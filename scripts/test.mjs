// Author: jperch1987
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const suites = [
  [process.execPath, ['--test', 'tests/server.test.mjs']],
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
