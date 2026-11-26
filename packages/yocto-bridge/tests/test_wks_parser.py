"""Unit tests for pure-stdlib `.wks` kickstart parser and serializer."""

from __future__ import annotations

from bridge.parsers.wks_parser import parse_wks, serialize_wks

SAMPLE_WKS = """# short-description: NXP i.MX8MP SD card layout
part u-boot --source rawcopy --sourceparams="file=imx-boot" --ondisk mmcblk2 --no-table --align 32
part /boot --source bootimg-partition --ondisk mmcblk2 --fstype=vfat --label boot --active --align 4096 --size 128M
part / --source rootfs --ondisk mmcblk2 --fstype=ext4 --label rootfs --align 4096 --size 2G
part /data --ondisk mmcblk2 --fstype=ext4 --label data --fixed-size 512M
bootloader --ptable gpt --timeout=3 --append="console=ttymxc1,115200 rootwait rw"
"""


def test_parse_wks_extracts_partitions_and_bootloader() -> None:
    parsed = parse_wks(SAMPLE_WKS, path="meta-freescale/wic/imx.wks")
    assert parsed["bootloader"]["ptable"] == "gpt"
    assert parsed["bootloader"]["timeout"] == 3
    assert "console=ttymxc1,115200" in (parsed["bootloader"]["append"] or "")

    parts = parsed["partitions"]
    assert len(parts) == 4
    assert parts[0]["name"] == "u-boot"
    assert parts[0]["no_table"] is True
    assert parts[1]["mountpoint"] == "/boot"
    assert parts[1]["fstype"] == "vfat"
    assert parts[1]["active"] is True
    assert parts[1]["size_mb"] == 128
    assert parts[2]["mountpoint"] == "/"
    assert parts[2]["size_mb"] == 2048
    assert parts[3]["fixed_size_mb"] == 512
    assert parsed["total_size_mb"] == 128 + 2048 + 512


def test_serialize_wks_roundtrip_preserves_layout() -> None:
    parsed = parse_wks(SAMPLE_WKS)
    parsed["partitions"][2]["size_mb"] = 4096
    regenerated = serialize_wks(parsed)
    reparsed = parse_wks(regenerated)

    assert len(reparsed["partitions"]) == 4
    assert reparsed["partitions"][2]["size_mb"] == 4096
    assert reparsed["bootloader"]["ptable"] == "gpt"
    assert reparsed["bootloader"]["timeout"] == 3
