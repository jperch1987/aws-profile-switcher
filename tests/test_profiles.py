# Author: jperch1987
"""Behavior tests for the local AWS metadata reader (no AWS access needed)."""

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import profiles


class ProfileParsingTests(unittest.TestCase):
    def test_standard_profiles_comments_and_allowlist(self):
        result = profiles.parse_profiles("""
# Comment
[default]
region = us-east-1
aws_access_key_id = SECRET_ACCESS_KEY
aws_secret_access_key = SECRET_PRIVATE_KEY

; Another comment
[profile dev]
role_arn = arn:aws:iam::111111111111:role/Developer
source_profile = default
region = ap-southeast-1
credential_process = NEVER_RUN_THIS
""")
        self.assertEqual(result, [
            {"profile": "default", "role_arn": "", "source_profile": "", "region": "us-east-1"},
            {"profile": "dev", "role_arn": "arn:aws:iam::111111111111:role/Developer",
             "source_profile": "default", "region": "ap-southeast-1"},
        ])
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertNotIn("NEVER_RUN", json.dumps(result))

    def test_default_and_source_profiles_do_not_inherit_values(self):
        result = profiles.parse_profiles("""
[DEFAULT]
region = injected-region
role_arn = injected-role
[default]
region = us-east-1
[profile child]
source_profile = default
""")
        self.assertEqual(result[0]["role_arn"], "")
        self.assertEqual(result[1], {
            "profile": "child", "role_arn": "", "source_profile": "default", "region": ""
        })

    def test_other_sections_are_ignored(self):
        result = profiles.parse_profiles("""
[sso-session company]
sso_start_url = https://example.awsapps.com/start
[services local]
s3 =
  endpoint_url = http://localhost:4566
[legacy-name]
region = nowhere
[profile dev]
region = us-west-2
""")
        self.assertEqual([item["profile"] for item in result], ["dev"])

    def test_quoted_profile_name_and_literal_metadata(self):
        result = profiles.parse_profiles(r"""
[profile "dev's \"laptop\""]
role_arn = arn:aws:iam::111111111111:role/100%Developer
source_profile = "base"
region = %(do_not_interpolate)s
""")
        self.assertEqual(result[0]["profile"], "dev's \"laptop\"")
        self.assertTrue(result[0]["role_arn"].endswith("100%Developer"))
        self.assertEqual(result[0]["source_profile"], '"base"')
        self.assertEqual(result[0]["region"], "%(do_not_interpolate)s")
        self.assertEqual(json.loads(json.dumps(result)), result)

    def test_quoted_and_escaped_profile_names_follow_aws_semantics(self):
        result = profiles.parse_profiles(r"""
[profile "team dev"]
[profile 'team production']
[profile escaped\ space]
""")
        self.assertEqual([item["profile"] for item in result], [
            "team dev", "team production", "escaped space"
        ])

    def test_malformed_profile_names_are_rejected_without_echoing_values(self):
        for section in ('profile "SECRET', "profile SECRET two", "profile 'SECRET", 'profile ""'):
            with self.subTest(section=section):
                with self.assertRaises(profiles.ProfileConfigError) as error:
                    profiles.parse_profiles(f"[{section}]\nregion = us-east-1")
                self.assertNotIn("SECRET", str(error.exception))

    def test_duplicate_sections_options_and_normalized_names_are_rejected(self):
        fixtures = [
            "[profile dev]\nregion = a\n[profile dev]\nregion = b",
            "[profile dev]\nregion = a\nREGION = b",
            "[profile dev]\nregion = a\n[profile  dev ]\nregion = b",
            "[default]\nregion = a\n[profile default]\nregion = b",
            '[profile dev]\nregion = a\n[profile "dev"]\nregion = b',
        ]
        for fixture in fixtures:
            with self.subTest(fixture=fixture), self.assertRaises(profiles.ProfileConfigError):
                profiles.parse_profiles(fixture)

    def test_malformed_config_diagnostics_do_not_reveal_source(self):
        for fixture in (
            "SECRET_ACCESS_KEY_WITHOUT_SECTION",
            "[profile dev]\nSECRET_PRIVATE_KEY_WITHOUT_EQUALS",
            "[profile dev]\naws_secret_access_key = SECRET_A\naws_secret_access_key = SECRET_B",
        ):
            with self.subTest(fixture=fixture):
                with self.assertRaises(profiles.ProfileConfigError) as error:
                    profiles.parse_profiles(fixture)
                self.assertNotIn("SECRET", str(error.exception))

    def test_multiline_and_control_characters_are_rejected(self):
        fixtures = [
            "[profile dev]\nregion = us-east-1\n  second-line",
            "[profile dev]\nregion = us\x00-east-1",
            "[profile dev]\nsource_profile = base\tprofile",
            "[profile de\x1bv]\nregion = us-east-1",
        ]
        for fixture in fixtures:
            with self.subTest(fixture=fixture), self.assertRaises(profiles.ProfileConfigError):
                profiles.parse_profiles(fixture)

    def test_missing_profile_name_is_rejected(self):
        with self.assertRaises(profiles.ProfileConfigError):
            profiles.parse_profiles("[profile ]\nregion = us-east-1")

    def test_profile_limit_is_enforced(self):
        with patch.object(profiles, "MAX_PROFILES", 2), self.assertRaises(profiles.ProfileConfigError):
            profiles.parse_profiles("[profile a]\n[profile b]\n[profile c]\n")


class ProfileFileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "profiles.txt"

    def test_bom_and_absolute_result(self):
        self.path.write_bytes(b"\xef\xbb\xbf[profile dev]\nregion = us-east-1\n")
        result = profiles.read_profiles(self.path)
        self.assertEqual(result["file"], str(self.path.resolve()))
        self.assertEqual(result["profiles"][0]["profile"], "dev")

    def test_tilde_path_expands(self):
        # Mock the open operation so this never reads the user's real home files.
        with patch.object(Path, "open", return_value=io.BytesIO(b"[default]\n")):
            result = profiles.read_profiles("~/profiles.txt")
        self.assertEqual(result["file"], str((Path.home() / "profiles.txt").resolve()))

    def test_missing_file_and_directory_are_clear(self):
        with self.assertRaisesRegex(profiles.ProfileConfigError, "not found"):
            profiles.read_profiles(self.path)
        with self.assertRaisesRegex(profiles.ProfileConfigError, "directory"):
            profiles.read_profiles(self.path.parent)

    def test_invalid_utf8_is_rejected(self):
        self.path.write_bytes(b"[default]\nregion = \xff")
        with self.assertRaisesRegex(profiles.ProfileConfigError, "UTF-8"):
            profiles.read_profiles(self.path)

    def test_size_limit_is_enforced(self):
        self.path.write_bytes(b"#" * (profiles.MAX_CONFIG_BYTES + 1))
        with self.assertRaisesRegex(profiles.ProfileConfigError, "too large"):
            profiles.read_profiles(self.path)

    def test_cli_success_and_failure_are_json_with_no_secret_leak(self):
        cases = [("[default]\nregion = us-east-1", 0),
                 ("[profile dev]\nSECRET_PRIVATE_KEY_WITHOUT_EQUALS", 1)]
        for fixture, status in cases:
            self.path.write_text(fixture, encoding="utf-8")
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(sys, "argv", ["profiles.py", "--file", str(self.path)]):
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    self.assertEqual(profiles.main(), status)
            output = stderr.getvalue() if status else stdout.getvalue()
            self.assertIsInstance(json.loads(output), dict)
            self.assertNotIn("SECRET", stdout.getvalue() + stderr.getvalue())
            self.assertEqual(stdout.getvalue() if status else stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
