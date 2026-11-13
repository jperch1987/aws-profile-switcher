// Author: jperch1987
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';

export const RESOURCE_TYPES = Object.freeze(['ec2', 'ebs', 'security-group', 'vpc', 's3', 'rds', 'lambda', 'eks', 'elasticache', 'route53', 'load-balancer', 'private-ip', 'acm']);
const CHECK_STATES = new Set(['found', 'not_found', 'access_denied', 'auth_failed', 'error', 'skipped']);
const REGION = /^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*$/;
const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
const ACM_MAX_LINE = 16 * 1024 * 1024;
const ACM_MAX_PROFILE_RESULTS = 5000;
const ACM_MAX_RESULTS = 10000;
const CERTIFICATE_TYPES = new Set(['', 'IMPORTED', 'AMAZON_ISSUED', 'PRIVATE']);
const CERTIFICATE_STATES = new Set(['', 'PENDING_VALIDATION', 'ISSUED', 'INACTIVE', 'EXPIRED', 'VALIDATION_TIMED_OUT', 'REVOKED', 'FAILED']);
const CERTIFICATE_KEYS = new Set(['', 'RSA_1024', 'RSA_2048', 'RSA_3072', 'RSA_4096', 'EC_prime256v1', 'EC_secp384r1', 'EC_secp521r1']);
const cleanString = (value, maximum = 1024) => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const cleanMetadata = (value, maximum) => cleanString(value, maximum) && !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value);
const ec2Id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}-(?:[0-9a-f]{8}|[0-9a-f]{17})$`).test(value);
const LOAD_BALANCER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?$/;

function loadBalancerDns(value) {
  if (!cleanMetadata(value, 254) || !/^[A-Za-z0-9.-]+$/.test(value)) return null;
  const name = value.toLowerCase().replace(/\.$/, '');
  if (!name || name.length > 253) return null;
  const labels = name.split('.');
  if (labels.length === 6 && labels[0] === 'dualstack') labels.shift();
  if (labels.length !== 5 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || labels[3] !== 'amazonaws' || labels[4] !== 'com') return null;
  const region = labels[1] === 'elb' ? labels[2] : labels[2] === 'elb' ? labels[1] : '';
  return REGION.test(region) ? { name, region } : null;
}

function loadBalancerKind(item, target) {
  const prefix = `arn:aws:elasticloadbalancing:${target.region}:${target.accountId}:loadbalancer/`;
  if (!item.arn.startsWith(prefix) || !LOAD_BALANCER_NAME.test(item.name) || item.resourceId !== item.name) return null;
  const path = item.arn.slice(prefix.length).split('/');
  if (path.length === 1 && path[0] === item.name) return 'classic';
  return path.length === 3 && ['app', 'net', 'gwy'].includes(path[0]) && path[1] === item.name
    && /^[a-f0-9]{16}$/.test(path[2]) ? path[0] : null;
}

function loadBalancerDnsMatches(query, found, kind) {
  if (query === found) return true;
  return ['app', 'classic'].includes(kind) && query.replace(/^dualstack\./, '') === found.replace(/^dualstack\./, '');
}

function networkMetadata(item, target, query) {
  const info = item.network;
  if (!info || typeof info !== 'object' || Array.isArray(info)
    || !ec2Id(item.resourceId, 'eni')
    || item.arn !== `arn:aws:ec2:${target.region}:${target.accountId}:network-interface/${item.resourceId}`
    || info.privateIpAddress !== query || !isIPv4(info.privateIpAddress)
    || !ec2Id(info.vpcId, 'vpc') || !ec2Id(info.subnetId, 'subnet')
    || !cleanMetadata(info.interfaceType, 128) || !cleanMetadata(info.description, 1024)
    || !cleanMetadata(info.requesterId, 256)
    || !(info.instanceId === '' || ec2Id(info.instanceId, 'i'))
    || !cleanMetadata(info.instanceOwnerId, 256)
    || !(info.requesterManaged === null || typeof info.requesterManaged === 'boolean')) return null;
  // Never retain extra SDK fields or an unexpected nested payload from a worker.
  return { privateIpAddress: info.privateIpAddress, vpcId: info.vpcId, subnetId: info.subnetId,
    interfaceType: info.interfaceType, description: info.description, instanceId: info.instanceId,
    instanceOwnerId: info.instanceOwnerId, requesterId: info.requesterId, requesterManaged: info.requesterManaged };
}

function certificateTimestamp(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length !== 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function certificateMetadata(item, target) {
  const info = item.certificate;
  if (!info || typeof info !== 'object' || Array.isArray(info)
    || item.resourceId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.resourceId)
    || item.arn !== `arn:aws:acm:${target.region}:${target.accountId}:certificate/${item.resourceId}`
    || !cleanMetadata(item.name, 253)
    || !CERTIFICATE_TYPES.has(info.type) || !CERTIFICATE_STATES.has(info.status) || !CERTIFICATE_KEYS.has(info.keyAlgorithm)
    || !(info.inUse === null || typeof info.inUse === 'boolean')
    || !certificateTimestamp(info.notBefore) || !certificateTimestamp(info.notAfter)) return null;
  return { type: info.type, status: info.status, keyAlgorithm: info.keyAlgorithm,
    inUse: info.inUse, notBefore: info.notBefore, notAfter: info.notAfter };
}

export class LookupError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'LookupError'; this.status = status; }
}

export function validateLookupRequest(body, profiles) {
  const inventory = body?.resourceType === 'acm';
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== (inventory ? 'mfaCode,profiles,query,region,resourceType' : 'mfaCode,profiles,query,resourceType')
    || !Array.isArray(body.profiles) || body.profiles.length < 1 || body.profiles.length > 250
    || body.profiles.some((name) => !cleanString(name, 2048) || !name)
    || new Set(body.profiles).size !== body.profiles.length) {
    throw new LookupError('Choose between 1 and 250 distinct role profiles for the lookup.');
  }
  if (!RESOURCE_TYPES.includes(body.resourceType)) throw new LookupError('Choose a supported resource type.');
  if (inventory) {
    if (body.query !== '') throw new LookupError('ACM inventory lists certificates without a resource query.');
    if (typeof body.region !== 'string' || body.region.length > 64 || /[^a-z0-9-]/.test(body.region) || !REGION.test(body.region)) {
      throw new LookupError('Choose a supported commercial AWS region for the ACM inventory.');
    }
  } else if (!cleanString(body.query, 256) || !body.query.trim()) throw new LookupError('Enter a resource ID, exact name, or ARN using at most 256 characters on one line.');
  if (body.resourceType === 'private-ip' && !isIPv4(body.query.trim())) throw new LookupError('Enter one exact private IPv4 address, such as 10.0.1.25. CIDR ranges, hostnames, and IPv6 are not supported.');
  if (body.resourceType === 'load-balancer' && !body.query.trim().startsWith('arn:')
    && !LOAD_BALANCER_NAME.test(body.query.trim()) && !loadBalancerDns(body.query.trim())) {
    throw new LookupError('Enter an exact load balancer name, ARN, or AWS-generated DNS hostname. Custom domains, URLs, ports, and zonal hostnames are not supported.');
  }
  if (typeof body.mfaCode !== 'string' || !/^[0-9]{6}$/.test(body.mfaCode)) throw new LookupError('Enter a fresh six-digit MFA code for this lookup.');
  const targets = body.profiles.map((name) => {
    const profile = profiles.find((item) => item.profile === name);
    if (!profile) throw new LookupError('A selected profile no longer exists. Refresh the profile list.', 404);
    if (profile.auth?.enabled !== true) throw new LookupError('Every selected profile must support IAM-user MFA authentication.', 422);
    const accountId = /^arn:aws:iam::([0-9]{12}):role\//.exec(profile.role_arn || '')?.[1];
    const source = profiles.find((item) => item.profile === profile.source_profile);
    const region = inventory ? body.region : profile.region || source?.region || 'us-east-1';
    if (!accountId || !REGION.test(region)) throw new LookupError('A selected profile has an unsupported account or region.', 422);
    return { profile: profile.profile, accountId, region, source: profile.source_profile, mfa: profile.auth.mfaSerial };
  });
  if (targets.some((target) => target.source !== targets[0].source || target.mfa !== targets[0].mfa)) {
    throw new LookupError('Search profiles with the same source identity and MFA device together. Use a fresh code for each identity.', 422);
  }
  return { profiles: targets.map(({ profile, accountId, region }) => ({ profile, accountId, region })), query: body.query.trim(), resourceType: body.resourceType,
    ...(inventory ? { region: body.region } : {}) };
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
    const inventory = job.data.resourceType === 'acm';
    if (event.event !== 'profile' || !target || job.data.checks.some((item) => item.profile === target.profile)
      || check.accountId !== target.accountId || check.region !== target.region || !CHECK_STATES.has(check.status)
      || !cleanString(check.message, 500) || !Array.isArray(event.results)
      || event.results.length > (inventory ? ACM_MAX_PROFILE_RESULTS : 100)
      || (inventory && job.data.results.length + event.results.length > ACM_MAX_RESULTS)) return badWorker(job);
    const rows = [];
    const certificateArns = new Set();
    for (const item of event.results) {
      if (!item || item.profile !== target.profile || item.accountId !== target.accountId || item.resourceType !== job.data.resourceType
        || !['region', 'resourceId', 'name', 'arn'].every((key) => cleanString(item[key])) || !item.resourceId
        || (!['s3', 'route53'].includes(job.data.resourceType) && item.region !== target.region)
        || (job.data.resourceType === 'route53' && item.region !== 'global')
        || (job.data.resourceType === 's3' && !REGION.test(item.region) && !['unknown', 'global'].includes(item.region))) return badWorker(job);
      const network = job.data.resourceType === 'private-ip' ? networkMetadata(item, target, job.data.query) : null;
      if (job.data.resourceType === 'private-ip' && !network) return badWorker(job);
      const certificate = inventory ? certificateMetadata(item, target) : null;
      if (inventory) {
        if (!certificate || certificateArns.has(item.arn)) return badWorker(job);
        certificateArns.add(item.arn);
      }
      let dnsName;
      if (job.data.resourceType === 'load-balancer') {
        const queryDns = loadBalancerDns(job.data.query);
        if (Object.hasOwn(item, 'dnsName')) {
          const foundDns = loadBalancerDns(item.dnsName);
          const kind = loadBalancerKind(item, target);
          if (!foundDns || foundDns.name !== item.dnsName || foundDns.region !== target.region || !kind
            || (queryDns && !loadBalancerDnsMatches(queryDns.name, foundDns.name, kind))) return badWorker(job);
          dnsName = foundDns.name;
        } else if (queryDns) return badWorker(job);
      }
      rows.push({ profile: target.profile, accountId: target.accountId, region: item.region, resourceType: job.data.resourceType,
        resourceId: item.resourceId, name: item.name, arn: item.arn, ...(network ? { network } : {}), ...(dnsName ? { dnsName } : {}),
        ...(certificate ? { certificate } : {}) });
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
        if (job.bytes > MAX_OUTPUT || Buffer.byteLength(job.buffer) > (job.data.resourceType === 'acm' ? ACM_MAX_LINE : MAX_LINE)) return badWorker(job);
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
      job.child.stdin.end(JSON.stringify({ profiles: body.profiles, resourceType: scope.resourceType, query: scope.query, mfaCode: body.mfaCode,
        ...(scope.resourceType === 'acm' ? { region: scope.region } : {}) }));
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
