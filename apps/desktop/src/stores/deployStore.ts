import { create } from "zustand";
import i18next from "@/i18n";
import type {
  StagedArtifact,
  TargetProfileRecord,
  TftpStatus,
  TftpTransferRecord,
  UbootMacro,
} from "@/lib/deployApi";
import { useAppStore } from "@/stores/appStore";

export interface SelectedDeployArtifact {
  filename: string;
  path: string;
  kind: string;
  size_bytes: number;
  sha256_short?: string;
  machine?: string;
}

export interface DeployJobState {
  jobId: string | null;
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  phase: string;
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  speedMbS: number;
  summary: string;
  sha256: string | null;
  logs: string[];
}

export interface SerialConsoleState {
  sessionId: string | null;
  connected: boolean;
  portName: string;
  baudRate: number;
  autoInterrupt: boolean;
  showTimestamps: boolean;
  buffer: string;
  customMacros: UbootMacro[];
}

export interface FlashConfirmationCheckInput {
  imagePath: string;
  targetDevice: string;
  sha256: string;
  confirmed: boolean;
}

export function validateFlashConfirmation(input: FlashConfirmationCheckInput): {
  valid: boolean;
  reason?: string;
} {
  const isEn = i18next.language === "en";
  if (!input.imagePath.trim()) {
    return {
      valid: false,
      reason: isEn ? "Image path to flash cannot be empty." : "Yüklenecek imaj yolu boş olamaz.",
    };
  }
  const target = input.targetDevice.trim();
  if (!target) {
    return {
      valid: false,
      reason: isEn ? "A target device or partition must be selected." : "Hedef aygıt veya bölüm seçilmelidir.",
    };
  }
  const upper = target.toUpperCase();
  if (
    upper === "C:" ||
    upper === "C:\\" ||
    upper.includes("PHYSICALDRIVE0") ||
    target === "/dev/sda" ||
    target === "/dev/nvme0n1"
  ) {
    return {
      valid: false,
      reason: isEn
        ? `Zero-Brick Protection: System disk (${target}) cannot be written.`
        : `Zero-Brick Koruması: Sistem diski (${target}) yazılamaz.`,
    };
  }
  if (!input.sha256.trim()) {
    return {
      valid: false,
      reason: isEn
        ? "SHA-256 digest must be verified before writing."
        : "Yazma öncesi SHA-256 özeti hazırlanmalıdır.",
    };
  }
  if (!input.confirmed) {
    return {
      valid: false,
      reason: isEn
        ? "User confirmation is required for destructive disk write."
        : "Yıkıcı yazma işlemi için kullanıcı onayı gereklidir.",
    };
  }
  return { valid: true };
}

interface DeployStoreState {
  selectedArtifact: SelectedDeployArtifact | null;
  stagedArtifact: StagedArtifact | null;
  profiles: TargetProfileRecord[];
  activeProfileId: string | null;
  mockMode: boolean;
  splitSerialOpen: boolean;
  activeJob: DeployJobState;
  tftpStatus: TftpStatus;
  serial: SerialConsoleState;

  setSelectedArtifact: (artifact: SelectedDeployArtifact | null) => void;
  setStagedArtifact: (staged: StagedArtifact | null) => void;
  handoffImageToDeploy: (artifact: SelectedDeployArtifact) => void;
  setProfiles: (profiles: TargetProfileRecord[]) => void;
  setActiveProfileId: (id: string | null) => void;
  setMockMode: (mock: boolean) => void;
  setSplitSerialOpen: (open: boolean) => void;

  startJobTracking: (jobId: string, phase: string) => void;
  updateJobProgress: (patch: {
    job_id: string;
    phase: string;
    percent: number;
    bytes_written: number;
    total_bytes: number;
    speed_mb_s: number;
    message: string;
  }) => void;
  appendJobLog: (jobId: string, line: string) => void;
  updateJobStatus: (patch: {
    job_id: string;
    status: "running" | "succeeded" | "failed" | "cancelled";
    summary: string;
    sha256?: string | null;
  }) => void;

  setTftpStatus: (status: TftpStatus) => void;
  upsertTftpTransfer: (xfer: TftpTransferRecord) => void;

  setSerialConnected: (sessionId: string | null, portName: string, baudRate: number) => void;
  setSerialAutoInterrupt: (enabled: boolean) => void;
  setSerialTimestamps: (enabled: boolean) => void;
  appendSerialOutput: (chunk: string, ts?: string) => void;
  clearSerialBuffer: () => void;
  addCustomMacro: (macro: UbootMacro) => void;
}

const INITIAL_JOB: DeployJobState = {
  jobId: null,
  status: "idle",
  phase: "",
  percent: 0,
  bytesWritten: 0,
  totalBytes: 0,
  speedMbS: 0,
  summary: "",
  sha256: null,
  logs: [],
};

export const useDeployStore = create<DeployStoreState>((set) => ({
  selectedArtifact: null,
  stagedArtifact: null,
  profiles: [],
  activeProfileId: null,
  mockMode: true,
  splitSerialOpen: false,
  activeJob: INITIAL_JOB,
  tftpStatus: {
    running: false,
    bind_ip: "0.0.0.0",
    port: 69,
    root_dir: "",
    transfers: [],
  },
  serial: {
    sessionId: null,
    connected: false,
    portName: "mock://uart-imx8mp",
    baudRate: 115200,
    autoInterrupt: true,
    showTimestamps: false,
    buffer: "",
    customMacros: [],
  },

  setSelectedArtifact: (selectedArtifact) => set({ selectedArtifact }),
  setStagedArtifact: (stagedArtifact) => set({ stagedArtifact }),
  handoffImageToDeploy: (artifact) => {
    set({ selectedArtifact: artifact, stagedArtifact: null });
    useAppStore.getState().setActiveModule("deploy");
  },
  setProfiles: (profiles) =>
    set((s) => ({
      profiles,
      activeProfileId:
        s.activeProfileId && profiles.some((p) => p.id === s.activeProfileId)
          ? s.activeProfileId
          : (profiles[0]?.id ?? null),
    })),
  setActiveProfileId: (activeProfileId) => set({ activeProfileId }),
  setMockMode: (mockMode) => set({ mockMode }),
  setSplitSerialOpen: (splitSerialOpen) => set({ splitSerialOpen }),

  startJobTracking: (jobId, phase) =>
    set({
      activeJob: {
        jobId,
        status: "running",
        phase,
        percent: 2,
        bytesWritten: 0,
        totalBytes: 0,
        speedMbS: 0,
        summary:
          i18next.language === "en" ? `Starting ${phase}...` : `${phase} başlatılıyor...`,
        sha256: null,
        logs: [],
      },
    }),

  updateJobProgress: (patch) =>
    set((s) => {
      if (s.activeJob.jobId && s.activeJob.jobId !== patch.job_id) return s;
      return {
        activeJob: {
          ...s.activeJob,
          jobId: patch.job_id,
          status: "running",
          phase: patch.phase,
          percent: patch.percent,
          bytesWritten: patch.bytes_written,
          totalBytes: patch.total_bytes,
          speedMbS: patch.speed_mb_s,
          summary: patch.message,
        },
      };
    }),

  appendJobLog: (jobId, line) =>
    set((s) => {
      if (s.activeJob.jobId && s.activeJob.jobId !== jobId) return s;
      return {
        activeJob: {
          ...s.activeJob,
          logs: [...s.activeJob.logs.slice(-400), line],
        },
      };
    }),

  updateJobStatus: (patch) =>
    set((s) => {
      if (s.activeJob.jobId && s.activeJob.jobId !== patch.job_id) return s;
      return {
        activeJob: {
          ...s.activeJob,
          jobId: patch.job_id,
          status: patch.status,
          percent: patch.status === "succeeded" ? 100 : s.activeJob.percent,
          summary: patch.summary,
          sha256: patch.sha256 ?? s.activeJob.sha256,
        },
      };
    }),

  setTftpStatus: (tftpStatus) => set({ tftpStatus }),
  upsertTftpTransfer: (xfer) =>
    set((s) => {
      const rest = s.tftpStatus.transfers.filter((t) => t.id !== xfer.id);
      return {
        tftpStatus: {
          ...s.tftpStatus,
          transfers: [xfer, ...rest].slice(0, 30),
        },
      };
    }),

  setSerialConnected: (sessionId, portName, baudRate) =>
    set((s) => ({
      serial: {
        ...s.serial,
        sessionId,
        connected: Boolean(sessionId),
        portName,
        baudRate,
      },
    })),

  setSerialAutoInterrupt: (autoInterrupt) =>
    set((s) => ({ serial: { ...s.serial, autoInterrupt } })),

  setSerialTimestamps: (showTimestamps) =>
    set((s) => ({ serial: { ...s.serial, showTimestamps } })),

  appendSerialOutput: (chunk, ts) =>
    set((s) => {
      const prefix = s.serial.showTimestamps && ts ? `[${ts}] ` : "";
      const next = (s.serial.buffer + prefix + chunk).slice(-96_000);
      return { serial: { ...s.serial, buffer: next } };
    }),

  clearSerialBuffer: () =>
    set((s) => ({ serial: { ...s.serial, buffer: "" } })),

  addCustomMacro: (macro) =>
    set((s) => ({
      serial: {
        ...s.serial,
        customMacros: [...s.serial.customMacros.filter((m) => m.id !== macro.id), macro],
      },
    })),
}));
