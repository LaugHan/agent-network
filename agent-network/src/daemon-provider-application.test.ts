import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { DaemonProviderStore } from './daemon-provider-store';
import { applyDaemonProvider, providerNodeRevision, type ProviderApplicationLifecycle } from './daemon-provider-application';

// Transaction-core tests, not evidence of a real Codex process or live provider.
const roots: string[] = [];
const secret = 'fixture-906-key#with=literal-content';
const files = ['config.json', '.env', 'codex-home/config.toml', 'codex-home/auth.json'];
const bytes = (dir: string) => files.map(f => readFileSync(join(dir, f), 'utf8'));
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'apply906-')); roots.push(root);
  const daemon = join(root, 'daemon'), node = join(root, 'node');
  for (const dir of [daemon, node, join(node, 'codex-home')]) mkdirSync(dir, { mode: 0o700 });
  const put = (path: string, value: string) => writeFileSync(path, value, { mode: 0o600 });
  put(join(daemon, 'config.json'), JSON.stringify({ role: 'host_supervisor', node_id: 'daemon_a', network_id: 'net_a' }));
  put(join(node, 'config.json'), JSON.stringify({ node_id: 'node_a', alias: 'fixture', network_id: 'net_a', runtime: 'codex-app-server', model: 'old-model' }));
  put(join(node, '.env'), 'UNRELATED=value\n');
  put(join(node, 'codex-home/config.toml'), 'model = "old-model"\nmodel_provider = "openai"\n');
  put(join(node, 'codex-home/auth.json'), '{"fixture":"never-change-this-login"}');
  const store = new DaemonProviderStore(daemon);
  const provider = { id: 'custom', label: 'Fixture', enabled: true, runtimes: [{ runtime: 'codex-tui',
    auth: [{ id: 'work', kind: 'api_key', baseUrl: 'https://example.test/v1', key: secret, models: ['new-model'] }] }] };
  store.upsert(provider, 0);
  const request = { requestId: 'dpa_11111111-1111-4111-8111-111111111111', networkId: 'net_a', daemonId: 'daemon_a',
    nodeId: 'node_a', alias: 'fixture', nodeRevision: providerNodeRevision(node), revision: 1, providerId: 'custom', authId: 'work', model: 'new-model', confirmRestart: true as const };
  const calls: string[] = [];
  const lifecycle: ProviderApplicationLifecycle = { stopVerified: async () => { calls.push('stop'); },
    activate: async expected => { calls.push('activate'); return expected; }, restore: async () => { calls.push('restore'); } };
  return { root, daemon, node, store, provider, request, calls, lifecycle };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('private configuration transaction selects exact provider/model and never edits login state', async () => {
  const s = setup(), before = bytes(s.node);
  s.lifecycle.activate = async expected => {
    s.calls.push('activate');
    const config = JSON.parse(readFileSync(join(s.node, 'config.json'), 'utf8'));
    const toml = parse(readFileSync(join(s.node, 'codex-home/config.toml'), 'utf8')) as any;
    expect(config.model).toBe('new-model');
    expect(config.codexModelProvider).toBe(expected.runtimeProvider);
    expect(toml.model_provider).toBe(expected.runtimeProvider);
    expect(toml.model_providers[expected.runtimeProvider]).toMatchObject({ base_url: 'https://example.test/v1', env_key: 'DAEMON_PROVIDER_API_KEY', wire_api: 'responses' });
    expect(readFileSync(join(s.node, '.env'), 'utf8')).toContain(`${config.env.DAEMON_PROVIDER_API_KEY._envRef}=${secret}\n`);
    expect(() => s.store.upsert(s.provider, 1)).toThrow('provider_store_busy');
    return expected;
  };
  const result = await applyDaemonProvider(s.node, s.store, s.request, s.lifecycle);
  expect(result.status).toBe('applied'); expect(s.calls).toEqual(['stop', 'activate']);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(bytes(s.node)[3]).toBe(before[3]);
  expect(bytes(s.node)[1]).toContain('UNRELATED=value\n');
  for (const f of files) expect(statSync(join(s.node, f)).mode & 0o777).toBe(0o600);
  expect(existsSync(join(s.node, 'provider-application.json'))).toBe(false);
});

test('wrong runtime readback rolls back exact private bytes and restores the old runtime', async () => {
  const s = setup(), before = bytes(s.node);
  s.lifecycle.activate = async expected => { s.calls.push('activate'); return { ...expected, model: 'wrong-model' }; };
  await expect(applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).rejects.toThrow('application_failed_rolled_back');
  expect(s.calls).toEqual(['stop', 'activate', 'stop', 'restore']); expect(bytes(s.node)).toEqual(before);
  expect(existsSync(join(s.node, 'provider-application.json'))).toBe(false);
});

test('launcher observations do not invalidate intent and lost ACK replay does not restart again', async () => {
  const s = setup();
  s.lifecycle.activate = async expected => {
    s.calls.push('activate');
    const path = join(s.node, 'config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...config, codexAppServerPort: 40000, codexAppServerUrl: 'ws://127.0.0.1:40000', codexRecoveryVerification: { model: 'new-model' } }));
    return { ...expected, nodeRevision: providerNodeRevision(s.node) };
  };
  const first = await applyDaemonProvider(s.node, s.store, s.request, s.lifecycle);
  expect(await applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).toEqual(first);
  expect(s.calls).toEqual(['stop', 'activate']);
  await expect(applyDaemonProvider(s.node, s.store, { ...s.request, model: 'different' }, s.lifecycle)).rejects.toThrow('application_request_conflict');
});

test('failed activation after launcher metadata update still restores the old configuration', async () => {
  const s = setup(), before = bytes(s.node);
  s.lifecycle.activate = async () => {
    const path = join(s.node, 'config.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), codexAppServerPort: 40001 }));
    throw new Error('startup failed');
  };
  await expect(applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).rejects.toThrow('application_failed_rolled_back');
  expect(bytes(s.node)).toEqual(before);
});

test('stale node/store revision, wrong scope or model are rejected before stopping', async () => {
  const s = setup(), before = bytes(s.node);
  for (const delta of [{ nodeRevision: '0'.repeat(64) }, { revision: 0 }, { networkId: 'net_other' }, { nodeId: 'other' }, { model: 'not-configured' }]) {
    await expect(applyDaemonProvider(s.node, s.store, { ...s.request, ...delta }, s.lifecycle)).rejects.toThrow();
    expect(s.calls).toEqual([]); expect(bytes(s.node)).toEqual(before);
  }
});

test('unconfirmed stop leaves recovery journal and blocks automatic replay without touching config', async () => {
  const s = setup(), before = bytes(s.node);
  s.lifecycle.stopVerified = async () => { throw new Error('partial stop'); };
  await expect(applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).rejects.toThrow('application_recovery_required');
  expect(bytes(s.node)).toEqual(before);
  expect(statSync(join(s.node, 'provider-application.json')).mode & 0o777).toBe(0o600);
  await expect(applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).rejects.toThrow('application_recovery_required');
});

test('external changes during activation are not overwritten by rollback', async () => {
  const s = setup();
  s.lifecycle.activate = async () => { writeFileSync(join(s.node, '.env'), 'EXTERNAL=changed\n'); throw new Error('failure'); };
  await expect(applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).rejects.toThrow('application_recovery_required');
  expect(readFileSync(join(s.node, '.env'), 'utf8')).toBe('EXTERNAL=changed\n');
  expect(s.calls).toEqual(['stop', 'stop']);
  expect(existsSync(join(s.node, 'provider-application.json'))).toBe(true);
});
