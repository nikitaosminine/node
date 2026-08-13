"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { runThemeFadeTransition } from "@/components/lightswind/theme-transition";
import { Switch } from "@/components/ui/switch";

type ThemeMode = "light" | "dark";

const STORAGE_KEY = "binturong-theme-mode";
const LEGACY_STORAGE_KEY = "portfolio-theme";
const LEGACY_THEME_CLASSES = [
  "theme-nordic",
  "theme-botanic",
  "theme-cobalt",
  "theme-aurora",
  "theme-sunset",
];

function getStoredMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "dark" || saved === "light" ? saved : "light";
}

// The applied theme is global (a class on <html>), so it cannot live in per-instance
// state: several switchers are mounted at once — the sidebar footer and the mobile
// top bar — and each must reflect the theme the others set.
let currentMode: ThemeMode = "light";
const modeListeners = new Set<() => void>();

function subscribeMode(listener: () => void) {
  modeListeners.add(listener);
  return () => {
    modeListeners.delete(listener);
  };
}

function getModeSnapshot(): ThemeMode {
  return currentMode;
}

function getServerModeSnapshot(): ThemeMode {
  return "light";
}

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  LEGACY_THEME_CLASSES.forEach((c) => root.classList.remove(c));
  root.classList.toggle("dark", mode === "dark");

  if (currentMode !== mode) {
    currentMode = mode;
    modeListeners.forEach((listener) => listener());
  }
}

export function ThemeInitializer() {
  useEffect(() => {
    applyTheme(getStoredMode());
  }, []);

  return null;
}

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const mode = useSyncExternalStore(subscribeMode, getModeSnapshot, getServerModeSnapshot);

  useEffect(() => {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    applyTheme(getStoredMode());
  }, []);

  const handleToggle = () => {
    const next = mode === "dark" ? "light" : "dark";
    runThemeFadeTransition(() => {
      applyTheme(next);
      localStorage.setItem(STORAGE_KEY, next);
    });
  };

  const isDark = mode === "dark";
  const Icon = isDark ? Moon : Sun;
  const label = isDark ? "Dark mode" : "Light mode";
  const nextLabel = isDark ? "Switch to light mode" : "Switch to dark mode";

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleToggle}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
        aria-label={nextLabel}
        title={nextLabel}
      >
        <Icon className="h-4 w-4 shrink-0" />
      </button>
    );
  }

  return (
    <label
      className="inline-flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      aria-label={nextLabel}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
      <Switch className="ml-auto" checked={isDark} onCheckedChange={() => handleToggle()} />
    </label>
  );
}
