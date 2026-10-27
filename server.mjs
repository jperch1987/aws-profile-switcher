// Author: jperch1987
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildConsoleTarget } from './console-target.mjs';

const execFileAsync = promisify(execFile);
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const MAX_BODY_BYTES = 4096;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function resolveLocalPath(value) {
  return path.resolve(value === '~' ? os.homedir() : value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2)) : value);
}

const quotePosix = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const quotePowerShell = (value) => "'" + value.replaceAll("'", "''") + "'";

export function pythonExecutable() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const local = path.join(APP_DIR, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  return existsSync(local) ? local : (process.platform === 'win32' ? 'python' : 'python3');
}

export function workerFailureMessage(error, stderr, kind) {
  let stage = null;
  let message = 'Could not create the AWS session. Check your Python dependencies and AWS configuration.';
  for (const line of stderr.split('\n')) {
    try {
      const diagnostic = JSON.parse(line);
      if (!diagnostic || typeof diagnostic !== 'object' || Object.keys(diagnostic).length !== 1) continue;
      if (['assume-role', 'federation'].includes(diagnostic.stage)) stage = diagnostic.stage;
      else if (typeof diagnostic.error === 'string' && diagnostic.error.length < 500 && !/[\r\n]/.test(diagnostic.error)) message = diagnostic.error;
    } catch { /* Never expose raw worker output, traces, or request details. */ }
  }
  if (error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    if (kind === 'console' && stage === 'federation') return 'The role was authenticated, but AWS Console sign-in timed out while contacting signin.aws.amazon.com. Check network and DNS access to that host from the computer running the app, then retry with a fresh MFA code.';
    if (kind === 'console' && stage === 'assume-role') return 'Creating the AWS role session timed out. Check network access to AWS STS, then retry with a fresh MFA code.';
    if (kind === 'console') return 'AWS Console sign-in timed out before the helper reported progress. Check the app\'s Python environment, then retry with a fresh MFA code.';
    return 'The AWS request timed out. Enter a fresh MFA code and try again.';
  }
  return message;
}

export function buildCredentialCommands(result) {
  const values = {
    AWS_ACCESS_KEY_ID: result.credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: result.credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: result.credentials.SessionToken,
    AWS_REGION: result.region,
    AWS_DEFAULT_REGION: result.region,
  };
  return {
    posix: Object.entries(values).map(([key, value]) => `export ${key}=${quotePosix(value)}`).join('\n'),
    powershell: Object.entries(values).map(([key, value]) => `$Env:${key} = ${quotePowerShell(value)}`).join('\n'),
  };
}

export function validateCliResult(result) {
  const expiry = Date.parse(result?.expiration);
  const credentials = result?.credentials;
  const valid = credentials && ['AccessKeyId', 'SecretAccessKey', 'SessionToken'].every((key) =>
    typeof credentials[key] === 'string' && /^[\x21-\x7e]{1,16384}$/.test(credentials[key]));
  if (!valid || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 3900000
    || typeof result.expiration !== 'string' || typeof result.roleArn !== 'string'
    || typeof result.region !== 'string' || !/^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*$/.test(result.region)) {
    throw new AppError('AWS returned an invalid CLI session. Enter a fresh MFA code and try again.', 502);
  }
  return { commands: buildCredentialCommands(result), expiration: result.expiration, roleArn: result.roleArn };
}

export function authenticationTarget(profile, profiles) {
  const source = profiles.find((item) => item.profile === profile.source_profile);
  const mfaSerial = profile.mfa_serial || source?.mfa_serial || '';
  const region = profile.region || source?.region || 'us-east-1';
  let reason = null;
  if (!/^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/.test(profile.role_arn || '')) reason = 'Choose a role profile with a commercial AWS role ARN.';
  else if (!profile.source_profile) reason = 'Add source_profile for the IAM user that assumes this role.';
  else if (source?.role_arn || profile.source_profile === profile.profile) reason = 'Use a direct IAM user source profile; chained roles are not supported by this MFA flow.';
  else if (!/^[\w+=/:,.@-]{9,256}$/.test(mfaSerial)) reason = 'Add mfa_serial with your MFA device ARN or hardware serial to this role or its source profile.';
  else if (mfaSerial.startsWith('arn:') && !/^arn:aws:iam::[0-9]{12}:mfa\/[A-Za-z0-9_+=/:,.@-]+$/.test(mfaSerial)) reason = 'The MFA device ARN must be a commercial AWS IAM MFA ARN.';
  else if (!/^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*$/.test(region)) reason = 'Set a supported commercial AWS region, such as us-east-1, on the profile.';
  else if (profile.external_id && !/^[A-Za-z0-9_+=,.@:/-]{2,1224}$/.test(profile.external_id)) reason = 'The profile external_id has an invalid length or format.';
  return { enabled: !reason, reason, mfaSerial };
}

export function validateFederationResult(result) {
  try {
    const url = new URL(result.url);
    const destination = new URL(url.searchParams.get('Destination'));
    const params = [...url.searchParams.keys()].sort();
    if (url.protocol !== 'https:' || url.host !== 'signin.aws.amazon.com' || url.username || url.password || url.hash || url.pathname !== '/federation'
      || JSON.stringify(params) !== JSON.stringify(['Action', 'Destination', 'SigninToken']) || url.searchParams.get('Action') !== 'login'
      || !url.searchParams.get('SigninToken') || destination.protocol !== 'https:' || destination.host !== 'console.aws.amazon.com'
      || destination.username || destination.password || destination.hash || destination.pathname !== '/console/home'
      || JSON.stringify([...destination.searchParams.keys()]) !== JSON.stringify(['region'])
      || !/^[a-z]{2}-[a-z]+-[1-9][0-9]*$/.test(destination.searchParams.get('region') || '')
      || typeof result.expiration !== 'string' || !Number.isFinite(Date.parse(result.expiration)) || Date.parse(result.expiration) <= Date.now()
      || typeof result.roleArn !== 'string') throw new Error();
    return { url: url.href, expiration: result.expiration, roleArn: result.roleArn };
  } catch { throw new AppError('AWS returned an invalid console session. Please try again.', 502); }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new AppError('Use application/json for this request.', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AppError('Request is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('Request must contain valid JSON.'); }
}

export function createProfileServer(options = {}) {
  const configFile = resolveLocalPath(options.configFile || process.env.PROFILES_FILE || path.join(APP_DIR, 'profiles.txt'));
  const stateDirectory = resolveLocalPath(options.stateDirectory || process.env.PROFILE_SWITCHER_STATE_DIR || path.join(APP_DIR, '.state'));
  const python = options.python || pythonExecutable();
  const token = randomBytes(32).toString('hex');
  const stateFile = path.join(stateDirectory, 'active-profile.json');
  let authenticationPending = false;

  async function createSession(kind, profile, mfaCode) {
    const handler = kind === 'cli' ? options.cliSession : options.consoleSession;
    if (handler) return handler(profile, mfaCode);
    return new Promise((resolve, reject) => {
      const child = execFile(python, [path.join(APP_DIR, 'aws_session.py'), `--${kind}-worker`, '--file', configFile], {
        // Console sign-in performs STS and federation requests sequentially.
        timeout: kind === 'console' ? 75_000 : 45_000, maxBuffer: 64 * 1024, windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new AppError(workerFailureMessage(error, stderr, kind), 502));
        } else {
          try { resolve(JSON.parse(stdout)); }
          catch { reject(new AppError('The AWS session helper returned an invalid response.', 502)); }
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ profile: profile.profile, mfaCode }));
    });
  }

  async function readProfiles() {
    try {
      const { stdout } = await execFileAsync(python, [path.join(APP_DIR, 'profiles.py'), '--file', configFile], {
        timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      });
      const data = JSON.parse(stdout);
      return { ...data, profiles: data.profiles.map((profile) => ({ ...profile, console: buildConsoleTarget(profile), auth: authenticationTarget(profile, data.profiles) })) };
    } catch (error) {
      if (error.code === 'ENOENT') throw new AppError('Python was not found. Install Python 3 or set PYTHON to its executable path.', 500);
      if (error.killed) throw new AppError('Reading the profile file timed out.', 500);
      let message = 'Could not read the profile file. Check its format and permissions.';
      try { message = JSON.parse(error.stderr).error || message; } catch { /* Never expose raw config contents. */ }
      throw new AppError(message, 422);
    }
  }

  async function readActive(profiles) {
    try {
      const saved = JSON.parse(await readFile(stateFile, 'utf8'));
      return saved.configFile === configFile ? profiles.find((entry) => entry.profile === saved.profile) || null : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw new AppError('Could not read the saved selection. Check the state directory permissions.', 500);
    }
  }

  async function saveActive(profile) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${stateFile}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ profile: profile.profile, configFile }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, stateFile);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  // Saved selection metadata never restores authenticated credentials.
  const activePayload = (profile) => ({ profile, commands: null });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
        throw new AppError('Only localhost requests are accepted.', 403);
      }
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new AppError('Cross-origin requests are not allowed.', 403);
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        const [file, contentType] = STATIC_FILES.get(url.pathname);
        const content = await readFile(path.join(PUBLIC_DIR, file));
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      } else if (req.method === 'GET' && url.pathname === '/api/profiles') {
        const data = await readProfiles();
        const active = await readActive(data.profiles);
        sendJson(res, 200, { ...data, activeProfile: active?.profile || null, token });
      } else if (req.method === 'GET' && url.pathname === '/api/active') {
        const { profiles } = await readProfiles();
        sendJson(res, 200, activePayload(await readActive(profiles)));
      } else if (req.method === 'POST' && url.pathname === '/api/active') {
        if (req.headers['x-csrf-token'] !== token) throw new AppError('Refresh the page before switching profiles.', 403);
        const body = await readJson(req);
        if (!body || typeof body.profile !== 'string') throw new AppError('Choose a profile name.');
        const { profiles } = await readProfiles();
        const profile = profiles.find((entry) => entry.profile === body.profile);
        if (!profile) throw new AppError('This profile no longer exists. Refresh the profile list.', 404);
        if (!profile.auth.enabled) throw new AppError(profile.auth.reason, 422);
        try { await saveActive(profile); }
        catch { throw new AppError('Could not save the selection. Check the state directory permissions.', 500); }
        sendJson(res, 200, activePayload(profile));
      } else if (req.method === 'POST' && ['/api/console', '/api/cli'].includes(url.pathname)) {
        if (req.headers['x-csrf-token'] !== token) throw new AppError('Refresh the page before authenticating to AWS.', 403);
        const body = await readJson(req);
        if (!body || typeof body.profile !== 'string' || typeof body.mfaCode !== 'string' || !/^[0-9]{6}$/.test(body.mfaCode)) {
          throw new AppError('Choose a profile and enter the six-digit MFA code.');
        }
        if (authenticationPending) throw new AppError('An AWS sign-in is already in progress. Wait before trying again.', 409);
        authenticationPending = true;
        try {
          const { profiles } = await readProfiles();
          const profile = profiles.find((entry) => entry.profile === body.profile);
          if (!profile) throw new AppError('This profile no longer exists. Refresh the profile list.', 404);
          if (!profile.auth.enabled) throw new AppError(profile.auth.reason, 422);
          const kind = url.pathname === '/api/cli' ? 'cli' : 'console';
          const raw = await createSession(kind, profile, body.mfaCode);
          const result = kind === 'cli' ? validateCliResult(raw) : validateFederationResult(raw);
          if (result.roleArn !== profile.role_arn) throw new AppError('The AWS session did not match the selected role.', 502);
          sendJson(res, 200, kind === 'cli' ? { profile, ...result } : result);
        } finally {
          body.mfaCode = '';
          authenticationPending = false;
        }
      } else {
        throw new AppError('Not found.', 404);
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) sendJson(res, error.status || 500, { error: error instanceof AppError ? error.message : 'An unexpected local server error occurred.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exit(1);
  }
  const server = createProfileServer();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Choose another PORT.` : `Could not start the local server (${error.code || 'unknown error'}).`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Profile Switcher: http://127.0.0.1:${port}`));
}
