# Author: jperch1987
"""Optional real-SDK smoke checks; synthetic credentials and all sockets blocked."""

from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import json
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
    from botocore.stub import ANY, Stubber
except ImportError:
    boto3 = None


@unittest.skipIf(boto3 is None, "Install requirements.txt to run optional real-SDK smoke checks.")
class ResourceLookupSdkTests(unittest.TestCase):
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

    def test_real_sdk_vpc_id_name_and_arn_filters_paginate_and_return_metadata(self):
        client = self.client("ec2")
        vpc_id = "vpc-0123456789abcdef0"
        arn = f"arn:aws:ec2:us-east-1:111111111111:vpc/{vpc_id}"
        for query, filter_name, value in [(vpc_id, "vpc-id", vpc_id), ("production-vpc", "tag:Name", "production-vpc"), (arn, "vpc-id", vpc_id)]:
            with self.subTest(query=query):
                parameters = {"Filters": [{"Name": filter_name, "Values": [value]}], "MaxResults": 100}
                operation = client.meta.service_model.operation_model("DescribeVpcs")
                serialized = client._serializer.serialize_to_request(parameters, operation)
                self.assertEqual(serialized["body"], {"Action": "DescribeVpcs", "Version": "2016-11-15",
                    "Filter.1.Name": filter_name, "Filter.1.Value.1": value, "MaxResults": 100})
                with Stubber(client) as stub:
                    stub.add_response("describe_vpcs", {"Vpcs": [], "NextToken": "PAGE_TWO"}, parameters)
                    stub.add_response("describe_vpcs", {"Vpcs": [{"VpcId": vpc_id, "OwnerId": "111111111111",
                        "State": "available", "CidrBlock": "10.0.0.0/16", "Tags": [{"Key": "Name", "Value": "production-vpc"}]}]},
                        {**parameters, "NextToken": "PAGE_TWO"})
                    rows = []
                    lookup._ec2(client, self.selected, "vpc", lookup.parse_query("vpc", query), rows, float("inf"))
                    stub.assert_no_pending_responses()
                    self.assertEqual(rows, [{"profile": "test", "accountId": "111111111111", "region": "us-east-1",
                        "resourceType": "vpc", "resourceId": vpc_id, "name": "production-vpc", "arn": arn}])

    def test_real_sdk_vpc_role_assumption_has_valid_restricted_session_parameters(self):
        client = self.client("sts")
        expected = {"RoleArn": self.selected["role_arn"], "RoleSessionName": ANY, "DurationSeconds": 900,
            "Policy": json.dumps({"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
                "Action": ["ec2:DescribeVpcs"], "Resource": "*"}]}, separators=(",", ":"))}
        temporary = {"AccessKeyId": "TEST_ROLE_KEY_12345678", "SecretAccessKey": "TEST_ROLE_SECRET",
            "SessionToken": "TEST_ROLE_TOKEN", "Expiration": datetime.now(timezone.utc) + timedelta(seconds=900)}
        with Stubber(client) as stub, patch.object(self.session, "client", return_value=client):
            stub.add_response("assume_role", {"Credentials": temporary}, expected)
            returned = lookup._assume(self.session, Config, {**self.selected, "external_id": ""}, self.credentials, "vpc", float("inf"))
            stub.assert_no_pending_responses()
            self.assertEqual(returned, temporary)

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

    def test_real_sdk_dns_inventory_uses_only_page_controls_for_both_families(self):
        hostname = "internal-api-edge-123456.us-east-1.elb.amazonaws.com"
        for family, result_key in [("elbv2", "LoadBalancers"), ("elb", "LoadBalancerDescriptions")]:
            with self.subTest(family=family):
                client = self.client(family)
                item = {"LoadBalancerName": "actual-resource-name", "DNSName": hostname.upper() + "."}
                first_items = []
                if family == "elbv2":
                    item.update(LoadBalancerArn="arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/app/actual-resource-name/0123456789abcdef", Type="application")
                    first_items = [{"LoadBalancerName": "gateway", "Type": "gateway",
                        "LoadBalancerArn": "arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/gwy/gateway/0123456789abcdef"}]
                with Stubber(client) as stub:
                    stub.add_response("describe_load_balancers", {result_key: first_items, "NextMarker": "PAGE_TWO"}, {"PageSize": 100})
                    stub.add_response("describe_load_balancers", {result_key: [item]}, {"PageSize": 100, "Marker": "PAGE_TWO"})
                    rows = []
                    lookup._load_balancer_family(client, family, self.selected,
                        lookup.parse_query("load-balancer", hostname), rows, float("inf"))
                    stub.assert_no_pending_responses()
                    self.assertEqual(len(rows), 1)
                    self.assertEqual(rows[0]["accountId"], "111111111111")
                    self.assertEqual(rows[0]["name"], "actual-resource-name")
                    self.assertEqual(rows[0]["dnsName"], hostname)

    def test_real_sdk_private_ip_filter_secondary_address_pagination_and_service_metadata(self):
        client = self.client("ec2")
        self.assertEqual(client.meta.endpoint_url, "https://ec2.us-east-1.amazonaws.com")
        self.assertEqual(client._request_signer.signing_name, "ec2")
        parameters = {"Filters": [{"Name": "addresses.private-ip-address", "Values": ["10.0.1.25"]}], "MaxResults": 100}
        operation = client.meta.service_model.operation_model("DescribeNetworkInterfaces")
        serialized = client._serializer.serialize_to_request(parameters, operation)
        self.assertEqual(serialized["body"], {"Action": "DescribeNetworkInterfaces", "Version": "2016-11-15",
            "Filter.1.Name": "addresses.private-ip-address", "Filter.1.Value.1": "10.0.1.25", "MaxResults": 100})
        interface = {"NetworkInterfaceId": "eni-0123456789abcdef0", "OwnerId": "111111111111",
            "VpcId": "vpc-0123456789abcdef0", "SubnetId": "subnet-0123456789abcdef0", "PrivateIpAddress": "10.0.1.10",
            "PrivateIpAddresses": [{"PrivateIpAddress": "10.0.1.10", "Primary": True},
                                   {"PrivateIpAddress": "10.0.1.25", "Primary": False}],
            "InterfaceType": "network_load_balancer", "Description": "ELB net/example/0123456789abcdef",
            "Attachment": {"InstanceOwnerId": "amazon-aws"}, "RequesterId": "amazon-elb", "RequesterManaged": True,
            "TagSet": [{"Key": "Name", "Value": "lb-interface"}]}
        with Stubber(client) as stub:
            stub.add_response("describe_network_interfaces", {"NetworkInterfaces": [], "NextToken": "PAGE_TWO"}, parameters)
            stub.add_response("describe_network_interfaces", {"NetworkInterfaces": [interface]}, {**parameters, "NextToken": "PAGE_TWO"})
            rows = []
            lookup._private_ip(client, self.selected, lookup.parse_query("private-ip", "10.0.1.25"), rows, float("inf"))
            stub.assert_no_pending_responses()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["name"], "lb-interface")
            self.assertEqual(rows[0]["network"]["privateIpAddress"], "10.0.1.25")
            self.assertEqual(rows[0]["network"]["instanceOwnerId"], "amazon-aws")
            self.assertEqual(rows[0]["network"]["instanceId"], "")

    def test_real_sdk_private_ip_permission_failure_has_safe_diagnostic(self):
        client = self.client("ec2")
        parameters = {"Filters": [{"Name": "addresses.private-ip-address", "Values": ["10.0.1.25"]}], "MaxResults": 100}
        with Stubber(client) as stub:
            stub.add_client_error("describe_network_interfaces", service_error_code="UnauthorizedOperation",
                service_message="PRIVATE_CREDENTIAL_QUERY", expected_params=parameters)
            with self.assertRaises(Exception) as raised:
                lookup._private_ip(client, self.selected, lookup.parse_query("private-ip", "10.0.1.25"), [], float("inf"))
            failure = lookup._scan_failure(raised.exception)
            self.assertEqual(failure.status, "access_denied")
            self.assertNotIn("PRIVATE", failure.safe_message)


if __name__ == "__main__":
    unittest.main()
