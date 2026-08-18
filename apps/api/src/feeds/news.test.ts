import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbFrom } = vi.hoisted(() => ({ dbFrom: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: dbFrom })),
}));

import { runNewsFanout } from "./news";

const env = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_KEY: "service-key",
  FIRECRAWL_API_KEY: "fc-test-key",
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
  searchBodies: Array<Record<string, any>>;
  existingClusters: Array<Record<string, any>>;
  holdings: Array<Record<string, any>>;
  etfConstituents: Array<Record<string, any>>;
  constituentsReject: boolean;
  constituentsError: boolean;
  geographyError: boolean;
}

function installDbMock(state: CapturedState): void {
  dbFrom.mockImplementation((table: string) => {
    switch (table) {
      case "holdings":
        return {
          select: () => ({ gt: async () => ({ data: state.holdings, error: null }) }),
        };
      case "etf_constituents":
        // Empty by default — the taxonomy must not hard-depend on it.
        return {
          select: () => ({
            in: async () => {
              if (state.constituentsReject) throw new Error("constituents read: network down");
              if (state.constituentsError) {
                return { data: null, error: { message: "TypeError: fetch failed" }, status: 0 };
              }
              return { data: state.etfConstituents, error: null };
            },
          }),
        };
      case "holding_geography_allocations":
        return {
          select: () => ({
            in: async () => {
              if (state.geographyError) {
                return { data: null, error: { message: "TypeError: fetch failed" }, status: 0 };
              }
              return { data: [], error: null };
            },
          }),
        };
      case "news_clusters":
        return {
          select: () => ({
            in: async () => ({ data: state.existingClusters, error: null }),
          }),
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

function installFetchMock(
  state: CapturedState,
  extra?: { companyResults?: unknown[]; marketResults?: unknown[] },
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (String(url).endsWith("/v2/search")) {
        state.searchQueries.push(body.query);
        state.searchBodies.push(body);
        let news: unknown[] = [];
        if (body.query.includes("Airbus")) {
          news = [
            {
              url: "https://www.lesechos.fr/airbus-order",
              title: "Airbus wins major A350 order from Asian carrier",
              date: "1 hour ago",
              position: 1,
              summary: "Summary for https://www.lesechos.fr/airbus-order",
            },
            ...(extra?.companyResults ?? []),
          ];
        } else if (body.query.includes("Nasdaq")) {
          news = [
            {
              url: "https://www.cnbc.com/nasdaq-rally",
              title: "Nasdaq rallies as tech stocks extend gains",
              date: "1 hour ago",
              position: 1,
              summary: "Summary for https://www.cnbc.com/nasdaq-rally",
            },
            {
              // Off-topic for the US-tech relevance filter — must be dropped.
              url: "https://www.cnbc.com/pastry-award",
              title: "Local bakery wins national pastry award",
              date: "1 hour ago",
              position: 2,
              summary: "A local bakery won a national award for its croissants.",
            },
            ...(extra?.marketResults ?? []),
          ];
        }
        return new Response(JSON.stringify({ success: true, data: { news } }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

describe("runNewsFanout — ETF-derived market coverage", () => {
  let state: CapturedState;

  beforeEach(() => {
    state = {
      clusterRows: [],
      matchRows: [],
      searchQueries: [],
      searchBodies: [],
      existingClusters: [],
      holdings: HOLDINGS,
      etfConstituents: [],
      constituentsReject: false,
      constituentsError: false,
      geographyError: false,
    };
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

    // Market cluster: entities.countries/sectors populated, cluster key = URL.
    const marketCluster = state.clusterRows.find(
      (r) => r.cluster_key === "https://www.cnbc.com/nasdaq-rally",
    );
    expect(marketCluster).toBeDefined();
    expect(marketCluster!.entities).toEqual({
      isins: [],
      tickers: [],
      countries: ["US"],
      sectors: ["Technology"],
    });
    expect(marketCluster!.primary_article.snippet).toContain("Summary for");
    // Rank 1 → providerScore 1.0, persisted as provider_score.
    expect(marketCluster!.primary_article.provider_score).toBe(1);

    // The off-topic result never became a cluster.
    expect(
      state.clusterRows.find((r) => r.cluster_key === "https://www.cnbc.com/pastry-award"),
    ).toBeUndefined();

    // Market match: matched_etfs/matched_topics filled, no company fields.
    const marketMatch = state.matchRows.find((m) => Array.isArray(m.match_reason.matched_etfs));
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

    const companyCluster = state.clusterRows.find(
      (r) => r.cluster_key === "https://www.lesechos.fr/airbus-order",
    );
    expect(companyCluster).toBeDefined();
    expect(companyCluster!.entities).toEqual({
      isins: ["NL0000235190"],
      tickers: ["AIR.PA"],
      countries: [],
      sectors: [],
    });

    const companyMatch = state.matchRows.find((m) => Array.isArray(m.match_reason.matched_tickers));
    expect(companyMatch).toBeDefined();
    expect(companyMatch!.match_reason).toEqual({
      matched_tickers: ["AIR.PA"],
      matched_company_names: ["Airbus SE"],
    });
  });

  it("unions prior-run entities into re-upserted clusters instead of clobbering them", async () => {
    state.existingClusters = [
      {
        cluster_key: "https://www.cnbc.com/nasdaq-rally",
        entities: { isins: ["US0378331005"], tickers: ["AAPL"], countries: [], sectors: [] },
      },
    ];

    const result = await runNewsFanout(env);
    expect(result.errors).toEqual([]);

    const marketCluster = state.clusterRows.find(
      (r) => r.cluster_key === "https://www.cnbc.com/nasdaq-rally",
    );
    expect(marketCluster).toBeDefined();
    expect(marketCluster!.entities).toEqual({
      isins: ["US0378331005"],
      tickers: ["AAPL"],
      countries: ["US"],
      sectors: ["Technology"],
    });
  });

  it("unions entity sets from deduped duplicate stories into the surviving cluster", async () => {
    const dupTitle = "Airbus soars while Nasdaq megacap giants tumble sharply";
    installFetchMock(state, {
      companyResults: [
        {
          url: "https://www.lesechos.fr/airbus-nasdaq",
          title: dupTitle,
          date: "2 hours ago",
          position: 2,
          summary: "Duplicate story summary.",
        },
      ],
      marketResults: [
        {
          url: "https://www.cnbc.com/airbus-nasdaq",
          title: dupTitle,
          date: "2 hours ago",
          position: 1,
          summary: "Duplicate story summary.",
        },
      ],
    });

    const result = await runNewsFanout(env);
    expect(result.dedupedAway).toBe(1);

    // The lower-tier duplicate is dropped (despite its better rank); its
    // market-topic entities survive on the kept company-sourced cluster.
    expect(
      state.clusterRows.find((r) => r.cluster_key === "https://www.cnbc.com/airbus-nasdaq"),
    ).toBeUndefined();
    const survivorIdx = state.clusterRows.findIndex(
      (r) => r.cluster_key === "https://www.lesechos.fr/airbus-nasdaq",
    );
    expect(survivorIdx).toBeGreaterThanOrEqual(0);
    expect(state.clusterRows[survivorIdx].entities).toEqual({
      isins: ["NL0000235190"],
      tickers: ["AIR.PA"],
      countries: ["US"],
      sectors: ["Technology"],
    });

    const survivorMatch = state.matchRows.find((m) => m.cluster_id === `cluster-${survivorIdx}`);
    expect(survivorMatch).toBeDefined();
    expect(survivorMatch!.match_reason).toEqual({
      matched_tickers: ["AIR.PA"],
      matched_company_names: ["Airbus SE"],
      matched_etfs: ["PUST.PA"],
      matched_topics: ["US tech market"],
    });
  });

  it("persists the highest provider score when one URL matches multiple queries", async () => {
    const sharedStory = {
      url: "https://www.lesechos.fr/airbus-nasdaq-shared",
      title: "Airbus and Nasdaq lead markets higher",
      date: "2 hours ago",
      position: 7,
      summary: "Airbus and Nasdaq both advanced in the latest session.",
    };
    installFetchMock(state, {
      companyResults: [sharedStory],
      marketResults: [{ ...sharedStory, position: 1 }],
    });

    await runNewsFanout(env);

    const cluster = state.clusterRows.find(
      (r) => r.cluster_key === sharedStory.url,
    );
    expect(cluster).toBeDefined();
    expect(cluster!.primary_article.provider_score).toBe(1);
  });

  it("still derives static-override topics when a taxonomy read rejects", async () => {
    state.constituentsReject = true;

    const result = await runNewsFanout(env);

    // The rejected optional read degrades that seed only — the Nasdaq ETF's
    // static override still produces its market topic and clusters.
    expect(result.marketTopicsQueried).toBe(1);
    expect(result.errors).toEqual([]);
    expect(
      state.clusterRows.find((r) => r.cluster_key === "https://www.cnbc.com/nasdaq-rally"),
    ).toBeDefined();
  });

  it("warns and still derives static-override topics when a taxonomy read resolves with an error", async () => {
    // supabase-js v2 converts network failures into resolved { data: null, error }
    // results rather than rejections — the guards must log those too.
    state.constituentsError = true;
    state.geographyError = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await runNewsFanout(env);

      expect(result.marketTopicsQueried).toBe(1);
      expect(result.errors).toEqual([]);
      expect(
        state.clusterRows.find((r) => r.cluster_key === "https://www.cnbc.com/nasdaq-rally"),
      ).toBeDefined();

      const messages = warn.mock.calls.map((c) => c.map(String).join(" "));
      expect(messages.some((m) => m.includes("etf_constituents read failed"))).toBe(true);
      expect(messages.some((m) => m.includes("geography allocations read failed"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("merges relevance terms when multiple ETFs derive the same topic", async () => {
    state.holdings = [
      ...HOLDINGS,
      {
        id: "h-xnas",
        ticker: "XNAS.DE",
        isin: "IE00XNAS0001",
        asset_type: "ETF",
        name: "Xtrackers Nasdaq 100 UCITS ETF",
        quantity: 3,
        portfolio_id: "portfolio-2",
      },
    ];
    // Only the second Nasdaq ETF knows Broadcom as a top constituent.
    state.etfConstituents = [
      {
        etf_isin: "IE00XNAS0001",
        constituents: [{ ticker: "AVGO", name: "Broadcom Inc" }],
        top_sectors: null,
      },
    ];
    installFetchMock(state, {
      marketResults: [
        {
          url: "https://www.cnbc.com/broadcom-orders",
          title: "Broadcom surges on record custom accelerator orders",
          date: "3 hours ago",
          position: 3,
          summary: "Broadcom reported record orders.",
        },
      ],
    });

    const result = await runNewsFanout(env);

    // One shared topic (not two), whose merged terms keep the Broadcom story.
    expect(result.marketTopicsQueried).toBe(1);
    const avgoIdx = state.clusterRows.findIndex(
      (r) => r.cluster_key === "https://www.cnbc.com/broadcom-orders",
    );
    expect(avgoIdx).toBeGreaterThanOrEqual(0);

    // Both portfolios hold an ETF mapping to the shared topic and both match
    // the story only the second ETF's constituent terms could keep.
    const avgoMatches = state.matchRows.filter((m) => m.cluster_id === `cluster-${avgoIdx}`);
    expect(avgoMatches.map((m) => m.portfolio_id).sort()).toEqual(["portfolio-1", "portfolio-2"]);
  });

  it("sends the Firecrawl production request shape with per-kind limits", async () => {
    await runNewsFanout(env);

    for (const body of state.searchBodies) {
      expect(body.sources).toEqual(["news"]);
      expect(body.tbs).toBe("qdr:w");
      expect(body.scrapeOptions).toEqual({ formats: ["summary"] });
      expect(body.location).toBe("FR");
      expect(Array.isArray(body.includeDomains)).toBe(true);
    }
    const companyBody = state.searchBodies.find((b) => b.query.includes("Airbus"));
    expect(companyBody!.limit).toBe(10);
    const marketBody = state.searchBodies.find((b) => b.query.includes("Nasdaq"));
    expect(marketBody!.limit).toBe(15);
  });

  it("drops stale, tbs-leaked, undated, and google-wrapped results", async () => {
    installFetchMock(state, {
      marketResults: [
        {
          // Relative date beyond the 7-day window (tbs leak) — stale.
          url: "https://www.cnbc.com/old-nasdaq",
          title: "Nasdaq slides on tech stocks rout",
          date: "2 weeks ago",
          position: 3,
          summary: "Old story.",
        },
        {
          // Ancient absolute date (observed leak shape) — stale.
          url: "https://www.cnbc.com/ancient-nasdaq",
          title: "Nasdaq reshuffle: tech stocks reweighted",
          date: "Nov 12, 2017",
          position: 4,
          summary: "Ancient story.",
        },
        {
          // No date at all — undated drop.
          url: "https://www.cnbc.com/undated-nasdaq",
          title: "Nasdaq futures point higher as tech stocks rebound",
          position: 5,
          summary: "Undated story.",
        },
        {
          // google.com/goto redirect wrapper — dropped at mapping.
          url: "https://www.google.com/goto?url=AbCdEf",
          title: "Nasdaq hits record as tech stocks rally",
          date: "1 hour ago",
          position: 6,
        },
      ],
    });

    const result = await runNewsFanout(env);

    expect(result.staleDropped).toBe(2);
    expect(result.undatedDropped).toBe(1);
    expect(result.googleWrappedDropped).toBe(1);
    for (const key of [
      "https://www.cnbc.com/old-nasdaq",
      "https://www.cnbc.com/ancient-nasdaq",
      "https://www.cnbc.com/undated-nasdaq",
      "https://www.google.com/goto?url=AbCdEf",
    ]) {
      expect(state.clusterRows.find((r) => r.cluster_key === key)).toBeUndefined();
    }
  });

  it("prefers scraped metadata dates, persists og:image, and tolerates missing summaries", async () => {
    installFetchMock(state, {
      companyResults: [
        {
          url: "https://www.wsj.com/airbus-deliveries",
          title: "Airbus deliveries hit monthly record",
          // The day-granular relative date loses to the exact metadata ISO.
          date: "3 days ago",
          position: 4,
          // No summary (scrape failed) — the snippet stays empty.
          imageUrl: "data:image/jpeg;base64,AAAA",
          metadata: {
            "article:published_time": RECENT,
            "og:image": "https://images.wsj.net/airbus.jpg",
          },
        },
      ],
    });

    await runNewsFanout(env);

    const cluster = state.clusterRows.find(
      (r) => r.cluster_key === "https://www.wsj.com/airbus-deliveries",
    );
    expect(cluster).toBeDefined();
    expect(cluster!.published_at).toBe(RECENT);
    expect(cluster!.primary_article.image).toBe("https://images.wsj.net/airbus.jpg");
    expect(cluster!.primary_article.snippet).toBe("");
    // Rank 4 → 0.95^3.
    expect(cluster!.primary_article.provider_score).toBeCloseTo(0.95 ** 3, 10);
  });
});
