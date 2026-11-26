import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Cpu, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import {
  deleteTargetProfile,
  listTargetProfiles,
  saveTargetProfile,
  type TargetProfileRecord,
} from "@/lib/deployApi";
import { useAppStore } from "@/stores/appStore";
import { useDeployStore } from "@/stores/deployStore";

export function TargetProfilesPanel() {
  const { t } = useTranslation();
  const activeProjectId = useAppStore((s) => s.activeProjectId) ?? "proj-wrynose-evk";
  const projects = useAppStore((s) => s.projects);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  const { activeProfileId, setProfiles, setActiveProfileId } = useDeployStore();

  const profilesQ = useQuery({
    queryKey: ["target-profiles", activeProjectId],
    queryFn: () => listTargetProfiles(activeProjectId),
  });

  useEffect(() => {
    if (profilesQ.data) {
      setProfiles(profilesQ.data);
    }
  }, [profilesQ.data, setProfiles]);

  const [draft, setDraft] = useState<TargetProfileRecord>({
    id: `tp-${Date.now()}`,
    project_id: activeProjectId,
    name: `${activeProject?.machine ?? "imx8mp-lpddr4-evk"}-TestBench`,
    machine: activeProject?.machine ?? "imx8mp-lpddr4-evk",
    preferred_method: "usb",
    usb_flasher: "raw_disk",
    target_ip: "192.168.10.50",
    ssh_user: "root",
    ssh_key_ref: "keyring://yocto/target-ssh",
    swupdate_url: "http://192.168.10.50:8080",
    uart_port: "mock://uart-imx8mp",
    uart_baud: 115200,
    ab_slots_json: '{"a":"/dev/mmcblk2p2","b":"/dev/mmcblk2p3"}',
    custom_cli_template: "uuu -b emmc_all {IMAGE_PATH}",
    created_at: new Date().toISOString(),
  });

  const saveM = useMutation({
    mutationFn: (rec: TargetProfileRecord) => saveTargetProfile(rec),
    onSuccess: (_, rec) => {
      setActiveProfileId(rec.id);
      void profilesQ.refetch();
    },
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => deleteTargetProfile(id),
    onSuccess: () => void profilesQ.refetch(),
  });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <Cpu className="h-4 w-4 text-accent" />
            {t("deploy.profilesTitle")}
          </h2>
          <Button
            size="sm"
            onClick={() =>
              setDraft({
                ...draft,
                id: `tp-${Date.now()}`,
                project_id: activeProjectId,
                created_at: new Date().toISOString(),
              })
            }
          >
            <Plus className="h-3.5 w-3.5" />
            {t("deploy.newProfile")}
          </Button>
        </div>

        {!profilesQ.data?.length ? (
          <div className="rounded border border-border bg-bg p-4 text-xs text-muted">
            {t("deploy.noProfilesEmpty")}
          </div>
        ) : (
          <div className="space-y-2">
            {profilesQ.data.map((p) => {
              const active = p.id === activeProfileId;
              return (
                <div
                  key={p.id}
                  className={`rounded-md border p-3 text-xs space-y-1.5 ${
                    active ? "border-accent bg-accent/10" : "border-border bg-bg"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-fg flex items-center gap-2">
                      {p.name}
                      <Badge tone="accent">{p.preferred_method.toUpperCase()}</Badge>
                      <Badge>{p.usb_flasher}</Badge>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant={active ? "primary" : "secondary"}
                        onClick={() => {
                          setActiveProfileId(p.id);
                          setDraft(p);
                        }}
                      >
                        <Check className="h-3 w-3" />
                        {active ? t("deploy.profileActive") : t("deploy.profileSelect")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => deleteM.mutate(p.id)}>
                        <Trash2 className="h-3.5 w-3.5 text-danger" />
                      </Button>
                    </div>
                  </div>
                  <div className="mono-num text-[11px] text-muted">
                    MACHINE: {p.machine} · IP: {p.target_ip} · UART: {p.uart_port}@{p.uart_baud}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">{t("deploy.profileEditorTitle")}</h2>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 text-xs">
          <div>
            <label className="text-[11px] text-muted">{t("deploy.profileNameLabel")}</label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div>
            <label className="text-[11px] text-muted">{t("deploy.targetMachineLabel")}</label>
            <Input value={draft.machine} onChange={(e) => setDraft({ ...draft, machine: e.target.value })} />
          </div>
          <div>
            <label className="text-[11px] text-muted">{t("deploy.preferredMethodLabel")}</label>
            <select
              value={draft.preferred_method}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  preferred_method: e.target.value as TargetProfileRecord["preferred_method"],
                })
              }
              className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg"
            >
              <option value="usb">USB Flash</option>
              <option value="tftp">Ethernet TFTP</option>
              <option value="swupdate">SWUpdate OTA</option>
              <option value="rauc">RAUC A/B</option>
              <option value="ssh_raw">SSH Raw Partition</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] text-muted">{t("deploy.usbFlasherLabel")}</label>
            <select
              value={draft.usb_flasher}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  usb_flasher: e.target.value as TargetProfileRecord["usb_flasher"],
                })
              }
              className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg"
            >
              <option value="raw_disk">SD / USB / UMS Raw</option>
              <option value="fastboot">Fastboot</option>
              <option value="dfu">USB DFU</option>
              <option value="nxp_uuu">NXP i.MX (uuu)</option>
              <option value="stm32_prog">STM32MP (.tsv)</option>
              <option value="ti_dfu_boot">TI Sitara (dfu-boot)</option>
              <option value="mediatek_sp">MediaTek Genio (sp-flash-tool)</option>
              <option value="rockchip_rkdev">Rockchip Maskrom (rkdeveloptool)</option>
              <option value="custom_cli">{t("deploy.customCliOption")}</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] text-muted">{t("deploy.targetIpLabel")}</label>
            <Input value={draft.target_ip} onChange={(e) => setDraft({ ...draft, target_ip: e.target.value })} />
          </div>
          <div>
            <label className="text-[11px] text-muted">{t("deploy.sshUserKeyLabel")}</label>
            <div className="flex gap-1.5">
              <Input
                value={draft.ssh_user}
                onChange={(e) => setDraft({ ...draft, ssh_user: e.target.value })}
                className="w-24"
              />
              <Input
                value={draft.ssh_key_ref}
                onChange={(e) => setDraft({ ...draft, ssh_key_ref: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="text-[11px] text-muted">{t("deploy.uartBaudLabel")}</label>
            <div className="flex gap-1.5">
              <Input
                value={draft.uart_port}
                onChange={(e) => setDraft({ ...draft, uart_port: e.target.value })}
              />
              <Input
                type="number"
                value={draft.uart_baud}
                onChange={(e) => setDraft({ ...draft, uart_baud: Number(e.target.value) || 115200 })}
                className="w-28"
              />
            </div>
          </div>
          <div>
            <label className="text-[11px] text-muted">SWUpdate URL</label>
            <Input
              value={draft.swupdate_url}
              onChange={(e) => setDraft({ ...draft, swupdate_url: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-[11px] text-muted">{t("deploy.abPartMapLabel")}</label>
            <Input
              value={draft.ab_slots_json}
              onChange={(e) => setDraft({ ...draft, ab_slots_json: e.target.value })}
              className="mono-num"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-[11px] text-muted">{t("deploy.customCliTemplateLabel")}</label>
            <Input
              value={draft.custom_cli_template}
              onChange={(e) => setDraft({ ...draft, custom_cli_template: e.target.value })}
              className="mono-num"
            />
          </div>
        </div>

        <Button
          variant="primary"
          onClick={() => saveM.mutate({ ...draft, project_id: activeProjectId })}
          disabled={saveM.isPending}
        >
          <Save className="h-3.5 w-3.5" />
          {t("deploy.saveProfileSqlite")}
        </Button>
      </Card>
    </div>
  );
}
