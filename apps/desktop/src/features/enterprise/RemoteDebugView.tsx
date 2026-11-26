import { useQuery } from "@tanstack/react-query";
import type { GdbserverSessionResult, IdeExportResult } from "@yocto-studio/shared-protocol";
import { Activity, Bug, Code2, Cpu, RefreshCw, ServerCrash, Terminal, Thermometer } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input, ProgressBar, Switch } from "@/components/ui/primitives";
import { enterpriseRpc } from "@/lib/enterpriseApi";

export function RemoteDebugView() {
  const { t } = useTranslation();
  const [recipe, setRecipe] = useState("my-sensor-daemon");
  const [targetHost, setTargetHost] = useState("192.168.10.50");
  const [gdbPort, setGdbPort] = useState("2345");
  const [remoteBin, setRemoteBin] = useState("/usr/bin/my-sensor-daemon");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [ideResult, setIdeResult] = useState<IdeExportResult | null>(null);
  const [gdbResult, setGdbResult] = useState<GdbserverSessionResult | null>(null);

  const telemetryQuery = useQuery({
    queryKey: ["enterprise-live-telemetry", targetHost, recipe],
    queryFn: () =>
      enterpriseRpc.getLiveTelemetry({
        target_host: targetHost,
        journal_unit: recipe,
      }),
    refetchInterval: autoRefresh ? 3000 : false,
  });

  const handleExportIde = async () => {
    const res = await enterpriseRpc.exportIdeConfig({
      recipe,
      binary_path: remoteBin,
      target_host: targetHost,
      gdb_port: Number(gdbPort) || 2345,
    });
    setIdeResult(res);
  };

  const handleStartGdbserver = async () => {
    const res = await enterpriseRpc.startGdbserver({
      target_host: targetHost,
      remote_binary: remoteBin,
      gdb_port: Number(gdbPort) || 2345,
    });
    setGdbResult(res);
  };

  const tel = telemetryQuery.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* IDE Config Export */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Code2 className="h-4 w-4 text-accent" />
            {t("enterprise.debug.ideTitle")}
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Input
              value={recipe}
              onChange={(e) => setRecipe(e.target.value)}
              placeholder={t("enterprise.debug.recipePlaceholder")}
            />
            <Input
              value={targetHost}
              onChange={(e) => setTargetHost(e.target.value)}
              placeholder="192.168.10.50"
            />
            <Input
              value={remoteBin}
              onChange={(e) => setRemoteBin(e.target.value)}
              placeholder="/usr/bin/app"
            />
            <Input value={gdbPort} onChange={(e) => setGdbPort(e.target.value)} placeholder="2345" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={() => void handleExportIde()}>
              {t("enterprise.debug.exportIdeBtn")}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void handleStartGdbserver()}>
              <Bug className="h-3.5 w-3.5" />
              {t("enterprise.debug.startGdbBtn")}
            </Button>
          </div>
          {gdbResult && (
            <div className="rounded border border-success/40 bg-success/10 p-2.5 text-[11px] mono-num space-y-1">
              <div className="font-semibold text-success">
                {t("enterprise.debug.gdbActive", { pid: gdbResult.pid, port: gdbResult.gdb_port })}
              </div>
              <div className="truncate">SSH: {gdbResult.ssh_command}</div>
              <div className="truncate">GDB: {gdbResult.local_gdb_command}</div>
            </div>
          )}
        </Card>

        {/* Exported VS Code JSON preview */}
        <Card className="p-4 space-y-2">
          <div className="text-xs font-semibold">.vscode/launch.json & c_cpp_properties.json</div>
          {ideResult ? (
            <div className="grid grid-cols-1 gap-2">
              <pre className="max-h-36 overflow-auto rounded bg-bg p-2 text-[10px] mono-num">
                {ideResult.launch_json}
              </pre>
              <pre className="max-h-32 overflow-auto rounded bg-bg p-2 text-[10px] mono-num">
                {ideResult.c_cpp_properties_json}
              </pre>
            </div>
          ) : (
            <div className="rounded border border-dashed border-border p-6 text-center text-xs text-muted">
              {t("enterprise.debug.ideEmptyHint")}
            </div>
          )}
        </Card>
      </div>

      {/* Live Target Monitor */}
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-success" />
            <span className="text-xs font-semibold">{t("enterprise.debug.monitorTitle")}</span>
            <Badge tone="accent" className="mono-num">
              {targetHost}
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted">{t("enterprise.debug.autoRefresh")}</span>
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
            <Button variant="secondary" size="sm" onClick={() => void telemetryQuery.refetch()}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t("enterprise.debug.refreshBtn")}
            </Button>
          </div>
        </div>

        {tel && (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4 text-xs">
              <div className="rounded border border-border bg-bg/70 p-2.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-muted">
                    <Cpu className="h-3.5 w-3.5" /> CPU
                  </span>
                  <span className="mono-num font-semibold">{tel.cpu_percent}%</span>
                </div>
                <ProgressBar value={tel.cpu_percent} />
                <div className="mono-num text-[10px] text-muted">
                  Load: {tel.load_avg.join(" / ")}
                </div>
              </div>

              <div className="rounded border border-border bg-bg/70 p-2.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-muted">RAM</span>
                  <span className="mono-num font-semibold">
                    {tel.ram_used_mb} / {tel.ram_total_mb} MB
                  </span>
                </div>
                <ProgressBar value={(tel.ram_used_mb / Math.max(1, tel.ram_total_mb)) * 100} />
                <div className="mono-num text-[10px] text-muted">
                  Swap: {tel.swap_used_mb} / {tel.swap_total_mb} MB
                </div>
              </div>

              <div className="rounded border border-border bg-bg/70 p-2.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-muted">{t("enterprise.debug.rootfsDisk")}</span>
                  <span className="mono-num font-semibold">
                    {tel.disk_used_gb} / {tel.disk_total_gb} GB
                  </span>
                </div>
                <ProgressBar value={tel.disk_percent} />
                <div className="mono-num text-[10px] text-muted">
                  {t("enterprise.debug.diskUsage", { pct: tel.disk_percent })}
                </div>
              </div>

              <div className="rounded border border-border bg-bg/70 p-2.5 space-y-1">
                <div className="flex items-center gap-1 text-muted">
                  <Thermometer className="h-3.5 w-3.5 text-warning" />
                  {t("enterprise.debug.thermalZones")}
                </div>
                {tel.thermal_zones.map((z) => (
                  <div key={z.zone} className="flex justify-between mono-num text-[11px]">
                    <span className="text-muted">{z.type}</span>
                    <span className={z.temp_c > 75 ? "text-danger" : "text-success"}>
                      {z.temp_c}°C
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded border border-border bg-bg/70 p-2.5 space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <ServerCrash className="h-3.5 w-3.5 text-danger" />
                  {t("enterprise.debug.failedUnits")}
                </div>
                {tel.failed_services.length === 0 ? (
                  <div className="text-xs text-success">{t("enterprise.debug.systemdAllHealthy")}</div>
                ) : (
                  tel.failed_services.map((s) => (
                    <div
                      key={s.unit}
                      className="flex items-center justify-between rounded bg-danger/10 px-2 py-1 text-[11px] mono-num text-danger"
                    >
                      <span>{s.unit}</span>
                      <span>{s.description}</span>
                    </div>
                  ))
                )}
              </div>

              <div className="rounded border border-border bg-bg/70 p-2.5 space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <Terminal className="h-3.5 w-3.5 text-accent" />
                  {t("enterprise.debug.journalTitle")}
                </div>
                <pre className="max-h-32 overflow-auto rounded bg-bg p-2 text-[10px] mono-num text-fg">
                  {tel.journal_lines.join("\n")}
                </pre>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
