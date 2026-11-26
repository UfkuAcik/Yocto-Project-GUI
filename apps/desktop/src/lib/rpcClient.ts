import type {
  BridgeEventMap,
  BridgeEventName,
  RpcMethodMap,
  RpcMethodName,
} from "@yocto-studio/shared-protocol";
import i18next from "@/i18n";

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ConnectionState = "connecting" | "connected" | "disconnected";
type NotificationListener = (method: BridgeEventName, params: BridgeEventMap[BridgeEventName]) => void;
type StateListener = (state: ConnectionState) => void;

export class BridgeRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "BridgeRpcError";
    this.code = code;
    this.data = data;
  }
}

class RpcClient {
  private ws: WebSocket | null = null;
  private url = "ws://127.0.0.1:18765/ws";
  private state: ConnectionState = "disconnected";
  private pending = new Map<string, PendingCall>();
  private notificationListeners = new Set<NotificationListener>();
  private stateListeners = new Set<StateListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private seq = 0;

  getConnectionState(): ConnectionState {
    return this.state;
  }

  getUrl(): string {
    return this.url;
  }

  private setState(next: ConnectionState): void {
    this.state = next;
    for (const cb of this.stateListeners) {
      cb(next);
    }
  }

  onStateChange(cb: StateListener): () => void {
    this.stateListeners.add(cb);
    cb(this.state);
    return () => this.stateListeners.delete(cb);
  }

  onNotification(cb: NotificationListener): () => void {
    this.notificationListeners.add(cb);
    return () => this.notificationListeners.delete(cb);
  }

  connect(wsUrl?: string): void {
    if (wsUrl) {
      this.url = wsUrl;
    }
    this.shouldReconnect = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.setState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.setState("connected");
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if ("id" in msg && msg.id !== null && msg.id !== undefined) {
          const id = String(msg.id);
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          if ("error" in msg && msg.error && typeof msg.error === "object") {
            const errObj = msg.error as { code: number; message: string; data?: unknown };
            pending.reject(new BridgeRpcError(errObj.code, errObj.message, errObj.data));
          } else {
            pending.resolve(msg.result);
          }
          return;
        }
        if ("method" in msg && typeof msg.method === "string") {
          const method = msg.method as BridgeEventName;
          const params = (msg.params ?? {}) as BridgeEventMap[BridgeEventName];
          for (const listener of this.notificationListeners) {
            listener(method, params);
          }
        }
      } catch {
        // Ignore malformed message frames
      }
    };

    ws.onerror = () => {
      // Closed handler handles reconnect
    };

    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.setState("disconnected");
      for (const [id, item] of this.pending.entries()) {
        clearTimeout(item.timer);
        item.reject(
          new Error(i18next.language === "en" ? "WebSocket connection closed." : "WebSocket bağlantısı kapandı.")
        );
        this.pending.delete(id);
      }
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 1200);
      }
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setState("disconnected");
  }

  async call<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]["params"],
    timeoutMs = 15000
  ): Promise<RpcMethodMap[M]["result"]> {
    const lang = i18next.language === "en" ? "en" : "tr";
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const id = `rpc-${++this.seq}-${Date.now()}`;
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id,
        lang,
        method,
        params,
      });

      return new Promise<RpcMethodMap[M]["result"]>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`RPC timeout (${method})`));
        }, timeoutMs);

        this.pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
        });
        this.ws?.send(payload);
      });
    }

    // Fallback to HTTP POST /rpc when WS is still handshaking
    const httpBase = this.url.replace(/^ws/, "http").replace(/\/ws$/, "");
    const res = await fetch(`${httpBase}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `http-${++this.seq}`,
        lang,
        method,
        params,
      }),
    });
    const body = (await res.json()) as {
      result?: RpcMethodMap[M]["result"];
      error?: { code: number; message: string; data?: unknown };
    };
    if (body.error) {
      throw new BridgeRpcError(body.error.code, body.error.message, body.error.data);
    }
    return body.result as RpcMethodMap[M]["result"];
  }
}

export const rpcClient = new RpcClient();
