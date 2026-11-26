import { useQuery } from "@tanstack/react-query";
import type { PreFlightFixAction } from "@yocto-studio/shared-protocol";
import { Activity, Cpu, Database, Gauge, HardDrive, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, ProgressBar } from "@/components/ui/primitives";
import { getPreFlightHostProfile, preflightRpc } from "@/lib/preflightApi";

export function BuildOptimizerPanel({
  target,
  onPreviewFix,
}: {
  target: string;
  onPreviewFix: (fix: PreFlightFixAction) => void;
}) {
  const { t } = useTranslation();
  const hostQ = useQuery({
    queryKey: ["preflight-host-profile"],
    queryFn: () => getPreFlightHostProfile(),
  });

  const optQ = useQuery({
    queryKey: ["preflight-optimization-plan", hostQ.data],
    queryFn: () => preflightRpc.getOptimizationPlan(hostQ.data),
    enabled: Boolean(hostQ.data),
  });

  const sstateQ = useQuery({
    queryKey: ["preflight-sstate-probe", target],
    queryFn: () => preflightRpc.probeSstate(target),
  });

  const host = optQ.data?.host ?? hostQ.data;

  return (
    <div className="space-y-4">
      {/* Host Profile Summary */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <Cpu className="h-4 w-4 text-accent" />
            {t("preflight.hostProfileTitle")}
          </h2>
          {host && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              <Badge className="mono-num">
                {t("preflight.coresCount", { count: host.cpu_cores })}
              </Badge>
              <Badge className="mono-num">{host.ram_total_gb} GiB RAM</Badge>
              <Badge tone={host.disk_free_gb < 180 ? "warn" : "ok"} className="mono-num">
                {t("preflight.freeDiskGb", { gb: host.disk_free_gb })}
              </Badge>
              <Badge tone={host.psi_supported ? "ok" : "neutral"}>
                PSI (/proc/pressure): {host.psi_supported ? t("preflight.psiSupported") : t("preflight.none")}
              </Badge>
            </div>
          )}
        </div>

        <div className="space-y-2">
          {!optQ.data?.recommendations.length ? (
            <div className="rounded border border-success/40 bg-success/10 p-3 text-xs text-success">
              {t("preflight.optAllApplied")}
            </div>
          ) : (
            optQ.data.recommendations.map((rec) => (
              <div
                key={rec.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-bg p-3 text-xs"
              >
                <div className="space-y-0.5">
                  <div className="font-semibold text-fg flex items-center gap-2">
                    <Gauge className="h-3.5 w-3.5 text-accent" />
                    {rec.title}
                  </div>
                  <div className="text-muted">{rec.impact}</div>
                  <div className="mono-num text-[11px] text-muted">
                    {t("preflight.currentLabel")} {rec.current_value} → {t("preflight.recommendedLabel")}{" "}
                    <span className="text-accent">{rec.recommended_value}</span>
                  </div>
                </div>
                {rec.auto_fix && (
                  <Button size="sm" variant="primary" onClick={() => onPreviewFix(rec.auto_fix!)}>
                    <Sparkles className="h-3 w-3" />
                    {t("preflight.previewAndApply")}
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </Card>

      {/* sstate-cache & BB_HASHSERVE Probe */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <Database className="h-4 w-4 text-accent" />
            {t("preflight.sstateProbeTitle")}
          </h2>
          <Button size="sm" onClick={() => void sstateQ.refetch()}>
            <Activity className="h-3.5 w-3.5" />
            {t("preflight.retestBtn")}
          </Button>
        </div>

        {sstateQ.data && (
          <div className="space-y-3 text-xs">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-fg">{sstateQ.data.recommendation}</span>
                <Badge tone="accent" className="mono-num">
                  {t("preflight.hitPercentEst", { pct: sstateQ.data.estimated_hit_percent })}
                </Badge>
              </div>
              <ProgressBar value={sstateQ.data.estimated_hit_percent} tone="ok" />
            </div>

            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {sstateQ.data.mirrors.map((m) => (
                <div key={m.url} className="rounded border border-border bg-bg p-2.5 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-fg flex items-center gap-1.5">
                      <HardDrive className="h-3.5 w-3.5 text-accent" />
                      SSTATE Mirror
                    </span>
                    <Badge tone={m.reachable ? "ok" : "danger"}>
                      {m.reachable ? t("preflight.reachableMs", { ms: m.latency_ms ?? 0 }) : m.status}
                    </Badge>
                  </div>
                  <div className="mono-num text-[11px] text-muted truncate">{m.url}</div>
                </div>
              ))}
              <div className="rounded border border-border bg-bg p-2.5 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-fg">BB_HASHSERVE</span>
                  <Badge tone={sstateQ.data.hashserve.reachable ? "ok" : "warn"}>
                    {sstateQ.data.hashserve.reachable
                      ? t("preflight.connectedMs", { ms: sstateQ.data.hashserve.latency_ms ?? 0 })
                      : sstateQ.data.hashserve.status}
                  </Badge>
                </div>
                <div className="mono-num text-[11px] text-muted truncate">
                  {sstateQ.data.hashserve.endpoint}
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
