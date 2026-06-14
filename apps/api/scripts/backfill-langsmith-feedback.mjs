#!/usr/bin/env node
// ============================================================
// Backfill LangSmith feedback from Supabase recap votes.
//
// Per-slide recap votes live in `recap_slide_feedback` (Supabase is the
// source of truth). The Worker pushes each NEW vote to its recap's LangSmith
// trace via createFeedback — but votes cast BEFORE that path went live exist
// only in Supabase. This one-off backfills them.
//
// Idempotent: the feedbackId is the SAME deterministic UUID the Worker uses
// (sha256 of `${runId}:${userId}:${slideIndex}` → UUID), so re-running this,
// or a later manual re-vote, UPDATES the same feedback instead of appending.
// Must match apps/api/src/index.ts:deterministicUuid byte-for-byte.
//
// Only recaps with a non-null langsmith_run_id can be backfilled — older
// recaps generated before tracing was live have no trace to attach to.
//
// Usage (from anywhere; resolves deps from apps/api/node_modules):
//   LANGSMITH_API_KEY=ls__... node apps/api/scripts/backfill-langsmith-feedback.mjs [--recap <id>] [--dry-run]
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   (auto-loaded from apps/api/.dev.vars)
//   LANGSMITH_API_KEY                    (required — Worker secret, export it)
//   LANGSMITH_WORKSPACE_ID               (required only for org-scoped keys)
//   LANGSMITH_ENDPOINT                   (only for EU region accounts)
// ============================================================

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { Client } from "langsmith";

const __dirname = dirname(fileURLToPath(import.meta.url));

function printHelp() {
  console.log(`Backfill LangSmith feedback from Supabase recap votes

Usage:
  LANGSMITH_API_KEY=... node apps/api/scripts/backfill-langsmith-feedback.mjs [options]

Options:
  --recap <uuid>   Backfill only this recap (default: all recaps with a trace)
  --dry-run        List what would be pushed; make no LangSmith writes
  --help, -h       Show this help

Env:
  SUPABASE_URL, SUPABASE_SERVICE_KEY   auto-loaded from apps/api/.dev.vars if unset
  LANGSMITH_API_KEY                    required
  LANGSMITH_WORKSPACE_ID               required for org-scoped keys (x-tenant-id)
  LANGSMITH_ENDPOINT                   only for EU-region accounts
`);
}

// Fill process.env from apps/api/.dev.vars for any keys not already set.
// Wrangler's .dev.vars is KEY=value (dotenv-ish). Never overrides a real env var.
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
  const args = { recap: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--recap") args.recap = argv[++i] ?? null;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

// MUST stay byte-identical to apps/api/src/index.ts:deterministicUuid so the
// feedbackId here collides (idempotently) with the Worker's live writes.
async function deterministicUuid(input) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  const b = digest.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  loadDevVars();

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, LANGSMITH_API_KEY } = process.env;
  const missing = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_KEY) missing.push("SUPABASE_SERVICE_KEY");
  // The LangSmith key is only needed for actual writes — a --dry-run preview
  // (Supabase read + classification only) runs without it.
  if (!LANGSMITH_API_KEY && !args.dryRun) missing.push("LANGSMITH_API_KEY");
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")}`);
    console.error("Run with --help for usage.");
    process.exitCode = 1;
    return;
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  let query = supa
    .from("recap_slide_feedback")
    .select(
      "recap_id, user_id, slide_index, score, comment, " +
        "recaps!inner(langsmith_run_id, type, period_start, period_end)",
    )
    .order("recap_id", { ascending: true })
    .order("slide_index", { ascending: true });
  if (args.recap) query = query.eq("recap_id", args.recap);

  const { data: rows, error } = await query;
  if (error) {
    console.error("Supabase query failed:", error.message);
    process.exitCode = 1;
    return;
  }

  const withTrace = (rows ?? []).filter((r) => r.recaps?.langsmith_run_id);
  const noTrace = (rows ?? []).filter((r) => !r.recaps?.langsmith_run_id);

  console.log(
    `Found ${rows?.length ?? 0} vote(s): ${withTrace.length} on traced recaps, ` +
      `${noTrace.length} on untraced recaps (skipped — no trace to attach to).`,
  );
  if (noTrace.length) {
    const ids = [...new Set(noTrace.map((r) => r.recap_id))];
    console.log(`  Untraced recap ids skipped: ${ids.join(", ")}`);
  }
  if (withTrace.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  const ls = args.dryRun
    ? null
    : new Client({
        apiKey: LANGSMITH_API_KEY,
        apiUrl: process.env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com",
        workspaceId: process.env.LANGSMITH_WORKSPACE_ID,
      });

  let pushed = 0;
  let failed = 0;
  for (const r of withTrace) {
    const runId = r.recaps.langsmith_run_id;
    const key = `slide_${r.slide_index}_score`;
    const tag = `recap ${r.recap_id} slide ${r.slide_index} (${r.recaps.type} ${r.recaps.period_start}→${r.recaps.period_end}) score=${r.score}`;
    if (args.dryRun) {
      console.log(`  [dry-run] would push ${key} to run ${runId} — ${tag}`);
      pushed += 1;
      continue;
    }
    try {
      const feedbackId = await deterministicUuid(
        `${runId}:${r.user_id}:${r.slide_index}`,
      );
      await ls.createFeedback(runId, key, {
        score: r.score,
        comment: r.comment ?? undefined,
        feedbackId,
      });
      pushed += 1;
      console.log(`  pushed ${key} → run ${runId} — ${tag}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAILED ${key} → run ${runId} — ${tag}:`, err?.message ?? err);
    }
  }

  if (!args.dryRun) {
    // Send the batched feedback events before the process exits.
    await ls.flush();
  }

  console.log(
    args.dryRun
      ? `Dry run complete: ${pushed} vote(s) would be pushed.`
      : `Backfill complete: ${pushed} pushed, ${failed} failed.`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Backfill crashed:", err);
  process.exitCode = 1;
});
