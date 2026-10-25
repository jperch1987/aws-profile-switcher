// Author: jperch1987
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
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

export function buildCommands(profile, configFile) {
  const values = {
    AWS_CONFIG_FILE: configFile,
    AWS_PROFILE: profile.profile,
    AWS_DEFAULT_PROFILE: profile.profile,
  };
  if (profile.region) {
    values.AWS_REGION = profile.region;
    values.AWS_DEFAULT_REGION = profile.region;
  }
  const credentials = [
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
    'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_SESSION_NAME',
  ];
  const posix = [`unset ${credentials.join(' ')}`];
  const powershell = [`Remove-Item ${credentials.map((key) => `Env:${key}`).join(', ')} -ErrorAction SilentlyContinue`];
  if (!profile.region) {
    posix.push('unset AWS_REGION AWS_DEFAULT_REGION');
    powershell.push('Remove-Item Env:AWS_REGION, Env:AWS_DEFAULT_REGION -ErrorAction SilentlyContinue');
  }
  for (const [key, value] of Object.entries(values)) {
    posix.push(`export ${key}=${quotePosix(value)}`);
    powershell.push(`$Env:${key} = ${quotePowerShell(value)}`);
  }
  return { posix: posix.join('\n'), powershell: powershell.join('\n') };
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
  const python = options.python || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const token = randomBytes(32).toString('hex');
  const stateFile = path.join(stateDirectory, 'active-profile.json');

  async function readProfiles() {
    try {
      const { stdout } = await execFileAsync(python, [path.join(APP_DIR, 'profiles.py'), '--file', configFile], {
        timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      });
      const data = JSON.parse(stdout);
      return { ...data, profiles: data.profiles.map((profile) => ({ ...profile, console: buildConsoleTarget(profile) })) };
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

  const activePayload = (profile) => ({ profile, commands: profile ? buildCommands(profile, configFile) : null });
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
        try { await saveActive(profile); }
        catch { throw new AppError('Could not save the selection. Check the state directory permissions.', 500); }
        sendJson(res, 200, activePayload(profile));
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
