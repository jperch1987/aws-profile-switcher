// Author: jperch1987
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const START_TIME = Date.parse('2030-01-01T00:00:00Z');
const JOB_ID = '0123456789abcdef0123456789abcdef';
const profiles = [
  { profile: 'dev', role_arn: 'arn:aws:iam::111111111111:role/ReadOnly', source_profile: 'base', region: 'us-east-1', auth: { enabled: true, mfaSerial: 'arn:aws:iam::999999999999:mfa/user' }, console: { url: 'https://signin.aws.amazon.com/switchrole?account=111111111111&roleName=ReadOnly' } },
  { profile: 'production', role_arn: 'arn:aws:iam::222222222222:role/ReadOnly', source_profile: 'base', region: 'eu-west-1', auth: { enabled: true, mfaSerial: 'arn:aws:iam::999999999999:mfa/user' }, console: { url: 'https://signin.aws.amazon.com/switchrole?account=222222222222&roleName=ReadOnly' } },
];
function response(body, ok = true) { return { ok, json: async () => body }; }
function snapshot({ state = 'running', names = ['dev', 'production'], resourceType = 'ec2', query = 'i-0123456789abcdef0', checks = [], results = [], message = 'Checking selected profiles.', expiresAt, list = profiles } = {}) {
  return { id: JOB_ID, state, query, resourceType, profiles: names.map((name) => {
    const profile = list.find((item) => item.profile === name);
    return { profile: name, accountId: profile.role_arn.match(/::([0-9]{12}):/)[1], region: profile.region };
  }), results, checks, completed: checks.length, total: names.length, message, ...(expiresAt ? { expiresAt } : {}) };
}
function check(index, status, message = status) {
  return { profile: profiles[index].profile, accountId: profiles[index].role_arn.match(/::([0-9]{12}):/)[1], region: profiles[index].region, status, message };
}
function result(index = 0, extra = {}) {
  return { profile: profiles[index].profile, accountId: profiles[index].role_arn.match(/::([0-9]{12}):/)[1], region: profiles[index].region, resourceType: 'ec2', resourceId: 'i-0123456789abcdef0', name: 'example-server', arn: '', ...extra };
}
function cliResult() {
  const values = { AWS_ACCESS_KEY_ID: 'TEST_KEY', AWS_SECRET_ACCESS_KEY: 'TEST_SECRET', AWS_SESSION_TOKEN: 'TEST_TOKEN', AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' };
  return { profile: profiles[0], roleArn: profiles[0].role_arn, expiration: new Date(START_TIME + 3600_000).toISOString(), commands: { posix: Object.entries(values).map(([key, value]) => `export ${key}='${value}'`).join('\n'), powershell: Object.entries(values).map(([key, value]) => `$Env:${key} = '${value}'`).join('\n') } };
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.events = new Map();
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.style = {};
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'href') delete this.href; }
  append(...elements) { for (const element of elements) { element.parent = this; this.children.push(...(element.tagName === 'FRAGMENT' ? element.children : [element])); } }
  replaceChildren(...elements) { this.children = []; this.append(...elements); }
  addEventListener(name, handler) { this.events.set(name, handler); }
  dispatch(name, fields = {}) { return this.events.get(name)?.({ preventDefault() {}, ...fields }); }
  querySelector() { return this.label ||= new Element('span'); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolledIntoView = true; }
  select() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
}

async function app({ list = profiles, start, poll, cancel, cli } = {}) {
  const elements = new Map([...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/g)].map((match) => [match[2], new Element(match[1])]));
  const requests = [];
  const timers = new Map();
  const windowEvents = new Map();
  let time = START_TIME;
  let timerId = 1;
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const tabs = ['posix', 'powershell'].map((shell) => Object.assign(new Element('button'), { dataset: { shell } }));
  const context = vm.createContext({
    URL, Set, Map, Date: ClockDate,
    setTimeout: (callback, delay) => { const id = timerId++; timers.set(id, { callback, due: time + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    navigator: { clipboard: { writeText: async () => {} } },
    window: { location: { href: 'http://127.0.0.1:3000/' }, addEventListener: (name, handler) => windowEvents.set(name, handler), open() { assert.fail('No programmatic browser windows'); } },
    document: {
      getElementById: (id) => { assert.ok(elements.has(id), `Missing DOM element ${id}`); return elements.get(id); },
      createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element('fragment'),
      querySelector: () => new Element('span'), querySelectorAll: () => tabs, addEventListener() {}, body: new Element('body'),
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/profiles') return response({ profiles: list, token: 'TEST_CSRF' });
      if (url === '/api/lookup' && options?.method === 'POST') return start ? start(options) : response(snapshot());
      if (url.startsWith('/api/lookup?id=')) return poll ? poll(url, options) : response(snapshot());
      if (url === '/api/lookup/cancel') return cancel ? cancel(options) : response(snapshot({ state: 'cancelled', checks: [check(0, 'skipped'), check(1, 'skipped')], message: 'Search cancelled.' }));
      if (url === '/api/cli') return cli ? cli(options) : response(cliResult());
      assert.fail(`Unexpected API ${url}`);
    },
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  const get = (id) => elements.get(id);
  assert.equal(get('notice').textContent, '');
  return {
    get, context, requests, windowEvents,
    async flush() { await new Promise(setImmediate); },
    async advance(milliseconds) { time += milliseconds; for (const [id, timer] of [...timers]) if (timer.due <= time && timers.has(id)) { timers.delete(id); timer.callback(); } await new Promise(setImmediate); },
    async search({ query = 'i-0123456789abcdef0', type = 'ec2', code = '000123' } = {}) { get('lookup-query').value = query; get('lookup-type').value = type; get('lookup-mfa').value = code; return get('lookup-submit').dispatch('click'); },
    choose(index, checked) { const input = get('lookup-profiles').children[index].children[0]; input.checked = checked; input.dispatch('change'); },
  };
}

test('lookup starts with explicit scopes grouped by source profile and MFA device, without AWS requests', async () => {
  const list = [...profiles,
    { ...profiles[0], profile: 'other-source', source_profile: 'other' },
    { ...profiles[0], profile: 'other-device', auth: { enabled: true, mfaSerial: 'arn:aws:iam::999999999999:mfa/other' } },
    { profile: 'base', role_arn: '', source_profile: '', region: 'us-east-1', auth: { enabled: false }, console: { url: null } },
  ];
  const ui = await app({ list });
  assert.deepEqual(ui.requests.map(({ url }) => url), ['/api/profiles']);
  assert.equal(ui.get('lookup-group').children.length, 3);
  assert.equal(ui.get('lookup-profiles').children.length, 2);
  assert.ok(ui.get('lookup-profiles').children.every((row) => row.children[0].checked));
  assert.match(ui.get('lookup-source-help').textContent, /1 profile needs/);
  assert.match(ui.get('lookup-region-help').textContent, /configured region/);
  ui.get('lookup-mfa').value = '000123';
  ui.get('lookup-group').value = ui.get('lookup-group').children[2].value;
  ui.get('lookup-group').dispatch('change');
  assert.equal(ui.get('lookup-profiles').children.length, 1);
  assert.equal(ui.get('lookup-profiles').children[0].children[0].value, 'other-device');
  assert.equal(ui.get('lookup-mfa').value, '');
  assert.match(ui.get('lookup-source-help').textContent, /mfa\/other/);
  assert.equal(ui.requests.length, 1);
});

test('Select all includes every profile beyond the former 25-profile limit, through 250', async () => {
  for (const total of [26, 250]) {
    const list = Array.from({ length: total }, (_, index) => ({ ...profiles[0], profile: `role-${index}` }));
    const ui = await app({ list, start: (options) => {
      const body = JSON.parse(options.body);
      return response(snapshot({ names: body.profiles, list }));
    } });
    assert.equal(ui.get('lookup-profiles').children.length, total);
    assert.equal(ui.get('lookup-select-all').disabled, false);
    assert.equal(ui.get('lookup-select-all').textContent, 'All selected');
    ui.get('lookup-select-none').dispatch('click');
    assert.ok(ui.get('lookup-profiles').children.every((row) => !row.children[0].checked));
    assert.equal(ui.get('lookup-select-all').textContent, 'Select all');
    assert.equal(ui.get('lookup-select-all').disabled, false);
    ui.get('lookup-mfa').value = '123456';
    ui.get('lookup-select-all').dispatch('click');
    assert.ok(ui.get('lookup-profiles').children.every((row) => row.children[0].checked));
    assert.equal(ui.get('lookup-select-all').textContent, 'All selected');
    assert.equal(ui.get('lookup-select-all').disabled, false);
    assert.equal(ui.get('lookup-submit').disabled, false);
    assert.equal(ui.get('lookup-mfa').value, '');
    assert.match(ui.get('lookup-scope-summary').textContent, new RegExp(`${total} of ${total} profiles selected`));
    await ui.search();
    const sent = JSON.parse(ui.requests.at(-1).options.body);
    assert.deepEqual(sent.profiles, list.map(({ profile }) => profile));
    assert.doesNotMatch(ui.get('lookup-status').textContent, /invalid lookup response/);
  }
});

test('more than 250 eligible profiles have an explained limit and are never silently selected or truncated', async () => {
  const list = Array.from({ length: 251 }, (_, index) => ({ ...profiles[0], profile: `role-${index}` }));
  const ui = await app({ list, start: (options) => {
    const body = JSON.parse(options.body);
    return response(snapshot({ names: body.profiles, list }));
  } });
  assert.equal(ui.get('lookup-profiles').children.length, 251);
  assert.ok(ui.get('lookup-profiles').children.every((row) => !row.children[0].checked));
  assert.match(ui.get('lookup-scope-summary').textContent, /250-profile search limit.*Select all is unavailable.*None have been selected automatically/);
  assert.equal(ui.get('lookup-select-all').disabled, true);
  await ui.search();
  assert.equal(ui.requests.length, 1);
  for (let index = 0; index < 251; index++) ui.choose(index, true);
  assert.equal(ui.get('lookup-submit').disabled, true);
  assert.match(ui.get('lookup-scope-summary').textContent, /251 of 251.*no more than 250/);
  await ui.search();
  assert.equal(ui.requests.length, 1);
  ui.choose(250, false);
  await ui.search();
  const sent = JSON.parse(ui.requests.at(-1).options.body);
  assert.equal(sent.profiles.length, 250);
  assert.deepEqual(sent.profiles, list.slice(0, 250).map(({ profile }) => profile));
});

test('lookup requires its own fresh six-digit MFA and validates bounded exact queries before sending', async () => {
  const ui = await app();
  ui.get('mfa-code').value = '654321';
  for (const code of ['', '12345', '1234567', '12 456', 'abcdef']) {
    await ui.search({ code });
    assert.equal(ui.get('lookup-mfa').value, '');
    assert.match(ui.get('lookup-status').textContent, /fresh six-digit/);
  }
  for (const query of ['', '   ', 'x'.repeat(257), 'name\nother']) {
    await ui.search({ query });
    assert.equal(ui.get('lookup-mfa').value, '');
    assert.match(ui.get('lookup-status').textContent, /up to 256/);
  }
  assert.deepEqual(ui.requests.map(({ url }) => url), ['/api/profiles']);
  await ui.search({ query: '  i-0123456789abcdef0  ', code: '001234' });
  assert.equal(ui.get('lookup-mfa').value, '');
  assert.equal(ui.get('mfa-code').value, '');
  assert.deepEqual(JSON.parse(ui.requests.at(-1).options.body), { profiles: ['dev', 'production'], resourceType: 'ec2', query: 'i-0123456789abcdef0', mfaCode: '001234' });
  assert.equal(ui.requests.at(-1).options.headers['X-CSRF-Token'], 'TEST_CSRF');
});

test('lookup prevents duplicate starts and CLI authentication, while the normal Console link stays usable', async () => {
  let resolveStart;
  const ui = await app({ start: () => new Promise((resolve) => { resolveStart = resolve; }) });
  const pending = ui.search();
  assert.equal(ui.get('lookup-mfa').value, '');
  assert.equal(ui.get('lookup-submit').disabled, true);
  assert.equal(ui.get('switch-button').disabled, true);
  assert.equal(ui.get('lookup-cancel').disabled, true);
  assert.equal(ui.get('console-link').hidden, false);
  assert.equal(ui.get('refresh-button').disabled, false);
  await ui.search();
  ui.get('mfa-code').value = '654321';
  await ui.get('switch-button').dispatch('click');
  ui.get('console-link').dispatch('click');
  assert.equal(ui.get('mfa-code').value, '');
  assert.equal(ui.get('lookup-mfa').value, '');
  assert.equal(ui.requests.filter(({ options }) => options.method === 'POST').length, 1);
  resolveStart(response(snapshot()));
  await pending;
  assert.equal(ui.get('lookup-cancel').disabled, false);
  assert.match(ui.get('lookup-progress').textContent, /0 of 2 profiles processed/);
});

test('a CLI request disables lookup and does not consume the separate lookup MFA', async () => {
  let resolveCli;
  const ui = await app({ cli: () => new Promise((resolve) => { resolveCli = resolve; }) });
  ui.get('mfa-code').value = '654321';
  const cli = ui.get('switch-button').dispatch('click');
  assert.equal(ui.get('lookup-submit').disabled, true);
  await ui.search();
  assert.equal(ui.requests.filter(({ url }) => url === '/api/lookup').length, 0);
  resolveCli(response(cliResult()));
  await cli;
  assert.equal(ui.get('lookup-submit').disabled, false);
  assert.match(ui.get('terminal-command').textContent, /TEST_SECRET/);
});

test('polling does not overlap, renders text-only matches, and preserves every profile outcome', async () => {
  let resolvePoll;
  let polls = 0;
  const ui = await app({ poll: () => { polls++; return new Promise((resolve) => { resolvePoll = resolve; }); } });
  await ui.search();
  await ui.advance(1499);
  assert.equal(polls, 0);
  await ui.advance(1);
  await ui.advance(15_000);
  assert.equal(polls, 1);
  const unsafeName = '<img src=x onerror=alert(1)>';
  resolvePoll(response(snapshot({ state: 'complete', results: [result(0, { name: unsafeName })], checks: [check(0, 'found', 'Matched one resource.'), check(1, 'access_denied', 'The role cannot describe EC2 instances.')], message: 'Lookup finished with partial coverage.' })));
  await ui.flush();
  assert.match(ui.get('lookup-progress').textContent, /2 of 2 profiles processed · 1 match/);
  const row = ui.get('lookup-results-body').children[0];
  assert.equal(row.children[0].textContent, '111111111111');
  assert.equal(row.children[1].textContent, 'dev');
  assert.equal(row.children[2].textContent, 'us-east-1');
  assert.equal(row.children[3].children[1].textContent, unsafeName);
  assert.equal(ui.get('lookup-checks').children.length, 2);
  assert.equal(ui.get('lookup-checks').children[1].children[0].children[1].textContent, 'Access denied');
  assert.equal(ui.get('lookup-diagnostics').hidden, false);
  assert.match(ui.get('lookup-diagnostics-summary').textContent, /1 of 2 profiles.*Confirmed matches are shown below/);
  assert.equal(ui.get('lookup-diagnostics-reasons').children[0].children[1].textContent, 'The role cannot describe EC2 instances.');
  assert.match(ui.get('lookup-coverage-note').textContent, /do not prove a resource is absent/);
  assert.equal(ui.get('switch-button').disabled, false);
  await ui.advance(30_000);
  assert.equal(polls, 1);
});

test('all failure and skipped statuses remain visible and no matches never implies global absence', async () => {
  for (const status of ['access_denied', 'auth_failed', 'error', 'skipped']) {
    const ui = await app({ start: () => response(snapshot({ state: 'complete', checks: [check(0, 'not_found'), check(1, status)], message: 'Finished with incomplete coverage.' })) });
    await ui.search();
    assert.match(ui.get('lookup-no-results').textContent, /does not prove the resource is absent/);
    assert.equal(ui.get('lookup-checks').children.length, 2);
    assert.equal(ui.get('lookup-checks').children[1].className.includes('is-warning'), true);
    assert.equal(ui.get('lookup-cancel').hidden, true);
  }
  const ui = await app({ start: () => response(snapshot({ state: 'complete', checks: [check(0, 'not_found'), check(1, 'not_found')] })) });
  await ui.search();
  assert.match(ui.get('lookup-no-results').textContent, /Other accounts and regions were not searched/);
  assert.equal(ui.get('lookup-diagnostics').hidden, true);
  assert.equal(ui.get('lookup-diagnostics-reasons').children.length, 0);
});

test('terminal failed checks prominently show grouped reasons for complete, error, and cancelled searches', async () => {
  const reason = 'Load balancer lookup could not reach the AWS endpoint. Check the network connection.';
  for (const state of ['complete', 'error', 'cancelled']) {
    const ui = await app({ start: () => response(snapshot({ state, checks: [check(0, 'error', reason), check(1, 'error', reason)] })) });
    await ui.search();
    assert.equal(ui.get('lookup-diagnostics').hidden, false);
    assert.match(ui.get('lookup-diagnostics-summary').textContent, /2 of 2 profiles could not be fully checked.*cannot confirm the resource is absent/);
    const reasons = ui.get('lookup-diagnostics-reasons').children;
    assert.equal(reasons.length, 1);
    assert.equal(reasons[0].children[0].textContent, '2 profiles: ');
    assert.equal(reasons[0].children[1].textContent, reason);
    assert.match(ui.get('lookup-diagnostics-detail').textContent, /Checks by profile below/);
    assert.equal(ui.get('lookup-results-body').children.length, 0);
    assert.equal(ui.get('lookup-checks').children[0].children[2].textContent, reason);
  }
});

test('failure summary renders only three distinct text-only reasons with counts and retains full profile details', async () => {
  const list = Array.from({ length: 6 }, (_, index) => ({ ...profiles[0], profile: `role-${index}` }));
  const markup = '<img src=x onerror=alert(1)>';
  const messages = [markup, markup, 'AWS rejected the request.', 'The SDK could not load the service.', 'The request timed out.', 'AWS temporarily limited requests.'];
  const checks = list.map((profile, index) => ({ profile: profile.profile, accountId: '111111111111', region: 'us-east-1', status: 'error', message: messages[index] }));
  const ui = await app({ list, start: () => response(snapshot({ state: 'complete', names: list.map(({ profile }) => profile), list, checks })) });
  await ui.search();
  const reasons = ui.get('lookup-diagnostics-reasons').children;
  assert.equal(reasons.length, 3);
  assert.equal(reasons[0].children[0].textContent, '2 profiles: ');
  assert.equal(reasons[0].children[1].tagName, 'SPAN');
  assert.equal(reasons[0].children[1].textContent, markup);
  assert.equal(reasons[0].children[1].children.length, 0);
  assert.equal(reasons[1].children[0].textContent, '1 profile: ');
  assert.match(ui.get('lookup-diagnostics-detail').textContent, /2 more reasons are listed below/);
  assert.equal(ui.get('lookup-checks').children.length, 6);
  assert.equal(ui.get('lookup-checks').children[5].children[2].textContent, messages[5]);
  assert.equal(ui.get('lookup-diagnostics-reasons').children.some((row) => row.children.some((child) => child.textContent.includes('role-'))), false);
});

test('running searches do not show a terminal failure summary or claim absence', async () => {
  const ui = await app({ start: () => response(snapshot({ checks: [check(0, 'error', 'The SDK could not load the service.')] })) });
  await ui.search();
  assert.equal(ui.get('lookup-diagnostics').hidden, true);
  assert.equal(ui.get('lookup-diagnostics-reasons').children.length, 0);
  assert.equal(ui.get('lookup-diagnostics-summary').textContent, '');
  assert.match(ui.get('lookup-no-results').textContent, /Checks are still running/);
  assert.equal(ui.get('lookup-checks').children[0].children[2].textContent, 'The SDK could not load the service.');
});

test('clearing or refreshing failed results removes the diagnostic summary and its messages', async () => {
  for (const action of ['lookup-clear', 'refresh-button']) {
    const ui = await app({ start: () => response(snapshot({ state: 'complete', checks: [check(0, 'error', 'The request timed out.'), check(1, 'not_found')] })) });
    await ui.search();
    assert.equal(ui.get('lookup-diagnostics').hidden, false);
    await ui.get(action).dispatch('click');
    assert.equal(ui.get('lookup-diagnostics').hidden, true);
    assert.equal(ui.get('lookup-diagnostics-reasons').children.length, 0);
    assert.equal(ui.get('lookup-diagnostics-summary').textContent, '');
    assert.equal(ui.get('lookup-diagnostics-detail').textContent, '');
  }
});

test('S3 uses global scope wording and displays its verified bucket region', async () => {
  const ui = await app({ start: () => response(snapshot({ state: 'complete', resourceType: 's3', query: 'example-bucket', results: [result(0, { resourceType: 's3', resourceId: 'example-bucket', name: 'example-bucket', arn: 'arn:aws:s3:::example-bucket', region: 'ap-southeast-2' })], checks: [check(0, 'found'), check(1, 'not_found')] })) });
  ui.get('lookup-type').value = 's3';
  ui.get('lookup-type').dispatch('change');
  assert.match(ui.get('lookup-region-help').textContent, /global/);
  await ui.search({ type: 's3', query: 'example-bucket' });
  assert.equal(ui.get('lookup-results-body').children[0].children[2].textContent, 'ap-southeast-2');
  assert.match(ui.get('lookup-checks').children[0].children[1].textContent, /us-east-1 · S3 global lookup/);
  assert.equal(JSON.parse(ui.requests.at(-1).options.body).resourceType, 's3');
});

test('EKS and ElastiCache options send exact queries and display account and configured region', async () => {
  for (const [type, query, label, placeholder] of [['eks', 'production-cluster', 'EKS cluster', /production-cluster/], ['elasticache', 'orders-cache', 'ElastiCache cache', /replication group.*serverless cache/]]) {
    assert.ok(html.includes(`<option value="${type}">${label}</option>`));
    const ui = await app({ start: () => response(snapshot({ state: 'complete', resourceType: type, query, results: [result(0, { resourceType: type, resourceId: query, name: query })], checks: [check(0, 'found'), check(1, 'not_found')] })) });
    ui.get('lookup-type').value = type;
    ui.get('lookup-type').dispatch('change');
    assert.match(ui.get('lookup-query').placeholder, placeholder);
    assert.match(ui.get('lookup-region-help').textContent, /configured region/);
    await ui.search({ type, query });
    assert.equal(JSON.parse(ui.requests.at(-1).options.body).resourceType, type);
    const row = ui.get('lookup-results-body').children[0];
    assert.equal(row.children[0].textContent, '111111111111');
    assert.equal(row.children[2].textContent, 'us-east-1');
    assert.equal(row.children[3].children[0].textContent, query);
  }
});

test('Load balancer lookup sends its exact name or ARN and displays matches in the selected account and region', async () => {
  assert.ok(html.includes('<option value="load-balancer">Load balancer</option>'));
  const arn = 'arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/app/production-web/0123456789abcdef';
  for (const query of ['production-web', arn]) {
    const ui = await app({ start: () => response(snapshot({ state: 'complete', resourceType: 'load-balancer', query,
      results: [result(0, { resourceType: 'load-balancer', resourceId: 'production-web', name: 'production-web', arn })],
      checks: [check(0, 'found'), check(1, 'not_found')] })) });
    ui.get('lookup-type').value = 'load-balancer';
    ui.get('lookup-type').dispatch('change');
    assert.match(ui.get('lookup-query').placeholder, /production-web.*load balancer ARN/);
    assert.match(ui.get('lookup-region-help').textContent, /Application, Network, Gateway, and Classic.*configured region/);
    await ui.search({ type: 'load-balancer', query });
    assert.deepEqual(JSON.parse(ui.requests.at(-1).options.body), { profiles: ['dev', 'production'], resourceType: 'load-balancer', query, mfaCode: '000123' });
    const row = ui.get('lookup-results-body').children[0];
    assert.equal(row.children[0].textContent, '111111111111');
    assert.equal(row.children[1].textContent, 'dev');
    assert.equal(row.children[2].textContent, 'us-east-1');
    assert.equal(row.children[3].children[0].textContent, 'production-web');
    assert.equal(row.children[3].children[1].textContent, arn);
    assert.equal(ui.get('lookup-mfa').value, '');
    assert.match(ui.get('lookup-checks').children[1].children[1].textContent, /eu-west-1/);
  }
});

test('Route 53 searches hosted zones globally and keeps configured regions out of absence claims', async () => {
  assert.ok(html.includes('<option value="route53">Route 53 hosted zone</option>'));
  for (const found of [true, false]) {
    const ui = await app({ start: () => response(snapshot({ state: 'complete', resourceType: 'route53', query: 'example.com', results: found ? [result(0, { resourceType: 'route53', resourceId: 'Z0123456789ABC', name: 'example.com.', arn: 'arn:aws:route53:::hostedzone/Z0123456789ABC', region: 'global' })] : [], checks: [check(0, found ? 'found' : 'not_found'), check(1, 'not_found')] })) });
    ui.get('lookup-type').value = 'route53';
    ui.get('lookup-type').dispatch('change');
    assert.match(ui.get('lookup-region-help').textContent, /hosted zone lookup is global.*individual DNS records are outside/);
    assert.match(ui.get('lookup-query').placeholder, /example.com.*Z0123456789ABC/);
    await ui.search({ type: 'route53', query: 'example.com' });
    assert.doesNotMatch(ui.get('lookup-status').textContent, /invalid lookup response/);
    assert.match(ui.get('lookup-checks').children[0].children[1].textContent, /Route 53 global lookup/);
    if (found) assert.equal(ui.get('lookup-results-body').children[0].children[2].textContent, 'global');
    else assert.equal(ui.get('lookup-no-results').textContent, 'No exact match was returned from the checked profiles. Other accounts were not searched.');
  }
});

test('resource rows cannot claim another region except for explicitly global lookup types', async () => {
  for (const [resourceType, region] of [['eks', 'eu-west-1'], ['elasticache', 'global'], ['load-balancer', 'eu-west-1'], ['load-balancer', 'global'], ['route53', 'us-east-1'], ['s3', 'unexpected-region']]) {
    const ui = await app({ start: () => response(snapshot({ state: 'complete', resourceType, query: 'example', results: [result(0, { resourceType, region })], checks: [check(0, 'found'), check(1, 'not_found')] })) });
    await ui.search({ type: resourceType, query: 'example' });
    assert.equal(ui.get('lookup-results-body').children.length, 0);
    assert.match(ui.get('lookup-status').textContent, /invalid lookup response/);
  }
});

test('explicit cancellation carries the job ID and CSRF token and rejects stale polling updates', async () => {
  let resolveOldPoll;
  const ui = await app({ poll: () => new Promise((resolve) => { resolveOldPoll = resolve; }) });
  await ui.search();
  await ui.advance(1500);
  await ui.get('lookup-cancel').dispatch('click');
  const cancellation = ui.requests.find(({ url }) => url === '/api/lookup/cancel');
  assert.deepEqual(JSON.parse(cancellation.options.body), { id: JOB_ID });
  assert.equal(cancellation.options.headers['X-CSRF-Token'], 'TEST_CSRF');
  resolveOldPoll(response(snapshot({ state: 'complete', results: [result()], checks: [check(0, 'found'), check(1, 'not_found')], message: 'Stale success.' })));
  await ui.flush();
  assert.match(ui.get('lookup-status').textContent, /cancelled/);
  assert.doesNotMatch(ui.get('lookup-status').textContent, /Stale/);
  assert.equal(ui.get('lookup-results-body').children.length, 0);
  assert.equal(ui.get('switch-button').disabled, false);
});

test('failed cancellation and status checks never claim the search has stopped', async () => {
  const ui = await app({ poll: () => response({ error: 'Status unavailable.' }, false), cancel: () => response({ error: 'Cancellation unavailable.' }, false) });
  await ui.search();
  await ui.advance(1500);
  assert.match(ui.get('lookup-status').textContent, /Search status is uncertain; cancellation has not been confirmed/);
  await ui.get('lookup-cancel').dispatch('click');
  assert.match(ui.get('lookup-status').textContent, /Cancellation was not confirmed.*may still be running/);
  assert.equal(ui.get('lookup-cancel').hidden, false);
  assert.equal(ui.get('switch-button').disabled, true);
  ui.get('lookup-clear').dispatch('click');
  await ui.flush();
  assert.match(ui.get('lookup-status').textContent, /cleared from this page.*may continue/);
  assert.equal(ui.get('lookup-results-panel').hidden, true);
  assert.equal(ui.get('switch-button').disabled, false);
});

test('refresh and pagehide discard results and send only best-effort cancellation for active jobs', async () => {
  for (const action of ['refresh', 'pagehide', 'clear']) {
    let resolvePoll;
    const ui = await app({ poll: () => new Promise((resolve) => { resolvePoll = resolve; }) });
    await ui.search();
    await ui.advance(1500);
    ui.get('lookup-mfa').value = '654321';
    if (action === 'refresh') await ui.get('refresh-button').dispatch('click');
    else if (action === 'pagehide') ui.windowEvents.get('pagehide')();
    else ui.get('lookup-clear').dispatch('click');
    resolvePoll(response(snapshot({ state: 'complete', results: [result()], checks: [check(0, 'found'), check(1, 'not_found')], message: 'Late completion.' })));
    await ui.flush();
    assert.equal(ui.get('lookup-mfa').value, '');
    assert.equal(ui.get('lookup-results-panel').hidden, true);
    assert.equal(ui.get('lookup-results-body').children.length, 0);
    assert.doesNotMatch(ui.get('lookup-status').textContent, /Late completion/);
    const cancellations = ui.requests.filter(({ url }) => url === '/api/lookup/cancel');
    assert.equal(cancellations.length, 1);
    assert.equal(cancellations[0].options.keepalive, true);
    if (action === 'pagehide') {
      ui.windowEvents.get('pageshow')({ persisted: true });
      await ui.flush();
      assert.equal(ui.requests.filter(({ url }) => url === '/api/profiles').length, 2);
    }
    const count = ui.requests.length;
    await ui.advance(30_000);
    assert.equal(ui.requests.length, count);
  }
});

test('a search response arriving after pagehide is discarded and its still-running job is cancelled best-effort', async () => {
  let resolveStart;
  const ui = await app({ start: () => new Promise((resolve) => { resolveStart = resolve; }) });
  const pending = ui.search();
  ui.windowEvents.get('pagehide')();
  resolveStart(response(snapshot()));
  await pending;
  await ui.flush();
  assert.equal(ui.get('lookup-results-panel').hidden, true);
  assert.equal(ui.requests.filter(({ url }) => url === '/api/lookup/cancel').length, 1);
  assert.equal(ui.get('lookup-mfa').value, '');
});

test('completed lookup metadata expires locally and Clear results never sends another AWS request', async () => {
  for (const expiry of [false, true]) {
    const ui = await app({ start: () => response(snapshot({ state: 'complete', results: [result()], checks: [check(0, 'found'), check(1, 'not_found')], expiresAt: new Date(START_TIME + 600_000).toISOString() })) });
    await ui.search();
    assert.equal(ui.get('lookup-results-body').children.length, 1);
    if (expiry) await ui.advance(600_001);
    else ui.get('lookup-clear').dispatch('click');
    assert.equal(ui.get('lookup-results-panel').hidden, true);
    assert.equal(ui.get('lookup-results-body').children.length, 0);
    assert.equal(ui.requests.length, 2);
  }
});

test('invalid or failed lookup responses never render returned resource metadata', async () => {
  for (const body of [
    response({ ...snapshot(), query: 'different-query', results: [result()] }),
    response({ ...snapshot(), id: 'invalid-id', results: [result()] }),
    response({ ...snapshot(), checks: [check(0, 'unknown_status')], completed: 1, results: [result()] }),
    response({ ...snapshot(), results: [result(0, { profile: 'not-selected' })] }),
    response({ error: 'Source MFA authentication failed.' }, false),
  ]) {
    const ui = await app({ start: () => body });
    await ui.search();
    assert.equal(ui.get('lookup-results-body').children.length, 0);
    assert.equal(ui.get('lookup-results-panel').hidden, true);
    assert.equal(ui.get('lookup-status').attributes.get('role'), 'alert');
    assert.equal(ui.get('lookup-mfa').value, '');
    assert.equal(ui.get('switch-button').disabled, false);
  }
});

test('lookup scope and response validation use role region, source fallback, then us-east-1', async () => {
  for (const { roleRegion, sourceRegion, expectedRegion } of [
    { roleRegion: undefined, sourceRegion: 'ap-southeast-2', expectedRegion: 'ap-southeast-2' },
    { roleRegion: '', sourceRegion: '', expectedRegion: 'us-east-1' },
    { roleRegion: 'eu-central-1', sourceRegion: 'ap-southeast-2', expectedRegion: 'eu-central-1' },
  ]) {
    const role = { ...profiles[0], region: roleRegion };
    const source = { profile: 'base', role_arn: '', source_profile: '', region: sourceRegion, auth: { enabled: false }, console: { url: null } };
    const scope = { profile: 'dev', accountId: '111111111111', region: expectedRegion };
    const completed = {
      ...snapshot({ state: 'complete', names: ['dev'], list: [role], checks: [{ ...scope, status: 'found', message: 'Found in the effective region.' }], results: [result(0, { region: expectedRegion })] }),
      profiles: [scope],
    };
    const ui = await app({ list: [role, source], start: () => response(completed) });
    const scopeRow = ui.get('lookup-profiles').children[0];
    assert.equal(scopeRow.children[0].attributes.get('aria-label'), `Search dev in ${expectedRegion}`);
    assert.equal(scopeRow.children[1].children[1].textContent, `111111111111 · ${expectedRegion}`);
    await ui.search();
    assert.doesNotMatch(ui.get('lookup-status').textContent, /invalid lookup response/);
    assert.equal(ui.get('lookup-results-body').children[0].children[2].textContent, expectedRegion);
    assert.equal(ui.get('lookup-checks').children[0].children[1].textContent, `111111111111 · ${expectedRegion}`);
  }
});

test('terminal error and cancellation snapshots count remaining skipped scopes as processed', async () => {
  for (const state of ['error', 'cancelled']) {
    const ui = await app({ start: () => response(snapshot({ state, checks: [check(0, 'auth_failed', 'Authentication failed.'), check(1, 'skipped', 'No lookup was performed.')], message: state === 'error' ? 'Search failed.' : 'Search cancelled.' })) });
    await ui.search();
    assert.doesNotMatch(ui.get('lookup-status').textContent, /invalid lookup response/);
    assert.match(ui.get('lookup-progress').textContent, /2 of 2 profiles processed/);
    assert.equal(ui.get('lookup-checks').children.length, 2);
    assert.equal(ui.get('lookup-checks').children[1].children[0].children[1].textContent, 'Not checked');
    assert.match(ui.get('lookup-no-results').textContent, /does not prove the resource is absent/);
    assert.equal(ui.get('lookup-cancel').hidden, true);
    assert.equal(ui.get('switch-button').disabled, false);
  }
});
