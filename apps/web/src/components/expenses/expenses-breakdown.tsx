"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
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

const PILL_TRANSITION = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.7 };

function TabPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  const transition = reduce ? { duration: 0 } : PILL_TRANSITION;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-selected={active}
      role="tab"
      className={`relative h-8 rounded-full px-4 text-[11px] font-medium uppercase tracking-[0.1em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "text-background" : "text-foreground-muted hover:text-foreground"
      }`}
    >
      {active && (
        <motion.span
          layoutId="expenses-breakdown-pill"
          className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
          transition={transition}
        />
      )}
      <span className="relative z-10">{children}</span>
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div
          className="inline-flex h-9 items-center rounded-full border border-hairline bg-surface-2 p-0.5"
          role="tablist"
          aria-label="Spending breakdown"
        >
          <TabPill active={tab === "categories"} onClick={() => setTab("categories")}>
            Where it goes
          </TabPill>
          <TabPill active={tab === "transactions"} onClick={() => setTab("transactions")}>
            Transactions <span className="ml-1 tabular-nums opacity-70">{rows.length}</span>
          </TabPill>
        </div>
        <span className="text-xs text-foreground-muted">
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
