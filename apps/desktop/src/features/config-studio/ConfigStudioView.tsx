import { useQuery } from "@tanstack/react-query";
import { Check, Eye, GitCompare, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input, Modal, Switch } from "@/components/ui/primitives";
import { rpcClient } from "@/lib/rpcClient";

const FRAGMENT_DESC_KEYS: Record<string, string> = {
  "core/yocto/root-login-with-empty-password": "config.fragmentDescriptions.rootLogin",
  "core/yocto/sstate-mirror-cdn": "config.fragmentDescriptions.sstateCdn",
  "distro/poky-altcfg": "config.fragmentDescriptions.pokyAltcfg",
  "toolchain/clang-target": "config.fragmentDescriptions.clangTarget",
};

export function ConfigStudioView() {
  const { t, i18n } = useTranslation();
  const confQuery = useQuery({
    queryKey: ["local-conf"],
    queryFn: () => rpcClient.call("config.get_local_conf", {}),
  });
  const fragQuery = useQuery({
    queryKey: ["config-fragments"],
    queryFn: () => rpcClient.call("config.list_fragments", {}),
  });

  const [machine, setMachine] = useState("imx8mp-lpddr4-evk");
  const [distro, setDistro] = useState("poky");
  const [initMgr, setInitMgr] = useState("systemd");
  const [pkgClass, setPkgClass] = useState("package_rpm");
  const [toolchain, setToolchain] = useState("gcc");
  const [bbThreads, setBbThreads] = useState("8");
  const [parallelMake, setParallelMake] = useState("-j 8");
  const [extraFeatures, setExtraFeatures] = useState("allow-empty-password allow-root-login debug-tweaks");
  const [imageInstallAppend, setImageInstallAppend] = useState("openssh-sftp-server htop my-sensor-daemon");

  const [diffText, setDiffText] = useState<string>("");
  const [showRawConf, setShowRawConf] = useState(false);

  // Variable Origin Inspector
  const [inspectInput, setInspectInput] = useState("IMAGE_INSTALL");
  const [inspectName, setInspectName] = useState("IMAGE_INSTALL");

  // Create Fragment modal
  const [fragModalOpen, setFragModalOpen] = useState(false);
  const [newFragId, setNewFragId] = useState("custom/debug-gdbserver");
  const [newFragName, setNewFragName] = useState("debug-gdbserver");
  const [newFragDesc, setNewFragDesc] = useState(() => t("config.defaultFragDesc"));
  const [newFragCat, setNewFragCat] = useState<"security" | "build" | "distro" | "toolchain">("build");

  useEffect(() => {
    setNewFragDesc((prev) => {
      const trVal = i18n.t("config.defaultFragDesc", { lng: "tr" });
      const enVal = i18n.t("config.defaultFragDesc", { lng: "en" });
      return prev === trVal || prev === enVal ? t("config.defaultFragDesc") : prev;
    });
  }, [i18n, i18n.language, t]);

  useEffect(() => {
    const vars = confQuery.data?.variables;
    if (vars) {
      if (vars.MACHINE) setMachine(vars.MACHINE);
      if (vars.DISTRO) setDistro(vars.DISTRO);
      if (vars.INIT_MANAGER) setInitMgr(vars.INIT_MANAGER);
      if (vars.PACKAGE_CLASSES) setPkgClass(vars.PACKAGE_CLASSES);
      if (vars.PREFERRED_TOOLCHAIN_TARGET) setToolchain(vars.PREFERRED_TOOLCHAIN_TARGET);
      if (vars.BB_NUMBER_THREADS) setBbThreads(vars.BB_NUMBER_THREADS);
      if (vars.PARALLEL_MAKE) setParallelMake(vars.PARALLEL_MAKE);
      if (vars.EXTRA_IMAGE_FEATURES) setExtraFeatures(vars.EXTRA_IMAGE_FEATURES);
      if (vars["IMAGE_INSTALL:append"]) setImageInstallAppend(vars["IMAGE_INSTALL:append"]);
    }
  }, [confQuery.data]);

  const inspectQuery = useQuery({
    queryKey: ["inspect-var", inspectName],
    queryFn: () => rpcClient.call("config.inspect_variable", { name: inspectName }),
  });

  const pendingUpdates = {
    MACHINE: machine,
    DISTRO: distro,
    INIT_MANAGER: initMgr,
    PACKAGE_CLASSES: pkgClass,
    PREFERRED_TOOLCHAIN_TARGET: toolchain,
    BB_NUMBER_THREADS: bbThreads,
    PARALLEL_MAKE: parallelMake,
    EXTRA_IMAGE_FEATURES: extraFeatures,
    "IMAGE_INSTALL:append": imageInstallAppend,
  };

  const handlePreviewDiff = async () => {
    const res = await rpcClient.call("config.preview_diff", { updates: pendingUpdates });
    setDiffText(res.diff || t("config.noChangesDiff"));
  };

  const handleApply = async () => {
    await rpcClient.call("config.apply_changes", { updates: pendingUpdates });
    setDiffText("");
    await Promise.all([confQuery.refetch(), inspectQuery.refetch()]);
  };

  const handleToggleFragment = async (id: string, enabled: boolean) => {
    await rpcClient.call("config.toggle_fragment", { id, enabled });
    await fragQuery.refetch();
  };

  const handleCreateFragment = async () => {
    await rpcClient.call("config.create_fragment", {
      id: newFragId,
      name: newFragName,
      description: newFragDesc,
      category: newFragCat,
    });
    setFragModalOpen(false);
    await fragQuery.refetch();
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-base font-bold text-fg">{t("config.title")}</h1>
        <p className="text-xs text-muted">{t("config.subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Visual local.conf Form */}
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-fg">{t("config.targetImageSettings")}</h2>
            <div className="flex items-center gap-2">
              {confQuery.data?.comments_count !== undefined && (
                <Badge tone="ok">
                  {t("config.commentsPreserved", { count: confQuery.data.comments_count })}
                </Badge>
              )}
              <Button size="sm" variant="ghost" onClick={() => setShowRawConf(!showRawConf)}>
                {showRawConf ? t("config.formView") : t("config.rawConfView")}
              </Button>
            </div>
          </div>

          {!showRawConf ? (
            <div className="grid grid-cols-2 gap-2.5 text-xs">
              <div>
                <label className="mb-1 block text-[11px] text-muted">MACHINE</label>
                <Input className="mono-num" value={machine} onChange={(e) => setMachine(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">DISTRO</label>
                <Input className="mono-num" value={distro} onChange={(e) => setDistro(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">INIT_MANAGER</label>
                <select
                  value={initMgr}
                  onChange={(e) => setInitMgr(e.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg mono-num"
                >
                  <option value="systemd">systemd</option>
                  <option value="sysvinit">sysvinit</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">PACKAGE_CLASSES</label>
                <select
                  value={pkgClass}
                  onChange={(e) => setPkgClass(e.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg mono-num"
                >
                  <option value="package_rpm">package_rpm</option>
                  <option value="package_ipk">package_ipk</option>
                  <option value="package_deb">package_deb</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">PREFERRED_TOOLCHAIN_TARGET</label>
                <select
                  value={toolchain}
                  onChange={(e) => setToolchain(e.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg mono-num"
                >
                  <option value="gcc">gcc (GNU)</option>
                  <option value="clang">clang (LLVM)</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-muted">BB_NUMBER_THREADS</label>
                  <Input
                    className="mono-num"
                    value={bbThreads}
                    onChange={(e) => setBbThreads(e.target.value)}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-muted">PARALLEL_MAKE</label>
                  <Input
                    className="mono-num"
                    value={parallelMake}
                    onChange={(e) => setParallelMake(e.target.value)}
                  />
                </div>
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-[11px] text-muted">EXTRA_IMAGE_FEATURES</label>
                <Input
                  className="mono-num"
                  value={extraFeatures}
                  onChange={(e) => setExtraFeatures(e.target.value)}
                />
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-[11px] text-muted">IMAGE_INSTALL:append</label>
                <Input
                  className="mono-num"
                  value={imageInstallAppend}
                  onChange={(e) => setImageInstallAppend(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <pre className="max-h-72 overflow-auto rounded border border-border bg-bg p-2.5 mono-num text-[11px] text-fg">
              {confQuery.data?.content}
            </pre>
          )}

          <div className="flex gap-2 pt-1">
            <Button onClick={() => void handlePreviewDiff()}>
              <GitCompare className="h-3.5 w-3.5" />
              {t("config.previewDiff")}
            </Button>
            <Button variant="primary" onClick={() => void handleApply()}>
              <Check className="h-3.5 w-3.5" />
              {t("config.applyPreservingComments")}
            </Button>
          </div>

          {diffText && (
            <pre className="max-h-48 overflow-auto rounded border border-border bg-bg p-2.5 mono-num text-[11px]">
              {diffText.split("\n").map((ln, idx) => (
                <div
                  key={idx}
                  className={
                    ln.startsWith("+") && !ln.startsWith("+++")
                      ? "text-success"
                      : ln.startsWith("-") && !ln.startsWith("---")
                      ? "text-danger"
                      : "text-muted"
                  }
                >
                  {ln}
                </div>
              ))}
            </pre>
          )}
        </Card>

        {/* Yocto 6.0 Config Fragments */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg">{t("config.fragmentsTitle")}</h2>
            <Button size="sm" onClick={() => setFragModalOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t("config.newFragment")}
            </Button>
          </div>
          <div className="space-y-2">
            {fragQuery.data?.fragments.map((frag) => (
              <div
                key={frag.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg p-2.5 text-xs"
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold mono-num text-fg">{frag.id}</span>
                    <Badge>{frag.category}</Badge>
                  </div>
                  <div className="text-muted">
                    {FRAGMENT_DESC_KEYS[frag.id] ? t(FRAGMENT_DESC_KEYS[frag.id]) : frag.description}
                  </div>
                </div>
                <Switch
                  checked={frag.enabled}
                  onCheckedChange={(val) => void handleToggleFragment(frag.id, val)}
                />
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Variable Origin Inspector */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
              <Eye className="h-4 w-4 text-accent" />
              {t("config.varInspectorTitle")}
            </h2>
            <p className="text-xs text-muted">{t("config.varInspectorSubtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1">
              <Input
                value={inspectInput}
                onChange={(e) => setInspectInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setInspectName(inspectInput.trim() || "MACHINE");
                }}
                placeholder={t("config.varSearchPlaceholder")}
                className="h-7 w-44 mono-num text-xs"
              />
              <Button size="sm" onClick={() => setInspectName(inspectInput.trim() || "MACHINE")}>
                <Search className="h-3 w-3" />
              </Button>
            </div>
            {["IMAGE_INSTALL", "MACHINE", "PARALLEL_MAKE", "PREFERRED_TOOLCHAIN_TARGET"].map((v) => (
              <Button
                key={v}
                size="sm"
                variant={inspectName === v ? "primary" : "secondary"}
                onClick={() => {
                  setInspectInput(v);
                  setInspectName(v);
                }}
                className="mono-num"
              >
                {v}
              </Button>
            ))}
          </div>
        </div>

        {inspectQuery.data && (
          <div className="space-y-2 text-xs">
            <div className="rounded border border-border bg-bg p-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5">
                <div>
                  <span className="text-muted">{t("config.finalValue")}: </span>
                  <code className="mono-num text-accent font-semibold">
                    {inspectQuery.data.final_value}
                  </code>
                </div>
                <div className="text-[11px] text-muted">
                  {t("config.unexpandedValue")}:{" "}
                  <code className="mono-num">{inspectQuery.data.unexpanded_value}</code>
                </div>
              </div>
              <span className="text-muted">{inspectQuery.data.doc}</span>
            </div>

            <div className="divide-y divide-border/50 rounded border border-border bg-bg">
              {inspectQuery.data.history.map((h, i) => (
                <div
                  key={`${h.file}-${h.line}-${i}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="mono-num text-muted">
                    {h.file}:{h.line}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge tone={h.overridden ? "neutral" : "accent"} className="mono-num">
                      {h.operator}
                    </Badge>
                    <code
                      className={`mono-num ${h.overridden ? "line-through text-muted" : "text-fg"}`}
                    >
                      "{h.value}"
                    </code>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Modal
        open={fragModalOpen}
        onOpenChange={setFragModalOpen}
        title={t("config.createFragTitle")}
        subtitle="bitbake-config-build"
      >
        <div className="space-y-3 text-xs">
          <div>
            <label className="mb-1 block text-[11px] text-muted">{t("config.fragId")}</label>
            <Input className="mono-num" value={newFragId} onChange={(e) => setNewFragId(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[11px] text-muted">{t("config.fragName")}</label>
              <Input value={newFragName} onChange={(e) => setNewFragName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-muted">{t("config.fragCategory")}</label>
              <select
                value={newFragCat}
                onChange={(e) =>
                  setNewFragCat(e.target.value as "security" | "build" | "distro" | "toolchain")
                }
                className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg"
              >
                <option value="build">build</option>
                <option value="security">security</option>
                <option value="distro">distro</option>
                <option value="toolchain">toolchain</option>
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted">{t("config.fragDesc")}</label>
            <Input value={newFragDesc} onChange={(e) => setNewFragDesc(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setFragModalOpen(false)}>{t("config.cancel")}</Button>
            <Button variant="primary" onClick={() => void handleCreateFragment()}>
              {t("config.createAndEnable")}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
