"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RotateCw, Upload } from "lucide-react";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { AddExpenseModal } from "@/components/expenses/add-expense-modal";
import { CsvImportExpenses } from "@/components/expenses/csv-import-expenses";
import { ExpensesEmptyState } from "@/components/expenses/expenses-empty-state";
import { AllocationStrip } from "@/components/expenses/allocation-strip";
import { SpendingHeatmap } from "@/components/expenses/spending-heatmap";
import { CategoryMix } from "@/components/expenses/category-mix";
import { TransactionLog } from "@/components/expenses/transaction-log";
import { ExpenseRecapTeaser } from "@/components/expenses/expense-recap-teaser";

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
        .limit(100),
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
    // Signal dependent widgets (allocation strip) to refetch their own month-scoped data.
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

  const monthLabel = useMemo(() => format(new Date(), "MMMM yyyy"), []);

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-6 pb-8 pt-4">
      {/* Topbar */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
          <p className="mt-0.5 text-sm text-foreground-muted">{monthLabel}</p>
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
            {/* Allocation strip (1A-105) — full-width context band. */}
            <AllocationStrip userId={user.id} refreshKey={dataVersion} />

            {/* Hero row: spending heatmap (1A-103, 2/3) + category mix (1A-106, 1/3).
                Reflows to one column below lg. */}
            <div className="grid items-start gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <SpendingHeatmap categoryNames={categoryNames} refreshKey={dataVersion} />
              </div>
              <CategoryMix
                userId={user.id}
                categoryNames={categoryNames}
                refreshKey={dataVersion}
              />
            </div>

            {/* The raw, searchable transaction log (1A-104) — full width. */}
            <TransactionLog rows={rows} categoryNames={categoryNames} />

            {/* Recap teaser (1A-110) — plain-mono placeholder, agent not wired. */}
            <ExpenseRecapTeaser />
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
