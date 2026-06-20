"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RotateCw, Upload } from "lucide-react";
import { format, parseISO } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { AddExpenseModal } from "@/components/expenses/add-expense-modal";
import { CsvImportExpenses } from "@/components/expenses/csv-import-expenses";
import { ExpensesEmptyState } from "@/components/expenses/expenses-empty-state";
import { formatCurrency } from "@/lib/currency";

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
  }, []);

  // Depend on the user id, not the user object — a new object identity each render
  // (e.g. from a re-created auth context value) must not re-trigger the load.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!authLoading && userId) void load();
  }, [authLoading, userId, load]);

  const isEmpty = !loading && !error && rows.length === 0;

  const monthLabel = useMemo(() => format(new Date(), "MMMM yyyy"), []);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-6 pl-14">
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

      {/* Foundation note — only once there's data; the onboarding panel covers the empty case. */}
      {rows.length > 0 && (
        <p className="text-xs text-foreground-muted">
          The spending heatmap, category mix, and allocation strip build on this data next.
        </p>
      )}

      {isEmpty && user ? (
        <ExpensesEmptyState
          userId={user.id}
          onImport={() => setImportOpen(true)}
          onAdd={() => setAddOpen(true)}
          onIncomeSet={load}
        />
      ) : (
        /* Transaction list (minimal — the full searchable log is a later issue) */
        <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
          {loading ? (
            <div className="px-4 py-10 text-center text-sm text-foreground-muted">Loading…</div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <p className="text-sm text-foreground-muted">Couldn&apos;t load your expenses.</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-hairline">
              {rows.map((row) => (
                <li key={row.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{row.merchant_name}</div>
                    <div className="text-xs text-foreground-muted">
                      {format(parseISO(row.posted_at), "d MMM yyyy")}
                      {row.category_id && categoryNames[row.category_id]
                        ? ` · ${categoryNames[row.category_id]}`
                        : ""}
                      {row.is_recurring ? " · recurring" : ""}
                    </div>
                  </div>
                  <div className="font-mono text-sm tabular-nums">
                    {formatCurrency(row.amount, row.currency)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
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
