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

function federationUrl(destination = 'https://console.aws.amazon.com/console/home?region=us-east-1') {
  return `https://signin.aws.amazon.com/federation?${new URLSearchParams({ Action: 'login', Destination: destination, SigninToken: 'EXAMPLE_TEST_TOKEN' })}`;
}

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

function consoleTab() {
  const head = new Element('head');
  return {
    opener: {}, closed: false, close() { this.closed = true; },
    location: { replace(url) { this.destination = url; } },
    document: {
      title: '', head, body: new Element('body'),
      createElement: (tag) => new Element(tag),
      getElementById: (id) => head.children.find((element) => element.id === id),
    },
  };
}

async function app({ list = profiles, open, consoleResponse, cli, savedActive, writeClipboard } = {}) {
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
    window: { location: { href: 'http://127.0.0.1:3000/' }, open: open || (() => { throw new Error('Unexpected popup'); }), addEventListener: (name, callback) => windowEvents.set(name, callback) },
    document: {
      getElementById: (id) => { assert.ok(elements.has(id), `UI references missing element: ${id}`); return elements.get(id); },
      createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element('fragment'),
      querySelector: () => prompt, querySelectorAll: () => tabs, addEventListener() {}, body,
      execCommand() { throw new Error('Clipboard denied'); },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/profiles') return { ok: true, json: async () => ({ profiles: list, token: 'test-csrf', activeProfile: savedActive }) };
      if (url === '/api/console') return consoleResponse(options);
      if (url === '/api/cli') return cli ? cli(options) : { ok: true, json: async () => cliResponse() };
      throw new Error('Unexpected request');
    },
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  const get = (id) => elements.get(id);
  assert.equal(vm.runInContext('state.profiles.length', context), list.length, get('notice').textContent);
  function advance(milliseconds, runTimers = true) {
    clockTime += milliseconds;
    if (runTimers) {
      for (const [id, timer] of [...timers]) {
        if (timer.due <= clockTime && timers.has(id)) { timers.delete(id); timer.callback(); }
      }
    }
  }
  return { get, context, requests, windowEvents, clipboard, tabs, body, advance, submit: () => get('console-form').dispatch('submit'),
    async authenticate(code = '000123') { get('mfa-code').value = code; await get('switch-button').dispatch('click'); },
  };
}

test('federation navigation only accepts the exact AWS login and Console destination', async () => {
  const ui = await app();
  const approved = (url) => { ui.context.candidate = url; return vm.runInContext('approvedFederationUrl(candidate)', ui.context); };
  assert.equal(approved(federationUrl()), federationUrl());
  for (const url of [
    federationUrl().replace('https://signin.', 'http://signin.'),
    federationUrl().replace('signin.aws.amazon.com', 'signin.aws.amazon.com.example.invalid'),
    federationUrl().replace('/federation?', '/switchrole?'),
    `${federationUrl()}&Action=login`, `${federationUrl()}&Issuer=https://example.invalid`,
    `${federationUrl()}#fragment`, federationUrl('https://example.invalid/console/home?region=us-east-1'),
    federationUrl('https://console.aws.amazon.com/other?region=us-east-1'),
    federationUrl('https://console.aws.amazon.com/console/home?region=us-east-1&redirect=https://example.invalid'),
    federationUrl().replace('SigninToken=EXAMPLE_TEST_TOKEN', 'SigninToken='),
  ]) assert.equal(approved(url), null);
});

test('blocked popups clear MFA without sending it to the server', async () => {
  let opened = 0;
  const ui = await app({ open: () => { opened++; return null; } });
  ui.get('mfa-code').value = '000123';
  await ui.submit();
  assert.equal(opened, 1);
  assert.equal(ui.get('mfa-code').value, '');
  assert.deepEqual(ui.requests.map((request) => request.url), ['/api/profiles']);
  assert.match(ui.get('notice').textContent, /Allow pop-ups/);
  assert.equal(ui.get('console-button').disabled, false);
});

test('console request preserves leading zero, locks selection and rejects duplicate submits', async () => {
  let resolveResponse;
  let opened = 0;
  let destination;
  const tab = consoleTab();
  tab.location.replace = (url) => { destination = url; };
  const ui = await app({ open: () => { opened++; return tab; }, consoleResponse: () => new Promise((resolve) => { resolveResponse = resolve; }) });
  ui.get('mfa-code').value = '000123';
  const submission = ui.submit();
  assert.equal(opened, 1);
  assert.equal(tab.document.title, 'Opening AWS Console');
  assert.match(tab.document.body.children[0].children[1].textContent, /Contacting AWS/);
  assert.equal(tab.opener, null);
  assert.equal(ui.get('mfa-code').value, '');
  assert.equal(ui.get('mfa-code').disabled, true);
  assert.equal(ui.get('console-button').disabled, true);
  assert.equal(ui.get('refresh-button').disabled, true);
  assert.equal(ui.get('switch-button').disabled, true);
  const otherProfile = ui.get('profile-list').children[1];
  assert.equal(otherProfile.disabled, true);
  otherProfile.dispatch('click');
  await ui.get('refresh-button').dispatch('click');
  await ui.get('switch-button').dispatch('click');
  await ui.submit();
  assert.equal(vm.runInContext('state.selected', ui.context), 'dev');
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.requests[1].options.headers['X-CSRF-Token'], 'test-csrf');
  assert.deepEqual(JSON.parse(ui.requests[1].options.body), { profile: 'dev', mfaCode: '000123' });
  resolveResponse({ ok: true, json: async () => ({ url: federationUrl(), expiration: '2099-01-01T00:00:00Z' }) });
  await submission;
  assert.equal(destination, federationUrl());
  assert.equal(ui.get('console-button').disabled, false);
  assert.equal(ui.get('mfa-code').value, '');
  assert.doesNotMatch(ui.get('notice').textContent, /EXAMPLE_TEST_TOKEN/);
  assert.doesNotMatch(ui.get('console-link').href, /EXAMPLE_TEST_TOKEN/);
  await ui.submit();
  assert.equal(opened, 1);
  assert.equal(ui.requests.length, 2);
  assert.match(ui.get('notice').textContent, /fresh six-digit/);
  ui.windowEvents.get('pagehide')();
  assert.equal(tab.closed, false, 'Leaving the switcher must not close a successfully opened AWS tab');
});

test('failed Console sign-in keeps an error visible in the new tab and app, clears MFA, and permits a fresh retry', async () => {
  const tab = consoleTab();
  const ui = await app({ open: () => tab, consoleResponse: async () => ({ ok: false, json: async () => ({ error: 'AWS rejected this code. Enter a fresh MFA code.' }) }) });
  ui.get('mfa-code').value = '123456';
  await ui.submit();
  assert.equal(tab.closed, false);
  assert.equal(tab.document.title, 'AWS Console sign-in failed');
  assert.match(tab.document.body.children[0].children[1].textContent, /AWS rejected/);
  assert.equal(tab.document.head.children.length, 1);
  assert.equal(ui.get('notice').scrolledIntoView, true);
  assert.equal(ui.get('mfa-code').value, '');
  assert.equal(ui.get('console-button').disabled, false);
  assert.equal(ui.get('refresh-button').disabled, false);
  assert.match(ui.get('notice').textContent, /AWS rejected/);
});

test('a malformed federation response stays visible without navigating or revealing the URL', async () => {
  const tab = consoleTab();
  tab.location.replace = () => { assert.fail('Must not navigate'); };
  const ui = await app({ open: () => tab, consoleResponse: async () => ({ ok: true, json: async () => ({ url: 'https://example.invalid/?SigninToken=EXAMPLE_TEST_TOKEN' }) }) });
  ui.get('mfa-code').value = '123456';
  await ui.submit();
  assert.equal(tab.closed, false);
  assert.match(tab.document.body.children[0].children[1].textContent, /invalid sign-in link/);
  assert.doesNotMatch(tab.document.body.children[0].children[1].textContent, /EXAMPLE_TEST_TOKEN/);
  assert.match(ui.get('notice').textContent, /invalid sign-in link/);
  assert.doesNotMatch(ui.get('notice').textContent, /EXAMPLE_TEST_TOKEN/);
});

test('Console timeout stays visible and browser navigation failures never echo a sign-in URL', async () => {
  for (const navigationFails of [false, true]) {
    const tab = consoleTab();
    if (navigationFails) tab.location.replace = () => { throw new Error(`Blocked ${federationUrl()}`); };
    const ui = await app({ open: () => tab, consoleResponse: async () => navigationFails
      ? { ok: true, json: async () => ({ url: federationUrl() }) }
      : { ok: false, json: async () => ({ error: 'AWS Console sign-in timed out while contacting signin.aws.amazon.com.' }) },
    });
    ui.get('mfa-code').value = '123456';
    await ui.submit();
    assert.equal(tab.closed, false);
    assert.match(tab.document.body.children[0].children[1].textContent, navigationFails ? /browser could not navigate/ : /timed out/);
    assert.doesNotMatch(ui.get('notice').textContent, /EXAMPLE_TEST_TOKEN|https:\/\//);
    assert.doesNotMatch(tab.document.body.children[0].children[1].textContent, /EXAMPLE_TEST_TOKEN|https:\/\//);
    assert.equal(ui.get('console-button').disabled, false);
  }
});

test('leaving during Console authentication closes only the pending tab and ignores a late response', async () => {
  const tab = consoleTab();
  let resolveResponse;
  const ui = await app({ open: () => tab, consoleResponse: () => new Promise((resolve) => { resolveResponse = resolve; }) });
  ui.get('mfa-code').value = '123456';
  const pending = ui.submit();
  ui.windowEvents.get('pagehide')();
  assert.equal(tab.closed, true);
  resolveResponse({ ok: true, json: async () => ({ url: federationUrl() }) });
  await pending;
  assert.equal(tab.location.destination, undefined);
});

test('profile changes and leaving the page clear MFA; unsupported profiles retain only manual fallback', async () => {
  const list = [profiles[0], { ...profiles[1], auth: { enabled: false, reason: 'Add mfa_serial to this profile.', mfaSerial: '' } }];
  const ui = await app({ list });
  ui.get('mfa-code').value = '123456';
  ui.get('profile-list').children[1].dispatch('click');
  assert.equal(ui.get('mfa-code').value, '');
  assert.equal(ui.get('console-button').disabled, true);
  assert.equal(ui.get('switch-button').disabled, true);
  assert.equal(ui.get('console-link').hidden, false);
  assert.equal(ui.get('console-reason').textContent, 'Add mfa_serial to this profile.');
  ui.get('profile-list').children[0].dispatch('click');
  ui.get('mfa-code').value = '123456';
  ui.windowEvents.get('pagehide')();
  assert.equal(ui.get('mfa-code').value, '');
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

test('starting Console sign-in clears previous CLI credentials even when popups are blocked', async () => {
  const ui = await app({ open: () => null });
  await ui.authenticate();
  ui.get('mfa-code').value = '654321';
  await ui.submit();
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
});
