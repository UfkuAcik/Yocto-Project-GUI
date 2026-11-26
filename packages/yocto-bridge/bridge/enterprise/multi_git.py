"""Multi-layer Git workspace manager across all meta-* Yocto layers."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

from bridge.i18n import tr_en

BRANCH_HEADER_RE = re.compile(
    r"^##\s+([^\s.]+)(?:\.\.\.([^\s]+))?(?:\s+\[(?:ahead (\d+))?(?:,\s*)?(?:behind (\d+))?\])?"
)


def parse_git_status_porcelain(
    layer_name: str,
    repo_path: str,
    porcelain_text: str,
    commit_sha: str = "HEAD",
    commit_message: str = "",
) -> dict[str, Any]:
    """Parse `git status --porcelain=v1 -b` output into a structured LayerGitStatus dict."""
    branch = "detached"
    upstream = ""
    ahead = 0
    behind = 0
    dirty_count = 0
    staged_count = 0
    untracked_count = 0
    changed_files: list[dict[str, str]] = []

    for line in porcelain_text.splitlines():
        if not line:
            continue
        if line.startswith("## "):
            m = BRANCH_HEADER_RE.match(line)
            if m:
                branch = m.group(1) or "HEAD"
                upstream = m.group(2) or ""
                ahead = int(m.group(3) or 0)
                behind = int(m.group(4) or 0)
            continue
        code = line[:2]
        fpath = line[3:] if len(line) > 3 else line.strip()
        changed_files.append({"status": code.strip() or "M", "path": fpath})
        if code == "??":
            untracked_count += 1
        else:
            if code[0] not in (" ", "?"):
                staged_count += 1
            if code[1] not in (" ", "?"):
                dirty_count += 1

    return {
        "layer_name": layer_name,
        "path": repo_path,
        "branch": branch,
        "commit_sha": commit_sha[:10],
        "commit_message": commit_message,
        "dirty_count": dirty_count,
        "staged_count": staged_count,
        "untracked_count": untracked_count,
        "ahead": ahead,
        "behind": behind,
        "upstream": upstream,
        "changed_files": changed_files,
    }


def _git_capture(repo_path: Path, args: list[str]) -> tuple[int, str, str]:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(repo_path),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def inspect_git_repo(layer_name: str, repo_path: Path) -> dict[str, Any]:
    """Inspect a single layer Git repository using safe subprocess list arguments."""
    _, porcelain, _ = _git_capture(repo_path, ["status", "--porcelain=v1", "-b"])
    _, sha, _ = _git_capture(repo_path, ["rev-parse", "--short=10", "HEAD"])
    _, msg, _ = _git_capture(repo_path, ["log", "-1", "--pretty=%s"])
    return parse_git_status_porcelain(
        layer_name=layer_name,
        repo_path=str(repo_path),
        porcelain_text=porcelain,
        commit_sha=sha or "0000000",
        commit_message=msg,
    )


def list_workspace_layer_repos(workspace_dir: Path) -> list[dict[str, Any]]:
    """Find all Git layer repositories (meta-*, openembedded-core, poky, bitbake) in workspace."""
    candidates: list[Path] = []
    if workspace_dir.exists():
        for root in [workspace_dir, workspace_dir / "layers"]:
            if not root.exists():
                continue
            for child in sorted(root.iterdir()):
                if child.is_dir() and (child / ".git").exists():
                    candidates.append(child)
    seen: set[Path] = set()
    results: list[dict[str, Any]] = []
    for repo in candidates:
        resolved = repo.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        results.append(inspect_git_repo(repo.name, repo))
    return results


def run_git_action(repo_path: Path, action: str, message: str | None = None) -> dict[str, Any]:
    """Execute a safe multi-layer Git action (fetch/diff/stash/stash_pop/commit)."""
    layer_name = repo_path.name
    if action == "fetch":
        rc, out, err = _git_capture(repo_path, ["fetch", "--all", "--prune"])
        return {
            "ok": rc == 0,
            "layer_name": layer_name,
            "action": "fetch",
            "output": out or err or tr_en("git fetch --all tamamlandı.", "git fetch --all completed."),
            "updated_status": inspect_git_repo(layer_name, repo_path),
        }
    if action == "diff":
        rc, out, err = _git_capture(repo_path, ["diff"])
        _, cached, _ = _git_capture(repo_path, ["diff", "--cached"])
        combined = "\n".join(x for x in (out, cached) if x)
        return {
            "ok": rc == 0,
            "layer_name": layer_name,
            "action": "diff",
            "output": (
                tr_en("Çalışma ağacı temiz (diff yok).", "Working tree clean (no diff).")
                if not combined
                else tr_en("Diff oluşturuldu.", "Diff generated.")
            ),
            "diff": combined,
            "updated_status": inspect_git_repo(layer_name, repo_path),
        }
    if action == "stash":
        rc, out, err = _git_capture(repo_path, ["stash", "push", "-u", "-m", "yocto-studio-stash"])
        return {
            "ok": rc == 0,
            "layer_name": layer_name,
            "action": "stash",
            "output": out or err or tr_en("Değişiklikler stash'e alındı.", "Changes stashed."),
            "updated_status": inspect_git_repo(layer_name, repo_path),
        }
    if action == "stash_pop":
        rc, out, err = _git_capture(repo_path, ["stash", "pop"])
        return {
            "ok": rc == 0,
            "layer_name": layer_name,
            "action": "stash_pop",
            "output": out or err or tr_en("Stash geri yüklendi.", "Stash popped."),
            "updated_status": inspect_git_repo(layer_name, repo_path),
        }
    if action == "commit":
        commit_msg = (message or "").strip() or "chore(layer): update via Yocto Studio"
        _git_capture(repo_path, ["add", "-A"])
        rc, out, err = _git_capture(repo_path, ["commit", "-m", commit_msg])
        return {
            "ok": rc == 0,
            "layer_name": layer_name,
            "action": "commit",
            "output": out or err,
            "updated_status": inspect_git_repo(layer_name, repo_path),
        }
    raise ValueError(f"Unsupported git action: {action}")
