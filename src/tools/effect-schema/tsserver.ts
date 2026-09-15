import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A tsserver process belongs to one session. No shell or global TypeScript install is used. */
export class SchemaTsServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "effect-schema-server-"));
  private readonly logFile = path.join(this.temporaryDirectory, "server.log");
  private buffer: Buffer = Buffer.alloc(0);
  private sequence = 0;
  private failure?: Error;
  private stderr = "";
  private closing?: Promise<void>;
  private readonly pending = new Map<number, {
    resolve: (body: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(serverPath: string, cwd: string, probeLocation: string, private readonly timeoutMs: number) {
    this.child = spawn(process.execPath, [serverPath,
      "--disableAutomaticTypingAcquisition", "--globalPlugins", "@effect/language-service",
      "--pluginProbeLocations", probeLocation,
      "--logVerbosity", "normal", "--logFile", this.logFile,
    ], { cwd, stdio: "pipe" });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { this.receive(chunk); } catch (error) { this.fail(error as Error); this.child.kill(); }
    });
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("close", (code, signal) => {
      this.fail(new Error(`TypeScript server exited (${signal ?? code}). ${this.stderr}`.trim()));
    });
  }

  request<T>(command: string, args?: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const seq = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`TypeScript server timed out during ${command} after ${this.timeoutMs} ms.`));
        this.child.kill();
      }, this.timeoutMs);
      this.pending.set(seq, { resolve: resolve as (body: unknown) => void, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`);
    });
  }

  assertPluginLoaded(): void {
    const log = fs.readFileSync(this.logFile, "utf8");
    if (!log.includes("[@effect/language-service] Started!") || !log.includes("Plugin validation succeeded")) {
      const details = log.split("\n").filter((line) => /activation failed|Couldn't find|Failed to load|Skipped loading/.test(line));
      throw new Error(`Could not activate the project's @effect/language-service. ${details.join("\n")}`);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fail(new Error("Effect schema session closed."));
    this.closing = (async () => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
          this.child.once("close", () => { clearTimeout(timer); resolve(); });
          this.child.kill();
        });
      }
      fs.rmSync(this.temporaryDirectory, { recursive: true, force: true });
    })();
    return this.closing;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const boundary = this.buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const header = this.buffer.subarray(0, boundary).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error("Invalid TypeScript server response header.");
      const length = Number(match[1]);
      const end = boundary + 4 + length;
      if (this.buffer.length < end) return;
      const message = JSON.parse(this.buffer.subarray(boundary + 4, end).toString("utf8"));
      this.buffer = this.buffer.subarray(end);
      if (message.type !== "response") continue;
      const pending = this.pending.get(message.request_seq);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.request_seq);
      if (message.success) pending.resolve(message.body);
      else pending.reject(new Error(`TypeScript ${message.command}: ${message.message ?? "request failed"}`));
    }
  }
}
