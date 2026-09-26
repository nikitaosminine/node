import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { polymarketFanout } = vi.hoisted(() => ({ polymarketFanout: vi.fn() }));
vi.mock("./feeds/polymarket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./feeds/polymarket")>()),
  runPolymarketFanout: polymarketFanout,
}));

import worker, { type Env } from "./index";

const scheduledTime = Date.UTC(2026, 8, 22, 8, 5);
const baseEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_KEY: "test-service-key",
} as Env;

function fanoutResult(overrides: Record<string, unknown> = {}) {
  return {
    marketsUpserted: 1,
    marketsDeactivated: 0,
    portfoliosProcessed: 5,
    portfoliosSkipped: 0,
    skippedPortfolioIds: [],
    nextPortfolioCursor: null,
    curation: {
      model: "test",
      reasoningEffort: "medium",
      forceRescore: false,
      grokRuns: 0,
      cacheHits: 5,
      fallbacks: 0,
      portfoliosWithoutHoldings: 0,
      rotatingMatchesWritten: 0,
    },
    errors: [],
    ...overrides,
  };
}

function batch(body: unknown, ack = vi.fn(), retry = vi.fn()) {
  return {
    value: { messages: [{ body, ack, retry }] } as unknown as Parameters<typeof worker.queue>[0],
    ack,
    retry,
  };
}

beforeEach(() => {
  polymarketFanout.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("scheduled Polymarket queue isolation", () => {
  it("enqueues a refresh even when 24 idempotent agent runs exhaust the cron budget", async () => {
    const portfolios = Array.from({ length: 24 }, (_, i) => ({ id: `p-${i}`, user_id: `u-${i}` }));
    const existingRuns = new Map<string, Record<string, unknown>>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (url.hostname === "gamma.example") return Response.json([]);
      if (url.pathname === "/rest/v1/portfolios") return Response.json(portfolios);
      if (url.pathname === "/rest/v1/agent_user_settings") {
        return Response.json(
          portfolios.map((p) => ({ user_id: p.user_id, timezone: "UTC", global_runs_per_day: 1 })),
        );
      }
      if (url.pathname === "/rest/v1/agent_portfolio_settings") return Response.json([]);
      if (url.pathname === "/rest/v1/agent_runs" && method === "POST") {
        const row = JSON.parse(String(init?.body)) as Record<string, unknown>;
        existingRuns.set(String(row.idempotency_key), { ...row, id: `run-${row.portfolio_id}` });
        return Response.json({ code: "23505", message: "existing scheduled run" }, { status: 409 });
      }
      if (url.pathname === "/rest/v1/agent_runs" && method === "GET") {
        const key = url.searchParams.get("idempotency_key")?.slice(3) ?? "";
        return Response.json(existingRuns.get(key));
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    polymarketFanout.mockImplementation(async (_env, options) => {
      await options.fetch("https://gamma.example/events");
      return fanoutResult();
    });
    const sent: Array<{ body: unknown; fetchCount: number }> = [];
    const sendRun = vi.fn().mockResolvedValue(undefined);
    const env = {
      ...baseEnv,
      AGENT_RUNS_QUEUE: { send: sendRun },
      RECAP_QUEUE: {
        send: vi.fn(async (body: unknown) => {
          sent.push({ body, fetchCount: fetchMock.mock.calls.length });
        }),
      },
    } as unknown as Env;

    await worker.scheduled(
      { cron: "5 * * * *", scheduledTime } as ScheduledController,
      env,
      {} as ExecutionContext,
    );

    expect(fetchMock).toHaveBeenCalledTimes(50);
    expect(sendRun).toHaveBeenCalledTimes(23);
    expect(sent).toContainEqual({
      body: { type: "polymarket_fanout", scheduledTime },
      fetchCount: 0,
    });
    expect(polymarketFanout).not.toHaveBeenCalled();

    const delivery = batch({ type: "polymarket_fanout", scheduledTime });
    await worker.queue(delivery.value, env);
    expect(polymarketFanout).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(51);
    expect(delivery.ack).toHaveBeenCalledOnce();
    expect(delivery.retry).not.toHaveBeenCalled();
  }, 30_000);

  it("retries a failed refresh and acknowledges its successful redelivery", async () => {
    polymarketFanout
      .mockRejectedValueOnce(new Error("Gamma unavailable"))
      .mockResolvedValueOnce(fanoutResult());
    const first = batch({ type: "polymarket_fanout", scheduledTime });
    const second = batch({ type: "polymarket_fanout", scheduledTime });
    await worker.queue(first.value, baseEnv);
    await worker.queue(second.value, baseEnv);
    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(second.retry).not.toHaveBeenCalled();
  });

  it("continues after five portfolios and retries skipped portfolios separately", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { ...baseEnv, RECAP_QUEUE: { send } } as unknown as Env;
    polymarketFanout.mockResolvedValueOnce(
      fanoutResult({
        portfoliosProcessed: 4,
        portfoliosSkipped: 1,
        skippedPortfolioIds: ["portfolio-3"],
        nextPortfolioCursor: "portfolio-5",
        errors: ["portfolio portfolio-3: scheduled invocation subrequest budget exhausted"],
      }),
    );
    const delivery = batch({ type: "polymarket_fanout", scheduledTime });
    await worker.queue(delivery.value, env);

    expect(polymarketFanout).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ maxPortfolios: 5 }),
    );
    expect(send).toHaveBeenCalledWith({
      type: "polymarket_fanout",
      scheduledTime,
      portfolioId: "portfolio-3",
    });
    expect(send).toHaveBeenCalledWith({
      type: "polymarket_fanout",
      scheduledTime,
      afterPortfolioId: "portfolio-5",
    });
    expect(delivery.ack).toHaveBeenCalledOnce();
    expect(delivery.retry).not.toHaveBeenCalled();
  });

  it("retries the delivery if a skipped portfolio cannot be queued", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const env = { ...baseEnv, RECAP_QUEUE: { send } } as unknown as Env;
    polymarketFanout.mockResolvedValueOnce(
      fanoutResult({
        portfoliosProcessed: 4,
        portfoliosSkipped: 1,
        skippedPortfolioIds: ["portfolio-3"],
      }),
    );
    const delivery = batch({ type: "polymarket_fanout", scheduledTime });
    await worker.queue(delivery.value, env);
    expect(delivery.retry).toHaveBeenCalledOnce();
    expect(delivery.ack).not.toHaveBeenCalled();
  });

  it("retries an individually skipped portfolio", async () => {
    polymarketFanout.mockResolvedValueOnce(
      fanoutResult({
        portfoliosProcessed: 0,
        portfoliosSkipped: 1,
        skippedPortfolioIds: ["portfolio-3"],
        errors: ["portfolio portfolio-3: Gamma unavailable"],
      }),
    );
    const delivery = batch({
      type: "polymarket_fanout",
      scheduledTime,
      portfolioId: "portfolio-3",
    });
    await worker.queue(delivery.value, baseEnv);
    expect(polymarketFanout).toHaveBeenCalledWith(
      baseEnv,
      expect.objectContaining({ portfolioId: "portfolio-3", maxPortfolios: 5 }),
    );
    expect(delivery.retry).toHaveBeenCalledOnce();
    expect(delivery.ack).not.toHaveBeenCalled();
  });

  it("keeps each queued feed refresh in its own deployed invocation", () => {
    const config = parse(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"));
    const queues = config.queues as {
      producers: Array<{ binding: string; queue: string }>;
      consumers: Array<{ queue: string; max_batch_size?: number }>;
    };
    const producer = queues.producers.find((item) => item.binding === "RECAP_QUEUE");
    expect(producer).toBeDefined();
    expect(queues.consumers.find((item) => item.queue === producer?.queue)?.max_batch_size).toBe(1);
  });
});
