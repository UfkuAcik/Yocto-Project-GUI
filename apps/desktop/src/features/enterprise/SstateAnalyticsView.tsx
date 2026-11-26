import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Database, Layers, RefreshCw, Server } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input, ProgressBar } from "@/components/ui/primitives";
import { enterpriseRpc } from "@/lib/enterpriseApi";

export function SstateAnalyticsView() {
  const { t } = useTranslation();
  const [timeRange, setTimeRange] = useState<"24h" | "7d" | "30d">("7d");
  const [mirrorUrl, setMirrorUrl] = useState("https://sstate.yoctoproject.org/all/PATH");
  const [hashserve, setHashserve] = useState("wss://hashserv.yoctostudio.dev:8687");

  const analyticsQ = useQuery({
    queryKey: ["enterprise-sstate-analytics", timeRange, mirrorUrl, hashserve],
    queryFn: () =>
      enterpriseRpc.getSstateRunnerAnalytics({
        mirror_url: mirrorUrl,
        hashserve_endpoint: hashserve,
        time_range: timeRange,
      }),
  });

  const data = analyticsQ.data;
  const points = data?.trend ?? [];

  // SVG chart coordinates
  const svgWidth = 640;
  const svgHeight = 140;
  const hitPolyline = points
    .map((pt, idx) => {
      const x = points.length <= 1 ? svgWidth / 2 : 24 + (idx / (points.length - 1)) * (svgWidth - 48);
      const y = svgHeight - 20 - (Math.min(100, Math.max(0, pt.hit_rate_percent)) / 100) * (svgHeight - 36);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("enterprise.sstate.heading")}</h3>
          <p className="text-xs text-muted">{t("enterprise.sstate.desc")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["24h", "7d", "30d"] as const).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={timeRange === r ? "primary" : "secondary"}
              onClick={() => setTimeRange(r)}
            >
              {r}
            </Button>
          ))}
          <Button size="sm" variant="secondary" onClick={() => void analyticsQ.refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("enterprise.sstate.refreshBtn")}
          </Button>
        </div>
      </div>

      {/* Endpoint Probe Bar */}
      <Card className="p-3">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 text-xs">
          <div className="flex items-center gap-2">
            <Input value={mirrorUrl} onChange={(e) => setMirrorUrl(e.target.value)} placeholder="SSTATE_MIRRORS" />
            {data && (
              <Badge tone={data.mirror_status.reachable ? "ok" : "danger"} className="shrink-0 mono-num">
                {data.mirror_status.reachable ? `${data.mirror_status.latency_ms ?? 0}ms` : "offline"}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Input value={hashserve} onChange={(e) => setHashserve(e.target.value)} placeholder="BB_HASHSERVE" />
            {data && (
              <Badge tone={data.hashserve_status.reachable ? "ok" : "danger"} className="shrink-0 mono-num">
                {data.hashserve_status.reachable ? `${data.hashserve_status.latency_ms ?? 0}ms` : "offline"}
              </Badge>
            )}
          </div>
        </div>
      </Card>

      {data && (
        <>
          {/* KPI Row */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4 text-xs">
            <Card className="p-3 space-y-1.5">
              <div className="flex items-center justify-between text-muted">
                <span>{t("enterprise.sstate.fleetHit")}</span>
                <CheckCircle2 className="h-4 w-4 text-success" />
              </div>
              <div className="text-xl font-bold mono-num text-fg">
                {t("enterprise.sstate.pctPrefix", { pct: data.fleet_hit_rate_percent })}
              </div>
              <ProgressBar value={data.fleet_hit_rate_percent} tone="ok" />
            </Card>

            <Card className="p-3 space-y-1.5">
              <div className="flex items-center justify-between text-muted">
                <span>{t("enterprise.sstate.hashEquiv")}</span>
                <Layers className="h-4 w-4 text-accent" />
              </div>
              <div className="text-xl font-bold mono-num text-accent">
                {t("enterprise.sstate.pctPrefix", { pct: data.hashequiv_dedup_percent })}
              </div>
              <div className="text-[11px] text-muted">{t("enterprise.sstate.hashEquivSub")}</div>
            </Card>

            <Card className="p-3 space-y-1.5">
              <div className="flex items-center justify-between text-muted">
                <span>{t("enterprise.sstate.timeSaved")}</span>
                <Clock className="h-4 w-4 text-success" />
              </div>
              <div className="text-xl font-bold mono-num text-fg">
                {t("enterprise.sstate.hoursShort", { val: data.total_time_saved_hours })}
              </div>
              <div className="text-[11px] text-muted">
                {t("enterprise.sstate.runnersCount", { count: data.runners.length })}
              </div>
            </Card>

            <Card className="p-3 space-y-1.5">
              <div className="flex items-center justify-between text-muted">
                <span>{t("enterprise.sstate.footprint")}</span>
                <Database className="h-4 w-4 text-warning" />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-lg font-bold mono-num">
                  {data.cache_footprint_gb} / {data.cache_quota_gb} GB
                </span>
                <Badge tone={data.eviction_risk === "high" ? "danger" : data.eviction_risk === "medium" ? "warn" : "ok"}>
                  {data.eviction_risk}
                </Badge>
              </div>
              <ProgressBar
                value={(data.cache_footprint_gb / Math.max(1, data.cache_quota_gb)) * 100}
                tone={data.eviction_risk === "low" ? "accent" : "warn"}
              />
            </Card>
          </div>

          {/* Anomalies */}
          {data.anomalies.length > 0 && (
            <div className="space-y-2">
              {data.anomalies.map((anom) => (
                <Card
                  key={anom.id}
                  className={`p-3 border ${
                    anom.severity === "critical"
                      ? "border-danger/50 bg-danger/10"
                      : "border-warning/40 bg-warning/10"
                  }`}
                >
                  <div className="flex items-start gap-2.5 text-xs">
                    <AlertTriangle
                      className={`h-4 w-4 shrink-0 mt-0.5 ${
                        anom.severity === "critical" ? "text-danger" : "text-warning"
                      }`}
                    />
                    <div className="space-y-0.5">
                      <div className="font-semibold text-fg">{anom.title}</div>
                      <div className="text-muted">{anom.detail}</div>
                      <div className="text-[11px] text-accent">
                        {t("enterprise.sstate.recommendationPrefix", { text: anom.recommendation })}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Trend SVG + HashEquiv Top Recipes */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="p-4 space-y-2">
              <div className="text-xs font-semibold">{t("enterprise.sstate.trendTitle")}</div>
              <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-36 rounded bg-bg/70 border border-border">
                <line x1="24" y1={svgHeight - 20} x2={svgWidth - 24} y2={svgHeight - 20} stroke="#334155" strokeWidth="1" />
                {points.length > 1 && (
                  <polyline
                    fill="none"
                    stroke="#10B981"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={hitPolyline}
                  />
                )}
                {points.map((pt, idx) => {
                  const x =
                    points.length <= 1 ? svgWidth / 2 : 24 + (idx / (points.length - 1)) * (svgWidth - 48);
                  const y =
                    svgHeight - 20 - (Math.min(100, Math.max(0, pt.hit_rate_percent)) / 100) * (svgHeight - 36);
                  return (
                    <g key={pt.label}>
                      <circle cx={x} cy={y} r="4" fill="#38BDF8" />
                      <text x={x} y={svgHeight - 6} textAnchor="middle" fontSize="10" fill="#94A3B8">
                        {pt.label}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </Card>

            <Card className="p-4 space-y-2">
              <div className="text-xs font-semibold">{t("enterprise.sstate.hashEquivRecipes")}</div>
              <div className="space-y-1.5 text-xs">
                {data.hash_equiv_top_recipes.map((item) => (
                  <div
                    key={item.recipe}
                    className="flex items-center justify-between rounded border border-border bg-bg/70 px-2.5 py-1.5"
                  >
                    <div>
                      <span className="font-semibold mono-num">{item.recipe}</span>{" "}
                      <span className="text-[11px] text-muted">
                        ({item.equivalent_unihash_hits}/{item.out_hash_changes} uniHash)
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mono-num text-[11px]">
                      <Badge tone="accent">
                        {t("enterprise.sstate.skippedTasks", { count: item.skipped_downstream_tasks })}
                      </Badge>
                      <span className="text-success font-semibold">
                        {t("enterprise.sstate.savedMin", { min: item.saved_minutes })}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Runners Comparison Table */}
          <Card className="p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Server className="h-4 w-4 text-accent" />
              {t("enterprise.sstate.runnersTitle")}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-[11px] text-muted">
                    <th className="py-2 pr-3">Runner</th>
                    <th className="py-2 pr-3">{t("enterprise.sstate.colProviderBranch")}</th>
                    <th className="py-2 pr-3">NATIVELSBSTRING</th>
                    <th className="py-2 pr-3">Hit Rate</th>
                    <th className="py-2 pr-3">HashEquiv</th>
                    <th className="py-2 pr-3">{t("enterprise.sstate.colAvgDuration")}</th>
                    <th className="py-2 text-right">{t("enterprise.sstate.colStatus")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {data.runners.map((r) => (
                    <tr key={r.runner_id} className="hover:bg-elevated/40">
                      <td className="py-2 pr-3 font-semibold mono-num">{r.runner_name}</td>
                      <td className="py-2 pr-3 text-[11px] text-muted">
                        {r.provider} · <span className="mono-num text-fg">{r.branch}</span>
                      </td>
                      <td className="py-2 pr-3 mono-num text-[11px]">{r.nativelsbstring}</td>
                      <td className="py-2 pr-3 mono-num font-semibold">
                        {t("enterprise.sstate.pctPrefix", { pct: r.hit_rate_percent })}{" "}
                        <span className="text-[10px] text-muted font-normal">
                          ({r.local_hits + r.mirror_hits}/{r.wanted_tasks})
                        </span>
                      </td>
                      <td className="py-2 pr-3 mono-num text-accent">{r.hashequiv_reused}</td>
                      <td className="py-2 pr-3 mono-num">
                        {t("enterprise.sstate.avgMin", { min: r.avg_duration_min })}
                      </td>
                      <td className="py-2 text-right">
                        <Badge tone={r.status === "healthy" ? "ok" : r.status === "degraded" ? "warn" : "danger"}>
                          {r.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
