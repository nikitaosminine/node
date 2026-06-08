"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Pause, Play, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { RecapSlide } from "./recap-slide";
import { postLangsmithScore, postSlideFeedback } from "./use-recap";
import type { Recap, SlideVote } from "./types";

const SLIDE_MS = 10_000;
const TICK_MS = 50;

// Build the initial optimistic-feedback map from the votes the API returned.
function seedFeedback(recap: Recap): Map<number, SlideVote> {
  const map = new Map<number, SlideVote>();
  for (const f of recap.slide_feedback ?? []) {
    map.set(f.slide_index, { score: f.score, comment: f.comment ?? "" });
  }
  return map;
}

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

  // Per-slide optimistic feedback (score + comment). Seeded from the API on
  // open and persisted through navigation — voting on slide 2 must not reset
  // slide 1's thumb. committedRef tracks what's already saved server-side so a
  // bare focus/blur doesn't re-POST an unchanged comment.
  const [optimisticFeedback, setOptimisticFeedback] = useState<Map<number, SlideVote>>(() =>
    seedFeedback(recap),
  );
  const committedRef = useRef<Map<number, string>>(new Map());
  // Latest recap, read-only — lets the open effect re-seed without re-running
  // when the parent updates recap identity (e.g. optimistic markSeen).
  const recapRef = useRef(recap);
  recapRef.current = recap;

  // Reset position + re-seed feedback whenever the player (re)opens.
  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setProgress(0);
    setPaused(false);
    const seeded = seedFeedback(recapRef.current);
    setOptimisticFeedback(seeded);
    const committed = new Map<number, string>();
    seeded.forEach((v, k) => committed.set(k, v.comment));
    committedRef.current = committed;
  }, [open]);

  const updateVote = useCallback((slideIndex: number, patch: Partial<SlideVote>) => {
    setOptimisticFeedback((prev) => {
      const nextMap = new Map(prev);
      const cur = nextMap.get(slideIndex) ?? { score: null, comment: "" };
      nextMap.set(slideIndex, { ...cur, ...patch });
      return nextMap;
    });
  }, []);

  // Thumb click: optimistic update, fire-and-forget LangSmith signal, primary
  // Supabase write. Roll the thumb back and toast if the primary write fails.
  const handleVote = useCallback(
    (slideIndex: number, score: 1 | -1) => {
      const prevVote = optimisticFeedback.get(slideIndex) ?? { score: null, comment: "" };
      const comment = prevVote.comment;
      updateVote(slideIndex, { score });
      if (recap.feedback_token) postLangsmithScore(recap.feedback_token, score);
      postSlideFeedback(recap.id, { slide_index: slideIndex, score, comment })
        .then(() => {
          committedRef.current.set(slideIndex, comment);
        })
        .catch(() => {
          setOptimisticFeedback((prev) => {
            const nextMap = new Map(prev);
            nextMap.set(slideIndex, prevVote);
            return nextMap;
          });
          toast.error("Couldn't save your feedback");
        });
    },
    [optimisticFeedback, recap.id, recap.feedback_token, updateVote],
  );

  const handleCommentChange = useCallback(
    (slideIndex: number, value: string) => updateVote(slideIndex, { comment: value }),
    [updateVote],
  );

  // Comment input focus pauses auto-advance so the 10s timer can't fire and
  // lose what the user is typing.
  const handleCommentFocus = useCallback(() => setPaused(true), []);

  // On blur (or Enter): resume, then persist the comment — but only when the
  // slide has a vote (score is NOT NULL in the DB) and the text actually changed.
  const handleCommentBlur = useCallback(
    (slideIndex: number) => {
      setPaused(false);
      const vote = optimisticFeedback.get(slideIndex);
      if (!vote || vote.score == null) return;
      if (committedRef.current.get(slideIndex) === vote.comment) return;
      postSlideFeedback(recap.id, {
        slide_index: slideIndex,
        score: vote.score,
        comment: vote.comment,
      })
        .then(() => {
          committedRef.current.set(slideIndex, vote.comment);
        })
        .catch(() => {
          toast.error("Couldn't save your comment");
        });
    },
    [optimisticFeedback, recap.id],
  );

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
      // Don't hijack keys while typing in the comment input.
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
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
  const currentVote = optimisticFeedback.get(index) ?? { score: null, comment: "" };

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

        {/* Tap zones for navigation. Stop ~100px above the bottom so they don't
            sit over the pinned feedback footer (thumbs + comment). */}
        <button
          type="button"
          aria-label="Previous slide"
          onClick={prev}
          className="absolute bottom-[100px] left-0 top-0 z-10 w-1/3 cursor-default"
        />
        <button
          type="button"
          aria-label="Next slide"
          onClick={next}
          className="absolute bottom-[100px] right-0 top-0 z-10 w-1/3 cursor-default"
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
              <RecapSlide
                slide={slide}
                feedback={{
                  vote: currentVote,
                  onVote: (score) => handleVote(index, score),
                  onCommentChange: (value) => handleCommentChange(index, value),
                  onCommentFocus: handleCommentFocus,
                  onCommentBlur: () => handleCommentBlur(index),
                }}
              />
            </motion.div>
          </AnimatePresence>
        </div>
      </DialogContent>
    </Dialog>
  );
}
