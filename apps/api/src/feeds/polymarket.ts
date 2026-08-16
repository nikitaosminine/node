import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { RunTree } from "langsmith";
import { traceable, withRunTree } from "langsmith/traceable";
import { langsmithClient } from "../llm/langsmith";
import {
  buildPortfolioProfile,
  type EtfConstituentGap,
  type HoldingRow,
} from "./portfolio-profile";

// Re-exported so callers/tests of the Polymarket fanout keep a single import site.
export { buildPortfolioProfile, type EtfConstituentGap } from "./portfolio-profile";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Queue message for the geography/constituents enrichment consumer in
// index.ts. Structurally compatible with GeographyQueueMessage so the
// Worker's Queue<GeographyQueueMessage> binding satisfies Env below.
interface EtfEnrichmentQueueMessage {
  type: "geography_research";
  portfolio_id: string;
  holding_id: string;
  reason: "polymarket_constituents";
}

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  // Optional: when bound, ETF constituents coverage gaps found during profile
  // builds are enqueued for background enrichment (never LLM work inline).
  GEOGRAPHY_QUEUE?: { send(message: EtfEnrichmentQueueMessage): Promise<unknown> };
  GROK_MAIN_API_KEY?: string;
  GROK_SUB_API_KEY?: string;
  GROK_NORMALIZATION_API_KEY?: string;
  GROK_API_BASE_URL?: string;
  POLYMARKET_GROK_MODEL?: string;
  POLYMARKET_GROK_REASONING_EFFORT?: string;
  POLYMARKET_GAMMA_BASE_URL?: string;
  // Optional LangSmith tracing — when unset, curation runs identically untraced.
  LANGSMITH_API_KEY?: string;
  LANGSMITH_PROJECT?: string;
  LANGSMITH_ENDPOINT?: string;
  LANGSMITH_WORKSPACE_ID?: string;
}

interface PortfolioRow {
  id: string;
  user_id: string;
}

// Gamma API shapes
interface GammaEvent {
  id?: string;
  slug?: string;
  title?: string;
  image?: string;
  tags?: GammaTag[];
  markets?: GammaMarket[];
}

interface GammaTag {
  id?: number;
  label?: string;
}

interface GammaMarket {
  conditionId?: string;
  slug?: string;
  question?: string;
  image?: string;
  outcomes?: string; // JSON-encoded string: '["Yes","No"]'
  outcomePrices?: string; // JSON-encoded string: '["0.825","0.175"]'
  liquidity?: number | string | null;
  volume24hr?: number | string | null;
  startDate?: string | null;
  endDate?: string | null;
  active?: boolean;
}

// Flattened market ready for DB
interface FlatMarket {
  condition_id: string;
  event_id: string;
  event_slug: string;
  event_title: string;
  market_slug: string;
  question: string;
  tags: Array<{ id: number; label: string }>;
  outcomes: string[];
  outcome_prices: number[];
  liquidity: number | null;
  volume_24hr: number | null;
  start_date: string | null;
  end_date: string | null;
  image: string | null;
  active: boolean;
}

// Grok response shape for scoring
interface GrokChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface GrokScoreItem {
  condition_id: string;
  score: number;
  reason: string;
}

interface GrokScoringResult {
  scores: GrokScoreItem[];
  grokInvoked: boolean;
}

type PolymarketGrokReasoningEffort = "low" | "medium" | "high" | "xhigh";

interface HoldingsCacheRow {
  holdings_hash: string;
  last_scored_at: string;
  profile_text: string | null;
}

export interface PolymarketFanoutOptions {
  forceRescore?: boolean;
}

export interface PolymarketFanoutResult {
  marketsUpserted: number;
  marketsDeactivated: number;
  portfoliosProcessed: number;
  portfoliosSkipped: number;
  curation: {
    model: string;
    reasoningEffort: PolymarketGrokReasoningEffort;
    forceRescore: boolean;
    grokRuns: number;
    cacheHits: number;
    fallbacks: number;
    portfoliosWithoutHoldings: number;
    rotatingMatchesWritten: number;
  };
  errors: string[];
}


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TAG_IDS = {
  politics: 2,
  geopolitics: 100265,
  economy: 100328,
  finance: 120,
  crypto: 21,
  business: 107,
  tech: 1401,
  stocks: 604,
} as const;

const ROTATING_BATCH_SIZE = 60; // max candidate markets sent to Grok per portfolio (event-deduped by highest-Yes bucket)
const ROTATING_TOP_K = 16; // Grok picks top-K; server-side event-dedup then reduces to ~8 unique events
const DEFAULT_POLYMARKET_GROK_MODEL = "grok-4.6";
const DEFAULT_POLYMARKET_GROK_REASONING_EFFORT: PolymarketGrokReasoningEffort = "medium";
const POLYMARKET_GROK_REASONING_EFFORTS = new Set<PolymarketGrokReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
]);

// Cache TTL: skip Grok re-scoring if holdings haven't changed AND last scored < 6h ago.
// Market prices still refresh on every fanout run — only the per-portfolio LLM call is cached.
const CACHE_TTL_HOURS = 6;

// ---------------------------------------------------------------------------
// Non-financial market filter — applied before Grok to prevent LLM from
// wasting tokens on sports/entertainment/individual political candidacies.
// Exported so the /api/polymarket/category endpoint in index.ts can reuse it.
// ---------------------------------------------------------------------------

export const NON_FINANCIAL_RE =
  /\b(fifa|world cup|super bowl|nfl|nba|nhl|mlb|premier league|la liga|bundesliga|serie a|champions league|olympic|euro 202[0-9]|euros 202[0-9]|wimbledon|grand prix|formula.?1\b|f1 race|moto ?gp|cricket|rugby world|march madness|stanley cup|gold cup|copa am[eé]rica|esports|grammy|oscar|emmy|golden globe|box office|celebrity|reality (tv|show)|presidential nomination|republican nomination|democratic nomination|win the .{0,30} nomination|become .{0,20} nominee|primary election|senate seat|congressional seat|gubernatorial|win the .{0,20} primary|win the \d{4} .{0,30} presidential election|win the \d{4} us presidential|us president in \d{4})\b/i;

export function isNonFinancialQuestion(question: string): boolean {
  return NON_FINANCIAL_RE.test(question);
}

// ---------------------------------------------------------------------------
// Short-duration filter — weekly/daily price-target markets ("Will MSFT close
// $440-$450 this week?") are gambler noise. The discriminator is DURATION, not
// end date: a monthly market resolving in 2 days (e.g. EWY "$212 in May") is
// relevant. Weekly markets span ~6-7 days; monthly span ~30 days. Keep markets
// with unknown duration (missing start/end) so we never over-filter.
// ---------------------------------------------------------------------------

export const MIN_MARKET_DURATION_DAYS = 14;

export function isShortTermMarket(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): boolean {
  if (!startIso || !endIso) return false;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms)) return false;
  return ms < MIN_MARKET_DURATION_DAYS * 86_400_000;
}

// ---------------------------------------------------------------------------
// Near-certain filter — a market at 100% Yes / 99% No is resolved-in-all-but-
// name and carries no information. Shared with the category browse endpoint
// so it applies the same cutoff as the personalized rotating path.
// ---------------------------------------------------------------------------

export const MAX_CERTAIN_PROB = 0.97;

export function isNearCertainMarket(outcomePrices: number[] | null | undefined): boolean {
  if (!outcomePrices || outcomePrices.length === 0) return false;
  const topProb = Math.max(...outcomePrices, 0);
  return topProb >= MAX_CERTAIN_PROB;
}

// ---------------------------------------------------------------------------
// Grok helpers (self-contained — no cross-import from index.ts)
// ---------------------------------------------------------------------------

function getGrokBaseUrl(env: Env): string {
  return (env.GROK_API_BASE_URL || "https://api.x.ai/v1").replace(/\/$/, "");
}

function getPolymarketGrokConfig(env: Env): {
  model: string;
  reasoningEffort: PolymarketGrokReasoningEffort;
} {
  const model = env.POLYMARKET_GROK_MODEL?.trim() || DEFAULT_POLYMARKET_GROK_MODEL;
  const configuredEffort =
    env.POLYMARKET_GROK_REASONING_EFFORT?.trim().toLowerCase() ||
    DEFAULT_POLYMARKET_GROK_REASONING_EFFORT;
  if (!POLYMARKET_GROK_REASONING_EFFORTS.has(configuredEffort as PolymarketGrokReasoningEffort)) {
    throw new Error(`[polymarket] Invalid POLYMARKET_GROK_REASONING_EFFORT: ${configuredEffort}`);
  }
  return {
    model,
    reasoningEffort: configuredEffort as PolymarketGrokReasoningEffort,
  };
}

export async function invokePolymarketGrok(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const apiKey = env.GROK_MAIN_API_KEY ?? env.GROK_SUB_API_KEY ?? env.GROK_NORMALIZATION_API_KEY;
  if (!apiKey) throw new Error("[polymarket] No Grok API key available");
  const { model, reasoningEffort } = getPolymarketGrokConfig(env);

  const res = await fetch(`${getGrokBaseUrl(env)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning_effort: reasoningEffort,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Grok API error (${res.status}): ${body.slice(0, 400)}`);
  }

  const data = (await res.json()) as GrokChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Grok response did not include content");
  return content;
}

// Traceable wrapper. Logs the prompts + raw model output (NOT `env`, which holds
// the API key). A no-op passthrough outside a run-tree context, so untraced
// callers are unaffected; nests as a child span when run inside withRunTree.
const invokeGrok = traceable(invokePolymarketGrok, {
  name: "grok.score",
  run_type: "llm",
  processInputs: (inputs) => {
    const args = (inputs as { args?: unknown[] }).args ?? [];
    return { system: args[1], user: args[2] };
  },
  processOutputs: (outputs) => ({ text: outputs }),
});

export function shouldUsePolymarketCurationCache(params: {
  cacheRow: HoldingsCacheRow | null;
  currentHash: string;
  forceRescore: boolean;
  nowMs?: number;
}): boolean {
  if (params.forceRescore || params.cacheRow === null) return false;
  const cacheAgeHours =
    ((params.nowMs ?? Date.now()) - new Date(params.cacheRow.last_scored_at).getTime()) / 3_600_000;
  return (
    params.cacheRow.holdings_hash === params.currentHash &&
    Number.isFinite(cacheAgeHours) &&
    cacheAgeHours >= 0 &&
    cacheAgeHours < CACHE_TTL_HOURS
  );
}

function extractJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Gamma API fetcher
// ---------------------------------------------------------------------------

function gammaBase(env: Env): string {
  return (env.POLYMARKET_GAMMA_BASE_URL || "https://gamma-api.polymarket.com").replace(/\/$/, "");
}

async function fetchGammaJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gamma API ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Market flattening
// ---------------------------------------------------------------------------

function parseJsonStringArray(raw: string | undefined | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function flattenEvent(event: GammaEvent): FlatMarket[] {
  const eventId = String(event.id ?? "");
  const eventSlug = String(event.slug ?? "");
  const eventTitle = String(event.title ?? "");
  const eventImage = event.image ?? null;
  const eventTags = (event.tags ?? [])
    .filter((t) => t.id != null && t.label != null)
    .map((t) => ({ id: Number(t.id), label: String(t.label) }));

  const markets: FlatMarket[] = [];

  for (const market of event.markets ?? []) {
    const conditionId = String(market.conditionId ?? "").trim();
    if (!conditionId) continue;

    const outcomes = parseJsonStringArray(market.outcomes).map(String);
    const outcomePricesRaw = parseJsonStringArray(market.outcomePrices).map((p) => Number(p));
    const outcomePrices = outcomePricesRaw.filter((p) => Number.isFinite(p));

    markets.push({
      condition_id: conditionId,
      event_id: eventId,
      event_slug: eventSlug,
      event_title: eventTitle,
      market_slug: String(market.slug ?? ""),
      question: String(market.question ?? ""),
      tags: eventTags,
      outcomes,
      outcome_prices: outcomePrices,
      liquidity:
        market.liquidity != null && Number.isFinite(Number(market.liquidity))
          ? Number(market.liquidity)
          : null,
      volume_24hr:
        market.volume24hr != null && Number.isFinite(Number(market.volume24hr))
          ? Number(market.volume24hr)
          : null,
      start_date: market.startDate ?? null,
      end_date: market.endDate ?? null,
      image: market.image ?? eventImage,
      active: market.active ?? true,
    });
  }

  return markets;
}

// ---------------------------------------------------------------------------
// Candidate pool fetch (tag-filtered only — no broad pool)
// ---------------------------------------------------------------------------

export async function fetchCandidateMarkets(env: Env): Promise<Map<string, FlatMarket>> {
  const base = gammaBase(env);
  const marketMap = new Map<string, FlatMarket>();
  const failures: string[] = [];
  let successfulTags = 0;

  for (const [tagName, tagId] of Object.entries(TAG_IDS)) {
    try {
      const events = await fetchGammaJson<GammaEvent[]>(
        `${base}/events?tag_id=${tagId}&active=true&closed=false&order=volume24hr&ascending=false&limit=30`,
      );
      successfulTags++;
      let added = 0;
      for (const event of events) {
        for (const market of flattenEvent(event)) {
          if (isNonFinancialQuestion(market.question)) continue;
          if (!marketMap.has(market.condition_id)) {
            marketMap.set(market.condition_id, market);
            added++;
          }
        }
      }
      console.log(`[polymarket] tag ${tagName} (${tagId}): +${added} new markets`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${tagName} (${tagId}): ${message}`);
      console.error(`[polymarket] tag ${tagName} fetch failed:`, err);
    }
  }

  if (marketMap.size === 0) {
    const failureDetail = failures.length > 0 ? ` Failures: ${failures.join(" | ")}` : "";
    throw new Error(
      `[polymarket] Gamma candidate pool is empty (${successfulTags}/${Object.keys(TAG_IDS).length} tag requests succeeded). Preserving existing feed rows.${failureDetail}`,
    );
  }

  if (failures.length > 0) {
    console.warn(
      `[polymarket] candidate pool is partial (${successfulTags}/${Object.keys(TAG_IDS).length} tags succeeded): ${failures.join(" | ")}`,
    );
  }

  console.log(`[polymarket] total candidate pool: ${marketMap.size} markets`);
  return marketMap;
}

// ---------------------------------------------------------------------------
// Upsert markets into polymarket_markets
// ---------------------------------------------------------------------------

async function upsertMarkets(
  client: AnySupabaseClient,
  markets: FlatMarket[],
): Promise<void> {
  if (markets.length === 0) return;

  const rows = markets.map((m) => ({
    condition_id: m.condition_id,
    event_id: m.event_id || null,
    event_slug: m.event_slug || null,
    event_title: m.event_title || null,
    market_slug: m.market_slug || null,
    question: m.question,
    tags: m.tags,
    outcomes: m.outcomes,
    outcome_prices: m.outcome_prices,
    liquidity: m.liquidity,
    volume_24hr: m.volume_24hr,
    start_date: m.start_date,
    end_date: m.end_date,
    image: m.image,
    active: m.active,
    fetched_at: new Date().toISOString(),
  }));

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = (await (client as any)
      .from("polymarket_markets")
      .upsert(chunk, { onConflict: "condition_id" })) as { error: { message: string } | null };
    if (error) {
      throw new Error(
        `[polymarket] market upsert batch failed (${i}–${i + chunk.length}): ${error.message}`,
      );
    }
  }
}

// Markets that drop out of the top-30-per-tag Gamma pool are never re-fetched
// and would otherwise freeze at their last-seen `active`/`outcome_prices`
// forever. 48h comfortably covers the fanout's normal run cadence (hourly)
// plus a couple of missed runs, so anything older is treated as abandoned by
// Gamma rather than merely mid-cycle.
const STALE_FANOUT_WINDOW_HOURS = 48;

/**
 * Deactivates rows that have resolved (`end_date` in the past) or have not
 * been re-fetched by a recent fanout — both are cases where Gamma has
 * stopped surfacing the market, so `active`/prices are stale and the market
 * must stop appearing in feeds. Pinned markets are not exempt: a pinned
 * market that resolves is exactly the case most likely to render stale.
 */
async function deactivateStaleMarkets(client: AnySupabaseClient): Promise<number> {
  const nowIso = new Date().toISOString();
  const staleCutoffIso = new Date(
    Date.now() - STALE_FANOUT_WINDOW_HOURS * 3_600_000,
  ).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (client as any)
    .from("polymarket_markets")
    .update({ active: false })
    .eq("active", true)
    .or(`end_date.lt.${nowIso},fetched_at.lt.${staleCutoffIso}`)
    .select("condition_id")) as { data: { condition_id: string }[] | null; error: { message: string } | null };

  if (error) {
    throw new Error(`[polymarket] failed to deactivate stale markets: ${error.message}`);
  }
  return (data ?? []).length;
}

interface PortfolioMarketSelection {
  condition_id: string;
  score: number | null;
  reason: string | null;
}

function postgrestInList(values: string[]): string {
  return `(${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")})`;
}

/**
 * Writes the replacement selection before pruning stale rows. An empty
 * selection is rejected so an upstream/API failure can never turn into a
 * destructive "replace with nothing" operation.
 */
export async function upsertThenPrunePortfolioMatches(
  client: AnySupabaseClient,
  portfolioId: string,
  selections: PortfolioMarketSelection[],
): Promise<void> {
  if (selections.length === 0) {
    throw new Error(
      `[polymarket] refusing to replace portfolio ${portfolioId} matches with an empty set`,
    );
  }

  const rows = selections.map((selection) => ({
    portfolio_id: portfolioId,
    ...selection,
    is_pinned: false,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: upsertError } = (await (client as any)
    .from("portfolio_polymarket_matches")
    .upsert(rows, { onConflict: "portfolio_id,condition_id" })) as {
    error: { message: string } | null;
  };
  if (upsertError) {
    throw new Error(
      `[polymarket] match upsert failed for portfolio ${portfolioId}: ${upsertError.message}`,
    );
  }

  // Prune only after the replacement rows are safely present. If pruning
  // fails, the feed may temporarily contain stale rows, but it never goes
  // empty because of a failed refresh.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: pruneError } = (await (client as any)
    .from("portfolio_polymarket_matches")
    .delete()
    .eq("portfolio_id", portfolioId)
    .not(
      "condition_id",
      "in",
      postgrestInList(selections.map((selection) => selection.condition_id)),
    )) as {
    error: { message: string } | null;
  };
  if (pruneError) {
    throw new Error(
      `[polymarket] stale-match prune failed for portfolio ${portfolioId}: ${pruneError.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Holdings hash — SHA-256 of sorted (ticker|isin|quantity) fingerprint.
// Cache invalidates when any holding's ticker, ISIN, or quantity (rounded to
// nearest 0.01) changes. Uses WebCrypto available natively in CF Workers.
// ---------------------------------------------------------------------------

async function computeHoldingsHash(holdings: HoldingRow[]): Promise<string> {
  const fingerprint = [...holdings]
    .sort((a, b) => a.ticker.localeCompare(b.ticker))
    .map((h) => `${h.ticker}|${h.isin ?? ""}|${Math.round(h.quantity * 100)}`)
    .join(",");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// buildPortfolioProfile (holdings → ETF constituents → sectors → countries)
// lives in ./portfolio-profile — shared with the news fanout.

// ---------------------------------------------------------------------------
// ETF constituents self-healing — when a profile build finds an ETF with no
// etf_constituents row, enqueue the existing geography/constituents research
// job for that holding instead of degrading curation silently. The LLM work
// happens in the geography-queue consumer, never inline in the fanout.
// ---------------------------------------------------------------------------

// Re-enqueue backoff: an ETF whose research finds no constituents would
// otherwise re-trigger an LLM web-search job on every 6h cache expiry, forever.
const CONSTITUENT_ENRICHMENT_BACKOFF_HOURS = 24;

export async function enqueueEtfConstituentsEnrichment(
  env: Env,
  client: AnySupabaseClient,
  portfolioId: string,
  gaps: EtfConstituentGap[],
): Promise<{ enqueued: string[] }> {
  const eligible = gaps.filter((gap) => {
    if (!gap.isin || !gap.holdingId) {
      // etf_constituents is keyed by ISIN — without one the row can never
      // exist, so enqueueing would loop forever. Log once per profile build.
      console.warn(
        `[polymarket] ETF constituents gap for ${gap.ticker} (portfolio ${portfolioId}) not enqueueable: missing ${gap.isin ? "holding id" : "ISIN"}`,
      );
      return false;
    }
    return true;
  });
  if (eligible.length === 0) return { enqueued: [] };

  if (!env.GEOGRAPHY_QUEUE) {
    console.warn(
      `[polymarket] GEOGRAPHY_QUEUE binding missing; ${eligible.length} ETF constituents enrichment jobs not queued`,
    );
    return { enqueued: [] };
  }

  // Dedupe/backoff via geography_research_jobs, claimed ATOMICALLY per holding
  // so overlapping fanouts cannot double-enqueue the same LLM job: a
  // conditional UPDATE claims a stale row (any status — a recent
  // completed/failed row means research ran and found nothing; retry daily,
  // not on every fanout), and an INSERT claims a missing one, where a
  // unique-violation means another fanout holds a recent claim.
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const staleCutoff = new Date(
    nowMs - CONSTITUENT_ENRICHMENT_BACKOFF_HOURS * 3_600_000,
  ).toISOString();
  const claimed: EtfConstituentGap[] = [];
  for (const gap of eligible) {
    const holdingId = String(gap.holdingId);
    const jobRow = {
      holding_id: holdingId,
      portfolio_id: portfolioId,
      status: "queued",
      reason: "polymarket_constituents",
      last_error: null,
      started_at: null,
      finished_at: null,
      updated_at: now,
    };
    const { data: updatedRows, error: updateError } = (await client
      .from("geography_research_jobs")
      .update(jobRow)
      .eq("holding_id", holdingId)
      .or(`updated_at.is.null,updated_at.lt.${staleCutoff}`)
      .select("holding_id")) as {
      data: Array<{ holding_id: string }> | null;
      error: { message: string } | null;
    };
    if (updateError) {
      throw new Error(
        `[polymarket] constituents enrichment claim failed: ${updateError.message}`,
      );
    }
    if (updatedRows && updatedRows.length > 0) {
      claimed.push(gap);
      continue;
    }
    const { error: insertError } = (await client
      .from("geography_research_jobs")
      .insert(jobRow)) as { error: { message: string; code?: string } | null };
    if (!insertError) {
      claimed.push(gap);
      continue;
    }
    // 23505 = unique violation: a row with recent activity already exists
    // (or a concurrent fanout inserted first) — back off, don't double-enqueue.
    if (insertError.code === "23505") continue;
    throw new Error(
      `[polymarket] constituents enrichment job insert failed: ${insertError.message}`,
    );
  }
  if (claimed.length === 0) return { enqueued: [] };

  // Deliver, and make the claim reflect delivery: if a send rejects, release
  // the claim so the next fanout retries immediately instead of the ETF
  // sitting unenriched behind a 24h backoff with no message in flight. The
  // status guard can't strand a concurrent geography-path message — that
  // consumer re-upserts the row when it starts (markGeographyJobRunning).
  const sendResults = await Promise.allSettled(
    claimed.map((gap) =>
      env.GEOGRAPHY_QUEUE!.send({
        type: "geography_research",
        portfolio_id: portfolioId,
        holding_id: String(gap.holdingId),
        reason: "polymarket_constituents",
      }),
    ),
  );
  const enqueued: string[] = [];
  for (const [index, result] of sendResults.entries()) {
    const gap = claimed[index];
    const holdingId = String(gap.holdingId);
    if (result.status === "fulfilled") {
      enqueued.push(holdingId);
      console.warn(
        `[polymarket] ETF constituents coverage gap: ${gap.ticker} (${gap.isin}) has no etf_constituents row${gap.hasFallback ? " (hardcoded fallback used this run)" : ""} — enrichment enqueued`,
      );
      continue;
    }
    console.error(
      `[polymarket] constituents enrichment send failed for ${gap.ticker} (holding ${holdingId}) — releasing claim:`,
      result.reason,
    );
    const { error: releaseError } = (await client
      .from("geography_research_jobs")
      .delete()
      .eq("holding_id", holdingId)
      .eq("status", "queued")) as { error: { message: string } | null };
    if (releaseError) {
      console.error(
        `[polymarket] constituents enrichment claim release failed for holding ${holdingId}: ${releaseError.message}`,
      );
    }
  }
  return { enqueued };
}

// ---------------------------------------------------------------------------
// Grok scoring
// ---------------------------------------------------------------------------

async function scoreRotatingCandidates(
  env: Env,
  profileSummary: string,
  candidates: FlatMarket[],
): Promise<GrokScoringResult> {
  if (candidates.length === 0) return { scores: [], grokInvoked: false };

  const candidateList = candidates
    .slice(0, ROTATING_BATCH_SIZE)
    .map((m, i) => `${i + 1}. [${m.condition_id}] ${m.question}`)
    .join("\n");

  const systemPrompt = `You are a financial analyst scoring prediction market relevance for an investment portfolio.

STRICT RULES — read carefully:
1. Only include markets that have a DIRECT, MATERIAL financial connection to the portfolio's specific holdings or sectors.
2. "Direct" means: the market outcome would move stock prices, interest rates, commodity prices, currency rates, or sector-specific regulation for specific companies held.
3. REJECT any sports or entertainment market even if a country in the portfolio plays in it. Geographic overlap is NOT relevance.
4. REJECT markets about: sports championships, individual political party nominations (e.g. "Will X win the Republican/Democratic nomination?"), celebrity events, social media trends, weather, cultural events. Who wins a primary race 2+ years away has NO direct link to stock prices.
4b. For elections that ARE relevant (e.g. US House midterms affecting trade policy), only include if you can name a SPECIFIC financial mechanism — not generic "macro uncertainty".
5. SCORE HIGHLY (>0.6): Central bank rate decisions (especially relevant to tech/growth stocks held via ETFs like NASDAQ-100), trade tariffs/sanctions affecting specific sectors held, energy price regulation, tech regulation affecting held tech ETFs, company-specific events (earnings, mergers, regulatory approvals).
6. SCORE MEDIUM (0.3–0.6): Broad macroeconomic outcomes (recession, inflation) that would materially affect the portfolio's sector mix.
7. Score 0 and EXCLUDE anything else.

Return ONLY a JSON array with the top ${ROTATING_TOP_K} most relevant markets. Format:
[{"condition_id": "...", "score": 0.85, "reason": "One specific financial mechanism naming the exact holding/ETF/underlying stock affected"}]

Only include markets with score >= 0.35. If fewer than 3 markets meet this bar, return only those that genuinely do.
IMPORTANT: Maximize DIVERSITY. If multiple markets come from the same Polymarket event (e.g. multiple Fed rate outcomes), pick AT MOST 2 from that event. Fill remaining slots with markets from DIFFERENT events/topics.`;

  const userPrompt = `Portfolio profile:
${profileSummary}

Candidate prediction markets — pick the top ${ROTATING_TOP_K} with DIRECT financial connection to this portfolio:
${candidateList}

Return JSON array only. No sports, no entertainment, no individual political candidacies, no geography-as-relevance.`;

  const validIds = new Set(candidates.slice(0, ROTATING_BATCH_SIZE).map((m) => m.condition_id));

  try {
    const raw = await invokeGrok(env, systemPrompt, userPrompt);
    const items = extractJsonArray(raw);
    return {
      scores: items
        .filter(
          (item): item is GrokScoreItem =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as Record<string, unknown>).condition_id === "string" &&
            typeof (item as Record<string, unknown>).score === "number" &&
            validIds.has((item as Record<string, unknown>).condition_id as string),
        )
        .map((item) => ({
          condition_id: item.condition_id,
          score: Math.max(0, Math.min(1, item.score)),
          reason: String(item.reason ?? ""),
        }))
        .slice(0, ROTATING_TOP_K),
      grokInvoked: true,
    };
  } catch (err) {
    console.error("[polymarket] Grok scoring failed:", err);
    return { scores: [], grokInvoked: true };
  }
}

// ---------------------------------------------------------------------------
// Probability of the affirmative ("Yes") outcome — the market's consensus
// answer. Yes/No markets → the Yes price; non-binary → leading outcome price.
// ---------------------------------------------------------------------------

function getYesProb(market: FlatMarket | undefined): number {
  if (!market) return 0;
  const yesIdx = market.outcomes.findIndex((o) => /^yes$/i.test(o.trim()));
  if (yesIdx >= 0) return market.outcome_prices[yesIdx] ?? 0;
  return Math.max(...market.outcome_prices, 0);
}

// ---------------------------------------------------------------------------
// Server-side event deduplication
//
// A single Polymarket EVENT (e.g. "How many Fed rate cuts in 2026?") is split
// into many binary markets ("Will 0 cuts happen?", "Will 7 cuts happen?", …)
// sharing one event_id. Grok scores them individually, so we collapse to one
// row per event.
//
// Selection: keep the bucket with the HIGHEST Yes probability — the consensus
// answer (e.g. "0 cuts" at 67% Yes), NOT a lopsided near-zero bucket like
// "7 cuts" at 100% No which carries no information. The event's feed ranking
// uses the MAX Grok score across its buckets so relevance is preserved.
// ---------------------------------------------------------------------------

function dedupeByEvent(
  scored: Array<{ condition_id: string; score: number; reason: string | null }>,
  candidateMap: Map<string, FlatMarket>,
): typeof scored {
  type Item = { condition_id: string; score: number; reason: string | null };
  const groups = new Map<string, { best: Item; bestYes: number; maxScore: number }>();

  for (const item of scored) {
    const market = candidateMap.get(item.condition_id);
    const eventKey = market?.event_id || item.condition_id;
    const yesProb = getYesProb(market);

    const group = groups.get(eventKey);
    if (!group) {
      groups.set(eventKey, { best: item, bestYes: yesProb, maxScore: item.score });
    } else {
      group.maxScore = Math.max(group.maxScore, item.score);
      if (yesProb > group.bestYes) {
        group.best = item;
        group.bestYes = yesProb;
      }
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => b.maxScore - a.maxScore)
    .map((g) => ({ ...g.best, score: g.maxScore }));
}

// ---------------------------------------------------------------------------
// Main: runPolymarketFanout
// ---------------------------------------------------------------------------

export async function runPolymarketFanout(
  env: Env,
  options: PolymarketFanoutOptions = {},
): Promise<PolymarketFanoutResult> {
  const client: AnySupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const forceRescore = options.forceRescore === true;
  const { model, reasoningEffort } = getPolymarketGrokConfig(env);

  const errors: string[] = [];
  let portfoliosProcessed = 0;
  let portfoliosSkipped = 0;
  const curation: PolymarketFanoutResult["curation"] = {
    model,
    reasoningEffort,
    forceRescore,
    grokRuns: 0,
    cacheHits: 0,
    fallbacks: 0,
    portfoliosWithoutHoldings: 0,
    rotatingMatchesWritten: 0,
  };

  // 1. Fetch and flatten candidate markets. A completely empty candidate pool
  // is fatal: continuing would eventually replace every portfolio feed with
  // an empty set. Let the scheduled/debug caller surface the failure instead.
  const candidateMap = await fetchCandidateMarkets(env);

  // 2. Upsert all markets (prices + probabilities refresh every run)
  const allMarkets = Array.from(candidateMap.values());
  await upsertMarkets(client, allMarkets);
  console.log(`[polymarket] upserted ${allMarkets.length} markets`);

  // 2b. Deactivate resolved/stale markets so they stop rendering in feeds,
  // regardless of whether they're still pinned or matched to a portfolio.
  const marketsDeactivated = await deactivateStaleMarkets(client);
  console.log(`[polymarket] deactivated ${marketsDeactivated} resolved/stale markets`);

  // 3. Fetch all portfolios
  const { data: portfoliosData, error: portfoliosError } = await client
    .from("portfolios")
    .select("id,user_id");

  if (portfoliosError || !portfoliosData) {
    errors.push(`portfolios fetch: ${portfoliosError?.message ?? "no data"}`);
    return {
      marketsUpserted: allMarkets.length,
      marketsDeactivated,
      portfoliosProcessed,
      portfoliosSkipped,
      curation,
      errors,
    };
  }

  const portfolios = portfoliosData as PortfolioRow[];

  // Collapse multi-bucket events (e.g. "How many Fed cuts?") to a SINGLE
  // representative market — the highest-Yes bucket (consensus answer) — BEFORE
  // Grok scoring. Otherwise Grok sees all 13 buckets of one event and may pick
  // a lopsided near-zero bucket ("Will 7 cuts happen?" at 100% No) instead of
  // the meaningful one ("Will 0 cuts happen?" at 67% Yes).
  // Drop near-certain markets (see isNearCertainMarket) so noise like
  // "Will MSFT hit $435 in May? 100% Yes" never reaches Grok.
  const consensusByEvent = new Map<string, FlatMarket>();
  for (const m of allMarkets) {
    // Drop weekly/daily price-target gambling markets (short duration)
    if (isShortTermMarket(m.start_date, m.end_date)) continue;
    if (isNearCertainMarket(m.outcome_prices)) continue;
    const key = m.event_id || m.condition_id;
    const existing = consensusByEvent.get(key);
    if (!existing || getYesProb(m) > getYesProb(existing)) {
      consensusByEvent.set(key, m);
    }
  }
  const rotatingCandidates = Array.from(consensusByEvent.values()).sort(
    (a, b) => (b.volume_24hr ?? 0) - (a.volume_24hr ?? 0),
  );
  if (rotatingCandidates.length === 0) {
    throw new Error(
      "[polymarket] no eligible rotating candidates remained after filtering; preserving existing portfolio matches",
    );
  }

  const hasGrokKey = !!(
    env.GROK_MAIN_API_KEY ||
    env.GROK_SUB_API_KEY ||
    env.GROK_NORMALIZATION_API_KEY
  );

  // 4. Per-portfolio scoring
  for (const portfolio of portfolios) {
    const portfolioId = portfolio.id;

    try {
      // 4a. Holdings-hash cache check — skip Grok if holdings unchanged AND cache is fresh
      const { data: holdingsData } = await client
        .from("holdings")
        .select("id,ticker,isin,asset_type,name,quantity")
        .eq("portfolio_id", portfolioId)
        .gt("quantity", 0);

      const holdings: HoldingRow[] = (holdingsData as HoldingRow[] | null) ?? [];

      if (holdings.length === 0) {
        // Portfolio has no holdings — sweep legacy pinned rows, skip scoring
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: legacySweepError } = (await (client as any)
          .from("portfolio_polymarket_matches")
          .delete()
          .eq("portfolio_id", portfolioId)
          .eq("is_pinned", true)) as { error: { message: string } | null };
        if (legacySweepError) {
          throw new Error(
            `[polymarket] legacy pinned-match sweep failed for portfolio ${portfolioId}: ${legacySweepError.message}`,
          );
        }
        curation.portfoliosWithoutHoldings++;
        portfoliosProcessed++;
        continue;
      }

      const currentHash = await computeHoldingsHash(holdings);

      // Read cache row
      const { data: cacheRow } = (await client
        .from("portfolio_holdings_cache")
        .select("holdings_hash,last_scored_at,profile_text")
        .eq("portfolio_id", portfolioId)
        .maybeSingle()) as {
        data: HoldingsCacheRow | null;
        error: unknown;
      };

      const cacheAgeHours = cacheRow
        ? (Date.now() - new Date(cacheRow.last_scored_at).getTime()) / 3_600_000
        : Infinity;
      const cacheHit = shouldUsePolymarketCurationCache({
        cacheRow,
        currentHash,
        forceRescore,
      });

      if (cacheHit) {
        console.log(
          `[polymarket] cache hit for portfolio ${portfolioId} (holdings unchanged, age=${cacheAgeHours.toFixed(1)}h) — skipping Grok`,
        );
        curation.cacheHits++;
        portfoliosProcessed++;
        continue;
      }

      // 4b. Cache miss or stale — run full profile build + Grok scoring
      console.log(
        `[polymarket] ${forceRescore ? "forced rescore" : "cache miss"} for portfolio ${portfolioId} (hashChanged=${cacheRow?.holdings_hash !== currentHash}, age=${cacheAgeHours.toFixed(1)}h) — scoring`,
      );

      let scored: Array<{ condition_id: string; score: number; reason: string | null }>;
      let profileSummaryForCache: string | null = null;

      if (!hasGrokKey) {
        curation.fallbacks++;
        errors.push(`portfolio ${portfolioId}: no Grok key available — using volume fallback`);
        scored = rotatingCandidates.slice(0, 10).map((m) => ({
          condition_id: m.condition_id,
          score: 0,
          reason: null,
        }));
      } else {
        const { profileSummary, constituentGaps } = await buildPortfolioProfile(
          client,
          portfolioId,
          holdings,
        );
        profileSummaryForCache = profileSummary;

        // Self-heal ETF constituents coverage in the background. Best-effort:
        // an enqueue failure must never break this portfolio's curation.
        if (constituentGaps.length > 0) {
          try {
            await enqueueEtfConstituentsEnrichment(env, client, portfolioId, constituentGaps);
          } catch (err) {
            console.error(
              `[polymarket] constituents enrichment enqueue failed for portfolio ${portfolioId}:`,
              err,
            );
          }
        }

        // --- LangSmith tracing (additive, attributed to this portfolio/user) ---
        // One run per portfolio per fanout. portfolio_id + user_id in the inputs
        // make every run attributable in the LangSmith dashboard without storing
        // the run id. Every LangSmith call is best-effort; curation never breaks.
        const lsClient = langsmithClient(env);
        let curationRun: RunTree | null = null;
        if (lsClient) {
          curationRun = new RunTree({
            name: "polymarket-curation",
            run_type: "chain",
            id: crypto.randomUUID(),
            project_name: env.LANGSMITH_PROJECT ?? "node-polymarket",
            client: lsClient,
            tracingEnabled: true,
            inputs: {
              portfolio_id: portfolioId,
              user_id: portfolio.user_id,
              model,
              reasoning_effort: reasoningEffort,
              candidate_count: rotatingCandidates.length,
            },
          });
          try {
            await curationRun.postRun();
          } catch (e) {
            console.error("[polymarket] LangSmith postRun failed — continuing untraced:", e);
            curationRun = null;
          }
        }

        let scoringResult: GrokScoringResult;
        try {
          scoringResult = curationRun
            ? await withRunTree(curationRun, () =>
                scoreRotatingCandidates(env, profileSummary, rotatingCandidates),
              )
            : await scoreRotatingCandidates(env, profileSummary, rotatingCandidates);
        } catch (err) {
          if (curationRun && lsClient) {
            try {
              await curationRun.end(undefined, err instanceof Error ? err.message : String(err));
              await curationRun.patchRun();
              await lsClient.flush();
            } catch (e) {
              console.error("[polymarket] LangSmith patch/flush (error path) failed:", e);
            }
          }
          throw err;
        }

        const rawScored = scoringResult.scores;
        if (scoringResult.grokInvoked) curation.grokRuns++;

        if (curationRun && lsClient) {
          try {
            // Output = the curated picks (what needs steering), so the run is evaluatable.
            await curationRun.end({ scored: rawScored, count: rawScored.length });
            await curationRun.patchRun();
            // Flush before the Worker tears down — see llm/langsmith.ts.
            await lsClient.flush();
          } catch (e) {
            console.error("[polymarket] LangSmith patch/flush failed:", e);
          }
        }

        if (rawScored.length === 0) {
          curation.fallbacks++;
          errors.push(
            `portfolio ${portfolioId}: Grok scoring returned 0 results — using volume fallback`,
          );
          scored = rotatingCandidates.slice(0, 10).map((m) => ({
            condition_id: m.condition_id,
            score: 0,
            reason: null,
          }));
        } else {
          // Server-side event deduplication before storing
          const deduped = dedupeByEvent(rawScored, candidateMap);
          console.log(
            `[polymarket] portfolio ${portfolioId}: Grok returned ${rawScored.length} → ${deduped.length} after event-dedup`,
          );
          scored = deduped;
        }
      }

      // 4c. Upsert the replacement first, then prune stale rows. Never advance
      // the cache until this succeeds, otherwise a failed write would suppress
      // retries for six hours.
      if (scored.length === 0) {
        throw new Error(
          "[polymarket] scoring produced no replacement rows; preserving existing matches",
        );
      }

      const rotatingRows: PortfolioMarketSelection[] = scored.map((item) => ({
        condition_id: item.condition_id,
        score: item.score,
        reason: item.reason || null,
      }));
      await upsertThenPrunePortfolioMatches(client, portfolioId, rotatingRows);
      curation.rotatingMatchesWritten += rotatingRows.length;

      if (profileSummaryForCache !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: cacheError } = (await (client as any)
          .from("portfolio_holdings_cache")
          .upsert(
            {
              portfolio_id: portfolioId,
              holdings_hash: currentHash,
              profile_text: profileSummaryForCache,
              last_scored_at: new Date().toISOString(),
            },
            { onConflict: "portfolio_id" },
          )) as { error: { message: string } | null };
        if (cacheError) {
          errors.push(`portfolio ${portfolioId} cache: ${cacheError.message}`);
          console.error(
            `[polymarket] cache update failed for portfolio ${portfolioId}:`,
            cacheError.message,
          );
        }
      }

      portfoliosProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[polymarket] unexpected error for portfolio ${portfolioId}:`, msg);
      errors.push(`portfolio ${portfolioId}: ${msg}`);
      portfoliosSkipped++;
    }
  }

  const result = {
    marketsUpserted: allMarkets.length,
    marketsDeactivated,
    portfoliosProcessed,
    portfoliosSkipped,
    curation,
    errors,
  };

  console.log("[polymarket] fanout complete:", result);
  return result;
}
