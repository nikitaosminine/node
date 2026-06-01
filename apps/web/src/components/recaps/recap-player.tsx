"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Pause, Play, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { RecapSlide } from "./recap-slide";
import type { Recap } from "./types";

const SLIDE_MS = 10_000;
const TICK_MS = 50;

interface RecapPlayerProps {
  recap: Recap;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RecapPlayer({ recap, open, onOpenChange }: RecapPlayerProps) {
  const slides = recap.slides ?? [];
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState(0); // 0..1 for the current slide
  const [paused, setPaused] = useState(false);
  const dirRef = useRef(1); // animation direction

  // Reset to the first slide whenever the player (re)opens.
  useEffect(() => {
    if (open) {
      setIndex(0);
      setProgress(0);
      setPaused(false);
    }
  }, [open]);

  const goTo = useCallback(
    (next: number, dir: number) => {
      if (next < 0) return;
      if (next >= slides.length) {
        onOpenChange(false);
        return;
      }
      dirRef.current = dir;
      setIndex(next);
      setProgress(0);
    },
    [slides.length, onOpenChange],
  );

  const next = useCallback(() => goTo(index + 1, 1), [goTo, index]);
  const prev = useCallback(() => goTo(index - 1, -1), [goTo, index]);

  // Auto-advance timer — gated on paused / open.
  useEffect(() => {
    if (!open || paused || slides.length === 0) return;
    const id = setInterval(() => {
      setProgress((p) => {
        const np = p + TICK_MS / SLIDE_MS;
        if (np >= 1) {
          // advance on the next tick to avoid setState-in-setState races
          queueMicrotask(next);
          return 1;
        }
        return np;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [open, paused, index, slides.length, next]);

  // Pause when the tab loses focus; resume on return.
  useEffect(() => {
    if (!open) return;
    const onVis = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [open]);

  // Keyboard: ←/→ navigate, space toggles pause.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === " ") {
        e.preventDefault();
        setPaused((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, next, prev]);

  if (slides.length === 0) return null;
  const slide = slides[index];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideCloseButton
        className="h-[640px] max-h-[88vh] w-[520px] max-w-[96vw] gap-0 overflow-hidden rounded-2xl border-hairline bg-surface p-0"
      >
        <DialogTitle className="sr-only">
          {recap.type === "weekly" ? "Weekly recap" : "Daily recap"}
        </DialogTitle>

        {/* Segmented progress bars */}
        <div className="absolute inset-x-0 top-0 z-20 flex gap-1 p-3">
          {slides.map((_, i) => (
            <div key={i} className="h-0.5 flex-1 overflow-hidden rounded-full bg-foreground/15">
              <div
                className="h-full rounded-full bg-foreground"
                style={{
                  width: `${i < index ? 100 : i === index ? progress * 100 : 0}%`,
                  transition: i === index ? "width 50ms linear" : "none",
                }}
              />
            </div>
          ))}
        </div>

        {/* Controls */}
        <div className="absolute right-3 top-5 z-30 flex items-center gap-1">
          <button
            type="button"
            aria-label={paused ? "Resume" : "Pause"}
            onClick={() => setPaused((p) => !p)}
            className="rounded-full p-1.5 text-foreground-muted hover:bg-surface-2 hover:text-foreground"
          >
            {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </button>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="rounded-full p-1.5 text-foreground-muted hover:bg-surface-2 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tap zones for navigation */}
        <button
          type="button"
          aria-label="Previous slide"
          onClick={prev}
          className="absolute inset-y-0 left-0 z-10 w-1/3 cursor-default"
        />
        <button
          type="button"
          aria-label="Next slide"
          onClick={next}
          className="absolute inset-y-0 right-0 z-10 w-1/3 cursor-default"
        />

        {/* Slide */}
        <div className="relative h-full w-full">
          <AnimatePresence initial={false} custom={dirRef.current} mode="popLayout">
            <motion.div
              key={index}
              custom={dirRef.current}
              initial={reduceMotion ? false : { opacity: 0, x: dirRef.current * 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: dirRef.current * -40 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="absolute inset-0"
            >
              <RecapSlide slide={slide} />
            </motion.div>
          </AnimatePresence>
        </div>
      </DialogContent>
    </Dialog>
  );
}
