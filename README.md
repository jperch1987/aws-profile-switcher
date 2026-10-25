# AWS Profile Switcher

Author: jperch1987

A local web app built with **Node.js and Python**. Read `profile`, `role_arn`, `source_profile`, and `region` from a local AWS config-format text file, then either copy commands for a terminal or open AWS's Switch Role page in your browser.

Clients need a browser, Node.js, and Python. **Codex and browser extensions are not required.** The app uses standard libraries, so there are no application packages to install. AWS CLI is optional for using the app; install it separately if you want to run AWS CLI commands.

## Install Python and Node.js

Use a patched **Node.js 24 LTS** (recommended; the repository's `.nvmrc` selects 24) or **22 LTS**, and a supported **Python 3.11+** release. Node.js installers include npm. If these are already installed, check their versions below and skip reinstalling. See the [Node.js release list](https://nodejs.org/en/about/previous-releases) for supported releases.

### Windows

1. Open the [official Node.js downloads page](https://nodejs.org/en/download), select **24 LTS**, **Windows**, and your computer's architecture, then download and run the **Windows Installer (.msi)**. Keep the npm and PATH options enabled.
2. Install the **Python install manager** from the [official Python Windows downloads page](https://www.python.org/downloads/windows/). Open a new PowerShell window and install its default Python runtime:

   ```powershell
   pymanager install default
   ```

   The manager and the Python runtime are separate installs. See the [official Python Windows installation guide](https://docs.python.org/3/using/windows.html) for details. If using a traditional Python installer instead, enable **Add python.exe to PATH**.
3. Close and reopen PowerShell, then check:

   ```powershell
   node --version
   npm.cmd --version
   python --version
   ```

Expect Node.js `v24.x` (or a supported `v22.x`), an npm version, and Python `3.11` or newer.

### macOS

1. From the [official Node.js downloads page](https://nodejs.org/en/download), select **24 LTS** and **macOS**, then download and run the **macOS Installer (.pkg)** for your Mac.
2. Download a supported Python 3 release from the [official Python macOS downloads page](https://www.python.org/downloads/macos/) and run its `.pkg` installer with the default options. Complete the installer's **Install Certificates.command** step as described in the [Python macOS guide](https://docs.python.org/3/using/mac.html).
3. Close and reopen Terminal, then check:

   ```sh
   node --version
   npm --version
   python3 --version
   ```

Expect Node.js `v24.x` (or a supported `v22.x`), an npm version, and Python `3.11` or newer. Use the installed Python rather than replacing the Apple-managed Python in `/usr/bin`.

### Linux

Install Python from your distribution's package manager. For example, on Ubuntu/Debian:

```sh
sudo apt update
sudo apt install python3 git curl
```

On Fedora:

```sh
sudo dnf install python3 git curl
```

Run `python3 --version` and confirm it is **3.11 or newer**. Older distributions may supply an older version; use a supported distribution release or a separately installed supported Python, selected with `PYTHON` below. See [Python's Linux installation guidance](https://docs.python.org/3/using/unix.html).

For Node.js, install **nvm** using its [official installation instructions](https://github.com/nvm-sh/nvm#installing-and-updating), then reopen a Bash or Zsh terminal and run:

```sh
nvm install 24
nvm use 24
node --version
npm --version
python3 --version
```

This installs Node.js 24 and npm for your user. Run `nvm use 24` in a new terminal before starting the app if another Node version is selected. If your organization provides Node.js directly, verify its version instead; a distribution's default `nodejs` package may be too old. The [npm installation guide](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/) describes the supported installation options.

### Installation troubleshooting

- **Command not found:** reopen your terminal after installation and check that Node.js and Python are on PATH. The app expects `python3` on macOS/Linux and `python` on Windows.
- **Windows has `py`, but `python` does not work:** if `py -3 --version` reports Python 3.11+, select its executable in the same PowerShell session before starting the app:

  ```powershell
  $Env:PYTHON = (py -3 -c "import sys; print(sys.executable)")
  ```

- **Multiple Python versions:** set `PYTHON` to the full path of the desired interpreter. It must be one executable path, without arguments; `py -3` is not a valid value. See the configuration examples below.
- **PowerShell blocks `npm.ps1`:** use `npm.cmd start` to run the app and `npm.cmd test` for tests. You can also start with `node server.mjs`.

No `npm install`, `pip install`, or virtual environment is required for this app: it uses only the Node.js and Python standard libraries.

## Install and run the app

Install Git if you want to use the clone commands below. Alternatively, select **Code → Download ZIP** on the [GitHub repository](https://github.com/jperch1987/aws-profile-switcher), extract it, and open a terminal in the extracted folder; skip the `git clone` and `cd` lines. Create your local configuration from the example, edit it, and start the app.

macOS/Linux:

```sh
git clone https://github.com/jperch1987/aws-profile-switcher.git profile-switcher
cd profile-switcher
cp profiles.example.txt profiles.txt
# Edit profiles.txt with your own profile metadata.
npm start
```

Windows PowerShell:

```powershell
git clone https://github.com/jperch1987/aws-profile-switcher.git profile-switcher
cd profile-switcher
Copy-Item profiles.example.txt profiles.txt
# Edit profiles.txt with your own profile metadata.
npm.cmd start
```

You can also start with `node server.mjs`. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and stop the server with Ctrl+C. Example account IDs and roles are placeholders and will not grant AWS access.

To keep your metadata file outside the checkout:

```sh
PROFILES_FILE="$HOME/aws-profiles.txt" npm start
```

```powershell
$Env:PROFILES_FILE = "$HOME/aws-profiles.txt"
npm.cmd start
```

| Setting | Default | Purpose |
| --- | --- | --- |
| `PROFILES_FILE` | `profiles.txt` beside the server | Local config file; relative paths resolve from the working directory |
| `PORT` | `3000` | Loopback web server port |
| `PYTHON` | `python3`; `python` on Windows | Python executable name or full path |
| `PROFILE_SWITCHER_STATE_DIR` | `.state` beside the server | Directory for the app's saved CLI profile selection |

For example, `PORT=8080 npm start` changes the port on macOS/Linux. To choose a specific Python installation, replace the example path below with the full path to your installed Python 3.11+ executable:

```sh
PYTHON="/absolute/path/to/python3" npm start
```

```powershell
$Env:PYTHON = "C:\Path\To\Python\python.exe"
npm.cmd start
```

Restart the server to change these settings.

## Profile file

```ini
[default]
region = ap-southeast-1

[profile development]
role_arn = arn:aws:iam::111122223333:role/Developer
source_profile = default
region = ap-southeast-1

[profile production]
role_arn = arn:aws:iam::444455556666:role/team/ReadOnly
source_profile = default
region = us-east-1
```

Use `[default]` or `[profile name]` sections. Quote names containing spaces, such as `[profile "team dev"]`. Fields can be absent, but opening the AWS switch page requires a supported `role_arn`. Comments and UTF-8 are accepted. The reader tolerates a BOM; use UTF-8 without a BOM if AWS CLI will read the same file. Profiles do not inherit metadata from `[default]`. The parser rejects duplicate or malformed entries, limits files to 1 MiB and 1,000 profiles, and excludes unrelated fields and SSO/session/service sections from its response.

Prefer a file containing only these metadata fields. The parser reads the supplied file's bytes even though it returns only the allowed fields. Personal `profiles.txt` and `.state/` are ignored by Git. Edit the file and click **Refresh** to reload it. The app never edits the source config.

## Use a profile in a terminal

1. Select a profile and review its details.
2. Save it as the app's CLI selection.
3. Choose Bash/Zsh or PowerShell, copy the generated commands, and paste them into the terminal you want to configure.

The commands set `AWS_CONFIG_FILE` to the file this app reads, set `AWS_PROFILE` and `AWS_DEFAULT_PROFILE`, and apply the selected region. A missing region clears previous region overrides. The commands also clear exported access-key, session-token, and web-identity role variables so they do not override the selected profile. Bash/Zsh commands are not for Fish or Windows Command Prompt.

The selected profile and its `source_profile` must have working authentication configured for your AWS tools. Credentials can remain in the existing AWS credentials file or an approved provider. AWS tools may honor additional settings in the config, including credential providers, even though this app does not display them. Use a config you trust.

The saved selection is stored in `.state/active-profile.json`; it is not a live terminal session. A browser cannot change an existing terminal's environment. The app does not run these commands, assume a role, or verify AWS access. With AWS CLI installed, verify the terminal context after applying the commands:

```sh
aws sts get-caller-identity
```

## Open a role in AWS Console

1. Sign in to AWS in the browser using your organization's normal process.
2. Select a profile and review its account and role.
3. Open the AWS Switch Role page in a new tab, review and confirm the switch on AWS, then choose your region in the console.

Links use AWS's fixed `https://signin.aws.amazon.com/switchrole` destination with `account` and `roleName` parameters derived from the ARN. AWS documents this [role-link format and its 64-character path/name limit](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_permissions-to-switch.html).

For browser access, `source_profile` and `region` are reference metadata: they do not select the browser's source identity or set the console region. AWS authorizes switches using the original browser sign-in identity, including when already viewing another role. The app cannot confirm your live AWS identity or whether switching succeeded. Follow [AWS's console switching procedure](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-console.html).

Only commercial AWS `arn:aws:iam::...:role/...` ARNs are supported for console links. Launch is disabled for missing/invalid ARNs, other partitions, or role path/name combinations longer than 64 characters. Roles requiring `ExternalId` cannot be switched to through the console; root-user sessions cannot switch roles either. [AWS console restrictions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-console.html)

SSO-only profiles without a role ARN cannot launch a switch link. Use your organization's AWS access portal to sign in and obtain access; this app does not discover SSO accounts, roles, or permission sets. AWS enforces authentication, MFA, trust policies, and permissions. The app does not change IAM policies or bypass those checks.

**The two actions are independent:** saving a CLI selection does not change your browser's AWS session, and opening a console role does not configure any terminal.

## Local operation and security

The Node server serves local assets, invokes the Python reader, and saves the chosen CLI profile name and config path. It makes no outbound network requests. Your browser contacts AWS when you open a role link. The app has no telemetry or external assets.

This is for a trusted single-user desktop. It binds to `127.0.0.1`, checks Host/origin headers, and requires a per-process token for changes to the saved selection. It has no user authentication: other local processes or users that can reach the port can read profile metadata and use the app. Do not expose it through a LAN listener, public proxy, or shared hosting. See [SECURITY.md](SECURITY.md) for the trust boundary and distribution guidance.

## Validation

```sh
npm test
```

Tests cover metadata parsing and local server behavior using temporary fixtures, without AWS credentials or live AWS requests. Development checks have run on macOS; Windows and Linux instructions require validation on those platforms. Real AWS sign-in and role authorization have not been tested.

The implementation has not received an independent security audit or production certification. Review and test it for your environment before distributing it to clients.
