import { useMutation, useQuery } from "@tanstack/react-query";
import type { DtNode } from "@yocto-studio/shared-protocol";
import { CheckCircle2, Cpu, FileCode2, GitBranch, Save, Search, AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { proRpc } from "@/lib/proSuiteApi";

function DtTreeItem({
  node,
  selectedPath,
  onSelect,
  depth = 0,
}: {
  node: DtNode;
  selectedPath: string;
  onSelect: (n: DtNode) => void;
  depth?: number;
}) {
  const active = node.path === selectedPath;
  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(node)}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        className={`flex w-full items-center justify-between rounded py-1.5 pr-2 text-left text-xs cursor-pointer ${
          active ? "bg-accent/15 text-accent font-semibold" : "text-fg hover:bg-elevated"
        }`}
      >
        <span className="mono-num truncate">
          {node.label ? `${node.label}: ` : ""}
          {node.name}
        </span>
        {node.status && (
          <Badge tone={node.status === "okay" ? "ok" : "neutral"}>{node.status}</Badge>
        )}
      </button>
      {node.children.map((ch) => (
        <DtTreeItem
          key={ch.path}
          node={ch}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export function KernelDtStudio() {
  const { t } = useTranslation();
  const [cfgSearch, setCfgSearch] = useState("");
  const [fragmentName, setFragmentName] = useState("custom-can-wireguard.cfg");
  const [fragResult, setFragResult] = useState<string | null>(null);

  const [selectedDtPath, setSelectedDtPath] = useState("");
  const [selectedNode, setSelectedNode] = useState<DtNode | null>(null);
  const [dtsDiff, setDtsDiff] = useState<string | null>(null);

  const cfgQ = useQuery({
    queryKey: ["pro-kernel-diff", cfgSearch],
    queryFn: () => proRpc.diffKernelConfig(cfgSearch),
  });

  const dtFilesQ = useQuery({
    queryKey: ["pro-dt-files"],
    queryFn: () => proRpc.listDtFiles(),
  });

  useEffect(() => {
    if (!selectedDtPath && dtFilesQ.data?.files.length) {
      setSelectedDtPath(dtFilesQ.data.files[0].path);
    }
  }, [dtFilesQ.data, selectedDtPath]);

  const dtTreeQ = useQuery({
    queryKey: ["pro-dt-tree", selectedDtPath],
    queryFn: () => proRpc.parseDtTree(selectedDtPath),
    enabled: Boolean(selectedDtPath),
  });

  useEffect(() => {
    if (dtTreeQ.data?.tree && !selectedNode) {
      setSelectedNode(dtTreeQ.data.tree.children[0] ?? dtTreeQ.data.tree);
    }
  }, [dtTreeQ.data, selectedNode]);

  const saveFragM = useMutation({
    mutationFn: () =>
      proRpc.saveKernelFragment(fragmentName, cfgQ.data?.fragment_content ?? ""),
    onSuccess: (res) =>
      setFragResult(
        `${t("pro.savedFragNotice", { path: res.fragment_path })}\n${res.bbappend_diff || res.bbappend_content}`
      ),
  });

  const toggleStatusM = useMutation({
    mutationFn: (newStatus: "okay" | "disabled") =>
      proRpc.updateDtNodeStatus(selectedDtPath, selectedNode?.path ?? "/", newStatus),
    onSuccess: (res) => {
      setDtsDiff(res.diff);
      void dtTreeQ.refetch();
      const findNode = (n: DtNode): DtNode | null => {
        if (n.path === selectedNode?.path) return n;
        for (const ch of n.children) {
          const hit = findNode(ch);
          if (hit) return hit;
        }
        return null;
      };
      const updated = findNode(res.tree);
      if (updated) setSelectedNode(updated);
    },
  });

  return (
    <div className="space-y-4">
      {/* Kernel Fragment Manager */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <Cpu className="h-4 w-4 text-accent" />
            {t("pro.kernelFragTitle")}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-48">
              <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted" />
              <Input
                value={cfgSearch}
                onChange={(e) => setCfgSearch(e.target.value)}
                placeholder={t("pro.searchConfigPlaceholder")}
                className="pl-7 mono-num"
              />
            </div>
            <Input
              value={fragmentName}
              onChange={(e) => setFragmentName(e.target.value)}
              className="w-48 mono-num"
            />
            <Button
              size="sm"
              variant="primary"
              onClick={() => saveFragM.mutate()}
              disabled={saveFragM.isPending}
            >
              <Save className="h-3.5 w-3.5" />
              {t("pro.saveFragBtn")}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 text-xs">
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold text-muted">
              {t("pro.capturedChanges", { count: cfgQ.data?.changes.length ?? 0 })}
            </div>
            {cfgQ.data?.changes.map((c) => (
              <div
                key={c.symbol}
                className="flex items-center justify-between rounded border border-border bg-bg px-2.5 py-1.5 mono-num"
              >
                <span className="text-fg">{c.symbol}</span>
                <span>
                  <span className="text-muted">{c.old_value ?? "unset"}</span> →{" "}
                  <span className="text-accent font-semibold">{c.new_value ?? "unset"}</span>
                </span>
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold text-muted">{t("pro.generatedFragment")}</div>
            <pre className="rounded border border-border bg-bg p-2.5 mono-num text-[11px] text-accent overflow-x-auto">
              {cfgQ.data?.fragment_content ?? ""}
            </pre>
          </div>
        </div>

        {fragResult && (
          <pre className="rounded border border-success/40 bg-success/10 p-2.5 text-[11px] mono-num text-success whitespace-pre-wrap">
            {fragResult}
          </pre>
        )}
      </Card>

      {/* Device Tree Explorer & Editor */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-accent" />
            {t("pro.dtTitle")}
          </h2>
          <div className="flex items-center gap-2">
            <select
              value={selectedDtPath}
              onChange={(e) => setSelectedDtPath(e.target.value)}
              className="h-8 rounded-md border border-border bg-bg px-2 text-xs text-fg mono-num"
            >
              {dtFilesQ.data?.files.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.layer} / {f.name}
                </option>
              ))}
            </select>
            {dtTreeQ.data && (
              <Badge tone={dtTreeQ.data.valid ? "ok" : "danger"}>
                {dtTreeQ.data.valid ? (
                  <>
                    <CheckCircle2 className="h-3 w-3" /> {t("pro.dtcValid")}
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-3 w-3" />{" "}
                    {t("pro.dtcErrors", { count: dtTreeQ.data.errors.length })}
                  </>
                )}
              </Badge>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 text-xs">
          <div className="lg:col-span-5 rounded border border-border bg-bg p-2 max-h-80 overflow-auto">
            {dtTreeQ.data?.tree && (
              <DtTreeItem
                node={dtTreeQ.data.tree}
                selectedPath={selectedNode?.path ?? "/"}
                onSelect={setSelectedNode}
              />
            )}
          </div>

          <div className="lg:col-span-7 space-y-3">
            {selectedNode ? (
              <div className="rounded border border-border bg-bg p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold mono-num text-fg flex items-center gap-1.5">
                      <FileCode2 className="h-3.5 w-3.5 text-accent" />
                      {selectedNode.path}
                    </div>
                    <div className="mono-num text-[11px] text-muted">
                      compatible: {selectedNode.compatible ?? "—"} · reg: {selectedNode.reg ?? "—"}
                    </div>
                  </div>
                  {selectedNode.path !== "/" && (
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant={selectedNode.status === "okay" ? "primary" : "secondary"}
                        onClick={() => toggleStatusM.mutate("okay")}
                      >
                        status = &quot;okay&quot;
                      </Button>
                      <Button
                        size="sm"
                        variant={selectedNode.status === "disabled" ? "danger" : "secondary"}
                        onClick={() => toggleStatusM.mutate("disabled")}
                      >
                        status = &quot;disabled&quot;
                      </Button>
                    </div>
                  )}
                </div>

                <div className="space-y-1 border-t border-border pt-2">
                  {Object.entries(selectedNode.properties).map(([k, v]) => (
                    <div key={k} className="flex justify-between mono-num text-[11px]">
                      <span className="text-muted">{k}</span>
                      <span className="text-fg">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {dtsDiff && (
              <pre className="rounded border border-accent/40 bg-bg p-2.5 mono-num text-[11px] text-accent overflow-x-auto">
                {dtsDiff}
              </pre>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
