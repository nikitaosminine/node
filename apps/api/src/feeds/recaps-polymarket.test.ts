import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  builder.range = (from, to) =>
    Promise.resolve({
      data: Array.isArray(data) ? data.slice(Number(from), Number(to) + 1) : data,
      error: null,
    });
  return builder;
}

describe("recap Polymarket watch filter", () => {
  const reviewNow = new Date("2026-08-16T00:00:00Z");

  beforeEach(() => {
    dbFrom.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(reviewNow);
  });

  afterEach(() => {
    vi.useRealTimers();
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

    let watchEndDateFilter: unknown[] | undefined;
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
        const watchRows = [
          ...Array.from({ length: 20 }, (_, index) => ({
            is_pinned: false,
            score: 1 - index / 100,
            polymarket_markets: {
              ...eligibleMarket,
              start_date: "2027-12-20T00:00:00Z",
              end_date: "2027-12-31T00:00:00Z",
            },
          })),
          {
            is_pinned: false,
            score: 0.95,
            polymarket_markets: { ...eligibleMarket, liquidity: 333 },
          },
          {
            is_pinned: false,
            score: 0.92,
            polymarket_markets: {
              ...eligibleMarket,
              tags: [{ id: 104152, label: "Finance Up/Down" }],
            },
          },
          { is_pinned: false, score: 0.9, polymarket_markets: eligibleMarket },
        ];
        const builder = chainResult(watchRows);
        let filteredRows = watchRows;
        builder.gt = (...args) => {
          watchEndDateFilter = args;
          filteredRows = filteredRows.filter(
            (row) =>
              typeof row.polymarket_markets.end_date === "string" &&
              row.polymarket_markets.end_date > String(args[1]),
          );
          return builder;
        };
        builder.gte = (...args) => {
          filteredRows = filteredRows.filter(
            (row) => Number(row.polymarket_markets.liquidity) >= Number(args[1]),
          );
          return builder;
        };
        builder.range = (from, to) => {
          return Promise.resolve({
            data: filteredRows.slice(Number(from), Number(to) + 1),
            error: null,
          });
        };
        return builder;
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
    expect(watchEndDateFilter).toEqual(["polymarket_markets.end_date", reviewNow.toISOString()]);
  });
});
