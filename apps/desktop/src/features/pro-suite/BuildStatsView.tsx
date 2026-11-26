import { useQuery } from "@tanstack/react-query";
import { BarChart3, Clock, Cpu, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { proRpc } from "@/lib/proSuiteApi";
import { useBuildStore } from "@/stores/buildStore";

export function BuildStatsView() {
  const { t } = useTranslation();
  const target = useBuildStore((s) => s.selectedBuildTarget);
  const statsQ = useQuery({
    queryKey: ["pro-buildstats", target],
    queryFn: () => proRpc.analyzeBuildStats(target),
  });

  const totalSec = Math.max(1, statsQ.data?.total_duration_sec ?? 1);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-fg flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-accent" />
            {t("pro.buildstatsTitle")}
          </h2>
          <p className="text-xs text-muted">
            <code className="mono-num">tmp/buildstats/</code>
            {t("pro.buildstatsSubSuffix")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {statsQ.data && (
            <>
              <Badge tone="accent" className="mono-num">
                <Clock className="h-3 w-3" />
                {t("pro.totalSecBadge", { sec: statsQ.data.total_duration_sec })}
              </Badge>
              <Badge tone="ok" className="mono-num">
                <Cpu className="h-3 w-3" />
                {t("pro.avgCpuBadge", { pct: statsQ.data.avg_cpu_percent })}
              </Badge>
            </>
          )}
          <Button size="sm" onClick={() => void statsQ.refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("pro.analyzeBtn")}
          </Button>
        </div>
      </div>

      <div className="space-y-2 text-xs">
        {statsQ.data?.top_tasks.map((task) => {
          const leftPct = Math.min(90, (task.start_offset_sec / totalSec) * 100);
          const widthPct = Math.max(3, (task.duration_sec / totalSec) * 100);
          return (
            <div key={`${task.recipe}-${task.task}-${task.start_offset_sec}`} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="mono-num font-medium text-fg">
                  {task.recipe}:{task.task}
                </span>
                <span className="mono-num text-[11px] text-muted">
                  {t("pro.taskStatLine", { sec: task.duration_sec, pct: task.cpu_percent })}
                </span>
              </div>
              <div className="relative h-3.5 w-full rounded bg-elevated overflow-hidden">
                <div
                  className="absolute top-0 bottom-0 rounded bg-accent"
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
