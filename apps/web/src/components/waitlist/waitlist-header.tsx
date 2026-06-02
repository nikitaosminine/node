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
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="sticky top-0 z-50 w-full">
      {/*
        Single element — transitions the same properties in both directions.
        Switching entire className strings breaks CSS transitions because the
        browser sees two different elements. Instead we keep one element and
        animate max-width, padding, border-radius, and background via inline
        style values toggled by the scrolled flag.
      */}
      <div
        style={{
          maxWidth: scrolled ? "32rem" : "100%",
          marginLeft: "auto",
          marginRight: "auto",
          marginTop: scrolled ? "0.5rem" : "0",
          marginBottom: scrolled ? "0.5rem" : "0",
          borderRadius: scrolled ? "9999px" : "0",
          paddingTop: scrolled ? "0.375rem" : "1.25rem",
          paddingBottom: scrolled ? "0.375rem" : "1.25rem",
          paddingLeft: scrolled ? "1rem" : "1.5rem",
          paddingRight: scrolled ? "1rem" : "1.5rem",
          boxShadow: scrolled ? "0 4px 24px 0 rgba(0,0,0,0.10)" : "none",
          transition:
            "max-width 500ms cubic-bezier(0.4,0,0.2,1), " +
            "margin 500ms cubic-bezier(0.4,0,0.2,1), " +
            "border-radius 500ms cubic-bezier(0.4,0,0.2,1), " +
            "padding 500ms cubic-bezier(0.4,0,0.2,1), " +
            "box-shadow 500ms cubic-bezier(0.4,0,0.2,1)",
        }}
        className={`flex items-center justify-between border border-hairline ${
          scrolled
            ? "bg-background/80 backdrop-blur-md"
            : "border-b-hairline border-l-transparent border-r-transparent border-t-transparent bg-background"
        }`}
      >
        {/* Left: logo + wordmark */}
        <div className="flex items-center gap-2">
          <div
            style={{
              width: scrolled ? "1.5rem" : "2.25rem",
              height: scrolled ? "1.5rem" : "2.25rem",
              transition: "width 500ms cubic-bezier(0.4,0,0.2,1), height 500ms cubic-bezier(0.4,0,0.2,1)",
            }}
          >
            <NodeLogo className="h-full w-full" />
          </div>
          <span
            style={{
              fontSize: scrolled ? "0.875rem" : "1.125rem",
              transition: "font-size 500ms cubic-bezier(0.4,0,0.2,1)",
            }}
            className="font-semibold tracking-tight"
          >
            Node
          </span>
        </div>

        {/* Right: login link + theme toggle */}
        <div className="flex items-center gap-3">
          <p
            style={{
              opacity: scrolled ? 0 : 1,
              maxWidth: scrolled ? "0px" : "400px",
              overflow: "hidden",
              whiteSpace: "nowrap",
              transition:
                "opacity 400ms cubic-bezier(0.4,0,0.2,1), max-width 500ms cubic-bezier(0.4,0,0.2,1)",
            }}
            className="text-sm text-muted-foreground"
          >
            Already have an invitation?{" "}
            <Link href="/login" className="text-foreground transition-colors hover:underline">
              Log in here
            </Link>
          </p>
          <Link
            href="/login"
            style={{
              opacity: scrolled ? 1 : 0,
              pointerEvents: scrolled ? "auto" : "none",
              transition: "opacity 400ms cubic-bezier(0.4,0,0.2,1)",
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Log in
          </Link>
          <ThemeSwitcher compact />
        </div>
      </div>
    </div>
  );
}
