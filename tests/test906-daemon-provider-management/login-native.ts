import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { CodexStdioClient } from './codex-stdio-client';

// This is a protocol/isolated-start check, NOT a human login success test.
const home = '/tmp/test906-login-draft';
mkdirSync(home, { recursive: true, mode: 0o700 });
process.env.OPENAI_API_KEY = 'TEST-ONLY-parent-must-not-leak';
process.env.CODEX_HOME = '/tmp/wrong-parent-home';
assert.equal(Bun.spawnSync(['codex', '--version']).stdout.toString().trim(), 'codex-cli 0.159.2');
const schemaDir = '/tmp/test906-login-schema';
assert.equal(Bun.spawnSync(['codex', 'app-server', 'generate-json-schema', '--out', schemaDir]).exitCode, 0);
const params = JSON.parse(readFileSync(`${schemaDir}/v2/LoginAccountParams.json`, 'utf8'));
assert.ok(params.oneOf.some((v: any) => v.properties?.type?.enum?.includes('chatgptDeviceCode')));
const client = new CodexStdioClient();
client.on('error', () => {});
client.start({ binary: '/usr/local/bin/codex', cwd: home, replaceEnv: true,
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: home } });
try {
  await client.request('initialize', { clientInfo: { name: 'anet_login_contract', title: 'ANet isolated login check', version: '0.1' } });
  client.notify('initialized', {});
  const result = await client.request<any>('account/read', { refreshToken: false });
  assert.equal(result.account, null, 'no inherited API key or host account');
  console.log('PASS native Codex 0.159.2 device-code schema + isolated account/read (no real login)');
} finally { await client.close(); }
