alter table public.polymarket_markets
  add column if not exists start_date timestamptz;
