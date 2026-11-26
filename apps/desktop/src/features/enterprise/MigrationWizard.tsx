import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Search, Wand2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { enterpriseRpc } from "@/lib/enterpriseApi";

export function MigrationWizard() {
  const { t } = useTranslation();
  const [fromLts, setFromLts] = useState<"kirkstone" | "scarthgap">("scarthgap");
  const [toLts, setToLts] = useState<"scarthgap" | "wrynose">("wrynose");
  const [layerName, setLayerName] = useState("meta-custom-iot");
  const [appliedDiff, setAppliedDiff] = useState("");
  const [appliedNotice, setAppliedNotice] = useState("");

  const scanQuery = useQuery({
    queryKey: ["enterprise-migration", fromLts, toLts, layerName],
    queryFn: () =>
      enterpriseRpc.scanMigration({
        from_lts: fromLts,
        to_lts: toLts,
        layer_name: layerName,
      }),
  });

  const handleApplyAll = async () => {
    const res = await enterpriseRpc.applyAllMigration({
      from_lts: fromLts,
      to_lts: toLts,
      layer_name: layerName,
    });
    setAppliedDiff(res.combined_diff);
    setAppliedNotice(
      t("enterprise.migration.appliedNotice", {
        count: res.applied_count,
        files: res.modified_files.length,
      })
    );
    await scanQuery.refetch();
  };

  const findings = scanQuery.data?.findings ?? [];

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-semibold">{t("enterprise.migration.heading")}</h3>
            <p className="text-[11px] text-muted">
              Kirkstone 4.0 → Scarthgap 5.0 → Wrynose 6.0 (UNPACKDIR, :append, debug-tweaks, sbom-cve-check, LAYERSERIES_COMPAT)
            </p>
          </div>
          <Badge tone={findings.length > 0 ? "warn" : "ok"}>
            {t("enterprise.migration.findingsCount", { count: findings.length })}
          </Badge>
        </div>

        <div className="flex flex-wrap items-end gap-2 text-xs">
          <label className="space-y-1">
            <span className="text-muted">{t("enterprise.migration.fromLabel")}</span>
            <select
              value={fromLts}
              onChange={(e) => setFromLts(e.target.value as "kirkstone" | "scarthgap")}
              className="block h-8 rounded border border-border bg-bg px-2 text-xs"
            >
              <option value="kirkstone">Kirkstone (4.0)</option>
              <option value="scarthgap">Scarthgap (5.0)</option>
            </select>
          </label>
          <ArrowRight className="h-4 w-4 mb-2 text-accent" />
          <label className="space-y-1">
            <span className="text-muted">{t("enterprise.migration.toLabel")}</span>
            <select
              value={toLts}
              onChange={(e) => setToLts(e.target.value as "scarthgap" | "wrynose")}
              className="block h-8 rounded border border-border bg-bg px-2 text-xs"
            >
              <option value="scarthgap">Scarthgap (5.0)</option>
              <option value="wrynose">Wrynose (6.0)</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-muted">{t("enterprise.migration.layerLabel")}</span>
            <Input
              className="w-48"
              value={layerName}
              onChange={(e) => setLayerName(e.target.value)}
            />
          </label>
          <Button variant="secondary" size="sm" onClick={() => void scanQuery.refetch()}>
            <Search className="h-3.5 w-3.5" />
            {t("enterprise.migration.scanBtn")}
          </Button>
          {findings.length > 0 && (
            <Button variant="primary" size="sm" onClick={() => void handleApplyAll()}>
              <Wand2 className="h-3.5 w-3.5" />
              {t("enterprise.migration.applyAllBtn")}
            </Button>
          )}
        </div>

        {appliedNotice && (
          <div className="rounded border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
            {appliedNotice}
          </div>
        )}

        {findings.length === 0 ? (
          <div className="flex items-center gap-2 rounded border border-success/30 bg-success/10 p-3 text-xs text-success">
            <CheckCircle2 className="h-4 w-4" />
            {t("enterprise.migration.compatibleMsg", { layer: layerName, toLts })}
          </div>
        ) : (
          <div className="space-y-2">
            {findings.map((f) => (
              <div
                key={f.id}
                className="rounded border border-border bg-bg/70 p-2.5 text-xs space-y-1"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold mono-num">
                    {f.file_path}:{f.line_number}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Badge tone={f.severity === "error" ? "danger" : "warn"}>{f.rule_id}</Badge>
                    <Badge tone="accent">{f.migration_path}</Badge>
                  </div>
                </div>
                <p className="text-[11px] text-muted">{f.reason}</p>
                <div className="rounded bg-bg p-2 mono-num text-[11px]">
                  <div className="text-danger">- {f.before_line}</div>
                  <div className="text-success">+ {f.after_line}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {(appliedDiff || scanQuery.data?.combined_diff) && (
        <Card className="p-4 space-y-2">
          <div className="text-xs font-semibold">{t("enterprise.migration.diffPreviewTitle")}</div>
          <pre className="max-h-56 overflow-auto rounded bg-bg p-2.5 text-[11px] mono-num">
            {appliedDiff || scanQuery.data?.combined_diff}
          </pre>
        </Card>
      )}
    </div>
  );
}
