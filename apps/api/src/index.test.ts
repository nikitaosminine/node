import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbFrom, dbRpc } = vi.hoisted(() => ({ dbFrom: vi.fn(), dbRpc: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: dbFrom, rpc: dbRpc })),
}));
vi.mock("./feeds/recaps", () => ({ generateRecap: vi.fn().mockResolvedValue(undefined) }));

import worker, {
  researchPortfolioEtfGeography,
  type Env,
  withInvocationSubrequestBudget,
} from "./index";

const env = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_KEY: "service-key",
  GROK_SUB_API_KEY: "grok-sub-key",
} as unknown as Env;

const holdingRow = {
  id: "holding-vwce",
  ticker: "VWCE.DE",
  name: "Vanguard FTSE All-World",
  isin: "IE00BK5BQT80",
  asset_type: "ETF",
  quantity: 10,
  purchase_price: 100,
  fees: 0,
};

function geographyDb({
  existingAllocations,
}: {
  existingAllocations: Array<Record<string, unknown>>;
}) {
  const holdingsUpdates: Array<Record<string, unknown>> = [];
  const allocationDeletes: unknown[] = [];
  const allocationInserts: Array<Array<Record<string, unknown>>> = [];
  const jobWrites: Array<Record<string, unknown>> = [];

  dbFrom.mockImplementation((table: string) => {
    if (table === "holdings") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: [holdingRow], error: null }),
        })),
        update: vi.fn((values: Record<string, unknown>) => {
          holdingsUpdates.push(values);
          return { eq: vi.fn().mockResolvedValue({ error: null }) };
        }),
      };
    }
    if (table === "holding_geography_allocations") {
      return {
        select: vi.fn(() => ({
          in: vi.fn().mockResolvedValue({ data: existingAllocations, error: null }),
        })),
        delete: vi.fn(() => ({
          eq: vi.fn(async (_column: string, value: unknown) => {
            allocationDeletes.push(value);
            return { error: null };
          }),
        })),
        insert: vi.fn(async (rows: Array<Record<string, unknown>>) => {
          allocationInserts.push(rows);
          return { error: null };
        }),
      };
    }
    if (table === "geography_research_jobs") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: { attempts: 1 }, error: null }),
          })),
        })),
        upsert: vi.fn(async (row: Record<string, unknown>) => {
          jobWrites.push(row);
          return { error: null };
        }),
        update: vi.fn((values: Record<string, unknown>) => {
          jobWrites.push(values);
          return { eq: vi.fn().mockResolvedValue({ error: null }) };
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  return { holdingsUpdates, allocationDeletes, allocationInserts, jobWrites };
}

function stubGrokGeographyResearch(payload: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "resp-1", output_text: JSON.stringify(payload) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
}

beforeEach(() => {
  dbFrom.mockReset();
  dbRpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("researchPortfolioEtfGeography re-research", () => {
  const existingAllocations = [
    { holding_id: "holding-vwce", source: "llm_web", updated_at: "2026-01-01T00:00:00Z" },
  ];

  it("preserves existing geography when a re-research run returns no allocations", async () => {
    const db = geographyDb({ existingAllocations });
    stubGrokGeographyResearch({
      allocations: [],
      confidence: 0.2,
      uses_domicile_or_collateral: false,
      notes: "could not find country weights",
      sources: [],
    });

    const result = await researchPortfolioEtfGeography(env, "portfolio-1", {
      reason: "polymarket_constituents",
    });

    expect(result).toEqual({ checked: 1, resolved: 0, unresolved: 1 });
    expect(db.holdingsUpdates).toEqual([]);
    expect(db.allocationDeletes).toEqual([]);
    expect(db.allocationInserts).toEqual([]);
    expect(db.jobWrites.at(-1)).toMatchObject({
      status: "completed",
      last_error: expect.stringContaining("below the 0.65 threshold"),
    });
  });

  it("still replaces existing geography when a re-research run returns allocations", async () => {
    const db = geographyDb({ existingAllocations });
    stubGrokGeographyResearch({
      allocations: [
        { country_code: "US", country_name: "United States", weight_pct: 60 },
        { country_code: "JP", country_name: "Japan", weight_pct: 40 },
      ],
      confidence: 0.9,
      uses_domicile_or_collateral: false,
      notes: "issuer factsheet",
      sources: [],
    });

    const result = await researchPortfolioEtfGeography(env, "portfolio-1", {
      reason: "polymarket_constituents",
    });

    expect(result).toEqual({ checked: 1, resolved: 1, unresolved: 0 });
    expect(db.holdingsUpdates).toEqual([
      expect.objectContaining({ country_code: "US", geography_source: "llm_web" }),
    ]);
    expect(db.allocationDeletes).toEqual(["holding-vwce"]);
    expect(db.allocationInserts).toEqual([
      [
        expect.objectContaining({ holding_id: "holding-vwce", country_code: "US", weight_pct: 60 }),
        expect.objectContaining({ holding_id: "holding-vwce", country_code: "JP", weight_pct: 40 }),
      ],
    ]);
    expect(db.jobWrites.at(-1)).toMatchObject({ status: "completed", last_error: null });
  });

  it("records an unknown-geography result as before when the holding had no coverage", async () => {
    const db = geographyDb({ existingAllocations: [] });
    stubGrokGeographyResearch({
      allocations: [],
      confidence: 0.2,
      uses_domicile_or_collateral: false,
      notes: "could not find country weights",
      sources: [],
    });

    const result = await researchPortfolioEtfGeography(env, "portfolio-1", {
      reason: "polymarket_constituents",
    });

    expect(result).toEqual({ checked: 1, resolved: 0, unresolved: 1 });
    expect(db.holdingsUpdates).toEqual([
      expect.objectContaining({ country_code: null, geography_source: "unknown" }),
    ]);
    expect(db.allocationDeletes).toEqual(["holding-vwce"]);
    expect(db.allocationInserts).toEqual([]);
  });
});

describe("withInvocationSubrequestBudget", () => {
  it("counts fetches shared by all scheduled fanouts", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await withInvocationSubrequestBudget(async (budget) => {
      expect(globalThis.fetch).toBe(fetchMock);
      expect(budget.remaining()).toBe(50);
      await budget.fetch("https://example.test");
      expect(budget.remaining()).toBe(49);
      for (let i = 0; i < 49; i++) {
        await budget.fetch("https://example.test");
      }
      await expect(budget.fetch("https://example.test")).rejects.toThrow(
        "scheduled invocation subrequest budget exhausted",
      );
      await fetch("https://example.test");
    });

    expect(fetchMock).toHaveBeenCalledTimes(51);
    expect(globalThis.fetch).toBe(fetchMock);
  });
});

describe("scheduled news queue handoff", () => {
  it("enqueues news before the shared scheduled work can consume its budget", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    const queueEnv = {
      ...env,
      RECAP_QUEUE: { send: vi.fn(async (message: unknown) => sent.push(message)) },
    } as unknown as Env;

    await worker.scheduled(
      {
        cron: "30 16 * * 2-6",
        scheduledTime: Date.UTC(2026, 8, 21, 16, 30),
      } as ScheduledController,
      queueEnv,
      {} as ExecutionContext,
    );

    expect(sent).toEqual([
      { type: "news_fanout", scheduledTime: Date.UTC(2026, 8, 21, 16, 30) },
    ]);
  });

  it("retries a news queue delivery when the provider key is absent", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue(
      {
        messages: [
          {
            body: { type: "news_fanout", scheduledTime: Date.UTC(2026, 8, 21, 16, 30) },
            ack,
            retry,
          },
        ],
      } as unknown as Parameters<typeof worker.queue>[0],
      env,
    );

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("safely acknowledges duplicate successful deliveries", async () => {
    const holdingsQuery = {
      gt: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    dbFrom.mockImplementation((table: string) => {
      if (table === "holdings") return { select: vi.fn(() => holdingsQuery) };
      if (table === "news_clusters") {
        return {
          delete: vi.fn(() => ({
            lt: vi.fn().mockResolvedValue({ count: 0, error: null }),
          })),
        };
      }
      if (table === "company_sentiment_pending") {
        return { select: vi.fn(() => ({ order: vi.fn(() => ({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) })) })) };
      }
      if (table === "company_sentiment_lock") {
        return { delete: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) })) };
      }
      throw new Error(`unexpected table ${table}`);
    });
    dbRpc.mockResolvedValue({ data: true, error: null });
    const queueEnv = { ...env, FIRECRAWL_API_KEY: "fc-key" } as Env;
    const ack1 = vi.fn();
    const retry1 = vi.fn();
    const ack2 = vi.fn();
    const retry2 = vi.fn();
    const body = { type: "news_fanout", scheduledTime: Date.UTC(2026, 8, 21, 6, 30) } as const;
    const makeBatch = (ack: () => void, retry: () => void) =>
      ({ messages: [{ body, ack, retry }] }) as unknown as Parameters<typeof worker.queue>[0];

    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 21, 21, 0));
    try {
      await worker.queue(makeBatch(ack1, retry1), queueEnv);
      await worker.queue(makeBatch(ack2, retry2), queueEnv);
    } finally {
      vi.useRealTimers();
    }

    expect(ack1).toHaveBeenCalledOnce();
    expect(ack2).toHaveBeenCalledOnce();
    expect(retry1).not.toHaveBeenCalled();
    expect(retry2).not.toHaveBeenCalled();
  });

  it("retries a total provider failure instead of acknowledging it", async () => {
    const holdingsQuery = {
      gt: vi.fn().mockResolvedValue({
        data: [
          {
            id: "holding-1",
            ticker: "ACME",
            isin: null,
            asset_type: "EQUITY",
            name: "Acme Corp",
            quantity: 1,
            portfolio_id: "portfolio-1",
          },
        ],
        error: null,
      }),
    };
    dbFrom.mockImplementation((table: string) => {
      if (table === "holdings") return { select: vi.fn(() => holdingsQuery) };
      if (table === "news_clusters") {
        return {
          delete: vi.fn(() => ({
            lt: vi.fn().mockResolvedValue({ count: 0, error: null }),
          })),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider down", { status: 500 })));
    const ack = vi.fn();
    const retry = vi.fn();

    vi.useFakeTimers();
    try {
      const delivery = worker.queue(
        {
          messages: [
            {
              body: { type: "news_fanout", scheduledTime: Date.UTC(2026, 8, 21, 16, 30) },
              ack,
              retry,
            },
          ],
        } as unknown as Parameters<typeof worker.queue>[0],
        { ...env, FIRECRAWL_API_KEY: "fc-key" } as Env,
      );
      await vi.runAllTimersAsync();
      await delivery;
    } finally {
      vi.useRealTimers();
    }

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps recap queue messages on their existing acknowledgement path", async () => {
    dbFrom.mockImplementation((table: string) => {
      if (table !== "recaps") throw new Error(`unexpected table ${table}`);
      return {
        update: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ error: null }),
          })),
        })),
      };
    });
    const ack = vi.fn();
    const retry = vi.fn();

    await worker.queue(
      {
        messages: [{ body: { recapId: "recap-1" }, ack, retry }],
      } as unknown as Parameters<typeof worker.queue>[0],
      env,
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
