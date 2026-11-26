import { Download, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Input, Modal, Switch } from "@/components/ui/primitives";
import {
  type SnapshotExportResult,
  type SnapshotImportResult,
  type UpdateCheckResult,
  type UpdaterConfigInfo,
  checkAppUpdate,
  exportProjectSnapshot,
  getUpdaterConfig,
  importProjectSnapshot,
  setUpdaterAutoCheck,
} from "@/lib/enterpriseApi";
import { useAppStore } from "@/stores/appStore";

export function ProjectSnapshotModal() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.snapshotModalOpen);
  const setOpen = useAppStore((s) => s.setSnapshotModalOpen);
  const activeProjectId = useAppStore((s) => s.activeProjectId);

  const [tab, setTab] = useState<"export" | "import" | "updater">("export");
  const [format, setFormat] = useState<"json" | "zip">("json");
  const [exportRes, setExportRes] = useState<SnapshotExportResult | null>(null);
  const [importJson, setImportJson] = useState("");
  const [importPath, setImportPath] = useState("");
  const [importRes, setImportRes] = useState<SnapshotImportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [updaterCfg, setUpdaterCfg] = useState<UpdaterConfigInfo | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);

  useEffect(() => {
    if (open) {
      void getUpdaterConfig().then(setUpdaterCfg).catch(() => {});
    }
  }, [open]);

  const handleExport = async () => {
    setErrorMsg(null);
    try {
      const res = await exportProjectSnapshot({
        projectId: activeProjectId ?? undefined,
        format,
        kasConfig: "header:\n  version: 14\nmachine: imx8mp-lpddr4-evk\ndistro: poky\n",
        openvexRecords: [{ cve_id: "CVE-2025-29911", status: "fixed" }],
        incompatibleLicenses: ["GPL-3.0-only"],
      });
      setExportRes(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImport = async () => {
    setErrorMsg(null);
    try {
      const res = await importProjectSnapshot({
        inputPath: importPath || undefined,
        rawJson: importJson || undefined,
      });
      setImportRes(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCheckUpdate = async () => {
    const res = await checkAppUpdate();
    setUpdateCheck(res);
    const cfg = await getUpdaterConfig();
    setUpdaterCfg(cfg);
  };

  const handleToggleAutoCheck = async (val: boolean) => {
    await setUpdaterAutoCheck(val);
    setUpdaterCfg((prev) => (prev ? { ...prev, auto_check: val } : prev));
  };

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={t("enterprise.snapshot.modalTitle")}
      subtitle={t("enterprise.snapshot.modalSubtitle")}
    >
      <div className="space-y-3 text-xs">
        <div className="flex items-center gap-1.5 border-b border-border pb-2">
          <Button
            size="sm"
            variant={tab === "export" ? "primary" : "secondary"}
            onClick={() => setTab("export")}
          >
            <Download className="h-3.5 w-3.5" />
            {t("enterprise.snapshot.exportTab")}
          </Button>
          <Button
            size="sm"
            variant={tab === "import" ? "primary" : "secondary"}
            onClick={() => setTab("import")}
          >
            <Upload className="h-3.5 w-3.5" />
            {t("enterprise.snapshot.importTab")}
          </Button>
          <Button
            size="sm"
            variant={tab === "updater" ? "primary" : "secondary"}
            onClick={() => setTab("updater")}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("enterprise.snapshot.updaterTab")}
          </Button>
        </div>

        {errorMsg && (
          <div className="rounded border border-danger/40 bg-danger/10 p-2 text-danger">
            {errorMsg}
          </div>
        )}

        {tab === "export" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded border border-success/40 bg-success/10 p-2.5 text-success">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              <span>{t("enterprise.snapshot.securityBadge")}</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-muted">{t("enterprise.snapshot.formatLabel")}:</span>
              {(["json", "zip"] as const).map((fmt) => (
                <Button
                  key={fmt}
                  size="sm"
                  variant={format === fmt ? "primary" : "secondary"}
                  onClick={() => setFormat(fmt)}
                >
                  .{fmt === "zip" ? "yoctostudio.zip" : "yoctostudio (JSON)"}
                </Button>
              ))}
            </div>

            <Button variant="primary" size="sm" onClick={() => void handleExport()}>
              <Download className="h-3.5 w-3.5" />
              {t("enterprise.snapshot.exportBtn")}
            </Button>

            {exportRes && (
              <div className="space-y-2 rounded border border-border bg-bg/70 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-success mono-num truncate">
                    {exportRes.path}
                  </span>
                  <Badge tone="ok">
                    {t("enterprise.snapshot.secretsStripped", {
                      count: exportRes.stripped_secret_count,
                    })}
                  </Badge>
                </div>
                <div className="mono-num text-[10px] text-muted truncate">
                  SHA-256: {exportRes.sha256} ({exportRes.size_bytes} bytes)
                </div>
                <pre className="max-h-40 overflow-auto rounded bg-bg p-2 text-[10px] mono-num">
                  {exportRes.preview_json}
                </pre>
              </div>
            )}
          </div>
        )}

        {tab === "import" && (
          <div className="space-y-3">
            <Input
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
              placeholder={t("enterprise.snapshot.importPathPlaceholder")}
            />
            <textarea
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              rows={6}
              placeholder={t("enterprise.snapshot.importJsonPlaceholder")}
              className="w-full rounded border border-border bg-bg p-2 text-[11px] mono-num focus:border-accent focus:outline-none"
            />
            <Button variant="primary" size="sm" onClick={() => void handleImport()}>
              <Upload className="h-3.5 w-3.5" />
              {t("enterprise.snapshot.importBtn")}
            </Button>
            {importRes && (
              <div className="rounded border border-success/40 bg-success/10 p-2.5 text-success space-y-0.5">
                <div className="font-semibold">
                  {t("enterprise.snapshot.importedTitle", { name: importRes.project_name })}
                </div>
                <div>
                  {t("enterprise.snapshot.importedCounts", {
                    targets: importRes.target_profiles_imported,
                    providers: importRes.provider_profiles_imported,
                    vex: importRes.openvex_count,
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "updater" && (
          <div className="space-y-3">
            {updaterCfg && (
              <div className="rounded border border-border bg-bg/70 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Tauri v2 Signed Auto-Updater</span>
                  <Badge tone={updaterCfg.pubkey_configured ? "ok" : "warn"}>
                    v{updaterCfg.current_version} ({updaterCfg.channel})
                  </Badge>
                </div>
                <div className="mono-num text-[10px] text-muted truncate">
                  Endpoint: {updaterCfg.endpoints[0]}
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span>{t("enterprise.snapshot.autoCheckLabel")}</span>
                  <Switch
                    checked={updaterCfg.auto_check}
                    onCheckedChange={(v) => void handleToggleAutoCheck(v)}
                  />
                </div>
              </div>
            )}

            <Button variant="primary" size="sm" onClick={() => void handleCheckUpdate()}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t("enterprise.snapshot.checkUpdateBtn")}
            </Button>

            {updateCheck && (
              <div className="rounded border border-accent/40 bg-accent/10 p-2.5 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{updateCheck.message}</span>
                  {updateCheck.signature_verified_manifest && (
                    <Badge tone="ok">Signed Manifest</Badge>
                  )}
                </div>
                {updateCheck.release_notes && (
                  <div className="text-[11px] text-muted">{updateCheck.release_notes}</div>
                )}
                {updateCheck.download_url && (
                  <div className="mono-num text-[10px] text-accent truncate" title={updateCheck.download_url}>
                    {t("enterprise.snapshot.packageUrl", { url: updateCheck.download_url })}
                  </div>
                )}
                <div className="mono-num text-[10px] text-muted">
                  {t("enterprise.snapshot.checkedAt", { at: updateCheck.checked_at })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
