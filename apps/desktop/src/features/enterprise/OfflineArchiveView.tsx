import { useQuery } from "@tanstack/react-query";
import type { ArchiverBundleResult, OfflineMirrorPlan } from "@yocto-studio/shared-protocol";
import { Archive, CheckCircle2, Lock, Search, ShieldAlert, WifiOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input, Switch } from "@/components/ui/primitives";
import { enterpriseRpc } from "@/lib/enterpriseApi";

export function OfflineArchiveView() {
  const { t } = useTranslation();
  const [layerFilter, setLayerFilter] = useState("");
  const [pinnedDiff, setPinnedDiff] = useState("");
  const [target, setTarget] = useState("core-image-minimal");
  const [mirrorDir, setMirrorDir] = useState("/home/yocto/airgap-mirror/downloads");
  const [enableNoNetwork, setEnableNoNetwork] = useState(true);
  const [mirrorPlan, setMirrorPlan] = useState<OfflineMirrorPlan | null>(null);

  const [archMode, setArchMode] = useState<"original" | "patched">("patched");
  const [gplOnly, setGplOnly] = useState(true);
  const [archiveRes, setArchiveRes] = useState<ArchiverBundleResult | null>(null);

  const autorevQuery = useQuery({
    queryKey: ["enterprise-autorev", layerFilter],
    queryFn: () => enterpriseRpc.scanAutorev(layerFilter || undefined),
  });

  const handlePinAll = async (ids: string[]) => {
    const res = await enterpriseRpc.pinAutorev(ids);
    setPinnedDiff(res.combined_diff);
    await autorevQuery.refetch();
  };

  const handlePrepareMirror = async () => {
    const res = await enterpriseRpc.prepareMirror({
      target,
      mirror_dir: mirrorDir,
      enable_no_network: enableNoNetwork,
      apply_config: true,
    });
    setMirrorPlan(res);
  };

  const handleExportArchiver = async () => {
    const res = await enterpriseRpc.configureArchiver({
      mode: archMode,
      gpl_only: gplOnly,
      apply_config: true,
      export_bundle: true,
    });
    setArchiveRes(res);
  };

  const findings = autorevQuery.data?.findings ?? [];

  return (
    <div className="space-y-4">
      {/* Section 1: AUTOREV Scanner */}
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-warning" />
            <span className="text-xs font-semibold">{t("enterprise.offline.autorevTitle")}</span>
            <Badge tone={findings.length > 0 ? "warn" : "ok"}>
              {findings.length} AUTOREV
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Input
              className="w-44"
              value={layerFilter}
              onChange={(e) => setLayerFilter(e.target.value)}
              placeholder={t("enterprise.offline.layerFilterPlaceholder")}
            />
            <Button variant="secondary" size="sm" onClick={() => void autorevQuery.refetch()}>
              <Search className="h-3.5 w-3.5" />
              {t("enterprise.offline.scanBtn")}
            </Button>
            {findings.length > 0 && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handlePinAll(findings.map((f) => f.id))}
              >
                <Lock className="h-3.5 w-3.5" />
                {t("enterprise.offline.pinSelectedBtn")}
              </Button>
            )}
          </div>
        </div>

        {findings.length === 0 ? (
          <div className="flex items-center gap-2 rounded border border-success/30 bg-success/10 p-3 text-xs text-success">
            <CheckCircle2 className="h-4 w-4" />
            {t("enterprise.offline.allPinnedMsg")}
          </div>
        ) : (
          <div className="space-y-2">
            {findings.map((f) => (
              <div
                key={f.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-bg/70 p-2.5 text-xs"
              >
                <div className="space-y-0.5">
                  <div className="font-semibold mono-num">
                    {f.recipe}{" "}
                    <span className="text-muted">
                      ({f.file_path}:{f.line_number})
                    </span>
                  </div>
                  <div className="mono-num text-[11px] text-warning">{f.current_line}</div>
                  <div className="mono-num text-[11px] text-success">→ {f.suggested_line}</div>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void handlePinAll([f.id])}>
                  <Lock className="h-3 w-3" />
                  {t("enterprise.offline.pinSingleBtn")}
                </Button>
              </div>
            ))}
          </div>
        )}

        {pinnedDiff && (
          <pre className="max-h-40 overflow-auto rounded bg-bg p-2.5 text-[11px] mono-num">
            {pinnedDiff}
          </pre>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Section 2: Offline Mirror Tarball & BB_NO_NETWORK */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <WifiOff className="h-4 w-4 text-accent" />
            {t("enterprise.offline.mirrorTitle")}
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="space-y-1">
              <span className="text-muted">{t("enterprise.offline.targetImageLabel")}</span>
              <Input value={target} onChange={(e) => setTarget(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-muted">SOURCE_MIRROR_URL (file://)</span>
              <Input value={mirrorDir} onChange={(e) => setMirrorDir(e.target.value)} />
            </label>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span>BB_NO_NETWORK = "1" + own-mirrors</span>
            <Switch checked={enableNoNetwork} onCheckedChange={setEnableNoNetwork} />
          </div>
          <Button variant="primary" size="sm" onClick={() => void handlePrepareMirror()}>
            {t("enterprise.offline.prepareBtn")}
          </Button>
          {mirrorPlan && (
            <div className="space-y-2 pt-1">
              <div className="text-xs text-success">{mirrorPlan.summary}</div>
              <pre className="rounded bg-bg p-2 text-[11px] mono-num overflow-auto">
                {mirrorPlan.commands.join("\n")}
              </pre>
              {mirrorPlan.local_conf_diff && (
                <pre className="max-h-36 rounded bg-bg p-2 text-[11px] mono-num overflow-auto">
                  {mirrorPlan.local_conf_diff}
                </pre>
              )}
            </div>
          )}
        </Card>

        {/* Section 3: GPL/LGPL Source Archiver */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Archive className="h-4 w-4 text-accent" />
            {t("enterprise.offline.archiverTitle")}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">ARCHIVER_MODE[src]:</span>
            {(["original", "patched"] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={archMode === m ? "primary" : "secondary"}
                onClick={() => setArchMode(m)}
              >
                {m}
              </Button>
            ))}
          </div>
          <div className="flex items-center justify-between text-xs">
            <span>{t("enterprise.offline.copyleftOnly")}</span>
            <Switch checked={gplOnly} onCheckedChange={setGplOnly} />
          </div>
          <Button variant="primary" size="sm" onClick={() => void handleExportArchiver()}>
            {t("enterprise.offline.exportArchiveBtn")}
          </Button>
          {archiveRes && (
            <div className="space-y-1.5 rounded border border-border bg-bg/70 p-2.5 text-[11px] mono-num">
              <div className="text-success font-semibold">
                {t("enterprise.offline.archivedResult", {
                  count: archiveRes.package_count,
                  bytes: archiveRes.size_bytes,
                })}
              </div>
              <div className="truncate" title={archiveRes.archive_path}>
                {t("enterprise.offline.fileLabel", { path: archiveRes.archive_path })}
              </div>
              <div className="truncate" title={archiveRes.sha256}>
                SHA-256: {archiveRes.sha256}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
