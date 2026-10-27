# AWS Profile Switcher

Author: jperch1987

A local web app built with **Node.js and Python**. Choose a role from a local AWS config-format text file, enter a fresh MFA code, and either authenticate a terminal or open that role directly in the AWS Console in a new tab.

Clients need a browser, Node.js, Python, and the Python packages in `requirements.txt`, including the AWS SDK **boto3**. **Codex and browser extensions are not required.** Node.js uses only its standard library; no `npm install` is needed. AWS CLI is optional for the app itself; install it separately to run `aws` commands.

This version requires a fresh six-digit MFA code in the web app for each CLI credential request or direct Console launch. CLI credentials appear as five ready-to-copy environment assignments, similar to an access portal. Authentication uses a role whose `source_profile` supplies an IAM user's long-term access keys; this is not IAM Identity Center or SSO integration. SSO, `credential_process`, web-identity credentials, and role chaining are not supported by this authentication flow. The manual AWS Switch Role page remains available as a separate fallback.

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

Add the `export PATH=...` line to `~/.zshrc` if you want it applied in future Zsh terminals. The [Node.js formula](https://formulae.brew.sh/formula/node@24) is keg-only; the [Python formula](https://formulae.brew.sh/formula/python@3.14) puts the `python3` alias in its `libexec/bin` directory. Continue with the virtual environment and `requirements.txt` installation below; Homebrew does not install the app's Python packages.

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
- **PowerShell blocks `npm.ps1`:** use `npm.cmd start` to run the app and `npm.cmd test` for tests. You can also start with `node server.mjs`.

Virtual environment activation is optional: the commands below call its Python executable directly.

### Debian on WSL

Run the server with Linux Node.js and Python inside Debian. From the project folder, create a separate Linux virtual environment in your WSL home directory:

```sh
sudo apt update
sudo apt install python3 python3-venv python3-pip
python3 -m venv "$HOME/.venvs/aws-profile-switcher-wsl"
"$HOME/.venvs/aws-profile-switcher-wsl/bin/python" -m pip install -r requirements.txt
export PYTHON="$HOME/.venvs/aws-profile-switcher-wsl/bin/python"
npm start
```

Use Python 3.11 or newer and install Node.js using the Linux instructions above. Do not reuse a Windows `.venv` inside WSL. Set `PYTHON` to this same Linux interpreter each time you start the app; it takes precedence over any `.venv` in the checkout.

The source keys must exist in **WSL's** `~/.aws/credentials`, not only in your Windows home. Match the credentials section to `source_profile` exactly. For example, `source_profile = work-user` requires a `[work-user]` section containing that source user's keys; putting them only under `[default]` will not satisfy that configuration. Keep the MFA device identifier in `mfa_serial` in the profile config as described below.

## Install and run the app

Install Git if you want to use the clone commands below. Alternatively, select **Code → Download ZIP** on the [GitHub repository](https://github.com/jperch1987/aws-profile-switcher), extract it, and open a terminal in the extracted folder; skip the `git clone` and `cd` lines. Create the virtual environment, install the Python dependencies, and configure your roles and source credentials before authenticating.

macOS/Linux:

```sh
git clone https://github.com/jperch1987/aws-profile-switcher.git profile-switcher
cd profile-switcher
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
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item profiles.example.txt profiles.txt
# Edit profiles.txt and configure source credentials as described below.
npm.cmd start
```

You can also start with `node server.mjs`. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and stop the server with Ctrl+C. Example account IDs, MFA devices, and roles are placeholders and will not grant AWS access. When upgrading an existing checkout, rerun the dependency installation command and restart the server; do not overwrite your personal `profiles.txt`.

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
| `PROFILE_SWITCHER_STATE_DIR` | `.state` beside the server | Directory for saved selection metadata; never stores or restores credentials |

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

For MFA authentication, each selected role needs `role_arn`, `source_profile`, and a valid `mfa_serial`. Put `mfa_serial` on the role or on its referenced source profile; a role's own setting takes precedence. Use the virtual device ARN or hardware device serial associated with the **source IAM user**, which may be in a different account from the target role. Set `region` on each role to choose its CLI and Console region; if absent, the helper uses the source profile's region, then `us-east-1`. These are explicit helper fallbacks, not general inheritance from `[default]`. Use `external_id` on a role only when required by its trust policy.

Store the source IAM user's long-term credentials in the normal AWS shared credentials file, usually `~/.aws/credentials` (`%USERPROFILE%\.aws\credentials` on Windows):

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

Every **Get CLI credentials** request needs a fresh MFA code and creates a new one-hour STS session. The exported credentials can be reused until they expire; pasting the same valid exports does not request MFA again. The app does not reuse a cached session for a new request or refresh credentials in the background. Request a new set whenever you switch roles or the session expires. Console access is a separate request with its own fresh MFA entry; requesting CLI credentials does not sign in your browser.

Use the temporary exports without `--profile`, which can select a separate AWS CLI profile workflow. With AWS CLI installed, verify the identity before doing work:

```sh
aws sts get-caller-identity
```

These assignments contain **live secrets**. Turn off shell tracing and avoid terminal recording or shell history that saves the pasted credentials. Copying is explicit, but clipboard history or synchronization tools may retain what you copy. Do not share the commands or include them in screenshots, logs, or support messages.

Use **Clear credentials** to remove the displayed values. The app also removes them when you change profiles, begin another authentication request, refresh, encounter an authentication failure, reach the session's expiration, or leave the page. This only clears the app's display and references: it does not clear the clipboard, shell environment, terminal history, or revoke an AWS session. A failed request does not change credentials already pasted into a terminal. The browser cannot change an existing terminal's environment.

Temporary credentials are returned over the loopback HTTP connection and held in the browser's memory and page content. They are not saved to browser storage or server state. The new CLI flow does not save the selection. Any legacy selection in `.state/active-profile.json` contains only profile/config metadata; restoring a selection never restores credentials.

For advanced terminal-only use, `aws_session.py` remains available as an optional helper that prompts for MFA in the terminal. It is separate from the web app's copy-and-paste workflow.

## Open a role in AWS Console

1. Select a role profile and review its account, role, source, and region.
2. Enter a fresh six-digit MFA code in the app.
3. Use the direct Console action. A new tab opens the selected role's AWS Console after authentication, without the intermediate AWS Switch Role form.

The local Python helper authenticates with the configured source IAM user's credentials and MFA, calls STS `AssumeRole`, and exchanges the temporary credentials for an AWS federation sign-in token over HTTPS. It opens a login URL targeting the selected region. This uses [AWS's documented federation flow](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_enable-console-custom-url.html); it skips the manual form while preserving AWS authorization and MFA checks. An existing browser sign-in is not the source identity for this direct flow.

The sign-in URL is a temporary bearer credential: do not copy, log, share, or screenshot it. The app does not save MFA codes or temporary credentials to disk. Browser history, developer tools, extensions, local processes, and terminal recording tools remain part of your device's trust boundary. Review the account and role shown inside AWS after navigation. The app cannot inspect the final AWS page to confirm which identity is active, and browser session behavior remains controlled by AWS.

### If direct Console sign-in times out

The new tab shows progress while the app contacts AWS. If sign-in fails, it stays open with the same error shown in the original app. Return to the original app to retry with a fresh MFA code; you can close the failed tab.

CLI authentication calls AWS STS. Direct Console sign-in also contacts `signin.aws.amazon.com` to exchange the role credentials for a sign-in token. A working CLI request does not establish connectivity to that second endpoint. Console requests have a 75-second overall limit to accommodate both sequential requests; CLI requests retain their 45-second limit. Individual network timeouts still apply.

- **Creating the AWS role session timed out:** check the server computer's network access to AWS STS.
- **The role was authenticated, but AWS Console sign-in timed out:** check network and DNS access to `signin.aws.amazon.com` from the environment running the server. For WSL, this means Debian's connection, which can differ from the Windows browser's connection.
- **Certificate verification failed:** fix the Python environment's trusted CA certificates using your organization's approved certificate setup. Do not disable certificate verification.
- **AWS Console sign-in failed (HTTP …):** report the status number and safe error text. Never share a sign-in URL, MFA code, or credentials.

For a basic connection check in the same WSL terminal, run:

```sh
curl -I --max-time 15 https://signin.aws.amazon.com/federation
```

An HTTP response, including an error status, means this check reached an HTTP endpoint; it does not prove federation authentication will succeed. A connection, DNS, or certificate error identifies a network setup issue to investigate. The helper does not use proxy environment overrides, so a successful curl request through a configured proxy does not establish that the helper can connect directly.

### Manual Switch Role fallback

The separate manual switch-page link still opens AWS's standard form in a new tab. Sign in to AWS first in that browser, then review and confirm the role on AWS. This fallback uses the original browser sign-in identity; it does not use local source keys or the app's MFA field, and you choose the Console region on AWS. The link is restricted to the fixed `https://signin.aws.amazon.com/switchrole` destination and commercial AWS role ARNs.

AWS's manual form cannot supply an `ExternalId`, and its role path/name limit is 64 characters. The direct authentication flow can supply a configured `external_id` through STS. Root-user browser sessions cannot manually switch roles. See [AWS Console switching restrictions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-console.html).

This release supports commercial AWS (`arn:aws:iam::...:role/...`), not AWS China or GovCloud. For SSO and other unsupported identity providers, use your organization's access portal or approved tools. The app does not discover SSO permission sets or change IAM policies.

**The two actions are independent:** getting CLI credentials does not change your browser's AWS session, and opening a console role does not configure any terminal. Each authentication request requires fresh MFA entry.

## Local operation and security

The Node server serves local assets, invokes Python, and can save profile-selection metadata. During authentication the Python helper reads source keys, holds MFA codes and temporary credentials in memory, and contacts AWS STS and, for Console access, the AWS federation endpoint over HTTPS. The CLI response intentionally contains temporary credentials in the shell assignments shown in the browser. Source keys are never returned to the browser. The app has no telemetry or external UI assets.

The authentication helper uses fixed AWS destinations and does not honor custom endpoint or proxy overrides. Networks that require an outbound proxy may need an approved network configuration before authentication can work.

This is a **credential-capable application for a trusted single-user desktop**. It binds to `127.0.0.1`, checks Host/origin headers, and requires a per-process token for state-changing and authentication requests. These controls are not user authentication: another local process or user that can reach the port can access the app and submit authentication requests. Do not expose it through a LAN listener, public proxy, or shared hosting. See [SECURITY.md](SECURITY.md) for credential handling, the trust boundary, and distribution guidance.

## Validation

```sh
npm test
```

Tests use temporary fixtures and mocked AWS responses; they do not require customer credentials or make live AWS authentication requests. They cover metadata parsing, MFA/session handling, command generation, and local server behavior. Development checks run on macOS; Windows and Linux instructions require validation on those platforms. End-to-end AWS MFA, federation sign-in, and your role policies must be verified in your own environment.

The implementation has not received an independent security audit or production certification. Review and test it for your environment before distributing it to clients.
