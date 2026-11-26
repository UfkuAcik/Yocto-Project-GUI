import { invoke } from "@tauri-apps/api/core";
import i18next from "@/i18n";
import { isTauriRuntime } from "@/lib/tauriApi";

export interface TargetProfileRecord {
  id: string;
  project_id: string;
  name: string;
  machine: string;
  preferred_method: "usb" | "tftp" | "swupdate" | "rauc" | "ssh_raw";
  usb_flasher:
    | "raw_disk"
    | "fastboot"
    | "dfu"
    | "nxp_uuu"
    | "stm32_prog"
    | "ti_dfu_boot"
    | "mediatek_sp"
    | "rockchip_rkdev"
    | "custom_cli";
  target_ip: string;
  ssh_user: string;
  ssh_key_ref: string;
  swupdate_url: string;
  uart_port: string;
  uart_baud: number;
  ab_slots_json: string;
  custom_cli_template: string;
  created_at: string;
}

export interface FlashToolStatus {
  tool_id: string;
  display_name: string;
  binary: string;
  found: boolean;
  resolved_path?: string | null;
  version?: string | null;
  install_hint: string;
}

export interface StagedArtifact {
  local_path: string;
  bmap_path?: string | null;
  sha256_path?: string | null;
  sha256: string;
  size_bytes: number;
  cache_hit: boolean;
  verified: boolean;
  source_path: string;
}

export interface UsbDetectedDevice {
  id: string;
  kind: string;
  name: string;
  device_path: string;
  size_bytes: number;
  size_human: string;
  bus_type: string;
  is_system_disk: boolean;
  removable: boolean;
  details: string;
}

export interface DfuAltSetting {
  alt_index: number;
  name: string;
  vid_pid: string;
  serial: string;
  interface: string;
}

export interface PartitionMapping {
  partition: string;
  file_path: string;
}

export interface FlashRequest {
  job_id: string;
  flasher_kind:
    | "raw_disk"
    | "fastboot"
    | "dfu"
    | "nxp_uuu"
    | "stm32_prog"
    | "ti_dfu_boot"
    | "mediatek_sp"
    | "rockchip_rkdev"
    | "custom_cli";
  image_path: string;
  deploy_dir: string;
  machine: string;
  kernel_path: string;
  dtb_path: string;
  serial_port: string;
  target_device: string;
  partition_map: PartitionMapping[];
  altsetting?: string;
  vid_pid?: string;
  uuu_mode?: string;
  uuu_script_path?: string;
  bootloader_path?: string;
  tsv_path?: string;
  custom_template?: string;
  ti_tiboot3_path?: string;
  ti_tispl_path?: string;
  mtk_scatter_path?: string;
  mtk_da_path?: string;
  rk_loader_path?: string;
  rk_lba_offset?: string;
  verify_after_write: boolean;
  reboot_after: boolean;
  mock_mode: boolean;
  confirmed: boolean;
  confirmed_sha256?: string;
}

export interface FlashOutcome {
  job_id: string;
  ok: boolean;
  sha256: string;
  bytes_written: number;
  summary: string;
}

export interface NetworkInterfaceInfo {
  name: string;
  ip: string;
  is_loopback: boolean;
}

export interface TftpTransferRecord {
  id: string;
  client_ip: string;
  filename: string;
  bytes_sent: number;
  total_bytes: number;
  speed_kb_s: number;
  status: string;
  ts: string;
}

export interface TftpStatus {
  running: boolean;
  bind_ip: string;
  port: number;
  root_dir: string;
  transfers: TftpTransferRecord[];
}

export interface RaucSlotInfo {
  slot_name: string;
  class: string;
  device: string;
  state: string;
  bootname: string;
  boot_status: string;
  bundle_version: string;
  active: boolean;
}

export interface RaucStatus {
  compatible: string;
  variant: string;
  booted: string;
  slots: RaucSlotInfo[];
}

export interface RemoteBlockDevice {
  name: string;
  path: string;
  size_bytes: number;
  size_human: string;
  model: string;
  mountpoints: string[];
  is_active_root: boolean;
}

export interface SerialPortInfo {
  port_name: string;
  description: string;
  vid?: string | null;
  pid?: string | null;
  manufacturer?: string | null;
  serial_number?: string | null;
  is_virtual: boolean;
}

export interface UbootMacro {
  id: string;
  label: string;
  command: string;
  description: string;
  category: string;
}

const TARGET_PROFILES_LS_KEY = "yocto_studio_target_profiles";

export async function listTargetProfiles(projectId?: string): Promise<TargetProfileRecord[]> {
  if (isTauriRuntime()) {
    return invoke<TargetProfileRecord[]>("list_target_profiles", {
      projectId: projectId ?? null,
    });
  }
  try {
    const raw = localStorage.getItem(TARGET_PROFILES_LS_KEY);
    const items: TargetProfileRecord[] = raw ? JSON.parse(raw) : [];
    return projectId ? items.filter((p) => p.project_id === projectId) : items;
  } catch {
    return [];
  }
}

export async function saveTargetProfile(profile: TargetProfileRecord): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("save_target_profile", { profile });
    return;
  }
  try {
    const existing = await listTargetProfiles();
    const updated = [profile, ...existing.filter((p) => p.id !== profile.id)];
    localStorage.setItem(TARGET_PROFILES_LS_KEY, JSON.stringify(updated));
  } catch {
    // ignore storage errors
  }
}

export async function deleteTargetProfile(id: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("delete_target_profile", { id });
    return;
  }
  try {
    const existing = await listTargetProfiles();
    localStorage.setItem(
      TARGET_PROFILES_LS_KEY,
      JSON.stringify(existing.filter((p) => p.id !== id))
    );
  } catch {
    // ignore
  }
}

export async function getFlashToolsHealth(): Promise<FlashToolStatus[]> {
  if (isTauriRuntime()) {
    return invoke<FlashToolStatus[]>("get_flash_tools_health");
  }
  const isEn = i18next.language === "en";
  return [
    {
      tool_id: "fastboot",
      display_name: "Android / U-Boot Fastboot",
      binary: "fastboot",
      found: false,
      resolved_path: null,
      version: null,
      install_hint: isEn
        ? "Select Platform-Tools binary path (Mock active in browser preview)"
        : "Platform-Tools yolunu belirtin (Tarayıcı önizlemesinde Mock aktif)",
    },
    {
      tool_id: "dfu-util",
      display_name: "USB DFU (dfu-util)",
      binary: "dfu-util",
      found: false,
      resolved_path: null,
      version: null,
      install_hint: isEn ? "Install dfu-util and select binary path" : "dfu-util kurup yolunu seçin",
    },
    {
      tool_id: "uuu",
      display_name: "NXP i.MX Universal Update (uuu)",
      binary: "uuu",
      found: false,
      resolved_path: null,
      version: null,
      install_hint: isEn ? "Select mfgtools uuu binary path" : "mfgtools uuu ikili yolunu seçin",
    },
    {
      tool_id: "stm32_prog",
      display_name: "STM32CubeProgrammer CLI",
      binary: "STM32_Programmer_CLI",
      found: false,
      resolved_path: null,
      version: null,
      install_hint: isEn ? "Select STM32_Programmer_CLI binary path" : "STM32_Programmer_CLI yolunu seçin",
    },
    {
      tool_id: "rpiboot",
      display_name: "Raspberry Pi USB Boot (rpiboot)",
      binary: "rpiboot",
      found: false,
      resolved_path: null,
      version: null,
      install_hint: isEn ? "Select rpiboot binary path" : "rpiboot yolunu seçin",
    },
    {
      tool_id: "sp-flash-tool",
      display_name: "MediaTek SP Flash Tool",
      binary: "sp-flash-tool",
      found: false,
      resolved_path: null,
      version: null,
      install_hint: isEn
        ? "Select MediaTek sp-flash-tool / genio-flash binary path"
        : "MediaTek sp-flash-tool / genio-flash yolunu seçin",
    },
    {
      tool_id: "rkdeveloptool",
      display_name: "Rockchip Maskrom (rkdeveloptool)",
      binary: "rkdeveloptool",
      found: false,
      resolved_path: null,
      version: null,
      install_hint: isEn ? "Select rkdeveloptool binary path" : "rkdeveloptool yolunu seçin",
    },
  ];
}

export async function setFlashToolPath(toolId: string, path: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("set_flash_tool_path", { toolId, path });
  }
}

export async function stageDeployArtifact(req: {
  source_kind: string;
  source_path: string;
  project_id: string;
  machine: string;
  wsl_distro?: string;
  expected_sha256?: string;
  mock_mode: boolean;
}): Promise<StagedArtifact> {
  if (isTauriRuntime()) {
    return invoke<StagedArtifact>("stage_deploy_artifact", { req });
  }
  return {
    local_path: `C:\\Users\\Demo\\AppData\\Local\\yocto-studio\\staging\\${req.machine}\\${req.source_path.split(/[\\/]/).pop() ?? "image.wic"}`,
    bmap_path: `${req.source_path}.bmap`,
    sha256_path: `${req.source_path}.sha256`,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    size_bytes: 148_392_448,
    cache_hit: false,
    verified: true,
    source_path: req.source_path,
  };
}

export async function listUsbDeployDevices(includeMock = true): Promise<UsbDetectedDevice[]> {
  if (isTauriRuntime()) {
    return invoke<UsbDetectedDevice[]>("list_usb_deploy_devices", { includeMock });
  }
  const isEn = i18next.language === "en";
  const sim = isEn ? "(Simulation)" : "(Simülasyon)";
  return [
    {
      id: "mock-sd-01",
      kind: "raw_disk",
      name: `SanDisk Industrial microSD 32GB ${sim}`,
      device_path: "mock://sd-card-industrial-32g",
      size_bytes: 31_914_983_424,
      size_human: "29.7 GB",
      bus_type: "USB (Mock)",
      is_system_disk: false,
      removable: true,
      details: isEn ? "Removable SD / USB / UMS" : "Çıkarılabilir SD / USB / UMS",
    },
    {
      id: "mock-fb-01",
      kind: "fastboot",
      name: `NXP i.MX8MP U-Boot Fastboot ${sim}`,
      device_path: "IMX8MP-FB-001",
      size_bytes: 0,
      size_human: "16 GB eMMC",
      bus_type: "USB Fastboot (Mock)",
      is_system_disk: false,
      removable: true,
      details: "mock fastboot gadget",
    },
    {
      id: "mock-uuu-01",
      kind: "nxp_uuu",
      name: `NXP i.MX8MP SDP [1fc9:0146] ${sim}`,
      device_path: "usb:1:14-1fc9:0146",
      size_bytes: 0,
      size_human: "32 GB eMMC",
      bus_type: "USB SDP (Mock uuu)",
      is_system_disk: false,
      removable: true,
      details: "MX8MP SDP Serial Download Protocol",
    },
    {
      id: "mock-ti-am62x-dfu",
      kind: "ti_dfu_boot",
      name: `TI AM625-SK Sitara ROM DFU ${sim}`,
      device_path: "0451:6165",
      size_bytes: 17_179_869_184,
      size_human: "16 GB eMMC",
      bus_type: "USB DFU",
      is_system_disk: false,
      removable: true,
      details: "VID:PID 0451:6165 · alt=bootloader, tispl.bin, u-boot.img",
    },
    {
      id: "mock-mtk-genio-700",
      kind: "mediatek_sp",
      name: `MediaTek Genio 700 EVK BROM/Preloader ${sim}`,
      device_path: "0e8d:2000",
      size_bytes: 34_359_738_368,
      size_human: "32 GB UFS/eMMC",
      bus_type: "USB BROM",
      is_system_disk: false,
      removable: true,
      details: isEn
        ? "VID:PID 0e8d:2000 · sp-flash-tool / genio-flash compatible"
        : "VID:PID 0e8d:2000 · sp-flash-tool / genio-flash uyumlu",
    },
    {
      id: "mock-rk3588-maskrom",
      kind: "rockchip_rkdev",
      name: `Rockchip RK3588 Maskrom USB [2207:350b] ${sim}`,
      device_path: "rkdev://2207:350b",
      size_bytes: 68_719_476_736,
      size_human: "64 GB eMMC",
      bus_type: "USB Maskrom",
      is_system_disk: false,
      removable: true,
      details: "DevNo=1 Vid=0x2207 Pid=0x350b LocationID=104 Maskrom",
    },
  ];
}

export async function listDfuAltsettings(includeMock = true): Promise<DfuAltSetting[]> {
  if (isTauriRuntime()) {
    return invoke<DfuAltSetting[]>("list_dfu_altsettings", { includeMock });
  }
  return [
    { alt_index: 0, name: "@FSBL /0x00/1*004Ke", vid_pid: "0483:df11", serial: "0029003B", interface: "alt=0" },
    { alt_index: 1, name: "@SSBL /0x00/1*002Me", vid_pid: "0483:df11", serial: "0029003B", interface: "alt=1" },
    { alt_index: 2, name: "@rootfs /0x00/1*256Me", vid_pid: "0483:df11", serial: "0029003B", interface: "alt=2" },
  ];
}

export async function startUsbFlash(req: FlashRequest): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("start_usb_flash", { req });
  }
  return req.job_id || "mock-browser-job";
}

export async function cancelDeployJob(jobId: string): Promise<boolean> {
  if (isTauriRuntime()) {
    return invoke<boolean>("cancel_deploy_job", { jobId });
  }
  return true;
}

export async function listNetworkInterfaces(): Promise<NetworkInterfaceInfo[]> {
  if (isTauriRuntime()) {
    return invoke<NetworkInterfaceInfo[]>("list_network_interfaces");
  }
  const isEn = i18next.language === "en";
  return [
    { name: isEn ? "All Interfaces (Any)" : "Tüm Arayüzler (Any)", ip: "0.0.0.0", is_loopback: false },
    { name: isEn ? "Ethernet (Simulation)" : "Ethernet (Simülasyon)", ip: "192.168.10.2", is_loopback: false },
    { name: "Loopback", ip: "127.0.0.1", is_loopback: true },
  ];
}

export async function startTftpServer(
  bindIp: string,
  port: number,
  rootDir?: string
): Promise<TftpStatus> {
  if (isTauriRuntime()) {
    return invoke<TftpStatus>("start_tftp_server", {
      bindIp,
      port,
      rootDir: rootDir ?? null,
    });
  }
  return {
    running: true,
    bind_ip: bindIp,
    port,
    root_dir: rootDir || "staging",
    transfers: [
      {
        id: "tftp-demo",
        client_ip: "192.168.10.50",
        filename: "Image-6.12.19-yocto-standard",
        bytes_sent: 34_816_000,
        total_bytes: 34_816_000,
        speed_kb_s: 8420,
        status: "completed",
        ts: "10:52:04",
      },
    ],
  };
}

export async function stopTftpServer(): Promise<TftpStatus> {
  if (isTauriRuntime()) {
    return invoke<TftpStatus>("stop_tftp_server");
  }
  return { running: false, bind_ip: "0.0.0.0", port: 69, root_dir: "", transfers: [] };
}

export async function generateUbootTftpScript(
  serverIp: string,
  targetIp: string,
  kernelFile: string,
  dtbFile: string
): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("generate_uboot_tftp_script", {
      serverIp,
      targetIp,
      kernelFile,
      dtbFile,
    });
  }
  const srv = serverIp === "0.0.0.0" ? "192.168.10.2" : serverIp;
  return `setenv ipaddr ${targetIp}\nsetenv serverip ${srv}\ntftpboot \${loadaddr} ${kernelFile}\ntftpboot \${fdt_addr_r} ${dtbFile}\nbooti \${loadaddr} - \${fdt_addr_r}`;
}

export async function swupdateDeploy(req: {
  job_id: string;
  target_url: string;
  swu_path: string;
  mock_mode: boolean;
  confirmed: boolean;
}): Promise<FlashOutcome> {
  if (isTauriRuntime()) {
    return invoke<FlashOutcome>("swupdate_deploy", { req });
  }
  return {
    job_id: req.job_id,
    ok: true,
    sha256: "",
    bytes_written: 64_000_000,
    summary:
      i18next.language === "en"
        ? `Mock SWUpdate OTA (${req.target_url}) completed.`
        : `Mock SWUpdate OTA (${req.target_url}) tamamlandı.`,
  };
}

export async function raucGetStatus(
  host: string,
  sshUser: string,
  sshKeyRef: string,
  mockMode: boolean
): Promise<RaucStatus> {
  if (isTauriRuntime()) {
    return invoke<RaucStatus>("rauc_get_status", {
      host,
      sshUser,
      sshKeyRef,
      mockMode,
    });
  }
  return {
    compatible: "imx8mp-lpddr4-evk",
    variant: "prod",
    booted: "A",
    slots: [
      {
        slot_name: "rootfs.0",
        class: "rootfs",
        device: "/dev/mmcblk2p2",
        state: "booted",
        bootname: "A",
        boot_status: "good",
        bundle_version: "2026.11.0",
        active: true,
      },
      {
        slot_name: "rootfs.1",
        class: "rootfs",
        device: "/dev/mmcblk2p3",
        state: "inactive",
        bootname: "B",
        boot_status: "good",
        bundle_version: "2026.10.2",
        active: false,
      },
    ],
  };
}

export async function raucInstallBundle(req: {
  job_id: string;
  host: string;
  ssh_user: string;
  ssh_key_ref: string;
  bundle_path: string;
  reboot_after: boolean;
  mock_mode: boolean;
  confirmed: boolean;
}): Promise<FlashOutcome> {
  if (isTauriRuntime()) {
    return invoke<FlashOutcome>("rauc_install_bundle", { req });
  }
  return {
    job_id: req.job_id,
    ok: true,
    sha256: "",
    bytes_written: 51_200_000,
    summary:
      i18next.language === "en"
        ? `Mock RAUC (${req.bundle_path}) installed to inactive slot.`
        : `Mock RAUC (${req.bundle_path}) pasif slota yüklendi.`,
  };
}

export async function sshListBlockDevices(
  host: string,
  sshUser: string,
  sshKeyRef: string,
  mockMode: boolean
): Promise<RemoteBlockDevice[]> {
  if (isTauriRuntime()) {
    return invoke<RemoteBlockDevice[]>("ssh_list_block_devices", {
      host,
      sshUser,
      sshKeyRef,
      mockMode,
    });
  }
  return [
    {
      name: "mmcblk2p1",
      path: "/dev/mmcblk2p1",
      size_bytes: 134_217_728,
      size_human: "128.0 MB",
      model: "eMMC Boot",
      mountpoints: ["/boot"],
      is_active_root: true,
    },
    {
      name: "mmcblk2p2",
      path: "/dev/mmcblk2p2",
      size_bytes: 4_294_967_296,
      size_human: "4.0 GB",
      model: "eMMC Slot A",
      mountpoints: ["/"],
      is_active_root: true,
    },
    {
      name: "mmcblk2p3",
      path: "/dev/mmcblk2p3",
      size_bytes: 4_294_967_296,
      size_human: "4.0 GB",
      model: i18next.language === "en" ? "eMMC Slot B (Passive)" : "eMMC Slot B (Pasif)",
      mountpoints: [],
      is_active_root: false,
    },
  ];
}

export async function sshFlashPartition(req: {
  job_id: string;
  host: string;
  ssh_user: string;
  ssh_key_ref: string;
  image_path: string;
  target_device: string;
  use_bmaptool: boolean;
  mock_mode: boolean;
  confirmed: boolean;
}): Promise<FlashOutcome> {
  if (isTauriRuntime()) {
    return invoke<FlashOutcome>("ssh_flash_partition", { req });
  }
  return {
    job_id: req.job_id,
    ok: true,
    sha256: "",
    bytes_written: 120_000_000,
    summary:
      i18next.language === "en"
        ? `Mock SSH Raw (${req.target_device}) completed.`
        : `Mock SSH Raw (${req.target_device}) tamamlandı.`,
  };
}

export async function listSerialPorts(includeVirtual = true): Promise<SerialPortInfo[]> {
  if (isTauriRuntime()) {
    return invoke<SerialPortInfo[]>("list_serial_ports", { includeVirtual });
  }
  const isEn = i18next.language === "en";
  return [
    {
      port_name: "mock://uart-imx8mp",
      description: isEn
        ? "Virtual i.MX8MP U-Boot / Linux UART (Simulation)"
        : "Sanal i.MX8MP U-Boot / Linux UART (Simülasyon)",
      vid: "0403",
      pid: "6001",
      manufacturer: "FTDI (Virtual)",
      serial_number: "MOCK-UART-01",
      is_virtual: true,
    },
  ];
}

export async function openSerialPort(config: {
  port_name: string;
  baud_rate: number;
  data_bits: number;
  parity: string;
  stop_bits: number;
  auto_interrupt_uboot: boolean;
  interrupt_key?: string;
}): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("open_serial_port", { config });
  }
  return "uart-browser-mock";
}

export async function writeSerialPort(sessionId: string, data: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("write_serial_port", { sessionId, data });
  }
}

export async function closeSerialPort(sessionId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("close_serial_port", { sessionId });
  }
}

export async function setSerialAutoInterrupt(sessionId: string, enabled: boolean): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("set_serial_auto_interrupt", { sessionId, enabled });
  }
}

export async function getUbootMacros(): Promise<UbootMacro[]> {
  if (isTauriRuntime()) {
    return invoke<UbootMacro[]>("get_uboot_macros");
  }
  const isEn = i18next.language === "en";
  return [
    {
      id: "ums-mmc0",
      label: isEn ? "UMS Mode (eMMC/SD)" : "UMS Modu (eMMC/SD)",
      command: "ums 0 mmc 0",
      description: isEn
        ? "Exposes the target MMC device as USB Mass Storage."
        : "Hedef MMC aygıtını USB Mass Storage olarak açar.",
      category: "usb",
    },
    {
      id: "fastboot-0",
      label: isEn ? "Fastboot Mode" : "Fastboot Modu",
      command: "fastboot 0",
      description: isEn
        ? "Starts U-Boot fastboot USB gadget mode."
        : "U-Boot fastboot USB gadget modunu başlatır.",
      category: "usb",
    },
    {
      id: "tftpboot-net",
      label: "TFTP Boot",
      command: "dhcp; tftpboot ${loadaddr} Image && tftpboot ${fdt_addr_r} devicetree.dtb && booti ${loadaddr} - ${fdt_addr_r}",
      description: isEn
        ? "Downloads kernel and DTB over TFTP and boots."
        : "TFTP üzerinden kernel ve DTB yükleyip başlatır.",
      category: "network",
    },
    {
      id: "printenv",
      label: "printenv",
      command: "printenv",
      description: isEn
        ? "Lists all U-Boot environment variables."
        : "Tüm U-Boot ortam değişkenlerini listeler.",
      category: "diag",
    },
    {
      id: "reset",
      label: "Reset",
      command: "reset",
      description: isEn ? "Resets the target board." : "Hedef kartı yeniden başlatır.",
      category: "power",
    },
  ];
}

export async function saveSerialLog(sessionId: string, destPath: string): Promise<number> {
  if (isTauriRuntime()) {
    return invoke<number>("save_serial_log", { sessionId, destPath });
  }
  return destPath.length;
}
