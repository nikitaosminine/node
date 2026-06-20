// Pure helpers for CSV expense import (Linear 1A-109).
//
// The Worker normalizes a bank/card CSV into PreviewRow[] via the LLM; these functions
// turn confirmed rows into the DB writes. Kept side-effect-free so the mapping, income
// aggregation, and dedup logic are unit-testable without a network or Supabase.
//
//   PreviewRow[]  ──coerce──►  ReviewRow[]  ──split──►  expense_transactions (spend)
//                                                  └──►  expense_income (income, by month)

export type ExpenseImportKind = "spend" | "income";

/** One row as returned by the normalizer (LLM output, loosely typed). */
export interface PreviewRow {
  posted_at: string;
  merchant_name: string;
  amount: string | number;
  currency: string;
  kind: ExpenseImportKind;
  is_recurring: boolean;
  pfc_primary: string;
  external_ref: string | null;
  confidence: number;
}

export interface PreviewResponse {
  columns_detected?: string[];
  rows: PreviewRow[];
  errors: string[];
}

/** A normalized, user-editable row in the review table. */
export interface ReviewRow {
  posted_at: string;
  merchant_name: string;
  amount: number;
  currency: string;
  kind: ExpenseImportKind;
  is_recurring: boolean;
  pfc_primary: string;
  category_id: string | null;
  external_id: string | null;
  confidence: number;
  include: boolean;
}

export interface ExpenseTransactionInsert {
  user_id: string;
  posted_at: string;
  merchant_name: string;
  amount: number;
  currency: string;
  category_id: string | null;
  is_recurring: boolean;
  source: "csv";
  external_id: string | null;
}

export interface IncomeUpsert {
  user_id: string;
  month: string;
  amount: number;
  currency: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a flexible amount string ("€1.234,56", "1,234.56", "-12.50") into a positive number. */
export function parseAmount(raw: string | number): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.abs(raw) : 0;
  let s = String(raw).replace(/[^0-9.,-]/g, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Whichever separator is last is the decimal separator; the other groups thousands.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    // Lone comma: decimal if it looks like "12,50", else thousands.
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/** First day of the month for an ISO date, as YYYY-MM-01. */
export function monthOf(isoDate: string): string {
  return ISO_DATE.test(isoDate) ? `${isoDate.slice(0, 7)}-01` : isoDate;
}

/** Dedup key: only the bank's own reference dedups; blank/whitespace → null (no dedup). */
export function externalId(ref: string | null | undefined): string | null {
  const trimmed = (ref ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize one loosely-typed LLM row into a ReviewRow. Resolves the category id from the
 * PFCv2 primary against the seeded categories; unknown primaries resolve to null
 * (uncategorized) so a bad LLM label never blocks the import.
 */
export function coercePreviewRow(
  raw: PreviewRow,
  categoryIdByPrimary: Record<string, string>,
  baseCurrency: string,
): ReviewRow {
  const kind: ExpenseImportKind = raw.kind === "income" ? "income" : "spend";
  const primary = String(raw.pfc_primary ?? "").toUpperCase();
  const confidence = Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0;
  return {
    posted_at: String(raw.posted_at ?? ""),
    merchant_name: String(raw.merchant_name ?? "").trim() || "Unknown",
    amount: parseAmount(raw.amount),
    currency: String(raw.currency ?? baseCurrency).toUpperCase() || baseCurrency,
    kind,
    is_recurring: raw.is_recurring === true,
    pfc_primary: primary,
    category_id: categoryIdByPrimary[primary] ?? null,
    external_id: externalId(raw.external_ref),
    confidence,
    include: true,
  };
}

/** Map confirmed *spend* rows (incl. recurring fixed costs) to transaction inserts. */
export function buildTransactionInserts(
  rows: ReviewRow[],
  userId: string,
  baseCurrency: string,
): ExpenseTransactionInsert[] {
  return rows
    .filter((r) => r.include && r.kind === "spend" && r.amount > 0 && ISO_DATE.test(r.posted_at))
    .map((r) => ({
      user_id: userId,
      posted_at: r.posted_at,
      merchant_name: r.merchant_name,
      amount: r.amount,
      // Single base currency for v1 (eng-review A2): everything stored in the base currency.
      currency: baseCurrency,
      category_id: r.category_id,
      is_recurring: r.is_recurring,
      source: "csv",
      external_id: r.external_id,
    }));
}

/** Sum confirmed *income* rows by month into expense_income upserts. */
export function aggregateIncomeByMonth(
  rows: ReviewRow[],
  userId: string,
  baseCurrency: string,
): IncomeUpsert[] {
  const byMonth = new Map<string, number>();
  for (const r of rows) {
    if (!r.include || r.kind !== "income" || r.amount <= 0 || !ISO_DATE.test(r.posted_at)) continue;
    const month = monthOf(r.posted_at);
    byMonth.set(month, (byMonth.get(month) ?? 0) + r.amount);
  }
  return Array.from(byMonth.entries()).map(([month, amount]) => ({
    user_id: userId,
    month,
    amount: Math.round(amount * 100) / 100,
    currency: baseCurrency,
  }));
}

/** Detected currencies that differ from the user's base currency (for a warning banner). */
export function foreignCurrencies(rows: ReviewRow[], baseCurrency: string): string[] {
  const base = baseCurrency.toUpperCase();
  return Array.from(new Set(rows.map((r) => r.currency).filter((c) => c && c !== base)));
}
