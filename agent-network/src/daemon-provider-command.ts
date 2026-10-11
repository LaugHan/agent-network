import { join } from "node:path";
import { readSync } from "node:fs";
import { DaemonProviderError, DaemonProviderStore } from "./daemon-provider-store";

export const DAEMON_PROVIDER_USAGE = "anet daemon provider <list|put> <daemon> [--revision N] (put reads one private JSON document from stdin; no key in argv)";
export function readProviderInput(fd = 0): string {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(4096);
    const bytes = readSync(fd, chunk, 0, chunk.length, null);
    if (!bytes) return Buffer.concat(chunks, total).toString("utf8");
    total += bytes;
    if (total > 64 * 1024) throw new DaemonProviderError("input_too_large");
    chunks.push(chunk.subarray(0, bytes));
  }
}
export function runDaemonProvider(args: string[], deps: { nodesDir: string; readInput: () => string; print: (text: string) => void }): number {
  const [action, daemon, ...rest] = args;
  if (!["list", "put"].includes(action) || !daemon || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u.test(daemon)
    || (action === "list" && rest.length !== 0)
    || (action === "put" && (rest.length !== 2 || rest[0] !== "--revision" || !/^(0|[1-9][0-9]*)$/.test(rest[1])))) {
    deps.print(DAEMON_PROVIDER_USAGE); return 2;
  }
  try {
    const store = new DaemonProviderStore(join(deps.nodesDir, daemon));
    if (action === "list") deps.print(JSON.stringify({ ok: true, ...store.list() }));
    else {
      const input = deps.readInput();
      if (Buffer.byteLength(input) > 64 * 1024) throw new DaemonProviderError("input_too_large");
      let value: unknown;
      try { value = JSON.parse(input); } catch { throw new DaemonProviderError("invalid_json"); }
      deps.print(JSON.stringify({ ok: true, ...store.upsert(value, Number(rest[1])) }));
    }
    return 0;
  } catch (error) {
    // Raw fs/parser errors can contain file content or paths. Only fixed codes
    // leave this boundary; credentials never appear in errors or receipts.
    deps.print(JSON.stringify({ ok: false, error: error instanceof DaemonProviderError ? error.code : "provider_store_unavailable" }));
    return 1;
  }
}
