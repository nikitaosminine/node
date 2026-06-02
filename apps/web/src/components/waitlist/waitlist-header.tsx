"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { NodeLogo } from "@/components/node-logo";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";

const SCROLL_THRESHOLD = 60;

export function WaitlistHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SCROLL_THRESHOLD);
    // Set initial state in case page loads mid-scroll
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    // Outer: always sticky, full-width, transitions its own bg/border on scroll
    <div className="sticky top-0 z-50 w-full">
      <div
        className={
          scrolled
            ? // Collapsed: centered floating pill
              "mx-auto my-2 flex max-w-lg items-center justify-between rounded-full border border-hairline bg-background/80 px-4 py-2 shadow-lg backdrop-blur-md transition-all duration-300"
            : // Expanded: full-width bar
              "flex items-center justify-between border-b border-hairline bg-background px-6 py-5 transition-all duration-300"
        }
      >
        {/* Left: logo + wordmark */}
        <div className="flex items-center gap-2.5">
          <NodeLogo className={scrolled ? "h-6 w-6" : "h-9 w-9"} />
          <span
            className={`font-semibold tracking-tight transition-all duration-300 ${scrolled ? "text-sm" : "text-lg"}`}
          >
            Node
          </span>
        </div>

        {/* Right: login link (hidden when collapsed) + theme toggle */}
        <div className="flex items-center gap-3">
          {!scrolled && (
            <p className="text-sm text-muted-foreground">
              Already have an invitation?{" "}
              <Link
                href="/login"
                className="text-foreground transition-colors hover:underline"
              >
                Log in here
              </Link>
            </p>
          )}
          {scrolled && (
            <Link
              href="/login"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Log in
            </Link>
          )}
          <ThemeSwitcher compact />
        </div>
      </div>
    </div>
  );
}
