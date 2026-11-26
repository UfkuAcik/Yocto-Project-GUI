import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import i18next, { syncNativeLanguage } from "@/i18n";
import { CommandPalette } from "@/app/CommandPalette";
import { LayoutShell } from "@/app/LayoutShell";
import { ArtifactsView } from "@/features/artifacts/ArtifactsView";
import { BuildEngineView } from "@/features/build-engine/BuildEngineView";
import { ConfigStudioView } from "@/features/config-studio/ConfigStudioView";
import { EnterpriseHubView } from "@/features/enterprise/EnterpriseHubView";
import { ProjectSnapshotModal } from "@/features/enterprise/ProjectSnapshotModal";
import { LayersView } from "@/features/layers/LayersView";
import { EnvironmentDoctorView } from "@/features/onboarding/EnvironmentDoctorView";
import { PreFlightDashboard } from "@/features/preflight-advisor/PreFlightDashboard";
import { ProSuiteView } from "@/features/pro-suite/ProSuiteView";
import { RecipeIdeView } from "@/features/recipe-ide/RecipeIdeView";
import { TargetDeployView } from "@/features/target-deploy/TargetDeployView";
import { BottomDrawer } from "@/features/terminal/BottomDrawer";
import { WorkspaceView } from "@/features/workspace/WorkspaceView";
import type { TftpTransferRecord } from "@/lib/deployApi";
import { rpcClient } from "@/lib/rpcClient";
import { getBridgeStatus, isTauriRuntime } from "@/lib/tauriApi";
import { useAppStore } from "@/stores/appStore";
import { useBuildStore } from "@/stores/buildStore";
import { useDeployStore } from "@/stores/deployStore";
import { usePreFlightStore } from "@/stores/preflightStore";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
    },
  },
});

function StudioContent() {
  const activeModule = useAppStore((s) => s.activeModule);
  const setConnectionState = useAppStore((s) => s.setConnectionState);
  const setProjects = useAppStore((s) => s.setProjects);
  const handleBridgeEvent = useBuildStore((s) => s.handleBridgeEvent);
  const appendLocalPtyOutput = useBuildStore((s) => s.appendLocalPtyOutput);
  const setSnapshot = useBuildStore((s) => s.setSnapshot);

  useEffect(() => {
    const unsubState = rpcClient.onStateChange((st) => {
      setConnectionState(st);
      if (st === "connected") {
        void rpcClient.call("workspace.list", {}).then((res) => {
          setProjects(res.projects, res.active_project_id);
        });
        void rpcClient.call("build.status", {}).then((snap) => {
          setSnapshot(snap);
        });
      }
    });

    const unsubNotif = rpcClient.onNotification((method, params) => {
      handleBridgeEvent(method, params);
    });

    const unsubListeners: Array<Promise<() => void>> = [];
    if (isTauriRuntime()) {
      const activeLang: "tr" | "en" = i18next.language === "en" ? "en" : "tr";
      void syncNativeLanguage(activeLang).then(() => {
        if (activeLang === "en") {
          void queryClient.invalidateQueries();
        }
      });
      unsubListeners.push(
        listen<{ session_id: string; data: string }>("pty://output", (ev) => {
          appendLocalPtyOutput(ev.payload.session_id, ev.payload.data);
        })
      );
      unsubListeners.push(
        listen<{
          job_id: string;
          phase: string;
          percent: number;
          bytes_written: number;
          total_bytes: number;
          speed_mb_s: number;
          message: string;
        }>("deploy://progress", (ev) => {
          useDeployStore.getState().updateJobProgress(ev.payload);
        })
      );
      unsubListeners.push(
        listen<{ job_id: string; line: string }>("deploy://log", (ev) => {
          useDeployStore.getState().appendJobLog(ev.payload.job_id, ev.payload.line);
        })
      );
      unsubListeners.push(
        listen<{
          job_id: string;
          status: "running" | "succeeded" | "failed" | "cancelled";
          summary: string;
          sha256?: string | null;
        }>("deploy://status", (ev) => {
          useDeployStore.getState().updateJobStatus(ev.payload);
        })
      );
      unsubListeners.push(
        listen<TftpTransferRecord>("deploy://tftp-transfer", (ev) => {
          useDeployStore.getState().upsertTftpTransfer(ev.payload);
        })
      );
      unsubListeners.push(
        listen<{ session_id: string; data: string; ts: string }>(
          "deploy://serial-data",
          (ev) => {
            useDeployStore.getState().appendSerialOutput(ev.payload.data, ev.payload.ts);
          }
        )
      );
    }

    void getBridgeStatus().then((st) => {
      rpcClient.connect(st.ws_url);
    });

    const onLanguageChanged = () => {
      usePreFlightStore.getState().setReport(null);
      void queryClient.invalidateQueries();
      if (rpcClient.getConnectionState() === "connected") {
        void rpcClient.call("workspace.list", {}).then((res) => {
          setProjects(res.projects, res.active_project_id);
        });
        void rpcClient.call("build.status", {}).then((snap) => {
          setSnapshot(snap);
        });
      }
    };
    i18next.on("languageChanged", onLanguageChanged);

    return () => {
      i18next.off("languageChanged", onLanguageChanged);
      unsubState();
      unsubNotif();
      for (const p of unsubListeners) {
        void p.then((fn) => fn());
      }
    };
  }, [appendLocalPtyOutput, handleBridgeEvent, setConnectionState, setProjects, setSnapshot]);

  const renderModule = () => {
    switch (activeModule) {
      case "environment":
        return <EnvironmentDoctorView />;
      case "workspace":
        return <WorkspaceView />;
      case "layers":
        return <LayersView />;
      case "config":
        return <ConfigStudioView />;
      case "recipes":
        return <RecipeIdeView />;
      case "build":
        return <BuildEngineView />;
      case "artifacts":
        return <ArtifactsView />;
      case "deploy":
        return <TargetDeployView />;
      case "preflight":
        return <PreFlightDashboard />;
      case "pro":
        return <ProSuiteView />;
      case "enterprise":
        return <EnterpriseHubView />;
    }
  };

  return (
    <>
      <LayoutShell bottomDrawer={<BottomDrawer />}>{renderModule()}</LayoutShell>
      <CommandPalette />
      <ProjectSnapshotModal />
    </>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <StudioContent />
    </QueryClientProvider>
  );
}
