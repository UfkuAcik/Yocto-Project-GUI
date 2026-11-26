import type { PreFlightAuditReport } from "@yocto-studio/shared-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  evaluatePreFlightGate,
  usePreFlightStore,
  validateImagePlanHardware,
} from "@/stores/preflightStore";

const SAMPLE_REPORT: PreFlightAuditReport = {
  score: 35,
  target: "core-image-minimal",
  machine: "imx8mp-lpddr4-evk",
  yocto_series: "6.0.4 (wrynose)",
  duration_ms: 42,
  blockers: 2,
  warnings: 2,
  optimizations: 3,
  ready_to_build: false,
  issues: [],
  layer_checks: [],
  bloat_items: [],
  license_violations: [],
  check_layer_summary: null,
};

describe("preflightStore gate, auto-fix score progression, and image planner validation", () => {
  beforeEach(() => {
    usePreFlightStore.setState({
      report: null,
      gateEnabled: true,
      blockedBuildTarget: null,
    });
  });

  it("blocks build when gateEnabled is true and blockers > 0, then allows after blockers are resolved", () => {
    const blocked = evaluatePreFlightGate(SAMPLE_REPORT, true);
    expect(blocked.allowBuild).toBe(false);
    expect(blocked.blockers).toBe(2);

    const fixedReport: PreFlightAuditReport = {
      ...SAMPLE_REPORT,
      score: 90,
      blockers: 0,
      ready_to_build: true,
    };
    const allowed = evaluatePreFlightGate(fixedReport, true);
    expect(allowed.allowBuild).toBe(true);
    expect(evaluatePreFlightGate(SAMPLE_REPORT, false).allowBuild).toBe(true);
  });

  it("warns when graphical-hmi scenario is chosen on hardware without gpu/opengl", () => {
    const res = validateImagePlanHardware("graphical-hmi", ["alsa", "usbhost"]);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.warnings[0]).toContain("GPU");

    const testImg = validateImagePlanHardware("hardware-test", ["gpu", "wifi"]);
    expect(testImg.extraPackages).toContain("gdbserver");
    expect(testImg.extraPackages).toContain("can-utils");
    expect(testImg.extraPackages).toContain("spidev-test");
  });
});
