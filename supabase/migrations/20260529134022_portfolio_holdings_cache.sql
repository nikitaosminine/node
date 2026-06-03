create table if not exists public.portfolio_holdings_cache (
  portfolio_id uuid not null primary key references public.portfolios(id) on delete cascade,
  holdings_hash text not null,
  profile_text text,
  last_scored_at timestamptz not null default now()
);

alter table public.portfolio_holdings_cache enable row level security;

create policy "owner_select"
  on public.portfolio_holdings_cache for select
  using (portfolio_id in (
    select id from public.portfolios where user_id = (select auth.uid())
  ));

create policy "owner_insert"
  on public.portfolio_holdings_cache for insert
  with check (portfolio_id in (
    select id from public.portfolios where user_id = (select auth.uid())
  ));

create policy "owner_update"
  on public.portfolio_holdings_cache for update
  using (portfolio_id in (
    select id from public.portfolios where user_id = (select auth.uid())
  ));
