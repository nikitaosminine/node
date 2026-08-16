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
  -- full re-observation dedupe set: array of {id, scoredAt} for every
  -- news_clusters.id already folded into this company's EWMA. Pruned by age
  -- rather than count (see MAX_SCORED_CLUSTER_IDS in feeds/sentiment.ts) — a
  -- cluster older than the news TTL window can never resurface as an Exa
  -- result again, so it's safe to drop from the dedupe set once it ages out.
  -- Kept separate from evidence_cluster_ids so the small display cap can't
  -- evict ids the EWMA still needs to recognize as already observed.
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
  values ('singleton', p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (id) do update
    set holder = excluded.holder,
        expires_at = excluded.expires_at
    where public.company_sentiment_lock.expires_at < now();
  get diagnostics v_acquired = row_count;
  return v_acquired > 0;
end;
$$;

revoke all on function public.try_acquire_company_sentiment_lock(text, int) from public;
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

  if v_holder is distinct from p_holder or v_expires_at is null or v_expires_at <= now() then
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

  return true;
end;
$$;

revoke all on function public.apply_company_sentiment_batch(text, jsonb) from public;
grant execute on function public.apply_company_sentiment_batch(text, jsonb) to service_role;
