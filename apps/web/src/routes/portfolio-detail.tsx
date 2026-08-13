"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import { DateRange } from "react-day-picker";
import { format } from "date-fns";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useThesisContext } from "@/contexts/thesis-context";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ArrowBigUp,
  CalendarDays,
  Columns3,
  Download,
  FileJson,
  FileSpreadsheet,
  FileText,
  Info,
  Keyboard,
  Minus,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getSector } from "@/lib/mock-data";
import { toast } from "sonner";
import { TakeBadge } from "@/components/take-badge";
import { Thesis, thesesForTicker } from "@/lib/thesis";
import { EditHoldingModal } from "@/components/edit-holding-modal";
import { AddHoldingModal } from "@/components/add-holding-modal";
import { ImportTransactionsModal } from "@/components/import-transactions-modal";
import { ManualTransactionModal } from "@/components/manual-transaction-modal";
import { AnimatedCopyButton } from "@/components/lightswind/animated-copy-button";
import { OrbitRing } from "@/components/loading-ui/orbit-ring";
import { TransactionDateRange, TransactionHistoryTab } from "@/components/transaction-history-tab";
import { AllocationCard } from "@/components/portfolio/AllocationCard";
import {
  convertCurrency,
  fetchFxRates,
  formatCurrency,
  formatSignedCurrency,
  normalizeCurrencyCode,
} from "@/lib/currency";
import {
  type TransactionApiRow,
  toFiniteNumber,
  computeRealizedSellPnL,
} from "@/lib/portfolio-math";
import {
  type CachedMarketQuote,
  MARKET_CACHE_MAX_AGE_MS,
  getCachedFxRates,
  getCachedQuotes,
  getFxRateKeys,
  upsertCachedFxRates,
  upsertCachedQuotes,
} from "@/lib/market-cache";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuCheckboxItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { API_BASE_URL } from "@/lib/api";

interface Holding {
  id: string;
  ticker: string;
  name: string;
  isin: string | null;
  asset_type: string | null;
  currency: string | null;
  quantity: number;
  purchase_price: number;
  fees: number;
  purchase_date: string;
}

function fmtMoney(n: number, currency: string) {
  return formatCurrency(n, currency);
}
function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function normalizeAssetType(assetType: string | null, name = "", ticker = "") {
  const rawValue = assetType?.trim().toLowerCase();
  const value =
    rawValue && rawValue !== "other" && rawValue !== "n/a"
      ? rawValue
      : `${name} ${ticker}`.trim().toLowerCase();
  if (!value) return "Other";
  if (/\betf\b|exchange traded fund/.test(value)) return "ETF";
  if (/\bmutual\s*fund\b|\bfund\b|\buc\b|\bucits\b|open end fund/.test(value)) return "Fund";
  if (value.includes("bond") || value.includes("fixed")) return "Bonds";
  if (/\bequity\b|\bstock\b/.test(value)) return "Equity";
  if (value.includes("cash")) return "Cash";
  return "Other";
}

function inferSectorFromHolding(ticker: string, name: string, assetType: string | null): string {
  const symbol = ticker.toUpperCase();
  const baseTicker = symbol.split(".")[0];
  const label = name.toLowerCase();
  const type = normalizeAssetType(assetType, name, ticker);

  const explicitTickerSector: Record<string, string> = {
    "SU.PA": "Industrials",
    "LR.PA": "Industrials",
    "TTE.PA": "Energy",
    "ALSEM.PA": "Technology",
  };
  if (explicitTickerSector[symbol]) return explicitTickerSector[symbol];
  if (explicitTickerSector[baseTicker]) return explicitTickerSector[baseTicker];

  if (type === "ETF" || type === "Fund") {
    if (
      label.includes("tech") ||
      label.includes("technology") ||
      label.includes("nasdaq") ||
      label.includes("semiconductor")
    ) {
      return "Technology";
    }
    if (label.includes("energy")) return "Energy";
    if (label.includes("industrial")) return "Industrials";
    if (label.includes("financial") || label.includes("bank")) return "Financials";
    if (label.includes("healthcare") || label.includes("health")) return "Healthcare";
    if (
      label.includes("europe") ||
      label.includes("msci") ||
      label.includes("s&p") ||
      label.includes("stoxx") ||
      label.includes("world") ||
      label.includes("emerging") ||
      label.includes("japan") ||
      label.includes("topix") ||
      label.includes("screen")
    ) {
      return "Broad Market";
    }
    return "Broad Market";
  }

  if (label.includes("electric") || label.includes("industrial")) return "Industrials";
  if (label.includes("energy") || label.includes("totalenergies")) return "Energy";
  if (label.includes("technology") || label.includes("tech")) return "Technology";
  if (label.includes("bank") || label.includes("financial")) return "Financials";
  if (label.includes("health")) return "Healthcare";
  return "Other";
}

const ALL_COLUMNS = [
  { key: "name", label: "Asset", align: "left" },
  { key: "assetType", label: "Type", align: "left" },
  { key: "qty", label: "Qty", align: "right" },
  { key: "currency", label: "Currency", align: "left" },
  { key: "cur", label: "Current", align: "right" },
  { key: "buy", label: "Cost", align: "right" },
  { key: "total", label: "Value", align: "right" },
  { key: "gl", label: "Gain/Loss", align: "right" },
  { key: "weight", label: "Weight", align: "right" },
  { key: "sector", label: "Sector", align: "left" },
  { key: "perf1D", label: "1D", align: "right" },
  { key: "perfYTD", label: "YTD", align: "right" },
  { key: "take", label: "Take", align: "center" },
] as const;

type ColKey = (typeof ALL_COLUMNS)[number]["key"];

// Per-column widths, shared by the <colgroup> and by the table's minimum width.
// `table-auto` treats a <col> width as a preference it may shrink below, so
// without an explicit min-width the columns crush instead of scrolling whenever
// the cell text is short. Deriving the minimum from the VISIBLE columns means
// hiding columns removes the horizontal scroll rather than leaving dead space.
const COLUMN_WIDTHS: Partial<Record<ColKey, number>> = {
  name: 340,
  assetType: 96,
  qty: 64,
  cur: 104,
  buy: 104,
  total: 104,
  gl: 112,
  weight: 78,
  sector: 110,
  perf1D: 76,
  perfYTD: 76,
  take: 52,
};

/** Width of the trailing row-actions column, which has no entry in ALL_COLUMNS. */
const ACTIONS_COLUMN_WIDTH = 52;

interface RowData {
  id: string;
  ticker: string;
  name: string;
  isin: string | null;
  qty: number;
  currency: string;
  cur: number;
  buy: number;
  total: number;
  gl: number;
  weight: number;
  sector: string;
  assetType: string;
  perf1D: number;
  perfYTD: number;
}

interface LiveQuote {
  ticker: string;
  currentPrice: number | null;
  change1dPercent: number | null;
  ytdChangePercent: number | null;
  currency?: string | null;
  sector?: string | null;
  assetType?: string | null;
  lastPriceUpdatedAt?: string | null;
}

function cachedQuoteEntriesToLiveQuotes(entries: Record<string, CachedMarketQuote>) {
  return Object.entries(entries).reduce<Record<string, LiveQuote>>((acc, [ticker, quote]) => {
    acc[ticker] = {
      ticker,
      currentPrice: quote.currentPrice,
      change1dPercent: quote.change1dPercent ?? null,
      ytdChangePercent: quote.ytdChangePercent ?? null,
      currency: quote.currency,
      sector: quote.sector,
      assetType: quote.assetType,
      lastPriceUpdatedAt: quote.lastPriceUpdatedAt,
    };
    return acc;
  }, {});
}

type ExportValue = string | number | null;
type ExportRow = Record<string, ExportValue>;
type DatePreset = "30D" | "90D" | "YTD" | "All";
type ExportFormat = "xlsx" | "csv" | "json";
type CsvExportScope = "portfolio" | "allocation" | "holdings" | "transactions";
type ExportDatePreset = "all_time" | "ytd" | "last_12_months" | "last_quarter" | "custom";
type ExportDateRange = TransactionDateRange;
type ExportSheetSection = { title: string; rows: ExportRow[]; headers: string[] };
type ExportSheetSpec = {
  name: string;
  rows: ExportRow[];
  headers: string[];
  sections?: ExportSheetSection[];
};

interface ChartSeries {
  date: string;
  total_value: number;
  cash_balance: number;
  securities_value: number;
  simple_return_pct: number;
  twr_pct: number;
}

interface BenchmarkDefinition {
  id?: string;
  name: string;
  ticker: string;
  color: string;
  weights?: unknown;
  created_at?: string;
}

interface BenchmarkPricePoint {
  date: string;
  close: number;
}

interface GeographyCountry {
  countryCode?: string | null;
  countryName?: string | null;
  value?: number | null;
  percentage?: number | null;
  source?: string | null;
  confidence?: number | null;
}

interface GeographyResponse {
  coveragePct?: number | null;
  unknownPct?: number | null;
  unknownValue?: number | null;
  unknownHoldingCount?: number | null;
  checkedAt?: string | null;
  oldestCheckedAt?: string | null;
  countries?: GeographyCountry[];
}

// TransactionApiRow, toFiniteNumber, computeRealizedSellPnL imported from @/lib/portfolio-math

interface ExportDataset {
  portfolioRows: ExportRow[];
  portfolioReturnRows: ExportRow[];
  portfolioReturnHeaders: string[];
  allocationRows: ExportRow[];
  holdingsRows: ExportRow[];
  transactionsRows: ExportRow[];
  savedBenchmarkRows: ExportRow[];
  jsonPayload: {
    meta: {
      exported_at: string;
      portfolio_name: string;
      account_type: string;
      currency: string;
      date_range: ExportDateRange;
    };
    portfolio: {
      summary: ExportRow;
      value_history: ExportRow[];
    };
    allocation: {
      sectors: ExportRow[];
      asset_types: ExportRow[];
      geography: ExportRow[];
    };
    holdings: ExportRow[];
    transactions: ExportRow[];
    saved_benchmarks: ExportRow[];
  };
}

const PILL_TRANSITION = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.7 };
const ACTIVE_BENCHMARKS_STORAGE_PREFIX = "portfolio-chart:active-benchmarks";

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const DEFAULT_ORDER: ColKey[] = ALL_COLUMNS.map((c) => c.key);

function loadLS<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function saveLS(key: string, val: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* ignore */
  }
}

function toIsoDate(date: Date) {
  return format(date, "yyyy-MM-dd");
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function getPresetRange(preset: DatePreset): TransactionDateRange {
  if (preset === "All") return { from: null, to: null };
  const today = new Date();
  if (preset === "YTD") {
    return { from: `${today.getFullYear()}-01-01`, to: toIsoDate(today) };
  }
  return { from: toIsoDate(addDays(today, preset === "30D" ? -30 : -90)), to: toIsoDate(today) };
}

function getExportDatePresetRange(preset: ExportDatePreset): ExportDateRange {
  const today = new Date();
  if (preset === "all_time" || preset === "custom") return { from: null, to: null };
  if (preset === "ytd") return { from: `${today.getFullYear()}-01-01`, to: toIsoDate(today) };
  if (preset === "last_12_months") {
    const start = new Date(today);
    start.setFullYear(start.getFullYear() - 1);
    return { from: toIsoDate(start), to: toIsoDate(today) };
  }

  const currentQuarter = Math.floor(today.getMonth() / 3);
  const startMonth = currentQuarter === 0 ? 9 : (currentQuarter - 1) * 3;
  const year = currentQuarter === 0 ? today.getFullYear() - 1 : today.getFullYear();
  const start = new Date(year, startMonth, 1);
  const end = new Date(year, startMonth + 3, 0);
  return { from: toIsoDate(start), to: toIsoDate(end) };
}

function getInitialExportPreset(
  transactionLabel: string,
  transactionRange: TransactionDateRange,
): ExportDatePreset {
  if (!transactionRange.from && !transactionRange.to) return "all_time";
  if (transactionLabel === "YTD") return "ytd";
  return "custom";
}

function slugifyPortfolioName(name: string | null | undefined) {
  const slug = (name ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "portfolio";
}

function formatExportDate(date = new Date()) {
  return toIsoDate(date);
}

function formatExportFilename(
  portfolioName: string,
  exportLabel: "export" | CsvExportScope,
  extension: ExportFormat,
) {
  return `${slugifyPortfolioName(portfolioName)}_${exportLabel}_${formatExportDate()}.${extension}`;
}

function escapeCsvValue(value: ExportValue) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function exportToCsv(filename: string, rows: ExportRow[], headers: string[]) {
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((key) => escapeCsvValue(row[key])).join(",")),
  ].join("\n");
  downloadBlob(filename, new Blob([csv], { type: "text/csv;charset=utf-8" }));
}

function exportToJson(filename: string, payload: unknown) {
  downloadBlob(
    filename,
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
  );
}

function rowsToWorksheet(
  rows: ExportRow[],
  headers: string[],
  sections: ExportSheetSection[] = [],
) {
  const sheetRows: ExportValue[][] = [
    headers,
    ...rows.map((row) => headers.map((key) => row[key] ?? "")),
  ];

  for (const section of sections) {
    sheetRows.push([]);
    sheetRows.push([section.title]);
    sheetRows.push(section.headers);
    sheetRows.push(...section.rows.map((row) => section.headers.map((key) => row[key] ?? "")));
  }

  return XLSX.utils.aoa_to_sheet(sheetRows);
}

function exportToXlsx(filename: string, sheets: ExportSheetSpec[]) {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(
      workbook,
      rowsToWorksheet(sheet.rows, sheet.headers, sheet.sections),
      sheet.name.slice(0, 31),
    );
  }
  XLSX.writeFile(workbook, filename);
}

function transactionToExportRow(transaction: TransactionApiRow): ExportRow {
  return {
    Date: transaction.date,
    Symbol: transaction.symbol,
    ISIN: transaction.isin ?? "",
    Ticker: transaction.yahoo_ticker ?? "",
    Side: transaction.side,
    Qty: transaction.quantity ?? "",
    "Net Amount": transaction.net_amount ?? "",
    Commission: transaction.commission || "",
  };
}

async function fetchPortfolioTransactions(portfolioId: string): Promise<TransactionApiRow[]> {
  const response = await fetch(`${API_BASE_URL}/api/portfolios/${portfolioId}/transactions`, {
    headers: await authHeaders(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Failed to load transactions");
  return (body.transactions ?? []) as TransactionApiRow[];
}

function isWithinDateRange(date: string, range: ExportDateRange) {
  const matchesFrom = !range.from || date >= range.from;
  const matchesTo = !range.to || date <= range.to;
  return matchesFrom && matchesTo;
}

function activeBenchmarksStorageKey(portfolioId: string) {
  return `${ACTIVE_BENCHMARKS_STORAGE_PREFIX}:${portfolioId}`;
}

function parseStoredActiveBenchmarks(value: string | null): BenchmarkDefinition[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        const name = String(row.name ?? "").trim();
        const ticker = String(row.ticker ?? "")
          .trim()
          .toUpperCase();
        const color = String(row.color ?? "").trim();
        if (!name || !ticker || !color) return null;
        const benchmark: BenchmarkDefinition = { name, ticker, color };
        if (typeof row.id === "string") benchmark.id = row.id;
        if ("weights" in row) benchmark.weights = row.weights;
        if (typeof row.created_at === "string") benchmark.created_at = row.created_at;
        return benchmark;
      })
      .filter((item): item is BenchmarkDefinition => item != null)
      .slice(0, 4);
  } catch {
    return [];
  }
}

function loadStoredActiveBenchmarks(portfolioId: string): BenchmarkDefinition[] {
  return parseStoredActiveBenchmarks(localStorage.getItem(activeBenchmarksStorageKey(portfolioId)));
}

function latestBenchmarkCloseOnOrBefore(prices: BenchmarkPricePoint[], date: string) {
  let value: number | null = null;
  for (const point of prices) {
    if (point.date > date) break;
    value = point.close;
  }
  return value;
}

function latestReturnOnOrBefore(
  points: Array<{ date: string; value: number }>,
  date: string,
): number | null {
  let value: number | null = null;
  for (const point of points) {
    if (point.date > date) break;
    value = point.value;
  }
  return value;
}

function benchmarkColumnName(benchmark: BenchmarkDefinition) {
  return `${benchmark.name} (${benchmark.ticker})`;
}

function benchmarkReturnColumnName(benchmark: BenchmarkDefinition) {
  return `${benchmark.name} (${benchmark.ticker}) Return %`;
}

function getMonthLabel(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return monthKey;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

function computeMonthlyReturnValues(points: Array<{ date: string; value: number }>) {
  const sorted = points
    .filter((point) => point.date && Number.isFinite(point.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  const grouped = new Map<string, Array<{ date: string; value: number }>>();
  for (const point of sorted) {
    const monthKey = point.date.slice(0, 7);
    if (!grouped.has(monthKey)) grouped.set(monthKey, []);
    grouped.get(monthKey)!.push(point);
  }

  return Array.from(grouped.entries()).map(([monthKey, monthPoints]) => {
    const first = monthPoints[0];
    const last = monthPoints[monthPoints.length - 1];
    const startFactor = 1 + first.value / 100;
    const endFactor = 1 + last.value / 100;
    return {
      period: getMonthLabel(monthKey),
      value: startFactor > 0 ? Number(((endFactor / startFactor - 1) * 100).toFixed(2)) : null,
    };
  });
}

function benchmarkPricesToReturnPoints(prices: BenchmarkPricePoint[]) {
  const sorted = prices
    .filter((point) => Number.isFinite(point.close) && point.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const base = sorted[0]?.close;
  if (!base) return [];
  return sorted.map((point) => ({
    date: point.date,
    value: (point.close / base - 1) * 100,
  }));
}

const PORTFOLIO_EXPORT_HEADERS = [
  "Date",
  "Total Value",
  "Cash Balance",
  "Securities Value",
  "Simple Return %",
  "TWR %",
];
const PORTFOLIO_RETURN_EXPORT_HEADERS = ["Period", "Portfolio Return %"];
const ALLOCATION_EXPORT_HEADERS = ["Category", "Name", "Weight %", "Checked At"];
const HOLDINGS_EXPORT_HEADERS = [
  "Asset",
  "Ticker",
  "ISIN",
  "Type",
  "Currency",
  "Qty",
  "Current",
  "Cost",
  "Value",
  "Gain/Loss",
  "Weight %",
  "Sector",
  "1D %",
  "YTD %",
  "Take Count",
  "Last Price",
  "Last Price Update",
];
const SAVED_BENCHMARKS_EXPORT_HEADERS = ["Name", "Ticker", "Created At", "Active"];
const TRANSACTION_EXPORT_HEADERS = [
  "Date",
  "Symbol",
  "ISIN",
  "Ticker",
  "Side",
  "Qty",
  "Net Amount",
  "Commission",
];

function PerfCell({
  value,
  money,
  currency = "EUR",
}: {
  value: number;
  money?: boolean;
  currency?: string;
}) {
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  const tone = value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-foreground-muted";
  const text = money ? formatSignedCurrency(value, currency) : fmtPct(value);
  return (
    <span
      className={`inline-flex items-center justify-end gap-1 font-mono text-[11px] tabular-nums ${tone}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {text}
    </span>
  );
}

export default function PortfolioDetailPage() {
  const params = useParams();
  const portfolioId = params.portfolioId as string;
  const { theses, openDrawer, openModal } = useThesisContext();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<{
    id: string;
    name: string;
    description: string | null;
    cash_value: number;
    currency: string | null;
  } | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [transactionRows, setTransactionRows] = useState<TransactionApiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [liveQuotes, setLiveQuotes] = useState<Record<string, LiveQuote>>({});
  const [fxRates, setFxRates] = useState<Record<string, number>>({});
  const [marketReady, setMarketReady] = useState(false);

  const [sortBy, setSortBy] = useState<string>("total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [hiddenCols, setHiddenCols] = useState<Set<ColKey>>(
    () => new Set<ColKey>(loadLS(`binturong.columns.hidden.${portfolioId}`, [])),
  );

  const [colOrder, setColOrder] = useState<ColKey[]>(() => {
    const saved = loadLS(`binturong.columns.order.${portfolioId}`, DEFAULT_ORDER);
    const missing = DEFAULT_ORDER.filter((k) => !saved.includes(k));
    return [...saved, ...missing];
  });

  const dragKey = useRef<ColKey | null>(null);

  const [editingHolding, setEditingHolding] = useState<Holding | null>(null);
  const [addHoldingOpen, setAddHoldingOpen] = useState(false);
  const [cashDialogOpen, setCashDialogOpen] = useState(false);
  const [cashAction, setCashAction] = useState<"deposit" | "withdraw">("deposit");
  const [cashAmount, setCashAmount] = useState("");
  const [cashSubmitting, setCashSubmitting] = useState(false);
  const [manualTransactionOpen, setManualTransactionOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"holdings" | "transactions">("holdings");
  const shouldReduceMotion = useReducedMotion();
  const pillTransition = shouldReduceMotion ? { duration: 0 } : PILL_TRANSITION;
  const [transactionSearch, setTransactionSearch] = useState("");
  const [transactionDateRange, setTransactionDateRange] = useState<TransactionDateRange>({
    from: null,
    to: null,
  });
  const [transactionDateLabel, setTransactionDateLabel] = useState("Date range");
  const [transactionCalendarRange, setTransactionCalendarRange] = useState<DateRange | undefined>();
  const [exportSheetOpen, setExportSheetOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("xlsx");
  const [selectedCsvExportScopes, setSelectedCsvExportScopes] = useState<CsvExportScope[]>([
    "portfolio",
  ]);
  const [exportDatePreset, setExportDatePreset] = useState<ExportDatePreset>("all_time");
  const [exportDateRange, setExportDateRange] = useState<ExportDateRange>({ from: null, to: null });
  const [exportSubmitting, setExportSubmitting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const columnModifierSelectRef = useRef(false);

  const hydrateCachedMarketState = useCallback(
    (nextHoldings: Holding[], nextPortfolioCurrency: string) => {
      const symbols = Array.from(
        new Set(nextHoldings.map((holding) => holding.ticker.toUpperCase()).filter(Boolean)),
      );
      if (symbols.length === 0) {
        setLiveQuotes({});
        setFxRates({});
        return true;
      }

      const cachedQuotes = getCachedQuotes(symbols);
      const cachedQuoteMap = cachedQuoteEntriesToLiveQuotes(cachedQuotes.entries);
      const sourceCurrencies = nextHoldings.map(
        (holding) => cachedQuoteMap[holding.ticker.toUpperCase()]?.currency ?? holding.currency,
      );
      const cachedFx = getCachedFxRates(getFxRateKeys(sourceCurrencies, [nextPortfolioCurrency]));

      if (cachedQuotes.hasAll) setLiveQuotes(cachedQuoteMap);
      if (cachedFx.hasAll) setFxRates(cachedFx.entries);

      return cachedQuotes.hasAll && cachedFx.hasAll;
    },
    [],
  );

  const load = useCallback(async () => {
    const transactionRowsPromise = portfolioId
      ? fetchPortfolioTransactions(portfolioId).catch((error) => {
          toast.error(error instanceof Error ? error.message : "Failed to load transactions");
          return [] as TransactionApiRow[];
        })
      : Promise.resolve([] as TransactionApiRow[]);

    const [pRes, hRes, nextTransactionRows] = await Promise.all([
      supabase
        .from("portfolios")
        .select("id, name, description, cash_value, currency")
        .eq("id", portfolioId!)
        .single(),
      supabase.from("holdings").select("*").eq("portfolio_id", portfolioId!),
      transactionRowsPromise,
    ]);
    if (pRes.error) toast.error("Failed to load portfolio");
    else setPortfolio(pRes.data);
    setTransactionRows(nextTransactionRows);
    if (!hRes.error) {
      const nextHoldings = hRes.data || [];
      const nextPortfolioCurrency = normalizeCurrencyCode(pRes.data?.currency);
      const hasCachedMarketData = hydrateCachedMarketState(nextHoldings, nextPortfolioCurrency);
      setHoldings(nextHoldings);
      setMarketReady(nextHoldings.length === 0 || hasCachedMarketData);
    }
    setLoading(false);
  }, [hydrateCachedMarketState, portfolioId]);

  const triggerGeographySync = useCallback(async () => {
    if (!portfolioId) return;
    try {
      const headers = await authHeaders();
      await fetch(`${API_BASE_URL}/api/portfolios/${portfolioId}/geography/enqueue`, {
        method: "POST",
        headers,
      });
    } catch {
      // Geography sync is a background repair/enqueue step; holdings changes should not fail on it.
    }
  }, [portfolioId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (portfolioId) localStorage.setItem("binturong.last-portfolio-id", portfolioId);
  }, [portfolioId]);

  useEffect(() => {
    saveLS(`binturong.columns.hidden.${portfolioId}`, Array.from(hiddenCols));
  }, [hiddenCols, portfolioId]);

  useEffect(() => {
    saveLS(`binturong.columns.order.${portfolioId}`, colOrder);
  }, [colOrder, portfolioId]);

  const portfolioCurrency = normalizeCurrencyCode(portfolio?.currency);
  const holdingsValue = useMemo(
    () =>
      holdings.reduce((s, h) => {
        const live = liveQuotes[h.ticker.toUpperCase()];
        const current = live?.currentPrice ?? h.purchase_price;
        const currency = live?.currency ?? h.currency ?? portfolioCurrency;
        return s + convertCurrency(current * h.quantity, currency, portfolioCurrency, fxRates);
      }, 0),
    [fxRates, holdings, liveQuotes, portfolioCurrency],
  );
  const holdingsCost = useMemo(
    () =>
      holdings.reduce(
        (s, h) =>
          s +
          convertCurrency(h.purchase_price * h.quantity, h.currency, portfolioCurrency, fxRates),
        0,
      ),
    [fxRates, holdings, portfolioCurrency],
  );
  const cashValue = portfolio?.cash_value ?? 0;
  const totalValue = holdingsValue + cashValue;
  const totalCost = holdingsCost + cashValue;
  const unrealizedPL = holdingsValue - holdingsCost;
  const unrealizedPct = holdingsCost > 0 ? (unrealizedPL / holdingsCost) * 100 : 0;
  const realizedMetrics = useMemo(() => computeRealizedSellPnL(transactionRows), [transactionRows]);
  const hasRealizedPnL = realizedMetrics.realizedCostBasis > 0;

  const rows: RowData[] = useMemo(() => {
    const r = holdings.map((h) => {
      const live = liveQuotes[h.ticker.toUpperCase()];
      const cur = live?.currentPrice ?? h.purchase_price;
      const currency = normalizeCurrencyCode(live?.currency ?? h.currency, portfolioCurrency);
      const total = convertCurrency(cur * h.quantity, currency, portfolioCurrency, fxRates);
      const cost = convertCurrency(
        h.purchase_price * h.quantity,
        h.currency,
        portfolioCurrency,
        fxRates,
      );
      const gl = total - cost;
      const weight = totalValue > 0 ? (total / totalValue) * 100 : 0;
      const perf1D = live?.change1dPercent ?? 0;
      const perfYTD = live?.ytdChangePercent ?? 0;
      return {
        id: h.id,
        ticker: h.ticker,
        name: h.name,
        isin: h.isin,
        qty: h.quantity,
        currency,
        cur,
        buy: h.purchase_price,
        total,
        gl,
        weight,
        sector:
          live?.sector && live.sector !== "Other"
            ? live.sector
            : inferSectorFromHolding(h.ticker, h.name, live?.assetType ?? h.asset_type) ||
              getSector(h.ticker),
        assetType: normalizeAssetType(live?.assetType ?? h.asset_type, h.name, h.ticker),
        perf1D,
        perfYTD,
        _raw: h,
      } as RowData & { _raw: Holding };
    });

    r.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      const av = (a as unknown as Record<string, unknown>)[sortBy];
      const bv = (b as unknown as Record<string, unknown>)[sortBy];
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return (((av as number) ?? 0) - ((bv as number) ?? 0)) * dir;
    });
    return r;
  }, [fxRates, holdings, liveQuotes, portfolioCurrency, totalValue, sortBy, sortDir]);

  // Allocation data for charts
  const sectorData = useMemo(() => {
    const bySector: Record<string, number> = {};
    rows.forEach((r) => {
      bySector[r.sector] = (bySector[r.sector] || 0) + r.total;
    });
    return Object.entries(bySector)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value }));
  }, [rows]);

  const assetTypeData = useMemo(() => {
    const byType: Record<string, number> = {};
    rows.forEach((r) => {
      byType[r.assetType] = (byType[r.assetType] || 0) + r.total;
    });
    if (cashValue > 0) byType.Cash = (byType.Cash || 0) + cashValue;
    return Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value }));
  }, [rows, cashValue]);

  useEffect(() => {
    const symbols = Array.from(
      new Set(holdings.map((h) => h.ticker.toUpperCase()).filter(Boolean)),
    );
    if (symbols.length === 0) {
      setLiveQuotes({});
      setFxRates({});
      setMarketReady(true);
      return;
    }

    let cancelled = false;
    const cachedQuotes = getCachedQuotes(symbols);
    const cachedQuoteMap = cachedQuoteEntriesToLiveQuotes(cachedQuotes.entries);
    const cachedSourceCurrencies = holdings.map(
      (holding) => cachedQuoteMap[holding.ticker.toUpperCase()]?.currency ?? holding.currency,
    );
    const cachedFx = getCachedFxRates(getFxRateKeys(cachedSourceCurrencies, [portfolioCurrency]));
    const hasCompleteCache = cachedQuotes.hasAll && cachedFx.hasAll;

    if (cachedQuotes.hasAll) setLiveQuotes(cachedQuoteMap);
    if (cachedFx.hasAll) setFxRates(cachedFx.entries);
    if (hasCompleteCache) setMarketReady(true);

    const fetchQuotes = async (showErrorToast = false) => {
      try {
        const params = encodeURIComponent(symbols.join(","));
        const quoteRequest = fetch(
          `${API_BASE_URL}/api/market/quotes?symbols=${params}&currency=${portfolioCurrency}`,
        );
        const knownRatesRequest = fetchFxRates(
          API_BASE_URL,
          holdings.map((holding) => holding.currency),
          portfolioCurrency,
        );
        const [res, knownRates] = await Promise.all([quoteRequest, knownRatesRequest]);
        if (!res.ok) throw new Error("Unable to fetch live quotes");
        const data = (await res.json()) as LiveQuote[];
        if (cancelled) return;
        const quoteMap = data.reduce<Record<string, LiveQuote>>((acc, quote) => {
          acc[quote.ticker.toUpperCase()] = quote;
          return acc;
        }, {});
        upsertCachedQuotes(data);
        setLiveQuotes(quoteMap);
        const quoteCurrencies = holdings.map(
          (holding) => quoteMap[holding.ticker.toUpperCase()]?.currency ?? holding.currency,
        );
        const missingQuoteCurrencies = quoteCurrencies.filter((currency) =>
          getFxRateKeys([currency], [portfolioCurrency]).some((key) => knownRates[key] == null),
        );
        const missingRates =
          missingQuoteCurrencies.length > 0
            ? await fetchFxRates(API_BASE_URL, missingQuoteCurrencies, portfolioCurrency)
            : {};
        const rates = { ...knownRates, ...missingRates };
        upsertCachedFxRates(rates);
        if (!cancelled) {
          setFxRates(rates);
          setMarketReady(true);
        }
      } catch {
        if (!cancelled) {
          if (!hasCompleteCache) setMarketReady(true);
          if (showErrorToast) toast.error("Failed to refresh market prices");
        }
      }
    };

    if (cachedQuotes.shouldRefetch || cachedFx.shouldRefetch) void fetchQuotes(!hasCompleteCache);
    const intervalId = window.setInterval(() => void fetchQuotes(false), MARKET_CACHE_MAX_AGE_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [holdings, portfolioCurrency]);

  const visibleCols = colOrder.filter((k) => !hiddenCols.has(k));
  const holdingsTableMinWidth = useMemo(
    () =>
      visibleCols.reduce((total, key) => total + (COLUMN_WIDTHS[key] ?? 0), ACTIONS_COLUMN_WIDTH),
    [visibleCols],
  );
  const holdingsSnapshotRows = useMemo<ExportRow[]>(() => {
    return rows.map((row) => {
      return {
        Asset: row.name,
        Ticker: row.ticker,
        ISIN: row.isin ?? "",
        Type: row.assetType,
        Currency: row.currency,
        Qty: row.qty,
        Current: row.cur,
        Cost: row.buy,
        Value: row.total,
        "Gain/Loss": row.gl,
        "Weight %": Number(row.weight.toFixed(2)),
        Sector: row.sector,
        "1D %": Number(row.perf1D.toFixed(2)),
        "YTD %": Number(row.perfYTD.toFixed(2)),
        "Take Count": thesesForTicker(theses, row.ticker).length,
        "Last Price": liveQuotes[row.ticker.toUpperCase()]?.currentPrice ?? null,
        "Last Price Update": liveQuotes[row.ticker.toUpperCase()]?.lastPriceUpdatedAt ?? "",
      };
    });
  }, [liveQuotes, rows, theses]);

  const sectorAllocationRows = useMemo<ExportRow[]>(() => {
    return sectorData.map((item) => ({
      Category: "Sector",
      Name: item.name,
      Value: item.value,
      "Weight %": holdingsValue > 0 ? Number(((item.value / holdingsValue) * 100).toFixed(2)) : 0,
    }));
  }, [holdingsValue, sectorData]);

  const assetTypeAllocationRows = useMemo<ExportRow[]>(() => {
    return assetTypeData.map((item) => ({
      Category: "Asset Type",
      Name: item.name,
      Value: item.value,
      "Weight %": totalValue > 0 ? Number(((item.value / totalValue) * 100).toFixed(2)) : 0,
    }));
  }, [assetTypeData, totalValue]);

  const allocationExportRows = useMemo<ExportRow[]>(
    () => [...sectorAllocationRows, ...assetTypeAllocationRows],
    [assetTypeAllocationRows, sectorAllocationRows],
  );

  const hasTransactionDateFilter = transactionDateLabel !== "Date range";

  const handleSort = (key: string) => {
    if (key === "take") return;
    if (sortBy === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(key);
      setSortDir("desc");
    }
  };

  const toggleHide = (key: ColKey) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleDragStart = (key: ColKey) => {
    dragKey.current = key;
  };
  const handleDrop = (targetKey: ColKey) => {
    if (!dragKey.current || dragKey.current === targetKey) return;
    setColOrder((prev) => {
      const next = [...prev];
      const fromIdx = next.indexOf(dragKey.current!);
      const toIdx = next.indexOf(targetKey);
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, dragKey.current!);
      return next;
    });
    dragKey.current = null;
  };

  const handleDelete = async (holding: Holding) => {
    if (!confirm(`Remove ${holding.name} from this portfolio?`)) return;
    const { error } = await supabase.from("holdings").delete().eq("id", holding.id);
    if (error) toast.error("Failed to delete holding");
    else {
      toast.success("Holding removed");
      void triggerGeographySync();
      load();
    }
  };

  const submitCashChange = async () => {
    if (!portfolio) return;
    const amount = Number(cashAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    const currentCash = portfolio.cash_value ?? 0;
    const delta = cashAction === "deposit" ? amount : -amount;
    const nextCash = currentCash + delta;
    if (nextCash < 0) {
      toast.error("Withdrawal exceeds available cash");
      return;
    }
    try {
      setCashSubmitting(true);
      const { error } = await supabase
        .from("portfolios")
        .update({ cash_value: nextCash })
        .eq("id", portfolio.id);
      if (error) throw error;
      setPortfolio((prev) => (prev ? { ...prev, cash_value: nextCash } : prev));
      toast.success(cashAction === "deposit" ? "Cash deposited" : "Cash withdrawn");
      setCashAmount("");
      setCashDialogOpen(false);
    } catch {
      toast.error("Failed to update cash");
    } finally {
      setCashSubmitting(false);
    }
  };

  const markIsinCopied = useCallback((rowId: string) => {
    setCopiedId(rowId);
    window.setTimeout(() => setCopiedId(null), 1200);
  }, []);

  const applyTransactionPreset = (preset: DatePreset) => {
    setTransactionDateRange(getPresetRange(preset));
    setTransactionDateLabel(preset === "All" ? "All" : preset);
    setTransactionCalendarRange(undefined);
  };

  const applyManualTransactionRange = (range: DateRange | undefined) => {
    setTransactionCalendarRange(range);
    const nextRange = {
      from: range?.from ? toIsoDate(range.from) : null,
      to: range?.to ? toIsoDate(range.to) : range?.from ? toIsoDate(range.from) : null,
    };
    setTransactionDateRange(nextRange);
    if (nextRange.from && nextRange.to)
      setTransactionDateLabel(`${nextRange.from} - ${nextRange.to}`);
    else setTransactionDateLabel("Date range");
  };

  const resetTransactionDateRange = () => {
    setTransactionDateRange({ from: null, to: null });
    setTransactionDateLabel("Date range");
    setTransactionCalendarRange(undefined);
  };

  const openExportSheet = () => {
    const nextPreset = getInitialExportPreset(transactionDateLabel, transactionDateRange);
    setExportFormat("xlsx");
    setSelectedCsvExportScopes(["portfolio"]);
    setExportDatePreset(nextPreset);
    setExportDateRange({ ...transactionDateRange });
    setExportError(null);
    setExportSheetOpen(true);
  };

  const toggleCsvExportScope = (scope: CsvExportScope, checked: boolean) => {
    setSelectedCsvExportScopes((current) => {
      if (checked) return current.includes(scope) ? current : [...current, scope];
      return current.filter((item) => item !== scope);
    });
  };

  const updateExportDatePreset = (preset: ExportDatePreset) => {
    setExportDatePreset(preset);
    if (preset !== "custom") setExportDateRange(getExportDatePresetRange(preset));
  };

  const updateCustomExportDate = (key: keyof ExportDateRange, value: string) => {
    setExportDatePreset("custom");
    setExportDateRange((current) => ({ ...current, [key]: value || null }));
  };

  const markColumnModifierSelect = (event: { shiftKey: boolean }) => {
    columnModifierSelectRef.current = event.shiftKey;
  };

  const handleColumnSelect = (event: Event) => {
    if (columnModifierSelectRef.current) event.preventDefault();
    columnModifierSelectRef.current = false;
  };

  const fetchChartExportRows = async (
    dateRange: ExportDateRange,
  ): Promise<{ rows: ExportRow[]; returnRows: ExportRow[]; returnHeaders: string[] }> => {
    if (!portfolioId) {
      return {
        rows: [],
        returnRows: [],
        returnHeaders: PORTFOLIO_RETURN_EXPORT_HEADERS,
      };
    }
    const response = await fetch(`${API_BASE_URL}/api/portfolios/${portfolioId}/chart`, {
      headers: await authHeaders(),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Failed to load portfolio value history");

    const chartRows = ((body.series ?? []) as ChartSeries[]).filter((point) =>
      isWithinDateRange(point.date, dateRange),
    );
    const activeBenchmarks = loadStoredActiveBenchmarks(portfolioId);
    const firstDate = chartRows[0]?.date;
    const benchmarkPrices = new Map<string, BenchmarkPricePoint[]>();

    if (firstDate) {
      await Promise.all(
        activeBenchmarks.map(async (benchmark) => {
          const ticker = benchmark.ticker.toUpperCase();
          const benchmarkResponse = await fetch(
            `${API_BASE_URL}/api/benchmarks/${encodeURIComponent(ticker)}/prices?from=${encodeURIComponent(firstDate)}`,
            { headers: await authHeaders() },
          );
          if (!benchmarkResponse.ok) {
            benchmarkPrices.set(ticker, []);
            return;
          }
          const benchmarkBody = (await benchmarkResponse.json()) as BenchmarkPricePoint[];
          benchmarkPrices.set(
            ticker,
            Array.isArray(benchmarkBody)
              ? benchmarkBody
                  .filter((point) => Number.isFinite(point.close) && point.close > 0)
                  .sort((a, b) => a.date.localeCompare(b.date))
              : [],
          );
        }),
      );
    }

    const benchmarkReturnSeries = new Map<string, Array<{ date: string; value: number }>>();
    for (const benchmark of activeBenchmarks) {
      const ticker = benchmark.ticker.toUpperCase();
      benchmarkReturnSeries.set(
        ticker,
        benchmarkPricesToReturnPoints(benchmarkPrices.get(ticker) ?? []),
      );
    }

    const rowsWithBenchmarks = chartRows.map((point) => {
      const row: ExportRow = {
        Date: point.date,
        "Total Value": point.total_value,
        "Cash Balance": point.cash_balance,
        "Securities Value": point.securities_value,
        "Simple Return %": point.simple_return_pct,
        "TWR %": point.twr_pct,
      };
      for (const benchmark of activeBenchmarks) {
        row[benchmarkColumnName(benchmark)] = latestReturnOnOrBefore(
          benchmarkReturnSeries.get(benchmark.ticker.toUpperCase()) ?? [],
          point.date,
        );
      }
      return row;
    });

    const returnHeaders = [...PORTFOLIO_RETURN_EXPORT_HEADERS];
    const monthlyReturnByPeriod = new Map<string, ExportRow>();
    for (const point of computeMonthlyReturnValues(
      chartRows.map((row) => ({ date: row.date, value: row.twr_pct })),
    )) {
      monthlyReturnByPeriod.set(point.period, {
        Period: point.period,
        "Portfolio Return %": point.value ?? "",
      });
    }

    for (const benchmark of activeBenchmarks) {
      const columnName = benchmarkReturnColumnName(benchmark);
      if (!returnHeaders.includes(columnName)) returnHeaders.push(columnName);
      const benchmarkReturnRows = computeMonthlyReturnValues(
        benchmarkPricesToReturnPoints(benchmarkPrices.get(benchmark.ticker.toUpperCase()) ?? []),
      );
      for (const point of benchmarkReturnRows) {
        const row = monthlyReturnByPeriod.get(point.period) ?? { Period: point.period };
        row[columnName] = point.value ?? "";
        monthlyReturnByPeriod.set(point.period, row);
      }
    }

    return {
      rows: rowsWithBenchmarks,
      returnRows: Array.from(monthlyReturnByPeriod.values()),
      returnHeaders,
    };
  };

  const fetchGeographyExportRows = async (): Promise<ExportRow[]> => {
    if (!portfolioId) return [];
    try {
      const response = await fetch(`${API_BASE_URL}/api/portfolios/${portfolioId}/geography`, {
        headers: await authHeaders(),
      });
      if (!response.ok) return [];
      const body = (await response.json()) as GeographyResponse;
      const countryRows = (body.countries ?? []).map((country) => ({
        Category: "Geography",
        Name: country.countryName ?? "Unknown",
        Code: country.countryCode ?? "",
        Value: country.value ?? "",
        "Weight %": country.percentage ?? "",
        Source: country.source ?? "",
        Confidence: country.confidence ?? "",
        "Checked At": body.checkedAt ?? "",
        Notes: "",
      }));
      return countryRows;
    } catch {
      return [];
    }
  };

  const fetchSavedBenchmarkRows = async (): Promise<ExportRow[]> => {
    if (!portfolioId) return [];
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/portfolios/${portfolioId}/benchmarks/saved`,
        { headers: await authHeaders() },
      );
      if (!response.ok) return [];
      const body = (await response.json()) as { benchmarks?: BenchmarkDefinition[] };
      const activeBenchmarks = loadStoredActiveBenchmarks(portfolioId);
      const activeIds = new Set(activeBenchmarks.map((benchmark) => benchmark.id).filter(Boolean));
      const activeTickers = new Set(
        activeBenchmarks.map((benchmark) => benchmark.ticker.toUpperCase()).filter(Boolean),
      );
      return (body.benchmarks ?? []).map((benchmark) => {
        const ticker = benchmark.ticker.toUpperCase();
        const active = Boolean(
          (benchmark.id && activeIds.has(benchmark.id)) || activeTickers.has(ticker),
        );
        return {
          Name: benchmark.name,
          Ticker: ticker,
          Color: benchmark.color ?? "",
          Weights:
            benchmark.weights == null || benchmark.weights === ""
              ? ""
              : JSON.stringify(benchmark.weights),
          "Created At": benchmark.created_at ?? "",
          Active: active ? "Yes" : "No",
        };
      });
    } catch {
      return [];
    }
  };

  const fetchTransactionExportRows = async (dateRange: ExportDateRange) => {
    if (!portfolioId) return [];
    return (await fetchPortfolioTransactions(portfolioId))
      .filter((transaction) => isWithinDateRange(transaction.date, dateRange))
      .map(transactionToExportRow);
  };

  const fetchLastPriceMap = async (): Promise<
    Record<string, { date: string | null; close: number | null }>
  > => {
    if (!portfolioId) return {};
    try {
      const response = await fetch(`${API_BASE_URL}/api/portfolios/${portfolioId}/last-prices`, {
        headers: await authHeaders(),
      });
      if (!response.ok) return {};
      const body = (await response.json()) as Array<{
        ticker: string;
        date: string | null;
        close: number | null;
      }>;
      return body.reduce<Record<string, { date: string | null; close: number | null }>>(
        (acc, entry) => {
          acc[entry.ticker.toUpperCase()] = { date: entry.date, close: entry.close };
          return acc;
        },
        {},
      );
    } catch {
      return {};
    }
  };

  const buildExportDataset = async (dateRange: ExportDateRange): Promise<ExportDataset> => {
    const [portfolioExport, transactionsRows, geographyRows, savedBenchmarkRows, lastPriceMap] =
      await Promise.all([
        fetchChartExportRows(dateRange),
        fetchTransactionExportRows(dateRange),
        fetchGeographyExportRows(),
        fetchSavedBenchmarkRows(),
        fetchLastPriceMap(),
      ]);
    const enrichedHoldingsRows = holdingsSnapshotRows.map((row) => {
      const ticker = String(row.Ticker ?? "").toUpperCase();
      const entry = lastPriceMap[ticker];
      if (!entry) return row;
      return {
        ...row,
        "Last Price": entry.close ?? row["Last Price"] ?? null,
        "Last Price Update": entry.date ?? row["Last Price Update"] ?? "",
      };
    });
    const allocationRows = [...allocationExportRows, ...geographyRows];
    const portfolioSummary: ExportRow = {
      "Portfolio Name": portfolio?.name ?? "Portfolio",
      Currency: portfolioCurrency,
      "Total Value": totalValue,
      Cash: cashValue,
      "Cost Basis": totalCost,
      "Unrealized P/L": unrealizedPL,
      "Unrealized P/L %": Number(unrealizedPct.toFixed(2)),
      "Realized P/L": hasRealizedPnL ? realizedMetrics.realizedPnL : "",
      "Realized P/L %": hasRealizedPnL ? Number(realizedMetrics.realizedPct.toFixed(2)) : "",
      Holdings: holdings.length,
    };

    return {
      portfolioRows: portfolioExport.rows,
      portfolioReturnRows: portfolioExport.returnRows,
      portfolioReturnHeaders: portfolioExport.returnHeaders,
      allocationRows,
      holdingsRows: enrichedHoldingsRows,
      transactionsRows,
      savedBenchmarkRows,
      jsonPayload: {
        meta: {
          exported_at: new Date().toISOString(),
          portfolio_name: portfolio?.name ?? "Portfolio",
          account_type: "Unknown",
          currency: portfolioCurrency,
          date_range: dateRange,
        },
        portfolio: {
          summary: portfolioSummary,
          value_history: portfolioExport.rows,
        },
        allocation: {
          sectors: sectorAllocationRows,
          asset_types: assetTypeAllocationRows,
          geography: geographyRows,
        },
        holdings: enrichedHoldingsRows,
        transactions: transactionsRows,
        saved_benchmarks: savedBenchmarkRows,
      },
    };
  };

  const handleExportDownload = async () => {
    if (!portfolio) return;
    if (exportFormat === "csv" && selectedCsvExportScopes.length === 0) return;
    setExportSubmitting(true);
    setExportError(null);
    try {
      const dataset = await buildExportDataset(exportDateRange);
      const portfolioHeaders = [...PORTFOLIO_EXPORT_HEADERS];
      for (const row of dataset.portfolioRows) {
        for (const key of Object.keys(row)) {
          if (!portfolioHeaders.includes(key)) portfolioHeaders.push(key);
        }
      }

      if (exportFormat === "xlsx") {
        exportToXlsx(formatExportFilename(portfolio.name, "export", "xlsx"), [
          {
            name: "Portfolio Value",
            rows: dataset.portfolioRows,
            headers: portfolioHeaders,
            sections: [
              {
                title: "Bars (returns)",
                rows: dataset.portfolioReturnRows,
                headers: dataset.portfolioReturnHeaders,
              },
            ],
          },
          { name: "Allocation", rows: dataset.allocationRows, headers: ALLOCATION_EXPORT_HEADERS },
          { name: "Holdings", rows: dataset.holdingsRows, headers: HOLDINGS_EXPORT_HEADERS },
          {
            name: "Transactions",
            rows: dataset.transactionsRows,
            headers: TRANSACTION_EXPORT_HEADERS,
          },
          {
            name: "Saved Benchmarks",
            rows: dataset.savedBenchmarkRows,
            headers: SAVED_BENCHMARKS_EXPORT_HEADERS,
          },
        ]);
      } else if (exportFormat === "csv") {
        const csvRowsByScope: Record<CsvExportScope, { rows: ExportRow[]; headers: string[] }> = {
          portfolio: { rows: dataset.portfolioRows, headers: portfolioHeaders },
          allocation: { rows: dataset.allocationRows, headers: ALLOCATION_EXPORT_HEADERS },
          holdings: { rows: dataset.holdingsRows, headers: HOLDINGS_EXPORT_HEADERS },
          transactions: { rows: dataset.transactionsRows, headers: TRANSACTION_EXPORT_HEADERS },
        };
        for (const scope of selectedCsvExportScopes) {
          const csvData = csvRowsByScope[scope];
          exportToCsv(
            formatExportFilename(portfolio.name, scope, "csv"),
            csvData.rows,
            csvData.headers,
          );
        }
      } else {
        exportToJson(formatExportFilename(portfolio.name, "export", "json"), dataset.jsonPayload);
      }

      toast.success("Export downloaded");
      setExportSheetOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Export failed";
      setExportError(message);
    } finally {
      setExportSubmitting(false);
    }
  };

  if (loading)
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-foreground-muted">
        <OrbitRing className="size-6" />
        <span>Loading portfolio.</span>
      </div>
    );

  if (!portfolio)
    return (
      <div className="py-24 text-center">
        <p className="text-foreground-muted">Portfolio not found</p>
        <Link
          href="/portfolios"
          className="mt-2 inline-block text-sm text-foreground hover:underline"
        >
          Back to portfolios
        </Link>
      </div>
    );

  return (
    <div className="bg-background text-foreground">
      <div className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-4 pb-8 pt-4 sm:px-6">
        {/* Compact header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/portfolios">
              <button
                type="button"
                className="grid h-7 w-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            </Link>
            <h1 className="text-xl font-semibold tracking-tight">{portfolio.name}</h1>
            <span className="rounded-full border border-hairline bg-surface px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground-muted">
              {holdings.length} holdings
            </span>
            {portfolio.description && (
              <span className="text-xs text-foreground-muted">{portfolio.description}</span>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={openExportSheet}
              className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-2 md:py-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </button>
          </div>
        </div>

        {/* Allocation + Geography 2-col grid. Container-, not viewport-, driven:
            `lg:` fired at 1024px of WINDOW, which is only ~756px of content once the
            sidebar and gutters are taken out — two 370px cards. @4xl (896px) is
            measured against the real content box, so the split waits for room. */}
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
          <AllocationCard
            portfolioId={portfolioId!}
            sectorData={sectorData}
            assetTypeData={assetTypeData}
            currency={portfolioCurrency}
            initialView="classic"
            hideViewToggle
          />
          <AllocationCard
            portfolioId={portfolioId!}
            sectorData={sectorData}
            assetTypeData={assetTypeData}
            currency={portfolioCurrency}
            initialView="geography"
            hideViewToggle
          />
        </div>

        {/* 1px divider above holdings table */}
        <div className="border-t border-hairline" />

        {/* Holdings and transaction history */}
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)}>
          <div className="rounded-2xl border border-hairline bg-surface">
            <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-5 py-3">
              <TabsList className="h-11 rounded-full border border-hairline bg-surface-2 p-0.5 md:h-9">
                <TabsTrigger
                  value="holdings"
                  className={`relative h-10 rounded-full px-4 text-[11px] uppercase tracking-[0.1em] transition-colors md:h-8 ${
                    activeTab === "holdings"
                      ? "text-background"
                      : "text-foreground-muted hover:text-foreground"
                  } isolate data-[state=active]:!bg-transparent data-[state=active]:!shadow-none`}
                >
                  {activeTab === "holdings" && (
                    <motion.span
                      layoutId="portfolio-history-tab-pill"
                      className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                      transition={pillTransition}
                    />
                  )}
                  <span
                    className={`relative z-10 ${
                      activeTab === "holdings" ? "text-background" : "text-foreground-muted"
                    }`}
                  >
                    Holdings
                    <span className="ml-1.5 tabular-nums opacity-70">{rows.length}</span>
                  </span>
                </TabsTrigger>
                <TabsTrigger
                  value="transactions"
                  className={`relative h-10 rounded-full px-4 text-[11px] uppercase tracking-[0.1em] transition-colors md:h-8 ${
                    activeTab === "transactions"
                      ? "text-background"
                      : "text-foreground-muted hover:text-foreground"
                  } isolate data-[state=active]:!bg-transparent data-[state=active]:!shadow-none`}
                >
                  {activeTab === "transactions" && (
                    <motion.span
                      layoutId="portfolio-history-tab-pill"
                      className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                      transition={pillTransition}
                    />
                  )}
                  <span
                    className={`relative z-10 ${
                      activeTab === "transactions" ? "text-background" : "text-foreground-muted"
                    }`}
                  >
                    Transactions
                  </span>
                </TabsTrigger>
              </TabsList>

              {activeTab === "holdings" ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-10 rounded-full bg-background px-4 md:h-8"
                    >
                      <Columns3 className="h-3.5 w-3.5" />
                      Columns
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className="flex items-center justify-between gap-3">
                        <span>Columns</span>
                        <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-normal text-foreground-muted">
                          <Keyboard className="h-3 w-3" />
                          Hold
                          <ArrowBigUp className="h-3 w-3" />
                          for multi-select
                        </span>
                      </DropdownMenuLabel>
                      {ALL_COLUMNS.map((column) => (
                        <DropdownMenuCheckboxItem
                          key={column.key}
                          checked={!hiddenCols.has(column.key)}
                          onCheckedChange={() => toggleHide(column.key)}
                          onPointerDown={markColumnModifierSelect}
                          onKeyDown={markColumnModifierSelect}
                          onSelect={handleColumnSelect}
                        >
                          {column.label}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <>
                  <div className="relative min-w-[220px] flex-1 sm:flex-none">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted" />
                    <Input
                      value={transactionSearch}
                      onChange={(event) => setTransactionSearch(event.target.value)}
                      placeholder="Search..."
                      className="h-9 rounded-full bg-background pl-9 text-xs"
                    />
                  </div>
                  <Popover>
                    <div className="inline-flex h-9 items-center rounded-full border border-input bg-background shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground">
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex h-full items-center gap-2 rounded-l-full px-4 text-xs font-medium"
                        >
                          <CalendarDays className="h-3.5 w-3.5" />
                          {transactionDateLabel}
                        </button>
                      </PopoverTrigger>
                      {hasTransactionDateFilter && (
                        <button
                          type="button"
                          onClick={resetTransactionDateRange}
                          className="mr-1 grid h-7 w-7 place-items-center rounded-full text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                          aria-label="Clear transaction date filter"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {/* Two months is ~560px wide — wider than a phone. Cap to the
                        viewport and let the calendar scroll inside the popover. */}
                    <PopoverContent
                      className="w-auto max-w-[calc(100vw-2rem)] overflow-x-auto p-3"
                      align="start"
                    >
                      <div className="mb-3 flex flex-wrap gap-2">
                        {(["30D", "90D", "YTD", "All"] as DatePreset[]).map((preset) => (
                          <Button
                            key={preset}
                            type="button"
                            variant={transactionDateLabel === preset ? "default" : "outline"}
                            size="sm"
                            className="h-7 rounded-full px-3 text-[11px]"
                            onClick={() => applyTransactionPreset(preset)}
                          >
                            {preset}
                          </Button>
                        ))}
                      </div>
                      <Calendar
                        mode="range"
                        selected={transactionCalendarRange}
                        onSelect={applyManualTransactionRange}
                        numberOfMonths={2}
                      />
                      <div className="mt-3 flex justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={resetTransactionDateRange}
                        >
                          Reset
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                </>
              )}

              <div className="ml-auto flex shrink-0 items-center gap-2">
                {activeTab === "holdings" ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setCashAction("deposit");
                        setCashDialogOpen(true);
                      }}
                      className="h-10 rounded-full bg-background px-4 md:h-8"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add cash
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => setAddHoldingOpen(true)}
                      className="h-10 rounded-full px-4 md:h-8"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add holding
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setManualTransactionOpen(true)}
                      className="h-10 rounded-full bg-background px-4 md:h-8"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add transaction
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => setImportOpen(true)}
                      className="h-10 rounded-full px-4 md:h-8"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Import transactions
                    </Button>
                  </>
                )}
              </div>
            </div>

            <TabsContent value="holdings" className="m-0">
              <div className="overflow-x-auto">
                <table
                  className="w-full table-auto text-sm"
                  style={{ minWidth: `${holdingsTableMinWidth}px` }}
                >
                  <colgroup>
                    {visibleCols.map((key) => (
                      <col
                        key={key}
                        style={{
                          width: COLUMN_WIDTHS[key] ? `${COLUMN_WIDTHS[key]}px` : "auto",
                        }}
                      />
                    ))}
                    <col style={{ width: `${ACTIONS_COLUMN_WIDTH}px` }} />
                  </colgroup>
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.1em] text-foreground-muted">
                      {visibleCols.map((key) => {
                        const col = ALL_COLUMNS.find((c) => c.key === key)!;
                        const active = sortBy === key;
                        const isAllocationStart = key === "total";
                        const isPerformanceStart = key === "gl";
                        const isTake = key === "take";
                        return (
                          <ContextMenu key={key}>
                            <ContextMenuTrigger asChild>
                              <th
                                draggable
                                onDragStart={() => handleDragStart(key)}
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={() => handleDrop(key)}
                                onClick={() => handleSort(key)}
                                className={`cursor-pointer select-none whitespace-nowrap px-3 py-3 font-medium transition-colors ${
                                  col.align === "right"
                                    ? "text-right"
                                    : col.align === "center"
                                      ? "text-center"
                                      : "text-left"
                                } ${active ? "text-foreground" : ""} ${
                                  isAllocationStart || isPerformanceStart || isTake
                                    ? "border-l border-hairline/60"
                                    : ""
                                } ${key === "name" ? "px-5" : ""}`}
                              >
                                {col.label}
                                {active && (
                                  <span className="ml-1 text-[9px]">
                                    {sortDir === "asc" ? "↑" : "↓"}
                                  </span>
                                )}
                              </th>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-48">
                              {ALL_COLUMNS.map((c) => (
                                <ContextMenuCheckboxItem
                                  key={c.key}
                                  checked={!hiddenCols.has(c.key)}
                                  onCheckedChange={() => toggleHide(c.key)}
                                >
                                  {c.label}
                                </ContextMenuCheckboxItem>
                              ))}
                            </ContextMenuContent>
                          </ContextMenu>
                        );
                      })}
                      <th className="px-2 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={visibleCols.length + 1}
                          className="py-10 text-center text-sm text-foreground-muted"
                        >
                          No holdings — add one to get started
                        </td>
                      </tr>
                    ) : (
                      rows.map((r) => {
                        const raw = holdings.find((h) => h.id === r.id)!;
                        const tickerTheses = thesesForTicker(theses, r.ticker);
                        return (
                          <tr
                            key={r.id}
                            className="border-t border-hairline/60 transition-colors hover:bg-surface-2/60 group"
                          >
                            {visibleCols.map((key) => {
                              const col = ALL_COLUMNS.find((c) => c.key === key)!;
                              const alignCls =
                                col.align === "right"
                                  ? "text-right"
                                  : col.align === "center"
                                    ? "text-center"
                                    : "";
                              const isAllocationStart = key === "total";
                              const isPerformanceStart = key === "gl";
                              const isTake = key === "take";
                              return (
                                <td
                                  key={key}
                                  className={`px-3 py-3 text-[12px] ${alignCls} ${
                                    isAllocationStart || isPerformanceStart || isTake
                                      ? "border-l border-hairline/60"
                                      : ""
                                  } ${key === "name" ? "px-5" : ""}`}
                                >
                                  {key === "name" && (
                                    <div className="flex items-center gap-3">
                                      <TooltipProvider>
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <AnimatedCopyButton
                                              textToCopy={r.isin ?? ""}
                                              size="sm"
                                              ariaLabel="Copy ISIN"
                                              onCopy={() => markIsinCopied(r.id)}
                                              onCopyError={() =>
                                                toast.error(
                                                  r.isin
                                                    ? "Failed to copy ISIN"
                                                    : "No ISIN available for this holding",
                                                )
                                              }
                                            />
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            <p>
                                              {copiedId === r.id
                                                ? "Copied!"
                                                : r.isin
                                                  ? "Copy ISIN"
                                                  : "No ISIN"}
                                            </p>
                                          </TooltipContent>
                                        </Tooltip>
                                      </TooltipProvider>
                                      <div className="min-w-0">
                                        <div className="truncate font-medium text-foreground">
                                          {r.name}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-x-1.5 text-foreground-muted">
                                          <span className="font-mono text-[11px] font-medium tabular-nums">
                                            {r.ticker}
                                          </span>
                                          {r.isin && (
                                            <span className="font-mono text-[11px] font-normal text-muted-foreground">
                                              {r.isin}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                  {key === "qty" && (
                                    <span className="font-mono text-[11px] tabular-nums">
                                      {r.qty}
                                    </span>
                                  )}
                                  {key === "assetType" && (
                                    <span className="text-foreground-muted">{r.assetType}</span>
                                  )}
                                  {key === "currency" && (
                                    <span className="font-mono text-[11px] tabular-nums text-foreground-muted">
                                      {r.currency}
                                    </span>
                                  )}
                                  {key === "cur" && (
                                    <span className="font-mono text-[11px] tabular-nums">
                                      {fmtMoney(r.cur, r.currency)}
                                    </span>
                                  )}
                                  {key === "buy" && (
                                    <span className="font-mono text-[11px] tabular-nums text-foreground-muted">
                                      {fmtMoney(r.buy, r.currency)}
                                    </span>
                                  )}
                                  {key === "total" && (
                                    <span className="font-mono text-[11px] font-medium tabular-nums">
                                      {fmtMoney(r.total, portfolioCurrency)}
                                    </span>
                                  )}
                                  {key === "gl" && (
                                    <PerfCell value={r.gl} money currency={portfolioCurrency} />
                                  )}
                                  {key === "weight" && (
                                    <span className="font-mono text-[11px] tabular-nums text-foreground-muted">
                                      {r.weight.toFixed(1)}%
                                    </span>
                                  )}
                                  {key === "sector" && (
                                    <span className="text-foreground-muted">{r.sector}</span>
                                  )}
                                  {key === "perf1D" && <PerfCell value={r.perf1D} />}
                                  {key === "perfYTD" && <PerfCell value={r.perfYTD} />}
                                  {key === "take" && (
                                    <div className="flex justify-center">
                                      <TakeBadge
                                        theses={tickerTheses}
                                        onOpen={openDrawer}
                                        onCreate={() =>
                                          openModal(undefined, { tickers: [r.ticker] })
                                        }
                                      />
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                            {/* Row actions */}
                            <td className="px-2 py-3">
                              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  onClick={() => setEditingHolding(raw)}
                                >
                                  <Pencil className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 text-destructive hover:text-destructive"
                                  onClick={() => handleDelete(raw)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </TabsContent>

            <TabsContent value="transactions" className="m-0 p-4">
              <TransactionHistoryTab
                portfolioId={portfolioId!}
                currency={portfolioCurrency}
                searchQuery={transactionSearch}
                dateRange={transactionDateRange}
                onDeleted={() => load()}
                onEdited={() => load()}
              />
            </TabsContent>
          </div>
        </Tabs>

        <Sheet open={exportSheetOpen} onOpenChange={setExportSheetOpen}>
          <SheetContent
            side="right"
            className="flex w-[min(440px,100vw)] flex-col gap-0 p-0 sm:max-w-[440px]"
          >
            <SheetHeader className="border-b border-hairline px-5 py-4 pr-12">
              <SheetTitle className="text-base">Export</SheetTitle>
              <SheetDescription>Download portfolio data for analysis or backup.</SheetDescription>
            </SheetHeader>

            <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
              <section className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-foreground-muted">
                  Format
                </Label>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ["xlsx", "Excel", FileSpreadsheet],
                      ["csv", "CSV", FileText],
                      ["json", "JSON", FileJson],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setExportFormat(value)}
                      className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors ${
                        exportFormat === value
                          ? "border-foreground bg-foreground text-background"
                          : "border-hairline bg-surface text-foreground-muted hover:bg-surface-2 hover:text-foreground"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  ))}
                  <TooltipProvider delayDuration={150}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          disabled
                          className="inline-flex h-9 cursor-not-allowed items-center gap-2 rounded-full border border-hairline bg-surface px-3 text-xs font-medium text-foreground-muted opacity-50"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          PDF Report
                          <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                            Soon
                          </span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" sideOffset={8} className="max-w-64 text-center">
                        PDF Report is coming soon. It will include AI-generated commentary and
                        time-scoped views.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </section>

              {exportFormat === "csv" && (
                <section className="space-y-2">
                  <FieldSet>
                    <FieldLegend variant="label">What to export</FieldLegend>
                    <FieldGroup className="gap-3">
                      {(
                        [
                          ["portfolio", "Portfolio"],
                          ["allocation", "Allocation"],
                          ["holdings", "Holdings"],
                          ["transactions", "Transactions"],
                        ] as const
                      ).map(([value, label]) => (
                        <Field key={value} orientation="horizontal">
                          <Checkbox
                            id={`export-scope-${value}`}
                            checked={selectedCsvExportScopes.includes(value)}
                            onCheckedChange={(checked) =>
                              toggleCsvExportScope(value, checked === true)
                            }
                          />
                          <FieldLabel
                            htmlFor={`export-scope-${value}`}
                            className="cursor-pointer font-normal"
                          >
                            {label}
                          </FieldLabel>
                        </Field>
                      ))}
                    </FieldGroup>
                  </FieldSet>
                  <p className="flex gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-foreground-muted">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Selecting multiple datasets downloads one CSV file for each checked option.
                    </span>
                  </p>
                  {selectedCsvExportScopes.length === 0 && (
                    <p className="text-xs text-destructive">
                      Select at least one dataset to download CSV.
                    </p>
                  )}
                </section>
              )}

              <section className="space-y-3">
                <div className="space-y-2">
                  <Label
                    htmlFor="export-date-range"
                    className="text-xs uppercase tracking-wider text-foreground-muted"
                  >
                    Date range
                  </Label>
                  <Select value={exportDatePreset} onValueChange={updateExportDatePreset}>
                    <SelectTrigger
                      id="export-date-range"
                      className="h-10 rounded-full bg-background"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all_time">All time</SelectItem>
                      <SelectItem value="ytd">YTD</SelectItem>
                      <SelectItem value="last_12_months">Last 12 months</SelectItem>
                      <SelectItem value="last_quarter">Last quarter</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {exportDatePreset === "custom" && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="export-date-from" className="text-xs text-foreground-muted">
                        Start date
                      </Label>
                      <Input
                        id="export-date-from"
                        type="date"
                        value={exportDateRange.from ?? ""}
                        onChange={(event) => updateCustomExportDate("from", event.target.value)}
                        className="h-9 rounded-full bg-background text-xs"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="export-date-to" className="text-xs text-foreground-muted">
                        End date
                      </Label>
                      <Input
                        id="export-date-to"
                        type="date"
                        value={exportDateRange.to ?? ""}
                        onChange={(event) => updateCustomExportDate("to", event.target.value)}
                        className="h-9 rounded-full bg-background text-xs"
                      />
                    </div>
                  </div>
                )}

                <p className="flex gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-foreground-muted">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Date range applies to transactions and portfolio history. Holdings and
                    allocation reflect current values.
                  </span>
                </p>
              </section>
            </div>

            <SheetFooter className="border-t border-hairline px-5 py-4">
              {exportError && (
                <p className="mr-auto text-left text-xs text-destructive">{exportError}</p>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => setExportSheetOpen(false)}
                disabled={exportSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleExportDownload}
                disabled={
                  exportSubmitting ||
                  (exportFormat === "csv" && selectedCsvExportScopes.length === 0)
                }
              >
                <Download className="h-4 w-4" />
                {exportSubmitting ? "Preparing..." : "Download"}
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        {/* Modals */}
        <AddHoldingModal
          open={addHoldingOpen}
          onOpenChange={setAddHoldingOpen}
          portfolioId={portfolioId!}
          portfolioCurrency={portfolioCurrency}
          onAdded={() => {
            setAddHoldingOpen(false);
            void triggerGeographySync();
            load();
          }}
        />

        <Dialog open={cashDialogOpen} onOpenChange={setCashDialogOpen}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>
                {cashAction === "deposit" ? "Deposit cash" : "Withdraw cash"}
              </DialogTitle>
              <DialogDescription>
                Current cash balance:{" "}
                <span className="font-mono">{fmtMoney(cashValue, portfolioCurrency)}</span>
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={cashAction === "deposit" ? "default" : "outline"}
                  onClick={() => setCashAction("deposit")}
                >
                  Deposit
                </Button>
                <Button
                  type="button"
                  variant={cashAction === "withdraw" ? "default" : "outline"}
                  onClick={() => setCashAction("withdraw")}
                >
                  Withdraw
                </Button>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cash-amount">Amount</Label>
                <Input
                  id="cash-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={cashAmount}
                  onChange={(e) => setCashAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCashDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={cashSubmitting} onClick={submitCashChange}>
                {cashSubmitting
                  ? "Saving…"
                  : cashAction === "deposit"
                    ? "Deposit cash"
                    : "Withdraw cash"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {editingHolding && (
          <EditHoldingModal
            open={!!editingHolding}
            onOpenChange={(open) => {
              if (!open) setEditingHolding(null);
            }}
            holding={editingHolding}
            portfolioCurrency={portfolioCurrency}
            onUpdated={() => {
              setEditingHolding(null);
              void triggerGeographySync();
              load();
            }}
          />
        )}

        <ManualTransactionModal
          open={manualTransactionOpen}
          onOpenChange={setManualTransactionOpen}
          portfolioId={portfolioId!}
          onAdded={() => {
            setActiveTab("transactions");
            void triggerGeographySync();
            load();
          }}
        />

        <ImportTransactionsModal
          open={importOpen}
          onOpenChange={setImportOpen}
          portfolioId={portfolioId!}
          onImported={() => {
            setActiveTab("transactions");
            void triggerGeographySync();
            load();
          }}
        />
      </div>
    </div>
  );
}
