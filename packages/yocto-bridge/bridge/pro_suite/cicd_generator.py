"""CI/CD pipeline generator (GitLab CI & GitHub Actions) for Yocto / kas / CROPS."""

from __future__ import annotations

from typing import Any


def generate_cicd_pipeline(
    platform: str,
    setup_tool: str = "kas",
    machine: str = "imx8mp-lpddr4-evk",
    target: str = "core-image-minimal",
    kas_file: str = "kas-project.yml",
    enable_preflight_gate: bool = True,
    enable_cve_gate: bool = True,
    sstate_cache_dir: str = "/cache/yocto/sstate-cache",
    dl_dir: str = "/cache/yocto/downloads",
) -> dict[str, Any]:
    """Generate a ready-to-commit `.gitlab-ci.yml` or `.github/workflows/yocto-ci.yml`."""
    plat = platform.strip().lower()
    if setup_tool == "kas":
        build_cmd = f"kas build {kas_file} --target {target}"
        preflight_cmd = f"kas shell {kas_file} -c 'bitbake -p && bitbake-layers show-layers'"
        cve_cmd = f"kas shell {kas_file} -c 'bitbake {target} -c cve_check'"
    else:
        build_cmd = (
            f"source oe-init-build-env build && "
            f"MACHINE={machine} bitbake {target}"
        )
        preflight_cmd = "source oe-init-build-env build && bitbake -p && bitbake-layers show-layers"
        cve_cmd = f"source oe-init-build-env build && bitbake {target} -c cve_check"

    if plat == "gitlab":
        filename = ".gitlab-ci.yml"
        lines = [
            "stages:",
            "  - preflight" if enable_preflight_gate else "  - build",
            *(["  - build"] if enable_preflight_gate else []),
            *(["  - security"] if enable_cve_gate else []),
            "  - publish",
            "",
            "variables:",
            f'  MACHINE: "{machine}"',
            f'  TARGET_IMAGE: "{target}"',
            f'  SSTATE_DIR: "{sstate_cache_dir}"',
            f'  DL_DIR: "{dl_dir}"',
            "",
            "default:",
            "  image: ghcr.io/siemens/kas/kas:latest",
            "",
        ]
        if enable_preflight_gate:
            lines.extend(
                [
                    "yocto_preflight:",
                    "  stage: preflight",
                    "  script:",
                    f"    - {preflight_cmd}",
                    "",
                ]
            )
        lines.extend(
            [
                "yocto_build:",
                "  stage: build",
                "  script:",
                f"    - {build_cmd}",
                "  artifacts:",
                "    paths:",
                "      - build/tmp/deploy/images/",
                "    expire_in: 7 days",
                "",
            ]
        )
        if enable_cve_gate:
            lines.extend(
                [
                    "yocto_sbom_cve_gate:",
                    "  stage: security",
                    "  script:",
                    f"    - {cve_cmd}",
                    "",
                ]
            )
        lines.extend(
            [
                "publish_release:",
                "  stage: publish",
                "  script:",
                "    - ls -lh build/tmp/deploy/images/",
            ]
        )
        return {"platform": "gitlab", "filename": filename, "yaml_content": "\n".join(lines) + "\n"}

    filename = ".github/workflows/yocto-ci.yml"
    lines = [
        "name: Yocto Studio CI Pipeline",
        "",
        "on:",
        "  push:",
        "    branches: [ main ]",
        "  pull_request:",
        "",
        "jobs:",
        "  build-yocto:",
        "    runs-on: ubuntu-latest",
        "    container:",
        "      image: ghcr.io/siemens/kas/kas:latest",
        "    env:",
        f"      MACHINE: {machine}",
        f"      SSTATE_DIR: {sstate_cache_dir}",
        f"      DL_DIR: {dl_dir}",
        "    steps:",
        "      - uses: actions/checkout@v4",
    ]
    if enable_preflight_gate:
        lines.extend(
            [
                "      - name: Pre-Flight Compatibility & Parse Gate",
                f"        run: {preflight_cmd}",
            ]
        )
    lines.extend(
        [
            f"      - name: Build {target}",
            f"        run: {build_cmd}",
        ]
    )
    if enable_cve_gate:
        lines.extend(
            [
                "      - name: SBOM & CVE Security Gate",
                f"        run: {cve_cmd}",
            ]
        )
    lines.extend(
        [
            "      - name: Upload Image & SPDX Artifacts",
            "        uses: actions/upload-artifact@v4",
            "        with:",
            f"          name: {machine}-{target}",
            "          path: build/tmp/deploy/images/",
        ]
    )
    return {"platform": "github", "filename": filename, "yaml_content": "\n".join(lines) + "\n"}
