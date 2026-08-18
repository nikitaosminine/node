// End-to-end fanout test: runs the real runNewsFanout over a stubbed HTTP
// layer (Exa search/contents, Grok chat/completions, Supabase PostgREST) and
// asserts on the actual rows the Worker would persist — per-cluster sentiments
// folded into the news_clusters upsert, and the EWMA-updated company_sentiment
// row — plus the graceful-degradation path when the Grok call fails.

import { afterEach, describe, expect, it, vi } from "vitest";

import { runNewsFanout } from "./news";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SUPABASE_URL = "http://supabase.local";

const env = {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY: "service-key",
  EXA_SEARCH: "exa-key",
  GROK_MAIN_API_KEY: "grok-key",
};

const publishedAt = new Date(Date.now() - 24 * 3_600_000).toISOString();

const exaResults = [
  {
    id: "exa-1",
    url: "https://www.cnbc.com/acme-earnings",
    title: "Acme Corp posts record quarterly earnings beat",
    publishedDate: publishedAt,
    score: 0.9,
  },
  {
    id: "exa-2",
    url: "https://www.cnbc.com/acme-expansion",
    title: "Acme Corp announces factory expansion in France",
    publishedDate: publishedAt,
    score: 0.8,
  },
];

interface CapturedRequest {
  method: string;
  pathname: string;
  body: unknown;
}

// Routes every outbound HTTP call runNewsFanout makes. `grokStatus` controls
// the sentiment-scoring branch (`grokScores` optionally overrides the scored
// pairs it returns); everything else stays healthy.
function stubFanoutHttp(options: {
  grokStatus: number;
  grokScores?: Array<{ i: number; sentiment: number; rationale: string }>;
  multiCompany?: boolean;
  clusterPreReadStatus?: number;
}) {
  const captured: CapturedRequest[] = [];
  let nextClusterId = 1;
  const results = options.multiCompany
    ? [
        {
          id: "exa-shared",
          url: "https://www.cnbc.com/acme-beta-joint-expansion",
          title: "Acme Corp and Beta Corp announce a joint expansion",
          publishedDate: publishedAt,
          score: 0.9,
        },
      ]
    : exaResults;

  const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const rawBody = typeof init?.body === "string" ? init.body : null;
    const body = rawBody ? JSON.parse(rawBody) : null;
    captured.push({ method, pathname: url.pathname, body });

    // --- Exa ---------------------------------------------------------------
      if (url.hostname === "api.exa.ai" && url.pathname === "/search") {
      const isPrimary = (body as { includeDomains: string[] }).includeDomains.includes("ft.com");
      return jsonResponse({ results: isPrimary ? results : [] });
    }
    if (url.hostname === "api.exa.ai" && url.pathname === "/contents") {
      return jsonResponse({
        results: results.map((result) => ({
          url: result.url,
          summary: result.title,
        })),
      });
    }

    // --- Grok sentiment scoring ---------------------------------------------
    if (url.hostname === "api.x.ai") {
      if (options.grokStatus !== 200)
        return new Response("grok down", { status: options.grokStatus });
      const content = JSON.stringify({
        scores: options.grokScores ?? [
          { i: 1, sentiment: 0.7, rationale: "Earnings beat." },
          { i: 2, sentiment: 0.3, rationale: "Expansion positive." },
        ],
      });
      return jsonResponse({ choices: [{ message: { content } }] });
    }

    // --- Supabase PostgREST --------------------------------------------------
    if (url.pathname === "/rest/v1/holdings") {
      return jsonResponse(
        options.multiCompany
          ? [
              {
                ticker: "ACME",
                isin: null,
                asset_type: "stock",
                name: "Acme Corp",
                quantity: 10,
                portfolio_id: "p-1",
              },
              {
                ticker: "BETA",
                isin: null,
                asset_type: "stock",
                name: "Beta Corp",
                quantity: 10,
                portfolio_id: "p-1",
              },
            ]
          : [
              {
                ticker: "ACME",
                isin: null,
                asset_type: "stock",
                name: "Acme Corp",
                quantity: 10,
                portfolio_id: "p-1",
              },
            ],
      );
    }
    if (url.pathname === "/rest/v1/news_clusters" && method === "GET") {
      if (options.clusterPreReadStatus && options.clusterPreReadStatus !== 200) {
        return jsonResponse({ message: "cluster pre-read failed" }, options.clusterPreReadStatus);
      }
      return jsonResponse([]);
    }
    if (url.pathname === "/rest/v1/news_clusters" && method === "POST") {
      return jsonResponse(
        (body as Array<{ cluster_key: string }>).map((row) => ({
          id: `db-${nextClusterId++}`,
          cluster_key: row.cluster_key,
        })),
        201,
      );
    }
    if (url.pathname === "/rest/v1/news_clusters" && method === "DELETE") {
      return jsonResponse(null, 204, { "content-range": "*/0" });
    }
    if (url.pathname === "/rest/v1/company_sentiment" && method === "GET") {
      return jsonResponse([
        {
          company_key: "ticker:ACME",
          score: 0,
          evidence_cluster_ids: ["old-1"],
          scored_cluster_ids: [
            { id: "old-1", scoredAt: new Date(Date.now() - 3_600_000).toISOString() },
          ],
        },
      ]);
    }
    if (url.pathname === "/rest/v1/company_sentiment_pending" && method === "GET") {
      return jsonResponse([]);
    }
    if (url.pathname === "/rest/v1/portfolio_news_matches" && method === "POST") {
      return jsonResponse(null, 201);
    }
    if (url.pathname === "/rest/v1/rpc/try_acquire_company_sentiment_lock" && method === "POST") {
      return jsonResponse(true, 200);
    }
    if (url.pathname === "/rest/v1/rpc/enqueue_company_sentiment_pending" && method === "POST") {
      return jsonResponse(true, 200);
    }
    if (url.pathname === "/rest/v1/rpc/apply_company_sentiment_batch" && method === "POST") {
      return jsonResponse(true, 200);
    }
    if (url.pathname === "/rest/v1/company_sentiment_lock" && method === "DELETE") {
      return jsonResponse(null, 204);
    }

    throw new Error(`Unexpected request in test: ${method} ${url.href}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { captured };
}

function clusterUpsertRows(captured: CapturedRequest[]): Array<Record<string, unknown>> {
  const requests = captured.filter(
    (r) => r.pathname === "/rest/v1/news_clusters" && r.method === "POST",
  );
  expect(requests.length).toBeGreaterThan(0);
  return requests.flatMap((request) => request.body as Array<Record<string, unknown>>);
}

describe("runNewsFanout sentiment pipeline (end-to-end over stubbed HTTP)", () => {
  it("persists per-cluster sentiments and EWMA-updates the rolling company score", async () => {
    const { captured } = stubFanoutHttp({ grokStatus: 200 });

    const result = await runNewsFanout(env);

    expect(result.errors).toEqual([]);
    expect(result.clustersUpserted).toBe(2);
    expect(result.matchesUpserted).toBe(2);
    expect(result.clustersScored).toBe(2);
    expect(result.companiesRescored).toBe(1);

    // Per-cluster sentiments are folded into the single batch cluster upsert.
    const rows = clusterUpsertRows(captured);
    const clusterRequests = captured.filter(
      (r) => r.pathname === "/rest/v1/news_clusters" && r.method === "POST",
    );
    expect(clusterRequests.every((request) => {
      const rows = request.body as Array<Record<string, unknown>>;
      return new Set(rows.map((row) => Object.prototype.hasOwnProperty.call(row, "sentiments"))).size === 1;
    })).toBe(true);
    expect(rows.map((r) => r.cluster_key)).toEqual(["exa-1", "exa-2"]);
    expect(rows[0].sentiments).toEqual([
      {
        company_key: "ticker:ACME",
        company_name: "Acme Corp",
        tickers: ["ACME"],
        isins: [],
        score: 0.7,
        rationale: "Earnings beat.",
      },
    ]);
    expect(rows[1].sentiments).toEqual([
      {
        company_key: "ticker:ACME",
        company_name: "Acme Corp",
        tickers: ["ACME"],
        isins: [],
        score: 0.3,
        rationale: "Expansion positive.",
      },
    ]);

    // Rolling row: mean(0.7, 0.3)=0.5 observed, EWMA over prior 0 with
    // alpha=0.35 → 0.175; cluster-id lists use the durable DB ids, fresh first.
    // The write goes through the lease-guarded RPC, not a plain upsert.
    const companyApply = captured.find(
      (r) => r.pathname === "/rest/v1/rpc/apply_company_sentiment_batch" && r.method === "POST",
    );
    expect(companyApply).toBeDefined();
    const applyBody = companyApply!.body as {
      p_holder: string;
      p_rows: Array<Record<string, unknown>>;
    };
    expect(applyBody.p_holder).toEqual(expect.any(String));
    const companyRow = applyBody.p_rows[0];
    expect(companyRow).toMatchObject({
      company_key: "ticker:ACME",
      company_name: "Acme Corp",
      ticker: "ACME",
      isin: null,
      score: 0.175,
      trend: "up",
      evidence_cluster_ids: ["db-1", "db-2", "old-1"],
    });
    expect((companyRow.scored_cluster_ids as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "db-1",
      "db-2",
      "old-1",
    ]);
  });

  it("skips the sentiments write for clusters Grok only partially answered, while scoring the rest", async () => {
    // Grok returns valid JSON but only answers pair 1 (cluster exa-1); the
    // (exa-2, ACME) pair is silently omitted. exa-2's write must be skipped
    // (preserving any stored sentiment) instead of persisting [], and only
    // exa-1 may be folded into the rolling score.
    const { captured } = stubFanoutHttp({
      grokStatus: 200,
      grokScores: [{ i: 1, sentiment: 0.7, rationale: "Earnings beat." }],
    });

    const result = await runNewsFanout(env);

    const rows = clusterUpsertRows(captured);
    const clusterRequests = captured.filter(
      (r) => r.pathname === "/rest/v1/news_clusters" && r.method === "POST",
    );
    expect(clusterRequests).toHaveLength(2);
    expect(clusterRequests.every((request) => {
      const rows = request.body as Array<Record<string, unknown>>;
      return new Set(rows.map((row) => Object.prototype.hasOwnProperty.call(row, "sentiments"))).size === 1;
    })).toBe(true);
    expect(rows.map((r) => r.cluster_key)).toEqual(["exa-1", "exa-2"]);
    expect((rows[0].sentiments as Array<Record<string, unknown>>).map((s) => s.score)).toEqual([
      0.7,
    ]);
    // The unanswered cluster omits the key entirely so the conflict upsert
    // leaves previously stored sentiments untouched.
    expect(rows[1]).not.toHaveProperty("sentiments");

    // Only the answered cluster reaches the rolling score: EWMA over prior 0
    // with alpha=0.35 and a single 0.7 observation → 0.245. exa-2 is NOT
    // marked as scored, so it stays eligible for the next fanout run.
    expect(result.clustersScored).toBe(1);
    expect(result.companiesRescored).toBe(1);
    const companyApply = captured.find(
      (r) => r.pathname === "/rest/v1/rpc/apply_company_sentiment_batch" && r.method === "POST",
    );
    expect(companyApply).toBeDefined();
    const companyRow = (companyApply!.body as { p_rows: Array<Record<string, unknown>> }).p_rows[0];
    expect(companyRow).toMatchObject({ company_key: "ticker:ACME", score: 0.245, trend: "up" });
    expect((companyRow.scored_cluster_ids as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "db-1",
      "old-1",
    ]);
  });

  it("still fully populates the feed when Grok scoring fails, without touching stored sentiment", async () => {
    const { captured } = stubFanoutHttp({ grokStatus: 500 });

    const result = await runNewsFanout(env);

    // Feed populated as if sentiment scoring did not exist.
    expect(result.clustersUpserted).toBe(2);
    expect(result.matchesUpserted).toBe(2);
    expect(result.clustersScored).toBe(0);
    expect(result.companiesRescored).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("sentiment scoring");

    // The sentiments key is omitted so the conflict upsert preserves any
    // previously stored per-cluster sentiment.
    for (const row of clusterUpsertRows(captured)) {
      expect(row).not.toHaveProperty("sentiments");
    }

    expect(
      captured.some(
        (r) => r.pathname === "/rest/v1/rpc/apply_company_sentiment_batch" && r.method === "POST",
      ),
    ).toBe(false);
  });

  it("does not fold the answered member of a partially answered cluster into EWMA", async () => {
    const { captured } = stubFanoutHttp({
      grokStatus: 200,
      multiCompany: true,
      grokScores: [{ i: 1, sentiment: 0.7, rationale: "Earnings beat." }],
    });

    const result = await runNewsFanout(env);

    expect(result.clustersUpserted).toBe(1);
    expect(result.clustersScored).toBe(0);
    expect(result.companiesRescored).toBe(0);
    expect(clusterUpsertRows(captured)[0]).not.toHaveProperty("sentiments");
    expect(
      captured.some(
        (r) => r.pathname === "/rest/v1/rpc/apply_company_sentiment_batch" && r.method === "POST",
      ),
    ).toBe(false);
  });

  it("preserves stored sentiments when the cluster pre-read fails", async () => {
    const { captured } = stubFanoutHttp({ grokStatus: 200, clusterPreReadStatus: 500 });

    const result = await runNewsFanout(env);

    expect(result.clustersUpserted).toBe(2);
    expect(result.matchesUpserted).toBe(2);
    expect(result.errors).toContain("cluster entities pre-read: cluster pre-read failed");
    expect(result.clustersScored).toBe(0);
    expect(result.companiesRescored).toBe(0);
    for (const row of clusterUpsertRows(captured)) {
      expect(row).not.toHaveProperty("sentiments");
    }
    expect(
      captured.some(
        (r) => r.pathname === "/rest/v1/rpc/apply_company_sentiment_batch" && r.method === "POST",
      ),
    ).toBe(false);
  });
});
