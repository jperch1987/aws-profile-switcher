// Author: jperch1987
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createLookupManager, validateLookupRequest } from '../resource-lookup.mjs';

const profiles = ['dev', 'production'].map((profile, index) => ({ profile,
  role_arn: `arn:aws:iam::${index ? '222222222222' : '111111111111'}:role/Lookup`,
  region: 'us-east-1', source_profile: 'base', auth: { enabled: true, mfaSerial: 'arn:aws:iam::333333333333:mfa/test' } }));
const request = (changes = {}) => ({ profiles: ['dev', 'production'], resourceType: 'ec2', query: 'web-server', mfaCode: '012345', ...changes });
function worker() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.input = ''; child.kills = [];
  child.stdin.on('data', (chunk) => { child.input += chunk; });
  child.end = (code = 0) => { child.exitCode = code; child.emit('close', code); };
  child.kill = (signal = 'SIGTERM') => { child.kills.push(signal); queueMicrotask(() => child.end(1)); };
  child.event = (event) => child.stdout.write(JSON.stringify(event) + '\n');
  return child;
}
function fixture(t, options = {}) {
  const children = [];
  const calls = [];
  const manager = createLookupManager({ python: '/fake/python', configFile: '/fake/config', ...options,
    spawnProcess: (...args) => { calls.push(args); const child = worker(); children.push(child); return child; } });
  t.after(() => manager.close());
  return { manager, children, calls };
}
function event(profile = 'dev', changes = {}) {
  const target = profiles.find((item) => item.profile === profile);
  return { event: 'profile', check: { profile, accountId: target.role_arn.split(':')[4], region: target.region,
    status: 'found', message: 'Found a matching resource.' }, results: [{ profile, accountId: target.role_arn.split(':')[4],
    region: target.region, resourceType: 'ec2', resourceId: 'i-0123456789abcdef0', name: 'web-server',
    arn: `arn:aws:ec2:${target.region}:${target.role_arn.split(':')[4]}:instance/i-0123456789abcdef0` }], ...changes };
}
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('lookup validation limits scope and requires one source/MFA group before starting a worker', (t) => {
  const { manager, children } = fixture(t);
  for (const body of [null, [], request({ extra: true }), request({ profiles: [] }), request({ profiles: ['dev', 'dev'] }),
    request({ profiles: Array.from({ length: 26 }, (_, i) => `p${i}`) }), request({ query: '' }), request({ query: 'x'.repeat(257) }),
    request({ query: 'hello\nworld' }), request({ resourceType: 'arbitrary-service' }), request({ mfaCode: '12345' }), request({ profiles: ['missing'] })]) {
    assert.throws(() => manager.start(body, profiles));
  }
  assert.throws(() => manager.start(request(), [profiles[0], { ...profiles[1], source_profile: 'other' }]), /same source/);
  assert.throws(() => manager.start(request(), [profiles[0], { ...profiles[1], auth: { enabled: true, mfaSerial: 'different' } }]), /same source/);
  assert.throws(() => manager.start(request(), [profiles[0], { ...profiles[1], auth: { enabled: false } }]), /support IAM-user/);
  assert.equal(children.length, 0);
  assert.equal(validateLookupRequest(request({ query: '  web-server  ' }), profiles).query, 'web-server');
});

test('worker receives MFA only over stdin, metadata is allowlisted, and partial failures remain explicit', (t) => {
  const { manager, children, calls } = fixture(t);
  const started = manager.start(request(), profiles);
  const child = children[0];
  assert.match(started.id, /^[a-f0-9]{32}$/);
  assert.deepEqual(JSON.parse(child.input), request());
  assert.doesNotMatch(JSON.stringify(calls), /012345/);
  assert.equal(manager.running(), true);
  assert.throws(() => manager.start(request(), profiles), /already running/);
  child.stderr.write('PRIVATE_SOURCE_SECRET\n');
  const first = event(); first.extra = 'PRIVATE'; first.check.secret = 'PRIVATE'; first.results[0].credentials = 'PRIVATE';
  child.event(first);
  child.event({ event: 'profile', check: { profile: 'production', accountId: '222222222222', region: 'us-east-1', status: 'access_denied', message: 'The role cannot read this resource type.' }, results: [] });
  child.event({ event: 'complete' }); child.end();
  const result = manager.get(started.id);
  assert.equal(result.state, 'complete'); assert.equal(result.completed, 2); assert.equal(result.results.length, 1);
  assert.equal(result.checks[1].status, 'access_denied'); assert.equal(manager.running(), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|"012345"|credentials|mfaCode/);
  result.results.length = 0;
  assert.equal(manager.get(started.id).results.length, 1, 'callers cannot mutate stored metadata');
});

test('malformed, mismatched, duplicate and false no-match events stop the worker', (t) => {
  const { manager, children } = fixture(t);
  const mismatched = event(); mismatched.results[0].accountId = '999999999999';
  const wrongRegion = event(); wrongRegion.check.region = 'eu-west-1';
  const noMatches = event(); noMatches.check.status = 'not_found';
  const newline = event(); newline.results[0].name = 'bad\nname';
  for (const bad of [null, {}, mismatched, wrongRegion, noMatches, newline, { event: 'complete' }]) {
    const start = manager.start(request(), profiles); const child = children.at(-1);
    child.event(bad);
    assert.equal(manager.get(start.id).state, 'error'); assert.ok(child.kills.length);
    assert.equal(manager.get(start.id).results.length, 0);
  }
  const start = manager.start(request(), profiles); const child = children.at(-1);
  child.event(event()); child.event(event());
  assert.equal(manager.get(start.id).state, 'error'); assert.equal(manager.get(start.id).results.length, 1);
});

test('S3 results use verified bucket region while checks keep the configured scope', (t) => {
  const { manager, children } = fixture(t);
  const start = manager.start(request({ profiles: ['dev'], resourceType: 's3', query: 'example-bucket' }), profiles);
  const row = event(); row.results[0] = { profile: 'dev', accountId: '111111111111', region: 'eu-west-1', resourceType: 's3', resourceId: 'example-bucket', name: 'example-bucket', arn: 'arn:aws:s3:::example-bucket' };
  children[0].event(row); children[0].event({ event: 'complete' }); children[0].end();
  assert.equal(manager.get(start.id).state, 'complete');
  assert.equal(manager.get(start.id).checks[0].region, 'us-east-1');
  assert.equal(manager.get(start.id).results[0].region, 'eu-west-1');
});

test('bounded Unicode profile names support a full worker result page with ASCII-escaped JSON', (t) => {
  const { manager, children } = fixture(t);
  const name = '界'.repeat(2048);
  const scope = [{ ...profiles[0], profile: name }];
  const start = manager.start(request({ profiles: [name] }), scope);
  const page = event(); page.check.profile = name;
  page.results = Array.from({ length: 100 }, (_, index) => ({ ...page.results[0], profile: name, resourceId: `instance-${index}` }));
  const escaped = JSON.stringify(page).replace(/[^\x00-\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  assert.ok(escaped.length > 256 * 1024);
  children[0].stdout.write(escaped + '\n'); children[0].event({ event: 'complete' }); children[0].end();
  assert.equal(manager.get(start.id).state, 'complete'); assert.equal(manager.get(start.id).results.length, 100);
});

test('cancellation keeps known results, marks unsearched profiles, and ignores late output', async (t) => {
  const { manager, children } = fixture(t);
  const start = manager.start(request(), profiles); children[0].event(event());
  assert.throws(() => manager.cancel('f'.repeat(32)), /unavailable/);
  const cancelled = manager.cancel(start.id);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.completed, 2);
  assert.equal(cancelled.checks[1].status, 'skipped');
  children[0].event(event('production'));
  assert.equal(manager.get(start.id).results.length, 1);
  await delay(1);
  assert.deepEqual(children[0].kills, ['SIGTERM']);
  manager.start(request(), profiles);
  assert.throws(() => manager.get(start.id), /unavailable/);
});

test('deadlines and retention bound workers and metadata without claiming absence', async (t) => {
  const { manager, children } = fixture(t, { timeoutMs: 15, retentionMs: 30 });
  const start = manager.start(request(), profiles);
  await delay(22);
  const expired = manager.get(start.id);
  assert.equal(expired.state, 'error'); assert.match(expired.message, /timed out/);
  assert.ok(expired.checks.every((check) => check.status === 'skipped')); assert.ok(children[0].kills.length);
  await delay(40);
  assert.throws(() => manager.get(start.id), /unavailable or expired/);
});

test('worker crash, protocol overflow, startup error and shutdown expose no raw diagnostics', (t) => {
  const { manager, children } = fixture(t);
  for (const fail of [(child) => child.end(1), (child) => child.stdout.write('x'.repeat(3_000_000)),
    (child) => child.emit('error', new Error('PRIVATE_SOURCE_SECRET'))]) {
    const start = manager.start(request(), profiles); fail(children.at(-1));
    const result = manager.get(start.id); assert.equal(result.state, 'error');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SOURCE_SECRET|012345/);
  }
  manager.start(request(), profiles); manager.close(); manager.close();
  assert.equal(manager.running(), false);
  assert.throws(() => manager.start(request(), profiles), /shutting down/);
});
