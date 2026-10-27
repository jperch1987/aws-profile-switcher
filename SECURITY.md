# Security and trust boundary

Author: jperch1987

Authentication workers emit only fixed progress stages and safe errors to the local server. Timeout messages distinguish configuration, Python SDK loading, source credential loading, the STS request, and legacy federation. The diagnostic output contains no MFA codes, credential values, profile paths, or raw AWS responses. Request timeouts do not extend an authenticator code's validity.

This app is a credential-capable AWS role switcher for a trusted single-user desktop. CLI authentication uses local IAM-user keys and a fresh MFA code. Automatic Console switching controls a separate Chromium browser and uses its signed-in AWS identity. It is not a centrally hosted or multiuser service, and it has not received an independent security audit or production certification.

## Data and permissions

The metadata reader reads the configured file before filtering fields and returns allowed profile metadata and derived links. Profile names, account IDs, role ARNs, source-profile names, MFA device identifiers, regions, and local paths can reveal organizational information. Prefer a metadata-only config and keep source credentials in your private AWS credentials file. The app never edits either source file.

For each **Get CLI credentials** request, the Python helper reads the selected source IAM user's long-term keys from the AWS credentials file or source config section. It requires a fresh six-digit MFA code and calls AWS STS `AssumeRole` without reusing an assumed-role credential cache. This flow does not support SSO, external credential processes, web identity, temporary source credentials, or role chaining. AWS checks the source identity, MFA, trust policy, optional external ID, and permissions. Enforce your organization's MFA requirements in AWS policies; an app-side code requirement does not replace them. [AWS STS MFA parameters](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html)

The `/api/cli` response intentionally contains temporary STS keys and a session token inside shell command strings over loopback HTTP. The browser holds them in memory, displays them, and copies them only when requested. Source keys are never returned to the browser. Each request creates a new one-hour session; the resulting credentials can be reused until expiration without another MFA prompt. There is no background refresh.

The app does not intentionally persist CLI MFA codes or temporary keys to disk or browser storage. It clears the displayed exports and its references on profile changes, new authentication, refresh, failure, expiry, page hide, or **Clear credentials**. This is not guaranteed memory erasure or AWS session revocation. It cannot clear clipboard history, terminal history, or credentials already exported into a shell. Secrets can also exist in local process memory and pipes, browser request/response inspection, page content, and recording tools.

The CLI flow does not save selections. Legacy selection endpoints use only profile/config metadata in `.state/active-profile.json` and never restore CLI credentials. **The state directory as a whole is sensitive:** it now also contains the persistent managed-browser profile described below.

## Managed browser

**Open AWS Console** launches a dedicated visible Chromium browser through Playwright. The app does not connect to your ordinary browser profile, copy its cookies, install an extension, or expose a TCP debugging port. You enter AWS sign-in details and any requested MFA directly in the managed browser. The controller does not fill login/password/MFA fields or pass local IAM source keys or app-entered MFA codes into that browser.

The controller visits the AWS Switch Role form, checks the target account and full role name, and submits the switch. Browser operations are local; the browser itself contacts AWS over HTTPS. Automation depends on AWS's page structure and may require updates. Form submission is not independent verification of the final AWS identity: review the account and role displayed by AWS before doing work. Cancellation closes the pending switch tab but cannot undo a switch already submitted to AWS. Shutting down the server closes the managed browser.

Chromium persists **cookies, session data, history, and other browser-profile data** in `browser/` under `PROFILE_SWITCHER_STATE_DIR` (default `.state/browser`). Those files may retain access to AWS sessions across app restarts. Closing the browser, canceling a switch, or stopping the server does not erase them or revoke AWS access. Sign out through AWS when appropriate, protect the directory with operating-system permissions, and exclude it from repositories, release archives, shared backups, and support attachments. Use the dedicated browser for the intended AWS workflow; do not save passwords or unrelated sensitive data there.

AWS role switching uses the original browser sign-in identity, including when moving between roles. AWS controls MFA challenges; the app does not guarantee a fresh challenge for every Console switch. The Console form cannot switch from root or supply `ExternalId`, and limits the full role path/name to 64 characters. The manual switch-page link uses the same form in your ordinary browser and requires you to click the confirmation. [AWS Console role switching](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-console.html)

The older `/api/console` federation endpoint remains available for compatibility but is not used by the primary Console button. It authenticates through STS and exchanges temporary credentials for an AWS sign-in URL. Treat that URL as a bearer credential: never log, share, screenshot, or copy it into a support report. The app does not intentionally persist its MFA codes, temporary keys, or federation tokens. Browser history and inspection tools can still retain a login URL. [AWS federation URL handling](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_enable-console-custom-url.html)

## Network boundary

The server listens on `127.0.0.1` over HTTP. Host/origin checks, browser request checks, a restrictive Content Security Policy, anti-framing headers, no-store responses, and a per-process CSRF token reduce attacks from unrelated web pages. These controls are **not user authentication**: another local process or user able to reach the port can read metadata, obtain the token, and submit requests. CLI authentication still needs a valid MFA code, but managed Console operations can use an already signed-in browser session without a new app-side MFA check. This is not sufficient isolation for a shared machine.

Keep the loopback binding. Do not expose the app with port forwarding, public tunnels, LAN listeners, reverse proxies, or shared hosting. TLS alone would not add missing user isolation or authorization. Stop the server when finished. Use operating-system permissions to protect the credentials, config, checkout, and managed-browser profile. These controls do not protect against local malware, privileged users, memory inspection, browser extensions, or recording tools.

CLI authentication needs outbound HTTPS to AWS STS. The legacy federation endpoint also needs AWS's sign-in endpoint. The Python helper uses fixed AWS destinations, certificate verification, and redirect restrictions; it does not honor custom endpoint or proxy overrides. Networks requiring a proxy need an approved network configuration. The managed browser needs access to AWS sign-in and Console pages. Local UI assets use no external fonts, scripts, or telemetry. Dependency and Chromium installation separately contact package/download sources.

## Terminal boundaries

The five generated environment assignments contain temporary credentials and region settings. They apply only to the terminal where you paste them; they neither invoke Python nor clear older environment settings. Use a fresh terminal without existing AWS overrides, especially `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, and legacy `AWS_SECURITY_TOKEN`, or follow the README's cleanup instructions. Run `aws sts get-caller-identity` after applying credentials, and omit `--profile` on later commands using those exports.

Use a trusted checkout and config, and review what you paste. Disable shell tracing, avoid recording, and use a history policy that does not save pasted secrets. Clipboard history or synchronization can retain copied commands. AWS rejects expired credentials, but their text may remain in terminal history. An app authentication failure leaves credentials already pasted into a terminal unchanged.

Console switching and terminal credentials are independent. The optional terminal-only `aws_session.py` helper still prompts for MFA in the terminal; the five export lines do not invoke it. Follow your organization's access process and use least privilege.

## Distribution and maintenance

Distribute reviewed source through a repository or release channel clients trust. Keep real profile files, credentials, `.state/` (especially browser cookies), virtual environments, `node_modules/`, browser binaries, MFA codes, session tokens, private screenshots, and other runtime artifacts out of commits and release archives. Clients install dependencies and browser binaries locally; downloading the repository must not include someone else's authenticated browser profile.

Keep Node.js, Python, Playwright, Chromium, and the operating system patched. Install the pinned Node.js dependencies with `npm ci` and Chromium with `npx playwright install chromium`; use Playwright's documented dependency setup on supported Linux distributions. Install `requirements.txt` in a dedicated Python virtual environment. Review dependency and browser updates, then retest destination validation, form checks, cancellation, secret handling, and authorization behavior.

Automated tests use fixtures and mocked AWS/browser responses. They do not establish that live AWS sign-in, MFA, role policies, or the current AWS form work in your environment. Validate the supported operating systems, including WSL's GUI setup, before client distribution. Publish release identifiers and checksums through your trusted channel when distributing releases; these instructions do not themselves imply a release or checksum.

## Reporting a problem

Use the private security-reporting channel offered by the repository or your distributor, when available. This project does not currently specify a security contact or response-time commitment. Do not post credentials, tokens, cookies, browser-profile files, private configuration, or unredacted customer metadata in public issues. Provide a minimal reproduction with placeholder profiles and runtime versions. Revoke or rotate any exposed credentials through your organization's incident process.
