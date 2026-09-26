// Run only with `npm run test:postgres` against a disposable PostgreSQL 17 database.
// This file deliberately does not match Vitest's *.test.* glob.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function testConnectionString() {
  const raw = process.env.PG_SENTIMENT_TEST_URL;
  assert.ok(raw, "PG_SENTIMENT_TEST_URL is required for the PostgreSQL integration suite");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PG_SENTIMENT_TEST_URL must be a PostgreSQL connection URL");
  }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(
    ["127.0.0.1", "localhost"].includes(url.hostname),
    "test database must be loopback-only",
  );
  assert.equal(
    url.username,
    "node_sentiment_test",
    "test database user must be node_sentiment_test",
  );
  assert.equal(
    url.pathname,
    "/node_sentiment_test",
    "test database name must be node_sentiment_test",
  );
  assert.equal(url.search, "", "test URL must not contain connection overrides");
  assert.equal(url.hash, "", "test URL must not contain a fragment");
  return raw;
}

// Validate the explicitly supplied, disposable target before importing a driver
// or opening any connection. DATABASE_URL and production Supabase secrets are unused.
const connectionString = testConnectionString();
const { default: pg } = await import("pg");

async function connect() {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 3_000,
    query_timeout: 10_000,
  });
  await client.connect();
  await client.query("SET statement_timeout = '10s'");
  return client;
}

async function installActualMigration(client) {
  const migrationsDir = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((name) =>
    /^\d+_add_news_sentiment\.sql$/.test(name),
  );
  assert.equal(files.length, 1, "expected exactly one versioned news sentiment migration");

  // Only the prerequisites supplied by earlier Supabase migrations are needed.
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN;
      END IF;
    END $$;
    -- Supabase grants these roles EXECUTE directly on newly created functions.
    -- The migration must revoke anon/authenticated explicitly, not only PUBLIC.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE TABLE IF NOT EXISTS public.portfolios (id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS public.news_clusters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cluster_key text NOT NULL UNIQUE,
      primary_article jsonb NOT NULL DEFAULT '{}'::jsonb,
      see_also jsonb NOT NULL DEFAULT '[]'::jsonb,
      entities jsonb NOT NULL DEFAULT '{}'::jsonb,
      published_at timestamptz NOT NULL,
      fetched_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS public.portfolio_news_matches (
      portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
      cluster_id uuid NOT NULL REFERENCES public.news_clusters(id) ON DELETE CASCADE,
      score numeric(6, 4) NOT NULL DEFAULT 0,
      match_reason jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (portfolio_id, cluster_id)
    );
    CREATE OR REPLACE FUNCTION public.update_updated_at_column()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END $$;
  `);
  await client.query(await readFile(join(migrationsDir, files[0]), "utf8"));
}

async function installNewsUrlMigration(client) {
  const migrationsDir = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((name) =>
    /^\d+_reconcile_news_article_urls\.sql$/.test(name),
  );
  assert.equal(files.length, 1, "expected exactly one versioned news URL migration");
  await client.query(await readFile(join(migrationsDir, files[0]), "utf8"));
}

async function reset(client) {
  await client.query(`
    TRUNCATE public.company_sentiment_pending,
             public.company_sentiment_lock,
             public.company_sentiment,
             public.portfolio_news_matches,
             public.news_clusters,
             public.portfolios;
  `);
}

function observation(clusterId, score = 0.4, observedAt = new Date().toISOString()) {
  return {
    company_key: "ticker:AAPL",
    cluster_id: clusterId,
    company_name: "Apple",
    ticker: "AAPL",
    isin: null,
    score,
    rationale: `Evidence from ${clusterId}`,
    published_at: observedAt,
    observed_at: observedAt,
  };
}

function aggregate(score, clusterIds) {
  const now = new Date().toISOString();
  return {
    company_key: "ticker:AAPL",
    company_name: "Apple",
    ticker: "AAPL",
    isin: null,
    score,
    trend: "flat",
    evidence_cluster_ids: clusterIds,
    scored_cluster_ids: clusterIds.map((id) => ({ id, scoredAt: now, publishedAt: now })),
    updated_at: now,
  };
}

async function acquire(client, holder, ttlSeconds = 120) {
  const { rows } = await client.query(
    "SELECT public.try_acquire_company_sentiment_lock($1, $2) AS acquired",
    [holder, ttlSeconds],
  );
  return rows[0].acquired;
}

async function enqueue(client, observations) {
  const { rows } = await client.query(
    "SELECT public.enqueue_company_sentiment_pending($1::jsonb) AS enqueued",
    [JSON.stringify(observations)],
  );
  assert.equal(rows[0].enqueued, true);
}

async function apply(client, holder, aggregates) {
  const { rows } = await client.query(
    "SELECT public.apply_company_sentiment_batch($1, $2::jsonb) AS applied",
    [holder, JSON.stringify(aggregates)],
  );
  return rows[0].applied;
}

async function pendingIds(client) {
  const { rows } = await client.query(
    "SELECT cluster_id FROM public.company_sentiment_pending ORDER BY cluster_id",
  );
  return rows.map((row) => row.cluster_id);
}

async function waitUntilBlocked(observer, blockedPid, blockerPid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query("SELECT pg_blocking_pids($1::int) AS blockers", [
      blockedPid,
    ]);
    if (rows[0].blockers.includes(blockerPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("lock takeover did not block behind the apply transaction");
}

test(
  "news sentiment migration works on disposable PostgreSQL 17",
  { timeout: 60_000 },
  async (t) => {
    const client = await connect();
    try {
      const { rows: versionRows } = await client.query(
        "SELECT current_setting('server_version_num')::int AS version_num",
      );
      assert.equal(
        Math.floor(versionRows[0].version_num / 10_000),
        17,
        "PostgreSQL 17 is required",
      );
      await installActualMigration(client);

      await t.test(
        "executes the complete migration and installs its default and RPC grants",
        async () => {
          await reset(client);
          const { rows: clusterRows } = await client.query(
            "INSERT INTO public.news_clusters (cluster_key, published_at, expires_at) VALUES ('bootstrap', now(), now() + interval '2 days') RETURNING sentiments",
          );
          assert.deepEqual(clusterRows[0].sentiments, []);
          const { rows: grantRows } = await client.query(`
        SELECT
          has_function_privilege('service_role', 'public.try_acquire_company_sentiment_lock(text,int)', 'EXECUTE') AS lock_grant,
          has_function_privilege('service_role', 'public.enqueue_company_sentiment_pending(jsonb)', 'EXECUTE') AS enqueue_grant,
          has_function_privilege('service_role', 'public.apply_company_sentiment_batch(text,jsonb)', 'EXECUTE') AS apply_grant,
          has_function_privilege('anon', 'public.try_acquire_company_sentiment_lock(text,int)', 'EXECUTE') AS anon_lock_grant,
          has_function_privilege('anon', 'public.enqueue_company_sentiment_pending(jsonb)', 'EXECUTE') AS anon_enqueue_grant,
          has_function_privilege('anon', 'public.apply_company_sentiment_batch(text,jsonb)', 'EXECUTE') AS anon_apply_grant,
          has_function_privilege('authenticated', 'public.try_acquire_company_sentiment_lock(text,int)', 'EXECUTE') AS authenticated_lock_grant,
          has_function_privilege('authenticated', 'public.enqueue_company_sentiment_pending(jsonb)', 'EXECUTE') AS authenticated_enqueue_grant,
          has_function_privilege('authenticated', 'public.apply_company_sentiment_batch(text,jsonb)', 'EXECUTE') AS authenticated_apply_grant
      `);
          assert.deepEqual(grantRows[0], {
            lock_grant: true,
            enqueue_grant: true,
            apply_grant: true,
            anon_lock_grant: false,
            anon_enqueue_grant: false,
            anon_apply_grant: false,
            authenticated_lock_grant: false,
            authenticated_enqueue_grant: false,
            authenticated_apply_grant: false,
          });
        },
      );

      await t.test("enforces holder ownership and rejects an expired holder", async () => {
        await reset(client);
        await enqueue(client, [observation("owner-cluster")]);
        assert.equal(await acquire(client, "holder-a"), true);
        assert.equal(await acquire(client, "holder-b"), false);
        assert.equal(await apply(client, "holder-b", [aggregate(0.4, ["owner-cluster"])]), false);
        assert.deepEqual(await pendingIds(client), ["owner-cluster"]);

        await client.query(
          "UPDATE public.company_sentiment_lock SET expires_at = clock_timestamp() - interval '1 second' WHERE id = 'singleton'",
        );
        assert.equal(await apply(client, "holder-a", [aggregate(0.4, ["owner-cluster"])]), false);
        assert.equal(await acquire(client, "holder-b"), true);
        assert.equal(await apply(client, "holder-a", [aggregate(-0.8, ["owner-cluster"])]), false);
        assert.equal(await apply(client, "holder-b", [aggregate(0.4, ["owner-cluster"])]), true);
        assert.deepEqual(await pendingIds(client), []);
        const { rows } = await client.query(
          "SELECT score FROM public.company_sentiment WHERE company_key = 'ticker:AAPL'",
        );
        assert.equal(Number(rows[0].score), 0.4);
      });

      await t.test(
        "rolls back a failed aggregate write without acknowledging pending rows",
        async () => {
          await reset(client);
          await enqueue(client, [observation("atomic-cluster")]);
          assert.equal(await acquire(client, "holder-atomic"), true);
          await assert.rejects(
            apply(client, "holder-atomic", [aggregate(1.5, ["atomic-cluster"])]),
            (error) => error.code === "23514",
          );
          assert.deepEqual(await pendingIds(client), ["atomic-cluster"]);
          const { rows: beforeRows } = await client.query(
            "SELECT count(*)::int AS count FROM public.company_sentiment",
          );
          assert.equal(beforeRows[0].count, 0);
          assert.equal(
            await apply(client, "holder-atomic", [aggregate(0.5, ["atomic-cluster"])]),
            true,
          );
          assert.deepEqual(await pendingIds(client), []);
        },
      );

      await t.test("deduplicates enqueues and acknowledges a replayed observation", async () => {
        await reset(client);
        const older = new Date(Date.now() - 1_000).toISOString();
        const newer = new Date().toISOString();
        await enqueue(client, [
          observation("replay-cluster", -0.2, older),
          observation("replay-cluster", 0.7, newer),
        ]);
        const { rows: pendingRows } = await client.query(
          "SELECT score, published_at FROM public.company_sentiment_pending",
        );
        assert.equal(pendingRows.length, 1);
        assert.equal(Number(pendingRows[0].score), 0.7);
        assert.equal(pendingRows[0].published_at.toISOString(), newer);
        assert.equal(await acquire(client, "holder-replay"), true);
        assert.equal(
          await apply(client, "holder-replay", [aggregate(0.7, ["replay-cluster"])]),
          true,
        );
        assert.deepEqual(await pendingIds(client), []);
        await enqueue(client, [observation("replay-cluster", 0.7)]);
        assert.equal(
          await apply(client, "holder-replay", [aggregate(0.7, ["replay-cluster"])]),
          true,
        );
        assert.deepEqual(await pendingIds(client), []);
        const { rows: aggregateRows } = await client.query(
          "SELECT score, scored_cluster_ids FROM public.company_sentiment",
        );
        assert.equal(Number(aggregateRows[0].score), 0.7);
        assert.deepEqual(
          aggregateRows[0].scored_cluster_ids.map(({ id }) => id),
          ["replay-cluster"],
        );
      });

      await t.test(
        "keeps distinct pending observations inserted by a concurrent client",
        async () => {
          await reset(client);
          await enqueue(client, [observation("acknowledged"), observation("already-pending")]);
          assert.equal(await acquire(client, "holder-concurrent"), true);
          const writer = await connect();
          let writerOpen = false;
          let applyOpen = false;
          try {
            await writer.query("BEGIN");
            writerOpen = true;
            await enqueue(writer, [observation("concurrent-pending")]);
            await client.query("BEGIN");
            applyOpen = true;
            assert.equal(
              await apply(client, "holder-concurrent", [aggregate(0.4, ["acknowledged"])]),
              true,
            );
            await writer.query("COMMIT");
            writerOpen = false;
            await client.query("COMMIT");
            applyOpen = false;
            assert.deepEqual(await pendingIds(client), ["already-pending", "concurrent-pending"]);
          } finally {
            if (applyOpen) await client.query("ROLLBACK");
            if (writerOpen) await writer.query("ROLLBACK");
            await writer.end();
          }
        },
      );

      await t.test(
        "holds the lease row through apply so takeover cannot race its write",
        async () => {
          await reset(client);
          assert.equal(await acquire(client, "holder-first"), true);
          const successor = await connect();
          let transactionOpen = false;
          let takeover;
          try {
            const { rows: firstPidRows } = await client.query("SELECT pg_backend_pid() AS pid");
            const { rows: successorPidRows } = await successor.query(
              "SELECT pg_backend_pid() AS pid",
            );
            await client.query("BEGIN");
            transactionOpen = true;
            assert.equal(
              await apply(client, "holder-first", [aggregate(0.2, ["first-cluster"])]),
              true,
            );
            // Simulate the lease expiring after the guarded write begins, before commit.
            await client.query(
              "UPDATE public.company_sentiment_lock SET expires_at = clock_timestamp() - interval '1 second' WHERE id = 'singleton'",
            );
            takeover = acquire(successor, "holder-second");
            await waitUntilBlocked(client, successorPidRows[0].pid, firstPidRows[0].pid);
            await client.query("COMMIT");
            transactionOpen = false;
            assert.equal(await takeover, true);
            assert.equal(
              await apply(client, "holder-first", [aggregate(-0.9, ["stale-cluster"])]),
              false,
            );
            const { rows } = await client.query(
              "SELECT score FROM public.company_sentiment WHERE company_key = 'ticker:AAPL'",
            );
            assert.equal(Number(rows[0].score), 0.2);
          } finally {
            if (transactionOpen) await client.query("ROLLBACK");
            if (takeover) await takeover.catch(() => {});
            await successor.end();
          }
        },
      );

      await t.test(
        "merges stored URL duplicates without losing links or sentiment history",
        async () => {
          await reset(client);
          await client.query("DROP INDEX IF EXISTS public.news_clusters_article_url_unique");
          await client.query("ALTER TABLE public.news_clusters DROP COLUMN IF EXISTS article_url");

          const url = "https://example.com/articles/earnings";
          const canonicalId = "11111111-1111-4111-8111-111111111111";
          const duplicateId = "22222222-2222-4222-8222-222222222222";
          const otherId = "33333333-3333-4333-8333-333333333333";
          const portfolioA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
          const portfolioB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
          const oldUpdatedAt = "2026-08-01T00:00:00.000Z";
          const oldScoredAt = "2026-08-01T01:00:00Z";
          const newScoredAt = "2026-08-02T01:00:00Z";
          const oldPublishedAt = "2026-08-01T00:30:00Z";
          const newPublishedAt = "2026-08-02T00:30:00Z";
          await client.query("INSERT INTO public.portfolios (id) VALUES ($1), ($2)", [
            portfolioA,
            portfolioB,
          ]);

          const insertCluster = async (
            id,
            key,
            article,
            seeAlso,
            entities,
            sentiments,
            fetchedAt,
          ) => {
            await client.query(
              `INSERT INTO public.news_clusters
              (id, cluster_key, primary_article, see_also, entities, sentiments,
               published_at, fetched_at, expires_at)
             VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb,
                     '2026-08-01T00:00:00Z', $7, $7::timestamptz + interval '3 days')`,
              [
                id,
                key,
                JSON.stringify(article),
                JSON.stringify(seeAlso),
                JSON.stringify(entities),
                JSON.stringify(sentiments),
                fetchedAt,
              ],
            );
          };
          await insertCluster(
            canonicalId,
            "exa-document-42",
            {
              url,
              title: "Canonical headline",
              snippet: "",
              source: "example.com",
              legacy_provider_id: "42",
            },
            [{ title: "Related A", url: "https://example.com/a" }],
            { tickers: ["AAPL"], isins: [], countries: [], sectors: [] },
            [{ company_key: "ticker:AAPL", score: 0.2, rationale: "Canonical score" }],
            "2026-08-01T01:00:00Z",
          );
          await insertCluster(
            duplicateId,
            url,
            { url, title: "Provider headline", source: "example.com", snippet: "Fresh summary" },
            [{ title: "Related B", url: "https://example.com/b" }],
            { tickers: ["MSFT"], isins: [], countries: ["US"], sectors: ["Technology"] },
            [
              { company_key: "ticker:AAPL", score: -0.6, rationale: "Duplicate score" },
              { company_key: "ticker:MSFT", score: 0.7, rationale: "Second company" },
            ],
            "2026-08-02T01:00:00Z",
          );

          await client.query(
            `INSERT INTO public.portfolio_news_matches
             (portfolio_id, cluster_id, score, match_reason, created_at)
           VALUES
             ($1, $3, 0.5, '{"matched_tickers":["AAPL"]}', '2026-08-01T01:00:00Z'),
             ($1, $4, 0.8, '{"matched_topics":["tech"]}', '2026-08-02T01:00:00Z'),
             ($2, $4, 0.6, '{"matched_tickers":["MSFT"]}', '2026-08-02T01:00:00Z')`,
            [portfolioA, portfolioB, canonicalId, duplicateId],
          );
          await client.query(
            `INSERT INTO public.company_sentiment
             (company_key, company_name, score, trend, evidence_cluster_ids,
              scored_cluster_ids, updated_at)
           VALUES ('ticker:AAPL', 'Apple', 0.37, 'up', $1::jsonb, $2::jsonb, $3)`,
            [
              JSON.stringify([duplicateId, canonicalId, otherId]),
              JSON.stringify([
                { id: duplicateId, scoredAt: newScoredAt, publishedAt: newPublishedAt },
                { id: canonicalId, scoredAt: oldScoredAt, publishedAt: oldPublishedAt },
              ]),
              oldUpdatedAt,
            ],
          );
          await client.query(
            `INSERT INTO public.company_sentiment_pending
             (company_key, cluster_id, company_name, score, rationale, published_at, observed_at)
           VALUES
             ('ticker:AAPL', $1, 'Apple', 0.4, 'old duplicate', now(), now() - interval '2 hours'),
             ('ticker:AAPL', $2, 'Apple', 0.8, 'new canonical', now(), now() - interval '1 hour'),
             ('ticker:MSFT', $1, 'Microsoft', 0.3, 'distinct company', now(), now())`,
            [duplicateId, canonicalId],
          );

          await installNewsUrlMigration(client);
          const { rows: clusters } = await client.query(
            `SELECT id::text, cluster_key, article_url, primary_article, see_also,
                  entities, sentiments
             FROM public.news_clusters WHERE article_url = $1`,
            [url],
          );
          assert.equal(clusters.length, 1);
          assert.equal(clusters[0].id, canonicalId);
          assert.equal(clusters[0].cluster_key, "exa-document-42");
          assert.equal(clusters[0].primary_article.title, "Canonical headline");
          assert.equal(clusters[0].primary_article.legacy_provider_id, "42");
          assert.equal(clusters[0].primary_article.snippet, "Fresh summary");
          assert.deepEqual(clusters[0].see_also.map(({ url: relatedUrl }) => relatedUrl).sort(), [
            "https://example.com/a",
            "https://example.com/b",
          ]);
          assert.deepEqual(clusters[0].entities.tickers, ["AAPL", "MSFT"]);
          assert.deepEqual(clusters[0].entities.sectors, ["Technology"]);
          assert.deepEqual(clusters[0].sentiments.map(({ company_key: key }) => key).sort(), [
            "ticker:AAPL",
            "ticker:MSFT",
          ]);
          assert.equal(
            clusters[0].sentiments.find(({ company_key: key }) => key === "ticker:AAPL").score,
            0.2,
          );

          const { rows: links } = await client.query(
            `SELECT portfolio_id::text, cluster_id::text, score, match_reason
             FROM public.portfolio_news_matches ORDER BY portfolio_id`,
          );
          assert.equal(links.length, 2);
          assert.deepEqual(
            links.map((link) => link.cluster_id),
            [canonicalId, canonicalId],
          );
          assert.equal(Number(links[0].score), 0.8);
          assert.deepEqual(links[0].match_reason.matched_tickers, ["AAPL"]);
          assert.deepEqual(links[0].match_reason.matched_topics, ["tech"]);
          assert.equal(links[1].portfolio_id, portfolioB);

          const { rows: ledgerRows } = await client.query(
            `SELECT score, trend, updated_at, evidence_cluster_ids, scored_cluster_ids
             FROM public.company_sentiment WHERE company_key = 'ticker:AAPL'`,
          );
          assert.equal(Number(ledgerRows[0].score), 0.37);
          assert.equal(ledgerRows[0].trend, "up");
          assert.equal(ledgerRows[0].updated_at.toISOString(), oldUpdatedAt);
          assert.deepEqual(ledgerRows[0].evidence_cluster_ids, [canonicalId, otherId]);
          assert.deepEqual(
            ledgerRows[0].scored_cluster_ids.map(({ id }) => id),
            [canonicalId],
          );
          assert.deepEqual(ledgerRows[0].scored_cluster_ids, [
            { id: canonicalId, scoredAt: newScoredAt, publishedAt: newPublishedAt },
          ]);

          const { rows: pending } = await client.query(
            `SELECT company_key, cluster_id, score FROM public.company_sentiment_pending
             ORDER BY company_key`,
          );
          assert.deepEqual(
            pending.map((row) => row.cluster_id),
            [canonicalId, canonicalId],
          );
          assert.equal(Number(pending[0].score), 0.8);
          assert.equal(Number(pending[1].score), 0.3);

          await assert.rejects(
            client.query(
              `INSERT INTO public.news_clusters
               (cluster_key, primary_article, published_at, expires_at)
             VALUES ('another-provider-key', $1::jsonb, now(), now() + interval '2 days')`,
              [JSON.stringify({ url })],
            ),
            (error) => error.code === "23505",
          );
        },
      );

      await t.test("serializes concurrent inserts for one exact article URL", async () => {
        await reset(client);
        const first = await connect();
        const second = await connect();
        const url = "https://example.com/articles/concurrent";
        let firstOpen = false;
        let competingInsert;
        try {
          const { rows: firstPidRows } = await first.query("SELECT pg_backend_pid() AS pid");
          const { rows: secondPidRows } = await second.query("SELECT pg_backend_pid() AS pid");
          await first.query("BEGIN");
          firstOpen = true;
          await first.query(
            `INSERT INTO public.news_clusters
               (cluster_key, primary_article, published_at, expires_at)
             VALUES ('provider-one', $1::jsonb, now(), now() + interval '2 days')`,
            [JSON.stringify({ url })],
          );
          competingInsert = second.query(
            `INSERT INTO public.news_clusters
               (cluster_key, primary_article, published_at, expires_at)
             VALUES ('provider-two', $1::jsonb, now(), now() + interval '2 days')`,
            [JSON.stringify({ url })],
          );
          await waitUntilBlocked(first, secondPidRows[0].pid, firstPidRows[0].pid);
          await first.query("COMMIT");
          firstOpen = false;
          await assert.rejects(competingInsert, (error) => error.code === "23505");
          const { rows } = await client.query(
            "SELECT cluster_key FROM public.news_clusters WHERE article_url = $1",
            [url],
          );
          assert.deepEqual(
            rows.map((row) => row.cluster_key),
            ["provider-one"],
          );
        } finally {
          if (firstOpen) await first.query("ROLLBACK");
          if (competingInsert) await competingInsert.catch(() => {});
          await first.end();
          await second.end();
        }
      });
    } finally {
      await client.end();
    }
  },
);
