import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  GROK_MAIN_API_KEY?: string;
  GROK_SUB_API_KEY?: string;
  GROK_NORMALIZATION_API_KEY?: string;
  GROK_API_BASE_URL?: string;
  POLYMARKET_GAMMA_BASE_URL?: string;
}

interface PortfolioRow {
  id: string;
  user_id: string;
}

interface HoldingRow {
  ticker: string;
  isin: string | null;
  asset_type: string | null;
  name: string;
  quantity: number;
}

interface GeographyAllocationRow {
  country_code: string;
  country_name: string;
  weight_pct: number;
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

// ---------------------------------------------------------------------------
// Constants — tag IDs are numeric in Polymarket's Gamma API.
// These may change over time; move to a DB admin table when they become
// a maintenance burden (noted as an open item in the plan).
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

// Slugs of Polymarket events to always pin (highest volume_24hr market from
// each event gets is_pinned=true across all portfolios). Update as needed.
// Keep this list short and current — expired/resolved slugs are silently skipped.
export const PINNED_MARKET_SLUGS: string[] = [
  "will-the-fed-cut-rates-in-2026",
  "will-there-be-a-us-recession-in-2026",
  "us-midterm-elections-2026",
  "will-bitcoin-reach-200k-in-2026",
];

const ROTATING_BATCH_SIZE = 50; // max candidate markets sent to Grok per portfolio
const ROTATING_TOP_K = 8; // how many rotating matches to keep per portfolio

// ---------------------------------------------------------------------------
// Grok helpers (self-contained — no cross-import from index.ts)
// ---------------------------------------------------------------------------

function getGrokBaseUrl(env: Env): string {
  return (env.GROK_API_BASE_URL || "https://api.x.ai/v1").replace(/\/$/, "");
}

async function invokeGrok(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = env.GROK_MAIN_API_KEY ?? env.GROK_SUB_API_KEY ?? env.GROK_NORMALIZATION_API_KEY;
  if (!apiKey) throw new Error("[polymarket] No Grok API key available");

  const res = await fetch(`${getGrokBaseUrl(env)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-4.20-0309-non-reasoning",
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
    if (!conditionId) continue; // skip markets with no conditionId

    const outcomes = parseJsonStringArray(market.outcomes).map(String);
    const outcomePricesRaw = parseJsonStringArray(market.outcomePrices).map((p) => Number(p));
    // Filter out NaN entries
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
      end_date: market.endDate ?? null,
      image: market.image ?? eventImage,
      active: market.active ?? true,
    });
  }

  return markets;
}

// ---------------------------------------------------------------------------
// Non-financial market filter — sports/entertainment sneak in even through
// financial tags because Polymarket tags events broadly. We strip them here
// so they never reach the Grok scoring step.
// ---------------------------------------------------------------------------

const NON_FINANCIAL_RE =
  /\b(fifa|world cup|super bowl|nfl|nba|nhl|mlb|premier league|la liga|bundesliga|serie a|champions league|olympic|euro 202[0-9]|euros 202[0-9]|wimbledon|grand prix|formula.?1\b|f1 race|moto ?gp|cricket|rugby world|march madness|stanley cup|gold cup|copa am[eé]rica|esports|grammy|oscar|emmy|golden globe|box office|celebrity|reality (tv|show))\b/i;

function isNonFinancialQuestion(question: string): boolean {
  return NON_FINANCIAL_RE.test(question);
}

// ---------------------------------------------------------------------------
// Fetch tag-filtered candidate pool (NO broad pool).
//
// The broad "top N by volume_24hr" pool sounds useful but is toxic: whatever
// sport or event is culturally dominant right now (e.g. FIFA World Cup 2026)
// dominates by volume and floods the candidate set, causing the LLM to find
// spurious geographic connections (Japan ETF → Japan wins World Cup). Removing
// it entirely and relying only on financially-tagged pools eliminates this.
// ---------------------------------------------------------------------------

async function fetchCandidateMarkets(env: Env): Promise<Map<string, FlatMarket>> {
  const base = gammaBase(env);
  const marketMap = new Map<string, FlatMarket>();

  // Tag-filtered pools only — no broad pool.
  // Each tag call returns events already tagged as financial/political.
  for (const [tagName, tagId] of Object.entries(TAG_IDS)) {
    try {
      const events = await fetchGammaJson<GammaEvent[]>(
        `${base}/events?tag_id=${tagId}&active=true&closed=false&order=volume_24hr&ascending=false&limit=30`,
      );
      let added = 0;
      for (const event of events) {
        for (const market of flattenEvent(event)) {
          // Secondary safety net: drop any market whose question matches a
          // known non-financial pattern even if it slipped through the tag filter.
          if (isNonFinancialQuestion(market.question)) continue;
          if (!marketMap.has(market.condition_id)) {
            marketMap.set(market.condition_id, market);
            added++;
          }
        }
      }
      console.log(`[polymarket] tag ${tagName} (${tagId}): +${added} new markets`);
    } catch (err) {
      console.error(`[polymarket] tag ${tagName} fetch failed:`, err);
    }
  }

  console.log(`[polymarket] total candidate pool: ${marketMap.size} markets`);
  return marketMap;
}

// ---------------------------------------------------------------------------
// Fetch pinned events and determine which market to pin per event
// Returns: Map<eventSlug, condition_id of pinned market>
// ---------------------------------------------------------------------------

async function fetchPinnedMarkets(
  env: Env,
  candidateMap: Map<string, FlatMarket>,
): Promise<Map<string, string>> {
  const base = gammaBase(env);
  const pinnedBySlug = new Map<string, string>(); // slug → condition_id

  for (const slug of PINNED_MARKET_SLUGS) {
    try {
      // Check if we already have markets for this slug from the candidate pool
      const slugMarkets = Array.from(candidateMap.values()).filter(
        (m) => m.event_slug === slug,
      );

      // If not in candidate pool, fetch the event directly
      let eventMarkets: FlatMarket[] = slugMarkets;
      if (eventMarkets.length === 0) {
        const event = await fetchGammaJson<GammaEvent>(`${base}/events/slug/${slug}`);
        eventMarkets = flattenEvent(event);
        // Add to candidate map
        for (const m of eventMarkets) {
          if (!candidateMap.has(m.condition_id)) {
            candidateMap.set(m.condition_id, m);
          }
        }
      }

      // Pick highest volume_24hr market (with non-empty conditionId)
      const best = eventMarkets
        .filter((m) => m.condition_id)
        .sort((a, b) => (b.volume_24hr ?? 0) - (a.volume_24hr ?? 0))[0];

      if (best) {
        pinnedBySlug.set(slug, best.condition_id);
        console.log(
          `[polymarket] pinned slug ${slug} → conditionId ${best.condition_id} (vol24hr=${best.volume_24hr})`,
        );
      }
    } catch (err) {
      console.error(`[polymarket] pinned slug ${slug} fetch failed:`, err);
    }
  }

  return pinnedBySlug;
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
    end_date: m.end_date,
    image: m.image,
    active: m.active,
    fetched_at: new Date().toISOString(),
  }));

  // Batch upsert in chunks to avoid payload limits.
  // Keep chunk large (500) to minimise subrequest count — Cloudflare Workers
  // has a per-invocation subrequest limit (50 on free, 1000 on paid).
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = (await (client as any)
      .from("polymarket_markets")
      .upsert(chunk, { onConflict: "condition_id" })) as { error: { message: string } | null };
    if (error) {
      console.error(`[polymarket] market upsert batch failed (${i}–${i + chunk.length}):`, error.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Score rotating candidates via Grok
// ---------------------------------------------------------------------------

interface PortfolioProfile {
  tickers: string[];
  sectors: string[];
  countries: string[];
}

async function buildPortfolioProfile(
  client: AnySupabaseClient,
  portfolioId: string,
): Promise<PortfolioProfile> {
  const [holdingsResult, geoResult] = await Promise.all([
    client
      .from("holdings")
      .select("ticker,isin,asset_type,name,quantity")
      .eq("portfolio_id", portfolioId)
      .gt("quantity", 0),
    client
      .from("holding_geography_allocations")
      .select("country_name,weight_pct")
      .eq("portfolio_id", portfolioId)
      .order("weight_pct", { ascending: false })
      .limit(5),
  ]);

  const holdings: HoldingRow[] = (holdingsResult.data as HoldingRow[] | null) ?? [];
  const geoRows: GeographyAllocationRow[] =
    (geoResult.data as GeographyAllocationRow[] | null) ?? [];

  const tickers = holdings
    .filter((h) => h.quantity > 0)
    .map((h) => h.ticker)
    .filter(Boolean)
    .slice(0, 15);

  // Collect sectors from ETF constituents
  const etfIsins = holdings
    .filter(
      (h) =>
        h.isin &&
        /\betf\b|exchange traded fund|mutual\s*fund|\bfund\b|\bucits\b/i.test(
          `${h.asset_type ?? ""} ${h.name}`,
        ),
    )
    .map((h) => h.isin as string);

  let sectors: string[] = [];
  if (etfIsins.length > 0) {
    const { data: constituentRows } = (await client
      .from("etf_constituents")
      .select("top_sectors")
      .in("etf_isin", etfIsins)) as { data: Array<{ top_sectors: unknown }> | null; error: unknown };
    const sectorSet = new Set<string>();
    for (const row of constituentRows ?? []) {
      const ts = (row.top_sectors as Array<{ sector: string }> | null) ?? [];
      for (const s of ts.slice(0, 3)) sectorSet.add(s.sector);
    }
    sectors = Array.from(sectorSet);
  }

  const countries = geoRows.map((g) => g.country_name).filter(Boolean).slice(0, 5);

  return { tickers, sectors, countries };
}

async function scoreRotatingCandidates(
  env: Env,
  profile: PortfolioProfile,
  candidates: FlatMarket[],
): Promise<GrokScoreItem[]> {
  if (candidates.length === 0) return [];

  const profileSummary = [
    `Holdings: ${profile.tickers.slice(0, 15).join(", ")}`,
    profile.sectors.length > 0 ? `Sectors: ${profile.sectors.join(", ")}` : null,
    profile.countries.length > 0 ? `Countries: ${profile.countries.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(". ");

  const candidateList = candidates
    .slice(0, ROTATING_BATCH_SIZE)
    .map((m, i) => `${i + 1}. [${m.condition_id}] ${m.question}`)
    .join("\n");

  const systemPrompt = `You are a financial analyst scoring prediction market relevance for an investment portfolio.

STRICT RULES — read carefully:
1. Only include markets that have a DIRECT, MATERIAL financial connection to the portfolio's specific holdings or sectors.
2. "Direct" means: the market outcome would move stock prices, interest rates, commodity prices, currency rates, or sector-specific regulation for specific companies held.
3. REJECT any sports or entertainment market even if a country in the portfolio plays in it. "France wins World Cup" does NOT affect Schneider Electric's earnings. Geographic overlap is NOT relevance.
4. REJECT markets about: sports championships, elections in countries where you hold no index ETFs, celebrity events, social media trends, weather, cultural events.
5. SCORE HIGHLY (>0.6): Central bank rate decisions, trade tariffs/sanctions affecting specific sectors held, energy price regulation, tech regulation affecting held tech ETFs, company-specific events (earnings, mergers, regulatory approvals).
6. SCORE MEDIUM (0.3–0.6): Broad macroeconomic outcomes (recession, inflation) that would materially affect the portfolio's sector mix.
7. Score 0 and EXCLUDE anything else.

Return ONLY a JSON array with the top ${ROTATING_TOP_K} most relevant markets. Format:
[{"condition_id": "...", "score": 0.85, "reason": "One specific financial mechanism connecting this to the portfolio"}]

Only include markets with score >= 0.35. If fewer than 3 markets meet this bar, return only those that genuinely do.`;

  const userPrompt = `Portfolio profile:
${profileSummary}

Candidate prediction markets — pick the top ${ROTATING_TOP_K} that have a DIRECT financial connection to the holdings above:
${candidateList}

Return JSON array only. No sports, no entertainment, no geography-as-relevance.`;

  // Build a set of valid condition_ids so we can reject hallucinated ones
  const validIds = new Set(candidates.slice(0, ROTATING_BATCH_SIZE).map((m) => m.condition_id));

  try {
    const raw = await invokeGrok(env, systemPrompt, userPrompt);
    const items = extractJsonArray(raw);
    return items
      .filter(
        (item): item is GrokScoreItem =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).condition_id === "string" &&
          typeof (item as Record<string, unknown>).score === "number" &&
          // Reject any condition_id Grok hallucinated — must be in the candidate list
          validIds.has((item as Record<string, unknown>).condition_id as string),
      )
      .map((item) => ({
        condition_id: item.condition_id,
        score: Math.max(0, Math.min(1, item.score)),
        reason: String(item.reason ?? ""),
      }))
      .slice(0, ROTATING_TOP_K);
  } catch (err) {
    console.error("[polymarket] Grok scoring failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main: runPolymarketFanout
// ---------------------------------------------------------------------------

export async function runPolymarketFanout(env: Env): Promise<{
  marketsUpserted: number;
  pinnedSlugsFound: number;
  portfoliosProcessed: number;
  portfoliosSkipped: number;
  errors: string[];
}> {
  const client: AnySupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  const errors: string[] = [];
  let portfoliosProcessed = 0;
  let portfoliosSkipped = 0;

  // 1. Fetch and flatten candidate markets (broad + per-tag)
  let candidateMap: Map<string, FlatMarket>;
  try {
    candidateMap = await fetchCandidateMarkets(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`candidate fetch: ${msg}`);
    candidateMap = new Map();
  }

  // 2. Fetch pinned events (may add to candidateMap)
  let pinnedBySlug: Map<string, string>;
  try {
    pinnedBySlug = await fetchPinnedMarkets(env, candidateMap);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`pinned fetch: ${msg}`);
    pinnedBySlug = new Map();
  }

  // 3. Upsert all markets into polymarket_markets
  const allMarkets = Array.from(candidateMap.values());
  try {
    await upsertMarkets(client, allMarkets);
    console.log(`[polymarket] upserted ${allMarkets.length} markets`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`market upsert: ${msg}`);
  }

  // 4. Collect all pinned condition_ids (one per slug)
  const pinnedConditionIds = new Set(pinnedBySlug.values());

  // 5. Fetch all portfolios
  const { data: portfoliosData, error: portfoliosError } = await client
    .from("portfolios")
    .select("id,user_id");

  if (portfoliosError || !portfoliosData) {
    errors.push(`portfolios fetch: ${portfoliosError?.message ?? "no data"}`);
    return {
      marketsUpserted: allMarkets.length,
      pinnedSlugsFound: pinnedBySlug.size,
      portfoliosProcessed,
      portfoliosSkipped,
      errors,
    };
  }

  const portfolios = portfoliosData as PortfolioRow[];

  // Rotating candidates = all markets NOT pinned, sorted by volume_24hr desc
  const rotatingCandidates = allMarkets
    .filter((m) => !pinnedConditionIds.has(m.condition_id))
    .sort((a, b) => (b.volume_24hr ?? 0) - (a.volume_24hr ?? 0));

  // 6. Per-portfolio: write pinned rows + score rotating
  for (const portfolio of portfolios) {
    const portfolioId = portfolio.id;

    try {
      // 6a. Upsert pinned matches (is_pinned=true, score=NULL)
      if (pinnedConditionIds.size > 0) {
        const pinnedRows = Array.from(pinnedConditionIds).map((conditionId) => ({
          portfolio_id: portfolioId,
          condition_id: conditionId,
          score: null,
          reason: null,
          is_pinned: true,
        }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: pinnedError } = (await (client as any)
          .from("portfolio_polymarket_matches")
          .upsert(pinnedRows, { onConflict: "portfolio_id,condition_id" })) as {
          error: { message: string } | null;
        };

        if (pinnedError) {
          console.error(
            `[polymarket] pinned upsert failed for portfolio ${portfolioId}:`,
            pinnedError.message,
          );
          errors.push(`portfolio ${portfolioId} pinned: ${pinnedError.message}`);
        }
      }

      // 6b. Score rotating candidates via Grok, or fall back to top-N by volume
      const hasGrokKey = !!(env.GROK_MAIN_API_KEY || env.GROK_SUB_API_KEY || env.GROK_NORMALIZATION_API_KEY);
      let scored: Array<{ condition_id: string; score: number; reason: string | null }>;

      if (!hasGrokKey) {
        // No LLM key — just take the top 10 by volume as unscored rotating picks
        scored = rotatingCandidates.slice(0, 10).map((m) => ({
          condition_id: m.condition_id,
          score: 0,
          reason: null,
        }));
      } else {
        const profile = await buildPortfolioProfile(client, portfolioId);
        if (profile.tickers.length === 0 && profile.sectors.length === 0 && profile.countries.length === 0) {
          // Portfolio has no holdings — fall back to top-10 by volume
          scored = rotatingCandidates.slice(0, 10).map((m) => ({
            condition_id: m.condition_id,
            score: 0,
            reason: null,
          }));
        } else {
          scored = await scoreRotatingCandidates(env, profile, rotatingCandidates);
          // If Grok returned nothing (API error, bad model, etc.) fall back to volume-ranked top-10
          if (scored.length === 0) {
            errors.push(`portfolio ${portfolioId}: Grok scoring returned 0 results — using volume fallback`);
            scored = rotatingCandidates.slice(0, 10).map((m) => ({
              condition_id: m.condition_id,
              score: 0,
              reason: null,
            }));
          }
        }
      }

      if (scored.length > 0) {
        const rotatingRows = scored.map((item) => ({
          portfolio_id: portfolioId,
          condition_id: item.condition_id,
          score: item.score,
          reason: item.reason || null,
          is_pinned: false,
        }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: rotatingError } = (await (client as any)
          .from("portfolio_polymarket_matches")
          .upsert(rotatingRows, { onConflict: "portfolio_id,condition_id" })) as {
          error: { message: string } | null;
        };

        if (rotatingError) {
          console.error(
            `[polymarket] rotating upsert failed for portfolio ${portfolioId}:`,
            rotatingError.message,
          );
          errors.push(`portfolio ${portfolioId} rotating: ${rotatingError.message}`);
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
    pinnedSlugsFound: pinnedBySlug.size,
    portfoliosProcessed,
    portfoliosSkipped,
    errors,
  };

  console.log("[polymarket] fanout complete:", result);
  return result;
}
