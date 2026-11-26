"""Tests for 100,000+ log line ring buffer performance and BitBake XML-RPC event normalizer."""

from __future__ import annotations

import time

from bridge.event_monitor import normalize_bitbake_event
from bridge.tools.process_runner import LogRingBuffer


def test_100k_log_lines_ingestion_and_filtering_performance() -> None:
    buf = LogRingBuffer(max_lines=120_000)
    batch = [
        {
            "seq": i,
            "level": "ERROR" if i % 5000 == 0 else "NOTE",
            "message": f"Task {i} compiled object file_{i}.o",
        }
        for i in range(105_000)
    ]

    t0 = time.perf_counter()
    buf.append_many(batch)
    errors = buf.filter(level="ERROR", limit=500)
    elapsed = time.perf_counter() - t0

    assert len(buf) == 105_000
    assert len(errors) == 21
    assert elapsed < 2.0, f"100k+ log processing too slow: {elapsed:.2f}s"


def test_bitbake_xmlrpc_event_normalizer() -> None:
    started = normalize_bitbake_event(
        "bb.event.BuildStarted",
        {"target": "core-image-minimal", "machine": "qemuarm64", "total": 140},
        "b-1",
    )
    assert started is not None and started[0] == "build.started"
    assert started[1]["total_tasks"] == 140

    sstate = normalize_bitbake_event(
        "bb.runqueue.sceneQueueTaskCompleted",
        {"pn": "glibc", "taskname": "do_populate_sysroot_setscene", "completed": 1, "total": 140, "sstate_hits": 1},
        "b-1",
    )
    assert sstate is not None and sstate[0] == "build.task_succeeded"
    assert sstate[1]["from_sstate"] is True

    failed = normalize_bitbake_event(
        "bb.runqueue.runQueueTaskFailed",
        {"pn": "my-app", "taskname": "do_compile", "exitcode": 1, "msg": "gcc error"},
        "b-1",
    )
    assert failed is not None and failed[0] == "build.task_failed"
    assert failed[1]["exit_code"] == 1
