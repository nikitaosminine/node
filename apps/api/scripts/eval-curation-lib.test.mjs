import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateMetrics,
  computeJudgeMetrics,
  computeRunMetrics,
  extractProfileAnchors,
  isFallbackRun,
  judgeCacheKey,
  normalizeLangsmithRun,
  parseCurationUserPrompt,
  parseJudgeResponse,
  formatReport,
} from "./eval-curation-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDataset = JSON.parse(
  readFileSync(resolve(__dirname, "..", "evals", "curation", "fixtures", "fixture-dataset.json"), "utf8"),
);
const fixtureJudgments = JSON.parse(
  readFileSync(resolve(__dirname, "..", "evals", "curation", "fixtures", "fixture-judgments.json"), "utf8"),
);

// Mirrors the exact prompt built in scoreRotatingCandidates
// (src/feeds/polymarket.ts) — if that format changes, parsing must follow.
const SAMPLE_USER_PROMPT = `Portfolio profile:
Direct holdings: NVDA, MSFT. ETF exposure: PUST.PA (Amundi NASDAQ-100: NVDA, AAPL, MSFT, AMZN, META). Sectors: Information Technology. Countries: United States

Candidate prediction markets — pick the top 16 with DIRECT financial connection to this portfolio:
1. [0xabc123] Will the Fed make 0 rate cuts in 2026?
2. [0xdef456] Will the US enter a recession by end of 2026?
3. [0x789aaa] Will Bitcoin hit $200k before 2027?

Return JSON array only. No sports, no entertainment, no individual political candidacies, no geography-as-relevance.`;

describe("parseCurationUserPrompt", () => {
  it("extracts the profile summary and candidate list from the production prompt format", () => {
    const { profileSummary, candidates } = parseCurationUserPrompt(SAMPLE_USER_PROMPT);
    expect(profileSummary).toContain("Direct holdings: NVDA, MSFT");
    expect(profileSummary).toContain("Countries: United States");
    expect(candidates).toEqual([
      { condition_id: "0xabc123", question: "Will the Fed make 0 rate cuts in 2026?" },
      { condition_id: "0xdef456", question: "Will the US enter a recession by end of 2026?" },
      { condition_id: "0x789aaa", question: "Will Bitcoin hit $200k before 2027?" },
    ]);
  });

  it("returns empty structure for missing/garbage prompts", () => {
    expect(parseCurationUserPrompt(undefined)).toEqual({ profileSummary: null, candidates: [] });
    expect(parseCurationUserPrompt("no structure here")).toEqual({
      profileSummary: null,
      candidates: [],
    });
  });
});

describe("normalizeLangsmithRun", () => {
  it("maps parent inputs/outputs and child prompt into a dataset row", () => {
    const parent = {
      id: "run-1",
      start_time: "2026-08-01T00:00:00Z",
      inputs: {
        portfolio_id: "p1",
        user_id: "u1",
        model: "grok-4.6",
        reasoning_effort: "medium",
        candidate_count: 3,
      },
      outputs: {
        scored: [
          { condition_id: "0xabc123", score: 0.9, reason: "rates reprice PUST.PA" },
          { condition_id: 42, score: 0.5, reason: "bad row dropped" },
        ],
        count: 2,
      },
      error: null,
    };
    const child = { inputs: { user: SAMPLE_USER_PROMPT } };

    const row = normalizeLangsmithRun(parent, child);
    expect(row.run_id).toBe("run-1");
    expect(row.portfolio_id).toBe("p1");
    expect(row.candidates).toHaveLength(3);
    expect(row.picks).toEqual([
      { condition_id: "0xabc123", score: 0.9, reason: "rates reprice PUST.PA" },
    ]);
    expect(row.error).toBeNull();
  });

  it("handles errored runs with no child", () => {
    const row = normalizeLangsmithRun({ id: "run-2", error: "boom", inputs: {} }, null);
    expect(row.error).toBe("boom");
    expect(row.picks).toEqual([]);
    expect(isFallbackRun(row)).toBe(true);
  });
});

describe("computeRunMetrics", () => {
  const runB = fixtureDataset.runs.find((r) => r.run_id.endsWith("b"));

  it("catches every planted failure mode in fixture run B", () => {
    const m = computeRunMetrics(runB);
    expect(m.fallback).toBe(false);
    expect(m.pick_count).toBe(7);
    expect(m.invalid_picks).toBe(1); // 0xdeadbeef not in candidates
    expect(m.below_threshold).toBe(1); // score 0.2 < 0.35
    expect(m.missing_reason).toBe(1); // empty reason on 0xoil1
    expect(m.non_financial_picks).toBe(1); // Champions League pick
    expect(m.events_over_cap).toBe(1); // 3 picks from evt-fed-cuts (cap is 2)
    expect(m.max_picks_per_event).toBe(3);
    expect(m.duplicate_picks).toBe(0);
  });

  it("scores the healthy fixture run A clean", () => {
    const runA = fixtureDataset.runs.find((r) => r.run_id.endsWith("a"));
    const m = computeRunMetrics(runA);
    expect(m.invalid_picks).toBe(0);
    expect(m.below_threshold).toBe(0);
    expect(m.missing_reason).toBe(0);
    expect(m.non_financial_picks).toBe(0);
    expect(m.events_over_cap).toBe(0);
    expect(m.unique_events).toBe(8);
  });

  it("marks empty-pick and errored runs as fallback", () => {
    const runC = fixtureDataset.runs.find((r) => r.run_id.endsWith("c"));
    const runD = fixtureDataset.runs.find((r) => r.run_id.endsWith("d"));
    expect(computeRunMetrics(runC).fallback).toBe(true);
    expect(computeRunMetrics(runD).fallback).toBe(true);
    expect(computeRunMetrics(runD).error).toContain("429");
  });
});

describe("aggregateMetrics", () => {
  it("aggregates the fixture dataset to the documented numbers", () => {
    const m = aggregateMetrics(fixtureDataset.runs.map(computeRunMetrics));
    expect(m.runs).toBe(4);
    expect(m.scored_runs).toBe(2);
    expect(m.fallback_rate).toBeCloseTo(0.5);
    expect(m.error_runs).toBe(1);
    expect(m.total_picks).toBe(15);
    expect(m.avg_picks_per_scored_run).toBeCloseTo(7.5);
    expect(m.invalid_pick_rate).toBeCloseTo(1 / 15);
    expect(m.below_threshold_rate).toBeCloseTo(1 / 15);
    expect(m.missing_reason_rate).toBeCloseTo(1 / 15);
    expect(m.non_financial_leak_rate).toBeCloseTo(1 / 15);
    expect(m.event_over_cap_run_rate).toBeCloseTo(0.5);
    expect(m.score_histogram["0.00-0.35"]).toBe(1);
    // Fallback runs contribute no picks/scores.
    expect(m.score_min).toBeCloseTo(0.2);
    expect(m.score_max).toBeCloseTo(0.9);
  });

  it("handles an empty dataset without dividing by zero", () => {
    const m = aggregateMetrics([]);
    expect(m.runs).toBe(0);
    expect(m.fallback_rate).toBe(0);
    expect(m.score_mean).toBeNull();
    expect(m.event_over_cap_run_rate).toBeNull();
  });
});

describe("judge plumbing", () => {
  it("cache keys are stable and sensitive to every input", () => {
    const base = { profileSummary: "p", question: "q", reason: "r" };
    expect(judgeCacheKey(base)).toBe(judgeCacheKey({ ...base }));
    expect(judgeCacheKey(base)).not.toBe(judgeCacheKey({ ...base, question: "q2" }));
    expect(judgeCacheKey(base)).not.toBe(judgeCacheKey({ ...base, reason: null }));
  });

  it("parses direct and wrapped judge JSON, rejects garbage", () => {
    expect(parseJudgeResponse('{"relevant": true, "mechanism": "m"}')).toEqual({
      relevant: true,
      mechanism: "m",
    });
    expect(
      parseJudgeResponse('Here you go:\n```json\n{"relevant": false, "mechanism": "none"}\n```'),
    ).toEqual({ relevant: false, mechanism: "none" });
    expect(parseJudgeResponse("not json")).toBeNull();
    expect(parseJudgeResponse('{"missing": "relevant"}')).toBeNull();
  });

  it("computes the fixture's known relevance precision from the bundled verdicts", () => {
    const verdictFor = (run, pick) => {
      const questionById = new Map(run.candidates.map((c) => [c.condition_id, c.question]));
      const key = judgeCacheKey({
        profileSummary: run.profile_summary,
        question: questionById.get(pick.condition_id) ?? null,
        reason: pick.reason,
      });
      return fixtureJudgments.verdicts[key] ?? null;
    };
    const jm = computeJudgeMetrics(fixtureDataset, verdictFor);
    expect(jm.judged).toBe(15);
    expect(jm.unjudged).toBe(0);
    expect(jm.precision).toBeCloseTo(10 / 15); // run A: 7/8, run B: 3/7
    expect(jm.mean_run_precision).toBeCloseTo((7 / 8 + 3 / 7) / 2);
  });
});

describe("profile anchors", () => {
  it("extracts ticker-ish tokens and skips template words", () => {
    const anchors = extractProfileAnchors(
      "Direct holdings: NVDA, MSFT. ETF exposure: PUST.PA (Amundi NASDAQ-100: NVDA, AAPL). Sectors: Information Technology",
    );
    expect(anchors).toContain("NVDA");
    expect(anchors).toContain("PUST.PA");
    expect(anchors).not.toContain("ETF");
    expect(anchors).not.toContain("DIRECT");
  });
});

describe("formatReport", () => {
  it("renders a readable report and baseline deltas", () => {
    const runMetrics = fixtureDataset.runs.map(computeRunMetrics);
    const report = {
      dataset: { label: "fixture", source: "fixture" },
      metrics: aggregateMetrics(runMetrics),
      judge: { mode: "cached", judged: 15, relevant: 10, unjudged: 0, cache_hits: 15, api_calls: 0, precision: 10 / 15, mean_run_precision: 0.65, per_run: [] },
    };
    const text = formatReport(report);
    expect(text).toContain("Fallback-run rate:      50.0%");
    expect(text).toContain("Precision:              66.7%");

    const worseBaseline = JSON.parse(JSON.stringify(report));
    worseBaseline.baseline_label = "old";
    worseBaseline.judge.precision = 0.5;
    const withDelta = formatReport(report, worseBaseline);
    expect(withDelta).toContain('Comparison vs baseline "old"');
    expect(withDelta).toContain("50.0% → 66.7%  ✅");
  });
});
