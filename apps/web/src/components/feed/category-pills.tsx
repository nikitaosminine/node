"use client";

import { motion } from "framer-motion";
import { useReducedMotion } from "framer-motion";

export const POLYMARKET_TABS = [
  { id: "personalized", label: "For you" },
  { id: "finance",      label: "Finance" },
  { id: "geopolitics",  label: "Geopolitics" },
  { id: "tech",         label: "Tech" },
  { id: "economy",      label: "Economy" },
] as const;

export type PolymarketTabId = (typeof POLYMARKET_TABS)[number]["id"];

interface CategoryPillsProps<T extends string> {
  tabs: readonly { id: T; label: string }[];
  activeTab: T;
  onChange: (tab: T) => void;
  /** Framer Motion layoutId — must be unique per pill group on the page */
  layoutId?: string;
  ariaLabel?: string;
}

export function CategoryPills<T extends string>({
  tabs,
  activeTab,
  onChange,
  layoutId = "category-pill",
  ariaLabel = "Category",
}: CategoryPillsProps<T>) {
  const shouldReduceMotion = useReducedMotion();
  const transition = shouldReduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, bounce: 0.2, duration: 0.35 };

  return (
    <div
      className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full border border-hairline bg-surface-2 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`relative shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors isolate ${
              isActive ? "text-background" : "text-foreground-muted hover:text-foreground"
            }`}
          >
            {isActive && (
              <motion.span
                layoutId={layoutId}
                className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                transition={transition}
              />
            )}
            <span className="relative z-10">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
