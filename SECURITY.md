# Security and trust boundary

Author: jperch1987

This app is a local AWS profile selector and Console link launcher for a trusted single-user desktop. It is not a centrally hosted or multiuser service. It has not received an independent security audit or production certification.

## Data and permissions

The server reads the file configured by the person starting it and returns profile names, role ARNs, source-profile names, regions, the file path, and derived command/link metadata. It reads the permitted file content before filtering fields. Prefer a metadata-only file and keep credentials in your existing AWS credential provider. The app does not intentionally persist or return credentials, authenticate to AWS, or assume roles through AWS APIs.

Account IDs, role names, profile names, and local file paths can reveal organizational information. The app saves the CLI selection's profile name and config path in `.state/active-profile.json`; it never writes the source config. Opening a console link sends its account and role to AWS and can leave the URL in browser history. Copying commands or links exposes their metadata to the clipboard and clipboard-history tools. Treat screenshots and copied content accordingly.

The server makes no outbound network requests. Local UI assets require no external fonts, scripts, or telemetry services. Browser navigation to AWS is a separate user action.

## Network boundary

The server listens on `127.0.0.1` over HTTP. Host/origin checks, browser request checks, a restrictive Content Security Policy, anti-framing headers, no-store responses, and a fixed AWS launch destination reduce browser-origin attacks. A per-process CSRF token protects the saved-selection endpoint against unrelated web pages. These controls are not user authentication: a local process or another local user able to connect to the port can read metadata, obtain the token, and change the app selection. Malicious software or privileged users on the device are outside this app's protection.

Keep the loopback binding. Do not expose the app with port forwarding, a public tunnel, a LAN listener, a reverse proxy, or shared hosting. Local HTTP assumes a trusted desktop; adding TLS alone would not provide missing user isolation or authorization. Stop the server when finished and use operating-system file permissions to protect profile and state files.

## Terminal and AWS boundaries

Generated commands are text for you to review and paste. They change only that terminal's AWS environment and clear existing credential/region overrides as described in the README. The app does not execute them. Use a trusted config: AWS tools may execute its configured credential provider or honor other settings that this app does not display. The saved app selection does not establish an authenticated AWS session.

For console links, AWS owns sign-in, MFA, authorization, session handling, and final confirmation. The app does not change IAM policies or select browser credentials from `source_profile`. Review the destination account and role on AWS before confirming. AWS uses the original browser sign-in identity to authorize a switch. [AWS console switching](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-console.html)

Follow your organization's AWS access process. AWS recommends federation with temporary credentials, least privilege, and MFA for human access. This app does not supply or replace those controls. [AWS IAM security practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)

## Distribution and maintenance

Distribute reviewed source through a repository or release channel clients trust. Keep real profile files, credentials, private screenshots, and local runtime artifacts out of commits and release archives. Review the exact release contents, run tests, and validate supported operating systems. Publish a release identifier and checksum through your trusted channel; clients should compare them before running downloaded code. No release or checksum is implied merely by these instructions.

Keep Node.js, Python, the browser, and the operating system patched. Use supported runtime releases. Review updates before distribution and recheck command quoting, destination validation, and authorization behavior when changing generation code. There are no third-party application packages, but that does not remove risks in runtimes, source changes, or the distribution channel.

## Reporting a problem

Use the private security-reporting channel offered by the repository or your distributor, when available. This project does not currently specify a security contact or response-time commitment. Do not post real credentials, tokens, private configuration, or unredacted customer metadata in public issues. Provide a minimal reproduction using placeholder profiles and include runtime versions. Revoke or rotate any exposed credentials through your organization's incident process.
