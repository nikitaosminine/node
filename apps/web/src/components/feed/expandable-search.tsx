"use client";

import { useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Search, X } from "lucide-react";

interface ExpandableSearchProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export function ExpandableSearch({
  value,
  onChange,
  placeholder = "Search…",
}: ExpandableSearchProps) {
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldReduceMotion = useReducedMotion();

  const transition = shouldReduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 400, damping: 30 };

  function open() {
    setExpanded(true);
    // Focus after the animation frame so the input is visible
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleBlur() {
    if (!value) setExpanded(false);
  }

  function clear() {
    onChange("");
    setExpanded(false);
  }

  return (
    <motion.div
      className="relative flex h-7 items-center overflow-hidden rounded-md border border-hairline bg-surface-2"
      animate={{ width: expanded ? 160 : 28 }}
      transition={transition}
      style={{ minWidth: 28 }}
    >
      {/* Search icon — always visible, click to expand */}
      <button
        type="button"
        onClick={open}
        className="absolute left-0 grid h-7 w-7 shrink-0 place-items-center text-foreground-muted"
        tabIndex={expanded ? -1 : 0}
        aria-label="Search"
      >
        <Search className="h-3.5 w-3.5" />
      </button>

      {/* Input */}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
        className="h-full w-full bg-transparent pl-7 pr-6 text-xs text-foreground outline-none placeholder:text-foreground-muted/50"
        style={{ pointerEvents: expanded ? "auto" : "none" }}
        aria-hidden={!expanded}
      />

      {/* Clear button */}
      <AnimatePresence>
        {value && (
          <motion.button
            key="clear"
            type="button"
            onClick={clear}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 grid h-7 w-6 place-items-center text-foreground-muted hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
