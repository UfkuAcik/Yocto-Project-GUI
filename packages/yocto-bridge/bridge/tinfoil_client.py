"""BitBake tinfoil API abstraction with live bb.tinfoil + bitbake -e fallback adapter."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Protocol

from bridge.i18n import tr_en
from bridge.parsers.varhistory import parse_bitbake_env_variable


class TinfoilClient(Protocol):
    def inspect_variable(self, name: str) -> dict[str, Any]: ...
    def list_recipes(self, query: str = "") -> list[dict[str, Any]]: ...


class LiveTinfoilUnavailableError(RuntimeError):
    """Raised when bb.tinfoil is requested outside an initialized BitBake environment."""


def import_live_tinfoil() -> Any:
    try:
        import bb.tinfoil  # type: ignore[import-not-found]

        return bb.tinfoil
    except ImportError as exc:
        raise LiveTinfoilUnavailableError(
            tr_en(
                "BitBake 'bb.tinfoil' modülü aktif Python ortamında bulunamadı; "
                "lütfen önce oe-init-build-env veya bitbake-setup ortamını kaynaklayın.",
                "BitBake 'bb.tinfoil' module was not found in the active Python environment; "
                "please source oe-init-build-env or bitbake-setup first.",
            )
        ) from exc


class LiveTinfoilAdapter:
    """Queries live BitBake variable history via bb.tinfoil or `bitbake -e` fallback."""

    def __init__(self, build_dir: str | Path) -> None:
        self.build_dir = Path(build_dir)

    def _inspect_via_tinfoil_sync(self, name: str) -> dict[str, Any]:
        tinfoil_mod = import_live_tinfoil()
        with tinfoil_mod.Tinfoil() as tf:
            tf.prepare(config_only=True)
            data = tf.config_data
            final_val = str(data.getVar(name, True) or "<unset>")
            unexpanded_val = str(data.getVar(name, False) or final_val)
            doc = str(data.getVarFlag(name, "doc") or f"BitBake variable '{name}'")
            raw_hist = data.varhistory.variable(name) or []
            history: list[dict[str, Any]] = []
            for entry in raw_hist:
                history.append(
                    {
                        "file": str(entry.get("file", "")),
                        "line": int(entry.get("line", 0)),
                        "operator": str(entry.get("op", "=")),
                        "value": str(entry.get("detail", "")),
                        "overridden": False,
                    }
                )
            return {
                "name": name,
                "final_value": final_val,
                "unexpanded_value": unexpanded_val,
                "doc": doc,
                "history": history,
            }

    async def inspect_variable(self, name: str, recipe: str | None = None) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(self._inspect_via_tinfoil_sync, name)
        except LiveTinfoilUnavailableError:
            cmd = ["bitbake", "-e"]
            if recipe:
                cmd.append(recipe)
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(self.build_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, stderr_b = await proc.communicate()
            if proc.returncode != 0:
                err_msg = stderr_b.decode("utf-8", errors="replace").strip()
                raise LiveTinfoilUnavailableError(
                    err_msg or tr_en("bitbake -e çalıştırılamadı.", "Failed to execute bitbake -e.")
                ) from None
            return parse_bitbake_env_variable(stdout_b.decode("utf-8", errors="replace"), name)
