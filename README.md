# AWS Profile Switcher

Author: jperch1987

A local web app built with **Node.js and Python**. Read `profile`, `role_arn`, `source_profile`, and `region` from a local AWS config-format text file, then either copy commands for a terminal or open AWS's Switch Role page in your browser.

Clients need a browser, Node.js, and Python. **Codex and browser extensions are not required.** The app uses standard libraries, so there are no application packages to install. AWS CLI is optional for using the app; install it separately if you want to run AWS CLI commands.

## Install and run

Install a patched **Node.js 24 LTS** or **22 LTS**, **Python 3.11+**, and Git. Use a supported Node release from the [official release list](https://nodejs.org/en/about/previous-releases). Ensure `node` and `python3` (macOS/Linux) or `python` (Windows) are on your PATH.

Clone the repository, create your local configuration from the example, and start the app.

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
npm start
```

You can also start with `node server.mjs`. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and stop the server with Ctrl+C. Example account IDs and roles are placeholders and will not grant AWS access.

To keep your metadata file outside the checkout:

```sh
PROFILES_FILE="$HOME/aws-profiles.txt" npm start
```

```powershell
$Env:PROFILES_FILE = "$HOME/aws-profiles.txt"
npm start
```

| Setting | Default | Purpose |
| --- | --- | --- |
| `PROFILES_FILE` | `profiles.txt` beside the server | Local config file; relative paths resolve from the working directory |
| `PORT` | `3000` | Loopback web server port |
| `PYTHON` | `python3`; `python` on Windows | Python executable name or full path |
| `PROFILE_SWITCHER_STATE_DIR` | `.state` beside the server | Directory for the app's saved CLI profile selection |

For example, `PORT=8080 PYTHON=/usr/bin/python3 node server.mjs` changes the port and Python executable on macOS/Linux. Restart the server to change these settings.

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
