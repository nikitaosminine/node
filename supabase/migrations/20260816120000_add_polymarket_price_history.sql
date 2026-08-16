-- ============================================================
-- Polymarket Price History
-- Append-only snapshot of polymarket_markets.outcome_prices,
-- one row per active market per fanout run, so probability
-- movement over time can be reconstructed (storage only — no
-- read-path/UI changes in this migration).
--
-- Retention: rows older than the worker's retention window
-- (PRICE_HISTORY_RETENTION_DAYS, currently 90 days, see
-- apps/api/src/feeds/polymarket.ts) are swept on every fanout
-- run, mirroring the news_clusters expiry sweep in
-- 20260520195025_add_news_and_polymarket_feed.sql. A fixed
-- window bounds table growth without needing downsampling.
--
-- Deploy-order note: apply this migration BEFORE deploying the
-- Worker version that writes to it — the fanout insert will
-- fail (and be caught/logged, not fatal to the run) if the
-- table doesn't exist yet.
-- ============================================================

create table if not exists public.polymarket_price_history (
  id              uuid primary key default gen_random_uuid(),
  condition_id    text not null references public.polymarket_markets(condition_id) on delete cascade,
  outcome_prices  jsonb not null default '[]'::jsonb,
  -- float array, same ordering as polymarket_markets.outcomes at snapshot time
  volume_24hr     numeric(18, 6),
  -- null for closed or inactive markets, matches polymarket_markets
  snapshotted_at  timestamptz not null default now()
);

create index if not exists polymarket_price_history_condition_snapshotted_idx
  on public.polymarket_price_history (condition_id, snapshotted_at desc);

alter table public.polymarket_price_history enable row level security;

drop policy if exists "Authenticated users can read polymarket price history"
  on public.polymarket_price_history;
create policy "Authenticated users can read polymarket price history"
  on public.polymarket_price_history for select
  to authenticated
  using (true);

drop policy if exists "Service role can manage polymarket price history"
  on public.polymarket_price_history;
create policy "Service role can manage polymarket price history"
  on public.polymarket_price_history for all
  to service_role
  using (true)
  with check (true);
