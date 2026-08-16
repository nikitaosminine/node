import { useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { ChevronUp, Layers } from "lucide-react";
import type { Thesis } from "@/lib/thesis";
import { ThesisCard } from "./ThesisCard";

type Props = {
  theses: Thesis[];
  onUpdate: (id: string, patch: Partial<Thesis>) => void;
  onOpen: (id: string) => void;
};

const STACK_OFFSET = 14;
const STACK_SCALE_STEP = 0.018;
const STACK_VISIBLE_CARD_HEIGHT = 96;

export function ThesisStack({ theses, onUpdate, onOpen }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (theses.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          Theses
        </div>
        <p className="mt-3">
          No theses linked to this portfolio yet. Add one from The Take and link it to a ticker in
          this portfolio.
        </p>
      </div>
    );
  }

  const stackHeight = STACK_VISIBLE_CARD_HEIGHT + STACK_OFFSET * (theses.length - 1);

  return (
    <LayoutGroup>
      <div className="relative">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <Layers className="h-3.5 w-3.5" />
              Theses
            </div>
            <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">
              Investment notes
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {theses.length} linked {theses.length === 1 ? "thesis" : "theses"} ·{" "}
              {expanded ? "expanded" : "click the stack to expand"}
            </p>
          </div>

          <AnimatePresence>
            {expanded && (
              <motion.button
                key="collapse"
                type="button"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                onClick={() => setExpanded(false)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary md:py-1.5"
              >
                <ChevronUp className="h-3.5 w-3.5" />
                Collapse
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {!expanded ? (
          <motion.button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label="Expand thesis stack"
            className="group relative block w-full text-left focus:outline-none"
            style={{ height: stackHeight }}
            whileHover="hover"
          >
            {theses.map((t, i) => {
              const depth = theses.length - 1 - i;
              return (
                <motion.div
                  key={t.id}
                  layoutId={`thesis-${t.id}`}
                  className="absolute inset-x-0 origin-top"
                  style={{
                    top: i * STACK_OFFSET,
                    zIndex: i,
                    scale: 1 - depth * STACK_SCALE_STEP,
                    transformOrigin: "top center",
                  }}
                  variants={{
                    hover: {
                      y: i === theses.length - 1 ? -3 : 0,
                    },
                  }}
                  transition={{ type: "spring" as const, stiffness: 260, damping: 28 }}
                >
                  <ThesisCard thesis={t} expanded={false} onChange={onUpdate} onOpen={onOpen} />
                </motion.div>
              );
            })}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-8 -bottom-2 h-6 rounded-full bg-foreground/0 blur-2xl transition-colors duration-300 group-hover:bg-foreground/10"
            />
          </motion.button>
        ) : (
          <div className="flex flex-col gap-4">
            {theses.map((t) => (
              <motion.div key={t.id} layoutId={`thesis-${t.id}`}>
                <ThesisCard thesis={t} expanded onChange={onUpdate} onOpen={onOpen} />
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </LayoutGroup>
  );
}
