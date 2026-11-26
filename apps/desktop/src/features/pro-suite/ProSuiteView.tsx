import * as Tabs from "@radix-ui/react-tabs";
import { Activity, BarChart3, Cpu, GitMerge, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/primitives";
import { BuildStatsView } from "@/features/pro-suite/BuildStatsView";
import { CiCdExportModal } from "@/features/pro-suite/CiCdExportModal";
import { CraSecurityHub } from "@/features/pro-suite/CraSecurityHub";
import { KernelDtStudio } from "@/features/pro-suite/KernelDtStudio";
import { QaBootProfiler } from "@/features/pro-suite/QaBootProfiler";

export function ProSuiteView() {
  const { t } = useTranslation();
  const [subTab, setSubTab] = useState<"kernel" | "qa" | "cra" | "buildstats">("kernel");
  const [cicdOpen, setCicdOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-fg flex items-center gap-2">
            <Cpu className="h-4 w-4 text-accent" />
            {t("pro.title")}
          </h1>
          <p className="text-xs text-muted">{t("pro.subtitle")}</p>
        </div>

        <Button variant="primary" onClick={() => setCicdOpen(true)}>
          <GitMerge className="h-3.5 w-3.5" />
          {t("pro.generateCiCd")}
        </Button>
      </div>

      <Tabs.Root value={subTab} onValueChange={(v) => setSubTab(v as typeof subTab)}>
        <Tabs.List className="flex flex-wrap gap-1 border-b border-border pb-2">
          {[
            { id: "kernel", label: t("pro.tabKernel"), icon: Cpu },
            { id: "qa", label: t("pro.tabQa"), icon: Activity },
            { id: "cra", label: t("pro.tabCra"), icon: ShieldCheck },
            { id: "buildstats", label: t("pro.tabBuildstats"), icon: BarChart3 },
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

        <Tabs.Content value="kernel" className="mt-4">
          <KernelDtStudio />
        </Tabs.Content>
        <Tabs.Content value="qa" className="mt-4">
          <QaBootProfiler />
        </Tabs.Content>
        <Tabs.Content value="cra" className="mt-4">
          <CraSecurityHub />
        </Tabs.Content>
        <Tabs.Content value="buildstats" className="mt-4">
          <BuildStatsView />
        </Tabs.Content>
      </Tabs.Root>

      <CiCdExportModal open={cicdOpen} onOpenChange={setCicdOpen} />
    </div>
  );
}
