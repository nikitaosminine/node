import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildClusterRow,
  MAX_COMPANY_SEARCHES_PER_RUN,
  NEWS_CRON_SLOTS,
  resolveSentimentsForRow,
  selectRotatingWindow,
  updateRollingCompanySentiment,
} from "./news";
import type { ClusterSentiment, ScoredClusterRecord, SentimentCompanyRef } from "./sentiment";

const { dbFrom } = vi.hoisted(() => ({ dbFrom: vi.fn() }));
const { dbRpc } = vi.hoisted(() => ({ dbRpc: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: dbFrom, rpc: dbRpc })),
}));

import { runNewsFanout } from "./news";

const env = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_KEY: "service-key",
  FIRECRAWL_API_KEY: "fc-key",
  GROK_MAIN_API_KEY: "grok-key",
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
  existingClusters: Array<Record<string, any>>;
  holdings: Array<Record<string, any>>;
  etfConstituents: Array<Record<string, any>>;
  constituentsReject: boolean;
  constituentsError: boolean;
  geographyError: boolean;
  nextClusterId: number;
  subrequestCount: number;
  clusterIds: Map<string, string>;
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
                data: rows.map((r) => {
                  const id = `cluster-${state.nextClusterId++}`;
                  state.clusterIds.set(r.cluster_key, id);
                  return { id, cluster_key: r.cluster_key };
                }),
                error: null,
              }),
            };
          },
          delete: () => ({ lt: async () => ({ count: 0, error: null }) }),
        };
      case "company_sentiment":
        return {
          select: () => ({ in: async () => ({ data: [], error: null }) }),
        };
      case "company_sentiment_pending":
        return {
          select: () => ({
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        };
      case "company_sentiment_lock":
        return {
          delete: () => ({
            eq: () => ({ eq: async () => ({ error: null }) }),
          }),
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
  dbRpc.mockImplementation(async (fn: string) => {
    if (
      fn === "enqueue_company_sentiment_pending" ||
      fn === "try_acquire_company_sentiment_lock" ||
      fn === "apply_company_sentiment_batch"
    ) {
      return { data: fn === "try_acquire_company_sentiment_lock" ? true : true, error: null };
    }
    return { data: null, error: null };
  });
}

interface SearchFixture {
  id?: string;
  url: string;
  title: string;
  publishedDate: string;
  score: number;
  summary?: string;
}

function installFetchMock(
  state: CapturedState,
  extra?: {
    companyResults?: SearchFixture[];
    marketResults?: SearchFixture[];
    firecrawlStatus?: number;
  },
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      state.subrequestCount++;
      const body = JSON.parse(init?.body ?? "{}");
      if (String(url).includes("api.x.ai")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"scores":[]}' } }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (String(url).endsWith("/v2/search")) {
        state.searchQueries.push(body.query);
        if (extra?.firecrawlStatus)
          return new Response("Firecrawl down", { status: extra.firecrawlStatus });
        let results: SearchFixture[] = [];
        if (body.query.includes("Airbus")) {
          results = [
            {
              id: "https://www.lesechos.fr/airbus-order",
              url: "https://www.lesechos.fr/airbus-order",
              title: "Airbus wins major A350 order from Asian carrier",
              publishedDate: RECENT,
              score: 0.8,
            },
            ...(extra?.companyResults ?? []),
          ];
        } else if (body.query.includes("Nasdaq")) {
          results = [
            {
              id: "https://www.cnbc.com/nasdaq-rally",
              url: "https://www.cnbc.com/nasdaq-rally",
              title: "Nasdaq rallies as tech stocks extend gains",
              publishedDate: RECENT,
              score: 0.7,
            },
            {
              // Off-topic for the US-tech relevance filter — must be dropped.
              id: "https://www.cnbc.com/pastry-award",
              url: "https://www.cnbc.com/pastry-award",
              title: "Local bakery wins national pastry award",
              publishedDate: RECENT,
              score: 0.9,
            },
            ...(extra?.marketResults ?? []),
          ];
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              news: results.map((result) => ({
                url: result.url,
                title: result.title,
                summary: result.summary ?? `Summary for ${result.url}`,
                metadata: { "article:published_time": result.publishedDate },
                position: Math.max(1, Math.round((1 - result.score) * 10)),
              })),
            },
          }),
          { status: 200 },
        );
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
      existingClusters: [],
      holdings: HOLDINGS,
      etfConstituents: [],
      constituentsReject: false,
      constituentsError: false,
      geographyError: false,
      nextClusterId: 0,
      subrequestCount: 0,
      clusterIds: new Map(),
    };
    installDbMock(state);
    installFetchMock(state);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    dbFrom.mockReset();
    dbRpc.mockReset();
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

  it("uses Firecrawl inline summaries for drift filtering and drops stale or future news", async () => {
    installFetchMock(state, {
      companyResults: [
        {
          url: "https://www.ft.com/a350-production",
          title: "A350 production outlook improves",
          summary: "Airbus SE increased the A350 production target after strong orders.",
          publishedDate: RECENT,
          score: 0.7,
        },
        {
          url: "https://www.ft.com/airbus-old",
          title: "Airbus announces an old order",
          publishedDate: new Date(Date.now() - 8 * 24 * 3_600_000).toISOString(),
          score: 0.6,
        },
        {
          url: "https://www.ft.com/airbus-future",
          title: "Airbus announces a future order",
          publishedDate: new Date(Date.now() + 3_600_000).toISOString(),
          score: 0.6,
        },
      ],
    });

    const result = await runNewsFanout(env);

    expect(result.staleDropped).toBe(4); // primary and fallback both return the two stale items
    expect(result.errors).toEqual([]);
    const summaryOnly = state.clusterRows.find(
      (row) => row.cluster_key === "https://www.ft.com/a350-production",
    );
    expect(summaryOnly?.primary_article.snippet).toBe(
      "Airbus SE increased the A350 production target after strong orders.",
    );
    expect(state.clusterRows.some((row) => row.cluster_key.endsWith("airbus-old"))).toBe(false);
    expect(state.clusterRows.some((row) => row.cluster_key.endsWith("airbus-future"))).toBe(false);
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
          id: "https://www.lesechos.fr/airbus-nasdaq",
          url: "https://www.lesechos.fr/airbus-nasdaq",
          title: dupTitle,
          publishedDate: RECENT,
          score: 0.6,
        },
      ],
      marketResults: [
        {
          id: "https://www.cnbc.com/airbus-nasdaq",
          url: "https://www.cnbc.com/airbus-nasdaq",
          title: dupTitle,
          publishedDate: RECENT,
          score: 0.95,
        },
      ],
    });

    const result = await runNewsFanout(env);
    expect(result.dedupedAway).toBe(1);

    // The lower-tier duplicate is dropped; its market-topic entities survive on
    // the kept company-sourced cluster.
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

    const survivorMatch = state.matchRows.find(
      (m) => m.cluster_id === state.clusterIds.get("https://www.lesechos.fr/airbus-nasdaq"),
    );
    expect(survivorMatch).toBeDefined();
    expect(survivorMatch!.match_reason).toEqual({
      matched_tickers: ["AIR.PA"],
      matched_company_names: ["Airbus SE"],
      matched_etfs: ["PUST.PA"],
      matched_topics: ["US tech market"],
    });
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
          id: "https://www.cnbc.com/broadcom-orders",
          url: "https://www.cnbc.com/broadcom-orders",
          title: "Broadcom surges on record custom accelerator orders",
          publishedDate: RECENT,
          score: 0.65,
        },
      ],
    });

    const result = await runNewsFanout(env);

    // One shared topic (not two), whose merged terms keep the Broadcom story.
    expect(result.marketTopicsQueried).toBe(1);
    expect(state.clusterIds.get("https://www.cnbc.com/broadcom-orders")).toBeDefined();

    // Both portfolios hold an ETF mapping to the shared topic and both match
    // the story only the second ETF's constituent terms could keep.
    const avgoMatches = state.matchRows.filter(
      (m) => m.cluster_id === state.clusterIds.get("https://www.cnbc.com/broadcom-orders"),
    );
    expect(avgoMatches.map((m) => m.portfolio_id).sort()).toEqual(["portfolio-1", "portfolio-2"]);
  });

  it("keeps a large company universe within the subrequest budget", async () => {
    state.holdings = Array.from({ length: 100 }, (_, i) => ({
      id: `h-company-${i}`,
      ticker: `C${i}`,
      isin: null,
      asset_type: "EQUITY",
      name: `Company ${i}`,
      quantity: 1,
      portfolio_id: `portfolio-${i}`,
    }));

    const result = await runNewsFanout(env);

    expect(result.distinctCompaniesQueried).toBe(MAX_COMPANY_SEARCHES_PER_RUN);
    expect(state.subrequestCount).toBeLessThanOrEqual(50);
  });

  it("reduces company coverage when the scheduled invocation has less capacity", async () => {
    state.holdings = Array.from({ length: 100 }, (_, i) => ({
      id: `h-company-${i}`,
      ticker: `C${i}`,
      isin: null,
      asset_type: "EQUITY",
      name: `Company ${i}`,
      quantity: 1,
      portfolio_id: `portfolio-${i}`,
    }));

    const result = await runNewsFanout(env, { availableSubrequests: 40 });

    expect(result.distinctCompaniesQueried).toBe(1);
    expect(state.subrequestCount).toBeLessThanOrEqual(40);
  });

  it("uses the queued scheduled time when a news consumer is delayed", async () => {
    state.holdings = Array.from({ length: 100 }, (_, i) => ({
      id: `h-company-${i}`,
      ticker: `C${i}`,
      isin: null,
      asset_type: "EQUITY",
      name: `Company ${i}`,
      quantity: 1,
      portfolio_id: `portfolio-${i}`,
    }));
    const scheduledTime = Date.UTC(2026, 8, 21, 16, 30);
    const delayedUntil = Date.UTC(2026, 8, 21, 21, 0);
    vi.useFakeTimers();
    vi.setSystemTime(delayedUntil);
    try {
      await runNewsFanout(env, { scheduledTime });
    } finally {
      vi.useRealTimers();
    }

    const expected = selectRotatingWindow(
      [...state.holdings]
        .sort((a, b) => a.ticker.localeCompare(b.ticker))
        .map((holding) => holding.name),
      MAX_COMPANY_SEARCHES_PER_RUN,
      scheduledTime,
    );
    expect(expected.every((company) => state.searchQueries.some((query) => query.includes(company)))).toBe(
      true,
    );
  });

  it("counts physical Firecrawl retries and degrades before the hard budget", async () => {
    vi.useFakeTimers();
    state.holdings = Array.from({ length: 100 }, (_, i) => ({
      id: `h-company-${i}`,
      ticker: `C${i}`,
      isin: null,
      asset_type: "EQUITY",
      name: `Company ${i}`,
      quantity: 1,
      portfolio_id: `portfolio-${i}`,
    }));
    installFetchMock(state, { firecrawlStatus: 500 });

    try {
      const run = runNewsFanout(env);
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
    }

    expect(state.subrequestCount).toBeLessThanOrEqual(26);
  });

  it("rotates market topics within the retry-aware remaining search capacity", async () => {
    vi.useFakeTimers();
    const runTimes = [
      Date.UTC(2026, 8, 21, 16, 30),
      Date.UTC(2026, 8, 21, 21, 0),
      Date.UTC(2026, 8, 22, 6, 30),
    ];
    state.holdings = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `h-company-${i}`,
        ticker: `C${i}`,
        isin: null,
        asset_type: "EQUITY",
        name: `Company ${i}`,
        quantity: 1,
        portfolio_id: `portfolio-${i}`,
      })),
      {
        id: "h-nasdaq",
        ticker: "PUST.PA",
        isin: null,
        asset_type: "ETF",
        name: "Amundi PEA NASDAQ-100 UCITS ETF",
        quantity: 1,
        portfolio_id: "portfolio-1",
      },
      {
        id: "h-sp500",
        ticker: "SPY",
        isin: null,
        asset_type: "ETF",
        name: "S&P 500 ETF",
        quantity: 1,
        portfolio_id: "portfolio-1",
      },
      {
        id: "h-asia",
        ticker: "PAASI.PA",
        isin: null,
        asset_type: "ETF",
        name: "Amundi MSCI Emerging Asia UCITS ETF",
        quantity: 1,
        portfolio_id: "portfolio-1",
      },
      {
        id: "h-japan",
        ticker: "PTPXH.PA",
        isin: null,
        asset_type: "ETF",
        name: "Japan TOPIX ETF",
        quantity: 1,
        portfolio_id: "portfolio-1",
      },
    ];
    installFetchMock(state, { firecrawlStatus: 500 });

    const topicQueries = new Set<string>();
    const topicMarkers = ["Nasdaq", "S&P 500", "China and South Korea", "Japanese economy"];
    try {
      for (const scheduledAt of runTimes) {
        state.searchQueries = [];
        state.subrequestCount = 0;
        vi.setSystemTime(scheduledAt);
        const run = runNewsFanout(env);
        await vi.runAllTimersAsync();
        const result = await run;

        expect(result.marketTopicsQueried).toBeGreaterThan(0);
        expect(result.marketTopicsQueried).toBeLessThanOrEqual(2);
        expect(state.subrequestCount).toBeLessThanOrEqual(50);
        state.searchQueries
          .filter((query) => topicMarkers.some((marker) => query.includes(marker)))
          .forEach((query) => topicQueries.add(query));
      }
    } finally {
      vi.useRealTimers();
    }

    expect(topicQueries.size).toBe(4);
  });
});

const sentimentResult = {
  url: "https://example.com/acme-earnings",
  title: "Acme Corp posts record earnings",
  publishedAt: "2026-08-10T08:00:00.000Z",
  summary: "Strong quarter.",
  image: null,
  providerScore: 0.9,
};

const companiesByKey = new Map<string, SentimentCompanyRef>([
  ["ticker:ACME", { canonicalKey: "ticker:ACME", name: "Acme Corp", tickers: ["ACME"], isins: [] }],
]);

describe("buildClusterRow sentiment persistence", () => {
  it("writes scored sentiments with company metadata", () => {
    const row = buildClusterRow(
      sentimentResult,
      ["ACME"],
      [],
      "Strong quarter.",
      [{ clusterKey: "cluster-1", companyKey: "ticker:ACME", score: 0.7, rationale: "Beat." }],
      companiesByKey,
    );
    expect(row.sentiments).toEqual([
      {
        company_key: "ticker:ACME",
        company_name: "Acme Corp",
        tickers: ["ACME"],
        isins: [],
        score: 0.7,
        rationale: "Beat.",
      },
    ]);
  });

  it("preserves prior sentiment entries for companies outside the rotating subset", () => {
    const row = buildClusterRow(
      sentimentResult,
      ["ACME"],
      [],
      "Strong quarter.",
      [{ clusterKey: "cluster-1", companyKey: "ticker:ACME", score: 0.7, rationale: "Beat." }],
      companiesByKey,
      [],
      [],
      [
        {
          company_key: "ticker:BETA",
          company_name: "Beta Corp",
          tickers: ["BETA"],
          isins: [],
          score: -0.2,
          rationale: "Prior result.",
        },
      ],
    );

    expect(row.sentiments).toEqual([
      expect.objectContaining({ company_key: "ticker:ACME", score: 0.7 }),
      expect.objectContaining({ company_key: "ticker:BETA", score: -0.2 }),
    ]);
  });

  it("writes an explicit empty sentiments array when scoring succeeded but returned nothing for the cluster", () => {
    const row = buildClusterRow(
      sentimentResult,
      ["ACME"],
      [],
      "Strong quarter.",
      [],
      companiesByKey,
    );
    expect(row).toHaveProperty("sentiments", []);
  });

  it("omits the sentiments key entirely when scoring failed, so the upsert preserves stored data", () => {
    const row = buildClusterRow(
      sentimentResult,
      ["ACME"],
      [],
      "Strong quarter.",
      null,
      companiesByKey,
    );
    expect(row).not.toHaveProperty("sentiments");
    expect(row.cluster_key).toBe(sentimentResult.url);
    expect(row.entities).toEqual({ isins: [], tickers: ["ACME"], countries: [], sectors: [] });
  });
});

describe("resolveSentimentsForRow", () => {
  const scored: ClusterSentiment[] = [
    { clusterKey: "cluster-1", companyKey: "ticker:ACME", score: 0.5, rationale: "ok" },
  ];

  it("returns the scored entries when every requested company got an answer", () => {
    expect(resolveSentimentsForRow(["ticker:ACME"], scored, null)).toEqual(scored);
  });

  it("returns an explicit empty array when there were no companies to score", () => {
    expect(resolveSentimentsForRow([], [], null)).toEqual([]);
  });

  it("preserves stored data (null) when the response only covers a subset of the requested companies", () => {
    // Grok answered for 1 of 2 requested (cluster, company) pairs — a valid,
    // parseable response, so sentimentError is null, but writing `scored`
    // as-is would erase the still-unanswered company's stored sentiment.
    expect(resolveSentimentsForRow(["ticker:ACME", "ticker:BETA"], scored, null)).toBeNull();
  });

  it("requires the exact requested company keys, not just the expected count", () => {
    expect(
      resolveSentimentsForRow(["ticker:BETA"], [{ ...scored[0], companyKey: "ticker:ACME" }], null),
    ).toBeNull();
  });

  it("preserves stored data (null) when scoring failed outright", () => {
    expect(
      resolveSentimentsForRow(["ticker:ACME"], [], "Grok sentiment scoring failed (500)"),
    ).toBeNull();
  });
});

describe("selectRotatingWindow", () => {
  it("reaches all 12 companies across the actual weekday news cron slots", () => {
    expect(NEWS_CRON_SLOTS).toEqual(["30 6 * * 2-6", "30 16 * * 2-6", "0 21 * * 2-6"]);
    expect(MAX_COMPANY_SEARCHES_PER_RUN).toBe(2);
    const entries = Array.from({ length: 12 }, (_, i) => `company-${i}`);
    const monday = Date.UTC(2026, 8, 21);
    const slots: Array<[number, number, number]> = [
      [0, 16, 30],
      [0, 21, 0],
      [1, 6, 30],
      [1, 16, 30],
      [1, 21, 0],
      [2, 6, 30],
      [2, 16, 30],
      [2, 21, 0],
      [3, 6, 30],
      [3, 16, 30],
      [3, 21, 0],
      [4, 6, 30],
      [4, 16, 30],
      [4, 21, 0],
      [5, 6, 30],
    ];
    const seen = new Set<string>();

    for (let week = 0; week < 3; week++) {
      for (const [day, hour, minute] of slots) {
        const scheduledAt =
          monday + (week * 7 + day) * 24 * 3_600_000 + hour * 3_600_000 + minute * 60_000;
        const selected = selectRotatingWindow(entries, MAX_COMPANY_SEARCHES_PER_RUN, scheduledAt);
        expect(selected).toHaveLength(4);
        selected.forEach((entry) => seen.add(entry));
      }
    }

    expect(seen).toEqual(new Set(entries));
  });
});

interface PriorRow {
  company_key: string;
  score: number;
  evidence_cluster_ids: string[] | null;
  scored_cluster_ids: ScoredClusterRecord[] | null;
}

function mockSentimentClient(
  priorRows: PriorRow[],
  opts: {
    lockAcquired?: boolean;
    applyAccepted?: boolean;
    lockSequence?: boolean[];
    applySequence?: boolean[];
    pendingRows?: Array<Record<string, unknown>>;
    onApply?: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  } = {},
) {
  const applies: Array<{ rows: Array<Record<string, unknown>>; holder: unknown }> = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const lockReleases: Array<{ holder: unknown }> = [];
  const companyReadKeys: string[][] = [];
  const lockAcquired = opts.lockAcquired ?? true;
  const applyAccepted = opts.applyAccepted ?? true;
  const lockSequence = [...(opts.lockSequence ?? [])];
  const applySequence = [...(opts.applySequence ?? [])];
  const pendingRows = opts.pendingRows ?? [];
  let nextPendingId = 1;
  for (const row of pendingRows) {
    if (typeof row.id !== "number") row.id = nextPendingId;
    nextPendingId = Math.max(nextPendingId, Number(row.id) + 1);
    if (!row.published_at) row.published_at = row.observed_at ?? new Date().toISOString();
  }
  const client = {
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === "try_acquire_company_sentiment_lock") {
        return { data: lockSequence.shift() ?? lockAcquired, error: null };
      }
      if (fn === "enqueue_company_sentiment_pending") {
        const { p_rows } = args as { p_rows: Array<Record<string, unknown>> };
        for (const row of p_rows) {
          const existingIndex = pendingRows.findIndex(
            (pending) =>
              pending.company_key === row.company_key && pending.cluster_id === row.cluster_id,
          );
          if (existingIndex < 0) {
            pendingRows.push({ ...row, id: nextPendingId++ });
          } else {
            pendingRows[existingIndex] = { ...pendingRows[existingIndex], ...row };
          }
        }
        return { data: true, error: null };
      }
      if (fn === "apply_company_sentiment_batch") {
        const { p_holder, p_rows } = args as {
          p_holder: unknown;
          p_rows: Array<Record<string, unknown>>;
        };
        applies.push({ rows: p_rows, holder: p_holder });
        const accepted = applySequence.shift() ?? applyAccepted;
        if (accepted) {
          for (const row of opts.onApply?.(p_rows) ?? []) {
            pendingRows.push({ ...row, id: nextPendingId++ });
          }
          const completed = new Set(
            p_rows.flatMap((row) =>
              (row.scored_cluster_ids as Array<{ id: string }>).map(
                (scored) => `${row.company_key}:${scored.id}`,
              ),
            ),
          );
          for (let i = pendingRows.length - 1; i >= 0; i--) {
            const prior = priorRows.find((row) => row.company_key === pendingRows[i].company_key);
            const alreadyScored = prior?.scored_cluster_ids?.some(
              (scored) => scored.id === pendingRows[i].cluster_id,
            );
            const observedAt = pendingRows[i].observed_at;
            const expired =
              typeof observedAt === "string" &&
              Date.parse(observedAt) < Date.now() - 7 * 24 * 3_600_000;
            if (
              completed.has(`${pendingRows[i].company_key}:${pendingRows[i].cluster_id}`) ||
              alreadyScored ||
              expired
            ) {
              pendingRows.splice(i, 1);
            }
          }
          for (const row of p_rows) {
            const updated: PriorRow = {
              company_key: String(row.company_key),
              score: Number(row.score),
              evidence_cluster_ids: row.evidence_cluster_ids as string[],
              scored_cluster_ids: row.scored_cluster_ids as ScoredClusterRecord[],
            };
            const priorIndex = priorRows.findIndex(
              (prior) => prior.company_key === updated.company_key,
            );
            if (priorIndex < 0) priorRows.push(updated);
            else priorRows[priorIndex] = updated;
          }
        }
        return { data: accepted, error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      if (table === "company_sentiment_lock") {
        return {
          delete: () => ({
            eq: () => ({
              eq: async (_col: string, holder: unknown) => {
                lockReleases.push({ holder });
                return { error: null };
              },
            }),
          }),
        };
      }
      if (table === "company_sentiment_pending") {
        return {
          select: () => ({
            order: () => ({
              limit: (count: number) => {
                const page = (beforeId = Infinity) => ({
                  data: pendingRows
                    .filter((row) => Number(row.id) < beforeId)
                    .sort((a, b) => Number(b.id) - Number(a.id))
                    .slice(0, count),
                  error: null,
                });
                return {
                  lt: async (_column: string, beforeId: number) => page(beforeId),
                  then: (resolve: (value: ReturnType<typeof page>) => unknown) =>
                    Promise.resolve(page()).then(resolve),
                };
              },
            }),
          }),
        };
      }
      return {
        select: () => ({
          in: async (_column: string, keys: string[]) => {
            companyReadKeys.push(keys);
            return {
              data: priorRows.filter((row) => keys.includes(row.company_key)).slice(0, 1000),
              error: null,
            };
          },
        }),
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, applies, rpcCalls, lockReleases, companyReadKeys };
}

describe("updateRollingCompanySentiment", () => {
  it("skips a cluster still in scored_cluster_ids even after it left the 10-id display list", async () => {
    const now = Date.now();
    const scored = Array.from({ length: 15 }, (_, i) => ({
      id: `c-${i}`,
      scoredAt: new Date(now).toISOString(),
    }));
    const { client, applies } = mockSentimentClient([
      {
        company_key: "ticker:ACME",
        score: 0.5,
        evidence_cluster_ids: scored.slice(0, 10).map((r) => r.id),
        scored_cluster_ids: scored,
      },
    ]);

    const outcome = await updateRollingCompanySentiment(
      client,
      [{ clusterKey: "c-14", companyKey: "ticker:ACME", score: 0.9, rationale: "" }],
      companiesByKey,
    );

    expect(outcome).toEqual({ companiesRescored: 0, error: null });
    expect(applies).toHaveLength(1);
    expect(applies[0].rows).toEqual([]);
  });

  it("folds a genuinely new cluster into the EWMA and writes both id columns via the guarded RPC", async () => {
    const { client, applies, rpcCalls } = mockSentimentClient([
      {
        company_key: "ticker:ACME",
        score: 0,
        evidence_cluster_ids: ["old-1"],
        scored_cluster_ids: [{ id: "old-1", scoredAt: new Date().toISOString() }],
      },
    ]);

    const outcome = await updateRollingCompanySentiment(
      client,
      [{ clusterKey: "c-new", companyKey: "ticker:ACME", score: 1, rationale: "" }],
      companiesByKey,
    );

    expect(outcome).toEqual({ companiesRescored: 1, error: null });
    expect(applies).toHaveLength(1);
    expect(applies[0].rows[0]).toMatchObject({
      company_key: "ticker:ACME",
      company_name: "Acme Corp",
      ticker: "ACME",
      score: 0.35,
      trend: "up",
      evidence_cluster_ids: ["c-new", "old-1"],
    });
    const scoredIds = (applies[0].rows[0].scored_cluster_ids as ScoredClusterRecord[]).map(
      (r) => r.id,
    );
    expect(scoredIds).toEqual(["c-new", "old-1"]);
    // The write is guarded by the same holder token the lock was acquired with.
    const acquireCall = rpcCalls.find((c) => c.fn === "try_acquire_company_sentiment_lock")!;
    expect(applies[0].holder).toBe((acquireCall.args as { p_holder: string }).p_holder);
  });

  it("prunes stale scored ids even when there is no fresh observation", async () => {
    const now = Date.now();
    const { client, applies } = mockSentimentClient([
      {
        company_key: "ticker:ACME",
        score: 0.5,
        evidence_cluster_ids: ["old-1"],
        scored_cluster_ids: [
          { id: "stale", scoredAt: new Date(now - 8 * 24 * 3_600_000).toISOString() },
          { id: "fresh", scoredAt: new Date(now - 1_000).toISOString() },
        ],
      },
    ]);

    const outcome = await updateRollingCompanySentiment(client, [], companiesByKey);

    expect(outcome).toEqual({ companiesRescored: 1, error: null });
    expect(applies[0].rows[0]).toMatchObject({
      company_key: "ticker:ACME",
      score: 0.5,
      scored_cluster_ids: [{ id: "fresh" }],
    });
  });

  it("removes expired pending observations while draining the queue", async () => {
    const pendingRows: Array<Record<string, unknown>> = [
      {
        company_key: "ticker:ACME",
        cluster_id: "expired",
        company_name: "Acme Corp",
        ticker: "ACME",
        isin: null,
        score: 0.2,
        rationale: "old",
        observed_at: new Date(Date.now() - 8 * 24 * 3_600_000).toISOString(),
      },
    ];
    const { client, applies } = mockSentimentClient([], { pendingRows });

    const outcome = await updateRollingCompanySentiment(client, [], companiesByKey);

    expect(outcome).toEqual({ companiesRescored: 0, error: null });
    expect(applies).toHaveLength(1);
    expect(pendingRows).toHaveLength(0);
  });

  it("drains pending observations when the current fanout has no direct companies", async () => {
    const pendingRows: Array<Record<string, unknown>> = [
      {
        company_key: "ticker:ACME",
        cluster_id: "queued",
        company_name: "Acme Corp",
        ticker: "ACME",
        isin: null,
        score: 0.8,
        rationale: "queued",
        observed_at: new Date().toISOString(),
      },
    ];
    const { client, applies } = mockSentimentClient([], { pendingRows });

    const outcome = await updateRollingCompanySentiment(client, [], new Map());

    expect(outcome).toEqual({ companiesRescored: 1, error: null });
    expect(applies[0].rows[0]).toMatchObject({ company_key: "ticker:ACME", score: 0.8 });
    expect(pendingRows).toHaveLength(0);
  });

  it("prefers a current observation over an older pending conflict", async () => {
    const pendingRows: Array<Record<string, unknown>> = [
      {
        company_key: "ticker:ACME",
        cluster_id: "cluster-1",
        company_name: "Acme Corp",
        ticker: "ACME",
        isin: null,
        score: -0.8,
        rationale: "old",
        observed_at: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ];
    const { client, applies } = mockSentimentClient([], { pendingRows });

    const outcome = await updateRollingCompanySentiment(
      client,
      [{ clusterKey: "cluster-1", companyKey: "ticker:ACME", score: 0.8, rationale: "fresh" }],
      companiesByKey,
    );

    expect(outcome).toEqual({ companiesRescored: 1, error: null });
    expect(applies[0].rows[0]).toMatchObject({ company_key: "ticker:ACME", score: 0.8 });
    expect(pendingRows).toHaveLength(0);
  });

  it("does not write when there is no input or pending work", async () => {
    const { client, applies, rpcCalls } = mockSentimentClient([]);
    const outcome = await updateRollingCompanySentiment(client, [], new Map());
    expect(outcome).toEqual({ companiesRescored: 0, error: null });
    expect(applies).toHaveLength(0);
    expect(rpcCalls.map((call) => call.fn)).toEqual(["try_acquire_company_sentiment_lock"]);
  });

  it("acquires and releases the update lock around a successful run", async () => {
    const { client, rpcCalls, lockReleases } = mockSentimentClient([]);
    await updateRollingCompanySentiment(
      client,
      [{ clusterKey: "c-new", companyKey: "ticker:ACME", score: 1, rationale: "" }],
      companiesByKey,
    );

    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "enqueue_company_sentiment_pending",
      "try_acquire_company_sentiment_lock",
      "apply_company_sentiment_batch",
    ]);
    const acquireCall = rpcCalls.find((call) => call.fn === "try_acquire_company_sentiment_lock")!;
    expect(acquireCall.args).toMatchObject({ p_ttl_seconds: expect.any(Number) });
    expect(lockReleases).toHaveLength(1);
    expect(lockReleases[0].holder).toBe((acquireCall.args as { p_holder: string }).p_holder);
  });

  it("retries lock contention before giving up without writing", async () => {
    const { client, applies, lockReleases } = mockSentimentClient([], { lockAcquired: false });

    const outcome = await updateRollingCompanySentiment(
      client,
      [{ clusterKey: "c-new", companyKey: "ticker:ACME", score: 1, rationale: "" }],
      companiesByKey,
    );

    expect(outcome.companiesRescored).toBe(0);
    expect(outcome.error).toMatch(/lock/i);
    expect(applies).toHaveLength(0);
    expect(lockReleases).toHaveLength(0);
  });

  it("hands off to a waiting run after the lock is released", async () => {
    const { client, applies, rpcCalls } = mockSentimentClient([], {
      lockSequence: [false, true],
    });

    const outcome = await updateRollingCompanySentiment(
      client,
      [{ clusterKey: "c-new", companyKey: "ticker:ACME", score: 1, rationale: "valid" }],
      companiesByKey,
    );

    expect(outcome).toEqual({ companiesRescored: 1, error: null });
    expect(
      rpcCalls.filter((call) => call.fn === "try_acquire_company_sentiment_lock"),
    ).toHaveLength(2);
    expect(applies).toHaveLength(1);
  });

  it("hands off after a lease loss and persists the observation after re-reading", async () => {
    const { client, applies, lockReleases } = mockSentimentClient([], {
      applySequence: [false, true],
    });

    const outcome = await updateRollingCompanySentiment(
      client,
      [{ clusterKey: "c-new", companyKey: "ticker:ACME", score: 1, rationale: "" }],
      companiesByKey,
    );

    expect(outcome).toEqual({ companiesRescored: 1, error: null });
    expect(applies).toHaveLength(2);
    expect(lockReleases).toHaveLength(2);
  });

  it("persists observations in the pending handoff until a later run drains them", async () => {
    const pendingRows: Array<Record<string, unknown>> = [];
    const first = mockSentimentClient([], { lockAcquired: false, pendingRows });

    const firstOutcome = await updateRollingCompanySentiment(
      first.client,
      [{ clusterKey: "c-new", companyKey: "ticker:ACME", score: 1, rationale: "valid" }],
      companiesByKey,
    );

    expect(firstOutcome.companiesRescored).toBe(0);
    expect(pendingRows).toHaveLength(1);

    const second = mockSentimentClient([], { pendingRows });
    const secondOutcome = await updateRollingCompanySentiment(second.client, [], companiesByKey);

    expect(secondOutcome).toEqual({ companiesRescored: 1, error: null });
    expect(second.applies).toHaveLength(1);
    expect(pendingRows).toHaveLength(0);
  });

  it("reads only the provided scored-company scope", async () => {
    const allCompanies = new Map(companiesByKey);
    allCompanies.set("ticker:BETA", {
      canonicalKey: "ticker:BETA",
      name: "Beta Corp",
      tickers: ["BETA"],
      isins: [],
    });
    const { client, companyReadKeys } = mockSentimentClient([
      {
        company_key: "ticker:ACME",
        score: 0,
        evidence_cluster_ids: [],
        scored_cluster_ids: [],
      },
    ]);

    await updateRollingCompanySentiment(
      client,
      [{ clusterKey: "cluster-1", companyKey: "ticker:ACME", score: 0.7, rationale: "fresh" }],
      new Map([["ticker:ACME", allCompanies.get("ticker:ACME")!]]),
    );

    expect(companyReadKeys).toEqual([["ticker:ACME"]]);
  });

  it("eventually drains 1,001 distinct companies in bounded pages without resetting prior scores", async () => {
    const observedAt = new Date().toISOString();
    const publishedAt = new Date(Date.now() - 3_600_000).toISOString();
    const oldPublishedAt = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const priorRows: PriorRow[] = Array.from({ length: 1001 }, (_, index) => ({
      company_key: `ticker:C${index}`,
      score: 0.2,
      evidence_cluster_ids: [`old-${index}`],
      scored_cluster_ids: [
        {
          id: `old-${index}`,
          scoredAt: observedAt,
          publishedAt: oldPublishedAt,
        },
      ],
    }));
    const pendingRows: Array<Record<string, unknown>> = priorRows.map((prior, index) => ({
      company_key: prior.company_key,
      cluster_id: `fresh-${index}`,
      company_name: `Company ${index}`,
      ticker: `C${index}`,
      isin: null,
      score: 0.8,
      rationale: "Improved outlook.",
      published_at: publishedAt,
      observed_at: observedAt,
    }));
    const { client, applies, companyReadKeys } = mockSentimentClient(priorRows, { pendingRows });

    for (const remaining of [601, 201, 0]) {
      const outcome = await updateRollingCompanySentiment(client, [], new Map());
      expect(outcome.error).toBeNull();
      expect(pendingRows).toHaveLength(remaining);
    }

    expect(applies.map((apply) => apply.rows.length)).toEqual([400, 400, 201]);
    expect(companyReadKeys.every((keys) => keys.length <= 125)).toBe(true);
    expect(new Set(companyReadKeys.flat()).size).toBe(1001);
    priorRows.forEach((prior, index) => {
      expect(prior.score).toBe(0.41); // one EWMA update from 0.2 and 0.8
      expect(prior.evidence_cluster_ids).toEqual([`fresh-${index}`, `old-${index}`]);
      expect(prior.scored_cluster_ids?.map((record) => record.id)).toEqual([
        `fresh-${index}`,
        `old-${index}`,
      ]);
    });
  });

  it("keeps a distinct observation enqueued during acknowledgement for the next run", async () => {
    const observedAt = new Date().toISOString();
    const pendingRows: Array<Record<string, unknown>> = [
      {
        company_key: "ticker:ACME",
        cluster_id: "first",
        company_name: "Acme Corp",
        ticker: "ACME",
        isin: null,
        score: 0.7,
        rationale: "First article.",
        published_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        observed_at: observedAt,
      },
    ];
    let injected = false;
    const { client, applies } = mockSentimentClient([], {
      pendingRows,
      onApply: () => {
        if (injected) return [];
        injected = true;
        return [
          {
            company_key: "ticker:ACME",
            cluster_id: "later",
            company_name: "Acme Corp",
            ticker: "ACME",
            isin: null,
            score: -0.5,
            rationale: "Later article.",
            published_at: new Date(Date.now() - 3_600_000).toISOString(),
            observed_at: observedAt,
          },
        ];
      },
    });

    expect(await updateRollingCompanySentiment(client, [], new Map())).toEqual({
      companiesRescored: 1,
      error: null,
    });
    expect(pendingRows.map((row) => row.cluster_id)).toEqual(["later"]);
    expect(await updateRollingCompanySentiment(client, [], new Map())).toEqual({
      companiesRescored: 1,
      error: null,
    });
    expect(pendingRows).toHaveLength(0);
    expect(applies[0].rows[0].score).toBe(0.7);
    expect(applies[1].rows[0].score).toBe(0.28);
    expect(applies[1].rows[0].evidence_cluster_ids).toEqual(["later", "first"]);
  });
});
