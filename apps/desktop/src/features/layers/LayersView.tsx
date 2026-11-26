import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FolderPlus, Globe, Layers, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input, Modal, Switch } from "@/components/ui/primitives";
import { rpcClient } from "@/lib/rpcClient";

export function LayersView() {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [branch, setBranch] = useState("wrynose");
  const [kind, setKind] = useState<"layer" | "machine" | "recipe" | "distro">("layer");
  const [liveApi, setLiveApi] = useState(true);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newLayerName, setNewLayerName] = useState("meta-edge-bsp");
  const [newLayerPriority, setNewLayerPriority] = useState(9);
  const [newLayerCompat, setNewLayerCompat] = useState("wrynose, scarthgap");

  const layersQuery = useQuery({
    queryKey: ["layers-list"],
    queryFn: () => rpcClient.call("layers.list", {}),
  });

  const compatQuery = useQuery({
    queryKey: ["layers-check-compat"],
    queryFn: () => rpcClient.call("layers.check_compat", {}),
  });

  const indexQuery = useQuery({
    queryKey: ["layers-index", search, branch, kind, liveApi],
    queryFn: () =>
      rpcClient.call("layers.search_index", {
        query: search,
        branch,
        kind,
        live: liveApi,
        limit: 20,
      }),
  });

  const appendsQuery = useQuery({
    queryKey: ["layers-appends"],
    queryFn: () => rpcClient.call("layers.show_appends", {}),
  });

  const overlayedQuery = useQuery({
    queryKey: ["layers-overlayed"],
    queryFn: () => rpcClient.call("layers.show_overlayed", {}),
  });

  const refreshAll = async () => {
    await Promise.all([
      layersQuery.refetch(),
      compatQuery.refetch(),
      indexQuery.refetch(),
      appendsQuery.refetch(),
      overlayedQuery.refetch(),
    ]);
  };

  const handleAddFromIndex = async (name: string) => {
    await rpcClient.call("layers.fetch_from_index", { name, branch });
    await refreshAll();
  };

  const handleRemove = async (name: string) => {
    await rpcClient.call("layers.remove", { name });
    await refreshAll();
  };

  const handleCreateLayer = async () => {
    await rpcClient.call("layers.create_layer", {
      name: newLayerName,
      priority: newLayerPriority,
      compat: newLayerCompat
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setCreateModalOpen(false);
    await refreshAll();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-fg">{t("layers.title")}</h1>
          <p className="text-xs text-muted">
            {t("layers.subtitlePrefix")}<code className="mono-num">bitbake-layers</code>
            {t("layers.subtitleAnd")}
            <code className="mono-num">LAYERSERIES_COMPAT</code> /{" "}
            <code className="mono-num">BBFILE_PRIORITY</code>
            {t("layers.subtitleSuffix")}
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setCreateModalOpen(true)}>
          <FolderPlus className="h-3.5 w-3.5" />
          {t("layers.createLayerBtn")}
        </Button>
      </div>

      {/* Compatibility & Priority Check Card */}
      {compatQuery.data && (
        <Card
          className={`space-y-2 ${
            compatQuery.data.issues.length > 0 ? "border-warning/50 bg-warning/5" : "border-success/40"
          }`}
        >
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-fg flex items-center gap-2">
              {compatQuery.data.issues.length === 0 ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-warning" />
              )}
              {t("layers.compatCheckTitle", { series: compatQuery.data.active_series })}
            </span>
            <Badge tone={compatQuery.data.ok ? "ok" : "danger"}>
              {t("layers.issuesCount", { count: compatQuery.data.issues.length })}
            </Badge>
          </div>
          {compatQuery.data.issues.map((issue, idx) => (
            <div key={idx} className="rounded border border-border bg-bg p-2 text-xs space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="font-medium text-fg">{issue.message}</span>
                <Badge tone={issue.severity === "error" ? "danger" : "warn"}>{issue.kind}</Badge>
              </div>
              <div className="text-[11px] text-accent">
                {t("layers.fixHint", { hint: issue.fix_hint })}
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* Active Layers Table */}
      <Card className="space-y-2">
        <h2 className="text-sm font-semibold text-fg">
          {t("layers.activeLayersTitle", { count: layersQuery.data?.layers.length ?? 0 })}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[11px] text-muted">
                <th className="py-2 pr-3">{t("layers.colLayer")}</th>
                <th className="py-2 pr-3">{t("layers.colPriority")}</th>
                <th className="py-2 pr-3">{t("layers.colBranchCompat")}</th>
                <th className="py-2 pr-3">{t("layers.colStatus")}</th>
                <th className="py-2 text-right">{t("layers.colAction")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {layersQuery.data?.layers.map((layer) => (
                <tr key={layer.name}>
                  <td className="py-2 pr-3">
                    <div className="font-semibold mono-num text-fg">{layer.name}</div>
                    <div className="mono-num text-[11px] text-muted">{layer.path}</div>
                  </td>
                  <td className="py-2 pr-3 mono-num">{layer.priority}</td>
                  <td className="py-2 pr-3 mono-num text-muted">
                    {layer.branch} [{layer.compat.join(", ")}]
                  </td>
                  <td className="py-2 pr-3">
                    {layer.compatible_with_active ? (
                      <Badge tone="ok">{t("layers.compatible")}</Badge>
                    ) : (
                      <Badge tone="warn">
                        <AlertTriangle className="h-3 w-3" />
                        {t("layers.incompatible")}
                      </Badge>
                    )}
                    {layer.warning && (
                      <div className="mt-0.5 text-[11px] text-warning">{layer.warning}</div>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {layer.name !== "meta" && (
                      <Button size="sm" variant="ghost" onClick={() => void handleRemove(layer.name)}>
                        <Trash2 className="h-3.5 w-3.5 text-danger" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Live OpenEmbedded Layer Index Explorer */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-fg">OpenEmbedded Layer Index</h2>
            {indexQuery.data && (
              <Badge tone={indexQuery.data.source === "live" ? "ok" : "accent"}>
                {indexQuery.data.source.toUpperCase()}
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5 text-muted">
              <Switch checked={liveApi} onCheckedChange={setLiveApi} />
              {t("layers.liveApi")}
            </label>
            <select
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="h-8 rounded-md border border-border bg-bg px-2 text-xs text-fg mono-num"
            >
              {(indexQuery.data?.branches ?? ["wrynose", "scarthgap", "blacksail", "master"]).map(
                (br) => (
                  <option key={br} value={br}>
                    {br}
                  </option>
                )
              )}
            </select>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as "layer" | "machine" | "recipe" | "distro")}
              className="h-8 rounded-md border border-border bg-bg px-2 text-xs text-fg"
            >
              <option value="layer">{t("layers.kindLayer")}</option>
              <option value="machine">{t("layers.kindMachine")}</option>
              <option value="recipe">{t("layers.kindRecipe")}</option>
              <option value="distro">Distro</option>
            </select>
            <div className="relative w-52">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("layers.searchPlaceholder")}
                className="pl-7"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {indexQuery.data?.results.map((entry) => (
            <div
              key={`${entry.name}-${entry.branch}`}
              className="flex items-start justify-between gap-3 rounded-md border border-border bg-bg p-2.5 text-xs"
            >
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold mono-num text-fg truncate">{entry.name}</span>
                  <Badge>{entry.layer_type}</Badge>
                </div>
                <div className="text-muted line-clamp-2">{entry.summary}</div>
                <div className="mono-num text-[10px] text-muted truncate">{entry.vcs_url}</div>
              </div>
              {kind === "layer" &&
                (entry.installed ? (
                  <Badge tone="ok">{t("layers.installed")}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void handleAddFromIndex(entry.name)}
                  >
                    <Plus className="h-3 w-3" />
                    {t("layers.fetchAndAdd")}
                  </Button>
                ))}
            </div>
          ))}
        </div>
      </Card>

      {/* Appends & Overlayed */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="space-y-2.5">
          <h2 className="text-sm font-semibold text-fg">{t("layers.activeAppendsTitle")}</h2>
          <div className="space-y-2">
            {appendsQuery.data?.appends.map((ap) => (
              <div
                key={ap.append_file}
                className="rounded-md border border-border bg-bg p-2.5 text-xs space-y-0.5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold mono-num text-fg">{ap.recipe}</span>
                  <Badge tone="accent">{ap.layer}</Badge>
                </div>
                <div className="mono-num text-[11px] text-muted">{ap.append_file}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="space-y-2.5">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <Layers className="h-4 w-4 text-warning" />
            {t("layers.overlayedTitle")}
          </h2>
          <div className="space-y-2">
            {overlayedQuery.data?.overlayed.map((ov) => (
              <div
                key={ov.recipe}
                className="rounded-md border border-border bg-bg p-2.5 text-xs space-y-1"
              >
                <div className="font-semibold mono-num text-fg">{ov.recipe}</div>
                <div className="mono-num text-[11px] text-muted">
                  {t("layers.activePrefix")}{" "}
                  <span className="text-success">{ov.active_layer} (prio {ov.active_priority})</span> ·{" "}
                  {t("layers.shadowedPrefix")}{" "}
                  <span className="text-warning">{ov.shadowed_layer} (prio {ov.shadowed_priority})</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* create-layer Modal */}
      <Modal
        open={createModalOpen}
        onOpenChange={setCreateModalOpen}
        title={t("layers.modalTitle")}
        subtitle="bitbake-layers create-layer"
      >
        <div className="space-y-3 text-xs">
          <div>
            <label className="mb-1 block text-[11px] text-muted">{t("layers.layerNameLabel")}</label>
            <Input
              className="mono-num"
              value={newLayerName}
              onChange={(e) => setNewLayerName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[11px] text-muted">BBFILE_PRIORITY</label>
              <Input
                type="number"
                className="mono-num"
                value={newLayerPriority}
                onChange={(e) => setNewLayerPriority(Number(e.target.value) || 6)}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-muted">LAYERSERIES_COMPAT</label>
              <Input
                className="mono-num"
                value={newLayerCompat}
                onChange={(e) => setNewLayerCompat(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setCreateModalOpen(false)}>{t("layers.cancel")}</Button>
            <Button variant="primary" onClick={() => void handleCreateLayer()}>
              {t("layers.createAndAdd")}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
