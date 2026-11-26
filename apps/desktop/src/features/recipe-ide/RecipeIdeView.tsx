import { DiffEditor, Editor } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import {
  FileCode2,
  FilePlus2,
  GitCompare,
  Hammer,
  Plus,
  RotateCcw,
  Save,
  Send,
  SlidersHorizontal,
  Terminal,
  Wand2,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input, Modal } from "@/components/ui/primitives";
import { initMonacoBitbake } from "@/lib/monacoBitbake";
import { rpcClient } from "@/lib/rpcClient";
import { useAppStore } from "@/stores/appStore";
import { useBuildStore } from "@/stores/buildStore";

initMonacoBitbake();

export function RecipeIdeView() {
  const { t } = useTranslation();
  const theme = useAppStore((s) => s.theme);
  const selectedRecipePn = useAppStore((s) => s.selectedRecipePn);
  const openBridgePtyTab = useBuildStore((s) => s.openBridgePtyTab);

  const [filter, setFilter] = useState("");
  const [selectedPn, setSelectedPn] = useState(selectedRecipePn ?? "my-sensor-daemon");
  const [editorText, setEditorText] = useState("");
  const [diffBaseText, setDiffBaseText] = useState("");
  const [diffMode, setDiffMode] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [statusLog, setStatusLog] = useState<string | null>(null);

  // recipetool wizard state
  const [rtOpen, setRtOpen] = useState(false);
  const [rtName, setRtName] = useState("rust-edge-gateway");
  const [rtVer, setRtVer] = useState("1.0.0");
  const [rtUri, setRtUri] = useState("git://github.com/example/rust-edge-gateway.git;branch=main");
  const [rtBuildSys, setRtBuildSys] = useState<
    "cmake" | "meson" | "autotools" | "cargo" | "python" | "go"
  >("cargo");

  // devtool add & finish modals
  const [devAddOpen, setDevAddOpen] = useState(false);
  const [devAddName, setDevAddName] = useState("telemetry-agent");
  const [devAddUri, setDevAddUri] = useState("https://github.com/example/telemetry-agent.git");
  const [deployHost, setDeployHost] = useState("192.168.1.50");
  const [finishResult, setFinishResult] = useState<{
    patch_file: string;
    bbappend_file: string;
    patch_diff: string;
  } | null>(null);

  const recipesQuery = useQuery({
    queryKey: ["recipes-list", filter],
    queryFn: () => rpcClient.call("recipes.list", { query: filter }),
  });

  const recipeQuery = useQuery({
    queryKey: ["recipes-get", selectedPn],
    queryFn: () => rpcClient.call("recipes.get", { pn: selectedPn }),
  });

  const devtoolQuery = useQuery({
    queryKey: ["devtool-status"],
    queryFn: () => rpcClient.call("devtool.status", {}),
  });

  useEffect(() => {
    if (selectedRecipePn) {
      setSelectedPn(selectedRecipePn);
    }
  }, [selectedRecipePn]);

  useEffect(() => {
    if (recipeQuery.data?.content !== undefined) {
      setEditorText(recipeQuery.data.content);
      setDiffBaseText(recipeQuery.data.content);
    }
  }, [recipeQuery.data]);

  const handleSave = async () => {
    await rpcClient.call("recipes.save", { pn: selectedPn, content: editorText });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 1800);
  };

  const handleCreateBbappend = async () => {
    const res = await rpcClient.call("recipes.create_bbappend", {
      pn: selectedPn.replace(".bbappend", ""),
      layer: "meta-custom-iot",
      template: "files",
    });
    setDiffBaseText(res.base_content);
    setSelectedPn(res.pn);
    setEditorText(res.content);
    setDiffMode(true);
    await recipesQuery.refetch();
  };

  const handleRecipetoolCreate = async () => {
    const res = await rpcClient.call("recipetool.create", {
      name: rtName,
      version: rtVer,
      src_uri: rtUri,
      build_system: rtBuildSys,
    });
    setRtOpen(false);
    await recipesQuery.refetch();
    setSelectedPn(res.pn);
    setEditorText(res.content);
    setDiffBaseText(res.content);
    setStatusLog(t("recipes.recipetoolLog", { path: res.file_path }));
  };

  const handleDevtoolAdd = async () => {
    const res = await rpcClient.call("devtool.add", { recipe: devAddName, src_uri: devAddUri });
    setDevAddOpen(false);
    setStatusLog(res.output);
    await Promise.all([devtoolQuery.refetch(), recipesQuery.refetch()]);
    setSelectedPn(devAddName);
  };

  const handleDevtoolModify = async () => {
    const res = await rpcClient.call("devtool.modify", { recipe: selectedPn });
    setStatusLog(res.output);
    await devtoolQuery.refetch();
  };

  const handleDevtoolBuild = async (rec: string) => {
    const res = await rpcClient.call("devtool.build", { recipe: rec });
    setStatusLog(res.output);
  };

  const handleDevtoolDeploy = async (rec: string) => {
    const res = await rpcClient.call("devtool.deploy_target", {
      recipe: rec,
      target_host: deployHost,
      target_user: "root",
    });
    setStatusLog(res.output);
  };

  const handleDevtoolFinish = async (rec: string) => {
    const res = await rpcClient.call("devtool.finish", {
      recipe: rec,
      layer_path: "meta-custom-iot",
    });
    setFinishResult(res);
    await devtoolQuery.refetch();
  };

  const handleDevtoolReset = async (rec: string) => {
    await rpcClient.call("devtool.reset", { recipe: rec });
    setStatusLog(t("recipes.devtoolResetLog", { recipe: rec }));
    await devtoolQuery.refetch();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-fg">{t("recipes.title")}</h1>
          <p className="text-xs text-muted">{t("recipes.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => setRtOpen(true)}>
            <Wand2 className="h-3.5 w-3.5 text-accent" />
            {t("recipes.recipetoolWizard")}
          </Button>
          <Button size="sm" onClick={() => setDevAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            devtool add
          </Button>
          <Button size="sm" onClick={() => void handleCreateBbappend()}>
            <FilePlus2 className="h-3.5 w-3.5" />
            {t("recipes.createBbappend")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void openBridgePtyTab("menuconfig", "virtual/kernel")}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            kernel menuconfig
          </Button>
          <Button size="sm" onClick={() => void openBridgePtyTab("devshell", selectedPn)}>
            <Terminal className="h-3.5 w-3.5 text-accent" />
            devshell ({selectedPn})
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left: Recipe List & devtool workspace */}
        <Card className="lg:col-span-4 space-y-2.5">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("recipes.searchPlaceholder")}
          />
          <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
            {recipesQuery.data?.recipes.map((r) => (
              <button
                key={r.pn}
                onClick={() => setSelectedPn(r.pn)}
                className={`w-full rounded-md border p-2 text-left text-xs cursor-pointer transition-colors ${
                  selectedPn === r.pn
                    ? "border-accent bg-accent/10"
                    : "border-border bg-bg hover:bg-elevated"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold mono-num text-fg">
                    {r.pn} <span className="text-muted">({r.pv})</span>
                  </span>
                  {r.has_bbappend && <Badge tone="accent">.bbappend</Badge>}
                </div>
                <div className="mt-0.5 text-[11px] text-muted truncate">{r.summary}</div>
                <div className="mt-1 flex items-center justify-between text-[10px] mono-num text-muted">
                  <span>{r.layer}</span>
                  <span>{r.license}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="pt-2 border-t border-border space-y-2">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                <Wrench className="h-3.5 w-3.5 text-accent" />
                devtool Workspace ({devtoolQuery.data?.entries.length ?? 0})
              </span>
              <Button size="sm" onClick={() => void handleDevtoolModify()}>
                modify ({selectedPn})
              </Button>
            </div>

            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-muted shrink-0">{t("recipes.targetBoardIp")}</span>
              <Input
                value={deployHost}
                onChange={(e) => setDeployHost(e.target.value)}
                className="h-6 mono-num text-[11px]"
              />
            </div>

            {devtoolQuery.data?.entries.map((d) => (
              <div key={d.recipe} className="rounded border border-border bg-bg p-2 text-[11px] space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold mono-num text-fg">{d.recipe}</span>
                  <Badge tone="ok">{d.status}</Badge>
                </div>
                <div className="mono-num text-[10px] text-muted truncate">{d.srctree}</div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" onClick={() => void handleDevtoolBuild(d.recipe)}>
                    <Hammer className="h-3 w-3" />
                    build
                  </Button>
                  <Button size="sm" onClick={() => void handleDevtoolDeploy(d.recipe)}>
                    <Send className="h-3 w-3" />
                    deploy-target
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void handleDevtoolFinish(d.recipe)}>
                    finish
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void handleDevtoolReset(d.recipe)}>
                    <RotateCcw className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Right: Monaco BitBake Editor + Diff */}
        <Card className="lg:col-span-8 flex flex-col space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <FileCode2 className="h-4 w-4 text-accent" />
              <span className="mono-num font-semibold text-fg">
                {recipeQuery.data?.recipe?.file_path ??
                  (recipeQuery.data as { summary?: { file_path?: string } } | undefined)?.summary
                    ?.file_path ??
                  `${selectedPn}.bb`}
              </span>
              <Badge tone="accent">BitBake Monaco</Badge>
            </div>
            <div className="flex items-center gap-2">
              {savedNotice && <Badge tone="ok">{t("recipes.saved")}</Badge>}
              <Button size="sm" onClick={() => setDiffMode(!diffMode)}>
                <GitCompare className="h-3.5 w-3.5" />
                {diffMode ? t("recipes.backToEditor") : t("recipes.sideBySideDiff")}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void handleSave()}>
                <Save className="h-3.5 w-3.5" />
                {t("recipes.save")}
              </Button>
            </div>
          </div>

          <div className="h-[400px] w-full overflow-hidden rounded-md border border-border">
            {diffMode ? (
              <DiffEditor
                height="100%"
                language="bitbake"
                theme={theme === "dark" ? "yocto-dark" : "yocto-light"}
                original={diffBaseText}
                modified={editorText}
                options={{
                  readOnly: false,
                  minimap: { enabled: false },
                  fontSize: 12,
                  fontFamily: "JetBrains Mono, monospace",
                }}
              />
            ) : (
              <Editor
                height="100%"
                language="bitbake"
                theme={theme === "dark" ? "yocto-dark" : "yocto-light"}
                value={editorText}
                onChange={(val) => setEditorText(val ?? "")}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  fontFamily: "JetBrains Mono, monospace",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                }}
              />
            )}
          </div>

          {statusLog && (
            <pre className="rounded border border-border bg-bg p-2 mono-num text-[11px] text-accent whitespace-pre-wrap">
              {statusLog}
            </pre>
          )}
        </Card>
      </div>

      {/* recipetool Wizard Modal */}
      <Modal
        open={rtOpen}
        onOpenChange={setRtOpen}
        title={t("recipes.rtModalTitle")}
        subtitle="CMake · Meson · Autotools · Cargo (Rust) · Python · Go"
      >
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[11px] text-muted">{t("recipes.pkgName")}</label>
              <Input className="mono-num" value={rtName} onChange={(e) => setRtName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-muted">{t("recipes.version")}</label>
              <Input className="mono-num" value={rtVer} onChange={(e) => setRtVer(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted">{t("recipes.buildSystem")}</label>
            <select
              value={rtBuildSys}
              onChange={(e) =>
                setRtBuildSys(
                  e.target.value as "cmake" | "meson" | "autotools" | "cargo" | "python" | "go"
                )
              }
              className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg mono-num"
            >
              <option value="cargo">Cargo (Rust)</option>
              <option value="cmake">CMake</option>
              <option value="meson">Meson</option>
              <option value="autotools">Autotools</option>
              <option value="python">Python (setuptools_build_meta)</option>
              <option value="go">Go (go-mod)</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted">SRC_URI</label>
            <Input className="mono-num" value={rtUri} onChange={(e) => setRtUri(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setRtOpen(false)}>{t("recipes.cancel")}</Button>
            <Button variant="primary" onClick={() => void handleRecipetoolCreate()}>
              {t("recipes.generateAndOpen")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* devtool add Modal */}
      <Modal
        open={devAddOpen}
        onOpenChange={setDevAddOpen}
        title={t("recipes.devAddTitle")}
        subtitle={t("recipes.devAddSubtitle")}
      >
        <div className="space-y-3 text-xs">
          <div>
            <label className="mb-1 block text-[11px] text-muted">{t("recipes.recipeName")}</label>
            <Input
              className="mono-num"
              value={devAddName}
              onChange={(e) => setDevAddName(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted">{t("recipes.sourceUrl")}</label>
            <Input
              className="mono-num"
              value={devAddUri}
              onChange={(e) => setDevAddUri(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setDevAddOpen(false)}>{t("recipes.cancel")}</Button>
            <Button variant="primary" onClick={() => void handleDevtoolAdd()}>
              {t("recipes.addToWorkspace")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* devtool finish Result Modal */}
      <Modal
        open={finishResult !== null}
        onOpenChange={(v) => {
          if (!v) setFinishResult(null);
        }}
        wide
        title={t("recipes.devFinishTitle")}
        subtitle={finishResult?.bbappend_file}
      >
        {finishResult && (
          <div className="space-y-2 text-xs">
            <div className="mono-num text-muted">
              {t("recipes.patchFile")}: {finishResult.patch_file}
            </div>
            <pre className="rounded border border-border bg-bg p-3 mono-num text-[11px] text-fg">
              {finishResult.patch_diff}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}
