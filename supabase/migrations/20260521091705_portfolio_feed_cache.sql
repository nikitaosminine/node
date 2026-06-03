create table if not exists public.portfolio_feed_cache (
  portfolio_id uuid not null primary key references public.portfolios(id) on delete cascade,
  holdings_hash text not null,
  grok_scores jsonb not null default '[]'::jsonb,
  profile_text text,
  scored_at timestamptz not null default now()
);

alter table public.portfolio_feed_cache enable row level security;

create policy "Owner can read own feed cache"
  on public.portfolio_feed_cache for select
  using (portfolio_id in (
    select id from public.portfolios where user_id = (select auth.uid())
  ));
