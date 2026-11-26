import type { PreFlightAuditReport, PreFlightFixAction } from "@yocto-studio/shared-protocol";
import { PackageMinus, ShieldAlert, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { usePreFlightStore } from "@/stores/preflightStore";

export function BloatDetectorView({
  report,
  onRerunAudit,
  onPreviewFix,
}: {
  report: PreFlightAuditReport | null;
  onRerunAudit: (licenses: string[]) => void;
  onPreviewFix: (fix: PreFlightFixAction) => void;
}) {
  const { t } = useTranslation();
  const { incompatibleLicenses, setIncompatibleLicenses } = usePreFlightStore();
  const [policyInput, setPolicyInput] = useState(incompatibleLicenses.join(" "));

  function applyPolicy() {
    const tokens = policyInput
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setIncompatibleLicenses(tokens);
    onRerunAudit(tokens);
  }

  return (
    <div className="space-y-4">
      {/* License Shield */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-warning" />
            {t("preflight.licenseShieldTitle")}
          </h2>
          <div className="flex items-center gap-2">
            <Input
              value={policyInput}
              onChange={(e) => setPolicyInput(e.target.value)}
              placeholder={t("preflight.licensePlaceholder")}
              className="w-56 mono-num"
            />
            <Button size="sm" variant="primary" onClick={applyPolicy}>
              {t("preflight.checkPolicyBtn")}
            </Button>
          </div>
        </div>

        {!report?.license_violations.length ? (
          <div className="rounded border border-success/40 bg-success/10 p-3 text-xs text-success">
            {t("preflight.noLicenseViolations", {
              list: incompatibleLicenses.join(", ") || t("preflight.none"),
            })}
          </div>
        ) : (
          <div className="space-y-2">
            {report.license_violations.map((v) => (
              <div
                key={`${v.package}-${v.license}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-bg p-3 text-xs"
              >
                <div className="space-y-1">
                  <div className="font-semibold text-fg mono-num flex items-center gap-2">
                    {v.package} ({v.version})
                    <Badge tone="danger">{v.license}</Badge>
                    <Badge tone="neutral">
                      {t("preflight.policyRule", { rule: v.policy_rule })}
                    </Badge>
                  </div>
                  <div className="text-muted mono-num text-[11px]">
                    {t("preflight.inclusionChain", { chain: v.chain.join(" → ") })}
                  </div>
                </div>
                {v.auto_fix && (
                  <Button size="sm" variant="primary" onClick={() => onPreviewFix(v.auto_fix!)}>
                    <Sparkles className="h-3 w-3" />
                    {v.auto_fix.label}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Bloat Detector */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <PackageMinus className="h-4 w-4 text-accent" />
            {t("preflight.bloatTitle")}
          </h2>
          <Badge tone={report?.bloat_items.length ? "warn" : "ok"}>
            {t("preflight.bloatCount", { count: report?.bloat_items.length ?? 0 })}
          </Badge>
        </div>

        {!report?.bloat_items.length ? (
          <div className="rounded border border-success/40 bg-success/10 p-3 text-xs text-success">
            {t("preflight.noBloatFound")}
          </div>
        ) : (
          <div className="space-y-2">
            {report.bloat_items.map((b) => (
              <div
                key={b.package}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-bg p-3 text-xs"
              >
                <div className="space-y-1">
                  <div className="font-semibold text-fg flex items-center gap-2">
                    <span className="mono-num">{b.package}</span>
                    <Badge tone="warn">+{b.estimated_rootfs_mb} MiB rootfs</Badge>
                    <Badge tone="neutral">
                      {t("preflight.bloatTimeBadge", { min: b.estimated_build_min })}
                    </Badge>
                  </div>
                  <div className="text-muted">{b.reason}</div>
                  <div className="mono-num text-[11px] text-accent">
                    {t("preflight.bloatWhyChain", { chain: b.chain.join(" → ") })}
                  </div>
                </div>
                {b.auto_fix && (
                  <Button size="sm" variant="primary" onClick={() => onPreviewFix(b.auto_fix!)}>
                    <Sparkles className="h-3 w-3" />
                    {b.auto_fix.label}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
