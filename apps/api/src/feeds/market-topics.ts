import { ETF_UNDERLYING_LABELS } from "./portfolio-profile";

// ---------------------------------------------------------------------------
// ETF → market-topic taxonomy for the news fanout.
//
// Each held ETF maps to 1-2 market topics. A topic carries a provider-agnostic
// news search query plus a relevance-term list (the market analog of the
// per-company `mentionsCompany` drift filter). Well-known ETFs resolve through
// a static override table; everything else is derived best-effort from
// `etf_constituents` (top sectors) and `holding_geography_allocations`
// (country mix). Neither data source is required — an ETF with no static
// match and no data simply contributes no topics.
// ---------------------------------------------------------------------------

export interface MarketTopic {
  /** Stable topic id — dedup key across ETFs and providers. */
  topicKey: string;
  /** Human label, surfaced via match_reason.matched_topics. */
  label: string;
  /** News search query (provider-agnostic — no Exa-specific syntax). */
  query: string;
  /** OR-matched terms for the topic-relevance drift filter (word-boundary). */
  relevanceTerms: string[];
  /** ISO-3166 alpha-2 codes for news_clusters.entities.countries. */
  countries: string[];
  /** Sector labels for news_clusters.entities.sectors. */
  sectors: string[];
}

export interface EtfHoldingInfo {
  ticker: string;
  isin: string | null;
  name: string;
}

export interface EtfMarketData {
  /** From etf_constituents.top_sectors — best-effort, may be missing. */
  topSectors?: Array<{ sector: string; weight_pct: number }> | null;
  /** From holding_geography_allocations — best-effort, may be missing. */
  countryWeights?: Array<{ country_code: string; country_name: string; weight_pct: number }> | null;
  /** Top constituent names/tickers, folded into relevance terms. */
  topConstituents?: string[] | null;
}

export const MAX_TOPICS_PER_ETF = 2;

// A dynamic country/sector must carry at least this share of the ETF before it
// spawns a topic — avoids one topic per 3%-weight tail country.
const MIN_DYNAMIC_WEIGHT_PCT = 25;

// ---------------------------------------------------------------------------
// Static override table for well-known ETFs. Matched on the holding name
// first, then on the exchange-qualified ticker (with or without suffix).
// ---------------------------------------------------------------------------

interface StaticEtfTopic {
  nameRe: RegExp;
  tickers: string[];
  topics: Omit<MarketTopic, "relevanceTerms">[];
  /** Base relevance terms per topicKey; constituent names are appended at runtime. */
  relevanceTerms: Record<string, string[]>;
}

const STATIC_ETF_TOPICS: StaticEtfTopic[] = [
  {
    nameRe: /nasdaq/i,
    tickers: ["PUST"],
    topics: [
      {
        topicKey: "us-tech-market",
        label: "US tech market",
        query: "US technology stocks and Nasdaq-100 market latest news and developments",
        countries: ["US"],
        sectors: ["Technology"],
      },
    ],
    relevanceTerms: {
      "us-tech-market": [
        "nasdaq", "tech stocks", "technology stocks", "big tech", "megacap", "mega-cap",
        "semiconductor", "semiconductors", "chipmaker", "chip stocks", "artificial intelligence",
        "ai stocks", "ai boom", "ai spending", "silicon valley", "software stocks", "cloud computing",
      ],
    },
  },
  {
    nameRe: /s\s*&\s*p\s*500|sp\s*500|s&p500/i,
    tickers: [],
    topics: [
      {
        topicKey: "us-economy",
        label: "US economy & broad market",
        query: "US economy, Federal Reserve policy and S&P 500 stock market latest news",
        countries: ["US"],
        sectors: [],
      },
    ],
    relevanceTerms: {
      "us-economy": [
        "s&p 500", "s&p500", "sp 500", "wall street", "us economy", "u.s. economy",
        "us stocks", "u.s. stocks", "federal reserve", "fed", "fomc", "us inflation",
        "u.s. inflation", "treasury yields", "treasuries", "jobs report", "payrolls",
        "us gdp", "u.s. gdp", "recession", "rate cut", "rate cuts", "rate hike", "us market",
      ],
    },
  },
  {
    nameRe: /(?:\bem\b|emerging).*asia|asia.*(?:\bem\b|emerging)/i,
    tickers: ["PAASI"],
    topics: [
      {
        topicKey: "china-south-korea-markets",
        label: "China & South Korea markets",
        query: "China and South Korea economy and stock markets latest news and developments",
        countries: ["CN", "KR"],
        sectors: [],
      },
    ],
    relevanceTerms: {
      "china-south-korea-markets": [
        "china", "chinese", "beijing", "shanghai", "hong kong", "hang seng", "yuan", "renminbi",
        "south korea", "korean", "seoul", "kospi", "won", "taiwan", "asian markets", "emerging markets",
      ],
    },
  },
  {
    nameRe: /japan|topix|nikkei/i,
    tickers: ["PTPXH"],
    topics: [
      {
        topicKey: "japan-macro",
        label: "Japanese economy & BoJ",
        query: "Japanese economy, Bank of Japan monetary policy and yen JPY/USD latest news",
        countries: ["JP"],
        sectors: [],
      },
    ],
    relevanceTerms: {
      "japan-macro": [
        "japan", "japanese", "bank of japan", "boj", "yen", "jpy", "nikkei", "topix",
        "tokyo", "ueda", "japanese stocks",
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Dynamic taxonomy — country and sector topics for ETFs without a static match.
// Only countries/sectors with a curated term list produce topics: relevance
// filtering needs real terms, and guessing them from a label invites drift.
// ---------------------------------------------------------------------------

const COUNTRY_TOPICS: Record<string, { label: string; query: string; terms: string[] }> = {
  US: {
    label: "US economy & markets",
    query: "US economy and stock market latest news and developments",
    terms: ["us economy", "u.s. economy", "wall street", "s&p 500", "federal reserve", "fed", "us stocks", "u.s. stocks", "nasdaq", "dow jones"],
  },
  JP: {
    label: "Japanese economy & markets",
    query: "Japanese economy and stock market latest news and developments",
    terms: ["japan", "japanese", "bank of japan", "boj", "yen", "nikkei", "topix", "tokyo"],
  },
  CN: {
    label: "China economy & markets",
    query: "China economy and stock market latest news and developments",
    terms: ["china", "chinese", "beijing", "shanghai", "hang seng", "yuan", "renminbi", "hong kong"],
  },
  KR: {
    label: "South Korea economy & markets",
    query: "South Korea economy and stock market latest news and developments",
    terms: ["south korea", "korean", "seoul", "kospi", "won"],
  },
  GB: {
    label: "UK economy & markets",
    query: "UK economy and stock market latest news and developments",
    terms: ["uk economy", "britain", "british", "bank of england", "ftse", "sterling", "pound"],
  },
  FR: {
    label: "French economy & markets",
    query: "French economy and stock market latest news and developments",
    terms: ["france", "french", "cac 40", "paris bourse", "banque de france"],
  },
  DE: {
    label: "German economy & markets",
    query: "German economy and stock market latest news and developments",
    terms: ["germany", "german", "dax", "bundesbank", "frankfurt"],
  },
  IN: {
    label: "Indian economy & markets",
    query: "Indian economy and stock market latest news and developments",
    terms: ["india", "indian", "sensex", "nifty", "rupee", "mumbai"],
  },
  TW: {
    label: "Taiwan economy & markets",
    query: "Taiwan economy and stock market latest news and developments",
    terms: ["taiwan", "taiwanese", "taipei", "tsmc"],
  },
};

const SECTOR_TOPICS: Record<string, { label: string; query: string; terms: string[] }> = {
  technology: {
    label: "Technology sector",
    query: "technology sector stocks latest news and developments",
    terms: ["tech stocks", "technology stocks", "semiconductor", "semiconductors", "software stocks", "artificial intelligence", "ai stocks", "cloud computing", "big tech"],
  },
  financials: {
    label: "Financials sector",
    query: "banking and financial sector stocks latest news and developments",
    terms: ["bank stocks", "banking sector", "financial sector", "banks", "insurers", "lenders"],
  },
  energy: {
    label: "Energy sector",
    query: "energy sector, oil and gas markets latest news and developments",
    terms: ["oil prices", "crude", "opec", "natural gas", "energy stocks", "energy sector", "brent"],
  },
  healthcare: {
    label: "Healthcare sector",
    query: "healthcare and pharmaceutical sector stocks latest news and developments",
    terms: ["pharma", "pharmaceutical", "healthcare stocks", "health care", "biotech", "drugmaker"],
  },
  industrials: {
    label: "Industrials sector",
    query: "industrial sector stocks latest news and developments",
    terms: ["industrial stocks", "industrials", "manufacturing", "aerospace", "defense stocks"],
  },
  "consumer discretionary": {
    label: "Consumer sector",
    query: "consumer and retail sector stocks latest news and developments",
    terms: ["consumer spending", "retail sales", "retailer", "consumer stocks", "luxury"],
  },
  "consumer staples": {
    label: "Consumer staples sector",
    query: "consumer staples sector stocks latest news and developments",
    terms: ["consumer staples", "food and beverage", "consumer goods"],
  },
  utilities: {
    label: "Utilities sector",
    query: "utilities sector stocks latest news and developments",
    terms: ["utilities", "utility stocks", "power prices", "electricity prices"],
  },
  materials: {
    label: "Materials sector",
    query: "materials and mining sector stocks latest news and developments",
    terms: ["mining", "commodities", "copper", "iron ore", "materials sector"],
  },
  "communication services": {
    label: "Communication services sector",
    query: "communication services and media sector stocks latest news and developments",
    terms: ["telecom", "media stocks", "communication services", "streaming"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// "Toyota (7203.T)" → "toyota"; "Samsung Electronics Co Ltd" → "samsung
// electronics". Constituent labels fold into relevance terms so stories about
// an ETF's top holdings count as on-topic. Legal suffixes are stripped the
// same way the per-company drift filter normalizes names.
function constituentTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(se|sa|plc|inc|ltd|corp|nv|ag|spa|llc|co|holdings?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackConstituents(etf: EtfHoldingInfo): string[] {
  const fromTicker =
    ETF_UNDERLYING_LABELS[etf.ticker] ?? ETF_UNDERLYING_LABELS[`${etf.ticker}.PA`];
  return fromTicker?.top5 ?? [];
}

function buildTopic(
  base: Omit<MarketTopic, "relevanceTerms">,
  baseTerms: string[],
  constituents: string[],
): MarketTopic {
  const terms = new Set(baseTerms.map((t) => t.toLowerCase()));
  for (const c of constituents) {
    const term = constituentTerm(c);
    // Very short tokens ("nv", "3m"-style) are too noisy as boundary matches.
    if (term.length >= 3) terms.add(term);
  }
  return { ...base, relevanceTerms: [...terms] };
}

// ---------------------------------------------------------------------------
// deriveMarketTopics — pure, unit-testable. Static override wins outright;
// otherwise 1-2 topics from country mix + top sector. Returns [] when nothing
// is known about the ETF (constituents/geography are best-effort).
// ---------------------------------------------------------------------------

export function deriveMarketTopics(etf: EtfHoldingInfo, data?: EtfMarketData): MarketTopic[] {
  const constituents =
    data?.topConstituents && data.topConstituents.length > 0
      ? data.topConstituents
      : fallbackConstituents(etf);

  const tickerBase = etf.ticker.split(".")[0]?.toUpperCase() ?? "";
  for (const entry of STATIC_ETF_TOPICS) {
    if (entry.nameRe.test(etf.name) || entry.tickers.includes(tickerBase)) {
      return entry.topics
        .slice(0, MAX_TOPICS_PER_ETF)
        .map((t) => buildTopic(t, entry.relevanceTerms[t.topicKey] ?? [], constituents));
    }
  }

  const topics: MarketTopic[] = [];

  const countryWeights = [...(data?.countryWeights ?? [])].sort(
    (a, b) => b.weight_pct - a.weight_pct,
  );
  for (const cw of countryWeights) {
    if (topics.length >= MAX_TOPICS_PER_ETF) break;
    if (cw.weight_pct < MIN_DYNAMIC_WEIGHT_PCT) break;
    const code = cw.country_code.toUpperCase();
    const def = COUNTRY_TOPICS[code];
    if (!def) continue;
    topics.push(
      buildTopic(
        {
          topicKey: `country-${code.toLowerCase()}`,
          label: def.label,
          query: def.query,
          countries: [code],
          sectors: [],
        },
        def.terms,
        constituents,
      ),
    );
  }

  const topSectors = [...(data?.topSectors ?? [])].sort((a, b) => b.weight_pct - a.weight_pct);
  for (const ts of topSectors) {
    if (topics.length >= MAX_TOPICS_PER_ETF) break;
    if (ts.weight_pct < MIN_DYNAMIC_WEIGHT_PCT) break;
    const key = ts.sector.trim().toLowerCase();
    const def = SECTOR_TOPICS[key];
    if (!def) continue;
    topics.push(
      buildTopic(
        {
          topicKey: `sector-${key.replace(/\s+/g, "-")}`,
          label: def.label,
          query: def.query,
          countries: [],
          sectors: [ts.sector.trim()],
        },
        def.terms,
        constituents,
      ),
    );
    break; // at most one sector topic — countries carry the rest of the budget
  }

  return topics;
}

// ---------------------------------------------------------------------------
// mentionsTopic — the market analog of the per-company `mentionsCompany` drift
// filter. A result is on-topic when any relevance term appears in the haystack
// with word boundaries (so "fed" never matches "federated" but "s&p 500" and
// multi-word phrases match as-is).
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionsTopic(haystack: string, topic: MarketTopic): boolean {
  const hay = haystack.toLowerCase();
  for (const term of topic.relevanceTerms) {
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?:$|[^\\p{L}\\p{N}])`, "u");
    if (re.test(hay)) return true;
  }
  return false;
}
