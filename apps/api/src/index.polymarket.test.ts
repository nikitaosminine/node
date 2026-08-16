import { beforeEach, describe, expect, it, vi } from "vitest";

const { requirePortfolioAccess } = vi.hoisted(() => ({
  requirePortfolioAccess: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

vi.mock("./auth", () => ({
  adminDb: vi.fn(),
  assertPortfolioAccess: vi.fn(),
  requireAuth: vi.fn(),
  requirePortfolioAccess,
}));

import worker from "./index";

const env = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key",
  SUPABASE_ANON_KEY: "anon-key",
} as never;

function marketRow(overrides: Record<string, unknown> = {}) {
  return {
    is_pinned: false,
    score: 0.9,
    reason: "macro",
    polymarket_markets: {
      condition_id: "cond-x",
      event_id: "evt-x",
      event_slug: "slug-x",
      event_title: "Event",
      market_slug: "market-x",
      question: "Will the Fed cut rates in 2027?",
      tags: [{ id: 100328 }],
      outcomes: ["Yes", "No"],
      outcome_prices: [0.6, 0.4],
      liquidity: 5000,
      volume_24hr: 500,
      start_date: "2026-01-01T00:00:00Z",
      end_date: "2027-12-31T00:00:00Z",
      image: null,
      active: true,
      fetched_at: "2026-08-01T00:00:00Z",
    },
    ...overrides,
  };
}

function fakeDb(rows: unknown[]) {
  return {
    from(table: string) {
      const builder: Record<string, (...args: unknown[]) => unknown> = {};
      for (const method of ["select", "eq", "or", "order"]) {
        builder[method] = () => builder;
      }
      builder.limit = () => Promise.resolve({ data: rows, error: null });
      if (table !== "portfolio_polymarket_matches") {
        throw new Error(`Unexpected table: ${table}`);
      }
      return builder;
    },
  };
}

describe("GET /api/feed/polymarket", () => {
  beforeEach(() => {
    requirePortfolioAccess.mockReset();
  });

  it("does not deliver an ineligible cached match", async () => {
    const rows = [
      marketRow({
        polymarket_markets: {
          ...marketRow().polymarket_markets,
          condition_id: "illiquid",
          liquidity: 333,
        },
      }),
      marketRow({
        polymarket_markets: {
          ...marketRow().polymarket_markets,
          condition_id: "eligible",
        },
      }),
    ];
    requirePortfolioAccess.mockResolvedValue({
      userId: "user-1",
      token: "token-1",
      db: fakeDb(rows),
    });

    const response = await worker.fetch(
      new Request("https://api.test/api/feed/polymarket?portfolio_id=portfolio-1", {
        headers: { Authorization: "Bearer token-1" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pinned: Array<{ polymarket_markets: { condition_id: string } }>;
      rotating: Array<{ polymarket_markets: { condition_id: string } }>;
    };
    expect(body.rotating.map((row) => row.polymarket_markets.condition_id)).toEqual(["eligible"]);
  });
});
