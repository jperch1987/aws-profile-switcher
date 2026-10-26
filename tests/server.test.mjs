// Author: jperch1987
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildCommands, createProfileServer, authenticationTarget, validateFederationResult } from '../server.mjs';
import { buildConsoleTarget } from '../console-target.mjs';

const execFileAsync = promisify(execFile);
const exampleConfig = `[default]
region = us-east-1
mfa_serial = arn:aws:iam::123456789012:mfa/test-user
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

async function fixture(t, config = exampleConfig, serverOptions = {}) {
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
    server = createProfileServer({ configFile, stateDirectory, python: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ...serverOptions });
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
  assert.match(selected.json().commands.posix, /'--profile=dev'/);
  assert.match(selected.json().commands.posix, /aws_session\.py/);
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
  assert.equal((await app.select('production', token)).status, 422);
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
  for (const url of ['/server.mjs', '/console-target.mjs', '/profiles.py', '/aws_session.py', '/profiles.txt', '/../server.mjs', '/%2e%2e/server.mjs', '/public/../server.mjs', '/.state/active-profile.json']) {
    const response = await app.request(url);
    assert.equal(response.status, 404, `${url} must not serve a private file`);
    assert.deepEqual(response.json(), { error: 'Not found.' });
  }
});

test('CLI commands invoke the MFA helper literally and apply exports only on success', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'switch-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = path.join(directory, "helper's file.mjs");
  await writeFile(helper, String.raw`const args = process.argv.slice(2);
const quote = (v) => "'" + v.replaceAll("'", "'\\''") + "'";
process.stdout.write('export AWS_SESSION_TOKEN=' + quote(JSON.stringify(args)) + '\nexport AWS_ACCESS_KEY_ID=fresh-test-key\n');
if (args.includes('--profile=fail')) process.exit(1);
`);
  const configFile = "/tmp/config's $(printf substituted) `printf substituted` file.txt";
  const profile = { profile: "--team's $(printf substituted) `printf substituted`; [test] \\ $HOME", region: 'ap-southeast-1' };
  const stale = { ...process.env, AWS_ACCESS_KEY_ID: 'stale', AWS_SECRET_ACCESS_KEY: 'stale',
    AWS_SESSION_TOKEN: 'stale', AWS_PROFILE: 'stale', AWS_DEFAULT_PROFILE: 'stale',
    AWS_REGION: 'stale', AWS_DEFAULT_REGION: 'stale', AWS_ROLE_ARN: 'stale',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://localhost/TEST_ONLY', AWS_CONTAINER_AUTHORIZATION_TOKEN: 'TEST_ONLY' };
  const command = buildCommands(profile, configFile, process.execPath, helper).posix;
  const dump = `"${process.execPath}" -e 'process.stdout.write(JSON.stringify(process.env))'`;
  const output = await execFileAsync('/bin/sh', ['-c', `${command}\n${dump}`], { env: stale });
  const env = JSON.parse(output.stdout);
  assert.deepEqual(JSON.parse(env.AWS_SESSION_TOKEN), [`--file=${configFile}`, `--profile=${profile.profile}`, '--shell', 'posix']);
  assert.equal(env.AWS_ACCESS_KEY_ID, 'fresh-test-key');
  for (const key of ['AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ROLE_ARN']) assert.equal(env[key], undefined);
  const failed = buildCommands({profile:'fail'}, configFile, process.execPath, helper).posix;
  await assert.rejects(execFileAsync('/bin/sh', ['-c', failed], { env: stale }));
  const after = await execFileAsync('/bin/sh', ['-c', `${failed}\n${dump}`], { env: stale });
  assert.match(after.stderr, /AWS switch failed/);
  const failedEnv = JSON.parse(after.stdout);
  assert.equal(failedEnv.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(failedEnv.AWS_SESSION_TOKEN, undefined);
  assert.equal(failedEnv.AWS_CONTAINER_CREDENTIALS_FULL_URI, undefined);
  assert.equal(failedEnv.AWS_CONTAINER_AUTHORIZATION_TOKEN, undefined);
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

function fakeSession(profile) {
  const url = new URL('https://signin.aws.amazon.com/federation');
  url.searchParams.set('Action', 'login');
  url.searchParams.set('Destination', 'https://console.aws.amazon.com/console/home?region=us-east-1');
  url.searchParams.set('SigninToken', 'FAKE_TEST_SIGNIN_TOKEN');
  return { url: url.href, expiration: new Date(Date.now() + 3600000).toISOString(), roleArn: profile.role_arn };
}

test('direct console requires MFA and CSRF, requests a fresh session each time, and returns only launch fields', async (t) => {
  const calls = [];
  const app = await fixture(t, exampleConfig, { consoleSession: async (profile, code) => {
    calls.push({profile:profile.profile, code});
    return {...fakeSession(profile), credentials:'DO_NOT_RETURN_CREDENTIALS'};
  }});
  const {token} = (await app.request('/api/profiles')).json();
  const post = (body, csrf=token, extra={}) => app.request('/api/console', {method:'POST',
    headers:{'content-type':'application/json','x-csrf-token':csrf,...extra},body:JSON.stringify(body)});
  assert.equal((await post({profile:'dev',mfaCode:'012345'}, 'wrong')).status, 403);
  assert.equal((await post({profile:'dev',mfaCode:'012345'}, token, {origin:'https://foreign.invalid'})).status, 403);
  for (const mfaCode of [123456, '12345', '1234567', '１２３４５６', ' 12345', null]) {
    assert.equal((await post({profile:'dev',mfaCode})).status, 400);
  }
  assert.equal((await post({profile:'default',mfaCode:'123456'})).status, 422);
  assert.equal((await post({profile:'missing',mfaCode:'123456'})).status, 404);
  assert.deepEqual(calls, []);
  for (const mfaCode of ['012345','654321']) {
    const response = await post({profile:'dev',mfaCode});
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(response.json()).sort(), ['expiration','roleArn','url']);
    assert.doesNotMatch(response.text, /DO_NOT_RETURN_CREDENTIALS|012345|654321/);
  }
  assert.deepEqual(calls, [{profile:'dev',code:'012345'}, {profile:'dev',code:'654321'}]);
  assert.deepEqual((await app.request('/api/active')).json(), {profile:null,commands:null});
  assert.equal(await readFile(app.configFile, 'utf8'), exampleConfig);
});

test('console rejects concurrent attempts and unlocks after errors without leaking error details', async (t) => {
  let release;
  let entered;
  const started = new Promise((r) => {entered=r;});
  const app = await fixture(t, exampleConfig, {consoleSession: async () => {
    entered();
    await new Promise((r) => {release=r;});
    throw new Error('DO_NOT_LEAK_CREDENTIAL_OR_MFA');
  }});
  const {token} = (await app.request('/api/profiles')).json();
  const options = {method:'POST',headers:{'content-type':'application/json','x-csrf-token':token},body:'{"profile":"dev","mfaCode":"012345"}'};
  const pending = app.request('/api/console',options);
  await started;
  assert.equal((await app.request('/api/console',options)).status,409);
  release();
  const failed = await pending;
  assert.equal(failed.status,500);
  assert.doesNotMatch(failed.text,/DO_NOT_LEAK|012345/);
  const missing = await app.request('/api/console',{...options,body:'{"profile":"missing","mfaCode":"012345"}'});
  assert.equal(missing.status,404);
});

test('console validates federation destination, expiry and matching role before returning a session', async (t) => {
  let mode='url';
  const app = await fixture(t,exampleConfig,{consoleSession:async (profile) => {
    const result=fakeSession(profile);
    if(mode==='url')result.url='https://example.invalid/?secret=DO_NOT_LEAK';
    if(mode==='expired')result.expiration='2000-01-01T00:00:00Z';
    if(mode==='role')result.roleArn='arn:aws:iam::999999999999:role/Wrong';
    return result;
  }});
  const {token}=(await app.request('/api/profiles')).json();
  for(mode of ['url','expired','role']) {
    const response=await app.request('/api/console',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':token},body:'{"profile":"dev","mfaCode":"012345"}'});
    assert.equal(response.status,502);
    assert.doesNotMatch(response.text,/DO_NOT_LEAK|012345/);
  }
  const valid=fakeSession({role_arn:'arn:aws:iam::123456789012:role/Developer'});
  assert.deepEqual(validateFederationResult(valid),valid);
  for(const value of ['https://signin.aws.amazon.com.evil.invalid/federation', valid.url+'&Action=login',valid.url+'&Unexpected=1']) {
    assert.throws(()=>validateFederationResult({...valid,url:value}));
  }
});

test('MFA readiness uses role or source device without inferring browser authentication',()=>{
  const source={profile:'base',mfa_serial:'arn:aws:iam::123456789012:mfa/device'};
  const role={profile:'dev',source_profile:'base',role_arn:'arn:aws:iam::123456789012:role/Developer'};
  assert.equal(authenticationTarget(role,[source,role]).enabled,true);
  assert.equal(authenticationTarget(role,[source,role]).mfaSerial,source.mfa_serial);
  assert.equal(authenticationTarget(role,[role]).enabled,false);
  assert.equal(authenticationTarget({...role,mfa_serial:'GAHT12345678'},[role]).enabled,true);
  assert.equal(authenticationTarget(role,[{...source,role_arn:role.role_arn},role]).enabled,false);
  for (const override of [{region:'us-gov-west-1'},{mfa_serial:'arn:aws-cn:iam::123456789012:mfa/test'},{external_id:'x'},{role_arn:role.role_arn+'?bad'}]) {
    assert.equal(authenticationTarget({...role,...override},[source,role]).enabled,false);
  }
});

test('POSIX helper secrets are not echoed by xtrace and trace state is restored', { skip:process.platform==='win32' }, async(t)=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'switch-trace-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const helper=path.join(directory,'helper.mjs');
  await writeFile(helper,`process.stdout.write("export AWS_SECRET_ACCESS_KEY='TEST_ONLY_SECRET'\\nexport AWS_SESSION_TOKEN='TEST_ONLY_TOKEN'\\n"); if(process.argv.includes('--profile=fail'))process.exit(1);`);
  for(const profile of ['dev','fail']) {
    const command=buildCommands({profile},'/unused/config',process.execPath,helper).posix;
    const {stdout,stderr}=await execFileAsync('/bin/bash',['-xc',`${command}\ncase $- in *x*) printf 'trace-restored' ;; esac`]);
    assert.equal(stdout,'trace-restored');
    assert.doesNotMatch(stderr,/TEST_ONLY_SECRET|TEST_ONLY_TOKEN/);
  }
});
