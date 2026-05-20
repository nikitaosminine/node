import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  MARKETAUX_API_KEY?: string;
}

interface PortfolioRow {
  id: string;
  user_id: string;
}

interface HoldingRow {
  id: string;
  ticker: string;
  isin: string | null;
  asset_type: string | null;
  name: string;
  quantity: number;
}

interface EtfConstituentTopSector {
  sector: string;
  weight_pct: number;
}

interface GeographyAllocationRow {
  country_code: string;
  weight_pct: number;
}

// Marketaux API shapes
interface MarketauxArticle {
  uuid?: string;
  title?: string;
  description?: string;
  snippet?: string;
  url?: string;
  image_url?: string;
  source?: string;
  published_at?: string;
  similar?: string; // cluster key
  entities?: MarketauxEntity[];
}

interface MarketauxEntity {
  symbol?: string;
  isin?: string;
  name?: string;
  exchange_short?: string;
  country?: string;
  industry?: string;
  sentiment_score?: number;
  type?: string;
}

interface MarketauxResponse {
  data?: MarketauxArticle[];
  error?: { code?: string; message?: string };
  meta?: { found?: number; returned?: number; limit?: number; page?: number };
}

// Internal matching structures
interface NewsClusterEntities {
  isins: string[];
  tickers: string[];
  countries: string[];
  sectors: string[];
}

interface PortfolioNewsContext {
  portfolioId: string;
  stockIsins: string[];
  stockTickers: string[];
  etfSectors: string[];
  etfCountries: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKETAUX_BASE = "https://api.marketaux.com";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const CLUSTER_TTL_HOURS = 48;

// Marketaux industry labels corresponding to GICS sector names (best-effort mapping)
// Used to build the `industries` filter for ETF holdings
const SECTOR_TO_INDUSTRY_MAP: Record<string, string> = {
  Technology: "Technology",
  Financials: "Financial Services",
  "Health Care": "Healthcare",
  Industrials: "Industrials",
  "Consumer Discretionary": "Consumer Cyclical",
  "Consumer Staples": "Consumer Defensive",
  Energy: "Energy",
  Materials: "Basic Materials",
  "Real Estate": "Real Estate",
  Utilities: "Utilities",
  "Communication Services": "Communication Services",
};

// ---------------------------------------------------------------------------
// Helper: is an asset fund-like (ETF/mutual fund)?
// Mirrors the logic in geography.ts without importing cross-file
// ---------------------------------------------------------------------------

function isFundLike(assetType: string | null | undefined, name = ""): boolean {
  const value = `${assetType ?? ""} ${name}`.toLowerCase();
  return /\betf\b|exchange traded fund|mutual\s*fund|\bfund\b|\bucits\b/.test(value);
}

// ---------------------------------------------------------------------------
// Helper: build per-portfolio Marketaux query context
// ---------------------------------------------------------------------------

async function buildPortfolioNewsContext(
  client: AnySupabaseClient,
  portfolioId: string,
): Promise<PortfolioNewsContext> {
  const [holdingsResult, geographyResult] = await Promise.all([
    client
      .from("holdings")
      .select("id,ticker,isin,asset_type,name,quantity")
      .eq("portfolio_id", portfolioId)
      .gt("quantity", 0),
    client
      .from("holding_geography_allocations")
      .select("country_code,weight_pct")
      .eq("portfolio_id", portfolioId),
  ]);

  const holdings: HoldingRow[] = (holdingsResult.data as HoldingRow[] | null) ?? [];
  const geoAllocations: GeographyAllocationRow[] =
    (geographyResult.data as GeographyAllocationRow[] | null) ?? [];

  const stockIsins: string[] = [];
  const stockTickers: string[] = [];
  const etfHoldingIds: string[] = [];

  for (const h of holdings) {
    if (isFundLike(h.asset_type, h.name)) {
      etfHoldingIds.push(h.id);
    } else {
      if (h.isin) stockIsins.push(h.isin);
      else stockTickers.push(h.ticker);
    }
  }

  // Pull ETF top sectors from the central registry for each ETF's ISIN
  const etfIsins = holdings
    .filter((h) => isFundLike(h.asset_type, h.name) && h.isin)
    .map((h) => h.isin as string);

  let etfSectors: string[] = [];
  if (etfIsins.length > 0) {
    const { data: constituentRows } = (await client
      .from("etf_constituents")
      .select("top_sectors")
      .in("etf_isin", etfIsins)) as { data: Array<{ top_sectors: unknown }> | null; error: unknown };

    const sectorSet = new Set<string>();
    for (const row of constituentRows ?? []) {
      const topSectors = (row.top_sectors as EtfConstituentTopSector[] | null) ?? [];
      // Include top 3 sectors per ETF by weight
      for (const s of topSectors.slice(0, 3)) {
        const mapped = SECTOR_TO_INDUSTRY_MAP[s.sector];
        if (mapped) sectorSet.add(mapped);
      }
    }
    etfSectors = Array.from(sectorSet);
  }

  // Top countries by weight from geography allocations (top 5)
  const sortedCountries = geoAllocations
    .filter((g) => g.country_code && g.weight_pct > 0)
    .sort((a, b) => b.weight_pct - a.weight_pct)
    .slice(0, 5)
    .map((g) => g.country_code.toLowerCase());

  return {
    portfolioId,
    stockIsins: [...new Set(stockIsins)],
    stockTickers: [...new Set(stockTickers)],
    etfSectors,
    etfCountries: [...new Set(sortedCountries)],
  };
}

// ---------------------------------------------------------------------------
// Helper: fetch Marketaux with retry/backoff
// ---------------------------------------------------------------------------

async function fetchMarketaux(
  apiKey: string,
  params: Record<string, string>,
  attempt = 1,
): Promise<MarketauxResponse> {
  const url = new URL(`${MARKETAUX_BASE}/v1/news/all`);
  url.searchParams.set("api_token", apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    if (attempt >= MAX_RETRIES) throw err;
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return fetchMarketaux(apiKey, params, attempt + 1);
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= MAX_RETRIES) {
      const body = await res.text().catch(() => "");
      throw new Error(`Marketaux ${res.status} after ${MAX_RETRIES} attempts: ${body}`);
    }
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return fetchMarketaux(apiKey, params, attempt + 1);
  }

  return res.json() as Promise<MarketauxResponse>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Helper: build Marketaux query params for a portfolio
// ---------------------------------------------------------------------------

function buildMarketauxParams(
  ctx: PortfolioNewsContext,
  publishedAfter: string,
): Record<string, string> | null {
  const params: Record<string, string> = {
    published_after: publishedAfter,
    group_similar: "true",
    language: "en,fr",
    limit: "50",
    sort: "published_at",
    sort_order: "desc",
  };

  const hasIsins = ctx.stockIsins.length > 0;
  const hasEntitySymbols = ctx.stockTickers.length > 0;
  const hasSectors = ctx.etfSectors.length > 0;
  const hasCountries = ctx.etfCountries.length > 0;

  if (hasIsins) {
    // Primary: ISIN-based entity matching
    params["entity_isin"] = ctx.stockIsins.slice(0, 10).join(",");
  } else if (hasEntitySymbols) {
    params["entity_types"] = "equity";
    params["symbols"] = ctx.stockTickers.slice(0, 10).join(",");
  }

  if (hasSectors) {
    params["industries"] = ctx.etfSectors.slice(0, 5).join(",");
  }

  if (hasCountries) {
    params["countries"] = ctx.etfCountries.slice(0, 5).join(",");
  }

  // If we have no query signal at all, skip this portfolio
  if (!hasIsins && !hasEntitySymbols && !hasSectors && !hasCountries) {
    return null;
  }

  return params;
}

// ---------------------------------------------------------------------------
// Helper: parse article entities into our standard shape
// ---------------------------------------------------------------------------

function extractClusterEntities(articles: MarketauxArticle[]): NewsClusterEntities {
  const isins = new Set<string>();
  const tickers = new Set<string>();
  const countries = new Set<string>();
  const sectors = new Set<string>();

  for (const article of articles) {
    for (const entity of article.entities ?? []) {
      if (entity.isin) isins.add(entity.isin.toUpperCase());
      if (entity.symbol) tickers.add(entity.symbol.toUpperCase());
      if (entity.country) countries.add(entity.country.toUpperCase());
      if (entity.industry) sectors.add(entity.industry);
    }
  }

  return {
    isins: Array.from(isins),
    tickers: Array.from(tickers),
    countries: Array.from(countries),
    sectors: Array.from(sectors),
  };
}

// ---------------------------------------------------------------------------
// Helper: compute relevance score for a cluster vs a portfolio context
// entity_weight × recency_decay
// ---------------------------------------------------------------------------

function computeMatchScore(
  clusterEntities: NewsClusterEntities,
  ctx: PortfolioNewsContext,
  publishedAt: string,
): { score: number; matchReason: Record<string, string[]> } {
  const matchedIsins: string[] = [];
  const matchedTickers: string[] = [];
  const matchedCountrySector: string[] = [];

  // ISIN overlap
  for (const isin of clusterEntities.isins) {
    if (ctx.stockIsins.includes(isin)) matchedIsins.push(isin);
  }

  // Ticker overlap (for stocks with no ISIN)
  for (const ticker of clusterEntities.tickers) {
    if (ctx.stockTickers.includes(ticker)) matchedTickers.push(ticker);
  }

  // ETF sector/country overlap
  for (const sector of clusterEntities.sectors) {
    if (ctx.etfSectors.includes(sector)) matchedCountrySector.push(`sector:${sector}`);
  }
  for (const country of clusterEntities.countries) {
    if (ctx.etfCountries.includes(country.toLowerCase())) {
      matchedCountrySector.push(`country:${country}`);
    }
  }

  // Entity weight: prioritise direct ISIN/ticker match over sector/country match
  let entityWeight = 0;
  if (matchedIsins.length > 0) entityWeight = Math.min(1, 0.5 + matchedIsins.length * 0.15);
  else if (matchedTickers.length > 0) entityWeight = Math.min(1, 0.4 + matchedTickers.length * 0.15);
  else if (matchedCountrySector.length > 0) entityWeight = Math.min(0.6, matchedCountrySector.length * 0.1);

  // Recency decay: linear from 1.0 (now) to 0.1 at 48 h
  const ageHours = (Date.now() - new Date(publishedAt).getTime()) / 3_600_000;
  const recencyDecay = Math.max(0.1, 1 - (ageHours / CLUSTER_TTL_HOURS) * 0.9);

  const score = Math.round(entityWeight * recencyDecay * 10000) / 10000;

  return {
    score,
    matchReason: {
      matched_isins: matchedIsins,
      matched_tickers: matchedTickers,
      matched_country_sector: matchedCountrySector,
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: upsert a single cluster and its portfolio bridge row
// ---------------------------------------------------------------------------

async function upsertCluster(
  client: AnySupabaseClient,
  article: MarketauxArticle,
  allArticlesInCluster: MarketauxArticle[],
  clusterKey: string,
): Promise<string | null> {
  const publishedAt = article.published_at ?? new Date().toISOString();
  const newExpiresAt = new Date(
    new Date(publishedAt).getTime() + CLUSTER_TTL_HOURS * 3_600_000,
  ).toISOString();

  // Build primary_article (no sentiment)
  const primaryArticle = {
    title: article.title ?? "",
    url: article.url ?? "",
    source: article.source ?? "",
    published_at: publishedAt,
    snippet: article.snippet ?? article.description ?? "",
    image: article.image_url ?? null,
  };

  // Build see_also from sibling articles (all except primary)
  const seeAlso = allArticlesInCluster
    .filter((a) => a.uuid !== article.uuid)
    .slice(0, 5)
    .map((a) => ({
      title: a.title ?? "",
      url: a.url ?? "",
      source: a.source ?? "",
    }));

  // Extract entities from all articles in the cluster
  const entities = extractClusterEntities(allArticlesInCluster);

  // Upsert with expires_at = GREATEST(existing, new)
  // We do a select first to check existing expires_at, then upsert
  const { data: existing } = (await client
    .from("news_clusters")
    .select("id,expires_at")
    .eq("cluster_key", clusterKey)
    .maybeSingle()) as { data: { id: string; expires_at: string } | null; error: unknown };

  const existingExpiresAt = existing?.expires_at ? new Date(existing.expires_at) : null;
  const expiresAt =
    existingExpiresAt && existingExpiresAt > new Date(newExpiresAt)
      ? existingExpiresAt.toISOString()
      : newExpiresAt;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: upserted, error } = (await (client as any)
    .from("news_clusters")
    .upsert(
      {
        cluster_key: clusterKey,
        primary_article: primaryArticle,
        see_also: seeAlso,
        entities,
        published_at: publishedAt,
        fetched_at: new Date().toISOString(),
        expires_at: expiresAt,
      },
      { onConflict: "cluster_key" },
    )
    .select("id")
    .maybeSingle()) as { data: { id: string } | null; error: { message: string } | null };

  if (error) {
    console.error(`[news] cluster upsert failed for key ${clusterKey}:`, error.message);
    return null;
  }

  // If upsert doesn't return the id (e.g. no-op), look it up
  if (upserted?.id) return upserted.id;
  const { data: fetched } = (await client
    .from("news_clusters")
    .select("id")
    .eq("cluster_key", clusterKey)
    .maybeSingle()) as { data: { id: string } | null; error: unknown };
  return fetched?.id ?? null;
}

// ---------------------------------------------------------------------------
// Main: runNewsFanout
// ---------------------------------------------------------------------------

export async function runNewsFanout(env: Env): Promise<{
  portfoliosProcessed: number;
  portfoliosSkipped: number;
  clustersUpserted: number;
  matchesUpserted: number;
  expiredSwept: number;
  errors: string[];
}> {
  if (!env.MARKETAUX_API_KEY) {
    console.warn("[news] MARKETAUX_API_KEY not set — skipping news fanout");
    return {
      portfoliosProcessed: 0,
      portfoliosSkipped: 0,
      clustersUpserted: 0,
      matchesUpserted: 0,
      expiredSwept: 0,
      errors: ["MARKETAUX_API_KEY not configured"],
    };
  }

  const client: AnySupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  // Fetch all portfolios
  const { data: portfoliosData, error: portfoliosError } = await client
    .from("portfolios")
    .select("id,user_id");

  if (portfoliosError || !portfoliosData) {
    throw new Error(`[news] failed to fetch portfolios: ${portfoliosError?.message}`);
  }

  const portfolios = portfoliosData as PortfolioRow[];

  // published_after = 48h ago
  // Marketaux expects "YYYY-MM-DDTHH:MM:SS" — no milliseconds, no Z suffix.
  const publishedAfter = new Date(Date.now() - CLUSTER_TTL_HOURS * 3_600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "");

  let portfoliosProcessed = 0;
  let portfoliosSkipped = 0;
  let clustersUpserted = 0;
  let matchesUpserted = 0;
  const errors: string[] = [];

  for (const portfolio of portfolios) {
    const portfolioId = portfolio.id;

    try {
      // Build query context for this portfolio
      const ctx = await buildPortfolioNewsContext(client, portfolioId);
      const params = buildMarketauxParams(ctx, publishedAfter);

      if (!params) {
        portfoliosSkipped++;
        continue;
      }

      // Fetch from Marketaux
      let response: MarketauxResponse;
      try {
        response = await fetchMarketaux(env.MARKETAUX_API_KEY, params);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[news] Marketaux fetch failed for portfolio ${portfolioId}:`, msg);
        errors.push(`portfolio ${portfolioId}: ${msg}`);
        portfoliosSkipped++;
        continue;
      }

      if (response.error) {
        const msg = response.error.message ?? response.error.code ?? "unknown error";
        console.error(`[news] Marketaux API error for portfolio ${portfolioId}:`, msg);
        errors.push(`portfolio ${portfolioId}: Marketaux error ${msg}`);
        portfoliosSkipped++;
        continue;
      }

      const articles = response.data ?? [];
      if (articles.length === 0) {
        portfoliosProcessed++;
        continue;
      }

      // Group articles by cluster_key (Marketaux `similar` field).
      // Articles without a `similar` field get their own cluster keyed by uuid.
      const clusterMap = new Map<string, MarketauxArticle[]>();
      for (const article of articles) {
        const key = article.similar ?? article.uuid ?? `solo-${article.url ?? Math.random()}`;
        const existing = clusterMap.get(key) ?? [];
        existing.push(article);
        clusterMap.set(key, existing);
      }

      // Process each cluster
      const clusterIdsByKey = new Map<string, string>();
      for (const [clusterKey, clusterArticles] of clusterMap) {
        // Use the first (most recent, per sort=published_at desc) article as primary
        const primary = clusterArticles[0];
        if (!primary) continue;

        const clusterId = await upsertCluster(client, primary, clusterArticles, clusterKey);
        if (clusterId) {
          clusterIdsByKey.set(clusterKey, clusterId);
          clustersUpserted++;
        }
      }

      // Upsert portfolio_news_matches
      for (const [clusterKey, clusterId] of clusterIdsByKey) {
        const clusterArticles = clusterMap.get(clusterKey) ?? [];
        const primary = clusterArticles[0];
        if (!primary) continue;

        const clusterEntities = extractClusterEntities(clusterArticles);
        const publishedAt = primary.published_at ?? new Date().toISOString();
        const { score, matchReason } = computeMatchScore(clusterEntities, ctx, publishedAt);

        // Only store matches with non-zero score
        if (score === 0) continue;

        const { error: matchError } = await client.from("portfolio_news_matches").upsert(
          {
            portfolio_id: portfolioId,
            cluster_id: clusterId,
            score,
            match_reason: matchReason,
          },
          { onConflict: "portfolio_id,cluster_id" },
        );

        if (matchError) {
          console.error(
            `[news] match upsert failed for portfolio ${portfolioId} cluster ${clusterId}:`,
            matchError.message,
          );
        } else {
          matchesUpserted++;
        }
      }

      portfoliosProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[news] unexpected error for portfolio ${portfolioId}:`, msg);
      errors.push(`portfolio ${portfolioId}: ${msg}`);
      portfoliosSkipped++;
    }
  }

  // Sweep expired clusters (no portfolio references needed — cascade handles bridge)
  const { count: expiredSwept, error: sweepError } = await client
    .from("news_clusters")
    .delete({ count: "exact" })
    .lt("expires_at", new Date().toISOString());

  if (sweepError) {
    console.error("[news] expired sweep failed:", sweepError.message);
  }

  const result = {
    portfoliosProcessed,
    portfoliosSkipped,
    clustersUpserted,
    matchesUpserted,
    expiredSwept: expiredSwept ?? 0,
    errors,
  };

  console.log("[news] fanout complete:", result);
  return result;
}
