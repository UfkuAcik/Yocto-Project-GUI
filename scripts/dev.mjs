#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

console.log("[Yocto Studio] Starting Mock Python Bridge (127.0.0.1:18765) + Vite UI...");
console.log("[Yocto Studio] Open http://localhost:1420 in your browser (Ctrl+C to stop).");

const bridgeProc = spawn(
  process.execPath,
  [
    path.join(__dirname, "run-bridge.mjs"),
    "serve",
    "--mock",
    "--host",
    "127.0.0.1",
    "--port",
    "18765",
  ],
  {
    cwd: ROOT,
    stdio: "inherit",
  }
);

const desktopProc =
  process.platform === "win32"
    ? spawn("cmd.exe", ["/c", "pnpm.cmd", "--filter", "@yocto-studio/desktop", "dev"], {
        cwd: ROOT,
        stdio: "inherit",
      })
    : spawn("pnpm", ["--filter", "@yocto-studio/desktop", "dev"], {
        cwd: ROOT,
        stdio: "inherit",
      });

const children = [bridgeProc, desktopProc];
let shuttingDown = false;

function terminateChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Ignore errors when child already terminated
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    terminateChild(child);
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

for (const [name, child] of [
  ["yocto-bridge", bridgeProc],
  ["desktop-vite", desktopProc],
]) {
  child.on("error", (err) => {
    console.error(`[Yocto Studio] Failed to start ${name}: ${err.message}`);
    shutdown(1);
  });
  child.on("exit", (code) => {
    if (!shuttingDown) {
      shutdown(code ?? 0);
    }
  });
}
