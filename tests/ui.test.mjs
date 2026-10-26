// Author: jperch1987
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const profiles = ['dev', 'production'].map((profile) => ({
  profile, role_arn: 'arn:aws:iam::123456789012:role/Developer', source_profile: 'base', region: 'us-east-1',
  auth: { enabled: true, reason: null, mfaSerial: 'arn:aws:iam::123456789012:mfa/example' },
  console: { url: 'https://signin.aws.amazon.com/switchrole?account=123456789012&roleName=Developer' },
}));

function federationUrl(destination = 'https://console.aws.amazon.com/console/home?region=us-east-1') {
  return `https://signin.aws.amazon.com/federation?${new URLSearchParams({ Action: 'login', Destination: destination, SigninToken: 'EXAMPLE_TEST_TOKEN' })}`;
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
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'href') delete this.href; }
  append(...elements) { for (const element of elements) this.children.push(...(element.tagName === 'FRAGMENT' ? element.children : [element])); }
  replaceChildren(...elements) { this.children = []; this.append(...elements); }
  addEventListener(name, handler) { this.events.set(name, handler); }
  dispatch(name) { return this.events.get(name)?.({ preventDefault() {} }); }
  querySelector() { return this.label ||= new Element('span'); }
  focus() { this.focused = true; }
}

async function app({ list = profiles, open, consoleResponse, activeResponse } = {}) {
  const elements = new Map([...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/g)].map((match) => [match[2], new Element(match[1])]));
  const prompt = new Element('span');
  const tabs = ['posix', 'powershell'].map((shell) => Object.assign(new Element('button'), { dataset: { shell } }));
  const requests = [];
  const windowEvents = new Map();
  const context = vm.createContext({
    URL, Set, setTimeout, clearTimeout,
    window: { open: open || (() => { throw new Error('Unexpected popup'); }), addEventListener: (name, callback) => windowEvents.set(name, callback) },
    document: {
      getElementById: (id) => { assert.ok(elements.has(id), `UI references missing element: ${id}`); return elements.get(id); },
      createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element('fragment'),
      querySelector: () => prompt, querySelectorAll: () => tabs, addEventListener() {},
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/profiles') return { ok: true, json: async () => ({ profiles: list, token: 'test-csrf' }) };
      if (url === '/api/console') return consoleResponse(options);
      if (url === '/api/active') return activeResponse(options);
      throw new Error('Unexpected request');
    },
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  const get = (id) => elements.get(id);
  assert.equal(vm.runInContext('state.profiles.length', context), list.length, get('notice').textContent);
  return { get, context, requests, windowEvents, submit: () => get('console-form').dispatch('submit') };
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
  const tab = { opener: {}, closed: false, close() { this.closed = true; }, location: { replace(url) { destination = url; } } };
  const ui = await app({ open: () => { opened++; return tab; }, consoleResponse: () => new Promise((resolve) => { resolveResponse = resolve; }) });
  ui.get('mfa-code').value = '000123';
  const submission = ui.submit();
  assert.equal(opened, 1);
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
});

test('failed Console sign-in closes the tab, clears MFA, and permits a fresh retry', async () => {
  const tab = { opener: {}, closed: false, close() { this.closed = true; } };
  const ui = await app({ open: () => tab, consoleResponse: async () => ({ ok: false, json: async () => ({ error: 'AWS rejected this code. Enter a fresh MFA code.' }) }) });
  ui.get('mfa-code').value = '123456';
  await ui.submit();
  assert.equal(tab.closed, true);
  assert.equal(ui.get('mfa-code').value, '');
  assert.equal(ui.get('console-button').disabled, false);
  assert.equal(ui.get('refresh-button').disabled, false);
  assert.match(ui.get('notice').textContent, /AWS rejected/);
});

test('a malformed federation response closes the new tab without navigating', async () => {
  const tab = { opener: {}, closed: false, close() { this.closed = true; }, location: { replace() { assert.fail('Must not navigate'); } } };
  const ui = await app({ open: () => tab, consoleResponse: async () => ({ ok: true, json: async () => ({ url: 'https://example.invalid/?SigninToken=EXAMPLE_TEST_TOKEN' }) }) });
  ui.get('mfa-code').value = '123456';
  await ui.submit();
  assert.equal(tab.closed, true);
  assert.match(ui.get('notice').textContent, /invalid sign-in link/);
  assert.doesNotMatch(ui.get('notice').textContent, /EXAMPLE_TEST_TOKEN/);
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

test('saved CLI selection remains reusable and is never presented as authenticated', async () => {
  const ui = await app({ activeResponse: async () => ({ ok: true, json: async () => ({ profile: profiles[0], commands: { posix: 'example-helper dev', powershell: 'example-helper dev' } }) }) });
  await ui.get('switch-button').dispatch('click');
  assert.equal(ui.get('switch-button').disabled, false);
  assert.equal(ui.get('switch-label').textContent, 'Refresh CLI command');
  assert.equal(ui.get('active-status').textContent, 'Selection only');
  assert.match(ui.get('notice').textContent, /fresh MFA code in your terminal/);
  await ui.get('switch-button').dispatch('click');
  assert.equal(ui.requests.filter((request) => request.url === '/api/active').length, 2);
});
