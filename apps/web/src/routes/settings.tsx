"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { authHeaders } from "@/lib/api";

const DEPLOYED_API_BASE_URL = "https://binturong-api.nikita-osminine.workers.dev";
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? DEPLOYED_API_BASE_URL;

async function fetchApiWithFallback(path: string, init?: RequestInit): Promise<Response> {
  const primaryUrl = `${API_BASE_URL}${path}`;
  const fallbackUrl = `${DEPLOYED_API_BASE_URL}${path}`;
  const canFallback = API_BASE_URL !== DEPLOYED_API_BASE_URL;

  // The API authenticates via bearer token — attach it to every request.
  const auth = await authHeaders();
  const authedInit: RequestInit = { ...init, headers: { ...auth, ...(init?.headers ?? {}) } };

  try {
    const primary = await fetch(primaryUrl, authedInit);
    if (!canFallback) return primary;

    if (primary.ok) return primary;

    const body = await primary
      .clone()
      .text()
      .catch(() => "");
    const hasServerConfigError = body.includes("Server misconfiguration");
    if (!hasServerConfigError) return primary;

    return fetch(fallbackUrl, authedInit);
  } catch (error) {
    if (!canFallback) throw error;
    return fetch(fallbackUrl, authedInit);
  }
}

interface AgentUserSettingsResponse {
  user_id: string;
  timezone: string;
  global_runs_per_day: number;
  auto_apply_enabled: boolean;
  auto_apply_min_confidence: number;
}

interface AgentPortfolioSettingsResponse {
  id: string;
  user_id: string;
  portfolio_id: string;
  runs_per_day_override: number | null;
  agent_enabled: boolean;
}

interface PortfolioRow {
  id: string;
  name: string;
}

interface AgentMetricsResponse {
  window_hours: number;
  total_runs: number;
  queue_depth: number;
  success_rate: number | null;
  counts_by_status: Record<string, number>;
  counts_by_trigger: Record<string, number>;
  duration_ms: {
    samples: number;
    avg: number | null;
    p50: number | null;
    p95: number | null;
  };
}

interface AgentAlertsResponse {
  alerts: Array<{
    key: string;
    triggered: boolean;
    value: number | null;
    threshold: number;
  }>;
}

export default function SettingsPage() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [portfolios, setPortfolios] = useState<PortfolioRow[]>([]);
  const [portfolioSettings, setPortfolioSettings] = useState<AgentPortfolioSettingsResponse[]>([]);
  const [metrics, setMetrics] = useState<AgentMetricsResponse | null>(null);
  const [alerts, setAlerts] = useState<AgentAlertsResponse["alerts"]>([]);
  const [settings, setSettings] = useState({
    timezone: "Europe/Paris",
    globalRunsPerDay: 2,
    autoApplyEnabled: false,
    autoApplyMinConfidence: 0.8,
  });

  useEffect(() => {
    if (!user?.id) return;
    void (async () => {
      try {
        setIsLoading(true);
        const [settingsRes, portfolioSettingsRes, metricsRes, alertsRes, portfoliosRes] =
          await Promise.all([
            fetchApiWithFallback(`/api/agent/settings?user_id=${user.id}`),
            fetchApiWithFallback(`/api/agent/portfolio-settings?user_id=${user.id}`),
            fetchApiWithFallback(`/api/agent/metrics?user_id=${user.id}&hours=24`),
            fetchApiWithFallback(`/api/agent/alerts?user_id=${user.id}&hours=24`),
            supabase
              .from("portfolios")
              .select("id,name")
              .eq("user_id", user.id)
              .order("name", { ascending: true }),
          ]);

        if (!settingsRes.ok) throw new Error(await settingsRes.text());
        if (!portfolioSettingsRes.ok) throw new Error(await portfolioSettingsRes.text());
        if (portfoliosRes.error) throw portfoliosRes.error;

        const settingsData = (await settingsRes.json()) as AgentUserSettingsResponse;
        const portfolioSettingsData =
          (await portfolioSettingsRes.json()) as AgentPortfolioSettingsResponse[];
        const metricsData = metricsRes.ok
          ? ((await metricsRes.json()) as AgentMetricsResponse)
          : null;
        const alertsData = alertsRes.ok ? ((await alertsRes.json()) as AgentAlertsResponse) : null;

        setSettings({
          timezone: settingsData.timezone ?? "Europe/Paris",
          globalRunsPerDay: settingsData.global_runs_per_day ?? 2,
          autoApplyEnabled: settingsData.auto_apply_enabled ?? false,
          autoApplyMinConfidence: settingsData.auto_apply_min_confidence ?? 0.8,
        });
        setPortfolioSettings(portfolioSettingsData ?? []);
        setMetrics(metricsData);
        setAlerts(alertsData?.alerts ?? []);
        setPortfolios((portfoliosRes.data as PortfolioRow[]) ?? []);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to load settings");
      } finally {
        setIsLoading(false);
      }
    })();
  }, [user?.id]);

  const portfolioSettingsMap = useMemo(
    () => new Map(portfolioSettings.map((row) => [row.portfolio_id, row])),
    [portfolioSettings],
  );

  const saveGlobalSettings = async () => {
    if (!user?.id) return;
    try {
      setIsSaving(true);
      const response = await fetchApiWithFallback("/api/agent/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          timezone: settings.timezone,
          globalRunsPerDay: settings.globalRunsPerDay,
          autoApplyEnabled: settings.autoApplyEnabled,
          autoApplyMinConfidence: settings.autoApplyMinConfidence,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      toast.success("Agent settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const savePortfolioSetting = async (
    portfolioId: string,
    payload: { runsPerDayOverride?: number | null; agentEnabled?: boolean },
  ) => {
    if (!user?.id) return;
    try {
      const existing = portfolioSettingsMap.get(portfolioId);
      const response = await fetchApiWithFallback("/api/agent/portfolio-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          portfolioId,
          runsPerDayOverride:
            payload.runsPerDayOverride === undefined
              ? (existing?.runs_per_day_override ?? null)
              : payload.runsPerDayOverride,
          agentEnabled:
            payload.agentEnabled === undefined
              ? (existing?.agent_enabled ?? true)
              : payload.agentEnabled,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const updated = (await response.json()) as AgentPortfolioSettingsResponse;
      setPortfolioSettings((prev) => {
        const next = prev.filter((row) => row.portfolio_id !== portfolioId);
        next.push(updated);
        return next;
      });
      toast.success("Portfolio setting saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save portfolio setting");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-6">
      <Card>
        <CardHeader>
          <CardTitle>Agent run metrics (last 24h)</CardTitle>
          <CardDescription>
            Quick health snapshot for queue depth, success rate, and latency.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!metrics ? (
            <p className="text-sm text-muted-foreground">No metrics yet.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Total runs</p>
                <p className="text-lg font-semibold">{metrics.total_runs}</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Queue depth</p>
                <p className="text-lg font-semibold">{metrics.queue_depth}</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Success rate</p>
                <p className="text-lg font-semibold">
                  {metrics.success_rate == null
                    ? "—"
                    : `${Math.round(metrics.success_rate * 100)}%`}
                </p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">p95 duration</p>
                <p className="text-lg font-semibold">
                  {metrics.duration_ms.p95 == null
                    ? "—"
                    : `${Math.round(metrics.duration_ms.p95 / 1000)}s`}
                </p>
              </div>
              <div className="rounded-md border border-border px-3 py-2 sm:col-span-2 lg:col-span-4">
                <p className="text-xs text-muted-foreground">Triggered alerts</p>
                <p className="text-sm font-medium">
                  {alerts.filter((alert) => alert.triggered).length === 0
                    ? "No active alerts"
                    : alerts
                        .filter((alert) => alert.triggered)
                        .map((alert) => alert.key)
                        .join(", ")}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent settings</CardTitle>
          <CardDescription>
            Control global run cadence, timezone, and auto-apply behavior for Trace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Input
              id="timezone"
              value={settings.timezone}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, timezone: event.target.value }))
              }
              placeholder="Europe/Paris"
              disabled={isLoading || isSaving}
            />
          </div>

          <div className="grid gap-2">
            <Label>Global runs per day</Label>
            <Select
              value={String(settings.globalRunsPerDay)}
              onValueChange={(value) =>
                setSettings((prev) => ({ ...prev, globalRunsPerDay: Number(value) }))
              }
              disabled={isLoading || isSaving}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 run/day</SelectItem>
                <SelectItem value="2">2 runs/day</SelectItem>
                <SelectItem value="3">3 runs/day</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div className="space-y-0.5">
              <Label htmlFor="auto-apply">Auto-apply updates</Label>
              <p className="text-xs text-muted-foreground">
                Off by default. When enabled, Trace can auto-apply high-confidence updates.
              </p>
            </div>
            <Switch
              id="auto-apply"
              checked={settings.autoApplyEnabled}
              onCheckedChange={(checked) =>
                setSettings((prev) => ({
                  ...prev,
                  autoApplyEnabled: checked,
                }))
              }
              disabled={isLoading || isSaving}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="confidence">Auto-apply confidence threshold (0-1)</Label>
            <Input
              id="confidence"
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={settings.autoApplyMinConfidence}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  autoApplyMinConfidence: Number(event.target.value || 0),
                }))
              }
              disabled={isLoading || isSaving}
            />
          </div>

          <Button onClick={saveGlobalSettings} disabled={isLoading || isSaving}>
            Save global settings
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Per-portfolio schedule overrides</CardTitle>
          <CardDescription>
            Override run frequency or disable agent runs for specific portfolios.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {portfolios.length === 0 ? (
            <p className="text-sm text-muted-foreground">No portfolios found.</p>
          ) : (
            portfolios.map((portfolio) => {
              const setting = portfolioSettingsMap.get(portfolio.id);
              return (
                <div
                  key={portfolio.id}
                  className="flex flex-col gap-2 rounded-lg border border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-medium">{portfolio.name}</p>
                    <p className="text-xs text-muted-foreground">{portfolio.id}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Select
                      value={String(setting?.runs_per_day_override ?? 0)}
                      onValueChange={(value) =>
                        savePortfolioSetting(portfolio.id, {
                          runsPerDayOverride: value === "0" ? null : Number(value),
                        })
                      }
                      disabled={isLoading}
                    >
                      <SelectTrigger className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">Use global default</SelectItem>
                        <SelectItem value="1">Override: 1/day</SelectItem>
                        <SelectItem value="2">Override: 2/day</SelectItem>
                        <SelectItem value="3">Override: 3/day</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`enabled-${portfolio.id}`} className="text-xs">
                        Enabled
                      </Label>
                      <Switch
                        id={`enabled-${portfolio.id}`}
                        checked={setting?.agent_enabled ?? true}
                        onCheckedChange={(checked) =>
                          savePortfolioSetting(portfolio.id, { agentEnabled: checked })
                        }
                        disabled={isLoading}
                      />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
