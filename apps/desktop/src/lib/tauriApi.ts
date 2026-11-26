import { invoke } from "@tauri-apps/api/core";
import type { PathValidationResult, ProviderKind } from "@yocto-studio/shared-protocol";
import i18next from "@/i18n";
import { rpcClient } from "./rpcClient";

export interface WslDistroInfo {
  name: string;
  state: string;
  version: number;
  is_default: boolean;
}

export interface WslConfigInfo {
  path: string;
  exists: boolean;
  memory: string | null;
  processors: string | null;
  swap: string | null;
}

export interface VhdxMaintenancePlan {
  vhdx_path: string;
  mount_point: string;
  size_gb: number;
  create_and_mount_commands: string[];
  optimize_vhd_command: string;
  prune_sstate_command: string;
}

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  wsl_distro?: string | null;
  docker_image?: string | null;
  docker_sstate_vol?: string | null;
  docker_dl_vol?: string | null;
  docker_tmp_vol?: string | null;
  ssh_host?: string | null;
  ssh_port?: number | null;
  ssh_user?: string | null;
  ssh_key_path?: string | null;
  ssh_use_agent?: boolean | null;
  remote_workspace_root?: string | null;
  is_default?: boolean | null;
}

export interface ProviderTestResult {
  provider: ProviderKind;
  reachable: boolean;
  latency_ms: number;
  summary: string;
  remote_ram_gb?: number | null;
  remote_disk_free_gb?: number | null;
  missing_packages: string[];
  checks: Array<{
    id: string;
    label: string;
    status: "ok" | "warn" | "error";
    detail: string;
    fix_command?: string | null;
  }>;
}

export interface EnvironmentHealth {
  host_os: string;
  cpu_cores: number;
  ram_total_gb: number;
  disk_free_gb: number;
  yocto6_ram_ok: boolean;
  yocto6_disk_ok: boolean;
  recommended_provider: ProviderKind;
  wsl2: {
    installed: boolean;
    default_version: number | null;
    distros: WslDistroInfo[];
    wslconfig: WslConfigInfo;
    raw_status: string;
  };
  docker: {
    installed: boolean;
    daemon_running: boolean;
    version: string | null;
  };
  ssh: {
    client_available: boolean;
    version: string | null;
    configured_hosts: string[];
  };
  checks: Array<{
    id: string;
    label: string;
    status: "ok" | "warn" | "error";
    detail: string;
    fix_command?: string | null;
  }>;
}

export interface BridgeStatus {
  running: boolean;
  mode: string;
  port: number;
  ws_url: string;
  http_url: string;
  pid: number | null;
  last_error: string | null;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getBridgeStatus(): Promise<BridgeStatus> {
  if (isTauriRuntime()) {
    return invoke<BridgeStatus>("get_bridge_status");
  }
  return {
    running: rpcClient.getConnectionState() === "connected",
    mode: "mock",
    port: 18765,
    ws_url: "ws://127.0.0.1:18765/ws",
    http_url: "http://127.0.0.1:18765",
    pid: null,
    last_error: null,
  };
}

export async function getEnvironmentHealth(): Promise<EnvironmentHealth> {
  if (isTauriRuntime()) {
    return invoke<EnvironmentHealth>("get_environment_health");
  }
  const bridgeDoctor = await rpcClient.call("env.doctor", { provider: "mock" });
  return {
    host_os: "browser-preview",
    cpu_cores: navigator.hardwareConcurrency || 8,
    ram_total_gb: 32.0,
    disk_free_gb: 240.0,
    yocto6_ram_ok: true,
    yocto6_disk_ok: true,
    recommended_provider: "mock",
    wsl2: {
      installed: false,
      default_version: null,
      distros: [],
      wslconfig: { path: "~/.wslconfig", exists: false, memory: "24GB", processors: "8", swap: "8GB" },
      raw_status:
        i18next.language === "en"
          ? "Tauri host scanning is simulated in browser preview mode."
          : "Tarayıcı önizleme modunda Tauri yerel taraması simüle edilir.",
    },
    docker: { installed: false, daemon_running: false, version: null },
    ssh: { client_available: true, version: "OpenSSH (Mock)", configured_hosts: [] },
    checks: bridgeDoctor.checks,
  };
}

export async function validateWorkspacePath(
  path: string,
  provider: ProviderKind
): Promise<PathValidationResult> {
  if (isTauriRuntime()) {
    return invoke<PathValidationResult>("validate_workspace_path", { path, provider });
  }
  return rpcClient.call("env.validate_path", { path, provider });
}

export async function testProviderConnection(
  profile: ProviderProfile
): Promise<ProviderTestResult> {
  if (isTauriRuntime()) {
    return invoke<ProviderTestResult>("test_provider_connection", { profile });
  }
  const isEn = i18next.language === "en";
  return {
    provider: profile.kind,
    reachable: profile.kind === "mock",
    latency_ms: 4,
    summary:
      profile.kind === "mock"
        ? isEn
          ? "Mock engine is active."
          : "Mock motoru aktif."
        : isEn
        ? "Live WSL2/Docker/SSH probing runs inside the Tauri desktop shell."
        : "Gerçek WSL2/Docker/SSH taraması Tauri masaüstü kabuğunda çalışır.",
    missing_packages: [],
    checks: [
      {
        id: "preview",
        label: `Provider (${profile.kind})`,
        status: profile.kind === "mock" ? "ok" : "warn",
        detail:
          profile.kind === "mock"
            ? isEn
              ? "WebSocket JSON-RPC 2.0 connected."
              : "WebSocket JSON-RPC 2.0 bağlı."
            : isEn
            ? "Local host processes cannot run inside browser preview."
            : "Tarayıcı önizlemesinde yerel proses çalıştırılamaz.",
      },
    ],
  };
}

const PREVIEW_PROFILES_KEY = "yocto_studio_provider_profiles";

export async function listProviderProfiles(): Promise<ProviderProfile[]> {
  if (isTauriRuntime()) {
    return invoke<ProviderProfile[]>("list_provider_profiles");
  }
  try {
    const raw = localStorage.getItem(PREVIEW_PROFILES_KEY);
    return raw ? (JSON.parse(raw) as ProviderProfile[]) : [];
  } catch {
    return [];
  }
}

export async function saveProviderProfile(profile: ProviderProfile): Promise<void> {
  if (isTauriRuntime()) {
    return invoke("save_provider_profile", { profile });
  }
  const existing = await listProviderProfiles();
  const next = [profile, ...existing.filter((p) => p.id !== profile.id)];
  localStorage.setItem(PREVIEW_PROFILES_KEY, JSON.stringify(next));
}

export async function deleteProviderProfile(id: string): Promise<void> {
  if (isTauriRuntime()) {
    return invoke("delete_provider_profile", { id });
  }
  const existing = await listProviderProfiles();
  localStorage.setItem(
    PREVIEW_PROFILES_KEY,
    JSON.stringify(existing.filter((p) => p.id !== id))
  );
}

export async function updateWslconfig(
  memory: string,
  processors: number,
  swap?: string
): Promise<WslConfigInfo> {
  if (isTauriRuntime()) {
    return invoke<WslConfigInfo>("update_wslconfig", { memory, processors, swap });
  }
  return { path: "~/.wslconfig (preview)", exists: true, memory, processors: String(processors), swap: swap ?? null };
}

export async function getVhdxMaintenancePlan(
  vhdxPath: string,
  mountPoint: string,
  sizeGb: number,
  sstateDir: string
): Promise<VhdxMaintenancePlan> {
  if (isTauriRuntime()) {
    return invoke<VhdxMaintenancePlan>("get_vhdx_maintenance_plan", {
      vhdxPath,
      mountPoint,
      sizeGb,
      sstateDir,
    });
  }
  return {
    vhdx_path: vhdxPath,
    mount_point: mountPoint,
    size_gb: sizeGb,
    create_and_mount_commands: [
      `New-VHD -Path "${vhdxPath}" -SizeBytes ${sizeGb}GB -Dynamic`,
      `wsl --mount "${vhdxPath}" --vhd --bare`,
      `wsl -u root -- mkfs.ext4 -L yocto-ext4 /dev/sdX && wsl -u root -- mkdir -p ${mountPoint}`,
    ],
    optimize_vhd_command: `wsl --shutdown ; Optimize-VHD -Path "${vhdxPath}" -Mode Full`,
    prune_sstate_command: `find ${sstateDir} -type f -atime +30 -delete`,
  };
}

export async function ensureDockerVolumes(): Promise<string[]> {
  if (isTauriRuntime()) {
    return invoke<string[]>("ensure_docker_volumes");
  }
  return [
    "yocto-studio-workspace",
    "yocto-studio-sstate-cache",
    "yocto-studio-downloads",
    "yocto-studio-build-tmp",
  ];
}

export interface LocalPtyDescriptor {
  session_id: string;
  cols: number;
  rows: number;
  title: string;
}

export async function ptyLocalOpen(
  cols: number,
  rows: number,
  shellCmd?: string,
  cwd?: string
): Promise<LocalPtyDescriptor> {
  if (!isTauriRuntime()) {
    throw new Error(
      i18next.language === "en"
        ? "Local PTY is only available inside the Tauri desktop shell."
        : "Yerel PTY yalnızca Tauri masaüstü kabuğunda kullanılabilir."
    );
  }
  return invoke<LocalPtyDescriptor>("pty_local_open", {
    cols,
    rows,
    shellCmd: shellCmd ?? null,
    cwd: cwd ?? null,
  });
}

export async function ptyLocalWrite(sessionId: string, data: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("pty_local_write", { sessionId, data });
  }
}

export async function ptyLocalResize(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("pty_local_resize", { sessionId, cols, rows });
  }
}

export async function ptyLocalClose(sessionId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("pty_local_close", { sessionId });
  }
}

export interface BuildRunRecord {
  id: string;
  project_id: string;
  target: string;
  status: string;
  duration_ms: number;
  sstate_hits: number;
  sstate_misses: number;
  created_at: string;
}

export interface RemovableDriveInfo {
  id: string;
  name: string;
  device_path: string;
  size_bytes: number;
  size_human: string;
  bus_type: string;
  is_system_disk: boolean;
  removable: boolean;
  mount_points: string[];
}

export interface FlashPlan {
  image_path: string;
  image_filename: string;
  target_device: string;
  method: string;
  command: string;
  warnings: string[];
  requires_elevation: boolean;
}

export interface CopyArtifactResult {
  ok: boolean;
  source_path: string;
  dest_path: string;
  bytes_copied: number;
}

const LOCAL_RUNS_KEY = "yocto_studio_mock_build_runs";

export async function listBuildRuns(): Promise<BuildRunRecord[]> {
  if (isTauriRuntime()) {
    return invoke<BuildRunRecord[]>("list_build_runs");
  }
  try {
    const raw = localStorage.getItem(LOCAL_RUNS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as BuildRunRecord[];
  } catch {
    return [];
  }
}

export async function recordBuildRun(record: BuildRunRecord): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("record_build_run", { record });
    return;
  }
  try {
    const existing = await listBuildRuns();
    const updated = [record, ...existing.filter((r) => r.id !== record.id)].slice(0, 50);
    localStorage.setItem(LOCAL_RUNS_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage errors in non-persistent contexts
  }
}

export async function listRemovableDrives(includeMockIfEmpty = true): Promise<RemovableDriveInfo[]> {
  if (isTauriRuntime()) {
    return invoke<RemovableDriveInfo[]>("list_removable_drives", {
      includeMockIfEmpty,
    });
  }
  const isEn = i18next.language === "en";
  return [
    {
      id: "browser-sys-0",
      name: isEn ? "NVMe System Disk (Protected)" : "NVMe Sistem Diski (Korumalı)",
      device_path: "\\\\.\\PHYSICALDRIVE0",
      size_bytes: 512_000_000_000,
      size_human: "476.8 GB",
      bus_type: "NVME",
      is_system_disk: true,
      removable: false,
      mount_points: ["C:\\"],
    },
    {
      id: "mock-sd-01",
      name: isEn ? "SanDisk Industrial microSD 32GB (Simulation)" : "SanDisk Industrial microSD 32GB (Simülasyon)",
      device_path: "mock://sd-card-industrial-32g",
      size_bytes: 31_914_983_424,
      size_human: "29.7 GB",
      bus_type: "USB (Mock)",
      is_system_disk: false,
      removable: true,
      mount_points: [],
    },
  ];
}

export async function buildFlashPlan(imagePath: string, targetDevice: string): Promise<FlashPlan> {
  if (isTauriRuntime()) {
    return invoke<FlashPlan>("build_flash_plan", {
      imagePath,
      targetDevice,
    });
  }
  const isEn = i18next.language === "en";
  const upper = targetDevice.trim().toUpperCase();
  if (upper === "C:" || upper === "C:\\" || upper.includes("PHYSICALDRIVE0") || targetDevice === "/dev/sda") {
    throw new Error(
      isEn
        ? `Safety Lock: Direct image writing onto system disk (${targetDevice}) is blocked.`
        : `Güvenlik Kilidi: Sistem diski (${targetDevice}) üzerine doğrudan imaj yazımı engellenmiştir.`
    );
  }
  return {
    image_path: imagePath,
    image_filename: imagePath.split(/[\\/]/).pop() ?? imagePath,
    target_device: targetDevice,
    method: "dry-run-bmaptool",
    command: `bmaptool copy "${imagePath}" "${targetDevice}"`,
    warnings: isEn
      ? [
          `All partitions on the target device (${targetDevice}) will be erased.`,
          "Only removable USB/SD drives are permitted; system disks are locked.",
        ]
      : [
          `Hedef aygıttaki (${targetDevice}) tüm bölümler silinecektir.`,
          "Yalnızca çıkarılabilir USB/SD sürücülere izin verilir; sistem diskleri kilitlidir.",
        ],
    requires_elevation: false,
  };
}

export async function copyArtifactToHost(
  sourcePath: string,
  destDir?: string
): Promise<CopyArtifactResult> {
  if (isTauriRuntime()) {
    return invoke<CopyArtifactResult>("copy_artifact_to_host", {
      sourcePath,
      destDir: destDir ?? null,
    });
  }
  return {
    ok: true,
    source_path: sourcePath,
    dest_path: `${destDir ?? "C:\\Users\\Demo\\Downloads\\yocto-artifacts"}\\${sourcePath.split(/[\\/]/).pop() ?? "artifact"}`,
    bytes_copied: 148_392_448,
  };
}
