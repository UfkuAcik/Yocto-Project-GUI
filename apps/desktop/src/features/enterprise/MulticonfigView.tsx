import { useQuery } from "@tanstack/react-query";
import { Cpu, GitBranchPlus, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { enterpriseRpc } from "@/lib/enterpriseApi";
import { rpcClient } from "@/lib/rpcClient";
import { useAppStore } from "@/stores/appStore";

export function MulticonfigView() {
  const { t, i18n } = useTranslation();
  const setActiveModule = useAppStore((s) => s.setActiveModule);

  const [name, setName] = useState("cortex-r5f-safety");
  const [machine, setMachine] = useState("imx8mp-r5f-freertos");
  const [tmpdir, setTmpdir] = useState("${TOPDIR}/tmp-r5f-safety");
  const [distro, setDistro] = useState("baremetal");
  const [description, setDescription] = useState(() => t("enterprise.mc.defaultDesc"));

  useEffect(() => {
    setDescription((prev) => {
      const trDef = i18n.t("enterprise.mc.defaultDesc", { lng: "tr" });
      const enDef = i18n.t("enterprise.mc.defaultDesc", { lng: "en" });
      return prev === trDef || prev === enDef ? t("enterprise.mc.defaultDesc") : prev;
    });
  }, [i18n, i18n.language, t]);

  const [depFrom, setDepFrom] = useState("cortex-a53-linux");
  const [depTo, setDepTo] = useState("cortex-m7-rtos");
  const [depRecipe, setDepRecipe] = useState("zephyr-sensor-fw");
  const [depTask, setDepTask] = useState("do_deploy");
  const [lastDiff, setLastDiff] = useState("");
  const [notice, setNotice] = useState("");

  const mcQuery = useQuery({
    queryKey: ["enterprise-multiconfig"],
    queryFn: () => enterpriseRpc.multiconfigList(),
  });

  const handleSave = async (withDependency = false) => {
    const res = await enterpriseRpc.multiconfigSave({
      name,
      machine,
      tmpdir,
      distro,
      description,
      add_dependency: withDependency
        ? { from_config: depFrom, to_config: depTo, recipe: depRecipe, task: depTask }
        : undefined,
    });
    setLastDiff(res.local_conf_diff);
    setNotice(t("enterprise.mc.savedNotice", { path: res.config.file_path }));
    await mcQuery.refetch();
  };

  const handleDelete = async (mcName: string) => {
    await enterpriseRpc.multiconfigDelete(mcName);
    setNotice(t("enterprise.mc.deletedNotice", { name: mcName }));
    await mcQuery.refetch();
  };

  const handleBuildMulticonfig = async (cfgName: string) => {
    setActiveModule("build");
    await rpcClient.call("build.start", { target: `mc:${cfgName}:core-image-minimal` });
  };

  const configs = mcQuery.data?.configs ?? [];
  const dependencies = mcQuery.data?.dependencies ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("enterprise.mc.heading")}</h3>
          <p className="text-xs text-muted">{t("enterprise.mc.desc")}</p>
        </div>
        <Badge tone="accent" className="mono-num">
          {mcQuery.data?.local_conf_snippet ?? 'BBMULTICONFIG = "..."'}
        </Badge>
      </div>

      {notice && (
        <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent">
          {notice}
        </div>
      )}

      {/* Existing Multiconfig Cards */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {configs.map((cfg) => (
          <Card key={cfg.name} className="p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-accent" />
                <div>
                  <div className="text-xs font-semibold mono-num">{cfg.name}</div>
                  <div className="text-[11px] text-muted">{cfg.file_path}</div>
                </div>
              </div>
              <Badge tone="ok">{cfg.distro || "poky"}</Badge>
            </div>
            <p className="text-xs text-muted">{cfg.description || "—"}</p>
            <div className="rounded bg-bg/70 p-2 text-[11px] mono-num space-y-0.5">
              <div>MACHINE = "{cfg.machine}"</div>
              <div className="truncate" title={cfg.tmpdir}>
                TMPDIR = "{cfg.tmpdir}"
              </div>
            </div>
            <div className="flex items-center gap-1.5 pt-1">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleBuildMulticonfig(cfg.name)}
              >
                <Play className="h-3 w-3" />
                mc:{cfg.name}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => {
                setName(cfg.name);
                setMachine(cfg.machine);
                setTmpdir(cfg.tmpdir);
                setDistro(cfg.distro);
                setDescription(cfg.description);
              }}>
                {t("enterprise.mc.editBtn")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void handleDelete(cfg.name)}>
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Create / Edit Multiconfig */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Plus className="h-4 w-4 text-accent" />
            {t("enterprise.mc.createEditPrefix")}{" "}
            <code className="mono-num">conf/multiconfig/*.conf</code>
          </div>
          <div className="grid grid-cols-2 gap-2.5 text-xs">
            <label className="space-y-1">
              <span className="text-muted">{t("enterprise.mc.name")}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-muted">{t("enterprise.mc.machine")}</span>
              <Input value={machine} onChange={(e) => setMachine(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-muted">{t("enterprise.mc.tmpdir")}</span>
              <Input value={tmpdir} onChange={(e) => setTmpdir(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-muted">{t("enterprise.mc.distro")}</span>
              <Input value={distro} onChange={(e) => setDistro(e.target.value)} />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-muted">{t("enterprise.mc.description")}</span>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>
          <Button variant="primary" size="sm" onClick={() => void handleSave(false)}>
            {t("enterprise.mc.saveBtn")}
          </Button>
        </Card>

        {/* Inter-Multiconfig Dependencies */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <GitBranchPlus className="h-4 w-4 text-accent" />
            {t("enterprise.mc.dependsTitle")}
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Input value={depFrom} onChange={(e) => setDepFrom(e.target.value)} placeholder="from" />
            <Input value={depTo} onChange={(e) => setDepTo(e.target.value)} placeholder="to" />
            <Input value={depRecipe} onChange={(e) => setDepRecipe(e.target.value)} placeholder="recipe" />
            <Input value={depTask} onChange={(e) => setDepTask(e.target.value)} placeholder="do_deploy" />
          </div>
          <Button variant="secondary" size="sm" onClick={() => void handleSave(true)}>
            {t("enterprise.mc.addDepBtn")}
          </Button>
          <div className="space-y-1.5 pt-1">
            {dependencies.map((d) => (
              <div
                key={d.expression}
                className="flex items-center justify-between rounded border border-border bg-bg/70 px-2.5 py-1.5 text-[11px] mono-num"
              >
                <span>{d.expression}</span>
                <Badge tone="accent">{d.to_config}</Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {lastDiff && (
        <Card className="p-3 space-y-2">
          <div className="text-xs font-semibold">{t("enterprise.mc.diffPreview")}</div>
          <pre className="max-h-48 overflow-auto rounded bg-bg p-2.5 text-[11px] mono-num text-fg">
            {lastDiff}
          </pre>
        </Card>
      )}
    </div>
  );
}
