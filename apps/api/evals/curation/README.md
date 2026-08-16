# Polymarket curation quality evals

A measuring stick for the Polymarket curation pipeline (`src/feeds/polymarket.ts`):
snapshot recent `polymarket-curation` LangSmith traces into a local dataset, score
pick precision and diversity, and compare against a saved baseline — so parsing and
prompt changes ship with a before/after number instead of vibes.

Local / CI-manual only. Nothing here runs in the Worker or touches production paths.

## Quick start

```bash
cd apps/api

# Report on the bundled fixture dataset (fully offline, no secrets needed):
npm run eval:curation

# Pull the last 25 real curation runs from LangSmith into a labeled dataset:
LANGSMITH_API_KEY=lsv2_... npm run eval:curation -- snapshot --label pre-parse-fix --last 25

# Score it, judging relevance with Grok, and record it as the baseline:
npm run eval:curation -- --dataset pre-parse-fix --judge grok --save-baseline pre-parse-fix

# ... merge the parsing/prompt change, wait for fanout runs, snapshot again ...
LANGSMITH_API_KEY=lsv2_... npm run eval:curation -- snapshot --label post-parse-fix

# Before/after:
npm run eval:curation -- --dataset post-parse-fix --judge grok --baseline pre-parse-fix
```

`--help` lists all flags. Everything under `datasets/` and `judgments/` is
gitignored (real snapshots carry portfolio/user ids and holdings profiles);
`fixtures/` and `baselines/` (aggregate numbers only) are committed.

## Environment

All keys auto-load from `apps/api/.dev.vars` when not exported.

| Variable | Needed for | Notes |
|---|---|---|
| `LANGSMITH_API_KEY` | `snapshot` | The script fails with a clear message when absent. Fixture reports never need it. |
| `LANGSMITH_PROJECT` | `snapshot` | Trace project; defaults to `node-polymarket` (same default as the Worker). |
| `LANGSMITH_WORKSPACE_ID` | `snapshot` | Only for org-scoped keys (sent as x-tenant-id). |
| `LANGSMITH_ENDPOINT` | `snapshot` | Only for EU-region accounts. |
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | `snapshot` (optional) | Enriches candidates with `event_id` from `polymarket_markets` so the per-event duplication metric works. Without them the report shows `n/a` for event diversity. |
| `GROK_MAIN_API_KEY` (or `EVAL_JUDGE_API_KEY` / `GROK_SUB_API_KEY` / `GROK_NORMALIZATION_API_KEY`) | `--judge grok` | Judge verdicts are cached in `judgments/cache.json`, so re-runs on the same dataset make zero API calls. |
| `EVAL_JUDGE_MODEL` | `--judge grok` (optional) | Defaults to `grok-4.6`. |

## How it works

1. **snapshot** — pulls root `polymarket-curation` runs (portfolio/user attribution +
   the picks written by the Worker) and each run's `grok.score` child (the exact
   system/user prompt the model saw). The user prompt is parsed back into the
   portfolio profile summary and the candidate pool, so the dataset file is a
   self-contained record of *what the model saw* and *what it picked*.
2. **report** — computes structural metrics from the dataset, plus an LLM-judge
   relevance pass over every pick. Judge verdicts are content-addressed
   (sha256 of rubric version + profile + question + reason), so a verdict is only
   ever bought once, and the same picks always score the same.

## Metrics — what each number means

A **fallback run** is one where curation produced no usable picks (Grok error or
zero valid rows); in production the Worker then writes volume-sorted rows with
`score=0, reason=null` instead of curated picks. Fallback runs are excluded from
pick-level metrics and reported as a rate.

| Metric | Definition | Good direction |
|---|---|---|
| **Fallback-run rate** | fallback runs / all runs. The headline reliability number — parsing bugs (e.g. Grok's JSON not extracted) show up here first. | ↓ lower |
| **Avg picks / scored run** | picks per non-fallback run. Target is ≤16 (`ROTATING_TOP_K`); a collapse toward 0–3 means the model is over-filtering or output parsing is dropping rows. | context |
| **Score mean / p50 / histogram** | distribution of Grok's self-reported relevance scores across all picks. Watch for drift (e.g. everything clustering at 0.85 after a prompt change means the score lost resolution). | context |
| **Picks below 0.35** | share of picks violating the prompt's own floor ("only include markets with score >= 0.35"). Pure instruction-following measure. | ↓ lower |
| **Invalid-id picks** | picks whose `condition_id` was not in the candidate pool sent to the model (hallucinated ids). The Worker filters these out, so they cost slots silently. | ↓ lower |
| **Duplicate picks** | same `condition_id` picked twice in one run. | ↓ lower |
| **Missing reasons** | picks with an empty `reason`. Reasons render in the feed UI, so empties are user-visible. | ↓ lower |
| **Reason-anchored rate** | share of non-empty reasons that name at least one ticker/ETF from the portfolio profile (regex over ticker-ish tokens). Cheap proxy for "the reason cites a specific holding, not generic macro". | ↑ higher |
| **Non-financial leak rate** | picks whose question matches `NON_FINANCIAL_RE` (sports / entertainment / individual candidacies — the same regex the Worker uses as a pre-filter). These should be ~0; any leak means the prompt's reject rules failed. | ↓ lower |
| **Unique-event ratio** | unique Polymarket events / picks, averaged over runs with event data. 100% = maximal diversity. Requires `event_id` enrichment at snapshot time. | ↑ higher |
| **Runs breaking 2-per-event cap** | share of runs where >2 picks share one event, violating the prompt's diversity instruction (server-side dedup later collapses them, so violations silently waste pick slots). | ↓ lower |
| **Judge relevance precision** | LLM-judge verdicts: relevant picks / judged picks. The judge gets the profile, the market question, and the model's stated reason, and must name a concrete financial mechanism to say "relevant" (rubric in `scripts/eval-curation-lib.mjs:buildJudgePrompt`; geography-overlap, sports, candidacies, and bare "macro uncertainty" are defined as not relevant). **This is the headline quality number.** | ↑ higher |
| **Mean per-run precision** | precision computed per run, then averaged — keeps one pick-heavy run from dominating the aggregate. | ↑ higher |

### Comparing runs

- Compare like with like: same `--judge` mode, and ideally similar run counts and
  portfolio mix (`snapshot --last N` over the same N).
- The judge cache makes precision deterministic per (rubric, profile, question,
  reason) tuple; bumping `JUDGE_RUBRIC_VERSION` in `eval-curation-lib.mjs`
  invalidates all cached verdicts on purpose — never compare precision numbers
  across rubric versions.
- `--baseline <name>` prints deltas with ✅/⚠️ markers based on each metric's
  good direction (table above).

### Recording a baseline before a change merges

```bash
LANGSMITH_API_KEY=... npm run eval:curation -- snapshot --label pre-<change>
npm run eval:curation -- --dataset pre-<change> --judge grok --save-baseline pre-<change>
git add evals/curation/baselines/pre-<change>.json   # baseline = aggregate numbers only, safe to commit
```

After the change is deployed and a few fanouts have run, snapshot `post-<change>`
and report with `--baseline pre-<change>`.

## Fixtures

`fixtures/fixture-dataset.json` is a hand-built dataset with known-good numbers:
a healthy run, a run planted with every failure mode the metrics catch, a
zero-result fallback, and an errored trace. `fixtures/fixture-judgments.json` is
the matching pre-recorded judge cache, so `npm run eval:curation` works with no
network and no secrets. Expected values are asserted in
`scripts/eval-curation-lib.test.mjs` (runs with `npm test`).

If you edit fixture picks/profiles, regenerate the judgment keys:

```bash
node scripts/generate-curation-fixture-judgments.mjs
```
