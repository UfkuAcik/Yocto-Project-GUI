import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/primitives";
import { rpcClient } from "@/lib/rpcClient";
import { ptyLocalResize, ptyLocalWrite } from "@/lib/tauriApi";
import { useAppStore } from "@/stores/appStore";
import type { PtyTabSession } from "@/stores/buildStore";

export function XtermPane({ tab }: { tab: PtyTabSession }) {
  const { t } = useTranslation();
  const theme = useAppStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const writtenLenRef = useRef(0);
  const latestBufferRef = useRef(tab.buffer);
  latestBufferRef.current = tab.buffer;
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    let resizeRaf = 0;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let disp: { dispose(): void } | null = null;
    let ro: ResizeObserver | null = null;

    const safeFit = () => {
      if (
        disposed ||
        !term ||
        !fit ||
        !el.isConnected ||
        el.clientWidth === 0 ||
        el.clientHeight === 0
      ) {
        return false;
      }
      try {
        fit.fit();
        return true;
      } catch {
        return false;
      }
    };

    const initRaf = requestAnimationFrame(() => {
      if (disposed || !el.isConnected) return;

      const instance = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        convertEol: true,
        theme:
          theme === "dark"
            ? {
                background: "#0B0E14",
                foreground: "#E2E8F0",
                cursor: "#38BDF8",
                selectionBackground: "#38BDF844",
              }
            : {
                background: "#FFFFFF",
                foreground: "#0F172A",
                cursor: "#0284C7",
              },
      });

      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      const linksAddon = new WebLinksAddon();
      instance.loadAddon(fitAddon);
      instance.loadAddon(searchAddon);
      instance.loadAddon(linksAddon);
      instance.open(el);

      term = instance;
      fit = fitAddon;
      termRef.current = instance;
      searchAddonRef.current = searchAddon;
      writtenLenRef.current = 0;

      safeFit();

      const initialBuffer = latestBufferRef.current;
      if (initialBuffer) {
        instance.write(initialBuffer);
        writtenLenRef.current = initialBuffer.length;
      }

      disp = instance.onData((data) => {
        if (tab.backend === "local") {
          void ptyLocalWrite(tab.id, data);
        } else {
          void rpcClient.call("pty.write", { session_id: tab.id, data });
        }
      });

      ro = new ResizeObserver(() => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          if (!safeFit() || !term) return;
          const cols = term.cols;
          const rows = term.rows;
          if (tab.backend === "local") {
            void ptyLocalResize(tab.id, cols, rows);
          } else {
            void rpcClient.call("pty.resize", { session_id: tab.id, cols, rows });
          }
        });
      });
      ro.observe(el);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(initRaf);
      cancelAnimationFrame(resizeRaf);
      ro?.disconnect();
      disp?.dispose();
      term?.dispose();
      termRef.current = null;
      searchAddonRef.current = null;
    };
  }, [tab.id, tab.backend, theme]);

  // Stream incremental buffer updates into the active xterm instance
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (tab.buffer.length < writtenLenRef.current) {
      term.reset();
      term.write(tab.buffer);
      writtenLenRef.current = tab.buffer.length;
      return;
    }
    if (tab.buffer.length > writtenLenRef.current) {
      term.write(tab.buffer.slice(writtenLenRef.current));
      writtenLenRef.current = tab.buffer.length;
    }
  }, [tab.buffer]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-surface/50 px-2.5 py-1 text-[11px]">
        <span className="mono-num text-muted">
          {tab.title} · {tab.backend === "local" ? t("drawer.localPtyBackend") : t("drawer.bridgePtyBackend")}
        </span>
        <div className="relative w-44">
          <Search className="pointer-events-none absolute left-2 top-1.5 h-3 w-3 text-muted" />
          <Input
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              if (e.target.value) searchAddonRef.current?.findNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchTerm) {
                searchAddonRef.current?.findNext(searchTerm);
              }
            }}
            placeholder={t("drawer.searchTerminal")}
            className="h-6 pl-6 text-[11px]"
          />
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 p-1" />
    </div>
  );
}
