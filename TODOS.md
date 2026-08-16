# TODOS

Work captured during engineering reviews. Each item is deferred — not in scope for the PR that surfaced it.

---

## Eval loop: feedback → prompt iteration
**Branch context:** tracing-and-evals

**What:** Query recaps with low per-slide scores, correlate with their LangSmith run (via `recaps.langsmith_run_id`), replay specific runs with updated prompts in LangSmith's playground, and measure improvement.

**Why:** The `recap_slide_feedback` table and `langsmith_run_id` FK are designed for exactly this. Without the eval loop, feedback data accumulates but nothing closes the improvement cycle.

**Depends on:** Part 1 shipped and at least 2 weeks of feedback data collected.

**Where to start:** `supabase/` — query `recap_slide_feedback JOIN recaps ON recap_id` grouped by slide_index and score. Filter runs where avg(score) < 0. Pull `langsmith_run_id` and open those runs in LangSmith.

---

## Idempotent run-level LangSmith feedback
**Branch context:** tracing-and-evals

**What:** If a recap-level (or slide-level) user score in LangSmith is wanted, post it server-side from `POST /api/recaps/:id/feedback` with a deterministic `feedbackId` (so re-votes update, not append). The per-click presigned-token approach was removed because it appended a new score on every click.

**Why:** Lets you filter/sort runs by sentiment in the LangSmith UI. Not required — Supabase `recap_slide_feedback` is the source of truth and already correlates via `langsmith_run_id`.

**Where to start:** `apps/api/src/index.ts` feedback handler + `langsmithClient()`; use `client.createFeedback(runId, key, { score, feedbackId })`.

---

## Worker-runtime test setup for `apps/api`

**Branch context:** tracing-and-evals

**Web app is done — do not re-propose it.** `apps/web` has had Vitest (jsdom + React Testing
Library) since `c5271ff`, run with `npm test` from `apps/web`, and CI runs that suite in the
`check-web` job on every PR.

**What:** Give `apps/api` a Worker-compatible test setup — `@cloudflare/vitest-pool-workers` plus a
`vitest.config.ts` — and cover the request handlers. Vitest itself is already a devDependency with
a `npm test` script, but there is no config and the existing tests (`src/llm/gemini.test.ts`,
`src/feeds/polymarket.test.ts`, `src/feeds/market-topics.test.ts`, `src/feeds/news.test.ts`) are
pure-helper suites that need no Workers runtime. Once tests exist that are worth gating on, add a
`npm test` step to the `check-api` CI job, which today runs only `npm run typecheck`.

**Why:** The feedback endpoint, traceable wrappers, and upsert logic are the natural first targets.
Without a Workers-runtime harness, regressions in the auth model or upsert semantics are invisible
until production.

**Where to start:** `@cloudflare/vitest-pool-workers` docs. First tests:
`POST /api/recaps/:id/feedback` auth checks (401, 403, 404) and upsert behavior (insert + re-vote).

---

## Geography-queue Grok tracing
**Branch context:** tracing-and-evals

**What:** Apply the same tracing pattern to the geography enrichment Grok call (`invokeGrokWebGeographyResearch` in `apps/api/src/index.ts`).

**Why:** Polymarket curation is now traced (see Completed). Geography is the remaining un-traced LLM call.

**Where to start:** Reuse `llm/langsmith.ts` `langsmithClient()` + `traceable` + `withRunTree`, same shape as `polymarket.ts`.

---

## Completed

- **Part 2: Polymarket / Grok curation tracing** — traced `invokeGrok` + per-portfolio `polymarket-curation` run with portfolio/user attribution. Shipped on `tracing-and-evals` (this PR).
