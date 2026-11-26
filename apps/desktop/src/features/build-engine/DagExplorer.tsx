import dagre from "@dagrejs/dagre";
import { useQuery } from "@tanstack/react-query";
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { DagNode } from "@yocto-studio/shared-protocol";
import { HelpCircle, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { rpcClient } from "@/lib/rpcClient";
import { useAppStore } from "@/stores/appStore";

interface DagFlowNodeData extends Record<string, unknown> {
  dagNode: DagNode;
  highlighted: boolean;
}

const KIND_STYLES: Record<string, string> = {
  image: "border-sky-400 bg-sky-500/15",
  kernel: "border-amber-400 bg-amber-500/15",
  runtime: "border-emerald-400 bg-emerald-500/15",
  toolchain: "border-purple-400 bg-purple-500/15",
  app: "border-cyan-400 bg-cyan-500/15",
};

function YoctoTaskNode({ data }: NodeProps<Node<DagFlowNodeData>>) {
  const { dagNode, highlighted } = data;
  return (
    <div
      className={`min-w-[190px] rounded-md border px-2.5 py-2 text-xs shadow-sm bg-surface ${
        highlighted
          ? "border-accent ring-2 ring-accent/60"
          : KIND_STYLES[dagNode.kind] ?? "border-border"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-accent !w-2 !h-2" />
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold mono-num text-fg truncate">{dagNode.recipe}</span>
        <Badge tone={highlighted ? "accent" : "neutral"}>{dagNode.kind}</Badge>
      </div>
      <div className="mono-num text-[11px] text-accent truncate">{dagNode.task}</div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted">
        <span>{dagNode.layer}</span>
        <span className="mono-num">rdeps: {dagNode.rdepends_count}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-accent !w-2 !h-2" />
    </div>
  );
}

const nodeTypes = { yoctoTask: YoctoTaskNode };

function layoutWithDagre(
  rawNodes: DagNode[],
  rawEdges: Array<{ id: string; source: string; target: string }>,
  highlightedRecipes: Set<string>
): { nodes: Array<Node<DagFlowNodeData>>; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 42, ranksep: 64 });

  for (const n of rawNodes) {
    g.setNode(n.id, { width: 210, height: 74 });
  }
  for (const e of rawEdges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      g.setEdge(e.source, e.target);
    }
  }
  dagre.layout(g);

  const nodeRecipeMap = new Map(rawNodes.map((n) => [n.id, n.recipe]));
  const nodes: Array<Node<DagFlowNodeData>> = rawNodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: "yoctoTask",
      position: { x: pos.x - 105, y: pos.y - 37 },
      data: {
        dagNode: n,
        highlighted: highlightedRecipes.has(n.recipe),
      },
    };
  });

  const edges: Edge[] = rawEdges.map((e) => {
    const sRec = nodeRecipeMap.get(e.source) ?? "";
    const tRec = nodeRecipeMap.get(e.target) ?? "";
    const isHot = highlightedRecipes.has(sRec) && highlightedRecipes.has(tRec);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      animated: isHot,
      markerEnd: { type: MarkerType.ArrowClosed, color: isHot ? "#38BDF8" : "#64748B" },
      style: {
        stroke: isHot ? "#38BDF8" : "#475569",
        strokeWidth: isHot ? 2.5 : 1.2,
      },
    };
  });

  return { nodes, edges };
}

export function DagExplorer({ target }: { target: string }) {
  const { t } = useTranslation();
  const theme = useAppStore((s) => s.theme);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [whyPkg, setWhyPkg] = useState("openssl");
  const [whyResult, setWhyResult] = useState<{
    included: boolean;
    chains: string[][];
    direct_rdepends: string[];
  } | null>(null);

  const dagQuery = useQuery({
    queryKey: ["dag-generate", target, query, kind],
    queryFn: () =>
      rpcClient.call("dag.generate", {
        target,
        query: query || undefined,
        kind: kind || undefined,
        max_nodes: 120,
      }),
  });

  const highlightedRecipes = useMemo(() => {
    const set = new Set<string>();
    if (whyResult?.chains) {
      for (const ch of whyResult.chains) {
        for (const r of ch) set.add(r);
      }
    }
    return set;
  }, [whyResult]);

  const { nodes, edges } = useMemo(() => {
    if (!dagQuery.data) return { nodes: [], edges: [] };
    return layoutWithDagre(dagQuery.data.nodes, dagQuery.data.edges, highlightedRecipes);
  }, [dagQuery.data, highlightedRecipes]);

  const handleExplainWhy = async () => {
    const res = await rpcClient.call("dag.explain_why", { target, package: whyPkg });
    setWhyResult(res);
  };

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-fg">
            {t("dag.title", { target })}
          </h2>
          <p className="text-xs text-muted">
            {t("dag.summary", {
              nodes: dagQuery.data?.total_nodes ?? dagQuery.data?.nodes.length ?? 0,
              edges: dagQuery.data?.total_edges ?? dagQuery.data?.edges.length ?? 0,
            })}
            {dagQuery.data?.truncated ? t("dag.filteredWindow") : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="relative w-40">
            <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("dag.filterPlaceholder")}
              className="pl-7 h-7 text-xs"
            />
          </div>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="h-7 rounded border border-border bg-bg px-2 text-xs text-fg"
          >
            <option value="">{t("dag.allTypes")}</option>
            <option value="image">image</option>
            <option value="kernel">kernel</option>
            <option value="runtime">runtime</option>
            <option value="app">app</option>
            <option value="toolchain">toolchain</option>
          </select>

          <div className="flex items-center gap-1 border-l border-border pl-2">
            <Input
              value={whyPkg}
              onChange={(e) => setWhyPkg(e.target.value)}
              placeholder="openssl..."
              className="h-7 w-28 mono-num text-xs"
            />
            <Button size="sm" variant="primary" onClick={() => void handleExplainWhy()}>
              <HelpCircle className="h-3.5 w-3.5" />
              {t("dag.whyBtn")}
            </Button>
          </div>
        </div>
      </div>

      {whyResult && (
        <div className="rounded-md border border-accent/40 bg-accent/10 p-2.5 text-xs space-y-1">
          <div className="font-semibold text-fg">
            {t("dag.whyHeader", {
              pkg: whyPkg,
              status: whyResult.included ? t("dag.included") : t("dag.notFound"),
            })}
          </div>
          {whyResult.chains.map((ch, idx) => (
            <div key={idx} className="mono-num text-[11px] text-accent">
              {ch.join(" → ")}
            </div>
          ))}
        </div>
      )}

      <div className="h-[440px] w-full overflow-hidden rounded-md border border-border bg-bg">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode={theme}
          fitView
          minZoom={0.2}
          maxZoom={2}
        >
          <Background gap={18} size={1} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </Card>
  );
}
