#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BRIDGE_DIR = path.join(ROOT, "packages", "yocto-bridge");
const VENV_DIR = path.join(BRIDGE_DIR, ".venv");

const PYTHON_VERSION_RE = /Python 3\.(1[0-9]|[2-9]\d)\./;

function tryResolvePython() {
  const venvPython =
    process.platform === "win32"
      ? path.join(VENV_DIR, "Scripts", "python.exe")
      : path.join(VENV_DIR, "bin", "python");

  if (fs.existsSync(venvPython)) {
    return { cmd: venvPython, prefixArgs: [] };
  }

  const candidates =
    process.platform === "win32"
      ? [
          ["python", []],
          ["py", ["-3"]],
          ["python3", []],
        ]
      : [
          ["python3", []],
          ["python", []],
        ];

  for (const [cmd, prefixArgs] of candidates) {
    const res = spawnSync(cmd, [...prefixArgs, "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.status === 0 && PYTHON_VERSION_RE.test(output)) {
      return { cmd, prefixArgs };
    }
  }

  return null;
}

function requirePython() {
  const py = tryResolvePython();
  if (!py) {
    console.error(
      "[yocto-bridge] Python 3.10+ is required, but neither packages/yocto-bridge/.venv nor a system Python 3.10+ executable was found."
    );
    process.exit(1);
  }
  return py;
}

function resolveVenvTool(toolName) {
  const venvTool =
    process.platform === "win32"
      ? path.join(VENV_DIR, "Scripts", `${toolName}.exe`)
      : path.join(VENV_DIR, "bin", toolName);

  if (fs.existsSync(venvTool)) {
    return { cmd: venvTool, prefixArgs: [] };
  }

  const py = tryResolvePython();
  if (py) {
    const probe = spawnSync(py.cmd, [...py.prefixArgs, "-m", toolName, "--version"], {
      stdio: "ignore",
    });
    if (probe.status === 0) {
      return { cmd: py.cmd, prefixArgs: [...py.prefixArgs, "-m", toolName] };
    }
  }

  console.error(
    `[yocto-bridge] '${toolName}' was not found in packages/yocto-bridge/.venv or the active Python environment.`
  );
  console.error("Create the virtualenv and install test/lint dependencies:");
  if (process.platform === "win32") {
    console.error("  python -m venv packages/yocto-bridge/.venv");
    console.error(
      "  packages\\yocto-bridge\\.venv\\Scripts\\python.exe -m pip install pytest pytest-asyncio ruff"
    );
  } else {
    console.error("  python3 -m venv packages/yocto-bridge/.venv");
    console.error(
      "  packages/yocto-bridge/.venv/bin/python -m pip install pytest pytest-asyncio ruff"
    );
  }
  process.exit(1);
}

function runChild(cmd, args) {
  const child = spawn(cmd, args, {
    cwd: BRIDGE_DIR,
    stdio: "inherit",
  });

  const forwardSignal = (sig) => {
    if (child.killed) return;
    try {
      child.kill(sig);
    } catch {
      // Child already exited
    }
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("error", (err) => {
    console.error(`[yocto-bridge] Failed to start '${cmd}': ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

const [subcommand, ...extraArgs] = process.argv.slice(2);

switch (subcommand) {
  case "serve": {
    const py = requirePython();
    const args =
      extraArgs.length > 0 ? extraArgs : ["--mock", "--host", "127.0.0.1", "--port", "18765"];
    runChild(py.cmd, [...py.prefixArgs, "-m", "bridge.server", ...args]);
    break;
  }
  case "test": {
    const pytest = resolveVenvTool("pytest");
    runChild(pytest.cmd, [...pytest.prefixArgs, "-v", ...extraArgs]);
    break;
  }
  case "lint": {
    const ruff = resolveVenvTool("ruff");
    runChild(ruff.cmd, [...ruff.prefixArgs, "check", ".", ...extraArgs]);
    break;
  }
  default: {
    console.error("Usage: node scripts/run-bridge.mjs <serve|test|lint> [args...]");
    process.exit(1);
  }
}
