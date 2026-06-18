"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Minus,
  Pencil,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { OrbitRing } from "@/components/loading-ui/orbit-ring";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, normalizeCurrencyCode } from "@/lib/currency";
import { EditableTransaction, ManualTransactionModal } from "@/components/manual-transaction-modal";
import { API_BASE_URL } from "@/lib/api";

type Side = "BUY" | "SELL" | "DEP" | "WD" | "DIV" | "FEE";
type SortKey =
  | "date"
  | "symbol"
  | "isin"
  | "yahoo_ticker"
  | "side"
  | "quantity"
  | "net_amount"
  | "commission";

export interface TransactionDateRange {
  from: string | null;
  to: string | null;
}

export interface TransactionExportRow {
  Date: string;
  Symbol: string;
  ISIN: string;
  Ticker: string;
  Side: Side;
  Qty: number | string;
  "Net Amount": number | string;
  Commission: number | string;
}

interface Transaction {
  id: string;
  date: string;
  symbol: string;
  isin: string | null;
  yahoo_ticker: string | null;
  side: Side;
  quantity: number | null;
  net_amount: number | null;
  commission: number;
}

interface Props {
  portfolioId: string;
  currency: string;
  searchQuery: string;
  dateRange: TransactionDateRange;
  onDeleted?: () => void;
  onEdited?: () => void;
  onExportRowsChange?: (rows: TransactionExportRow[]) => void;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

const SIDE_COLOURS: Record<Side, string> = {
  BUY: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  SELL: "bg-red-500/10 text-red-400 border-red-500/20",
  DEP: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  WD: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  DIV: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  FEE: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
};

const COLUMNS: Array<{
  key: SortKey;
  label: string;
  align?: "left" | "right";
}> = [
  { key: "date", label: "Date" },
  { key: "symbol", label: "Symbol" },
  { key: "isin", label: "ISIN" },
  { key: "yahoo_ticker", label: "Ticker" },
  { key: "side", label: "Side" },
  { key: "quantity", label: "Qty", align: "right" },
  { key: "net_amount", label: "Net Amount", align: "right" },
  { key: "commission", label: "Commission", align: "right" },
];

function formatAmount(value: number | null, currency: string): string {
  if (value == null) return "-";
  return formatCurrency(value, currency);
}

function toExportRows(transactions: Transaction[]): TransactionExportRow[] {
  return transactions.map((transaction) => ({
    Date: transaction.date,
    Symbol: transaction.symbol,
    ISIN: transaction.isin ?? "",
    Ticker: transaction.yahoo_ticker ?? "",
    Side: transaction.side,
    Qty: transaction.quantity ?? "",
    "Net Amount": transaction.net_amount ?? "",
    Commission: transaction.commission || "",
  }));
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not authenticated");
  return { Authorization: `Bearer ${token}` };
}

export function TransactionHistoryTab({
  portfolioId,
  currency,
  searchQuery,
  dateRange,
  onDeleted,
  onEdited,
  onExportRowsChange,
}: Props) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<Transaction | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(25);
  const displayCurrency = normalizeCurrencyCode(currency);

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/portfolios/${portfolioId}/transactions`, {
        headers: await authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load transactions");
      setTransactions(data.transactions ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load transaction history");
    } finally {
      setLoading(false);
    }
  }, [portfolioId]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const filteredTransactions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return transactions.filter((transaction) => {
      const matchesSearch =
        !query ||
        transaction.symbol.toLowerCase().includes(query) ||
        (transaction.isin ?? "").toLowerCase().includes(query) ||
        (transaction.yahoo_ticker ?? "").toLowerCase().includes(query);
      const matchesFrom = !dateRange.from || transaction.date >= dateRange.from;
      const matchesTo = !dateRange.to || transaction.date <= dateRange.to;
      return matchesSearch && matchesFrom && matchesTo;
    });
  }, [transactions, searchQuery, dateRange]);

  const sortedTransactions = useMemo(() => {
    const sorted = [...filteredTransactions];
    sorted.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      const av = a[sortBy];
      const bv = b[sortBy];
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((Number(av ?? 0) || 0) - (Number(bv ?? 0) || 0)) * dir;
    });
    return sorted;
  }, [filteredTransactions, sortBy, sortDir]);

  useEffect(() => {
    onExportRowsChange?.(toExportRows(sortedTransactions));
  }, [onExportRowsChange, sortedTransactions]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, dateRange, pageSize]);

  const totalPages = Math.max(1, Math.ceil(sortedTransactions.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = sortedTransactions.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const pageEnd = Math.min(safePage * pageSize, sortedTransactions.length);
  const pagedTransactions = sortedTransactions.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );

  const handleSort = (key: SortKey) => {
    if (sortBy === key) setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    else {
      setSortBy(key);
      setSortDir("desc");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/portfolios/${portfolioId}/transactions/${deleteTarget.id}`,
        {
          method: "DELETE",
          headers: await authHeaders(),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Delete failed");
      toast.success("Transaction deleted. Chart rebuild queued.");
      setDeleteTarget(null);
      await fetchTransactions();
      onDeleted?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete transaction");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center gap-3 text-sm text-muted-foreground">
        <OrbitRing className="size-6" />
        <span>Loading transactions.</span>
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="flex h-32 flex-col items-center justify-center gap-2 text-muted-foreground">
        <AlertCircle className="h-5 w-5" />
        <p className="text-sm">No transactions imported yet.</p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((column) => {
                const active = sortBy === column.key;
                const SortIcon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : null;
                return (
                  <TableHead
                    key={column.key}
                    onClick={() => handleSort(column.key)}
                    className={`cursor-pointer select-none whitespace-nowrap text-xs ${
                      column.align === "right" ? "text-right" : ""
                    } ${active ? "text-foreground" : ""}`}
                  >
                    <span
                      className={`inline-flex items-center gap-1 ${
                        column.align === "right" ? "justify-end" : ""
                      }`}
                    >
                      {column.label}
                      {SortIcon ? (
                        <SortIcon className="h-3 w-3" />
                      ) : (
                        <Minus className="h-3 w-3 opacity-0" />
                      )}
                    </span>
                  </TableHead>
                );
              })}
              <TableHead className="w-8 text-xs" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagedTransactions.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMNS.length + 1}
                  className="h-28 text-center text-sm text-muted-foreground"
                >
                  No transactions match these filters.
                </TableCell>
              </TableRow>
            ) : (
              pagedTransactions.map((transaction) => (
                <TableRow key={transaction.id} className="group">
                  <TableCell className="font-mono text-xs">{transaction.date}</TableCell>
                  <TableCell className="max-w-[180px] truncate text-xs" title={transaction.symbol}>
                    {transaction.symbol}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {transaction.isin ?? "-"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {transaction.yahoo_ticker ?? "-"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium ${SIDE_COLOURS[transaction.side]}`}
                    >
                      {transaction.side}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {transaction.quantity ?? "-"}
                  </TableCell>
                  <TableCell
                    className={`text-right font-mono text-xs ${
                      (transaction.net_amount ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {formatAmount(transaction.net_amount, displayCurrency)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {transaction.commission !== 0
                      ? formatAmount(transaction.commission, displayCurrency)
                      : "-"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => setEditTarget(transaction)}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
                        title="Edit transaction"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(transaction)}
                        className="rounded p-1 text-destructive transition-colors hover:bg-destructive/10"
                        title="Delete transaction"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Rows</span>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => setPageSize(Number(value) as typeof pageSize)}
          >
            <SelectTrigger className="h-8 w-20 rounded-full bg-surface px-3 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-full"
            disabled={safePage <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            aria-label="Previous transaction page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-32 text-center tabular-nums">
            {pageStart}-{pageEnd} out of {sortedTransactions.length}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-full"
            disabled={safePage >= totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            aria-label="Next transaction page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete transaction?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `This will permanently remove the ${deleteTarget.side} of ${deleteTarget.symbol} on ${deleteTarget.date} and rebuild the chart.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ManualTransactionModal
        open={!!editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        portfolioId={portfolioId}
        transaction={editTarget as EditableTransaction | null}
        onAdded={async () => {
          setEditTarget(null);
          await fetchTransactions();
          onEdited?.();
        }}
      />
    </>
  );
}
