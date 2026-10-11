// #906 local transaction core. Transport must resolve nodeDir from the daemon's
// trusted registry and revalidate Hub ownership, never accept a remote path.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { DaemonProviderError, DaemonProviderStore } from './daemon-provider-store';
import { atomicWritePrivateFile, atomicWritePrivateJson } from './private-state';
import { resolveNodeCodexHome } from './codex-home-enforce';
import { mergeCodexProviderToml } from './provider-presets';
import { planPlainSecretEnvRewrites } from './claude-vendor-env';

const fail = (code: string): never => { throw new DaemonProviderError(code); };
function privateDir(path: string) {
  const s = lstatSync(path);
  if (!s.isDirectory() || realpathSync(path) !== resolve(path) || (process.getuid && s.uid !== process.getuid())
    || (process.platform !== 'win32' && (s.mode & 0o022))) fail('unsafe_node_directory');
}
function privateText(path: string): string | null {
  privateDir(dirname(path));
  let before;
  try { before = lstatSync(path); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('unsafe_node_file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const s = fstatSync(fd);
    if (s.dev !== before.dev || s.ino !== before.ino || s.nlink !== 1 || s.size > 1024 * 1024
      || (process.getuid && s.uid !== process.getuid()) || (process.platform !== 'win32' && (s.mode & 0o077))) fail('unsafe_node_file');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
const digest = (values: unknown) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
// Restart owns these observations. They may change without changing the node's
// requested identity/provider/model or any launch permissions/credentials.
const launchObservations = ['codexRecoveryVerification', 'codexRecoveryBackup', 'codexAppServerPort', 'codexAppServerUrl', 'session'];
function configIntent(raw: string | null, nodeDir: string) {
  const config = JSON.parse(raw ?? '{}');
  for (const key of launchObservations) delete config[key];
  if (config.codexHome === resolve(nodeDir, 'codex-home')) delete config.codexHome;
  return Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
}
type Files = Record<'config.json' | '.env' | 'codex-home/config.toml', string | null>;
function currentFiles(nodeDir: string): Files {
  return { 'config.json': privateText(join(nodeDir, 'config.json')), '.env': privateText(join(nodeDir, '.env')),
    'codex-home/config.toml': privateText(join(nodeDir, 'codex-home/config.toml')) };
}
/** Opaque CAS token, no paths, credentials or original configuration are returned. */
function filesRevision(files: Files, nodeDir: string) {
  return digest({ ...files, 'config.json': configIntent(files['config.json'], nodeDir) });
}
export function providerNodeRevision(nodeDir: string): string { return filesRevision(currentFiles(nodeDir), nodeDir); }
export function readProviderNodeConfig(nodeDir: string): Record<string, any> {
  return JSON.parse(privateText(join(nodeDir, 'config.json')) ?? '{}');
}
export function readProviderNodeToml(nodeDir: string) {
  return parse(privateText(join(nodeDir, 'codex-home/config.toml')) ?? '');
}

export type ProviderApplicationRequest = {
  requestId: string; networkId: string; daemonId: string; nodeId: string; alias: string;
  nodeRevision: string; revision: number; providerId: string; authId: string; model: string;
  confirmRestart: true;
};
export type ProviderActivation = { nodeId: string; model: string; runtimeProvider: string; nodeRevision: string };
export type ProviderApplicationLifecycle = {
  // Read-only checks before a recovery journal is created; no partial stop.
  preflight?: () => Promise<void>;
  // Must drain/refuse busy work, stop only this node and verify process exit.
  stopVerified: () => Promise<void>;
  // Must launch using the staged profile and check actual runtime evidence.
  activate: (expected: ProviderActivation) => Promise<ProviderActivation>;
  restore: () => Promise<void>;
};

/** Stop → private writes → verified activation. A crash leaves an explicit
 * private recovery journal; reconnect must NOT blindly replay the mutation. */
export async function applyDaemonProvider(nodeDir: string, store: DaemonProviderStore,
  request: ProviderApplicationRequest, lifecycle: ProviderApplicationLifecycle) {
  if (!/^dpa_[a-f0-9-]{36}$/.test(request.requestId) || request.confirmRestart !== true
    || !/^[a-f0-9]{64}$/.test(request.nodeRevision)) fail('invalid_application_request');
  const scope = store.list();
  if (scope.network_id !== request.networkId || scope.daemon_node_id !== request.daemonId
    || request.nodeId === request.daemonId) fail('application_scope_mismatch');
  privateDir(nodeDir);
  const journal = join(nodeDir, 'provider-application.json');
  const receiptPath = join(nodeDir, 'provider-application-receipt.json');
  const lock = join(nodeDir, 'provider-application.lock');
  let fd: number;
  try { fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch { throw new DaemonProviderError('application_busy'); }
  try {
    // Check under the lock: a previous transaction may have left recovery
    // state between our initial inspection and acquiring this lock.
    if (existsSync(journal)) fail('application_recovery_required');
    const requestHash = digest(request);
    const priorReceipt = JSON.parse(privateText(receiptPath) ?? 'null');
    if (priorReceipt?.receipt?.request_id === request.requestId) {
      if (priorReceipt.request_hash !== requestHash) fail('application_request_conflict');
      if (providerNodeRevision(nodeDir) !== priorReceipt.receipt.node_revision) fail('node_revision_conflict');
      return priorReceipt.receipt; // Lost ACK: historical receipt, no second restart.
    }
    return await store.withApiKey(request, async selected => {
      const before = currentFiles(nodeDir);
      if (filesRevision(before, nodeDir) !== request.nodeRevision) fail('node_revision_conflict');
      const config = JSON.parse(before['config.json'] ?? '{}');
      if (config.node_id !== request.nodeId || (config.alias ?? config.node_name) !== request.alias
        || config.network_id !== request.networkId || config.runtime !== 'codex-app-server'
        || config.role === 'host_supervisor') fail('node_identity_mismatch');
      if (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env))) fail('invalid_node_environment');
      // First mutation path requires an exclusive node-owned home. Shared or
      // external homes need explicit ownership support; never edit a neighbour.
      if (resolveNodeCodexHome({ nodeDir, config }).codexHome !== resolve(nodeDir, 'codex-home')) fail('exclusive_codex_home_required');
      const oldToml = before['codex-home/config.toml'] ?? '';
      const original = parse(oldToml); // invalid TOML fails before stopping or changing anything
      if (original.profile) fail('incompatible_profile_override');
      const runtimeProvider = `anet_${digest([selected.providerId, selected.authId]).slice(0, 20)}`;
      const envKey = 'DAEMON_PROVIDER_API_KEY';
      const [secret] = planPlainSecretEnvRewrites({ env: { [envKey]: selected.key }, nodeId: request.nodeId });
      const dotenv = (before['.env'] ?? '').split(/\r?\n/).filter(line => !new RegExp(`^\\s*(?:export\\s+)?${secret.refName}\\s*=`).test(line));
      // Existing dotenv reader is line-oriented. Preserve unrelated entries.
      const nextEnv = `${dotenv.join('\n').replace(/\n*$/, '')}\n${secret.refName}=${selected.key}\n`;
      const nextConfig = { ...config, model: selected.model, codexModelProvider: runtimeProvider,
        env: { ...config.env, [envKey]: { _envRef: secret.refName } } };
      const nextToml = mergeCodexProviderToml(oldToml, { family: 'codex', presetId: 'custom-openai-compat',
        providerId: runtimeProvider, label: selected.providerId, model: selected.model, profileModel: selected.model,
        baseUrl: selected.baseUrl, baseUrlExplicit: true, envKey, wireApi: 'responses' });
      const parsed = parse(nextToml) as any;
      const provider = parsed.model_providers?.[runtimeProvider];
      if (parsed.model !== selected.model || parsed.model_provider !== runtimeProvider || provider?.base_url !== selected.baseUrl
        || provider.env_key !== envKey || provider.requires_openai_auth === true || provider.auth || provider.experimental_bearer_token
        || provider.http_headers || provider.env_http_headers) fail('incompatible_provider_override');
      const after: Files = { 'config.json': JSON.stringify(nextConfig, null, 2) + '\n', '.env': nextEnv, 'codex-home/config.toml': nextToml };
      const expected = { nodeId: request.nodeId, model: selected.model, runtimeProvider, nodeRevision: filesRevision(after, nodeDir) };
      await lifecycle.preflight?.();
      if (providerNodeRevision(nodeDir) !== request.nodeRevision) fail('node_revision_conflict');
      // Journal includes prior private bytes for recovery, never a public receipt.
      atomicWritePrivateJson(journal, { schema: 1, request_id: request.requestId, node_id: request.nodeId,
        network_id: request.networkId, daemon_node_id: request.daemonId, before, after_revision: expected.nodeRevision });
      let stopped = false;
      try {
        await lifecycle.stopVerified(); stopped = true;
        if (providerNodeRevision(nodeDir) !== request.nodeRevision) fail('node_revision_conflict');
        for (const [name, body] of Object.entries(after)) atomicWritePrivateFile(join(nodeDir, name), body!);
        if (providerNodeRevision(nodeDir) !== expected.nodeRevision) fail('application_write_unconfirmed');
        const actual = await lifecycle.activate(expected);
        if (actual.nodeId !== expected.nodeId || actual.model !== expected.model || actual.runtimeProvider !== expected.runtimeProvider
          || actual.nodeRevision !== expected.nodeRevision) fail('runtime_application_unconfirmed');
        if (providerNodeRevision(nodeDir) !== expected.nodeRevision) fail('application_write_unconfirmed');
        const receipt = { status: 'applied' as const, request_id: request.requestId, node_id: request.nodeId,
          provider_id: selected.providerId, auth_id: selected.authId, model: selected.model, runtime_provider: runtimeProvider,
          node_revision: expected.nodeRevision, provider_revision: request.revision, verification: 'runtime_confirmed' as const,
          applied_at: Date.now() };
        atomicWritePrivateJson(receiptPath, { request_hash: requestHash, receipt });
        unlinkSync(journal);
        return receipt;
      } catch {
        // A failed stop can have partially stopped a process. Retain recovery
        // state instead of claiming the original runtime was left untouched.
        if (!stopped) fail('application_recovery_required');
        try {
          await lifecycle.stopVerified();
          // Never overwrite a concurrent external edit during rollback.
          const current = currentFiles(nodeDir);
          for (const name of Object.keys(before) as (keyof Files)[]) {
            if (name === 'config.json' && [before[name], after[name]].some(raw => digest(configIntent(raw, nodeDir)) === digest(configIntent(current[name], nodeDir)))) continue;
            if (current[name] !== before[name] && current[name] !== after[name]) fail('rollback_conflict');
          }
          for (const name of Object.keys(before) as (keyof Files)[]) {
            if (before[name] === null) { if (current[name] !== null) unlinkSync(join(nodeDir, name)); }
            else atomicWritePrivateFile(join(nodeDir, name), before[name]!);
          }
          await lifecycle.restore();
          unlinkSync(journal);
        } catch { fail('application_recovery_required'); }
        fail('application_failed_rolled_back');
      }
    });
  } finally { closeSync(fd); unlinkSync(lock); }
}
