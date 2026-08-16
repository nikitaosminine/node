#!/usr/bin/env node
// ============================================================
// Regenerates evals/curation/fixtures/fixture-judgments.json from
// fixture-dataset.json + the hand-labeled verdict table below.
//
// The judge cache is keyed by sha256(rubric|profile|question|reason)
// (eval-curation-lib.mjs:judgeCacheKey), so any edit to a fixture pick's
// profile/question/reason — or a JUDGE_RUBRIC_VERSION bump — changes the key.
// Run this after such edits:
//   node apps/api/scripts/generate-curation-fixture-judgments.mjs
// ============================================================

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JUDGE_RUBRIC_VERSION, judgeCacheKey } from "./eval-curation-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "..", "evals", "curation", "fixtures");

// Ground-truth labels per (run_id suffix, condition_id). These encode what a
// correct judge SHOULD say, so the fixture report has known-good numbers
// (asserted in eval-curation-lib.test.mjs).
const LABELS = {
  a: {
    "0xfed0": { relevant: true, mechanism: "Rate path reprices NASDAQ-100 growth stocks held via PUST.PA." },
    "0xtar1": { relevant: true, mechanism: "China chip tariffs hit NVDA revenue directly." },
    "0xexp1": { relevant: true, mechanism: "EUV servicing export controls directly affect ASML, a direct holding." },
    "0xtsm1": { relevant: true, mechanism: "TSMC earnings move NVDA and the held semiconductor chain." },
    "0xair1": { relevant: true, mechanism: "EU AI fines would hit MSFT and PUST.PA AI names." },
    "0xrec1": { relevant: true, mechanism: "US recession compresses NASDAQ-100 earnings held via PUST.PA." },
    "0xgdp1": { relevant: true, mechanism: "US growth drives earnings of US tech holdings NVDA/MSFT." },
    "0xoil1": { relevant: false, mechanism: "No named mechanism to the tech holdings — generic input-cost/demand hand-wave." },
  },
  b: {
    "0xfed0": { relevant: true, mechanism: "US rates drive USD/JPY, repricing PTPXH.PA exporters." },
    "0xfed2": { relevant: true, mechanism: "Cuts weaken USD/JPY, hitting Toyota/Sony export earnings." },
    "0xfed4": { relevant: true, mechanism: "Aggressive cuts weaken the dollar vs yen, hitting Topix exporters." },
    "0xucl1": { relevant: false, mechanism: "Geographic overlap only — a football result moves no held asset." },
    "0xoil1": { relevant: false, mechanism: "No reason given and no direct link to Japan/EM Asia industrials stated." },
    "0xrec1": { relevant: false, mechanism: "Generic macro uncertainty with no named mechanism." },
    "0xdeadbeef": { relevant: false, mechanism: "Market not in the candidate pool — hallucinated pick." },
  },
};

const dataset = JSON.parse(readFileSync(resolve(FIXTURES_DIR, "fixture-dataset.json"), "utf8"));

const verdicts = {};
let labeled = 0;
for (const run of dataset.runs) {
  const suffix = run.run_id.slice(-1);
  const labels = LABELS[suffix];
  if (!labels) continue;
  const questionById = new Map(run.candidates.map((c) => [c.condition_id, c.question]));
  for (const pick of run.picks) {
    const label = labels[pick.condition_id];
    if (!label) {
      throw new Error(`No label for run ${run.run_id} pick ${pick.condition_id} — add one to LABELS`);
    }
    const question = questionById.get(pick.condition_id) ?? null;
    const key = judgeCacheKey({
      profileSummary: run.profile_summary,
      question,
      reason: pick.reason,
    });
    verdicts[key] = { ...label, question, model: "fixture-ground-truth" };
    labeled += 1;
  }
}

const outPath = resolve(FIXTURES_DIR, "fixture-judgments.json");
writeFileSync(
  outPath,
  JSON.stringify({ rubric_version: JUDGE_RUBRIC_VERSION, verdicts }, null, 2) + "\n",
);
console.log(`Wrote ${labeled} fixture verdicts to ${outPath}`);
