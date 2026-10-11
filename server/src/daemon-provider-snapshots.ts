// #906: human-requested readback of ONE daemon's private Provider metadata.
// Hub registry is not a fallback. No credential values enter this protocol.
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { getUserNetworkRole } from "./auth";
import { validateDaemonProviderSnapshot } from "./shared/daemon-provider-snapshot";

type Human = { userId?: string | null; isNode: boolean; networkId: string | null };
type Daemon = { ok: false; error: string } | { ok: true; networkId: string; daemonNodeId: string; daemonAlias: string };
type Row = { request_id: string; network_id: string; daemon_node_id: string; status: string;
  created_at: number; expires_at: number; observed_at: number | null; snapshot_json: string | null; error: string | null };
const denied = (error: string) => ({ ok: false as const, error });
function authorize(h: Human) {
  if (h.isNode || !h.userId) return denied("user_token_required");
  if (!h.networkId || !["owner", "admin"].includes(getUserNetworkRole(h.userId, h.networkId) || "")) return denied("provider_admin_required");
  return null;
}
function daemonExists(networkId: string, nodeId: string): boolean {
  const node = db.get<{ config_snapshot: string }>(
    `SELECT n.config_snapshot FROM nodes n WHERE n.node_id=?1 AND n.network_id=?2
      AND EXISTS (SELECT 1 FROM api_tokens t WHERE t.network_id=n.network_id
        AND t.name='node:' || n.alias AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > datetime('now')))`, nodeId, networkId);
  try { return JSON.parse(node?.config_snapshot || "{}").role === "host_supervisor"; } catch { return false; }
}
function expire(networkId: string, daemonId?: string) {
  db.run(`UPDATE daemon_provider_snapshots SET status='expired', error='request_expired'
    WHERE network_id=?1 AND status='pending' AND expires_at <= ?2
    AND (?3 IS NULL OR daemon_node_id=?3)`, [networkId, Date.now(), daemonId ?? null]);
  db.run(`DELETE FROM daemon_provider_snapshots WHERE network_id=?1 AND expires_at < ?2`, [networkId, Date.now() - 7 * 86400_000]);
}
export function requestProviderSnapshot(h: Human, daemonId: string) {
  const refusal = authorize(h); if (refusal) return refusal;
  if (!daemonExists(h.networkId!, daemonId)) return denied("daemon_not_found");
  expire(h.networkId!, daemonId);
  // Repeated refresh clicks share the pending request; pending never means ready.
  const pending = db.get<Row>(`SELECT * FROM daemon_provider_snapshots WHERE network_id=?1 AND daemon_node_id=?2 AND status='pending' ORDER BY created_at DESC LIMIT 1`, h.networkId!, daemonId);
  if (pending) return { ok: true as const, request_id: pending.request_id, status: "pending", expires_at: pending.expires_at };
  const requestId = `dps_${randomUUID()}`, now = Date.now();
  db.run(`INSERT INTO daemon_provider_snapshots
    (request_id,network_id,daemon_node_id,requested_by,status,created_at,expires_at)
    VALUES (?1,?2,?3,?4,'pending',?5,?6) ON CONFLICT DO NOTHING`, [requestId, h.networkId!, daemonId, h.userId!, now, now + 120_000]);
  const accepted = db.get<Row>(`SELECT * FROM daemon_provider_snapshots WHERE network_id=?1 AND daemon_node_id=?2 AND status='pending'`, h.networkId!, daemonId);
  if (!accepted) return denied("provider_snapshot_busy");
  return { ok: true as const, request_id: accepted.request_id, status: "pending", expires_at: accepted.expires_at };
}
export function getProviderSnapshot(h: Human, requestId: string) {
  const refusal = authorize(h); if (refusal) return refusal;
  expire(h.networkId!);
  const row = db.get<Row>(`SELECT * FROM daemon_provider_snapshots WHERE request_id=?1 AND network_id=?2`, requestId, h.networkId!);
  if (!row) return denied("request_not_found");
  return { ok: true, request_id: row.request_id, daemon_node_id: row.daemon_node_id, status: row.status,
    expires_at: row.expires_at, observed_at: row.observed_at, error: row.error,
    snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) : null };
}
export function pullProviderSnapshots(d: Daemon) {
  if (!d.ok) return denied("caller_not_a_daemon");
  if (!daemonExists(d.networkId, d.daemonNodeId)) return denied("caller_not_a_daemon");
  expire(d.networkId, d.daemonNodeId);
  const requests = db.all<{ request_id: string; expires_at: number }>(`SELECT request_id,expires_at FROM daemon_provider_snapshots
    WHERE network_id=?1 AND daemon_node_id=?2 AND status='pending' ORDER BY created_at LIMIT 20`, d.networkId, d.daemonNodeId);
  return { ok: true, requests };
}
export function ackProviderSnapshot(d: Daemon, requestId: string, snapshot?: unknown, failed = false) {
  if (!d.ok || !daemonExists(d.networkId, d.daemonNodeId)) return denied("caller_not_a_daemon");
  expire(d.networkId, d.daemonNodeId);
  const row = db.get<Row>(`SELECT * FROM daemon_provider_snapshots WHERE request_id=?1 AND network_id=?2 AND daemon_node_id=?3`, requestId, d.networkId, d.daemonNodeId);
  if (!row) return denied("request_not_found");
  // First accepted receipt wins; reconnect replay cannot rewrite prior evidence.
  if (row.status !== "pending") return { ok: row.status === "succeeded" || row.status === "failed", status: row.status };
  let safe: unknown = null;
  if (failed && snapshot !== undefined) return denied("invalid_provider_snapshot");
  if (!failed) {
    try { safe = validateDaemonProviderSnapshot(snapshot, d.networkId, d.daemonNodeId); }
    catch { return denied("invalid_provider_snapshot"); }
  }
  db.run(`UPDATE daemon_provider_snapshots SET status=?1, snapshot_json=?2, error=?3, observed_at=?4
    WHERE request_id=?5 AND status='pending'`, [failed ? "failed" : "succeeded", safe ? JSON.stringify(safe) : null,
    failed ? "provider_snapshot_unavailable" : null, Date.now(), requestId]);
  const accepted = db.get<Row>("SELECT * FROM daemon_provider_snapshots WHERE request_id=?1", requestId);
  return { ok: true, status: accepted!.status };
}
