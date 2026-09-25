#!/usr/bin/env node
// ============================================================
// Polymarket curation quality eval harness.
//
// Gives parsing/prompt changes a before/after number instead of vibes:
//   1. `snapshot` pulls recent `polymarket-curation` traces from LangSmith
//      (parent run = portfolio attribution + picks; `grok.score` child = the
//      exact profile + candidate pool the model saw) into a labeled local
//      dataset file.
//   2. `report` (default) scores a dataset: structural metrics (fallback
//      rate, score distribution, per-event duplication, non-financial leaks)
//      plus an LLM-judge relevance-precision pass with a persistent verdict
//      cache, and can save/compare baselines.
//
// Runs locally / CI-manually only — NOT a Worker route; no production code
// path is involved. Full metric definitions: apps/api/evals/curation/README.md
//
// Usage:
//   npm run eval:curation                        # report on newest dataset (bundled fixture if none)
//   npm run eval:curation -- --judge grok        # judge uncached picks via Grok API
//   npm run eval:curation -- --save-baseline pre-parse-fix
//   npm run eval:curation -- --baseline pre-parse-fix
//   npm run eval:curation -- snapshot --label pre-parse-fix --last 25
//
// Env (auto-loaded from apps/api/.dev.vars when unset):
//   LANGSMITH_API_KEY      required for `snapshot` only
//   LANGSMITH_PROJECT      trace project (default: node-polymarket)
//   LANGSMITH_WORKSPACE_ID required for org-scoped LangSmith keys
//   LANGSMITH_ENDPOINT     only for EU-region accounts
//   SUPABASE_URL + SUPABASE_SERVICE_KEY  optional: event_id enrichment during snapshot
//   GROK_MAIN_API_KEY (or EVAL_JUDGE_API_KEY / GROK_SUB_API_KEY / GROK_NORMALIZATION_API_KEY)
//                          required for `--judge grok` only
//   EVAL_JUDGE_MODEL       judge model (default: grok-4.6)
// ============================================================

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateMetrics,
  buildJudgePrompt,
  computeJudgeMetrics,
  computeRunMetrics,
  isFallbackRun,
  isJudgeablePick,
  judgeCacheKey,
  normalizeLangsmithRun,
  parseJudgeResponse,
} from "./eval-curation-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = resolve(__dirname, "..", "evals", "curation");
const DATASETS_DIR = resolve(EVAL_DIR, "datasets");
const BASELINES_DIR = resolve(EVAL_DIR, "baselines");
const JUDGMENTS_DIR = resolve(EVAL_DIR, "judgments");
const FIXTURE_DATASET = resolve(EVAL_DIR, "fixtures", "fixture-dataset.json");
const FIXTURE_JUDGMENTS = resolve(EVAL_DIR, "fixtures", "fixture-judgments.json");
const JUDGE_CACHE_FILE = resolve(JUDGMENTS_DIR, "cache.json");

const DEFAULT_PROJECT = "node-polymarket";
const DEFAULT_JUDGE_MODEL = "grok-4.6";

function printHelp() {
  console.log(`Polymarket Curation Eval Harness

Usage:
  npm run eval:curation -- [report] [options]     score a dataset -> report
  npm run eval:curation -- snapshot [options]     pull LangSmith runs -> dataset file

Report options:
  --dataset <path|label>   dataset file, or label under evals/curation/datasets/
                           (default: newest dataset; bundled fixture if none exist)
  --judge <cached|grok|off>  cached = use stored verdicts only (offline, default)
                             grok   = call the judge model for uncached picks
                             off    = structural metrics only
  --save-baseline <name>   write this report to evals/curation/baselines/<name>.json
  --baseline <name|path>   compare against a saved baseline
  --json                   machine-readable output
  --out <path>             also write the report JSON to a file

Snapshot options:
  --label <name>           dataset label (required), file: evals/curation/datasets/<label>.json
  --last <n>               number of recent curation runs to pull (default 25)
  --days <n>               only runs newer than n days (optional)
  --project <name>         LangSmith project (default: $LANGSMITH_PROJECT or ${DEFAULT_PROJECT})

Environment: see header of scripts/eval-curation.mjs or evals/curation/README.md.
`);
}

// Fill process.env from apps/api/.dev.vars for any keys not already set.
// Same dotenv-ish loader as backfill-langsmith-feedback.mjs; never overrides
// a real env var.
function loadDevVars() {
  const path = resolve(__dirname, "..", ".dev.vars");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // no .dev.vars — rely entirely on process.env
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] != null) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

function parseArgs(argv) {
  const args = {
    command: "report",
    dataset: null,
    judge: "cached",
    saveBaseline: null,
    baseline: null,
    json: false,
    out: null,
    label: null,
    last: 25,
    days: null,
    project: null,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dataset") args.dataset = argv[++i] ?? null;
    else if (a === "--judge") args.judge = argv[++i] ?? "cached";
    else if (a === "--save-baseline") args.saveBaseline = argv[++i] ?? null;
    else if (a === "--baseline") args.baseline = argv[++i] ?? null;
    else if (a === "--json") args.json = true;
    else if (a === "--out") args.out = argv[++i] ?? null;
    else if (a === "--label") args.label = argv[++i] ?? null;
    else if (a === "--last") args.last = Number(argv[++i] ?? 25);
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--project") args.project = argv[++i] ?? null;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("--")) positional.push(a);
    else throw new Error(`Unknown option: ${a} (run with --help)`);
  }
  if (positional.length > 0) args.command = positional[0];
  if (!["report", "snapshot"].includes(args.command)) {
    throw new Error(`Unknown command: ${args.command} (expected "report" or "snapshot")`);
  }
  if (!["cached", "grok", "off"].includes(args.judge)) {
    throw new Error(`Invalid --judge value: ${args.judge} (expected cached, grok, or off)`);
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function tryReadJson(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// snapshot: LangSmith -> dataset file
// ---------------------------------------------------------------------------

async function commandSnapshot(args) {
  if (!process.env.LANGSMITH_API_KEY) {
    console.error(
      "LANGSMITH_API_KEY is not set.\n\n" +
        "Snapshotting pulls `polymarket-curation` traces from LangSmith and needs an API key.\n" +
        "Export it (or add it to apps/api/.dev.vars):\n" +
        "  LANGSMITH_API_KEY=lsv2_... npm run eval:curation -- snapshot --label my-label\n\n" +
        "Org-scoped keys also need LANGSMITH_WORKSPACE_ID. EU accounts: set LANGSMITH_ENDPOINT.\n" +
        "No key? The harness still runs against fixtures: npm run eval:curation",
    );
    process.exitCode = 1;
    return;
  }
  if (!args.label || !/^[A-Za-z0-9._-]+$/.test(args.label)) {
    console.error(
      'snapshot requires --label <name> (letters/digits/._- only), e.g. --label pre-parse-fix',
    );
    process.exitCode = 1;
    return;
  }

  const { Client } = await import("langsmith");
  const client = new Client({
    apiKey: process.env.LANGSMITH_API_KEY,
    apiUrl: process.env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com",
    workspaceId: process.env.LANGSMITH_WORKSPACE_ID,
  });
  const project = args.project ?? process.env.LANGSMITH_PROJECT ?? DEFAULT_PROJECT;

  console.log(`Pulling last ${args.last} polymarket-curation runs from project "${project}"...`);
  const listParams = {
    projectName: project,
    filter: 'eq(name, "polymarket-curation")',
    isRoot: true,
    limit: Math.max(1, args.last),
  };
  if (args.days && Number.isFinite(args.days)) {
    listParams.startTime = new Date(Date.now() - args.days * 86_400_000);
  }

  const parents = [];
  for await (const run of client.listRuns(listParams)) {
    parents.push(run);
    if (parents.length >= args.last) break;
  }
  if (parents.length === 0) {
    console.error(
      `No polymarket-curation runs found in project "${project}". ` +
        "Check LANGSMITH_PROJECT and that tracing is enabled in the Worker.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Found ${parents.length} run(s); fetching grok.score children...`);

  const runs = [];
  for (const parent of parents) {
    let child = null;
    try {
      for await (const c of client.listRuns({
        projectName: project,
        traceId: parent.trace_id ?? parent.id,
        filter: 'eq(name, "grok.score")',
        limit: 1,
      })) {
        child = c;
        break;
      }
    } catch (err) {
      console.warn(`  warn: child fetch failed for run ${parent.id}: ${err?.message ?? err}`);
    }
    const normalized = normalizeLangsmithRun(parent, child);
    if (!child) {
      console.warn(
        `  warn: run ${parent.id} has no grok.score child — candidate pool/profile unavailable`,
      );
    }
    runs.push(normalized);
  }

  await enrichEventIds(runs);

  const dataset = {
    label: args.label,
    created_at: new Date().toISOString(),
    source: "langsmith",
    project,
    runs,
  };
  mkdirSync(DATASETS_DIR, { recursive: true });
  const outPath = resolve(DATASETS_DIR, `${args.label}.json`);
  writeFileSync(outPath, JSON.stringify(dataset, null, 2) + "\n");

  const fallbacks = runs.filter(isFallbackRun).length;
  console.log(
    `\nWrote ${runs.length} run(s) (${fallbacks} fallback/errored) to ${outPath}\n` +
      `Next: npm run eval:curation -- --dataset ${args.label} --judge grok --save-baseline ${args.label}`,
  );
}

// Best-effort event_id enrichment from the polymarket_markets table so the
// per-event duplication metric works. Skipped (with a note) without Supabase
// creds — traces alone don't carry event ids.
async function enrichEventIds(runs) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.log(
      "  note: SUPABASE_URL/SUPABASE_SERVICE_KEY not set — skipping event_id enrichment " +
        "(per-event duplication will report n/a)",
    );
    return;
  }
  const allIds = [
    ...new Set(runs.flatMap((r) => r.candidates.map((c) => c.condition_id))),
  ];
  if (allIds.length === 0) return;

  const { createClient } = await import("@supabase/supabase-js");
  const supa = createClient(url, key);
  const eventById = new Map();
  for (let i = 0; i < allIds.length; i += 100) {
    const chunk = allIds.slice(i, i + 100);
    const { data, error } = await supa
      .from("polymarket_markets")
      .select("condition_id,event_id,event_title")
      .in("condition_id", chunk);
    if (error) {
      console.warn(`  warn: event enrichment query failed: ${error.message}`);
      return;
    }
    for (const row of data ?? []) {
      if (row.event_id) eventById.set(row.condition_id, row);
    }
  }
  let enriched = 0;
  for (const run of runs) {
    for (const cand of run.candidates) {
      const row = eventById.get(cand.condition_id);
      if (row) {
        cand.event_id = row.event_id;
        cand.event_title = row.event_title ?? undefined;
        enriched += 1;
      }
    }
  }
  console.log(`  enriched event_id on ${enriched} candidate rows (${eventById.size} markets matched)`);
}

// ---------------------------------------------------------------------------
// report: dataset -> metrics (+ judge, + baseline compare)
// ---------------------------------------------------------------------------

function resolveDataset(datasetArg) {
  if (datasetArg) {
    const candidates = [
      datasetArg,
      resolve(process.cwd(), datasetArg),
      resolve(DATASETS_DIR, `${datasetArg}.json`),
      resolve(DATASETS_DIR, datasetArg),
    ];
    for (const path of candidates) {
      try {
        if (statSync(path).isFile()) return { path, isFixture: false };
      } catch {
        // try next
      }
    }
    throw new Error(
      `Dataset not found: ${datasetArg} (looked for a file path and under evals/curation/datasets/)`,
    );
  }

  // No --dataset: newest snapshot under datasets/, else the bundled fixture.
  let newest = null;
  try {
    for (const name of readdirSync(DATASETS_DIR)) {
      if (!name.endsWith(".json")) continue;
      const path = resolve(DATASETS_DIR, name);
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    }
  } catch {
    // datasets/ doesn't exist yet
  }
  if (newest) return { path: newest.path, isFixture: false };
  return { path: FIXTURE_DATASET, isFixture: true };
}

function loadJudgeCaches() {
  // Bundled fixture verdicts (read-only) + local cache (read/write), keyed by
  // sha256(rubric|profile|question|reason) — see eval-curation-lib.mjs.
  const cache = new Map();
  for (const source of [tryReadJson(FIXTURE_JUDGMENTS), tryReadJson(JUDGE_CACHE_FILE)]) {
    if (source && typeof source.verdicts === "object" && source.verdicts !== null) {
      for (const [k, v] of Object.entries(source.verdicts)) cache.set(k, v);
    }
  }
  return cache;
}

async function callJudge({ system, user }) {
  const apiKey =
    process.env.EVAL_JUDGE_API_KEY ??
    process.env.GROK_MAIN_API_KEY ??
    process.env.GROK_SUB_API_KEY ??
    process.env.GROK_NORMALIZATION_API_KEY;
  if (!apiKey) {
    throw new Error(
      "--judge grok needs a judge API key: set EVAL_JUDGE_API_KEY or GROK_MAIN_API_KEY " +
        "(or GROK_SUB_API_KEY / GROK_NORMALIZATION_API_KEY) in env or apps/api/.dev.vars",
    );
  }
  const base = (process.env.GROK_API_BASE_URL || "https://api.x.ai/v1").replace(/\/$/, "");
  const model = process.env.EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Judge API error (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function runJudge(dataset, mode) {
  const stats = { mode, judged: 0, unjudged: 0, relevant: 0, cache_hits: 0, api_calls: 0 };
  if (mode === "off") {
    return { verdictFor: () => null, stats, newVerdicts: null };
  }

  const cache = loadJudgeCaches();
  const newVerdicts = {};
  const verdicts = new Map();

  for (const run of dataset.runs) {
    if (isFallbackRun(run)) continue;
    const questionById = new Map(run.candidates.map((c) => [c.condition_id, c.question]));
    for (const pick of run.picks) {
      // Never judge (or cache a verdict for) content we don't have — see
      // isJudgeablePick. computeJudgeMetrics counts these as unjudgeable.
      if (!isJudgeablePick(run, pick)) continue;
      const question = questionById.get(pick.condition_id) ?? null;
      const key = judgeCacheKey({
        profileSummary: run.profile_summary,
        question,
        reason: pick.reason,
      });
      if (verdicts.has(key)) continue;

      const cached = cache.get(key);
      if (cached && typeof cached.relevant === "boolean") {
        verdicts.set(key, cached);
        stats.cache_hits += 1;
        continue;
      }
      if (mode !== "grok") continue; // cached-only mode: leave unjudged

      const prompt = buildJudgePrompt({
        profileSummary: run.profile_summary,
        question,
        reason: pick.reason,
      });
      const raw = await callJudge(prompt);
      stats.api_calls += 1;
      const verdict = parseJudgeResponse(raw);
      if (verdict) {
        verdicts.set(key, verdict);
        newVerdicts[key] = {
          ...verdict,
          question,
          judged_at: new Date().toISOString(),
          model: process.env.EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL,
        };
      } else {
        console.warn(`  warn: unparseable judge response for pick ${pick.condition_id}`);
      }
    }
  }

  const verdictFor = (run, pick) => {
    const questionById = new Map(run.candidates.map((c) => [c.condition_id, c.question]));
    const key = judgeCacheKey({
      profileSummary: run.profile_summary,
      question: questionById.get(pick.condition_id) ?? null,
      reason: pick.reason,
    });
    return verdicts.get(key) ?? null;
  };

  return { verdictFor, stats, newVerdicts };
}

function resolveBaseline(baselineArg) {
  const candidates = [
    baselineArg,
    resolve(process.cwd(), baselineArg),
    resolve(BASELINES_DIR, `${baselineArg}.json`),
  ];
  for (const path of candidates) {
    const parsed = tryReadJson(path);
    if (parsed?.metrics) return parsed;
  }
  throw new Error(
    `Baseline not found: ${baselineArg} (looked for a file path and under evals/curation/baselines/)`,
  );
}

async function commandReport(args) {
  const { formatReport } = await import("./eval-curation-lib.mjs");
  const { path: datasetPath, isFixture } = resolveDataset(args.dataset);
  const dataset = readJson(datasetPath);
  if (!Array.isArray(dataset.runs)) {
    throw new Error(`Malformed dataset (no runs[]): ${datasetPath}`);
  }
  if (isFixture && !args.json) {
    console.log(
      "No snapshots under evals/curation/datasets/ — reporting on the bundled fixture dataset.\n" +
        "Pull real runs with: npm run eval:curation -- snapshot --label <name>\n",
    );
  }

  const runMetrics = dataset.runs.map(computeRunMetrics);
  const metrics = aggregateMetrics(runMetrics);

  const { verdictFor, stats, newVerdicts } = await runJudge(dataset, args.judge);
  let judge = { ...stats, precision: null, mean_run_precision: null, per_run: [] };
  if (args.judge !== "off") {
    const judgeMetrics = computeJudgeMetrics(dataset, verdictFor);
    judge = { ...stats, ...judgeMetrics };
  }

  // Persist any freshly judged verdicts so re-runs are free + deterministic.
  if (newVerdicts && Object.keys(newVerdicts).length > 0) {
    mkdirSync(JUDGMENTS_DIR, { recursive: true });
    const existing = tryReadJson(JUDGE_CACHE_FILE) ?? { verdicts: {} };
    existing.verdicts = { ...existing.verdicts, ...newVerdicts };
    writeFileSync(JUDGE_CACHE_FILE, JSON.stringify(existing, null, 2) + "\n");
  }

  const report = {
    generated_at: new Date().toISOString(),
    dataset: {
      label: dataset.label ?? "unlabeled",
      source: dataset.source ?? "unknown",
      path: datasetPath,
      created_at: dataset.created_at ?? null,
    },
    metrics,
    judge,
    per_run: runMetrics,
  };

  const baseline = args.baseline ? resolveBaseline(args.baseline) : null;

  if (args.saveBaseline) {
    if (!/^[A-Za-z0-9._-]+$/.test(args.saveBaseline)) {
      throw new Error("--save-baseline name may only contain letters/digits/._-");
    }
    mkdirSync(BASELINES_DIR, { recursive: true });
    const baselinePath = resolve(BASELINES_DIR, `${args.saveBaseline}.json`);
    // Baselines are meant to be committed, so keep them aggregate-only: no
    // per_run rows (portfolio/run ids), no judge.per_run, no local dataset
    // path. Everything the --baseline comparison reads is here.
    const baseline = {
      baseline_label: args.saveBaseline,
      generated_at: report.generated_at,
      dataset: {
        label: report.dataset.label,
        source: report.dataset.source,
        created_at: report.dataset.created_at,
      },
      metrics: report.metrics,
      judge: {
        mode: judge.mode,
        judged: judge.judged,
        unjudged: judge.unjudged,
        unjudgeable: judge.unjudgeable ?? 0,
        relevant: judge.relevant,
        precision: judge.precision,
        mean_run_precision: judge.mean_run_precision,
      },
    };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
    if (!args.json) console.log(`Saved baseline: ${baselinePath}`);
  }

  if (args.out) {
    writeFileSync(resolve(process.cwd(), args.out), JSON.stringify(report, null, 2) + "\n");
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report, baseline));
    if (judge.unjudged > 0 && args.judge === "cached") {
      console.log(
        `Tip: ${judge.unjudged} pick(s) have no cached verdict — run with --judge grok (needs a Grok API key) to judge them.\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  loadDevVars();
  if (args.command === "snapshot") await commandSnapshot(args);
  else await commandReport(args);
}

main().catch((error) => {
  console.error("Eval failed:", error.message);
  process.exit(1);
});
