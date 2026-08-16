import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbFrom } = vi.hoisted(() => ({ dbFrom: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: dbFrom })),
}));

import { gatherContext } from "./recaps";

const env = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_KEY: "service-key",
};

function chainResult(data: unknown) {
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ["select", "eq", "gt", "in", "gte", "lte", "order"]) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve({ data, error: null });
  builder.limit = () => Promise.resolve({ data, error: null });
  return builder;
}

describe("recap Polymarket watch filter", () => {
  beforeEach(() => {
    dbFrom.mockReset();
  });

  it("excludes cached matches that fail the shared eligibility gate", async () => {
    const eligibleMarket = {
      question: "Will the Fed cut rates in 2027?",
      event_slug: "fed-rates-2027",
      outcome_prices: [0.6, 0.4],
      start_date: "2026-01-01T00:00:00Z",
      end_date: "2027-01-01T00:00:00Z",
      liquidity: 5000,
      active: true,
    };

    dbFrom.mockImplementation((table: string) => {
      if (table === "portfolios")
        return chainResult({ primary_exchange: "UNKNOWN", cash_value: 0 });
      if (table === "holdings") {
        const builder = chainResult([
          { id: "holding-1", ticker: "AAPL", name: "Apple", quantity: 1, asset_type: "stock" },
        ]);
        builder.gt = () =>
          Promise.resolve({
            data: [
              { id: "holding-1", ticker: "AAPL", name: "Apple", quantity: 1, asset_type: "stock" },
            ],
            error: null,
          });
        return builder;
      }
      if (table === "price_history") {
        const builder = chainResult([
          { yahoo_ticker: "AAPL", date: "2026-08-07", closing_price: 100 },
          { yahoo_ticker: "AAPL", date: "2026-08-10", closing_price: 101 },
          { yahoo_ticker: "AAPL", date: "2026-08-14", closing_price: 102 },
        ]);
        builder.order = () =>
          Promise.resolve({
            data: [
              { yahoo_ticker: "AAPL", date: "2026-08-07", closing_price: 100 },
              { yahoo_ticker: "AAPL", date: "2026-08-10", closing_price: 101 },
              { yahoo_ticker: "AAPL", date: "2026-08-14", closing_price: 102 },
            ],
            error: null,
          });
        return builder;
      }
      if (table === "saved_benchmarks") return chainResult([]);
      if (table === "portfolio_polymarket_matches") {
        return chainResult([
          {
            is_pinned: false,
            score: 0.95,
            polymarket_markets: { ...eligibleMarket, liquidity: 333 },
          },
          { is_pinned: false, score: 0.9, polymarket_markets: eligibleMarket },
        ]);
      }
      if (table === "holding_geography_allocations") {
        const builder = chainResult([]);
        builder.in = () => Promise.resolve({ data: [], error: null });
        return builder;
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const context = await gatherContext(env, {
      id: "recap-1",
      portfolio_id: "portfolio-1",
      user_id: "user-1",
      type: "weekly",
      period_start: "2026-08-10",
      period_end: "2026-08-14",
    });

    expect(context?.watch).toEqual([
      {
        question: eligibleMarket.question,
        url: "https://polymarket.com/event/fed-rates-2027",
        topProbability: 0.6,
      },
    ]);
  });
});
