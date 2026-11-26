"""Tests for two-way Siemens kas YAML parser & serializer."""

from __future__ import annotations

from bridge.parsers.kas_yaml import parse_kas_yaml, serialize_kas_yaml

SAMPLE_KAS = """header:
  version: 14

machine: imx8mp-lpddr4-evk
distro: poky
target:
  - core-image-minimal
  - core-image-weston

repos:
  poky:
    url: https://git.yoctoproject.org/git/poky
    branch: wrynose
    layers:
      meta:
      meta-poky:
  meta-openembedded:
    url: https://github.com/openembedded/meta-openembedded.git
    branch: wrynose
    layers:
      meta-oe:
      meta-python:

local_conf_header:
  standard: |
    CONF_VERSION = "2"
    PACKAGE_CLASSES = "package_rpm"
"""


def test_kas_two_way_parse_and_serialize_roundtrip() -> None:
    cfg, warnings = parse_kas_yaml(SAMPLE_KAS)
    assert warnings == []
    assert cfg["header"]["version"] == 14
    assert cfg["machine"] == "imx8mp-lpddr4-evk"
    assert cfg["target"] == ["core-image-minimal", "core-image-weston"]
    assert "poky" in cfg["repos"]
    assert 'CONF_VERSION = "2"' in cfg["local_conf_header"]["standard"]

    yaml_out = serialize_kas_yaml(cfg)
    cfg2, warnings2 = parse_kas_yaml(yaml_out)
    assert warnings2 == []
    assert cfg2["machine"] == cfg["machine"]
    assert cfg2["target"] == cfg["target"]
    assert cfg2["repos"]["meta-openembedded"]["branch"] == "wrynose"
    assert 'PACKAGE_CLASSES = "package_rpm"' in cfg2["local_conf_header"]["standard"]
