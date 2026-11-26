import {
  Activity,
  AlertOctagon,
  Bot,
  CheckCircle2,
  Cpu,
  FileWarning,
  GitBranch,
  Play,
  Square,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Modal, ProgressBar } from "@/components/ui/primitives";
import { DagExplorer } from "@/features/build-engine/DagExplorer";
import { AiTriageDrawer } from "@/features/pro-suite/AiTriageDrawer";
import { rpcClient } from "@/lib/rpcClient";
import { formatDurationMs } from "@/lib/utils";
import { type TelemetryPoint, useBuildStore } from "@/stores/buildStore";

function Sparkline({
  points,
  accessor,
  maxVal,
  stroke,
}: {
  points: TelemetryPoint[];
  accessor: (p: TelemetryPoint) => number;
  maxVal: number;
  stroke: string;
}) {
  const width = 220;
  const height = 42;
  if (points.length < 2) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="h-10 w-full">
        <line x1="0" y1={height - 2} x2={width} y2={height - 2} stroke="currentColor" strokeOpacity={0.15} />
      </svg>
    );
  }
  const coords = points.map((p, idx) => {
    const x = (idx / Math.max(1, points.length - 1)) * width;
    const norm = Math.max(0, Math.min(1, accessor(p) / maxVal));
    const y = height - 4 - norm * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-10 w-full">
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={coords.join(" ")}
      />
    </svg>
  );
}

export function BuildEngineView() {
  const { t } = useTranslation();
  const {
    snapshot,
    telemetry,
    selectedBuildTarget,
    setSelectedBuildTarget,
    openBridgePtyTab,
  } = useBuildStore();

  const [tab, setTab] = useState<"live" | "dag">("live");
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [taskLog, setTaskLog] = useState<{
    recipe: string;
    task: string;
    log_path: string;
    run_path: string;
    log_content: string;
    run_content: string;
  } | null>(null);

  const isRunning = snapshot.status === "running";
  const pct =
    snapshot.total_tasks > 0
      ? Math.round((snapshot.completed_tasks / snapshot.total_tasks) * 100)
      : 0;
  const sstateTotal = snapshot.sstate_hits + snapshot.sstate_misses;
  const sstateRate = sstateTotal > 0 ? Math.round((snapshot.sstate_hits / sstateTotal) * 100) : 0;
  const latestTelemetry = telemetry[telemetry.length - 1];

  const handleStart = async (simulateFailure = false) => {
    setActionMsg(null);
    await rpcClient.call("build.start", {
      target: selectedBuildTarget,
      simulate_failure: simulateFailure,
    });
  };

  const handleCancel = async () => {
    await rpcClient.call("build.cancel", {});
  };

  const openFailedLog = async () => {
    if (!snapshot.failed_task) return;
    const res = await rpcClient.call("build.get_task_log", {
      build_id: snapshot.build_id ?? undefined,
      recipe: snapshot.failed_task.recipe,
      task: snapshot.failed_task.task,
    });
    setTaskLog(res);
    setLogModalOpen(true);
  };

  const runQuickTaskAction = async (
    recipe: string,
    action: "cleansstate" | "cleanall" | "compile"
  ) => {
    const res = await rpcClient.call("build.run_task_action", { recipe, action });
    setActionMsg(res.output);
  };

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-bold text-fg">{t("build.title")}</h1>
          <p className="text-xs text-muted">{t("build.subtitle")}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedBuildTarget}
            onChange={(e) => setSelectedBuildTarget(e.target.value)}
            disabled={isRunning}
            className="h-8 rounded-md border border-border bg-surface px-2.5 text-xs text-fg mono-num"
          >
            <option value="core-image-minimal">core-image-minimal</option>
            <option value="core-image-weston">core-image-weston</option>
            <option value="core-image-sato">core-image-sato</option>
          </select>

          {!isRunning ? (
            <>
              <Button variant="primary" onClick={() => void handleStart(false)}>
                <Play className="h-3.5 w-3.5 fill-current" />
                {t("build.startBuild")}
              </Button>
              <Button variant="secondary" onClick={() => void handleStart(true)}>
                <FileWarning className="h-3.5 w-3.5 text-warning" />
                {t("build.simulateFailure")}
              </Button>
            </>
          ) : (
            <Button variant="danger" onClick={() => void handleCancel()}>
              <Square className="h-3.5 w-3.5 fill-current" />
              {t("build.stopBuild")}
            </Button>
          )}
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 border-b border-border pb-2">
        <Button
          size="sm"
          variant={tab === "live" ? "primary" : "ghost"}
          onClick={() => setTab("live")}
        >
          <Activity className="h-3.5 w-3.5" />
          {t("build.tabLive")}
        </Button>
        <Button
          size="sm"
          variant={tab === "dag" ? "primary" : "ghost"}
          onClick={() => setTab("dag")}
        >
          <GitBranch className="h-3.5 w-3.5" />
          {t("build.tabDag")}
        </Button>
      </div>

      {tab === "live" ? (
        <>
          {/* Failed Task Banner */}
          {snapshot.failed_task && (
            <Card className="border-danger/50 bg-danger/10 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-0.5 text-xs">
                <div className="flex items-center gap-2 font-semibold text-danger">
                  <AlertOctagon className="h-4 w-4" />
                  {t("build.taskError", {
                    recipe: snapshot.failed_task.recipe,
                    task: snapshot.failed_task.task,
                    code: snapshot.failed_task.exit_code,
                  })}
                </div>
                <div className="mono-num text-[11px] text-fg">{snapshot.failed_task.error_summary}</div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="danger" onClick={() => void openFailedLog()}>
                  {t("build.inspectCompileLog")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={async () => {
                    await openFailedLog();
                    setLogModalOpen(false);
                    setAiDrawerOpen(true);
                  }}
                >
                  <Bot className="h-3 w-3" />
                  {t("build.aiDiagnose")}
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    void runQuickTaskAction(snapshot.failed_task!.recipe, "cleansstate")
                  }
                >
                  <Trash2 className="h-3 w-3" />
                  -c cleansstate
                </Button>
                <Button
                  size="sm"
                  onClick={() => void openBridgePtyTab("devshell", snapshot.failed_task!.recipe)}
                >
                  <Terminal className="h-3 w-3 text-accent" />
                  {t("build.openDevshell")}
                </Button>
              </div>
            </Card>
          )}

          {actionMsg && (
            <div className="rounded border border-accent/40 bg-accent/10 px-3 py-2 mono-num text-xs text-fg">
              {actionMsg}
            </div>
          )}

          {/* Top Metrics */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Card className="space-y-2 md:col-span-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-fg flex items-center gap-2">
                  {t("build.overallProgress")}
                  <Badge
                    tone={
                      snapshot.status === "running"
                        ? "accent"
                        : snapshot.status === "succeeded"
                        ? "ok"
                        : snapshot.status === "failed"
                        ? "danger"
                        : snapshot.status === "cancelled"
                        ? "warn"
                        : "neutral"
                    }
                  >
                    {snapshot.status.toUpperCase()}
                  </Badge>
                </span>
                <span className="mono-num text-muted">
                  {t("build.tasksCount", {
                    completed: snapshot.completed_tasks,
                    total: snapshot.total_tasks || 32,
                    pct,
                  })}
                </span>
              </div>
              <ProgressBar
                value={pct}
                tone={
                  snapshot.status === "failed"
                    ? "danger"
                    : snapshot.status === "succeeded"
                    ? "ok"
                    : snapshot.status === "cancelled"
                    ? "warn"
                    : "accent"
                }
              />
              <div className="flex justify-between text-[11px] text-muted mono-num">
                <span>
                  {t("build.targetLabel", {
                    target: snapshot.target ?? selectedBuildTarget,
                    machine: snapshot.machine,
                  })}
                </span>
                <span>
                  {snapshot.elapsed_ms > 0
                    ? t("build.elapsedLabel", { duration: formatDurationMs(snapshot.elapsed_ms) })
                    : t("build.ready")}
                </span>
              </div>
            </Card>

            <Card className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-success" />
                  {t("build.sstateHitRate")}
                </span>
                <Badge tone="ok" className="mono-num">
                  {sstateRate}%
                </Badge>
              </div>
              <div className="mono-num text-lg font-bold text-fg">
                {snapshot.sstate_hits} Hit / {snapshot.sstate_misses} Miss
              </div>
              <div className="text-[11px] text-muted">{t("build.sstateSub")}</div>
            </Card>

            <Card className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <Cpu className="h-3.5 w-3.5 text-accent" />
                  {t("build.cpuRamLive")}
                </span>
                <span className="mono-num text-xs font-semibold text-fg">
                  {latestTelemetry ? `${latestTelemetry.cpu_percent.toFixed(0)}%` : "—"} ·{" "}
                  {latestTelemetry ? `${latestTelemetry.ram_used_gb.toFixed(1)}G` : "—"}
                </span>
              </div>
              <Sparkline
                points={telemetry}
                accessor={(p) => p.cpu_percent}
                maxVal={100}
                stroke="#38BDF8"
              />
              <div className="flex justify-between text-[10px] mono-num text-muted">
                <span>
                  Disk R: {latestTelemetry ? `${latestTelemetry.disk_read_mb_s.toFixed(0)} MB/s` : "0"}
                </span>
                <span>
                  W: {latestTelemetry ? `${latestTelemetry.disk_write_mb_s.toFixed(0)} MB/s` : "0"}
                </span>
              </div>
            </Card>
          </div>

          {/* 4 Concurrent BitBake Worker Slots */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-fg">{t("build.workerSlotsTitle")}</h2>
              <span className="mono-num text-[11px] text-muted">
                {t("build.activeThreads", { active: snapshot.active_tasks.length })}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {[0, 1, 2, 3].map((slot) => {
                const task = snapshot.active_tasks.find((t) => t.worker_slot === slot);
                return (
                  <div
                    key={slot}
                    className="rounded-md border border-border bg-bg p-2.5 text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="mono-num text-[11px] text-muted">Worker #{slot + 1}</span>
                      {task ? (
                        <Badge tone={task.status === "cached" ? "ok" : "accent"}>
                          {task.status === "cached" ? "setscene" : `${task.progress}%`}
                        </Badge>
                      ) : (
                        <Badge>{t("build.idle")}</Badge>
                      )}
                    </div>
                    <div className="mono-num font-semibold text-fg truncate">
                      {task ? `${task.recipe} : ${task.task}` : t("build.waiting")}
                    </div>
                    <ProgressBar
                      value={task ? (task.status === "cached" ? 100 : task.progress) : 0}
                      tone={task?.status === "cached" ? "ok" : "accent"}
                      className="h-1.5"
                    />
                  </div>
                );
              })}
            </div>

            {snapshot.status === "succeeded" && (
              <div className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
                <CheckCircle2 className="h-4 w-4" />
                {t("build.buildSucceeded")}
              </div>
            )}
          </Card>
        </>
      ) : (
        <DagExplorer target={selectedBuildTarget} />
      )}

      {/* Task Error Log Modal */}
      <Modal
        open={logModalOpen}
        onOpenChange={setLogModalOpen}
        wide
        title={t("build.taskLogModalTitle", {
          recipe: taskLog?.recipe ?? "",
          task: taskLog?.task ?? "",
        })}
        subtitle={taskLog?.log_path}
      >
        {taskLog && (
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => void runQuickTaskAction(taskLog.recipe, "cleansstate")}
              >
                -c cleansstate
              </Button>
              <Button size="sm" onClick={() => void runQuickTaskAction(taskLog.recipe, "cleanall")}>
                -c cleanall
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setLogModalOpen(false);
                  void openBridgePtyTab("devshell", taskLog.recipe);
                }}
              >
                {t("build.startDevshell")}
              </Button>
            </div>
            <div>
              <div className="mb-1 font-semibold text-fg">temp/log.{taskLog.task}</div>
              <pre className="max-h-72 overflow-auto rounded border border-border bg-bg p-3 mono-num text-[11px] leading-relaxed">
                {taskLog.log_content.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.includes("error:") || line.startsWith("ERROR:")
                        ? "bg-danger/20 text-danger px-1 rounded"
                        : line.includes("note:")
                        ? "text-accent"
                        : "text-fg"
                    }
                  >
                    {line}
                  </div>
                ))}
              </pre>
            </div>
            <div>
              <div className="mb-1 font-semibold text-fg">temp/run.{taskLog.task}</div>
              <pre className="max-h-40 overflow-auto rounded border border-border bg-bg p-3 mono-num text-[11px] text-muted">
                {taskLog.run_content}
              </pre>
            </div>
          </div>
        )}
      </Modal>

      {snapshot.failed_task && (
        <AiTriageDrawer
          open={aiDrawerOpen}
          onOpenChange={setAiDrawerOpen}
          recipe={snapshot.failed_task.recipe}
          task={snapshot.failed_task.task}
          logContent={taskLog?.log_content ?? snapshot.failed_task.error_summary}
          recipeSnippet={taskLog?.run_content ?? ""}
        />
      )}
    </div>
  );
}
