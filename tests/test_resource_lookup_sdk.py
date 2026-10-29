# Author: jperch1987
"""Optional real-SDK smoke checks; synthetic credentials and all sockets blocked."""

from contextlib import ExitStack
import os
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import resource_lookup as lookup

try:
    import boto3
    from botocore.config import Config
    from botocore.stub import Stubber
except ImportError:
    boto3 = None


@unittest.skipIf(boto3 is None, "Install requirements.txt to run optional real-SDK smoke checks.")
class LoadBalancerSdkTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        # Never inspect the developer's AWS config, credentials, or overrides.
        self.stack.enter_context(patch.dict(os.environ, {
            "AWS_CONFIG_FILE": os.devnull,
            "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            "AWS_EC2_METADATA_DISABLED": "true",
            "BOTO_CONFIG": os.devnull,
        }, clear=True))
        for attribute in ("connect", "connect_ex"):
            self.stack.enter_context(patch.object(socket.socket, attribute,
                side_effect=AssertionError("Network is forbidden in this offline SDK test.")))
        for attribute in ("create_connection", "getaddrinfo"):
            self.stack.enter_context(patch.object(socket, attribute,
                side_effect=AssertionError("Network is forbidden in this offline SDK test.")))
        self.credentials = {"AccessKeyId": "TEST_ROLE_KEY", "SecretAccessKey": "TEST_ROLE_SECRET", "SessionToken": "TEST_ROLE_TOKEN"}
        self.session = boto3.Session(aws_access_key_id="TEST_SESSION_KEY", aws_secret_access_key="TEST_SESSION_SECRET",
            aws_session_token="TEST_SESSION_TOKEN", region_name="us-east-1")
        self.selected = {"profile": "test", "role_arn": "arn:aws:iam::111111111111:role/Test", "region": "us-east-1"}

    def client(self, family):
        client = lookup._client(self.session, Config, family, "us-east-1", self.credentials)
        self.addCleanup(client.close)
        return client

    def test_real_sdk_client_parameters_serializer_and_signing_match_both_apis(self):
        for family, parameter, result_key, version in [
            ("elbv2", "Names", "LoadBalancers", "2015-12-01"),
            ("elb", "LoadBalancerNames", "LoadBalancerDescriptions", "2012-06-01"),
        ]:
            with self.subTest(family=family):
                client = self.client(family)
                self.assertEqual(client.meta.endpoint_url, "https://elasticloadbalancing.us-east-1.amazonaws.com")
                self.assertEqual(client._request_signer.signing_name, "elasticloadbalancing")
                parameters = {parameter: ["test-lb"], "PageSize": 100}
                operation = client.meta.service_model.operation_model("DescribeLoadBalancers")
                serialized = client._serializer.serialize_to_request(parameters, operation)
                self.assertEqual(serialized["method"], "POST")
                self.assertEqual(serialized["body"], {"Action": "DescribeLoadBalancers", "Version": version,
                    f"{parameter}.member.1": "test-lb", "PageSize": 100})
                item = {"LoadBalancerName": "test-lb"}
                if family == "elbv2":
                    item.update(LoadBalancerArn="arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/app/test-lb/0123456789abcdef", Type="application")
                with Stubber(client) as stub:
                    stub.add_response("describe_load_balancers", {result_key: [item]}, parameters)
                    rows = []
                    lookup._load_balancer_family(client, family, self.selected,
                        lookup.parse_query("load-balancer", "test-lb"), rows, float("inf"))
                    self.assertEqual(len(rows), 1)
                    self.assertEqual(rows[0]["accountId"], "111111111111")
                    self.assertEqual(rows[0]["name"], "test-lb")

    def test_real_sdk_errors_preserve_safe_codes_without_private_aws_messages(self):
        for family, parameter in [("elbv2", "Names"), ("elb", "LoadBalancerNames")]:
            with self.subTest(family=family):
                client = self.client(family)
                parameters = {parameter: ["test-lb"], "PageSize": 100}
                with Stubber(client) as stub:
                    stub.add_client_error("describe_load_balancers", service_error_code="ValidationError",
                        service_message="PRIVATE_QUERY_CREDENTIAL_REQUESTID", expected_params=parameters)
                    with self.assertRaises(Exception) as raised:
                        lookup._load_balancer_family(client, family, self.selected,
                            lookup.parse_query("load-balancer", "test-lb"), [], float("inf"))
                    failure = lookup._load_balancer_failure(raised.exception, "read")
                    self.assertEqual(failure.status, "error")
                    self.assertIn("ValidationError", failure.safe_message)
                    self.assertNotIn("PRIVATE", failure.safe_message)
                with Stubber(client) as stub:
                    stub.add_client_error("describe_load_balancers", service_error_code="LoadBalancerNotFound", expected_params=parameters)
                    with self.assertRaises(Exception) as raised:
                        lookup._load_balancer_family(client, family, self.selected,
                            lookup.parse_query("load-balancer", "test-lb"), [], float("inf"))
                    self.assertEqual(lookup._scan_failure(raised.exception).status, "not_found")


if __name__ == "__main__":
    unittest.main()
