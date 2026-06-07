import type { Metadata } from "next";
import { BarChart3, Globe, type LucideIcon, Mic, Newspaper, Receipt, ShieldCheck } from "lucide-react";
import { NodeLogo } from "@/components/node-logo";
import { WaitlistHeader } from "@/components/waitlist/waitlist-header";
import { WaitlistForm } from "@/components/waitlist/waitlist-form";

const SITE_URL = "https://trynode.app";
const TITLE = "Node | AI-Native Personal Finance Hub";
const DESCRIPTION =
  "The AI-native personal finance hub that explains your money. One clear view of your finances, with plain-language answers grounded in your data and real-world events.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Node",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

const FEATURES = [
  {
    icon: Newspaper,
    title: "Recaps That Explain",
    body: "Daily and weekly, Node turns what happened to your portfolio into plain language — what moved, and why. The brief you'd actually read, mapped to the exact holdings you own.",
  },
  {
    icon: Globe,
    title: "Live Macro Context",
    body: "See how real-world events impact your portfolio. Node integrates traditional news alongside live prediction market probabilities, giving you a clearer picture of shifting economic and market trends.",
  },
  {
    icon: BarChart3,
    title: "One Clear View",
    body: "Portfolio value, allocations, and benchmarks in a single high-density view — no clutter, no upsells, none of the noise of a banking app.",
  },
];

const ROADMAP = [
  {
    icon: Mic,
    title: "Ask It Anything",
    body: "Talk to Node in plain language — how your month went, where you're drifting, what you're exposed to. And because it's built to remember you, the answers get more personal the longer you use it.",
  },
  {
    icon: ShieldCheck,
    title: "Behavioral Guardrails",
    body: "Most apps reward trading more. Node is designed to reward discipline — tracking your streaks, helping you resist panic-selling, and keeping you on your strategy.",
  },
  {
    icon: Receipt,
    title: "Beyond Your Portfolio",
    body: "Budget, spending, and goals join the picture — connecting everyday money decisions to your long-term wealth, so the whole hub reasons together.",
  },
];

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Node",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  url: SITE_URL,
  description: DESCRIPTION,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

function FeatureCard({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-sm transition-all duration-300 hover:border-foreground/30 hover:shadow-md">
      <Icon className="h-5 w-5 text-muted-foreground" />
      <h3 className="mt-4 text-base font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

// Inner content wrapper — keeps text/cards within the readable max-width.
function Container({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`mx-auto w-full max-w-5xl px-6 ${className}`}>{children}</div>
  );
}

export default function WaitlistLandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      {/* ── Header — sticky, collapses to pill on scroll ──────── */}
      <WaitlistHeader />

      {/* ── Hero — bg-background ────────────────────────────────── */}
      <section className="bg-background py-24 text-center sm:py-32">
        <Container>
          <div className="mb-8 flex items-center justify-center gap-3">
            <NodeLogo className="h-16 w-16" />
            <span className="text-4xl font-semibold tracking-tight sm:text-5xl">Node</span>
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Your finances, explained.
            <br />
            At any time.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg">
            The personal finance hub that knows you — bound to your data and aware of what's happening in the world. 
            One clear view, and answers the moment you ask.
          </p>
          <div className="mx-auto mt-8 max-w-md">
            <WaitlistForm />
            <p className="mt-3 text-xs text-muted-foreground">
              Built for retail investors.
            </p>
          </div>
        </Container>
      </section>

      {/* ── Core features — bg-surface ──────────────────────────── */}
      <section className="border-t border-hairline bg-surface py-16 sm:py-20">
        <Container>
          <h2 className="mx-auto max-w-2xl text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            Not another dashboard. Node explains how and why your money is moving.
          </h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {FEATURES.map((f) => (
              <FeatureCard key={f.title} {...f} />
            ))}
          </div>
        </Container>
      </section>

      {/* ── Transparency & trust — bg-background ────────────────── */}
      <section className="border-t border-hairline bg-background py-16 text-center sm:py-20">
        <Container>
          <h2 className="mx-auto max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
            Built for clarity, not commissions.
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground">
          Node never touches your money — no trades, no transactions, nothing to sell you.
          That independence is the point: with nothing to push, the only thing Node optimizes
          for is whether you actually understand what's going on.
          </p>
        </Container>
      </section>

      {/* ── Roadmap — bg-surface ────────────────────────────────── */}
      <section className="border-t border-hairline bg-surface py-16 sm:py-20">
        <Container>
          <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            Where Node is headed.
          </h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {ROADMAP.map((r) => (
              <FeatureCard key={r.title} {...r} />
            ))}
          </div>
        </Container>
      </section>

      {/* ── Footer CTA — bg-background ──────────────────────────── */}
      <section className="border-t border-hairline bg-background py-20 text-center sm:py-24">
        <Container>
          <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Finances that finally make sense.
          </h3>
          <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
            Join the waitlist for early access.
          </p>
          <div className="mx-auto mt-8 max-w-md">
            <WaitlistForm />
          </div>
        </Container>
      </section>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="border-t border-hairline bg-surface py-8 text-center">
        <p className="text-xs text-muted-foreground">© 2026 Node. All rights reserved.</p>
      </footer>
    </div>
  );
}