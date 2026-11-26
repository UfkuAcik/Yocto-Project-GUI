"""Tests for BitBake task-depends.dot parser, 5k+ node performance, and reverse-dependency BFS."""

from __future__ import annotations

import time

from bridge.parsers.dot_dag import (
    explain_why_included,
    parse_pn_buildlist,
    parse_task_depends_dot,
    slice_graph_for_ui,
)


def test_parses_dot_and_explains_why_package_included() -> None:
    dot_src = """
    digraph depends {
      "core-image-minimal.do_build" -> "core-image-minimal.do_rootfs"
      "core-image-minimal.do_rootfs" -> "my-sensor-daemon.do_package_write_rpm"
      "my-sensor-daemon.do_package_write_rpm" -> "mosquitto.do_populate_sysroot"
      "mosquitto.do_populate_sysroot" -> "openssl.do_populate_sysroot"
      "openssl.do_populate_sysroot" -> "glibc.do_populate_sysroot"
    }
    """
    graph = parse_task_depends_dot(dot_src)
    assert len(graph.nodes) == 6
    assert graph.edge_count == 5

    why = explain_why_included(graph, "core-image-minimal", "openssl")
    assert why["included"] is True
    assert why["chains"][0] == [
        "core-image-minimal",
        "my-sensor-daemon",
        "mosquitto",
        "openssl",
    ]
    assert "mosquitto" in why["direct_rdepends"]

    pkgs = parse_pn_buildlist("core-image-minimal\nopenssl\nopenssl\nglibc\n")
    assert pkgs == ["core-image-minimal", "openssl", "glibc"]


def test_5000_plus_node_dot_performance_and_slicing() -> None:
    lines = ["digraph depends {"]
    for idx in range(5200):
        lines.append(f'"pkg-{idx}.do_compile" [label="pkg-{idx}\\ndo_compile"]')
        if idx > 0:
            lines.append(f'"pkg-{idx}.do_compile" -> "pkg-{idx - 1}.do_compile"')
        if idx > 3:
            lines.append(f'"pkg-{idx}.do_compile" -> "pkg-{idx // 2}.do_compile"')
        if idx > 7:
            lines.append(f'"pkg-{idx}.do_compile" -> "pkg-{idx // 4}.do_compile"')
    lines.append("}")
    big_dot = "\n".join(lines)

    t0 = time.perf_counter()
    graph = parse_task_depends_dot(big_dot)
    sliced = slice_graph_for_ui(graph, target="pkg-5199", max_nodes=100)
    elapsed = time.perf_counter() - t0

    assert len(graph.nodes) == 5200
    assert graph.edge_count > 15000
    assert sliced["total_nodes"] == 5200
    assert sliced["truncated"] is True
    assert len(sliced["nodes"]) == 100
    assert elapsed < 2.0, f"5k+ DAG parsing too slow: {elapsed:.2f}s"
