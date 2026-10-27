// Author: jperch1987
// Optional real-Chromium smoke test: npm run test:browser.
// Every page request is fulfilled locally or denied. No real AWS endpoint,
// login, credentials, browser profile, or cookie store is used.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createManagedConsole } from '../managed-console.mjs';

const profile = { profile: 'browser-smoke', role_arn: 'arn:aws:iam::123456789012:role/team/Developer', source_profile: 'test-only' };
const consoleUrl = 'https://us-east-1.console.aws.amazon.com/console/home';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const html = (body) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local browser test fixture</title><body>${body}</body></html>`;
// Start a new, independently intercepted navigation. Avoid HTTP redirects,
// whose follow-up requests can differ in routing behavior between browsers.
const navigateToConsole = html(`<p>Local fixture navigation</p><script>setTimeout(() => location.replace(${JSON.stringify(consoleUrl)}), 10)</script>`);

async function waitState(controller, state) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = controller.status();
    if (result.state === state) return result;
    if (result.state === 'error') assert.fail(`Unexpected controller error: ${result.message}`);
    await sleep(20);
  }
  assert.equal(controller.status().state, state, 'The local browser fixture did not reach the expected state.');
}

async function fixture(t, { signedIn = false, wrongAccount = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aws-browser-smoke-'));
  const submissions = [];
  const requests = [];
  let context;
  const controller = createManagedConsole({
    browserDirectory: path.join(directory, 'browser'), timeoutMs: 30_000, pollIntervalMs: 20,
    launchContext: async (browserDirectory, options) => {
      context = await chromium.launchPersistentContext(browserDirectory, {
        ...options, headless: true, serviceWorkers: 'block',
      });
      // There is deliberately no route.continue()/fallback(): unknown hosts and
      // paths receive a local denial, even if application code navigates there.
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requests.push(`${request.method()} ${url.origin}${url.pathname}`);
        if (url.origin === 'https://signin.aws.amazon.com' && url.pathname === '/switchrole' && request.method() === 'GET') {
          if (!signedIn) {
            await route.fulfill({ status: 200, contentType: 'text/html', body: html('<h1>Local fake sign-in</h1><form action="/test-manual-login" method="post"><button type="submit">Complete test sign-in</button></form>') });
          } else {
            const account = wrongAccount ? '999999999999' : '123456789012';
            await route.fulfill({ status: 200, contentType: 'text/html', body: html(`<h1>Local fake Switch Role</h1><form action="/test-complete-switch" method="post"><label>Account ID<input name="account" value="${account}"></label><label>Role<input name="roleName" value="team/Developer"></label><button type="submit">Switch Role</button></form>`) });
          }
          return;
        }
        if (url.origin === 'https://signin.aws.amazon.com' && url.pathname === '/test-manual-login' && request.method() === 'POST') {
          signedIn = true;
          await route.fulfill({ status: 200, contentType: 'text/html', body: navigateToConsole });
          return;
        }
        if (url.origin === 'https://signin.aws.amazon.com' && url.pathname === '/test-complete-switch' && request.method() === 'POST') {
          const data = new URLSearchParams(request.postData());
          submissions.push({ account: data.get('account'), role: data.get('roleName') });
          await route.fulfill({ status: 200, contentType: 'text/html', body: navigateToConsole });
          return;
        }
        if (request.method() === 'GET' && url.href === consoleUrl) {
          await route.fulfill({ status: 200, contentType: 'text/html', body: html('<h1>Local fake AWS Console</h1>') });
          return;
        }
        await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Network access denied by local smoke test.' });
      });
      return context;
    },
  });
  t.after(async () => {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { controller, submissions, requests, context: () => context };
}

test('real Chromium switches the matching form exactly once after a simulated manual login', { timeout: 45_000 }, async (t) => {
  const { controller, submissions, requests, context } = await fixture(t);
  assert.equal(controller.start(profile).state, 'starting');
  await waitState(controller, 'waiting-for-login');
  assert.deepEqual(submissions, []);
  const page = context().pages().find((candidate) => candidate.url().startsWith('https://signin.aws.amazon.com/switchrole'));
  assert.ok(page, 'Expected the controller tab to contain the local fake sign-in page.');
  // This click represents the user signing in. The controller must never click it.
  await page.getByRole('button', { name: 'Complete test sign-in', exact: true }).click();
  await waitState(controller, 'opened');
  assert.deepEqual(submissions, [{ account: '123456789012', role: 'team/Developer' }]);
  assert.equal(requests.filter((request) => request === 'GET https://signin.aws.amazon.com/switchrole').length, 2);
  assert.equal(requests.filter((request) => request === 'POST https://signin.aws.amazon.com/test-complete-switch').length, 1);
  assert.equal(page.url(), consoleUrl);
  assert.equal(page.isClosed(), false);
  assert.equal(await page.getByRole('heading', { name: 'Local fake AWS Console' }).count(), 1);
});

test('real Chromium does not click a form with a different target account', { timeout: 45_000 }, async (t) => {
  const { controller, submissions, requests } = await fixture(t, { signedIn: true, wrongAccount: true });
  controller.start(profile);
  await waitState(controller, 'error');
  assert.match(controller.status().message, /does not match/);
  assert.deepEqual(submissions, []);
  assert.equal(requests.some((request) => request.includes('/test-complete-switch')), false);
});

test('real Chromium cancellation closes the waiting tab without submitting login or switch forms', { timeout: 45_000 }, async (t) => {
  const { controller, submissions, requests, context } = await fixture(t);
  controller.start(profile);
  await waitState(controller, 'waiting-for-login');
  const page = context().pages().find((candidate) => candidate.url().startsWith('https://signin.aws.amazon.com/switchrole'));
  const closed = page.waitForEvent('close', { timeout: 5000 });
  assert.equal(controller.cancel().state, 'cancelled');
  await closed;
  assert.equal(page.isClosed(), true);
  assert.deepEqual(submissions, []);
  assert.equal(requests.some((request) => request.startsWith('POST ')), false);
});
