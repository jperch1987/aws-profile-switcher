// Author: jperch1987
// Only AWS's documented switch-role endpoint is permitted. Config values become
// encoded query parameters, never a URL scheme, hostname, or redirect target.
export function buildConsoleTarget(profile) {
  const unavailable = (reason) => ({ url: null, accountId: null, roleName: null, reason });
  const arn = profile?.role_arn;
  if (typeof arn !== 'string' || !arn) {
    return unavailable('This profile has no role_arn. Sign in through your AWS access portal, or choose a profile with an IAM role.');
  }
  const match = /^arn:([a-z0-9-]+):iam::(\d{12}):role\/([\x21-\x7E]+)$/.exec(arn);
  if (!match) return unavailable('The role_arn must be an IAM role ARN with a 12-digit AWS account ID.');
  const [, partition, accountId, roleName] = match;
  if (partition !== 'aws') {
    return unavailable('Console links currently support commercial AWS accounts. AWS China and GovCloud require their own sign-in endpoints.');
  }
  const leafName = roleName.slice(roleName.lastIndexOf('/') + 1);
  if (!/^[A-Za-z0-9_+=,.@-]+$/.test(leafName)) {
    return unavailable('The IAM role name is invalid. Check the role_arn in the configuration file.');
  }
  if (roleName.length > 64) {
    return unavailable('AWS Console switching requires the role path and name together to be 64 characters or fewer.');
  }
  const url = new URL('https://signin.aws.amazon.com/switchrole');
  url.searchParams.set('account', accountId);
  url.searchParams.set('roleName', roleName);
  return { url: url.href, accountId, roleName, reason: null };
}
