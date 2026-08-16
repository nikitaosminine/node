import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Shared portfolio-profile builder.
// Extracted verbatim from polymarket.ts so the news fanout can reuse the same
// holdings → ETF constituents → sectors → countries context without
// re-deriving it. Keep this module behavior-identical for the Polymarket
// curation path.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

export interface HoldingRow {
  // Optional so pre-fetched holdings from older call sites still type-check;
  // ETFs without an id are skipped by the enrichment enqueue, nothing else.
  id?: string | null;
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

export interface PortfolioProfile {
  tickers: string[];
  /** ETF holdings expanded with underlying stocks, e.g. "PUST.PA (Amundi NASDAQ-100: NVDA, AAPL, MSFT, AMZN, META)" */
  etfDescriptions: string[];
  sectors: string[];
  countries: string[];
}

/** ETF holding with no etf_constituents row — candidate for enrichment enqueue. */
export interface EtfConstituentGap {
  holdingId: string | null;
  ticker: string;
  isin: string | null;
  name: string;
  /** true when the hardcoded ETF_UNDERLYING_LABELS map still covers this ETF */
  hasFallback: boolean;
}

// ETF → top-5 underlying stocks for LLM/query context. LAST-RESORT fallback
// only: the etf_constituents table (lazy-populated by the geography job) is
// the primary source, and any ETF missing from it gets enrichment enqueued —
// so entries here merely bridge the gap until the DB row lands.
// Keyed by exchange-qualified ETF ticker.
export const ETF_UNDERLYING_LABELS: Record<string, { label: string; top5: string[] }> = {
  "PUST.PA": {
    label: "Amundi NASDAQ-100",
    top5: ["NVDA", "AAPL", "MSFT", "AMZN", "META"],
  },
  "PTPXH.PA": {
    label: "Amundi Japan Topix",
    top5: ["Toyota (7203.T)", "Sony (6758.T)", "Keyence (6861.T)", "NTT (9432.T)", "SoftBank (9984.T)"],
  },
  "PAASI.PA": {
    label: "Amundi EM Asia",
    top5: ["TSM", "Samsung (005930.KS)", "Tencent (700.HK)", "Alibaba (BABA)", "ASML"],
  },
};

// Is an asset fund-like (ETF/mutual fund)? Mirrors geography.ts without a cross-import.
export function isFundLike(assetType: string | null | undefined, name = ""): boolean {
  return /\betf\b|exchange traded fund|mutual\s*fund|\bfund\b|\bucits\b/i.test(
    `${assetType ?? ""} ${name}`,
  );
}

// ---------------------------------------------------------------------------
// Portfolio profile — full context including ETF underlying stocks.
// Accepts pre-fetched holdings to avoid double DB round-trips.
// ---------------------------------------------------------------------------

export async function buildPortfolioProfile(
  client: AnySupabaseClient,
  portfolioId: string,
  preloadedHoldings?: HoldingRow[],
): Promise<{
  profile: PortfolioProfile;
  profileSummary: string;
  constituentGaps: EtfConstituentGap[];
}> {
  const [holdingsResult, geoResult] = await Promise.all([
    preloadedHoldings
      ? Promise.resolve({ data: preloadedHoldings })
      : client
          .from("holdings")
          .select("id,ticker,isin,asset_type,name,quantity")
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

  const directTickers: string[] = [];
  const etfHoldings: Array<{
    holdingId: string | null;
    ticker: string;
    isin: string | null;
    name: string;
  }> = [];

  for (const h of holdings) {
    if (isFundLike(h.asset_type, h.name)) {
      etfHoldings.push({
        holdingId: h.id == null ? null : String(h.id),
        ticker: h.ticker,
        isin: h.isin,
        name: h.name,
      });
    } else {
      directTickers.push(h.ticker);
    }
  }

  // Build ETF description strings including top-5 underlying stocks.
  // This is the key context Grok needs to correctly reason about rate sensitivity:
  // "PUST.PA" alone is opaque; "PUST.PA (Amundi NASDAQ-100: NVDA, AAPL, MSFT, AMZN, META)"
  // makes DCF repricing obvious.
  const etfIsins = etfHoldings.map((e) => e.isin).filter(Boolean) as string[];
  const dbConstituentsByIsin: Record<string, { label: string; top5: string[] }> = {};

  if (etfIsins.length > 0) {
    const { data: constituentRows } = (await client
      .from("etf_constituents")
      .select("etf_isin,constituents")
      .in("etf_isin", etfIsins)) as {
      data: Array<{ etf_isin: string; constituents: Array<{ ticker: string; name: string }> }> | null;
      error: unknown;
    };
    for (const row of constituentRows ?? []) {
      const top5 = (row.constituents ?? []).slice(0, 5).map((c) => c.ticker);
      if (top5.length > 0) {
        dbConstituentsByIsin[row.etf_isin] = { label: row.etf_isin, top5 };
      }
    }
  }

  const etfDescriptions: string[] = [];
  const constituentGaps: EtfConstituentGap[] = [];
  for (const etf of etfHoldings) {
    const fromDb = etf.isin ? dbConstituentsByIsin[etf.isin] : undefined;
    const fromFallback = ETF_UNDERLYING_LABELS[etf.ticker];
    // The holding's display name beats the DB label (the raw ISIN) for Grok.
    const label = etf.name && etf.name !== etf.ticker ? etf.name : null;
    if (fromDb) {
      etfDescriptions.push(`${etf.ticker} (${label ?? fromDb.label}: ${fromDb.top5.join(", ")})`);
    } else {
      // No DB coverage — record the gap so the fanout can enqueue enrichment,
      // and degrade gracefully in the meantime (hardcoded map, else name+ticker).
      constituentGaps.push({
        holdingId: etf.holdingId,
        ticker: etf.ticker,
        isin: etf.isin,
        name: etf.name,
        hasFallback: Boolean(fromFallback),
      });
      if (fromFallback) {
        etfDescriptions.push(
          `${etf.ticker} (${fromFallback.label}: ${fromFallback.top5.join(", ")})`,
        );
      } else {
        etfDescriptions.push(label ? `${etf.ticker} (${label})` : etf.ticker);
      }
    }
  }

  // Sectors from etf_constituents (best-effort — table may be empty)
  const sectorSet = new Set<string>();
  if (etfIsins.length > 0) {
    const { data: sectorRows } = (await client
      .from("etf_constituents")
      .select("top_sectors")
      .in("etf_isin", etfIsins)) as { data: Array<{ top_sectors: unknown }> | null; error: unknown };
    for (const row of sectorRows ?? []) {
      const ts = (row.top_sectors as Array<{ sector: string }> | null) ?? [];
      for (const s of ts.slice(0, 3)) sectorSet.add(s.sector);
    }
  }

  const countries = geoRows.map((g) => g.country_name).filter(Boolean).slice(0, 5);

  const profile: PortfolioProfile = {
    tickers: directTickers.slice(0, 10),
    etfDescriptions,
    sectors: Array.from(sectorSet),
    countries,
  };

  const profileSummary = [
    profile.tickers.length > 0 ? `Direct holdings: ${profile.tickers.join(", ")}` : null,
    profile.etfDescriptions.length > 0
      ? `ETF exposure: ${profile.etfDescriptions.join(" | ")}`
      : null,
    profile.sectors.length > 0 ? `Sectors: ${profile.sectors.join(", ")}` : null,
    profile.countries.length > 0 ? `Countries: ${profile.countries.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(". ");

  return { profile, profileSummary, constituentGaps };
}
