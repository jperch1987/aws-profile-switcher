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
        self.config_reader = self.stack.enter_context(patch.object(aws_session, "read_profiles", side_effect=lambda _: {"file": CONFIG, "profiles": list(self.profiles.values())}))
        self.profile_reader = self.stack.enter_context(patch.object(aws_session, "_selected_profile", wraps=aws_session._selected_profile))
        self.source_client = Mock()
        self.source_client.get_session_token.return_value = {"Credentials": credentials("SOURCE_SESSION")}
        self.sts = Mock()
        self.sts.assume_role.side_effect = lambda **kwargs: {"Credentials": credentials()}
        self.resource = Mock()
        self.resource.describe_instances.return_value = ec2_response()
        self.resource.describe_volumes.return_value = {"Volumes": []}
        self.resource.describe_security_groups.return_value = {"SecurityGroups": []}
        self.resource.describe_vpcs.return_value = {"Vpcs": []}
        self.elbv2 = Mock()
        self.elbv2.describe_load_balancers.return_value = {"LoadBalancers": []}
        self.elb = Mock()
        self.elb.describe_load_balancers.return_value = {"LoadBalancerDescriptions": []}
        self.session = Mock()
        self.source = {"aws_access_key_id": "TEST_USER_KEY", "aws_secret_access_key": "TEST_USER_SECRET"}
        self.session._session.get_scoped_config.return_value = self.source
        self.session.get_credentials.return_value = SimpleNamespace(method="shared-credentials-file", get_frozen_credentials=lambda: SimpleNamespace(access_key="TEST_USER_KEY", secret_key="TEST_USER_SECRET", token=None))
        self.clients = []
        def client(service, **kwargs):
            self.clients.append((service, kwargs))
            if service == "sts":
                return self.source_client if kwargs["aws_session_token"] is None else self.sts
            if service == "elbv2":
                return self.elbv2
            if service == "elb":
                return self.elb
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
                   {**request(), "profiles": ["dev", "dev"]}, {**request(), "profiles": [f"profile-{n}" for n in range(251)]},
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
        with patch.object(lookup.time, "monotonic", side_effect=[0, 1, 2, 3, 600, 601]):
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

    def test_all_250_profiles_are_checked_with_one_mfa_session(self):
        self.profiles = {f"account-{n}": selected(f"account-{n}") for n in range(250)}
        events = self.scan(request(profiles=list(self.profiles)))
        self.assertEqual(len(events), 250)
        self.assertTrue(all(event["check"]["status"] == "found" for event in events))
        self.assertEqual(self.sts.assume_role.call_count, 250)
        self.source_client.get_session_token.assert_called_once()
        self.config_reader.assert_called_once_with(CONFIG)

    def test_invalid_profile_in_shared_config_snapshot_stops_before_mfa(self):
        self.profiles["prod"]["role_arn"] = "invalid"
        with self.assertRaisesRegex(lookup.LookupError, "selected role profile"):
            self.scan(request(profiles=["dev", "prod"]))
        self.config_reader.assert_called_once_with(CONFIG)
        self.sdk.assert_not_called()
        self.source_client.get_session_token.assert_not_called()

    def test_eks_name_and_arn_are_confirmed_without_exposing_cluster_secrets(self):
        arn = f"arn:aws:eks:{REGION}:{ACCOUNT}:cluster/example-eks"
        self.resource.describe_cluster.return_value = {"cluster": {"name": "example-eks", "arn": arn,
            "connectorConfig": {"activationCode": "PRIVATE"}, "certificateAuthority": {"data": "PRIVATE"}}}
        for query in ["example-eks", arn]:
            event = self.scan(request("eks", query))[0]
            self.assertEqual(event["check"]["status"], "found")
            self.assertEqual(event["results"][0]["arn"], arn)
            self.assertNotIn("PRIVATE", json.dumps(event))
        self.resource.describe_cluster.assert_called_with(name="example-eks")
        self.resource.describe_cluster.return_value["cluster"]["arn"] = arn.replace(ACCOUNT, "999999999999")
        self.assertEqual(self.scan(request("eks", "example-eks"))[0]["check"]["status"], "error")
        self.resource.describe_cluster.side_effect = aws_error("ResourceNotFoundException")
        self.assertEqual(self.scan(request("eks", "example-eks"))[0]["check"]["status"], "not_found")

    def test_new_types_reject_unsupported_arns_and_names_before_authentication(self):
        invalid = [("eks", "bad/name"), ("eks", f"arn:aws:eks:{REGION}:{ACCOUNT}:nodegroup/name/group/id"),
            ("elasticache", "bad--name"), ("elasticache", f"arn:aws:elasticache:{REGION}:{ACCOUNT}:snapshot:example"),
            ("elasticache", f"arn:aws:elasticache:{REGION}:{ACCOUNT}:replicationgroup:" + "a" * 41),
            ("elasticache", f"arn:aws:elasticache:{REGION}:{ACCOUNT}:serverlesscache:" + "a" * 41),
            ("route53", "arn:aws:route53:us-east-1::hostedzone/Z12345"),
            ("route53", f"arn:aws:route53::{ACCOUNT}:hostedzone/Z12345"),
            ("route53", "arn:aws:route53:::healthcheck/Z12345"),
            ("route53", "*.example.com"), ("route53", "example..com"), ("route53", "example.com/path")]
        for resource_type, query in invalid:
            with self.subTest(resource_type=resource_type, query=query), self.assertRaises(lookup.LookupError):
                self.scan(request(resource_type, query))
        self.sdk.assert_not_called()

    def test_new_regional_arns_skip_different_accounts_before_mfa(self):
        for resource_type, resource in [("eks", "cluster/example"), ("elasticache", "cluster:example")]:
            event = self.scan(request(resource_type, f"arn:aws:{resource_type}:{REGION}:999999999999:{resource}"))[0]
            self.assertEqual(event["check"]["status"], "skipped")
        self.sdk.assert_not_called()

    def cache_response(self, kind, name="example-cache"):
        _, id_key, response_key, _, _ = lookup.ELASTICACHE_TYPES[kind]
        return {response_key: [{id_key: name, "ARN": f"arn:aws:elasticache:{REGION}:{ACCOUNT}:{kind}:{name}", "AuthToken": "PRIVATE"}]}

    def test_elasticache_plain_name_searches_all_subtypes_and_preserves_collisions(self):
        for kind, (operation, _, _, _, _) in lookup.ELASTICACHE_TYPES.items():
            getattr(self.resource, operation).return_value = self.cache_response(kind)
        event = self.scan(request("elasticache", "Example-Cache"))[0]
        self.assertEqual(event["check"]["status"], "found")
        self.assertEqual(len(event["results"]), 3)
        self.assertEqual(len({row["arn"] for row in event["results"]}), 3)
        self.assertNotIn("PRIVATE", json.dumps(event))
        self.resource.describe_cache_clusters.assert_called_once_with(CacheClusterId="example-cache", MaxRecords=100)
        self.resource.describe_replication_groups.assert_called_once_with(ReplicationGroupId="example-cache", MaxRecords=100)
        self.resource.describe_serverless_caches.assert_called_once_with(ServerlessCacheName="example-cache", MaxResults=100)

    def test_elasticache_arn_only_queries_its_subtype(self):
        for kind, (operation, _, _, _, _) in lookup.ELASTICACHE_TYPES.items():
            self.resource.reset_mock()
            arn = f"arn:aws:elasticache:{REGION}:{ACCOUNT}:{kind}:example-cache"
            getattr(self.resource, operation).return_value = self.cache_response(kind)
            event = self.scan(request("elasticache", arn))[0]
            self.assertEqual(event["check"]["status"], "found")
            for other_kind, (other_operation, _, _, _, _) in lookup.ELASTICACHE_TYPES.items():
                if other_kind != kind:
                    getattr(self.resource, other_operation).assert_not_called()

    def test_long_elasticache_cluster_names_skip_impossible_subtypes(self):
        name = "a" * 50
        self.resource.describe_cache_clusters.return_value = self.cache_response("cluster", name)
        event = self.scan(request("elasticache", name))[0]
        self.assertEqual(event["check"]["status"], "found")
        self.assertEqual(event["results"][0]["resourceId"], name)
        self.resource.describe_replication_groups.assert_not_called()
        self.resource.describe_serverless_caches.assert_not_called()

    def test_elasticache_absent_subtypes_do_not_hide_later_matches(self):
        self.resource.describe_cache_clusters.side_effect = aws_error("CacheClusterNotFound")
        self.resource.describe_replication_groups.side_effect = aws_error("ReplicationGroupNotFoundFault")
        self.resource.describe_serverless_caches.return_value = self.cache_response("serverlesscache")
        event = self.scan(request("elasticache", "example-cache"))[0]
        self.assertEqual(event["check"]["status"], "found")
        self.assertEqual(len(event["results"]), 1)
        self.resource.describe_serverless_caches.side_effect = aws_error("ServerlessCacheNotFoundFault")
        self.assertEqual(self.scan(request("elasticache", "example-cache"))[0]["check"]["status"], "not_found")

    def test_elasticache_partial_denial_keeps_other_matches_and_reports_incomplete(self):
        self.resource.describe_cache_clusters.side_effect = aws_error("AccessDenied")
        self.resource.describe_replication_groups.side_effect = aws_error("ReplicationGroupNotFoundFault")
        self.resource.describe_serverless_caches.return_value = self.cache_response("serverlesscache")
        event = self.scan(request("elasticache", "example-cache"))[0]
        self.assertEqual(event["check"]["status"], "access_denied")
        self.assertEqual(len(event["results"]), 1)
        self.assertNotIn("PRIVATE", json.dumps(event))

    def test_elasticache_serverless_pagination_is_bounded_and_validates_owner(self):
        arn = f"arn:aws:elasticache:{REGION}:{ACCOUNT}:serverlesscache:example-cache"
        response = self.cache_response("serverlesscache")
        self.resource.describe_serverless_caches.side_effect = [{"ServerlessCaches": [], "NextToken": "NEXT"}, response]
        event = self.scan(request("elasticache", arn))[0]
        self.assertEqual(event["check"]["status"], "found")
        self.assertEqual(self.resource.describe_serverless_caches.call_args.kwargs["NextToken"], "NEXT")
        response["ServerlessCaches"][0]["ARN"] = arn.replace(ACCOUNT, "999999999999")
        self.resource.describe_serverless_caches.side_effect = None
        self.resource.describe_serverless_caches.return_value = response
        event = self.scan(request("elasticache", arn))[0]
        self.assertEqual(event["check"]["status"], "error")
        self.assertEqual(event["results"], [])
        self.resource.describe_serverless_caches.return_value = {"ServerlessCaches": [], "NextToken": "REPEAT"}
        self.assertEqual(self.scan(request("elasticache", arn))[0]["check"]["status"], "error")

    def zone(self, zone_id="Z12345", name="example.com."):
        return {"Id": f"/hostedzone/{zone_id}", "Name": name, "CallerReference": "PRIVATE", "Config": {"PrivateZone": True}}

    def test_route53_domain_normalizes_case_and_returns_all_owned_zones_globally(self):
        self.profiles["dev"]["region"] = "eu-west-1"
        self.resource.list_hosted_zones_by_name.side_effect = [
            {"HostedZones": [self.zone()], "IsTruncated": True, "NextDNSName": "example.com.", "NextHostedZoneId": "Z67890"},
            {"HostedZones": [self.zone("Z67890"), self.zone("Z99999", "example.net.")], "IsTruncated": False}]
        event = self.scan(request("route53", "EXAMPLE.com"))[0]
        self.assertEqual(event["check"]["status"], "found")
        self.assertEqual(event["check"]["region"], "eu-west-1")
        self.assertEqual([row["resourceId"] for row in event["results"]], ["Z12345", "Z67890"])
        self.assertTrue(all(row["region"] == "global" for row in event["results"]))
        self.assertNotIn("PRIVATE", json.dumps(event))
        self.assertEqual(self.resource.list_hosted_zones_by_name.call_args.kwargs, {"DNSName": "example.com.", "HostedZoneId": "Z67890", "MaxItems": "100"})
        route_client = next(options for service, options in self.clients if service == "route53")
        self.assertEqual(route_client["region_name"], "us-east-1")
        self.assertEqual(route_client["endpoint_url"], "https://route53.amazonaws.com")
        self.resource.get_hosted_zone.assert_not_called()

    def test_route53_id_and_arn_require_confirmation_in_account_owned_listing(self):
        self.resource.get_hosted_zone.return_value = {"HostedZone": self.zone()}
        for query in ["Z12345", "/hostedzone/Z12345", "arn:aws:route53:::hostedzone/Z12345"]:
            self.resource.list_hosted_zones_by_name.return_value = {"HostedZones": [self.zone()], "IsTruncated": False}
            event = self.scan(request("route53", query))[0]
            self.assertEqual(event["check"]["status"], "found")
            self.assertEqual(event["results"][0]["arn"], "arn:aws:route53:::hostedzone/Z12345")
        self.resource.get_hosted_zone.assert_called_with(Id="Z12345")
        self.resource.list_hosted_zones_by_name.return_value = {"HostedZones": [self.zone("Z67890")], "IsTruncated": False}
        event = self.scan(request("route53", "Z12345"))[0]
        self.assertEqual(event["check"]["status"], "not_found")
        self.assertEqual(event["results"], [])

    def test_route53_denial_and_malformed_pagination_never_report_absence(self):
        self.resource.list_hosted_zones_by_name.side_effect = aws_error("AccessDenied")
        self.assertEqual(self.scan(request("route53", "example.com"))[0]["check"]["status"], "access_denied")
        self.resource.list_hosted_zones_by_name.side_effect = None
        for response in [{"HostedZones": []}, {"HostedZones": [], "IsTruncated": True},
            {"HostedZones": [self.zone()], "IsTruncated": True, "NextDNSName": "example.com.", "NextHostedZoneId": "Z12345"}]:
            self.resource.list_hosted_zones_by_name.return_value = response
            event = self.scan(request("route53", "example.com"))[0]
            self.assertEqual(event["check"]["status"], "error")
            self.assertNotIn("PRIVATE", json.dumps(event))
        self.resource.get_hosted_zone.side_effect = aws_error("NoSuchHostedZone")
        self.assertEqual(self.scan(request("route53", "Z12345"))[0]["check"]["status"], "not_found")

    def test_route53_result_limit_preserves_confirmed_zones(self):
        self.resource.list_hosted_zones_by_name.return_value = {"HostedZones": [self.zone(f"Z{n:05}") for n in range(101)], "IsTruncated": False}
        event = self.scan(request("route53", "example.com"))[0]
        self.assertEqual(event["check"]["status"], "error")
        self.assertEqual(len(event["results"]), 100)

    def test_route53_unrelated_escaped_names_end_the_exact_name_range(self):
        responses = [
            {"HostedZones": [self.zone(), self.zone("Z67890", r"foo\052.com.")], "IsTruncated": False},
            {"HostedZones": [self.zone()], "IsTruncated": True, "NextDNSName": r"foo\052.com.", "NextHostedZoneId": "Z67890"},
        ]
        for response in responses:
            self.resource.list_hosted_zones_by_name.reset_mock()
            self.resource.list_hosted_zones_by_name.return_value = response
            event = self.scan(request("route53", "example.com"))[0]
            self.assertEqual(event["check"]["status"], "found")
            self.assertEqual([row["resourceId"] for row in event["results"]], ["Z12345"])
            self.resource.list_hosted_zones_by_name.assert_called_once()
        self.resource.list_hosted_zones_by_name.return_value = {
            "HostedZones": [self.zone("invalid", "example.com.")], "IsTruncated": False}
        self.assertEqual(self.scan(request("route53", "example.com"))[0]["check"]["status"], "error")

    def test_example_policy_matches_all_supported_resource_read_actions(self):
        policy = json.loads((Path(__file__).resolve().parents[1] / "lookup-permissions.example.json").read_text())
        self.assertEqual(set(policy["Statement"][0]["Action"]), {action for actions in lookup.READ_ACTIONS.values() for action in actions})

    def modern_balancer(self, kind="app", name="example-lb", **changes):
        result = {"LoadBalancerName": name,
            "LoadBalancerArn": f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:loadbalancer/{kind}/{name}/0123456789abcdef",
            "Type": lookup.LOAD_BALANCER_TYPES[kind], "DNSName": "PRIVATE", "SecurityGroups": ["PRIVATE"]}
        result.update(changes)
        return result

    def classic_balancer(self, name="example-lb"):
        return {"LoadBalancerName": name, "DNSName": "PRIVATE", "ListenerDescriptions": [{"PRIVATE": "PRIVATE"}],
            "SourceSecurityGroup": {"OwnerAlias": "amazon-elb", "GroupName": "PRIVATE"}}

    def test_load_balancer_modern_types_confirm_exact_arn_and_only_query_v2(self):
        for kind in ["app", "net", "gwy"]:
            with self.subTest(kind=kind):
                self.elbv2.reset_mock()
                item = self.modern_balancer(kind)
                self.elbv2.describe_load_balancers.return_value = {"LoadBalancers": [item]}
                event = self.scan(request("load-balancer", item["LoadBalancerArn"]))[0]
                self.assertEqual(event["check"]["status"], "found")
                self.assertEqual(event["results"][0]["arn"], item["LoadBalancerArn"])
                self.assertNotIn("PRIVATE", json.dumps(event))
                self.elbv2.describe_load_balancers.assert_called_once_with(LoadBalancerArns=[item["LoadBalancerArn"]], PageSize=100)
                self.elbv2.close.assert_called_once()
        self.elb.describe_load_balancers.assert_not_called()
        for service, options in self.clients:
            if service == "elbv2":
                self.assertEqual(options["endpoint_url"], f"https://elasticloadbalancing.{REGION}.amazonaws.com")
                self.assertEqual(options["region_name"], REGION)
                self.assertEqual(options["aws_access_key_id"], "TEST_ROLE_KEY")
                self.assertEqual(options["aws_session_token"], "TEST_ROLE_TOKEN")
                self.assertTrue(options["verify"])
                self.assertEqual(options["config"]["signature_version"], "v4")
                self.assertEqual(options["config"]["retries"], {"total_max_attempts": 1})
                self.assertEqual(options["config"]["proxies"], {})

    def test_load_balancer_classic_arn_is_confirmed_then_constructed_from_role_account(self):
        arn = f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:loadbalancer/example-lb"
        self.elb.describe_load_balancers.return_value = {"LoadBalancerDescriptions": [self.classic_balancer()]}
        event = self.scan(request("load-balancer", arn))[0]
        self.assertEqual(event["check"]["status"], "found")
        self.assertEqual(event["results"][0], {"profile": "dev", "accountId": ACCOUNT, "region": REGION,
            "resourceType": "load-balancer", "resourceId": "example-lb", "name": "example-lb", "arn": arn})
        self.assertNotIn("PRIVATE", json.dumps(event))
        self.elb.describe_load_balancers.assert_called_once_with(LoadBalancerNames=["example-lb"], PageSize=100)
        self.elbv2.describe_load_balancers.assert_not_called()
        self.elb.close.assert_called_once()
        options = next(options for service, options in self.clients if service == "elb")
        self.assertEqual(options["endpoint_url"], f"https://elasticloadbalancing.{REGION}.amazonaws.com")
        self.assertEqual(options["aws_access_key_id"], "TEST_ROLE_KEY")
        self.assertTrue(options["verify"])

    def test_load_balancer_plain_name_keeps_matches_from_both_api_families(self):
        self.elbv2.describe_load_balancers.return_value = {"LoadBalancers": [self.modern_balancer()]}
        self.elb.describe_load_balancers.return_value = {"LoadBalancerDescriptions": [self.classic_balancer()]}
        event = self.scan(request("load-balancer", "example-lb"))[0]
        self.assertEqual(event["check"]["status"], "found")
        self.assertEqual(len(event["results"]), 2)
        self.assertEqual(len({row["arn"] for row in event["results"]}), 2)
        self.elbv2.describe_load_balancers.assert_called_once_with(Names=["example-lb"], PageSize=100)
        self.elb.describe_load_balancers.assert_called_once_with(LoadBalancerNames=["example-lb"], PageSize=100)
        self.source_client.get_session_token.assert_called_once()
        self.sts.assume_role.assert_called_once()
        policy = json.loads(self.sts.assume_role.call_args.kwargs["Policy"])
        self.assertEqual(policy["Statement"][0]["Action"], ["elasticloadbalancing:DescribeLoadBalancers"])

    def test_load_balancer_classic_internal_prefix_does_not_query_impossible_v2_name(self):
        self.elb.describe_load_balancers.return_value = {"LoadBalancerDescriptions": [self.classic_balancer("internal-example")]}
        self.assertEqual(self.scan(request("load-balancer", "internal-example"))[0]["check"]["status"], "found")
        self.elbv2.describe_load_balancers.assert_not_called()

    def test_load_balancer_missing_family_does_not_hide_other_family_match(self):
        self.elbv2.describe_load_balancers.side_effect = aws_error("LoadBalancerNotFound")
        self.elb.describe_load_balancers.return_value = {"LoadBalancerDescriptions": [self.classic_balancer()]}
        self.assertEqual(self.scan(request("load-balancer", "example-lb"))[0]["check"]["status"], "found")
        self.elb.describe_load_balancers.side_effect = aws_error("LoadBalancerNotFound")
        self.assertEqual(self.scan(request("load-balancer", "example-lb"))[0]["check"]["status"], "not_found")
        self.elbv2.describe_load_balancers.side_effect = None
        self.elbv2.describe_load_balancers.return_value = {"LoadBalancers": [self.modern_balancer()]}
        self.assertEqual(self.scan(request("load-balancer", "example-lb"))[0]["check"]["status"], "found")

    def test_load_balancer_partial_denial_preserves_other_family_matches_in_either_order(self):
        for denied, found, response in [(self.elbv2, self.elb, {"LoadBalancerDescriptions": [self.classic_balancer()]}),
            (self.elb, self.elbv2, {"LoadBalancers": [self.modern_balancer()]})]:
            self.elbv2.describe_load_balancers.side_effect = None
            self.elb.describe_load_balancers.side_effect = None
            denied.describe_load_balancers.side_effect = aws_error("AccessDenied")
            found.describe_load_balancers.return_value = response
            event = self.scan(request("load-balancer", "example-lb"))[0]
            self.assertEqual(event["check"]["status"], "access_denied")
            self.assertEqual(len(event["results"]), 1)
            self.assertNotIn("PRIVATE", json.dumps(event))

    def test_load_balancer_v2_metadata_requires_matching_owner_region_name_type_and_exact_arn(self):
        item = self.modern_balancer()
        arn = item["LoadBalancerArn"]
        invalid = [{"LoadBalancerName": "different"}, {"LoadBalancerArn": arn.replace(ACCOUNT, "999999999999")},
            {"LoadBalancerArn": arn.replace(REGION, "eu-west-1")}, {"LoadBalancerArn": arn.replace("example-lb", "other-lb")},
            {"Type": "network"}, {"Type": None}, {"LoadBalancerArn": None},
            {"LoadBalancerArn": arn.replace("0123456789abcdef", "fedcba9876543210")},
            {"LoadBalancerArn": arn.replace("loadbalancer/app/", "targetgroup/")},
            {"LoadBalancerArn": f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:loadbalancer/example-lb"}]
        for changed in invalid:
            with self.subTest(changed=changed):
                self.elbv2.describe_load_balancers.return_value = {"LoadBalancers": [{**item, **changed}]}
                event = self.scan(request("load-balancer", arn))[0]
                self.assertEqual(event["check"]["status"], "error")
                self.assertEqual(event["results"], [])
        self.elb.describe_load_balancers.return_value = {"LoadBalancerDescriptions": [self.classic_balancer("different")]}
        classic_arn = f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:loadbalancer/example-lb"
        self.assertEqual(self.scan(request("load-balancer", classic_arn))[0]["check"]["status"], "error")

    def test_load_balancer_invalid_names_and_non_balancer_arns_fail_before_mfa(self):
        prefix = f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:"
        invalid = ["a" * 33, "-example", "example-", "example_lb", "example.example.com", "app/example/0123456789abcdef",
            prefix + "listener/app/example/0123456789abcdef/0123456789abcdef", prefix + "targetgroup/example/0123456789abcdef",
            prefix + "loadbalancer/app/example", prefix + "loadbalancer/unknown/example/0123456789abcdef",
            prefix + "loadbalancer/app/example/not-a-valid-id", prefix + "loadbalancer/app/internal-example/0123456789abcdef",
            prefix.replace("arn:aws:", "arn:aws-cn:") + "loadbalancer/example",
            prefix.replace("elasticloadbalancing:", "elbv2:") + "loadbalancer/app/example/0123456789abcdef"]
        for query in invalid:
            with self.subTest(query=query), self.assertRaises(lookup.LookupError):
                self.scan(request("load-balancer", query))
        self.sdk.assert_not_called()
        self.source_client.get_session_token.assert_not_called()

    def test_load_balancer_arn_scope_mismatches_skip_before_authentication(self):
        for suffix in ["example-lb", "app/example-lb/0123456789abcdef"]:
            for region, account in [(REGION, "999999999999"), ("eu-west-1", ACCOUNT)]:
                arn = f"arn:aws:elasticloadbalancing:{region}:{account}:loadbalancer/{suffix}"
                event = self.scan(request("load-balancer", arn))[0]
                self.assertEqual(event["check"]["status"], "skipped")
                self.assertEqual(event["results"], [])
        self.sdk.assert_not_called()

    def test_load_balancer_pagination_maps_next_marker_to_marker_for_both_apis(self):
        modern = self.modern_balancer()
        cases = [(self.elbv2, "LoadBalancers", modern, modern["LoadBalancerArn"]),
            (self.elb, "LoadBalancerDescriptions", self.classic_balancer(), f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:loadbalancer/example-lb")]
        for client, key, item, arn in cases:
            with self.subTest(key=key):
                client.describe_load_balancers.side_effect = [{key: [], "NextMarker": "NEXT"}, {key: [item], "NextMarker": ""}]
                event = self.scan(request("load-balancer", arn))[0]
                self.assertEqual(event["check"]["status"], "found")
                self.assertEqual(client.describe_load_balancers.call_args.kwargs["Marker"], "NEXT")
                self.assertNotIn("NextMarker", client.describe_load_balancers.call_args.kwargs)
                client.describe_load_balancers.side_effect = None
                client.describe_load_balancers.return_value = {key: [item], "NextMarker": "REPEATED"}
                event = self.scan(request("load-balancer", arn))[0]
                self.assertEqual(event["check"]["status"], "error")
                self.assertEqual(len(event["results"]), 1)
                client.describe_load_balancers.reset_mock()
                client.describe_load_balancers.side_effect = lambda c=client, k=key, **_: {k: [], "NextMarker": str(c.describe_load_balancers.call_count)}
                with patch.object(lookup, "MAX_PAGES", 2):
                    event = self.scan(request("load-balancer", arn))[0]
                self.assertEqual(event["check"]["status"], "error")
                self.assertEqual(client.describe_load_balancers.call_count, 2)

    def test_load_balancer_deadline_between_families_preserves_confirmed_matches(self):
        current = [0]
        def first_family(**_):
            current[0] = 600
            return {"LoadBalancers": [self.modern_balancer()]}
        self.elbv2.describe_load_balancers.side_effect = first_family
        with patch.object(lookup.time, "monotonic", side_effect=lambda: current[0]):
            event = self.scan(request("load-balancer", "example-lb"))[0]
        self.assertEqual(event["check"]["status"], "skipped")
        self.assertEqual(len(event["results"]), 1)
        self.elb.describe_load_balancers.assert_not_called()

    def test_load_balancer_notfound_after_pagination_progress_is_incomplete(self):
        modern = self.modern_balancer()
        cases = [(self.elbv2, "LoadBalancers", modern, modern["LoadBalancerArn"]),
            (self.elb, "LoadBalancerDescriptions", self.classic_balancer(), f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:loadbalancer/example-lb")]
        for client, key, item, arn in cases:
            for first_page_rows in [[], [item]]:
                with self.subTest(key=key, has_match=bool(first_page_rows)):
                    client.describe_load_balancers.side_effect = [
                        {key: first_page_rows, "NextMarker": "NEXT"}, aws_error("LoadBalancerNotFound")]
                    event = self.scan(request("load-balancer", arn))[0]
                    self.assertEqual(event["check"]["status"], "error")
                    self.assertEqual(len(event["results"]), len(first_page_rows))
                    self.assertNotIn("PRIVATE", json.dumps(event))

    def test_large_selected_scope_survives_worker_stdin_without_truncation(self):
        names = [f"profile-{n}-" + "\u90e8" * 256 for n in range(250)]
        payload = json.dumps(request(profiles=names), ensure_ascii=False).encode()
        self.assertGreater(len(payload), 65536)
        output = io.StringIO()
        def scan(config_file, decoded, emit):
            self.assertEqual(config_file, CONFIG)
            self.assertEqual(decoded["profiles"], names)
            emit({"event": "complete"})
        with patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(payload))), patch.object(lookup, "scan", side_effect=scan), redirect_stdout(output):
            self.assertEqual(lookup.main(["--file", CONFIG]), 0)
        self.assertEqual(json.loads(output.getvalue()), {"event": "complete"})

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
