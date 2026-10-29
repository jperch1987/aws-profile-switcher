#!/usr/bin/env python3
# Author: jperch1987
"""Find exact AWS resources using short-lived, restricted role sessions."""

from __future__ import annotations

import argparse
from contextlib import closing
import json
import re
import secrets
import sys
import time
import unicodedata

import aws_session
from profiles import ProfileConfigError


MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_PROFILES = 250
MAX_PAGES = 10
MAX_RESULTS = 100
PAGE_SIZE = 100
MAX_PAGE_ITEMS = 1000
SCAN_SECONDS = 540
SESSION_SECONDS = 900
READ_ACTIONS = {
    "ec2": ["ec2:DescribeInstances"],
    "ebs": ["ec2:DescribeVolumes"],
    "security-group": ["ec2:DescribeSecurityGroups"],
    "vpc": ["ec2:DescribeVpcs"],
    "s3": ["s3:ListAllMyBuckets", "s3:GetBucketLocation"],
    "rds": ["rds:DescribeDBInstances"],
    "lambda": ["lambda:GetFunctionConfiguration"],
    "eks": ["eks:DescribeCluster"],
    "elasticache": ["elasticache:DescribeCacheClusters", "elasticache:DescribeReplicationGroups", "elasticache:DescribeServerlessCaches"],
    "route53": ["route53:GetHostedZone", "route53:ListHostedZonesByName"],
    "load-balancer": ["elasticloadbalancing:DescribeLoadBalancers"],
}
LOAD_BALANCER_NAME = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?"
LOAD_BALANCER_TYPES = {"app": "application", "net": "network", "gwy": "gateway"}
LOAD_BALANCER_FAMILIES = {"elbv2": "Application/Network/Gateway", "elb": "Classic"}
ELASTICACHE_TYPES = {
    "cluster": ("describe_cache_clusters", "CacheClusterId", "CacheClusters", "MaxRecords", "Marker"),
    "replicationgroup": ("describe_replication_groups", "ReplicationGroupId", "ReplicationGroups", "MaxRecords", "Marker"),
    "serverlesscache": ("describe_serverless_caches", "ServerlessCacheName", "ServerlessCaches", "MaxResults", "NextToken"),
}
EC2_TYPES = {
    "ec2": ("instance", "i", "describe_instances", "InstanceId", "Reservations", "instance-id"),
    "ebs": ("volume", "vol", "describe_volumes", "VolumeId", "Volumes", "volume-id"),
    "security-group": ("security-group", "sg", "describe_security_groups", "GroupId", "SecurityGroups", "group-id"),
    "vpc": ("vpc", "vpc", "describe_vpcs", "VpcId", "Vpcs", "vpc-id"),
}
MESSAGES = {
    "found": "Exact resource matches were found.",
    "not_found": "No exact match was returned for this account and search scope.",
    "access_denied": "AWS denied a required read operation. This check is incomplete; confirm the role's read permissions.",
    "auth_failed": "AWS could not authenticate this role. Check its trust policy, permissions, and external ID.",
    "error": "The resource check could not finish. Check network access, AWS availability, and SDK dependencies.",
    "limit": "The scan reached its page or result limit. Shown matches are confirmed, but this check is incomplete.",
    "deadline": "The scan time limit was reached. This profile was not fully checked.",
    "arn_scope": "Skipped because the resource ARN belongs to a different account or region.",
    "invalid_response": "AWS returned unexpected resource metadata. This check is incomplete.",
}


class LookupError(ValueError):
    """Fixed safe diagnostic for request or source authentication failure."""


class ScanError(Exception):
    def __init__(self, status="error", message=None):
        super().__init__(message or MESSAGES[status])
        self.status = status
        self.safe_message = message or MESSAGES[status]


def _text(value, maximum=256, *, empty=False):
    return (isinstance(value, str) and (empty or bool(value)) and len(value) <= maximum
            and not any(unicodedata.category(character) in {"Cc", "Cs"} or character in "\u2028\u2029" for character in value))


def _id_pattern(prefix):
    return rf"{prefix}-(?:[0-9a-f]{{8}}|[0-9a-f]{{17}})"


def _bucket_name(value):
    return bool(re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", value)
                and ".." not in value and not re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}", value)
                and not value.endswith("--x-s3"))


def _zone_id(value):
    if not isinstance(value, str):
        return None
    value = value.removeprefix("/hostedzone/")
    return value if re.fullmatch(r"Z[A-Z0-9]{1,31}", value) else None


def _dns_name(value):
    # Use ASCII/Punycode domain names; ignore DNS case and a single root dot.
    if not isinstance(value, str) or not value.isascii():
        return None
    value = value.removesuffix(".").lower()
    if not 1 <= len(value) <= 253:
        return None
    if all(re.fullmatch(r"[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?", label) for label in value.split(".")):
        return value + "."
    return None


def parse_query(resource_type, query):
    if not isinstance(resource_type, str) or resource_type not in READ_ACTIONS or not _text(query) or query != query.strip():
        raise LookupError("Choose a supported resource type and enter an exact name, ID, or ARN using at most 256 single-line characters.")
    result = {"query": query, "value": query, "account": None, "region": None, "arn": None}
    if query.startswith("arn:"):
        parts = query.split(":", 5)
        if len(parts) != 6 or parts[:2] != ["arn", "aws"]:
            raise LookupError("Use a supported commercial AWS resource ARN.")
        _, _, service, region, account, resource = parts
        if resource_type == "s3":
            if service != "s3" or region or account or not _bucket_name(resource):
                raise LookupError("Use a general-purpose S3 bucket name or bucket ARN, without an object path.")
            result["value"] = resource
        elif resource_type == "route53":
            match = re.fullmatch(r"hostedzone/(Z[A-Z0-9]{1,31})", resource)
            if service != "route53" or region or account or not match:
                raise LookupError("Use a Route 53 hosted zone ARN, without an account ID or region.")
            result["value"] = match.group(1)
        else:
            if not aws_session.REGION_PATTERN.fullmatch(region) or not re.fullmatch(r"[0-9]{12}", account):
                raise LookupError("The resource ARN must contain a supported region and a twelve-digit account ID.")
            if resource_type in EC2_TYPES:
                kind, prefix, *_ = EC2_TYPES[resource_type]
                match = re.fullmatch(rf"{kind}/({_id_pattern(prefix)})", resource)
                if service != "ec2" or not match:
                    raise LookupError("The resource ARN does not match the selected resource type.")
                result["value"] = match.group(1)
            elif resource_type == "elasticache":
                match = re.fullmatch(r"(cluster|replicationgroup|serverlesscache):([^:]+)", resource)
                if service != "elasticache" or not match:
                    raise LookupError("Use an ElastiCache cache cluster, replication group, or serverless cache ARN.")
                result.update(kind=match.group(1), value=match.group(2))
            elif resource_type == "load-balancer":
                modern = re.fullmatch(rf"loadbalancer/(app|net|gwy)/({LOAD_BALANCER_NAME})/([0-9a-f]{{16}})", resource)
                classic = re.fullmatch(rf"loadbalancer/({LOAD_BALANCER_NAME})", resource)
                if service != "elasticloadbalancing" or not (modern or classic):
                    raise LookupError("Use an Application, Network, Gateway, or Classic Load Balancer ARN, without a listener or target group path.")
                if modern:
                    result.update(kind="elbv2", value=modern.group(2), loadBalancerType=modern.group(1))
                else:
                    result.update(kind="elb", value=classic.group(1))
            else:
                prefix = {"rds": "db:", "lambda": "function:", "eks": "cluster/"}[resource_type]
                if service != resource_type or not resource.startswith(prefix):
                    raise LookupError("The resource ARN does not match the selected resource type.")
                result["value"] = resource[len(prefix):]
            result.update(account=account, region=region)
        result["arn"] = query
    value = result["value"]
    if resource_type == "s3" and not _bucket_name(value):
        raise LookupError("Enter an exact general-purpose S3 bucket name or bucket ARN.")
    if resource_type == "lambda" and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
        raise LookupError("Enter a Lambda function name or unqualified function ARN, without an alias or version.")
    if resource_type == "rds" and (not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,62}", value) or value.endswith("-") or "--" in value):
        raise LookupError("Enter an RDS DB instance identifier or DB instance ARN.")
    if resource_type == "eks" and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", value):
        raise LookupError("Enter an EKS cluster name or cluster ARN.")
    if resource_type == "load-balancer":
        if not re.fullmatch(LOAD_BALANCER_NAME, value):
            raise LookupError("Enter an exact load balancer name of at most 32 letters, numbers, or hyphens, or its ARN.")
        if result.get("kind") == "elbv2" and value.startswith("internal-"):
            raise LookupError("Application, Network, and Gateway Load Balancer names cannot begin with internal-.")
    if resource_type == "elasticache":
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,49}", value) or value.endswith("-") or "--" in value:
            raise LookupError("Enter an ElastiCache cache cluster, replication group, or serverless cache name or ARN.")
        if result.get("kind") in {"replicationgroup", "serverlesscache"} and len(value) > 40:
            raise LookupError("ElastiCache replication group and serverless cache identifiers contain at most 40 characters.")
        result["value"] = value.lower()
    if resource_type == "route53":
        zone_id = _zone_id(value)
        if zone_id:
            result.update(value=zone_id, kind="id")
        else:
            domain = _dns_name(value)
            if not domain:
                raise LookupError("Enter a Route 53 hosted zone ID, hosted zone ARN, or an ASCII/Punycode domain name.")
            result.update(value=domain, kind="name")
    return result


def validate_request(config_file, payload):
    if not isinstance(payload, dict) or set(payload) != {"profiles", "resourceType", "query", "mfaCode"}:
        raise LookupError("Invalid resource lookup request.")
    names = payload["profiles"]
    if (not isinstance(names, list) or not 1 <= len(names) <= MAX_PROFILES
            or any(not _text(name, 2048) for name in names) or len(set(names)) != len(names)):
        raise LookupError("Select between one and 250 unique role profiles.")
    if not isinstance(payload["mfaCode"], str) or not re.fullmatch(r"[0-9]{6}", payload["mfaCode"]):
        raise LookupError("Enter a fresh six-digit MFA code for the selected source profile.")
    query = parse_query(payload["resourceType"], payload["query"])
    try:
        config = aws_session.read_profiles(config_file)
        profiles = [aws_session._selected_profile(config_file, name, config=config) for name in names]
    except (aws_session.SessionError, ProfileConfigError):
        raise LookupError("A selected role profile is missing or invalid. Check its role, source profile, MFA device, and region, then refresh.") from None
    if len({(profile["source_profile"], profile["mfa_serial"]) for profile in profiles}) != 1:
        raise LookupError("Selected profiles must use the same source profile and MFA device. Search each source group separately.")
    return profiles, payload["resourceType"], query


def _error_code(error):
    response = getattr(error, "response", None)
    detail = response.get("Error") if isinstance(response, dict) else None
    code = detail.get("Code") if isinstance(detail, dict) else None
    return code if isinstance(code, str) else None


def _scan_failure(error, *, authenticating=False):
    if isinstance(error, ScanError):
        return error
    code = _error_code(error)
    if authenticating:
        return ScanError("auth_failed")
    if code in {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "AuthorizationError", "Forbidden", "403"}:
        return ScanError("access_denied")
    if code in {"ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId", "UnrecognizedClientException", "SignatureDoesNotMatch"}:
        return ScanError("auth_failed")
    if code in {"DBInstanceNotFound", "DBInstanceNotFoundFault", "ResourceNotFoundException", "NoSuchBucket", "InvalidInstanceID.NotFound", "InvalidVolume.NotFound", "InvalidGroup.NotFound", "InvalidVpcID.NotFound", "CacheClusterNotFound", "CacheClusterNotFoundFault", "ReplicationGroupNotFound", "ReplicationGroupNotFoundFault", "ServerlessCacheNotFoundFault", "NoSuchHostedZone", "LoadBalancerNotFound", "LoadBalancerNotFoundException"}:
        return ScanError("not_found")
    return ScanError("error")


def _before_call(deadline):
    if time.monotonic() >= deadline:
        raise ScanError("skipped", MESSAGES["deadline"])


def _call(client, operation, parameters, deadline):
    _before_call(deadline)
    return getattr(client, operation)(**parameters)


def _client(session, config_class, service, region, credentials):
    options = {
        "signature_version": "v4", "connect_timeout": 3, "read_timeout": 5,
        "retries": {"total_max_attempts": 1}, "proxies": {}, "ignore_configured_endpoint_urls": True,
    }
    if service == "s3":
        options["s3"] = {"addressing_style": "path", "us_east_1_regional_endpoint": "regional"}
    endpoint = f"https://{service}.{region}.amazonaws.com"
    if service == "route53":
        region, endpoint = "us-east-1", "https://route53.amazonaws.com"
    elif service in {"elb", "elbv2"}:
        endpoint = f"https://elasticloadbalancing.{region}.amazonaws.com"
    return session.client(service, region_name=region, endpoint_url=endpoint, verify=True,
                          aws_access_key_id=credentials["AccessKeyId"], aws_secret_access_key=credentials["SecretAccessKey"],
                          aws_session_token=credentials.get("SessionToken"), config=config_class(**options))


def _source_session(boto3, config_class, selected, mfa_code, deadline):
    session = boto3.Session(profile_name=selected["source_profile"], region_name=selected["region"])
    source = session._session.get_scoped_config()
    aws_session._validate_source_config(source)
    provider = session.get_credentials()
    if provider is None or provider.method not in {"shared-credentials-file", "config-file"}:
        raise LookupError("The source profile must use IAM-user keys from the local AWS credentials or config file.")
    frozen = provider.get_frozen_credentials()
    if frozen.token:
        raise LookupError("Use long-term IAM-user keys for the source profile.")
    credentials = {"AccessKeyId": frozen.access_key, "SecretAccessKey": frozen.secret_key}
    with closing(_client(session, config_class, "sts", selected["region"], credentials)) as client:
        response = _call(client, "get_session_token", {"DurationSeconds": SESSION_SECONDS, "SerialNumber": selected["mfa_serial"], "TokenCode": mfa_code}, deadline)
    temporary = aws_session._credentials(response)
    return session, temporary


def _assume(session, config_class, selected, source_credentials, resource_type, deadline):
    policy = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": READ_ACTIONS[resource_type], "Resource": "*"}]}
    parameters = {"RoleArn": selected["role_arn"], "RoleSessionName": f"resource-lookup-{secrets.token_hex(8)}",
                  "DurationSeconds": SESSION_SECONDS, "Policy": json.dumps(policy, separators=(",", ":"))}
    if selected["external_id"]:
        parameters["ExternalId"] = selected["external_id"]
    with closing(_client(session, config_class, "sts", selected["region"], source_credentials)) as client:
        response = _call(client, "assume_role", parameters, deadline)
    return aws_session._credentials(response)


def _list(response, key):
    value = response.get(key) if isinstance(response, dict) else None
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ScanError("error", MESSAGES["invalid_response"])
    return value


def _pages(client, operation, parameters, deadline, token_key="NextToken", request_token_key=None):
    seen = set()
    for page_number in range(MAX_PAGES):
        try:
            response = _call(client, operation, parameters, deadline)
        except Exception as error:
            # A later-page disappearance cannot establish that the complete
            # targeted result set was checked, even if an earlier page was empty.
            if page_number and _scan_failure(error).status == "not_found":
                raise ScanError("error") from None
            raise
        if not isinstance(response, dict):
            raise ScanError("error", MESSAGES["invalid_response"])
        yield response
        token = response.get(token_key)
        if not token:
            return
        if not isinstance(token, str) or len(token) > 16384 or token in seen:
            raise ScanError("error", MESSAGES["limit"])
        seen.add(token)
        parameters = {**parameters, request_token_key or token_key: token}
    raise ScanError("error", MESSAGES["limit"])


def _name_tag(item):
    tags = item.get("Tags", [])
    if not isinstance(tags, list):
        raise ScanError("error", MESSAGES["invalid_response"])
    for tag in tags:
        if isinstance(tag, dict) and tag.get("Key") == "Name":
            value = tag.get("Value")
            if not _text(value, empty=True):
                raise ScanError("error", MESSAGES["invalid_response"])
            return value
    return ""


def _owned_by(item, account):
    owner = item.get("OwnerId")
    if not isinstance(owner, str) or not re.fullmatch(r"[0-9]{12}", owner):
        raise ScanError("error", MESSAGES["invalid_response"])
    return owner == account


def _row(selected, resource_type, resource_id, name, arn, region=None):
    if not _text(resource_id) or not _text(name, empty=True) or not _text(arn, 512):
        raise ScanError("error", MESSAGES["invalid_response"])
    return {"profile": selected["profile"], "accountId": selected["role_arn"].split(":")[4],
            "region": region or selected["region"], "resourceType": resource_type,
            "resourceId": resource_id, "name": name, "arn": arn}


def _add(rows, row):
    if any(existing["arn"] == row["arn"] for existing in rows):
        return
    if len(rows) >= MAX_RESULTS:
        raise ScanError("error", MESSAGES["limit"])
    rows.append(row)


def _ec2(client, selected, resource_type, query, rows, deadline):
    kind, prefix, operation, id_key, response_key, id_filter = EC2_TYPES[resource_type]
    exact_id = bool(re.fullmatch(_id_pattern(prefix), query["value"]))
    filters = [id_filter] if exact_id else (["group-name", "tag:Name"] if resource_type == "security-group" else ["tag:Name"])
    account = selected["role_arn"].split(":")[4]
    for filter_name in filters:
        parameters = {"Filters": [{"Name": filter_name, "Values": [query["value"]]}], "MaxResults": PAGE_SIZE}
        for page in _pages(client, operation, parameters, deadline):
            entries = _list(page, response_key)
            if len(entries) > MAX_PAGE_ITEMS:
                raise ScanError("error", MESSAGES["limit"])
            items = []
            for entry in entries:
                if resource_type == "ec2":
                    if not _owned_by(entry, account):
                        continue
                    items.extend(_list(entry, "Instances"))
                else:
                    items.append(entry)
            if len(items) > MAX_PAGE_ITEMS:
                raise ScanError("error", MESSAGES["limit"])
            for item in items:
                if resource_type in {"security-group", "vpc"} and not _owned_by(item, account):
                    continue
                resource_id = item.get(id_key)
                if not isinstance(resource_id, str) or not re.fullmatch(_id_pattern(prefix), resource_id):
                    raise ScanError("error", MESSAGES["invalid_response"])
                name = _name_tag(item)
                group_name = item.get("GroupName", "") if resource_type == "security-group" else ""
                if exact_id:
                    matched = resource_id == query["value"]
                else:
                    matched = query["value"] in {name, group_name} if resource_type == "security-group" else name == query["value"]
                if matched:
                    arn = f"arn:aws:ec2:{selected['region']}:{account}:{kind}/{resource_id}"
                    _add(rows, _row(selected, resource_type, resource_id, name or group_name, arn))


def _s3(client, selected, query, rows, deadline):
    name = query["value"]
    parameters = {"Prefix": name, "MaxBuckets": PAGE_SIZE}
    seen = set()
    for page_number in range(MAX_PAGES):
        try:
            response = _call(client, "list_buckets", parameters, deadline)
        except Exception as error:
            # Older SDKs do not know the optional paginated ListBuckets fields.
            # Their one legacy response is inspected only to a fixed item cap.
            if page_number != 0 or type(error).__name__ != "ParamValidationError":
                raise
            parameters = {}
            response = _call(client, "list_buckets", parameters, deadline)
        buckets = _list(response, "Buckets")
        for bucket in buckets[:MAX_PAGE_ITEMS]:
            if bucket.get("Name") != name:
                continue
            row = _row(selected, "s3", name, name, f"arn:aws:s3:::{name}", "unknown")
            _add(rows, row)
            region = bucket.get("BucketRegion")
            if not region:
                location = _call(client, "get_bucket_location", {"Bucket": name, "ExpectedBucketOwner": row["accountId"]}, deadline)
                if not isinstance(location, dict) or "LocationConstraint" not in location:
                    raise ScanError("error", MESSAGES["invalid_response"])
                region = location["LocationConstraint"]
                region = "us-east-1" if region is None else "eu-west-1" if region == "EU" else region
            if not isinstance(region, str) or not aws_session.REGION_PATTERN.fullmatch(region):
                raise ScanError("error", MESSAGES["invalid_response"])
            row["region"] = region
            return  # Bucket names are globally unique; ownership is confirmed by ListBuckets.
        if len(buckets) > MAX_PAGE_ITEMS:
            raise ScanError("error", MESSAGES["limit"])
        token = response.get("ContinuationToken")
        if not token:
            return
        if not parameters or not isinstance(token, str) or len(token) > 16384 or token in seen:
            raise ScanError("error", MESSAGES["limit"])
        seen.add(token)
        parameters["ContinuationToken"] = token
    raise ScanError("error", MESSAGES["limit"])


def _rds(client, selected, query, rows, deadline):
    parameters = {"DBInstanceIdentifier": query["arn"] or query["value"], "MaxRecords": PAGE_SIZE}
    for response in _pages(client, "describe_db_instances", parameters, deadline, "Marker"):
        instances = _list(response, "DBInstances")
        if len(instances) > MAX_PAGE_ITEMS:
            raise ScanError("error", MESSAGES["limit"])
        for item in instances:
            identifier, arn = item.get("DBInstanceIdentifier"), item.get("DBInstanceArn")
            if not isinstance(identifier, str) or identifier.casefold() != query["value"].casefold():
                raise ScanError("error", MESSAGES["invalid_response"])
            expected = f"arn:aws:rds:{selected['region']}:{selected['role_arn'].split(':')[4]}:db:{identifier}"
            if arn != expected:
                raise ScanError("error", MESSAGES["invalid_response"])
            if item.get("Engine") in {"neptune", "docdb"}:
                continue
            _add(rows, _row(selected, "rds", identifier, identifier, arn))


def _lambda(client, selected, query, rows, deadline):
    response = _call(client, "get_function_configuration", {"FunctionName": query["arn"] or query["value"]}, deadline)
    expected = f"arn:aws:lambda:{selected['region']}:{selected['role_arn'].split(':')[4]}:function:{query['value']}"
    if not isinstance(response, dict) or response.get("FunctionName") != query["value"] or response.get("FunctionArn") != expected:
        raise ScanError("error", MESSAGES["invalid_response"])
    _add(rows, _row(selected, "lambda", query["value"], query["value"], expected))


def _eks(client, selected, query, rows, deadline):
    response = _call(client, "describe_cluster", {"name": query["value"]}, deadline)
    cluster = response.get("cluster") if isinstance(response, dict) else None
    expected = f"arn:aws:eks:{selected['region']}:{selected['role_arn'].split(':')[4]}:cluster/{query['value']}"
    if not isinstance(cluster, dict) or cluster.get("name") != query["value"] or cluster.get("arn") != expected:
        raise ScanError("error", MESSAGES["invalid_response"])
    _add(rows, _row(selected, "eks", query["value"], query["value"], expected))


def _elasticache(client, selected, query, rows, deadline):
    failure = None
    kinds = [query["kind"]] if query.get("kind") else ELASTICACHE_TYPES
    for kind in kinds:
        # Only cache clusters support names longer than 40 characters.
        if kind in {"replicationgroup", "serverlesscache"} and len(query["value"]) > 40:
            continue
        operation, id_key, response_key, size_key, token_key = ELASTICACHE_TYPES[kind]
        parameters = {id_key: query["value"], size_key: PAGE_SIZE}
        try:
            for page in _pages(client, operation, parameters, deadline, token_key):
                caches = _list(page, response_key)
                if len(caches) > MAX_PAGE_ITEMS:
                    raise ScanError("error", MESSAGES["limit"])
                for cache in caches:
                    identifier, arn = cache.get(id_key), cache.get("ARN")
                    expected = f"arn:aws:elasticache:{selected['region']}:{selected['role_arn'].split(':')[4]}:{kind}:{query['value']}"
                    if not isinstance(identifier, str) or identifier != query["value"] or arn != expected:
                        raise ScanError("error", MESSAGES["invalid_response"])
                    _add(rows, _row(selected, "elasticache", identifier, identifier, arn))
        except Exception as error:
            current = _scan_failure(error)
            if current.status == "not_found":
                continue
            if current.status in {"auth_failed", "skipped"}:
                raise current
            # A name can exist in more than one subtype. Preserve later matches
            # even if another subtype is denied, but report an incomplete check.
            if failure is None:
                failure = current
    if failure is not None:
        raise failure


def _load_balancer_family(client, family, selected, query, rows, deadline):
    if family == "elbv2":
        parameters = {"LoadBalancerArns": [query["arn"]]} if query["arn"] else {"Names": [query["value"]]}
        response_key = "LoadBalancers"
    else:
        parameters = {"LoadBalancerNames": [query["value"]]}
        response_key = "LoadBalancerDescriptions"
    parameters["PageSize"] = PAGE_SIZE
    account = selected["role_arn"].split(":")[4]
    for page in _pages(client, "describe_load_balancers", parameters, deadline, "NextMarker", "Marker"):
        balancers = _list(page, response_key)
        if len(balancers) > MAX_PAGE_ITEMS:
            raise ScanError("error", MESSAGES["limit"])
        for balancer in balancers:
            name = balancer.get("LoadBalancerName")
            if name != query["value"]:
                raise ScanError("error", MESSAGES["invalid_response"])
            if family == "elbv2":
                arn = balancer.get("LoadBalancerArn")
                try:
                    found = parse_query("load-balancer", arn)
                except LookupError:
                    raise ScanError("error", MESSAGES["invalid_response"]) from None
                if (found.get("kind") != "elbv2" or found["value"] != name
                        or found["account"] != account or found["region"] != selected["region"]
                        or balancer.get("Type") != LOAD_BALANCER_TYPES[found["loadBalancerType"]]
                        or (query["arn"] and arn != query["arn"])):
                    raise ScanError("error", MESSAGES["invalid_response"])
            else:
                # Classic DescribeLoadBalancers returns only this role account's
                # resources, without an ARN. Construct the documented ARN only
                # after the exact name is confirmed by that authenticated call.
                arn = f"arn:aws:elasticloadbalancing:{selected['region']}:{account}:loadbalancer/{name}"
            _add(rows, _row(selected, "load-balancer", name, name, arn))


def _load_balancer_failure(error, stage):
    """Explain a failed step using fixed text, never exception or AWS messages."""
    failure = _scan_failure(error)
    step = "Client setup failed" if stage == "client" else "Read request failed"
    if isinstance(error, ScanError):
        # These diagnostics are produced by our metadata/pagination/deadline
        # checks. Do not forward arbitrary custom exception messages.
        message = error.safe_message if error.safe_message in MESSAGES.values() else MESSAGES["error"]
        return ScanError(failure.status, message)
    code = _error_code(error)
    if code in {"AccessDenied", "AccessDeniedException", "AccessDeniedFault", "UnauthorizedOperation", "AuthorizationError", "Forbidden", "ForbiddenException", "403"}:
        return ScanError("access_denied", f"{step}: Read permission denied ({code}). Allow elasticloadbalancing:DescribeLoadBalancers on the role.")
    if code in {"ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId", "UnrecognizedClientException", "SignatureDoesNotMatch", "InvalidSignatureException"}:
        return ScanError("auth_failed", f"{step}: AWS rejected the temporary session ({code}). Retry the lookup with a fresh MFA code.")
    if code in {"ValidationError", "InvalidParameter", "InvalidParameterValue", "InvalidParameterCombination", "InvalidConfigurationRequest"}:
        reason = f"AWS rejected the lookup parameters ({code}). Check the load balancer name or ARN and app version."
    elif code in {"Throttling", "ThrottlingException", "RequestLimitExceeded", "DependencyThrottle"}:
        reason = f"AWS limited the lookup requests ({code}). Wait briefly and retry."
    elif code in {"ServiceUnavailable", "ServiceUnavailableException", "InternalFailure", "InternalError"}:
        reason = f"AWS could not complete the lookup ({code}). Retry later."
    else:
        # Matching only known class names also supports SDK-free unit tests.
        # Unknown names, paths, request IDs, signed URLs, and raw messages stay private.
        exception_name = type(error).__name__
        network_messages = {
            "EndpointConnectionError": "Could not connect to the regional AWS load balancing endpoint.",
            "ConnectTimeoutError": "Connection to the regional AWS load balancing endpoint timed out.",
            "ReadTimeoutError": "AWS did not reply before the read timeout.",
            "ConnectionClosedError": "The AWS connection closed before the response finished.",
            "SSLError": "The TLS connection or certificate verification failed.",
            "ProxyConnectionError": "A proxy connection failed.",
            "ResponseParserError": "AWS returned a response that the Python SDK could not read.",
            "ParamValidationError": "The Python SDK rejected the lookup parameters. Update the app and its Python dependencies.",
            "UnknownSignatureVersionError": "The Python SDK could not use the required request signing method.",
            "UnsupportedSignatureVersionError": "The Python SDK could not use the required request signing method.",
            "EndpointResolutionError": "The Python SDK could not resolve the AWS endpoint settings.",
            "InvalidEndpointConfigurationError": "The Python SDK could not resolve the AWS endpoint settings.",
        }
        if exception_name in network_messages:
            reason = network_messages[exception_name]
        elif exception_name in {"UnknownServiceError", "DataNotFoundError", "UnknownAPIVersionError", "UnknownEndpointError", "ImportError", "ModuleNotFoundError"}:
            reason = "The Python AWS SDK service data is missing or unsupported. Reinstall requirements.txt."
        elif exception_name in {"NoCredentialsError", "PartialCredentialsError", "CredentialRetrievalError"}:
            return ScanError("auth_failed", f"{step}: The Python SDK could not use the temporary role credentials. Retry with a fresh MFA code.")
        elif exception_name in {"TypeError", "AttributeError", "KeyError", "ValueError"}:
            reason = f"Unexpected application or SDK error ({exception_name}). Update the app and its Python dependencies."
        elif code is not None:
            reason = "AWS returned an unrecognized service error. This check is incomplete."
        else:
            reason = "Unexpected application or SDK failure. This check is incomplete."
    return ScanError(failure.status, f"{step}: {reason}")


def _load_balancers(session, config_class, selected, query, rows, deadline, credentials):
    failure = None
    explanations = []
    families = [query["kind"]] if query.get("kind") else ["elbv2", "elb"]
    for family in families:
        if family == "elbv2" and query["value"].startswith("internal-"):
            continue  # Reserved by ELBv2, but valid for Classic Load Balancers.
        stage = "client"
        try:
            with closing(_client(session, config_class, family, selected["region"], credentials)) as client:
                stage = "read"
                _load_balancer_family(client, family, selected, query, rows, deadline)
        except Exception as error:
            current = _scan_failure(error)
            if current.status == "not_found":
                continue
            current = _load_balancer_failure(error, stage)
            explanations.append(f"{LOAD_BALANCER_FAMILIES[family]}: {current.safe_message}")
            if current.status in {"auth_failed", "skipped"}:
                raise ScanError(current.status, "; ".join(explanations)[:500]) from None
            # Plain names can exist in both APIs. Continue to preserve matches,
            # while keeping any denial or failed family explicitly incomplete.
            if failure is None:
                failure = current
    if failure is not None:
        raise ScanError(failure.status, "; ".join(explanations)[:500])


def _route53(client, selected, query, rows, deadline):
    target_id = query["value"] if query["kind"] == "id" else None
    if target_id:
        response = _call(client, "get_hosted_zone", {"Id": target_id}, deadline)
        zone = response.get("HostedZone") if isinstance(response, dict) else None
        if not isinstance(zone, dict) or _zone_id(zone.get("Id")) != target_id:
            raise ScanError("error", MESSAGES["invalid_response"])
        name = _dns_name(zone.get("Name"))
        if not name:
            raise ScanError("error", MESSAGES["invalid_response"])
    else:
        name = query["value"]
    # These listings contain zones created by the current account. Confirm an
    # ID lookup here too: hosted zone ARNs do not themselves contain an owner.
    parameters = {"DNSName": name, "MaxItems": str(PAGE_SIZE)}
    seen = set()
    for _ in range(MAX_PAGES):
        response = _call(client, "list_hosted_zones_by_name", parameters, deadline)
        zones = _list(response, "HostedZones")
        if len(zones) > MAX_PAGE_ITEMS:
            raise ScanError("error", MESSAGES["limit"])
        for zone in zones:
            raw_name = zone.get("Name")
            if not _text(raw_name, 1024):
                raise ScanError("error", MESSAGES["invalid_response"])
            # Unrelated zones may use Route 53 escape sequences outside this
            # search's supported ASCII/Punycode input. The ordered exact-name
            # range has already ended, so their other metadata is irrelevant.
            if raw_name.removesuffix(".").lower() != name.removesuffix("."):
                return
            zone_id, zone_name = _zone_id(zone.get("Id")), _dns_name(raw_name)
            if not zone_id or not zone_name:
                raise ScanError("error", MESSAGES["invalid_response"])
            if target_id and zone_id != target_id:
                continue
            _add(rows, _row(selected, "route53", zone_id, zone_name.removesuffix("."),
                            f"arn:aws:route53:::hostedzone/{zone_id}", "global"))
            if target_id:
                return
        truncated = response.get("IsTruncated")
        if not isinstance(truncated, bool):
            raise ScanError("error", MESSAGES["invalid_response"])
        if not truncated:
            return
        raw_next_name = response.get("NextDNSName")
        if not _text(raw_next_name, 1024):
            raise ScanError("error", MESSAGES["invalid_response"])
        if raw_next_name.removesuffix(".").lower() != name.removesuffix("."):
            return
        next_name, next_id = _dns_name(raw_next_name), _zone_id(response.get("NextHostedZoneId"))
        if not next_name or not next_id:
            raise ScanError("error", MESSAGES["invalid_response"])
        cursor = (next_name, next_id)
        if cursor in seen:
            raise ScanError("error", MESSAGES["limit"])
        seen.add(cursor)
        parameters = {"DNSName": next_name, "HostedZoneId": next_id, "MaxItems": str(PAGE_SIZE)}
    raise ScanError("error", MESSAGES["limit"])


def _emit_check(emit, selected, status, rows, message=None):
    emit({"event": "profile", "check": {"profile": selected["profile"],
          "accountId": selected["role_arn"].split(":")[4], "region": selected["region"],
          "status": status, "message": message or MESSAGES[status]}, "results": rows})


def scan(config_file, payload, emit):
    profiles, resource_type, query = validate_request(config_file, payload)
    deadline = time.monotonic() + SCAN_SECONDS
    candidates = []
    for selected in profiles:
        if ((query["account"] and query["account"] != selected["role_arn"].split(":")[4])
                or (query["region"] and query["region"] != selected["region"])):
            _emit_check(emit, selected, "skipped", [], MESSAGES["arn_scope"])
        else:
            candidates.append(selected)
    if not candidates:
        emit({"event": "complete"})
        return
    try:
        boto3, config_class = aws_session._sdk()
    except aws_session.SessionError:
        raise LookupError("Install the Python dependencies in the app's virtual environment before searching resources.") from None
    with aws_session._isolated_aws_environment(profiles[0]["file"]):
        try:
            session, source_credentials = _source_session(boto3, config_class, candidates[0], payload["mfaCode"], deadline)
        except ScanError as error:
            if error.status == "skipped":
                for selected in candidates:
                    _emit_check(emit, selected, "skipped", [], MESSAGES["deadline"])
                emit({"event": "complete"})
                return
            raise LookupError("Source authentication failed. Check the IAM-user keys and MFA device, then retry with a fresh MFA code.") from None
        except Exception:
            raise LookupError("Source authentication failed. Check the IAM-user keys and MFA device, then retry with a fresh MFA code.") from None
        finally:
            payload["mfaCode"] = ""
        try:
            for selected in candidates:
                rows = []
                if time.monotonic() >= deadline:
                    _emit_check(emit, selected, "skipped", rows, MESSAGES["deadline"])
                    continue
                try:
                    credentials = _assume(session, config_class, selected, source_credentials, resource_type, deadline)
                except Exception as error:
                    failure = _scan_failure(error, authenticating=True)
                    _emit_check(emit, selected, failure.status, rows, failure.safe_message)
                    continue
                try:
                    if resource_type == "load-balancer":
                        _load_balancers(session, config_class, selected, query, rows, deadline, credentials)
                    else:
                        service = "ec2" if resource_type in EC2_TYPES else resource_type
                        with closing(_client(session, config_class, service, selected["region"], credentials)) as client:
                            if resource_type in EC2_TYPES:
                                _ec2(client, selected, resource_type, query, rows, deadline)
                            elif resource_type == "s3":
                                _s3(client, selected, query, rows, deadline)
                            elif resource_type == "rds":
                                _rds(client, selected, query, rows, deadline)
                            elif resource_type == "lambda":
                                _lambda(client, selected, query, rows, deadline)
                            elif resource_type == "eks":
                                _eks(client, selected, query, rows, deadline)
                            elif resource_type == "elasticache":
                                _elasticache(client, selected, query, rows, deadline)
                            else:
                                _route53(client, selected, query, rows, deadline)
                    _emit_check(emit, selected, "found" if rows else "not_found", rows)
                except Exception as error:
                    failure = _scan_failure(error)
                    if rows and failure.status == "not_found":
                        failure = ScanError("error")
                    _emit_check(emit, selected, failure.status, rows, failure.safe_message)
                finally:
                    credentials.clear()
        finally:
            source_credentials.clear()
    emit({"event": "complete"})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True)
    args = parser.parse_args(argv)
    def emit(event):
        print(json.dumps(event, ensure_ascii=True, separators=(",", ":")), flush=True)
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise LookupError("The resource lookup request is too large.")
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeError):
            raise LookupError("Invalid resource lookup request.") from None
        scan(args.file, payload, emit)
    except LookupError as error:
        emit({"event": "error", "message": str(error)})
        return 1
    except Exception:
        emit({"event": "error", "message": "Resource lookup could not finish. Check the app configuration and Python dependencies."})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
