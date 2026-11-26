import { invoke } from "@tauri-apps/api/core";
import type { RpcMethodMap, RpcMethodName } from "@yocto-studio/shared-protocol";
import i18next from "@/i18n";
import { rpcClient } from "./rpcClient";
import { isTauriRuntime } from "./tauriApi";

export type EnterpriseRpc = {
  <M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]["params"]
  ): Promise<RpcMethodMap[M]["result"]>;
};

export const callEnterpriseRpc: EnterpriseRpc = (method, params) =>
  rpcClient.call(method, params);

export const enterpriseRpc = {
  multiconfigList: () => rpcClient.call("enterprise.multiconfig.list", {}),
  multiconfigSave: (params: RpcMethodMap["enterprise.multiconfig.save"]["params"]) =>
    rpcClient.call("enterprise.multiconfig.save", params),
  multiconfigDelete: (name: string) => rpcClient.call("enterprise.multiconfig.delete", { name }),
  scanAutorev: (layer_filter?: string) =>
    rpcClient.call("enterprise.offline.scanAutorev", { layer_filter }),
  pinAutorev: (finding_ids: string[]) =>
    rpcClient.call("enterprise.offline.pinAutorev", { finding_ids }),
  prepareMirror: (params: RpcMethodMap["enterprise.offline.prepareMirror"]["params"]) =>
    rpcClient.call("enterprise.offline.prepareMirror", params),
  configureArchiver: (params: RpcMethodMap["enterprise.offline.configureArchiver"]["params"]) =>
    rpcClient.call("enterprise.offline.configureArchiver", params),
  getRootfsTreemap: (image?: string) => rpcClient.call("enterprise.rootfs.getTreemap", { image }),
  findRootfsPath: (path: string) => rpcClient.call("enterprise.rootfs.findPath", { path }),
  diffSigs: (recipe?: string, task?: string) =>
    rpcClient.call("enterprise.rootfs.diffSigs", { recipe, task }),
  exportIdeConfig: (params: RpcMethodMap["enterprise.debug.exportIdeConfig"]["params"]) =>
    rpcClient.call("enterprise.debug.exportIdeConfig", params),
  startGdbserver: (params: RpcMethodMap["enterprise.debug.startGdbserver"]["params"]) =>
    rpcClient.call("enterprise.debug.startGdbserver", params),
  getLiveTelemetry: (params: RpcMethodMap["enterprise.debug.getLiveTelemetry"]["params"]) =>
    rpcClient.call("enterprise.debug.getLiveTelemetry", params),
  scanMigration: (params: RpcMethodMap["enterprise.migration.scan"]["params"]) =>
    rpcClient.call("enterprise.migration.scan", params),
  applyAllMigration: (params: RpcMethodMap["enterprise.migration.applyAll"]["params"]) =>
    rpcClient.call("enterprise.migration.applyAll", params),
  gitStatusAll: () => rpcClient.call("enterprise.git.statusAll", {}),
  gitRunAction: (params: RpcMethodMap["enterprise.git.runAction"]["params"]) =>
    rpcClient.call("enterprise.git.runAction", params),
  getSstateRunnerAnalytics: (
    params: RpcMethodMap["enterprise.sstate.getRunnerAnalytics"]["params"]
  ) => rpcClient.call("enterprise.sstate.getRunnerAnalytics", params),
};

export interface SnapshotExportResult {
  ok: boolean;
  path: string;
  format: string;
  size_bytes: number;
  sha256: string;
  stripped_secret_count: number;
  preview_json: string;
}

export interface SnapshotImportResult {
  ok: boolean;
  project_name: string;
  target_profiles_imported: number;
  provider_profiles_imported: number;
  openvex_count: number;
  preflight_gate_enabled: boolean;
  kas_config: string | null;
  openvex_records: unknown;
}

export interface UpdaterConfigInfo {
  current_version: string;
  endpoints: string[];
  pubkey_configured: boolean;
  signing_ready: boolean;
  auto_check: boolean;
  last_checked_at: string | null;
  channel: string;
}

export interface UpdateCheckResult {
  status: string;
  current_version: string;
  latest_version: string | null;
  release_notes: string | null;
  download_url: string | null;
  signature_verified_manifest: boolean;
  checked_at: string;
  message: string;
}

const SENSITIVE_KEY_WORDS = [
  "password",
  "passwd",
  "secret",
  "api_key",
  "apikey",
  "token",
  "private_key",
  "passphrase",
  "credential",
  "authorization",
  "ssh_key_path",
  "ssh_key_ref",
];

/** Browser/test helper mirroring Rust's zero-secret-leakage sanitization. */
export function sanitizeSnapshotObject<T>(input: T): T {
  if (typeof input === "string") {
    let s: string = input;
    if (s.includes("BEGIN") && s.includes("PRIVATE KEY")) {
      return "[REDACTED_PRIVATE_KEY]" as unknown as T;
    }
    s = s.replace(/https?:\/\/[^:\s/@]+:[^@\s/@]+@/g, (m) => `${m.split("://")[0]}://`);
    s = s.replace(/\b(sk-|ghp_|gho_|AKIA|xoxb-)[A-Za-z0-9_-]{7,}/g, "[REDACTED_TOKEN]");
    return s as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeSnapshotObject(item)) as unknown as T;
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      const low = k.toLowerCase();
      if (SENSITIVE_KEY_WORDS.some((w) => low.includes(w))) {
        out[k] = "";
      } else {
        out[k] = sanitizeSnapshotObject(v);
      }
    }
    return out as T;
  }
  return input;
}

export async function exportProjectSnapshot(params: {
  projectId?: string;
  format?: "json" | "zip";
  kasConfig?: string;
  openvexRecords?: unknown;
  incompatibleLicenses?: string[];
  outputPath?: string;
}): Promise<SnapshotExportResult> {
  if (isTauriRuntime()) {
    return invoke<SnapshotExportResult>("export_project_snapshot", {
      projectId: params.projectId ?? null,
      format: params.format ?? "json",
      kasConfig: params.kasConfig ?? null,
      openvexRecords: params.openvexRecords ?? [],
      incompatibleLicenses: params.incompatibleLicenses ?? [],
      outputPath: params.outputPath ?? null,
    });
  }

  const sanitizedPayload = sanitizeSnapshotObject({
    schema: "yocto-studio-snapshot/v1",
    exported_at: new Date().toISOString(),
    app_version: "0.1.0",
    project: { id: params.projectId ?? "proj-wrynose-imx8mp", name: "poky-wrynose-imx8mp" },
    kas_config: params.kasConfig ?? null,
    target_profiles: [],
    provider_profiles: [],
    preflight_rules: {
      gate_enabled: true,
      incompatible_licenses: params.incompatibleLicenses ?? [],
    },
    openvex_records: params.openvexRecords ?? [],
  });
  const preview = JSON.stringify(sanitizedPayload, null, 2);
  return {
    ok: true,
    path: `poky-wrynose-imx8mp.${params.format === "zip" ? "yoctostudio.zip" : "yoctostudio"}`,
    format: params.format ?? "json",
    size_bytes: preview.length,
    sha256: "browser-preview-sha256",
    stripped_secret_count: 0,
    preview_json: preview,
  };
}

export async function importProjectSnapshot(params: {
  inputPath?: string;
  rawJson?: string;
}): Promise<SnapshotImportResult> {
  if (isTauriRuntime()) {
    return invoke<SnapshotImportResult>("import_project_snapshot", {
      inputPath: params.inputPath ?? null,
      rawJson: params.rawJson ?? null,
    });
  }
  const parsed = JSON.parse(params.rawJson || "{}") as Record<string, unknown>;
  return {
    ok: true,
    project_name:
      (parsed.project as { name?: string } | undefined)?.name ?? "imported-yocto-project",
    target_profiles_imported: Array.isArray(parsed.target_profiles)
      ? parsed.target_profiles.length
      : 0,
    provider_profiles_imported: Array.isArray(parsed.provider_profiles)
      ? parsed.provider_profiles.length
      : 0,
    openvex_count: Array.isArray(parsed.openvex_records) ? parsed.openvex_records.length : 0,
    preflight_gate_enabled: true,
    kas_config: (parsed.kas_config as string | null | undefined) ?? null,
    openvex_records: parsed.openvex_records ?? [],
  };
}

export async function getUpdaterConfig(): Promise<UpdaterConfigInfo> {
  if (isTauriRuntime()) {
    return invoke<UpdaterConfigInfo>("get_updater_config");
  }
  return {
    current_version: "1.1.0",
    endpoints: ["https://github.com/UfkuAcik/Yocto-Project-GUI/releases/latest/download/latest.json"],
    pubkey_configured: true,
    signing_ready: false,
    auto_check: true,
    last_checked_at: null,
    channel: "stable",
  };
}

export async function setUpdaterAutoCheck(enabled: boolean): Promise<boolean> {
  if (isTauriRuntime()) {
    return invoke<boolean>("set_updater_auto_check", { enabled });
  }
  return enabled;
}

export async function checkAppUpdate(endpointOverride?: string): Promise<UpdateCheckResult> {
  if (isTauriRuntime()) {
    return invoke<UpdateCheckResult>("check_app_update", {
      endpointOverride: endpointOverride ?? null,
    });
  }
  const isEn = i18next.language === "en";
  return {
    status: "offline_or_unconfigured",
    current_version: "1.1.0",
    latest_version: "1.1.0",
    release_notes: isEn
      ? "Live release manifest is published via GitHub Releases (latest.json)."
      : "Canlı manifest GitHub Releases (latest.json) üzerinden yayınlanır.",
    download_url: null,
    signature_verified_manifest: false,
    checked_at: new Date().toISOString(),
    message: isEn
      ? "Version v1.1.0 (Up-to-date / Signed Release Ready)."
      : "Sürüm v1.1.0 (Güncel / İmzalı Release Hazır).",
  };
}
