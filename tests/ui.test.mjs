// Author: jperch1987
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const START_TIME = Date.parse('2030-01-01T00:00:00Z');
const profiles = ['dev', 'production'].map((profile) => ({
  profile, role_arn: 'arn:aws:iam::123456789012:role/Developer', source_profile: 'base', region: 'us-east-1',
  auth: { enabled: true, reason: null, mfaSerial: 'arn:aws:iam::123456789012:mfa/example' },
  console: { url: 'https://signin.aws.amazon.com/switchrole?account=123456789012&roleName=Developer' },
}));

function browserStatus(state = 'idle', profile = null, message = 'AWS browser is ready.') {
  return { state, profile, message };
}

function response(value, ok = true) { return { ok, json: async () => value }; }

function cliResponse(expiration = START_TIME + 3600_000) {
  const values = { AWS_ACCESS_KEY_ID: 'TEST_ONLY_KEY', AWS_SECRET_ACCESS_KEY: 'TEST_ONLY_SECRET', AWS_SESSION_TOKEN: 'TEST_ONLY_TOKEN', AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' };
  return {
    profile: profiles[0], roleArn: profiles[0].role_arn, expiration: new Date(expiration).toISOString(),
    commands: {
      posix: Object.entries(values).map(([key, value]) => `export ${key}='${value}'`).join('\n'),
      powershell: Object.entries(values).map(([key, value]) => `$Env:${key} = '${value}'`).join('\n'),
    },
  };
}

// A small DOM double exercises the actual event handlers without browser dependencies.
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

async function app({ list = profiles, browser, cancel, cli, savedActive, writeClipboard } = {}) {
  const elements = new Map([...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/g)].map((match) => [match[2], new Element(match[1])]));
  const prompt = new Element('span');
  const tabs = ['posix', 'powershell'].map((shell) => Object.assign(new Element('button'), { dataset: { shell } }));
  const requests = [];
  const clipboard = [];
  const windowEvents = new Map();
  const timers = new Map();
  let clockTime = START_TIME;
  let nextTimer = 1;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clockTime])); }
    static now() { return clockTime; }
  }
  const body = new Element('body');
  const context = vm.createContext({
    URL, Set, Date: ClockDate,
    setTimeout: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, due: clockTime + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    navigator: { clipboard: { writeText: writeClipboard || (async (text) => { clipboard.push(text); }) } },
    window: { location: { href: 'http://127.0.0.1:3000/' }, open: () => { throw new Error('The managed browser must not use window.open'); }, addEventListener: (name, callback) => windowEvents.set(name, callback) },
    document: {
      getElementById: (id) => { assert.ok(elements.has(id), `UI references missing element: ${id}`); return elements.get(id); },
      createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element('fragment'),
      querySelector: () => prompt, querySelectorAll: () => tabs, addEventListener() {}, body,
      execCommand() { throw new Error('Clipboard denied'); },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/profiles') return { ok: true, json: async () => ({ profiles: list, token: 'test-csrf', activeProfile: savedActive }) };
      if (url === '/api/browser-console') return browser ? browser(options) : response(options?.method === 'POST' ? browserStatus('waiting-for-login', 'dev', 'Sign in and complete MFA in the AWS browser.') : browserStatus());
      if (url === '/api/browser-console/cancel') return cancel ? cancel(options) : response(browserStatus('cancelled', 'dev', 'Switch cancelled.'));
      if (url === '/api/cli') return cli ? cli(options) : { ok: true, json: async () => cliResponse() };
      throw new Error('Unexpected request');
    },
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  const get = (id) => elements.get(id);
  assert.equal(vm.runInContext('state.profiles.length', context), list.length, get('notice').textContent);
  async function advance(milliseconds, runTimers = true) {
    clockTime += milliseconds;
    if (runTimers) {
      for (const [id, timer] of [...timers]) {
        if (timer.due <= clockTime && timers.has(id)) { timers.delete(id); timer.callback(); }
      }
    }
    await new Promise(setImmediate);
  }
  return { get, context, requests, windowEvents, clipboard, tabs, body, advance, submit: () => get('console-form').dispatch('submit'),
    async authenticate(code = '000123') { get('mfa-code').value = code; await get('switch-button').dispatch('click'); },
  };
}

test('Console starts the separate browser without a popup, MFA, or federation request', async () => {
  let resolveResponse;
  const ui = await app({ browser: (options) => options?.method === 'POST' ? new Promise((resolve) => { resolveResponse = resolve; }) : response(browserStatus()) });
  ui.get('mfa-code').value = '000123';
  const submission = ui.submit();
  assert.equal(ui.get('mfa-code').value, '');
  assert.equal(ui.get('console-button').disabled, true);
  assert.equal(ui.get('mfa-code').disabled, true);
  assert.equal(ui.get('switch-button').disabled, true);
  assert.equal(ui.get('profile-list').children[1].disabled, true);
  assert.equal(ui.get('cancel-console').hidden, false);
  assert.equal(ui.get('cancel-console').disabled, true);
  await ui.submit();
  await ui.get('switch-button').dispatch('click');
  ui.get('profile-list').children[1].dispatch('click');
  const sent = ui.requests.filter(({ options }) => options?.method === 'POST');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/browser-console');
  assert.deepEqual(JSON.parse(sent[0].options.body), { profile: 'dev' });
  assert.equal(sent[0].options.headers['X-CSRF-Token'], 'test-csrf');
  resolveResponse(response(browserStatus('waiting-for-login', 'dev', 'Sign in and complete MFA in the separate AWS browser.')));
  await submission;
  assert.match(ui.get('browser-status').textContent, /Sign in and complete MFA/);
  assert.equal(ui.get('cancel-console').disabled, false);
  assert.equal(ui.get('refresh-button').disabled, false);
  assert.equal(vm.runInContext('state.selected', ui.context), 'dev');
  assert.ok(ui.requests.every(({ url }) => url !== '/api/console'));
});

test('browser progress polls once per interval, finishes visibly, and stops polling', async () => {
  let getCount = 0;
  const statuses = [browserStatus(), browserStatus('switching', 'dev', 'Clicking Switch Role.'), browserStatus('opened', 'dev', 'Switch request sent. Check the account and role shown in AWS.')];
  const ui = await app({ browser: (options) => response(options?.method === 'POST' ? browserStatus('waiting-for-login', 'dev', 'Complete sign-in in AWS.') : statuses[getCount++]) });
  await ui.submit();
  assert.equal(getCount, 1);
  await ui.advance(1499);
  assert.equal(getCount, 1);
  await ui.advance(1);
  assert.equal(getCount, 2);
  assert.match(ui.get('browser-status').textContent, /Clicking Switch Role/);
  await ui.advance(1500);
  assert.equal(getCount, 3);
  assert.match(ui.get('browser-status').textContent, /Check the account and role/);
  assert.equal(ui.get('console-button').disabled, false);
  assert.equal(ui.get('cancel-console').hidden, true);
  await ui.advance(30_000);
  assert.equal(getCount, 3);
});

test('a slow poll does not overlap another poll and a terminal error stays visible in the app', async () => {
  let resolvePoll;
  let getCount = 0;
  const ui = await app({ browser: (options) => {
    if (options?.method === 'POST') return response(browserStatus('starting', 'dev', 'Opening browser.'));
    return ++getCount === 1 ? response(browserStatus()) : new Promise((resolve) => { resolvePoll = resolve; });
  } });
  await ui.submit();
  await ui.advance(1500);
  await ui.advance(15_000);
  assert.equal(getCount, 2);
  resolvePoll(response(browserStatus('error', 'dev', 'AWS did not show a supported Switch Role button.')));
  await new Promise(setImmediate);
  assert.match(ui.get('browser-status').textContent, /supported Switch Role/);
  assert.match(ui.get('notice').textContent, /supported Switch Role/);
  assert.equal(ui.get('notice').scrolledIntoView, true);
  assert.equal(ui.get('console-button').disabled, false);
  await ui.advance(30_000);
  assert.equal(getCount, 2);
});

test('cancellation is explicit, protected with CSRF, and invalidates an outstanding poll', async () => {
  let resolvePoll;
  let getCount = 0;
  let resolveCancel;
  const ui = await app({ browser: (options) => {
    if (options?.method === 'POST') return response(browserStatus('waiting-for-login', 'dev', 'Complete sign-in.'));
    return ++getCount === 1 ? response(browserStatus()) : new Promise((resolve) => { resolvePoll = resolve; });
  }, cancel: () => new Promise((resolve) => { resolveCancel = resolve; }) });
  await ui.submit();
  await ui.advance(1500);
  const cancellation = ui.get('cancel-console').dispatch('click');
  assert.equal(ui.get('cancel-console').disabled, true);
  await ui.get('cancel-console').dispatch('click');
  const calls = ui.requests.filter(({ url }) => url === '/api/browser-console/cancel');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'test-csrf');
  assert.equal(calls[0].options.body, '{}');
  resolveCancel(response(browserStatus('cancelled', 'dev', 'Switch cancelled.')));
  await cancellation;
  resolvePoll(response(browserStatus('opened', 'dev', 'Stale completion.')));
  await new Promise(setImmediate);
  assert.match(ui.get('browser-status').textContent, /cancelled/);
  assert.doesNotMatch(ui.get('browser-status').textContent, /Stale/);
  assert.equal(ui.get('cancel-console').hidden, true);
  assert.equal(ui.get('console-button').disabled, false);
});

test('reload and refresh resume an existing browser job without starting or cancelling it', async () => {
  const ui = await app({ browser: () => response(browserStatus('waiting-for-login', 'production', 'Finish signing in inside AWS.')) });
  assert.match(ui.get('browser-status').textContent, /production/);
  assert.equal(ui.get('console-button').disabled, true);
  assert.equal(ui.get('cancel-console').hidden, false);
  await ui.get('refresh-button').dispatch('click');
  assert.equal(ui.requests.filter(({ url }) => url === '/api/profiles').length, 2);
  await ui.advance(1500);
  assert.equal(ui.requests.filter(({ url }) => url === '/api/browser-console').length, 3);
  assert.ok(ui.requests.every(({ options }) => !options?.method));
});

test('pagehide ignores a late Console start response and does not cancel the server job', async () => {
  let resolveStart;
  const ui = await app({ browser: (options) => options?.method === 'POST' ? new Promise((resolve) => { resolveStart = resolve; }) : response(browserStatus()) });
  const pending = ui.submit();
  ui.windowEvents.get('pagehide')();
  resolveStart(response(browserStatus('opened', 'dev', 'Late start response.')));
  await pending;
  await ui.advance(30_000);
  assert.doesNotMatch(ui.get('browser-status').textContent, /Late start/);
  assert.equal(ui.requests.length, 3);
  assert.equal(ui.requests.some(({ url }) => url.endsWith('/cancel')), false);
});

test('pagehide invalidates pending status; BFCache restore reads current server status', async () => {
  let getCount = 0;
  let resolveOldPoll;
  const ui = await app({ browser: (options) => {
    if (options?.method === 'POST') return response(browserStatus('starting', 'dev', 'Opening browser.'));
    getCount++;
    if (getCount === 2) return new Promise((resolve) => { resolveOldPoll = resolve; });
    return response(getCount === 1 ? browserStatus() : browserStatus('opened', 'dev', 'Current completion. Check AWS identity.'));
  } });
  await ui.submit();
  await ui.advance(1500);
  ui.windowEvents.get('pagehide')();
  ui.windowEvents.get('pageshow')({ persisted: true });
  await new Promise(setImmediate);
  resolveOldPoll(response(browserStatus('waiting-for-login', 'dev', 'Stale login prompt.')));
  await new Promise(setImmediate);
  assert.match(ui.get('browser-status').textContent, /Current completion/);
  assert.doesNotMatch(ui.get('browser-status').textContent, /Stale/);
  assert.ok(ui.requests.every(({ url }) => !url.endsWith('/cancel')));
});

test('malformed browser responses and request errors are shown safely with retry available', async () => {
  for (const result of [response({ state: 'opened', profile: 'dev', message: {} }), response({ error: 'Install the app browser first.' }, false)]) {
    const ui = await app({ browser: (options) => options?.method === 'POST' ? result : response(browserStatus()) });
    await ui.submit();
    assert.match(ui.get('notice').textContent, /invalid browser status|Install the app browser/);
    assert.equal(ui.get('console-button').disabled, false);
    assert.equal(ui.get('cancel-console').hidden, true);
    assert.equal(ui.get('browser-status').attributes.get('role'), 'alert');
  }
});

test('Console availability is independent of CLI MFA and unsupported reasons are separate', async () => {
  const list = [profiles[0], { ...profiles[1], auth: { enabled: false, reason: 'Add mfa_serial to use CLI credentials.', mfaSerial: '' } }, { ...profiles[1], profile: 'unsupported-console', console: { url: null, reason: 'This role is unsupported in AWS Console.' } }];
  const ui = await app({ list });
  ui.get('mfa-code').value = '123456';
  ui.get('profile-list').children[1].dispatch('click');
  assert.equal(ui.get('mfa-code').value, '');
  assert.equal(ui.get('console-button').disabled, false);
  assert.equal(ui.get('switch-button').disabled, true);
  assert.equal(ui.get('console-link').hidden, false);
  assert.equal(ui.get('cli-reason').textContent, 'Add mfa_serial to use CLI credentials.');
  assert.equal(ui.get('console-reason').hidden, true);
  ui.get('profile-list').children[2].dispatch('click');
  assert.equal(ui.get('console-button').disabled, true);
  assert.equal(ui.get('switch-button').disabled, false);
  assert.equal(ui.get('console-link').hidden, true);
  assert.equal(ui.get('console-reason').textContent, 'This role is unsupported in AWS Console.');
  assert.equal(ui.get('cli-reason').hidden, true);
});

test('refresh invalidates an outstanding poll without cancelling the AWS job', async () => {
  let getCount = 0;
  let resolveOldPoll;
  const ui = await app({ browser: (options) => {
    if (options?.method === 'POST') return response(browserStatus('starting', 'dev', 'Opening browser.'));
    getCount++;
    if (getCount === 2) return new Promise((resolve) => { resolveOldPoll = resolve; });
    return response(getCount === 1 ? browserStatus() : browserStatus('opened', 'dev', 'Current switch completed. Check AWS.'));
  } });
  await ui.submit();
  await ui.advance(1500);
  await ui.get('refresh-button').dispatch('click');
  resolveOldPoll(response(browserStatus('error', 'dev', 'Stale failure.')));
  await new Promise(setImmediate);
  assert.match(ui.get('browser-status').textContent, /Current switch completed/);
  assert.doesNotMatch(ui.get('notice').textContent, /Stale failure/);
  assert.ok(ui.requests.every(({ url }) => !url.endsWith('/cancel')));
});

test('manual fallback stays an AWS link and clears credentials without requesting browser automation', async () => {
  const ui = await app();
  await ui.authenticate();
  ui.get('mfa-code').value = '654321';
  ui.get('console-link').dispatch('click');
  assert.equal(ui.get('mfa-code').value, '');
  assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
  assert.match(ui.get('console-link').href, /^https:\/\/signin\.aws\.amazon\.com\/switchrole\?/);
  assert.equal(ui.requests.filter(({ url, options }) => url === '/api/browser-console' && options?.method === 'POST').length, 0);
  assert.match(html, /id="console-link" target="_blank" rel="noopener noreferrer"/);
});

test('saved profile metadata never restores credentials; CLI exports appear only after fresh MFA succeeds', async () => {
  let resolveResponse;
  const ui = await app({ savedActive: 'dev', cli: () => new Promise((resolve) => { resolveResponse = resolve; }) });
  assert.deepEqual(ui.requests.map((request) => request.url), ['/api/profiles', '/api/browser-console']);
  assert.equal(ui.get('copy-button').disabled, true);
  const authentication = ui.authenticate();
  assert.equal(ui.get('mfa-code').value, '');
  assert.equal(ui.get('copy-button').disabled, true);
  assert.equal(ui.get('switch-button').disabled, true);
  assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
  assert.deepEqual(JSON.parse(ui.requests[2].options.body), { profile: 'dev', mfaCode: '000123' });
  assert.equal(ui.requests[2].options.headers['X-CSRF-Token'], 'test-csrf');
  resolveResponse({ ok: true, json: async () => cliResponse() });
  await authentication;
  assert.equal(ui.get('terminal-command').textContent, cliResponse().commands.posix);
  assert.equal(ui.get('copy-button').disabled, false);
  assert.equal(ui.get('active-status').textContent, 'Temporary session');
  assert.match(ui.get('session-expiry').textContent, /60 min remaining/);
  await ui.get('copy-button').dispatch('click');
  assert.deepEqual(ui.clipboard, [cliResponse().commands.posix]);
  ui.tabs[1].dispatch('click');
  await ui.get('copy-button').dispatch('click');
  assert.deepEqual(ui.clipboard, [cliResponse().commands.posix, cliResponse().commands.powershell]);
  assert.equal(ui.requests.filter((request) => request.url === '/api/cli').length, 1);
});

test('CLI click and Enter send only the MFA CLI request after saved Console terminal states', async () => {
  const consoleForm = html.match(/<form\b[^>]*id="console-form"[^>]*>([\s\S]*?)<\/form>/)?.[1];
  assert.ok(consoleForm);
  assert.doesNotMatch(consoleForm, /id="(?:switch-button|mfa-code)"/, 'CLI controls must remain outside the Console form');
  assert.match(html, /id="switch-button" type="button"/);
  for (const state of ['idle', 'error', 'opened', 'cancelled']) {
    for (const useEnter of [false, true]) {
      const ui = await app({ browser: (options) => {
        assert.notEqual(options?.method, 'POST', 'A CLI action must not start browser automation');
        return response(browserStatus(state, state === 'idle' ? null : 'dev', 'Previous Console status.'));
      } });
      ui.get('mfa-code').value = '000123';
      if (useEnter) {
        ui.get('mfa-code').dispatch('keydown', { key: 'Enter' });
        await new Promise(setImmediate);
      } else await ui.get('switch-button').dispatch('click');
      const mutations = ui.requests.filter(({ options }) => options?.method === 'POST');
      assert.equal(mutations.length, 1);
      assert.equal(mutations[0].url, '/api/cli');
      assert.deepEqual(JSON.parse(mutations[0].options.body), { profile: 'dev', mfaCode: '000123' });
      assert.equal(ui.get('terminal-command').textContent, cliResponse().commands.posix);
      assert.match(ui.get('notice').textContent, /Temporary CLI credentials.*are ready/);
      assert.doesNotMatch(ui.get('notice').textContent, /Previous Console status/);
      await ui.advance(30_000);
      assert.equal(ui.get('terminal-command').textContent, cliResponse().commands.posix);
      assert.match(ui.get('notice').textContent, /Temporary CLI credentials.*are ready/);
    }
  }
});

test('a late cancelled browser poll cannot overwrite a subsequent CLI result or CLI error', async () => {
  for (const failCli of [false, true]) {
    let getCount = 0;
    let resolveOldPoll;
    const ui = await app({ browser: (options) => {
      if (options?.method === 'POST') return response(browserStatus('waiting-for-login', 'dev', 'Sign in inside AWS.'));
      return ++getCount === 1 ? response(browserStatus()) : new Promise((resolve) => { resolveOldPoll = resolve; });
    }, cli: () => failCli ? response({ error: 'The CLI MFA code was rejected.' }, false) : response(cliResponse()) });
    await ui.submit();
    await ui.advance(1500);
    await ui.get('cancel-console').dispatch('click');
    await ui.authenticate();
    const cliNotice = ui.get('notice').textContent;
    resolveOldPoll(response(browserStatus('error', 'dev', 'Old Console error must not replace CLI feedback.')));
    await new Promise(setImmediate);
    assert.equal(ui.get('notice').textContent, cliNotice);
    assert.doesNotMatch(ui.get('notice').textContent, /Old Console error/);
    if (failCli) {
      assert.match(cliNotice, /CLI MFA code was rejected/);
      assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
    } else assert.equal(ui.get('terminal-command').textContent, cliResponse().commands.posix);
  }
});

test('a new CLI attempt clears old exports before sending and requires a fresh code', async () => {
  let fail = false;
  const ui = await app({ cli: async () => fail ? { ok: false, json: async () => ({ error: 'MFA rejected.' }) } : { ok: true, json: async () => cliResponse() } });
  await ui.authenticate();
  await ui.get('switch-button').dispatch('click');
  assert.equal(ui.requests.filter((request) => request.url === '/api/cli').length, 1);
  assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
  assert.match(ui.get('notice').textContent, /fresh six-digit/);
  await ui.authenticate();
  fail = true;
  const pending = ui.authenticate('654321');
  assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
  assert.equal(ui.get('copy-button').disabled, true);
  await pending;
  assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
  assert.match(ui.get('notice').textContent, /Your terminal was not changed/);
  assert.equal(ui.get('mfa-code').value, '');
});

test('starting Console switching clears previous CLI credentials and never sends CLI MFA', async () => {
  const ui = await app();
  await ui.authenticate();
  ui.get('mfa-code').value = '654321';
  await ui.submit();
  assert.equal(ui.get('mfa-code').value, '');
  assert.equal(ui.requests.at(-1).options.body, '{"profile":"dev"}');
  assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
  assert.equal(ui.get('copy-button').disabled, true);
});

test('profile changes, refresh, explicit clear, pagehide, and BFCache restore erase credentials', async () => {
  for (const action of [
    (ui) => ui.get('profile-list').children[1].dispatch('click'),
    (ui) => ui.get('refresh-button').dispatch('click'),
    (ui) => ui.get('clear-credentials').dispatch('click'),
    (ui) => ui.windowEvents.get('pagehide')(),
    (ui) => ui.windowEvents.get('pageshow')({ persisted: true }),
  ]) {
    const ui = await app();
    await ui.authenticate();
    ui.get('mfa-code').value = '654321';
    await action(ui);
    assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
    assert.equal(ui.get('mfa-code').value, '');
    assert.equal(ui.get('copy-button').disabled, true);
    assert.equal(vm.runInContext('state.commands', ui.context), null);
    assert.equal(ui.clipboard.length, 0);
  }
});

test('expiry clears exports and copy rejects expired credentials even when timers were suspended', async () => {
  for (const runTimers of [true, false]) {
    const ui = await app();
    await ui.authenticate();
    ui.advance(3600_001, runTimers);
    await ui.get('copy-button').dispatch('click');
    assert.equal(ui.clipboard.length, 0);
    assert.equal(ui.get('copy-button').disabled, true);
    assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
    assert.equal(vm.runInContext('state.commands', ui.context), null);
  }
});

test('a CLI response finishing after pagehide cannot restore credentials', async () => {
  let resolveResponse;
  const ui = await app({ cli: () => new Promise((resolve) => { resolveResponse = resolve; }) });
  const authentication = ui.authenticate();
  ui.windowEvents.get('pagehide')();
  ui.windowEvents.get('pageshow')({ persisted: true });
  resolveResponse({ ok: true, json: async () => cliResponse() });
  await authentication;
  assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
  assert.equal(ui.get('copy-button').disabled, true);
});

test('malformed, expired, or mismatched CLI responses are not displayed', async () => {
  for (const response of [
    cliResponse(START_TIME - 1),
    { ...cliResponse(), roleArn: 'arn:aws:iam::999999999999:role/Other' },
    { ...cliResponse(), commands: { ...cliResponse().commands, posix: 'export AWS_ACCESS_KEY_ID=unsafe; do-something' } },
  ]) {
    const ui = await app({ cli: async () => ({ ok: true, json: async () => response }) });
    await ui.authenticate();
    assert.equal(ui.get('copy-button').disabled, true);
    assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY|do-something/);
    assert.match(ui.get('notice').textContent, /invalid or expired/);
  }
});

test('failed clipboard writes clear credentials and remove temporary copy elements', async () => {
  const ui = await app({ writeClipboard: async () => { throw new Error('Denied'); } });
  await ui.authenticate();
  await ui.get('copy-button').dispatch('click');
  assert.equal(ui.get('copy-button').disabled, true);
  assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
  assert.equal(ui.body.children.length, 0);
});

test('an older clipboard promise cannot clear a newer authenticated session', async () => {
  for (const rejectCopy of [false, true]) {
    let finishCopy;
    let issued = 0;
    const ui = await app({
      writeClipboard: () => new Promise((resolve, reject) => { finishCopy = () => rejectCopy ? reject(new Error('Old copy denied')) : resolve(); }),
      cli: async () => {
        const response = cliResponse();
        if (++issued > 1) for (const shell of ['posix', 'powershell']) response.commands[shell] = response.commands[shell].replaceAll('TEST_ONLY', 'SECOND_ONLY');
        return { ok: true, json: async () => response };
      },
    });
    await ui.authenticate();
    const oldCopy = ui.get('copy-button').dispatch('click');
    await ui.authenticate('654321');
    assert.match(ui.get('terminal-command').textContent, /SECOND_ONLY_SECRET/);
    finishCopy();
    await oldCopy;
    assert.match(ui.get('terminal-command').textContent, /SECOND_ONLY_SECRET/);
    assert.equal(ui.get('copy-button').disabled, false);
    assert.equal(ui.body.children.length, 0);
  }
});

test('the UI never uses browser persistent storage for credentials or MFA', () => {
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(source, /\/api\/active/);
  assert.doesNotMatch(source, /window\.open|\/api\/console|SigninToken/);
});
