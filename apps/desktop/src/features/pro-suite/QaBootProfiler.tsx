import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2, Clock, Download, Play, Timer } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { listQaRuns, proRpc, recordQaRun } from "@/lib/proSuiteApi";
import { useAppStore } from "@/stores/appStore";
import { useBuildStore } from "@/stores/buildStore";

export function QaBootProfiler() {
  const { t, i18n } = useTranslation();
  const activeProjectId = useAppStore((s) => s.activeProjectId) ?? "proj-wrynose-evk";
  const projects = useAppStore((s) => s.projects);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  const target = useBuildStore((s) => s.selectedBuildTarget);

  const [targetIp, setTargetIp] = useState("192.168.10.50");
  const [suiteRes, setSuiteRes] = useState<Awaited<ReturnType<typeof proRpc.runQaSuite>> | null>(null);
  const [smokeRes, setSmokeRes] = useState<Awaited<ReturnType<typeof proRpc.runHardwareSmoke>> | null>(
    null
  );

  const historyQ = useQuery({
    queryKey: ["qa-runs-history"],
    queryFn: () => listQaRuns(),
  });

  const suiteM = useMutation({
    mutationFn: (suite: "testimage" | "ptest") => proRpc.runQaSuite(suite, target),
    onSuccess: async (res) => {
      setSuiteRes(res);
      await recordQaRun({
        id: `qa-${Date.now()}`,
        project_id: activeProjectId,
        suite: res.suite,
        total: res.total,
        passed: res.passed,
        failed: res.failed,
        skipped: res.skipped,
        total_boot_ms: smokeRes?.total_boot_ms ?? 0,
        created_at: new Date().toISOString(),
      });
      void historyQ.refetch();
    },
  });

  const smokeM = useMutation({
    mutationFn: () => proRpc.runHardwareSmoke(targetIp, activeProject?.machine),
    onSuccess: async (res) => {
      setSmokeRes(res);
      await recordQaRun({
        id: `qa-smoke-${Date.now()}`,
        project_id: activeProjectId,
        suite: "hardware-smoke",
        total: res.checks.length,
        passed: res.checks.filter((c) => c.status === "PASS").length,
        failed: res.checks.filter((c) => c.status === "FAIL").length,
        skipped: 0,
        total_boot_ms: res.total_boot_ms,
        created_at: new Date().toISOString(),
      });
      void historyQ.refetch();
    },
  });

  function downloadReport(ext: "html" | "md") {
    if (!smokeRes) return;
    const content = ext === "html" ? smokeRes.html_report : smokeRes.markdown_report;
    const blob = new Blob([content], { type: ext === "html" ? "text/html" : "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `yocto-qa-boot-${smokeRes.machine}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
              <Activity className="h-4 w-4 text-accent" />
              {t("pro.qaTitle")}
            </h2>
            <p className="text-xs text-muted">
              {t("pro.qaSubtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={targetIp} onChange={(e) => setTargetIp(e.target.value)} className="w-36 mono-num" />
            <Button size="sm" onClick={() => suiteM.mutate("testimage")}>
              <Play className="h-3.5 w-3.5" />
              bitbake -c testimage
            </Button>
            <Button size="sm" onClick={() => suiteM.mutate("ptest")}>
              <Play className="h-3.5 w-3.5" />
              ptest-runner
            </Button>
            <Button size="sm" variant="primary" onClick={() => smokeM.mutate()}>
              <Timer className="h-3.5 w-3.5" />
              {t("pro.runSmokeProfile")}
            </Button>
          </div>
        </div>

        {suiteRes && (
          <div className="rounded border border-border bg-bg p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-fg">
                {t("pro.suiteLabel", { suite: suiteRes.suite })}
              </span>
              <div className="flex gap-1.5">
                <Badge tone="ok">{suiteRes.passed} PASS</Badge>
                <Badge tone={suiteRes.failed > 0 ? "danger" : "neutral"}>{suiteRes.failed} FAIL</Badge>
                <Badge>{suiteRes.skipped} SKIP</Badge>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {suiteRes.cases.map((c) => (
                <div key={c.name} className="flex items-center justify-between rounded border border-border/60 px-2 py-1 mono-num">
                  <span>{c.name}</span>
                  <Badge tone={c.status === "PASS" ? "ok" : c.status === "FAIL" ? "danger" : "neutral"}>
                    {c.status}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {smokeRes && (
          <div className="space-y-3 rounded border border-accent/35 bg-bg p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-fg flex items-center gap-2">
                <Clock className="h-4 w-4 text-accent" />
                {t("pro.bootWaterfallTotal")}{" "}
                <strong className="mono-num text-accent">{smokeRes.total_boot_ms} ms</strong>
              </span>
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => downloadReport("md")}>
                  <Download className="h-3 w-3" />
                  {t("pro.markdownReport")}
                </Button>
                <Button size="sm" variant="primary" onClick={() => downloadReport("html")}>
                  <Download className="h-3 w-3" />
                  {t("pro.htmlReport")}
                </Button>
              </div>
            </div>

            {/* Boot Waterfall */}
            <div className="space-y-1.5">
              {smokeRes.boot_stages.map((st) => {
                const leftPct = (st.start_ms / Math.max(1, smokeRes.total_boot_ms)) * 100;
                const widthPct = Math.max(4, (st.duration_ms / Math.max(1, smokeRes.total_boot_ms)) * 100);
                return (
                  <div key={st.stage} className="space-y-0.5">
                    <div className="flex justify-between text-[11px]">
                      <span className="font-medium text-fg">{st.stage}</span>
                      <span className="mono-num text-muted">
                        {st.duration_ms} ms · {st.detail}
                      </span>
                    </div>
                    <div className="relative h-3 w-full rounded bg-elevated overflow-hidden">
                      <div
                        className="absolute top-0 bottom-0 rounded bg-accent/80"
                        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 pt-2">
              <div className="space-y-1">
                <div className="text-[11px] font-semibold text-muted">{t("pro.hwSmokeChecks")}</div>
                {smokeRes.checks.map((chk) => (
                  <div key={chk.name} className="flex items-center justify-between rounded border border-border/60 px-2 py-1">
                    <span className="mono-num text-fg flex items-center gap-1.5">
                      <CheckCircle2 className="h-3 w-3 text-success" />
                      {chk.name}
                    </span>
                    <span className="mono-num text-[11px] text-muted">{chk.output}</span>
                  </div>
                ))}
              </div>
              <div className="space-y-1">
                <div className="text-[11px] font-semibold text-muted">systemd-analyze blame</div>
                {smokeRes.systemd_blame.map((b) => (
                  <div key={b.unit} className="flex justify-between rounded border border-border/60 px-2 py-1 mono-num text-[11px]">
                    <span className="text-fg">{b.unit}</span>
                    <span className="text-warning">{b.duration_ms} ms</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* SQLite QA Regression History */}
      <Card className="space-y-2">
        <div className="text-sm font-semibold text-fg">{t("pro.qaHistoryTitle")}</div>
        {!historyQ.data?.length ? (
          <div className="text-xs text-muted">{t("pro.noQaRuns")}</div>
        ) : (
          <div className="space-y-1.5 text-xs">
            {historyQ.data.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded border border-border bg-bg px-3 py-1.5">
                <span className="mono-num font-semibold text-fg">
                  {r.suite} · {new Date(r.created_at).toLocaleString(i18n.language === "en" ? "en-US" : "tr-TR")}
                </span>
                <div className="flex items-center gap-2">
                  <Badge tone="ok">{r.passed}/{r.total} PASS</Badge>
                  {r.total_boot_ms > 0 && <Badge tone="accent">{r.total_boot_ms} ms boot</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
