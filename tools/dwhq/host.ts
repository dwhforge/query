/** Local, single-owner DWHQuery Host transport. Does not expose generic RPC as a CLI command. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Socket, connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

type Reply = { id?: number; ok?: boolean; result?: unknown; error?: string; error_detail?: unknown };
const DEFAULT_TIMEOUT = 120_000;
const MAX_FRAME = 64 * 1024 * 1024;

export class LocalHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private socket: Socket | null = null;
  private waiting = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void}>();
  private buffer = Buffer.alloc(0);
  private nextId = 0;

  async start(): Promise<void> {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const binary = process.env.DWHQ_HOST_BIN
      ? resolve(process.env.DWHQ_HOST_BIN)
      : resolve(root, "target/release/dwh-host");
    const timeout = Number(process.env.DWHQ_HOST_TIMEOUT_MS) || DEFAULT_TIMEOUT;
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.child = child;
    // Drain stderr but do not forward: host diagnostics may contain sensitive paths.
    child.stderr.on("data", () => {});
    let ready = "";
    const address = await new Promise<{path?: string; port?: number}>((ok, fail) => {
      let settled = false;
      const done = (err?: Error, addr?: {path?: string; port?: number}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", data);
        child.off("error", error);
        child.off("exit", exit);
        if (err) fail(err); else ok(addr!);
      };
      const error = (err: Error) => done(err);
      const exit = (code: number | null) => done(new Error(`dwh-host exited before ready (code ${code})`));
      const data = (chunk: Buffer) => {
        ready += chunk.toString("utf8");
        const unix = ready.match(/DWH_HOST_READY\s+unix\s+(\S+)/);
        const tcp = ready.match(/DWH_HOST_READY\s+tcp\s+(\d+)/);
        if (unix) done(undefined, {path: unix[1]});
        else if (tcp) done(undefined, {port: Number(tcp[1])});
        else if (ready.length > 8192) ready = ready.slice(-2048);
      };
      const timer = setTimeout(() => done(new Error("dwh-host readiness timeout")), timeout);
      child.stdout.on("data", data);
      child.once("error", error);
      child.once("exit", exit);
    });
    const socket = address.path ? connect(address.path) : connect({host: "127.0.0.1", port: address.port!});
    this.socket = socket;
    try { await once(socket, "connect"); }
    catch (error) { this.close(); throw error; }
    socket.on("data", chunk => this.onData(chunk));
    socket.on("error", error => this.rejectAll(error));
    socket.on("close", () => this.rejectAll(new Error("dwh-host socket closed")));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.waiting.values()) pending.reject(error);
    this.waiting.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size > MAX_FRAME) {
        this.rejectAll(new Error("Host returned oversized frame"));
        this.close();
        return;
      }
      if (this.buffer.length < size + 4) break;
      const frame = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      let reply: Reply;
      try { reply = JSON.parse(frame.toString("utf8")) as Reply; }
      catch { this.rejectAll(new Error("Invalid host response JSON")); this.close(); return; }
      const pending = this.waiting.get(reply.id ?? -1);
      if (!pending) continue;
      this.waiting.delete(reply.id!);
      if (reply.ok === true) pending.resolve(reply.result);
      else pending.reject(new Error(reply.error || "Host request failed"));
    }
  }

  async call<T>(cmd: string, args: unknown): Promise<T> {
    if (!this.socket || this.socket.destroyed) throw new Error("Host is not connected");
    const id = ++this.nextId;
    const encoded = Buffer.from(JSON.stringify({id, cmd, args}), "utf8");
    if (encoded.length > MAX_FRAME) throw new Error("Host request exceeds 64 MiB");
    const frame = Buffer.allocUnsafe(4 + encoded.length);
    frame.writeUInt32LE(encoded.length, 0);
    encoded.copy(frame, 4);
    const timeout = Number(process.env.DWHQ_HOST_TIMEOUT_MS) || DEFAULT_TIMEOUT;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${cmd} timed out`));
        this.close();
      }, timeout);
      this.waiting.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value as T); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.socket!.write(frame, error => {
        if (!error) return;
        const pending = this.waiting.get(id);
        if (pending) { this.waiting.delete(id); pending.reject(error); }
      });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.rejectAll(new Error("Host closed"));
    this.child?.kill();
    this.child = null;
  }
}
