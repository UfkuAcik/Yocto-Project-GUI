#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "assets", "screenshots");

function findBrowserExecutable() {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/microsoft-edge",
        ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

async function waitForHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startChild(cmd, args, cwd) {
  if (process.platform === "win32" && cmd.endsWith(".cmd")) {
    return spawn("cmd.exe", ["/c", cmd, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function captureLocale(browser, lang, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await context.addInitScript((l) => {
    window.localStorage.setItem("yocto-studio.lang", l);
  }, lang);

  try {
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error(`PAGEERROR [${lang}]:`, err));

    await page.goto("http://localhost:1420", { waitUntil: "networkidle" });
    await page.getByText(/MOCK · (Bağlı|Connected)/).waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);

    // 01: Live Build Dashboard
    await page.getByRole("button", { name: /Derlemeyi Başlat|Start Build/ }).first().click();
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(outDir, "01-build-dashboard.png") });
    await page.waitForTimeout(1800);

    // 02: Pre-Flight & Image Advisor
    await page
      .locator("header")
      .getByRole("button", { name: /Pre-Flight Kontrolü Çalıştır|Run Pre-Flight Check/ })
      .first()
      .click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(outDir, "02-preflight-advisor.png") });

    // 03: Config Studio
    await page.locator("aside button", { hasText: /^Config$/ }).first().click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, "03-config-studio-layers.png") });

    // 04: Recipe IDE (Monaco BitBake Editor)
    await page.locator("aside button", { hasText: /^(Tarif|Recipes)$/ }).first().click();
    await page.waitForTimeout(1400);
    await page.screenshot({ path: path.join(outDir, "04-recipe-ide-dag.png") });

    // 05: Target Deploy + UART Serial Console
    await page.locator("aside").first().locator("button", { hasText: /^Deploy$/ }).first().click();
    await page.getByRole("button", { name: /UART Serial/ }).first().click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, "05-target-deploy-uart.png") });

    // 06: Enterprise RootFS Treemap & diffsigs
    await page
      .locator("aside")
      .first()
      .locator("button", { hasText: /^(Kurumsal|Enterprise)$/ })
      .first()
      .click();
    await page.getByRole("button", { name: /RootFS Treemap/ }).first().click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(outDir, "06-pro-suite-enterprise.png") });

    // 07: Crisp Light Theme Preview (Pro Suite Kernel / Device Tree)
    await page.locator("aside").first().locator("button", { hasText: /^Pro$/ }).first().click();
    await page.getByRole("button", { name: /Canlı BitBake Logları|Live BitBake Logs/ }).first().click();
    await page.getByTitle(/Tema Değiştir|Switch Theme/).first().click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(outDir, "07-light-theme-preview.png") });

    console.log(`Captured 7 [${lang}] screenshots into ${outDir}`);
  } finally {
    await context.close();
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pyExe =
    process.platform === "win32"
      ? path.join(ROOT, "packages", "yocto-bridge", ".venv", "Scripts", "python.exe")
      : path.join(ROOT, "packages", "yocto-bridge", ".venv", "bin", "python");

  const bridgeProc = startChild(
    pyExe,
    ["-m", "bridge.server", "--mock", "--port", "18765"],
    path.join(ROOT, "packages", "yocto-bridge")
  );

  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const previewProc = startChild(
    pnpmCmd,
    ["--filter", "@yocto-studio/desktop", "preview", "--port", "1420", "--strictPort"],
    ROOT
  );

  const cleanup = () => {
    for (const p of [bridgeProc, previewProc]) {
      if (!p?.pid) continue;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          p.kill("SIGTERM");
        }
      } catch {}
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    await Promise.all([
      waitForHttp("http://127.0.0.1:18765/health"),
      waitForHttp("http://localhost:1420"),
    ]);

    const executablePath = findBrowserExecutable();
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });

    try {
      await captureLocale(browser, "tr", OUT_DIR);
      await captureLocale(browser, "en", path.join(OUT_DIR, "en"));
    } finally {
      await browser.close();
    }
  } finally {
    cleanup();
  }

  console.log("Captured 14 screenshots (7 TR + 7 EN)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
