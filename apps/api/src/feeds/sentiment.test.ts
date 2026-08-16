import { afterEach, describe, expect, it, vi } from "vitest";

import {
  aggregateObservationsByCompany,
  buildSentimentPrompt,
  computeEwma,
  invokeSentimentGrok,
  mergeEvidenceClusterIds,
  parseSentimentResponse,
  scoreClusterSentiments,
  type SentimentTarget,
} from "./sentiment";

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = { GROK_MAIN_API_KEY: "grok-key" };

const target: SentimentTarget = {
  clusterKey: "cluster-1",
  title: "Acme Corp posts record earnings",
  summary: "Acme Corp beat expectations on strong cloud revenue growth.",
  companies: [{ canonicalKey: "ticker:ACME", name: "Acme Corp", tickers: ["ACME"], isins: [] }],
};

describe("buildSentimentPrompt", () => {
  it("assigns one numbered pair per (cluster, company) and indexes it", () => {
    const { userPrompt, pairIndex } = buildSentimentPrompt([target]);
    expect(userPrompt).toContain("1. Company: Acme Corp");
    expect(pairIndex.get(1)).toEqual({ clusterKey: "cluster-1", companyKey: "ticker:ACME" });
  });

  it("numbers pairs across multiple clusters and multiple companies per cluster", () => {
    const targets: SentimentTarget[] = [
      target,
      {
        clusterKey: "cluster-2",
        title: "Beta Inc merger talks",
        summary: "",
        companies: [
          { canonicalKey: "ticker:BETA", name: "Beta Inc", tickers: ["BETA"], isins: [] },
          { canonicalKey: "ticker:GAMMA", name: "Gamma LLC", tickers: ["GAMMA"], isins: [] },
        ],
      },
    ];
    const { pairIndex } = buildSentimentPrompt(targets);
    expect(pairIndex.size).toBe(3);
    expect(pairIndex.get(2)).toEqual({ clusterKey: "cluster-2", companyKey: "ticker:BETA" });
    expect(pairIndex.get(3)).toEqual({ clusterKey: "cluster-2", companyKey: "ticker:GAMMA" });
  });
});

describe("parseSentimentResponse (strict JSON)", () => {
  it("parses a well-formed response and clamps scores to [-1, 1]", () => {
    const { pairIndex } = buildSentimentPrompt([target]);
    const raw = JSON.stringify({ scores: [{ i: 1, sentiment: 1.4, rationale: "Strong beat." }] });
    const result = parseSentimentResponse(raw, pairIndex);
    expect(result).toEqual([
      { clusterKey: "cluster-1", companyKey: "ticker:ACME", score: 1, rationale: "Strong beat." },
    ]);
  });

  it("tolerates a response wrapped in a markdown code fence", () => {
    const { pairIndex } = buildSentimentPrompt([target]);
    const raw = '```json\n{"scores": [{"i": 1, "sentiment": -0.5, "rationale": "Guidance cut."}]}\n```';
    const result = parseSentimentResponse(raw, pairIndex);
    expect(result).toEqual([
      { clusterKey: "cluster-1", companyKey: "ticker:ACME", score: -0.5, rationale: "Guidance cut." },
    ]);
  });

  it("drops entries whose pair index was never issued (hallucinated pair)", () => {
    const { pairIndex } = buildSentimentPrompt([target]);
    const raw = JSON.stringify({
      scores: [
        { i: 1, sentiment: 0.2, rationale: "ok" },
        { i: 99, sentiment: 0.9, rationale: "hallucinated" },
      ],
    });
    expect(parseSentimentResponse(raw, pairIndex)).toHaveLength(1);
  });

  it("returns an empty array for garbage input instead of throwing", () => {
    const { pairIndex } = buildSentimentPrompt([target]);
    expect(parseSentimentResponse("not json at all", pairIndex)).toEqual([]);
    expect(parseSentimentResponse("", pairIndex)).toEqual([]);
  });

  it("drops entries missing a numeric sentiment", () => {
    const { pairIndex } = buildSentimentPrompt([target]);
    const raw = JSON.stringify({ scores: [{ i: 1, rationale: "no score" }] });
    expect(parseSentimentResponse(raw, pairIndex)).toEqual([]);
  });

  it("keeps only the first entry when the same pair index repeats", () => {
    const { pairIndex } = buildSentimentPrompt([target]);
    const raw = JSON.stringify({
      scores: [
        { i: 1, sentiment: 0.4, rationale: "first" },
        { i: 1, sentiment: -0.9, rationale: "duplicate" },
      ],
    });
    expect(parseSentimentResponse(raw, pairIndex)).toEqual([
      { clusterKey: "cluster-1", companyKey: "ticker:ACME", score: 0.4, rationale: "first" },
    ]);
  });
});

describe("invokeSentimentGrok", () => {
  it("posts strict-JSON chat completion request to Grok", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"scores":[]}' } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(invokeSentimentGrok(env, "system", "user")).resolves.toBe('{"scores":[]}');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.x.ai/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "grok-4-1-fast-non-reasoning",
      response_format: { type: "json_object" },
    });
  });

  it("throws when no Grok API key is configured", async () => {
    await expect(invokeSentimentGrok({}, "system", "user")).rejects.toThrow("No Grok API key available");
  });
});

describe("scoreClusterSentiments (degrade gracefully)", () => {
  it("returns no sentiments and no throw when the Grok call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const result = await scoreClusterSentiments(env, [target]);
    expect(result.sentiments).toEqual([]);
    expect(result.error).toContain("500");
  });

  it("returns empty with no error for an empty target list (skips the call)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await scoreClusterSentiments(env, []);
    expect(result).toEqual({ sentiments: [], error: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("computeEwma", () => {
  it("starts a company at the observed score when there is no prior history", () => {
    expect(computeEwma(null, 0.6)).toEqual({ score: 0.6, trend: "flat" });
  });

  it("blends the observed score into the prior using the configured alpha", () => {
    // alpha=0.35: 0.35*1 + 0.65*0 = 0.35
    const { score, trend } = computeEwma(0, 1);
    expect(score).toBeCloseTo(0.35, 4);
    expect(trend).toBe("up");
  });

  it("labels a move within the deadband as flat", () => {
    // alpha=0.35: 0.35*0.1 + 0.65*0.1 = 0.1 -> delta 0
    const { trend } = computeEwma(0.1, 0.1);
    expect(trend).toBe("flat");
  });

  it("labels a clear negative move as down", () => {
    const { score, trend } = computeEwma(0.5, -1);
    expect(score).toBeCloseTo(0.5 * 0.65 + -1 * 0.35, 4);
    expect(trend).toBe("down");
  });

  it("clamps an out-of-range observed score before blending", () => {
    const { score } = computeEwma(0, 5);
    expect(score).toBeCloseTo(0.35, 4); // clamped to 1 before blending
  });
});

describe("aggregateObservationsByCompany", () => {
  it("averages multiple cluster scores for the same company into one observation", () => {
    const result = aggregateObservationsByCompany([
      { clusterKey: "c1", companyKey: "ticker:ACME", score: 0.2, rationale: "" },
      { clusterKey: "c2", companyKey: "ticker:ACME", score: 0.8, rationale: "" },
      { clusterKey: "c3", companyKey: "ticker:BETA", score: -0.4, rationale: "" },
    ]);
    expect(result.get("ticker:ACME")).toEqual({ observedScore: 0.5, clusterKeys: ["c1", "c2"] });
    expect(result.get("ticker:BETA")).toEqual({ observedScore: -0.4, clusterKeys: ["c3"] });
  });

  it("excludes clusters already recorded as prior evidence for that company", () => {
    const result = aggregateObservationsByCompany(
      [
        { clusterKey: "c1", companyKey: "ticker:ACME", score: 0.2, rationale: "" },
        { clusterKey: "c2", companyKey: "ticker:ACME", score: 0.8, rationale: "" },
      ],
      new Map([["ticker:ACME", new Set(["c1"])]]),
    );
    expect(result.get("ticker:ACME")).toEqual({ observedScore: 0.8, clusterKeys: ["c2"] });
  });

  it("omits a company whose clusters were all previously observed", () => {
    const result = aggregateObservationsByCompany(
      [
        { clusterKey: "c1", companyKey: "ticker:ACME", score: 0.2, rationale: "" },
        { clusterKey: "c1", companyKey: "ticker:BETA", score: -0.4, rationale: "" },
      ],
      new Map([["ticker:ACME", new Set(["c1", "c2"])]]),
    );
    expect(result.has("ticker:ACME")).toBe(false);
    expect(result.get("ticker:BETA")).toEqual({ observedScore: -0.4, clusterKeys: ["c1"] });
  });
});

describe("mergeEvidenceClusterIds", () => {
  it("puts fresh ids first and caps the total at 10", () => {
    const existing = Array.from({ length: 9 }, (_, i) => `old-${i}`);
    const merged = mergeEvidenceClusterIds(existing, ["new-1", "new-2"]);
    expect(merged).toHaveLength(10);
    expect(merged.slice(0, 2)).toEqual(["new-1", "new-2"]);
  });

  it("de-duplicates ids already present in existing evidence", () => {
    const merged = mergeEvidenceClusterIds(["a", "b"], ["b", "c"]);
    expect(merged).toEqual(["b", "c", "a"]);
  });
});
