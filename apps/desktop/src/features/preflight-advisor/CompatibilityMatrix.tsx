import { useQuery } from "@tanstack/react-query";
import type { PreFlightAuditReport, PreFlightFixAction } from "@yocto-studio/shared-protocol";
import { AlertTriangle, CheckCircle2, Layers, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { preflightRpc } from "@/lib/preflightApi";

export function CompatibilityMatrix({
  target,
  report,
  onRunCheckLayer,
  onPreviewFix,
}: {
  target: string;
  report: PreFlightAuditReport | null;
  onRunCheckLayer: (layer: string) => void;
  onPreviewFix: (fix: PreFlightFixAction) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [showUpgrades, setShowUpgrades] = useState(false);

  const matrixQ = useQuery({
    queryKey: ["preflight-version-matrix", target, search],
    queryFn: () => preflightRpc.getVersionMatrix({ target, query: search }),
  });

  const upgradesQ = useQuery({
    queryKey: ["preflight-check-upgrades"],
    queryFn: () => preflightRpc.checkUpgrades(),
    enabled: showUpgrades,
  });

  const entries = showUpgrades && upgradesQ.data ? upgradesQ.data.entries : (matrixQ.data?.entries ?? []);

  return (
    <div className="space-y-4">
      {/* BSP & Layer Compatibility Table */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <Layers className="h-4 w-4 text-accent" />
            {t("preflight.matrixLayerTitle")}
          </h2>
          {report?.check_layer_summary && (
            <Badge tone={report.check_layer_summary.status === "PASS" ? "ok" : "danger"}>
              yocto-check-layer ({report.check_layer_summary.layer}):{" "}
              {report.check_layer_summary.status} ({report.check_layer_summary.passed} PASS /{" "}
              {report.check_layer_summary.failed} FAIL)
            </Badge>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[11px] text-muted">
                <th className="py-2 pr-3">{t("preflight.colLayer")}</th>
                <th className="py-2 pr-3">{t("preflight.colBranchSeries")}</th>
                <th className="py-2 pr-3">{t("preflight.colStatus")}</th>
                <th className="py-2 pr-3">{t("preflight.colAppendDrift")}</th>
                <th className="py-2 pr-3">{t("preflight.colMissingDep")}</th>
                <th className="py-2 text-right">{t("preflight.colVerify")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {report?.layer_checks.map((lyr) => (
                <tr key={lyr.name}>
                  <td className="py-2 pr-3 font-semibold mono-num text-fg">
                    {lyr.name} (P{lyr.priority})
                  </td>
                  <td className="py-2 pr-3 mono-num text-muted">
                    {lyr.branch} · [{lyr.compat.join(", ") || "—"}]
                  </td>
                  <td className="py-2 pr-3">
                    {lyr.compat_ok ? (
                      <Badge tone="ok">
                        <CheckCircle2 className="h-3 w-3" />
                        {t("preflight.seriesCompatible", { series: lyr.active_series })}
                      </Badge>
                    ) : (
                      <Badge tone="danger">
                        <AlertTriangle className="h-3 w-3" />
                        {t("preflight.seriesIncompatible")}
                      </Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {lyr.drifted_appends.length > 0 ? (
                      <Badge tone="danger">
                        {t("preflight.driftedCount", { count: lyr.drifted_appends.length })}
                      </Badge>
                    ) : (
                      <span className="text-muted">{t("preflight.clean")}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {lyr.missing_depends.length > 0 ? (
                      <Badge tone="danger">{lyr.missing_depends.join(", ")}</Badge>
                    ) : (
                      <span className="text-muted">{t("preflight.none")}</span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <Button size="sm" onClick={() => onRunCheckLayer(lyr.name)}>
                      yocto-check-layer
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Library & Recipe Version Matrix */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">
            {t("preflight.versionMatrixTitle")}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("preflight.matrixSearchPlaceholder")}
              className="w-64"
            />
            <Button
              size="sm"
              variant={showUpgrades ? "primary" : "secondary"}
              onClick={() => {
                setShowUpgrades(true);
                void upgradesQ.refetch();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              devtool check-upgrade-status
            </Button>
          </div>
        </div>

        {(matrixQ.data?.conflicts?.length ?? 0) > 0 && (
          <div className="space-y-1.5">
            {matrixQ.data?.conflicts.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-warning/40 bg-warning/10 p-2.5 text-xs"
              >
                <div>
                  <div className="font-semibold text-fg">{c.title}</div>
                  <div className="text-muted">{c.summary}</div>
                </div>
                {c.auto_fix && (
                  <Button size="sm" variant="primary" onClick={() => onPreviewFix(c.auto_fix!)}>
                    <Sparkles className="h-3 w-3" />
                    {c.auto_fix.label}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[11px] text-muted">
                <th className="py-2 pr-3">{t("preflight.colRecipe")}</th>
                <th className="py-2 pr-3">{t("preflight.colResolvedVer")}</th>
                <th className="py-2 pr-3">{t("preflight.colLayer")}</th>
                <th className="py-2 pr-3">.bbappend</th>
                <th className="py-2">{t("preflight.colSecurityState")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {entries.map((e) => (
                <tr key={e.recipe}>
                  <td className="py-2 pr-3 font-semibold mono-num text-fg">{e.recipe}</td>
                  <td className="py-2 pr-3 mono-num text-accent">{e.resolved_version}</td>
                  <td className="py-2 pr-3 mono-num text-muted">{e.layer}</td>
                  <td className="py-2 pr-3 mono-num text-muted">
                    {e.bbappends.length > 0 ? e.bbappends.length : "—"}
                  </td>
                  <td className="py-2">
                    {e.upgrade_status === "security-risk" ? (
                      <span title={e.security_note ?? ""}>
                        <Badge tone="danger">
                          <ShieldAlert className="h-3 w-3" />
                          {t("preflight.securityRisk")}{" "}
                          {e.upstream_version ? `(Upstream: ${e.upstream_version})` : ""}
                        </Badge>
                      </span>
                    ) : e.upgrade_status === "outdated" ? (
                      <Badge tone="warn">
                        {t("preflight.updateAvail", { ver: e.upstream_version })}
                      </Badge>
                    ) : e.upgrade_status === "up-to-date" ? (
                      <Badge tone="ok">{t("preflight.upToDate")}</Badge>
                    ) : (
                      <span className="text-muted">Normal</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
