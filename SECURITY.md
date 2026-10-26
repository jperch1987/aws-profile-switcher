# Security and trust boundary

Author: jperch1987

This app is a credential-capable AWS role switcher for a trusted single-user desktop. It authenticates to AWS using local source credentials and a fresh MFA code. It is not a centrally hosted or multiuser service. It has not received an independent security audit or production certification.

## Data and permissions

The metadata reader reads the file configured by the person starting the server and returns allowed profile metadata and derived commands/links. It reads the file's bytes before filtering fields. Profile names, account IDs, role ARNs, source-profile names, MFA device identifiers, regions, and local paths can reveal organizational information. Prefer a metadata-only config and keep source credentials in your private AWS credentials file.

For each authentication, the Python helper reads the selected source IAM user's long-term keys from the AWS credentials file or source config section. It requires a fresh six-digit MFA code and calls AWS STS `AssumeRole` without using an assumed-role credential cache. It supports direct IAM-user source credentials, not SSO, external credential processes, web identity, temporary source credentials, or role chaining. AWS checks the source identity, MFA device/code, trust policy, optional external ID, and permissions. Requiring a code in this app does not replace an MFA condition in the role trust policy; enforce your organization's access requirements in AWS. [AWS STS MFA parameters](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html)

The app saves only the CLI selection's profile name and config path in `.state/active-profile.json`. It never edits the source config or credentials file, and does not intentionally persist MFA codes, temporary keys, or federation tokens to disk. Secrets still exist in process memory, pipes between the local processes, the CLI shell environment, and the browser's authentication request or navigation. They are not protected against local malware, privileged users, memory inspection, or terminal/browser recording.

For direct Console access, the helper sends temporary credentials to AWS's HTTPS federation endpoint and obtains a sign-in token. The resulting login URL grants Console access and must be treated as a bearer credential. It can appear in browser history, developer tools, or monitoring software. Never log it, copy it to a clipboard, include it in screenshots, or share it in an issue. The app does not put source access keys or temporary STS keys in the browser response. [AWS federation URL handling](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_enable-console-custom-url.html)

Authentication requires outbound HTTPS to AWS STS and, for direct Console access, the AWS federation endpoint. The browser then contacts AWS. Local UI assets use no external fonts, scripts, or telemetry services. Installing or updating Python dependencies separately contacts your configured package source.

## Network boundary

The server listens on `127.0.0.1` over HTTP. Host/origin checks, browser request checks, a restrictive Content Security Policy, anti-framing headers, no-store responses, and fixed AWS destinations reduce browser-origin attacks. A per-process CSRF token protects state-changing and authentication endpoints against unrelated web pages. These controls are not user authentication: a local process or another local user able to connect to the port can read metadata, obtain the token, and submit requests. A valid MFA code is still needed for this app's authentication flow, but this is not sufficient isolation for a shared machine.

Keep the loopback binding. Do not expose the app with port forwarding, a public tunnel, a LAN listener, a reverse proxy, or shared hosting. Local HTTP assumes a trusted desktop; adding TLS alone would not provide missing user isolation or authorization. Stop the server when finished and use operating-system file permissions to protect credentials, profile files, and the checkout. Allow only trusted browser extensions and tools on the device.

## Terminal and AWS boundaries

Generated commands are text for you to review and paste. They invoke the local `aws_session.py` helper, prompt for MFA in the terminal, and apply temporary credentials only to that shell. They clear previous exported AWS credentials and profile overrides before authentication, including on a failed attempt. AWS tools may still fall back to their normal defaults when exports are absent; do not treat a failed switch as a confirmed identity. Run `aws sts get-caller-identity` after a successful switch and do not pass `--profile` to subsequent AWS CLI commands when using the exported temporary credentials.

Use a trusted checkout and config. The generated commands execute local helper code and evaluate its generated environment assignments; modifying that code can compromise the terminal. Do not turn on shell tracing or record secret-bearing output while authenticating. Temporary credentials remain in the shell environment until replaced, cleared, the terminal closes, or AWS rejects them after expiration. There is no background refresh: run the helper again with a fresh MFA code. Saving a profile in the web UI alone does not authenticate a terminal.

Direct Console launch uses the configured local source identity and STS session. It removes the manual switch form, not AWS's MFA, policy, or authorization checks. Review the account and role displayed by AWS after login; the app cannot inspect the final AWS session. The manual fallback remains separate: it uses the original browser sign-in identity, requires confirmation on AWS, and does not use local keys or the app's MFA field. [AWS manual Console switching](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-console.html)

Follow your organization's AWS access process and use least privilege. For IAM Identity Center or other identity providers unsupported by this release, use your organization's approved access tools rather than substituting unapproved long-term keys.

## Distribution and maintenance

Distribute reviewed source through a repository or release channel clients trust. Keep real profile files, credentials, virtual environments, MFA codes, session tokens, private screenshots, and local runtime artifacts out of commits and release archives. Review the exact release contents, run tests, and validate supported operating systems and your own AWS policies. Automated tests use fixtures and mocked AWS responses; they do not establish that live MFA or federation works in your environment. Publish a release identifier and checksum through your trusted channel; clients should compare them before running downloaded code. No release or checksum is implied merely by these instructions.

Keep Node.js, Python, the browser, and the operating system patched. Use supported runtime releases. The Python authentication helper depends on boto3 and its dependencies from `requirements.txt`; install them into a dedicated virtual environment and review dependency updates. Node.js uses its standard library. Review updates before distribution and recheck command quoting, secret handling, destination validation, and authorization behavior when authentication or command generation changes.

## Reporting a problem

Use the private security-reporting channel offered by the repository or your distributor, when available. This project does not currently specify a security contact or response-time commitment. Do not post real credentials, tokens, private configuration, or unredacted customer metadata in public issues. Provide a minimal reproduction using placeholder profiles and include runtime versions. Revoke or rotate any exposed credentials through your organization's incident process.
