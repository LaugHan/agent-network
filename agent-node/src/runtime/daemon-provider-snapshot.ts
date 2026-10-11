// #906: read-only Provider inventory. Never accepts a remote path or command.
import { execFile } from "node:child_process";
import { getAnetBinAbs, minimalEnv } from "./create-node-daemon.js";
import { validateDaemonProviderSnapshot } from "../shared/daemon-provider-snapshot.js";

export type SnapshotDeps = {
  callCommHub: (name: string, args: Record<string, unknown>) => Promise<any>;
  workDir: string; alias: string; networkId: string; daemonId: string;
  warn: (message: string) => void;
  readSnapshot?: () => Promise<unknown>;
};
export async function readLocalProviderSnapshot(deps: Pick<SnapshotDeps, "workDir" | "alias" | "networkId" | "daemonId">) {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u.test(deps.alias) || !deps.networkId || !deps.daemonId) throw new Error("provider_snapshot_unavailable");
  // Existing daemon boot trust root pins the executable. Use Node directly,
  // minimal env (no inherited API keys / NODE_OPTIONS), no shell or secret argv.
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [getAnetBinAbs(), "daemon", "provider", "list", deps.alias],
      { cwd: deps.workDir, env: minimalEnv(), timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true },
      (error, stdout) => error ? reject(new Error("provider_snapshot_unavailable")) : resolve(stdout));
  });
  const { ok, ...snapshot } = JSON.parse(raw);
  if (ok !== true) throw new Error("provider_snapshot_unavailable");
  return validateDaemonProviderSnapshot(snapshot, deps.networkId, deps.daemonId);
}

const inFlight = new Map<string, { promise: Promise<void>; again: boolean }>();
export function reconcileProviderSnapshots(deps: SnapshotDeps): Promise<void> {
  const key = JSON.stringify([deps.networkId, deps.daemonId]);
  const running = inFlight.get(key); if (running) { running.again = true; return running.promise; }
  const state = { promise: Promise.resolve(), again: false };
  const run = (async () => {
    do {
      state.again = false;
      const pending = await deps.callCommHub("pull_daemon_provider_snapshots", {});
      if (!pending?.ok || !Array.isArray(pending.requests)) return; // old Hub capability: unsupported is not success
      for (const request of pending.requests.slice(0, 20)) {
        if (typeof request?.request_id !== "string" || !/^dps_[a-f0-9-]{36}$/.test(request.request_id)
          || !Number.isSafeInteger(request.expires_at) || request.expires_at <= Date.now()) continue;
        let snapshot: unknown;
        try {
          snapshot = validateDaemonProviderSnapshot(await (deps.readSnapshot ? deps.readSnapshot() : readLocalProviderSnapshot(deps)), deps.networkId, deps.daemonId);
        } catch {
          await deps.callCommHub("ack_daemon_provider_snapshot", { request_id: request.request_id, failed: true });
          continue;
        }
        await deps.callCommHub("ack_daemon_provider_snapshot", { request_id: request.request_id, snapshot });
      }
    } while (state.again);
  })().catch(() => { deps.warn("[daemon-provider] readback unavailable; pending requests can retry on reconnect"); })
    .finally(() => { inFlight.delete(key); });
  state.promise = run;
  inFlight.set(key, state);
  return run;
}
