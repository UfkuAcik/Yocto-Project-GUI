import { z } from "zod";

export const ProviderKindSchema = z.enum(["mock", "wsl2", "docker", "ssh", "local"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const BridgeInfoSchema = z.object({
  version: z.string(),
  mode: z.enum(["mock", "live"]),
  yocto_series: z.string(),
  python_version: z.string(),
  pid: z.number().int(),
  uptime_sec: z.number(),
  active_clients: z.number().int(),
  active_project_id: z.string().nullable(),
});
export type BridgeInfo = z.infer<typeof BridgeInfoSchema>;

export const PathValidationResultSchema = z.object({
  valid: z.boolean(),
  error_code: z.number().int().nullable(),
  reason: z.string(),
  recommendation: z.string().nullable(),
  normalized_path: z.string(),
});
export type PathValidationResult = z.infer<typeof PathValidationResultSchema>;

export const EnvCheckItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["ok", "warn", "error"]),
  detail: z.string(),
  fix_command: z.string().nullable().optional(),
});
export type EnvCheckItem = z.infer<typeof EnvCheckItemSchema>;

export const WorkspaceProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  yocto_version: z.string(),
  yocto_codename: z.string(),
  setup_tool: z.enum(["bitbake-setup", "oe-init-build-env", "kas"]),
  workspace_path: z.string(),
  build_dir: z.string(),
  dl_dir: z.string(),
  sstate_dir: z.string(),
  machine: z.string(),
  distro: z.string(),
  provider: ProviderKindSchema,
  hashserve: z.string().nullable().optional(),
});
export type WorkspaceProject = z.infer<typeof WorkspaceProjectSchema>;

export const LayerInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  priority: z.number().int(),
  branch: z.string(),
  compat: z.array(z.string()),
  compatible_with_active: z.boolean(),
  warning: z.string().nullable().optional(),
  appends_count: z.number().int().optional(),
});
export type LayerInfo = z.infer<typeof LayerInfoSchema>;

export const LayerIndexEntrySchema = z.object({
  name: z.string(),
  summary: z.string(),
  vcs_url: z.string(),
  branch: z.string(),
  compat: z.array(z.string()),
  layer_type: z.enum(["bsp", "software", "distro", "toolchain", "security"]),
  installed: z.boolean(),
  kind: z.enum(["layer", "machine", "recipe", "distro"]).optional(),
  vcs_subdir: z.string().optional(),
});
export type LayerIndexEntry = z.infer<typeof LayerIndexEntrySchema>;

export const SetupLayerDiffSchema = z.object({
  layer: z.string(),
  branch: z.string(),
  current_rev: z.string(),
  remote_rev: z.string(),
  status: z.enum(["up-to-date", "behind", "dirty"]),
  local_changes: z.array(z.string()),
  diff: z.string(),
});
export type SetupLayerDiff = z.infer<typeof SetupLayerDiffSchema>;

export const KasRepoSchema = z.object({
  url: z.string().optional(),
  path: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  refspec: z.string().optional(),
  layers: z.record(z.string()).optional(),
});
export type KasRepo = z.infer<typeof KasRepoSchema>;

export const KasConfigSchema = z.object({
  header: z.object({
    version: z.number().int(),
    includes: z.array(z.string()).optional(),
  }),
  machine: z.string(),
  distro: z.string(),
  target: z.array(z.string()),
  repos: z.record(KasRepoSchema),
  local_conf_header: z.record(z.string()),
  bblayers_conf_header: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
});
export type KasConfig = z.infer<typeof KasConfigSchema>;

export const LayerCompatIssueSchema = z.object({
  severity: z.enum(["error", "warn"]),
  kind: z.enum(["compat_mismatch", "priority_collision"]),
  layers: z.array(z.string()),
  message: z.string(),
  fix_hint: z.string(),
});
export type LayerCompatIssue = z.infer<typeof LayerCompatIssueSchema>;

export const LayerOverlayedEntrySchema = z.object({
  recipe: z.string(),
  active_layer: z.string(),
  active_priority: z.number().int(),
  shadowed_layer: z.string(),
  shadowed_priority: z.number().int(),
});
export type LayerOverlayedEntry = z.infer<typeof LayerOverlayedEntrySchema>;

export const LayerAppendEntrySchema = z.object({
  recipe: z.string(),
  layer: z.string(),
  append_file: z.string(),
});
export type LayerAppendEntry = z.infer<typeof LayerAppendEntrySchema>;

export const ConfigFragmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(["security", "build", "distro", "toolchain"]),
  enabled: z.boolean(),
});
export type ConfigFragment = z.infer<typeof ConfigFragmentSchema>;

export const VariableHistoryEntrySchema = z.object({
  file: z.string(),
  line: z.number().int(),
  operator: z.enum(["=", "?=", "??=", "+=", "=+", ":=", ":append", ":prepend", ":remove"]),
  value: z.string(),
  overridden: z.boolean().optional(),
});
export type VariableHistoryEntry = z.infer<typeof VariableHistoryEntrySchema>;

export const VariableInspectionSchema = z.object({
  name: z.string(),
  final_value: z.string(),
  unexpanded_value: z.string(),
  doc: z.string(),
  history: z.array(VariableHistoryEntrySchema),
});
export type VariableInspection = z.infer<typeof VariableInspectionSchema>;

export const LocalConfStateSchema = z.object({
  path: z.string(),
  content: z.string(),
  variables: z.record(z.string()),
  comments_count: z.number().int().optional(),
  directives: z.array(z.string()).optional(),
  multiline_keys: z.array(z.string()).optional(),
});
export type LocalConfState = z.infer<typeof LocalConfStateSchema>;

export const RecipeSummarySchema = z.object({
  pn: z.string(),
  pv: z.string(),
  layer: z.string(),
  file_path: z.string(),
  summary: z.string(),
  license: z.string(),
  has_bbappend: z.boolean(),
});
export type RecipeSummary = z.infer<typeof RecipeSummarySchema>;

export const DevtoolEntrySchema = z.object({
  recipe: z.string(),
  srctree: z.string(),
  bbappend: z.string().nullable(),
  status: z.enum(["modified", "added", "upgraded"]),
});
export type DevtoolEntry = z.infer<typeof DevtoolEntrySchema>;

export const BuildStatusValueSchema = z.enum([
  "idle",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type BuildStatusValue = z.infer<typeof BuildStatusValueSchema>;

export const BuildTaskStateSchema = z.object({
  task_id: z.string(),
  recipe: z.string(),
  task: z.string(),
  worker_slot: z.number().int(),
  progress: z.number().min(0).max(100),
  status: z.enum(["running", "succeeded", "failed", "cached"]),
  started_at: z.number(),
  duration_ms: z.number().optional(),
});
export type BuildTaskState = z.infer<typeof BuildTaskStateSchema>;

export const BuildSnapshotSchema = z.object({
  build_id: z.string().nullable(),
  target: z.string().nullable(),
  machine: z.string(),
  distro: z.string(),
  status: BuildStatusValueSchema,
  total_tasks: z.number().int(),
  completed_tasks: z.number().int(),
  sstate_hits: z.number().int(),
  sstate_misses: z.number().int(),
  elapsed_ms: z.number(),
  active_tasks: z.array(BuildTaskStateSchema),
  failed_task: z
    .object({
      recipe: z.string(),
      task: z.string(),
      exit_code: z.number().int(),
      error_summary: z.string(),
      log_path: z.string(),
      run_path: z.string(),
    })
    .nullable(),
});
export type BuildSnapshot = z.infer<typeof BuildSnapshotSchema>;

export const DagNodeSchema = z.object({
  id: z.string(),
  recipe: z.string(),
  task: z.string(),
  layer: z.string(),
  kind: z.enum(["image", "kernel", "runtime", "toolchain", "app"]),
  depends_on: z.array(z.string()),
  rdepends_count: z.number().int(),
});
export type DagNode = z.infer<typeof DagNodeSchema>;

export const DagGraphSchema = z.object({
  target: z.string(),
  nodes: z.array(DagNodeSchema),
  edges: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      target: z.string(),
    })
  ),
});
export type DagGraph = z.infer<typeof DagGraphSchema>;

export const DeployImageSchema = z.object({
  filename: z.string(),
  path: z.string(),
  kind: z.enum(["wic", "kernel", "rootfs", "dtb", "bootloader", "spdx", "sdk"]),
  size_bytes: z.number(),
  modified_at: z.string(),
  sha256_short: z.string(),
});
export type DeployImage = z.infer<typeof DeployImageSchema>;

export const SbomPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  purl: z.string(),
  license: z.string(),
  supplier: z.string(),
  gplv3_flag: z.boolean(),
});
export type SbomPackage = z.infer<typeof SbomPackageSchema>;

export const CveFindingSchema = z.object({
  cve_id: z.string(),
  package: z.string(),
  version: z.string(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  cvss: z.number(),
  status: z.enum(["Unpatched", "Patched", "Ignored"]),
  summary: z.string(),
});
export type CveFinding = z.infer<typeof CveFindingSchema>;

export const BuildHistoryDiffEntrySchema = z.object({
  package: z.string(),
  change: z.enum(["upgraded", "added", "removed", "size_changed"]),
  old_version: z.string().nullable(),
  new_version: z.string().nullable(),
  size_delta_kb: z.number(),
});
export type BuildHistoryDiffEntry = z.infer<typeof BuildHistoryDiffEntrySchema>;

export const WksPartitionSchema = z.object({
  id: z.string(),
  line: z.number().optional(),
  name: z.string(),
  mountpoint: z.string().nullable(),
  fstype: z.string().nullable(),
  source: z.string().nullable(),
  size_mb: z.number().nullable(),
  fixed_size_mb: z.number().nullable().optional(),
  align_kb: z.number().nullable().optional(),
  offset_kb: z.number().nullable().optional(),
  ondisk: z.string().nullable().optional(),
  part_type: z.string().nullable().optional(),
  uuid: z.string().nullable().optional(),
  active: z.boolean().optional(),
  no_table: z.boolean().optional(),
  exclude_path: z.array(z.string()).optional(),
  extra_args: z.array(z.string()).optional(),
});
export type WksPartition = z.infer<typeof WksPartitionSchema>;

export const WksFileSchema = z.object({
  path: z.string(),
  bootloader: z.object({
    ptable: z.string().nullable().optional(),
    timeout: z.number().nullable().optional(),
    append: z.string().nullable().optional(),
    raw: z.string().optional(),
  }),
  comments: z.array(z.string()).optional(),
  partitions: z.array(WksPartitionSchema),
  total_size_mb: z.number().optional(),
  raw_text: z.string(),
});
export type WksFile = z.infer<typeof WksFileSchema>;

export const SdkArtifactSchema = z.object({
  name: z.string(),
  kind: z.enum(["standard-sdk", "esdk"]),
  machine: z.string(),
  filename: z.string(),
  path: z.string(),
  size_bytes: z.number(),
  built_at: z.string(),
  sysroot_arch: z.string(),
});
export type SdkArtifact = z.infer<typeof SdkArtifactSchema>;

export const PreFlightFixActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  kind: z.enum([
    "local_conf_set",
    "local_conf_append",
    "local_conf_remove",
    "layer_add",
    "layer_remove",
    "layer_compat_update",
    "bbappend_wildcard",
    "packageconfig_remove",
  ]),
  target_file: z.string(),
  changes: z.record(z.string()),
  operator: z.string().optional(),
  layer_name: z.string().optional(),
  layer_url: z.string().optional(),
  preview_diff: z.string().optional(),
});
export type PreFlightFixAction = z.infer<typeof PreFlightFixActionSchema>;

export const PreFlightIssueSchema = z.object({
  id: z.string(),
  severity: z.enum(["blocker", "warning", "optimization"]),
  category: z.enum(["layer", "version", "distro", "license", "bloat", "performance", "sstate"]),
  title: z.string(),
  summary: z.string(),
  detail: z.string(),
  recipe: z.string().nullable().optional(),
  layer: z.string().nullable().optional(),
  dependency_chain: z.array(z.string()).optional(),
  auto_fix: PreFlightFixActionSchema.nullable().optional(),
  resolved: z.boolean().optional(),
});
export type PreFlightIssue = z.infer<typeof PreFlightIssueSchema>;

export const LayerAuditItemSchema = z.object({
  name: z.string(),
  path: z.string(),
  priority: z.number(),
  branch: z.string(),
  compat: z.array(z.string()),
  active_series: z.string(),
  compat_ok: z.boolean(),
  missing_depends: z.array(z.string()),
  drifted_appends: z.array(
    z.object({
      recipe: z.string(),
      append_file: z.string(),
      expected_pv: z.string(),
      actual_pv: z.string(),
    })
  ),
  overlayed_count: z.number(),
});
export type LayerAuditItem = z.infer<typeof LayerAuditItemSchema>;

export const BloatItemSchema = z.object({
  package: z.string(),
  category: z.string(),
  estimated_rootfs_mb: z.number(),
  estimated_build_min: z.number(),
  chain: z.array(z.string()),
  reason: z.string(),
  auto_fix: PreFlightFixActionSchema.nullable().optional(),
});
export type BloatItem = z.infer<typeof BloatItemSchema>;

export const LicenseViolationSchema = z.object({
  package: z.string(),
  version: z.string(),
  license: z.string(),
  policy_rule: z.string(),
  chain: z.array(z.string()),
  auto_fix: PreFlightFixActionSchema.nullable().optional(),
});
export type LicenseViolation = z.infer<typeof LicenseViolationSchema>;

export const PreFlightAuditReportSchema = z.object({
  score: z.number(),
  target: z.string(),
  machine: z.string(),
  yocto_series: z.string(),
  duration_ms: z.number(),
  blockers: z.number(),
  warnings: z.number(),
  optimizations: z.number(),
  ready_to_build: z.boolean(),
  issues: z.array(PreFlightIssueSchema),
  layer_checks: z.array(LayerAuditItemSchema),
  bloat_items: z.array(BloatItemSchema),
  license_violations: z.array(LicenseViolationSchema),
  check_layer_summary: z
    .object({
      layer: z.string(),
      status: z.string(),
      passed: z.number(),
      failed: z.number(),
      output: z.string(),
    })
    .nullable()
    .optional(),
});
export type PreFlightAuditReport = z.infer<typeof PreFlightAuditReportSchema>;

export const VersionMatrixEntrySchema = z.object({
  recipe: z.string(),
  resolved_version: z.string(),
  layer: z.string(),
  priority: z.number(),
  bbappends: z.array(z.string()),
  providers: z.array(z.string()),
  preferred_provider: z.string().nullable().optional(),
  preferred_version: z.string().nullable().optional(),
  preferred_conflict: z.string().nullable().optional(),
  upstream_version: z.string().nullable().optional(),
  upgrade_status: z.enum(["up-to-date", "outdated", "security-risk", "unknown"]),
  security_note: z.string().nullable().optional(),
});
export type VersionMatrixEntry = z.infer<typeof VersionMatrixEntrySchema>;

export const SstateProbeResultSchema = z.object({
  mirrors: z.array(
    z.object({
      url: z.string(),
      reachable: z.boolean(),
      latency_ms: z.number().nullable(),
      status: z.string(),
    })
  ),
  hashserve: z.object({
    endpoint: z.string(),
    reachable: z.boolean(),
    latency_ms: z.number().nullable(),
    status: z.string(),
  }),
  estimated_hit_percent: z.number(),
  total_tasks_sampled: z.number(),
  setscene_covered_tasks: z.number(),
  recommendation: z.string(),
});
export type SstateProbeResult = z.infer<typeof SstateProbeResultSchema>;

export const OptimizationRecommendationSchema = z.object({
  id: z.string(),
  title: z.string(),
  impact: z.string(),
  current_value: z.string(),
  recommended_value: z.string(),
  applied: z.boolean(),
  auto_fix: PreFlightFixActionSchema.nullable().optional(),
});
export type OptimizationRecommendation = z.infer<typeof OptimizationRecommendationSchema>;

export const OptimizationPlanSchema = z.object({
  host: z.object({
    cpu_cores: z.number(),
    ram_total_gb: z.number(),
    ram_available_gb: z.number(),
    disk_free_gb: z.number(),
    psi_supported: z.boolean(),
    provider: z.string(),
  }),
  recommendations: z.array(OptimizationRecommendationSchema),
  combined_diff: z.string(),
});
export type OptimizationPlan = z.infer<typeof OptimizationPlanSchema>;

export interface DtNode {
  name: string;
  path: string;
  label?: string | null;
  compatible?: string | null;
  reg?: string | null;
  pinctrl?: string | null;
  status?: string | null;
  properties: Record<string, string>;
  children: DtNode[];
}

export const VexEntrySchema = z.object({
  cve_id: z.string(),
  package: z.string(),
  version: z.string(),
  severity: z.string(),
  cvss: z.number(),
  status: z.enum(["not_affected", "fixed", "affected", "under_investigation"]),
  justification: z.string().nullable().optional(),
  impact_statement: z.string().nullable().optional(),
  updated_at: z.string(),
});
export type VexEntry = z.infer<typeof VexEntrySchema>;

export const QaTestCaseSchema = z.object({
  name: z.string(),
  status: z.enum(["PASS", "FAIL", "SKIP"]),
  duration_ms: z.number(),
});
export type QaTestCase = z.infer<typeof QaTestCaseSchema>;

export const QaSuiteResultSchema = z.object({
  suite: z.string(),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  ok: z.boolean(),
  cases: z.array(QaTestCaseSchema),
  raw_output: z.string(),
});
export type QaSuiteResult = z.infer<typeof QaSuiteResultSchema>;

export const BootStageSchema = z.object({
  stage: z.string(),
  start_ms: z.number(),
  duration_ms: z.number(),
  detail: z.string(),
});
export type BootStage = z.infer<typeof BootStageSchema>;

export const HardwareSmokeResultSchema = z.object({
  machine: z.string(),
  target_host: z.string(),
  total_boot_ms: z.number(),
  boot_stages: z.array(BootStageSchema),
  systemd_blame: z.array(z.object({ unit: z.string(), duration_ms: z.number() })),
  dmesg_errors: z.array(z.string()),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["PASS", "WARN", "FAIL"]),
      output: z.string(),
    })
  ),
  markdown_report: z.string(),
  html_report: z.string(),
});
export type HardwareSmokeResult = z.infer<typeof HardwareSmokeResultSchema>;

export const BuildStatsTaskSchema = z.object({
  recipe: z.string(),
  task: z.string(),
  duration_sec: z.number(),
  start_offset_sec: z.number(),
  cpu_percent: z.number(),
});
export type BuildStatsTask = z.infer<typeof BuildStatsTaskSchema>;

export const BuildStatsReportSchema = z.object({
  total_duration_sec: z.number(),
  avg_cpu_percent: z.number(),
  task_count: z.number(),
  top_tasks: z.array(BuildStatsTaskSchema),
});
export type BuildStatsReport = z.infer<typeof BuildStatsReportSchema>;

// ─── Modül 11: Enterprise & Completeness Pack ──────────────────────────────

export interface MulticonfigEntry {
  name: string;
  file_path: string;
  machine: string;
  tmpdir: string;
  distro: string;
  description: string;
  extra_vars: Record<string, string>;
  raw_content: string;
}

export interface McDependency {
  from_config: string;
  to_config: string;
  recipe: string;
  task: string;
  expression: string;
}

export interface AutorevFinding {
  id: string;
  recipe: string;
  file_path: string;
  line_number: number;
  variable: string;
  current_line: string;
  suggested_sha: string;
  suggested_line: string;
  diff: string;
}

export interface OfflineMirrorPlan {
  target: string;
  dl_dir: string;
  mirror_dir: string;
  local_conf_updates: Record<string, string>;
  local_conf_diff: string;
  commands: string[];
  verified_offline: boolean;
  summary: string;
}

export interface ArchiverBundleResult {
  ok: boolean;
  mode: "original" | "patched";
  gpl_only: boolean;
  local_conf_updates: Record<string, string>;
  local_conf_diff: string;
  archive_path: string;
  size_bytes: number;
  package_count: number;
  sha256: string;
}

export interface RootfsPackageItem {
  name: string;
  recipe: string;
  category: string;
  size_bytes: number;
  size_kb: number;
  percent: number;
  file_count: number;
  sample_files: string[];
}

export interface RootfsCategorySummary {
  category: string;
  size_bytes: number;
  percent: number;
  package_count: number;
}

export interface RootfsTreemapResult {
  image: string;
  machine: string;
  total_bytes: number;
  package_count: number;
  categories: RootfsCategorySummary[];
  packages: RootfsPackageItem[];
}

export interface PkgPathMatch {
  file_path: string;
  package: string;
  recipe: string;
  recipe_file: string;
  layer: string;
  version: string;
  size_bytes: number;
}

export interface DiffsigsCause {
  cause_type: string;
  symbol: string;
  before: string;
  after: string;
  explanation: string;
  impact: "high" | "medium" | "low";
}

export interface DiffsigsResult {
  task: string;
  recipe: string;
  old_sig: string;
  new_sig: string;
  summary: string;
  causes: DiffsigsCause[];
  raw_output: string;
}

export interface IdeExportResult {
  recipe: string;
  launch_json: string;
  c_cpp_properties_json: string;
  gdb_command: string;
  sysroot_path: string;
  gdb_path: string;
}

export interface GdbserverSessionResult {
  ok: boolean;
  target_host: string;
  gdb_port: number;
  remote_binary: string;
  ssh_command: string;
  local_gdb_command: string;
  status: string;
  pid: number;
}

export interface LiveTargetTelemetry {
  target_host: string;
  timestamp: string;
  uptime_sec: number;
  cpu_percent: number;
  load_avg: [number, number, number];
  ram_used_mb: number;
  ram_total_mb: number;
  swap_used_mb: number;
  swap_total_mb: number;
  disk_used_gb: number;
  disk_total_gb: number;
  disk_percent: number;
  thermal_zones: Array<{ zone: string; type: string; temp_c: number }>;
  failed_services: Array<{
    unit: string;
    load: string;
    active: string;
    sub: string;
    description: string;
  }>;
  journal_lines: string[];
}

export interface MigrationFinding {
  id: string;
  rule_id: string;
  severity: "error" | "warning" | "info";
  file_path: string;
  line_number: number;
  before_line: string;
  after_line: string;
  reason: string;
  migration_path: string;
  auto_fixable: boolean;
}

export interface MigrationScanResult {
  from_lts: "kirkstone" | "scarthgap";
  to_lts: "scarthgap" | "wrynose";
  layer_name: string;
  scanned_files: number;
  findings: MigrationFinding[];
  combined_diff: string;
}

export interface MigrationApplyResult {
  applied_count: number;
  modified_files: string[];
  combined_diff: string;
  remaining_findings: MigrationFinding[];
}

export interface LayerGitStatus {
  layer_name: string;
  path: string;
  branch: string;
  commit_sha: string;
  commit_message: string;
  dirty_count: number;
  staged_count: number;
  untracked_count: number;
  ahead: number;
  behind: number;
  upstream: string;
  changed_files: Array<{ status: string; path: string }>;
}

export interface LayerGitActionResult {
  ok: boolean;
  layer_name: string;
  action: "fetch" | "diff" | "stash" | "stash_pop" | "commit";
  output: string;
  diff?: string;
  updated_status?: LayerGitStatus;
}

export interface CiRunnerSstateMetric {
  runner_id: string;
  runner_name: string;
  arch: string;
  provider: string;
  branch: string;
  wanted_tasks: number;
  local_hits: number;
  mirror_hits: number;
  missed: number;
  hit_rate_percent: number;
  hashequiv_reused: number;
  avg_duration_min: number;
  time_saved_min: number;
  nativelsbstring: string;
  status: "healthy" | "degraded" | "cold";
  last_run_at: string;
}

export interface SstateTrendPoint {
  label: string;
  hit_rate_percent: number;
  hashequiv_rate_percent: number;
  runs_count: number;
}

export interface HashEquivBreakdown {
  recipe: string;
  out_hash_changes: number;
  equivalent_unihash_hits: number;
  skipped_downstream_tasks: number;
  saved_minutes: number;
}

export interface SstateAnomaly {
  id: string;
  severity: "warning" | "critical";
  runner_id: string;
  title: string;
  detail: string;
  recommendation: string;
}

export interface RemoteSstateAnalyticsReport {
  generated_at: string;
  time_range: "24h" | "7d" | "30d";
  mirror_status: {
    url: string;
    reachable: boolean;
    latency_ms: number | null;
    status: string;
  };
  hashserve_status: {
    endpoint: string;
    reachable: boolean;
    latency_ms: number | null;
    status: string;
  };
  fleet_hit_rate_percent: number;
  hashequiv_dedup_percent: number;
  total_time_saved_hours: number;
  cache_footprint_gb: number;
  cache_quota_gb: number;
  eviction_risk: "low" | "medium" | "high";
  runners: CiRunnerSstateMetric[];
  trend: SstateTrendPoint[];
  hash_equiv_top_recipes: HashEquivBreakdown[];
  anomalies: SstateAnomaly[];
}

export interface RpcMethodMap {
  "bridge.ping": { params: Record<string, never>; result: { pong: true; ts: number } };
  "bridge.info": { params: Record<string, never>; result: BridgeInfo };
  "bridge.shutdown": { params: Record<string, never>; result: { ok: boolean } };

  "env.doctor": {
    params: { provider?: ProviderKind };
    result: { provider: ProviderKind; checks: EnvCheckItem[] };
  };
  "env.validate_path": {
    params: { path: string; provider: ProviderKind };
    result: PathValidationResult;
  };

  "workspace.list": {
    params: Record<string, never>;
    result: { projects: WorkspaceProject[]; active_project_id: string };
  };
  "workspace.get": {
    params: { project_id?: string };
    result: WorkspaceProject;
  };
  "workspace.select": {
    params: { project_id: string };
    result: WorkspaceProject;
  };
  "workspace.create": {
    params: {
      name: string;
      yocto_codename: string;
      setup_tool: "bitbake-setup" | "oe-init-build-env" | "kas";
      workspace_path: string;
      machine: string;
      distro: string;
      provider: ProviderKind;
    };
    result: WorkspaceProject;
  };
  "workspace.import": {
    params: {
      name: string;
      workspace_path: string;
      build_dir?: string;
      setup_tool: "oe-init-build-env" | "bitbake-setup" | "kas";
      provider: ProviderKind;
    };
    result: WorkspaceProject;
  };
  "workspace.setup_status": {
    params: { project_id?: string };
    result: { tool: string; up_to_date: boolean; layers: SetupLayerDiff[] };
  };
  "workspace.setup_update": {
    params: { project_id?: string; preserve_local?: boolean };
    result: {
      updated_layers: string[];
      preserved_dirty: string[];
      summary: string;
      diff: string;
    };
  };
  "workspace.update_caches": {
    params: { dl_dir: string; sstate_dir: string; hashserve?: string };
    result: WorkspaceProject;
  };

  "kas.parse": {
    params: { yaml_text: string };
    result: { config: KasConfig; warnings: string[] };
  };
  "kas.serialize": {
    params: { config: KasConfig };
    result: { yaml_text: string };
  };
  "kas.run": {
    params: { action: "lock" | "checkout" | "build"; yaml_text: string; filename?: string };
    result: {
      ok: boolean;
      action: string;
      command: string;
      output: string;
      lock_yaml?: string;
    };
  };

  "layers.list": {
    params: Record<string, never>;
    result: { layers: LayerInfo[] };
  };
  "layers.search_index": {
    params: {
      query?: string;
      branch?: string;
      kind?: "layer" | "machine" | "recipe" | "distro";
      live?: boolean;
      limit?: number;
    };
    result: {
      source: "live" | "cache" | "mock";
      branch: string;
      branches: string[];
      results: LayerIndexEntry[];
    };
  };
  "layers.add": {
    params: { name: string };
    result: { layers: LayerInfo[] };
  };
  "layers.remove": {
    params: { name: string };
    result: { layers: LayerInfo[] };
  };
  "layers.show_appends": {
    params: Record<string, never>;
    result: { appends: LayerAppendEntry[] };
  };
  "layers.show_overlayed": {
    params: Record<string, never>;
    result: { overlayed: LayerOverlayedEntry[] };
  };
  "layers.create_layer": {
    params: {
      name: string;
      parent_dir?: string;
      priority?: number;
      compat?: string[];
      description?: string;
    };
    result: { layer: LayerInfo; files_created: string[]; layers: LayerInfo[] };
  };
  "layers.check_compat": {
    params: Record<string, never>;
    result: { ok: boolean; active_series: string; issues: LayerCompatIssue[] };
  };
  "layers.fetch_from_index": {
    params: { name: string; branch?: string };
    result: { layer: LayerInfo; layers: LayerInfo[] };
  };

  "config.get_local_conf": {
    params: Record<string, never>;
    result: LocalConfState;
  };
  "config.preview_diff": {
    params: {
      updates: Record<string, string>;
      operators?: Record<string, string>;
      remove_keys?: string[];
    };
    result: { diff: string; new_content: string };
  };
  "config.apply_changes": {
    params: {
      updates: Record<string, string>;
      operators?: Record<string, string>;
      remove_keys?: string[];
    };
    result: LocalConfState;
  };
  "config.list_fragments": {
    params: Record<string, never>;
    result: { fragments: ConfigFragment[] };
  };
  "config.toggle_fragment": {
    params: { id: string; enabled: boolean };
    result: { fragments: ConfigFragment[] };
  };
  "config.create_fragment": {
    params: {
      id: string;
      name: string;
      description: string;
      category: "security" | "build" | "distro" | "toolchain";
      content?: string;
    };
    result: { fragments: ConfigFragment[] };
  };
  "config.inspect_variable": {
    params: { name: string; recipe?: string };
    result: VariableInspection;
  };

  "recipes.list": {
    params: { query?: string };
    result: { recipes: RecipeSummary[] };
  };
  "recipes.get": {
    params: { pn: string };
    result: { recipe: RecipeSummary; content: string };
  };
  "recipes.save": {
    params: { pn: string; content: string };
    result: { ok: boolean; file_path: string };
  };
  "recipes.create_bbappend": {
    params: { pn: string; layer?: string; template?: string };
    result: {
      pn: string;
      file_path: string;
      content: string;
      base_content: string;
    };
  };

  "devtool.status": {
    params: Record<string, never>;
    result: { entries: DevtoolEntry[] };
  };
  "devtool.add": {
    params: { recipe: string; src_uri: string; srcrev?: string };
    result: { entry: DevtoolEntry; entries: DevtoolEntry[]; output: string };
  };
  "devtool.modify": {
    params: { recipe: string };
    result: { entry: DevtoolEntry; entries: DevtoolEntry[]; output: string };
  };
  "devtool.build": {
    params: { recipe: string };
    result: { ok: boolean; recipe: string; output: string };
  };
  "devtool.deploy_target": {
    params: { recipe: string; target_host: string; target_user?: string };
    result: { ok: boolean; command: string; output: string };
  };
  "devtool.upgrade": {
    params: { recipe: string; new_version: string; srcrev?: string };
    result: { entry: DevtoolEntry; entries: DevtoolEntry[]; output: string };
  };
  "devtool.finish": {
    params: { recipe: string; layer_path: string };
    result: {
      ok: boolean;
      patch_file: string;
      bbappend_file: string;
      patch_diff: string;
      entries: DevtoolEntry[];
    };
  };
  "devtool.reset": {
    params: { recipe: string };
    result: { ok: boolean; entries: DevtoolEntry[] };
  };

  "recipetool.create": {
    params: {
      name: string;
      version?: string;
      src_uri: string;
      build_system: "cmake" | "meson" | "autotools" | "cargo" | "python" | "go";
      license?: string;
      summary?: string;
    };
    result: {
      pn: string;
      file_path: string;
      content: string;
      recipe: RecipeSummary;
    };
  };

  "build.start": {
    params: {
      target: string;
      machine?: string;
      distro?: string;
      simulate_failure?: boolean;
      tick_ms?: number;
    };
    result: { build_id: string; status: BuildStatusValue; target: string };
  };
  "build.cancel": {
    params: { build_id?: string; force?: boolean };
    result: { ok: boolean; build_id: string | null; status: BuildStatusValue };
  };
  "build.status": {
    params: Record<string, never>;
    result: BuildSnapshot;
  };
  "build.get_task_log": {
    params: { build_id?: string; recipe: string; task: string };
    result: {
      recipe: string;
      task: string;
      log_path: string;
      run_path: string;
      log_content: string;
      run_content: string;
    };
  };
  "build.run_task_action": {
    params: {
      recipe: string;
      action:
        | "cleansstate"
        | "cleanall"
        | "compile"
        | "menuconfig"
        | "diffconfig"
        | "savedefconfig"
        | "devshell";
    };
    result: {
      ok: boolean;
      command: string;
      output: string;
      pty_session_id?: string | null;
    };
  };

  "dag.generate": {
    params: {
      target: string;
      query?: string;
      kind?: string;
      focus_recipe?: string;
      max_nodes?: number;
      raw_dot?: string;
    };
    result: DagGraph & {
      total_nodes?: number;
      total_edges?: number;
      truncated?: boolean;
    };
  };
  "dag.explain_why": {
    params: { target: string; package: string };
    result: {
      target: string;
      package: string;
      included: boolean;
      chains: string[][];
      direct_rdepends: string[];
    };
  };

  "artifacts.list_images": {
    params: Record<string, never>;
    result: { machine: string; deploy_dir: string; images: DeployImage[] };
  };
  "artifacts.get_sbom": {
    params: Record<string, never>;
    result: { format: string; packages: SbomPackage[] };
  };
  "artifacts.get_cves": {
    params: { format?: "sbom-cve-check" | "cve-check" };
    result: {
      tool: string;
      summary?: {
        total: number;
        unpatched: number;
        patched: number;
        ignored: number;
        critical: number;
        high: number;
        medium: number;
        low: number;
      };
      findings: Array<CveFinding & { vector?: string }>;
    };
  };
  "artifacts.export_licenses": {
    params: { format: "csv" | "json" | "markdown" };
    result: { format: string; filename: string; content: string; package_count: number };
  };
  "artifacts.copy_to_host": {
    params: { source_path: string; dest_dir?: string };
    result: {
      ok: boolean;
      source_path: string;
      dest_path: string;
      bytes_copied: number;
      command: string;
    };
  };
  "artifacts.get_buildhistory_diff": {
    params: { from_build?: string; to_build?: string; diff_text?: string };
    result: {
      from_build: string;
      to_build: string;
      rootfs_size_kb: number;
      rootfs_delta_kb: number;
      summary?: {
        total_changes: number;
        added: number;
        removed: number;
        upgraded: number;
      };
      entries: BuildHistoryDiffEntry[];
    };
  };

  "wic.list_wks": {
    params: Record<string, never>;
    result: {
      files: Array<{ name: string; path: string; layer: string; description: string }>;
    };
  };
  "wic.parse_wks": {
    params: { path?: string; content?: string };
    result: WksFile;
  };
  "wic.serialize_wks": {
    params: { wks: Partial<WksFile> & { partitions: WksPartition[] }; save_path?: string };
    result: { raw_text: string; saved: boolean; path?: string };
  };
  "wic.create_image": {
    params: {
      wks_path: string;
      image_name: string;
      wks_content?: string;
      outdir?: string;
    };
    result: {
      ok: boolean;
      command: string;
      output_image: string;
      size_bytes: number;
      log: string;
    };
  };

  "qemu.launch": {
    params: {
      machine: string;
      image?: string;
      mode?: "nographic" | "slirp" | "vnc";
      memory_mb?: number;
      extra_args?: string;
    };
    result: {
      ok: boolean;
      session_id: string;
      pty_session_id: string;
      command: string;
      mode: string;
      ssh_forward?: string;
      status: string;
    };
  };
  "qemu.stop": {
    params: { session_id: string };
    result: { ok: boolean; session_id: string };
  };

  "sdk.list": {
    params: Record<string, never>;
    result: { sdks: SdkArtifact[] };
  };
  "sdk.build": {
    params: { target: string; kind: "standard-sdk" | "esdk" };
    result: {
      ok: boolean;
      command: string;
      sdk: SdkArtifact;
      log: string;
    };
  };

  "preflight.runAudit": {
    params: {
      target?: string;
      incompatible_licenses?: string[];
      check_layer?: string;
      host_resources?: {
        cpu_cores: number;
        ram_total_gb: number;
        ram_available_gb: number;
        disk_free_gb: number;
        psi_supported: boolean;
        provider: string;
      };
    };
    result: PreFlightAuditReport;
  };
  "preflight.getVersionMatrix": {
    params: { target?: string; query?: string };
    result: {
      target: string;
      entries: VersionMatrixEntry[];
      conflicts: PreFlightIssue[];
    };
  };
  "preflight.checkUpgrades": {
    params: { recipes?: string[] };
    result: {
      checked_count: number;
      outdated_count: number;
      entries: VersionMatrixEntry[];
    };
  };
  "preflight.probeSstate": {
    params: { target?: string };
    result: SstateProbeResult;
  };
  "preflight.getOptimizationPlan": {
    params: {
      host_resources?: {
        cpu_cores: number;
        ram_total_gb: number;
        ram_available_gb: number;
        disk_free_gb: number;
        psi_supported: boolean;
        provider: string;
      };
    };
    result: OptimizationPlan;
  };
  "preflight.applyFix": {
    params: {
      fix: PreFlightFixAction;
      dry_run?: boolean;
      target?: string;
      incompatible_licenses?: string[];
      host_resources?: {
        cpu_cores: number;
        ram_total_gb: number;
        ram_available_gb: number;
        disk_free_gb: number;
        psi_supported: boolean;
        provider: string;
      };
    };
    result: {
      applied: boolean;
      fix_id: string;
      diff: string;
      message: string;
      updated_score: number;
      updated_report?: PreFlightAuditReport | null;
    };
  };

  "pro.kernel.diffConfig": {
    params: { search?: string };
    result: {
      changes: Array<{
        symbol: string;
        old_value: string | null;
        new_value: string | null;
        change: "added" | "removed" | "changed";
      }>;
      fragment_content: string;
      search_matches: Array<{ symbol: string; value: string }>;
      total_symbols: number;
    };
  };
  "pro.kernel.saveFragment": {
    params: { fragment_name: string; fragment_content: string };
    result: { ok: boolean; fragment_path: string; bbappend_diff: string; bbappend_content: string };
  };
  "pro.dt.listFiles": {
    params: Record<string, never>;
    result: { files: Array<{ name: string; path: string; layer: string }> };
  };
  "pro.dt.parseTree": {
    params: { path?: string; content?: string };
    result: {
      path: string;
      raw_text: string;
      valid: boolean;
      errors: string[];
      tree: DtNode;
    };
  };
  "pro.dt.updateNodeStatus": {
    params: { path: string; node_path: string; new_status: "okay" | "disabled" };
    result: {
      ok: boolean;
      valid: boolean;
      errors: string[];
      diff: string;
      raw_text: string;
      tree: DtNode;
    };
  };
  "pro.qa.runSuite": {
    params: { suite: "testimage" | "ptest"; target?: string; package?: string };
    result: QaSuiteResult;
  };
  "pro.qa.runHardwareSmoke": {
    params: { target_host?: string; machine?: string };
    result: HardwareSmokeResult;
  };
  "pro.cra.listVex": {
    params: Record<string, never>;
    result: {
      product_purl: string;
      entries: VexEntry[];
      openvex_doc: Record<string, unknown>;
    };
  };
  "pro.cra.updateVex": {
    params: {
      cve_id: string;
      status: "not_affected" | "fixed" | "affected" | "under_investigation";
      justification?: string;
      impact_statement?: string;
    };
    result: { entry: VexEntry; entries: VexEntry[]; openvex_doc: Record<string, unknown> };
  };
  "pro.cra.exportBundle": {
    params: { output_dir?: string; bundle_name?: string };
    result: {
      ok: boolean;
      bundle_path: string;
      size_bytes: number;
      files: string[];
      sha256_bundle: string;
    };
  };
  "pro.secboot.generateConfig": {
    params: {
      enable_fit_sign: boolean;
      key_dir: string;
      key_name: string;
      key_bits: number;
      enable_dm_verity: boolean;
      verity_image: string;
      verity_data_dev: string;
    };
    result: {
      inc_filename: string;
      inc_content: string;
      local_conf_require: string;
      keygen_commands: string[];
      production_warning: string;
    };
  };
  "pro.buildstats.analyze": {
    params: { target?: string };
    result: BuildStatsReport;
  };
  "pro.cicd.generate": {
    params: {
      platform: "gitlab" | "github";
      setup_tool?: string;
      machine?: string;
      target?: string;
      kas_file?: string;
      enable_preflight_gate?: boolean;
      enable_cve_gate?: boolean;
      sstate_cache_dir?: string;
      dl_dir?: string;
    };
    result: { platform: string; filename: string; yaml_content: string };
  };

  "enterprise.multiconfig.list": {
    params: Record<string, never>;
    result: {
      bbmulticonfig_enabled: string[];
      configs: MulticonfigEntry[];
      dependencies: McDependency[];
      local_conf_snippet: string;
    };
  };
  "enterprise.multiconfig.save": {
    params: {
      name: string;
      machine: string;
      tmpdir: string;
      distro?: string;
      description?: string;
      extra_vars?: Record<string, string>;
      add_dependency?: {
        from_config: string;
        to_config: string;
        recipe: string;
        task: string;
      };
    };
    result: {
      config: MulticonfigEntry;
      bbmulticonfig_enabled: string[];
      configs: MulticonfigEntry[];
      dependencies: McDependency[];
      local_conf_diff: string;
    };
  };
  "enterprise.multiconfig.delete": {
    params: { name: string };
    result: {
      ok: boolean;
      bbmulticonfig_enabled: string[];
      configs: MulticonfigEntry[];
    };
  };

  "enterprise.offline.scanAutorev": {
    params: { layer_filter?: string };
    result: { scanned_files: number; findings: AutorevFinding[] };
  };
  "enterprise.offline.pinAutorev": {
    params: { finding_ids: string[] };
    result: {
      pinned_count: number;
      combined_diff: string;
      remaining_findings: AutorevFinding[];
    };
  };
  "enterprise.offline.prepareMirror": {
    params: {
      target?: string;
      dl_dir?: string;
      mirror_dir?: string;
      enable_no_network?: boolean;
      apply_config?: boolean;
    };
    result: OfflineMirrorPlan;
  };
  "enterprise.offline.configureArchiver": {
    params: {
      mode: "original" | "patched";
      gpl_only?: boolean;
      apply_config?: boolean;
      export_bundle?: boolean;
    };
    result: ArchiverBundleResult;
  };

  "enterprise.rootfs.getTreemap": {
    params: { image?: string };
    result: RootfsTreemapResult;
  };
  "enterprise.rootfs.findPath": {
    params: { path: string };
    result: { query: string; matches: PkgPathMatch[] };
  };
  "enterprise.rootfs.diffSigs": {
    params: { recipe?: string; task?: string };
    result: DiffsigsResult;
  };

  "enterprise.debug.exportIdeConfig": {
    params: {
      recipe: string;
      binary_path?: string;
      target_host?: string;
      gdb_port?: number;
      sysroot_path?: string;
      gdb_path?: string;
    };
    result: IdeExportResult;
  };
  "enterprise.debug.startGdbserver": {
    params: {
      target_host: string;
      ssh_user?: string;
      ssh_port?: number;
      remote_binary: string;
      gdb_port?: number;
      args?: string;
    };
    result: GdbserverSessionResult;
  };
  "enterprise.debug.getLiveTelemetry": {
    params: { target_host?: string; ssh_user?: string; journal_unit?: string };
    result: LiveTargetTelemetry;
  };

  "enterprise.migration.scan": {
    params: {
      from_lts: "kirkstone" | "scarthgap";
      to_lts: "scarthgap" | "wrynose";
      layer_name?: string;
    };
    result: MigrationScanResult;
  };
  "enterprise.migration.applyAll": {
    params: {
      from_lts: "kirkstone" | "scarthgap";
      to_lts: "scarthgap" | "wrynose";
      layer_name?: string;
      finding_ids?: string[];
    };
    result: MigrationApplyResult;
  };

  "enterprise.git.statusAll": {
    params: Record<string, never>;
    result: { layers: LayerGitStatus[] };
  };
  "enterprise.git.runAction": {
    params: {
      layer_name: string;
      action: "fetch" | "diff" | "stash" | "stash_pop" | "commit";
      message?: string;
    };
    result: LayerGitActionResult;
  };
  "enterprise.sstate.getRunnerAnalytics": {
    params: {
      mirror_url?: string;
      hashserve_endpoint?: string;
      time_range?: "24h" | "7d" | "30d";
      runner_logs?: Array<{
        runner_id: string;
        runner_name: string;
        arch?: string;
        provider?: string;
        branch?: string;
        nativelsbstring?: string;
        log_text: string;
      }>;
    };
    result: RemoteSstateAnalyticsReport;
  };

  "pty.open": {
    params: {
      kind?: "shell" | "devshell" | "menuconfig" | "diffconfig" | "runqemu";
      recipe?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
    };
    result: { session_id: string; kind: string; title: string; prompt: string };
  };
  "pty.write": {
    params: { session_id: string; data: string };
    result: { ok: boolean };
  };
  "pty.resize": {
    params: { session_id: string; cols: number; rows: number };
    result: { ok: boolean };
  };
  "pty.close": {
    params: { session_id: string };
    result: { ok: boolean };
  };
}

export type RpcMethodName = keyof RpcMethodMap;
