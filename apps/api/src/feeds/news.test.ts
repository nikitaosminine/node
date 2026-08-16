import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildClusterRow, resolveSentimentsForRow, updateRollingCompanySentiment } from "./news";
import type { ClusterSentiment, ScoredClusterRecord, SentimentCompanyRef } from "./sentiment";

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
            ...(extra?.companyResults ?? []),
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
            ...(extra?.marketResults ?? []),
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

  it("unions prior-run entities into re-upserted clusters instead of clobbering them", async () => {
    state.existingClusters = [
      {
        cluster_key: "exa-market-1",
        entities: { isins: ["US0378331005"], tickers: ["AAPL"], countries: [], sectors: [] },
      },
    ];

    const result = await runNewsFanout(env);
    expect(result.errors).toEqual([]);

    const marketCluster = state.clusterRows.find((r) => r.cluster_key === "exa-market-1");
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
          id: "exa-dup-co",
          url: "https://www.lesechos.fr/airbus-nasdaq",
          title: dupTitle,
          publishedDate: RECENT,
          score: 0.6,
        },
      ],
      marketResults: [
        {
          id: "exa-dup-mkt",
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
    expect(state.clusterRows.find((r) => r.cluster_key === "exa-dup-mkt")).toBeUndefined();
    const survivorIdx = state.clusterRows.findIndex((r) => r.cluster_key === "exa-dup-co");
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

  it("still derives static-override topics when a taxonomy read rejects", async () => {
    state.constituentsReject = true;

    const result = await runNewsFanout(env);

    // The rejected optional read degrades that seed only — the Nasdaq ETF's
    // static override still produces its market topic and clusters.
    expect(result.marketTopicsQueried).toBe(1);
    expect(result.errors).toEqual([]);
    expect(state.clusterRows.find((r) => r.cluster_key === "exa-market-1")).toBeDefined();
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
      expect(state.clusterRows.find((r) => r.cluster_key === "exa-market-1")).toBeDefined();

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
          id: "exa-avgo",
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
    const avgoIdx = state.clusterRows.findIndex((r) => r.cluster_key === "exa-avgo");
    expect(avgoIdx).toBeGreaterThanOrEqual(0);

    // Both portfolios hold an ETF mapping to the shared topic and both match
    // the story only the second ETF's constituent terms could keep.
    const avgoMatches = state.matchRows.filter((m) => m.cluster_id === `cluster-${avgoIdx}`);
    expect(avgoMatches.map((m) => m.portfolio_id).sort()).toEqual([
      "portfolio-1",
      "portfolio-2",
    ]);
  });
});

const sentimentResult = {
  id: "cluster-1",
  url: "https://example.com/acme-earnings",
  title: "Acme Corp posts record earnings",
  publishedDate: "2026-08-10T08:00:00.000Z",
  score: 0.9,
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

  it("writes an explicit empty sentiments array when scoring succeeded but returned nothing for the cluster", () => {
    const row = buildClusterRow(sentimentResult, ["ACME"], [], "Strong quarter.", [], companiesByKey);
    expect(row).toHaveProperty("sentiments", []);
  });

  it("omits the sentiments key entirely when scoring failed, so the upsert preserves stored data", () => {
    const row = buildClusterRow(sentimentResult, ["ACME"], [], "Strong quarter.", null, companiesByKey);
    expect(row).not.toHaveProperty("sentiments");
    expect(row.cluster_key).toBe("cluster-1");
    expect(row.entities).toEqual({ isins: [], tickers: ["ACME"], countries: [], sectors: [] });
  });
});

describe("resolveSentimentsForRow", () => {
  const scored: ClusterSentiment[] = [
    { clusterKey: "cluster-1", companyKey: "ticker:ACME", score: 0.5, rationale: "ok" },
  ];

  it("returns the scored entries when every requested company got an answer", () => {
    expect(resolveSentimentsForRow(1, scored, null)).toEqual(scored);
  });

  it("returns an explicit empty array when there were no companies to score", () => {
    expect(resolveSentimentsForRow(0, [], null)).toEqual([]);
  });

  it("preserves stored data (null) when the response only covers a subset of the requested companies", () => {
    // Grok answered for 1 of 2 requested (cluster, company) pairs — a valid,
    // parseable response, so sentimentError is null, but writing `scored`
    // as-is would erase the still-unanswered company's stored sentiment.
    expect(resolveSentimentsForRow(2, scored, null)).toBeNull();
  });

  it("preserves stored data (null) when scoring failed outright", () => {
    expect(resolveSentimentsForRow(1, [], "Grok sentiment scoring failed (500)")).toBeNull();
  });
});

interface PriorRow {
  company_key: string;
  score: number;
  evidence_cluster_ids: string[] | null;
  scored_cluster_ids: ScoredClusterRecord[] | null;
}

function mockSentimentClient(priorRows: PriorRow[], opts: { lockAcquired?: boolean } = {}) {
  const upserts: Array<{ rows: Array<Record<string, unknown>>; options: unknown }> = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const lockReleases: Array<{ holder: unknown }> = [];
  const lockAcquired = opts.lockAcquired ?? true;
  const client = {
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return { data: lockAcquired, error: null };
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
      return {
        select: () => ({
          in: async () => ({ data: priorRows, error: null }),
        }),
        upsert: async (rows: Array<Record<string, unknown>>, options: unknown) => {
          upserts.push({ rows, options });
          return { error: null };
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, upserts, rpcCalls, lockReleases };
}

describe("updateRollingCompanySentiment", () => {
  it("skips a cluster still in scored_cluster_ids even after it left the 10-id display list", async () => {
    const now = Date.now();
    const scored = Array.from({ length: 15 }, (_, i) => ({
      id: `c-${i}`,
      scoredAt: new Date(now).toISOString(),
    }));
    const { client, upserts } = mockSentimentClient([
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
    expect(upserts).toHaveLength(0);
  });

  it("folds a genuinely new cluster into the EWMA and writes both id columns", async () => {
    const { client, upserts } = mockSentimentClient([
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
    expect(upserts).toHaveLength(1);
    expect(upserts[0].options).toEqual({ onConflict: "company_key" });
    expect(upserts[0].rows[0]).toMatchObject({
      company_key: "ticker:ACME",
      company_name: "Acme Corp",
      ticker: "ACME",
      score: 0.35,
      trend: "up",
      evidence_cluster_ids: ["c-new", "old-1"],
    });
    const scoredIds = (upserts[0].rows[0].scored_cluster_ids as ScoredClusterRecord[]).map(
      (r) => r.id,
    );
    expect(scoredIds).toEqual(["c-new", "old-1"]);
  });

  it("skips the DB entirely when there is nothing to update", async () => {
    const { client, upserts, rpcCalls } = mockSentimentClient([]);
    const outcome = await updateRollingCompanySentiment(client, [], companiesByKey);
    expect(outcome).toEqual({ companiesRescored: 0, error: null });
    expect(upserts).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("acquires and releases the update lock around a successful run", async () => {
    const { client, rpcCalls, lockReleases } = mockSentimentClient([]);
    await updateRollingCompanySentiment(
      client,
      [{ clusterKey: "c-new", companyKey: "ticker:ACME", score: 1, rationale: "" }],
      companiesByKey,
    );

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("try_acquire_company_sentiment_lock");
    expect(rpcCalls[0].args).toMatchObject({ p_ttl_seconds: expect.any(Number) });
    expect(lockReleases).toHaveLength(1);
    expect(lockReleases[0].holder).toBe((rpcCalls[0].args as { p_holder: string }).p_holder);
  });

  it("skips gracefully without writing when a concurrent run holds the lock", async () => {
    const { client, upserts, lockReleases } = mockSentimentClient([], { lockAcquired: false });

    const outcome = await updateRollingCompanySentiment(
      client,
      [{ clusterKey: "c-new", companyKey: "ticker:ACME", score: 1, rationale: "" }],
      companiesByKey,
    );

    expect(outcome.companiesRescored).toBe(0);
    expect(outcome.error).toMatch(/lock/i);
    expect(upserts).toHaveLength(0);
    expect(lockReleases).toHaveLength(0);
  });
});
