import type { PreFlightAuditReport } from "@yocto-studio/shared-protocol";
import { create } from "zustand";
import i18next from "@/i18n";

export type ImageScenarioId = "headless-iot" | "industrial-gateway" | "graphical-hmi" | "hardware-test";

export function evaluatePreFlightGate(
  report: PreFlightAuditReport | null,
  gateEnabled: boolean
): { allowBuild: boolean; blockers: number; reason?: string } {
  if (!gateEnabled || !report) {
    return { allowBuild: true, blockers: report?.blockers ?? 0 };
  }
  if (report.blockers > 0) {
    return {
      allowBuild: false,
      blockers: report.blockers,
      reason:
        i18next.language === "en"
          ? `Build blocked until ${report.blockers} critical blocker(s) are resolved.`
          : `${report.blockers} adet kritik Blocker hatası çözülmeden derleme engellendi.`,
    };
  }
  return { allowBuild: true, blockers: 0 };
}

export function validateImagePlanHardware(
  scenario: ImageScenarioId,
  machineFeatures: string[]
): { warnings: string[]; recommendedDistroFeatures: string[]; extraPackages: string[] } {
  const mf = new Set(machineFeatures.map((f) => f.trim().toLowerCase()));
  const warnings: string[] = [];
  const isEn = i18next.language === "en";

  if (scenario === "graphical-hmi") {
    if (!mf.has("gpu") && !mf.has("opengl") && !mf.has("drm")) {
      warnings.push(
        isEn
          ? "Selected MACHINE lacks GPU/DRM support; graphical HMI may fall back to software rendering."
          : "Seçili MACHINE üzerinde GPU/DRM desteği işaretli değil; grafiksel HMI yazılımsal render kullanabilir."
      );
    }
    return {
      warnings,
      recommendedDistroFeatures: ["systemd", "wayland", "opengl", "pam"],
      extraPackages: ["weston", "qtbase-examples", "liberation-fonts"],
    };
  }

  if (scenario === "industrial-gateway") {
    if (!mf.has("wifi") && !mf.has("ethernet")) {
      warnings.push(
        isEn
          ? "At least one Ethernet or Wi-Fi hardware feature is recommended for the industrial gateway scenario."
          : "Endüstriyel ağ senaryosu için en az bir Ethernet veya Wi-Fi donanım özelliği önerilir."
      );
    }
    return {
      warnings,
      recommendedDistroFeatures: ["systemd", "seccomp", "wifi", "bluetooth"],
      extraPackages: ["mosquitto", "wireguard-tools", "rauc", "nftables"],
    };
  }

  if (scenario === "hardware-test") {
    return {
      warnings,
      recommendedDistroFeatures: ["systemd", "wifi", "bluetooth", "usbgadget"],
      extraPackages: [
        "gdbserver",
        "strace",
        "iperf3",
        "ethtool",
        "i2c-tools",
        "can-utils",
        "spidev-test",
        "memtester",
        "ptest-runner",
      ],
    };
  }

  return {
    warnings,
    recommendedDistroFeatures: ["systemd"],
    extraPackages: ["openssh-sshd"],
  };
}

interface PreFlightStoreState {
  report: PreFlightAuditReport | null;
  gateEnabled: boolean;
  blockedBuildTarget: string | null;
  incompatibleLicenses: string[];
  runningAudit: boolean;

  setReport: (report: PreFlightAuditReport | null) => void;
  setGateEnabled: (enabled: boolean) => void;
  setBlockedBuildTarget: (target: string | null) => void;
  setIncompatibleLicenses: (licenses: string[]) => void;
  setRunningAudit: (running: boolean) => void;
}

export const usePreFlightStore = create<PreFlightStoreState>((set) => ({
  report: null,
  gateEnabled: true,
  blockedBuildTarget: null,
  incompatibleLicenses: ["GPL-3.0*"],
  runningAudit: false,

  setReport: (report) => set({ report }),
  setGateEnabled: (gateEnabled) => set({ gateEnabled }),
  setBlockedBuildTarget: (blockedBuildTarget) => set({ blockedBuildTarget }),
  setIncompatibleLicenses: (incompatibleLicenses) => set({ incompatibleLicenses }),
  setRunningAudit: (runningAudit) => set({ runningAudit }),
}));
