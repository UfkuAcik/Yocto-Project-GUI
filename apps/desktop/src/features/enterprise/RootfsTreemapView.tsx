import { useQuery } from "@tanstack/react-query";
import type { RootfsPackageItem } from "@yocto-studio/shared-protocol";
import { ExternalLink, FileSearch, Layers, PieChart, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { enterpriseRpc } from "@/lib/enterpriseApi";
import { useAppStore } from "@/stores/appStore";
import { computeTreemapLayout } from "./treemapLayout";

const CATEGORY_COLORS: Record<string, string> = {
  "Kernel & Firmware": "bg-sky-600/80 border-sky-400/50",
  "Graphics & Multimedia": "bg-violet-600/80 border-violet-400/50",
  "Systemd & Core OS": "bg-emerald-600/80 border-emerald-400/50",
  "Security & Networking": "bg-amber-600/80 border-amber-400/50",
  "Runtime & Scripting": "bg-rose-600/80 border-rose-400/50",
  "Custom Applications": "bg-cyan-600/80 border-cyan-400/50",
  "Shared Libraries": "bg-indigo-600/80 border-indigo-400/50",
  "Other Packages": "bg-slate-600/80 border-slate-400/50",
};

export function RootfsTreemapView() {
  const { t } = useTranslation();
  const openRecipeInIde = useAppStore((s) => s.openRecipeInIde);

  const [selectedCategory, setSelectedCategory] = useState<string>("ALL");
  const [selectedPkg, setSelectedPkg] = useState<RootfsPackageItem | null>(null);
  const [pathQuery, setPathQuery] = useState("/usr/lib/libcrypto.so.3");
  const [diffRecipe, setDiffRecipe] = useState("my-sensor-daemon");
  const [diffTask, setDiffTask] = useState("do_compile");

  const treemapQuery = useQuery({
    queryKey: ["enterprise-treemap"],
    queryFn: () => enterpriseRpc.getRootfsTreemap("core-image-minimal"),
  });

  const pathQueryRes = useQuery({
    queryKey: ["enterprise-pkgdata-path", pathQuery],
    queryFn: () => enterpriseRpc.findRootfsPath(pathQuery),
  });

  const diffsigsQuery = useQuery({
    queryKey: ["enterprise-diffsigs", diffRecipe, diffTask],
    queryFn: () => enterpriseRpc.diffSigs(diffRecipe, diffTask),
  });

  const filteredPackages = useMemo(() => {
    const all = treemapQuery.data?.packages ?? [];
    return selectedCategory === "ALL"
      ? all
      : all.filter((p) => p.category === selectedCategory);
  }, [treemapQuery.data, selectedCategory]);

  const rects = useMemo(() => computeTreemapLayout(filteredPackages), [filteredPackages]);
  const totalMb = ((treemapQuery.data?.total_bytes ?? 0) / (1024 * 1024)).toFixed(1);

  return (
    <div className="space-y-4">
      {/* Treemap Header & Category Filters */}
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <PieChart className="h-4 w-4 text-accent" />
            <span className="text-xs font-semibold">{t("enterprise.rootfs.treemapTitle")}</span>
            <Badge tone="accent" className="mono-num">
              {totalMb} MB
            </Badge>
            <Badge className="mono-num">
              {treemapQuery.data?.package_count ?? 0} {t("enterprise.rootfs.packageCount")}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              variant={selectedCategory === "ALL" ? "primary" : "secondary"}
              onClick={() => setSelectedCategory("ALL")}
            >
              {t("enterprise.rootfs.allCategories")}
            </Button>
            {(treemapQuery.data?.categories ?? []).slice(0, 6).map((c) => (
              <Button
                key={c.category}
                size="sm"
                variant={selectedCategory === c.category ? "primary" : "secondary"}
                onClick={() => setSelectedCategory(c.category)}
              >
                {c.category} ({c.percent}%)
              </Button>
            ))}
          </div>
        </div>

        {/* Interactive Treemap Canvas */}
        <div className="relative h-80 w-full overflow-hidden rounded-md border border-border bg-bg">
          {rects.map((r) => {
            const cls = CATEGORY_COLORS[r.item.category] ?? CATEGORY_COLORS["Other Packages"];
            const showLabel = r.width > 7 && r.height > 10;
            const active = selectedPkg?.name === r.item.name;
            return (
              <button
                key={r.item.name}
                type="button"
                onClick={() => setSelectedPkg(r.item)}
                title={`${r.item.name} (${r.item.recipe}) — ${(r.item.size_kb / 1024).toFixed(2)} MB (${r.item.percent}%)`}
                style={{
                  left: `${r.x}%`,
                  top: `${r.y}%`,
                  width: `${r.width}%`,
                  height: `${r.height}%`,
                }}
                className={`absolute border p-1 text-left transition-opacity hover:opacity-100 cursor-pointer overflow-hidden ${cls} ${
                  active ? "ring-2 ring-white z-10 opacity-100" : "opacity-90"
                }`}
              >
                {showLabel && (
                  <div className="text-[10px] leading-tight text-white">
                    <div className="font-semibold truncate">{r.item.name}</div>
                    <div className="mono-num opacity-85">
                      {(r.item.size_kb / 1024).toFixed(1)} MB
                    </div>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {selectedPkg && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-bg/70 p-2.5 text-xs">
            <div className="space-y-0.5">
              <div className="font-semibold mono-num">
                {selectedPkg.name}{" "}
                <Badge tone="accent">{selectedPkg.category}</Badge>
              </div>
              <div className="text-muted mono-num text-[11px]">
                {t("enterprise.rootfs.recipeLabel")}: {selectedPkg.recipe} ·{" "}
                {(selectedPkg.size_kb / 1024).toFixed(2)} MB ({selectedPkg.percent}%) ·{" "}
                {t("enterprise.rootfs.sampleLabel")}: {selectedPkg.sample_files.join(", ")}
              </div>
            </div>
            <Button size="sm" variant="primary" onClick={() => openRecipeInIde(selectedPkg.recipe)}>
              <ExternalLink className="h-3.5 w-3.5" />
              {t("enterprise.rootfs.openInIdeBtn")}
            </Button>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* File -> Package -> Recipe Reverse Lookup */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <FileSearch className="h-4 w-4 text-accent" />
            {t("enterprise.rootfs.reverseLookupTitle")}
          </div>
          <div className="flex gap-2">
            <Input
              value={pathQuery}
              onChange={(e) => setPathQuery(e.target.value)}
              placeholder={t("enterprise.rootfs.lookupPlaceholder")}
            />
            <Button variant="primary" size="sm" onClick={() => void pathQueryRes.refetch()}>
              {t("enterprise.rootfs.searchBtn")}
            </Button>
          </div>
          <div className="space-y-2">
            {(pathQueryRes.data?.matches ?? []).map((m) => (
              <div
                key={`${m.package}-${m.file_path}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-bg/70 p-2.5 text-xs"
              >
                <div className="space-y-0.5 min-w-0">
                  <div className="mono-num font-semibold truncate">{m.file_path}</div>
                  <div className="text-[11px] text-muted mono-num">
                    {t("enterprise.rootfs.packageLabel")}: <span className="text-fg">{m.package}</span> ·{" "}
                    {t("enterprise.rootfs.recipeLabel")}:{" "}
                    <span className="text-accent">{m.recipe}</span> ({m.layer})
                  </div>
                  <div className="text-[10px] text-muted truncate">{m.recipe_file}</div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => openRecipeInIde(m.recipe)}>
                  <ExternalLink className="h-3 w-3" />
                  {t("enterprise.rootfs.openInIdeBtn")}
                </Button>
              </div>
            ))}
          </div>
        </Card>

        {/* bitbake-diffsigs Explainer */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Sparkles className="h-4 w-4 text-warning" />
              {t("enterprise.rootfs.diffsigsTitle")}
            </div>
            <Badge className="mono-num">
              {diffsigsQuery.data?.old_sig.slice(0, 8)} → {diffsigsQuery.data?.new_sig.slice(0, 8)}
            </Badge>
          </div>
          <div className="flex gap-2">
            <Input value={diffRecipe} onChange={(e) => setDiffRecipe(e.target.value)} placeholder="recipe" />
            <Input value={diffTask} onChange={(e) => setDiffTask(e.target.value)} placeholder="do_compile" />
            <Button variant="secondary" size="sm" onClick={() => void diffsigsQuery.refetch()}>
              <Layers className="h-3.5 w-3.5" />
              {t("enterprise.rootfs.analyzeSigsBtn")}
            </Button>
          </div>
          {diffsigsQuery.data && (
            <div className="space-y-2">
              <div className="text-xs text-accent font-medium">{diffsigsQuery.data.summary}</div>
              {diffsigsQuery.data.causes.map((c, idx) => (
                <div
                  key={`${c.symbol}-${idx}`}
                  className="rounded border border-border bg-bg/70 p-2 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold mono-num">{c.symbol}</span>
                    <Badge tone={c.impact === "high" ? "danger" : "warn"}>{c.cause_type}</Badge>
                  </div>
                  <p className="text-[11px] text-muted">{c.explanation}</p>
                  <div className="mono-num text-[10px]">
                    <span className="text-danger">- {c.before}</span>
                    <br />
                    <span className="text-success">+ {c.after}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
