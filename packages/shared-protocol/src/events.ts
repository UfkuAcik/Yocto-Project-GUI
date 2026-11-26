import { z } from "zod";

export const BuildStartedEventSchema = z.object({
  build_id: z.string(),
  target: z.string(),
  machine: z.string(),
  distro: z.string(),
  total_tasks: z.number().int(),
  ts: z.number(),
});

export const BuildTaskStartedEventSchema = z.object({
  build_id: z.string(),
  task_id: z.string(),
  recipe: z.string(),
  task: z.string(),
  worker_slot: z.number().int(),
  from_sstate: z.boolean(),
  ts: z.number(),
});

export const BuildTaskProgressEventSchema = z.object({
  build_id: z.string(),
  task_id: z.string(),
  recipe: z.string(),
  task: z.string(),
  worker_slot: z.number().int(),
  progress: z.number().min(0).max(100),
  ts: z.number(),
});

export const BuildTaskSucceededEventSchema = z.object({
  build_id: z.string(),
  task_id: z.string(),
  recipe: z.string(),
  task: z.string(),
  worker_slot: z.number().int(),
  from_sstate: z.boolean(),
  duration_ms: z.number(),
  completed_tasks: z.number().int(),
  total_tasks: z.number().int(),
  sstate_hits: z.number().int(),
  sstate_misses: z.number().int(),
  ts: z.number(),
});

export const BuildTaskFailedEventSchema = z.object({
  build_id: z.string(),
  task_id: z.string(),
  recipe: z.string(),
  task: z.string(),
  worker_slot: z.number().int(),
  exit_code: z.number().int(),
  error_summary: z.string(),
  log_path: z.string(),
  run_path: z.string(),
  ts: z.number(),
});

export const BuildLogEventSchema = z.object({
  build_id: z.string(),
  seq: z.number().int(),
  level: z.enum(["NOTE", "WARNING", "ERROR", "DEBUG"]),
  recipe: z.string().nullable(),
  task: z.string().nullable(),
  message: z.string(),
  ts: z.number(),
});

export const BuildCompletedEventSchema = z.object({
  build_id: z.string(),
  target: z.string(),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  completed_tasks: z.number().int(),
  total_tasks: z.number().int(),
  sstate_hits: z.number().int(),
  sstate_misses: z.number().int(),
  duration_ms: z.number(),
  ts: z.number(),
});

export const TelemetrySampleEventSchema = z.object({
  cpu_percent: z.number(),
  ram_used_gb: z.number(),
  ram_total_gb: z.number(),
  disk_read_mb_s: z.number(),
  disk_write_mb_s: z.number(),
  ts: z.number(),
});

export const CommandExecutedEventSchema = z.object({
  id: z.string(),
  command: z.string(),
  cwd: z.string(),
  provider: z.string(),
  status: z.enum(["running", "ok", "error"]),
  ts: z.number(),
});

export const PtyOutputEventSchema = z.object({
  session_id: z.string(),
  data: z.string(),
});

export const PtyExitEventSchema = z.object({
  session_id: z.string(),
  exit_code: z.number().int(),
});

export interface BridgeEventMap {
  "build.started": z.infer<typeof BuildStartedEventSchema>;
  "build.task_started": z.infer<typeof BuildTaskStartedEventSchema>;
  "build.task_progress": z.infer<typeof BuildTaskProgressEventSchema>;
  "build.task_succeeded": z.infer<typeof BuildTaskSucceededEventSchema>;
  "build.task_failed": z.infer<typeof BuildTaskFailedEventSchema>;
  "build.log": z.infer<typeof BuildLogEventSchema>;
  "build.completed": z.infer<typeof BuildCompletedEventSchema>;
  "telemetry.sample": z.infer<typeof TelemetrySampleEventSchema>;
  "command.executed": z.infer<typeof CommandExecutedEventSchema>;
  "pty.output": z.infer<typeof PtyOutputEventSchema>;
  "pty.exit": z.infer<typeof PtyExitEventSchema>;
}

export type BridgeEventName = keyof BridgeEventMap;
