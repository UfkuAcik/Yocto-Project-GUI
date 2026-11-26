import {
  Activity,
  Building2,
  FolderGit2,
  Languages,
  Layers,
  PackageCheck,
  Play,
  ShieldCheck,
  Sliders,
  Sparkles,
  Square,
  Stethoscope,
  Terminal,
  Usb,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Modal } from "@/components/ui/primitives";
import { setAppLanguage } from "@/i18n";
import { rpcClient } from "@/lib/rpcClient";
import { type ModuleId, useAppStore } from "@/stores/appStore";
import { useBuildStore } from "@/stores/buildStore";

type CommandCategoryKey = "module" | "action" | "view";

interface PaletteCommand {
  id: string;
  label: string;
  categoryKey: CommandCategoryKey;
  category: string;
  hint?: string;
  action: () => void;
}

export function CommandPalette() {
  const { t, i18n } = useTranslation();
  const open = useAppStore((s) => s.commandPaletteOpen);
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const setDrawerTab = useAppStore((s) => s.setDrawerTab);
  const setSnapshotModalOpen = useAppStore((s) => s.setSnapshotModalOpen);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const target = useBuildStore((s) => s.selectedBuildTarget);

  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const modCat = t("palette.catModule");
    const actCat = t("palette.catAction");
    const viewCat = t("palette.catView");
    const nav = (mod: ModuleId, label: string, hint: string): PaletteCommand => ({
      id: `nav-${mod}`,
      label,
      categoryKey: "module",
      category: modCat,
      hint,
      action: () => {
        setActiveModule(mod);
        setOpen(false);
      },
    });
    return [
      nav("environment", t("palette.navEnvironment"), "WSL2 / RAM / ext4"),
      nav("workspace", t("palette.navWorkspace"), "bitbake-setup / kas"),
      nav("layers", t("palette.navLayers"), "bitbake-layers"),
      nav("config", t("palette.navConfig"), "local.conf / fragments"),
      nav("recipes", t("palette.navRecipes"), ".bb / .bbappend"),
      nav("build", t("palette.navBuild"), "BitBake XML-RPC"),
      nav("preflight", t("palette.navPreflight"), t("palette.hintPreflight")),
      nav("artifacts", t("palette.navArtifacts"), "SPDX 3.0 / wic"),
      nav("pro", t("palette.navPro"), t("palette.hintModule10")),
      nav("enterprise", t("nav.enterprise.label"), t("palette.hintModule11")),
      nav("deploy", t("palette.navDeploy"), "USB / Ethernet / UART"),
      {
        id: "open-snapshot",
        label: t("palette.openSnapshot"),
        categoryKey: "action",
        category: actCat,
        hint: ".yoctostudio",
        action: () => {
          setSnapshotModalOpen(true);
          setOpen(false);
        },
      },
      {
        id: "toggle-lang",
        label: t("palette.toggleLanguage"),
        categoryKey: "view",
        category: viewCat,
        hint: "TR / EN",
        action: () => {
          setAppLanguage(i18n.language === "en" ? "tr" : "en");
          setOpen(false);
        },
      },
      {
        id: "build-start",
        label: t("palette.buildStart", { target }),
        categoryKey: "action",
        category: actCat,
        hint: "Mock/Live",
        action: () => {
          setActiveModule("build");
          void rpcClient.call("build.start", { target });
          setOpen(false);
        },
      },
      {
        id: "build-fail",
        label: t("palette.buildFail"),
        categoryKey: "action",
        category: actCat,
        hint: "log.do_compile",
        action: () => {
          setActiveModule("build");
          void rpcClient.call("build.start", { target, simulate_failure: true });
          setOpen(false);
        },
      },
      {
        id: "build-stop",
        label: t("palette.buildStop"),
        categoryKey: "action",
        category: actCat,
        action: () => {
          void rpcClient.call("build.cancel", {});
          setOpen(false);
        },
      },
      {
        id: "open-term",
        label: t("palette.openTerm"),
        categoryKey: "view",
        category: viewCat,
        action: () => {
          setDrawerTab("terminal");
          setOpen(false);
        },
      },
      {
        id: "open-serial",
        label: t("palette.openSerial"),
        categoryKey: "view",
        category: viewCat,
        action: () => {
          setDrawerTab("serial");
          setOpen(false);
        },
      },
      {
        id: "toggle-theme",
        label: t("palette.toggleTheme"),
        categoryKey: "view",
        category: viewCat,
        action: () => {
          toggleTheme();
          setOpen(false);
        },
      },
    ];
  }, [i18n.language, setActiveModule, setDrawerTab, setOpen, setSnapshotModalOpen, t, target, toggleTheme]);

  const filtered = commands.filter(
    (c) =>
      c.label.toLowerCase().includes(query.toLowerCase()) ||
      c.category.toLowerCase().includes(query.toLowerCase())
  );

  const iconFor = (catKey: CommandCategoryKey, id: string) => {
    if (id.includes("build-start")) return <Play className="h-3.5 w-3.5 text-success" />;
    if (id.includes("build-stop")) return <Square className="h-3.5 w-3.5 text-danger" />;
    if (id.includes("environment")) return <Stethoscope className="h-3.5 w-3.5 text-accent" />;
    if (id.includes("workspace")) return <FolderGit2 className="h-3.5 w-3.5 text-accent" />;
    if (id.includes("layers")) return <Layers className="h-3.5 w-3.5 text-accent" />;
    if (id.includes("config")) return <Sliders className="h-3.5 w-3.5 text-accent" />;
    if (id.includes("artifacts")) return <PackageCheck className="h-3.5 w-3.5 text-accent" />;
    if (id.includes("preflight")) return <ShieldCheck className="h-3.5 w-3.5 text-accent" />;
    if (id.includes("pro")) return <Sparkles className="h-3.5 w-3.5 text-accent" />;
    if (id.includes("enterprise")) return <Building2 className="h-3.5 w-3.5 text-accent" />;
    if (id.includes("toggle-lang")) return <Languages className="h-3.5 w-3.5 text-accent" />;
    if (id.includes("deploy")) return <Usb className="h-3.5 w-3.5 text-accent" />;
    if (catKey === "view") return <Terminal className="h-3.5 w-3.5 text-muted" />;
    return <Activity className="h-3.5 w-3.5 text-accent" />;
  };

  return (
    <Modal open={open} onOpenChange={setOpen} title={t("palette.title")} subtitle={t("palette.subtitle")}>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("palette.placeholder")}
        className="w-full rounded-md border border-border bg-bg px-3 py-2 text-xs text-fg focus:border-accent focus:outline-none"
      />
      <div className="mt-2 max-h-72 overflow-y-auto divide-y divide-border/50">
        {filtered.map((item) => (
          <button
            key={item.id}
            onClick={item.action}
            className="flex w-full items-center justify-between px-2.5 py-2 text-left text-xs hover:bg-elevated rounded cursor-pointer"
          >
            <span className="flex items-center gap-2 text-fg">
              {iconFor(item.categoryKey, item.id)}
              {item.label}
            </span>
            <span className="flex items-center gap-2">
              {item.hint && <span className="mono-num text-[11px] text-muted">{item.hint}</span>}
              <Badge>{item.category}</Badge>
            </span>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="py-6 text-center text-xs text-muted">{t("palette.empty")}</div>
        )}
      </div>
    </Modal>
  );
}
