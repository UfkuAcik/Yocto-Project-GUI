import { useQuery } from "@tanstack/react-query";
import {
  Copy,
  Globe,
  HardDrive,
  Lock,
  Play,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
  UploadCloud,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input, Modal } from "@/components/ui/primitives";
import {
  generateUbootTftpScript,
  listNetworkInterfaces,
  raucGetStatus,
  raucInstallBundle,
  sshFlashPartition,
  sshListBlockDevices,
  startTftpServer,
  stopTftpServer,
  swupdateDeploy,
  writeSerialPort,
} from "@/lib/deployApi";
import { isTauriRuntime } from "@/lib/tauriApi";
import { formatBytes } from "@/lib/utils";
import { useDeployStore } from "@/stores/deployStore";

export function EthernetDeployView() {
  const { t } = useTranslation();
  const {
    mockMode,
    tftpStatus,
    setTftpStatus,
    serial,
    appendSerialOutput,
    startJobTracking,
    appendJobLog,
    updateJobStatus,
  } = useDeployStore();

  // TFTP state
  const [bindIp, setBindIp] = useState("0.0.0.0");
  const [tftpPort, setTftpPort] = useState(1069);
  const [tftpRoot, setTftpRoot] = useState("");
  const [targetIp, setTargetIp] = useState("192.168.10.50");
  const [kernelFile, setKernelFile] = useState("Image-6.12.19-yocto-standard");
  const [dtbFile, setDtbFile] = useState("imx8mp-lpddr4-evk.dtb");
  const [ubootScript, setUbootScript] = useState("");

  // SWUpdate state
  const [swupdateUrl, setSwupdateUrl] = useState("http://192.168.10.50:8080");
  const [swuPath, setSwuPath] = useState("core-image-minimal-imx8mp-lpddr4-evk.swu");

  // RAUC state
  const [sshUser, setSshUser] = useState("root");
  const [sshKeyRef, setSshKeyRef] = useState("keyring://yocto/target-ssh");
  const [raucBundlePath, setRaucBundlePath] = useState("core-image-minimal-imx8mp.raucb");
  const [raucReboot, setRaucReboot] = useState(false);

  // SSH Raw state
  const [selectedRemoteDev, setSelectedRemoteDev] = useState("/dev/mmcblk2p3");
  const [useBmaptool, setUseBmaptool] = useState(true);
  const [sshRawImage, setSshRawImage] = useState("core-image-minimal-imx8mp.rootfs.ext4");

  // Shared confirmation modal for destructive network ops
  const [confirmKind, setConfirmKind] = useState<"swupdate" | "rauc" | "ssh_raw" | null>(null);
  const [netFeedback, setNetFeedback] = useState<string | null>(null);

  const nicsQ = useQuery({
    queryKey: ["net-interfaces"],
    queryFn: () => listNetworkInterfaces(),
  });

  const raucQ = useQuery({
    queryKey: ["rauc-status", targetIp, sshUser, mockMode],
    queryFn: () => raucGetStatus(targetIp, sshUser, sshKeyRef, mockMode),
  });

  const sshBlocksQ = useQuery({
    queryKey: ["ssh-block-devices", targetIp, sshUser, mockMode],
    queryFn: () => sshListBlockDevices(targetIp, sshUser, sshKeyRef, mockMode),
  });

  async function toggleTftp() {
    setNetFeedback(null);
    try {
      if (tftpStatus.running) {
        const st = await stopTftpServer();
        setTftpStatus(st);
      } else {
        const st = await startTftpServer(bindIp, tftpPort, tftpRoot || undefined);
        setTftpStatus(st);
        const script = await generateUbootTftpScript(
          bindIp === "0.0.0.0" ? "192.168.10.2" : bindIp,
          targetIp,
          kernelFile,
          dtbFile
        );
        setUbootScript(script);
      }
    } catch (err) {
      setNetFeedback(err instanceof Error ? err.message : String(err));
    }
  }

  async function sendUbootScriptToUart() {
    if (!ubootScript) return;
    if (serial.sessionId && isTauriRuntime()) {
      for (const line of ubootScript.split("\n")) {
        await writeSerialPort(serial.sessionId, `${line}\r`);
      }
      setNetFeedback(t("deploy.ubootSentUart"));
    } else {
      appendSerialOutput(`\r\n${ubootScript}\r\n`);
      setNetFeedback(t("deploy.ubootWrittenBuffer"));
    }
  }

  async function runConfirmedNetworkDeploy() {
    const kind = confirmKind;
    setConfirmKind(null);
    if (!kind) return;
    const jobId = `net-${Date.now()}`;
    startJobTracking(jobId, kind);

    try {
      if (kind === "swupdate") {
        const res = await swupdateDeploy({
          job_id: jobId,
          target_url: swupdateUrl,
          swu_path: swuPath,
          mock_mode: mockMode,
          confirmed: true,
        });
        appendJobLog(jobId, res.summary);
        updateJobStatus({ job_id: jobId, status: "succeeded", summary: res.summary });
        setNetFeedback(res.summary);
      } else if (kind === "rauc") {
        const res = await raucInstallBundle({
          job_id: jobId,
          host: targetIp,
          ssh_user: sshUser,
          ssh_key_ref: sshKeyRef,
          bundle_path: raucBundlePath,
          reboot_after: raucReboot,
          mock_mode: mockMode,
          confirmed: true,
        });
        appendJobLog(jobId, res.summary);
        updateJobStatus({ job_id: jobId, status: "succeeded", summary: res.summary });
        setNetFeedback(res.summary);
        void raucQ.refetch();
      } else {
        const res = await sshFlashPartition({
          job_id: jobId,
          host: targetIp,
          ssh_user: sshUser,
          ssh_key_ref: sshKeyRef,
          image_path: sshRawImage,
          target_device: selectedRemoteDev,
          use_bmaptool: useBmaptool,
          mock_mode: mockMode,
          confirmed: true,
        });
        appendJobLog(jobId, res.summary);
        updateJobStatus({ job_id: jobId, status: "succeeded", summary: res.summary });
        setNetFeedback(res.summary);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateJobStatus({ job_id: jobId, status: "failed", summary: msg });
      setNetFeedback(msg);
    }
  }

  return (
    <div className="space-y-4">
      {netFeedback && (
        <div className="rounded border border-accent/40 bg-accent/10 p-2.5 text-xs text-fg">
          {netFeedback}
        </div>
      )}

      {/* 1. Built-in Rust TFTP Server */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
              <Radio className="h-4 w-4 text-accent" />
              {t("deploy.tftpTitle")}
            </h2>
            <p className="text-xs text-muted">
              {t("deploy.tftpSubtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={tftpStatus.running ? "ok" : "neutral"}>
              {tftpStatus.running
                ? t("deploy.tftpActive", { ip: tftpStatus.bind_ip, port: tftpStatus.port })
                : t("deploy.tftpStopped")}
            </Badge>
            <Button
              size="sm"
              variant={tftpStatus.running ? "danger" : "primary"}
              onClick={() => void toggleTftp()}
            >
              {tftpStatus.running ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {tftpStatus.running ? t("deploy.tftpStop") : t("deploy.tftpStart")}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4 text-xs">
          <div>
            <label className="text-[11px] text-muted">{t("deploy.nicLabel")}</label>
            <select
              value={bindIp}
              onChange={(e) => setBindIp(e.target.value)}
              disabled={tftpStatus.running}
              className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg"
            >
              {nicsQ.data?.map((n) => (
                <option key={`${n.name}-${n.ip}`} value={n.ip}>
                  {n.name} ({n.ip})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] text-muted">{t("deploy.udpPortLabel")}</label>
            <Input
              type="number"
              value={tftpPort}
              onChange={(e) => setTftpPort(Number(e.target.value) || 1069)}
              disabled={tftpStatus.running}
              className="mono-num"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-[11px] text-muted">{t("deploy.stagingDirLabel")}</label>
            <Input
              value={tftpRoot}
              onChange={(e) => setTftpRoot(e.target.value)}
              placeholder={t("deploy.stagingPlaceholder")}
              disabled={tftpStatus.running}
              className="mono-num"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
          <Input
            value={targetIp}
            onChange={(e) => setTargetIp(e.target.value)}
            placeholder={t("deploy.targetIpPlaceholder")}
          />
          <Input
            value={kernelFile}
            onChange={(e) => setKernelFile(e.target.value)}
            placeholder={t("deploy.kernelFilePlaceholder")}
          />
          <Input
            value={dtbFile}
            onChange={(e) => setDtbFile(e.target.value)}
            placeholder={t("deploy.dtbFilePlaceholder")}
          />
        </div>

        {ubootScript && (
          <div className="rounded border border-border bg-bg p-2.5 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-fg">{t("deploy.autoUbootBlock")}</span>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  onClick={() => void navigator.clipboard?.writeText(ubootScript)}
                >
                  <Copy className="h-3 w-3" />
                  {t("deploy.copyBtn")}
                </Button>
                <Button size="sm" variant="primary" onClick={() => void sendUbootScriptToUart()}>
                  <Send className="h-3 w-3" />
                  {t("deploy.sendToUart")}
                </Button>
              </div>
            </div>
            <pre className="mono-num text-[11px] text-accent overflow-x-auto">{ubootScript}</pre>
          </div>
        )}

        {tftpStatus.transfers.length > 0 && (
          <div className="space-y-1 text-xs">
            <div className="text-[11px] text-muted">{t("deploy.liveTftpTransfers")}</div>
            {tftpStatus.transfers.map((x) => (
              <div
                key={x.id}
                className="flex items-center justify-between rounded border border-border bg-bg px-2.5 py-1.5 mono-num text-[11px]"
              >
                <span>
                  {x.client_ip} ← {x.filename}
                </span>
                <span className="text-success">
                  {formatBytes(x.bytes_sent)} · {Math.round(x.speed_kb_s)} KB/s ({x.status})
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 2. SWUpdate OTA */}
        <Card className="space-y-3">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <UploadCloud className="h-4 w-4 text-accent" />
            SWUpdate (.swu) HTTP / WebSocket OTA
          </h2>
          <div className="space-y-2 text-xs">
            <Input
              value={swupdateUrl}
              onChange={(e) => setSwupdateUrl(e.target.value)}
              placeholder="http://<target-ip>:8080"
            />
            <Input
              value={swuPath}
              onChange={(e) => setSwuPath(e.target.value)}
              placeholder="core-image-minimal.swu"
              className="mono-num"
            />
            <Button variant="primary" onClick={() => setConfirmKind("swupdate")}>
              <Globe className="h-3.5 w-3.5" />
              {t("deploy.swuUploadBtn")}
            </Button>
          </div>
        </Card>

        {/* 3. RAUC A/B Slot Manager */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-accent" />
              {t("deploy.raucTitle")}
            </h2>
            <Button size="sm" onClick={() => void raucQ.refetch()}>
              <RefreshCw className="h-3 w-3" />
              {t("deploy.readSlots")}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
            {raucQ.data?.slots.map((slot) => (
              <div
                key={slot.slot_name}
                className={`rounded border p-2 ${
                  slot.active ? "border-success/50 bg-success/10" : "border-border bg-bg"
                }`}
              >
                <div className="flex items-center justify-between font-semibold">
                  <span className="mono-num">{slot.slot_name} ({slot.bootname})</span>
                  <Badge tone={slot.active ? "ok" : "neutral"}>
                    {slot.active ? t("deploy.slotActiveBooted") : t("deploy.slotPassive")}
                  </Badge>
                </div>
                <div className="mono-num text-[11px] text-muted mt-0.5">
                  {slot.device} · v{slot.bundle_version}
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Input
              value={raucBundlePath}
              onChange={(e) => setRaucBundlePath(e.target.value)}
              className="flex-1 mono-num"
            />
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={raucReboot}
                onChange={(e) => setRaucReboot(e.target.checked)}
                className="accent-accent"
              />
              {t("deploy.reboot")}
            </label>
            <Button variant="primary" onClick={() => setConfirmKind("rauc")}>
              {t("deploy.raucInstall")}
            </Button>
          </div>
        </Card>
      </div>

      {/* 4. SSH Raw / bmaptool Passive Partition */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-accent" />
            {t("deploy.sshPipeTitle")}
          </h2>
          <div className="flex items-center gap-2">
            <Input
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              className="w-24"
              placeholder="root"
            />
            <Input
              value={sshKeyRef}
              onChange={(e) => setSshKeyRef(e.target.value)}
              className="w-48"
              placeholder={t("deploy.sshKeyRefPlaceholder")}
            />
            <Button size="sm" onClick={() => void sshBlocksQ.refetch()}>
              <RefreshCw className="h-3 w-3" />
              {t("deploy.remoteLsblk")}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
          {sshBlocksQ.data?.map((dev) => (
            <button
              key={dev.path}
              type="button"
              disabled={dev.is_active_root}
              onClick={() => setSelectedRemoteDev(dev.path)}
              className={`rounded border p-2 text-left ${
                dev.is_active_root
                  ? "border-danger/30 bg-danger/5 opacity-60 cursor-not-allowed"
                  : selectedRemoteDev === dev.path
                  ? "border-accent bg-accent/10 cursor-pointer"
                  : "border-border bg-bg hover:bg-elevated cursor-pointer"
              }`}
            >
              <div className="flex items-center justify-between font-semibold">
                <span className="mono-num flex items-center gap-1">
                  {dev.is_active_root && <Lock className="h-3 w-3 text-danger" />}
                  {dev.path}
                </span>
                <Badge tone={dev.is_active_root ? "danger" : "ok"}>
                  {dev.is_active_root ? t("deploy.activeLocked") : t("deploy.passiveTarget")}
                </Badge>
              </div>
              <div className="mono-num text-[11px] text-muted mt-0.5">
                {dev.size_human} · {dev.mountpoints.join(", ") || t("deploy.notMounted")}
              </div>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Input
            value={sshRawImage}
            onChange={(e) => setSshRawImage(e.target.value)}
            className="flex-1 mono-num"
          />
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={useBmaptool}
              onChange={(e) => setUseBmaptool(e.target.checked)}
              className="accent-accent"
            />
            {t("deploy.useBmaptool")}
          </label>
          <Button variant="danger" onClick={() => setConfirmKind("ssh_raw")}>
            {t("deploy.writePassivePart", { dev: selectedRemoteDev })}
          </Button>
        </div>
      </Card>

      <Modal
        open={Boolean(confirmKind)}
        onOpenChange={(v) => !v && setConfirmKind(null)}
        title={t("deploy.netConfirmTitle")}
        subtitle={t("deploy.netConfirmSubtitle", { ip: targetIp })}
      >
        <div className="space-y-3 text-xs">
          <p className="text-muted">
            {t("deploy.netConfirmBodyPre")}
            <strong className="text-fg">{confirmKind}</strong>
            {t("deploy.netConfirmBodyPost")}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmKind(null)}>
              {t("deploy.abortShort")}
            </Button>
            <Button variant="primary" onClick={() => void runConfirmedNetworkDeploy()}>
              {t("deploy.confirmAndStart")}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
