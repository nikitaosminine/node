"use client";

import { useState } from "react";
import { Plus, Upload, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SetIncomeDialog } from "@/components/expenses/set-income-dialog";

interface Props {
  userId: string;
  onImport: () => void;
  onAdd: () => void;
  onIncomeSet?: () => void;
}

// Import-led first-run experience (Linear 1A-112). Until there is data, the screen shows
// one coherent onboarding panel — Import (primary), Add manually (secondary), Set income —
// over a muted ghost of the heatmap grid, instead of four blank widgets.
export function ExpensesEmptyState({ userId, onImport, onAdd, onIncomeSet }: Props) {
  const [incomeOpen, setIncomeOpen] = useState(false);
  const [incomeSet, setIncomeSet] = useState(false);

  return (
    <div className="relative overflow-hidden rounded-xl border border-hairline bg-surface px-6 py-12">
      {/* Ghost heatmap — decorative preview of what fills in once data arrives. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 flex justify-center opacity-40"
      >
        <div className="grid grid-cols-7 gap-1.5 p-5">
          {Array.from({ length: 35 }).map((_, i) => (
            <div
              key={i}
              className="h-7 w-7 rounded-md border border-dashed border-hairline bg-surface-2"
            />
          ))}
        </div>
      </div>

      <div className="relative flex flex-col items-center gap-5 text-center">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Start tracking your spending</h2>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-foreground-muted">
            Import a bank or card statement to see your spending rhythm — or add an expense by hand.
            Set your monthly income so Node can show what&apos;s left.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={onImport}>
            <Upload className="h-4 w-4" />
            Import transactions
          </Button>
          <Button variant="outline" onClick={onAdd}>
            <Plus className="h-4 w-4" />
            Add manually
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setIncomeOpen(true)}
          className="flex items-center gap-1.5 text-sm text-foreground-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          {incomeSet && <Check className="h-3.5 w-3.5 text-positive" />}
          {incomeSet ? "Monthly income set — edit" : "Set monthly income"}
        </button>
      </div>

      <SetIncomeDialog
        open={incomeOpen}
        onOpenChange={setIncomeOpen}
        userId={userId}
        onSaved={() => {
          setIncomeSet(true);
          onIncomeSet?.();
        }}
      />
    </div>
  );
}
