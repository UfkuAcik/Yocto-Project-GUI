"""Integration & offline-fallback tests for OpenEmbedded Layer Index REST API client."""

from __future__ import annotations

import pytest

from bridge.tools.layer_index import LayerIndexClient


@pytest.mark.asyncio
async def test_live_layer_index_api_wrynose_clang() -> None:
    client = LayerIndexClient(timeout_sec=8.0)
    branches, br_source = await client.get_branches()
    assert br_source in ("live", "cache")
    assert "wrynose" in branches

    results, src = await client.search(query="meta-clang", branch="wrynose", kind="layer", limit=10)
    assert src in ("live", "cache")
    assert any(r["name"] == "meta-clang" for r in results)


@pytest.mark.asyncio
async def test_layer_index_offline_graceful_fallback() -> None:
    client = LayerIndexClient(base_url="http://127.0.0.1:1/unreachable/", timeout_sec=0.2)
    branches, br_source = await client.get_branches()
    assert br_source == "mock"
    assert "wrynose" in branches

    results, src = await client.search(query="clang", branch="wrynose", kind="layer")
    assert src == "mock"
    assert results == []
