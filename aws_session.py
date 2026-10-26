#!/usr/bin/env python3
# Author: jperch1987
"""Create a fresh MFA-authenticated role session without saving credentials."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import getpass
import json
import logging
import os
from pathlib import Path
import re
import secrets
import shlex
import sys
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import warnings

from profiles import ProfileConfigError, read_profiles


FEDERATION_URL = "https://signin.aws.amazon.com/federation"
CONSOLE_URL = "https://console.aws.amazon.com/console/home"
MAX_WORKER_BYTES = 8192
MAX_FEDERATION_BYTES = 65536
SESSION_SECONDS = 3600
ROLE_PATTERN = re.compile(r"arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}\Z")
REGION_PATTERN = re.compile(
    r"(?:af|ap|ca|eu|il|me|mx|sa|us)-"
    r"(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*\Z"
)
MFA_SERIAL_PATTERN = re.compile(r"[A-Za-z0-9_+=/:,.@-]{9,256}\Z")
EXTERNAL_ID_PATTERN = re.compile(r"[A-Za-z0-9_+=,.@:/-]{2,1224}\Z")
CONFLICTING_ENV = (
    "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SECURITY_TOKEN", "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME", "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
)


class SessionError(ValueError):
    """An actionable diagnostic safe to display without AWS response details."""


def _selected_profile(config_file: str | Path, profile_name: str) -> dict[str, str]:
    result = read_profiles(config_file)
    available = {profile["profile"]: profile for profile in result["profiles"]}
    selected = available.get(profile_name)
    if selected is None:
        raise SessionError("Profile was not found. Refresh the list and select it again.")
    if not ROLE_PATTERN.fullmatch(selected.get("role_arn", "")):
        raise SessionError("Set a valid commercial AWS IAM role_arn on this profile.")
    source_name = selected.get("source_profile", "")
    if not source_name or source_name == profile_name:
        raise SessionError("Set source_profile to a separate IAM-user credentials profile.")
    source = available.get(source_name, {})
    if source.get("role_arn"):
        raise SessionError("MFA switching requires a direct IAM-user source_profile, not a role chain.")
    serial = selected.get("mfa_serial") or source.get("mfa_serial", "")
    if not MFA_SERIAL_PATTERN.fullmatch(serial):
        raise SessionError("Set mfa_serial to your MFA device ARN or hardware serial on this profile or its source profile.")
    if serial.startswith("arn:") and not re.fullmatch(r"arn:aws:iam::[0-9]{12}:mfa/[A-Za-z0-9_+=/:,.@-]+", serial):
        raise SessionError("The MFA device ARN must be a commercial AWS IAM MFA ARN.")
    region = selected.get("region") or source.get("region") or "us-east-1"
    if not REGION_PATTERN.fullmatch(region):
        raise SessionError("Set a supported commercial AWS region, such as us-east-1, on the profile.")
    external_id = selected.get("external_id", "")
    if external_id and not EXTERNAL_ID_PATTERN.fullmatch(external_id):
        raise SessionError("The profile external_id has an invalid length or format.")
    return {
        **selected, "file": result["file"], "source_profile": source_name,
        "mfa_serial": serial, "region": region, "external_id": external_id,
    }


@contextmanager
def _isolated_aws_environment(config_file: str):
    """Only use in the short-lived, single-request helper process."""
    previous = {key: value for key, value in os.environ.items() if key.startswith("AWS_") or key == "BOTO_CONFIG"}
    previous_logging = logging.root.manager.disable
    try:
        for key in previous:
            os.environ.pop(key, None)
        os.environ.update({
            "AWS_CONFIG_FILE": config_file,
            "AWS_SHARED_CREDENTIALS_FILE": str(Path.home() / ".aws" / "credentials"),
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true",
            "BOTO_CONFIG": os.devnull,
        })
        # Debug-level SDK logs can contain signed request bodies, including MFA.
        logging.disable(logging.CRITICAL)
        yield
    finally:
        for key in list(os.environ):
            if key.startswith("AWS_") or key == "BOTO_CONFIG":
                os.environ.pop(key, None)
        os.environ.update(previous)
        logging.disable(previous_logging)


def _sdk():
    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        raise SessionError("Install the Python dependencies in the app's virtual environment: python -m pip install -r requirements.txt.") from None
    return boto3, Config


def _validate_source_config(source: dict) -> None:
    forbidden = {
        "role_arn", "source_profile", "credential_source", "credential_process",
        "web_identity_token_file", "login_session",
    }
    if any(value and (key in forbidden or key.startswith("sso_")) for key, value in source.items()):
        raise SessionError("Use a source_profile with direct IAM-user access keys. Role chains, SSO, web identity, and credential processes are not supported by this MFA-code flow.")
    if source.get("aws_session_token") or source.get("aws_security_token"):
        raise SessionError("Use long-term IAM-user keys for source_profile; temporary source sessions are not supported by this MFA-code flow.")
    if not source.get("aws_access_key_id") or not source.get("aws_secret_access_key"):
        raise SessionError("Configure the source_profile IAM-user keys in your local ~/.aws/credentials file before switching.")


def _aws_failure(error: Exception) -> SessionError:
    # AWS messages can echo submitted values. Only inspect the fixed error code.
    response = getattr(error, "response", None)
    code = response.get("Error", {}).get("Code") if isinstance(response, dict) and isinstance(response.get("Error"), dict) else ""
    if code in {"AccessDenied", "AccessDeniedException"}:
        return SessionError("AWS denied the role switch. Check the MFA code and device, source-user permission, role trust policy, and external ID if required.")
    if code in {"InvalidClientTokenId", "SignatureDoesNotMatch", "ExpiredToken", "ExpiredTokenException", "UnrecognizedClientException"}:
        return SessionError("AWS rejected the source credentials. Check the IAM-user keys for source_profile.")
    if code in {"Throttling", "ThrottlingException", "RequestLimitExceeded"}:
        return SessionError("AWS temporarily limited requests. Wait briefly and enter a fresh MFA code.")
    return SessionError("Unable to create an AWS role session. Check the local source credentials, network access, and profile configuration, then enter a fresh MFA code.")


def _credentials(response: dict, now: datetime | None = None) -> dict:
    current = now or datetime.now(timezone.utc)
    value = response.get("Credentials") if isinstance(response, dict) else None
    if not isinstance(value, dict):
        raise SessionError("AWS returned an invalid role session. No credentials were applied.")
    for key in ("AccessKeyId", "SecretAccessKey", "SessionToken"):
        item = value.get(key)
        if not isinstance(item, str) or not 1 <= len(item) <= 16384 or any(ord(char) < 33 or ord(char) > 126 for char in item):
            raise SessionError("AWS returned an invalid role session. No credentials were applied.")
    expiration = value.get("Expiration")
    if not isinstance(expiration, datetime) or expiration.tzinfo is None:
        raise SessionError("AWS returned an invalid session expiration. No credentials were applied.")
    if expiration <= current or expiration > current + timedelta(seconds=SESSION_SECONDS + 300):
        raise SessionError("AWS returned an expired or unexpectedly long session. No credentials were applied.")
    return {key: value[key] for key in ("AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration")}


def assume_profile(config_file: str | Path, profile_name: str, mfa_code: str) -> dict:
    """Make one fresh AssumeRole call; no MFA or credential cache is used."""
    if not isinstance(mfa_code, str) or not re.fullmatch(r"[0-9]{6}", mfa_code):
        raise SessionError("Enter the six-digit code from your MFA device.")
    selected = _selected_profile(config_file, profile_name)
    boto3, config_class = _sdk()
    try:
        with _isolated_aws_environment(selected["file"]):
            session = boto3.Session(profile_name=selected["source_profile"], region_name=selected["region"])
            # Inspect the merged local profile before credential providers can run.
            # This also supports a source profile defined only in credentials.
            source = session._session.get_scoped_config()
            _validate_source_config(source)
            source_credentials = session.get_credentials()
            if source_credentials is None or source_credentials.method not in {"shared-credentials-file", "config-file"}:
                raise SessionError("The source profile must load IAM-user keys directly from the local credentials or config file.")
            frozen = source_credentials.get_frozen_credentials()
            if frozen.token:
                raise SessionError("Use long-term IAM-user keys for source_profile; temporary source sessions are not supported by this MFA-code flow.")
            client = session.client(
                "sts", region_name=selected["region"],
                endpoint_url=f"https://sts.{selected['region']}.amazonaws.com",
                verify=True,
                aws_access_key_id=frozen.access_key,
                aws_secret_access_key=frozen.secret_key,
                aws_session_token=None,
                config=config_class(
                    signature_version="v4", connect_timeout=10, read_timeout=20,
                    retries={"total_max_attempts": 1}, proxies={},
                    ignore_configured_endpoint_urls=True,
                ),
            )
            parameters = {
                "RoleArn": selected["role_arn"],
                "RoleSessionName": f"profile-switcher-{secrets.token_hex(8)}",
                "DurationSeconds": SESSION_SECONDS,
                "SerialNumber": selected["mfa_serial"],
                "TokenCode": mfa_code,
            }
            if selected["external_id"]:
                parameters["ExternalId"] = selected["external_id"]
            try:
                response = client.assume_role(**parameters)
            finally:
                client.close()
    except SessionError:
        raise
    except Exception as error:
        raise _aws_failure(error) from None
    return {
        "credentials": _credentials(response), "region": selected["region"],
        "roleArn": selected["role_arn"],
    }


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise SessionError("AWS sign-in returned an unexpected redirect. No console session was opened.")


def _signin_token(credentials: dict) -> str:
    payload = urlencode({
        "Action": "getSigninToken",
        "Session": json.dumps({
            "sessionId": credentials["AccessKeyId"],
            "sessionKey": credentials["SecretAccessKey"],
            "sessionToken": credentials["SessionToken"],
        }, separators=(",", ":")),
    }).encode("ascii")
    request = Request(
        FEDERATION_URL, data=payload, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
    )
    try:
        with build_opener(ProxyHandler({}), _NoRedirects()).open(request, timeout=20) as response:
            if response.status != 200 or response.geturl() != FEDERATION_URL:
                raise SessionError("AWS sign-in returned an unexpected response. Try again with a fresh MFA code.")
            raw = response.read(MAX_FEDERATION_BYTES + 1)
        if len(raw) > MAX_FEDERATION_BYTES:
            raise ValueError("response too large")
        token = json.loads(raw).get("SigninToken")
        if not isinstance(token, str) or not 1 <= len(token) <= 16384 or any(ord(char) < 33 or ord(char) > 126 for char in token):
            raise ValueError("invalid token")
        return token
    except SessionError:
        raise
    except Exception:
        raise SessionError("Unable to obtain the AWS Console sign-in token. Check network access and try again with a fresh MFA code.") from None


def console_session(config_file: str | Path, profile_name: str, mfa_code: str) -> dict[str, str]:
    result = assume_profile(config_file, profile_name, mfa_code)
    token = _signin_token(result["credentials"])
    return {
        "url": FEDERATION_URL + "?" + urlencode({
            "Action": "login", "Destination": CONSOLE_URL + "?" + urlencode({"region": result["region"]}),
            "SigninToken": token,
        }),
        "expiration": result["credentials"]["Expiration"].astimezone(timezone.utc).isoformat(),
        "roleArn": result["roleArn"],
    }


def shell_exports(result: dict, shell: str) -> str:
    credentials = result["credentials"]
    values = {
        "AWS_ACCESS_KEY_ID": credentials["AccessKeyId"],
        "AWS_SECRET_ACCESS_KEY": credentials["SecretAccessKey"],
        "AWS_SESSION_TOKEN": credentials["SessionToken"],
        "AWS_REGION": result["region"], "AWS_DEFAULT_REGION": result["region"],
    }
    if shell == "posix":
        lines = ["unset " + " ".join(CONFLICTING_ENV)]
        lines.extend(f"export {key}={shlex.quote(value)}" for key, value in values.items())
    elif shell == "powershell":
        lines = [f"Remove-Item Env:{key} -ErrorAction SilentlyContinue" for key in CONFLICTING_ENV]
        lines.extend("$env:" + key + " = '" + value.replace("'", "''") + "'" for key, value in values.items())
    else:
        raise SessionError("Choose the posix or powershell shell format.")
    return "\n".join(lines)


def _prompt_mfa() -> str:
    # getpass can read /dev/tty during shell command substitution. If no secure
    # terminal exists, turn its echoing fallback warning into a hard failure.
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            return getpass.getpass("Enter a fresh six-digit MFA code: ")
    except (getpass.GetPassWarning, EOFError, OSError):
        raise SessionError("MFA entry needs an interactive terminal that can hide input. Run the switch command in your terminal.") from None


def _worker_request() -> tuple[str, str]:
    raw = sys.stdin.buffer.read(MAX_WORKER_BYTES + 1)
    if len(raw) > MAX_WORKER_BYTES:
        raise SessionError("The console sign-in request is too large.")
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeError):
        raise SessionError("Invalid console sign-in request.") from None
    if not isinstance(payload, dict) or set(payload) != {"profile", "mfaCode"}:
        raise SessionError("Invalid console sign-in request.")
    profile_name, mfa_code = payload["profile"], payload["mfaCode"]
    if not isinstance(profile_name, str) or not 1 <= len(profile_name) <= 2048 or not isinstance(mfa_code, str):
        raise SessionError("Invalid console sign-in request.")
    return profile_name, mfa_code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, help="Local AWS config file")
    parser.add_argument("--profile", help="Role profile for an interactive CLI session")
    parser.add_argument("--shell", choices=("posix", "powershell"), default="posix")
    parser.add_argument("--console-worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        if args.console_worker:
            profile_name, mfa_code = _worker_request()
            output = json.dumps(console_session(args.file, profile_name, mfa_code), ensure_ascii=True)
        else:
            if not args.profile:
                raise SessionError("Choose a profile with --profile.")
            # Catch configuration mistakes before prompting for a one-time code.
            _selected_profile(args.file, args.profile)
            result = assume_profile(args.file, args.profile, _prompt_mfa())
            output = shell_exports(result, args.shell)
            expiration = result["credentials"]["Expiration"].astimezone(timezone.utc).isoformat()
            print(
                f"Authenticated as {result['roleArn']}. Session expires at {expiration}. "
                "Repeat this command with a fresh MFA code to renew.",
                file=sys.stderr,
            )
        print(output)
        return 0
    except (SessionError, ProfileConfigError) as error:
        message = str(error)
    except KeyboardInterrupt:
        message = "MFA authentication cancelled. No credentials were applied."
    except Exception:
        message = "Unable to complete the AWS sign-in. No credentials were applied."
    print(json.dumps({"error": message}, ensure_ascii=True), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
