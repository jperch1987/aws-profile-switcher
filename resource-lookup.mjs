// Author: jperch1987
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const RESOURCE_TYPES = Object.freeze(['ec2', 'ebs', 'security-group', 'vpc', 's3', 'rds', 'lambda', 'eks', 'elasticache', 'route53', 'load-balancer']);
const CHECK_STATES = new Set(['found', 'not_found', 'access_denied', 'auth_failed', 'error', 'skipped']);
const REGION = /^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*$/;
const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
const cleanString = (value, maximum = 1024) => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);

export class LookupError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'LookupError'; this.status = status; }
}

export function validateLookupRequest(body, profiles) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== 'mfaCode,profiles,query,resourceType'
    || !Array.isArray(body.profiles) || body.profiles.length < 1 || body.profiles.length > 250
    || body.profiles.some((name) => !cleanString(name, 2048) || !name)
    || new Set(body.profiles).size !== body.profiles.length) {
    throw new LookupError('Choose between 1 and 250 distinct role profiles for the lookup.');
  }
  if (!RESOURCE_TYPES.includes(body.resourceType)) throw new LookupError('Choose a supported resource type.');
  if (!cleanString(body.query, 256) || !body.query.trim()) throw new LookupError('Enter a resource ID, exact name, or ARN using at most 256 characters on one line.');
  if (typeof body.mfaCode !== 'string' || !/^[0-9]{6}$/.test(body.mfaCode)) throw new LookupError('Enter a fresh six-digit MFA code for this lookup.');
  const targets = body.profiles.map((name) => {
    const profile = profiles.find((item) => item.profile === name);
    if (!profile) throw new LookupError('A selected profile no longer exists. Refresh the profile list.', 404);
    if (profile.auth?.enabled !== true) throw new LookupError('Every selected profile must support IAM-user MFA authentication.', 422);
    const accountId = /^arn:aws:iam::([0-9]{12}):role\//.exec(profile.role_arn || '')?.[1];
    const source = profiles.find((item) => item.profile === profile.source_profile);
    const region = profile.region || source?.region || 'us-east-1';
    if (!accountId || !REGION.test(region)) throw new LookupError('A selected profile has an unsupported account or region.', 422);
    return { profile: profile.profile, accountId, region, source: profile.source_profile, mfa: profile.auth.mfaSerial };
  });
  if (targets.some((target) => target.source !== targets[0].source || target.mfa !== targets[0].mfa)) {
    throw new LookupError('Search profiles with the same source identity and MFA device together. Use a fresh code for each identity.', 422);
  }
  return { profiles: targets.map(({ profile, accountId, region }) => ({ profile, accountId, region })), query: body.query.trim(), resourceType: body.resourceType };
}

// Only the short-lived Python worker sees source and session keys. Node forwards
// MFA transiently over stdin; stored jobs contain only allowlisted metadata.
export function createLookupManager({ python, configFile, spawnProcess = spawn, timeoutMs = 600_000, retentionMs = 600_000 } = {}) {
  let current = null;
  let closed = false;
  const snapshot = (job) => structuredClone(job.data);
  const running = () => current?.data.state === 'running';
  function stopProcess(job) {
    if (!job.child) return;
    try { job.child.stdin.destroy(); job.child.kill(); } catch { /* Process may have already exited. */ }
    job.killTimer = setTimeout(() => { try { if (job.child.exitCode == null) job.child.kill('SIGKILL'); } catch {} }, 1000);
    job.killTimer.unref?.();
  }
  function finish(job, state, message, kill = false) {
    if (job.data.state !== 'running') return;
    clearTimeout(job.deadline);
    job.buffer = '';
    for (const target of job.data.profiles) {
      if (!job.data.checks.some((check) => check.profile === target.profile)) {
        job.data.checks.push({ ...target, status: 'skipped', message: 'This profile was not fully searched. Run a new lookup to check it.' });
      }
    }
    job.data.state = state;
    job.data.completed = job.data.checks.length;
    job.data.message = message;
    job.data.expiresAt = new Date(Date.now() + retentionMs).toISOString();
    if (kill) stopProcess(job);
    job.expiry = setTimeout(() => { if (current === job) current = null; }, retentionMs);
    job.expiry.unref?.();
  }
  function badWorker(job) { finish(job, 'error', 'The lookup helper returned an invalid response. Results may be incomplete.', true); }
  function handleEvent(job, event) {
    if (job.data.state !== 'running') return;
    if (!event || typeof event !== 'object' || Array.isArray(event)) return badWorker(job);
    if (event.event === 'complete') {
      if (job.data.checks.length !== job.data.total) return badWorker(job);
      job.completeReceived = true;
      return;
    }
    if (job.completeReceived) return badWorker(job);
    if (event.event === 'error') {
      // Worker messages must be deliberately safe fixed diagnostics, never raw
      // SDK exceptions. Ignore all other fields even if a helper includes them.
      if (!cleanString(event.message, 500) || !event.message) return badWorker(job);
      finish(job, 'error', event.message, true);
      return;
    }
    const check = event.check;
    const target = job.data.profiles.find((item) => item.profile === check?.profile);
    if (event.event !== 'profile' || !target || job.data.checks.some((item) => item.profile === target.profile)
      || check.accountId !== target.accountId || check.region !== target.region || !CHECK_STATES.has(check.status)
      || !cleanString(check.message, 500) || !Array.isArray(event.results) || event.results.length > 100) return badWorker(job);
    const rows = [];
    for (const item of event.results) {
      if (!item || item.profile !== target.profile || item.accountId !== target.accountId || item.resourceType !== job.data.resourceType
        || !['region', 'resourceId', 'name', 'arn'].every((key) => cleanString(item[key])) || !item.resourceId
        || (!['s3', 'route53'].includes(job.data.resourceType) && item.region !== target.region)
        || (job.data.resourceType === 'route53' && item.region !== 'global')
        || (job.data.resourceType === 's3' && !REGION.test(item.region) && !['unknown', 'global'].includes(item.region))) return badWorker(job);
      rows.push({ profile: target.profile, accountId: target.accountId, region: item.region, resourceType: job.data.resourceType,
        resourceId: item.resourceId, name: item.name, arn: item.arn });
    }
    if ((check.status === 'not_found' && rows.length) || (check.status === 'found' && !rows.length)) return badWorker(job);
    job.data.checks.push({ ...target, status: check.status, message: check.message });
    job.data.results.push(...rows);
    job.data.completed = job.data.checks.length;
    job.data.message = `Checked ${job.data.completed} of ${job.data.total} profiles.`;
  }
  function start(body, profiles) {
    if (closed) throw new LookupError('The app is shutting down.', 503);
    if (running()) throw new LookupError('A resource lookup is already running. Finish or cancel it first.', 409);
    const scope = validateLookupRequest(body, profiles);
    if (current) clearTimeout(current.expiry);
    const job = { data: { id: randomBytes(16).toString('hex'), state: 'running', ...scope, results: [], checks: [],
      completed: 0, total: scope.profiles.length, message: 'Authenticating and searching the selected profiles.' },
      child: null, buffer: '', bytes: 0, completeReceived: false };
    current = job;
    job.deadline = setTimeout(() => finish(job, 'error', 'The resource lookup timed out. Results may be incomplete; check fewer profiles with a fresh MFA code.', true), timeoutMs);
    job.deadline.unref?.();
    try {
      job.child = spawnProcess(python, [fileURLToPath(new URL('./resource_lookup.py', import.meta.url)), '--file', configFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      job.child.stdout.setEncoding('utf8');
      job.child.stdout.on('data', (chunk) => {
        if (job.data.state !== 'running') return;
        job.bytes += Buffer.byteLength(chunk);
        job.buffer += chunk;
        if (job.bytes > MAX_OUTPUT || job.buffer.length > MAX_LINE) return badWorker(job);
        let newline;
        while ((newline = job.buffer.indexOf('\n')) !== -1) {
          const line = job.buffer.slice(0, newline); job.buffer = job.buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try { handleEvent(job, JSON.parse(line)); } catch { badWorker(job); }
        }
      });
      // Drain stderr without retaining or forwarding paths, tracebacks, keys,
      // queries, MFA codes, or SDK debug messages.
      job.child.stderr.on('data', (chunk) => { job.bytes += chunk.length; if (job.bytes > MAX_OUTPUT) badWorker(job); });
      job.child.stdin.on('error', () => finish(job, 'error', 'The lookup helper stopped before it could read the request. Check the Python environment.', true));
      job.child.on('error', () => finish(job, 'error', 'The lookup helper could not start. Check Python and install requirements.txt in the app environment.', true));
      job.child.on('close', (code) => {
        clearTimeout(job.killTimer);
        if (job.data.state !== 'running') return;
        if (code === 0 && job.completeReceived && !job.buffer.trim()) finish(job, 'complete', 'Lookup finished. Review each profile’s status; denied or skipped profiles may still contain the resource.');
        else finish(job, 'error', 'The lookup helper stopped early. Results may be incomplete; check the Python environment and try again.');
      });
      job.child.stdin.end(JSON.stringify({ profiles: body.profiles, resourceType: scope.resourceType, query: scope.query, mfaCode: body.mfaCode }));
    } catch {
      finish(job, 'error', 'The lookup helper could not start. Check Python and install requirements.txt in the app environment.', true);
    }
    return snapshot(job);
  }
  function get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || !current || current.data.id !== id) throw new LookupError('This lookup is unavailable or expired. Run a new search.', 404);
    return snapshot(current);
  }
  function cancel(id) {
    get(id);
    finish(current, 'cancelled', 'Lookup cancelled. Results show only the checks completed before cancellation.', true);
    return snapshot(current);
  }
  function close() {
    closed = true;
    if (current) {
      finish(current, 'cancelled', 'The app stopped before the lookup finished.', true);
      clearTimeout(current.expiry);
      current = null;
    }
  }
  return { start, get, cancel, close, running };
}
