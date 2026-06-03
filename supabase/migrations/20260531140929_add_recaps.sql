-- ============================================================
-- Recaps
-- Spotify-Wrapped-style 4-slide stories about what happened to
-- a portfolio and the markets that moved it. One row per
-- (portfolio, type, period_end) — the unique constraint is the
-- idempotency key (same pattern as agent_runs.idempotency_key).
--
-- Daily recaps are produced by the snapshot consumer AFTER it
-- commits today's portfolio_snapshots row (chained, not raced).
-- Weekly recaps are produced by the Saturday-08:00 cron fanout,
-- reading Friday's already-committed snapshot.
--
-- The LLM (Gemini) writes prose only; every figure in `slides`
-- is computed deterministically and injected. See plan §4a.
-- ============================================================

create table if not exists public.recaps (
  id            uuid primary key default gen_random_uuid(),
  portfolio_id  uuid not null references public.portfolios(id) on delete cascade,
  user_id       uuid not null,
  -- denormalized from portfolios.user_id for fanout + RLS without a join
  type          text not null check (type in ('daily', 'weekly')),
  period_start  date not null,
  period_end    date not null,
  -- daily: the close date; weekly: the Friday of the covered week
  status        text not null default 'queued'
                  check (status in ('queued', 'running', 'ready', 'failed', 'skipped')),
  slides        jsonb not null default '[]'::jsonb,
  -- SlideSpec[]: see packages/shared recap types. Numbers live in
  -- structured stat/chart fields, never parsed from prose.
  model         text,
  -- e.g. 'gemini-3.5-flash'
  token_usage   jsonb not null default '{}'::jsonb,
  error         text,
  generated_at  timestamptz,
  seen_at       timestamptz,
  -- set when the user first opens the recap (drives the "new" dot)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (portfolio_id, type, period_end)
);

create index if not exists recaps_portfolio_type_period_idx
  on public.recaps (portfolio_id, type, period_end desc);

create index if not exists recaps_status_created_idx
  on public.recaps (status, created_at);

alter table public.recaps enable row level security;

-- Users can read recaps of portfolios they own (mirrors
-- portfolio_news_matches). Writes are service-role only — recaps
-- are produced by the worker, never by the client.
drop policy if exists "Users can view recaps of their portfolios"
  on public.recaps;
create policy "Users can view recaps of their portfolios"
  on public.recaps for select
  using (
    exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = auth.uid()
    )
  );

-- Writes (insert/update incl. seen_at) are service-role only — the
-- POST /api/recaps/:id/seen endpoint verifies ownership then writes
-- via the service client, matching the rest of the app.
drop policy if exists "Service role can manage recaps"
  on public.recaps;
create policy "Service role can manage recaps"
  on public.recaps for all
  to service_role
  using (true)
  with check (true);

drop trigger if exists update_recaps_updated_at on public.recaps;
create trigger update_recaps_updated_at
  before update on public.recaps
  for each row execute function public.update_updated_at_column();
