# Author: jperch1987
"""Resource lookup tests use only mocked AWS clients and synthetic metadata."""

from contextlib import ExitStack, redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import aws_session
import resource_lookup as lookup


ACCOUNT = "111111111111"
REGION = "us-east-1"
MFA = "arn:aws:iam::222222222222:mfa/example"
CONFIG = "/local/test-config"
INSTANCE = "i-0123456789abcdef0"


def selected(name="dev", **changes):
    result = {"profile": name, "role_arn": f"arn:aws:iam::{ACCOUNT}:role/Developer", "source_profile": "base",
              "region": REGION, "mfa_serial": MFA, "external_id": "", "file": CONFIG}
    result.update(changes)
    return result


def request(resource_type="ec2", query=INSTANCE, profiles=None):
    return {"profiles": profiles or ["dev"], "resourceType": resource_type, "query": query, "mfaCode": "012345"}


def credentials(prefix="ROLE"):
    return {"AccessKeyId": f"TEST_{prefix}_KEY", "SecretAccessKey": f"TEST_{prefix}_SECRET",
            "SessionToken": f"TEST_{prefix}_TOKEN", "Expiration": datetime.now(timezone.utc) + timedelta(minutes=15)}


def aws_error(code="AccessDenied"):
    error = RuntimeError("PRIVATE_ERROR_WITH_TOKEN_012345")
    error.response = {"Error": {"Code": code, "Message": "PRIVATE_AWS_RESPONSE_WITH_012345"}}
    return error


def ec2_response(instance_id=INSTANCE, name="example", account=ACCOUNT):
    return {"Reservations": [{"OwnerId": account, "Instances": [{"InstanceId": instance_id, "Tags": [{"Key": "Name", "Value": name}], "PrivateSecretField": "PRIVATE"}]}]}


class LookupTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.profiles = {"dev": selected(), "prod": selected("prod", role_arn=f"arn:aws:iam::{ACCOUNT}:role/Production")}
        self.profile_reader = self.stack.enter_context(patch.object(aws_session, "_selected_profile", side_effect=lambda _, name: self.profiles[name]))
        self.source_client = Mock()
        self.source_client.get_session_token.return_value = {"Credentials": credentials("SOURCE_SESSION")}
        self.sts = Mock()
        self.sts.assume_role.side_effect = lambda **kwargs: {"Credentials": credentials()}
        self.resource = Mock()
        self.resource.describe_instances.return_value = ec2_response()
        self.resource.describe_volumes.return_value = {"Volumes": []}
        self.resource.describe_security_groups.return_value = {"SecurityGroups": []}
        self.resource.describe_vpcs.return_value = {"Vpcs": []}
        self.session = Mock()
        self.source = {"aws_access_key_id": "TEST_USER_KEY", "aws_secret_access_key": "TEST_USER_SECRET"}
        self.session._session.get_scoped_config.return_value = self.source
        self.session.get_credentials.return_value = SimpleNamespace(method="shared-credentials-file", get_frozen_credentials=lambda: SimpleNamespace(access_key="TEST_USER_KEY", secret_key="TEST_USER_SECRET", token=None))
        self.clients = []
        def client(service, **kwargs):
            self.clients.append((service, kwargs))
            if service == "sts":
                return self.source_client if kwargs["aws_session_token"] is None else self.sts
            return self.resource
        self.session.client.side_effect = client
        self.boto3 = SimpleNamespace(Session=Mock(return_value=self.session))
        self.config = Mock(side_effect=lambda **kwargs: kwargs)
        self.sdk = self.stack.enter_context(patch.object(aws_session, "_sdk", return_value=(self.boto3, self.config)))

    def scan(self, payload=None):
        events = []
        lookup.scan(CONFIG, payload or request(), events.append)
        self.assertEqual(events[-1], {"event": "complete"})
        return events[:-1]

    def test_one_mfa_source_session_authenticates_multiple_restricted_roles(self):
        self.profiles["prod"]["external_id"] = "client-external-id"
        payload = request(profiles=["dev", "prod"])
        events = self.scan(payload)
        self.assertEqual([event["check"]["status"] for event in events], ["found", "found"])
        self.source_client.get_session_token.assert_called_once_with(DurationSeconds=900, SerialNumber=MFA, TokenCode="012345")
        self.assertEqual(self.sts.assume_role.call_count, 2)
        for call in self.sts.assume_role.call_args_list:
            self.assertEqual(call.kwargs["DurationSeconds"], 900)
            self.assertNotIn("TokenCode", call.kwargs)
            self.assertNotIn("SerialNumber", call.kwargs)
            policy = json.loads(call.kwargs["Policy"])
            self.assertEqual(policy, {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": ["ec2:DescribeInstances"], "Resource": "*"}]})
        self.assertEqual(self.sts.assume_role.call_args_list[1].kwargs["ExternalId"], "client-external-id")
        self.assertNotEqual(self.sts.assume_role.call_args_list[0].kwargs["RoleSessionName"], self.sts.assume_role.call_args_list[1].kwargs["RoleSessionName"])
        for service, options in self.clients:
            self.assertEqual(options["endpoint_url"], f"https://{service}.{REGION}.amazonaws.com")
            self.assertTrue(options["verify"])
            self.assertEqual(options["config"]["proxies"], {})
            self.assertEqual(options["config"]["retries"], {"total_max_attempts": 1})
            self.assertTrue(options["config"]["ignore_configured_endpoint_urls"])
            if service != "sts":
                self.assertEqual(options["aws_access_key_id"], "TEST_ROLE_KEY")
                self.assertEqual(options["aws_session_token"], "TEST_ROLE_TOKEN")
        self.assertEqual(payload["mfaCode"], "")
        self.assertNotIn("TEST_", json.dumps(events))
        self.assertNotIn("PRIVATE", json.dumps(events))
        self.assertEqual(self.resource.close.call_count, 2)

    def test_all_request_and_profile_validation_happens_before_aws(self):
        invalid = [None, {}, {**request(), "extra": "PRIVATE"}, {**request(), "profiles": []},
                   {**request(), "profiles": ["dev", "dev"]}, {**request(), "profiles": ["dev"] * 26},
                   {**request(), "mfaCode": 123456}, {**request(), "mfaCode": "12345"},
                   {**request(), "query": "line\nbreak"}, {**request(), "query": "x" * 257},
                   {**request(), "resourceType": []}, {**request(), "resourceType": "unsupported"}]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(lookup.LookupError):
                lookup.scan(CONFIG, payload, lambda _: None)
        self.sdk.assert_not_called()
        self.profiles["prod"]["source_profile"] = "other-user"
        with self.assertRaisesRegex(lookup.LookupError, "same source"):
            self.scan(request(profiles=["dev", "prod"]))
        self.sdk.assert_not_called()
        self.profiles["prod"]["source_profile"] = "base"
        self.profiles["prod"]["mfa_serial"] = MFA + "-other"
        with self.assertRaisesRegex(lookup.LookupError, "same source"):
            self.scan(request(profiles=["dev", "prod"]))
        self.sdk.assert_not_called()

    def test_invalid_selected_profile_is_safe_and_no_aws_call_is_made(self):
        self.profile_reader.side_effect = aws_session.SessionError("PRIVATE_CONFIGURATION")
        with self.assertRaises(lookup.LookupError) as error:
            self.scan()
        self.assertNotIn("PRIVATE", str(error.exception))
        self.sdk.assert_not_called()

    def test_arn_account_and_region_mismatches_skip_before_authentication(self):
        for arn in [f"arn:aws:ec2:{REGION}:999999999999:instance/{INSTANCE}", f"arn:aws:ec2:eu-west-1:{ACCOUNT}:instance/{INSTANCE}"]:
            events = self.scan(request(query=arn))
            self.assertEqual(events[0]["check"]["status"], "skipped")
            self.assertEqual(events[0]["results"], [])
        self.sdk.assert_not_called()

    def test_arn_rejects_wrong_type_partition_and_qualified_resource(self):
        for kind, query in [("ec2", f"arn:aws:ec2:{REGION}:{ACCOUNT}:volume/vol-01234567"),
                            ("ec2", f"arn:aws-cn:ec2:cn-north-1:{ACCOUNT}:instance/{INSTANCE}"),
                            ("s3", "arn:aws:s3:::test-bucket/object"),
                            ("lambda", f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:test:alias"),
                            ("rds", "db--invalid")]:
            with self.subTest(kind=kind, query=query), self.assertRaises(lookup.LookupError):
                self.scan(request(kind, query))
        self.sdk.assert_not_called()

    def test_source_failure_is_fatal_safe_and_never_assumes_roles(self):
        self.source_client.get_session_token.side_effect = aws_error()
        with self.assertRaises(lookup.LookupError) as error:
            self.scan()
        self.assertRegex(str(error.exception), "fresh MFA")
        self.assertNotIn("PRIVATE", str(error.exception))
        self.sts.assume_role.assert_not_called()
        self.resource.describe_instances.assert_not_called()

    def test_unsafe_source_providers_are_rejected_without_network(self):
        for key in ["credential_process", "role_arn", "aws_session_token", "sso_session"]:
            self.source[key] = "PRIVATE_VALUE"
            with self.subTest(key=key), self.assertRaises(lookup.LookupError):
                self.scan()
            self.source.pop(key)
        self.source_client.get_session_token.assert_not_called()
        self.sts.assume_role.assert_not_called()

    def test_environment_overrides_are_isolated_and_restored(self):
        extras = {"AWS_ACCESS_KEY_ID": "PRIVATE_ENV", "AWS_PROFILE": "wrong", "AWS_ENDPOINT_URL": "https://wrong.invalid", "AWS_CA_BUNDLE": "/wrong"}
        original = self.session.client.side_effect
        def client(service, **kwargs):
            for key in extras:
                self.assertNotIn(key, os.environ)
            self.assertEqual(os.environ["AWS_CONFIG_FILE"], CONFIG)
            self.assertEqual(os.environ["AWS_EC2_METADATA_DISABLED"], "true")
            return original(service, **kwargs)
        self.session.client.side_effect = client
        with patch.dict(os.environ, extras):
            self.scan()
            for key, value in extras.items():
                self.assertEqual(os.environ[key], value)

    def test_failed_role_does_not_abort_later_roles_or_use_source_for_resource_reads(self):
        self.sts.assume_role.side_effect = [aws_error("AccessDenied"), {"Credentials": credentials()}]
        events = self.scan(request(profiles=["dev", "prod"]))
        self.assertEqual([event["check"]["status"] for event in events], ["auth_failed", "found"])
        self.assertEqual(self.resource.describe_instances.call_count, 1)
        self.assertNotIn("PRIVATE", json.dumps(events))

    def test_exact_name_tag_filter_is_postchecked_and_pagination_is_followed(self):
        first = ec2_response(name="prod-extra")
        first["NextToken"] = "TEST_NEXT_PAGE"
        self.resource.describe_instances.side_effect = [first, ec2_response("i-11111111111111111", "prod")]
        event = self.scan(request(query="prod"))[0]
        self.assertEqual([row["resourceId"] for row in event["results"]], ["i-11111111111111111"])
        calls = self.resource.describe_instances.call_args_list
        self.assertEqual(calls[0].kwargs, {"Filters": [{"Name": "tag:Name", "Values": ["prod"]}], "MaxResults": 100})
        self.assertEqual(calls[1].kwargs["NextToken"], "TEST_NEXT_PAGE")

    def test_wrong_owner_resources_do_not_become_matches(self):
        self.resource.describe_instances.return_value = ec2_response(account="999999999999")
        self.assertEqual(self.scan()[0]["check"]["status"], "not_found")
        self.resource.describe_vpcs.return_value = {"Vpcs": [{"OwnerId": "999999999999", "VpcId": "vpc-01234567", "Tags": [{"Key": "Name", "Value": "shared"}]}]}
        self.assertEqual(self.scan(request("vpc", "shared"))[0]["check"]["status"], "not_found")

    def test_missing_owner_metadata_is_incomplete_instead_of_inferred_absence(self):
        response = ec2_response()
        response["Reservations"][0].pop("OwnerId")
        self.resource.describe_instances.return_value = response
        event = self.scan()[0]
        self.assertEqual(event["check"]["status"], "error")
        self.assertEqual(event["results"], [])

    def test_every_selected_type_gets_only_its_own_read_actions(self):
        for kind, actions in lookup.READ_ACTIONS.items():
            with self.subTest(kind=kind):
                lookup._assume(self.session, self.config, selected(), credentials("SOURCE_SESSION"), kind, float("inf"))
                statement = json.loads(self.sts.assume_role.call_args.kwargs["Policy"])["Statement"]
                self.assertEqual(statement, [{"Effect": "Allow", "Action": actions, "Resource": "*"}])

    def test_ebs_and_vpc_exact_ids_and_names_produce_only_metadata(self):
        for kind, operation, key, id_key, resource_id in [("ebs", "describe_volumes", "Volumes", "VolumeId", "vol-01234567"), ("vpc", "describe_vpcs", "Vpcs", "VpcId", "vpc-01234567")]:
            getattr(self.resource, operation).return_value = {key: [{id_key: resource_id, "OwnerId": ACCOUNT, "Tags": [{"Key": "Name", "Value": "my resource"}], "Private": "PRIVATE"}]}
            for query in [resource_id, "my resource"]:
                event = self.scan(request(kind, query))[0]
                self.assertEqual(event["check"]["status"], "found")
                self.assertEqual(event["results"][0]["name"], "my resource")
                self.assertEqual(set(event["results"][0]), {"profile", "accountId", "region", "resourceType", "resourceId", "name", "arn"})

    def test_security_group_searches_group_name_or_name_tag_and_deduplicates(self):
        group = {"GroupId": "sg-01234567", "OwnerId": ACCOUNT, "GroupName": "web", "Tags": [{"Key": "Name", "Value": "web"}]}
        self.resource.describe_security_groups.return_value = {"SecurityGroups": [group]}
        event = self.scan(request("security-group", "web"))[0]
        self.assertEqual(len(event["results"]), 1)
        self.assertEqual([call.kwargs["Filters"][0]["Name"] for call in self.resource.describe_security_groups.call_args_list], ["group-name", "tag:Name"])

    def test_pagination_cap_and_repeated_token_are_incomplete_not_absent(self):
        response = ec2_response()
        response["NextToken"] = "REPEATED_TOKEN"
        self.resource.describe_instances.return_value = response
        event = self.scan()[0]
        self.assertEqual(event["check"]["status"], "error")
        self.assertEqual(len(event["results"]), 1)
        self.assertRegex(event["check"]["message"], "incomplete")
        self.resource.describe_instances.reset_mock()
        self.resource.describe_instances.side_effect = lambda **_: {"Reservations": [], "NextToken": str(self.resource.describe_instances.call_count)}
        with patch.object(lookup, "MAX_PAGES", 2):
            event = self.scan()[0]
        self.assertEqual(event["check"]["status"], "error")
        self.assertEqual(self.resource.describe_instances.call_count, 2)

    def test_result_cap_preserves_confirmed_rows_and_reports_incomplete(self):
        instances = [{"InstanceId": f"i-{number:017x}", "Tags": [{"Key": "Name", "Value": "common"}]} for number in range(101)]
        self.resource.describe_instances.return_value = {"Reservations": [{"OwnerId": ACCOUNT, "Instances": instances}]}
        event = self.scan(request(query="common"))[0]
        self.assertEqual(event["check"]["status"], "error")
        self.assertEqual(len(event["results"]), 100)

    def test_deadline_skips_remaining_profiles_without_assuming_them(self):
        with patch.object(lookup, "SCAN_SECONDS", 0):
            # Source authentication checks the deadline before making a request.
            events = self.scan(request(profiles=["dev", "prod"]))
            self.assertEqual([event["check"]["status"] for event in events], ["skipped", "skipped"])
        self.source_client.get_session_token.assert_not_called()
        with patch.object(lookup.time, "monotonic", side_effect=[0, 1, 2, 3, 200, 201]):
            events = self.scan(request(profiles=["dev", "prod"]))
        self.assertEqual([event["check"]["status"] for event in events], ["skipped", "skipped"])
        self.resource.describe_instances.assert_not_called()

    def test_s3_searches_owned_buckets_globally_and_uses_actual_region(self):
        self.resource.list_buckets.return_value = {"Buckets": [{"Name": "test-bucket-other", "BucketRegion": "us-west-2"}, {"Name": "test-bucket", "BucketRegion": "eu-west-1"}]}
        event = self.scan(request("s3", "arn:aws:s3:::test-bucket"))[0]
        self.assertEqual(event["check"]["region"], REGION)
        self.assertEqual(event["results"][0]["region"], "eu-west-1")
        self.assertEqual(event["results"][0]["accountId"], ACCOUNT)
        self.resource.list_buckets.assert_called_once_with(Prefix="test-bucket", MaxBuckets=100)
        self.resource.get_bucket_location.assert_not_called()
        self.resource.head_bucket.assert_not_called()

    def test_s3_location_fallback_normalizes_legacy_region_and_proves_expected_owner(self):
        self.resource.list_buckets.return_value = {"Buckets": [{"Name": "test-bucket"}]}
        for region, expected_region in [(None, "us-east-1"), ("EU", "eu-west-1"), ("ap-southeast-1", "ap-southeast-1")]:
            self.resource.get_bucket_location.return_value = {"LocationConstraint": region}
            event = self.scan(request("s3", "test-bucket"))[0]
            self.assertEqual(event["results"][0]["region"], expected_region)
        self.resource.get_bucket_location.assert_called_with(Bucket="test-bucket", ExpectedBucketOwner=ACCOUNT)

    def test_s3_denial_never_infers_owner_but_known_owned_bucket_can_have_unknown_region(self):
        self.resource.list_buckets.side_effect = aws_error()
        event = self.scan(request("s3", "test-bucket"))[0]
        self.assertEqual(event["check"]["status"], "access_denied")
        self.assertEqual(event["results"], [])
        self.resource.head_bucket.assert_not_called()
        self.resource.list_buckets.side_effect = None
        self.resource.list_buckets.return_value = {"Buckets": [{"Name": "test-bucket"}]}
        self.resource.get_bucket_location.side_effect = aws_error()
        event = self.scan(request("s3", "test-bucket"))[0]
        self.assertEqual(event["check"]["status"], "access_denied")
        self.assertEqual(event["results"][0]["region"], "unknown")

    def test_s3_old_sdk_fallback_is_bounded_and_cannot_report_false_absence(self):
        ParamValidationError = type("ParamValidationError", (Exception,), {})
        self.resource.list_buckets.side_effect = [ParamValidationError("PRIVATE"), {"Buckets": [{"Name": "other-bucket"}] * 1001}]
        event = self.scan(request("s3", "test-bucket"))[0]
        self.assertEqual(event["check"]["status"], "error")
        self.assertEqual(self.resource.list_buckets.call_args_list[1].kwargs, {})

    def test_s3_pagination_and_old_sdk_can_return_a_confirmed_match(self):
        self.resource.list_buckets.side_effect = [{"Buckets": [], "ContinuationToken": "NEXT"}, {"Buckets": [{"Name": "test-bucket", "BucketRegion": "us-west-2"}]}]
        event = self.scan(request("s3", "test-bucket"))[0]
        self.assertEqual(event["check"]["status"], "found")
        self.assertEqual(self.resource.list_buckets.call_args_list[1].kwargs["ContinuationToken"], "NEXT")
        ParamValidationError = type("ParamValidationError", (Exception,), {})
        self.resource.list_buckets.side_effect = [ParamValidationError("PRIVATE"), {"Buckets": [{"Name": "test-bucket", "BucketRegion": "us-west-2"}]}]
        event = self.scan(request("s3", "test-bucket"))[0]
        self.assertEqual(event["check"]["status"], "found")

    def test_matching_arn_is_confirmed_by_service_not_just_parsed(self):
        arn = f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/{INSTANCE}"
        self.resource.describe_instances.return_value = {"Reservations": []}
        event = self.scan(request(query=arn))[0]
        self.assertEqual(event["check"]["status"], "not_found")
        self.assertEqual(event["results"], [])
        self.sts.assume_role.assert_called_once()

    def test_rds_and_lambda_targeted_calls_validate_arns_and_discard_sensitive_fields(self):
        arn = f"arn:aws:rds:{REGION}:{ACCOUNT}:db:example-db"
        self.resource.describe_db_instances.return_value = {"DBInstances": [{"DBInstanceIdentifier": "example-db", "DBInstanceArn": arn, "Engine": "postgres", "MasterUsername": "PRIVATE"}]}
        event = self.scan(request("rds", arn))[0]
        self.assertEqual(event["check"]["status"], "found")
        self.resource.describe_db_instances.assert_called_once_with(DBInstanceIdentifier=arn, MaxRecords=100)
        lambda_arn = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:example-function"
        self.resource.get_function_configuration.return_value = {"FunctionName": "example-function", "FunctionArn": lambda_arn, "Environment": {"Variables": {"TOKEN": "PRIVATE"}}}
        event = self.scan(request("lambda", "example-function"))[0]
        self.assertEqual(event["check"]["status"], "found")
        self.assertNotIn("PRIVATE", json.dumps(event))
        self.resource.get_function.assert_not_called()
        self.resource.get_function_configuration.return_value["FunctionArn"] = lambda_arn.replace(ACCOUNT, "999999999999")
        event = self.scan(request("lambda", "example-function"))[0]
        self.assertEqual(event["check"]["status"], "error")
        self.assertEqual(event["results"], [])

    def test_fixed_failure_statuses_do_not_expose_aws_messages(self):
        for code, expected in [("AccessDenied", "access_denied"), ("UnauthorizedOperation", "access_denied"), ("ExpiredToken", "auth_failed"), ("InvalidInstanceID.NotFound", "not_found"), ("Throttling", "error")]:
            self.resource.describe_instances.side_effect = aws_error(code)
            event = self.scan()[0]
            self.assertEqual(event["check"]["status"], expected)
            self.assertNotIn("PRIVATE", json.dumps(event))
            self.assertNotIn("012345", event["check"]["message"])

    def test_stdout_protocol_is_ndjson_metadata_only_and_stderr_is_empty(self):
        output, errors = io.StringIO(), io.StringIO()
        payload = json.dumps(request()).encode()
        with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(lookup.main(["--file", CONFIG]), 0)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([event["event"] for event in events], ["profile", "complete"])
        self.assertEqual(errors.getvalue(), "")
        self.assertNotIn("TEST_SOURCE", output.getvalue())
        self.assertNotIn("TEST_ROLE", output.getvalue())
        self.assertNotIn("PRIVATE", output.getvalue())

    def test_invalid_worker_input_returns_one_fixed_error_without_echoing_input(self):
        for raw in [b'PRIVATE_INVALID_JSON', json.dumps({**request(), "query": "PRIVATE\nINPUT"}).encode(), b"x" * (lookup.MAX_REQUEST_BYTES + 1)]:
            output, errors = io.StringIO(), io.StringIO()
            with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(raw))), redirect_stdout(output), redirect_stderr(errors):
                self.assertEqual(lookup.main(["--file", CONFIG]), 1)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["event"], "error")
            self.assertNotIn("PRIVATE", output.getvalue())
            self.assertEqual(errors.getvalue(), "")
        self.source_client.get_session_token.assert_not_called()


if __name__ == "__main__":
    unittest.main()
