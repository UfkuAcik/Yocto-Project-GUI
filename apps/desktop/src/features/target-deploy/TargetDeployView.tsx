import * as Tabs from "@radix-ui/react-tabs";
import { Activity, Cpu, Network, Settings2, TerminalSquare, Usb } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Switch } from "@/components/ui/primitives";
import { EthernetDeployView } from "@/features/target-deploy/EthernetDeployView";
import { SerialConsoleTab } from "@/features/target-deploy/SerialConsoleTab";
import { TargetProfilesPanel } from "@/features/target-deploy/TargetProfilesPanel";
import { ToolHealthBanner } from "@/features/target-deploy/ToolHealthBanner";
import { UsbFlashView } from "@/features/target-deploy/UsbFlashView";
import { useAppStore } from "@/stores/appStore";
import { useDeployStore } from "@/stores/deployStore";

export function TargetDeployView() {
  const { t } = useTranslation();
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const [subTab, setSubTab] = useState<"usb" | "ethernet" | "profiles">("usb");
  const {
    selectedArtifact,
    profiles,
    activeProfileId,
    setActiveProfileId,
    mockMode,
    setMockMode,
    splitSerialOpen,
    setSplitSerialOpen,
  } = useDeployStore();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-fg flex items-center gap-2">
            <Cpu className="h-4 w-4 text-accent" />
            {t("deploy.title")}
          </h1>
          <p className="text-xs text-muted">{t("deploy.subtitle")}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {profiles.length > 0 && (
            <select
              value={activeProfileId ?? ""}
              onChange={(e) => setActiveProfileId(e.target.value)}
              className="h-8 rounded-md border border-border bg-surface px-2.5 text-xs text-fg"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {t("deploy.profileOption", { name: p.name, machine: p.machine })}
                </option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs">
            <Switch checked={mockMode} onCheckedChange={setMockMode} />
            <span className="text-fg">{t("deploy.mockHardware")}</span>
          </div>
          <Button
            size="sm"
            variant={splitSerialOpen ? "primary" : "secondary"}
            onClick={() => setSplitSerialOpen(!splitSerialOpen)}
          >
            <TerminalSquare className="h-3.5 w-3.5" />
            {splitSerialOpen ? t("deploy.closeSplitUart") : t("deploy.openSplitUart")}
          </Button>
          <Button size="sm" onClick={() => setActiveModule("pro")}>
            <Activity className="h-3.5 w-3.5 text-accent" />
            {t("deploy.runQaBoot")}
          </Button>
        </div>
      </div>

      {selectedArtifact && (
        <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2">
          <span>
            {t("deploy.transferredArtifact")}{" "}
            <strong className="mono-num text-fg">{selectedArtifact.filename}</strong>
          </span>
          <Badge tone="accent">{selectedArtifact.kind}</Badge>
        </div>
      )}

      <ToolHealthBanner />

      <div className={splitSerialOpen ? "grid grid-cols-1 gap-4 xl:grid-cols-12" : ""}>
        <div className={splitSerialOpen ? "xl:col-span-7" : ""}>
          <Tabs.Root value={subTab} onValueChange={(v) => setSubTab(v as "usb" | "ethernet" | "profiles")}>
            <Tabs.List className="flex flex-wrap gap-1 border-b border-border pb-2 mb-4">
              <Tabs.Trigger
                value="usb"
                className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-xs font-medium text-muted hover:text-fg hover:bg-elevated data-[state=active]:border-accent/40 data-[state=active]:bg-accent/15 data-[state=active]:text-accent cursor-pointer"
              >
                <Usb className="h-3.5 w-3.5" />
                {t("deploy.tabUsb")}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="ethernet"
                className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-xs font-medium text-muted hover:text-fg hover:bg-elevated data-[state=active]:border-accent/40 data-[state=active]:bg-accent/15 data-[state=active]:text-accent cursor-pointer"
              >
                <Network className="h-3.5 w-3.5" />
                {t("deploy.tabEthernet")}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="profiles"
                className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-xs font-medium text-muted hover:text-fg hover:bg-elevated data-[state=active]:border-accent/40 data-[state=active]:bg-accent/15 data-[state=active]:text-accent cursor-pointer"
              >
                <Settings2 className="h-3.5 w-3.5" />
                {t("deploy.tabProfiles", { count: profiles.length })}
              </Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="usb">
              <UsbFlashView />
            </Tabs.Content>
            <Tabs.Content value="ethernet">
              <EthernetDeployView />
            </Tabs.Content>
            <Tabs.Content value="profiles">
              <TargetProfilesPanel />
            </Tabs.Content>
          </Tabs.Root>
        </div>

        {splitSerialOpen && (
          <Card className="xl:col-span-5 flex flex-col p-0 overflow-hidden min-h-[540px]">
            <div className="border-b border-border bg-surface px-3 py-2 text-xs font-semibold text-fg flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <TerminalSquare className="h-3.5 w-3.5 text-accent" />
                {t("deploy.splitSerialTitle")}
              </span>
              <Badge tone="accent">Split View</Badge>
            </div>
            <div className="flex-1 min-h-0">
              <SerialConsoleTab />
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
