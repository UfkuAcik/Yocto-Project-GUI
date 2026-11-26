import { invoke } from "@tauri-apps/api/core";
import i18next from "@/i18n";
import { rpcClient } from "@/lib/rpcClient";
import { isTauriRuntime } from "@/lib/tauriApi";

export interface AiSettings {
  enabled: boolean;
  provider: "disabled" | "ollama" | "openai_compat" | "mock";
  endpoint: string;
  model: string;
  has_api_key: boolean;
}

export interface RedactionResult {
  redacted_text: string;
  replacements_count: number;
  categories: string[];
}

export interface AiTriageResponse {
  root_cause: string;
  affected_file_line: string;
  explanation: string;
  suggested_fix_diff: string;
  target_file: string;
  redacted_preview: string;
  redaction_count: number;
  provider_used: string;
}

export interface QaRunRecord {
  id: string;
  project_id: string;
  suite: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  total_boot_ms: number;
  created_at: string;
}

const AI_SETTINGS_LS_KEY = "yocto_studio_ai_settings";
const QA_RUNS_LS_KEY = "yocto_studio_qa_runs";

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  provider: "disabled",
  endpoint: "http://localhost:11434",
  model: "qwen2.5-coder:7b",
  has_api_key: false,
};

export function redactLogClientFallback(logContent: string): RedactionResult {
  let count = 0;
  const cats = new Set<string>();
  let text = logContent;

  const patterns: Array<[RegExp, string, string]> = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY_BLOCK]", "PRIVATE_KEY"],
    [/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[REDACTED_TOKEN]", "BEARER_TOKEN"],
    [/\b(?:sk|ghp|gho|AKIA|xoxb)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]", "API_KEY"],
    [/((?:password|api_key|apikey|secret|token)=)[^\s"']+/gi, "$1[REDACTED]", "SECRET_ASSIGNMENT"],
    [/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED_INTERNAL_IP]", "INTERNAL_IP"],
  ];

  for (const [re, rep, cat] of patterns) {
    text = text.replace(re, (...args) => {
      count += 1;
      cats.add(cat);
      if (rep.includes("$1") && typeof args[1] === "string") {
        return rep.replace("$1", args[1]);
      }
      return rep;
    });
  }
  return { redacted_text: text, replacements_count: count, categories: [...cats] };
}

export async function getAiSettings(): Promise<AiSettings> {
  if (isTauriRuntime()) {
    return invoke<AiSettings>("get_ai_settings");
  }
  try {
    const raw = localStorage.getItem(AI_SETTINGS_LS_KEY);
    return raw ? (JSON.parse(raw) as AiSettings) : DEFAULT_AI_SETTINGS;
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
}

export async function saveAiSettings(
  settings: AiSettings,
  apiKey?: string
): Promise<AiSettings> {
  if (isTauriRuntime()) {
    return invoke<AiSettings>("save_ai_settings", {
      settings,
      apiKey: apiKey ?? null,
    });
  }
  const updated: AiSettings = {
    ...settings,
    has_api_key: Boolean(apiKey?.trim()) || settings.has_api_key,
  };
  try {
    localStorage.setItem(AI_SETTINGS_LS_KEY, JSON.stringify(updated));
  } catch {
    // ignore storage errors
  }
  return updated;
}

export async function previewRedactedLog(logContent: string): Promise<RedactionResult> {
  if (isTauriRuntime()) {
    return invoke<RedactionResult>("preview_redacted_log", { logContent });
  }
  return redactLogClientFallback(logContent);
}

export async function runAiTriage(req: {
  recipe: string;
  task: string;
  log_content: string;
  recipe_snippet: string;
}): Promise<AiTriageResponse> {
  if (isTauriRuntime()) {
    return invoke<AiTriageResponse>("run_ai_triage", { req });
  }
  const isEn = i18next.language === "en";
  const settings = await getAiSettings();
  if (!settings.enabled || settings.provider === "disabled") {
    throw new Error(
      isEn
        ? "Privacy Protection: AI Build Triage is disabled by default (Opt-In). Select a provider and enable it."
        : "Gizlilik Koruması: AI Hata Teşhisi varsayılan olarak kapalıdır (Opt-In). Sağlayıcı seçip etkinleştirin."
    );
  }
  const red = redactLogClientFallback(req.log_content);
  return {
    root_cause: isEn
      ? `${req.recipe} (${req.task}): Missing nlohmann-json header or DEPENDS entry`
      : `${req.recipe} (${req.task}): Eksik nlohmann-json başlık dosyası veya DEPENDS tanımı`,
    affected_file_line: "src/telemetry_publisher.cpp:14",
    explanation: isEn
      ? "The C++ compiler could not find <nlohmann/json.hpp> in sysroot. Add nlohmann-json to the recipe's DEPENDS list."
      : "C++ derleyicisi sysroot içinde <nlohmann/json.hpp> dosyasını bulamadı. Tarif DEPENDS listesine nlohmann-json eklenmelidir.",
    suggested_fix_diff: `--- a/recipes-apps/${req.recipe}/${req.recipe}_%.bbappend\n+++ b/recipes-apps/${req.recipe}/${req.recipe}_%.bbappend\n-DEPENDS = "mosquitto libgpiod"\n+DEPENDS += " nlohmann-json"`,
    target_file: `recipes-apps/${req.recipe}/${req.recipe}_%.bbappend`,
    redacted_preview: red.redacted_text,
    redaction_count: red.replacements_count,
    provider_used: settings.provider === "ollama" ? "ollama (browser-sim)" : "offline-mock",
  };
}

export async function listQaRuns(): Promise<QaRunRecord[]> {
  if (isTauriRuntime()) {
    return invoke<QaRunRecord[]>("list_qa_runs");
  }
  try {
    const raw = localStorage.getItem(QA_RUNS_LS_KEY);
    return raw ? (JSON.parse(raw) as QaRunRecord[]) : [];
  } catch {
    return [];
  }
}

export async function recordQaRun(record: QaRunRecord): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("record_qa_run", { record });
    return;
  }
  try {
    const existing = await listQaRuns();
    localStorage.setItem(QA_RUNS_LS_KEY, JSON.stringify([record, ...existing].slice(0, 30)));
  } catch {
    // ignore
  }
}

export const proRpc = {
  diffKernelConfig: (search?: string) => rpcClient.call("pro.kernel.diffConfig", { search }),
  saveKernelFragment: (fragment_name: string, fragment_content: string) =>
    rpcClient.call("pro.kernel.saveFragment", { fragment_name, fragment_content }),
  listDtFiles: () => rpcClient.call("pro.dt.listFiles", {}),
  parseDtTree: (path?: string, content?: string) =>
    rpcClient.call("pro.dt.parseTree", { path, content }),
  updateDtNodeStatus: (path: string, node_path: string, new_status: "okay" | "disabled") =>
    rpcClient.call("pro.dt.updateNodeStatus", { path, node_path, new_status }),
  runQaSuite: (suite: "testimage" | "ptest", target?: string) =>
    rpcClient.call("pro.qa.runSuite", { suite, target }),
  runHardwareSmoke: (target_host?: string, machine?: string) =>
    rpcClient.call("pro.qa.runHardwareSmoke", { target_host, machine }),
  listVex: () => rpcClient.call("pro.cra.listVex", {}),
  updateVex: (params: {
    cve_id: string;
    status: "not_affected" | "fixed" | "affected" | "under_investigation";
    justification?: string;
    impact_statement?: string;
  }) => rpcClient.call("pro.cra.updateVex", params),
  exportCraBundle: (bundle_name?: string) =>
    rpcClient.call("pro.cra.exportBundle", { bundle_name }),
  generateSecureBoot: (params: {
    enable_fit_sign: boolean;
    key_dir: string;
    key_name: string;
    key_bits: number;
    enable_dm_verity: boolean;
    verity_image: string;
    verity_data_dev: string;
  }) => rpcClient.call("pro.secboot.generateConfig", params),
  analyzeBuildStats: (target?: string) => rpcClient.call("pro.buildstats.analyze", { target }),
  generateCiCd: (params: {
    platform: "gitlab" | "github";
    setup_tool?: string;
    machine?: string;
    target?: string;
    enable_preflight_gate?: boolean;
    enable_cve_gate?: boolean;
  }) => rpcClient.call("pro.cicd.generate", params),
};
