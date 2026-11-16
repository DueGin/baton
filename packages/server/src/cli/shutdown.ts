import type { Readable } from "node:stream";
import type { BatonServer } from "../api/server.js";

/** Shared by the CLI and stdin lifecycle tests; the desktop closes the pipe on Windows. */
export function installShutdown(daemon: Pick<BatonServer, "close">, options: {
  stdin?: Readable; exitOnStdinClose?: boolean; deadlineMs?: number;
  exit?: (code: number) => void; report?: (error: unknown) => void;
} = {}): { close(): Promise<void>; dispose(): void } {
  const stdin = options.stdin ?? process.stdin, exit = options.exit ?? ((code) => process.exit(code));
  let closing: Promise<void> | undefined;
  const dispose = (): void => { process.off("SIGINT", begin); process.off("SIGTERM", begin); stdin.off("end", begin); stdin.off("close", begin); };
  const close = (): Promise<void> => closing ??= (async () => {
    dispose();
    const deadline = setTimeout(() => exit(0), options.deadlineMs ?? 9500);
    try { await daemon.close(); }
    catch (error) { (options.report ?? console.error)(error); }
    finally { clearTimeout(deadline); stdin.pause(); exit(0); }
  })();
  function begin(): void { void close(); }
  process.once("SIGINT", begin); process.once("SIGTERM", begin);
  if (options.exitOnStdinClose) { stdin.once("end", begin); stdin.once("close", begin); stdin.resume(); if (stdin.readableEnded || stdin.destroyed) begin(); }
  return { close, dispose };
}
