import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbFrom } = vi.hoisted(() => ({ dbFrom: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: dbFrom })),
}));

import { runNewsFanout } from "./news";

const env = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_KEY: "service-key",
  EXA_SEARCH: "exa-key",
};

const RECENT = new Date(Date.now() - 3_600_000).toISOString();

// One direct company holding and one Nasdaq-100 ETF holding, same portfolio.
const HOLDINGS = [
  {
    id: "h-airbus",
    ticker: "AIR.PA",
    isin: "NL0000235190",
    asset_type: "EQUITY",
    name: "Airbus SE",
    quantity: 10,
    portfolio_id: "portfolio-1",
  },
  {
    id: "h-pust",
    ticker: "PUST.PA",
    isin: "LU1681038243",
    asset_type: "ETF",
    name: "Amundi PEA NASDAQ-100 UCITS ETF",
    quantity: 5,
    portfolio_id: "portfolio-1",
  },
];

interface CapturedState {
  clusterRows: Array<Record<string, any>>;
  matchRows: Array<Record<string, any>>;
  searchQueries: string[];
}

function installDbMock(state: CapturedState): void {
  dbFrom.mockImplementation((table: string) => {
    switch (table) {
      case "holdings":
        return {
          select: () => ({ gt: async () => ({ data: HOLDINGS, error: null }) }),
        };
      case "etf_constituents":
        // Empty on purpose — the taxonomy must not hard-depend on it.
        return {
          select: () => ({ in: async () => ({ data: [], error: null }) }),
        };
      case "holding_geography_allocations":
        return {
          select: () => ({ in: async () => ({ data: [], error: null }) }),
        };
      case "news_clusters":
        return {
          upsert: (rows: Array<Record<string, any>>) => {
            state.clusterRows.push(...rows);
            return {
              select: async () => ({
                data: rows.map((r, i) => ({ id: `cluster-${i}`, cluster_key: r.cluster_key })),
                error: null,
              }),
            };
          },
          delete: () => ({ lt: async () => ({ count: 0, error: null }) }),
        };
      case "portfolio_news_matches":
        return {
          upsert: async (rows: Array<Record<string, any>>) => {
            state.matchRows.push(...rows);
            return { error: null };
          },
        };
      default:
        throw new Error(`unexpected table ${table}`);
    }
  });
}

function installFetchMock(state: CapturedState): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (String(url).endsWith("/search")) {
        state.searchQueries.push(body.query);
        let results: unknown[] = [];
        if (body.query.includes("Airbus")) {
          results = [
            {
              id: "exa-airbus-1",
              url: "https://www.lesechos.fr/airbus-order",
              title: "Airbus wins major A350 order from Asian carrier",
              publishedDate: RECENT,
              score: 0.8,
            },
          ];
        } else if (body.query.includes("Nasdaq")) {
          results = [
            {
              id: "exa-market-1",
              url: "https://www.cnbc.com/nasdaq-rally",
              title: "Nasdaq rallies as tech stocks extend gains",
              publishedDate: RECENT,
              score: 0.7,
            },
            {
              // Off-topic for the US-tech relevance filter — must be dropped.
              id: "exa-market-2",
              url: "https://www.cnbc.com/pastry-award",
              title: "Local bakery wins national pastry award",
              publishedDate: RECENT,
              score: 0.9,
            },
          ];
        }
        return new Response(JSON.stringify({ results }), { status: 200 });
      }
      if (String(url).endsWith("/contents")) {
        const results = (body.urls as string[]).map((u) => ({
          url: u,
          summary: `Summary for ${u}`,
        }));
        return new Response(JSON.stringify({ results }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

describe("runNewsFanout — ETF-derived market coverage", () => {
  let state: CapturedState;

  beforeEach(() => {
    state = { clusterRows: [], matchRows: [], searchQueries: [] };
    installDbMock(state);
    installFetchMock(state);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    dbFrom.mockReset();
  });

  it("queries one market topic per held ETF and writes matched market clusters", async () => {
    const result = await runNewsFanout(env);

    expect(result.distinctCompaniesQueried).toBe(1);
    expect(result.marketTopicsQueried).toBe(1);
    expect(result.offTopicDropped).toBe(1);
    expect(result.errors).toEqual([]);

    // The market search used the topic query, not a per-ETF company query.
    expect(state.searchQueries.some((q) => q.includes("Nasdaq-100"))).toBe(true);
    expect(state.searchQueries.some((q) => q.includes("Amundi"))).toBe(false);

    // Market cluster: entities.countries/sectors populated.
    const marketCluster = state.clusterRows.find((r) => r.cluster_key === "exa-market-1");
    expect(marketCluster).toBeDefined();
    expect(marketCluster!.entities).toEqual({
      isins: [],
      tickers: [],
      countries: ["US"],
      sectors: ["Technology"],
    });
    expect(marketCluster!.primary_article.snippet).toContain("Summary for");

    // The off-topic result never became a cluster.
    expect(state.clusterRows.find((r) => r.cluster_key === "exa-market-2")).toBeUndefined();

    // Market match: matched_etfs/matched_topics filled, no company fields.
    const marketMatch = state.matchRows.find((m) =>
      Array.isArray(m.match_reason.matched_etfs),
    );
    expect(marketMatch).toBeDefined();
    expect(marketMatch!.portfolio_id).toBe("portfolio-1");
    expect(marketMatch!.match_reason).toEqual({
      matched_etfs: ["PUST.PA"],
      matched_topics: ["US tech market"],
    });
    expect(marketMatch!.score).toBeGreaterThan(0);
  });

  it("keeps per-company clusters and match_reason in their V1 shape", async () => {
    await runNewsFanout(env);

    const companyCluster = state.clusterRows.find((r) => r.cluster_key === "exa-airbus-1");
    expect(companyCluster).toBeDefined();
    expect(companyCluster!.entities).toEqual({
      isins: ["NL0000235190"],
      tickers: ["AIR.PA"],
      countries: [],
      sectors: [],
    });

    const companyMatch = state.matchRows.find((m) =>
      Array.isArray(m.match_reason.matched_tickers),
    );
    expect(companyMatch).toBeDefined();
    expect(companyMatch!.match_reason).toEqual({
      matched_tickers: ["AIR.PA"],
      matched_company_names: ["Airbus SE"],
    });
  });
});
