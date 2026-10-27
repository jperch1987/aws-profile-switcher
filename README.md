# AWS Profile Switcher

Author: jperch1987

A local web app built with **Node.js and Python**. Choose a role from a local AWS config-format text file and either copy temporary credentials for a terminal or switch roles automatically in a separate app-controlled AWS browser.

Clients need Node.js, Python, the packages in `requirements.txt` (including **boto3**), and the pinned **Playwright** package and Chromium browser for automatic Console switching. **Codex and browser extensions are not required.** AWS CLI is optional for the app itself; install it separately to run `aws` commands. The repository contains source code and dependency manifests; each client installs the dependencies and browser binaries locally.

**Get CLI credentials** requires a fresh six-digit MFA code in the app and produces five ready-to-copy environment assignments. It uses an IAM user's long-term keys through `source_profile`; SSO, `credential_process`, web identity, temporary source credentials, and role chaining are not supported by this CLI flow. **Open AWS Console** uses the identity signed in to the dedicated browser instead. You complete sign-in and any AWS MFA prompts in that browser; the app then submits the AWS Switch Role form. A manual switch-page link remains available for your ordinary browser.

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

With [Homebrew](https://brew.sh/) already installed, you can instead install the runtimes and Git with:

```sh
brew update
brew install node@24 python@3.14 git
export PATH="$(brew --prefix node@24)/bin:$(brew --prefix python@3.14)/libexec/bin:$PATH"
node --version
npm --version
python3 --version
```

Add the `export PATH=...` line to `~/.zshrc` if you want it applied in future Zsh terminals. The [Node.js formula](https://formulae.brew.sh/formula/node@24) is keg-only; the [Python formula](https://formulae.brew.sh/formula/python@3.14) puts the `python3` alias in its `libexec/bin` directory. Continue with the app installation below; Homebrew does not install the app's Python packages, Playwright package, or Chromium browser.

### Linux

Install Python from your distribution's package manager. For example, on Ubuntu/Debian:

```sh
sudo apt update
sudo apt install python3 python3-venv python3-pip git curl
```

On Fedora:

```sh
sudo dnf install python3 python3-pip git curl
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

- **Command not found:** reopen your terminal after installation and check that Node.js and Python are on PATH. Use `python3` on macOS/Linux and `python` on Windows to create the virtual environment.
- **Windows has `py`, but `python` does not work:** if `py -3 --version` reports Python 3.11+, use this command from the project folder instead of `python -m venv .venv`, then continue with dependency installation:

  ```powershell
  py -3 -m venv .venv
  ```

- **Multiple Python versions:** create `.venv` using the desired Python version. The server selects the project's virtual environment automatically unless `PYTHON` is set. A `PYTHON` override must be one executable path, without arguments; `py -3` is not a valid value. Install `requirements.txt` with that same interpreter.
- **Missing boto3:** install `requirements.txt` into the Python environment used by the server, then restart it. A previously set `PYTHON` override takes precedence over `.venv`.
- **PowerShell blocks `npm.ps1`:** use `npm.cmd` and `npx.cmd` in place of `npm` and `npx`. You can also start with `node server.mjs`.
- **Chromium is missing:** from the project folder, run `npm ci`, then `npx playwright install chromium`. On supported Linux distributions, use `npx playwright install --with-deps chromium` to install the required system libraries too. See [Playwright browser installation](https://playwright.dev/docs/browsers).

Virtual environment activation is optional: the commands below call its Python executable directly.

### Debian on WSL

Run the server with Linux Node.js and Python inside Debian. From the project folder, create a separate Linux virtual environment in your WSL home directory:

```sh
sudo apt update
sudo apt install python3 python3-venv python3-pip
python3 -m venv "$HOME/.venvs/aws-profile-switcher-wsl"
"$HOME/.venvs/aws-profile-switcher-wsl/bin/python" -m pip install -r requirements.txt
export PYTHON="$HOME/.venvs/aws-profile-switcher-wsl/bin/python"
npm ci
npx playwright install --with-deps chromium
npm start
```

Use Python 3.11 or newer and install Node.js using the Linux instructions above. Do not reuse a Windows `.venv` inside WSL. Set `PYTHON` to this same Linux interpreter each time you start the app; it takes precedence over any `.venv` in the checkout.

Automatic Console switching launches a visible **Linux** Chromium window, so WSL needs **WSL 2 with WSLg**. Microsoft documents GUI support on Windows 10 build 19044+ and Windows 11; WSL 1 cannot run this flow. If the browser cannot open, follow [Microsoft's WSL GUI setup and troubleshooting](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps). Without a working Linux display, run the app natively on Windows or use the manual switch-page link. Install browser dependencies inside the same WSL distribution as the server.

For CLI credentials, the source keys must exist in **WSL's** `~/.aws/credentials`, not only in your Windows home. Match the credentials section to `source_profile` exactly. For example, `source_profile = work-user` requires a `[work-user]` section containing that source user's keys; putting them only under `[default]` will not satisfy that configuration. Keep the MFA device identifier in `mfa_serial` in the profile config as described below.

## Install and run the app

Install Git if you want to use the clone commands below. Alternatively, select **Code → Download ZIP** on the [GitHub repository](https://github.com/jperch1987/aws-profile-switcher), extract it, and open a terminal in the extracted folder; skip the `git clone` and `cd` lines. Install the Node.js dependencies, Chromium, and Python dependencies, then configure your roles. Configure source credentials as well if you need CLI credentials.

macOS/Linux:

```sh
git clone https://github.com/jperch1987/aws-profile-switcher.git profile-switcher
cd profile-switcher
npm ci
npx playwright install chromium
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp profiles.example.txt profiles.txt
# Edit profiles.txt and configure source credentials as described below.
npm start
```

Windows PowerShell:

```powershell
git clone https://github.com/jperch1987/aws-profile-switcher.git profile-switcher
cd profile-switcher
npm.cmd ci
npx.cmd playwright install chromium
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item profiles.example.txt profiles.txt
# Edit profiles.txt and configure source credentials as described below.
npm.cmd start
```

On supported Linux distributions, replace the browser installation command with `npx playwright install --with-deps chromium` to include system libraries; installing these may require administrator privileges. See [Playwright installation requirements](https://playwright.dev/docs/browsers).

You can also start with `node server.mjs`. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and stop the server with Ctrl+C. Example account IDs, MFA devices, and roles are placeholders and will not grant AWS access. When upgrading an existing checkout, run `git pull`, `npm ci`, `npx playwright install chromium`, and the Python dependency installation command, then restart the server and refresh the app. Use the `.cmd` commands on PowerShell. Do not overwrite your personal `profiles.txt`. Playwright loads only when automatic Console switching is requested; metadata and CLI features do not launch Chromium.

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
| `PYTHON` | Project `.venv` Python when present; otherwise `python3` or Windows `python` | Override the Python executable; its environment must contain `requirements.txt` packages |
| `PROFILE_SWITCHER_STATE_DIR` | `.state` beside the server | Directory for legacy selection metadata and the sensitive persistent Chromium profile in `browser/` |

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
mfa_serial = arn:aws:iam::123456789012:mfa/example-user

[profile development]
role_arn = arn:aws:iam::111122223333:role/Developer
source_profile = default
region = ap-southeast-1
mfa_serial = arn:aws:iam::123456789012:mfa/example-user

[profile production]
role_arn = arn:aws:iam::444455556666:role/team/ReadOnly
source_profile = default
region = us-east-1
# Uses mfa_serial from the source profile when omitted here.
# external_id = external-id-provided-by-your-client
```

Use `[default]` or `[profile name]` sections. Quote names containing spaces, such as `[profile "team dev"]`. Comments and UTF-8 are accepted. The reader tolerates a BOM; use UTF-8 without a BOM if AWS CLI will read the same file. The parser rejects duplicate or malformed entries, limits files to 1 MiB and 1,000 profiles, and excludes credentials and unrelated sections from the metadata returned to the browser.

For CLI MFA authentication, each selected role needs `role_arn`, `source_profile`, and a valid `mfa_serial`. Put `mfa_serial` on the role or on its referenced source profile; a role's own setting takes precedence. Use the virtual device ARN or hardware device serial associated with the **source IAM user**, which may be in a different account from the target role. Set `region` on each role to choose its CLI region; if absent, the helper uses the source profile's region, then `us-east-1`. These are explicit helper fallbacks, not general inheritance from `[default]`. Use `external_id` on a role only when required by its trust policy; such roles are supported by the CLI flow but cannot use the AWS Console Switch Role form.

For CLI authentication, store the source IAM user's long-term credentials in the normal AWS shared credentials file, usually `~/.aws/credentials` (`%USERPROFILE%\.aws\credentials` on Windows):

```ini
[default]
aws_access_key_id = YOUR_SOURCE_IAM_USER_ACCESS_KEY_ID
aws_secret_access_key = YOUR_SOURCE_IAM_USER_SECRET_ACCESS_KEY
```

Replace the placeholders locally. Credentials-file section names omit the `profile` prefix: a source named `work-user` uses `[work-user]` there and `[profile work-user]` in your config. The helper uses the standard credentials-file location; it does not honor `AWS_SHARED_CREDENTIALS_FILE` overrides. Existing static keys in the source's config section are also supported, but keeping them in the credentials file separates secrets from the profile metadata. Protect this file with your operating system's user permissions. Do not put credentials in Git, browser fields, screenshots, or support messages.

The helper reads the specified source's keys directly. It does not use a cached assumed-role session, exported credentials from a previous switch, SSO, `credential_process`, web identity, or a chain of roles. Unsupported source setups fail with an explanation. The source user needs permission to assume the target role, and that role's trust policy must allow it. The app supplies the device serial and fresh MFA code to [AWS STS AssumeRole](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html); AWS decides whether access is allowed.

Prefer a metadata-only profile file. The parser reads its bytes before filtering fields, and the authentication helper can read source credentials. Personal `profiles.txt`, `.venv/`, and `.state/` are ignored by Git. Edit the config and click **Refresh** to reload it. The app never edits your source config or credentials file.

## Use a profile in a terminal

1. Select a role profile and review its account, role, source, and MFA device.
2. Enter a fresh six-digit MFA code **in the web app**, then choose **Get CLI credentials**.
3. Choose Bash/Zsh or PowerShell. Review the role and expiration shown with the five environment assignments, then copy them.
4. Paste the assignments into a fresh terminal without prior AWS environment overrides, especially `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, or the legacy `AWS_SECURITY_TOKEN`. Run AWS commands without `--profile`.

The local server calls AWS STS with your source credentials and MFA. It returns temporary credentials as simple shell assignments for `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, and `AWS_DEFAULT_REGION`. For example, the Bash/Zsh format is:

```sh
export AWS_ACCESS_KEY_ID='TEMPORARY_ACCESS_KEY_ID'
export AWS_SECRET_ACCESS_KEY='TEMPORARY_SECRET_ACCESS_KEY'
export AWS_SESSION_TOKEN='TEMPORARY_SESSION_TOKEN'
export AWS_REGION='ap-southeast-1'
export AWS_DEFAULT_REGION='ap-southeast-1'
```

The actual values come from the app; the example above contains placeholders. PowerShell uses `$Env:NAME = 'value'` for the same five variables. Bash/Zsh exports are not for Fish or Windows Command Prompt. Pasting them requires no Python installation, local helper invocation, or second MFA prompt in the target terminal. Python and boto3 are still required on the computer running the local server.

If you reuse a terminal, clear these older profile/token/provider overrides **before** pasting the new five assignments. For Bash/Zsh:

```sh
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SECURITY_TOKEN AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_SESSION_NAME
```

For PowerShell:

```powershell
'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_SECURITY_TOKEN', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_SESSION_NAME' | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
```

Every **Get CLI credentials** request needs a fresh MFA code and creates a new one-hour STS session. The exported credentials can be reused until they expire; pasting the same valid exports does not request MFA again. The app does not reuse a cached session for a new request or refresh credentials in the background. Request a new set whenever you switch roles or the session expires. Console switching uses the separate browser session and AWS's sign-in/MFA prompts; requesting CLI credentials does not sign in that browser.

If your authenticator changes codes every 30 seconds, wait for a newly displayed code and submit it promptly. The CLI helper's 45-second response timeout does not extend the code's validity, and the app never retries a code automatically. AWS validates the code when it processes the role request.

CLI timeouts now identify the stalled step. **Loading the Python AWS SDK** points to Python startup or local SDK/model files; on WSL, use the Linux-home virtual environment in the WSL installation instructions, set `PYTHON`, and restart. **Reading configuration** or **loading source credentials** points to local file access. **Waiting for AWS STS** means the helper reached the role request; check that WSL can reach the regional AWS STS endpoint. These messages distinguish the stages but do not prove the underlying network or disk cause. Enter a new code after correcting the issue.

Use the temporary exports without `--profile`, which can select a separate AWS CLI profile workflow. With AWS CLI installed, verify the identity before doing work:

```sh
aws sts get-caller-identity
```

These assignments contain **live secrets**. Turn off shell tracing and avoid terminal recording or shell history that saves the pasted credentials. Copying is explicit, but clipboard history or synchronization tools may retain what you copy. Do not share the commands or include them in screenshots, logs, or support messages.

Use **Clear credentials** to remove the displayed values. The app also removes them when you change profiles, begin another authentication request, refresh, encounter an authentication failure, reach the session's expiration, or leave the page. This only clears the app's display and references: it does not clear the clipboard, shell environment, terminal history, or revoke an AWS session. A failed request does not change credentials already pasted into a terminal. The browser cannot change an existing terminal's environment.

Temporary credentials are returned over the loopback HTTP connection and held in the browser's memory and page content. They are not saved to browser storage or server state. The new CLI flow does not save the selection. Any legacy selection in `.state/active-profile.json` contains only profile/config metadata; restoring a selection never restores credentials.

For advanced terminal-only use, `aws_session.py` remains available as an optional helper that prompts for MFA in the terminal. It is separate from the web app's copy-and-paste workflow.

## Open a role in AWS Console

1. Select a role profile and review its target account and full role name.
2. Choose **Open AWS Console**. The server opens a separate Chromium window controlled by this app.
3. If AWS asks you to sign in, do so in that window and complete any AWS MFA prompt there. Use the identity authorized to assume the selected role.
4. The app opens AWS's Switch Role form with the intended account and role prefilled, checks those fields, and clicks **Switch Role** automatically. Review the account and role shown inside AWS before working, and choose your Console region there.

The app shows progress while switching. Canceling a pending switch closes its pending tab; a switch already submitted to AWS cannot be undone by canceling. Stopping the server closes the managed browser. Your ordinary Chrome/Edge session is separate: the app does not copy its cookies, control its tabs, or sign it out. The app's MFA field and local source access keys are used for CLI credentials, not this Console workflow.

The dedicated browser keeps its own profile in `.state/browser` by default, or `browser/` under `PROFILE_SWITCHER_STATE_DIR`. **This directory contains sensitive cookies and other sign-in data on disk.** The default `.state/` location is ignored by Git; keep custom state directories outside the checkout or exclude them too. Sign out through AWS when finished with a client account. Closing the window or stopping the app does not erase that browser profile or revoke its AWS sessions; keep the directory private and never distribute it with the repository.

AWS authorizes each role switch using the browser's original sign-in identity, even after switching to another role. AWS decides when MFA is required; this flow does not force a fresh MFA challenge on every switch. Root-user sessions cannot switch roles, roles requiring `ExternalId` cannot use the form, and the complete role path/name must be no more than 64 characters. See [AWS Console switching restrictions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-console.html).

This is local browser automation of the normal AWS form, not an AWS-supported URL parameter for automatic confirmation. If AWS changes the page, access is denied, sign-in expires, or the form cannot be verified, review the browser and app status and retry or use the manual link. A completed form submission is not independent verification of the final AWS identity. Never bypass a warning or work in an account you have not confirmed.

### Manual Switch Role fallback

**Open switch page manually in this browser** opens the standard form in a new tab in your ordinary browser. Sign in there first, then review and click **Switch Role** yourself. It uses that browser's original sign-in identity and does not use local keys or the app's MFA field. It has the same AWS form restrictions as automatic switching.

Both Console actions support commercial AWS role ARNs (`arn:aws:iam::...:role/...`). The app does not discover SSO permission sets, configure an identity provider, or change IAM policies. Use your organization's approved sign-in process.

Getting CLI credentials does not change either browser's AWS session, and switching a Console role does not configure a terminal.

## Local operation and security

The Node server serves local assets, invokes Python for CLI authentication, and controls the dedicated Chromium browser through Playwright. The Python helper reads source keys and contacts AWS STS over HTTPS; CLI responses intentionally contain temporary credentials in the displayed exports. Source keys are never returned to the browser. Chromium contacts AWS directly and persists its own sensitive browser profile. Local UI assets have no external scripts, fonts, or telemetry.

The authentication helper uses fixed AWS destinations and does not honor custom endpoint or proxy overrides. Networks that require an outbound proxy may need an approved network configuration before authentication can work.

This is a **credential-capable application for a trusted single-user desktop**. It binds to `127.0.0.1`, checks Host/origin headers, and requires a per-process token for state-changing and authentication requests. These controls are not user authentication: another local process or user that can reach the port can access the app, request CLI authentication, and operate the managed browser using its signed-in session. Do not expose it through a LAN listener, public proxy, or shared hosting. See [SECURITY.md](SECURITY.md) for credential handling, the trust boundary, and distribution guidance.

## Validation

```sh
npm test
```

After installing Chromium, `npm run test:browser` also exercises the controller with a real headless browser and simulated AWS pages. All browser requests in that check are intercepted locally; it does not sign in to AWS.

Tests use temporary fixtures and mocked AWS/browser responses; they do not require customer credentials or make live AWS authentication requests. They cover metadata parsing, MFA/session handling, command generation, browser-control guards, and local server behavior. Development checks run on macOS; Windows, Linux, and WSL installations require validation on those platforms. Real AWS sign-in, MFA, automatic form submission, and your role policies must be verified in your own environment.

The implementation has not received an independent security audit or production certification. Review and test it for your environment before distributing it to clients.
