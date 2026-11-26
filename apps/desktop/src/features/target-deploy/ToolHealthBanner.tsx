import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FolderOpen, RefreshCw, Wrench } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { getFlashToolsHealth, setFlashToolPath } from "@/lib/deployApi";

export function ToolHealthBanner() {
  const { t, i18n } = useTranslation();
  const healthQ = useQuery({
    queryKey: ["deploy-tools-health", i18n.language],
    queryFn: () => getFlashToolsHealth(),
  });

  const [editingToolId, setEditingToolId] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState("");

  async function savePath(toolId: string) {
    await setFlashToolPath(toolId, customPath);
    setEditingToolId(null);
    setCustomPath("");
    await healthQ.refetch();
  }

  return (
    <Card className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-fg">
          <Wrench className="h-4 w-4 text-accent" />
          {t("deploy.toolHealthTitle")}
        </div>
        <Button size="sm" onClick={() => void healthQ.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t("deploy.scanTools")}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {healthQ.data?.map((tool) => (
          <button
            key={tool.tool_id}
            type="button"
            onClick={() => {
              setEditingToolId(tool.tool_id === editingToolId ? null : tool.tool_id);
              setCustomPath(tool.resolved_path ?? tool.binary);
            }}
            title={tool.resolved_path ?? tool.install_hint}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg px-2.5 py-1 text-xs hover:border-accent/60 cursor-pointer"
          >
            {tool.found ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5 text-warning" />
            )}
            <span className="font-medium text-fg">{tool.tool_id}</span>
            <Badge tone={tool.found ? "ok" : "warn"}>
              {tool.found ? t("deploy.toolReady") : t("deploy.selectPath")}
            </Badge>
          </button>
        ))}
      </div>

      {editingToolId && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-bg p-2.5 text-xs">
          <span className="text-muted">
            <strong className="text-fg">{t("deploy.customBinaryPath", { tool: editingToolId })}</strong>
          </span>
          <Input
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            placeholder={t("deploy.customPathPlaceholder")}
            className="flex-1 min-w-56 mono-num"
          />
          <Button size="sm" variant="primary" onClick={() => void savePath(editingToolId)}>
            {t("deploy.save")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditingToolId(null)}>
            {t("deploy.cancel")}
          </Button>
        </div>
      )}
    </Card>
  );
}
