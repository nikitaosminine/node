import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { MARKET_SECTOR_LABELS } from "./market-topics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EtfConstituent {
  ticker: string;
  name: string;
  weight_pct: number;
  country_code: string;
  sector: string;
}

export interface EtfTopSector {
  sector: string;
  weight_pct: number;
}

export interface EtfConstituentsData {
  constituents: EtfConstituent[];
  top_sectors: EtfTopSector[];
  as_of_date: string | null;
  source: string;
  confidence: number;
  evidence: Record<string, unknown>;
}

// Raw shape returned by the LLM inside the extended geography JSON blob
interface RawConstituent {
  ticker?: unknown;
  name?: unknown;
  weight_pct?: unknown;
  country_code?: unknown;
  sector?: unknown;
}

// ---------------------------------------------------------------------------
// Prompt extension
// Appended to buildEtfGeographyResearchPrompt so both requests go in one
// LLM call. The schema is added as an extra key on the existing JSON object.
// ---------------------------------------------------------------------------

export function etfConstituentsPromptExtension(): string {
  return [
    "",
    "Additionally, find the Top-10 holdings (constituents) of this ETF by weight.",
    `Include each constituent's ticker, full name, weight_pct (%), country of domicile (ISO-3166 alpha-2), and sector chosen from exactly this list: ${MARKET_SECTOR_LABELS.join(", ")} (map canonical GICS names like "Health Care" or "Information Technology" to the closest listed label).`,
    "Add a key `top_constituents` to the JSON response (array of up to 10 objects):",
    '  "top_constituents": [{ "ticker": "AAPL", "name": "Apple Inc.", "weight_pct": 8.2, "country_code": "US", "sector": "Technology" }]',
    "If you cannot find constituent data, return an empty array for `top_constituents`.",
    "Constituent data is optional — do not let missing constituent data affect the allocations or confidence fields.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Extraction + normalisation
// ---------------------------------------------------------------------------

function isValidConstituent(c: unknown): c is RawConstituent {
  return typeof c === "object" && c !== null;
}

export function extractAndNormalizeConstituents(
  rawJson: Record<string, unknown>,
  meta: { responseId: string | null; webSearchModel: string },
): EtfConstituentsData | null {
  const raw = rawJson.top_constituents;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const constituents: EtfConstituent[] = [];
  for (const item of raw) {
    if (!isValidConstituent(item)) continue;
    const ticker = String(item.ticker ?? "").trim().toUpperCase();
    const name = String(item.name ?? "").trim();
    const weightPct = Number(item.weight_pct ?? 0);
    const countryCode = String(item.country_code ?? "").trim().toUpperCase();
    const sector = String(item.sector ?? "").trim();
    if (!ticker || !name || !Number.isFinite(weightPct) || weightPct <= 0) continue;
    constituents.push({ ticker, name, weight_pct: weightPct, country_code: countryCode, sector });
  }

  if (constituents.length === 0) return null;

  const top_sectors = rollUpSectors(constituents);

  return {
    constituents,
    top_sectors,
    as_of_date: typeof rawJson.as_of_date === "string" ? rawJson.as_of_date : null,
    source: "llm_web",
    confidence: Number.isFinite(Number(rawJson.confidence)) ? Number(rawJson.confidence) : 0,
    evidence: {
      responseId: meta.responseId,
      webSearchModel: meta.webSearchModel,
      retrieved: constituents.length,
    },
  };
}

export function rollUpSectors(constituents: EtfConstituent[]): EtfTopSector[] {
  const sectorMap = new Map<string, number>();
  for (const c of constituents) {
    const sector = c.sector || "Unknown";
    sectorMap.set(sector, (sectorMap.get(sector) ?? 0) + c.weight_pct);
  }
  return Array.from(sectorMap.entries())
    .map(([sector, weight_pct]) => ({ sector, weight_pct: Math.round(weight_pct * 100) / 100 }))
    .sort((a, b) => b.weight_pct - a.weight_pct);
}

// ---------------------------------------------------------------------------
// TTL check
// Returns null when the registry row is fresh (< ttlDays old based on
// updated_at — the fetch timestamp, not as_of_date which is the data date).
// Returns the existing data when fresh, so callers can skip the LLM call.
// In practice V1 always upserts as a side-effect of the geography job, so
// this function is used by the news worker to decide whether to wait.
// ---------------------------------------------------------------------------

export async function getEtfConstituentsIfFresh(
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string },
  etfIsin: string,
  ttlDays = 30,
): Promise<EtfConstituentsData | null> {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("etf_constituents")
    .select("constituents,top_sectors,as_of_date,source,confidence,evidence,updated_at")
    .eq("etf_isin", etfIsin)
    .gt("updated_at", cutoff)
    .maybeSingle();

  if (error || !data) return null;

  return {
    constituents: Array.isArray(data.constituents) ? (data.constituents as EtfConstituent[]) : [],
    top_sectors: Array.isArray(data.top_sectors) ? (data.top_sectors as EtfTopSector[]) : [],
    as_of_date: typeof data.as_of_date === "string" ? data.as_of_date : null,
    source: String(data.source ?? "llm_web"),
    confidence: Number(data.confidence ?? 0),
    evidence: (data.evidence as Record<string, unknown>) ?? {},
  };
}

// ---------------------------------------------------------------------------
// Upsert
// Called as a fire-and-forget side effect from researchEtfGeography in
// index.ts. Uses the Supabase service-role client passed by the caller to
// avoid re-creating it here (the geography job already has one open).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

export async function upsertEtfConstituents(
  client: AnySupabaseClient,
  etfIsin: string,
  data: EtfConstituentsData,
): Promise<void> {
  const { error } = await client.from("etf_constituents").upsert(
    {
      etf_isin: etfIsin,
      as_of_date: data.as_of_date,
      constituents: data.constituents,
      top_sectors: data.top_sectors,
      source: data.source,
      confidence: data.confidence,
      evidence: data.evidence,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "etf_isin" },
  );
  if (error) {
    // Non-fatal — geography research should not fail because of this
    console.error(`[etf-constituents] upsert failed for ${etfIsin}:`, error.message);
  }
}
