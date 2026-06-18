"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, Download, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { MOCK_STOCKS, CSV_TEMPLATE } from "@/lib/mock-data";
import Papa from "papaparse";
import { toast } from "sonner";
import { CurrencySelect } from "@/components/currency-select";
import { DEFAULT_PORTFOLIO_CURRENCY, normalizeCurrencyCode } from "@/lib/currency";
import { API_BASE_URL } from "@/lib/api";

interface AssetSearchResult {
  ticker: string;
  name: string;
  exchange: string;
  assetType: string;
  currency: string | null;
}

interface ParsedCsvRow {
  __row: number;
  __ticker: string;
  __exchange: string;
  __date: string;
  __price: number;
  __quantity: number;
  __fees: number;
  __isin: string;
  [key: string]: string | number;
}

const EXCHANGE_ALIASES: Record<string, string> = {
  EURONEXT: "PAR",
  "EURONEXT PARIS": "PAR",
  PARIS: "PAR",
  XPAR: "PAR",
  NYSE: "NYQ",
  NASDAQ: "NMS",
  NASDAQGS: "NMS",
  XETRA: "GER",
  SIX: "EBS",
  LSE: "LSE",
  LONDON: "LSE",
  TSX: "TOR",
  TSE: "TYO",
  HKEX: "HKG",
};

function normalizeExchange(raw: string | undefined): string {
  const normalized = raw?.trim().toUpperCase() || "";
  if (!normalized) return "";
  return EXCHANGE_ALIASES[normalized] ?? normalized;
}

function parseFlexibleNumber(raw: string | undefined): number {
  const value = raw?.trim() || "";
  if (!value) return 0;
  const compact = value.replace(/\s+/g, "");
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    const normalized = compact.split(thousandsSeparator).join("").replace(decimalSeparator, ".");
    return parseFloat(normalized) || 0;
  }

  if (lastComma > -1) {
    const parts = compact.split(",");
    if (parts.length === 2 && parts[1].length === 3 && parts[0].length >= 1) {
      return parseFloat(parts.join("")) || 0;
    }
    const normalized = compact.replace(",", ".");
    return parseFloat(normalized) || 0;
  }

  return parseFloat(compact) || 0;
}

function normalizeFlexibleDate(raw: string | undefined): string {
  const value = raw?.trim() || "";
  if (!value) throw new Error("Missing date");

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return value;

  const dmyOrMdy = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmyOrMdy) {
    const first = Number(dmyOrMdy[1]);
    const second = Number(dmyOrMdy[2]);
    const year = Number(dmyOrMdy[3]);
    if (first < 1 || first > 31 || second < 1 || second > 31) throw new Error("Invalid date");

    const day = first > 12 ? first : second > 12 ? second : first;
    const month = first > 12 ? second : second > 12 ? first : second;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid date");
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
}

function pickBestSearchMatch(
  inputTicker: string,
  inputExchange: string | undefined,
  matches: AssetSearchResult[],
) {
  if (matches.length === 0) return null;

  const normalized = inputTicker.trim().toUpperCase();
  const normalizedExchange = inputExchange?.trim().toUpperCase();
  const exact = matches.find((item) => item.ticker.toUpperCase() === normalized);
  if (exact) return exact;

  if (normalizedExchange) {
    const exchangeMatched = matches.find(
      (item) =>
        item.exchange?.trim().toUpperCase() === normalizedExchange ||
        item.ticker.toUpperCase().endsWith(`.${normalizedExchange}`),
    );
    if (exchangeMatched) return exchangeMatched;
  }

  const prefix = matches.find((item) => item.ticker.toUpperCase().startsWith(`${normalized}.`));
  if (prefix) return prefix;

  return matches[0];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function CreateCsvModal({ open, onOpenChange, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState(DEFAULT_PORTFOLIO_CURRENCY);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith(".csv")) setFile(f);
    else toast.error("Please drop a CSV file");
  }, []);

  const handleDownloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "portfolio_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSubmit = async () => {
    if (!name.trim() || !file) return;
    setLoading(true);

    try {
      const text = await file.text();
      const result = Papa.parse(text, { header: true, skipEmptyLines: true });

      if (result.errors.length > 0) {
        toast.error("CSV parsing error: " + result.errors[0].message);
        setLoading(false);
        return;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: portfolio, error: pErr } = await supabase
        .from("portfolios")
        .insert({
          name: name.trim(),
          description: description.trim() || null,
          currency,
          user_id: user.id,
        })
        .select()
        .single();

      if (pErr) throw pErr;

      const parsedRows = result.data as Array<Record<string, string>>;
      const normalizedRows: ParsedCsvRow[] = parsedRows.map((row, index) => {
        const rowNum = index + 2;
        const ticker = (row.Ticker || "").toUpperCase().trim();
        const exchange = normalizeExchange(row.Exchange);
        const isin = row.ISIN?.trim().toUpperCase() || "";
        if (!ticker) throw new Error(`Missing ticker on CSV row ${rowNum}`);

        try {
          return {
            ...row,
            __row: rowNum,
            __ticker: ticker,
            __exchange: exchange,
            __date: normalizeFlexibleDate(row.Date),
            __price: parseFlexibleNumber(row.Price),
            __quantity: parseFlexibleNumber(row.Quantity),
            __fees: parseFlexibleNumber(row.Fees),
            __isin: isin,
          };
        } catch (error) {
          throw new Error(
            error instanceof Error
              ? `${error.message} on CSV row ${rowNum}`
              : `Invalid data on CSV row ${rowNum}`,
          );
        }
      });

      const uniqueLookups = Array.from(
        new Set(
          normalizedRows
            .map((row) => {
              if (!row.__ticker) return "";
              return `${row.__ticker}|${row.__exchange}|${row.__isin}`;
            })
            .filter(Boolean),
        ),
      );

      const metadataEntries = await Promise.all(
        uniqueLookups.map(async (lookupKey) => {
          const [ticker, exchange, isin] = lookupKey.split("|");
          const query = isin || (exchange ? `${ticker} ${exchange}` : ticker);
          try {
            const res = await fetch(
              `${API_BASE_URL}/api/market/search?q=${encodeURIComponent(query)}`,
            );
            if (!res.ok) return [lookupKey, null] as const;
            const matches = (await res.json()) as AssetSearchResult[];
            return [lookupKey, pickBestSearchMatch(ticker, exchange, matches)] as const;
          } catch {
            return [lookupKey, null] as const;
          }
        }),
      );

      const metadataByLookup = new Map(metadataEntries);

      const holdings = normalizedRows.map((row) => {
        const ticker = row.__ticker;
        const exchange = row.__exchange;
        const lookupKey = `${ticker}|${exchange}|${row.__isin}`;
        const resolved = metadataByLookup.get(lookupKey);
        const stock = MOCK_STOCKS.find((s) => s.ticker === ticker);

        const resolvedTicker = resolved?.ticker?.toUpperCase() || ticker;
        const csvIsin = row.__isin || (row.ISIN as string | undefined)?.trim();

        return {
          portfolio_id: portfolio.id,
          ticker: resolvedTicker,
          name: resolved?.name || stock?.name || String(row.Ticker || "Unknown"),
          asset_type: resolved?.assetType || null,
          currency: normalizeCurrencyCode(resolved?.currency, currency),
          isin: csvIsin || stock?.isin || null,
          purchase_date: row.__date,
          purchase_price: row.__price,
          quantity: row.__quantity,
          fees: row.__fees,
        };
      });

      const { error: hErr } = await supabase.from("holdings").insert(holdings);
      if (hErr) throw hErr;

      toast.success("Portfolio created successfully");
      setName("");
      setDescription("");
      setCurrency(DEFAULT_PORTFOLIO_CURRENCY);
      setFile(null);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create portfolio");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import from CSV</DialogTitle>
          <DialogDescription>Upload a CSV with your holdings data.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Portfolio name *</Label>
            <Input
              placeholder="My Portfolio"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input
              placeholder="Optional description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Currency</Label>
            <CurrencySelect value={currency} onValueChange={setCurrency} />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <Label>CSV file *</Label>
              <button
                onClick={handleDownloadTemplate}
                className="flex items-center gap-1 text-xs text-foreground hover:underline"
              >
                <Download className="h-3 w-3" /> Download template
              </button>
            </div>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 cursor-pointer transition-colors ${
                dragOver
                  ? "border-foreground bg-foreground/5"
                  : "border-border/50 hover:border-foreground/30"
              }`}
            >
              {file ? (
                <div className="flex items-center gap-2 text-sm">
                  <FileText className="h-4 w-4 text-foreground" />
                  <span>{file.name}</span>
                </div>
              ) : (
                <>
                  <Upload className="h-6 w-6 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">Drop a CSV or click to browse</p>
                </>
              )}
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
          </div>

          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || !file || loading}
            className="w-full"
          >
            {loading ? "Creating..." : "Create portfolio"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
