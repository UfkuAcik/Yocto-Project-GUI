import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  HardDriveDownload,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  Usb,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input, Modal, ProgressBar } from "@/components/ui/primitives";
import {
  cancelDeployJob,
  listDfuAltsettings,
  listUsbDeployDevices,
  stageDeployArtifact,
  startUsbFlash,
  type FlashRequest,
  type PartitionMapping,
} from "@/lib/deployApi";
import { isTauriRuntime } from "@/lib/tauriApi";
import { formatBytes } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { useDeployStore, validateFlashConfirmation } from "@/stores/deployStore";

type UsbFlasherKind = FlashRequest["flasher_kind"];

const CUSTOM_PLACEHOLDERS = [
  "{IMAGE_PATH}",
  "{DEPLOY_DIR}",
  "{MACHINE}",
  "{KERNEL}",
  "{DTB}",
  "{SERIAL_PORT}",
];

export function UsbFlashView() {
  const { t, i18n } = useTranslation();
  const activeProjectId = useAppStore((s) => s.activeProjectId) ?? "proj-wrynose-evk";
  const projects = useAppStore((s) => s.projects);
  const activeProvider = useAppStore((s) => s.activeProvider);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];

  const {
    selectedArtifact,
    stagedArtifact,
    setStagedArtifact,
    mockMode,
    activeJob,
    startJobTracking,
    updateJobProgress,
    appendJobLog,
    updateJobStatus,
    serial,
  } = useDeployStore();

  const [flasherKind, setFlasherKind] = useState<UsbFlasherKind>("raw_disk");
  const [imagePath, setImagePath] = useState(
    selectedArtifact?.path ??
      "/home/yocto/yocto-studio/poky-wrynose-imx8mp/build/tmp/deploy/images/imx8mp-lpddr4-evk/core-image-minimal-imx8mp-lpddr4-evk.rootfs.wic.bz2"
  );
  const [targetDevice, setTargetDevice] = useState("mock://sd-card-industrial-32g");
  const [verifyAfterWrite, setVerifyAfterWrite] = useState(true);
  const [rebootAfter, setRebootAfter] = useState(false);

  // Fastboot mappings
  const [partitionMap, setPartitionMap] = useState<PartitionMapping[]>([
    { partition: "boot", file_path: "Image-6.12.19-yocto-standard" },
    { partition: "dtb", file_path: "imx8mp-lpddr4-evk.dtb" },
    { partition: "rootfs", file_path: "core-image-minimal-imx8mp-lpddr4-evk.rootfs.ext4" },
  ]);

  // DFU
  const [selectedAlt, setSelectedAlt] = useState("0");
  const [vidPid, setVidPid] = useState("0483:df11");

  // NXP uuu
  const [uuuMode, setUuuMode] = useState<"emmc_all" | "sd_all" | "script">("emmc_all");
  const [bootloaderPath, setBootloaderPath] = useState("imx-boot");
  const [uuuScriptPath, setUuuScriptPath] = useState("");

  // STM32
  const [tsvPath, setTsvPath] = useState("FlashLayout_sdcard_stm32mp157f-dk2-extensible.tsv");

  // TI dfu-boot (Sitara AM62x/AM64x)
  const [tiTiboot3, setTiTiboot3] = useState("tiboot3.bin");
  const [tiTispl, setTiTispl] = useState("tispl.bin");
  const [tiUboot, setTiUboot] = useState("u-boot.img");

  // MediaTek sp-flash-tool
  const [mtkScatter, setMtkScatter] = useState("MT8395_Android_scatter.txt");
  const [mtkDa, setMtkDa] = useState("MTK_AllInOne_DA.bin");

  // Rockchip rkdeveloptool
  const [rkLoader, setRkLoader] = useState("rk3588_spl_loader_v1.15.113.bin");
  const [rkLbaOffset, setRkLbaOffset] = useState("0x0");

  // Custom CLI
  const [customTemplate, setCustomTemplate] = useState(
    'rkdeveloptool wl 0 "{IMAGE_PATH}" --chip {MACHINE}'
  );

  // Staging & Confirm modal
  const [stagingBusy, setStagingBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  useEffect(() => {
    if (selectedArtifact?.path) {
      setImagePath(selectedArtifact.path);
    }
  }, [selectedArtifact?.path]);

  const devicesQ = useQuery({
    queryKey: ["usb-deploy-devices", mockMode, i18n.language],
    queryFn: () => listUsbDeployDevices(mockMode),
  });

  const dfuQ = useQuery({
    queryKey: ["dfu-altsettings", mockMode],
    queryFn: () => listDfuAltsettings(mockMode),
    enabled: flasherKind === "dfu",
  });

  async function handleStageImage() {
    setErrorBanner(null);
    setStagingBusy(true);
    try {
      const res = await stageDeployArtifact({
        source_kind: mockMode ? "mock" : activeProvider,
        source_path: imagePath,
        project_id: activeProjectId,
        machine: activeProject?.machine ?? "imx8mp-lpddr4-evk",
        mock_mode: mockMode,
      });
      setStagedArtifact(res);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setStagingBusy(false);
    }
  }

  function openConfirmationDialog() {
    setErrorBanner(null);
    setConfirmChecked(false);
    setConfirmOpen(true);
  }

  async function executeFlash() {
    const resolvedImage = stagedArtifact?.local_path ?? imagePath;
    const shaSummary =
      stagedArtifact?.sha256 ?? selectedArtifact?.sha256_short ?? "sha256-on-write";
    const resolvedTarget =
      flasherKind === "dfu"
        ? `${vidPid} (alt=${selectedAlt})`
        : flasherKind === "stm32_prog"
        ? tsvPath
        : flasherKind === "custom_cli"
        ? "custom-cli-target"
        : targetDevice;

    const check = validateFlashConfirmation({
      imagePath: resolvedImage,
      targetDevice: resolvedTarget,
      sha256: shaSummary,
      confirmed: confirmChecked,
    });
    if (!check.valid) {
      setErrorBanner(check.reason ?? t("deploy.validationErr"));
      return;
    }

    setConfirmOpen(false);
    const jobId = `job-${Date.now()}`;
    startJobTracking(jobId, flasherKind);

    const req: FlashRequest = {
      job_id: jobId,
      flasher_kind: flasherKind,
      image_path: resolvedImage,
      deploy_dir: activeProject ? `${activeProject.build_dir}/tmp/deploy/images` : "staging",
      machine: activeProject?.machine ?? "imx8mp-lpddr4-evk",
      kernel_path: "Image-6.12.19-yocto-standard",
      dtb_path: `${activeProject?.machine ?? "imx8mp-lpddr4-evk"}.dtb`,
      serial_port: serial.portName,
      target_device: resolvedTarget,
      partition_map: partitionMap,
      altsetting: selectedAlt,
      vid_pid: vidPid,
      uuu_mode: uuuMode === "script" ? undefined : uuuMode,
      uuu_script_path: uuuMode === "script" ? uuuScriptPath : undefined,
      bootloader_path: flasherKind === "ti_dfu_boot" ? tiUboot : bootloaderPath,
      tsv_path: tsvPath,
      custom_template: customTemplate,
      ti_tiboot3_path: tiTiboot3,
      ti_tispl_path: tiTispl,
      mtk_scatter_path: mtkScatter,
      mtk_da_path: mtkDa,
      rk_loader_path: rkLoader,
      rk_lba_offset: rkLbaOffset,
      verify_after_write: verifyAfterWrite,
      reboot_after: rebootAfter,
      mock_mode: mockMode,
      confirmed: true,
      confirmed_sha256: shaSummary,
    };

    try {
      await startUsbFlash(req);
      if (!isTauriRuntime()) {
        // Browser simulation stream when running outside Tauri
        for (const pct of [25, 50, 75, 100]) {
          appendJobLog(
            jobId,
            t("deploy.mockUsbProgressLog", { kind: flasherKind, pct, target: resolvedTarget })
          );
          updateJobProgress({
            job_id: jobId,
            phase: flasherKind,
            percent: pct,
            bytes_written: pct * 1_480_000,
            total_bytes: 148_000_000,
            speed_mb_s: 36.2,
            message: t("deploy.mockUsbStreamMsg", { kind: flasherKind, pct }),
          });
        }
        updateJobStatus({
          job_id: jobId,
          status: "succeeded",
          summary: t("deploy.mockUsbDone", { kind: flasherKind, target: resolvedTarget }),
          sha256: shaSummary,
        });
      }
    } catch (err) {
      updateJobStatus({
        job_id: jobId,
        status: "failed",
        summary: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const visibleDevices = (devicesQ.data ?? []).filter(
    (d) => !d.is_system_disk && d.removable
  );

  return (
    <div className="space-y-4">
      {/* Staging Bar */}
      <Card className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-fg flex items-center gap-2">
            <HardDriveDownload className="h-4 w-4 text-accent" />
            {t("deploy.stageHeading")}
          </div>
          {stagedArtifact && (
            <Badge tone="ok" className="mono-num">
              <CheckCircle2 className="h-3 w-3" />
              {stagedArtifact.cache_hit ? t("deploy.cachedVerified") : t("deploy.stagedOk")}
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={imagePath}
            onChange={(e) => setImagePath(e.target.value)}
            placeholder={t("deploy.imagePathPlaceholder")}
            className="flex-1 min-w-64 mono-num"
          />
          <Button onClick={() => void handleStageImage()} disabled={stagingBusy}>
            <HardDriveDownload className="h-3.5 w-3.5" />
            {stagingBusy ? t("deploy.stagingBusy") : t("deploy.stageBtn")}
          </Button>
        </div>

        {stagedArtifact && (
          <div className="rounded border border-success/40 bg-success/10 p-2 text-[11px] mono-num text-fg space-y-0.5">
            <div>
              {t("deploy.localStaging")}: {stagedArtifact.local_path}
            </div>
            <div>
              SHA-256: {stagedArtifact.sha256} · {formatBytes(stagedArtifact.size_bytes)}
            </div>
          </div>
        )}
      </Card>

      {/* USB Flasher Method Selector */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-fg flex items-center gap-2">
            <Usb className="h-4 w-4 text-accent" />
            {t("deploy.usbHeading")}
          </div>
          <Button size="sm" onClick={() => void devicesQ.refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("deploy.scanUsb")}
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[
            { id: "raw_disk", label: "SD / USB / UMS Raw" },
            { id: "fastboot", label: "Fastboot" },
            { id: "dfu", label: "USB DFU (dfu-util)" },
            { id: "nxp_uuu", label: "NXP i.MX (uuu)" },
            { id: "stm32_prog", label: "STM32MP (.tsv)" },
            { id: "ti_dfu_boot", label: "TI Sitara (dfu-boot)" },
            { id: "mediatek_sp", label: "MediaTek (sp-flash)" },
            { id: "rockchip_rkdev", label: "Rockchip (rkdeveloptool)" },
            { id: "custom_cli", label: t("deploy.customCliTab") },
          ].map((m) => (
            <Button
              key={m.id}
              size="sm"
              variant={flasherKind === m.id ? "primary" : "secondary"}
              onClick={() => setFlasherKind(m.id as UsbFlasherKind)}
            >
              {m.label}
            </Button>
          ))}
        </div>

        {/* Selectable Non-OS Hardware List */}
        {(flasherKind === "raw_disk" ||
          flasherKind === "fastboot" ||
          flasherKind === "nxp_uuu" ||
          flasherKind === "ti_dfu_boot" ||
          flasherKind === "mediatek_sp" ||
          flasherKind === "rockchip_rkdev") && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-muted">
              <span>{t("deploy.safeTargetsHint")}</span>
              <span className="flex items-center gap-1 text-success">
                <Lock className="h-3 w-3" />
                {t("deploy.systemDiskLocked")}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {visibleDevices.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setTargetDevice(d.device_path)}
                  className={`rounded-md border p-2.5 text-left text-xs cursor-pointer ${
                    targetDevice === d.device_path
                      ? "border-accent bg-accent/10"
                      : "border-border bg-bg hover:bg-elevated"
                  }`}
                >
                  <div className="font-semibold text-fg flex items-center justify-between">
                    <span>{d.name}</span>
                    <Badge tone="ok">{d.kind}</Badge>
                  </div>
                  <div className="mono-num text-[11px] text-muted mt-0.5">
                    {d.device_path} · {d.size_human} · {d.bus_type}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Mode Specific Controls */}
        {flasherKind === "raw_disk" && (
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={verifyAfterWrite}
                onChange={(e) => setVerifyAfterWrite(e.target.checked)}
                className="accent-accent"
              />
              {t("deploy.verifyAfterWrite")}
            </label>
          </div>
        )}

        {flasherKind === "fastboot" && (
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted">{t("deploy.partitionMapTitle")}</span>
              <Button
                size="sm"
                onClick={() =>
                  setPartitionMap([...partitionMap, { partition: "system", file_path: "" }])
                }
              >
                <Plus className="h-3 w-3" />
                {t("deploy.addRow")}
              </Button>
            </div>
            {partitionMap.map((row, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  value={row.partition}
                  onChange={(e) =>
                    setPartitionMap(
                      partitionMap.map((r, i) => (i === idx ? { ...r, partition: e.target.value } : r))
                    )
                  }
                  placeholder="partition"
                  className="w-32 mono-num"
                />
                <Input
                  value={row.file_path}
                  onChange={(e) =>
                    setPartitionMap(
                      partitionMap.map((r, i) => (i === idx ? { ...r, file_path: e.target.value } : r))
                    )
                  }
                  placeholder={t("deploy.filePathPlaceholder")}
                  className="flex-1 mono-num"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPartitionMap(partitionMap.filter((_, i) => i !== idx))}
                >
                  <Trash2 className="h-3.5 w-3.5 text-danger" />
                </Button>
              </div>
            ))}
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={rebootAfter}
                onChange={(e) => setRebootAfter(e.target.checked)}
                className="accent-accent"
              />
              {t("deploy.fastbootRebootAfter")}
            </label>
          </div>
        )}

        {flasherKind === "dfu" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
            <div>
              <label className="text-[11px] text-muted">VID:PID</label>
              <Input value={vidPid} onChange={(e) => setVidPid(e.target.value)} className="mono-num" />
            </div>
            <div>
              <label className="text-[11px] text-muted">dfu-util -l Altsetting</label>
              <select
                value={selectedAlt}
                onChange={(e) => setSelectedAlt(e.target.value)}
                className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg"
              >
                {dfuQ.data?.map((alt) => (
                  <option key={alt.alt_index} value={String(alt.alt_index)}>
                    alt={alt.alt_index} · {alt.name} ({alt.vid_pid})
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {flasherKind === "nxp_uuu" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
            <div>
              <label className="text-[11px] text-muted">{t("deploy.uuuMode")}</label>
              <select
                value={uuuMode}
                onChange={(e) => setUuuMode(e.target.value as "emmc_all" | "sd_all" | "script")}
                className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg"
              >
                <option value="emmc_all">-b emmc_all</option>
                <option value="sd_all">-b sd_all</option>
                <option value="script">{t("deploy.uuuScriptOption")}</option>
              </select>
            </div>
            {uuuMode === "script" ? (
              <div className="sm:col-span-2">
                <label className="text-[11px] text-muted">{t("deploy.uuuScriptPath")}</label>
                <Input
                  value={uuuScriptPath}
                  onChange={(e) => setUuuScriptPath(e.target.value)}
                  placeholder="imx8mp-deploy.uuu"
                />
              </div>
            ) : (
              <div className="sm:col-span-2">
                <label className="text-[11px] text-muted">Bootloader (imx-boot)</label>
                <Input
                  value={bootloaderPath}
                  onChange={(e) => setBootloaderPath(e.target.value)}
                />
              </div>
            )}
          </div>
        )}

        {flasherKind === "stm32_prog" && (
          <div className="text-xs">
            <label className="text-[11px] text-muted">{t("deploy.stm32TsvLabel")}</label>
            <Input value={tsvPath} onChange={(e) => setTsvPath(e.target.value)} className="mono-num" />
          </div>
        )}

        {flasherKind === "ti_dfu_boot" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
            <div>
              <label className="text-[11px] text-muted">tiboot3.bin (alt=bootloader)</label>
              <Input value={tiTiboot3} onChange={(e) => setTiTiboot3(e.target.value)} className="mono-num" />
            </div>
            <div>
              <label className="text-[11px] text-muted">tispl.bin (alt=tispl.bin)</label>
              <Input value={tiTispl} onChange={(e) => setTiTispl(e.target.value)} className="mono-num" />
            </div>
            <div>
              <label className="text-[11px] text-muted">u-boot.img (alt=u-boot.img)</label>
              <Input value={tiUboot} onChange={(e) => setTiUboot(e.target.value)} className="mono-num" />
            </div>
          </div>
        )}

        {flasherKind === "mediatek_sp" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
            <div>
              <label className="text-[11px] text-muted">{t("deploy.mtkScatterLabel")}</label>
              <Input value={mtkScatter} onChange={(e) => setMtkScatter(e.target.value)} className="mono-num" />
            </div>
            <div>
              <label className="text-[11px] text-muted">Download Agent (MTK_AllInOne_DA.bin)</label>
              <Input value={mtkDa} onChange={(e) => setMtkDa(e.target.value)} className="mono-num" />
            </div>
          </div>
        )}

        {flasherKind === "rockchip_rkdev" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
            <div className="sm:col-span-2">
              <label className="text-[11px] text-muted">MiniLoader / SPL Loader (.bin)</label>
              <Input value={rkLoader} onChange={(e) => setRkLoader(e.target.value)} className="mono-num" />
            </div>
            <div>
              <label className="text-[11px] text-muted">LBA Offset (hex/int)</label>
              <Input value={rkLbaOffset} onChange={(e) => setRkLbaOffset(e.target.value)} className="mono-num" />
            </div>
          </div>
        )}

        {flasherKind === "custom_cli" && (
          <div className="space-y-2 text-xs">
            <label className="text-[11px] text-muted">{t("deploy.customCliLabel")}</label>
            <Input
              value={customTemplate}
              onChange={(e) => setCustomTemplate(e.target.value)}
              className="mono-num"
            />
            <div className="flex flex-wrap gap-1">
              {CUSTOM_PLACEHOLDERS.map((ph) => (
                <button
                  key={ph}
                  type="button"
                  onClick={() => setCustomTemplate(`${customTemplate} ${ph}`)}
                  className="rounded border border-border bg-bg px-1.5 py-0.5 text-[10px] mono-num text-accent hover:bg-elevated cursor-pointer"
                >
                  + {ph}
                </button>
              ))}
            </div>
          </div>
        )}

        {errorBanner && (
          <div className="rounded border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger">
            {errorBanner}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button variant="primary" onClick={openConfirmationDialog} disabled={activeJob.status === "running"}>
            <Play className="h-3.5 w-3.5" />
            {t("deploy.flashBtn")}
          </Button>
          {activeJob.status === "running" && activeJob.jobId && (
            <Button variant="danger" onClick={() => void cancelDeployJob(activeJob.jobId!)}>
              <Square className="h-3.5 w-3.5" />
              {t("deploy.cancelFlash")}
            </Button>
          )}
        </div>
      </Card>

      {/* Live Progress & Stream Log */}
      {activeJob.status !== "idle" && (
        <Card className="space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-fg">
              {t("deploy.jobStatus")}: {activeJob.phase} · {activeJob.summary}
            </span>
            <div className="flex items-center gap-2">
              {activeJob.speedMbS > 0 && (
                <Badge className="mono-num">{activeJob.speedMbS.toFixed(1)} MB/s</Badge>
              )}
              <Badge
                tone={
                  activeJob.status === "succeeded"
                    ? "ok"
                    : activeJob.status === "failed" || activeJob.status === "cancelled"
                    ? "danger"
                    : "accent"
                }
              >
                {activeJob.status.toUpperCase()} ({Math.round(activeJob.percent)}%)
              </Badge>
            </div>
          </div>
          <ProgressBar
            value={activeJob.percent}
            tone={activeJob.status === "failed" ? "danger" : activeJob.status === "succeeded" ? "ok" : "accent"}
          />
          {activeJob.logs.length > 0 && (
            <pre className="max-h-40 overflow-auto rounded border border-border bg-bg p-2.5 text-[11px] mono-num text-muted">
              {activeJob.logs.join("\n")}
            </pre>
          )}
        </Card>
      )}

      {/* Explicit Hardware Destruction Confirmation Dialog */}
      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("deploy.confirmTitle")}
        subtitle={t("deploy.confirmSubtitle")}
      >
        <div className="space-y-3 text-xs">
          <div className="rounded border border-warning/40 bg-warning/10 p-3 flex items-start gap-2 text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{t("deploy.confirmWarn")}</span>
          </div>
          <div className="rounded border border-border bg-bg p-3 space-y-1 mono-num text-[11px]">
            <div>
              <strong className="text-fg">Flasher:</strong> {flasherKind}
            </div>
            <div>
              <strong className="text-fg">{t("deploy.confirmTargetLabel")}</strong>{" "}
              {flasherKind === "dfu"
                ? `${vidPid} (alt=${selectedAlt})`
                : flasherKind === "stm32_prog"
                ? tsvPath
                : targetDevice}
            </div>
            <div>
              <strong className="text-fg">{t("deploy.confirmImageLabel")}</strong>{" "}
              {stagedArtifact?.local_path ?? imagePath}
            </div>
            <div>
              <strong className="text-fg">{t("deploy.confirmShaLabel")}</strong>{" "}
              {stagedArtifact?.sha256 ?? selectedArtifact?.sha256_short ?? t("deploy.verifyOnWrite")}
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmChecked}
              onChange={(e) => setConfirmChecked(e.target.checked)}
              className="accent-accent h-4 w-4"
            />
            <span className="text-fg">{t("deploy.confirmCheckbox")}</span>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t("deploy.abort")}
            </Button>
            <Button variant="danger" disabled={!confirmChecked} onClick={() => void executeFlash()}>
              {t("deploy.confirmAndFlash")}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
