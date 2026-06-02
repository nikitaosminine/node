"use client";

import { useId, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export function WaitlistForm({ className }: { className?: string }) {
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState(""); // honeypot
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || done) return;
    setLoading(true);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, company }),
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
    <form
      onSubmit={handleSubmit}
      className={cn("flex w-full flex-col gap-2 sm:flex-row", className)}
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
        onChange={(e) => setEmail(e.target.value)}
        required
        disabled={loading}
        className="h-11 flex-1 focus-visible:border-foreground/40 focus-visible:ring-0"
      />
      {/* Honeypot — visually hidden, off the tab order. Bots fill it, humans don't. */}
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
      <Button type="submit" size="lg" className="h-11 shrink-0" disabled={loading}>
        {loading ? "Joining…" : "Join the waitlist"}
        {!loading && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
