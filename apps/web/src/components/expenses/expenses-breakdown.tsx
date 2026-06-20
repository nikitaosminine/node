"use client";

import { useState } from "react";
import { CategoryMix } from "@/components/expenses/category-mix";
import { TransactionLog } from "@/components/expenses/transaction-log";
import { DEFAULT_PORTFOLIO_CURRENCY, formatCurrency } from "@/lib/currency";
import type { LogTxn } from "@/lib/transaction-log";

interface Props {
  userId: string;
  categoryNames: Record<string, string>;
  rows: LogTxn[];
  refreshKey?: number;
}

type Tab = "categories" | "transactions";

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-selected={active}
      role="tab"
      className={`-mb-px border-b-2 pb-2.5 pt-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-foreground-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

// Where it goes / Transactions (mockup realign): the category-mix summary and the raw
// transaction log share one card, split by tabs. "Where it goes" is the default.
export function ExpensesBreakdown({ userId, categoryNames, rows, refreshKey = 0 }: Props) {
  const [tab, setTab] = useState<Tab>("categories");
  const [discretionary, setDiscretionary] = useState(0);

  return (
    <div className="rounded-xl border border-hairline bg-surface px-5 py-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-hairline">
        <div className="flex items-center gap-5" role="tablist" aria-label="Spending breakdown">
          <TabButton active={tab === "categories"} onClick={() => setTab("categories")}>
            Where it goes
          </TabButton>
          <TabButton active={tab === "transactions"} onClick={() => setTab("transactions")}>
            Transactions{" "}
            <span className="ml-1 text-foreground-muted tabular-nums">{rows.length}</span>
          </TabButton>
        </div>
        <span className="pb-2 text-xs text-foreground-muted">
          <span className="font-mono tabular-nums text-foreground">
            {formatCurrency(discretionary, DEFAULT_PORTFOLIO_CURRENCY, {
              maximumFractionDigits: 0,
            })}
          </span>{" "}
          discretionary{tab === "categories" && " · tap a category to expand"}
        </span>
      </div>

      {tab === "categories" ? (
        <CategoryMix
          userId={userId}
          categoryNames={categoryNames}
          refreshKey={refreshKey}
          embedded
          onTotal={setDiscretionary}
        />
      ) : (
        <TransactionLog rows={rows} categoryNames={categoryNames} embedded />
      )}
    </div>
  );
}
