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

async function app({ list = profiles, cli, savedActive, writeClipboard } = {}) {
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
    window: { location: { href: 'http://127.0.0.1:3000/' }, open: () => { throw new Error('Console uses a normal anchor, never window.open'); }, addEventListener: (name, callback) => windowEvents.set(name, callback) },
    document: {
      getElementById: (id) => { assert.ok(elements.has(id), `UI references missing element: ${id}`); return elements.get(id); },
      createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element('fragment'),
      querySelector: () => prompt, querySelectorAll: () => tabs, addEventListener() {}, body,
      execCommand() { throw new Error('Clipboard denied'); },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/profiles') return { ok: true, json: async () => ({ profiles: list, token: 'test-csrf', activeProfile: savedActive }) };
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
  return { get, context, requests, windowEvents, clipboard, tabs, body, advance, openConsole: (event = 'click') => get('console-link').dispatch(event),
    async authenticate(code = '000123') { get('mfa-code').value = code; await get('switch-button').dispatch('click'); },
  };
}

test('Console is a normal safe new-tab link and sends no API request or MFA', async () => {
  const ui = await app();
  const link = ui.get('console-link');
  assert.equal(link.tagName, 'A');
  assert.equal(link.hidden, false);
  assert.equal(link.href, profiles[0].console.url);
  assert.match(html, /id="console-link" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Open AWS Switch Role/);
  assert.match(html, /then click <strong>Switch Role<\/strong> on AWS/);
  for (const event of ['click', 'auxclick']) {
    ui.get('mfa-code').value = '000123';
    await ui.openConsole(event);
    assert.equal(ui.get('mfa-code').value, '');
    assert.equal(link.href, profiles[0].console.url);
  }
  assert.deepEqual(ui.requests.map(({ url }) => url), ['/api/profiles']);
  assert.equal(ui.get('switch-button').disabled, false);
});

test('Console is available without CLI MFA setup and unavailable for source-only profiles', async () => {
  const list = [
    { ...profiles[0], auth: { enabled: false, reason: 'Add mfa_serial to use CLI credentials.', mfaSerial: '' } },
    { profile: 'source-only', role_arn: '', source_profile: '', region: 'us-east-1', auth: { enabled: false, reason: 'This profile has no role.' }, console: { url: null, reason: 'This profile has no role_arn.' } },
  ];
  const ui = await app({ list });
  assert.equal(ui.get('console-link').hidden, false);
  assert.equal(ui.get('switch-button').disabled, true);
  assert.equal(ui.get('mfa-code').disabled, true);
  assert.equal(ui.get('cli-reason').textContent, 'Add mfa_serial to use CLI credentials.');
  assert.equal(ui.get('console-reason').hidden, true);
  await ui.openConsole();
  assert.deepEqual(ui.requests.map(({ url }) => url), ['/api/profiles']);
  ui.get('profile-list').children[1].dispatch('click');
  assert.equal(ui.get('console-link').hidden, true);
  assert.equal(ui.get('console-link').href, undefined);
  assert.equal(ui.get('console-reason').textContent, 'This profile has no role_arn.');
});

test('unsupported or malformed Console URLs never become navigable links', async () => {
  for (const url of [
    null, 'javascript:alert(1)', 'https://example.invalid/switchrole?account=123456789012&roleName=Developer',
    profiles[0].console.url.replace('https:', 'http:'),
    profiles[0].console.url.replace('signin.aws.amazon.com', 'signin.aws.amazon.com.example.invalid'),
    profiles[0].console.url.replace('/switchrole?', '/federation?'),
    profiles[0].console.url.replace('123456789012', '123'),
    profiles[0].console.url.replace('roleName=Developer', 'roleName='),
    `${profiles[0].console.url}&account=999999999999`,
    `${profiles[0].console.url}&redirect=https://example.invalid`,
    `${profiles[0].console.url}#fragment`,
  ]) {
    const ui = await app({ list: [{ ...profiles[0], console: { url, reason: 'Unsupported Console profile.' } }] });
    assert.equal(ui.get('console-link').hidden, true);
    assert.equal(ui.get('console-link').href, undefined);
    assert.equal(ui.get('console-reason').textContent, 'Unsupported Console profile.');
    assert.equal(ui.get('switch-button').disabled, false, 'Console eligibility must not disable CLI authentication');
  }
});

test('initial load, refresh and BFCache restoration do not poll or start Console automation', async () => {
  const ui = await app();
  await ui.get('refresh-button').dispatch('click');
  ui.windowEvents.get('pagehide')();
  ui.windowEvents.get('pageshow')({ persisted: true });
  await new Promise(setImmediate);
  await ui.advance(30_000);
  assert.deepEqual(ui.requests.map(({ url }) => url), ['/api/profiles', '/api/profiles', '/api/profiles']);
  assert.doesNotMatch(source, /browserStatus|browserTimer|browserMutation|\/api\/browser-console|\/api\/console|window\.open|SigninToken/);
  assert.doesNotMatch(html, /app-controlled|Switch automatically|Cancel switch|id="console-form"/);
});

test('saved profile metadata never restores credentials; CLI exports appear only after fresh MFA succeeds', async () => {
  let resolveResponse;
  const ui = await app({ savedActive: 'dev', cli: () => new Promise((resolve) => { resolveResponse = resolve; }) });
  assert.deepEqual(ui.requests.map((request) => request.url), ['/api/profiles']);
  assert.equal(ui.get('copy-button').disabled, true);
  const authentication = ui.authenticate();
  assert.equal(ui.get('mfa-code').value, '');
  assert.equal(ui.get('copy-button').disabled, true);
  assert.equal(ui.get('switch-button').disabled, true);
  assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
  assert.deepEqual(JSON.parse(ui.requests[1].options.body), { profile: 'dev', mfaCode: '000123' });
  assert.equal(ui.requests[1].options.headers['X-CSRF-Token'], 'test-csrf');
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

test('CLI click and Enter send only the MFA CLI request and remain independent of the Console link', async () => {
  assert.match(html, /id="switch-button" type="button"/);
  assert.doesNotMatch(html, /<form/);
  for (const useEnter of [false, true]) {
    const ui = await app();
    await ui.openConsole();
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
    await ui.advance(30_000);
    assert.equal(ui.get('terminal-command').textContent, cliResponse().commands.posix);
    assert.match(ui.get('notice').textContent, /Temporary CLI credentials.*are ready/);
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

test('opening the Console link clears previous CLI credentials on click and auxclick', async () => {
  for (const event of ['click', 'auxclick']) {
    const ui = await app();
    await ui.authenticate();
    const before = ui.requests.length;
    ui.get('mfa-code').value = '654321';
    await ui.openConsole(event);
    assert.equal(ui.get('mfa-code').value, '');
    assert.doesNotMatch(ui.get('terminal-command').textContent, /TEST_ONLY/);
    assert.equal(ui.get('copy-button').disabled, true);
    assert.equal(ui.requests.length, before);
    assert.equal(ui.get('console-link').href, profiles[0].console.url);
  }
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
