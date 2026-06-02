import type { Metadata } from "next";
import { DM_Sans, DM_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeInitializer } from "@/components/ThemeSwitcher";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "../src/styles.css";

// Typography source of truth: see apps/web/DESIGN_SYSTEM.md.
// next/font loaders must stay at module scope here (Next.js requirement);
// only the weights listed below exist in the system — keep the doc in sync.
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-dm-sans",
  display: "swap",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Node",
  description: "Premium agentic portfolio management",
  icons: [
    {
      rel: "icon",
      type: "image/svg+xml",
      url: "/brand/node_logo_black.svg",
      media: "(prefers-color-scheme: light)",
    },
    {
      rel: "icon",
      type: "image/svg+xml",
      url: "/brand/node_logo_white.svg",
      media: "(prefers-color-scheme: dark)",
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${dmMono.variable}`} suppressHydrationWarning>
      <body>
        <ThemeInitializer />
        {children}
        <Toaster />
        <SpeedInsights />
      </body>
    </html>
  );
}
