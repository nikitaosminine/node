import { describe, expect, it } from "vitest";

import { buildClusterRow, updateRollingCompanySentiment } from "./news";
import type { SentimentCompanyRef } from "./sentiment";

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

interface PriorRow {
  company_key: string;
  score: number;
  evidence_cluster_ids: string[] | null;
  scored_cluster_ids: string[] | null;
}

function mockSentimentClient(priorRows: PriorRow[]) {
  const upserts: Array<{ rows: Array<Record<string, unknown>>; options: unknown }> = [];
  const client = {
    from: () => ({
      select: () => ({
        in: async () => ({ data: priorRows, error: null }),
      }),
      upsert: async (rows: Array<Record<string, unknown>>, options: unknown) => {
        upserts.push({ rows, options });
        return { error: null };
      },
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, upserts };
}

describe("updateRollingCompanySentiment", () => {
  it("skips a cluster still in scored_cluster_ids even after it left the 10-id display list", async () => {
    const scored = Array.from({ length: 15 }, (_, i) => `c-${i}`);
    const { client, upserts } = mockSentimentClient([
      {
        company_key: "ticker:ACME",
        score: 0.5,
        evidence_cluster_ids: scored.slice(0, 10),
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

  it("folds a genuinely new cluster into the EWMA and writes both capped id columns", async () => {
    const { client, upserts } = mockSentimentClient([
      {
        company_key: "ticker:ACME",
        score: 0,
        evidence_cluster_ids: ["old-1"],
        scored_cluster_ids: ["old-1"],
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
      scored_cluster_ids: ["c-new", "old-1"],
    });
  });

  it("skips the DB entirely when there is nothing to update", async () => {
    const { client, upserts } = mockSentimentClient([]);
    const outcome = await updateRollingCompanySentiment(client, [], companiesByKey);
    expect(outcome).toEqual({ companiesRescored: 0, error: null });
    expect(upserts).toHaveLength(0);
  });
});
