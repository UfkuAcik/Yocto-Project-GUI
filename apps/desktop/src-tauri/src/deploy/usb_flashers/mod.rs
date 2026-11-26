pub mod custom_cli;
pub mod dfu;
pub mod fastboot;
pub mod mediatek_sp;
pub mod nxp_uuu;
pub mod raw_disk;
pub mod rockchip_rkdev;
pub mod stm32_prog;
pub mod ti_dfu_boot;

use crate::deploy::UsbDetectedDevice;

pub fn collect_all_usb_devices(
    fastboot_bin: &str,
    uuu_bin: &str,
    dfu_bin: &str,
    rk_bin: &str,
    include_mock: bool,
) -> Vec<UsbDetectedDevice> {
    let mut list = raw_disk::list_safe_removable_drives(include_mock);
    list.extend(fastboot::detect_fastboot_devices(fastboot_bin, include_mock));
    list.extend(nxp_uuu::detect_uuu_devices(uuu_bin, include_mock));
    list.extend(ti_dfu_boot::detect_ti_dfu_devices(dfu_bin, include_mock));
    list.extend(mediatek_sp::detect_mediatek_devices(include_mock));
    list.extend(rockchip_rkdev::detect_rockchip_devices(rk_bin, include_mock));
    list
}
