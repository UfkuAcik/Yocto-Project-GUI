"""Lightweight pure-stdlib i18n context for `yocto-bridge` RPC responses."""

from __future__ import annotations

from contextvars import ContextVar

_CURRENT_LANG: ContextVar[str | None] = ContextVar("yocto_bridge_lang", default=None)
_default_lang: str = "tr"


def normalize_lang(lang: str | None) -> str:
    """Normalize a client language tag to `'en'` or `'tr'` (default `'tr'`)."""
    if isinstance(lang, str) and lang.strip().lower().startswith("en"):
        return "en"
    return "tr"


def set_lang(lang: str | None) -> str:
    """Set active language for the current RPC task and update fallback default."""
    global _default_lang
    normalized = normalize_lang(lang)
    _CURRENT_LANG.set(normalized)
    _default_lang = normalized
    return normalized


def get_lang() -> str:
    """Return active language (`'tr'` or `'en'`)."""
    val = _CURRENT_LANG.get()
    return val if val is not None else _default_lang


def is_en() -> bool:
    """Return True when English localization is active."""
    return get_lang() == "en"


def tr_en(tr_text: str, en_text: str) -> str:
    """Select Turkish or English text dynamically based on active RPC language."""
    return en_text if is_en() else tr_text
