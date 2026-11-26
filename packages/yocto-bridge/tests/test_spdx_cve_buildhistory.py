"""Unit tests for SPDX 3.0 JSON-LD, CVE parsers, license matrix export, and buildhistory diff."""

from __future__ import annotations

import json

from bridge.parsers.buildhistory import parse_buildhistory_diff
from bridge.parsers.spdx_cve import export_license_matrix, parse_cve_report, parse_spdx3_jsonld


def test_parse_spdx3_jsonld_with_relationships_and_direct_attrs() -> None:
    spdx3_doc = {
        "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
        "@graph": [
            {
                "type": "simplelicensing_LicenseExpression",
                "spdxId": "spdx:lic-gpl2",
                "simplelicensing_licenseExpression": "GPL-2.0-only",
            },
            {
                "type": "software_Package",
                "spdxId": "spdx:pkg-kernel",
                "name": "linux-yocto",
                "software_packageVersion": "6.12.19",
                "software_packageUrl": "pkg:yocto/oe-core/linux-yocto@6.12.19",
                "verifiedUsing": [{"algorithm": "sha256", "hashValue": "abcd1234"}],
            },
            {
                "type": "Relationship",
                "spdxId": "spdx:rel-1",
                "relationshipType": "hasConcludedLicense",
                "from": "spdx:pkg-kernel",
                "to": ["spdx:lic-gpl2"],
            },
            {
                "type": "software_Package",
                "spdxId": "spdx:pkg-openssl",
                "name": "openssl",
                "software_packageVersion": "3.5.0",
                "software_concludedLicense": "Apache-2.0",
            },
        ],
    }
    pkgs = parse_spdx3_jsonld(spdx3_doc)
    assert len(pkgs) == 2
    assert pkgs[0]["name"] == "linux-yocto"
    assert pkgs[0]["license"] == "GPL-2.0-only"
    assert pkgs[0]["sha256"] == "abcd1234"
    assert pkgs[1]["license"] == "Apache-2.0"

    csv_out = export_license_matrix(pkgs, "csv")
    assert "linux-yocto,6.12.19,GPL-2.0-only" in csv_out
    md_out = export_license_matrix(pkgs, "markdown")
    assert "| openssl | 3.5.0 | Apache-2.0 |" in md_out
    json_out = json.loads(export_license_matrix(pkgs, "json"))
    assert len(json_out) == 2


def test_parse_cve_report_supports_wrynose_and_scarthgap() -> None:
    scarthgap = {
        "version": "1",
        "package": [
            {
                "name": "mosquitto",
                "version": "2.0.20",
                "issue": [
                    {
                        "id": "CVE-2025-41203",
                        "status": "Unpatched",
                        "scorev3": "9.1",
                        "summary": "Heap OOB",
                    }
                ],
            }
        ],
    }
    parsed_s = parse_cve_report(scarthgap)
    assert parsed_s["summary"]["critical"] == 1
    assert parsed_s["summary"]["unpatched"] == 1
    assert parsed_s["findings"][0]["severity"] == "CRITICAL"

    wrynose = {
        "tool": "sbom-cve-check",
        "vulnerabilities": [
            {
                "id": "CVE-2025-29911",
                "package": "openssl",
                "version": "3.5.0",
                "cvss": 5.3,
                "status": "Patched",
                "description": "Timing issue",
            }
        ],
    }
    parsed_w = parse_cve_report(wrynose)
    assert parsed_w["summary"]["patched"] == 1
    assert parsed_w["findings"][0]["severity"] == "MEDIUM"


def test_parse_buildhistory_diff_extracts_sizes_and_packages() -> None:
    raw_diff = (
        "images/imx8mp/glibc/core-image-minimal: IMAGESIZE: 132000 -> 134500\n"
        "packages/cortexa53-poky-linux/mosquitto/mosquitto: PV: 2.0.18 -> 2.0.20\n"
        "packages/cortexa53-poky-linux/mosquitto/mosquitto: PKGSIZE: 400000 -> 420480\n"
        "+ htop (3.4.0)\n"
        "- dropbear (2024.85)\n"
    )
    res = parse_buildhistory_diff(raw_diff, from_build="#10", to_build="#11")
    assert res["rootfs_size_kb"] == 134500
    assert res["rootfs_delta_kb"] == 2500
    assert res["summary"]["added"] == 1
    assert res["summary"]["removed"] == 1
    assert res["summary"]["upgraded"] == 1
    mosq = next(e for e in res["entries"] if e["package"] == "mosquitto")
    assert mosq["old_version"] == "2.0.18"
    assert mosq["new_version"] == "2.0.20"
    assert mosq["size_delta_kb"] == 20
