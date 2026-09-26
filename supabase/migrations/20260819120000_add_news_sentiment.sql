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
-- sentiment call at the end of runNewsFanout. Empty when the cluster
-- has never been fully scored (default) or predates this feature; a
-- failed or partial scoring run omits the key on upsert, preserving
-- whatever was stored (see buildClusterRow in feeds/news.ts).

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
  -- capped at 10 (see MAX_EVIDENCE_CLUSTER_IDS in feeds/sentiment.ts) —
  -- display/API list only, NOT the dedupe set
  scored_cluster_ids    jsonb not null default '[]'::jsonb,
  -- full re-observation dedupe set: array of {id, scoredAt, publishedAt} for every
  -- news_clusters.id already folded into this company's EWMA. Pruned by age
  -- using the news TTL window.
  updated_at            timestamptz not null default now()
);

create index if not exists company_sentiment_updated_at_idx
  on public.company_sentiment (updated_at desc);

alter table public.company_sentiment enable row level security;

drop policy if exists "Authenticated users can read company sentiment"
  on public.company_sentiment;

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

-- ============================================================
-- Company sentiment update lock
-- Guards the read-modify-write EWMA merge in
-- updateRollingCompanySentiment (feeds/news.ts) against a lost update when
-- two fanout runs overlap for the same company (e.g. a manual
-- /_debug/run-news-fanout call overlapping a scheduled run). PostgREST has
-- no transaction spanning multiple HTTP calls, so the compare-and-swap has
-- to happen in a single atomic statement server-side via this RPC, rather
-- than a plain client-side read-then-write.
-- ============================================================

create table if not exists public.company_sentiment_lock (
  id          text primary key,
  holder      text not null,
  expires_at  timestamptz not null
);

alter table public.company_sentiment_lock enable row level security;

drop policy if exists "Service role can manage company sentiment lock"
  on public.company_sentiment_lock;
create policy "Service role can manage company sentiment lock"
  on public.company_sentiment_lock for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.company_sentiment_pending (
  id           bigint generated always as identity primary key,
  company_key  text not null,
  cluster_id   text not null,
  company_name text not null,
  ticker       text,
  isin         text,
  score        numeric(5, 4) not null check (score >= -1 and score <= 1),
  rationale    text not null default '',
  published_at timestamptz not null,
  observed_at timestamptz not null default now(),
  unique (company_key, cluster_id)
);

alter table public.company_sentiment_pending enable row level security;

drop policy if exists "Service role can manage pending company sentiment"
  on public.company_sentiment_pending;
create policy "Service role can manage pending company sentiment"
  on public.company_sentiment_pending for all
  to service_role
  using (true)
  with check (true);

create or replace function public.enqueue_company_sentiment_pending(
  p_rows jsonb
) returns boolean
language plpgsql
set search_path = ''
as $$
begin
  insert into public.company_sentiment_pending (
    company_key, cluster_id, company_name, ticker, isin, score, rationale, published_at, observed_at
  )
  select
    r.company_key, r.cluster_id, r.company_name, r.ticker, r.isin,
    r.score, r.rationale, r.published_at, r.observed_at
  from (
    select distinct on (raw.company_key, raw.cluster_id)
      raw.company_key, raw.cluster_id, raw.company_name, raw.ticker,
      raw.isin, raw.score, raw.rationale, raw.published_at, raw.observed_at
    from jsonb_to_recordset(p_rows) as raw(
      company_key text,
      cluster_id text,
      company_name text,
      ticker text,
      isin text,
      score numeric,
      rationale text,
      published_at timestamptz,
      observed_at timestamptz
    )
    order by raw.company_key, raw.cluster_id, raw.observed_at desc nulls last
  ) as r
  on conflict (company_key, cluster_id) do update
    set company_name = excluded.company_name,
        ticker = excluded.ticker,
        isin = excluded.isin,
        score = excluded.score,
        rationale = excluded.rationale,
        published_at = excluded.published_at,
        observed_at = excluded.observed_at;

  return true;
end;
$$;

revoke all on function public.enqueue_company_sentiment_pending(jsonb) from public;
revoke all on function public.enqueue_company_sentiment_pending(jsonb) from anon, authenticated;
grant execute on function public.enqueue_company_sentiment_pending(jsonb) to service_role;

-- Atomically takes the singleton lock row if it is unheld or its holder's
-- lease has expired; returns false if another holder currently owns it. The
-- WHERE clause on the DO UPDATE branch is what makes this a true
-- compare-and-swap instead of an unconditional "last writer wins" upsert.
create or replace function public.try_acquire_company_sentiment_lock(
  p_holder text,
  p_ttl_seconds int
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_acquired int;
begin
  insert into public.company_sentiment_lock (id, holder, expires_at)
  values ('singleton', p_holder, clock_timestamp() + make_interval(secs => p_ttl_seconds))
  on conflict (id) do update
    set holder = excluded.holder,
        expires_at = excluded.expires_at
    where public.company_sentiment_lock.expires_at < clock_timestamp();
  get diagnostics v_acquired = row_count;
  return v_acquired > 0;
end;
$$;

revoke all on function public.try_acquire_company_sentiment_lock(text, int) from public;
revoke all on function public.try_acquire_company_sentiment_lock(text, int) from anon, authenticated;
grant execute on function public.try_acquire_company_sentiment_lock(text, int) to service_role;

-- Writes the rolling company_sentiment rows only if p_holder still holds a
-- live lease at write time, closing the gap a lease-TTL check alone can't:
-- acquiring the lock before the read and checking it again right before the
-- write are still two separate round trips, so a caller whose read-modify
-- work stalls past the TTL could otherwise resume and overwrite a row a
-- second caller already updated after stealing the expired lease. `select
-- ... for update` takes a row lock on the lease for the rest of this
-- transaction, so the ownership check and the write happen atomically: any
-- concurrent try_acquire_company_sentiment_lock call blocks until this
-- transaction commits, and by then the lease this call is holding is either
-- still valid (safe to write) or it isn't (write rejected, no torn state).
create or replace function public.apply_company_sentiment_batch(
  p_holder text,
  p_rows jsonb
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_holder text;
  v_expires_at timestamptz;
begin
  select holder, expires_at
    into v_holder, v_expires_at
    from public.company_sentiment_lock
    where id = 'singleton'
    for update;

  if v_holder is distinct from p_holder or v_expires_at is null or v_expires_at <= clock_timestamp() then
    return false;
  end if;

  insert into public.company_sentiment (
    company_key, company_name, ticker, isin, score, trend,
    evidence_cluster_ids, scored_cluster_ids, updated_at
  )
  select
    r.company_key, r.company_name, r.ticker, r.isin, r.score, r.trend,
    r.evidence_cluster_ids, r.scored_cluster_ids, r.updated_at
  from jsonb_to_recordset(p_rows) as r(
    company_key text,
    company_name text,
    ticker text,
    isin text,
    score numeric,
    trend text,
    evidence_cluster_ids jsonb,
    scored_cluster_ids jsonb,
    updated_at timestamptz
  )
  on conflict (company_key) do update
    set company_name = excluded.company_name,
        ticker = excluded.ticker,
        isin = excluded.isin,
        score = excluded.score,
        trend = excluded.trend,
        evidence_cluster_ids = excluded.evidence_cluster_ids,
        scored_cluster_ids = excluded.scored_cluster_ids,
        updated_at = excluded.updated_at;

  delete from public.company_sentiment_pending p
  where p.observed_at < clock_timestamp() - interval '7 days'
     or exists (
       select 1
       from public.company_sentiment cs
       cross join lateral jsonb_array_elements(coalesce(cs.scored_cluster_ids, '[]'::jsonb)) as ids(value)
       where cs.company_key = p.company_key
         and ids.value->>'id' = p.cluster_id
     );

  return true;
end;
$$;

revoke all on function public.apply_company_sentiment_batch(text, jsonb) from public;
revoke all on function public.apply_company_sentiment_batch(text, jsonb) from anon, authenticated;
grant execute on function public.apply_company_sentiment_batch(text, jsonb) to service_role;
