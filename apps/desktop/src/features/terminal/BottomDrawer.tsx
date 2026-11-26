import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Cable,
  Plus,
  ScrollText,
  SlidersHorizontal,
  Terminal,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Input } from "@/components/ui/primitives";
import { SerialConsoleTab } from "@/features/target-deploy/SerialConsoleTab";
import { XtermPane } from "@/features/terminal/XtermPane";
import { isTauriRuntime } from "@/lib/tauriApi";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { useBuildStore } from "@/stores/buildStore";
import { useDeployStore } from "@/stores/deployStore";

export function BottomDrawer() {
  const { t } = useTranslation();
  const drawerTab = useAppStore((s) => s.drawerTab);
  const setDrawerTab = useAppStore((s) => s.setDrawerTab);
  const connectionState = useAppStore((s) => s.connectionState);

  const {
    logs,
    snapshot,
    cliFeed,
    ptyTabs,
    activePtyTabId,
    setActivePtyTab,
    openBridgePtyTab,
    openLocalPtyTab,
    closePtyTab,
    clearLogs,
  } = useBuildStore();

  const [levelFilter, setLevelFilter] = useState<"ALL" | "NOTE" | "WARNING" | "ERROR">("ALL");
  const [logSearch, setLogSearch] = useState("");
  const logParentRef = useRef<HTMLDivElement>(null);

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return logs.filter((l) => {
      if (levelFilter !== "ALL" && l.level !== levelFilter) return false;
      if (q && !l.message.toLowerCase().includes(q) && !(l.recipe ?? "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [logs, levelFilter, logSearch]);

  const rowVirtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement: () => logParentRef.current,
    estimateSize: () => 22,
    overscan: 20,
  });

  useEffect(() => {
    if (filteredLogs.length > 0 && drawerTab === "logs") {
      rowVirtualizer.scrollToIndex(filteredLogs.length - 1, { align: "end" });
    }
  }, [filteredLogs.length, drawerTab, rowVirtualizer]);

  useEffect(() => {
    if (drawerTab === "terminal" && ptyTabs.length === 0 && connectionState === "connected") {
      void openBridgePtyTab("shell");
    }
  }, [drawerTab, ptyTabs.length, connectionState, openBridgePtyTab]);

  const activeTab = ptyTabs.find((t) => t.id === activePtyTabId) ?? ptyTabs[0] ?? null;
  const serialConnected = useDeployStore((s) => s.serial.connected);
  const errorCount = logs.filter((l) => l.level === "ERROR").length + (snapshot.failed_task ? 1 : 0);

  return (
    <div className="flex h-full flex-col">
      {/* Drawer Tab Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setDrawerTab("logs")}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs cursor-pointer",
              drawerTab === "logs" ? "bg-elevated text-fg font-semibold" : "text-muted hover:text-fg"
            )}
          >
            <ScrollText className="h-3.5 w-3.5 text-accent" />
            {t("drawer.liveLogs")}
            <Badge className="mono-num">{logs.length}</Badge>
          </button>

          <button
            onClick={() => setDrawerTab("tasks")}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs cursor-pointer",
              drawerTab === "tasks" ? "bg-elevated text-fg font-semibold" : "text-muted hover:text-fg"
            )}
          >
            <AlertCircle className="h-3.5 w-3.5 text-warning" />
            {t("drawer.tasksErrors")}
            {errorCount > 0 && <Badge tone="danger">{errorCount}</Badge>}
          </button>

          <button
            onClick={() => setDrawerTab("cli")}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs cursor-pointer",
              drawerTab === "cli" ? "bg-elevated text-fg font-semibold" : "text-muted hover:text-fg"
            )}
          >
            <Terminal className="h-3.5 w-3.5 text-success" />
            {t("drawer.cliFeed")}
            <Badge className="mono-num">{cliFeed.length}</Badge>
          </button>

          <button
            onClick={() => setDrawerTab("terminal")}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs cursor-pointer",
              drawerTab === "terminal"
                ? "bg-elevated text-fg font-semibold"
                : "text-muted hover:text-fg"
            )}
          >
            <TerminalSquare className="h-3.5 w-3.5 text-accent" />
            xterm.js PTY
            {ptyTabs.length > 0 && <Badge className="mono-num">{ptyTabs.length}</Badge>}
          </button>

          <button
            onClick={() => setDrawerTab("serial")}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs cursor-pointer",
              drawerTab === "serial"
                ? "bg-elevated text-fg font-semibold"
                : "text-muted hover:text-fg"
            )}
          >
            <Cable className="h-3.5 w-3.5 text-warning" />
            UART Serial
            {serialConnected && <Badge tone="ok">{t("app.connected")}</Badge>}
          </button>
        </div>

        {drawerTab === "logs" && (
          <div className="flex items-center gap-1.5">
            <Input
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              placeholder={t("drawer.filterPlaceholder")}
              className="h-6 w-40 text-[11px]"
            />
            {(["ALL", "NOTE", "WARNING", "ERROR"] as const).map((lvl) => (
              <Button
                key={lvl}
                size="sm"
                variant={levelFilter === lvl ? "primary" : "ghost"}
                onClick={() => setLevelFilter(lvl)}
                className="h-6 px-2 text-[10px]"
              >
                {lvl}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={clearLogs} className="h-6 px-1.5" title={t("drawer.clear")}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        )}

        {drawerTab === "terminal" && (
          <div className="flex items-center gap-1">
            <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => void openBridgePtyTab("shell")}>
              <Plus className="h-3 w-3" />
              Shell
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => void openBridgePtyTab("devshell", "my-sensor-daemon")}
            >
              <Plus className="h-3 w-3" />
              devshell
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => void openBridgePtyTab("menuconfig", "virtual/kernel")}
            >
              <SlidersHorizontal className="h-3 w-3" />
              menuconfig
            </Button>
            {isTauriRuntime() && (
              <Button
                size="sm"
                variant="primary"
                className="h-6 px-2 text-[11px]"
                onClick={() => void openLocalPtyTab()}
              >
                <Plus className="h-3 w-3" />
                {t("drawer.localPty")}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Drawer Content */}
      <div className="min-h-0 flex-1 bg-bg">
        {drawerTab === "logs" && (
          <div ref={logParentRef} className="h-full overflow-auto px-3 py-1.5 mono-num text-[11px]">
            {filteredLogs.length === 0 ? (
              <div className="py-6 text-center text-muted">{t("drawer.noLogs")}</div>
            ) : (
              <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((vRow) => {
                  const line = filteredLogs[vRow.index];
                  return (
                    <div
                      key={vRow.key}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${vRow.start}px)`,
                      }}
                      className={cn(
                        "flex gap-2 whitespace-nowrap leading-[22px]",
                        line.level === "ERROR"
                          ? "text-danger font-medium"
                          : line.level === "WARNING"
                          ? "text-warning"
                          : "text-fg/90"
                      )}
                    >
                      <span className="w-14 shrink-0 text-muted">[{line.level}]</span>
                      {line.recipe && (
                        <span className="shrink-0 text-accent">
                          {line.recipe}:{line.task}
                        </span>
                      )}
                      <span className="truncate">{line.message}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {drawerTab === "tasks" && (
          <div className="h-full overflow-auto p-3 space-y-2 text-xs">
            {snapshot.failed_task && (
              <div className="rounded border border-danger/40 bg-danger/10 p-2">
                <div className="font-semibold text-danger">
                  ERROR: {snapshot.failed_task.recipe}:{snapshot.failed_task.task}
                </div>
                <div className="mono-num text-[11px] text-fg">{snapshot.failed_task.error_summary}</div>
                <div className="mono-num text-[10px] text-muted">{snapshot.failed_task.log_path}</div>
              </div>
            )}
            {snapshot.active_tasks.map((t) => (
              <div
                key={t.task_id}
                className="flex items-center justify-between rounded border border-border bg-surface px-2.5 py-1.5"
              >
                <span className="mono-num text-fg">
                  Worker #{t.worker_slot + 1} · {t.recipe}:{t.task}
                </span>
                <Badge tone="accent">{t.progress}%</Badge>
              </div>
            ))}
            {!snapshot.failed_task && snapshot.active_tasks.length === 0 && (
              <div className="py-6 text-center text-muted">{t("drawer.noTasks")}</div>
            )}
          </div>
        )}

        {drawerTab === "cli" && (
          <div className="h-full overflow-auto p-2.5 space-y-1 mono-num text-[11px]">
            {cliFeed.length === 0 ? (
              <div className="py-6 text-center text-muted">{t("drawer.noCli")}</div>
            ) : (
              cliFeed.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded border border-border/60 bg-surface px-2.5 py-1"
                >
                  <span className="text-fg truncate">$ {c.command}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-muted">{c.cwd}</span>
                    <Badge tone={c.status === "error" ? "danger" : c.status === "running" ? "accent" : "ok"}>
                      {c.provider}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {drawerTab === "terminal" && (
          <div className="flex h-full flex-col">
            {/* Multi-tab PTY Bar */}
            {ptyTabs.length > 0 && (
              <div className="flex items-center gap-1 border-b border-border bg-surface px-2 py-1 overflow-x-auto">
                {ptyTabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={cn(
                      "flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] mono-num cursor-pointer",
                      activeTab?.id === tab.id
                        ? "bg-accent/15 text-accent border border-accent/35"
                        : "text-muted hover:bg-elevated hover:text-fg border border-transparent"
                    )}
                    onClick={() => setActivePtyTab(tab.id)}
                  >
                    <span>{tab.title}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void closePtyTab(tab.id);
                      }}
                      className="hover:text-danger cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="min-h-0 flex-1">
              {activeTab ? (
                <XtermPane key={activeTab.id} tab={activeTab} />
              ) : (
                <div className="py-8 text-center text-xs text-muted">{t("drawer.startingPty")}</div>
              )}
            </div>
          </div>
        )}

        {drawerTab === "serial" && <SerialConsoleTab compact />}
      </div>
    </div>
  );
}
