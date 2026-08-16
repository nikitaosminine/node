// ---------------------------------------------------------------------------
// Firecrawl news-search provider for the news fanout (1A-117).
//
// One POST /v2/search per query with sources:["news"] and inline summaries
// (scrapeOptions:{formats:["summary"]}), replacing the Exa search + contents
// pair. Summaries ride on the search call, so the fanout costs 0 extra
// subrequests. Recaps still use Exa — this module serves the news fanout only.
// ---------------------------------------------------------------------------

const FIRECRAWL_BASE = "https://api.firecrawl.dev";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// Raw news result from POST /v2/search. `snippet` is raw cached page markdown
// (nav boilerplate, multi-KB) — never display it. `imageUrl` is a base64
// data-URI thumbnail — never persist it. When the inline scrape succeeds the
// result additionally carries `summary` and full page `metadata`.
export interface FirecrawlNewsItem {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string; // human-relative ("5 days ago") or absolute ("Nov 12, 2017")
  imageUrl?: string;
  position?: number; // 1-based rank
  description?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface FirecrawlSearchResponse {
  success?: boolean;
  data?: { news?: FirecrawlNewsItem[] };
  creditsUsed?: number;
  error?: string;
}

// Provider-agnostic shape consumed by the fanout's ingest/filter phases.
export interface NewsSearchResult {
  url: string;
  title: string;
  /** ISO timestamp, or null when the date could not be resolved. */
  publishedAt: string | null;
  /** Inline summary; empty string when the scrape failed (kept as-is downstream). */
  summary: string;
  /** metadata["og:image"] when scraped; never the data-URI imageUrl. */
  image: string | null;
  /** Rank-decay relevance replacement for Exa's score — see providerScore(). */
  providerScore: number;
}

// The API rejects bare tokens: keys must carry the fc- prefix. Secrets are
// sometimes stored as the bare hex, so normalize here instead of failing.
export function normalizeFirecrawlKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.startsWith("fc-") ? trimmed : `fc-${trimmed}`;
}

// Firecrawl returns no relevance score, but its 1-based rank is empirically
// meaningful (all on-target company results sat at rank ≤ 7 in the 1A-114
// spike). Rank decay: 1 → 1.0, 5 → 0.81, 10 → 0.63, 15 → 0.49; the 0.2 clamp
// does not bind within the production limits (10 for company queries, 15 for
// market-topic queries). Missing rank → 0.5, mirroring the old missing-score
// convention.
export function providerScore(position: number | null | undefined): number {
  if (typeof position !== "number" || !Number.isFinite(position) || position < 1) return 0.5;
  return Math.max(0.2, 0.95 ** (position - 1));
}

const RELATIVE_DATE_RE = /^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i;
const RELATIVE_UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

// Firecrawl news dates are human-relative strings ("5 days ago"), never ISO.
// Absolute forms ("Nov 12, 2017") fall through to Date.parse.
export function parseFirecrawlDate(raw: string | null | undefined, nowMs: number): string | null {
  if (!raw) return null;
  const text = raw.trim();
  const m = RELATIVE_DATE_RE.exec(text);
  if (m) {
    const amount = Number(m[1]);
    const unitMs = RELATIVE_UNIT_MS[m[2].toLowerCase()];
    return new Date(nowMs - amount * unitMs).toISOString();
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

// Scraped page metadata recovers exact ISO timestamps under site-variant keys.
const METADATA_DATE_KEYS = [
  "article:published_time",
  "publishedTime",
  "datePublished",
  "article.published",
];

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  if (typeof value === "string") return value;
  // Repeated meta tags arrive as arrays — take the first string.
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

// Published-at resolution: scraped metadata ISO (exact) wins over the search
// result's relative date string (day-granular).
export function resolvePublishedAt(item: FirecrawlNewsItem, nowMs: number): string | null {
  for (const key of METADATA_DATE_KEYS) {
    const raw = metadataString(item.metadata, key);
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return parseFirecrawlDate(item.date, nowMs);
}

// ~6% of results arrive as google.com/goto redirect wrappers around a
// protobuf-encoded inner URL. They break every hostname-derived mechanism
// (allowlist trust, source tier, cluster key) and never yield summaries; their
// stories largely duplicate unwrapped results — drop them.
export function isGoogleWrappedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return host === "google.com" || host.endsWith(".google.com");
  } catch {
    return false;
  }
}

function resolveImage(item: FirecrawlNewsItem): string | null {
  const ogImage = metadataString(item.metadata, "og:image");
  return ogImage && /^https?:\/\//i.test(ogImage) ? ogImage : null;
}

export function mapFirecrawlNewsResults(
  items: FirecrawlNewsItem[],
  nowMs: number,
): { results: NewsSearchResult[]; googleWrappedDropped: number } {
  const results: NewsSearchResult[] = [];
  let googleWrappedDropped = 0;
  for (const item of items) {
    if (!item.url) continue;
    if (isGoogleWrappedUrl(item.url)) {
      googleWrappedDropped++;
      continue;
    }
    results.push({
      url: item.url,
      title: item.title ?? "",
      publishedAt: resolvePublishedAt(item, nowMs),
      summary: item.summary ?? "",
      image: resolveImage(item),
      providerScore: providerScore(item.position),
    });
  }
  return { results, googleWrappedDropped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FirecrawlSearchOptions {
  query: string;
  limit: number;
  location: string;
  includeDomains: string[];
}

// Search with retry/backoff: 429/5xx and network failures retry with
// exponential backoff; deterministic 4xx fails fast. Mirrors the Exa
// semantics this replaces.
export async function firecrawlSearchNews(
  apiKey: string,
  options: FirecrawlSearchOptions,
  attempt = 1,
): Promise<FirecrawlSearchResponse> {
  let res: Response;
  try {
    res = await fetch(`${FIRECRAWL_BASE}/v2/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${normalizeFirecrawlKey(apiKey)}`,
      },
      body: JSON.stringify({
        query: options.query,
        sources: ["news"],
        limit: options.limit,
        // tbs qdr:w asks for the last 7 days but leaks ~12% older results —
        // the fanout applies its own explicit window filter on publishedAt.
        tbs: "qdr:w",
        location: options.location,
        includeDomains: options.includeDomains,
        // Inline summaries: 2-3 sentence article summaries ride on the search
        // call (works through paywalls; failed scrapes are free and simply
        // omit `summary`).
        scrapeOptions: { formats: ["summary"] },
      }),
    });
  } catch (err) {
    if (attempt >= MAX_RETRIES) throw err;
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return firecrawlSearchNews(apiKey, options, attempt + 1);
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= MAX_RETRIES) {
      const body = await res.text().catch(() => "");
      throw new Error(`Firecrawl ${res.status} after ${MAX_RETRIES} attempts: ${body}`);
    }
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return firecrawlSearchNews(apiKey, options, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Firecrawl ${res.status}: ${body}`);
  }

  return res.json() as Promise<FirecrawlSearchResponse>;
}
