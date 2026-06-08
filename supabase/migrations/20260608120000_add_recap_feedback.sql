-- ============================================================
-- Recap feedback + LangSmith tracing columns
--
-- Two changes:
--  1. recaps gains two nullable text columns:
--       feedback_token   — presigned LangSmith URL for the overall
--                          recap signal (NULL when LangSmith is not
--                          configured or token generation failed).
--       langsmith_run_id — the run that produced this recap, so
--                          recap_slide_feedback rows can be correlated
--                          back to a specific trace during evals.
--  2. recap_slide_feedback — per-slide thumbs up/down + optional
--     comment. One row per (recap, user, slide); re-voting upserts
--     (last vote wins) via the unique constraint below.
--
-- Feedback is per-slide (not per-recap): each slide is a distinct
-- LLM output, so granular feedback pinpoints which slide regressed.
-- Supabase is the source of truth; LangSmith receives the overall
-- signal via the presigned token. See the tracing-and-evals design.
-- ============================================================

alter table public.recaps
  add column if not exists feedback_token   text,
  add column if not exists langsmith_run_id text;

create table if not exists public.recap_slide_feedback (
  id            uuid primary key default gen_random_uuid(),
  recap_id      uuid not null references public.recaps(id) on delete cascade,
  portfolio_id  uuid not null references public.portfolios(id) on delete cascade,
  -- denormalized from recaps for RLS / analytics without an extra join
  user_id       uuid not null,
  -- always set from getAuthenticatedUserId() — never from the recap row
  -- or the request body (see API auth model in CLAUDE.md)
  slide_index   smallint not null check (slide_index >= 0),
  score         smallint not null check (score in (1, -1)),
  -- 1 = thumbs up, -1 = thumbs down
  comment       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (recap_id, user_id, slide_index)
);

-- The unique constraint's index (recap_id, user_id, slide_index) also
-- serves the recap_id FK and the GET /api/recaps lookup
-- (WHERE recap_id = $id AND user_id = $uid). portfolio_id needs its own
-- index to satisfy the unindexed-FK advisor.
create index if not exists recap_slide_feedback_portfolio_idx
  on public.recap_slide_feedback (portfolio_id);

alter table public.recap_slide_feedback enable row level security;

-- Users can read only their own feedback. Writes go through the
-- service-role worker (POST /api/recaps/:id/feedback), which verifies
-- portfolio ownership before writing — matching the recaps table.
drop policy if exists "Users can view their own slide feedback"
  on public.recap_slide_feedback;
create policy "Users can view their own slide feedback"
  on public.recap_slide_feedback for select
  using (user_id = auth.uid());

drop policy if exists "Service role can manage slide feedback"
  on public.recap_slide_feedback;
create policy "Service role can manage slide feedback"
  on public.recap_slide_feedback for all
  to service_role
  using (true)
  with check (true);

drop trigger if exists update_recap_slide_feedback_updated_at
  on public.recap_slide_feedback;
create trigger update_recap_slide_feedback_updated_at
  before update on public.recap_slide_feedback
  for each row execute function public.update_updated_at_column();
