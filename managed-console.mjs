// Author: jperch1987
import { chmod, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildConsoleTarget } from './console-target.mjs';

const MAX_WAIT_MS = 5 * 60_000;
const SWITCH_WAIT_MS = 30_000;

export class ManagedConsoleError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ManagedConsoleError';
    this.statusCode = statusCode;
  }
}

function awsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url;
  } catch { return null; }
}

export function isSwitchRoleUrl(value) {
  const url = awsUrl(value);
  return Boolean(url && url.hostname === 'signin.aws.amazon.com' && /^\/switchrole\/?$/.test(url.pathname));
}

export function isAwsConsoleUrl(value) {
  const url = awsUrl(value);
  return Boolean(url && (url.hostname === 'console.aws.amazon.com' || url.hostname.endsWith('.console.aws.amazon.com')));
}

// Runs as one browser task: validate the current origin, visible form, exact
// account/role, and button immediately before dispatching the click. Never read
// or submit sign-in/MFA inputs, hidden tokens, cookies, or browser storage.
export function submitMatchingSwitchRole(expected) {
  if (location.protocol !== 'https:' || location.hostname !== 'signin.aws.amazon.com'
    || location.port || !/^\/switchrole\/?$/.test(location.pathname)) return 'wrong-page';
  const visible = (element) => Boolean(element.getClientRects().length)
    && getComputedStyle(element).visibility !== 'hidden';
  const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ');
  const label = (input) => normalize(input.getAttribute('aria-label') || Array.from(input.labels || [], (item) => item.textContent).join(' '));
  const inputs = Array.from(document.querySelectorAll('input')).filter((input) => input.type !== 'hidden' && visible(input));
  const accounts = inputs.filter((input) => [input.name, input.id].some((name) => /^(?:account|accountid|account-id)$/i.test(name))
    || /^account(?: id)?(?: or (?:account )?alias)?$/i.test(label(input)));
  const roles = inputs.filter((input) => [input.name, input.id].some((name) => /^(?:role|rolename|role-name)$/i.test(name))
    || /^(?:iam )?role(?: name)?$/i.test(label(input)));
  if (!accounts.length || !roles.length) return 'not-ready';
  if (accounts.length !== 1 || roles.length !== 1) return 'ambiguous';
  const account = accounts[0];
  const role = roles[0];
  if (account.value.trim() !== expected.accountId || role.value.trim() !== expected.roleName) return 'mismatch';
  const form = account.form;
  if (!form || role.form !== form) return 'not-ready';
  if (Array.from(form.querySelectorAll('input')).some((input) => input.type === 'password'
    || (input.type !== 'hidden' && visible(input) && /(?:password|mfa|otp|verification.?code|authentication.?code)/i.test(`${input.name} ${input.id} ${label(input)}`)))) return 'manual-only';
  const buttons = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]'))
    .filter((button) => visible(button) && /^switch role$/i.test(normalize(button.getAttribute('aria-label') || button.textContent || button.value)));
  if (buttons.length !== 1) return buttons.length ? 'ambiguous' : 'not-ready';
  const button = buttons[0];
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') return 'not-ready';
  button.click();
  return 'submitted';
}

function safeBrowserError(error) {
  if (error instanceof ManagedConsoleError) return error.message;
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return 'The app cannot access its browser profile directory. Check that your user can read and write the app state folder.';
  }
  const message = String(error?.message || '');
  if (error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package ['"]playwright/.test(message)) {
    return 'Install the app dependencies with npm ci, then install its browser with npx playwright install chromium.';
  }
  if (/Executable doesn.t exist|browserType\.launch.*executable|playwright install/i.test(message)) {
    return 'The app browser is missing. Run npx playwright install chromium, then try again.';
  }
  if (/Missing X server|\$DISPLAY|cannot open display|ozone_platform_x11|XServer/i.test(message)) {
    return 'The app browser needs a desktop display. On Debian WSL, use WSL 2 with GUI support (WSLg), then try again.';
  }
  if (/Host system is missing dependencies|error while loading shared libraries|lib[^\s]+\.so/i.test(message)) {
    return 'The browser needs Linux system libraries. Run npx playwright install --with-deps chromium, then try again.';
  }
  if (/ProcessSingleton|SingletonLock|profile.*in use|user data directory.*in use/i.test(message)) {
    return 'The app browser profile is already in use. Close the other profile-switcher browser or app instance, then try again.';
  }
  return 'The app browser could not finish switching roles. Check its window, then try again. If it cannot open, reinstall the browser with npx playwright install chromium.';
}

async function launchBrowser(directory, options) {
  const { chromium } = await import('playwright');
  return chromium.launchPersistentContext(directory, options);
}

function pause(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createManagedConsole({ browserDirectory, launchContext = launchBrowser,
  timeoutMs = MAX_WAIT_MS, pollIntervalMs = 250, switchWaitMs = SWITCH_WAIT_MS } = {}) {
  if (typeof browserDirectory !== 'string' || !path.isAbsolute(browserDirectory)) {
    throw new ManagedConsoleError('The app browser requires its own absolute profile directory.', 500);
  }
  // Shorter limits are useful to exercise cancellation and deadlines in tests.
  const waitLimit = Math.min(MAX_WAIT_MS, Math.max(1, timeoutMs));
  const switchLimit = Math.min(SWITCH_WAIT_MS, Math.max(1, switchWaitMs));
  const polling = Math.min(1000, Math.max(1, pollIntervalMs));
  let snapshot = { state: 'idle', profile: null, message: 'The app browser is ready.' };
  let context = null;
  let launching = null;
  let active = null;
  let shuttingDown = false;
  let closing = null;
  const jobs = new Set();
  const status = () => ({ ...snapshot });
  const current = (job) => active === job && !job.controller.signal.aborted && !shuttingDown;
  const update = (job, state, message) => { if (current(job)) snapshot = { state, profile: job.profile, message }; };

  async function getContext() {
    if (context) return context;
    if (!launching) {
      launching = (async () => {
        await mkdir(browserDirectory, { recursive: true, mode: 0o700 });
        const info = await lstat(browserDirectory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new ManagedConsoleError('The app browser profile must be a dedicated directory, not a symbolic link.', 500);
        if (process.platform !== 'win32') await chmod(browserDirectory, 0o700);
        const opened = await launchContext(browserDirectory, {
          headless: false, chromiumSandbox: true, viewport: null,
          acceptDownloads: false, timeout: 30_000,
        });
        if (shuttingDown) {
          await opened.close();
          throw new ManagedConsoleError('The app is shutting down.', 503);
        }
        context = opened;
        opened.on('close', () => { if (context === opened) context = null; });
        return opened;
      })();
      launching.finally(() => { launching = null; }).catch(() => {});
    }
    return launching;
  }

  async function navigate(page, url) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }); }
    catch (error) { if (error?.name !== 'TimeoutError') throw error; }
  }

  async function run(job) {
    try {
      const browser = await getContext();
      if (!current(job)) return;
      const page = await browser.newPage();
      job.page = page;
      if (!current(job)) { await page.close().catch(() => {}); return; }
      await page.bringToFront();
      if (!current(job)) return;
      await navigate(page, job.target.url);
      let returnedToRole = false;
      let submittedAt = null;
      while (current(job)) {
        if (page.isClosed()) throw new ManagedConsoleError('The app browser tab was closed. Choose Open AWS Console to try again.');
        if (Date.now() >= job.deadline) throw new ManagedConsoleError('Console switching timed out after five minutes. Finish signing in in the app browser, then try again.');
        const url = page.url();
        if (isAwsConsoleUrl(url)) {
          if (submittedAt !== null) {
            update(job, 'opened', 'AWS Console opened after the role switch. Check the account and role shown in the AWS header before working.');
            return;
          }
          if (returnedToRole) throw new ManagedConsoleError('AWS did not show the selected Switch Role form. Check the app browser, then try again.');
          returnedToRole = true;
          if (!current(job)) return;
          await navigate(page, job.target.url);
          continue;
        }
        if (submittedAt !== null) {
          if (Date.now() - submittedAt >= switchLimit) throw new ManagedConsoleError('AWS did not open the Console after Switch Role. Check the AWS page for a permissions or sign-in error, then try again.');
        } else if (isSwitchRoleUrl(url)) {
          if (!current(job)) return;
          const result = await page.evaluate(submitMatchingSwitchRole, { accountId: job.target.accountId, roleName: job.target.roleName });
          if (!current(job)) return;
          if (result === 'submitted') {
            submittedAt = Date.now();
            update(job, 'switching', 'Switch Role submitted. Waiting for AWS Console to open.');
          } else if (result === 'mismatch' || result === 'ambiguous') {
            throw new ManagedConsoleError('The AWS Switch Role form does not match the selected account and role. Nothing was submitted. Choose the profile again to retry.');
          } else {
            update(job, 'waiting-for-login', 'Sign in and complete any MFA in the app browser. The app will click Switch Role when the selected account and role are shown.');
          }
        } else {
          update(job, 'waiting-for-login', 'Sign in and complete any MFA in the app browser. The app will then switch to the selected role.');
        }
        await pause(polling, job.controller.signal);
      }
    } catch (error) {
      update(job, 'error', safeBrowserError(error));
    } finally {
      if (active === job) active = null;
    }
  }

  function start(profile) {
    if (shuttingDown) throw new ManagedConsoleError('The app is shutting down.', 503);
    if (active) throw new ManagedConsoleError('A Console switch is already in progress. Finish or cancel it first.', 409);
    if (!profile || typeof profile.profile !== 'string' || !profile.profile.trim()) throw new ManagedConsoleError('Choose a valid profile.');
    if (profile.external_id) throw new ManagedConsoleError('AWS browser role switching does not support profiles that require external_id.');
    const target = buildConsoleTarget(profile);
    if (!target.url) throw new ManagedConsoleError(target.reason);
    const job = { profile: profile.profile, target, page: null, controller: new AbortController(), deadline: Date.now() + waitLimit };
    active = job;
    snapshot = { state: 'starting', profile: job.profile, message: 'Opening the app browser for AWS Console.' };
    const task = run(job);
    jobs.add(task);
    task.finally(() => jobs.delete(task)).catch(() => {});
    return status();
  }

  function cancel() {
    if (active) {
      const job = active;
      job.controller.abort();
      active = null;
      snapshot = { state: 'cancelled', profile: job.profile, message: 'Console switching cancelled. A switch already submitted to AWS cannot be undone.' };
      if (job.page) void job.page.close().catch(() => {});
    }
    return status();
  }

  function close() {
    if (closing) return closing;
    cancel();
    shuttingDown = true;
    closing = (async () => {
      if (context) await context.close().catch(() => {});
      if (launching) await launching.catch(() => {});
      await Promise.allSettled([...jobs]);
      context = null;
    })();
    return closing;
  }
  return { start, status, cancel, close };
}
