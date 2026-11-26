import {
  Activity,
  Archive,
  Building2,
  Cpu,
  Download,
  GitBranch,
  PieChart,
  RefreshCw,
  Server,
  Wand2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/primitives";
import { useAppStore } from "@/stores/appStore";
import { MultiLayerGitPanel } from "./MultiLayerGitPanel";
import { MigrationWizard } from "./MigrationWizard";
import { MulticonfigView } from "./MulticonfigView";
import { OfflineArchiveView } from "./OfflineArchiveView";
import { RemoteDebugView } from "./RemoteDebugView";
import { RootfsTreemapView } from "./RootfsTreemapView";
import { SstateAnalyticsView } from "./SstateAnalyticsView";

type EnterpriseTab = "multiconfig" | "offline" | "rootfs" | "sstate" | "debug" | "migration" | "git";

export function EnterpriseHubView() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<EnterpriseTab>("multiconfig");
  const setSnapshotModalOpen = useAppStore((s) => s.setSnapshotModalOpen);

  const tabs: Array<{ id: EnterpriseTab; label: string; icon: typeof Cpu }> = [
    { id: "multiconfig", label: t("enterprise.tabs.multiconfig"), icon: Cpu },
    { id: "offline", label: t("enterprise.tabs.offline"), icon: Archive },
    { id: "rootfs", label: t("enterprise.tabs.rootfs"), icon: PieChart },
    { id: "sstate", label: t("enterprise.tabs.sstate"), icon: Server },
    { id: "debug", label: t("enterprise.tabs.debug"), icon: Activity },
    { id: "migration", label: t("enterprise.tabs.migration"), icon: Wand2 },
    { id: "git", label: t("enterprise.tabs.git"), icon: GitBranch },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/15 border border-accent/40 text-accent">
            <Building2 className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-base font-bold tracking-tight">{t("enterprise.title")}</h2>
            <p className="text-xs text-muted">{t("enterprise.subtitle")}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setSnapshotModalOpen(true)}>
            <Download className="h-3.5 w-3.5 text-accent" />
            {t("enterprise.snapshotBtn")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setSnapshotModalOpen(true)}>
            <RefreshCw className="h-3.5 w-3.5 text-accent" />
            {t("enterprise.updaterBtn")}
          </Button>
        </div>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border pb-2">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <Button
              key={item.id}
              size="sm"
              variant={tab === item.id ? "primary" : "secondary"}
              onClick={() => setTab(item.id)}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </Button>
          );
        })}
      </div>

      {tab === "multiconfig" && <MulticonfigView />}
      {tab === "offline" && <OfflineArchiveView />}
      {tab === "rootfs" && <RootfsTreemapView />}
      {tab === "sstate" && <SstateAnalyticsView />}
      {tab === "debug" && <RemoteDebugView />}
      {tab === "migration" && <MigrationWizard />}
      {tab === "git" && <MultiLayerGitPanel />}
    </div>
  );
}
