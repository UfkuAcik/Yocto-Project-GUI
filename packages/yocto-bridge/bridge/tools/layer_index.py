"""Live OpenEmbedded Layer Index REST API client with TTL cache and offline fallback."""

from __future__ import annotations

import asyncio
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_API_BASE = "https://layers.openembedded.org/layerindex/api/"

_LAYER_TYPE_MAP = {
    "B": "bsp",
    "S": "software",
    "D": "distro",
    "A": "software",
    "M": "software",
}


class LayerIndexClient:
    """Async wrapper around https://layers.openembedded.org/layerindex/api/."""

    def __init__(
        self,
        base_url: str = DEFAULT_API_BASE,
        ttl_sec: float = 600.0,
        timeout_sec: float = 8.0,
    ) -> None:
        self._base_url = base_url.rstrip("/") + "/"
        self._ttl_sec = ttl_sec
        self._timeout_sec = timeout_sec
        self._cache: dict[str, tuple[float, Any]] = {}

    def _fetch_json_sync(self, endpoint: str) -> Any:
        now = time.time()
        cached = self._cache.get(endpoint)
        if cached and (now - cached[0]) < self._ttl_sec:
            return cached[1], True

        url = self._base_url + endpoint.lstrip("/")
        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=self._timeout_sec) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        self._cache[endpoint] = (now, data)
        return data, False

    async def _fetch_json(self, endpoint: str) -> tuple[Any, bool]:
        return await asyncio.to_thread(self._fetch_json_sync, endpoint)

    async def get_branches(self) -> tuple[list[str], str]:
        try:
            data, from_cache = await self._fetch_json("branches/?format=json")
            names = [str(b["name"]) for b in data if b.get("name")]
            return names, "cache" if from_cache else "live"
        except (OSError, urllib.error.URLError, ValueError, KeyError):
            return ["wrynose", "scarthgap", "blacksail", "master"], "mock"

    async def search(
        self,
        query: str = "",
        branch: str = "wrynose",
        kind: str = "layer",
        limit: int = 25,
    ) -> tuple[list[dict[str, Any]], str]:
        q = query.strip()
        try:
            if kind == "machine":
                ep = "machines/?format=json"
                if q:
                    ep += "&filter=" + urllib.parse.quote(f"name__icontains:{q}")
                rows, cached = await self._fetch_json(ep)
                results = [
                    {
                        "name": str(r.get("name", "")),
                        "summary": str(r.get("description", "")).strip() or "OE BSP Machine",
                        "vcs_url": "https://layers.openembedded.org/layerindex/",
                        "branch": branch,
                        "compat": [branch],
                        "layer_type": "bsp",
                        "installed": False,
                        "kind": "machine",
                    }
                    for r in rows[:limit]
                ]
                return results, "cache" if cached else "live"

            if kind == "recipe":
                ep = "recipes/?format=json"
                if q:
                    ep += "&filter=" + urllib.parse.quote(f"pn__icontains:{q}")
                rows, cached = await self._fetch_json(ep)
                results = [
                    {
                        "name": f"{r.get('pn', '')} ({r.get('pv', '')})".strip(),
                        "summary": str(r.get("summary") or r.get("description") or "OE Recipe").strip(),
                        "vcs_url": str(r.get("homepage") or "https://layers.openembedded.org/layerindex/"),
                        "branch": branch,
                        "compat": [branch],
                        "layer_type": "software",
                        "installed": False,
                        "kind": "recipe",
                    }
                    for r in rows[:limit]
                ]
                return results, "cache" if cached else "live"

            if kind == "distro":
                ep = "distros/?format=json"
                if q:
                    ep += "&filter=" + urllib.parse.quote(f"name__icontains:{q}")
                rows, cached = await self._fetch_json(ep)
                results = [
                    {
                        "name": str(r.get("name", "")),
                        "summary": str(r.get("description", "")).strip() or "OE Distro",
                        "vcs_url": "https://layers.openembedded.org/layerindex/",
                        "branch": branch,
                        "compat": [branch],
                        "layer_type": "distro",
                        "installed": False,
                        "kind": "distro",
                    }
                    for r in rows[:limit]
                ]
                return results, "cache" if cached else "live"

            # Default: layers joined with branch availability
            items_ep = "layerItems/?format=json"
            if q:
                items_ep += "&filter=" + urllib.parse.quote(f"name__icontains:{q}")
            items, c1 = await self._fetch_json(items_ep)
            lb_ep = "layerBranches/?format=json&filter=" + urllib.parse.quote(
                f"branch__name:{branch}"
            )
            layer_branches, c2 = await self._fetch_json(lb_ep)
            lb_by_layer_id = {lb["layer"]: lb for lb in layer_branches if "layer" in lb}

            q_lower = q.lower()
            results = []
            for item in items:
                lid = item.get("id")
                lb = lb_by_layer_id.get(lid)
                if lb is None:
                    continue
                name = str(item.get("name", ""))
                summary = str(item.get("summary", ""))
                desc = str(item.get("description", ""))
                if q_lower and (
                    q_lower not in name.lower()
                    and q_lower not in summary.lower()
                    and q_lower not in desc.lower()
                ):
                    continue
                ltype = _LAYER_TYPE_MAP.get(str(item.get("layer_type", "S")), "software")
                results.append(
                    {
                        "name": name,
                        "summary": summary or desc,
                        "vcs_url": str(item.get("vcs_url", "")),
                        "branch": str(lb.get("actual_branch") or branch),
                        "compat": [branch],
                        "layer_type": ltype,
                        "installed": False,
                        "kind": "layer",
                        "vcs_subdir": str(lb.get("vcs_subdir") or ""),
                    }
                )
                if len(results) >= limit:
                    break

            src = "cache" if (c1 and c2) else "live"
            return results, src
        except (OSError, urllib.error.URLError, ValueError, KeyError):
            return [], "mock"
