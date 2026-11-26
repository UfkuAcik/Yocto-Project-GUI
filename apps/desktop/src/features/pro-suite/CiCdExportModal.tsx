import { useQuery } from "@tanstack/react-query";
import { Copy, Download, GitMerge } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Modal } from "@/components/ui/primitives";
import { proRpc } from "@/lib/proSuiteApi";
import { useAppStore } from "@/stores/appStore";
import { useBuildStore } from "@/stores/buildStore";

export function CiCdExportModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  const target = useBuildStore((s) => s.selectedBuildTarget);

  const [platform, setPlatform] = useState<"gitlab" | "github">("gitlab");
  const [setupTool, setSetupTool] = useState<string>(activeProject?.setup_tool ?? "kas");
  const [enablePreflight, setEnablePreflight] = useState(true);
  const [enableCveGate, setEnableCveGate] = useState(true);

  const ciQ = useQuery({
    queryKey: ["pro-cicd", platform, setupTool, enablePreflight, enableCveGate, target],
    queryFn: () =>
      proRpc.generateCiCd({
        platform,
        setup_tool: setupTool,
        machine: activeProject?.machine ?? "imx8mp-lpddr4-evk",
        target,
        enable_preflight_gate: enablePreflight,
        enable_cve_gate: enableCveGate,
      }),
    enabled: open,
  });

  function downloadYaml() {
    if (!ciQ.data) return;
    const blob = new Blob([ciQ.data.yaml_content], { type: "text/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ciQ.data.filename.split("/").pop() ?? "yocto-ci.yml";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("pro.cicdModalTitle")}
      subtitle={t("pro.cicdModalSubtitle")}
      wide
    >
      <div className="space-y-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={platform === "gitlab" ? "primary" : "secondary"}
              onClick={() => setPlatform("gitlab")}
            >
              <GitMerge className="h-3.5 w-3.5" />
              GitLab CI (.gitlab-ci.yml)
            </Button>
            <Button
              size="sm"
              variant={platform === "github" ? "primary" : "secondary"}
              onClick={() => setPlatform("github")}
            >
              GitHub Actions (yocto-ci.yml)
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select
              value={setupTool}
              onChange={(e) => setSetupTool(e.target.value)}
              className="h-7 rounded border border-border bg-bg px-2 text-xs text-fg"
            >
              <option value="kas">kas YAML</option>
              <option value="oe-init-build-env">oe-init-build-env</option>
            </select>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={enablePreflight}
                onChange={(e) => setEnablePreflight(e.target.checked)}
                className="accent-accent"
              />
              Pre-Flight
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={enableCveGate}
                onChange={(e) => setEnableCveGate(e.target.checked)}
                className="accent-accent"
              />
              CVE Gate
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <Badge tone="accent" className="mono-num">
            {ciQ.data?.filename ?? "—"}
          </Badge>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              onClick={() => void navigator.clipboard?.writeText(ciQ.data?.yaml_content ?? "")}
            >
              <Copy className="h-3 w-3" />
              {t("pro.copyBtn")}
            </Button>
            <Button size="sm" variant="primary" onClick={downloadYaml}>
              <Download className="h-3 w-3" />
              {t("pro.downloadYaml")}
            </Button>
          </div>
        </div>

        <pre className="max-h-96 overflow-auto rounded border border-border bg-bg p-3 mono-num text-[11px] text-accent">
          {ciQ.data?.yaml_content ?? t("pro.generating")}
        </pre>
      </div>
    </Modal>
  );
}
