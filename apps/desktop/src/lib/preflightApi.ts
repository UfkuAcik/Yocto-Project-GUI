import { invoke } from "@tauri-apps/api/core";
import type { PreFlightFixAction } from "@yocto-studio/shared-protocol";
import { rpcClient } from "@/lib/rpcClient";
import { isTauriRuntime } from "@/lib/tauriApi";

export interface PreFlightHostProfile {
  cpu_cores: number;
  ram_total_gb: number;
  ram_available_gb: number;
  disk_free_gb: number;
  psi_supported: boolean;
  provider: string;
}

const GATE_LS_KEY = "yocto_studio_preflight_gate";

export async function getPreFlightHostProfile(): Promise<PreFlightHostProfile> {
  if (isTauriRuntime()) {
    return invoke<PreFlightHostProfile>("get_preflight_host_profile");
  }
  return {
    cpu_cores: 8,
    ram_total_gb: 32.0,
    ram_available_gb: 22.4,
    disk_free_gb: 142.0,
    psi_supported: true,
    provider: "wsl2",
  };
}

export async function getPreFlightGateEnabled(): Promise<boolean> {
  if (isTauriRuntime()) {
    return invoke<boolean>("get_preflight_gate_enabled");
  }
  try {
    const val = localStorage.getItem(GATE_LS_KEY);
    return val === null ? true : val === "true";
  } catch {
    return true;
  }
}

export async function setPreFlightGateEnabled(enabled: boolean): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("set_preflight_gate_enabled", { enabled });
    return;
  }
  try {
    localStorage.setItem(GATE_LS_KEY, String(enabled));
  } catch {
    // ignore storage errors
  }
}

export const preflightRpc = {
  runAudit: (params: {
    target?: string;
    incompatible_licenses?: string[];
    check_layer?: string;
    host_resources?: PreFlightHostProfile;
  }) => rpcClient.call("preflight.runAudit", params),

  getVersionMatrix: (params: { target?: string; query?: string }) =>
    rpcClient.call("preflight.getVersionMatrix", params),

  checkUpgrades: (recipes?: string[]) =>
    rpcClient.call("preflight.checkUpgrades", { recipes }),

  probeSstate: (target?: string) => rpcClient.call("preflight.probeSstate", { target }),

  getOptimizationPlan: (host_resources?: PreFlightHostProfile) =>
    rpcClient.call("preflight.getOptimizationPlan", { host_resources }),

  applyFix: (params: {
    fix: PreFlightFixAction;
    dry_run?: boolean;
    target?: string;
    incompatible_licenses?: string[];
    host_resources?: PreFlightHostProfile;
  }) => rpcClient.call("preflight.applyFix", params),
};
