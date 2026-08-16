import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbFrom } = vi.hoisted(() => ({ dbFrom: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: dbFrom })),
}));

import { researchPortfolioEtfGeography, type Env } from "./index";

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

function geographyDb({ existingAllocations }: { existingAllocations: Array<Record<string, unknown>> }) {
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
