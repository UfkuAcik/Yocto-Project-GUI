import { useQuery } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Download,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Input, Switch } from "@/components/ui/primitives";
import {
  closeSerialPort,
  getUbootMacros,
  listSerialPorts,
  openSerialPort,
  saveSerialLog,
  setSerialAutoInterrupt as setSerialAutoInterruptApi,
  writeSerialPort,
} from "@/lib/deployApi";
import { isTauriRuntime } from "@/lib/tauriApi";
import { useAppStore } from "@/stores/appStore";
import { useDeployStore } from "@/stores/deployStore";

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export function SerialConsoleTab({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const theme = useAppStore((s) => s.theme);
  const {
    serial,
    setSerialConnected,
    setSerialAutoInterrupt,
    setSerialTimestamps,
    appendSerialOutput,
    clearSerialBuffer,
    addCustomMacro,
  } = useDeployStore();

  const [selectedPort, setSelectedPort] = useState(serial.portName || "mock://uart-imx8mp");
  const [baud, setBaud] = useState(serial.baudRate || 115200);
  const [dataBits, setDataBits] = useState<7 | 8>(8);
  const [parity, setParity] = useState<"none" | "even" | "odd">("none");
  const [stopBits, setStopBits] = useState<1 | 2>(1);
  const [searchTerm, setSearchTerm] = useState("");
  const [newMacroLabel, setNewMacroLabel] = useState("");
  const [newMacroCmd, setNewMacroCmd] = useState("");
  const [statusNote, setStatusNote] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const writtenLenRef = useRef(0);

  const portsQ = useQuery({
    queryKey: ["serial-ports", i18n.language],
    queryFn: () => listSerialPorts(true),
  });

  const macrosQ = useQuery({
    queryKey: ["uboot-macros", i18n.language],
    queryFn: () => getUbootMacros(),
  });

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
            ? { background: "#0B0E14", foreground: "#E2E8F0", cursor: "#38BDF8" }
            : { background: "#FFFFFF", foreground: "#0F172A", cursor: "#0284C7" },
      });

      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      instance.loadAddon(fitAddon);
      instance.loadAddon(searchAddon);
      instance.open(el);

      term = instance;
      fit = fitAddon;
      termRef.current = instance;
      searchAddonRef.current = searchAddon;
      writtenLenRef.current = 0;

      safeFit();

      const initialBuffer = useDeployStore.getState().serial.buffer;
      if (initialBuffer) {
        instance.write(initialBuffer);
        writtenLenRef.current = initialBuffer.length;
      }

      disp = instance.onData((data) => {
        const sid = useDeployStore.getState().serial.sessionId;
        if (!sid) return;
        if (isTauriRuntime()) {
          void writeSerialPort(sid, data);
        } else {
          appendSerialOutput(data);
          if (data === "\r") {
            appendSerialOutput("\r\nu-boot=> ");
          }
        }
      });

      ro = new ResizeObserver(() => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          safeFit();
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
  }, [theme]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (serial.buffer.length < writtenLenRef.current) {
      term.reset();
      term.write(serial.buffer);
      writtenLenRef.current = serial.buffer.length;
      return;
    }
    if (serial.buffer.length > writtenLenRef.current) {
      term.write(serial.buffer.slice(writtenLenRef.current));
      writtenLenRef.current = serial.buffer.length;
    }
  }, [serial.buffer]);

  async function handleConnectToggle() {
    if (serial.connected && serial.sessionId) {
      await closeSerialPort(serial.sessionId);
      setSerialConnected(null, selectedPort, baud);
      return;
    }

    const sid = await openSerialPort({
      port_name: selectedPort,
      baud_rate: baud,
      data_bits: dataBits,
      parity,
      stop_bits: stopBits,
      auto_interrupt_uboot: serial.autoInterrupt,
      interrupt_key: "\r",
    });
    setSerialConnected(sid, selectedPort, baud);
    if (!isTauriRuntime()) {
      appendSerialOutput(
        `\r\nU-Boot 2025.04 (${selectedPort}@${baud})\r\nHit any key to stop autoboot:  3 \r\n` +
          (serial.autoInterrupt
            ? `${t("deploy.serialAutoInterruptMsg")}\r\nu-boot=> `
            : "root@imx8mp:~# ")
      );
    }
  }

  async function sendMacro(command: string) {
    if (!serial.sessionId) {
      setStatusNote(t("deploy.serialConnectFirst"));
      return;
    }
    setStatusNote(null);
    if (isTauriRuntime()) {
      await writeSerialPort(serial.sessionId, `${command}\r`);
    } else {
      appendSerialOutput(
        `\r\n${command}\r\n[uart-mock] ${t("deploy.mockExecLine", { command })}\r\nu-boot=> `
      );
    }
  }

  async function handleToggleAutoInterrupt(val: boolean) {
    setSerialAutoInterrupt(val);
    if (serial.sessionId) {
      await setSerialAutoInterruptApi(serial.sessionId, val);
    }
  }

  async function handleSaveLog() {
    if (!serial.sessionId && !serial.buffer) return;
    if (isTauriRuntime() && serial.sessionId) {
      const dest = `yocto-uart-${Date.now()}.log`;
      const n = await saveSerialLog(serial.sessionId, dest);
      setStatusNote(t("deploy.savedLogNote", { dest, bytes: n }));
    } else {
      const blob = new Blob([serial.buffer], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `yocto-uart-${Date.now()}.log`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  const allMacros = [...(macrosQ.data ?? []), ...serial.customMacros];

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Toolbar 1: Port & Framing Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-2.5 py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={selectedPort}
            onChange={(e) => setSelectedPort(e.target.value)}
            disabled={serial.connected}
            className="h-7 rounded border border-border bg-bg px-2 text-xs text-fg max-w-64"
          >
            {portsQ.data?.map((p) => (
              <option key={p.port_name} value={p.port_name}>
                {p.port_name} — {p.description}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={() => void portsQ.refetch()} title={t("deploy.serialRefreshPorts")}>
            <RefreshCw className="h-3 w-3" />
          </Button>
          <select
            value={baud}
            onChange={(e) => setBaud(Number(e.target.value))}
            disabled={serial.connected}
            className="h-7 rounded border border-border bg-bg px-1.5 text-xs text-fg mono-num"
          >
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <select
            value={`${dataBits}${parity[0].toUpperCase()}${stopBits}`}
            onChange={(e) => {
              const v = e.target.value;
              setDataBits(v.startsWith("7") ? 7 : 8);
              setParity(v[1] === "E" ? "even" : v[1] === "O" ? "odd" : "none");
              setStopBits(v.endsWith("2") ? 2 : 1);
            }}
            disabled={serial.connected}
            className="h-7 rounded border border-border bg-bg px-1.5 text-xs text-fg mono-num"
          >
            <option value="8N1">8N1</option>
            <option value="8E1">8E1</option>
            <option value="8O1">8O1</option>
            <option value="7E1">7E1</option>
            <option value="8N2">8N2</option>
          </select>

          <Button
            size="sm"
            variant={serial.connected ? "danger" : "primary"}
            onClick={() => void handleConnectToggle()}
          >
            {serial.connected ? <PlugZap className="h-3 w-3" /> : <Plug className="h-3 w-3" />}
            {serial.connected ? t("deploy.serialDisconnect") : t("deploy.serialConnect")}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Switch
              checked={serial.autoInterrupt}
              onCheckedChange={(v) => void handleToggleAutoInterrupt(v)}
            />
            <span className="text-[11px] text-fg flex items-center gap-1">
              <Zap className="h-3 w-3 text-warning" />
              Auto-Interrupt Boot
            </span>
          </div>
          <label className="flex items-center gap-1 text-[11px] text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={serial.showTimestamps}
              onChange={(e) => setSerialTimestamps(e.target.checked)}
              className="accent-accent"
            />
            {t("deploy.serialTimestamps")}
          </label>
          <div className="relative w-32">
            <Search className="pointer-events-none absolute left-2 top-1.5 h-3 w-3 text-muted" />
            <Input
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                if (e.target.value) searchAddonRef.current?.findNext(e.target.value);
              }}
              placeholder={t("deploy.serialSearchPlaceholder")}
              className="h-6 pl-6 text-[11px]"
            />
          </div>
          <Button size="sm" variant="ghost" onClick={() => void handleSaveLog()} title={t("deploy.serialSaveLog")}>
            <Download className="h-3 w-3" />
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSerialBuffer} title={t("deploy.serialClear")}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Toolbar 2: U-Boot Quick Macro Bar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface/50 px-2.5 py-1 text-[11px]">
        <Badge tone="accent">{t("deploy.ubootMacros")}</Badge>
        {allMacros.map((m) => (
          <Button
            key={m.id}
            size="sm"
            className="h-6 px-2 text-[11px]"
            title={m.command}
            onClick={() => void sendMacro(m.command)}
          >
            <Send className="h-2.5 w-2.5" />
            {m.label}
          </Button>
        ))}

        {!compact && (
          <div className="ml-auto flex items-center gap-1">
            <Input
              value={newMacroLabel}
              onChange={(e) => setNewMacroLabel(e.target.value)}
              placeholder={t("deploy.macroNamePlaceholder")}
              className="h-6 w-24 text-[11px]"
            />
            <Input
              value={newMacroCmd}
              onChange={(e) => setNewMacroCmd(e.target.value)}
              placeholder={t("deploy.macroCmdPlaceholder")}
              className="h-6 w-36 text-[11px] mono-num"
            />
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                if (!newMacroLabel.trim() || !newMacroCmd.trim()) return;
                addCustomMacro({
                  id: `custom-${Date.now()}`,
                  label: newMacroLabel.trim(),
                  command: newMacroCmd.trim(),
                  description: t("deploy.userMacroDesc"),
                  category: "custom",
                });
                setNewMacroLabel("");
                setNewMacroCmd("");
              }}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>

      {statusNote && (
        <div className="border-b border-border bg-accent/10 px-3 py-1 text-[11px] text-accent">
          {statusNote}
        </div>
      )}

      <div ref={containerRef} className={compact ? "min-h-0 flex-1 p-1" : "min-h-72 flex-1 p-1"} />
    </div>
  );
}
