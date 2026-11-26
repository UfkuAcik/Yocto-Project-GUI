"""i18n regression tests ensuring yocto-bridge returns clean English JSON when lang='en'."""

from __future__ import annotations

import json
import re

import pytest

from bridge.i18n import set_lang
from bridge.mock_mode import INITIAL_LOCAL_CONF
from bridge.server import YoctoBridgeApp

TURKISH_DIACRITICS_RE = re.compile(r"[ğĞşŞıİçÇöÖüÜ]")
_INITIAL_CONF_COMMENTS = {
    line.strip() for line in INITIAL_LOCAL_CONF.splitlines() if line.strip().startswith("#")
}


def _strip_initial_conf_comment_context(obj: object) -> object:
    """Ignore immutable mock local.conf comment context lines inside unified diff previews."""
    if isinstance(obj, dict):
        return {k: _strip_initial_conf_comment_context(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_strip_initial_conf_comment_context(v) for v in obj]
    if isinstance(obj, str):
        lines = []
        for line in obj.splitlines():
            stripped = line.lstrip(" +-")
            if stripped in _INITIAL_CONF_COMMENTS:
                continue
            lines.append(line)
        return "\n".join(lines)
    return obj


@pytest.mark.asyncio
async def test_bridge_returns_english_without_turkish_leakage() -> None:
    app = YoctoBridgeApp(mock=True)
    try:
        rpc_calls = [
            ("env.doctor", {"provider": "mock"}),
            ("env.validate_path", {"path": "/mnt/c/yocto", "provider": "wsl2"}),
            ("env.validate_path", {"path": "/home/yocto/proj", "provider": "wsl2"}),
            ("layers.list", {}),
            ("layers.check_compat", {}),
            ("config.list_fragments", {}),
            ("wic.list_wks", {}),
            ("preflight.runAudit", {"target": "core-image-minimal", "incompatible_licenses": ["GPL-3.0*"]}),
            ("preflight.getVersionMatrix", {"target": "core-image-minimal"}),
            ("preflight.checkUpgrades", {}),
            ("preflight.probeSstate", {}),
            ("preflight.getOptimizationPlan", {}),
            ("pro.qa.runHardwareSmoke", {"machine": "imx8mp-lpddr4-evk"}),
            ("pro.cra.listVex", {}),
            ("pro.secboot.generateConfig", {}),
            ("enterprise.multiconfig.list", {}),
            ("enterprise.sstate.getRunnerAnalytics", {"time_range": "7d"}),
            ("enterprise.sstate.getRunnerAnalytics", {"time_range": "30d"}),
            ("enterprise.migration.scan", {"from_lts": "scarthgap", "to_lts": "wrynose"}),
            ("enterprise.rootfs.diffSigs", {"recipe": "my-sensor-daemon", "task": "do_compile"}),
            ("enterprise.git.runAction", {"layer_name": "openembedded-core", "action": "fetch"}),
            ("enterprise.git.runAction", {"layer_name": "openembedded-core", "action": "diff"}),
        ]

        for idx, (method, params) in enumerate(rpc_calls, start=1):
            raw = await app.server._process_rpc_text(
                json.dumps({"jsonrpc": "2.0", "id": idx, "lang": "en", "method": method, "params": params})
            )
            assert raw is not None
            assert "error" not in raw, f"RPC error for {method}: {raw}"
            cleaned = _strip_initial_conf_comment_context(raw["result"])
            serialized = json.dumps(cleaned, ensure_ascii=False)
            match = TURKISH_DIACRITICS_RE.search(serialized)
            assert match is None, f"Turkish character leaked in {method} (lang=en): {serialized}"

        # Also verify Turkish mode still returns Turkish text cleanly
        tr_raw = await app.server._process_rpc_text(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 999,
                    "lang": "tr",
                    "method": "env.validate_path",
                    "params": {"path": "/home/yocto/proj", "provider": "wsl2"},
                }
            )
        )
        assert tr_raw is not None
        assert "Geçerli POSIX" in tr_raw["result"]["reason"]
    finally:
        set_lang("tr")
