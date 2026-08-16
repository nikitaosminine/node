-- ============================================================
-- News sentiment scoring: reintroduces per-cluster sentiment
-- (deliberately dropped in V1, see the `sentiment` comment on
-- news_clusters in 20260520195025_add_news_and_polymarket_feed.sql)
-- and adds a rolling per-company sentiment score computed via
-- EWMA at the end of every news fanout run.
-- ============================================================

alter table public.news_clusters
  add column if not exists sentiments jsonb not null default '[]'::jsonb;
-- [{company_key, company_name, tickers, isins, score, rationale}]
-- One entry per (cluster, company) pair scored by the batched Grok
-- sentiment call at the end of runNewsFanout. Empty when scoring
-- failed or the cluster predates this migration/feature.

-- ============================================================
-- Company Sentiment
-- Rolling per-company sentiment, recomputed at the end of every
-- news fanout run via an EWMA over newly-scored clusters. One row
-- per canonical company key (ISIN > ticker > normalized-name,
-- same convention as news.ts:canonicalKey).
-- ============================================================

create table if not exists public.company_sentiment (
  company_key           text primary key,
  company_name          text not null,
  ticker                text,
  isin                  text,
  score                 numeric(5, 4) not null check (score >= -1 and score <= 1),
  trend                 text not null default 'flat'
                          check (trend in ('up', 'down', 'flat')),
  evidence_cluster_ids  jsonb not null default '[]'::jsonb,
  -- most-recent-first array of news_clusters.id this score was derived from,
  -- capped at 10 (see MAX_EVIDENCE_CLUSTER_IDS in feeds/sentiment.ts)
  updated_at            timestamptz not null default now()
);

create index if not exists company_sentiment_updated_at_idx
  on public.company_sentiment (updated_at desc);

alter table public.company_sentiment enable row level security;

drop policy if exists "Authenticated users can read company sentiment"
  on public.company_sentiment;
create policy "Authenticated users can read company sentiment"
  on public.company_sentiment for select
  to authenticated
  using (true);

drop policy if exists "Service role can manage company sentiment"
  on public.company_sentiment;
create policy "Service role can manage company sentiment"
  on public.company_sentiment for all
  to service_role
  using (true)
  with check (true);

drop trigger if exists update_company_sentiment_updated_at
  on public.company_sentiment;
create trigger update_company_sentiment_updated_at
  before update on public.company_sentiment
  for each row execute function public.update_updated_at_column();
