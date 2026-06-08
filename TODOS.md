# TODOS

Work captured during engineering reviews. Each item is deferred — not in scope for the PR that surfaced it.

---

## Eval loop: feedback → prompt iteration
**Branch context:** tracing-and-evals

**What:** Query recaps with low per-slide scores, correlate with their LangSmith run (via `recaps.langsmith_run_id`), replay specific runs with updated prompts in LangSmith's playground, and measure improvement.

**Why:** The `recap_slide_feedback` table and `langsmith_run_id` FK are designed for exactly this. Without the eval loop, feedback data accumulates but nothing closes the improvement cycle.

**Depends on:** Part 1 shipped and at least 2 weeks of feedback data collected. Part 2 (Polymarket/Grok tracing) also useful before building this.

**Where to start:** `supabase/` — query `recap_slide_feedback JOIN recaps ON recap_id` grouped by slide_index and score. Filter runs where avg(score) < 0. Pull `langsmith_run_id` and open those runs in LangSmith.

---

## Test framework setup
**Branch context:** tracing-and-evals

**What:** Add Vitest to `apps/api` (using `@cloudflare/vitest-pool-workers` for CF Workers compatibility) and Jest or Vitest to `apps/web`.

**Why:** No test framework exists in either app. The new feedback endpoint, traceable wrappers, and upsert logic are the natural first test targets. Without tests, regressions in the auth model or upsert semantics are invisible until production.

**Where to start:** `apps/api` — `@cloudflare/vitest-pool-workers` docs. First tests: `POST /api/recaps/:id/feedback` auth checks (401, 403, 404) and upsert behavior (insert + re-vote).

---

## Part 2: Polymarket / Grok tracing
**Branch context:** tracing-and-evals

**What:** Reuse the `langsmithClient()` factory + `withRunTree`/`traceable` pattern from `apps/api/src/feeds/recaps.ts` to trace the Polymarket curation and geography enrichment LLM calls (Grok).

**Why:** Part 1 established the infrastructure (langsmith dep, client factory, secrets). Part 2 is purely applying the same pattern to the other queue consumers.

**Where to start:** `apps/api/src/feeds/` (polymarket + geography consumers). Same shape: create a RunTree, wrap the Grok calls with `traceable`, run the body inside `withRunTree`.
