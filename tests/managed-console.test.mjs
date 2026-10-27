// Author: jperch1987
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createManagedConsole, isAwsConsoleUrl, isSwitchRoleUrl, ManagedConsoleError, submitMatchingSwitchRole } from '../managed-console.mjs';

const profile = { profile: 'development', role_arn: 'arn:aws:iam::123456789012:role/team/Developer', source_profile: 'base' };
const switchUrl = 'https://signin.aws.amazon.com/switchrole?account=123456789012&roleName=team%2FDeveloper';
const consoleUrl = 'https://us-east-1.console.aws.amazon.com/console/home';
const expected = { accountId: '123456789012', roleName: 'team/Developer' };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

class Page {
  currentUrl = 'about:blank';
  closed = false;
  visits = [];
  evaluations = [];
  result = 'submitted';
  navigateAfterSubmit = true;
  async goto(url, options) { this.visits.push({ url, options }); this.currentUrl = this.visits.length === 1 && this.loginFirst ? 'https://signin.aws.amazon.com/signin' : url; }
  async bringToFront() {}
  isClosed() { return this.closed; }
  url() { return this.currentUrl; }
  async evaluate(fn, value) {
    this.evaluations.push({ fn, value });
    if (this.failure) throw this.failure;
    if (this.result === 'submitted' && this.navigateAfterSubmit) this.currentUrl = consoleUrl;
    return this.result;
  }
  async close() { this.closed = true; }
}

class Context extends EventEmitter {
  pages = [];
  closeCalls = 0;
  makePage = () => new Page();
  async newPage() { const page = await this.makePage(); this.pages.push(page); return page; }
  async close() { this.closeCalls += 1; for (const page of this.pages) await page.close(); this.emit('close'); }
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aws-managed-test-'));
  const context = options.context || new Context();
  const launches = [];
  const controller = createManagedConsole({ browserDirectory: path.join(directory, 'browser'),
    launchContext: async (...args) => { launches.push(args); return context; },
    timeoutMs: 2000, pollIntervalMs: 1, ...options });
  t.after(async () => { await controller.close(); await rm(directory, { recursive: true, force: true }); });
  return { controller, context, directory, launches };
}

async function waitState(controller, state) {
  const until = Date.now() + 2000;
  while (controller.status().state !== state && Date.now() < until) await sleep(2);
  assert.equal(controller.status().state, state, JSON.stringify(controller.status()));
  return controller.status();
}

test('allowlists only HTTPS AWS switch-role and Console pages', () => {
  assert.equal(isSwitchRoleUrl(switchUrl), true);
  assert.equal(isSwitchRoleUrl('https://signin.aws.amazon.com/switchrole/'), true);
  assert.equal(isAwsConsoleUrl(consoleUrl), true);
  assert.equal(isAwsConsoleUrl('https://123456789012-alias.us-east-1.console.aws.amazon.com/'), true);
  for (const value of ['http://signin.aws.amazon.com/switchrole', 'https://signin.aws.amazon.com.evil.test/switchrole', 'https://user:secret@signin.aws.amazon.com/switchrole', 'https://signin.aws.amazon.com:444/switchrole', 'https://signin.aws.amazon.com/federation', 'javascript:alert(1)']) assert.equal(isSwitchRoleUrl(value), false, value);
  for (const value of ['http://console.aws.amazon.com/', 'https://console.aws.amazon.com.evil.test/', 'https://evilconsole.aws.amazon.com/', 'https://console.aws.amazon.com:444/', 'https://user@console.aws.amazon.com/', 'https://signin.aws.amazon.com/switchrole']) assert.equal(isAwsConsoleUrl(value), false, value);
});

test('rejects unsupported targets before launching, and status copies cannot mutate controller state', async (t) => {
  const { controller, launches } = await fixture(t);
  for (const value of [null, { ...profile, profile: '' }, { ...profile, external_id: 'client-id' }, { ...profile, role_arn: 'arn:aws-cn:iam::123456789012:role/Developer' }]) {
    assert.throws(() => controller.start(value), ManagedConsoleError);
  }
  assert.equal(launches.length, 0);
  controller.status().state = 'error';
  assert.equal(controller.status().state, 'idle');
});

test('visible sandboxed browser uses a private persistent directory and reuses its context', async (t) => {
  const { controller, context, directory, launches } = await fixture(t);
  assert.equal(controller.start(profile).state, 'starting');
  assert.throws(() => controller.start(profile), (error) => error.statusCode === 409);
  const result = await waitState(controller, 'opened');
  assert.deepEqual(Object.keys(result).sort(), ['message', 'profile', 'state']);
  assert.match(result.message, /Check the account and role/);
  assert.deepEqual(context.pages[0].evaluations[0].value, expected);
  assert.equal(context.pages[0].closed, false);
  assert.deepEqual(launches[0], [path.join(directory, 'browser'), { headless: false, chromiumSandbox: true, viewport: null, acceptDownloads: false, timeout: 30_000 }]);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'browser'))).mode & 0o777, 0o700);
  controller.start({ ...profile, profile: 'second' });
  await waitState(controller, 'opened');
  assert.equal(controller.status().profile, 'second');
  assert.equal(launches.length, 1);
  assert.equal(context.pages.length, 2);
});

test('manual sign-in is untouched and returning to Console opens the selected switch form once', async (t) => {
  const context = new Context();
  const page = new Page();
  page.loginFirst = true;
  context.makePage = () => page;
  const { controller } = await fixture(t, { context });
  controller.start(profile);
  await waitState(controller, 'waiting-for-login');
  assert.equal(page.evaluations.length, 0);
  page.currentUrl = 'https://client-idp.example.test/login?secret=PRIVATE';
  await sleep(5);
  assert.equal(page.evaluations.length, 0);
  assert.doesNotMatch(JSON.stringify(controller.status()), /PRIVATE|example\.test/);
  page.currentUrl = consoleUrl;
  await waitState(controller, 'opened');
  assert.deepEqual(page.visits.map((visit) => visit.url), [switchUrl, switchUrl]);
  assert.equal(page.evaluations.length, 1);
});

test('account mismatch fails without another evaluation or submission attempt', async (t) => {
  const context = new Context();
  const page = new Page();
  page.result = 'mismatch';
  context.makePage = () => page;
  const { controller } = await fixture(t, { context });
  controller.start(profile);
  await waitState(controller, 'error');
  assert.match(controller.status().message, /Nothing was submitted/);
  await sleep(5);
  assert.equal(page.evaluations.length, 1);
  assert.equal(page.closed, false);
});

test('AWS validation failures never cause repeat clicks and do not claim success', async (t) => {
  const context = new Context();
  const page = new Page();
  page.navigateAfterSubmit = false;
  context.makePage = () => page;
  const { controller } = await fixture(t, { context, switchWaitMs: 10 });
  controller.start(profile);
  await waitState(controller, 'error');
  assert.equal(page.evaluations.length, 1);
  assert.match(controller.status().message, /Check the AWS page/);
  assert.equal(page.closed, false);
});

test('cancel closes only the pending tab, prevents more evaluations, and permits another switch', async (t) => {
  const context = new Context();
  const page = new Page();
  page.result = 'not-ready';
  context.makePage = () => page;
  const { controller } = await fixture(t, { context });
  controller.start(profile);
  await waitState(controller, 'waiting-for-login');
  assert.equal(controller.cancel().state, 'cancelled');
  const count = page.evaluations.length;
  await sleep(10);
  assert.equal(page.evaluations.length, count);
  assert.equal(page.closed, true);
  assert.equal(context.closeCalls, 0);
  context.makePage = () => new Page();
  controller.start(profile);
  await waitState(controller, 'opened');
  assert.equal(controller.cancel().state, 'opened');
  assert.equal(context.pages[1].closed, false);
});

test('cancel during newPage closes the late tab before navigation or clicking', async (t) => {
  const context = new Context();
  const gate = deferred();
  const requested = deferred();
  context.makePage = () => { requested.resolve(); return gate.promise; };
  const { controller } = await fixture(t, { context });
  controller.start(profile);
  await requested.promise;
  controller.cancel();
  const page = new Page();
  gate.resolve(page);
  await sleep(5);
  assert.equal(page.closed, true);
  assert.equal(page.visits.length, 0);
  assert.equal(page.evaluations.length, 0);
  assert.equal(controller.status().state, 'cancelled');
});

test('late launch after cancellation is reusable, while close is idempotent and closes it', async (t) => {
  const gate = deferred();
  const requested = deferred();
  const context = new Context();
  const { controller } = await fixture(t, { launchContext: () => { requested.resolve(); return gate.promise; } });
  controller.start(profile);
  await requested.promise;
  controller.cancel();
  gate.resolve(context);
  await sleep(5);
  assert.equal(context.pages.length, 0);
  controller.start(profile);
  await waitState(controller, 'opened');
  const closing = controller.close();
  assert.equal(controller.close(), closing);
  await closing;
  assert.equal(context.closeCalls, 1);
  assert.throws(() => controller.start(profile), (error) => error.statusCode === 503);
});

test('closed browser can be relaunched and login timeout releases the active job', async (t) => {
  const context = new Context();
  const page = new Page();
  page.loginFirst = true;
  context.makePage = () => page;
  const { controller, launches } = await fixture(t, { context, timeoutMs: 30 });
  controller.start(profile);
  await waitState(controller, 'error');
  assert.match(controller.status().message, /timed out/);
  await context.close();
  context.makePage = () => new Page();
  controller.start(profile);
  await waitState(controller, 'opened');
  assert.equal(launches.length, 2);
});

test('browser failures are fixed actionable messages without raw URLs or secrets', async (t) => {
  for (const [message, code, expectedText] of [
    ["Cannot find package 'playwright' PRIVATE", 'ERR_MODULE_NOT_FOUND', /npm ci/],
    ["Executable doesn't exist: PRIVATE", null, /browser is missing/],
    ['Missing X server or $DISPLAY PRIVATE', null, /WSL 2/],
    ['Host system is missing dependencies PRIVATE', null, /with-deps/],
    ['ProcessSingleton PRIVATE', null, /already in use/],
    ['AWS failed https://signin.aws.amazon.com/?SigninToken=PRIVATE', null, /could not finish/],
  ]) {
    const error = new Error(message);
    error.code = code;
    const { controller } = await fixture(t, { launchContext: async () => { throw error; } });
    controller.start(profile);
    const result = await waitState(controller, 'error');
    assert.match(result.message, expectedText);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SigninToken|https:/);
  }
});

function formFixture({ accountValue = expected.accountId, roleValue = expected.roleName, locationUrl = switchUrl, buttonText = 'Switch Role', extraInput, duplicateButton = false, disabled = false } = {}) {
  const location = new URL(locationUrl);
  let clicks = 0;
  const form = { querySelectorAll(selector) { return selector === 'input' ? inputs : buttons; } };
  const input = (name, value, type = 'text') => ({ name, id: name, value, type, form, labels: [], getAttribute: () => null, getClientRects: () => [1] });
  const inputs = [input('account', accountValue), input('roleName', roleValue)];
  if (extraInput) inputs.push(input(extraInput, 'NEVER_READ', extraInput === 'password' ? 'password' : 'text'));
  const button = () => ({ textContent: buttonText, disabled, getAttribute: () => null, getClientRects: () => [1], click: () => { clicks += 1; } });
  const buttons = [button()];
  if (duplicateButton) buttons.push(button());
  const document = { querySelectorAll: () => inputs };
  return { run: () => vm.runInNewContext(`(${submitMatchingSwitchRole.toString()})(expected)`, { expected, location, document, getComputedStyle: () => ({ visibility: 'visible' }) }), clicks: () => clicks, inputs };
}

test('atomic form check clicks exactly once only with matching visible account, full role path, and exact button', () => {
  const fixture = formFixture({});
  assert.equal(fixture.run(), 'submitted');
  assert.equal(fixture.clicks(), 1);
  for (const options of [{ accountValue: '999999999999' }, { roleValue: 'Developer' }, { locationUrl: 'https://evil.test/switchrole' }, { locationUrl: 'https://signin.aws.amazon.com/signin' }, { buttonText: 'Sign in' }, { extraInput: 'password' }, { extraInput: 'otp' }, { extraInput: 'mfaCode' }, { duplicateButton: true }, { disabled: true }]) {
    const denied = formFixture(options);
    assert.notEqual(denied.run(), 'submitted', JSON.stringify(options));
    assert.equal(denied.clicks(), 0);
  }
});

test('form target changes before evaluation cannot submit a different selected role', () => {
  const fixture = formFixture({});
  fixture.inputs[1].value = 'Administrator';
  assert.equal(fixture.run(), 'mismatch');
  assert.equal(fixture.clicks(), 0);
});
