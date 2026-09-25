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
    CREATE TABLE IF NOT EXISTS public.news_clusters (id text PRIMARY KEY);
    CREATE OR REPLACE FUNCTION public.update_updated_at_column()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END $$;
  `);
  await client.query(await readFile(join(migrationsDir, files[0]), "utf8"));
}

async function reset(client) {
  await client.query(`
    TRUNCATE public.company_sentiment_pending,
             public.company_sentiment_lock,
             public.company_sentiment,
             public.news_clusters;
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
            "INSERT INTO public.news_clusters (id) VALUES ('bootstrap') RETURNING sentiments",
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
    } finally {
      await client.end();
    }
  },
);
