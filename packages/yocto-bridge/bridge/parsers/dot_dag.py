"""High-performance BitBake `task-depends.dot` & `pn-buildlist` parser and BFS reverse-dependency tracer."""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from typing import Any

# Matches: "recipe.do_task" [label="..."] or "recipe.do_task"
_NODE_RE = re.compile(r'^\s*"([^"]+)"\s*(?:\[.*?\])?\s*;?\s*$')
# Matches: "a.do_task" -> "b.do_task"
_EDGE_RE = re.compile(r'^\s*"([^"]+)"\s*->\s*"([^"]+)"')


def _split_node_id(raw_id: str) -> tuple[str, str]:
    if "." in raw_id:
        recipe, task = raw_id.rsplit(".", 1)
        return recipe, task
    if ":" in raw_id:
        recipe, task = raw_id.split(":", 1)
        return recipe, task
    return raw_id, "do_build"


def _infer_kind(recipe: str) -> str:
    r = recipe.lower()
    if "image" in r or r.startswith("packagegroup-"):
        return "image"
    if "linux" in r or "u-boot" in r or "kernel" in r:
        return "kernel"
    if "gcc" in r or "glibc" in r or "binutils" in r or "llvm" in r or r.endswith("-native"):
        return "toolchain"
    if "sensor" in r or "app" in r or "daemon" in r:
        return "app"
    return "runtime"


@dataclass
class ParsedDotGraph:
    nodes: dict[str, dict[str, Any]] = field(default_factory=dict)
    deps: dict[str, list[str]] = field(default_factory=dict)
    rdeps: dict[str, list[str]] = field(default_factory=dict)
    edge_count: int = 0

    def ensure_node(self, node_id: str) -> dict[str, Any]:
        norm_id = node_id.replace(".", ":", 1) if "." in node_id and ":" not in node_id else node_id
        if norm_id not in self.nodes:
            recipe, task = _split_node_id(node_id)
            self.nodes[norm_id] = {
                "id": norm_id,
                "recipe": recipe,
                "task": task,
                "layer": "openembedded-core",
                "kind": _infer_kind(recipe),
                "depends_on": [],
                "rdepends_count": 0,
            }
            self.deps[norm_id] = []
            self.rdeps[norm_id] = []
        return self.nodes[norm_id]


def parse_pn_buildlist(text: str) -> list[str]:
    """Parse BitBake `pn-buildlist` into a deduplicated ordered list of package names."""
    seen: set[str] = set()
    out: list[str] = []
    for line in text.splitlines():
        name = line.strip()
        if not name or name.startswith("#") or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def parse_task_depends_dot(dot_text: str) -> ParsedDotGraph:
    """Single-pass fast parser for BitBake `task-depends.dot` (handles 5,000+ nodes in <0.5s)."""
    graph = ParsedDotGraph()

    for line in dot_text.splitlines():
        if "->" in line:
            em = _EDGE_RE.match(line)
            if em:
                src_raw, dst_raw = em.groups()
                src = graph.ensure_node(src_raw)["id"]
                dst = graph.ensure_node(dst_raw)["id"]
                graph.deps[src].append(dst)
                graph.rdeps[dst].append(src)
                graph.nodes[src]["depends_on"].append(dst)
                graph.nodes[dst]["rdepends_count"] += 1
                graph.edge_count += 1
                continue

        nm = _NODE_RE.match(line)
        if nm:
            raw_id = nm.group(1)
            if raw_id not in ("digraph depends", "graph"):
                graph.ensure_node(raw_id)

    return graph


def explain_why_included(
    graph: ParsedDotGraph,
    target: str,
    package: str,
    max_chains: int = 5,
) -> dict[str, Any]:
    """Answer 'Bu paket imaja neden girdi?' by finding shortest dependency chains from target to package."""
    pkg_lower = package.strip().lower()
    target_lower = target.strip().lower()

    # Build recipe-level forward adjacency map from task graph
    recipe_deps: dict[str, set[str]] = {}
    recipe_rdeps: dict[str, set[str]] = {}
    all_recipes: set[str] = set()

    for nid, node in graph.nodes.items():
        rec = node["recipe"]
        all_recipes.add(rec)
        recipe_deps.setdefault(rec, set())
        recipe_rdeps.setdefault(rec, set())
        for dep_id in graph.deps.get(nid, []):
            dep_rec = graph.nodes[dep_id]["recipe"]
            if dep_rec != rec:
                recipe_deps[rec].add(dep_rec)
                recipe_rdeps.setdefault(dep_rec, set()).add(rec)

    matched_pkg = next((r for r in all_recipes if r.lower() == pkg_lower), None)
    if matched_pkg is None:
        return {
            "target": target,
            "package": package,
            "included": False,
            "chains": [],
            "direct_rdepends": [],
        }

    start_rec = next((r for r in all_recipes if r.lower() == target_lower), None)
    if start_rec is None:
        return {
            "target": target,
            "package": matched_pkg,
            "included": False,
            "chains": [],
            "direct_rdepends": sorted(recipe_rdeps.get(matched_pkg, set())),
        }

    if start_rec == matched_pkg:
        return {
            "target": start_rec,
            "package": matched_pkg,
            "included": True,
            "chains": [[start_rec]],
            "direct_rdepends": sorted(recipe_rdeps.get(matched_pkg, set())),
        }

    # BFS for shortest chains from start_rec -> matched_pkg
    chains: list[list[str]] = []
    queue: deque[list[str]] = deque([[start_rec]])
    visited_depth: dict[str, int] = {start_rec: 0}

    while queue and len(chains) < max_chains:
        path = queue.popleft()
        cur = path[-1]
        if len(path) > 12:
            continue
        for nxt in sorted(recipe_deps.get(cur, set())):
            if nxt in path:
                continue
            new_path = [*path, nxt]
            if nxt == matched_pkg:
                chains.append(new_path)
                if len(chains) >= max_chains:
                    break
            else:
                prev_depth = visited_depth.get(nxt)
                if prev_depth is None or len(new_path) <= prev_depth + 1:
                    visited_depth[nxt] = len(new_path)
                    queue.append(new_path)

    return {
        "target": start_rec,
        "package": matched_pkg,
        "included": len(chains) > 0,
        "chains": chains,
        "direct_rdepends": sorted(recipe_rdeps.get(matched_pkg, set())),
    }


def slice_graph_for_ui(
    graph: ParsedDotGraph,
    target: str,
    query: str = "",
    kind: str = "",
    focus_recipe: str = "",
    max_nodes: int = 120,
) -> dict[str, Any]:
    """Return a UI-friendly subgraph slice while preserving total node/edge counts."""
    q = query.strip().lower()
    k = kind.strip().lower()
    focus = focus_recipe.strip().lower()

    candidate_ids: list[str] = []
    for nid, node in graph.nodes.items():
        if q and q not in node["recipe"].lower() and q not in node["task"].lower():
            continue
        if k and node["kind"] != k:
            continue
        if focus and node["recipe"].lower() != focus:
            # Keep direct neighbors of focused recipe too
            neighbors = set(graph.deps.get(nid, [])) | set(graph.rdeps.get(nid, []))
            if not any(graph.nodes[nb]["recipe"].lower() == focus for nb in neighbors if nb in graph.nodes):
                continue
        candidate_ids.append(nid)

    truncated = len(candidate_ids) > max_nodes
    selected = set(candidate_ids[:max_nodes])
    nodes = [graph.nodes[nid] for nid in candidate_ids[:max_nodes]]
    edges: list[dict[str, str]] = []
    for src in selected:
        for dst in graph.deps.get(src, []):
            if dst in selected:
                edges.append({"id": f"{src}->{dst}", "source": src, "target": dst})

    return {
        "target": target,
        "total_nodes": len(graph.nodes),
        "total_edges": graph.edge_count,
        "truncated": truncated,
        "nodes": nodes,
        "edges": edges,
    }
