"""Tests for `bitbake -e` variable history parser."""

from __future__ import annotations

from bridge.parsers.varhistory import parse_bitbake_env_variable

SAMPLE_BITBAKE_E = """
# $IMAGE_INSTALL [3 operations]
#   set /home/yocto/meta/recipes-core/images/core-image-minimal.bb:3
#     "packagegroup-core-boot ${CORE_IMAGE_EXTRA_INSTALL}"
#   set? /home/yocto/meta/conf/bitbake.conf:412
#     ""
#   :append /home/yocto/build/conf/local.conf:25
#     " openssh-sftp-server htop"
# pre-expansion value:
#   "packagegroup-core-boot ${CORE_IMAGE_EXTRA_INSTALL} openssh-sftp-server htop"
IMAGE_INSTALL="packagegroup-core-boot run-postinsts openssh-sftp-server htop"
"""


def test_parses_bitbake_e_variable_history() -> None:
    res = parse_bitbake_env_variable(SAMPLE_BITBAKE_E, "IMAGE_INSTALL")
    assert res["name"] == "IMAGE_INSTALL"
    assert res["final_value"] == "packagegroup-core-boot run-postinsts openssh-sftp-server htop"
    assert "${CORE_IMAGE_EXTRA_INSTALL}" in res["unexpanded_value"]
    assert len(res["history"]) == 3
    assert res["history"][0]["operator"] == "="
    assert res["history"][0]["line"] == 3
    assert res["history"][2]["operator"] == ":append"
    assert res["history"][2]["file"] == "/home/yocto/build/conf/local.conf"
