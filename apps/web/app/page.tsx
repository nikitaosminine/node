import type { Metadata } from "next";
import { BarChart3, Globe, type LucideIcon, Mic, Newspaper, Receipt, ShieldCheck } from "lucide-react";
import { NodeLogo } from "@/components/node-logo";
import { WaitlistHeader } from "@/components/waitlist/waitlist-header";
import { WaitlistForm } from "@/components/waitlist/waitlist-form";

const SITE_URL = "https://trynode.app";
const TITLE = "Node | AI-Native Portfolio Tracker & Macro Workspace";
const DESCRIPTION =
  "A clean, high-density investing workspace for retail investors. Track portfolio trends, view automated market briefs, and monitor macro developments without the bloat.";

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
    title: "Portfolio-Specific Briefs",
    body: "Stop scrolling through generic financial news. Node runs an automated data loop to generate daily, bite-sized visual recaps and stories mapped directly to the specific stocks and ETFs you hold.",
  },
  {
    icon: Globe,
    title: "Live Macro Context",
    body: "See how real-world events impact broader markets. Node integrates traditional news headlines alongside live prediction market probabilities, giving you a clearer picture of shifting economic trends.",
  },
  {
    icon: BarChart3,
    title: "Clear Performance Analytics",
    body: "A high-density interface built strictly for tracking portfolio value trends, asset allocations, and performance benchmarks—without the visual clutter or hidden upsells of traditional banking apps.",
  },
];

const ROADMAP = [
  {
    icon: Mic,
    title: "Natural Language Queries",
    body: "Query your portfolio natively using your voice. Ask Node about monthly performance trends, category drifts, or macro exposure, and receive direct, data-grounded answers without digging through menus.",
  },
  {
    icon: ShieldCheck,
    title: "Behavioral Guardrails",
    body: "Most consumer finance apps try to incentivize high trading volume. Node is being designed to reward long-term discipline—helping you track investment streaks, resist emotional panic-selling, and stick to your strategy.",
  },
  {
    icon: Receipt,
    title: "Smart Expense Mindsets",
    body: "Connect daily recurring spending habits directly to your wealth goals. Node highlights the long-term opportunity cost of friction expenses, mapping out how automated changes compound when redirected into your portfolio.",
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
          <NodeLogo className="mx-auto mb-8 h-16 w-16" />
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Track what you own.
            <br />
            Understand why you own it.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg">
            Node combines portfolio tracking, asset allocation analytics, and macro market
            intelligence into a single, clutter-free workspace designed for individual investors.
          </p>
          <div className="mx-auto mt-8 max-w-md">
            <WaitlistForm />
            <p className="mt-3 text-xs text-muted-foreground">
              Built for retail investors. No spam, just early access updates.
            </p>
          </div>
        </Container>
      </section>

      {/* ── Core features — bg-surface ──────────────────────────── */}
      <section className="border-t border-hairline bg-surface py-16 sm:py-20">
        <Container>
          <h2 className="mx-auto max-w-2xl text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            Beyond basic stock charts. A focused workspace for your wealth.
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
            Built for execution, not speculation.
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground">
            Node is an independent software tool, not a brokerage platform. We process no financial
            transactions, execute no trades, and sell no financial products. Our only objective is
            providing unbiased data clarity to help you manage your investment habits.
          </p>
        </Container>
      </section>

      {/* ── Roadmap — bg-surface ────────────────────────────────── */}
      <section className="border-t border-hairline bg-surface py-16 sm:py-20">
        <Container>
          <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            Where we are going.
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
            Ready for a disciplined investing workflow?
          </h3>
          <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
            Secure your spot on the waitlist today to get early access to the beta.
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
