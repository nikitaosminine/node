// ============================================================
// Pure logic for the Polymarket curation eval harness.
//
// No network, no filesystem — everything here is deterministic and
// unit-tested (eval-curation-lib.test.mjs). The CLI wrapper
// (eval-curation.mjs) owns LangSmith/Grok/Supabase I/O.
//
// Dataset shape (one file = one labeled snapshot of curation runs):
//   {
//     label, created_at, source: "langsmith"|"fixture", project,
//     runs: [{
//       run_id, start_time, portfolio_id, user_id, model,
//       reasoning_effort, candidate_count,
//       profile_summary,                       // from grok.score user prompt
//       candidates: [{condition_id, question, event_id?, event_title?}],
//       picks: [{condition_id, score, reason}], // parent run outputs.scored
//       error: string|null
//     }]
//   }
// ============================================================

import { createHash } from "node:crypto";

// Bump when the judge rubric text changes — invalidates cached judgments so
// numbers from different rubrics are never mixed.
export const JUDGE_RUBRIC_VERSION = "v1";

// Grok is instructed to return only picks with score >= 0.35
// (apps/api/src/feeds/polymarket.ts scoreRotatingCandidates system prompt).
// Picks below this measure instruction-following, not relevance.
export const SCORE_THRESHOLD = 0.35;

// Grok is instructed to pick at most 2 markets per Polymarket event.
export const MAX_PICKS_PER_EVENT = 2;

// Max candidates sent to Grok per portfolio — copy of ROTATING_BATCH_SIZE in
// apps/api/src/feeds/polymarket.ts (KEEP IN SYNC). The parent run's
// candidate_count input is the pre-slice pool size, so the prompt contains
// min(candidate_count, this) lines — used to detect partially parsed prompts.
export const ROTATING_BATCH_SIZE = 60;

// Copy of NON_FINANCIAL_RE from apps/api/src/feeds/polymarket.ts (the .mjs
// script cannot import the Worker's TS module). KEEP IN SYNC — it is the
// pre-Grok sports/entertainment/candidacy filter, reused here to count picks
// that should never have reached (or survived) scoring.
export const NON_FINANCIAL_RE =
  /\b(fifa|world cup|super bowl|nfl|nba|nhl|mlb|premier league|la liga|bundesliga|serie a|champions league|olympic|euro 202[0-9]|euros 202[0-9]|wimbledon|grand prix|formula.?1\b|f1 race|moto ?gp|cricket|rugby world|march madness|stanley cup|gold cup|copa am[eé]rica|esports|grammy|oscar|emmy|golden globe|box office|celebrity|reality (tv|show)|presidential nomination|republican nomination|democratic nomination|win the .{0,30} nomination|become .{0,20} nominee|primary election|senate seat|congressional seat|gubernatorial|win the .{0,20} primary|win the \d{4} .{0,30} presidential election|win the \d{4} us presidential|us president in \d{4})\b/i;

// ---------------------------------------------------------------------------
// Trace parsing
// ---------------------------------------------------------------------------

// Parse the grok.score user prompt back into structured data. Prompt format
// (built in scoreRotatingCandidates):
//   Portfolio profile:
//   <profileSummary>
//
//   Candidate prediction markets — pick the top K ...:
//   1. [<condition_id>] <question>
//   ...
//
//   Return JSON array only. ...
export function parseCurationUserPrompt(userPrompt) {
  if (typeof userPrompt !== "string" || userPrompt.length === 0) {
    return { profileSummary: null, candidates: [] };
  }

  let profileSummary = null;
  const profileMatch = userPrompt.match(
    /Portfolio profile:\s*\n([\s\S]*?)\n\s*\nCandidate prediction markets/,
  );
  if (profileMatch) profileSummary = profileMatch[1].trim();

  const candidates = [];
  const lineRe = /^\s*\d+\.\s+\[([^\]]+)\]\s+(.+)$/gm;
  let m;
  while ((m = lineRe.exec(userPrompt)) !== null) {
    candidates.push({ condition_id: m[1].trim(), question: m[2].trim() });
  }

  return { profileSummary, candidates };
}

// Normalize a LangSmith parent run (+ optional grok.score child) into one
// dataset run row. `parent`/`child` are raw Run objects from client.listRuns.
export function normalizeLangsmithRun(parent, child) {
  const inputs = parent?.inputs ?? {};
  const outputs = parent?.outputs ?? {};
  const { profileSummary, candidates } = parseCurationUserPrompt(child?.inputs?.user);

  const picks = Array.isArray(outputs.scored)
    ? outputs.scored
        .filter((p) => p && typeof p === "object" && typeof p.condition_id === "string")
        .map((p) => ({
          condition_id: p.condition_id,
          score: typeof p.score === "number" ? p.score : null,
          reason: typeof p.reason === "string" ? p.reason : null,
        }))
    : [];

  return {
    run_id: parent?.id ?? null,
    start_time: parent?.start_time ?? null,
    portfolio_id: inputs.portfolio_id ?? null,
    user_id: inputs.user_id ?? null,
    model: inputs.model ?? null,
    reasoning_effort: inputs.reasoning_effort ?? null,
    candidate_count: inputs.candidate_count ?? candidates.length,
    profile_summary: profileSummary,
    candidates,
    picks,
    error: parent?.error ?? null,
  };
}

// ---------------------------------------------------------------------------
// Structural metrics (per run)
// ---------------------------------------------------------------------------

// Ticker-ish tokens from the profile summary (NVDA, PUST.PA, 7203.T, …) used
// as anchors for the reason-anchored check. Excludes prose words the profile
// template itself contributes.
const PROFILE_STOPWORDS = new Set([
  "DIRECT", "HOLDINGS", "ETF", "EXPOSURE", "SECTORS", "COUNTRIES", "AMUNDI",
]);

export function extractProfileAnchors(profileSummary) {
  if (!profileSummary) return [];
  const matches = profileSummary.match(/\b[A-Z][A-Z0-9]{1,6}(?:[.-][A-Z0-9]{1,4})*\b/g) ?? [];
  return [...new Set(matches.filter((t) => !PROFILE_STOPWORDS.has(t) && t.length >= 2))];
}

export function reasonMentionsProfile(reason, anchors) {
  if (!reason || anchors.length === 0) return false;
  const upper = reason.toUpperCase();
  return anchors.some((a) =>
    new RegExp(`(^|[^A-Z0-9])${a.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}([^A-Z0-9]|$)`).test(upper),
  );
}

// A run is a "fallback" when curation produced no usable picks — in
// production runPolymarketFanout then writes volume-sorted rows with
// score=0/reason=null instead (polymarket.ts step 6c/6d).
export function isFallbackRun(run) {
  return Boolean(run.error) || (run.picks ?? []).length === 0;
}

// Full context = profile present AND the candidate list parsed back complete.
// The prompt contains min(candidate_count, ROTATING_BATCH_SIZE) candidate
// lines; recovering fewer means some lines failed to parse, so picks from the
// omitted candidates would be falsely counted invalid and their questions are
// unknown — the run must not enter context-dependent denominators.
function hasFullContext(run, candidates) {
  if (!run.profile_summary || candidates.length === 0) return false;
  if (typeof run.candidate_count !== "number") return true; // nothing to check against
  return candidates.length >= Math.min(run.candidate_count, ROTATING_BATCH_SIZE);
}

export function computeRunMetrics(run) {
  const candidates = run.candidates ?? [];
  const picks = run.picks ?? [];
  const candidateIds = new Set(candidates.map((c) => c.condition_id));
  const questionById = new Map(candidates.map((c) => [c.condition_id, c.question]));
  const eventById = new Map(
    candidates.filter((c) => c.event_id).map((c) => [c.condition_id, c.event_id]),
  );
  const anchors = extractProfileAnchors(run.profile_summary);

  const seen = new Set();
  let duplicatePicks = 0;
  let invalidPicks = 0;
  let belowThreshold = 0;
  let missingReason = 0;
  let nonFinancial = 0;
  let reasonAnchored = 0;
  const scores = [];
  const picksPerEvent = new Map();
  let picksWithKnownEvent = 0;

  for (const pick of picks) {
    if (seen.has(pick.condition_id)) duplicatePicks += 1;
    seen.add(pick.condition_id);

    if (candidateIds.size > 0 && !candidateIds.has(pick.condition_id)) invalidPicks += 1;

    if (typeof pick.score === "number") {
      scores.push(pick.score);
      if (pick.score < SCORE_THRESHOLD) belowThreshold += 1;
    }

    if (!pick.reason || pick.reason.trim().length === 0) missingReason += 1;
    else if (reasonMentionsProfile(pick.reason, anchors)) reasonAnchored += 1;

    const question = questionById.get(pick.condition_id);
    if (question && NON_FINANCIAL_RE.test(question)) nonFinancial += 1;

    const eventId = eventById.get(pick.condition_id);
    if (eventId) {
      picksWithKnownEvent += 1;
      picksPerEvent.set(eventId, (picksPerEvent.get(eventId) ?? 0) + 1);
    }
  }

  const eventsOverCap = [...picksPerEvent.values()].filter((n) => n > MAX_PICKS_PER_EVENT).length;
  const maxPicksPerEvent = picksPerEvent.size > 0 ? Math.max(...picksPerEvent.values()) : 0;

  return {
    run_id: run.run_id,
    portfolio_id: run.portfolio_id,
    fallback: isFallbackRun(run),
    // Picks exist but the grok.score child (profile + candidate pool) was
    // missing, unparseable, or only PARTIALLY parsed (fewer candidate lines
    // recovered than the prompt must have contained) — invalid-id,
    // non-financial, and anchored-reason checks would be wrong for this run,
    // so it is excluded from the context-dependent aggregate rates.
    missing_context: picks.length > 0 && !hasFullContext(run, candidates),
    error: run.error ?? null,
    candidate_count: run.candidate_count ?? candidates.length,
    pick_count: picks.length,
    duplicate_picks: duplicatePicks,
    invalid_picks: invalidPicks,
    below_threshold: belowThreshold,
    missing_reason: missingReason,
    reason_anchored: reasonAnchored,
    non_financial_picks: nonFinancial,
    scores,
    event_coverage: picks.length > 0 ? picksWithKnownEvent / picks.length : 0,
    picks_with_known_event: picksWithKnownEvent,
    unique_events: picksPerEvent.size,
    events_over_cap: eventsOverCap,
    max_picks_per_event: maxPicksPerEvent,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function aggregateMetrics(runMetrics) {
  const runs = runMetrics.length;
  const fallbackRuns = runMetrics.filter((r) => r.fallback);
  const scoredRuns = runMetrics.filter((r) => !r.fallback);
  const errorRuns = runMetrics.filter((r) => r.error);

  const allScores = scoredRuns.flatMap((r) => r.scores).sort((a, b) => a - b);
  const totalPicks = scoredRuns.reduce((s, r) => s + r.pick_count, 0);
  const sum = (key) => scoredRuns.reduce((s, r) => s + r[key], 0);

  // Context-dependent rates (invalid-id, non-financial, reason-anchored) are
  // computed only over runs where the grok.score child gave us the candidate
  // pool + profile — otherwise missing-context picks would sit in the
  // denominator with guaranteed-zero numerators and dilute the rates as
  // missing-context traces accumulate.
  const contextRuns = scoredRuns.filter((r) => !r.missing_context);
  const contextPicks = contextRuns.reduce((s, r) => s + r.pick_count, 0);
  const sumCtx = (key) => contextRuns.reduce((s, r) => s + r[key], 0);
  const contextPicksWithReason = contextPicks - sumCtx("missing_reason");

  const histogram = {
    "0.00-0.35": allScores.filter((s) => s < 0.35).length,
    "0.35-0.60": allScores.filter((s) => s >= 0.35 && s < 0.6).length,
    "0.60-0.80": allScores.filter((s) => s >= 0.6 && s < 0.8).length,
    "0.80-1.00": allScores.filter((s) => s >= 0.8).length,
  };

  const runsWithEventData = scoredRuns.filter((r) => r.event_coverage > 0);

  return {
    runs,
    scored_runs: scoredRuns.length,
    fallback_runs: fallbackRuns.length,
    fallback_rate: runs > 0 ? fallbackRuns.length / runs : 0,
    error_runs: errorRuns.length,
    runs_missing_context: runMetrics.filter((r) => r.missing_context).length,
    distinct_portfolios: new Set(runMetrics.map((r) => r.portfolio_id).filter(Boolean)).size,
    avg_picks_per_scored_run: scoredRuns.length > 0 ? totalPicks / scoredRuns.length : 0,
    total_picks: totalPicks,
    invalid_pick_rate: contextPicks > 0 ? sumCtx("invalid_picks") / contextPicks : null,
    duplicate_pick_rate: totalPicks > 0 ? sum("duplicate_picks") / totalPicks : 0,
    below_threshold_rate: totalPicks > 0 ? sum("below_threshold") / totalPicks : 0,
    missing_reason_rate: totalPicks > 0 ? sum("missing_reason") / totalPicks : 0,
    reason_anchored_rate:
      contextPicksWithReason > 0 ? sumCtx("reason_anchored") / contextPicksWithReason : null,
    non_financial_leak_rate:
      contextPicks > 0 ? sumCtx("non_financial_picks") / contextPicks : null,
    context_picks: contextPicks,
    score_mean: allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : null,
    score_p50: quantile(allScores, 0.5),
    score_min: allScores.length > 0 ? allScores[0] : null,
    score_max: allScores.length > 0 ? allScores[allScores.length - 1] : null,
    score_histogram: histogram,
    event_data_runs: runsWithEventData.length,
    // Averaged over runs with any event data. Coverage < 100% can only hide
    // violations (an unknown-event pick can't be grouped), never invent them.
    event_over_cap_run_rate:
      runsWithEventData.length > 0
        ? runsWithEventData.filter((r) => r.events_over_cap > 0).length / runsWithEventData.length
        : null,
    // Ratio over picks WITH a known event only, so partial enrichment doesn't
    // read as (false) duplication. avg_event_coverage says how partial it was.
    avg_unique_event_ratio:
      runsWithEventData.length > 0
        ? runsWithEventData.reduce(
            (s, r) =>
              s + (r.picks_with_known_event > 0 ? r.unique_events / r.picks_with_known_event : 0),
            0,
          ) / runsWithEventData.length
        : null,
    avg_event_coverage:
      runsWithEventData.length > 0
        ? runsWithEventData.reduce((s, r) => s + r.event_coverage, 0) / runsWithEventData.length
        : null,
  };
}

// ---------------------------------------------------------------------------
// LLM judge (prompt construction + response parsing; the API call lives in
// the CLI)
// ---------------------------------------------------------------------------

export function judgeCacheKey({ profileSummary, question, reason }) {
  return createHash("sha256")
    .update(
      [JUDGE_RUBRIC_VERSION, profileSummary ?? "", question ?? "", reason ?? ""].join(" "),
    )
    .digest("hex");
}

export function buildJudgePrompt({ profileSummary, question, reason }) {
  const system = `You are auditing a financial-relevance curation system. It was told to pick prediction markets ONLY when the market outcome has a DIRECT, MATERIAL financial connection to a specific investment portfolio — i.e. the outcome would move stock prices, interest rates, commodity prices, currency rates, or sector-specific regulation for holdings in the portfolio.

Judge ONE pick. It is RELEVANT only if you can name a specific financial mechanism linking the market outcome to a specific holding, ETF, underlying stock, sector, or country exposure in the profile. It is NOT relevant if the connection is: sports or entertainment, geographic overlap alone ("the portfolio holds Japanese stocks and this market is about Japan's soccer team"), an individual political candidacy/nomination/primary, or only generic "macro uncertainty" with no named mechanism.

Respond with ONLY a JSON object:
{"relevant": true|false, "mechanism": "one sentence naming the mechanism, or why there is none"}`;

  const user = `Portfolio profile:
${profileSummary ?? "(unknown)"}

Prediction market picked by the system:
${question ?? "(unknown)"}

The system's stated reason for the pick:
${reason && reason.trim().length > 0 ? reason : "(none given)"}

Is this pick RELEVANT under the rubric? JSON only.`;

  return { system, user };
}

export function parseJudgeResponse(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const attempts = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1));
  for (const text of attempts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof parsed.relevant === "boolean") {
        return {
          relevant: parsed.relevant,
          mechanism: typeof parsed.mechanism === "string" ? parsed.mechanism : null,
        };
      }
    } catch {
      // try next form
    }
  }
  return null;
}

// A pick is judgeable only when we know what the model saw: the portfolio
// profile and the market's question text. Hallucinated condition_ids (no
// question) and runs missing their grok.score child are counted separately —
// a relevance verdict on "(unknown)" content would be meaningless and would
// poison the verdict cache.
export function isJudgeablePick(run, pick) {
  if (!run.profile_summary) return false;
  return (run.candidates ?? []).some(
    (c) => c.condition_id === pick.condition_id && typeof c.question === "string",
  );
}

// Fold judge verdicts into per-run + aggregate precision numbers.
// `verdictFor(run, pick)` returns {relevant} | null (null = unjudged).
export function computeJudgeMetrics(dataset, verdictFor) {
  let judged = 0;
  let relevant = 0;
  let unjudged = 0;
  let unjudgeable = 0;
  const perRun = [];

  for (const run of dataset.runs) {
    if (isFallbackRun(run)) continue;
    let runJudged = 0;
    let runRelevant = 0;
    for (const pick of run.picks) {
      if (!isJudgeablePick(run, pick)) {
        unjudgeable += 1;
        continue;
      }
      const verdict = verdictFor(run, pick);
      if (!verdict) {
        unjudged += 1;
        continue;
      }
      judged += 1;
      runJudged += 1;
      if (verdict.relevant) {
        relevant += 1;
        runRelevant += 1;
      }
    }
    perRun.push({
      run_id: run.run_id,
      judged: runJudged,
      precision: runJudged > 0 ? runRelevant / runJudged : null,
    });
  }

  const precisions = perRun.map((r) => r.precision).filter((p) => p !== null);
  return {
    judged,
    unjudged,
    unjudgeable,
    relevant,
    precision: judged > 0 ? relevant / judged : null,
    mean_run_precision:
      precisions.length > 0 ? precisions.reduce((a, b) => a + b, 0) / precisions.length : null,
    per_run: perRun,
  };
}

// ---------------------------------------------------------------------------
// Report formatting + baseline comparison
// ---------------------------------------------------------------------------

const COMPARE_KEYS = [
  ["fallback_rate", "Fallback-run rate", "pct", "lower"],
  ["avg_picks_per_scored_run", "Avg picks / scored run", "num", "info"],
  ["score_mean", "Mean pick score", "num", "info"],
  ["below_threshold_rate", "Picks below 0.35", "pct", "lower"],
  ["invalid_pick_rate", "Invalid-id pick rate", "pct", "lower"],
  ["duplicate_pick_rate", "Duplicate pick rate", "pct", "lower"],
  ["missing_reason_rate", "Missing-reason rate", "pct", "lower"],
  ["reason_anchored_rate", "Reason-anchored rate", "pct", "higher"],
  ["non_financial_leak_rate", "Non-financial leak rate", "pct", "lower"],
  ["event_over_cap_run_rate", "Runs breaking 2-per-event cap", "pct", "lower"],
  ["avg_unique_event_ratio", "Unique-event ratio", "pct", "higher"],
  ["judge_precision", "Judge relevance precision", "pct", "higher"],
];

function fmt(value, kind) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return kind === "pct" ? `${(value * 100).toFixed(1)}%` : value.toFixed(2);
}

export function flattenForComparison(report) {
  return {
    ...report.metrics,
    judge_precision: report.judge?.precision ?? null,
  };
}

export function formatReport(report, baseline = null) {
  const m = report.metrics;
  const lines = [];
  lines.push("");
  lines.push("Polymarket Curation Eval Report");
  lines.push("===============================");
  lines.push(`Dataset:            ${report.dataset.label} (${report.dataset.source})`);
  lines.push(`Runs:               ${m.runs} (${m.scored_runs} scored, ${m.fallback_runs} fallback, ${m.error_runs} errored)`);
  lines.push(`Portfolios:         ${m.distinct_portfolios}`);
  if (m.runs_missing_context > 0) {
    lines.push(
      `⚠️  ${m.runs_missing_context} run(s) have picks but no grok.score child (profile/candidate pool unknown) — their picks are excluded from the invalid-id, non-financial, and anchored-reason rates (${m.context_picks}/${m.total_picks} picks have context) and are not judged.`,
    );
  }
  lines.push("");
  lines.push("Structural metrics");
  lines.push("------------------");
  lines.push(`Fallback-run rate:      ${fmt(m.fallback_rate, "pct")}`);
  lines.push(`Avg picks / scored run: ${fmt(m.avg_picks_per_scored_run, "num")}  (${m.total_picks} picks total)`);
  lines.push(`Score mean / p50:       ${fmt(m.score_mean, "num")} / ${fmt(m.score_p50, "num")}  (min ${fmt(m.score_min, "num")}, max ${fmt(m.score_max, "num")})`);
  lines.push(`Score histogram:        <0.35: ${m.score_histogram["0.00-0.35"]} | 0.35-0.6: ${m.score_histogram["0.35-0.60"]} | 0.6-0.8: ${m.score_histogram["0.60-0.80"]} | >=0.8: ${m.score_histogram["0.80-1.00"]}`);
  lines.push(`Picks below 0.35:       ${fmt(m.below_threshold_rate, "pct")}  (instruction violation)`);
  lines.push(`Invalid-id picks:       ${fmt(m.invalid_pick_rate, "pct")}`);
  lines.push(`Duplicate picks:        ${fmt(m.duplicate_pick_rate, "pct")}`);
  lines.push(`Missing reasons:        ${fmt(m.missing_reason_rate, "pct")}`);
  lines.push(`Reason-anchored:        ${fmt(m.reason_anchored_rate, "pct")}  (reason names a profile holding)`);
  lines.push(`Non-financial leaks:    ${fmt(m.non_financial_leak_rate, "pct")}  (sports/entertainment/candidacy picks)`);
  if (m.event_data_runs > 0) {
    lines.push(`Event diversity:        ${fmt(m.avg_unique_event_ratio, "pct")} unique-event ratio; ${fmt(m.event_over_cap_run_rate, "pct")} of runs break the 2-per-event cap (event data on ${m.event_data_runs}/${m.scored_runs} runs, ${fmt(m.avg_event_coverage, "pct")} pick coverage)`);
  } else {
    lines.push("Event diversity:        n/a (no event_id enrichment in this dataset)");
  }
  lines.push("");
  lines.push("LLM judge (relevance precision)");
  lines.push("-------------------------------");
  if (report.judge && report.judge.judged > 0) {
    lines.push(`Precision:              ${fmt(report.judge.precision, "pct")}  (${report.judge.relevant}/${report.judge.judged} picks judged relevant)`);
    lines.push(`Mean per-run precision: ${fmt(report.judge.mean_run_precision, "pct")}`);
    if (report.judge.unjudged > 0) {
      lines.push(`Unjudged picks:         ${report.judge.unjudged}  (no cached verdict and no judge API key/mode)`);
    }
    if (report.judge.unjudgeable > 0) {
      lines.push(`Unjudgeable picks:      ${report.judge.unjudgeable}  (hallucinated id or missing grok.score context — see invalid-id/missing-context counts)`);
    }
    lines.push(`Judge source:           ${report.judge.mode}${report.judge.api_calls ? ` (${report.judge.api_calls} API calls, ${report.judge.cache_hits} cache hits)` : ` (${report.judge.cache_hits} cache hits)`}`);
  } else {
    lines.push(`Skipped (${report.judge?.mode ?? "off"}) — structural metrics only.`);
  }

  if (baseline) {
    const cur = flattenForComparison(report);
    const base = flattenForComparison(baseline);
    lines.push("");
    lines.push(`Comparison vs baseline "${baseline.baseline_label ?? baseline.dataset?.label ?? "?"}"`);
    lines.push("-".repeat(40));
    for (const [key, label, kind, direction] of COMPARE_KEYS) {
      const b = base[key];
      const c = cur[key];
      if ((b === null || b === undefined) && (c === null || c === undefined)) continue;
      let marker = "";
      if (typeof b === "number" && typeof c === "number" && Math.abs(c - b) > 1e-9) {
        const improved =
          direction === "lower" ? c < b : direction === "higher" ? c > b : null;
        marker = improved === null ? "" : improved ? "  ✅" : "  ⚠️";
      }
      lines.push(`${(label + ":").padEnd(31)}${fmt(b, kind)} → ${fmt(c, kind)}${marker}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
