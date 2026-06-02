"use client";

import { useId, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Lightweight client-side email check — catches obviously empty/invalid inputs
// before we even hit the network, so there's zero loading-state flash on bad input.
const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

export function WaitlistForm({ className }: { className?: string }) {
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState(""); // honeypot
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || done) return;

    // Validate locally first — no network call, no loading flash, no jerk.
    if (!isValidEmail(email)) {
      setFieldError("Please enter a valid email address.");
      return;
    }
    setFieldError(null);

    setLoading(true);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), company }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Something went wrong. Please try again.");
      setDone(true);
      toast.success("You're on the waitlist. Check your inbox for a confirmation.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div
        className={cn(
          "flex items-center justify-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-2.5 text-sm font-medium text-foreground",
          className,
        )}
        role="status"
      >
        <Check className="h-4 w-4 shrink-0 text-positive" />
        You&apos;re on the list — check your inbox.
      </div>
    );
  }

  return (
    <div className={cn("w-full", className)}>
      <form
        onSubmit={handleSubmit}
        className="flex w-full flex-col gap-2 sm:flex-row"
        noValidate
      >
        <label htmlFor={emailId} className="sr-only">
          Email address
        </label>
        <Input
          id={emailId}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (fieldError) setFieldError(null);
          }}
          disabled={loading}
          aria-describedby={fieldError ? `${emailId}-error` : undefined}
          aria-invalid={!!fieldError}
          className={cn(
            "h-11 flex-1 focus-visible:border-foreground/40 focus-visible:ring-0",
            fieldError && "border-negative focus-visible:border-negative",
          )}
        />
        {/* Honeypot — hidden from real users, filled by bots */}
        <input
          type="text"
          name="company"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="hidden"
        />
        <Button
          type="submit"
          size="lg"
          // relative + overflow-hidden so the ::after shine pseudo-element is clipped
          className="btn-shine relative h-11 shrink-0 overflow-hidden transition-transform duration-100 active:scale-[0.97]"
          disabled={loading}
        >
          <span className="relative z-10 flex items-center gap-2">
            {loading ? (
              "Joining…"
            ) : (
              <>
                Join the waitlist
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </span>
        </Button>
      </form>
      {fieldError && (
        <p
          id={`${emailId}-error`}
          role="alert"
          className="mt-1.5 text-left text-xs text-negative"
        >
          {fieldError}
        </p>
      )}
    </div>
  );
}
