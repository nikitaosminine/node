alter table public.portfolio_snapshots
  add column if not exists twr_pct numeric default 0;
