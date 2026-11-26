import {
  Activity,
  Building2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  FileCode2,
  FolderGit2,
  Languages,
  Layers,
  Moon,
  PackageCheck,
  PanelBottom,
  PanelLeft,
  Play,
  Search,
  ShieldCheck,
  Sliders,
  Sparkles,
  Square,
  Stethoscope,
  Sun,
  Usb,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button } from "@/components/ui/primitives";
import { setAppLanguage } from "@/i18n";
import { getPreFlightGateEnabled, getPreFlightHostProfile, preflightRpc } from "@/lib/preflightApi";
import { rpcClient } from "@/lib/rpcClient";
import { cn } from "@/lib/utils";
import { type ModuleId, useAppStore } from "@/stores/appStore";
import { useBuildStore } from "@/stores/buildStore";
import { evaluatePreFlightGate, usePreFlightStore } from "@/stores/preflightStore";

const NAV_ITEMS: Array<{ id: ModuleId; icon: typeof Activity }> = [
  { id: "environment", icon: Stethoscope },
  { id: "workspace", icon: FolderGit2 },
  { id: "layers", icon: Layers },
  { id: "config", icon: Sliders },
  { id: "recipes", icon: FileCode2 },
  { id: "build", icon: Activity },
  { id: "preflight", icon: ShieldCheck },
  { id: "artifacts", icon: PackageCheck },
  { id: "deploy", icon: Usb },
  { id: "pro", icon: Sparkles },
  { id: "enterprise", icon: Building2 },
];

export function LayoutShell({
  children,
  bottomDrawer,
}: {
  children: ReactNode;
  bottomDrawer: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language === "en" ? "en" : "tr";
  const {
    activeModule,
    setActiveModule,
    theme,
    toggleTheme,
    sidebarOpen,
    setSidebarOpen,
    drawerOpen,
    setDrawerOpen,
    setCommandPaletteOpen,
    setSnapshotModalOpen,
    connectionState,
    activeProvider,
    projects,
    activeProjectId,
    setProjects,
  } = useAppStore();

  const { snapshot, selectedBuildTarget } = useBuildStore();
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  const isBuilding = snapshot.status === "running";

  const handleProjectSwitch = async (projectId: string) => {
    await rpcClient.call("workspace.select", { project_id: projectId });
    const list = await rpcClient.call("workspace.list", {});
    setProjects(list.projects, list.active_project_id);
  };

  const handlePreFlightCheck = async () => {
    setActiveModule("preflight");
    const host = await getPreFlightHostProfile().catch(() => undefined);
    const { incompatibleLicenses, setReport, setRunningAudit } = usePreFlightStore.getState();
    setRunningAudit(true);
    try {
      const report = await preflightRpc.runAudit({
        target: selectedBuildTarget,
        incompatible_licenses: incompatibleLicenses,
        host_resources: host,
      });
      setReport(report);
    } finally {
      setRunningAudit(false);
    }
  };

  const handleQuickBuild = async () => {
    const gateOn = await getPreFlightGateEnabled().catch(() => usePreFlightStore.getState().gateEnabled);
    usePreFlightStore.getState().setGateEnabled(gateOn);
    if (gateOn) {
      const host = await getPreFlightHostProfile().catch(() => undefined);
      const { incompatibleLicenses, setReport, setBlockedBuildTarget } = usePreFlightStore.getState();
      const report = await preflightRpc.runAudit({
        target: selectedBuildTarget,
        incompatible_licenses: incompatibleLicenses,
        host_resources: host,
      });
      setReport(report);
      const gate = evaluatePreFlightGate(report, true);
      if (!gate.allowBuild) {
        setBlockedBuildTarget(selectedBuildTarget);
        setActiveModule("preflight");
        return;
      }
      setBlockedBuildTarget(null);
    }
    setActiveModule("build");
    await rpcClient.call("build.start", { target: selectedBuildTarget });
  };

  const handleCancelBuild = async () => {
    await rpcClient.call("build.cancel", {});
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-fg">
      {/* Top Status Bar */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-accent/15 border border-accent/40 text-accent">
              <Cpu className="h-3.5 w-3.5" />
            </div>
            <span className="text-xs font-bold tracking-tight">{t("app.title")}</span>
            <Badge tone="accent" className="mono-num">
              {t("app.series")}
            </Badge>
          </div>

          <div className="h-4 w-px bg-border" />

          {/* Backend Provider & Connection Badge */}
          <Badge
            tone={
              connectionState === "connected"
                ? "ok"
                : connectionState === "connecting"
                ? "warn"
                : "danger"
            }
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                connectionState === "connected"
                  ? "bg-success"
                  : connectionState === "connecting"
                  ? "bg-warning animate-pulse"
                  : "bg-danger"
              )}
            />
            {activeProvider.toUpperCase()} ·{" "}
            {connectionState === "connected"
              ? t("app.connected")
              : connectionState === "connecting"
              ? t("app.connecting")
              : t("app.disconnected")}
          </Badge>

          {/* Project Selector */}
          {activeProject && (
            <div className="flex items-center gap-1.5">
              <select
                aria-label={t("app.activeProjectAria")}
                value={activeProject.id}
                onChange={(e) => void handleProjectSwitch(e.target.value)}
                className="h-7 rounded border border-border bg-bg px-2 text-xs text-fg mono-num focus:border-accent focus:outline-none"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.yocto_codename})
                  </option>
                ))}
              </select>
              <Badge className="mono-num">{activeProject.machine}</Badge>
            </div>
          )}
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="flex h-7 items-center gap-2 rounded-md border border-border bg-bg px-2.5 text-xs text-muted hover:border-accent/60 hover:text-fg cursor-pointer"
          >
            <Search className="h-3.5 w-3.5" />
            <span>{t("app.commandPalette")}</span>
            <kbd className="mono-num rounded bg-elevated px-1 py-0.5 text-[10px] border border-border">
              Ctrl+K
            </kbd>
          </button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handlePreFlightCheck()}
            title={t("app.preflightRun")}
          >
            <ShieldCheck className="h-3.5 w-3.5 text-accent" />
            {t("app.preflightRun")}
          </Button>

          {isBuilding ? (
            <Button variant="danger" size="sm" onClick={() => void handleCancelBuild()}>
              <Square className="h-3 w-3 fill-current" />
              {t("app.stopBuild")}
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => void handleQuickBuild()}>
              <Play className="h-3 w-3 fill-current" />
              {t("app.build", { target: selectedBuildTarget })}
            </Button>
          )}

          <Button
            variant="secondary"
            size="sm"
            onClick={() => setActiveModule("deploy")}
            title={t("app.deployTarget")}
          >
            <Usb className="h-3.5 w-3.5 text-accent" />
            {t("app.deployTarget")}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSnapshotModalOpen(true)}
            title={t("app.snapshotUpdater")}
          >
            <Download className="h-3.5 w-3.5 text-accent" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAppLanguage(currentLang === "tr" ? "en" : "tr")}
            title={t("app.switchLanguage")}
            className="mono-num text-[11px] font-semibold"
          >
            <Languages className="h-3.5 w-3.5" />
            {currentLang.toUpperCase()}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title={t("app.toggleSidebar")}
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDrawerOpen(!drawerOpen)}
            title={t("app.toggleDrawer")}
          >
            <PanelBottom className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            title={t("app.toggleTheme")}
          >
            {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </header>

      {/* Main Body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Narrow Activity Bar */}
        <aside className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeModule === item.id;
            const label = t(`nav.${item.id}.label`);
            const short = t(`nav.${item.id}.short`);
            return (
              <button
                key={item.id}
                onClick={() => setActiveModule(item.id)}
                title={label}
                className={cn(
                  "relative flex w-13 flex-col items-center justify-center gap-1 rounded-md py-2 text-[10px] font-medium transition-colors cursor-pointer",
                  active
                    ? "bg-accent/15 text-accent border border-accent/35"
                    : "text-muted hover:bg-elevated hover:text-fg border border-transparent"
                )}
              >
                <Icon className="h-4 w-4" />
                <span>{short}</span>
                {item.id === "build" && isBuilding && (
                  <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent animate-ping" />
                )}
              </button>
            );
          })}
        </aside>

        {/* Collapsible Context Sidebar */}
        {sidebarOpen && (
          <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/60 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
              <span>{t("app.explorer")}</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </div>

            <div className="p-2.5 space-y-4 text-xs">
              <div>
                <div className="mb-1.5 px-1 text-[11px] font-semibold text-muted">
                  {t("app.activeProject")}
                </div>
                {activeProject ? (
                  <div className="rounded-md border border-border bg-surface p-2 space-y-1">
                    <div className="font-semibold text-fg">{activeProject.name}</div>
                    <div className="mono-num text-[11px] text-accent">
                      Yocto {activeProject.yocto_version} ({activeProject.yocto_codename})
                    </div>
                    <div className="mono-num text-[10px] text-muted truncate" title={activeProject.workspace_path}>
                      {activeProject.workspace_path}
                    </div>
                    <div className="flex gap-1 pt-1">
                      <Badge>{activeProject.setup_tool}</Badge>
                      <Badge>{activeProject.distro}</Badge>
                    </div>
                  </div>
                ) : (
                  <div className="px-1 text-muted">{t("app.loading")}</div>
                )}
              </div>

              <div>
                <div className="mb-1.5 px-1 text-[11px] font-semibold text-muted">
                  {t("app.quickTargets")}
                </div>
                <div className="space-y-0.5">
                  {["core-image-minimal", "core-image-weston", "core-image-sato"].map((img) => (
                    <button
                      key={img}
                      onClick={() => {
                        useBuildStore.getState().setSelectedBuildTarget(img);
                        setActiveModule("build");
                      }}
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left mono-num text-[11px] text-muted hover:bg-elevated hover:text-fg cursor-pointer"
                    >
                      <ChevronRight className="h-3 w-3 text-accent" />
                      {img}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1.5 px-1 text-[11px] font-semibold text-muted">
                  {t("app.statusSummary")}
                </div>
                <div className="rounded-md border border-border bg-surface p-2 space-y-1.5 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-muted">{t("app.buildState")}:</span>
                    <span className="mono-num font-medium text-fg">{snapshot.status}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">{t("app.tasks")}:</span>
                    <span className="mono-num text-fg">
                      {snapshot.completed_tasks}/{snapshot.total_tasks || 32}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">{t("app.sstateHit")}:</span>
                    <span className="mono-num text-success">{snapshot.sstate_hits}</span>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        )}

        {/* Center Workspace + Bottom Drawer */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <main className="min-h-0 flex-1 overflow-y-auto p-4">{children}</main>
          {drawerOpen && (
            <section className="h-64 shrink-0 border-t border-border bg-surface flex flex-col">
              {bottomDrawer}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
