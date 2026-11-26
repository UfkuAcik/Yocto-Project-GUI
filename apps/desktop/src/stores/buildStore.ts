import type {
  BridgeEventMap,
  BridgeEventName,
  BuildSnapshot,
  BuildTaskState,
} from "@yocto-studio/shared-protocol";
import { create } from "zustand";
import { rpcClient } from "@/lib/rpcClient";
import { isTauriRuntime, ptyLocalClose, ptyLocalOpen, recordBuildRun } from "@/lib/tauriApi";
import { useAppStore } from "@/stores/appStore";

export interface LogLine {
  seq: number;
  level: "NOTE" | "WARNING" | "ERROR" | "DEBUG";
  recipe: string | null;
  task: string | null;
  message: string;
  ts: number;
}

export interface TelemetryPoint {
  cpu_percent: number;
  ram_used_gb: number;
  ram_total_gb: number;
  disk_read_mb_s: number;
  disk_write_mb_s: number;
  ts: number;
}

export interface CommandAuditItem {
  id: string;
  command: string;
  cwd: string;
  provider: string;
  status: "running" | "ok" | "error";
  ts: number;
}

export interface PtyTabSession {
  id: string;
  title: string;
  kind: string;
  backend: "bridge" | "local";
  buffer: string;
}

const MAX_LOG_LINES = 120_000;
const MAX_TELEMETRY_SAMPLES = 60;

interface BuildStoreState {
  snapshot: BuildSnapshot;
  logs: LogLine[];
  telemetry: TelemetryPoint[];
  cliFeed: CommandAuditItem[];
  ptyTabs: PtyTabSession[];
  activePtyTabId: string | null;
  selectedBuildTarget: string;

  setSelectedBuildTarget: (target: string) => void;
  setSnapshot: (snapshot: BuildSnapshot) => void;
  clearLogs: () => void;
  setActivePtyTab: (id: string) => void;
  appendLocalPtyOutput: (sessionId: string, data: string) => void;
  openBridgePtyTab: (
    kind?: "shell" | "devshell" | "menuconfig" | "diffconfig" | "runqemu",
    recipe?: string
  ) => Promise<string>;
  attachBridgePtyTab: (sessionId: string, title: string, kind: string) => void;
  openLocalPtyTab: () => Promise<string | null>;
  closePtyTab: (id: string) => Promise<void>;
  handleBridgeEvent: (method: BridgeEventName, params: BridgeEventMap[BridgeEventName]) => void;
}

const INITIAL_SNAPSHOT: BuildSnapshot = {
  build_id: null,
  target: null,
  machine: "imx8mp-lpddr4-evk",
  distro: "poky",
  status: "idle",
  total_tasks: 0,
  completed_tasks: 0,
  sstate_hits: 0,
  sstate_misses: 0,
  elapsed_ms: 0,
  active_tasks: [],
  failed_task: null,
};

export const useBuildStore = create<BuildStoreState>((set, get) => ({
  snapshot: INITIAL_SNAPSHOT,
  logs: [],
  telemetry: [],
  cliFeed: [],
  ptyTabs: [],
  activePtyTabId: null,
  selectedBuildTarget: "core-image-minimal",

  setSelectedBuildTarget: (selectedBuildTarget) => set({ selectedBuildTarget }),
  setSnapshot: (snapshot) => set({ snapshot }),
  clearLogs: () => set({ logs: [] }),
  setActivePtyTab: (activePtyTabId) => set({ activePtyTabId }),

  appendLocalPtyOutput: (sessionId, data) => {
    set((s) => ({
      ptyTabs: s.ptyTabs.map((t) =>
        t.id === sessionId ? { ...t, buffer: (t.buffer + data).slice(-64000) } : t
      ),
    }));
  },

  openBridgePtyTab: async (kind = "shell", recipe) => {
    const res = await rpcClient.call("pty.open", { kind, recipe });
    set((s) => {
      const existing = s.ptyTabs.find((t) => t.id === res.session_id);
      if (existing) return { activePtyTabId: existing.id };
      const tab: PtyTabSession = {
        id: res.session_id,
        title: res.title,
        kind: res.kind,
        backend: "bridge",
        buffer: "",
      };
      return {
        ptyTabs: [...s.ptyTabs, tab],
        activePtyTabId: tab.id,
      };
    });
    useAppStore.getState().setDrawerTab("terminal");
    return res.session_id;
  },

  attachBridgePtyTab: (sessionId, title, kind) => {
    set((s) => {
      const existing = s.ptyTabs.find((t) => t.id === sessionId);
      if (existing) return { activePtyTabId: existing.id };
      const tab: PtyTabSession = {
        id: sessionId,
        title,
        kind,
        backend: "bridge",
        buffer: "",
      };
      return {
        ptyTabs: [...s.ptyTabs, tab],
        activePtyTabId: tab.id,
      };
    });
    useAppStore.getState().setDrawerOpen(true);
    useAppStore.getState().setDrawerTab("terminal");
  },

  openLocalPtyTab: async () => {
    if (!isTauriRuntime()) return null;
    const desc = await ptyLocalOpen(100, 24);
    const tab: PtyTabSession = {
      id: desc.session_id,
      title: desc.title,
      kind: "local-shell",
      backend: "local",
      buffer: "",
    };
    set((s) => ({
      ptyTabs: [...s.ptyTabs, tab],
      activePtyTabId: tab.id,
    }));
    useAppStore.getState().setDrawerTab("terminal");
    return desc.session_id;
  },

  closePtyTab: async (id) => {
    const tab = get().ptyTabs.find((t) => t.id === id);
    if (tab) {
      if (tab.backend === "local") {
        await ptyLocalClose(id).catch(() => {});
      } else {
        await rpcClient.call("pty.close", { session_id: id }).catch(() => {});
      }
    }
    set((s) => {
      const next = s.ptyTabs.filter((t) => t.id !== id);
      const nextActive =
        s.activePtyTabId === id ? (next[next.length - 1]?.id ?? null) : s.activePtyTabId;
      return { ptyTabs: next, activePtyTabId: nextActive };
    });
  },

  handleBridgeEvent: (method, params) => {
    switch (method) {
      case "build.started": {
        const ev = params as BridgeEventMap["build.started"];
        set((s) => ({
          logs: [],
          snapshot: {
            ...s.snapshot,
            build_id: ev.build_id,
            target: ev.target,
            machine: ev.machine,
            distro: ev.distro,
            status: "running",
            total_tasks: ev.total_tasks,
            completed_tasks: 0,
            sstate_hits: 0,
            sstate_misses: 0,
            elapsed_ms: 0,
            active_tasks: [],
            failed_task: null,
          },
        }));
        break;
      }
      case "build.task_started": {
        const ev = params as BridgeEventMap["build.task_started"];
        set((s) => {
          const others = s.snapshot.active_tasks.filter((t) => t.worker_slot !== ev.worker_slot);
          const nextTask: BuildTaskState = {
            task_id: ev.task_id,
            recipe: ev.recipe,
            task: ev.task,
            worker_slot: ev.worker_slot,
            progress: 0,
            status: ev.from_sstate ? "cached" : "running",
            started_at: ev.ts,
          };
          return {
            snapshot: {
              ...s.snapshot,
              active_tasks: [...others, nextTask].sort((a, b) => a.worker_slot - b.worker_slot),
            },
          };
        });
        break;
      }
      case "build.task_progress": {
        const ev = params as BridgeEventMap["build.task_progress"];
        set((s) => ({
          snapshot: {
            ...s.snapshot,
            active_tasks: s.snapshot.active_tasks.map((t) =>
              t.task_id === ev.task_id ? { ...t, progress: ev.progress } : t
            ),
          },
        }));
        break;
      }
      case "build.task_succeeded": {
        const ev = params as BridgeEventMap["build.task_succeeded"];
        set((s) => ({
          snapshot: {
            ...s.snapshot,
            completed_tasks: ev.completed_tasks,
            total_tasks: ev.total_tasks,
            sstate_hits: ev.sstate_hits,
            sstate_misses: ev.sstate_misses,
            active_tasks: s.snapshot.active_tasks.filter((t) => t.task_id !== ev.task_id),
          },
        }));
        break;
      }
      case "build.task_failed": {
        const ev = params as BridgeEventMap["build.task_failed"];
        set((s) => ({
          snapshot: {
            ...s.snapshot,
            status: "failed",
            active_tasks: s.snapshot.active_tasks.filter((t) => t.task_id !== ev.task_id),
            failed_task: {
              recipe: ev.recipe,
              task: ev.task,
              exit_code: ev.exit_code,
              error_summary: ev.error_summary,
              log_path: ev.log_path,
              run_path: ev.run_path,
            },
          },
        }));
        break;
      }
      case "build.completed": {
        const ev = params as BridgeEventMap["build.completed"];
        set((s) => ({
          snapshot: {
            ...s.snapshot,
            status: ev.status,
            completed_tasks: ev.completed_tasks,
            total_tasks: ev.total_tasks,
            sstate_hits: ev.sstate_hits,
            sstate_misses: ev.sstate_misses,
            elapsed_ms: ev.duration_ms,
            active_tasks: [],
          },
        }));
        const projectId = useAppStore.getState().activeProjectId ?? "proj-wrynose-evk";
        void recordBuildRun({
          id: ev.build_id,
          project_id: projectId,
          target: ev.target,
          status: ev.status,
          duration_ms: Math.round(ev.duration_ms),
          sstate_hits: ev.sstate_hits,
          sstate_misses: ev.sstate_misses,
          created_at: new Date().toISOString(),
        }).catch(() => {});
        break;
      }
      case "build.log": {
        const ev = params as BridgeEventMap["build.log"];
        set((s) => {
          const next = [
            ...s.logs,
            {
              seq: ev.seq,
              level: ev.level,
              recipe: ev.recipe,
              task: ev.task,
              message: ev.message,
              ts: ev.ts,
            },
          ];
          if (next.length > MAX_LOG_LINES) {
            next.splice(0, next.length - MAX_LOG_LINES);
          }
          return { logs: next };
        });
        break;
      }
      case "telemetry.sample": {
        const ev = params as BridgeEventMap["telemetry.sample"];
        set((s) => {
          const next = [...s.telemetry, ev];
          if (next.length > MAX_TELEMETRY_SAMPLES) {
            next.splice(0, next.length - MAX_TELEMETRY_SAMPLES);
          }
          return { telemetry: next };
        });
        break;
      }
      case "command.executed": {
        const ev = params as BridgeEventMap["command.executed"];
        set((s) => ({
          cliFeed: [ev, ...s.cliFeed].slice(0, 100),
        }));
        break;
      }
      case "pty.output": {
        const ev = params as BridgeEventMap["pty.output"];
        set((s) => {
          const exists = s.ptyTabs.some((t) => t.id === ev.session_id);
          if (!exists) {
            const tab: PtyTabSession = {
              id: ev.session_id,
              title: ev.session_id,
              kind: "shell",
              backend: "bridge",
              buffer: ev.data,
            };
            return {
              ptyTabs: [...s.ptyTabs, tab],
              activePtyTabId: s.activePtyTabId ?? ev.session_id,
            };
          }
          return {
            ptyTabs: s.ptyTabs.map((t) =>
              t.id === ev.session_id
                ? { ...t, buffer: (t.buffer + ev.data).slice(-64000) }
                : t
            ),
          };
        });
        break;
      }
      default:
        break;
    }
  },
}));
