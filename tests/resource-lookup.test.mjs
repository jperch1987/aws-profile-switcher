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
    request({ profiles: Array.from({ length: 251 }, (_, i) => `p${i}`) }), request({ query: '' }), request({ query: 'x'.repeat(257) }),
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

function certificateEvent(profile = 'dev', count = 1, region = 'eu-west-1') {
  const row = event(profile);
  row.check.region = region;
  row.results = Array.from({ length: count }, (_, index) => {
    const resourceId = `12345678-1234-1234-1234-${index.toString(16).padStart(12, '0')}`;
    return { profile, accountId: row.check.accountId, region, resourceType: 'acm', resourceId,
      name: `service-${index}.example.com`, arn: `arn:aws:acm:${region}:${row.check.accountId}:certificate/${resourceId}`,
      certificate: { type: 'IMPORTED', status: 'ISSUED', keyAlgorithm: 'RSA_4096', inUse: true,
        notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z' } };
  });
  return row;
}

test('ACM inventory requires a strict chosen region and empty query before spawning', (t) => {
  const { manager, children } = fixture(t);
  const body = request({ resourceType: 'acm', query: '', region: 'eu-west-1' });
  for (const region of [undefined, null, 42, '', 'EU-WEST-1', 'eu-west-1\n', 'eu-west-1\r', ' eu-west-1', 'eu-west-1 ',
    'us-gov-west-1', 'cn-north-1', 'https://acm.eu-west-1.amazonaws.com', 'eu-west-1'.repeat(10), 'eu-west-１']) {
    assert.throws(() => manager.start({ ...body, region }, profiles));
  }
  const missing = { ...body }; delete missing.region;
  assert.throws(() => manager.start(missing, profiles));
  for (const query of [' ', '*', 'example.com', null, 12]) assert.throws(() => manager.start({ ...body, query }, profiles));
  assert.throws(() => manager.start({ ...body, extra: true }, profiles));
  assert.throws(() => manager.start(request({ region: 'eu-west-1' }), profiles), 'non-inventory lookups do not accept a region override');
  assert.throws(() => manager.start(body, [profiles[0], { ...profiles[1], source_profile: 'other' }]), /same source/);
  assert.equal(children.length, 0);
  const before = structuredClone(profiles);
  const scope = validateLookupRequest(body, profiles);
  assert.equal(scope.region, 'eu-west-1');
  assert.equal(scope.query, '');
  assert.ok(scope.profiles.every((target) => target.region === 'eu-west-1'));
  assert.deepEqual(profiles, before, 'the selected inventory region never rewrites profile metadata');
});

test('ACM inventory forwards one region, retains only certificate metadata, and reports empty accounts', (t) => {
  const { manager, children, calls } = fixture(t);
  const body = request({ resourceType: 'acm', query: '', region: 'eu-west-1' });
  const started = manager.start(body, profiles);
  const child = children[0];
  assert.deepEqual(JSON.parse(child.input), body);
  assert.doesNotMatch(JSON.stringify(calls), /012345/);
  assert.equal(started.region, 'eu-west-1');
  assert.ok(started.profiles.every((target) => target.region === 'eu-west-1'));
  const first = certificateEvent('dev', 3);
  first.results[0].certificate.sdkSecret = 'DO_NOT_RETAIN';
  first.results[0].secret = 'DO_NOT_RETAIN';
  first.results[1].certificate = { type: 'AMAZON_ISSUED', status: 'PENDING_VALIDATION', keyAlgorithm: 'EC_prime256v1', inUse: false, notBefore: '', notAfter: '' };
  first.results[2].name = '';
  first.results[2].certificate = { type: '', status: '', keyAlgorithm: '', inUse: null, notBefore: '', notAfter: '' };
  child.event(first);
  const empty = certificateEvent('production', 0); empty.check.status = 'not_found';
  empty.check.message = 'No certificates were returned in this region.';
  child.event(empty); child.event({ event: 'complete' }); child.end();
  const snapshot = manager.get(started.id);
  assert.equal(snapshot.state, 'complete'); assert.equal(snapshot.results.length, 3);
  assert.equal(snapshot.results[0].certificate.type, 'IMPORTED');
  assert.equal(snapshot.results[1].certificate.keyAlgorithm, 'EC_prime256v1');
  assert.equal(snapshot.results[2].certificate.inUse, null);
  assert.deepEqual(Object.keys(snapshot.results[0].certificate).sort(), ['inUse', 'keyAlgorithm', 'notAfter', 'notBefore', 'status', 'type']);
  assert.equal(snapshot.checks[1].status, 'not_found');
  assert.doesNotMatch(JSON.stringify(snapshot), /DO_NOT_RETAIN|mfaCode|012345/);
});

test('ACM inventory rejects mismatched certificate identities, malformed metadata and duplicate rows', (t) => {
  const { manager, children } = fixture(t);
  const body = request({ profiles: ['dev'], resourceType: 'acm', query: '', region: 'eu-west-1' });
  for (const mutate of [
    (row) => { row.accountId = '999999999999'; },
    (row) => { row.region = 'us-east-1'; },
    (row) => { row.resourceId = row.resourceId.toUpperCase().replace('12345678', 'ABCDEF01'); },
    (row) => { row.resourceId += '\n'; },
    (row) => { row.resourceId += '\u2028'; row.arn += '\u2028'; },
    (row) => { row.arn = row.arn.replace('111111111111', '222222222222'); },
    (row) => { row.arn = row.arn.replace('eu-west-1', 'us-east-1'); },
    (row) => { row.arn += '/extra'; },
    (row) => { row.name = 'x'.repeat(254); },
    (row) => { row.name = 'bad\u2028name'; },
    (row) => { delete row.certificate; },
    (row) => { row.certificate = []; },
    (row) => { row.certificate.type = 'NEW_UNSUPPORTED_TYPE'; },
    (row) => { row.certificate.status = 'ISSUED\n'; },
    (row) => { row.certificate.keyAlgorithm = 'RSA_9999'; },
    (row) => { row.certificate.inUse = 'true'; },
    (row) => { row.certificate.notAfter = '2027-02-30T00:00:00.000Z'; },
    (row) => { row.certificate.notBefore = '2026-01-01T00:00:00+00:00'; },
    (row) => { row.certificate.notAfter = '2027-01-01T00:00:00.000Z\n'; },
    (row) => { delete row.certificate.notAfter; },
  ]) {
    const started = manager.start(body, profiles);
    const page = certificateEvent(); mutate(page.results[0]); children.at(-1).event(page);
    assert.equal(manager.get(started.id).state, 'error');
    assert.equal(manager.get(started.id).results.length, 0);
  }
  const started = manager.start(body, profiles);
  const duplicate = certificateEvent(); duplicate.results.push(structuredClone(duplicate.results[0]));
  children.at(-1).event(duplicate);
  assert.equal(manager.get(started.id).state, 'error');
});

test('ACM inventory permits bounded large result sets and preserves partial coverage on limits', (t) => {
  const { manager, children } = fixture(t);
  const body = request({ resourceType: 'acm', query: '', region: 'eu-west-1' });
  const started = manager.start(body, profiles);
  const first = certificateEvent('dev', 5000);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) > 2 * 1024 * 1024, 'ACM needs a larger per-profile line limit');
  first.check.status = 'error'; first.check.message = 'The inventory reached its result limit. This check is incomplete.';
  children[0].event(first);
  children[0].event(certificateEvent('production', 5000));
  children[0].event({ event: 'complete' }); children[0].end();
  const result = manager.get(started.id);
  assert.equal(result.state, 'complete'); assert.equal(result.results.length, 10000);
  assert.equal(result.checks[0].status, 'error');

  const perProfile = manager.start(body, profiles);
  children.at(-1).event(certificateEvent('dev', 5001));
  assert.equal(manager.get(perProfile.id).state, 'error');

  const moreProfiles = [...profiles, { ...profiles[0], profile: 'third' }];
  const globalLimit = manager.start({ ...body, profiles: moreProfiles.map((profile) => profile.profile) }, moreProfiles);
  const child = children.at(-1);
  child.event(certificateEvent('dev', 5000)); child.event(certificateEvent('production', 5000));
  const extra = certificateEvent(); extra.check.profile = 'third'; extra.results[0].profile = 'third';
  child.event(extra);
  const stopped = manager.get(globalLimit.id);
  assert.equal(stopped.state, 'error'); assert.equal(stopped.results.length, 10000);
  assert.equal(stopped.checks.at(-1).status, 'skipped');
});

test('all 250 profiles can be selected and every account receives a completion status', (t) => {
  const { manager, children } = fixture(t);
  const scope = Array.from({ length: 250 }, (_, index) => ({ ...profiles[0], profile: `account-${index}` }));
  const started = manager.start(request({ profiles: scope.map((item) => item.profile) }), scope);
  assert.equal(started.total, 250);
  assert.equal(JSON.parse(children[0].input).profiles.length, 250);
  for (const target of scope) children[0].event({ event: 'profile', check: {
    profile: target.profile, accountId: '111111111111', region: 'us-east-1', status: 'not_found', message: 'No exact match.' }, results: [] });
  children[0].event({ event: 'complete' }); children[0].end();
  assert.equal(manager.get(started.id).state, 'complete');
  assert.equal(manager.get(started.id).completed, 250);
});

test('new resource types accept regional results and Route 53 requires global results', (t) => {
  const { manager, children } = fixture(t);
  for (const resourceType of ['eks', 'elasticache', 'route53']) {
    const start = manager.start(request({ profiles: ['dev'], resourceType, query: 'example' }), profiles);
    const row = event();
    Object.assign(row.results[0], { resourceType, region: resourceType === 'route53' ? 'global' : 'us-east-1' });
    children.at(-1).event(row); children.at(-1).event({ event: 'complete' }); children.at(-1).end();
    assert.equal(manager.get(start.id).state, 'complete');
  }
  const start = manager.start(request({ profiles: ['dev'], resourceType: 'route53', query: 'example.com' }), profiles);
  const invalid = event(); invalid.results[0].resourceType = 'route53';
  children.at(-1).event(invalid);
  assert.equal(manager.get(start.id).state, 'error');
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

test('load balancer lookup retains confirmed matches on partial denial and enforces account and region', (t) => {
  const { manager, children } = fixture(t);
  const body = request({ profiles: ['dev'], resourceType: 'load-balancer', query: 'web-ingress' });
  const row = event();
  row.check.status = 'access_denied';
  row.check.message = 'One load balancer API could not be checked.';
  row.results = [{ profile: 'dev', accountId: '111111111111', region: 'us-east-1', resourceType: 'load-balancer',
    resourceId: 'app/web-ingress/0123456789abcdef', name: 'web-ingress',
    arn: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/app/web-ingress/0123456789abcdef' }];
  const start = manager.start(body, profiles);
  assert.equal(JSON.parse(children.at(-1).input).resourceType, 'load-balancer');
  children.at(-1).event(row); children.at(-1).event({ event: 'complete' }); children.at(-1).end();
  assert.equal(manager.get(start.id).state, 'complete');
  assert.equal(manager.get(start.id).results[0].name, 'web-ingress');
  assert.equal(manager.get(start.id).checks[0].status, 'access_denied');
  for (const invalidFields of [{ region: 'eu-west-1' }, { accountId: '222222222222' }]) {
    const started = manager.start(body, profiles);
    const invalid = structuredClone(row);
    Object.assign(invalid.results[0], invalidFields);
    children.at(-1).event(invalid);
    assert.equal(manager.get(started.id).state, 'error');
    assert.equal(manager.get(started.id).results.length, 0);
  }
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

function loadBalancerEvent(kind = 'app', dnsName = 'web-ingress-123.us-east-1.elb.amazonaws.com') {
  const row = event();
  Object.assign(row.results[0], { resourceType: 'load-balancer', resourceId: 'web-ingress', name: 'web-ingress', dnsName,
    arn: `arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/${kind === 'classic' ? 'web-ingress' : `${kind}/web-ingress/0123456789abcdef`}` });
  return row;
}

test('load balancer FQDN input accepts AWS hostnames and rejects unsupported destinations before spawning', (t) => {
  const { manager, children } = fixture(t);
  const body = request({ resourceType: 'load-balancer' });
  for (const query of ['web-ingress', 'internal-classic', 'web-ingress-123.us-east-1.elb.amazonaws.com',
    'internal-web-ingress-123.elb.us-east-1.amazonaws.com', 'DUALSTACK.Web-Ingress-123.us-east-1.elb.amazonaws.com.']) {
    assert.equal(validateLookupRequest({ ...body, query }, profiles).query, query);
  }
  for (const query of ['app.example.com', 'https://web-ingress-123.us-east-1.elb.amazonaws.com',
    'web-ingress-123.us-east-1.elb.amazonaws.com:443', 'web-ingress-123.us-east-1.elb.amazonaws.com/path',
    'web-ingress-123.us-east-1.elb.amazonaws.com.evil.example', '*.us-east-1.elb.amazonaws.com',
    'us-east-1a.web-ingress-123.elb.us-east-1.amazonaws.com', 'web_ingress.us-east-1.elb.amazonaws.com',
    'web-ingress-123.us-east-1.elb.amazonaws.com..', 'dualstack.dualstack.web-ingress-123.us-east-1.elb.amazonaws.com',
    'K-ingress-123.us-east-1.elb.amazonaws.com',
    'web-ingress-123.us-gov-west-1.elb.amazonaws.com', 'web-ingress-123.cn-north-1.elb.amazonaws.com.cn',
    `${'x'.repeat(64)}.us-east-1.elb.amazonaws.com`, 'web-ingress-123.not-a-region.elb.amazonaws.com']) {
    assert.throws(() => manager.start({ ...body, query }, profiles), /AWS-generated DNS hostname/);
  }
  assert.equal(children.length, 0);
});

test('load balancer DNS metadata survives polling with canonical matching and documented dualstack aliases', (t) => {
  const { manager, children } = fixture(t);
  for (const [kind, dnsName, query] of [
    ['app', 'web-ingress-123.us-east-1.elb.amazonaws.com', 'WEB-INGRESS-123.US-EAST-1.ELB.AMAZONAWS.COM.'],
    ['app', 'web-ingress-123.elb.us-east-1.amazonaws.com', 'dualstack.web-ingress-123.elb.us-east-1.amazonaws.com'],
    ['classic', 'web-ingress-123.us-east-1.elb.amazonaws.com', 'dualstack.web-ingress-123.us-east-1.elb.amazonaws.com'],
    ['net', 'internal-web-ingress-123.elb.us-east-1.amazonaws.com', 'internal-web-ingress-123.elb.us-east-1.amazonaws.com'],
    ['app', 'web-ingress-123.us-east-1.elb.amazonaws.com', 'web-ingress'],
  ]) {
    const started = manager.start(request({ profiles: ['dev'], resourceType: 'load-balancer', query }), profiles);
    const row = loadBalancerEvent(kind, dnsName); row.results[0].sdkSecret = 'PRIVATE_SDK_FIELD';
    const child = children.at(-1);
    assert.equal(JSON.parse(child.input).query, query);
    child.event(row); child.event({ event: 'complete' }); child.end();
    const result = manager.get(started.id);
    assert.equal(result.state, 'complete'); assert.equal(result.results[0].dnsName, dnsName);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SDK_FIELD|mfaCode/);
  }
});

test('load balancer DNS results require exact hostname, scoped identity and safe canonical metadata', (t) => {
  const { manager, children } = fixture(t);
  const dnsName = 'web-ingress-123.us-east-1.elb.amazonaws.com';
  const invalid = [
    (item) => { delete item.dnsName; },
    (item) => { item.dnsName = ''; },
    (item) => { item.dnsName = null; },
    (item) => { item.dnsName = { value: dnsName }; },
    (item) => { item.dnsName = 'app.example.com'; },
    (item) => { item.dnsName = dnsName.toUpperCase(); },
    (item) => { item.dnsName = dnsName + '.'; },
    (item) => { item.dnsName = dnsName + '\n'; },
    (item) => { item.dnsName = dnsName.replace('123', '124'); },
    (item) => { item.dnsName = dnsName.replace('us-east-1', 'eu-west-1'); },
    (item) => { item.arn = item.arn.replace('111111111111', '222222222222'); },
    (item) => { item.arn = item.arn.replace('us-east-1', 'eu-west-1'); },
    (item) => { item.arn = item.arn.replace('web-ingress', 'another-lb'); },
    (item) => { item.resourceId = 'another-lb'; },
  ];
  for (const mutate of invalid) {
    const started = manager.start(request({ profiles: ['dev'], resourceType: 'load-balancer', query: dnsName }), profiles);
    const row = loadBalancerEvent(); mutate(row.results[0]); children.at(-1).event(row);
    assert.equal(manager.get(started.id).state, 'error');
    assert.equal(manager.get(started.id).results.length, 0);
  }
  const started = manager.start(request({ profiles: ['dev'], resourceType: 'load-balancer', query: `dualstack.${dnsName}` }), profiles);
  children.at(-1).event(loadBalancerEvent('net'));
  assert.equal(manager.get(started.id).state, 'error', 'Network Load Balancers do not use Application/Classic dualstack alias equivalence');
});

test('confirmed load balancer DNS matches remain visible when inventory is incomplete', (t) => {
  const { manager, children } = fixture(t);
  const started = manager.start(request({ profiles: ['dev'], resourceType: 'load-balancer', query: 'web-ingress-123.us-east-1.elb.amazonaws.com' }), profiles);
  const row = loadBalancerEvent(); row.check.status = 'error';
  row.check.message = 'The scan reached its page limit; this check is incomplete.';
  children[0].event(row); children[0].event({ event: 'complete' }); children[0].end();
  const result = manager.get(started.id);
  assert.equal(result.results[0].dnsName, 'web-ingress-123.us-east-1.elb.amazonaws.com');
  assert.equal(result.checks[0].status, 'error');
});

function privateIpEvent(profile = 'dev', overrides = {}) {
  const row = event(profile);
  const target = row.results[0];
  Object.assign(target, { resourceType: 'private-ip', resourceId: 'eni-0123456789abcdef0', name: 'service-network',
    arn: `arn:aws:ec2:${target.region}:${target.accountId}:network-interface/eni-0123456789abcdef0`,
    network: { privateIpAddress: '10.0.1.25', vpcId: 'vpc-0123456789abcdef0', subnetId: 'subnet-0123456789abcdef0',
      interfaceType: 'interface', description: 'Application network interface', instanceId: 'i-0123456789abcdef0',
      instanceOwnerId: target.accountId, requesterId: '', requesterManaged: false, ...overrides } });
  return row;
}

test('private IP validation accepts only exact IPv4 literals before spawning or consuming MFA', (t) => {
  const { manager, children } = fixture(t);
  const body = request({ resourceType: 'private-ip' });
  for (const query of ['10.0.1.0/24', 'example.com', '::1', '::ffff:10.0.1.25', '10.0.01.25', '256.0.1.25', '10.0.1', '0xa000119', '10.0.1.*']) {
    assert.throws(() => manager.start({ ...body, query }, profiles), /exact private IPv4/);
  }
  assert.equal(children.length, 0);
  for (const query of ['10.0.1.25', '172.16.0.1', '192.168.1.25', '100.64.0.25']) {
    assert.equal(validateLookupRequest({ ...body, query }, profiles).query, query);
  }
  assert.equal(validateLookupRequest({ ...body, query: '  10.0.1.25  ' }, profiles).query, '10.0.1.25');
});

test('private IP metadata is allowlisted and overlapping addresses retain their account and VPC', (t) => {
  const { manager, children } = fixture(t);
  const started = manager.start(request({ resourceType: 'private-ip', query: '10.0.1.25' }), profiles);
  assert.equal(JSON.parse(children[0].input).query, '10.0.1.25');
  const first = privateIpEvent('dev', { credentials: 'DO_NOT_FORWARD' });
  const second = privateIpEvent('production', { vpcId: 'vpc-22222222222222222', instanceId: '', instanceOwnerId: 'amazon-aws', requesterManaged: null });
  children[0].event(first); children[0].event(second); children[0].event({ event: 'complete' }); children[0].end();
  const result = manager.get(started.id);
  assert.equal(result.state, 'complete'); assert.equal(result.results.length, 2);
  assert.equal(result.results[0].network.instanceId, 'i-0123456789abcdef0');
  assert.equal(result.results[1].accountId, '222222222222');
  assert.equal(result.results[1].network.vpcId, 'vpc-22222222222222222');
  assert.equal(result.results[1].network.requesterManaged, null);
  assert.equal(result.results[1].network.instanceOwnerId, 'amazon-aws');
  assert.equal(Object.keys(result.results[0].network).length, 9);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_FORWARD|credentials|mfaCode/);
  result.results[0].network.description = 'changed';
  assert.equal(manager.get(started.id).results[0].network.description, 'Application network interface');
});

test('private IP worker results reject mismatched identities and malformed network metadata', (t) => {
  const { manager, children } = fixture(t);
  const invalid = [
    (row) => { delete row.network; },
    (row) => { row.network = []; },
    (row) => { row.network.privateIpAddress = '10.0.1.26'; },
    (row) => { row.network.vpcId = 'vpc-bad'; },
    (row) => { row.network.subnetId = ''; },
    (row) => { row.network.instanceId = 'eni-0123456789abcdef0'; },
    (row) => { row.network.instanceOwnerId = 111111111111; },
    (row) => { row.network.requesterManaged = 'true'; },
    (row) => { delete row.network.requesterManaged; },
    (row) => { row.network.description = 'x'.repeat(1025); },
    (row) => { row.network.interfaceType = 'x'.repeat(129); },
    (row) => { row.network.requesterId = 'x'.repeat(257); },
    (row) => { row.network.description = 'bad\nvalue'; },
    (row) => { row.network.description = 'bad\u0085value'; },
    (row) => { row.network.description = 'bad\ud800value'; },
    (row) => { row.resourceId = 'i-0123456789abcdef0'; },
    (row) => { row.arn = row.arn.replace('111111111111', '222222222222'); },
    (row) => { row.region = 'eu-west-1'; },
  ];
  for (const mutate of invalid) {
    const started = manager.start(request({ profiles: ['dev'], resourceType: 'private-ip', query: '10.0.1.25' }), profiles);
    const row = privateIpEvent(); mutate(row.results[0]); children.at(-1).event(row);
    assert.equal(manager.get(started.id).state, 'error');
    assert.equal(manager.get(started.id).results.length, 0);
  }
});

test('private IP matches remain visible if a later page or account is denied', (t) => {
  const { manager, children } = fixture(t);
  const started = manager.start(request({ resourceType: 'private-ip', query: '10.0.1.25' }), profiles);
  const partial = privateIpEvent(); partial.check.status = 'access_denied';
  partial.check.message = 'AWS denied a required read operation. This check is incomplete.';
  children[0].event(partial);
  children[0].event({ event: 'profile', check: { profile: 'production', accountId: '222222222222', region: 'us-east-1', status: 'access_denied', message: 'AWS denied the request.' }, results: [] });
  children[0].event({ event: 'complete' }); children[0].end();
  const result = manager.get(started.id);
  assert.equal(result.state, 'complete'); assert.equal(result.results.length, 1);
  assert.ok(result.checks.every((check) => check.status === 'access_denied'));
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
