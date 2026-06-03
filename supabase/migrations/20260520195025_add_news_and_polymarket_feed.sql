-- ============================================================
-- ETF Constituents Registry
-- Central ISIN-keyed table shared across all portfolios.
-- Populated lazily by the geography research job; TTL checked
-- via updated_at (fetch time), not as_of_date (data reference date).
-- ============================================================

create table if not exists public.etf_constituents (
  etf_isin        text primary key,
  as_of_date      date,
  constituents    jsonb not null default '[]'::jsonb,
  -- [{ticker, name, weight_pct, country_code, sector}]
  top_sectors     jsonb not null default '[]'::jsonb,
  -- [{sector, weight_pct}] rolled up from constituents
  source          text not null default 'llm_web',
  confidence      numeric(4, 3) not null default 0
                    check (confidence >= 0 and confidence <= 1),
  evidence        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.etf_constituents enable row level security;

drop policy if exists "Authenticated users can read etf constituents"
  on public.etf_constituents;
create policy "Authenticated users can read etf constituents"
  on public.etf_constituents for select
  to authenticated
  using (true);

drop policy if exists "Service role can manage etf constituents"
  on public.etf_constituents;
create policy "Service role can manage etf constituents"
  on public.etf_constituents for all
  to service_role
  using (true)
  with check (true);

drop trigger if exists update_etf_constituents_updated_at
  on public.etf_constituents;
create trigger update_etf_constituents_updated_at
  before update on public.etf_constituents
  for each row execute function public.update_updated_at_column();


-- ============================================================
-- News Clusters
-- One row per news article/story (deduped by cluster_key).
-- Shared across portfolios; portfolio assignment lives in the
-- portfolio_news_matches bridge. expires_at uses
-- GREATEST(existing, new_published_at + TTL) on re-fetch so
-- actively-trending stories don't get swept early.
-- ============================================================

create table if not exists public.news_clusters (
  id              uuid primary key default gen_random_uuid(),
  cluster_key     text not null unique,
  -- stable identifier for a story (provider document id, else url)
  primary_article jsonb not null default '{}'::jsonb,
  -- {title, url, source, published_at, snippet, image}
  -- Note: `sentiment` intentionally excluded (V1 drops it)
  see_also        jsonb not null default '[]'::jsonb,
  -- [{title, url, source}]
  entities        jsonb not null default '{}'::jsonb,
  -- {isins: [], tickers: [], countries: [], sectors: []}
  published_at    timestamptz not null,
  fetched_at      timestamptz not null default now(),
  expires_at      timestamptz not null
  -- = GREATEST(existing_expires_at, published_at + interval '48 hours')
  -- set by the polling worker on every upsert
);

create index if not exists news_clusters_expires_at_idx
  on public.news_clusters (expires_at);

create index if not exists news_clusters_published_at_idx
  on public.news_clusters (published_at desc);

alter table public.news_clusters enable row level security;

drop policy if exists "Authenticated users can read news clusters"
  on public.news_clusters;
create policy "Authenticated users can read news clusters"
  on public.news_clusters for select
  to authenticated
  using (true);

drop policy if exists "Service role can manage news clusters"
  on public.news_clusters;
create policy "Service role can manage news clusters"
  on public.news_clusters for all
  to service_role
  using (true)
  with check (true);


-- ============================================================
-- Portfolio News Matches (bridge)
-- Per-portfolio relevance score + match metadata for each cluster.
-- Cascades on portfolio and cluster deletion.
-- ============================================================

create table if not exists public.portfolio_news_matches (
  portfolio_id    uuid not null references public.portfolios(id) on delete cascade,
  cluster_id      uuid not null references public.news_clusters(id) on delete cascade,
  score           numeric(6, 4) not null default 0,
  -- entity_weight × recency_decay; no source_quality term in V1
  match_reason    jsonb not null default '{}'::jsonb,
  -- {matched_isins: [], matched_tickers: [], matched_etfs: [],
  --  matched_country_sector: []}
  created_at      timestamptz not null default now(),
  primary key (portfolio_id, cluster_id)
);

create index if not exists portfolio_news_matches_portfolio_score_idx
  on public.portfolio_news_matches (portfolio_id, score desc);

create index if not exists portfolio_news_matches_cluster_idx
  on public.portfolio_news_matches (cluster_id);

alter table public.portfolio_news_matches enable row level security;

drop policy if exists "Users can view news matches of their portfolios"
  on public.portfolio_news_matches;
create policy "Users can view news matches of their portfolios"
  on public.portfolio_news_matches for select
  using (
    exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = auth.uid()
    )
  );

drop policy if exists "Service role can manage portfolio news matches"
  on public.portfolio_news_matches;
create policy "Service role can manage portfolio news matches"
  on public.portfolio_news_matches for all
  to service_role
  using (true)
  with check (true);


-- ============================================================
-- Polymarket Markets
-- Shared candidate pool. Columns locked by Step 0 spike.
-- Key mapping from Gamma API response (camelCase) to columns:
--   conditionId  → condition_id
--   volume24hr   → volume_24hr   (float or null for closed)
--   outcomePrices → outcome_prices (parsed from JSON string,
--                   stored as float array e.g. [0.825, 0.175])
--   outcomes     → outcomes (parsed from JSON string,
--                   stored as string array e.g. ["Yes","No"])
--   tags         → tags (carried from parent event, not market)
--   image        → image (market.image ?? event.image at flatten time)
-- No is_globally_pinned — pin is per-portfolio on the bridge.
-- ============================================================

create table if not exists public.polymarket_markets (
  condition_id    text primary key,
  event_id        text,
  event_slug      text,
  event_title     text,
  market_slug     text,
  question        text not null,
  tags            jsonb not null default '[]'::jsonb,
  -- [{id, label}] from parent event
  outcomes        jsonb not null default '[]'::jsonb,
  -- string array e.g. ["Yes", "No"] or ["Trump", "Biden", "Other"]
  outcome_prices  jsonb not null default '[]'::jsonb,
  -- float array sorted to match outcomes e.g. [0.825, 0.175]
  -- stored as numbers, not strings — convert at insert time
  liquidity       numeric(18, 6),
  volume_24hr     numeric(18, 6),
  -- null for closed or inactive markets
  end_date        timestamptz,
  image           text,
  active          boolean not null default true,
  fetched_at      timestamptz not null default now()
);

create index if not exists polymarket_markets_volume_24hr_idx
  on public.polymarket_markets (volume_24hr desc nulls last);

create index if not exists polymarket_markets_fetched_at_idx
  on public.polymarket_markets (fetched_at desc);

alter table public.polymarket_markets enable row level security;

drop policy if exists "Authenticated users can read polymarket markets"
  on public.polymarket_markets;
create policy "Authenticated users can read polymarket markets"
  on public.polymarket_markets for select
  to authenticated
  using (true);

drop policy if exists "Service role can manage polymarket markets"
  on public.polymarket_markets;
create policy "Service role can manage polymarket markets"
  on public.polymarket_markets for all
  to service_role
  using (true)
  with check (true);


-- ============================================================
-- Portfolio Polymarket Matches (bridge)
-- Per-portfolio assignment with LLM score and reason.
-- is_pinned=true rows bypass LLM; score is NULL for pinned.
-- Only the top-volume_24hr market per pinned event gets
-- is_pinned=true (resolved at upsert time in the worker).
-- Cascades on portfolio and market deletion.
-- ============================================================

create table if not exists public.portfolio_polymarket_matches (
  portfolio_id    uuid not null references public.portfolios(id) on delete cascade,
  condition_id    text not null references public.polymarket_markets(condition_id) on delete cascade,
  score           numeric(4, 3),
  -- null for pinned markets (bypasses LLM scoring)
  reason          text,
  -- one-line LLM explanation "why this matters for your portfolio"
  -- null for pinned markets
  is_pinned       boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (portfolio_id, condition_id)
);

create index if not exists portfolio_polymarket_matches_portfolio_pinned_score_idx
  on public.portfolio_polymarket_matches (portfolio_id, is_pinned desc, score desc nulls last);

create index if not exists portfolio_polymarket_matches_condition_idx
  on public.portfolio_polymarket_matches (condition_id);

alter table public.portfolio_polymarket_matches enable row level security;

drop policy if exists "Users can view polymarket matches of their portfolios"
  on public.portfolio_polymarket_matches;
create policy "Users can view polymarket matches of their portfolios"
  on public.portfolio_polymarket_matches for select
  using (
    exists (
      select 1 from public.portfolios
      where id = portfolio_id and user_id = auth.uid()
    )
  );

drop policy if exists "Service role can manage portfolio polymarket matches"
  on public.portfolio_polymarket_matches;
create policy "Service role can manage portfolio polymarket matches"
  on public.portfolio_polymarket_matches for all
  to service_role
  using (true)
  with check (true);
