import { describe, expect, it, vi } from "vitest";

// Exercise the real Worker fetch handler for GET /api/polymarket/category with
// a stubbed auth context and Supabase query builder, so the test proves the
// endpoint itself applies the NON_FINANCIAL_RE / isShortTermMarket /
// isNearCertainMarket filter chain (not just that the helpers work in
// isolation).

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

const fromCalls: Array<{ table: string; args: Record<string, unknown[]> }> = [];
let seededRows: unknown[] = [];

function makeFakeDb() {
  return {
    from(table: string) {
      const call = { table, args: {} as Record<string, unknown[]> };
      fromCalls.push(call);
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "contains", "eq", "or", "order"]) {
        builder[method] = (...args: unknown[]) => {
          call.args[method] = args;
          return builder;
        };
      }
      builder.limit = (...args: unknown[]) => {
        call.args.limit = args;
        return Promise.resolve({ data: seededRows, error: null });
      };
      return builder;
    },
  };
}

vi.mock("./auth", () => ({
  adminDb: vi.fn(),
  assertPortfolioAccess: vi.fn(),
  requirePortfolioAccess: vi.fn(),
  requireAuth: vi.fn(async () => ({
    userId: "user-1",
    token: "token-1",
    db: makeFakeDb(),
  })),
}));

import worker from "./index";

const env = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key",
  SUPABASE_ANON_KEY: "anon-key",
} as never;

function marketRow(overrides: Record<string, unknown>) {
  return {
    condition_id: "cond-x",
    event_id: "evt-x",
    event_slug: "slug-x",
    event_title: "Event",
    market_slug: "market-x",
    question: "Will the Fed cut rates in 2026?",
    tags: [{ id: 100328 }],
    outcomes: ["Yes", "No"],
    outcome_prices: [0.6, 0.4],
    liquidity: 1000,
    volume_24hr: 500,
    start_date: "2026-01-01T00:00:00Z",
    end_date: "2026-12-31T00:00:00Z",
    image: null,
    active: true,
    fetched_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("GET /api/polymarket/category", () => {
  it("excludes short-duration, near-certain, and non-financial markets from the response", async () => {
    seededRows = [
      marketRow({
        condition_id: "short-term",
        question: "Will MSFT close $440-$450 this week?",
        start_date: "2026-08-10T00:00:00Z",
        end_date: "2026-08-14T00:00:00Z",
      }),
      marketRow({
        condition_id: "near-certain",
        question: "Will the US default on its debt in 2026?",
        outcome_prices: [0.01, 0.99],
      }),
      marketRow({
        condition_id: "non-financial",
        question: "Will the Super Bowl champion be decided by field goal?",
      }),
      marketRow({
        condition_id: "keeper",
        question: "Will the Fed cut rates in 2026?",
      }),
    ];

    const response = await worker.fetch(
      new Request("https://api.test/api/polymarket/category?tag=finance&limit=30", {
        headers: { Authorization: "Bearer token-1" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ condition_id: string }>;
    expect(body.map((m) => m.condition_id)).toEqual(["keeper"]);

    // The query must fetch start_date so isShortTermMarket has real input.
    const query = fromCalls.find((c) => c.table === "polymarket_markets");
    expect(query).toBeDefined();
    expect(String(query?.args.select?.[0])).toContain("start_date");
  });

  it("keeps normal markets when nothing matches the filters", async () => {
    seededRows = [
      marketRow({ condition_id: "a" }),
      marketRow({ condition_id: "b", outcome_prices: [0.55, 0.45] }),
    ];

    const response = await worker.fetch(
      new Request("https://api.test/api/polymarket/category?tag=economy", {
        headers: { Authorization: "Bearer token-1" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ condition_id: string }>;
    expect(body.map((m) => m.condition_id)).toEqual(["a", "b"]);
  });
});
