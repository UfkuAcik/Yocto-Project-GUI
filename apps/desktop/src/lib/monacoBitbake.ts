import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import i18next from "@/i18n";

let initialized = false;

const BITBAKE_DOCS: Record<string, { tr: string; en: string }> = {
  SUMMARY: { tr: "Tarifin tek satırlık kısa açıklaması.", en: "Short one-line summary of the recipe." },
  DESCRIPTION: { tr: "Paketin ayrıntılı açıklaması.", en: "Detailed description of the package." },
  LICENSE: {
    tr: "SPDX lisans ifadesi (ör. MIT, GPL-2.0-only, Apache-2.0).",
    en: "SPDX license expression (e.g. MIT, GPL-2.0-only, Apache-2.0).",
  },
  LIC_FILES_CHKSUM: {
    tr: "Lisans dosyasının MD5/SHA256 doğrulama özeti.",
    en: "MD5/SHA256 verification checksum for license files.",
  },
  DEPENDS: { tr: "Derleme zamanı (build-time) bağımlılıkları.", en: "Build-time recipe dependencies." },
  RDEPENDS: { tr: "Çalışma zamanı (runtime) paket bağımlılıkları.", en: "Runtime package dependencies." },
  SRC_URI: {
    tr: "Kaynak kodu, yama (.patch) ve yardımcı dosya URI listesi.",
    en: "List of source code, patch (.patch), and helper file URIs.",
  },
  SRCREV: { tr: "Git/SCM kaynak revizyon commit hash'i.", en: "Git/SCM source revision commit hash." },
  PV: { tr: "Paket sürümü (Package Version).", en: "Package Version." },
  PR: { tr: "Paket revizyonu (Package Revision).", en: "Package Revision." },
  S: { tr: "Açılan kaynak kodunun çalışma dizini.", en: "Unpacked source code working directory." },
  B: { tr: "Derleme (build) çıktı dizini.", en: "Build output directory." },
  D: { tr: "do_install hedef kurulum (staging) dizini.", en: "Target staging install directory for do_install." },
  WORKDIR: {
    tr: "Tarifin tüm geçici derleme görevlerinin çalıştığı dizin.",
    en: "Working directory where all temporary recipe build tasks execute.",
  },
  FILESEXTRAPATHS: {
    tr: ".bbappend içinde yerel dosya/yama arama yolunu genişletir.",
    en: "Extends local file/patch lookup paths inside a .bbappend.",
  },
  IMAGE_INSTALL: {
    tr: "Hedef kök dosya sistemine (rootfs) kurulacak paket listesi.",
    en: "List of packages to install into the target root filesystem (rootfs).",
  },
  EXTRA_IMAGE_FEATURES: {
    tr: "İmaj özellikleri (debug-tweaks, ssh-server-openssh vb.).",
    en: "Additional image features (e.g. ssh-server-openssh, allow-root-login).",
  },
  MACHINE: { tr: "Hedef donanım / BSP makine tanımı.", en: "Target hardware / BSP machine definition." },
  DISTRO: {
    tr: "Aktif dağıtım politikası (poky, poky-altcfg vb.).",
    en: "Active distribution policy (poky, poky-altcfg, etc.).",
  },
  COMPATIBLE_MACHINE: {
    tr: "Tarifin desteklediği makineler (regex).",
    en: "Regular expression matching machines supported by the recipe.",
  },
  SYSTEMD_SERVICE: { tr: "systemd servis birim dosyası adı.", en: "systemd service unit filename." },
  PACKAGECONFIG: {
    tr: "İsteğe bağlı derleme özellik bayrakları.",
    en: "Optional build-time feature configuration flags.",
  },
  INHERIT: { tr: "Global sınıf (.bbclass) kalıtımı.", en: "Global BitBake class (.bbclass) inheritance." },
  BBFILE_PRIORITY: {
    tr: "Katman öncelik derecesi (yüksek sayı baskındır).",
    en: "Layer priority level (higher numbers take precedence).",
  },
  LAYERSERIES_COMPAT: {
    tr: "Katmanın uyumlu olduğu Yocto sürüm dalları (wrynose, scarthgap).",
    en: "Yocto release series compatible with the layer (wrynose, scarthgap).",
  },
};

export function initMonacoBitbake(): void {
  if (initialized) return;
  initialized = true;

  if (typeof self !== "undefined") {
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker() {
        return new editorWorker();
      },
    };
  }

  loader.config({ monaco });

  monaco.languages.register({
    id: "bitbake",
    extensions: [".bb", ".bbappend", ".bbclass", ".conf", ".inc"],
    aliases: ["BitBake", "bitbake"],
  });

  monaco.languages.setMonarchTokensProvider("bitbake", {
    keywords: [
      "inherit",
      "require",
      "include",
      "addtask",
      "deltask",
      "export",
      "python",
      "def",
      "do_fetch",
      "do_unpack",
      "do_patch",
      "do_configure",
      "do_compile",
      "do_install",
      "do_package",
      "do_deploy",
    ],
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/\b(inherit|require|include|addtask|deltask|export|python|def)\b/, "keyword"],
        [/\bdo_[a-zA-Z0-9_]+(:append|:prepend)?\b/, "type.identifier"],
        [/\$\{[^}]+\}/, "variable.predefined"],
        [/[A-Z][A-Z0-9_]+(?=(:[a-zA-Z0-9_${}-]+)*\s*(\?\?=|\?=|:=|\+=|=\+|\.=|=\.|=))/, "variable"],
        [/:(append|prepend|remove|class-target|class-native)\b/, "annotation"],
        [/\?\?=|\?=|:=|\+=|=\+|\.=|=\.|=/, "operator"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
      ],
    },
  });

  monaco.languages.registerHoverProvider("bitbake", {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const doc = BITBAKE_DOCS[word.word];
      if (!doc) return null;
      const isEn = i18next.language === "en";
      return {
        contents: [
          { value: `**\`${word.word}\`** — ${isEn ? "BitBake Variable" : "BitBake Değişkeni"}` },
          { value: isEn ? doc.en : doc.tr },
        ],
      };
    },
  });

  monaco.editor.defineTheme("yocto-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "64748B", fontStyle: "italic" },
      { token: "keyword", foreground: "38BDF8", fontStyle: "bold" },
      { token: "variable", foreground: "E2E8F0" },
      { token: "variable.predefined", foreground: "34D399" },
      { token: "annotation", foreground: "F59E0B" },
      { token: "type.identifier", foreground: "A78BFA", fontStyle: "bold" },
      { token: "string", foreground: "10B981" },
      { token: "operator", foreground: "38BDF8" },
    ],
    colors: {
      "editor.background": "#0B0E14",
      "editor.foreground": "#E2E8F0",
      "editorLineNumber.foreground": "#475569",
      "editor.lineHighlightBackground": "#131822",
      "editorCursor.foreground": "#38BDF8",
    },
  });

  monaco.editor.defineTheme("yocto-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "0284C7", fontStyle: "bold" },
      { token: "annotation", foreground: "D97706" },
      { token: "string", foreground: "059669" },
    ],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#0F172A",
    },
  });
}
