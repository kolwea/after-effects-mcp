// WebSocket client for the MCP Bridge CEP panel running inside After Effects.
// The panel writes its port and a per-session token to a discovery file; we read it on each connect,
// so restarting After Effects (new port or token) needs no MCP restart.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import WebSocket from "ws";

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
type Reply = { id: number; ok: boolean; result?: unknown; error?: string; ms?: number };

export class BridgeError extends Error {}

export function discoveryFile(): string {
  const dir =
    process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "ae-mcp")
    : process.platform === "win32" ? path.join(process.env.APPDATA || os.homedir(), "ae-mcp")
    : path.join(os.homedir(), ".ae-mcp");
  return path.join(dir, "bridge.json");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readDiscovery(): { port: number; token: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(discoveryFile(), "utf8");
  } catch {
    throw new BridgeError(
      "After Effects bridge is not running. Open After Effects and the panel at Window > Extensions > MCP Bridge."
    );
  }
  const parsed = JSON.parse(raw);
  // A crash or force-quit skips the panel's cleanup, leaving a stale file behind.
  if (typeof parsed.pid === "number" && !processAlive(parsed.pid)) {
    throw new BridgeError("After Effects bridge is not running (last panel process has exited). Open the MCP Bridge panel in After Effects.");
  }
  return { port: parsed.port, token: parsed.token };
}

export class BridgeClient {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private connect(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      let target: { port: number; token: string };
      try {
        target = readDiscovery();
      } catch (err) {
        reject(err);
        return;
      }
      const socket = new WebSocket(`ws://127.0.0.1:${target.port}`, { headers: { "x-aemcp-token": target.token } });

      socket.once("open", () => {
        this.socket = socket;
        resolve(socket);
      });
      socket.once("error", (err) => {
        reject(new BridgeError(
          `Cannot reach the After Effects bridge on port ${target.port} (${err.message}). ` +
          "Check that After Effects is open and the MCP Bridge panel is loaded."
        ));
      });
      socket.on("message", (data) => this.onMessage(String(data)));
      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new BridgeError("Connection to After Effects closed before the command finished."));
          this.pending.delete(id);
        }
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private onMessage(text: string): void {
    let reply: Reply;
    try {
      reply = JSON.parse(text);
    } catch {
      return;
    }
    const p = this.pending.get(reply.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(reply.id);
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new BridgeError(reply.error || "Unknown bridge error"));
  }

  async call(command: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const socket = await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(
          `After Effects did not answer '${command}' within ${timeoutMs / 1000}s. ` +
          "A modal dialog or a long render may be blocking it."
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, command, args }));
    });
  }
}
