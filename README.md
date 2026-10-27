# AWS Profile Switcher

Author: jperch1987

A local web app built with **Node.js and Python**. Choose roles from a local AWS config-format text file to copy temporary credentials for a terminal, open AWS's prefilled Switch Role page in your current browser, or look up a resource across selected roles.

Clients need Node.js, Python, the packages in `requirements.txt` (including **boto3**), and their existing browser. **No separate browser, Codex, or browser extension is required.** AWS CLI is optional for the app itself; install it separately to run `aws` commands. Download or clone the repository, install the Python dependencies locally, and configure your profiles.

**Get CLI credentials** requires a fresh six-digit MFA code in the app and produces five ready-to-copy environment assignments. It uses an IAM user's long-term keys through `source_profile`; SSO, `credential_process`, web identity, temporary source credentials, and role chaining are not supported by this CLI flow. **Open AWS Switch Role** opens a new tab in your current browser, using its AWS sign-in session. Review the prefilled account and role, then click **Switch Role** on AWS. AWS handles any sign-in and MFA prompts there.

**Resource Lookup** searches for an exact resource ID, name, or ARN using the configured roles and regions. Each search requires fresh MFA for one source identity and can include up to 25 profiles sharing that source and MFA device. It returns resource metadata, not credentials. It uses the existing boto3 dependency and requires no AWS Resource Explorer setup.

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

Add the `export PATH=...` line to `~/.zshrc` if you want it applied in future Zsh terminals. The [Node.js formula](https://formulae.brew.sh/formula/node@24) is keg-only; the [Python formula](https://formulae.brew.sh/formula/python@3.14) puts the `python3` alias in its `libexec/bin` directory. Continue with the app installation below; Homebrew does not install the app's Python packages.

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
- **PowerShell blocks `npm.ps1`:** use `npm.cmd` in place of `npm`. You can also start with `node server.mjs`.

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
npm start
```

Use Python 3.11 or newer and install Node.js using the Linux instructions above. Do not reuse a Windows `.venv` inside WSL. Set `PYTHON` to this same Linux interpreter each time you start the app; it takes precedence over any `.venv` in the checkout.

Open the app in your usual Windows browser at [http://127.0.0.1:3000](http://127.0.0.1:3000). The Console link opens in that browser; the server does not launch a Linux browser.

For CLI credentials and Resource Lookup, the source keys must exist in **WSL's** `~/.aws/credentials`, not only in your Windows home. Match the credentials section to `source_profile` exactly. For example, `source_profile = work-user` requires a `[work-user]` section containing that source user's keys; putting them only under `[default]` will not satisfy that configuration. Keep the MFA device identifier in `mfa_serial` in the profile config as described below.

## Install and run the app

Install Git if you want to use the clone commands below. Alternatively, select **Code → Download ZIP** on the [GitHub repository](https://github.com/jperch1987/aws-profile-switcher), extract it, and open a terminal in the extracted folder; skip the `git clone` and `cd` lines. Run the setup commands below and configure your roles. Configure source credentials as well if you need CLI credentials or Resource Lookup.

macOS/Linux:

```sh
git clone https://github.com/jperch1987/aws-profile-switcher.git profile-switcher
cd profile-switcher
npm ci
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
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item profiles.example.txt profiles.txt
# Edit profiles.txt and configure source credentials as described below.
npm.cmd start
```

You can also start with `node server.mjs`. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and stop the server with Ctrl+C. Example account IDs, MFA devices, and roles are placeholders and will not grant AWS access. When upgrading an existing checkout, run `git pull`, `npm ci`, and the Python dependency installation command, then restart the server and refresh the app. Use `npm.cmd` on PowerShell. Do not overwrite your personal `profiles.txt`. The Node.js server uses its standard library and has no runtime npm dependencies.

**Upgrading from v1.3.0:** `npm ci` removes the app's obsolete Playwright Node.js dependency. Previously downloaded Chromium binaries and `.state/browser` (or `browser/` under a custom state directory) are neither used nor automatically deleted. The old browser profile may contain sensitive cookies and sign-in data; keep it private and out of shared files. Browser download caches may be shared with other projects.

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
| `PROFILE_SWITCHER_STATE_DIR` | `.state` beside the server | Directory for legacy selection metadata; old v1.3.0 browser data is not loaded |

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

For CLI and lookup MFA authentication, each selected role needs `role_arn`, `source_profile`, and a valid `mfa_serial`. Put `mfa_serial` on the role or on its referenced source profile; a role's own setting takes precedence. Use the virtual device ARN or hardware device serial associated with the **source IAM user**, which may be in a different account from the target role. Set `region` on each role to choose its CLI and lookup region; if absent, the helper uses the source profile's region, then `us-east-1`. These are explicit helper fallbacks, not general inheritance from `[default]`. Use `external_id` on a role only when required by its trust policy; such roles are supported by CLI and lookup but cannot use the AWS Console Switch Role form.

For CLI and lookup authentication, store the source IAM user's long-term credentials in the normal AWS shared credentials file, usually `~/.aws/credentials` (`%USERPROFILE%\.aws\credentials` on Windows):

```ini
[default]
aws_access_key_id = YOUR_SOURCE_IAM_USER_ACCESS_KEY_ID
aws_secret_access_key = YOUR_SOURCE_IAM_USER_SECRET_ACCESS_KEY
```

Replace the placeholders locally. Credentials-file section names omit the `profile` prefix: a source named `work-user` uses `[work-user]` there and `[profile work-user]` in your config. The helper uses the standard credentials-file location; it does not honor `AWS_SHARED_CREDENTIALS_FILE` overrides. Existing static keys in the source's config section are also supported, but keeping them in the credentials file separates secrets from the profile metadata. Protect this file with your operating system's user permissions. Do not put credentials in Git, browser fields, screenshots, or support messages.

The helper reads the specified source's keys directly. It does not use a cached assumed-role session, exported credentials from a previous switch, SSO, `credential_process`, web identity, or a chain of roles. Unsupported source setups fail with an explanation. The source user needs permission to assume the target role, and that role's trust policy must allow it. For CLI requests, the app supplies the device serial and fresh MFA code to [AWS STS AssumeRole](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html); AWS decides whether access is allowed. Resource Lookup uses the separate, short-lived batch authentication described below.

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

Every **Get CLI credentials** request needs a fresh MFA code and creates a new one-hour STS session. The exported credentials can be reused until they expire; pasting the same valid exports does not request MFA again. The app does not reuse a cached session for a new request or refresh credentials in the background. Request a new set whenever you switch roles or the session expires. Console switching uses your current browser's AWS session and AWS's sign-in/MFA prompts; requesting CLI credentials does not sign in that browser.

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

## Find a resource across profiles

Use **Resource Lookup** when you know a resource's ID, exact name, or ARN and need to find which configured role can see it. It queries AWS directly and needs no AWS Resource Explorer index or other discovery service.

1. Choose a **Source identity**. Profiles are grouped by their exact `source_profile` and resolved MFA device; a batch cannot mix groups.
2. Choose one **Resource type** and enter its **Exact ID, name, or ARN**. Queries are single-line, limited to 256 characters, and do not support wildcard or substring searches.
3. Under **Search scope**, select 1–25 profiles. Each regional resource is checked only in that profile's resolved configured region. S3 searches owned buckets across regions and reports the bucket's actual region when available.
4. Enter a fresh code in **Lookup MFA code**, then choose **Search resources**. To search another source identity or another batch of profiles, start a new search with a fresh code.
5. Review both the matches and each profile's coverage/status. Use **Cancel search** to stop an active search or **Clear results** to remove displayed metadata.

| Resource type | Exact match supported | Required target-role read permission |
| --- | --- | --- |
| EC2 instance | Instance ID, `Name` tag, or instance ARN | `ec2:DescribeInstances` |
| EBS volume | Volume ID, `Name` tag, or volume ARN | `ec2:DescribeVolumes` |
| Security group | Group ID, group name, `Name` tag, or security-group ARN | `ec2:DescribeSecurityGroups` |
| VPC | VPC ID, `Name` tag, or VPC ARN | `ec2:DescribeVpcs` |
| S3 bucket | Bucket name or bucket ARN; buckets owned by the target account | `s3:ListAllMyBuckets`, `s3:GetBucketLocation` |
| RDS DB instance | DB instance identifier or DB instance ARN | `rds:DescribeDBInstances` |
| Lambda function | Function name or unqualified function ARN | `lambda:GetFunctionConfiguration` |

This scope does not include RDS clusters, Lambda versions/aliases, S3 objects, buckets merely shared from another account, or regions absent from the selected profiles. A `Name` tag is not necessarily unique, so multiple exact matches can be valid. Lambda lookup does not download function code or return environment variables.

Searches are bounded: the Python worker has a 150-second deadline, the server terminates a worker after 180 seconds, and results are limited to 100 matches per profile. Paginated EC2 filters and S3 scans stop after 10 pages per filter/scan. Hitting a limit is reported as incomplete. A denied request, timeout, cancelled or unsearched profile, or partial scan **does not establish that a resource does not exist**. Even a completed no-match result applies only to the selected account, resource type, and region/ownership scope. If S3 ownership is confirmed but reading its location is denied, the confirmed match can remain with an unknown region and an access-denied status.

Each search calls [AWS STS GetSessionToken](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetSessionToken.html) once for the chosen source identity with a fresh MFA code and a 900-second duration. The worker uses that temporary IAM-user session to assume each target role separately for 900 seconds. It passes the configured external ID when needed and supplies a restrictive session policy containing only the selected resource type's read actions. Credentials stay inside the worker and are discarded when it exits; they are not returned as exports, saved to disk, or reused by another search. This does not change the separate **Get CLI credentials** requirement for fresh MFA on every request.

The source user still needs permission to assume the target roles, and their existing trust policies must allow it. The target roles need the read permissions above. [lookup-permissions.example.json](lookup-permissions.example.json) is a target-role permission example for all seven supported types; review it and narrow resources where the API supports that. The app does not attach policies or grant permissions. Its per-search session policy cannot add permissions missing from the target role. `GetSessionToken` itself does not require an IAM permission grant. MFA is evaluated when assuming the role; assumed-role credentials do not satisfy a separate MFA-context requirement on downstream resource policies. See [AWS MFA-protected API access](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_configure-api-require.html).

The browser displays only resource metadata and scan statuses. **Clear results**, page exit/reload, or **Refresh** clears the local display. The server keeps only the most recent lookup's metadata in memory, replaces it when a new lookup starts, and expires it 10 minutes after the lookup finishes. Clearing the display does not immediately delete that server snapshot; stopping the server clears its memory. The browser also expires displayed results. Neither cancelling nor clearing a search revokes temporary AWS credentials before their normal expiration. Treat account, resource, and naming information as private when sharing screenshots or support reports.

## Open a role in AWS Console

1. Select a role profile and review its target account and full role name.
2. Choose **Open AWS Switch Role**. AWS's Switch Role page opens in a new tab in the browser you are already using, with the account and role prefilled.
3. Sign in to AWS in that browser if needed, using an identity authorized to assume the role. Complete any AWS MFA prompts there. If sign-in does not return you to the form, open the link again.
4. Review the form and click **Switch Role** on AWS. Confirm the account and role shown in the AWS Console before working, and choose your Console region there.

The app opens a normal link; it does not click AWS's confirmation button or control the new tab. The app's MFA field and local source access keys are used for CLI credentials, not this Console action. It does not log you out or replace your browser's original sign-in identity.

AWS authorizes a role switch using the browser's original sign-in identity, even after switching to another role. AWS controls sign-in and MFA requirements; this flow does not force a fresh MFA challenge on every switch. Root-user sessions cannot switch roles, roles requiring `ExternalId` cannot use the form, and the complete role path/name must be no more than 64 characters. See [AWS Console switching restrictions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-console.html).

The link supports commercial AWS role ARNs (`arn:aws:iam::...:role/...`) and is restricted to `https://signin.aws.amazon.com/switchrole`. The app does not discover SSO permission sets, configure an identity provider, or change IAM policies. Use your organization's approved sign-in process.

Getting CLI credentials does not change your browser's AWS session, and switching a Console role does not configure a terminal.

## Local operation and security

The Node server serves local assets and invokes Python for CLI authentication and Resource Lookup. The Python helpers read source keys and contact AWS STS over HTTPS; lookup also calls the selected AWS service's read APIs. CLI responses intentionally contain temporary credentials in the displayed exports, while lookup responses contain only resource metadata and statuses. Source keys are never returned to the browser. Console switching uses a normal AWS link in your current browser. Local UI assets have no external scripts, fonts, or telemetry.

The authentication helper uses fixed AWS destinations and does not honor custom endpoint or proxy overrides. Networks that require an outbound proxy may need an approved network configuration before authentication can work.

This is a **credential-capable application for a trusted single-user desktop**. It binds to `127.0.0.1`, checks Host/origin headers, and requires a per-process token for state-changing and authentication requests. These controls are not user authentication: another local process or user that can reach the port can access the app and submit authentication requests. Do not expose it through a LAN listener, public proxy, or shared hosting. See [SECURITY.md](SECURITY.md) for credential handling, the trust boundary, and distribution guidance.

## Validation

```sh
npm test
```

Tests use temporary fixtures and mocked AWS responses; they do not require customer credentials or make live AWS authentication requests. They cover metadata parsing, MFA/session handling, command generation, resource lookup, Console-link validation, and local server behavior. Development checks run on macOS; Windows, Linux, and WSL installations require validation on those platforms. Real AWS sign-in, MFA, resource-read permissions, and your role policies must be verified in your own environment.

The implementation has not received an independent security audit or production certification. Review and test it for your environment before distributing it to clients.
