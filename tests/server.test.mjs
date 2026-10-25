// Author: jperch1987
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildCommands, createProfileServer } from '../server.mjs';
import { buildConsoleTarget } from '../console-target.mjs';

const execFileAsync = promisify(execFile);
const exampleConfig = `[default]
region = us-east-1
aws_access_key_id = DO_NOT_RETURN_ACCESS_KEY
aws_secret_access_key = DO_NOT_RETURN_SECRET_KEY

[profile dev]
role_arn = arn:aws:iam::123456789012:role/Developer
source_profile = default
region = ap-southeast-1
`;

function request(server, requestPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: requestPath,
      method, headers, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('Test request timed out.')));
    req.on('error', reject);
    req.end(body);
  });
}

async function close(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function fixture(t, config = exampleConfig) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'profile-switcher-test-'));
  const configFile = path.join(directory, 'config.txt');
  const stateDirectory = path.join(directory, 'state');
  let server;
  t.after(async () => {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  });
  if (config !== null) await writeFile(configFile, config);
  async function start() {
    server = createProfileServer({ configFile, stateDirectory, python: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3') });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }
  await start();
  return {
    configFile,
    request: (url, options) => request(server, url, options),
    async restart() { await close(server); await start(); },
    async select(profile, token) {
      return request(server, '/api/active', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ profile }),
      });
    },
  };
}

function assertConsoleUrl(target, accountId, roleName) {
  assert.equal(target.reason, null);
  assert.equal(target.accountId, accountId);
  assert.equal(target.roleName, roleName);
  const url = new URL(target.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'signin.aws.amazon.com');
  assert.equal(url.port, '');
  assert.equal(url.pathname, '/switchrole');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['account', 'roleName']);
  assert.equal(url.searchParams.get('account'), accountId);
  assert.equal(url.searchParams.get('roleName'), roleName);
}

test('lists metadata and console links, persists selection, and leaves config untouched', async (t) => {
  const app = await fixture(t);
  const listing = await app.request('/api/profiles');
  assert.equal(listing.status, 200);
  assert.equal(listing.headers['cache-control'], 'no-store');
  assert.doesNotMatch(listing.text, /DO_NOT_RETURN|aws_access_key_id|aws_secret_access_key/);
  const data = listing.json();
  assert.equal(data.activeProfile, null);
  assert.deepEqual(data.profiles.map((profile) => profile.profile).sort(), ['default', 'dev']);
  const dev = data.profiles.find((profile) => profile.profile === 'dev');
  assert.equal(dev.role_arn, 'arn:aws:iam::123456789012:role/Developer');
  assert.equal(dev.source_profile, 'default');
  assert.equal(dev.region, 'ap-southeast-1');
  assertConsoleUrl(dev.console, '123456789012', 'Developer');
  const base = data.profiles.find((profile) => profile.profile === 'default');
  assert.equal(base.console.url, null);
  assert.equal(typeof base.console.reason, 'string');
  const selected = await app.select('dev', data.token);
  assert.equal(selected.status, 200);
  assert.deepEqual(selected.json().profile, dev);
  assert.match(selected.json().commands.posix, /AWS_PROFILE='dev'/);
  await app.restart();
  assert.deepEqual((await app.request('/api/active')).json().profile, dev);
  assert.equal((await app.request('/api/profiles')).json().activeProfile, 'dev');
  assert.equal(await readFile(app.configFile, 'utf8'), exampleConfig);
});

test('refresh reads file changes and invalidates a selection removed from the file', async (t) => {
  const app = await fixture(t);
  const { token } = (await app.request('/api/profiles')).json();
  assert.equal((await app.select('dev', token)).status, 200);
  await writeFile(app.configFile, exampleConfig.replace('ap-southeast-1', 'eu-west-1'));
  assert.equal((await app.request('/api/active')).json().profile.region, 'eu-west-1');
  const updated = '[profile production]\nrole_arn = arn:aws:iam::210987654321:role/teams/ReadOnly\nregion = eu-west-1\n';
  await writeFile(app.configFile, updated);
  const refreshed = (await app.request('/api/profiles')).json();
  assert.deepEqual(refreshed.profiles.map((profile) => profile.profile), ['production']);
  assert.equal(refreshed.profiles[0].region, 'eu-west-1');
  assertConsoleUrl(refreshed.profiles[0].console, '210987654321', 'teams/ReadOnly');
  assert.equal(refreshed.activeProfile, null);
  assert.deepEqual((await app.request('/api/active')).json(), { profile: null, commands: null });
  assert.equal((await app.select('dev', token)).status, 404);
  assert.equal((await app.select('production', token)).status, 200);
  assert.equal(await readFile(app.configFile, 'utf8'), updated);
});

test('rejects missing tokens, foreign origins, cross-site requests, and untrusted Host values', async (t) => {
  const app = await fixture(t);
  const { token } = (await app.request('/api/profiles')).json();
  const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"profile":"dev"}' };
  assert.equal((await app.request('/api/active', post)).status, 403);
  assert.equal((await app.select('dev', 'wrong-token')).status, 403);
  assert.equal((await app.request('/api/active', {
    ...post, headers: { ...post.headers, 'x-csrf-token': token, origin: 'https://example.invalid' },
  })).status, 403);
  assert.equal((await app.request('/api/profiles', { headers: { origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await app.request('/api/profiles', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await app.request('/api/profiles', { headers: { host: 'example.invalid' } })).status, 403);
  assert.equal((await app.request('/api/profiles')).status, 200);
  assert.equal((await app.request('/api/active')).json().profile, null);
});

test('returns safe errors for missing and malformed configs', async (t) => {
  const app = await fixture(t, null);
  const missing = await app.request('/api/profiles');
  assert.equal(missing.status, 422);
  assert.equal(typeof missing.json().error, 'string');
  assert.doesNotMatch(missing.text, /Traceback|FileNotFoundError/);
  await writeFile(app.configFile, 'DO_NOT_LEAK_MALFORMED_CONFIG_SECRET\n');
  const malformed = await app.request('/api/profiles');
  assert.equal(malformed.status, 422);
  assert.equal(typeof malformed.json().error, 'string');
  assert.doesNotMatch(malformed.text, /DO_NOT_LEAK|Traceback|MissingSectionHeaderError/);
});

test('serves only allowlisted public files', async (t) => {
  const app = await fixture(t);
  const script = await app.request('/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /javascript/);
  for (const url of ['/server.mjs', '/console-target.mjs', '/profiles.py', '/profiles.txt', '/../server.mjs', '/%2e%2e/server.mjs', '/public/../server.mjs', '/.state/active-profile.json']) {
    const response = await app.request(url);
    assert.equal(response.status, 404, `${url} must not serve a private file`);
    assert.deepEqual(response.json(), { error: 'Not found.' });
  }
});

test('generated POSIX commands preserve literal values and clear credential and region overrides', { skip: process.platform === 'win32' }, async () => {
  const profile = { profile: "team's $(printf substituted) `printf substituted`; [test] \\ $HOME", region: 'ap-southeast-1' };
  const configFile = "/tmp/config's $(printf substituted) `printf substituted` file.txt";
  const stale = {
    ...process.env, PROFILE_SWITCHER_TEST_NODE: process.execPath,
    AWS_ACCESS_KEY_ID: 'stale-key', AWS_SECRET_ACCESS_KEY: 'stale-secret',
    AWS_SESSION_TOKEN: 'stale-token', AWS_SECURITY_TOKEN: 'stale-token',
    AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/Stale',
    AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/stale-web-identity-token', AWS_ROLE_SESSION_NAME: 'stale-session',
    AWS_PROFILE: 'stale-profile', AWS_DEFAULT_PROFILE: 'stale-profile',
    AWS_REGION: 'stale-region', AWS_DEFAULT_REGION: 'stale-region',
  };
  async function evaluate(selected) {
    const commands = buildCommands(selected, configFile);
    const script = `${commands.posix}\nexec "$PROFILE_SWITCHER_TEST_NODE" -e 'process.stdout.write(JSON.stringify(process.env))'`;
    const { stdout } = await execFileAsync('/bin/sh', ['-c', script], { env: stale });
    return JSON.parse(stdout);
  }
  const env = await evaluate(profile);
  assert.equal(env.AWS_PROFILE, profile.profile);
  assert.equal(env.AWS_DEFAULT_PROFILE, profile.profile);
  assert.equal(env.AWS_CONFIG_FILE, configFile);
  assert.equal(env.AWS_REGION, profile.region);
  assert.equal(env.AWS_DEFAULT_REGION, profile.region);
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
    'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_SESSION_NAME']) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must be unset`);
  }
  const withoutRegion = await evaluate({ profile: 'default', region: null });
  assert.equal(Object.hasOwn(withoutRegion, 'AWS_REGION'), false);
  assert.equal(Object.hasOwn(withoutRegion, 'AWS_DEFAULT_REGION'), false);
});

test('console targets encode IAM paths as data and ignore unrelated profile fields', () => {
  const roleName = 'team&account=999999999999?/%2F/Developer';
  const target = buildConsoleTarget({
    profile: 'https://example.invalid/#profile',
    role_arn: `arn:aws:iam::123456789012:role/${roleName}`,
    source_profile: '&redirect_uri=https://example.invalid/',
    region: 'us-east-1&displayName=Injected',
  });
  assertConsoleUrl(target, '123456789012', roleName);
  assert.match(target.url, /%26/);
  assert.match(target.url, /%3F/);
  assert.match(target.url, /%252F/);
});

test('console targets reject unsupported partitions, malformed ARNs, and long role paths', () => {
  for (const role_arn of [
    '', 'https://example.invalid/',
    'arn:aws:iam::12345678901:role/Developer',
    'arn:aws:iam::1234567890123:role/Developer',
    'arn:aws:iam::12345678901x:role/Developer',
    'arn:aws:iam::123456789012&account=999999999999:role/Developer',
    'arn:aws:iam::123456789012:user/Developer',
    'arn:aws:iam::123456789012:role/',
    'arn:aws:iam::123456789012:role/Developer?redirect_uri=evil',
    'arn:aws:iam::123456789012:role/Developer\n',
    'arn:aws-us-gov:iam::123456789012:role/Developer',
    'arn:aws-cn:iam::123456789012:role/Developer',
    `arn:aws:iam::123456789012:role/team/${'a'.repeat(60)}`,
  ]) {
    const target = buildConsoleTarget({ role_arn });
    assert.equal(target.url, null, `Unexpected console URL for ${JSON.stringify(role_arn)}`);
    assert.equal(typeof target.reason, 'string');
    assert.ok(target.reason.length > 0);
  }
  const boundary = `team/${'a'.repeat(59)}`;
  assertConsoleUrl(buildConsoleTarget({ role_arn: `arn:aws:iam::123456789012:role/${boundary}` }), '123456789012', boundary);
  assert.equal(buildConsoleTarget({}).url, null);
});
