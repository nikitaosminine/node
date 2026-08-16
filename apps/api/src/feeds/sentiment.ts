// ---------------------------------------------------------------------------
// News sentiment scoring: one cheap Grok call per fanout run, scoring every
// newly-upserted (cluster, company) pair, plus the pure EWMA math used to
// roll per-company scores forward. Self-contained (no cross-import from
// index.ts/polymarket.ts), mirroring the strict-JSON pattern used by
// `invokeGrokWebGeographyResearch` (index.ts) and Polymarket's
// `scoreRotatingCandidates` (feeds/polymarket.ts).
// ---------------------------------------------------------------------------

interface Env {
  GROK_MAIN_API_KEY?: string;
  GROK_SUB_API_KEY?: string;
  GROK_NORMALIZATION_API_KEY?: string;
  GROK_API_BASE_URL?: string;
  SENTIMENT_GROK_MODEL?: string;
}

export interface SentimentCompanyRef {
  canonicalKey: string;
  name: string;
  tickers: string[];
  isins: string[];
}

export interface SentimentTarget {
  clusterKey: string;
  title: string;
  summary: string;
  companies: SentimentCompanyRef[];
}

export interface ClusterSentiment {
  clusterKey: string;
  companyKey: string;
  score: number;
  rationale: string;
}

interface GrokChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

const DEFAULT_SENTIMENT_MODEL = "grok-4-1-fast-non-reasoning";

function getGrokBaseUrl(env: Env): string {
  return (env.GROK_API_BASE_URL || "https://api.x.ai/v1").replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Prompt: one numbered (cluster, company) pair per line — batches every
// newly-upserted cluster's entities into a single strict-JSON call.
// ---------------------------------------------------------------------------

export function buildSentimentPrompt(targets: SentimentTarget[]): {
  systemPrompt: string;
  userPrompt: string;
  pairIndex: Map<number, { clusterKey: string; companyKey: string }>;
} {
  const systemPrompt = `You are a financial news sentiment analyst. For each numbered (article, company) pair, judge how the article's content affects sentiment toward that specific company.

Score from -1 (very negative for the company) to 1 (very positive), 0 = neutral/mixed/no clear signal.
Write ONE short sentence (max ~20 words) explaining why.

Return ONLY strict JSON: {"scores": [{"i": <pair number>, "sentiment": <number -1..1>, "rationale": "<one sentence>"}]}
Include exactly one entry per numbered pair. Do not invent pairs.`;

  const pairIndex = new Map<number, { clusterKey: string; companyKey: string }>();
  const lines: string[] = [];
  let i = 0;
  for (const target of targets) {
    for (const company of target.companies) {
      i++;
      pairIndex.set(i, { clusterKey: target.clusterKey, companyKey: company.canonicalKey });
      const snippet = target.summary || target.title;
      lines.push(`${i}. Company: ${company.name}\n   Article: "${target.title}" — ${snippet}`.trim());
    }
  }

  const userPrompt = `Score sentiment for each pair below:\n\n${lines.join("\n\n")}`;
  return { systemPrompt, userPrompt, pairIndex };
}

// ---------------------------------------------------------------------------
// Grok call — chat/completions, strict JSON object response.
// ---------------------------------------------------------------------------

export async function invokeSentimentGrok(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = env.GROK_MAIN_API_KEY ?? env.GROK_SUB_API_KEY ?? env.GROK_NORMALIZATION_API_KEY;
  if (!apiKey) throw new Error("[sentiment] No Grok API key available");

  const res = await fetch(`${getGrokBaseUrl(env)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.SENTIMENT_GROK_MODEL || DEFAULT_SENTIMENT_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Grok sentiment scoring failed (${res.status}): ${body.slice(0, 400)}`);
  }

  const data = (await res.json()) as GrokChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Grok sentiment scoring returned no content");
  return content;
}

// ---------------------------------------------------------------------------
// Strict-JSON parsing — tolerant of a stray code fence, validates every item
// against the pair index built alongside the prompt so a hallucinated
// index/company can never be attributed to the wrong cluster.
// ---------------------------------------------------------------------------

export function parseSentimentResponse(
  raw: string,
  pairIndex: Map<number, { clusterKey: string; companyKey: string }>,
): ClusterSentiment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return [];
    }
  }

  const scores =
    parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).scores)
      ? ((parsed as Record<string, unknown>).scores as unknown[])
      : [];

  const out: ClusterSentiment[] = [];
  const seenIndices = new Set<number>();
  for (const item of scores) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const i = typeof rec.i === "number" ? rec.i : Number(rec.i);
    const sentiment = typeof rec.sentiment === "number" ? rec.sentiment : Number(rec.sentiment);
    if (!Number.isFinite(i) || !Number.isFinite(sentiment)) continue;
    if (seenIndices.has(i)) continue;
    const ref = pairIndex.get(i);
    if (!ref) continue;
    seenIndices.add(i);

    out.push({
      clusterKey: ref.clusterKey,
      companyKey: ref.companyKey,
      score: Math.max(-1, Math.min(1, sentiment)),
      rationale: typeof rec.rationale === "string" ? rec.rationale.slice(0, 300) : "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration: score every target in one Grok call. Never throws — a
// scoring failure must not block the fanout from populating the feed.
// ---------------------------------------------------------------------------

export async function scoreClusterSentiments(
  env: Env,
  targets: SentimentTarget[],
): Promise<{ sentiments: ClusterSentiment[]; error: string | null }> {
  if (targets.length === 0) return { sentiments: [], error: null };

  const { systemPrompt, userPrompt, pairIndex } = buildSentimentPrompt(targets);
  if (pairIndex.size === 0) return { sentiments: [], error: null };

  try {
    const raw = await invokeSentimentGrok(env, systemPrompt, userPrompt);
    return { sentiments: parseSentimentResponse(raw, pairIndex), error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sentiment] scoring failed:", msg);
    return { sentiments: [], error: msg };
  }
}

// ---------------------------------------------------------------------------
// Rolling per-company EWMA. alpha weights the newest observation; a company
// with no prior score simply starts at the observed value (no history to
// smooth against). Trend compares the new score to the prior one with a
// deadband so noise-level moves don't flip the label back and forth.
// ---------------------------------------------------------------------------

export const SENTIMENT_EWMA_ALPHA = 0.35;
const TREND_DEADBAND = 0.05;

export type SentimentTrend = "up" | "down" | "flat";

export function computeEwma(
  priorScore: number | null,
  observedScore: number,
  alpha: number = SENTIMENT_EWMA_ALPHA,
): { score: number; trend: SentimentTrend } {
  const clampedObserved = Math.max(-1, Math.min(1, observedScore));
  if (priorScore === null || !Number.isFinite(priorScore)) {
    return { score: Math.round(clampedObserved * 10000) / 10000, trend: "flat" };
  }
  const next = alpha * clampedObserved + (1 - alpha) * priorScore;
  const delta = next - priorScore;
  const trend: SentimentTrend = delta > TREND_DEADBAND ? "up" : delta < -TREND_DEADBAND ? "down" : "flat";
  return { score: Math.round(next * 10000) / 10000, trend };
}

// Aggregate this run's per-cluster scores into one observation per company
// (mean across every cluster that mentioned it this run) before feeding
// computeEwma — a company mentioned in 3 clusters this run gets one rolling
// update, not three compounding ones. Clusters already recorded in that
// company's prior evidence_cluster_ids are re-fetches surfacing again within
// the 7-day window, not new observations, so they are excluded; a company
// with nothing new this run is omitted entirely (its rolling row is left
// untouched).
export function aggregateObservationsByCompany(
  sentiments: ClusterSentiment[],
  priorEvidenceByCompany?: Map<string, Set<string>>,
): Map<string, { observedScore: number; clusterKeys: string[] }> {
  const byCompany = new Map<string, { scores: number[]; clusterKeys: string[] }>();
  for (const s of sentiments) {
    if (priorEvidenceByCompany?.get(s.companyKey)?.has(s.clusterKey)) continue;
    let acc = byCompany.get(s.companyKey);
    if (!acc) {
      acc = { scores: [], clusterKeys: [] };
      byCompany.set(s.companyKey, acc);
    }
    acc.scores.push(s.score);
    acc.clusterKeys.push(s.clusterKey);
  }

  const out = new Map<string, { observedScore: number; clusterKeys: string[] }>();
  for (const [companyKey, acc] of byCompany) {
    const observedScore = acc.scores.reduce((a, b) => a + b, 0) / acc.scores.length;
    out.set(companyKey, { observedScore, clusterKeys: acc.clusterKeys });
  }
  return out;
}

// Cluster-id lists kept on the rolling row, newest first, bounded so the
// jsonb columns don't grow unbounded across months of fanout runs. Two caps:
// evidence_cluster_ids is a short display/API list, while scored_cluster_ids
// is the EWMA re-observation dedupe set and must comfortably exceed the
// realistic per-company cluster count within the 7-day TTL window
// (RESULTS_PER_COMPANY=25 per fanout, several fanouts/day) so display-cap
// eviction can never resurrect an already-observed cluster.
export const MAX_EVIDENCE_CLUSTER_IDS = 10;
export const MAX_SCORED_CLUSTER_IDS = 200;

function capIds(existing: string[], fresh: string[], max: number): string[] {
  const merged = [...fresh, ...existing.filter((id) => !fresh.includes(id))];
  return merged.slice(0, max);
}

export function mergeEvidenceClusterIds(existing: string[], fresh: string[]): string[] {
  return capIds(existing, fresh, MAX_EVIDENCE_CLUSTER_IDS);
}

export function mergeScoredClusterIds(existing: string[], fresh: string[]): string[] {
  return capIds(existing, fresh, MAX_SCORED_CLUSTER_IDS);
}
