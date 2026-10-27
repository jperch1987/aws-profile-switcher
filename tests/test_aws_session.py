# Author: jperch1987
"""MFA authentication and federation tests; no real AWS calls or credentials."""

from contextlib import ExitStack, redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
import getpass
import io
import json
import logging
import os
from pathlib import Path
import shlex
import ssl
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
import warnings

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import aws_session


ROLE = "arn:aws:iam::111111111111:role/team/Developer"
MFA = "arn:aws:iam::222222222222:mfa/test-user"
CONFIG = "/local/example-config"
ASSUME_STAGES = ["configuration", "python-sdk", "source-credentials", "python-sdk", "assume-role"]


def assumed_result(result=None, failure=None):
    """Simulate an already covered AssumeRole flow in downstream worker tests."""
    def assume(*args, progress=None):
        if progress:
            for stage in ASSUME_STAGES:
                progress(stage)
        if failure:
            raise failure
        return result
    return assume


def metadata(**changes):
    selected = {
        "profile": "dev", "role_arn": ROLE, "source_profile": "base",
        "region": "ap-southeast-1", "mfa_serial": MFA, "external_id": "",
    }
    selected.update(changes)
    return {"file": CONFIG, "profiles": [selected]}


def credentials(**changes):
    result = {
        "AccessKeyId": "TEST_TEMPORARY_KEY",
        "SecretAccessKey": "TEST_SECRET+/=",
        "SessionToken": "TEST_TOKEN+/=",
        "Expiration": datetime.now(timezone.utc) + timedelta(minutes=59),
    }
    result.update(changes)
    return result


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.profile_reader = self.stack.enter_context(patch.object(aws_session, "read_profiles", return_value=metadata()))
        self.client = Mock()
        self.client.assume_role.side_effect = lambda **kwargs: {"Credentials": credentials()}
        self.source = {
            "aws_access_key_id": "TEST_SOURCE_KEY", "aws_secret_access_key": "TEST_SOURCE_SECRET"
        }
        self.session = Mock()
        self.session._session.get_scoped_config.return_value = self.source
        self.session.get_credentials.return_value = SimpleNamespace(
            method="shared-credentials-file",
            get_frozen_credentials=lambda: SimpleNamespace(access_key="TEST_SOURCE_KEY", secret_key="TEST_SOURCE_SECRET", token=None),
        )
        self.session.client.return_value = self.client
        self.sdk = SimpleNamespace(Session=Mock(return_value=self.session))
        self.config = Mock(side_effect=lambda **kwargs: kwargs)
        self.stack.enter_context(patch.object(aws_session, "_sdk", return_value=(self.sdk, self.config)))

    def test_each_switch_makes_a_fresh_mfa_assume_role_call(self):
        first = aws_session.assume_profile(CONFIG, "dev", "123456")
        second = aws_session.assume_profile(CONFIG, "dev", "654321")
        self.assertEqual(self.client.assume_role.call_count, 2)
        self.assertEqual(self.sdk.Session.call_count, 2)
        calls = [call.kwargs for call in self.client.assume_role.call_args_list]
        self.assertEqual([call["TokenCode"] for call in calls], ["123456", "654321"])
        self.assertNotEqual(calls[0]["RoleSessionName"], calls[1]["RoleSessionName"])
        for call in calls:
            self.assertEqual(call["SerialNumber"], MFA)
            self.assertEqual(call["RoleArn"], ROLE)
            self.assertEqual(call["DurationSeconds"], 3600)
        self.assertEqual(first["region"], "ap-southeast-1")
        self.assertEqual(second["roleArn"], ROLE)
        self.assertEqual(self.client.close.call_count, 2)

    def test_cli_worker_uses_fresh_mfa_sessions_and_preserves_leading_zeroes(self):
        outputs = []
        self.client.assume_role.side_effect = [
            {"Credentials": credentials(AccessKeyId="TEST_FIRST_SESSION_KEY")},
            {"Credentials": credentials(AccessKeyId="TEST_SECOND_SESSION_KEY")},
        ]
        with patch.object(aws_session, "_prompt_mfa") as prompt, patch.object(aws_session, "_signin_token") as federation:
            for code in ("012345", "000123"):
                output, errors = io.StringIO(), io.StringIO()
                payload = json.dumps({"profile": "dev", "mfaCode": code}).encode("utf-8")
                with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), redirect_stdout(output), redirect_stderr(errors):
                    self.assertEqual(aws_session.main(["--file", CONFIG, "--cli-worker"]), 0)
                self.assertEqual([json.loads(line) for line in errors.getvalue().splitlines()], [{"stage": stage} for stage in ASSUME_STAGES])
                self.assertNotIn("TEST_SOURCE", errors.getvalue())
                self.assertNotIn(code, errors.getvalue())
                result = json.loads(output.getvalue())
                self.assertEqual(set(result), {"credentials", "region", "expiration", "roleArn"})
                self.assertEqual(set(result["credentials"]), {"AccessKeyId", "SecretAccessKey", "SessionToken"})
                self.assertNotIn("TEST_SOURCE", output.getvalue())
                self.assertNotIn(code, output.getvalue())
                outputs.append(result)
            prompt.assert_not_called()
            federation.assert_not_called()
        self.assertEqual(self.sdk.Session.call_count, 2)
        self.assertEqual([call.kwargs["TokenCode"] for call in self.client.assume_role.call_args_list], ["012345", "000123"])
        self.assertNotEqual(outputs[0]["credentials"]["AccessKeyId"], outputs[1]["credentials"]["AccessKeyId"])
        self.assertEqual(outputs[0]["region"], "ap-southeast-1")
        self.assertEqual(outputs[0]["roleArn"], ROLE)
        self.assertGreater(datetime.fromisoformat(outputs[0]["expiration"]), datetime.now(timezone.utc))

    def test_worker_progress_identifies_local_loading_and_network_failures_before_they_start(self):
        cases = (
            (aws_session, "_selected_profile", ASSUME_STAGES[:1]),
            (aws_session, "_sdk", ASSUME_STAGES[:2]),
            (self.session, "get_credentials", ASSUME_STAGES[:3]),
            (self.session, "client", ASSUME_STAGES[:4]),
            (self.client, "assume_role", ASSUME_STAGES),
        )
        for mode in ("--cli-worker", "--console-worker"):
            for target, method, expected in cases:
                with self.subTest(mode=mode, method=method):
                    output, errors = io.StringIO(), io.StringIO()
                    payload = b'{"profile":"dev","mfaCode":"012345"}'
                    with patch.object(target, method, side_effect=RuntimeError("PRIVATE_SDK_SOURCE_SECRET_012345")), patch.object(aws_session, "_signin_token") as federation, patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), redirect_stdout(output), redirect_stderr(errors):
                        self.assertEqual(aws_session.main(["--file", CONFIG, mode]), 1)
                    federation.assert_not_called()
                    self.assertEqual(output.getvalue(), "")
                    lines = [json.loads(line) for line in errors.getvalue().splitlines()]
                    self.assertEqual(lines[:-1], [{"stage": stage} for stage in expected])
                    self.assertEqual(set(lines[-1]), {"error"})
                    for secret in ("PRIVATE", "012345", "TEST_SOURCE", CONFIG, "dev", "base"):
                        self.assertNotIn(secret, errors.getvalue())

    def test_console_worker_adds_federation_only_after_successful_role_authentication(self):
        output, errors = io.StringIO(), io.StringIO()
        payload = b'{"profile":"dev","mfaCode":"012345"}'
        with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), patch.object(aws_session, "_signin_token", return_value="TEST_SIGNIN_TOKEN"), redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(aws_session.main(["--file", CONFIG, "--console-worker"]), 0)
        self.assertEqual([json.loads(line) for line in errors.getvalue().splitlines()], [{"stage": stage} for stage in ASSUME_STAGES + ["federation"]])
        self.assertEqual(set(json.loads(output.getvalue())), {"url", "expiration", "roleArn"})
        self.assertNotIn("TEST_SOURCE", output.getvalue())
        self.assertNotIn("TEST_SIGNIN_TOKEN", errors.getvalue())

    def test_invalid_otp_is_rejected_before_reading_config_or_using_sdk(self):
        for code in ("", "12345", "1234567", " 123456", "123456\n", "１２３４５６", "abcdef", 123456, None):
            with self.subTest(code=code), self.assertRaisesRegex(aws_session.SessionError, "six-digit"):
                aws_session.assume_profile(CONFIG, "dev", code)
        self.profile_reader.assert_not_called()
        self.sdk.Session.assert_not_called()

    def test_source_config_fallback_for_mfa_region_and_external_id(self):
        data = metadata(mfa_serial="", region="", external_id="client-id")
        data["profiles"].append({"profile": "base", "mfa_serial": MFA, "region": "eu-west-1"})
        self.profile_reader.return_value = data
        result = aws_session.assume_profile(CONFIG, "dev", "123456")
        self.assertEqual(result["region"], "eu-west-1")
        self.assertEqual(self.client.assume_role.call_args.kwargs["ExternalId"], "client-id")
        self.assertEqual(self.client.assume_role.call_args.kwargs["SerialNumber"], MFA)

    def test_source_defined_only_in_credentials_file_is_supported(self):
        aws_session.assume_profile(CONFIG, "dev", "123456")
        self.sdk.Session.assert_called_once_with(profile_name="base", region_name="ap-southeast-1")

    def test_environment_credentials_and_endpoint_overrides_are_isolated_and_restored(self):
        original = {
            "AWS_ACCESS_KEY_ID": "ENV_SECRET", "AWS_SECRET_ACCESS_KEY": "ENV_SECRET_2",
            "AWS_SESSION_TOKEN": "ENV_TOKEN", "AWS_PROFILE": "wrong-profile",
            "AWS_ENDPOINT_URL_STS": "https://attacker.example", "AWS_CA_BUNDLE": "/attacker-ca",
            "AWS_SHARED_CREDENTIALS_FILE": "/wrong/credentials", "BOTO_CONFIG": "/wrong/boto",
        }
        def create_session(**kwargs):
            self.assertNotIn("AWS_ACCESS_KEY_ID", os.environ)
            self.assertNotIn("AWS_PROFILE", os.environ)
            self.assertNotIn("AWS_ENDPOINT_URL_STS", os.environ)
            self.assertNotIn("AWS_CA_BUNDLE", os.environ)
            self.assertEqual(os.environ["AWS_CONFIG_FILE"], CONFIG)
            self.assertEqual(os.environ["AWS_SHARED_CREDENTIALS_FILE"], str(Path.home() / ".aws" / "credentials"))
            self.assertEqual(os.environ["AWS_EC2_METADATA_DISABLED"], "true")
            self.assertEqual(logging.root.manager.disable, logging.CRITICAL)
            return self.session
        self.sdk.Session.side_effect = create_session
        with patch.dict(os.environ, original):
            before_logging = logging.root.manager.disable
            aws_session.assume_profile(CONFIG, "dev", "123456")
            for key, value in original.items():
                self.assertEqual(os.environ[key], value)
            self.assertEqual(logging.root.manager.disable, before_logging)
        options = self.session.client.call_args.kwargs
        self.assertEqual(options["endpoint_url"], "https://sts.ap-southeast-1.amazonaws.com")
        self.assertIs(options["verify"], True)
        self.assertEqual(options["config"]["proxies"], {})
        self.assertEqual(options["config"]["retries"], {"total_max_attempts": 1})
        self.assertIs(options["config"]["ignore_configured_endpoint_urls"], True)

    def test_unsupported_source_providers_are_rejected_before_credentials_are_loaded(self):
        for key in ("role_arn", "source_profile", "credential_source", "credential_process", "web_identity_token_file", "sso_session", "sso_start_url", "login_session", "aws_session_token"):
            with self.subTest(key=key):
                self.session.get_credentials.reset_mock()
                self.session._session.get_scoped_config.return_value = {**self.source, key: "PRIVATE_VALUE"}
                with self.assertRaises(aws_session.SessionError) as error:
                    aws_session.assume_profile(CONFIG, "dev", "123456")
                self.assertNotIn("PRIVATE_VALUE", str(error.exception))
                self.session.get_credentials.assert_not_called()
        self.client.assume_role.assert_not_called()

    def test_missing_keys_and_unexpected_provider_or_source_token_are_rejected(self):
        self.session._session.get_scoped_config.return_value = {}
        with self.assertRaisesRegex(aws_session.SessionError, "credentials"):
            aws_session.assume_profile(CONFIG, "dev", "123456")
        self.session._session.get_scoped_config.return_value = self.source
        self.session.get_credentials.return_value = SimpleNamespace(method="env")
        with self.assertRaisesRegex(aws_session.SessionError, "directly"):
            aws_session.assume_profile(CONFIG, "dev", "123456")
        self.session.get_credentials.return_value = SimpleNamespace(
            method="shared-credentials-file", get_frozen_credentials=lambda: SimpleNamespace(token="PRIVATE_TOKEN")
        )
        with self.assertRaisesRegex(aws_session.SessionError, "long-term"):
            aws_session.assume_profile(CONFIG, "dev", "123456")
        self.client.assume_role.assert_not_called()

    def test_metadata_rejects_bad_or_cross_partition_endpoints_and_missing_mfa(self):
        for values in (
            {"role_arn": "arn:aws-cn:iam::111111111111:role/Developer"},
            {"source_profile": ""}, {"source_profile": "dev"}, {"mfa_serial": ""},
            {"mfa_serial": "arn:aws-cn:iam::222222222222:mfa/test-user"},
            {"region": "us-east-1.attacker.example/path"}, {"region": "us-gov-west-1"},
            {"external_id": "bad whitespace"},
        ):
            with self.subTest(values=values):
                self.profile_reader.return_value = metadata(**values)
                with self.assertRaises(aws_session.SessionError):
                    aws_session.assume_profile(CONFIG, "dev", "123456")
        self.sdk.Session.assert_not_called()

    def test_aws_error_response_and_raw_exception_are_never_echoed(self):
        for code in ("AccessDenied", "InvalidClientTokenId", "Throttling", "UNKNOWN_PRIVATE_CODE"):
            error = RuntimeError("PRIVATE_SOURCE_KEY and MFA123456")
            error.response = {"Error": {"Code": code, "Message": "PRIVATE_SESSION_TOKEN"}}
            self.client.assume_role.side_effect = error
            with self.assertRaises(aws_session.SessionError) as caught:
                aws_session.assume_profile(CONFIG, "dev", "123456")
            self.assertNotIn("PRIVATE", str(caught.exception))
            self.assertNotIn("123456", str(caught.exception))
        self.assertEqual(self.client.close.call_count, 4)


class CredentialValidationTests(unittest.TestCase):
    def test_rejects_missing_invalid_and_expired_temporary_credentials(self):
        now = datetime.now(timezone.utc)
        for change in (
            {"AccessKeyId": ""}, {"SecretAccessKey": "private\nexport BAD=1"},
            {"SessionToken": None}, {"SessionToken": "x" * 16385},
            {"Expiration": now - timedelta(seconds=1)},
            {"Expiration": now + timedelta(hours=2)},
            {"Expiration": now.replace(tzinfo=None)}, {"Expiration": "2030-01-01"},
        ):
            with self.subTest(change=change), self.assertRaises(aws_session.SessionError):
                aws_session._credentials({"Credentials": credentials(**change)}, now)
        for response in ({}, [], None):
            with self.assertRaises(aws_session.SessionError):
                aws_session._credentials(response)

    def test_shell_exports_quote_values_and_clear_profile_providers(self):
        value = credentials(SecretAccessKey="quoted'$(do-not-run)`value`")
        result = {"credentials": value, "region": "us-east-1"}
        output = aws_session.shell_exports(result, "posix")
        self.assertIn("unset AWS_PROFILE AWS_DEFAULT_PROFILE", output)
        self.assertIn("AWS_WEB_IDENTITY_TOKEN_FILE", output)
        secret_line = next(line for line in output.splitlines() if line.startswith("export AWS_SECRET_ACCESS_KEY"))
        self.assertEqual(shlex.split(secret_line), ["export", "AWS_SECRET_ACCESS_KEY=" + value["SecretAccessKey"]])
        powershell = aws_session.shell_exports(result, "powershell")
        self.assertIn("$env:AWS_SECRET_ACCESS_KEY = 'quoted''$(do-not-run)`value`'", powershell)
        self.assertNotIn("AWS_PROFILE =", powershell)


class FederationTests(unittest.TestCase):
    def setUp(self):
        self.result = {"credentials": credentials(), "region": "us-east-1", "roleArn": ROLE}

    def response(self, body=b'{"SigninToken":"TEST_SIGNIN+/="}', status=200, url=aws_session.FEDERATION_URL):
        result = Mock()
        result.status = status
        result.geturl.return_value = url
        result.read.return_value = body
        result.__enter__ = Mock(return_value=result)
        result.__exit__ = Mock(return_value=False)
        return result

    def test_console_uses_post_for_credentials_and_returns_only_login_url_and_metadata(self):
        opener = Mock()
        opener.open.return_value = self.response()
        with patch.object(aws_session, "assume_profile", return_value=self.result) as assume, patch.object(aws_session, "build_opener", return_value=opener):
            output = aws_session.console_session(CONFIG, "dev", "123456")
        assume.assert_called_once_with(CONFIG, "dev", "123456", progress=None)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, aws_session.FEDERATION_URL)
        self.assertEqual(request.method, "POST")
        posted = parse_qs(request.data.decode("ascii"))
        self.assertEqual(set(posted), {"Action", "Session"})
        self.assertEqual(posted["Action"], ["getSigninToken"])
        self.assertEqual(json.loads(posted["Session"][0]), {
            "sessionId": "TEST_TEMPORARY_KEY", "sessionKey": "TEST_SECRET+/=", "sessionToken": "TEST_TOKEN+/="
        })
        self.assertEqual(set(output), {"url", "expiration", "roleArn"})
        self.assertNotIn("TEST_SECRET", json.dumps(output))
        self.assertNotIn("TEST_TEMPORARY_KEY", json.dumps(output))
        query = parse_qs(urlsplit(output["url"]).query)
        self.assertEqual(set(query), {"Action", "Destination", "SigninToken"})
        self.assertEqual(query["Action"], ["login"])
        self.assertEqual(query["Destination"], ["https://console.aws.amazon.com/console/home?region=us-east-1"])
        self.assertEqual(query["SigninToken"], ["TEST_SIGNIN+/="])

    def test_console_progress_identifies_each_network_stage_in_order(self):
        events = []

        def assume(*args, progress=None):
            progress("assume-role")
            events.append("assume-called")
            return self.result

        def sign_in(*args):
            events.append("federation-called")
            return "TEST_SIGNIN_TOKEN"

        output = io.StringIO()
        with patch.object(aws_session, "assume_profile", side_effect=assume), patch.object(aws_session, "_signin_token", side_effect=sign_in), redirect_stderr(output):
            aws_session.console_session(CONFIG, "dev", "012345", progress=events.append)
        self.assertEqual(events, ["assume-role", "assume-called", "federation", "federation-called"])
        self.assertEqual(output.getvalue(), "", "A callback does not enable worker logging")

    def test_console_progress_does_not_enter_federation_after_role_failure(self):
        stages = []
        with patch.object(aws_session, "assume_profile", side_effect=assumed_result(failure=aws_session.SessionError("Role switch failed"))), patch.object(aws_session, "_signin_token") as sign_in, self.assertRaises(aws_session.SessionError):
            aws_session.console_session(CONFIG, "dev", "012345", progress=stages.append)
        self.assertEqual(stages, ASSUME_STAGES)
        sign_in.assert_not_called()

    def test_federation_refuses_redirects_even_to_another_https_host(self):
        with self.assertRaisesRegex(aws_session.SessionError, "redirect"):
            aws_session._NoRedirects().redirect_request(None, None, 302, "Found", {}, "https://attacker.example/")

    def test_federation_rejects_bad_response_without_leaking_credentials(self):
        for response in (
            self.response(body=b"PRIVATE_SESSION_TOKEN"), self.response(body=b'{}'),
            self.response(body=b'["PRIVATE_SESSION_TOKEN"]'), self.response(body=b'\xffPRIVATE_SESSION_TOKEN'),
            self.response(body=b'{"SigninToken":"bad\\nvalue"}'),
            self.response(body=b"x" * (aws_session.MAX_FEDERATION_BYTES + 1)),
            self.response(status=302), self.response(url="https://attacker.example"),
        ):
            opener = Mock()
            opener.open.return_value = response
            with patch.object(aws_session, "build_opener", return_value=opener), self.assertRaises(aws_session.SessionError) as caught:
                aws_session._signin_token(self.result["credentials"])
            self.assertNotIn("PRIVATE", str(caught.exception))

    def test_http_error_text_is_redacted(self):
        opener = Mock()
        opener.open.side_effect = RuntimeError("PRIVATE_REQUEST_BODY")
        with patch.object(aws_session, "build_opener", return_value=opener), self.assertRaises(aws_session.SessionError) as caught:
            aws_session._signin_token(self.result["credentials"])
        self.assertNotIn("PRIVATE", str(caught.exception))

    def test_federation_http_errors_report_only_the_status(self):
        for status in (400, 403, 429, 500, "PRIVATE_STATUS", 999, True):
            with self.subTest(status_type=type(status).__name__):
                opener = Mock()
                body = io.BytesIO(b"PRIVATE_RESPONSE_BODY_TEST_SECRET")
                opener.open.side_effect = HTTPError(
                    "https://example.invalid/PRIVATE_REQUEST_TOKEN", status,
                    "PRIVATE_HTTP_REASON", {"PRIVATE_HEADER": "PRIVATE_HEADER_VALUE"}, body,
                )
                with patch.object(aws_session, "build_opener", return_value=opener), self.assertRaises(aws_session.SessionError) as caught:
                    aws_session._signin_token(self.result["credentials"])
                message = str(caught.exception)
                self.assertIn("AWS Console sign-in failed", message)
                if type(status) is int and 100 <= status <= 599:
                    self.assertIn(f"HTTP {status}", message)
                else:
                    self.assertNotIn("HTTP", message)
                self.assertNotIn("PRIVATE", message)
                self.assertNotIn("TEST_SECRET", message)
                self.assertEqual(body.tell(), 0, "Error response bodies must not be read")

    def test_federation_connection_errors_are_actionable_without_raw_details(self):
        failures = (
            (ssl.SSLCertVerificationError(1, "PRIVATE_CERTIFICATE_DETAILS"), "CA certificates"),
            (URLError(ssl.SSLCertVerificationError(1, "PRIVATE_WRAPPED_CERTIFICATE")), "ca-certificates in Debian/WSL"),
            (TimeoutError("PRIVATE_TIMEOUT_DETAILS"), "timed out"),
            (URLError(TimeoutError("PRIVATE_WRAPPED_TIMEOUT")), "timed out"),
            (URLError(URLError(TimeoutError("PRIVATE_NESTED_TIMEOUT"))), "timed out"),
            (ssl.SSLError(1, "PRIVATE_TLS_DETAILS"), "TLS settings"),
            (URLError(ssl.SSLError(1, "PRIVATE_WRAPPED_TLS")), "TLS settings"),
            (ConnectionRefusedError("PRIVATE_CONNECTION_DETAILS"), "Could not connect"),
            (URLError("PRIVATE_CONNECTION_URL_OR_TOKEN"), "Could not connect"),
        )
        for failure, expected in failures:
            with self.subTest(error=type(failure).__name__, expected=expected):
                opener = Mock()
                opener.open.side_effect = failure
                with patch.object(aws_session, "build_opener", return_value=opener), self.assertRaises(aws_session.SessionError) as caught:
                    aws_session._signin_token(self.result["credentials"])
                self.assertIn(expected, str(caught.exception))
                self.assertNotIn("PRIVATE", str(caught.exception))
                self.assertIsNone(caught.exception.__cause__)

    def test_federation_response_errors_identify_the_failed_stage_safely(self):
        cases = (
            (self.response(status=503, body=b"PRIVATE_RESPONSE_BODY"), "HTTP 503"),
            (self.response(body=b"PRIVATE_MALFORMED_JSON"), "invalid response"),
            (self.response(body=b'{"unexpected":"PRIVATE_RESPONSE_VALUE"}'), "invalid sign-in token"),
            (self.response(body=b'{"SigninToken":"PRIVATE_TOKEN\\n"}'), "invalid sign-in token"),
            (self.response(body=b"PRIVATE" * aws_session.MAX_FEDERATION_BYTES), "oversized response"),
        )
        for response, expected in cases:
            with self.subTest(expected=expected):
                opener = Mock()
                opener.open.return_value = response
                with patch.object(aws_session, "build_opener", return_value=opener), self.assertRaises(aws_session.SessionError) as caught:
                    aws_session._signin_token(self.result["credentials"])
                self.assertIn(expected, str(caught.exception))
                self.assertNotIn("PRIVATE", str(caught.exception))


class EntrypointTests(unittest.TestCase):
    def test_console_worker_emits_only_flushed_safe_progress_and_result(self):
        result = {"credentials": credentials(), "region": "us-east-1", "roleArn": ROLE}
        output, errors = io.StringIO(), io.StringIO()
        payload = b'{"profile":"dev","mfaCode":"012345"}'
        with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), patch.object(aws_session, "assume_profile", side_effect=assumed_result(result)), patch.object(aws_session, "_signin_token", return_value="TEST_SIGNIN_TOKEN"), redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(aws_session.main(["--file", CONFIG, "--console-worker"]), 0)
        self.assertEqual([json.loads(line) for line in errors.getvalue().splitlines()], [{"stage": stage} for stage in ASSUME_STAGES + ["federation"]])
        self.assertEqual(set(json.loads(output.getvalue())), {"url", "expiration", "roleArn"})
        with patch("builtins.print") as emit:
            aws_session._worker_stage("federation")
        emit.assert_called_once_with('{"stage": "federation"}', file=sys.stderr, flush=True)

    def test_console_worker_reports_stage_before_assume_failure_without_sensitive_details(self):
        output, errors = io.StringIO(), io.StringIO()
        payload = b'{"profile":"dev","mfaCode":"012345"}'
        with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), patch.object(aws_session, "assume_profile", side_effect=assumed_result(failure=RuntimeError("PRIVATE_SOURCE_KEY_MFA_012345"))), redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(aws_session.main(["--file", CONFIG, "--console-worker"]), 1)
        self.assertEqual(output.getvalue(), "")
        lines = [json.loads(line) for line in errors.getvalue().splitlines()]
        self.assertEqual(lines[:-1], [{"stage": stage} for stage in ASSUME_STAGES])
        self.assertEqual(set(lines[-1]), {"error"})
        self.assertEqual(len(lines), len(ASSUME_STAGES) + 1)
        self.assertNotIn("PRIVATE", errors.getvalue())
        self.assertNotIn("012345", errors.getvalue())

    def test_worker_stage_rejects_unknown_values_without_printing_them(self):
        errors = io.StringIO()
        with redirect_stderr(errors), self.assertRaises(aws_session.SessionError) as caught:
            aws_session._worker_stage("PRIVATE_UNEXPECTED_STAGE")
        self.assertEqual(errors.getvalue(), "")
        self.assertNotIn("PRIVATE", str(caught.exception))

    def test_console_worker_reports_safe_federation_diagnostics_without_secrets(self):
        failures = (
            (HTTPError("https://example.invalid/PRIVATE_REQUEST_TOKEN", 403, "PRIVATE_HTTP_REASON", {}, io.BytesIO(b"PRIVATE_RESPONSE_BODY")), "HTTP 403"),
            (URLError(ssl.SSLCertVerificationError(1, "PRIVATE_CERTIFICATE_DETAILS")), "CA certificates"),
            (URLError(TimeoutError("PRIVATE_TIMEOUT_DETAILS")), "timed out"),
            (URLError("PRIVATE_CONNECTION_URL_OR_TOKEN"), "Could not connect"),
        )
        for failure, expected in failures:
            with self.subTest(expected=expected):
                result = {"credentials": credentials(), "region": "us-east-1", "roleArn": ROLE}
                opener = Mock()
                opener.open.side_effect = failure
                output, errors = io.StringIO(), io.StringIO()
                payload = b'{"profile":"dev","mfaCode":"012345"}'
                with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), patch.object(aws_session, "assume_profile", side_effect=assumed_result(result)), patch.object(aws_session, "build_opener", return_value=opener), redirect_stdout(output), redirect_stderr(errors):
                    self.assertEqual(aws_session.main(["--file", CONFIG, "--console-worker"]), 1)
                self.assertEqual(output.getvalue(), "")
                lines = [json.loads(line) for line in errors.getvalue().splitlines()]
                self.assertEqual(lines[:-1], [{"stage": stage} for stage in ASSUME_STAGES + ["federation"]])
                diagnostic = lines[-1]
                self.assertEqual(set(diagnostic), {"error"})
                self.assertIn(expected, diagnostic["error"])
                for secret in ("PRIVATE", "012345", "TEST_TEMPORARY_KEY", "TEST_SECRET", "TEST_TOKEN", "Traceback", "https://"):
                    self.assertNotIn(secret, errors.getvalue())

    def test_cli_worker_emits_only_allowlisted_temporary_credentials_and_metadata(self):
        temporary = credentials()
        temporary["unexpected"] = "PRIVATE_EXTRA_FIELD"
        result = {
            "credentials": temporary, "region": "us-east-1", "roleArn": ROLE,
            "sourceCredentials": {"SecretAccessKey": "PRIVATE_SOURCE_SECRET"},
        }
        output, errors = io.StringIO(), io.StringIO()
        payload = b'{"profile":"dev","mfaCode":"012345"}'
        with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), patch.object(aws_session, "assume_profile", side_effect=assumed_result(result)) as assume, patch.object(aws_session, "_signin_token") as federation, redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(aws_session.main(["--file", CONFIG, "--cli-worker"]), 0)
        assume.assert_called_once_with(CONFIG, "dev", "012345", progress=aws_session._worker_stage)
        federation.assert_not_called()
        self.assertEqual([json.loads(line) for line in errors.getvalue().splitlines()], [{"stage": stage} for stage in ASSUME_STAGES])
        self.assertNotIn("PRIVATE", output.getvalue())
        self.assertEqual(json.loads(output.getvalue()), {
            "credentials": {key: temporary[key] for key in ("AccessKeyId", "SecretAccessKey", "SessionToken")},
            "region": "us-east-1", "roleArn": ROLE,
            "expiration": temporary["Expiration"].astimezone(timezone.utc).isoformat(),
        })

    def test_cli_worker_failure_has_no_stdout_or_raw_error_details(self):
        for failure in (RuntimeError("PRIVATE_SOURCE_KEY_MFA_012345"), aws_session.SessionError("AWS rejected the source credentials.")):
            with self.subTest(error=type(failure).__name__):
                output, errors = io.StringIO(), io.StringIO()
                payload = b'{"profile":"dev","mfaCode":"012345"}'
                with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), patch.object(aws_session, "assume_profile", side_effect=failure), redirect_stdout(output), redirect_stderr(errors):
                    self.assertEqual(aws_session.main(["--file", CONFIG, "--cli-worker"]), 1)
                self.assertEqual(output.getvalue(), "")
                self.assertEqual(set(json.loads(errors.getvalue())), {"error"})
                self.assertNotIn("PRIVATE", errors.getvalue())
                self.assertNotIn("012345", errors.getvalue())

    def test_worker_modes_are_mutually_exclusive(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(aws_session, "_worker_request") as request, redirect_stdout(output), redirect_stderr(errors):
            with self.assertRaises(SystemExit) as exited:
                aws_session.main(["--file", CONFIG, "--console-worker", "--cli-worker"])
        self.assertEqual(exited.exception.code, 2)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("not allowed", errors.getvalue())
        request.assert_not_called()

    def test_getpass_never_falls_back_to_echoing_mfa(self):
        def fallback(*args, **kwargs):
            warnings.warn("Cannot control echo", getpass.GetPassWarning)
            self.fail("Echoing fallback must not proceed")
        with patch.object(getpass, "getpass", side_effect=fallback), self.assertRaisesRegex(aws_session.SessionError, "interactive terminal"):
            aws_session._prompt_mfa()

    def test_cli_prompts_on_every_invocation_and_emits_only_after_success(self):
        output, errors = io.StringIO(), io.StringIO()
        result = {"credentials": credentials(), "region": "us-east-1", "roleArn": ROLE}
        with patch.object(aws_session, "_selected_profile"), patch.object(aws_session, "_prompt_mfa", side_effect=["123456", "654321"]) as prompt, patch.object(aws_session, "assume_profile", side_effect=[result, aws_session.SessionError("AWS rejected the MFA code.")]) as assume:
            with redirect_stdout(output), redirect_stderr(errors):
                self.assertEqual(aws_session.main(["--file", CONFIG, "--profile", "dev"]), 0)
            self.assertIn("export AWS_ACCESS_KEY_ID", output.getvalue())
            self.assertIn(ROLE, errors.getvalue())
            self.assertIn(result["credentials"]["Expiration"].isoformat(), errors.getvalue())
            self.assertIn("fresh MFA code to renew", errors.getvalue())
            self.assertNotIn("TEST_SECRET", errors.getvalue())
            self.assertNotIn("TEST_TOKEN", errors.getvalue())
            output.seek(0)
            output.truncate(0)
            errors.seek(0)
            errors.truncate(0)
            with redirect_stdout(output), redirect_stderr(errors):
                self.assertEqual(aws_session.main(["--file", CONFIG, "--profile", "dev"]), 1)
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(prompt.call_count, 2)
            self.assertEqual([call.args[2] for call in assume.call_args_list], ["123456", "654321"])
            self.assertEqual(json.loads(errors.getvalue()), {"error": "AWS rejected the MFA code."})

    def test_worker_limits_input_and_rejects_extra_fields(self):
        for mode in ("--console-worker", "--cli-worker"):
            for payload in (b'{"profile":"dev","mfaCode":"123456","url":"https://attacker.example"}', b'[]', b'PRIVATE_BAD_JSON', b'x' * (aws_session.MAX_WORKER_BYTES + 1), b'{"profile":"dev","mfaCode":123456}'):
                with self.subTest(mode=mode, payload_length=len(payload)):
                    output, errors = io.StringIO(), io.StringIO()
                    with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), patch.object(aws_session, "console_session") as console, patch.object(aws_session, "cli_session") as cli, redirect_stdout(output), redirect_stderr(errors):
                        self.assertEqual(aws_session.main(["--file", CONFIG, mode]), 1)
                    console.assert_not_called()
                    cli.assert_not_called()
                    self.assertEqual(output.getvalue(), "")
                    self.assertEqual(set(json.loads(errors.getvalue())), {"error"})
                    self.assertNotIn("PRIVATE", errors.getvalue())

    def test_worker_does_not_print_credentials_or_raw_exception_on_failure(self):
        output, errors = io.StringIO(), io.StringIO()
        payload = b'{"profile":"dev","mfaCode":"123456"}'
        with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), patch.object(aws_session, "console_session", side_effect=RuntimeError("PRIVATE_ACCESS_KEY")), redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(aws_session.main(["--file", CONFIG, "--console-worker"]), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn("PRIVATE_ACCESS_KEY", errors.getvalue())
        self.assertIn("No credentials were applied", json.loads(errors.getvalue())["error"])


if __name__ == "__main__":
    unittest.main()
