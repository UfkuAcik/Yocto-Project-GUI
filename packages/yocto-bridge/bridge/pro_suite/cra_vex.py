"""EU Cyber Resilience Act (CRA) OpenVEX v0.2.0 triage & `.zip` compliance bundle exporter."""

from __future__ import annotations

import hashlib
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VEX_STATUS_VALUES = {
    "not_affected",
    "fixed",
    "affected",
    "under_investigation",
}

VEX_JUSTIFICATIONS = {
    "component_not_present",
    "vulnerable_code_not_present",
    "vulnerable_code_not_in_execute_path",
    "vulnerable_code_cannot_be_controlled_by_adversary",
    "inline_mitigations_already_exist",
}


def build_openvex_document(
    entries: list[dict[str, Any]],
    product_purl: str,
    author: str = "Yocto Studio Engineering",
) -> dict[str, Any]:
    """Serialize triage entries into a standard OpenVEX v0.2.0 JSON document."""
    now = datetime.now(timezone.utc).isoformat()
    statements: list[dict[str, Any]] = []
    for entry in entries:
        status = str(entry.get("status") or "under_investigation")
        if status not in VEX_STATUS_VALUES:
            status = "under_investigation"
        stmt: dict[str, Any] = {
            "vulnerability": {"name": str(entry.get("cve_id") or "")},
            "products": [
                {
                    "@id": product_purl,
                    "subcomponents": [
                        {
                            "@id": (
                                f"pkg:yocto/{entry.get('package', 'unknown')}"
                                f"@{entry.get('version', '1.0')}"
                            )
                        }
                    ],
                }
            ],
            "status": status,
            "timestamp": str(entry.get("updated_at") or now),
        }
        justification = str(entry.get("justification") or "").strip()
        if status == "not_affected" and justification:
            stmt["justification"] = justification
        impact = str(entry.get("impact_statement") or "").strip()
        if impact:
            stmt["impact_statement"] = impact
        statements.append(stmt)

    return {
        "@context": "https://openvex.dev/ns/v0.2.0",
        "@id": f"urn:uuid:yocto-studio-vex-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
        "author": author,
        "timestamp": now,
        "version": 1,
        "statements": statements,
    }


def export_cra_compliance_bundle(
    output_dir: Path,
    bundle_name: str,
    sbom_doc: dict[str, Any],
    vex_doc: dict[str, Any],
    license_csv: str,
) -> dict[str, Any]:
    """Create a CRA audit-ready `.zip` bundle with SBOM, OpenVEX, licenses, and SHA256SUMS."""
    output_dir.mkdir(parents=True, exist_ok=True)
    safe_name = bundle_name if bundle_name.endswith(".zip") else f"{bundle_name}.zip"
    zip_path = output_dir / safe_name

    sbom_bytes = json.dumps(sbom_doc, indent=2, ensure_ascii=False).encode("utf-8")
    vex_bytes = json.dumps(vex_doc, indent=2, ensure_ascii=False).encode("utf-8")
    lic_bytes = license_csv.encode("utf-8")

    artifacts = [
        ("sbom.spdx.json", sbom_bytes),
        ("openvex.json", vex_bytes),
        ("licenses.csv", lic_bytes),
    ]
    sums_lines = [
        f"{hashlib.sha256(content).hexdigest()}  {fname}"
        for fname, content in artifacts
    ]
    sums_bytes = ("\n".join(sums_lines) + "\n").encode("utf-8")

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for fname, content in artifacts:
            zf.writestr(fname, content)
        zf.writestr("SHA256SUMS.txt", sums_bytes)

    return {
        "ok": True,
        "bundle_path": str(zip_path),
        "size_bytes": zip_path.stat().st_size,
        "files": ["sbom.spdx.json", "openvex.json", "licenses.csv", "SHA256SUMS.txt"],
        "sha256_bundle": hashlib.sha256(zip_path.read_bytes()).hexdigest(),
    }
