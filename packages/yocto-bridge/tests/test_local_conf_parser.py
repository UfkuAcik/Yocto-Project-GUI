"""Tests for lossless comment- & multiline-preserving BitBake .conf parser."""

from __future__ import annotations

from bridge.parsers.local_conf import parse_conf

SAMPLE_CONF = """# Header comment must remain intact
# Second comment line
require conf/distro/include/yocto-uninative.inc

MACHINE ??= "imx8mp-lpddr4-evk" # inline machine note
DISTRO ?= "poky"

# Multiline variable with line continuations
IMAGE_INSTALL:append = " \\
    openssh-sftp-server \\
    htop \\
    my-sensor-daemon \\
"

BBLAYERS ?= " \\
  /home/yocto/layers/meta \\
  /home/yocto/layers/meta-oe \\
"
"""


def test_exact_roundtrip_preserves_every_byte() -> None:
    doc = parse_conf(SAMPLE_CONF)
    assert doc.render() == SAMPLE_CONF
    assert doc.comments_count == 3
    assert "require conf/distro/include/yocto-uninative.inc" in doc.directives
    assert "IMAGE_INSTALL:append" in doc.multiline_keys


def test_in_place_update_preserves_comments_inline_comments_and_operators() -> None:
    doc = parse_conf(SAMPLE_CONF)
    updated = doc.clone()
    updated.set_variable("MACHINE", "qemuarm64")
    updated.set_variable("PREFERRED_TOOLCHAIN_TARGET", "clang")

    rendered = updated.render()
    assert "# Header comment must remain intact" in rendered
    assert "# Multiline variable with line continuations" in rendered
    assert 'MACHINE ??= "qemuarm64" # inline machine note' in rendered
    assert 'PREFERRED_TOOLCHAIN_TARGET ?= "clang"' in rendered

    diff = doc.unified_diff(updated)
    assert '-MACHINE ??= "imx8mp-lpddr4-evk" # inline machine note' in diff
    assert '+MACHINE ??= "qemuarm64" # inline machine note' in diff


def test_bblayers_add_and_remove_preserves_comments() -> None:
    doc = parse_conf(SAMPLE_CONF)
    assert doc.get_bblayers() == [
        "/home/yocto/layers/meta",
        "/home/yocto/layers/meta-oe",
    ]
    assert doc.add_bblayer("/home/yocto/layers/meta-clang") is True
    assert doc.add_bblayer("/home/yocto/layers/meta-clang") is False
    assert "/home/yocto/layers/meta-clang" in doc.get_bblayers()
    assert doc.remove_bblayer("/home/yocto/layers/meta-oe") is True
    assert doc.get_bblayers() == [
        "/home/yocto/layers/meta",
        "/home/yocto/layers/meta-clang",
    ]
    assert "# Header comment must remain intact" in doc.render()
