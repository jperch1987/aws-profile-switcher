// Author: jperch1987
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { pythonExecutable } from '../server.mjs';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const python = pythonExecutable();
const nodeTests = readdirSync(new URL('../tests/', import.meta.url)).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `tests/${name}`);
const suites = [
  [process.execPath, ['--test', ...nodeTests]],
  [python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']],
];

for (const [executable, args] of suites) {
  const result = spawnSync(executable, args, { cwd: rootDirectory, stdio: 'inherit', windowsHide: true });
  if (result.error) {
    console.error(`Could not run ${executable}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (result.signal) console.error(`Test process stopped with ${result.signal}.`);
    process.exit(result.status || 1);
  }
}
