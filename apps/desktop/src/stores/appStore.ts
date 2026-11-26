import type { ProviderKind, WorkspaceProject } from "@yocto-studio/shared-protocol";
import { create } from "zustand";
import type { ConnectionState } from "@/lib/rpcClient";

export type ModuleId =
  | "environment"
  | "workspace"
  | "layers"
  | "config"
  | "recipes"
  | "build"
  | "artifacts"
  | "deploy"
  | "preflight"
  | "pro"
  | "enterprise";

export type DrawerTabId = "logs" | "tasks" | "cli" | "terminal" | "serial";

interface AppStoreState {
  activeModule: ModuleId;
  theme: "dark" | "light";
  sidebarOpen: boolean;
  drawerOpen: boolean;
  drawerTab: DrawerTabId;
  commandPaletteOpen: boolean;
  snapshotModalOpen: boolean;
  selectedRecipePn: string | null;
  connectionState: ConnectionState;
  activeProvider: ProviderKind;
  projects: WorkspaceProject[];
  activeProjectId: string | null;

  setActiveModule: (mod: ModuleId) => void;
  openRecipeInIde: (pn: string) => void;
  setSnapshotModalOpen: (open: boolean) => void;
  toggleTheme: () => void;
  setSidebarOpen: (open: boolean) => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerTab: (tab: DrawerTabId) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setConnectionState: (state: ConnectionState) => void;
  setActiveProvider: (provider: ProviderKind) => void;
  setProjects: (projects: WorkspaceProject[], activeId: string | null) => void;
}

export const useAppStore = create<AppStoreState>((set) => ({
  activeModule: "build",
  theme: "dark",
  sidebarOpen: true,
  drawerOpen: true,
  drawerTab: "logs",
  commandPaletteOpen: false,
  snapshotModalOpen: false,
  selectedRecipePn: null,
  connectionState: "disconnected",
  activeProvider: "mock",
  projects: [],
  activeProjectId: null,

  setActiveModule: (activeModule) => set({ activeModule }),
  openRecipeInIde: (pn) => set({ selectedRecipePn: pn, activeModule: "recipes" }),
  setSnapshotModalOpen: (snapshotModalOpen) => set({ snapshotModalOpen }),
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      if (typeof document !== "undefined") {
        document.documentElement.classList.toggle("dark", next === "dark");
      }
      return { theme: next };
    }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setDrawerTab: (drawerTab) => set({ drawerTab, drawerOpen: true }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  setConnectionState: (connectionState) => set({ connectionState }),
  setActiveProvider: (activeProvider) => set({ activeProvider }),
  setProjects: (projects, activeProjectId) => set({ projects, activeProjectId }),
}));
