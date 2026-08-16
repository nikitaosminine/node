import { describe, expect, it } from "vitest";

import { buildClusterRow } from "./news";
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
