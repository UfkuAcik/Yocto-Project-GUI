"""BitBake recipe & .bbappend generators for recipetool (CMake, Meson, Autotools, Cargo, Python, Go)."""

from __future__ import annotations

from typing import Any


def generate_recipe_content(
    name: str,
    version: str = "1.0.0",
    src_uri: str = "git://github.com/example/app.git;protocol=https;branch=main",
    build_system: str = "cmake",
    license_name: str = "MIT",
    summary: str = "",
) -> str:
    """Generate an authentic Yocto 6.0/5.0 compatible `.bb` recipe for the chosen build system."""
    desc = summary.strip() or f"{name} ({build_system}) application recipe"
    bs = build_system.lower().strip()

    inherit_map = {
        "cmake": "cmake pkgconfig",
        "meson": "meson pkgconfig",
        "autotools": "autotools pkgconfig",
        "cargo": "cargo cargo-update-recipe-crates",
        "python": "python_setuptools_build_meta",
        "go": "go-mod",
    }
    depends_map = {
        "cmake": 'DEPENDS = "openssl"',
        "meson": 'DEPENDS = "glib-2.0"',
        "autotools": 'DEPENDS = "zlib"',
        "cargo": "# Cargo dependencies managed via ${BPN}-crates.inc",
        "python": 'RDEPENDS:${PN} += "python3-core"',
        "go": 'GO_IMPORT = "github.com/example/' + name + '"',
    }
    inherit_line = inherit_map.get(bs, "cmake")
    extra_line = depends_map.get(bs, "")

    lines = [
        f'SUMMARY = "{desc}"',
        f'LICENSE = "{license_name}"',
        'LIC_FILES_CHKSUM = "file://LICENSE;md5=0835ade698e0bcf8506ecda2f7b4f302"',
        "",
        f'PV = "{version}"',
        f'SRC_URI = "{src_uri}"',
        'SRCREV = "${AUTOREV}"',
        "",
        'S = "${WORKDIR}/git"',
        "",
        f"inherit {inherit_line}",
    ]
    if extra_line:
        lines.append("")
        lines.append(extra_line)
    if bs == "cmake":
        lines.append('EXTRA_OECMAKE = "-DBUILD_TESTING=OFF"')
    elif bs == "meson":
        lines.append('EXTRA_OEMESON = "-Dtests=false"')

    return "\n".join(lines) + "\n"


def generate_bbappend_content(pn: str, template: str = "files") -> str:
    """Generate a clean `.bbappend` skeleton."""
    if template == "systemd":
        return (
            'FILESEXTRAPATHS:prepend := "${THISDIR}/${PN}:"\n\n'
            'SRC_URI += "file://override.service"\n\n'
            "do_install:append() {\n"
            "    install -d ${D}${systemd_system_unitdir}\n"
            "    install -m 0644 ${WORKDIR}/override.service ${D}${systemd_system_unitdir}/\n"
            "}\n"
        )
    return (
        f"# Custom .bbappend for {pn}\n"
        'FILESEXTRAPATHS:prepend := "${THISDIR}/${PN}:"\n\n'
        'SRC_URI += "file://0001-custom-configuration.patch"\n'
    )


def recipe_summary_dict(
    pn: str,
    pv: str,
    layer: str,
    file_path: str,
    summary: str,
    license_name: str,
    has_bbappend: bool = False,
) -> dict[str, Any]:
    return {
        "pn": pn,
        "pv": pv,
        "layer": layer,
        "file_path": file_path,
        "summary": summary,
        "license": license_name,
        "has_bbappend": has_bbappend,
    }
