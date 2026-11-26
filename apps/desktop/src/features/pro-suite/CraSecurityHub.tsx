import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, FileArchive, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { proRpc } from "@/lib/proSuiteApi";
import { formatBytes } from "@/lib/utils";

export const OPENVEX_JUSTIFICATIONS = [
  "component_not_present",
  "vulnerable_code_not_present",
  "vulnerable_code_not_in_execute_path",
  "vulnerable_code_cannot_be_controlled_by_adversary",
  "inline_mitigations_already_exist",
] as const;

export function CraSecurityHub() {
  const { t } = useTranslation();
  const vexQ = useQuery({
    queryKey: ["pro-cra-vex"],
    queryFn: () => proRpc.listVex(),
  });

  const [bundleInfo, setBundleInfo] = useState<Awaited<ReturnType<typeof proRpc.exportCraBundle>> | null>(
    null
  );

  // Secure Boot state
  const [enableFit, setEnableFit] = useState(true);
  const [keyDir, setKeyDir] = useState("${TOPDIR}/keys/dev-fit");
  const [keyName, setKeyName] = useState("dev-fit-key");
  const [keyBits, setKeyBits] = useState(2048);
  const [enableVerity, setEnableVerity] = useState(true);
  const [verityImg, setVerityImg] = useState("core-image-minimal");
  const [verityDev, setVerityDev] = useState("/dev/mmcblk2p2");
  const [secBootRes, setSecBootRes] = useState<Awaited<
    ReturnType<typeof proRpc.generateSecureBoot>
  > | null>(null);

  const updateVexM = useMutation({
    mutationFn: (params: {
      cve_id: string;
      status: "not_affected" | "fixed" | "affected" | "under_investigation";
      justification?: string;
      impact_statement?: string;
    }) => proRpc.updateVex(params),
    onSuccess: () => void vexQ.refetch(),
  });

  const exportBundleM = useMutation({
    mutationFn: () => proRpc.exportCraBundle(),
    onSuccess: (res) => setBundleInfo(res),
  });

  const genSecBootM = useMutation({
    mutationFn: () =>
      proRpc.generateSecureBoot({
        enable_fit_sign: enableFit,
        key_dir: keyDir,
        key_name: keyName,
        key_bits: keyBits,
        enable_dm_verity: enableVerity,
        verity_image: verityImg,
        verity_data_dev: verityDev,
      }),
    onSuccess: (res) => setSecBootRes(res),
  });

  return (
    <div className="space-y-4">
      {/* EU CRA OpenVEX Triage */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-accent" />
              {t("pro.craTitle")}
            </h2>
            <p className="text-xs text-muted">
              {t("pro.productPurl")} <code className="mono-num">{vexQ.data?.product_purl ?? "—"}</code>
            </p>
          </div>
          <Button
            size="sm"
            variant="primary"
            onClick={() => exportBundleM.mutate()}
            disabled={exportBundleM.isPending}
          >
            <FileArchive className="h-3.5 w-3.5" />
            {t("pro.exportCraBundle")}
          </Button>
        </div>

        {bundleInfo && (
          <div className="rounded border border-success/40 bg-success/10 p-2.5 text-xs mono-num text-success">
            {t("pro.bundleCreated", {
              path: bundleInfo.bundle_path,
              size: formatBytes(bundleInfo.size_bytes),
              files: bundleInfo.files.join(", "),
            })}
          </div>
        )}

        <div className="space-y-2 text-xs">
          {vexQ.data?.entries.map((e) => (
            <div key={e.cve_id} className="rounded border border-border bg-bg p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold mono-num text-fg flex items-center gap-2">
                  <span>
                    {e.cve_id} · {e.package} ({e.version})
                  </span>
                  <Badge tone={e.severity === "HIGH" || e.severity === "CRITICAL" ? "danger" : "warn"}>
                    {e.severity} {e.cvss}
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <select
                    value={e.status}
                    onChange={(ev) =>
                      updateVexM.mutate({
                        cve_id: e.cve_id,
                        status: ev.target.value as typeof e.status,
                        justification: e.justification ?? OPENVEX_JUSTIFICATIONS[2],
                        impact_statement: e.impact_statement ?? "",
                      })
                    }
                    className="h-7 rounded border border-border bg-surface px-2 text-xs text-fg"
                  >
                    <option value="under_investigation">under_investigation</option>
                    <option value="not_affected">not_affected</option>
                    <option value="fixed">fixed</option>
                    <option value="affected">affected</option>
                  </select>

                  {e.status === "not_affected" && (
                    <select
                      value={e.justification ?? OPENVEX_JUSTIFICATIONS[2]}
                      onChange={(ev) =>
                        updateVexM.mutate({
                          cve_id: e.cve_id,
                          status: "not_affected",
                          justification: ev.target.value,
                          impact_statement: e.impact_statement ?? "",
                        })
                      }
                      className="h-7 rounded border border-border bg-surface px-2 text-xs text-fg mono-num"
                    >
                      {OPENVEX_JUSTIFICATIONS.map((j) => (
                        <option key={j} value={j}>
                          {j}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              <div className="text-muted">{e.impact_statement || t("pro.noImpactStatement")}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Secure Boot FIT & dm-verity Wizard */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-accent" />
            {t("pro.secBootTitle")}
          </h2>
          <Button size="sm" variant="primary" onClick={() => genSecBootM.mutate()}>
            {t("pro.genSecBoot")}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enableFit}
              onChange={(e) => setEnableFit(e.target.checked)}
              className="accent-accent"
            />
            UBOOT_SIGN_ENABLE (FIT Verified Boot)
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enableVerity}
              onChange={(e) => setEnableVerity(e.target.checked)}
              className="accent-accent"
            />
            dm-verity Read-Only Rootfs
          </label>
          <select
            value={keyBits}
            onChange={(e) => setKeyBits(Number(e.target.value))}
            className="h-8 rounded border border-border bg-bg px-2 text-xs text-fg"
          >
            <option value={2048}>RSA-2048 (Dev Test)</option>
            <option value={4096}>RSA-4096 (Dev Test)</option>
          </select>
          <Input value={keyDir} onChange={(e) => setKeyDir(e.target.value)} placeholder="UBOOT_SIGN_KEYDIR" />
          <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="UBOOT_SIGN_KEYNAME" />
          <div className="flex gap-1.5">
            <Input value={verityImg} onChange={(e) => setVerityImg(e.target.value)} placeholder="DM_VERITY_IMAGE" />
            <Input value={verityDev} onChange={(e) => setVerityDev(e.target.value)} placeholder="/dev/mmcblk2p2" />
          </div>
        </div>

        {secBootRes && (
          <div className="space-y-2 text-xs">
            <div className="rounded border border-warning/40 bg-warning/10 p-2.5 flex items-center gap-2 text-warning">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{secBootRes.production_warning}</span>
            </div>
            <pre className="rounded border border-border bg-bg p-3 mono-num text-[11px] text-accent overflow-x-auto">
              {secBootRes.inc_content}
            </pre>
            <pre className="rounded border border-border bg-bg p-2.5 mono-num text-[11px] text-muted overflow-x-auto">
              {secBootRes.keygen_commands.join("\n")}
            </pre>
          </div>
        )}
      </Card>
    </div>
  );
}
