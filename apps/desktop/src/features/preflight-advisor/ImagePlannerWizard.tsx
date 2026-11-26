import { AlertTriangle, CheckCircle2, Compass, Cpu, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { rpcClient } from "@/lib/rpcClient";
import { type ImageScenarioId, validateImagePlanHardware } from "@/stores/preflightStore";

const SCENARIOS: Array<{
  id: ImageScenarioId;
  titleKey: string;
  baseImage: string;
  rootfsMb: number;
  buildMin: number;
  summaryKey: string;
}> = [
  {
    id: "headless-iot",
    titleKey: "preflight.scenarios.headlessTitle",
    baseImage: "core-image-minimal",
    rootfsMb: 38,
    buildMin: 18,
    summaryKey: "preflight.scenarios.headlessSummary",
  },
  {
    id: "industrial-gateway",
    titleKey: "preflight.scenarios.gatewayTitle",
    baseImage: "core-image-base",
    rootfsMb: 92,
    buildMin: 31,
    summaryKey: "preflight.scenarios.gatewaySummary",
  },
  {
    id: "graphical-hmi",
    titleKey: "preflight.scenarios.hmiTitle",
    baseImage: "core-image-weston",
    rootfsMb: 245,
    buildMin: 58,
    summaryKey: "preflight.scenarios.hmiSummary",
  },
  {
    id: "hardware-test",
    titleKey: "preflight.scenarios.hwtestTitle",
    baseImage: "core-image-base",
    rootfsMb: 148,
    buildMin: 36,
    summaryKey: "preflight.scenarios.hwtestSummary",
  },
];

const HW_FEATURES = ["gpu", "wifi", "bluetooth", "pcie", "can", "usbhost", "usbgadget", "ethernet"];

export function ImagePlannerWizard({ onPlanApplied }: { onPlanApplied: () => void }) {
  const { t } = useTranslation();
  const [scenario, setScenario] = useState<ImageScenarioId>("headless-iot");
  const [machineFeatures, setMachineFeatures] = useState<string[]>([
    "wifi",
    "bluetooth",
    "can",
    "ethernet",
    "usbhost",
  ]);
  const [rootfsFormat, setRootfsFormat] = useState<"wic.bz2" | "ext4" | "squashfs">("wic.bz2");
  const [pkgClass, setPkgClass] = useState<"package_ipk" | "package_rpm" | "package_deb">("package_ipk");
  const [diffPreview, setDiffPreview] = useState<string | null>(null);
  const [appliedMeta, setAppliedMeta] = useState<{ baseImage: string; titleKey: string } | null>(null);

  const selectedMeta = SCENARIOS.find((s) => s.id === scenario) ?? SCENARIOS[0];
  const hwValidation = validateImagePlanHardware(scenario, machineFeatures);

  function toggleHwFeature(feat: string) {
    setMachineFeatures((prev) =>
      prev.includes(feat) ? prev.filter((x) => x !== feat) : [...prev, feat]
    );
  }

  function buildPlannedChanges(): Record<string, string> {
    return {
      INIT_MANAGER: "systemd",
      PACKAGE_CLASSES: pkgClass,
      IMAGE_FSTYPES: rootfsFormat === "squashfs" ? "squashfs wic.bz2" : rootfsFormat,
      DISTRO_FEATURES: hwValidation.recommendedDistroFeatures.join(" "),
      "IMAGE_INSTALL:append": ` ${hwValidation.extraPackages.join(" ")}`,
    };
  }

  async function handlePreviewPlan() {
    setAppliedMeta(null);
    const res = await rpcClient.call("config.preview_diff", { updates: buildPlannedChanges() });
    setDiffPreview(res.diff || t("preflight.noDiffComment"));
  }

  async function handleApplyPlan() {
    await rpcClient.call("config.apply_changes", { updates: buildPlannedChanges() });
    setDiffPreview(null);
    setAppliedMeta({ baseImage: selectedMeta.baseImage, titleKey: selectedMeta.titleKey });
    onPlanApplied();
  }

  const sizeFactor = rootfsFormat === "squashfs" ? 0.65 : 1.0;
  const estSize = Math.round(selectedMeta.rootfsMb * sizeFactor);

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <Compass className="h-4 w-4 text-accent" />
            {t("preflight.wizardStep1")}
          </h2>
          <Badge tone="accent">
            {t("preflight.wizardEstBadge", { size: estSize, min: selectedMeta.buildMin })}
          </Badge>
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {SCENARIOS.map((sc) => (
            <button
              key={sc.id}
              type="button"
              onClick={() => setScenario(sc.id)}
              className={`rounded-md border p-3 text-left text-xs cursor-pointer ${
                scenario === sc.id ? "border-accent bg-accent/10" : "border-border bg-bg hover:bg-elevated"
              }`}
            >
              <div className="font-semibold text-fg flex items-center justify-between">
                <span>{t(sc.titleKey)}</span>
                <Badge>{sc.baseImage}</Badge>
              </div>
              <div className="text-muted mt-1">{t(sc.summaryKey)}</div>
            </button>
          ))}
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
          <Cpu className="h-4 w-4 text-accent" />
          {t("preflight.wizardStep2")}
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {HW_FEATURES.map((feat) => {
            const active = machineFeatures.includes(feat);
            return (
              <Button
                key={feat}
                size="sm"
                variant={active ? "primary" : "secondary"}
                onClick={() => toggleHwFeature(feat)}
              >
                {feat}
              </Button>
            );
          })}
        </div>
        {hwValidation.warnings.map((w) => (
          <div
            key={w}
            className="flex items-center gap-2 rounded border border-warning/40 bg-warning/10 p-2.5 text-xs text-warning"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{w}</span>
          </div>
        ))}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" />
          {t("preflight.wizardStep3")}
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
          <div>
            <label className="text-[11px] text-muted">{t("preflight.rootfsFormat")}</label>
            <select
              value={rootfsFormat}
              onChange={(e) => setRootfsFormat(e.target.value as "wic.bz2" | "ext4" | "squashfs")}
              className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg"
            >
              <option value="wic.bz2">{t("preflight.fstypeWic")}</option>
              <option value="ext4">{t("preflight.fstypeExt4")}</option>
              <option value="squashfs">{t("preflight.fstypeSquash")}</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] text-muted">{t("preflight.pkgManager")}</label>
            <select
              value={pkgClass}
              onChange={(e) =>
                setPkgClass(e.target.value as "package_ipk" | "package_rpm" | "package_deb")
              }
              className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg"
            >
              <option value="package_ipk">{t("preflight.pkgIpk")}</option>
              <option value="package_rpm">{t("preflight.pkgRpm")}</option>
              <option value="package_deb">{t("preflight.pkgDeb")}</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] text-muted">{t("preflight.addedPackages")}</label>
            <div className="rounded border border-border bg-bg px-2 py-1.5 mono-num text-[11px] text-muted truncate">
              {hwValidation.extraPackages.join(", ")}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={() => void handlePreviewPlan()}>{t("preflight.previewDiffBtn")}</Button>
          <Button variant="primary" onClick={() => void handleApplyPlan()}>
            {t("preflight.applyPlanBtn")}
          </Button>
        </div>

        {diffPreview && (
          <pre className="rounded border border-border bg-bg p-3 mono-num text-[11px] text-accent overflow-x-auto">
            {diffPreview}
          </pre>
        )}
        {appliedMeta && (
          <div className="flex items-center gap-2 rounded border border-success/40 bg-success/10 p-2.5 text-xs text-success">
            <CheckCircle2 className="h-4 w-4" />
            <span>
              {t("preflight.planAppliedMsg", {
                image: appliedMeta.baseImage,
                title: t(appliedMeta.titleKey),
              })}
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}
