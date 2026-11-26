"""Pure-stdlib parsers for SPDX 3.0 JSON-LD / SPDX 2.3 SBOMs and CVE reports."""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path
from typing import Any


def _load_json_input(data: dict[str, Any] | str | Path) -> dict[str, Any]:
    if isinstance(data, dict):
        return data
    if isinstance(data, Path):
        return json.loads(data.read_text(encoding="utf-8", errors="replace"))
    stripped = data.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        parsed = json.loads(stripped)
        return parsed if isinstance(parsed, dict) else {"@graph": parsed}
    return json.loads(Path(data).read_text(encoding="utf-8", errors="replace"))


def _cvss_to_severity(score: float) -> str:
    if score >= 9.0:
        return "CRITICAL"
    if score >= 7.0:
        return "HIGH"
    if score >= 4.0:
        return "MEDIUM"
    if score > 0.0:
        return "LOW"
    return "UNKNOWN"


def _normalize_status(raw: str) -> str:
    low = raw.strip().lower()
    if low in {"patched", "fixed", "resolved"}:
        return "Patched"
    if low in {"ignored", "not-affected", "not_affected", "false-positive"}:
        return "Ignored"
    return "Unpatched"


def parse_spdx3_jsonld(data: dict[str, Any] | str | Path) -> list[dict[str, Any]]:
    """Parse SPDX 3.0 JSON-LD (`@graph`) or SPDX 2.3 JSON SBOM into unified package records."""
    doc = _load_json_input(data)
    packages: list[dict[str, Any]] = []

    graph = doc.get("@graph")
    if isinstance(graph, list):
        licenses_by_id: dict[str, str] = {}
        license_edges: dict[str, list[str]] = {}

        for node in graph:
            if not isinstance(node, dict):
                continue
            ntype = str(node.get("type") or node.get("@type") or "")
            spdx_id = str(node.get("spdxId") or node.get("@id") or "")
            if "LicenseExpression" in ntype or "AnyLicenseInfo" in ntype:
                expr = (
                    node.get("simplelicensing_licenseExpression")
                    or node.get("licenseExpression")
                    or node.get("name")
                )
                if spdx_id and expr:
                    licenses_by_id[spdx_id] = str(expr)
            elif "Relationship" in ntype:
                rel_type = str(node.get("relationshipType") or "")
                from_id = str(node.get("from") or "")
                to_ids = node.get("to") or []
                if isinstance(to_ids, str):
                    to_ids = [to_ids]
                if rel_type in {"hasConcludedLicense", "hasDeclaredLicense"} and from_id:
                    license_edges.setdefault(from_id, []).extend(str(t) for t in to_ids)

        for node in graph:
            if not isinstance(node, dict):
                continue
            ntype = str(node.get("type") or node.get("@type") or "")
            if ntype not in {"software_Package", "Package", "software:Package"}:
                continue

            spdx_id = str(node.get("spdxId") or node.get("@id") or "")
            name = str(node.get("name") or "")
            if not name:
                continue

            version = str(
                node.get("software_packageVersion")
                or node.get("packageVersion")
                or node.get("versionInfo")
                or "unknown"
            )

            # Resolve licenses via direct properties or Relationship edges.
            lic = (
                node.get("software_concludedLicense")
                or node.get("software_declaredLicense")
                or node.get("licenseConcluded")
                or ""
            )
            if not lic and spdx_id in license_edges:
                resolved = [licenses_by_id.get(target, target.split("/")[-1]) for target in license_edges[spdx_id]]
                lic = " & ".join(dict.fromkeys(resolved))
            if not lic:
                lic = "NOASSERTION"

            purl = node.get("software_packageUrl") or node.get("packageUrl")
            cpe = None
            for ext in node.get("externalIdentifier") or []:
                if isinstance(ext, dict):
                    ext_type = str(ext.get("externalIdentifierType") or "").lower()
                    if ext_type in {"cpe22", "cpe23"}:
                        cpe = str(ext.get("identifier") or "")
                    elif ext_type == "purl" and not purl:
                        purl = str(ext.get("identifier") or "")

            sha256 = None
            for v in node.get("verifiedUsing") or []:
                if isinstance(v, dict) and str(v.get("algorithm") or "").lower() == "sha256":
                    sha256 = str(v.get("hashValue") or "")

            packages.append(
                {
                    "name": name,
                    "version": version,
                    "license": str(lic),
                    "spdx_id": spdx_id,
                    "purl": str(purl) if purl else None,
                    "cpe": cpe,
                    "sha256": sha256,
                }
            )
        return packages

    # Fallback for SPDX 2.3 JSON structure
    for pkg in doc.get("packages") or []:
        if not isinstance(pkg, dict):
            continue
        purl = None
        cpe = None
        for ref in pkg.get("externalRefs") or []:
            if not isinstance(ref, dict):
                continue
            rtype = str(ref.get("referenceType") or "").lower()
            if rtype == "purl":
                purl = str(ref.get("referenceLocator") or "")
            elif "cpe" in rtype:
                cpe = str(ref.get("referenceLocator") or "")

        sha256 = None
        for chk in pkg.get("checksums") or []:
            if isinstance(chk, dict) and str(chk.get("algorithm") or "").upper() == "SHA256":
                sha256 = str(chk.get("checksumValue") or "")

        packages.append(
            {
                "name": str(pkg.get("name") or "unknown"),
                "version": str(pkg.get("versionInfo") or "unknown"),
                "license": str(pkg.get("licenseConcluded") or pkg.get("licenseDeclared") or "NOASSERTION"),
                "spdx_id": str(pkg.get("SPDXID") or ""),
                "purl": purl,
                "cpe": cpe,
                "sha256": sha256,
            }
        )
    return packages


def parse_cve_report(data: dict[str, Any] | str | Path) -> dict[str, Any]:
    """Parse Yocto 6.0 `sbom-cve-check` or Scarthgap `cve-check` JSON reports."""
    doc = _load_json_input(data)
    findings: list[dict[str, Any]] = []
    tool = str(doc.get("tool") or "")

    # Format A: Yocto 6.0 `sbom-cve-check` JSON (vulnerabilities / findings)
    raw_findings = doc.get("findings") or doc.get("vulnerabilities")
    if isinstance(raw_findings, list):
        if not tool:
            tool = "sbom-cve-check (Yocto 6.0 Wrynose)"
        for item in raw_findings:
            if not isinstance(item, dict):
                continue
            try:
                cvss = float(item.get("cvss") or item.get("scorev3") or item.get("score") or 0.0)
            except (TypeError, ValueError):
                cvss = 0.0
            severity = str(item.get("severity") or _cvss_to_severity(cvss)).upper()
            findings.append(
                {
                    "cve_id": str(item.get("cve_id") or item.get("id") or "CVE-UNKNOWN"),
                    "package": str(item.get("package") or item.get("component") or "unknown"),
                    "version": str(item.get("version") or "unknown"),
                    "severity": severity,
                    "cvss": round(cvss, 1),
                    "status": _normalize_status(str(item.get("status") or "Unpatched")),
                    "summary": str(item.get("summary") or item.get("description") or ""),
                    "vector": str(item.get("vector") or ""),
                }
            )
    # Format B: Yocto 5.0 Scarthgap `cve-check` JSON (`package: [{ name, version, issue: [...] }]`)
    elif isinstance(doc.get("package"), list):
        if not tool:
            tool = "cve-check JSON (Yocto 5.0 Scarthgap)"
        for pkg in doc.get("package") or []:
            if not isinstance(pkg, dict):
                continue
            pkg_name = str(pkg.get("name") or "unknown")
            pkg_ver = str(pkg.get("version") or "unknown")
            for issue in pkg.get("issue") or []:
                if not isinstance(issue, dict):
                    continue
                raw_score = issue.get("scorev3") or issue.get("scorev2") or 0.0
                try:
                    cvss = float(raw_score)
                except (TypeError, ValueError):
                    cvss = 0.0
                severity = _cvss_to_severity(cvss)
                findings.append(
                    {
                        "cve_id": str(issue.get("id") or "CVE-UNKNOWN"),
                        "package": pkg_name,
                        "version": pkg_ver,
                        "severity": severity,
                        "cvss": round(cvss, 1),
                        "status": _normalize_status(str(issue.get("status") or "Unpatched")),
                        "summary": str(issue.get("summary") or ""),
                        "vector": str(issue.get("vector") or ""),
                    }
                )
    else:
        tool = tool or "sbom-cve-check"

    severity_rank = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "UNKNOWN": 4}
    findings.sort(key=lambda f: (severity_rank.get(f["severity"], 9), -float(f["cvss"]), f["cve_id"]))

    summary = {
        "total": len(findings),
        "unpatched": sum(1 for f in findings if f["status"] == "Unpatched"),
        "patched": sum(1 for f in findings if f["status"] == "Patched"),
        "ignored": sum(1 for f in findings if f["status"] == "Ignored"),
        "critical": sum(1 for f in findings if f["severity"] == "CRITICAL"),
        "high": sum(1 for f in findings if f["severity"] == "HIGH"),
        "medium": sum(1 for f in findings if f["severity"] == "MEDIUM"),
        "low": sum(1 for f in findings if f["severity"] == "LOW"),
    }
    return {"tool": tool, "summary": summary, "findings": findings}


def export_license_matrix(packages: list[dict[str, Any]], fmt: str = "csv") -> str:
    """Export SBOM package licenses into CSV, JSON, or Markdown matrix text."""
    normalized_fmt = fmt.strip().lower()
    if normalized_fmt == "json":
        return json.dumps(packages, indent=2, ensure_ascii=False)

    if normalized_fmt == "markdown":
        lines = [
            "| Package | Version | License | SPDX ID | PURL |",
            "| --- | --- | --- | --- | --- |",
        ]
        for pkg in packages:
            lines.append(
                f"| {pkg.get('name', '')} | {pkg.get('version', '')} | {pkg.get('license', '')} "
                f"| {pkg.get('spdx_id', '')} | {pkg.get('purl') or '-'} |"
            )
        return "\n".join(lines) + "\n"

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(["package", "version", "license", "spdx_id", "purl", "sha256"])
    for pkg in packages:
        writer.writerow(
            [
                pkg.get("name", ""),
                pkg.get("version", ""),
                pkg.get("license", ""),
                pkg.get("spdx_id", ""),
                pkg.get("purl") or "",
                pkg.get("sha256") or "",
            ]
        )
    return buf.getvalue()
