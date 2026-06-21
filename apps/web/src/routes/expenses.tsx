"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, RotateCw, Upload } from "lucide-react";
import { addMonths, format, isSameMonth, startOfMonth } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { AddExpenseModal } from "@/components/expenses/add-expense-modal";
import { CsvImportExpenses } from "@/components/expenses/csv-import-expenses";
import { ExpensesEmptyState } from "@/components/expenses/expenses-empty-state";
import { ExpenseNodeSection } from "@/components/expenses/expense-node-section";
import { SpendingRhythm } from "@/components/expenses/spending-rhythm";
import { ExpensesBreakdown } from "@/components/expenses/expenses-breakdown";

interface ExpenseRow {
  id: string;
  posted_at: string;
  merchant_name: string;
  amount: number;
  currency: string;
  is_recurring: boolean;
  category_id: string | null;
}

export default function Expenses() {
  const { user, isLoading: authLoading } = useAuth();
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [categoryNames, setCategoryNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [txnRes, catRes] = await Promise.all([
      supabase
        .from("expense_transactions")
        .select("id, posted_at, merchant_name, amount, currency, is_recurring, category_id")
        .order("posted_at", { ascending: false })
        .limit(500),
      supabase.from("expense_categories").select("id, display_name"),
    ]);
    // Surface failures explicitly — a failed load must not look like an empty account.
    if (txnRes.error || catRes.error) {
      setError(true);
      setLoading(false);
      return;
    }
    setRows((txnRes.data as ExpenseRow[]) ?? []);
    setCategoryNames(
      Object.fromEntries((catRes.data ?? []).map((c) => [c.id, c.display_name] as const)),
    );
    setLoading(false);
    // Signal the month-scoped widgets (node section, rhythm, category mix) to refetch.
    setDataVersion((v) => v + 1);
  }, []);

  // Depend on the user id, not the user object — a new object identity each render
  // (e.g. from a re-created auth context value) must not re-trigger the load.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (authLoading) return;
    if (userId) void load();
    // Auth resolved with no user (e.g. signed out): clear the spinner instead of
    // leaving the page stuck in its initial loading state.
    else setLoading(false);
  }, [authLoading, userId, load]);

  const isEmpty = !loading && !error && rows.length === 0;

  // Page-wide month context: the node section, spending rhythm, and category mix all read
  // this month. The transaction log is deliberately exempt — it's the cross-month searchable
  // record with its own date filter.
  const [viewDate, setViewDate] = useState(() => startOfMonth(new Date()));
  const isCurrentMonth = isSameMonth(viewDate, new Date());

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-6 pb-8 pt-4">
      {/* Topbar */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
          <div className="mt-1 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setViewDate((d) => startOfMonth(addMonths(d, -1)))}
              aria-label="Previous month"
              className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[7.5rem] text-center text-sm text-foreground-muted">
              {format(viewDate, "MMMM yyyy")}
            </span>
            <button
              type="button"
              onClick={() => setViewDate((d) => startOfMonth(addMonths(d, 1)))}
              disabled={isCurrentMonth}
              aria-label="Next month"
              className="grid h-6 w-6 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-foreground-muted"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)} disabled={!user}>
            <Upload className="h-4 w-4" />
            Import
          </Button>
          <Button onClick={() => setAddOpen(true)} disabled={!user}>
            <Plus className="h-4 w-4" />
            Add expense
          </Button>
        </div>
      </div>

      {/* Loading / error / empty resolve first; the dashboard renders only with data. */}
      {loading ? (
        <div className="overflow-hidden rounded-xl border border-hairline bg-surface px-4 py-10 text-center text-sm text-foreground-muted">
          Loading…
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 overflow-hidden rounded-xl border border-hairline bg-surface px-4 py-12 text-center">
          <p className="text-sm text-foreground-muted">Couldn&apos;t load your expenses.</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RotateCw className="h-4 w-4" />
            Retry
          </Button>
        </div>
      ) : isEmpty && user ? (
        <ExpensesEmptyState
          userId={user.id}
          onImport={() => setImportOpen(true)}
          onAdd={() => setAddOpen(true)}
          onIncomeSet={load}
        />
      ) : (
        user && (
          <>
            {/* Node AI section — recap card + ambient insight + chips + Ask-Node stub. */}
            <ExpenseNodeSection
              userId={user.id}
              categoryNames={categoryNames}
              monthDate={viewDate}
              refreshKey={dataVersion}
              onChanged={load}
            />

            {/* Spending rhythm — heatmap/bars + daily/weekly toggles + stat rail. */}
            <SpendingRhythm
              categoryNames={categoryNames}
              monthDate={viewDate}
              refreshKey={dataVersion}
            />

            {/* Where it goes / Transactions — category mix + log split by tabs. */}
            <ExpensesBreakdown
              userId={user.id}
              categoryNames={categoryNames}
              rows={rows}
              monthDate={viewDate}
              refreshKey={dataVersion}
            />
          </>
        )
      )}

      {user && (
        <>
          <AddExpenseModal
            open={addOpen}
            onOpenChange={setAddOpen}
            userId={user.id}
            onAdded={load}
          />
          <CsvImportExpenses
            open={importOpen}
            onOpenChange={setImportOpen}
            userId={user.id}
            onImported={load}
          />
        </>
      )}
    </div>
  );
}
