import * as Tabs from "@radix-ui/react-tabs";
import type { PreFlightFixAction } from "@yocto-studio/shared-protocol";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  Compass,
  Gauge,
  Layers,
  PackageMinus,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Modal, ProgressBar, Switch } from "@/components/ui/primitives";
import { BloatDetectorView } from "@/features/preflight-advisor/BloatDetectorView";
import { BuildOptimizerPanel } from "@/features/preflight-advisor/BuildOptimizerPanel";
import { CompatibilityMatrix } from "@/features/preflight-advisor/CompatibilityMatrix";
import { ImagePlannerWizard } from "@/features/preflight-advisor/ImagePlannerWizard";
import {
  getPreFlightGateEnabled,
  getPreFlightHostProfile,
  preflightRpc,
  setPreFlightGateEnabled,
} from "@/lib/preflightApi";
import { rpcClient } from "@/lib/rpcClient";
import { useAppStore } from "@/stores/appStore";
import { useBuildStore } from "@/stores/buildStore";
import { usePreFlightStore } from "@/stores/preflightStore";

type SubTab = "summary" | "matrix" | "wizard" | "optimizer" | "bloat";

export function PreFlightDashboard() {
  const { t, i18n } = useTranslation();
  const prevLangRef = useRef(i18n.language);
  const [subTab, setSubTab] = useState<SubTab>("summary");
  const selectedTarget = useBuildStore((s) => s.selectedBuildTarget);
  const setActiveModule = useAppStore((s) => s.setActiveModule);

  const {
    report,
    gateEnabled,
    blockedBuildTarget,
    incompatibleLicenses,
    runningAudit,
    setReport,
    setGateEnabled,
    setBlockedBuildTarget,
    setRunningAudit,
  } = usePreFlightStore();

  const [previewModal, setPreviewModal] = useState<{
    fix: PreFlightFixAction;
    diff: string;
    message: string;
  } | null>(null);
  const [applying, setApplying] = useState(false);

  async function runAudit(options?: { checkLayer?: string; licenses?: string[] }) {
    setRunningAudit(true);
    try {
      const host = await getPreFlightHostProfile().catch(() => undefined);
      const res = await preflightRpc.runAudit({
        target: selectedTarget,
        incompatible_licenses: options?.licenses ?? incompatibleLicenses,
        check_layer: options?.checkLayer,
        host_resources: host,
      });
      setReport(res);
    } finally {
      setRunningAudit(false);
    }
  }

  useEffect(() => {
    void getPreFlightGateEnabled().then(setGateEnabled);
    if (!report || prevLangRef.current !== i18n.language) {
      prevLangRef.current = i18n.language;
      void runAudit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.language]);

  async function handleToggleGate(val: boolean) {
    setGateEnabled(val);
    await setPreFlightGateEnabled(val);
  }

  async function openFixPreview(fix: PreFlightFixAction) {
    const host = await getPreFlightHostProfile().catch(() => undefined);
    const preview = await preflightRpc.applyFix({
      fix,
      dry_run: true,
      target: selectedTarget,
      incompatible_licenses: incompatibleLicenses,
      host_resources: host,
    });
    setPreviewModal({
      fix,
      diff: preview.diff || t("preflight.defaultDiffComment"),
      message: preview.message,
    });
  }

  async function confirmApplyFix() {
    if (!previewModal) return;
    setApplying(true);
    try {
      const host = await getPreFlightHostProfile().catch(() => undefined);
      const res = await preflightRpc.applyFix({
        fix: previewModal.fix,
        dry_run: false,
        target: selectedTarget,
        incompatible_licenses: incompatibleLicenses,
        host_resources: host,
      });
      if (res.updated_report) {
        setReport(res.updated_report);
      } else {
        await runAudit();
      }
      setPreviewModal(null);
    } finally {
      setApplying(false);
    }
  }

  async function handleOverrideBuild() {
    const target = blockedBuildTarget ?? selectedTarget;
    setBlockedBuildTarget(null);
    setActiveModule("build");
    await rpcClient.call("build.start", { target });
  }

  const score = report?.score ?? 0;
  const scoreTone = score >= 85 ? "ok" : score >= 55 ? "warn" : "danger";
  const issues = report?.issues ?? [];

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-fg flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-accent" />
            {t("preflight.title")}
          </h1>
          <p className="text-xs text-muted">{t("preflight.subtitle")}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1 text-xs">
            <Switch checked={gateEnabled} onCheckedChange={(v) => void handleToggleGate(v)} />
            <span className="text-fg">{t("preflight.gateToggle")}</span>
          </div>
          <Button variant="primary" onClick={() => void runAudit()} disabled={runningAudit}>
            <RefreshCw className={`h-3.5 w-3.5 ${runningAudit ? "animate-spin" : ""}`} />
            {runningAudit ? t("preflight.auditing") : t("preflight.runCheck")}
          </Button>
        </div>
      </div>

      {/* Blocked Build Alert Banner */}
      {blockedBuildTarget && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/50 bg-danger/10 p-3 text-xs">
          <div className="flex items-center gap-2 text-danger font-semibold">
            <AlertOctagon className="h-4 w-4" />
            <span>
              {t("preflight.gateActive", {
                target: blockedBuildTarget,
                count: report?.blockers ?? 0,
              })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setBlockedBuildTarget(null)}>
              {t("preflight.close")}
            </Button>
            <Button size="sm" variant="danger" onClick={() => void handleOverrideBuild()}>
              <Play className="h-3 w-3" />
              {t("preflight.overrideStart")}
            </Button>
          </div>
        </div>
      )}

      {/* Score & KPI Strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Card className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted font-medium">{t("preflight.readinessScore")}</span>
            <Badge tone={scoreTone} className="mono-num font-bold">
              {score} / 100
            </Badge>
          </div>
          <ProgressBar value={score} tone={scoreTone} />
          <div className="text-[11px] text-muted">
            {report?.ready_to_build
              ? t("preflight.readyToBuild")
              : t("preflight.blockersWaiting")}
          </div>
        </Card>

        <Card className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted">{t("preflight.criticalBlockers")}</div>
            <div className="text-xl font-bold mono-num text-danger">{report?.blockers ?? 0}</div>
          </div>
          <AlertOctagon className="h-6 w-6 text-danger/60" />
        </Card>

        <Card className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted">{t("preflight.warningsLabel")}</div>
            <div className="text-xl font-bold mono-num text-warning">{report?.warnings ?? 0}</div>
          </div>
          <AlertTriangle className="h-6 w-6 text-warning/60" />
        </Card>

        <Card className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted">{t("preflight.optimizationTips")}</div>
            <div className="text-xl font-bold mono-num text-accent">{report?.optimizations ?? 0}</div>
          </div>
          <Gauge className="h-6 w-6 text-accent/60" />
        </Card>
      </div>

      {/* Sub-Tabs */}
      <Tabs.Root value={subTab} onValueChange={(v) => setSubTab(v as SubTab)}>
        <Tabs.List className="flex flex-wrap gap-1 border-b border-border pb-2">
          {[
            { id: "summary", label: t("preflight.tabSummary"), icon: Sparkles },
            { id: "matrix", label: t("preflight.tabMatrix"), icon: Layers },
            { id: "wizard", label: t("preflight.tabWizard"), icon: Compass },
            { id: "optimizer", label: t("preflight.tabOptimizer"), icon: Gauge },
            { id: "bloat", label: t("preflight.tabBloat"), icon: PackageMinus },
          ].map((tab) => {
            const Icon = tab.icon;
            return (
              <Tabs.Trigger
                key={tab.id}
                value={tab.id}
                className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1.5 text-xs font-medium text-muted hover:text-fg hover:bg-elevated data-[state=active]:border-accent/40 data-[state=active]:bg-accent/15 data-[state=active]:text-accent cursor-pointer"
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>

        <Tabs.Content value="summary" className="mt-4 space-y-3">
          {!issues.length ? (
            <Card className="flex items-center gap-2 text-xs text-success">
              <CheckCircle2 className="h-4 w-4" />
              <span>{t("preflight.allClean")}</span>
            </Card>
          ) : (
            issues.map((iss) => (
              <Card key={iss.id} className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-fg">
                      <Badge
                        tone={
                          iss.severity === "blocker"
                            ? "danger"
                            : iss.severity === "warning"
                            ? "warn"
                            : "accent"
                        }
                      >
                        {iss.severity.toUpperCase()}
                      </Badge>
                      <Badge>{iss.category}</Badge>
                      <span>{iss.title}</span>
                    </div>
                    <div className="text-xs text-fg/90">{iss.summary}</div>
                    <div className="text-[11px] text-muted">{iss.detail}</div>
                    {iss.dependency_chain && iss.dependency_chain.length > 0 && (
                      <div className="mono-num text-[11px] text-accent">
                        {t("preflight.chainLabel")}: {iss.dependency_chain.join(" → ")}
                      </div>
                    )}
                  </div>

                  {iss.auto_fix && (
                    <Button
                      size="sm"
                      variant={iss.severity === "blocker" ? "primary" : "secondary"}
                      onClick={() => void openFixPreview(iss.auto_fix!)}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {iss.auto_fix.label}
                    </Button>
                  )}
                </div>
              </Card>
            ))
          )}
        </Tabs.Content>

        <Tabs.Content value="matrix" className="mt-4">
          <CompatibilityMatrix
            target={selectedTarget}
            report={report}
            onRunCheckLayer={(layer) => void runAudit({ checkLayer: layer })}
            onPreviewFix={(fix) => void openFixPreview(fix)}
          />
        </Tabs.Content>

        <Tabs.Content value="wizard" className="mt-4">
          <ImagePlannerWizard onPlanApplied={() => void runAudit()} />
        </Tabs.Content>

        <Tabs.Content value="optimizer" className="mt-4">
          <BuildOptimizerPanel
            target={selectedTarget}
            onPreviewFix={(fix) => void openFixPreview(fix)}
          />
        </Tabs.Content>

        <Tabs.Content value="bloat" className="mt-4">
          <BloatDetectorView
            report={report}
            onRerunAudit={(licenses) => void runAudit({ licenses })}
            onPreviewFix={(fix) => void openFixPreview(fix)}
          />
        </Tabs.Content>
      </Tabs.Root>

      {/* Auto-Fix Diff Preview Confirmation Modal */}
      <Modal
        open={Boolean(previewModal)}
        onOpenChange={(v) => !v && setPreviewModal(null)}
        title={t("preflight.previewTitle")}
        subtitle={previewModal?.fix.target_file}
        wide
      >
        {previewModal && (
          <div className="space-y-3 text-xs">
            <div className="text-muted">{previewModal.message}</div>
            <pre className="max-h-72 overflow-auto rounded border border-border bg-bg p-3 mono-num text-[11px] text-accent">
              {previewModal.diff}
            </pre>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPreviewModal(null)}>
                {t("preflight.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={applying}
                onClick={() => void confirmApplyFix()}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {applying ? t("preflight.applying") : t("preflight.applyAndReaudit")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
