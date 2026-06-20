"use client";

import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import type { DateRange } from "react-day-picker";
import { ArrowDown, ArrowUp, CalendarDays, ChevronsUpDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  filterAndSortLog,
  presetRange,
  type LogRange,
  type LogSortKey,
  type LogTxn,
  type SortDir,
} from "@/lib/transaction-log";
import { DEFAULT_PORTFOLIO_CURRENCY, formatCurrency } from "@/lib/currency";

interface Props {
  rows: LogTxn[];
  categoryNames: Record<string, string>;
  /** Drop the card chrome + title when rendered inside the breakdown tabs. */
  embedded?: boolean;
}

const COLUMNS: Array<{ key: LogSortKey; label: string; align?: "right" }> = [
  { key: "date", label: "Date" },
  { key: "merchant", label: "Merchant" },
  { key: "category", label: "Category" },
  { key: "amount", label: "Amount", align: "right" },
];

function toIso(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

// The raw record (Linear 1A-104): denser and more utilitarian than the category-mix summary.
// Searchable, sortable by column, date-filterable; scrolls within a fixed height so it stays
// contained in the bottom-right of the two-column row.
export function TransactionLog({ rows, categoryNames, embedded = false }: Props) {
  const currency = DEFAULT_PORTFOLIO_CURRENCY;
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<LogSortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [range, setRange] = useState<LogRange>({ from: null, to: null });
  const [dateLabel, setDateLabel] = useState("Date range");
  const [calendarRange, setCalendarRange] = useState<DateRange | undefined>();

  const hasDateFilter = range.from != null || range.to != null;

  const visible = useMemo(
    () => filterAndSortLog(rows, { search, range, categoryNames, sortKey, sortDir }),
    [rows, search, range, categoryNames, sortKey, sortDir],
  );

  const handleSort = (key: LogSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      // Amount/date default to descending (biggest/newest first); text defaults to ascending.
      setSortDir(key === "merchant" || key === "category" ? "asc" : "desc");
    }
  };

  const applyPreset = (preset: "30D" | "90D") => {
    setRange(presetRange(preset, toIso(new Date())));
    setDateLabel(preset);
    setCalendarRange(undefined);
  };

  const applyCalendar = (next: DateRange | undefined) => {
    setCalendarRange(next);
    const from = next?.from ? toIso(next.from) : null;
    const to = next?.to ? toIso(next.to) : next?.from ? toIso(next.from) : null;
    setRange({ from, to });
    setDateLabel(from && to ? `${from} → ${to}` : "Date range");
  };

  const clearDate = () => {
    setRange({ from: null, to: null });
    setDateLabel("Date range");
    setCalendarRange(undefined);
  };

  return (
    <div
      className={
        embedded ? "flex flex-col" : "flex flex-col rounded-xl border border-hairline bg-surface"
      }
    >
      {/* Header + toolbar */}
      <div
        className={
          embedded
            ? "flex flex-col gap-3 pb-3"
            : "flex flex-col gap-3 border-b border-hairline px-4 py-3"
        }
      >
        {!embedded && (
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold">Transactions</h2>
            <span className="text-xs text-foreground-muted tabular-nums">
              {visible.length} of {rows.length}
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search merchant or category"
              aria-label="Search transactions"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Popover>
            <div className="inline-flex h-8 shrink-0 items-center rounded-md border border-input bg-transparent">
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-full items-center gap-1.5 rounded-l-md px-2.5 text-xs font-medium"
                >
                  <CalendarDays className="h-3.5 w-3.5" />
                  {dateLabel}
                </button>
              </PopoverTrigger>
              {hasDateFilter && (
                <button
                  type="button"
                  onClick={clearDate}
                  aria-label="Clear date filter"
                  className="mr-1 grid h-6 w-6 place-items-center rounded text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <PopoverContent className="w-auto p-3" align="end">
              <div className="mb-3 flex flex-wrap gap-2">
                {(["30D", "90D"] as const).map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    variant={dateLabel === preset ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-3 text-xs"
                    onClick={() => applyPreset(preset)}
                  >
                    {preset}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant={!hasDateFilter ? "default" : "outline"}
                  size="sm"
                  className="h-7 px-3 text-xs"
                  onClick={clearDate}
                >
                  All
                </Button>
              </div>
              <Calendar mode="range" selected={calendarRange} onSelect={applyCalendar} />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Scrollable, fixed-height body so the log never unbalances the row. */}
      <div className="max-h-[420px] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-surface">
            <TableRow>
              {COLUMNS.map((col) => {
                const active = sortKey === col.key;
                const Icon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;
                return (
                  <TableHead
                    key={col.key}
                    aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    className={`whitespace-nowrap text-xs ${col.align === "right" ? "text-right" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSort(col.key)}
                      className={`inline-flex items-center gap-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        col.align === "right" ? "flex-row-reverse" : ""
                      } ${active ? "text-foreground" : ""}`}
                    >
                      {col.label}
                      <Icon className={`h-3 w-3 ${active ? "" : "opacity-40"}`} />
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMNS.length}
                  className="h-28 text-center text-sm text-foreground-muted"
                >
                  No transactions match these filters.
                </TableCell>
              </TableRow>
            ) : (
              visible.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-foreground-muted">
                    {format(parseISO(t.posted_at), "d MMM yyyy")}
                  </TableCell>
                  <TableCell
                    className="max-w-[160px] truncate text-xs font-medium"
                    title={t.merchant_name}
                  >
                    {t.merchant_name}
                    {t.is_recurring && (
                      <span className="ml-1.5 align-middle text-[10px] font-normal text-foreground-muted">
                        recurring
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-foreground-muted">
                    {t.category_id && categoryNames[t.category_id]
                      ? categoryNames[t.category_id]
                      : "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                    {formatCurrency(t.amount, currency)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
