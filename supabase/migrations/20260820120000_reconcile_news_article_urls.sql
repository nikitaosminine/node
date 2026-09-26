-- Reconcile Exa-ID and Firecrawl-URL keys for the same exact article URL.
-- Apply after 20260819120000_add_news_sentiment.sql and before deploying the
-- URL-identity reader in news.ts. One DO statement keeps the merge, locks, and
-- uniqueness guard in one transaction even when the migration runner autocommits.
do $reconcile$
declare
  article_url_value text;
  keep_row record;
  duplicate_row record;
  link_row record;
  existing_link record;
  sentiment_row record;
  reason_key text;
  article_field text;
  merged_article jsonb;
  merged_see_also jsonb;
  merged_entities jsonb;
  merged_sentiments jsonb;
  merged_reason jsonb;
  merged_values jsonb;
  merged_evidence jsonb;
  merged_scored jsonb;
begin
  -- No ingestion or ledger write may interleave the canonical-ID rewrite.
  lock table public.news_clusters, public.portfolio_news_matches,
    public.company_sentiment, public.company_sentiment_pending
    in access exclusive mode;
  -- Ledger ID rewrites must not make an unchanged score appear newly scored.
  alter table public.company_sentiment disable trigger update_company_sentiment_updated_at;

  alter table public.news_clusters
    add column if not exists article_url text
    generated always as (nullif(primary_article->>'url', '')) stored;

  for article_url_value in
    select article_url
    from public.news_clusters
    where article_url is not null
    group by article_url
    having count(*) > 1
  loop
    -- Prefer the existing provider-keyed identity, then the earliest fetched
    -- row. Its UUID and cluster_key remain stable for every linked portfolio.
    select * into keep_row
    from public.news_clusters
    where article_url = article_url_value
    order by (cluster_key = article_url_value), fetched_at, id
    limit 1;

    for duplicate_row in
      select * from public.news_clusters
      where article_url = article_url_value and id <> keep_row.id
    loop
      merged_article := jsonb_set(
        jsonb_strip_nulls(duplicate_row.primary_article) ||
          jsonb_strip_nulls(keep_row.primary_article),
        '{url}', to_jsonb(article_url_value), true
      );
      -- Canonical metadata wins when it has content; a blank legacy scrape
      -- must not discard a useful summary/image from the URL-keyed row.
      foreach article_field in array array['title', 'snippet', 'image']
      loop
        if nullif(btrim(coalesce(keep_row.primary_article->>article_field, '')), '') is null
          and nullif(btrim(coalesce(duplicate_row.primary_article->>article_field, '')), '') is not null
        then
          merged_article := jsonb_set(
            merged_article, array[article_field],
            duplicate_row.primary_article->article_field, true
          );
        end if;
      end loop;
      select coalesce(jsonb_agg(value order by first_ordinal), '[]'::jsonb)
        into merged_see_also
      from (
        select value, min(ordinality) as first_ordinal
        from jsonb_array_elements(keep_row.see_also || duplicate_row.see_also)
          with ordinality as items(value, ordinality)
        group by value
      ) as distinct_items;

      merged_entities := duplicate_row.entities || keep_row.entities;
      foreach reason_key in array array['isins', 'tickers', 'countries', 'sectors']
      loop
        select coalesce(jsonb_agg(to_jsonb(item) order by item), '[]'::jsonb)
          into merged_values
        from (
          select distinct value as item
          from jsonb_array_elements_text(
            coalesce(keep_row.entities->reason_key, '[]'::jsonb) ||
            coalesce(duplicate_row.entities->reason_key, '[]'::jsonb)
          ) as items(value)
        ) as distinct_items;
        merged_entities := jsonb_set(merged_entities, array[reason_key], merged_values, true);
      end loop;

      -- Keep the canonical sentiment for a company when both rows scored it;
      -- append scores for companies found only on the duplicate.
      select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
        into merged_sentiments
      from (
        select distinct on (value->>'company_key') value, ordinality
        from jsonb_array_elements(keep_row.sentiments || duplicate_row.sentiments)
          with ordinality as items(value, ordinality)
        order by value->>'company_key', ordinality
      ) as distinct_scores;

      update public.news_clusters
      set primary_article = merged_article,
          see_also = merged_see_also,
          entities = merged_entities,
          sentiments = merged_sentiments,
          fetched_at = greatest(keep_row.fetched_at, duplicate_row.fetched_at),
          expires_at = greatest(keep_row.expires_at, duplicate_row.expires_at)
      where id = keep_row.id
      returning * into keep_row;

      -- Move links from every portfolio. For a portfolio linked to both IDs,
      -- retain the stronger score and union each reason array.
      for link_row in
        select * from public.portfolio_news_matches
        where cluster_id = duplicate_row.id
      loop
        select * into existing_link
        from public.portfolio_news_matches
        where portfolio_id = link_row.portfolio_id and cluster_id = keep_row.id;
        if found then
          merged_reason := link_row.match_reason || existing_link.match_reason;
          for reason_key in
            select key from jsonb_object_keys(merged_reason) as keys(key)
          loop
            if jsonb_typeof(link_row.match_reason->reason_key) = 'array'
              or jsonb_typeof(existing_link.match_reason->reason_key) = 'array'
            then
              select coalesce(jsonb_agg(value order by first_ordinal), '[]'::jsonb)
                into merged_values
              from (
                select value, min(ordinality) as first_ordinal
                from jsonb_array_elements(
                  (case when jsonb_typeof(existing_link.match_reason->reason_key) = 'array'
                    then existing_link.match_reason->reason_key else '[]'::jsonb end) ||
                  (case when jsonb_typeof(link_row.match_reason->reason_key) = 'array'
                    then link_row.match_reason->reason_key else '[]'::jsonb end)
                ) with ordinality as items(value, ordinality)
                group by value
              ) as distinct_reasons;
              merged_reason := jsonb_set(merged_reason, array[reason_key], merged_values, true);
            end if;
          end loop;
          update public.portfolio_news_matches
          set score = greatest(existing_link.score, link_row.score),
              match_reason = merged_reason,
              created_at = least(existing_link.created_at, link_row.created_at)
          where portfolio_id = existing_link.portfolio_id and cluster_id = keep_row.id;
          delete from public.portfolio_news_matches
          where portfolio_id = link_row.portfolio_id and cluster_id = duplicate_row.id;
        else
          update public.portfolio_news_matches
          set cluster_id = keep_row.id
          where portfolio_id = link_row.portfolio_id and cluster_id = duplicate_row.id;
        end if;
      end loop;

      -- Rewrite evidence IDs and the full EWMA dedupe ledger. A repeated
      -- article contributes one canonical ID, while score/trend stay untouched.
      for sentiment_row in select * from public.company_sentiment
      loop
        select coalesce(jsonb_agg(id order by first_ordinal), '[]'::jsonb)
          into merged_evidence
        from (
          select case when value = duplicate_row.id::text
              then keep_row.id::text else value end as id,
            min(ordinality) as first_ordinal
          from jsonb_array_elements_text(sentiment_row.evidence_cluster_ids)
            with ordinality as items(value, ordinality)
          group by 1
        ) as distinct_evidence;

        select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
          into merged_scored
        from (
          select distinct on (rewritten.value->>'id') rewritten.value, rewritten.ordinality
          from (
            select case when value->>'id' = duplicate_row.id::text
                then jsonb_set(value, '{id}', to_jsonb(keep_row.id::text), true)
                else value end as value,
              ordinality,
              case when value->>'id' = keep_row.id::text then 0 else 1 end as preference,
              case when pg_input_is_valid(value->>'scoredAt', 'timestamptz')
                then (value->>'scoredAt')::timestamptz end as scored_at,
              case when pg_input_is_valid(value->>'publishedAt', 'timestamptz')
                then (value->>'publishedAt')::timestamptz end as published_at
            from jsonb_array_elements(sentiment_row.scored_cluster_ids)
              with ordinality as items(value, ordinality)
          ) as rewritten
          order by rewritten.value->>'id', rewritten.scored_at desc nulls last,
            rewritten.published_at desc nulls last, rewritten.preference, rewritten.ordinality
        ) as distinct_scored;

        if merged_evidence is distinct from sentiment_row.evidence_cluster_ids
          or merged_scored is distinct from sentiment_row.scored_cluster_ids
        then
          update public.company_sentiment
          set evidence_cluster_ids = merged_evidence,
              scored_cluster_ids = merged_scored
          where company_key = sentiment_row.company_key;
        end if;
      end loop;

      -- Move unprocessed observations without counting the same article twice.
      -- If both IDs were pending, keep the most recently observed payload.
      insert into public.company_sentiment_pending (
        company_key, cluster_id, company_name, ticker, isin, score,
        rationale, published_at, observed_at
      )
      select company_key, keep_row.id::text, company_name, ticker, isin, score,
        rationale, published_at, observed_at
      from public.company_sentiment_pending
      where cluster_id = duplicate_row.id::text
      on conflict (company_key, cluster_id) do update
      set company_name = excluded.company_name,
          ticker = excluded.ticker,
          isin = excluded.isin,
          score = excluded.score,
          rationale = excluded.rationale,
          published_at = excluded.published_at,
          observed_at = excluded.observed_at
      where excluded.observed_at > public.company_sentiment_pending.observed_at;
      delete from public.company_sentiment_pending
      where cluster_id = duplicate_row.id::text;

      delete from public.news_clusters where id = duplicate_row.id;
    end loop;
  end loop;

  create unique index if not exists news_clusters_article_url_unique
    on public.news_clusters (article_url) where article_url is not null;
  alter table public.company_sentiment enable trigger update_company_sentiment_updated_at;
end;
$reconcile$;
