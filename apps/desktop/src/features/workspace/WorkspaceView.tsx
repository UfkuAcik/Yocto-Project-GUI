import { useQuery } from "@tanstack/react-query";
import type { KasConfig, ProviderKind } from "@yocto-studio/shared-protocol";
import {
  FileCode,
  FolderGit2,
  FolderPlus,
  GitPullRequest,
  HardDriveDownload,
  Lock,
  Play,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { BridgeRpcError, rpcClient } from "@/lib/rpcClient";
import { useAppStore } from "@/stores/appStore";

const SAMPLE_KAS_YAML = `header:
  version: 14

machine: imx8mp-lpddr4-evk
distro: poky
target:
  - core-image-minimal

repos:
  poky:
    url: https://git.yoctoproject.org/git/poky
    branch: wrynose
    layers:
      meta:
      meta-poky:
  meta-openembedded:
    url: https://github.com/openembedded/meta-openembedded.git
    branch: wrynose
    layers:
      meta-oe:

local_conf_header:
  standard: |
    PACKAGE_CLASSES = "package_rpm"
    INIT_MANAGER = "systemd"
`;

export function WorkspaceView() {
  const { t } = useTranslation();
  const { projects, activeProjectId, setProjects } = useAppStore();
  const [subTab, setSubTab] = useState<"projects" | "setup" | "kas" | "import">("projects");

  // New project form
  const [name, setName] = useState("custom-wrynose-bsp");
  const [workspacePath, setWorkspacePath] = useState("/home/yocto/yocto-studio/custom-wrynose-bsp");
  const [codename, setCodename] = useState("wrynose");
  const [setupTool, setSetupTool] = useState<"bitbake-setup" | "oe-init-build-env" | "kas">(
    "bitbake-setup"
  );
  const [machine, setMachine] = useState("imx8mp-lpddr4-evk");
  const [distro, setDistro] = useState("poky");
  const [provider, setProvider] = useState<ProviderKind>("wsl2");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Shared cache settings
  const activeProj = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  const [dlDir, setDlDir] = useState(activeProj?.dl_dir ?? "/home/yocto/yocto-cache/downloads");
  const [sstateDir, setSstateDir] = useState(
    activeProj?.sstate_dir ?? "/home/yocto/yocto-cache/sstate-cache"
  );
  const [hashserve, setHashserve] = useState(activeProj?.hashserve ?? "auto");
  const [cacheMsg, setCacheMsg] = useState<{ ok: true } | { ok: false; text: string } | null>(null);

  // bitbake-setup status/update
  const setupQuery = useQuery({
    queryKey: ["workspace-setup-status", activeProjectId],
    queryFn: () => rpcClient.call("workspace.setup_status", { project_id: activeProjectId ?? undefined }),
  });
  const [setupUpdateMsg, setSetupUpdateMsg] = useState<string | null>(null);

  // kas two-way editor
  const [kasYaml, setKasYaml] = useState(SAMPLE_KAS_YAML);
  const [kasConfig, setKasConfig] = useState<KasConfig | null>(null);
  const [kasWarnings, setKasWarnings] = useState<string[]>([]);
  const [kasOutput, setKasOutput] = useState<string | null>(null);

  // Scarthgap import form
  const [importName, setImportName] = useState("existing-scarthgap-poky");
  const [importPath, setImportPath] = useState("/home/yocto/poky-scarthgap");
  const [importBuildDir, setImportBuildDir] = useState("/home/yocto/poky-scarthgap/build");
  const [importErr, setImportErr] = useState<string | null>(null);

  const handleSelect = async (id: string) => {
    await rpcClient.call("workspace.select", { project_id: id });
    const list = await rpcClient.call("workspace.list", {});
    setProjects(list.projects, list.active_project_id);
  };

  const handleCreate = async () => {
    setErrorMsg(null);
    try {
      await rpcClient.call("workspace.create", {
        name,
        yocto_codename: codename,
        setup_tool: setupTool,
        workspace_path: workspacePath,
        machine,
        distro,
        provider,
      });
      const list = await rpcClient.call("workspace.list", {});
      setProjects(list.projects, list.active_project_id);
    } catch (err) {
      setErrorMsg(err instanceof BridgeRpcError ? `[${err.code}] ${err.message}` : String(err));
    }
  };

  const handleUpdateCaches = async () => {
    setCacheMsg(null);
    try {
      await rpcClient.call("workspace.update_caches", {
        dl_dir: dlDir,
        sstate_dir: sstateDir,
        hashserve,
      });
      const list = await rpcClient.call("workspace.list", {});
      setProjects(list.projects, list.active_project_id);
      setCacheMsg({ ok: true });
    } catch (err) {
      setCacheMsg({
        ok: false,
        text: err instanceof BridgeRpcError ? `[${err.code}] ${err.message}` : String(err),
      });
    }
  };

  const handleSetupUpdate = async () => {
    const res = await rpcClient.call("workspace.setup_update", {
      project_id: activeProjectId ?? undefined,
      preserve_local: true,
    });
    setSetupUpdateMsg(`${res.summary}\n${res.diff}`);
    await setupQuery.refetch();
  };

  const handleParseKas = async (yamlOverride?: string) => {
    const res = await rpcClient.call("kas.parse", { yaml_text: yamlOverride ?? kasYaml });
    setKasConfig(res.config);
    setKasWarnings(res.warnings);
  };

  const handleFormToYaml = async (updated: KasConfig) => {
    setKasConfig(updated);
    const res = await rpcClient.call("kas.serialize", { config: updated });
    setKasYaml(res.yaml_text);
  };

  const handleKasRun = async (action: "lock" | "checkout" | "build") => {
    const res = await rpcClient.call("kas.run", { action, yaml_text: kasYaml });
    setKasOutput(res.lock_yaml ? `${res.output}\n\n${t("workspace.lockedYamlComment")}\n${res.lock_yaml}` : res.output);
  };

  const handleImport = async () => {
    setImportErr(null);
    try {
      await rpcClient.call("workspace.import", {
        name: importName,
        workspace_path: importPath,
        build_dir: importBuildDir,
        setup_tool: "oe-init-build-env",
        provider: "wsl2",
      });
      const list = await rpcClient.call("workspace.list", {});
      setProjects(list.projects, list.active_project_id);
      setSubTab("projects");
    } catch (err) {
      setImportErr(err instanceof BridgeRpcError ? `[${err.code}] ${err.message}` : String(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-fg">{t("workspace.title")}</h1>
          <p className="text-xs text-muted">
            {t("workspace.subtitlePart1")}<code className="mono-num">bitbake-setup</code>
            {t("workspace.subtitlePart2")}
            <code className="mono-num">oe-init-build-env</code>
            {t("workspace.subtitlePart3")}<code className="mono-num">kas</code>
            {t("workspace.subtitlePart4")}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={subTab === "projects" ? "primary" : "secondary"}
            onClick={() => setSubTab("projects")}
          >
            <FolderGit2 className="h-3.5 w-3.5" />
            {t("workspace.tabProjects")}
          </Button>
          <Button
            size="sm"
            variant={subTab === "setup" ? "primary" : "secondary"}
            onClick={() => setSubTab("setup")}
          >
            <GitPullRequest className="h-3.5 w-3.5" />
            bitbake-setup
          </Button>
          <Button
            size="sm"
            variant={subTab === "kas" ? "primary" : "secondary"}
            onClick={() => {
              setSubTab("kas");
              if (!kasConfig) void handleParseKas();
            }}
          >
            <FileCode className="h-3.5 w-3.5" />
            Siemens kas YAML
          </Button>
          <Button
            size="sm"
            variant={subTab === "import" ? "primary" : "secondary"}
            onClick={() => setSubTab("import")}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {t("workspace.tabImport")}
          </Button>
        </div>
      </div>

      {subTab === "projects" && (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {projects.map((p) => {
              const active = p.id === activeProjectId;
              return (
                <Card
                  key={p.id}
                  className={`space-y-2.5 ${active ? "border-accent/60 bg-elevated/40" : ""}`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-fg">{p.name}</span>
                        {active && <Badge tone="accent">{t("workspace.active")}</Badge>}
                      </div>
                      <div className="mono-num text-[11px] text-muted mt-0.5">{p.workspace_path}</div>
                    </div>
                    {!active && (
                      <Button size="sm" onClick={() => void handleSelect(p.id)}>
                        {t("workspace.selectProject")}
                      </Button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[11px] pt-1 border-t border-border/60">
                    <div>
                      <span className="text-muted">{t("workspace.yoctoRelease")}:</span>{" "}
                      <span className="mono-num text-fg">
                        {p.yocto_version} ({p.yocto_codename})
                      </span>
                    </div>
                    <div>
                      <span className="text-muted">{t("workspace.setupTool")}:</span>{" "}
                      <span className="mono-num text-accent">{p.setup_tool}</span>
                    </div>
                    <div>
                      <span className="text-muted">MACHINE:</span>{" "}
                      <span className="mono-num text-fg">{p.machine}</span>
                    </div>
                    <div>
                      <span className="text-muted">DISTRO:</span>{" "}
                      <span className="mono-num text-fg">{p.distro}</span>
                    </div>
                    <div className="col-span-2 flex items-center gap-1.5 text-muted">
                      <HardDriveDownload className="h-3 w-3 text-accent" />
                      <span className="mono-num truncate">
                        SSTATE_DIR={p.sstate_dir} · DL_DIR={p.dl_dir}
                      </span>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          {/* Shared Cache Settings */}
          <Card className="space-y-2.5">
            <h2 className="text-sm font-semibold text-fg">
              {t("workspace.sharedCachesTitle")}
            </h2>
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-4 text-xs">
              <div>
                <label className="mb-1 block text-[11px] text-muted">DL_DIR</label>
                <Input className="mono-num" value={dlDir} onChange={(e) => setDlDir(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">SSTATE_DIR</label>
                <Input className="mono-num" value={sstateDir} onChange={(e) => setSstateDir(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">BB_HASHSERVE</label>
                <Input className="mono-num" value={hashserve} onChange={(e) => setHashserve(e.target.value)} />
              </div>
              <div className="flex items-end">
                <Button variant="primary" onClick={() => void handleUpdateCaches()}>
                  {t("workspace.saveCaches")}
                </Button>
              </div>
            </div>
            {cacheMsg && (
              <div className="mono-num text-[11px] text-accent">
                {cacheMsg.ok ? t("workspace.cachesUpdated") : cacheMsg.text}
              </div>
            )}
          </Card>

          <Card className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-fg">
              <FolderPlus className="h-4 w-4 text-accent" />
              {t("workspace.createTitle")}
            </div>

            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3 text-xs">
              <div>
                <label className="mb-1 block text-[11px] text-muted">{t("workspace.projectName")}</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-[11px] text-muted">
                  {t("workspace.ext4PathLabel")}
                </label>
                <Input
                  className="mono-num"
                  value={workspacePath}
                  onChange={(e) => setWorkspacePath(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">{t("workspace.yoctoBranch")}</label>
                <select
                  value={codename}
                  onChange={(e) => setCodename(e.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg"
                >
                  <option value="wrynose">6.0 Wrynose LTS</option>
                  <option value="scarthgap">5.0 Scarthgap LTS</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">{t("workspace.orchestrationTool")}</label>
                <select
                  value={setupTool}
                  onChange={(e) =>
                    setSetupTool(e.target.value as "bitbake-setup" | "oe-init-build-env" | "kas")
                  }
                  className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg"
                >
                  <option value="bitbake-setup">{t("workspace.setupBitbake")}</option>
                  <option value="oe-init-build-env">{t("workspace.setupClassic")}</option>
                  <option value="kas">{t("workspace.setupKas")}</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">{t("workspace.provider")}</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as ProviderKind)}
                  className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-fg"
                >
                  <option value="wsl2">WSL2 (ext4)</option>
                  <option value="docker">Docker CROPS / kas</option>
                  <option value="ssh">Remote SSH</option>
                  <option value="mock">Mock</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">MACHINE</label>
                <Input className="mono-num" value={machine} onChange={(e) => setMachine(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted">DISTRO</label>
                <Input className="mono-num" value={distro} onChange={(e) => setDistro(e.target.value)} />
              </div>
              <div className="flex items-end gap-2">
                <Button variant="primary" onClick={() => void handleCreate()}>
                  {t("workspace.create")}
                </Button>
                <Button onClick={() => setWorkspacePath("/mnt/c/yocto-bad")}>
                  {t("workspace.tryMntC")}
                </Button>
              </div>
            </div>

            {errorMsg && (
              <div className="rounded-md border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger mono-num">
                {errorMsg}
              </div>
            )}
          </Card>
        </>
      )}

      {subTab === "setup" && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-fg">
                Yocto 6.0 Wrynose <code className="mono-num">bitbake-setup status / update</code>
              </h2>
              <p className="text-xs text-muted">
                {t("workspace.setupSubtitle")}
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void setupQuery.refetch()}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t("workspace.refreshStatus")}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void handleSetupUpdate()}>
                {t("workspace.updatePreservingLocal")}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            {setupQuery.data?.layers.map((item) => (
              <div key={item.layer} className="rounded-md border border-border bg-bg p-3 text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold mono-num text-fg">{item.layer}</span>
                    <Badge>{item.branch}</Badge>
                    <span className="mono-num text-[11px] text-muted">
                      {item.current_rev} → {item.remote_rev}
                    </span>
                  </div>
                  <Badge
                    tone={
                      item.status === "up-to-date"
                        ? "ok"
                        : item.status === "behind"
                        ? "accent"
                        : "warn"
                    }
                  >
                    {item.status}
                  </Badge>
                </div>
                {item.local_changes.length > 0 && (
                  <div className="mono-num text-[11px] text-warning">
                    {t("workspace.localChanges", { files: item.local_changes.join(", ") })}
                  </div>
                )}
                {item.diff && (
                  <pre className="max-h-32 overflow-auto rounded border border-border bg-surface p-2 mono-num text-[11px]">
                    {item.diff.split("\n").map((ln, idx) => (
                      <div
                        key={idx}
                        className={
                          ln.startsWith("+")
                            ? "text-success"
                            : ln.startsWith("-")
                            ? "text-danger"
                            : "text-muted"
                        }
                      >
                        {ln}
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            ))}
          </div>
          {setupUpdateMsg && (
            <pre className="rounded border border-success/40 bg-success/10 p-2.5 mono-num text-[11px] text-fg">
              {setupUpdateMsg}
            </pre>
          )}
        </Card>
      )}

      {subTab === "kas" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void handleParseKas()}>
                {t("workspace.syncYamlToForm")}
              </Button>
              <Button size="sm" onClick={() => void handleKasRun("lock")}>
                <Lock className="h-3.5 w-3.5" />
                kas lock
              </Button>
              <Button size="sm" onClick={() => void handleKasRun("checkout")}>
                kas checkout
              </Button>
              <Button size="sm" variant="primary" onClick={() => void handleKasRun("build")}>
                <Play className="h-3.5 w-3.5 fill-current" />
                kas build
              </Button>
            </div>
            {kasWarnings.length > 0 && (
              <Badge tone="warn">{kasWarnings.join(" · ")}</Badge>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="space-y-2.5 text-xs">
              <div className="font-semibold text-fg">{t("workspace.visualKasForm")}</div>
              {kasConfig ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="mb-1 block text-[11px] text-muted">
                        {t("workspace.headerVersion")}
                      </label>
                      <Input
                        type="number"
                        className="mono-num"
                        value={kasConfig.header.version}
                        onChange={(e) =>
                          void handleFormToYaml({
                            ...kasConfig,
                            header: { ...kasConfig.header, version: Number(e.target.value) || 14 },
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] text-muted">machine</label>
                      <Input
                        className="mono-num"
                        value={kasConfig.machine}
                        onChange={(e) =>
                          void handleFormToYaml({ ...kasConfig, machine: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] text-muted">distro</label>
                      <Input
                        className="mono-num"
                        value={kasConfig.distro}
                        onChange={(e) =>
                          void handleFormToYaml({ ...kasConfig, distro: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-muted">
                      {t("workspace.targetCsv")}
                    </label>
                    <Input
                      className="mono-num"
                      value={kasConfig.target.join(", ")}
                      onChange={(e) =>
                        void handleFormToYaml({
                          ...kasConfig,
                          target: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-[11px] text-muted">{t("workspace.definedRepos")}</div>
                    <div className="space-y-1">
                      {Object.entries(kasConfig.repos).map(([rname, rdata]) => (
                        <div
                          key={rname}
                          className="flex items-center justify-between rounded border border-border bg-bg px-2.5 py-1.5"
                        >
                          <span className="mono-num font-semibold text-fg">{rname}</span>
                          <span className="mono-num text-[11px] text-muted truncate max-w-64">
                            {rdata.url ?? rdata.path} ({rdata.branch ?? rdata.commit ?? "HEAD"})
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-muted">{t("workspace.parsingYaml")}</div>
              )}
            </Card>

            <Card className="space-y-2 text-xs">
              <div className="font-semibold text-fg">{t("workspace.rawKasEditor")}</div>
              <textarea
                value={kasYaml}
                onChange={(e) => setKasYaml(e.target.value)}
                onBlur={() => void handleParseKas()}
                rows={14}
                spellCheck={false}
                className="w-full rounded-md border border-border bg-bg p-2.5 mono-num text-[11px] text-fg focus:border-accent focus:outline-none"
              />
            </Card>
          </div>

          {kasOutput && (
            <pre className="max-h-56 overflow-auto rounded-md border border-border bg-surface p-3 mono-num text-[11px] text-fg">
              {kasOutput}
            </pre>
          )}
        </div>
      )}

      {subTab === "import" && (
        <Card className="space-y-3 text-xs">
          <div>
            <h2 className="text-sm font-semibold text-fg">
              {t("workspace.importTitle")}
            </h2>
            <p className="text-muted">
              {t("workspace.importSubtitlePre")}<code className="mono-num">poky</code> /{" "}
              <code className="mono-num">oe-core</code>{t("workspace.importSubtitlePost")}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
            <div>
              <label className="mb-1 block text-[11px] text-muted">{t("workspace.projectName")}</label>
              <Input value={importName} onChange={(e) => setImportName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-muted">{t("workspace.workspaceRootExt4")}</label>
              <Input className="mono-num" value={importPath} onChange={(e) => setImportPath(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-muted">{t("workspace.buildDirectory")}</label>
              <Input
                className="mono-num"
                value={importBuildDir}
                onChange={(e) => setImportBuildDir(e.target.value)}
              />
            </div>
          </div>
          <Button variant="primary" onClick={() => void handleImport()}>
            {t("workspace.importWorkspaceBtn")}
          </Button>
          {importErr && (
            <div className="rounded border border-danger/40 bg-danger/10 p-2 mono-num text-danger">
              {importErr}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
