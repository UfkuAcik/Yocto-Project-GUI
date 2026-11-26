import { useQuery } from "@tanstack/react-query";
import type { PathValidationResult, ProviderKind } from "@yocto-studio/shared-protocol";
import {
  AlertTriangle,
  CheckCircle2,
  Container,
  Cpu,
  HardDrive,
  Server,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input, Switch } from "@/components/ui/primitives";
import {
  deleteProviderProfile,
  ensureDockerVolumes,
  getEnvironmentHealth,
  getVhdxMaintenancePlan,
  listProviderProfiles,
  type ProviderProfile,
  type ProviderTestResult,
  saveProviderProfile,
  testProviderConnection,
  updateWslconfig,
  validateWorkspacePath,
  type VhdxMaintenancePlan,
} from "@/lib/tauriApi";
import { useAppStore } from "@/stores/appStore";

export function EnvironmentDoctorView() {
  const { t, i18n } = useTranslation();
  const setActiveProvider = useAppStore((s) => s.setActiveProvider);

  const { data: health, refetch, isFetching } = useQuery({
    queryKey: ["env-health"],
    queryFn: getEnvironmentHealth,
  });

  const profilesQuery = useQuery({
    queryKey: ["provider-profiles"],
    queryFn: listProviderProfiles,
  });

  const [motorTab, setMotorTab] = useState<"wsl2" | "docker" | "ssh">("wsl2");
  const [testPath, setTestPath] = useState("/mnt/c/Users/dev/yocto-build");
  const [testProvider, setTestProvider] = useState<ProviderKind>("wsl2");
  const [validation, setValidation] = useState<PathValidationResult | null>(null);
  const [connResult, setConnResult] = useState<ProviderTestResult | null>(null);

  // WSL2 .wslconfig & VHDX state
  const [wslMemory, setWslMemory] = useState("24GB");
  const [wslProcessors, setWslProcessors] = useState(8);
  const [wslSwap, setWslSwap] = useState("8GB");
  const [wslSavedMsg, setWslSavedMsg] = useState<{
    path: string;
    memory: string;
    processors: string | number;
  } | null>(null);
  const [vhdxPath, setVhdxPath] = useState("D:\\Yocto\\yocto-ext4.vhdx");
  const [vhdxPlan, setVhdxPlan] = useState<VhdxMaintenancePlan | null>(null);

  // Docker CROPS/kas state
  const [dockerImage, setDockerImage] = useState("crops/poky:ubuntu-24.04");
  const [dockerVolStatus, setDockerVolStatus] = useState<
    { ok: true; vols: string } | { ok: false; error: string } | null
  >(null);

  // SSH state (never stores passwords)
  const [sshName, setSshName] = useState(() => t("env.defaultSshName"));
  const [sshHost, setSshHost] = useState("build.local");
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState("yocto");
  const [sshKeyPath, setSshKeyPath] = useState("~/.ssh/id_ed25519");
  const [sshUseAgent, setSshUseAgent] = useState(true);
  const [sshWorkspaceRoot, setSshWorkspaceRoot] = useState("/home/yocto/yocto-studio");

  useEffect(() => {
    setSshName((prev) => {
      const trDefault = i18n.t("env.defaultSshName", { lng: "tr" });
      const enDefault = i18n.t("env.defaultSshName", { lng: "en" });
      return prev === trDefault || prev === enDefault ? t("env.defaultSshName") : prev;
    });
  }, [i18n, i18n.language, t]);

  useEffect(() => {
    if (health?.wsl2.wslconfig) {
      if (health.wsl2.wslconfig.memory) setWslMemory(health.wsl2.wslconfig.memory);
      if (health.wsl2.wslconfig.processors) {
        const parsed = Number.parseInt(health.wsl2.wslconfig.processors, 10);
        if (!Number.isNaN(parsed)) setWslProcessors(parsed);
      }
      if (health.wsl2.wslconfig.swap) setWslSwap(health.wsl2.wslconfig.swap);
    }
  }, [health]);

  const runPathCheck = async (pathOverride?: string) => {
    const target = pathOverride ?? testPath;
    if (pathOverride) setTestPath(pathOverride);
    const res = await validateWorkspacePath(target, testProvider);
    setValidation(res);
  };

  const handleTestWsl = async () => {
    const res = await testProviderConnection({
      id: "wsl2-probe",
      name: "WSL2",
      kind: "wsl2",
      wsl_distro: health?.wsl2.distros[0]?.name ?? null,
    });
    setConnResult(res);
  };

  const handleSaveWslConfig = async () => {
    const updated = await updateWslconfig(wslMemory, wslProcessors, wslSwap);
    setWslSavedMsg({
      path: updated.path,
      memory: updated.memory ?? wslMemory,
      processors: updated.processors ?? wslProcessors,
    });
  };

  const handleLoadVhdxPlan = async () => {
    const plan = await getVhdxMaintenancePlan(
      vhdxPath,
      "/mnt/yocto-ext4",
      200,
      "/mnt/yocto-ext4/sstate-cache"
    );
    setVhdxPlan(plan);
  };

  const handleTestDocker = async () => {
    const res = await testProviderConnection({
      id: "docker-probe",
      name: "Docker CROPS",
      kind: "docker",
      docker_image: dockerImage,
    });
    setConnResult(res);
  };

  const handleEnsureDockerVols = async () => {
    try {
      const vols = await ensureDockerVolumes();
      setDockerVolStatus({ ok: true, vols: vols.join(", ") });
    } catch (err) {
      setDockerVolStatus({ ok: false, error: String(err) });
    }
  };

  const currentSshProfile = (): ProviderProfile => ({
    id: `ssh-${sshHost}-${sshUser}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
    name: sshName,
    kind: "ssh",
    ssh_host: sshHost,
    ssh_port: sshPort,
    ssh_user: sshUser,
    ssh_key_path: sshKeyPath,
    ssh_use_agent: sshUseAgent,
    remote_workspace_root: sshWorkspaceRoot,
    is_default: false,
  });

  const handleSaveSsh = async () => {
    await saveProviderProfile(currentSshProfile());
    await profilesQuery.refetch();
  };

  const handleTestSsh = async (prof?: ProviderProfile) => {
    const res = await testProviderConnection(prof ?? currentSshProfile());
    setConnResult(res);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-fg">{t("env.title")}</h1>
          <p className="text-xs text-muted">
            {t("env.subtitlePrefix")}<code className="mono-num">ext4</code>
            {t("env.subtitleMid")}<code className="mono-num">.wslconfig</code>
            {t("env.subtitleSuffix")}
          </p>
        </div>
        <Button onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? t("env.scanning") : t("env.rescan")}
        </Button>
      </div>

      {/* Hardware Threshold Cards */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 text-accent" />
              {t("env.ramTitle")}
            </span>
            <Badge tone={health?.yocto6_ram_ok ? "ok" : "warn"}>
              {health?.yocto6_ram_ok ? t("env.yocto6Ready") : t("env.ramRecommended")}
            </Badge>
          </div>
          <div className="mono-num text-xl font-bold text-fg">
            {health ? `${health.ram_total_gb.toFixed(1)} GiB` : "—"}
          </div>
          <div className="text-[11px] text-muted">
            {health
              ? t("env.cpuCoresHost", { cores: health.cpu_cores, os: health.host_os })
              : t("env.measuring")}
          </div>
        </Card>

        <Card className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5 text-accent" />
              {t("env.diskTitle")}
            </span>
            <Badge tone={health?.yocto6_disk_ok ? "ok" : "warn"}>
              {health?.yocto6_disk_ok ? t("env.diskOk") : t("env.diskInsufficient")}
            </Badge>
          </div>
          <div className="mono-num text-xl font-bold text-fg">
            {health ? `${health.disk_free_gb.toFixed(1)} GiB` : "—"}
          </div>
          <div className="text-[11px] text-muted">
            {t("env.diskRequirement")}
          </div>
        </Card>

        <Card className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <Terminal className="h-3.5 w-3.5 text-accent" />
              {t("env.wslTitle")}
            </span>
            <Badge tone={health?.wsl2.installed ? "ok" : "accent"}>
              {health?.wsl2.installed
                ? t("env.wslActive")
                : t("env.recommendedProvider", { provider: health?.recommended_provider ?? "mock" })}
            </Badge>
          </div>
          <div className="mono-num text-xl font-bold text-fg">
            {health?.wsl2.installed
              ? t("env.distroCount", { count: health.wsl2.distros.length })
              : t("env.wslNotInstalled")}
          </div>
          <div className="text-[11px] text-muted">
            {health?.wsl2.installed
              ? t("env.wslDefaultVersion", { version: health.wsl2.default_version ?? 2 })
              : t("env.wslInstallHint")}
          </div>
        </Card>
      </div>

      {/* Phase 2: Backend Execution Provider Config & Connection Test */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">
            {t("env.enginesTitle")}
          </h2>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={motorTab === "wsl2" ? "primary" : "secondary"}
              onClick={() => setMotorTab("wsl2")}
            >
              <Terminal className="h-3.5 w-3.5" />
              WSL2 &amp; .vhdx
            </Button>
            <Button
              size="sm"
              variant={motorTab === "docker" ? "primary" : "secondary"}
              onClick={() => setMotorTab("docker")}
            >
              <Container className="h-3.5 w-3.5" />
              Docker / CROPS / kas
            </Button>
            <Button
              size="sm"
              variant={motorTab === "ssh" ? "primary" : "secondary"}
              onClick={() => setMotorTab("ssh")}
            >
              <Server className="h-3.5 w-3.5" />
              Remote SSH
            </Button>
          </div>
        </div>

        {motorTab === "wsl2" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 text-xs">
            <div className="space-y-2 rounded-md border border-border bg-bg p-3">
              <div className="font-semibold text-fg">{t("env.wslConfigTitle")}</div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-muted">memory</label>
                  <Input className="mono-num" value={wslMemory} onChange={(e) => setWslMemory(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-muted">processors</label>
                  <Input
                    type="number"
                    className="mono-num"
                    value={wslProcessors}
                    onChange={(e) => setWslProcessors(Number(e.target.value) || 4)}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-muted">swap</label>
                  <Input className="mono-num" value={wslSwap} onChange={(e) => setWslSwap(e.target.value)} />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <Button variant="primary" size="sm" onClick={() => void handleSaveWslConfig()}>
                  {t("env.updateWslConfig")}
                </Button>
                <Button size="sm" onClick={() => void handleTestWsl()}>
                  {t("env.testWslPackages")}
                </Button>
              </div>
              {wslSavedMsg && (
                <div className="mono-num text-[11px] text-success">
                  {t("env.wslUpdated", wslSavedMsg)}
                </div>
              )}
            </div>

            <div className="space-y-2 rounded-md border border-border bg-bg p-3">
              <div className="font-semibold text-fg">{t("env.vhdxTitle")}</div>
              <div className="flex gap-2">
                <Input className="mono-num" value={vhdxPath} onChange={(e) => setVhdxPath(e.target.value)} />
                <Button size="sm" onClick={() => void handleLoadVhdxPlan()}>
                  {t("env.generateCmdPlan")}
                </Button>
              </div>
              {vhdxPlan && (
                <pre className="max-h-32 overflow-auto rounded border border-border bg-surface p-2 mono-num text-[10px] text-fg">
                  {[
                    ...vhdxPlan.create_and_mount_commands,
                    t("env.vhdxCompressComment", { cmd: vhdxPlan.optimize_vhd_command }),
                    t("env.vhdxPruneComment", { cmd: vhdxPlan.prune_sstate_command }),
                  ].join("\n")}
                </pre>
              )}
            </div>
          </div>
        )}

        {motorTab === "docker" && (
          <div className="space-y-3 rounded-md border border-border bg-bg p-3 text-xs">
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-56">
                <label className="mb-1 block text-[11px] text-muted">{t("env.containerImageLabel")}</label>
                <select
                  value={dockerImage}
                  onChange={(e) => setDockerImage(e.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-surface px-2 text-xs text-fg mono-num"
                >
                  <option value="crops/poky:ubuntu-24.04">crops/poky:ubuntu-24.04 (Yocto CROPS)</option>
                  <option value="ghcr.io/siemens/kas/kas:latest">ghcr.io/siemens/kas/kas:latest (Siemens kas)</option>
                </select>
              </div>
              <Button variant="primary" size="sm" onClick={() => void handleEnsureDockerVols()}>
                {t("env.createExt4Volumes")}
              </Button>
              <Button size="sm" onClick={() => void handleTestDocker()}>
                {t("env.testDockerConn")}
              </Button>
            </div>
            <div className="mono-num text-[11px] text-muted">
              {t("env.requiredVolumes")}
            </div>
            {dockerVolStatus && (
              <div className="mono-num text-[11px] text-accent">
                {dockerVolStatus.ok
                  ? t("env.dockerPrepared", { vols: dockerVolStatus.vols })
                  : t("env.dockerError", { error: dockerVolStatus.error })}
              </div>
            )}
          </div>
        )}

        {motorTab === "ssh" && (
          <div className="space-y-3 rounded-md border border-border bg-bg p-3 text-xs">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <div>
                <label className="mb-1 block text-[11px] text-muted">{t("env.profileName")}</label>
                <Input value={sshName} onChange={(e) => setSshName(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">{t("env.hostIp")}</label>
                <Input className="mono-num" value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-muted">{t("env.port")}</label>
                  <Input
                    type="number"
                    className="mono-num"
                    value={sshPort}
                    onChange={(e) => setSshPort(Number(e.target.value) || 22)}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-muted">{t("env.username")}</label>
                  <Input className="mono-num" value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">{t("env.sshKeyLabel")}</label>
                <Input className="mono-num" value={sshKeyPath} onChange={(e) => setSshKeyPath(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">{t("env.remoteExt4Root")}</label>
                <Input
                  className="mono-num"
                  value={sshWorkspaceRoot}
                  onChange={(e) => setSshWorkspaceRoot(e.target.value)}
                />
              </div>
              <div className="flex items-end justify-between gap-2 pb-1">
                <label className="flex items-center gap-2 text-xs text-muted">
                  <Switch checked={sshUseAgent} onCheckedChange={setSshUseAgent} />
                  SSH Agent
                </label>
                <div className="flex gap-1.5">
                  <Button size="sm" onClick={() => void handleTestSsh()}>
                    {t("env.testAction")}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => void handleSaveSsh()}>
                    {t("env.save")}
                  </Button>
                </div>
              </div>
            </div>

            {profilesQuery.data && profilesQuery.data.length > 0 && (
              <div className="space-y-1.5 pt-2 border-t border-border/60">
                <div className="text-[11px] font-semibold text-muted">{t("env.savedProfiles")}</div>
                {profilesQuery.data.map((prof) => (
                  <div
                    key={prof.id}
                    className="flex items-center justify-between rounded border border-border bg-surface px-2.5 py-1.5"
                  >
                    <span className="mono-num text-fg">
                      {prof.name} ({prof.ssh_user}@{prof.ssh_host}:{prof.ssh_port ?? 22})
                    </span>
                    <div className="flex gap-1.5">
                      <Button size="sm" onClick={() => void handleTestSsh(prof)}>
                        {t("env.testShort")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => setActiveProvider(prof.kind)}
                      >
                        {t("env.select")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void deleteProviderProfile(prof.id).then(() => profilesQuery.refetch())}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-danger" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {connResult && (
          <div
            className={`rounded-md border p-2.5 text-xs space-y-1 ${
              connResult.reachable
                ? "border-success/40 bg-success/10"
                : "border-warning/40 bg-warning/10"
            }`}
          >
            <div className="flex items-center justify-between font-semibold text-fg">
              <span>
                {t("env.connectionTestTitle", {
                  provider: connResult.provider.toUpperCase(),
                  summary: connResult.summary,
                })}
              </span>
              <Badge tone={connResult.reachable ? "ok" : "warn"} className="mono-num">
                {connResult.latency_ms} ms
              </Badge>
            </div>
            {connResult.checks.map((c) => (
              <div key={c.id} className="text-[11px] text-muted">
                • {c.label}: {c.detail}{" "}
                {c.fix_command && <code className="mono-num text-accent">({c.fix_command})</code>}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Interactive /mnt/c NTFS Guard Tester */}
      <Card className="space-y-3 border-accent/30">
        <div>
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-accent" />
            {t("env.ntfsTitle")}
          </h2>
          <p className="text-xs text-muted">
            {t("env.ntfsDescPart1")}<code className="mono-num">pseudo</code>
            {t("env.ntfsDescPart2")}<code className="mono-num">/mnt/c</code>
            {t("env.ntfsDescPart3")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={testProvider}
            onChange={(e) => setTestProvider(e.target.value as ProviderKind)}
            className="h-8 rounded-md border border-border bg-bg px-2 text-xs text-fg"
          >
            <option value="wsl2">WSL2</option>
            <option value="local">Local Linux</option>
            <option value="docker">Docker</option>
          </select>
          <div className="flex-1 min-w-64">
            <Input
              value={testPath}
              onChange={(e) => setTestPath(e.target.value)}
              className="mono-num"
              placeholder="/home/yocto/yocto-studio/poky-wrynose"
            />
          </div>
          <Button variant="primary" onClick={() => void runPathCheck()}>
            {t("env.validatePath")}
          </Button>
          <Button onClick={() => void runPathCheck("/mnt/c/yocto/build")}>Test: /mnt/c</Button>
          <Button onClick={() => void runPathCheck("/home/yocto/yocto-studio/wrynose")}>
            Test: /home (ext4)
          </Button>
        </div>

        {validation && (
          <div
            className={`rounded-md border p-3 text-xs space-y-1 ${
              validation.valid
                ? "border-success/40 bg-success/10 text-fg"
                : "border-danger/40 bg-danger/10 text-fg"
            }`}
          >
            <div className="flex items-center gap-2 font-semibold">
              {validation.valid ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-danger" />
              )}
              <span>
                {validation.valid
                  ? t("env.validationPassed")
                  : t("env.validationBlocked", { code: validation.error_code ?? -32001 })}
              </span>
            </div>
            <p className="text-muted">{validation.reason}</p>
            {validation.recommendation && (
              <div className="mono-num text-[11px] text-accent">
                {t("env.recommendedPath", { path: validation.recommendation })}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Detailed Health Checks */}
      <Card className="space-y-2">
        <h2 className="text-sm font-semibold text-fg">{t("env.healthChecksTitle")}</h2>
        <div className="divide-y divide-border/60">
          {health?.checks.map((chk) => (
            <div key={chk.id} className="flex items-start justify-between gap-4 py-2.5 text-xs">
              <div className="space-y-0.5">
                <div className="font-medium text-fg flex items-center gap-2">
                  {chk.status === "ok" ? (
                    <ShieldCheck className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                  )}
                  {chk.label}
                </div>
                <div className="text-muted">{chk.detail}</div>
                {chk.fix_command && (
                  <code className="inline-block mt-1 rounded bg-bg px-2 py-0.5 mono-num text-[11px] text-accent border border-border">
                    {chk.fix_command}
                  </code>
                )}
              </div>
              <Badge tone={chk.status === "ok" ? "ok" : chk.status === "warn" ? "warn" : "danger"}>
                {chk.status.toUpperCase()}
              </Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
