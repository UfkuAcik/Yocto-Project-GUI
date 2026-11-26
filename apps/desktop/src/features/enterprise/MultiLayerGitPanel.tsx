import { useQuery } from "@tanstack/react-query";
import { ArchiveRestore, FileDiff, GitBranch, GitCommit, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { enterpriseRpc } from "@/lib/enterpriseApi";

export function MultiLayerGitPanel() {
  const { t } = useTranslation();
  const [selectedLayer, setSelectedLayer] = useState("meta-custom-iot");
  const [commitMsg, setCommitMsg] = useState("chore(layer): update recipe configuration");
  const [diffText, setDiffText] = useState("");
  const [actionLog, setActionLog] = useState("");

  const gitQuery = useQuery({
    queryKey: ["enterprise-git-status"],
    queryFn: () => enterpriseRpc.gitStatusAll(),
  });

  const runAction = async (
    layer: string,
    action: "fetch" | "diff" | "stash" | "stash_pop" | "commit",
    message?: string
  ) => {
    const res = await enterpriseRpc.gitRunAction({ layer_name: layer, action, message });
    setSelectedLayer(layer);
    setActionLog(`${layer}: ${res.output}`);
    if (res.diff !== undefined) {
      setDiffText(res.diff);
    }
    await gitQuery.refetch();
  };

  const handleFetchAll = async () => {
    const layers = gitQuery.data?.layers ?? [];
    for (const l of layers) {
      await enterpriseRpc.gitRunAction({ layer_name: l.layer_name, action: "fetch" });
    }
    setActionLog(t("enterprise.git.fetchAllDone", { count: layers.length }));
    await gitQuery.refetch();
  };

  const layers = gitQuery.data?.layers ?? [];

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <GitBranch className="h-4 w-4 text-accent" />
            {t("enterprise.git.heading")}
          </div>
          <Button variant="primary" size="sm" onClick={() => void handleFetchAll()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("enterprise.git.fetchAllBtn")}
          </Button>
        </div>

        {actionLog && (
          <div className="rounded border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs text-accent">
            {actionLog}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[11px] text-muted">
                <th className="py-2 pr-3">{t("enterprise.git.colLayer")}</th>
                <th className="py-2 pr-3">Branch</th>
                <th className="py-2 pr-3">Commit</th>
                <th className="py-2 pr-3">{t("enterprise.git.colStatus")}</th>
                <th className="py-2 pr-3">Upstream</th>
                <th className="py-2 text-right">{t("enterprise.git.colActions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {layers.map((repo) => {
                const totalDirty = repo.dirty_count + repo.staged_count + repo.untracked_count;
                return (
                  <tr key={repo.layer_name} className="hover:bg-elevated/40">
                    <td className="py-2 pr-3 font-semibold mono-num">{repo.layer_name}</td>
                    <td className="py-2 pr-3">
                      <Badge tone="accent">{repo.branch}</Badge>
                    </td>
                    <td className="py-2 pr-3 mono-num text-[11px]" title={repo.commit_message}>
                      {repo.commit_sha}{" "}
                      <span className="text-muted truncate inline-block max-w-48 align-bottom">
                        {repo.commit_message}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      {totalDirty === 0 ? (
                        <Badge tone="ok">{t("enterprise.git.cleanTree")}</Badge>
                      ) : (
                        <Badge tone="warn">
                          {t("enterprise.git.dirtyFiles", { count: totalDirty })}
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3 mono-num text-[11px]">
                      ↑{repo.ahead} ↓{repo.behind}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void runAction(repo.layer_name, "diff")}
                        >
                          <FileDiff className="h-3 w-3" />
                          {t("enterprise.git.diffBtn")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void runAction(repo.layer_name, "stash")}
                        >
                          <ArchiveRestore className="h-3 w-3" />
                          {t("enterprise.git.stashBtn")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4 space-y-2">
          <div className="text-xs font-semibold">
            {t("enterprise.git.selectedCommitTitle", { layer: selectedLayer })}
          </div>
          <div className="flex gap-2">
            <Input
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder={t("enterprise.git.commitPlaceholder")}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => void runAction(selectedLayer, "commit", commitMsg)}
            >
              <GitCommit className="h-3.5 w-3.5" />
              {t("enterprise.git.commitBtn")}
            </Button>
          </div>
        </Card>

        <Card className="p-4 space-y-2">
          <div className="text-xs font-semibold">
            {t("enterprise.git.diffPreviewHeading", { layer: selectedLayer })}
          </div>
          <pre className="max-h-40 overflow-auto rounded bg-bg p-2 text-[11px] mono-num">
            {diffText || t("enterprise.git.diffEmptyHint")}
          </pre>
        </Card>
      </div>
    </div>
  );
}
