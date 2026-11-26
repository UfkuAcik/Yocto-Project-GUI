import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/stores/appStore";
import { useDeployStore, validateFlashConfirmation } from "@/stores/deployStore";

describe("deployStore and Zero-Brick confirmation guardrails", () => {
  beforeEach(() => {
    useAppStore.setState({ activeModule: "artifacts" });
    useDeployStore.setState({
      selectedArtifact: null,
      stagedArtifact: null,
      profiles: [],
      activeProfileId: null,
    });
  });

  it("transfers selected image from Module 7 to Module 8 via handoffImageToDeploy", () => {
    useDeployStore.getState().handoffImageToDeploy({
      filename: "core-image-minimal-imx8mp-lpddr4-evk.rootfs.wic.bz2",
      path: "/home/yocto/deploy/core-image-minimal-imx8mp-lpddr4-evk.rootfs.wic.bz2",
      kind: "wic",
      size_bytes: 148_392_448,
      sha256_short: "8f2a9c1b",
      machine: "imx8mp-lpddr4-evk",
    });

    expect(useAppStore.getState().activeModule).toBe("deploy");
    expect(useDeployStore.getState().selectedArtifact?.filename).toContain("wic.bz2");
  });

  it("blocks OS system disks and unconfirmed destructive flash requests", () => {
    const sysRes = validateFlashConfirmation({
      imagePath: "core-image-minimal.wic",
      targetDevice: "\\\\.\\PHYSICALDRIVE0",
      sha256: "abc123",
      confirmed: true,
    });
    expect(sysRes.valid).toBe(false);
    expect(sysRes.reason).toContain("Zero-Brick");

    const unconfirmed = validateFlashConfirmation({
      imagePath: "core-image-minimal.wic",
      targetDevice: "mock://sd-card-industrial-32g",
      sha256: "abc123",
      confirmed: false,
    });
    expect(unconfirmed.valid).toBe(false);

    const ok = validateFlashConfirmation({
      imagePath: "core-image-minimal.wic",
      targetDevice: "mock://sd-card-industrial-32g",
      sha256: "abc123",
      confirmed: true,
    });
    expect(ok.valid).toBe(true);
  });

  it("tracks target profiles and UART auto-interrupt + custom macros", () => {
    useDeployStore.getState().setProfiles([
      {
        id: "tp-1",
        project_id: "proj-1",
        name: "i.MX8MP-EVK",
        machine: "imx8mp-lpddr4-evk",
        preferred_method: "usb",
        usb_flasher: "nxp_uuu",
        target_ip: "192.168.10.50",
        ssh_user: "root",
        ssh_key_ref: "keyring://yocto/imx8mp",
        swupdate_url: "http://192.168.10.50:8080",
        uart_port: "mock://uart-imx8mp",
        uart_baud: 115200,
        ab_slots_json: "{}",
        custom_cli_template: "uuu -b emmc_all {IMAGE_PATH}",
        created_at: "2026-11-25T10:00:00Z",
      },
    ]);
    expect(useDeployStore.getState().activeProfileId).toBe("tp-1");

    useDeployStore.getState().setSerialAutoInterrupt(false);
    expect(useDeployStore.getState().serial.autoInterrupt).toBe(false);
    useDeployStore.getState().addCustomMacro({
      id: "custom-1",
      label: "Boot Env Reset",
      command: "env default -a; saveenv",
      description: "Varsayılan U-Boot ortamı",
      category: "custom",
    });
    expect(useDeployStore.getState().serial.customMacros).toHaveLength(1);
  });
});
