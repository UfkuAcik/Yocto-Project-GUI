import * as Tabs from "@radix-ui/react-tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WksFile, WksPartition } from "@yocto-studio/shared-protocol";
import {
  Copy,
  Cpu,
  Download,
  FileArchive,
  HardDrive,
  History,
  Lock,
  PackageCheck,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  Usb,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { rpcClient } from "@/lib/rpcClient";
import {
  buildFlashPlan,
  copyArtifactToHost,
  listBuildRuns,
  listRemovableDrives,
  type CopyArtifactResult,
  type FlashPlan,
} from "@/lib/tauriApi";
import { formatBytes } from "@/lib/utils";
import { useBuildStore } from "@/stores/buildStore";
import { useDeployStore } from "@/stores/deployStore";

type SubTab = "deploy" | "wks" | "qemu" | "sdk" | "security" | "history";

export function ArtifactsView() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const attachBridgePtyTab = useBuildStore((s) => s.attachBridgePtyTab);
  const handoffImageToDeploy = useDeployStore((s) => s.handoffImageToDeploy);
  const [activeTab, setActiveTab] = useState<SubTab>("deploy");

  // Shared Deploy & Flash State
  const [selectedImagePath, setSelectedImagePath] = useState<string>("");
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [hostDestDir, setHostDestDir] = useState<string>("");
  const [copyOutcome, setCopyOutcome] = useState<CopyArtifactResult | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [flashPlan, setFlashPlan] = useState<FlashPlan | null>(null);
  const [flashError, setFlashError] = useState<string | null>(null);

  // WIC / .wks State
  const [selectedWksPath, setSelectedWksPath] = useState<string>("");
  const [wksDraft, setWksDraft] = useState<WksFile | null>(null);
  const [wicTargetImage, setWicTargetImage] = useState<string>("core-image-minimal");
  const [wicLog, setWicLog] = useState<string>("");

  // QEMU State
  const [qemuMachine, setQemuMachine] = useState<string>("imx8mp-lpddr4-evk");
  const [qemuImage, setQemuImage] = useState<string>("core-image-minimal");
  const [qemuMode, setQemuMode] = useState<"nographic" | "slirp" | "vnc">("nographic");
  const [qemuMemoryMb, setQemuMemoryMb] = useState<number>(1024);
  const [qemuExtraArgs, setQemuExtraArgs] = useState<string>("-smp 4");
  const [activeQemuSession, setActiveQemuSession] = useState<{
    session_id: string;
    command: string;
    ssh_forward?: string;
    mode: string;
  } | null>(null);

  // SDK State
  const [sdkTarget, setSdkTarget] = useState<string>("core-image-minimal");
  const [sdkLog, setSdkLog] = useState<string>("");

  // CVE & License Export State
  const [cveFormat, setCveFormat] = useState<"sbom-cve-check" | "cve-check">("sbom-cve-check");
  const [cveSeverityFilter, setCveSeverityFilter] = useState<string>("ALL");
  const [licenseExportPreview, setLicenseExportPreview] = useState<{
    filename: string;
    content: string;
  } | null>(null);

  // buildhistory State
  const [customDiffText, setCustomDiffText] = useState<string>("");

  // Queries
  const imagesQ = useQuery({
    queryKey: ["artifacts-images"],
    queryFn: () => rpcClient.call("artifacts.list_images", {}),
  });

  const drivesQ = useQuery({
    queryKey: ["removable-drives"],
    queryFn: () => listRemovableDrives(true),
  });

  const wksListQ = useQuery({
    queryKey: ["wic-list"],
    queryFn: () => rpcClient.call("wic.list_wks", {}),
  });

  const sdkListQ = useQuery({
    queryKey: ["sdk-list"],
    queryFn: () => rpcClient.call("sdk.list", {}),
  });

  const sbomQ = useQuery({
    queryKey: ["artifacts-sbom"],
    queryFn: () => rpcClient.call("artifacts.get_sbom", {}),
  });

  const cvesQ = useQuery({
    queryKey: ["artifacts-cves", cveFormat],
    queryFn: () => rpcClient.call("artifacts.get_cves", { format: cveFormat }),
  });

  const historyQ = useQuery({
    queryKey: ["artifacts-history", customDiffText],
    queryFn: () =>
      rpcClient.call(
        "artifacts.get_buildhistory_diff",
        customDiffText.trim() ? { diff_text: customDiffText } : {}
      ),
  });

  const sqliteRunsQ = useQuery({
    queryKey: ["sqlite-build-runs"],
    queryFn: () => listBuildRuns(),
  });

  // Sync defaults once loaded
  useEffect(() => {
    if (!selectedImagePath && imagesQ.data?.images.length) {
      const wicImg = imagesQ.data.images.find((i) => i.kind === "wic") ?? imagesQ.data.images[0];
      setSelectedImagePath(wicImg.path);
    }
    if (imagesQ.data?.machine) {
      setQemuMachine(imagesQ.data.machine);
    }
  }, [imagesQ.data, selectedImagePath]);

  useEffect(() => {
    if (!selectedDevice && drivesQ.data?.length) {
      const safe = drivesQ.data.find((d) => d.removable && !d.is_system_disk) ?? drivesQ.data[0];
      setSelectedDevice(safe.device_path);
    }
  }, [drivesQ.data, selectedDevice]);

  useEffect(() => {
    if (!selectedWksPath && wksListQ.data?.files.length) {
      setSelectedWksPath(wksListQ.data.files[0].path);
    }
  }, [wksListQ.data, selectedWksPath]);

  useEffect(() => {
    if (!selectedWksPath) return;
    void rpcClient
      .call("wic.parse_wks", { path: selectedWksPath })
      .then((res) => setWksDraft(res))
      .catch(() => {});
  }, [selectedWksPath]);

  // Mutations
  const serializeWksM = useMutation({
    mutationFn: async (save: boolean) => {
      if (!wksDraft) throw new Error(t("artifacts.wksNotLoaded"));
      return rpcClient.call("wic.serialize_wks", {
        wks: wksDraft,
        save_path: save ? selectedWksPath : undefined,
      });
    },
    onSuccess: (res) => {
      if (wksDraft) {
        setWksDraft({ ...wksDraft, raw_text: res.raw_text });
      }
      setWicLog(
        res.saved
          ? t("artifacts.wksSaved", { path: res.path })
          : t("artifacts.wksPreviewUpdated")
      );
    },
  });

  const createWicM = useMutation({
    mutationFn: async () => {
      if (!wksDraft) throw new Error(t("artifacts.loadWksFirst"));
      const serialized = await rpcClient.call("wic.serialize_wks", {
        wks: wksDraft,
        save_path: selectedWksPath || undefined,
      });
      return rpcClient.call("wic.create_image", {
        wks_path: selectedWksPath || "custom.wks",
        image_name: wicTargetImage,
        wks_content: serialized.raw_text,
      });
    },
    onSuccess: (res) => {
      setWicLog(res.log);
      void qc.invalidateQueries({ queryKey: ["artifacts-images"] });
    },
  });

  const qemuLaunchM = useMutation({
    mutationFn: () =>
      rpcClient.call("qemu.launch", {
        machine: qemuMachine,
        image: qemuImage,
        mode: qemuMode,
        memory_mb: qemuMemoryMb,
        extra_args: qemuExtraArgs,
      }),
    onSuccess: (res) => {
      setActiveQemuSession({
        session_id: res.session_id,
        command: res.command,
        ssh_forward: res.ssh_forward,
        mode: res.mode,
      });
      if (res.pty_session_id) {
        attachBridgePtyTab(res.pty_session_id, `qemu:${qemuMachine}`, "runqemu");
      }
    },
  });

  const qemuStopM = useMutation({
    mutationFn: async () => {
      if (!activeQemuSession) return { ok: true, session_id: "" };
      return rpcClient.call("qemu.stop", { session_id: activeQemuSession.session_id });
    },
    onSuccess: () => setActiveQemuSession(null),
  });

  const sdkBuildM = useMutation({
    mutationFn: (kind: "standard-sdk" | "esdk") =>
      rpcClient.call("sdk.build", { target: sdkTarget, kind }),
    onSuccess: (res) => {
      setSdkLog(res.log);
      void qc.invalidateQueries({ queryKey: ["sdk-list"] });
    },
  });

  const licenseExportM = useMutation({
    mutationFn: (format: "csv" | "json" | "markdown") =>
      rpcClient.call("artifacts.export_licenses", { format }),
    onSuccess: (res) => {
      setLicenseExportPreview({ filename: res.filename, content: res.content });
    },
  });

  async function handleCopyToHost(path: string) {
    setCopyError(null);
    setCopyOutcome(null);
    try {
      const res = await copyArtifactToHost(path, hostDestDir || undefined);
      setCopyOutcome(res);
    } catch {
      try {
        const fallback = await rpcClient.call("artifacts.copy_to_host", {
          source_path: path,
          dest_dir: hostDestDir || undefined,
        });
        setCopyOutcome({
          ok: fallback.ok,
          source_path: fallback.source_path,
          dest_path: fallback.dest_path,
          bytes_copied: fallback.bytes_copied,
        });
      } catch (err) {
        setCopyError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function handleBuildFlashPlan(overrideTarget?: string) {
    setFlashError(null);
    setFlashPlan(null);
    try {
      const plan = await buildFlashPlan(
        selectedImagePath || "core-image-minimal.wic.bz2",
        overrideTarget ?? selectedDevice
      );
      setFlashPlan(plan);
    } catch (err) {
      setFlashError(err instanceof Error ? err.message : String(err));
    }
  }

  function updatePartition(idx: number, patch: Partial<WksPartition>) {
    if (!wksDraft) return;
    const nextParts = wksDraft.partitions.map((p, i) => (i === idx ? { ...p, ...patch } : p));
    setWksDraft({ ...wksDraft, partitions: nextParts });
  }

  function addPartition() {
    if (!wksDraft) return;
    const next: WksPartition = {
      id: `part-${wksDraft.partitions.length + 1}`,
      name: `appfs${wksDraft.partitions.length}`,
      mountpoint: `/opt/app${wksDraft.partitions.length}`,
      fstype: "ext4",
      source: null,
      size_mb: 256,
      ondisk: wksDraft.partitions[0]?.ondisk ?? "mmcblk2",
      align_kb: 4096,
      active: false,
      no_table: false,
    };
    setWksDraft({ ...wksDraft, partitions: [...wksDraft.partitions, next] });
  }

  function removePartition(idx: number) {
    if (!wksDraft) return;
    setWksDraft({
      ...wksDraft,
      partitions: wksDraft.partitions.filter((_, i) => i !== idx),
    });
  }

  function downloadPreview() {
    if (!licenseExportPreview) return;
    const blob = new Blob([licenseExportPreview.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = licenseExportPreview.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalWksMb = (wksDraft?.partitions ?? []).reduce(
    (sum, p) => sum + (p.fixed_size_mb ?? p.size_mb ?? 16),
    0
  );

  const filteredCves = (cvesQ.data?.findings ?? []).filter(
    (f) => cveSeverityFilter === "ALL" || f.severity === cveSeverityFilter
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-fg">
            {t("artifacts.title")}
          </h1>
          <p className="text-xs text-muted">
            {t("artifacts.targetPrefix")}{" "}
            <code className="mono-num">{imagesQ.data?.machine ?? "imx8mp-lpddr4-evk"}</code>{" "}
            · <code className="mono-num">{imagesQ.data?.deploy_dir ?? "tmp/deploy/images"}</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="accent">
            {t("artifacts.imagesBadge", { count: imagesQ.data?.images.length ?? 0 })}
          </Badge>
          <Badge tone={cvesQ.data?.summary?.unpatched ? "danger" : "ok"}>
            {t("artifacts.openCveBadge", { count: cvesQ.data?.summary?.unpatched ?? 0 })}
          </Badge>
          <Badge tone="neutral">
            {t("artifacts.sdkBadge", { count: sdkListQ.data?.sdks.length ?? 0 })}
          </Badge>
        </div>
      </div>

      <Tabs.Root value={activeTab} onValueChange={(v) => setActiveTab(v as SubTab)}>
        <Tabs.List className="flex flex-wrap gap-1 border-b border-border pb-2">
          {[
            { id: "deploy", label: t("artifacts.tabDeploy"), icon: Usb },
            { id: "wks", label: t("artifacts.tabWks"), icon: HardDrive },
            { id: "qemu", label: t("artifacts.tabQemu"), icon: Cpu },
            { id: "sdk", label: t("artifacts.tabSdk"), icon: PackageCheck },
            { id: "security", label: t("artifacts.tabSecurity"), icon: ShieldAlert },
            { id: "history", label: t("artifacts.tabHistory"), icon: History },
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

        {/* TAB 1: Deploy & Host Copy + SD/USB Flash */}
        <Tabs.Content value="deploy" className="mt-4 space-y-4">
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
                <FileArchive className="h-4 w-4 text-accent" />
                {t("artifacts.deployImagesTitle", { machine: imagesQ.data?.machine ?? "—" })}
              </h2>
              <div className="flex items-center gap-2">
                <Input
                  value={hostDestDir}
                  onChange={(e) => setHostDestDir(e.target.value)}
                  placeholder={t("artifacts.hostDestPlaceholder")}
                  className="w-72"
                />
                <Button
                  size="sm"
                  onClick={() => void qc.invalidateQueries({ queryKey: ["artifacts-images"] })}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("artifacts.refresh")}
                </Button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-[11px] text-muted">
                    <th className="py-2 pr-3">{t("artifacts.colFilename")}</th>
                    <th className="py-2 pr-3">{t("artifacts.colType")}</th>
                    <th className="py-2 pr-3">{t("artifacts.colSize")}</th>
                    <th className="py-2 pr-3">SHA-256</th>
                    <th className="py-2 text-right">{t("artifacts.colAction")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {imagesQ.data?.images.map((img) => (
                    <tr key={img.filename}>
                      <td className="py-2 pr-3 mono-num font-medium text-fg">{img.filename}</td>
                      <td className="py-2 pr-3">
                        <Badge>{img.kind}</Badge>
                      </td>
                      <td className="py-2 pr-3 mono-num">{formatBytes(img.size_bytes)}</td>
                      <td className="py-2 pr-3 mono-num text-muted">{img.sha256_short || "—"}</td>
                      <td className="py-2 text-right space-x-1.5">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() =>
                            handoffImageToDeploy({
                              filename: img.filename,
                              path: img.path,
                              kind: img.kind,
                              size_bytes: img.size_bytes,
                              sha256_short: img.sha256_short,
                              machine: imagesQ.data?.machine,
                            })
                          }
                        >
                          <Usb className="h-3 w-3" />
                          {t("artifacts.flashToTarget")}
                        </Button>
                        <Button size="sm" onClick={() => void handleCopyToHost(img.path)}>
                          <Copy className="h-3 w-3" />
                          {t("artifacts.copyToHost")}
                        </Button>
                        {img.kind === "wic" && (
                          <Button
                            size="sm"
                            onClick={() => {
                              setSelectedImagePath(img.path);
                              void handleBuildFlashPlan();
                            }}
                          >
                            <Usb className="h-3 w-3" />
                            {t("artifacts.flashPlan")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {copyOutcome && (
              <div className="rounded border border-success/40 bg-success/10 p-2.5 text-xs text-success mono-num">
                {t("artifacts.copiedSuccess", {
                  dest: copyOutcome.dest_path,
                  size: formatBytes(copyOutcome.bytes_copied),
                })}
              </div>
            )}
            {copyError && (
              <div className="rounded border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger">
                {copyError}
              </div>
            )}
          </Card>

          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
                  <Usb className="h-4 w-4 text-accent" />
                  {t("artifacts.sdWizardTitle")}
                </h2>
                <p className="text-xs text-muted">
                  {t("artifacts.sdWizardSubtitle")}
                </p>
              </div>
              <Button size="sm" onClick={() => void drivesQ.refetch()}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t("artifacts.scanDrives")}
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {drivesQ.data?.map((drv) => {
                const locked = drv.is_system_disk || !drv.removable;
                const active = selectedDevice === drv.device_path;
                return (
                  <button
                    key={drv.id}
                    type="button"
                    onClick={() => setSelectedDevice(drv.device_path)}
                    className={`flex items-center justify-between rounded-md border p-2.5 text-left text-xs transition-colors cursor-pointer ${
                      active
                        ? "border-accent bg-accent/10"
                        : "border-border bg-bg hover:bg-elevated"
                    }`}
                  >
                    <div>
                      <div className="font-semibold text-fg flex items-center gap-1.5">
                        {locked && <Lock className="h-3.5 w-3.5 text-danger" />}
                        {drv.name}
                      </div>
                      <div className="mono-num text-[11px] text-muted">
                        {drv.device_path} · {drv.size_human} · {drv.bus_type}
                      </div>
                    </div>
                    <Badge tone={locked ? "danger" : "ok"}>
                      {locked ? t("artifacts.systemDiskLocked") : t("artifacts.removable")}
                    </Badge>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void handleBuildFlashPlan()}>
                {t("artifacts.buildFlashPlanBtn")}
              </Button>
              <Button
                variant="danger"
                onClick={() => void handleBuildFlashPlan("\\\\.\\PHYSICALDRIVE0")}
              >
                <Lock className="h-3.5 w-3.5" />
                {t("artifacts.testOsDiskLock")}
              </Button>
            </div>

            {flashError && (
              <div className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
                {flashError}
              </div>
            )}

            {flashPlan && (
              <div className="rounded border border-accent/40 bg-bg p-3 text-xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-fg">
                    {t("artifacts.flashPlanTarget")}{" "}
                    <code className="mono-num">{flashPlan.target_device}</code> ·{" "}
                    {t("artifacts.flashPlanMethod")}{" "}
                    <Badge tone="accent">{flashPlan.method}</Badge>
                  </span>
                </div>
                <pre className="rounded bg-elevated p-2 mono-num text-[11px] text-accent overflow-x-auto">
                  {flashPlan.command}
                </pre>
                <ul className="list-disc pl-4 text-muted space-y-0.5">
                  {flashPlan.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </Tabs.Content>

        {/* TAB 2: .wks Visual Partition Editor & WIC Builder */}
        <Tabs.Content value="wks" className="mt-4 space-y-4">
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <select
                  value={selectedWksPath}
                  onChange={(e) => setSelectedWksPath(e.target.value)}
                  className="h-8 rounded-md border border-border bg-bg px-2.5 text-xs text-fg"
                >
                  {wksListQ.data?.files.map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.layer} / {f.name}
                    </option>
                  ))}
                </select>
                <Input
                  value={wicTargetImage}
                  onChange={(e) => setWicTargetImage(e.target.value)}
                  placeholder={t("artifacts.targetImagePlaceholder")}
                  className="w-48"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={addPartition}>
                  <Plus className="h-3.5 w-3.5" />
                  {t("artifacts.addPartition")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => serializeWksM.mutate(true)}
                  disabled={serializeWksM.isPending || !wksDraft}
                >
                  <Save className="h-3.5 w-3.5" />
                  {t("artifacts.saveWks")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => createWicM.mutate()}
                  disabled={createWicM.isPending || !wksDraft}
                >
                  <HardDrive className="h-3.5 w-3.5" />
                  {createWicM.isPending ? t("artifacts.buildingWic") : t("artifacts.runWicCreate")}
                </Button>
              </div>
            </div>

            {/* Proportional Disk Layout Bar */}
            {wksDraft && wksDraft.partitions.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] text-muted flex justify-between">
                  <span>{t("artifacts.partitionMap", { ptable: wksDraft.bootloader.ptable ?? "gpt" })}</span>
                  <span className="mono-num">{t("artifacts.totalMb", { mb: totalWksMb })}</span>
                </div>
                <div className="flex h-8 w-full overflow-hidden rounded-md border border-border bg-bg">
                  {wksDraft.partitions.map((p, idx) => {
                    const mb = p.fixed_size_mb ?? p.size_mb ?? 32;
                    const pct = Math.max(8, (mb / Math.max(totalWksMb, 1)) * 100);
                    const palette = [
                      "bg-amber-500/25 border-amber-400/50 text-amber-200",
                      "bg-sky-500/25 border-sky-400/50 text-sky-200",
                      "bg-emerald-500/25 border-emerald-400/50 text-emerald-200",
                      "bg-violet-500/25 border-violet-400/50 text-violet-200",
                    ];
                    return (
                      <div
                        key={p.id + idx}
                        style={{ width: `${pct}%` }}
                        className={`flex items-center justify-center border-r px-2 text-[11px] mono-num truncate ${
                          palette[idx % palette.length]
                        }`}
                        title={`${p.name} (${p.mountpoint ?? "raw"}) — ${mb}M ${p.fstype ?? ""}`}
                      >
                        {p.name} ({mb}M)
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Interactive Partition Table */}
            {wksDraft && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-[11px] text-muted">
                      <th className="py-2 pr-2">{t("artifacts.colLabel")}</th>
                      <th className="py-2 pr-2">{t("artifacts.colMountpoint")}</th>
                      <th className="py-2 pr-2">{t("artifacts.colFilesystem")}</th>
                      <th className="py-2 pr-2">{t("artifacts.colSource")}</th>
                      <th className="py-2 pr-2">{t("artifacts.colSizeMb")}</th>
                      <th className="py-2 pr-2">{t("artifacts.colBootActive")}</th>
                      <th className="py-2 text-right">{t("artifacts.colDelete")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {wksDraft.partitions.map((p, idx) => (
                      <tr key={p.id + idx}>
                        <td className="py-1.5 pr-2">
                          <Input
                            value={p.name}
                            onChange={(e) => updatePartition(idx, { name: e.target.value })}
                            className="w-28"
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input
                            value={p.mountpoint ?? ""}
                            onChange={(e) =>
                              updatePartition(idx, { mountpoint: e.target.value || null })
                            }
                            placeholder="raw"
                            className="w-24"
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <select
                            value={p.fstype ?? ""}
                            onChange={(e) =>
                              updatePartition(idx, { fstype: e.target.value || null })
                            }
                            className="h-8 rounded-md border border-border bg-bg px-2 text-xs text-fg"
                          >
                            <option value="">raw</option>
                            <option value="vfat">vfat</option>
                            <option value="ext4">ext4</option>
                            <option value="btrfs">btrfs</option>
                            <option value="squashfs">squashfs</option>
                          </select>
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input
                            value={p.source ?? ""}
                            onChange={(e) =>
                              updatePartition(idx, { source: e.target.value || null })
                            }
                            className="w-36"
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input
                            type="number"
                            min={1}
                            value={p.fixed_size_mb ?? p.size_mb ?? 32}
                            onChange={(e) =>
                              updatePartition(idx, {
                                size_mb: Number(e.target.value) || 32,
                                fixed_size_mb: p.fixed_size_mb
                                  ? Number(e.target.value) || 32
                                  : undefined,
                              })
                            }
                            className="w-24 mono-num"
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input
                            type="checkbox"
                            checked={Boolean(p.active)}
                            onChange={(e) => updatePartition(idx, { active: e.target.checked })}
                            className="h-4 w-4 accent-accent cursor-pointer"
                          />
                        </td>
                        <td className="py-1.5 text-right">
                          <Button size="sm" variant="ghost" onClick={() => removePartition(idx)}>
                            <Trash2 className="h-3.5 w-3.5 text-danger" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {wksDraft && (
              <pre className="rounded border border-border bg-bg p-3 text-[11px] mono-num text-muted overflow-x-auto">
                {wksDraft.raw_text}
              </pre>
            )}
            {wicLog && (
              <pre className="rounded border border-success/40 bg-success/10 p-3 text-[11px] mono-num text-fg whitespace-pre-wrap">
                {wicLog}
              </pre>
            )}
          </Card>
        </Tabs.Content>

        {/* TAB 3: QEMU Launcher & Live Serial Console */}
        <Tabs.Content value="qemu" className="mt-4 space-y-4">
          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-accent" />
                  {t("artifacts.qemuTitle")}
                </h2>
                <p className="text-xs text-muted">
                  {t("artifacts.qemuSubtitle")}
                </p>
              </div>
              {activeQemuSession && (
                <Badge tone="ok">{t("artifacts.qemuRunning", { mode: activeQemuSession.mode })}</Badge>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                <label className="text-[11px] text-muted">{t("artifacts.qemuMachine")}</label>
                <Input value={qemuMachine} onChange={(e) => setQemuMachine(e.target.value)} />
              </div>
              <div>
                <label className="text-[11px] text-muted">{t("artifacts.qemuImage")}</label>
                <Input value={qemuImage} onChange={(e) => setQemuImage(e.target.value)} />
              </div>
              <div>
                <label className="text-[11px] text-muted">{t("artifacts.qemuMode")}</label>
                <select
                  value={qemuMode}
                  onChange={(e) =>
                    setQemuMode(e.target.value as "nographic" | "slirp" | "vnc")
                  }
                  className="h-8 w-full rounded-md border border-border bg-bg px-2.5 text-xs text-fg"
                >
                  <option value="nographic">{t("artifacts.modeNographic")}</option>
                  <option value="slirp">{t("artifacts.modeSlirp")}</option>
                  <option value="vnc">{t("artifacts.modeVnc")}</option>
                </select>
              </div>
              <div>
                <label className="text-[11px] text-muted">RAM (MiB)</label>
                <Input
                  type="number"
                  value={qemuMemoryMb}
                  onChange={(e) => setQemuMemoryMb(Number(e.target.value) || 1024)}
                />
              </div>
            </div>

            <div>
              <label className="text-[11px] text-muted">{t("artifacts.qemuExtraArgs")}</label>
              <Input
                value={qemuExtraArgs}
                onChange={(e) => setQemuExtraArgs(e.target.value)}
                placeholder="-smp 4 -device virtio-rng-pci"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                onClick={() => qemuLaunchM.mutate()}
                disabled={qemuLaunchM.isPending}
              >
                <Play className="h-3.5 w-3.5" />
                {t("artifacts.startQemu")}
              </Button>
              {activeQemuSession && (
                <Button variant="danger" onClick={() => qemuStopM.mutate()}>
                  <Square className="h-3.5 w-3.5" />
                  {t("artifacts.stopQemu")}
                </Button>
              )}
            </div>

            {activeQemuSession && (
              <div className="rounded border border-accent/40 bg-bg p-3 text-xs space-y-1.5">
                <div className="flex items-center gap-2 text-fg font-semibold">
                  <Terminal className="h-3.5 w-3.5 text-accent" />
                  {t("artifacts.commandLabel")}{" "}
                  <code className="mono-num text-accent">{activeQemuSession.command}</code>
                </div>
                {activeQemuSession.ssh_forward && (
                  <div className="text-muted mono-num">
                    {t("artifacts.sshForwardLabel", { endpoint: activeQemuSession.ssh_forward })}
                  </div>
                )}
              </div>
            )}
          </Card>
        </Tabs.Content>

        {/* TAB 4: SDK & eSDK Generator */}
        <Tabs.Content value="sdk" className="mt-4 space-y-4">
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
                  <PackageCheck className="h-4 w-4 text-accent" />
                  {t("artifacts.sdkTitle")}
                </h2>
                <p className="text-xs text-muted">
                  {t("artifacts.sdkSubtitle")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={sdkTarget}
                  onChange={(e) => setSdkTarget(e.target.value)}
                  className="w-48"
                />
                <Button
                  size="sm"
                  onClick={() => sdkBuildM.mutate("standard-sdk")}
                  disabled={sdkBuildM.isPending}
                >
                  {t("artifacts.buildStdSdk")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => sdkBuildM.mutate("esdk")}
                  disabled={sdkBuildM.isPending}
                >
                  {t("artifacts.buildEsdk")}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              {sdkListQ.data?.sdks.map((sdk) => (
                <div
                  key={sdk.filename}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-bg p-3 text-xs"
                >
                  <div>
                    <div className="font-semibold mono-num text-fg flex items-center gap-2">
                      {sdk.filename}
                      <Badge tone={sdk.kind === "esdk" ? "accent" : "neutral"}>{sdk.kind}</Badge>
                    </div>
                    <div className="text-[11px] text-muted mono-num mt-0.5">
                      {sdk.path} · {formatBytes(sdk.size_bytes)} · Sysroot: {sdk.sysroot_arch}
                    </div>
                  </div>
                  <code className="rounded bg-elevated px-2 py-1 mono-num text-[11px] text-accent">
                    sh {sdk.filename} -d ~/yocto-sdk
                  </code>
                </div>
              ))}
            </div>

            {sdkLog && (
              <pre className="rounded border border-success/40 bg-success/10 p-3 text-[11px] mono-num text-fg whitespace-pre-wrap">
                {sdkLog}
              </pre>
            )}
          </Card>
        </Tabs.Content>

        {/* TAB 5: SPDX 3.0 / CVE & License Matrix */}
        <Tabs.Content value="security" className="mt-4 space-y-4">
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-warning" />
                <h2 className="text-sm font-semibold text-fg">
                  {t("artifacts.cveTitle", { tool: cvesQ.data?.tool ?? cveFormat })}
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={cveFormat}
                  onChange={(e) =>
                    setCveFormat(e.target.value as "sbom-cve-check" | "cve-check")
                  }
                  className="h-8 rounded-md border border-border bg-bg px-2.5 text-xs text-fg"
                >
                  <option value="sbom-cve-check">Yocto 6.0 Wrynose (sbom-cve-check)</option>
                  <option value="cve-check">Yocto 5.0 Scarthgap (cve-check JSON)</option>
                </select>
                <select
                  value={cveSeverityFilter}
                  onChange={(e) => setCveSeverityFilter(e.target.value)}
                  className="h-8 rounded-md border border-border bg-bg px-2.5 text-xs text-fg"
                >
                  <option value="ALL">{t("artifacts.allSeverities")}</option>
                  <option value="CRITICAL">CRITICAL</option>
                  <option value="HIGH">HIGH</option>
                  <option value="MEDIUM">MEDIUM</option>
                  <option value="LOW">LOW</option>
                </select>
              </div>
            </div>

            {cvesQ.data?.summary && (
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge>{t("artifacts.cveTotal", { count: cvesQ.data.summary.total })}</Badge>
                <Badge tone="danger">
                  {t("artifacts.cveUnpatched", { count: cvesQ.data.summary.unpatched })}
                </Badge>
                <Badge tone="ok">{t("artifacts.cvePatched", { count: cvesQ.data.summary.patched })}</Badge>
                <Badge tone="neutral">
                  {t("artifacts.cveIgnored", { count: cvesQ.data.summary.ignored })}
                </Badge>
              </div>
            )}

            <div className="space-y-2">
              {filteredCves.map((f) => (
                <div
                  key={`${f.cve_id}-${f.package}`}
                  className="rounded-md border border-border bg-bg p-2.5 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold mono-num text-fg">
                      {f.cve_id} · {f.package} ({f.version})
                    </span>
                    <div className="flex gap-1.5">
                      <Badge
                        tone={
                          f.severity === "CRITICAL" || f.severity === "HIGH"
                            ? "danger"
                            : f.severity === "MEDIUM"
                            ? "warn"
                            : "neutral"
                        }
                      >
                        {f.severity} {f.cvss}
                      </Badge>
                      <Badge
                        tone={
                          f.status === "Patched"
                            ? "ok"
                            : f.status === "Unpatched"
                            ? "danger"
                            : "neutral"
                        }
                      >
                        {f.status}
                      </Badge>
                    </div>
                  </div>
                  <div className="text-muted">{f.summary}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-fg">
                {t("artifacts.sbomTitle", { format: sbomQ.data?.format ?? "SPDX 3.0" })}
              </h2>
              <div className="flex items-center gap-1.5">
                <Button size="sm" onClick={() => licenseExportM.mutate("csv")}>
                  <Download className="h-3.5 w-3.5" />
                  CSV
                </Button>
                <Button size="sm" onClick={() => licenseExportM.mutate("json")}>
                  <Download className="h-3.5 w-3.5" />
                  JSON
                </Button>
                <Button size="sm" onClick={() => licenseExportM.mutate("markdown")}>
                  <Download className="h-3.5 w-3.5" />
                  Markdown
                </Button>
              </div>
            </div>

            {licenseExportPreview && (
              <div className="rounded border border-accent/40 bg-bg p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="mono-num text-accent">{licenseExportPreview.filename}</span>
                  <Button size="sm" variant="primary" onClick={downloadPreview}>
                    <Download className="h-3 w-3" />
                    {t("artifacts.download")}
                  </Button>
                </div>
                <pre className="max-h-40 overflow-auto mono-num text-[11px] text-muted">
                  {licenseExportPreview.content}
                </pre>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-[11px] text-muted">
                    <th className="py-2 pr-3">{t("artifacts.colPackage")}</th>
                    <th className="py-2 pr-3">{t("artifacts.colVersion")}</th>
                    <th className="py-2 pr-3">{t("artifacts.colLicense")}</th>
                    <th className="py-2">PURL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {sbomQ.data?.packages.map((pkg) => (
                    <tr key={pkg.purl || pkg.name}>
                      <td className="py-2 pr-3 mono-num font-semibold text-fg">{pkg.name}</td>
                      <td className="py-2 pr-3 mono-num">{pkg.version}</td>
                      <td className="py-2 pr-3">
                        <Badge tone={pkg.gplv3_flag ? "warn" : "ok"}>
                          {pkg.license} {pkg.gplv3_flag ? "(GPLv3)" : ""}
                        </Badge>
                      </td>
                      <td className="py-2 mono-num text-[11px] text-muted">{pkg.purl}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </Tabs.Content>

        {/* TAB 6: buildhistory & SQLite Build Run History */}
        <Tabs.Content value="history" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
                  <History className="h-4 w-4 text-accent" />
                  {t("artifacts.buildhistoryTitle")}
                </h2>
                {historyQ.data && (
                  <Badge tone="warn" className="mono-num">
                    {historyQ.data.rootfs_delta_kb >= 0
                      ? `+${historyQ.data.rootfs_delta_kb}`
                      : historyQ.data.rootfs_delta_kb}{" "}
                    KiB rootfs
                  </Badge>
                )}
              </div>

              <textarea
                value={customDiffText}
                onChange={(e) => setCustomDiffText(e.target.value)}
                rows={3}
                placeholder={t("artifacts.customDiffPlaceholder")}
                className="w-full rounded-md border border-border bg-bg p-2 mono-num text-[11px] text-fg focus:outline-none focus:border-accent"
              />

              <div className="space-y-2">
                {historyQ.data?.entries.map((entry) => (
                  <div
                    key={entry.package}
                    className="flex items-center justify-between rounded-md border border-border bg-bg p-2.5 text-xs"
                  >
                    <div>
                      <div className="font-semibold mono-num text-fg">{entry.package}</div>
                      <div className="mono-num text-[11px] text-muted">
                        {entry.old_version ?? "—"} → {entry.new_version ?? "—"}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone="accent">{entry.change}</Badge>
                      <span className="mono-num text-fg">
                        {entry.size_delta_kb >= 0
                          ? `+${entry.size_delta_kb}`
                          : entry.size_delta_kb}{" "}
                        KiB
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-fg">
                  {t("artifacts.sqliteHistoryTitle")}
                </h2>
                <Button size="sm" onClick={() => void sqliteRunsQ.refetch()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("artifacts.refresh")}
                </Button>
              </div>
              {(!sqliteRunsQ.data || sqliteRunsQ.data.length === 0) ? (
                <div className="rounded border border-border bg-bg p-4 text-xs text-muted">
                  {t("artifacts.noBuildHistory")}
                </div>
              ) : (
                <div className="space-y-2">
                  {sqliteRunsQ.data.map((run) => {
                    const total = run.sstate_hits + run.sstate_misses;
                    const hitPct = total > 0 ? Math.round((run.sstate_hits / total) * 100) : 0;
                    return (
                      <div
                        key={run.id}
                        className="flex items-center justify-between rounded-md border border-border bg-bg p-2.5 text-xs"
                      >
                        <div>
                          <div className="font-semibold mono-num text-fg">{run.target}</div>
                          <div className="text-[11px] text-muted mono-num">
                            {new Date(run.created_at).toLocaleString(
                              i18n.language === "en" ? "en-US" : "tr-TR"
                            )}{" "}
                            ·{" "}
                            {t("artifacts.durationSec", {
                              sec: (run.duration_ms / 1000).toFixed(1),
                            })}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge tone="accent">{t("artifacts.sstateHitPct", { pct: hitPct })}</Badge>
                          <Badge tone={run.status === "succeeded" ? "ok" : "danger"}>
                            {run.status}
                          </Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
