import { describe, expect, it } from "vitest";

import { buildClusterRow, resolveSentimentsForRow, updateRollingCompanySentiment } from "./news";
import type { ClusterSentiment, ScoredClusterRecord, SentimentCompanyRef } from "./sentiment";

const result = {
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
      result,
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
    const row = buildClusterRow(result, ["ACME"], [], "Strong quarter.", [], companiesByKey);
    expect(row).toHaveProperty("sentiments", []);
  });

  it("omits the sentiments key entirely when scoring failed, so the upsert preserves stored data", () => {
    const row = buildClusterRow(result, ["ACME"], [], "Strong quarter.", null, companiesByKey);
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
