# Author: jperch1987
"""Exercise installer/launcher behavior with fake runtimes; no packages or AWS calls."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAKE_RUNTIME = r'''import json, os, pathlib, shutil, sys
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['INSTALL_TEST_LOG'], 'a') as log:
    log.write(json.dumps({'name':name,'args':args,'python':os.environ.get('PYTHON'),'path':str(pathlib.Path(sys.argv[0]).absolute())})+'\n')
if name == 'uname':
    print('x86_64' if args==['-m'] else os.environ.get('INSTALL_TEST_OS','Linux'))
elif name == 'node':
    if args and args[0]=='-p': print(pathlib.Path(sys.argv[0]).absolute())
    if os.environ.get('INSTALL_TEST_BAD_NODE') and 'node-v24' not in str(pathlib.Path(sys.argv[0])): sys.exit(1)
elif name in ('python3','python'):
    if args[:2]==['-m','venv']:
        target=pathlib.Path(args[2]); (target/'bin').mkdir(parents=True)
        shutil.copy2(sys.argv[0],target/'bin'/'python')
        (target/'pyvenv.cfg').write_text('test venv')
    elif args[:2]==['-m','pip']:
        sys.exit(int(os.environ.get('INSTALL_TEST_PIP_EXIT','0')))
    elif args and args[0]=='-c' and ('pathlib.Path(sys.argv' in args[1] or 'import re,sys' in args[1]):
        sys.argv=['-c']+args[2:]
        exec(args[1], {'__name__':'__main__'})
elif name == 'npm':
    sys.exit(int(os.environ.get('INSTALL_TEST_NPM_EXIT','0')))
elif name == 'curl':
    shutil.copyfile(os.environ['INSTALL_TEST_DOWNLOADS']+'/'+args[-3].rsplit('/',1)[-1], args[-1])
'''


@unittest.skipIf(os.name == 'nt', 'POSIX shell tests; native Windows needs PowerShell validation')
class InstallScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='switchboard install ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / 'app folder'
        self.app.mkdir()
        self.bin = self.root / 'fake bin'
        self.bin.mkdir()
        self.home_dir = self.root / 'linux home'
        self.home_dir.mkdir()
        for name in ['install.sh', 'start.sh']:
            shutil.copy2(ROOT / name, self.app / name)
        (self.app / 'requirements.txt').write_text('# test requirements')
        (self.app / 'profiles.example.txt').write_text('[profile example]\n')
        self.log = self.root / 'calls.jsonl'
        for name in ['node', 'python3', 'npm', 'uname', 'xz']:
            self.fake(name)
        self.env = dict(os.environ)
        for key in ['PYTHON','WSL_DISTRO_NAME','WSL_INTEROP']:
            self.env.pop(key, None)
        self.env.update(PATH=str(self.bin)+os.pathsep+os.environ['PATH'], HOME=str(self.home_dir), INSTALL_TEST_LOG=str(self.log), INSTALL_TEST_OS='Linux')

    def fake(self, name, directory=None):
        path = (directory or self.bin) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!'+sys.executable+'\n'+FAKE_RUNTIME)
        path.chmod(0o755)
        return path

    def run_script(self, script='install.sh', *args):
        return subprocess.run(['/bin/bash', str(self.app / script), *args], env=self.env, cwd=self.root, capture_output=True, text=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_install_and_launch_with_spaces_preserve_profiles_on_repeat(self):
        (self.app / 'profiles.txt').write_text('client configuration\n')
        for _ in range(2):
            result = self.run_script()
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.app / 'profiles.txt').read_text(), 'client configuration\n')
        self.assertEqual(sum(c['args'][:2] == ['-m','venv'] for c in self.calls()), 1)
        self.assertEqual((self.app / '.state/python-unix').read_text().strip(), str(self.app / '.venv/bin/python'))
        self.assertEqual(self.run_script('start.sh').returncode, 0)
        server_call = next(c for c in reversed(self.calls()) if c['args']==['server.mjs'])
        self.assertEqual(server_call['python'], str(self.app / '.venv/bin/python'))
        self.assertTrue(any(c['name']=='npm' and '--ignore-scripts' in c['args'] for c in self.calls()))

    def test_wsl_uses_linux_home_and_leaves_windows_venv_untouched(self):
        self.env['WSL_DISTRO_NAME']='Debian'
        windows_python=self.app / '.venv/Scripts/python.exe'
        windows_python.parent.mkdir(parents=True)
        windows_python.write_text('Windows runtime')
        result=self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        expected=self.home_dir / '.venvs/aws-profile-switcher-wsl/bin/python'
        self.assertTrue(expected.exists())
        self.assertEqual((self.app / '.state/python-wsl').read_text().strip(), str(expected))
        self.assertEqual(windows_python.read_text(), 'Windows runtime')
        self.assertEqual(self.run_script('start.sh').returncode,0)
        self.assertEqual(self.calls()[-1]['python'], str(expected))

    def test_failure_does_not_write_success_marker_or_example_profile(self):
        self.env['INSTALL_TEST_PIP_EXIT']='7'
        result=self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Setup complete', result.stdout)
        self.assertFalse((self.app / '.state/python-unix').exists())
        self.assertFalse((self.app / 'profiles.txt').exists())
        self.env.pop('INSTALL_TEST_PIP_EXIT')
        self.assertEqual(self.run_script().returncode,0)
        self.assertEqual(sum(c['args'][:2] == ['-m','venv'] for c in self.calls()), 1)

    def test_incompatible_venv_is_not_overwritten(self):
        (self.app / '.venv').mkdir()
        (self.app / '.venv/client-file').write_text('preserve')
        result=self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not been overwritten', result.stderr)
        self.assertEqual((self.app / '.venv/client-file').read_text(), 'preserve')
        self.assertFalse(any(c['args'][:2] == ['-m','venv'] for c in self.calls()))

    def test_explicit_python_override_wins_at_launch(self):
        self.assertEqual(self.run_script().returncode,0)
        custom=self.fake('python', self.root / 'custom env/bin')
        self.env['PYTHON']=str(custom)
        self.assertEqual(self.run_script('start.sh').returncode,0)
        self.assertEqual(self.calls()[-1]['python'],str(custom))

    def test_old_node_does_not_install_dependencies_without_runtime_flag(self):
        self.env['INSTALL_TEST_BAD_NODE']='1'
        result=self.run_script()
        self.assertNotEqual(result.returncode,0)
        self.assertIn('--install-runtimes', result.stderr)
        self.assertFalse(any(c['args'][:2] in (['-m','venv'],['-m','pip']) for c in self.calls()))

    def test_git_bash_directs_to_native_windows_installer(self):
        self.env['INSTALL_TEST_OS']='MINGW64_NT'
        result=self.run_script()
        self.assertNotEqual(result.returncode,0)
        self.assertIn('PowerShell',result.stderr)
        self.assertFalse((self.app / '.venv').exists())

    def test_node_archive_checksum_failure_never_extracts(self):
        self.env['INSTALL_TEST_BAD_NODE']='1'
        self.fake('curl')
        downloads=self.root / 'downloads'
        downloads.mkdir()
        archive='node-v24.1.0-linux-x64.tar.xz'
        (downloads / archive).write_bytes(b'corrupt archive')
        (downloads / 'SHASUMS256.txt').write_text('0'*64+'  '+archive+'\n')
        self.env['INSTALL_TEST_DOWNLOADS']=str(downloads)
        result=self.run_script('install.sh','--install-runtimes')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('checksum mismatch',result.stderr)
        self.assertFalse((self.home_dir / '.local/share/aws-profile-switcher').exists())

    def test_verified_existing_node_runtime_is_reused_after_dependency_failure(self):
        self.env['INSTALL_TEST_BAD_NODE']='1'
        self.fake('curl')
        downloads=self.root / 'downloads'
        downloads.mkdir()
        archive='node-v24.1.0-linux-x64.tar.xz'
        data=b'archive need not be extracted when the valid runtime already exists'
        (downloads / archive).write_bytes(data)
        (downloads / 'SHASUMS256.txt').write_text(hashlib.sha256(data).hexdigest()+'  '+archive+'\n')
        self.env['INSTALL_TEST_DOWNLOADS']=str(downloads)
        runtime_bin=self.home_dir / '.local/share/aws-profile-switcher/node-v24.1.0-linux-x64/bin'
        runtime_node=self.fake('node',runtime_bin)
        self.fake('npm',runtime_bin)
        self.env['INSTALL_TEST_PIP_EXIT']='7'
        self.assertNotEqual(self.run_script('install.sh','--install-runtimes').returncode,0)
        self.assertFalse((self.app / '.state/node-unix').exists())
        self.env.pop('INSTALL_TEST_PIP_EXIT')
        result=self.run_script('install.sh','--install-runtimes')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((self.app / '.state/node-unix').read_text().strip(),str(runtime_node))

    def test_mac_brew_node_is_saved_for_launch_without_shell_profile_changes(self):
        self.env['INSTALL_TEST_OS']='Darwin'
        self.env['INSTALL_TEST_BAD_NODE']='1'
        keg=self.root / 'node-v24-brew'
        runtime_node=self.fake('node',keg / 'bin')
        self.fake('npm',keg / 'bin')
        brew=self.bin / 'brew'
        brew.write_text('#!'+sys.executable+'\nimport sys\nif sys.argv[1]=="--prefix": print('+repr(str(keg))+')\n')
        brew.chmod(0o755)
        result=self.run_script('install.sh','--install-runtimes')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((self.app / '.state/node-unix').read_text().strip(),str(runtime_node))
        self.assertEqual(self.run_script('start.sh').returncode,0)
        self.assertFalse((self.home_dir / '.zshrc').exists())


if __name__ == '__main__':
    unittest.main()
