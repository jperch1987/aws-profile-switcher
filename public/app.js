// Author: jperch1987
"use strict";

const $ = (id) => document.getElementById(id);
const state = { profiles: [], selected: null, active: null, commands: null, expiration: 0, expiryTimer: null, sessionVersion: 0, authVersion: 0, loadVersion: 0, token: "", shell: "posix", loading: false, switching: false, loaded: false, copyTimer: null };

const lookupTypes = new Map([["ec2", "EC2 instance"], ["ebs", "EBS volume"], ["security-group", "Security group"], ["vpc", "VPC"], ["s3", "S3 bucket"], ["rds", "RDS database"], ["lambda", "Lambda function"], ["eks", "EKS cluster"], ["elasticache", "ElastiCache cache"], ["route53", "Route 53 hosted zone"]]);
const lookupProfileLimit = 250;
const lookupRegion = /^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*$/;
const lookup = { groups: [], group: null, selected: new Set(), snapshot: null, expected: null, version: 0, timer: null, expiryTimer: null, running: false, mutation: false, message: "", error: false };

function busy() { return state.loading || state.switching; }
function clearMfa() { $("mfa-code").value = ""; }

function forgetCredentials() {
  state.commands = null;
  state.active = null;
  state.expiration = 0;
  state.sessionVersion++;
  clearTimeout(state.expiryTimer);
  clearTimeout(state.copyTimer);
  state.expiryTimer = null;
}

function hasCredentials() {
  if (state.commands && state.expiration <= Date.now()) forgetCredentials();
  return Boolean(state.commands);
}

function clearCredentials() {
  forgetCredentials();
  renderProfiles();
  renderDetails();
  renderActive();
}

function scheduleExpiry() {
  clearTimeout(state.expiryTimer);
  if (!hasCredentials()) {
    clearCredentials();
    announce("CLI credentials expired and were cleared here. Enter a fresh MFA code to get new credentials.");
    return;
  }
  renderActive();
  state.expiryTimer = setTimeout(scheduleExpiry, Math.min(state.expiration - Date.now(), 60_000));
}

function validCliResponse(result, selected) {
  const expiration = Date.parse(result?.expiration);
  const keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION"];
  if (result?.profile?.profile !== selected.profile || result.roleArn !== selected.role_arn || typeof result.expiration !== "string" || !Number.isFinite(expiration) || expiration <= Date.now() || expiration > Date.now() + 3_900_000) return false;
  return ["posix", "powershell"].every((shell) => {
    const value = result.commands?.[shell];
    if (typeof value !== "string" || value.length > 200_000) return false;
    const lines = value.split("\n");
    return lines.length === keys.length && lines.every((line, index) => {
      const prefix = shell === "posix" ? `export ${keys[index]}=` : `$Env:${keys[index]} = `;
      const quoted = shell === "posix" ? /^'(?:[\x20-\x26\x28-\x7e]|'\\'')*'$/ : /^'(?:[\x20-\x26\x28-\x7e]|'')*'$/;
      return line.startsWith(prefix) && quoted.test(line.slice(prefix.length));
    });
  });
}

function announce(message, error = false) {
  if (error) { clearMfa(); clearCredentials(); }
  const notice = $("notice");
  notice.textContent = message;
  notice.classList.toggle("is-error", error);
  notice.setAttribute("role", error ? "alert" : "status");
  notice.hidden = false;
}

function clearNotice() {
  $("notice").hidden = true;
  $("notice").textContent = "";
}

async function request(url, options) {
  const response = await fetch(url, { ...options, cache: "no-store" });
  let body;
  try { body = await response.json(); } catch { throw new Error("The local server returned an unreadable response. Check that the server is running."); }
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The request could not be completed. Please try again.");
  return body;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function initials(name) {
  return name.slice(0, 2).toUpperCase();
}

function approvedConsoleUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "signin.aws.amazon.com" || url.pathname !== "/switchrole" || url.username || url.password || url.port || url.hash) return null;
    if ([...url.searchParams.keys()].some((key) => !["account", "roleName"].includes(key)) || url.searchParams.getAll("account").length !== 1 || url.searchParams.getAll("roleName").length !== 1) return null;
    const role = url.searchParams.get("roleName");
    if (!/^[0-9]{12}$/.test(url.searchParams.get("account")) || !role || role.length > 64 || !/^[\x21-\x7e]+$/.test(role) || !/^[A-Za-z0-9_+=,.@-]+$/.test(role.slice(role.lastIndexOf("/") + 1))) return null;
    return url.href;
  } catch { return null; }
}

function clearConsoleAction() {
  $("console-link").hidden = true;
  $("console-link").removeAttribute("href");
  $("mfa-code").disabled = true;
  $("console-reason").hidden = true;
  $("console-reason").textContent = "";
  $("cli-reason").hidden = true;
  $("cli-reason").textContent = "";
}

function showEmptyList(title, description) {
  const empty = makeElement("div", "empty-state");
  const icon = makeElement("span", "empty-state-symbol", "⌕");
  icon.setAttribute("aria-hidden", "true");
  empty.append(icon, makeElement("strong", "", title), makeElement("p", "", description));
  $("profile-list").replaceChildren(empty);
}

function renderProfiles() {
  const query = $("profile-search").value.trim().toLocaleLowerCase();
  const profiles = state.profiles.filter((profile) => [profile.profile, profile.region, profile.role_arn, profile.source_profile].some((value) => String(value || "").toLocaleLowerCase().includes(query)));
  $("profile-count").textContent = state.profiles.length;
  $("sidebar-count").textContent = state.profiles.length;
  $("browser-footer").textContent = query ? `${profiles.length} of ${state.profiles.length} profiles match your search` : `${state.profiles.length} ${state.profiles.length === 1 ? "profile" : "profiles"} available · Standard AWS format`;
  if (!profiles.length) {
    if (query && state.profiles.length) showEmptyList("No matching profiles", "Try a different profile name, role, or region.");
    else showEmptyList("No profiles found", "Add a [profile name] section to your configuration file, then refresh.");
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const profile of profiles) {
    const button = makeElement("button", "profile-item");
    button.type = "button";
    button.disabled = busy();
    button.classList.toggle("is-selected", profile.profile === state.selected);
    button.setAttribute("aria-pressed", String(profile.profile === state.selected));
    button.setAttribute("aria-label", `${profile.profile}, ${profile.region || "region not set"}${profile.profile === state.active?.profile ? ", temporary CLI credentials available" : ""}`);
    const avatar = makeElement("span", "profile-avatar", initials(profile.profile));
    avatar.setAttribute("aria-hidden", "true");
    const text = makeElement("span", "profile-item-text");
    const title = makeElement("span", "profile-item-title");
    title.append(makeElement("span", "profile-item-name", profile.profile));
    if (profile.profile === state.active?.profile) title.append(makeElement("span", "profile-item-active", "CLI"));
    const role = profile.role_arn ? profile.role_arn.split("/").pop() : profile.source_profile ? `from ${profile.source_profile}` : "No role specified";
    const meta = makeElement("span", "profile-item-meta", `${profile.region || "Region not set"} · ${role}`);
    text.append(title, meta);
    const arrow = makeElement("span", "profile-item-arrow", "›");
    arrow.setAttribute("aria-hidden", "true");
    button.append(avatar, text, arrow);
    button.addEventListener("click", () => {
      if (busy()) return;
      clearMfa();
      clearLookupMfa();
      clearNotice();
      forgetCredentials();
      state.selected = profile.profile;
      for (const item of $("profile-list").children) {
        const selected = item === button;
        item.classList.toggle("is-selected", selected);
        item.setAttribute("aria-pressed", String(selected));
      }
      renderDetails();
      renderActive();
      renderProfiles();
    });
    fragment.append(button);
  }
  $("profile-list").replaceChildren(fragment);
}

function renderDetails() {
  clearConsoleAction();
  const selected = state.profiles.find((profile) => profile.profile === state.selected);
  $("details-empty").hidden = Boolean(selected);
  $("details-content").hidden = !selected;
  if (!selected) return;
  const isActive = selected.profile === state.active?.profile;
  $("detail-name").textContent = selected.profile;
  $("detail-avatar").textContent = initials(selected.profile);
  $("detail-description").textContent = "Review the role before choosing your workflow.";
  $("selection-badge").textContent = isActive ? "CLI credentials ready" : "Preview";
  $("selection-badge").classList.toggle("is-active", isActive);
  for (const [id, value] of [["detail-profile", selected.profile], ["detail-region", selected.region], ["detail-role", selected.role_arn], ["detail-source", selected.source_profile]]) {
    $(id).textContent = value || "Not set";
    $(id).classList.toggle("not-set", !value);
  }
  const enabled = selected.auth?.enabled === true;
  $("switch-label").textContent = state.switching ? "Authenticating…" : "Get CLI credentials";
  $("switch-button").disabled = busy() || lookup.running || !enabled;
  $("switch-help").textContent = "Enter a fresh MFA code here for CLI credentials. Console switching uses your existing AWS browser session.";
  const url = approvedConsoleUrl(selected.console?.url);
  $("mfa-code").disabled = busy() || lookup.running || !enabled;
  $("detail-mfa").textContent = selected.auth?.mfaSerial || "Not set";
  $("detail-mfa").classList.toggle("not-set", !selected.auth?.mfaSerial);
  if (!enabled) {
    $("cli-reason").textContent = typeof selected.auth?.reason === "string" && selected.auth.reason ? selected.auth.reason : "CLI credentials require a supported role, source profile, MFA device, and region.";
    $("cli-reason").hidden = false;
  }
  if (!url) {
    $("console-reason").textContent = typeof selected.console?.reason === "string" && selected.console.reason ? selected.console.reason : "This profile does not have a supported AWS Console role.";
    $("console-reason").hidden = false;
  }
  if (busy()) return;
  if (url) {
    $("console-link").href = url;
    $("console-link").hidden = false;
  }
}

function renderActive() {
  const available = hasCredentials();
  $("active-name").textContent = available ? state.active.profile : "No CLI credentials loaded";
  $("active-meta").textContent = available ? `${state.active.region || "Region not set"} · Temporary credentials in this page only` : "Choose a profile, enter MFA, then select “Get CLI credentials”.";
  $("active-status").textContent = available ? "Temporary session" : "MFA required";
  renderCommand();
}

function renderCommand() {
  if (state.commands && state.expiration <= Date.now()) {
    clearCredentials();
    return;
  }
  const available = hasCredentials();
  const command = state.commands?.[state.shell];
  $("terminal-command").textContent = command || "# Temporary export commands appear after MFA authentication";
  $("terminal-command").classList.toggle("is-placeholder", !command);
  $("terminal-description").textContent = command ? `Copy these five lines for “${state.active.profile}” into a fresh terminal. No second MFA prompt.` : "Enter MFA above and choose “Get CLI credentials” to reveal the export commands.";
  $("session-expiry").textContent = available ? `Expires at ${new Date(state.expiration).toLocaleTimeString()} · ${Math.ceil((state.expiration - Date.now()) / 60_000)} min remaining` : "Credentials are cleared here on expiry, refresh, or profile change.";
  $("clear-credentials").disabled = !available;
  document.querySelector(".terminal-prompt").textContent = state.shell === "powershell" ? ">" : "$";
  $("copy-button").disabled = !command || busy();
  $("copy-label").textContent = "Copy commands";
  clearTimeout(state.copyTimer);
  document.querySelectorAll("[data-shell]").forEach((tab) => {
    const selected = tab.dataset.shell === state.shell;
    tab.classList.toggle("is-selected", selected);
    tab.setAttribute("aria-pressed", String(selected));
  });
}

function renderBusy() {
  $("refresh-button").disabled = busy();
  $("profile-search").disabled = busy();
  $("refresh-button").classList.toggle("is-loading", state.loading);
  $("refresh-button").querySelector("span").textContent = state.loading ? "Reading…" : "Refresh";
  $("profile-list").setAttribute("aria-busy", String(busy()));
  $("profile-details").setAttribute("aria-busy", String(busy()));
  for (const item of $("profile-list").children) if (item.tagName === "BUTTON") item.disabled = busy();
  renderDetails();
  renderCommand();
  renderLookupControls();
}

function setLoading(loading) {
  state.loading = loading;
  renderBusy();
}

async function loadProfiles(isRefresh = false) {
  if (busy()) return;
  const loadVersion = ++state.loadVersion;
  resetLookup(true);
  const previousSelection = state.selected;
  clearMfa();
  clearNotice();
  forgetCredentials();
  state.profiles = [];
  rebuildLookupGroups();
  state.selected = null;
  state.active = null;
  state.commands = null;
  state.token = "";
  setLoading(true);
  renderProfiles();
  renderActive();
  showEmptyList("Reading profiles…", "Refreshing the local configuration file.");
  try {
    const data = await request("/api/profiles");
    if (loadVersion !== state.loadVersion) return;
    if (!Array.isArray(data.profiles) || !data.profiles.every((profile) => profile && typeof profile.profile === "string" && [profile.role_arn, profile.source_profile, profile.region].every((value) => value == null || typeof value === "string"))) throw new Error("The local server returned invalid profile data.");
    state.profiles = data.profiles;
    rebuildLookupGroups();
    state.token = data.token;
    state.active = null;
    state.commands = null;
    $("source-file").textContent = data.file || "Local AWS configuration";
    $("source-file").title = data.file || "";
    state.selected = state.profiles.some((profile) => profile.profile === previousSelection) ? previousSelection : state.profiles.find((profile) => profile.auth?.enabled === true)?.profile || state.profiles.find((profile) => approvedConsoleUrl(profile.console?.url))?.profile || state.profiles[0]?.profile || null;
    state.loaded = true;
    renderProfiles();
    renderDetails();
    renderActive();
    if (isRefresh && $("notice").hidden) announce(`Configuration refreshed. ${state.profiles.length} ${state.profiles.length === 1 ? "profile is" : "profiles are"} available.`);
  } catch (error) {
    if (loadVersion !== state.loadVersion) return;
    announce(error.message, true);
    state.profiles = [];
    rebuildLookupGroups();
    state.selected = null;
    state.active = null;
    state.commands = null;
    state.token = "";
    clearConsoleAction();
    $("source-file").textContent = "Configuration could not be read";
    $("source-file").removeAttribute("title");
    showEmptyList("Unable to load profiles", "Check your file path and configuration, then try Refresh.");
    $("browser-footer").textContent = "Waiting for a readable configuration file";
    renderActive();
  } finally {
    if (loadVersion === state.loadVersion) setLoading(false);
  }
}

async function switchProfile() {
  if (busy() || lookup.running || state.profiles.find((profile) => profile.profile === state.selected)?.auth?.enabled !== true) return;
  const selected = state.profiles.find((profile) => profile.profile === state.selected);
  let mfaCode = $("mfa-code").value;
  clearMfa();
  clearLookupMfa();
  clearCredentials();
  if (!/^[0-9]{6}$/.test(mfaCode)) {
    mfaCode = "";
    announce("Enter a fresh six-digit MFA code to get CLI credentials.", true);
    $("mfa-code").focus();
    return;
  }
  const authVersion = ++state.authVersion;
  state.switching = true;
  clearNotice();
  renderBusy();
  try {
    const pending = request("/api/cli", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": state.token }, body: JSON.stringify({ profile: selected.profile, mfaCode }) });
    mfaCode = "";
    const result = await pending;
    if (authVersion !== state.authVersion) return;
    if (!validCliResponse(result, selected)) throw new Error("AWS returned invalid or expired CLI credentials. Enter a fresh MFA code and try again.");
    state.active = result.profile;
    state.commands = result.commands;
    state.expiration = Date.parse(result.expiration);
    scheduleExpiry();
    announce(`Temporary CLI credentials for “${result.profile.profile}” are ready. Copy the export commands into a fresh terminal.`);
    renderProfiles();
    renderActive();
  } catch (error) {
    if (authVersion === state.authVersion) announce(`${error.message} Your terminal was not changed.`, true);
  } finally {
    mfaCode = "";
    if (authVersion === state.authVersion) {
      clearMfa();
      state.switching = false;
      renderBusy();
    }
  }
}

function clearLookupMfa() { $("lookup-mfa").value = ""; }

function currentLookupGroup() { return lookup.groups.find((group) => group.key === lookup.group); }

function effectiveRegion(profile) {
  return profile.region || state.profiles.find((source) => source.profile === profile.source_profile)?.region || "us-east-1";
}

function resetLookup(cancelPending = false, message = "") {
  const pendingId = lookup.running ? lookup.snapshot?.id : null;
  lookup.version++;
  clearTimeout(lookup.timer);
  clearTimeout(lookup.expiryTimer);
  lookup.timer = null;
  lookup.expiryTimer = null;
  lookup.snapshot = null;
  lookup.expected = null;
  lookup.running = false;
  lookup.mutation = false;
  lookup.message = message;
  lookup.error = false;
  clearLookupMfa();
  if (cancelPending && pendingId) cancelDetachedLookup(pendingId, state.token);
  renderLookupSnapshot();
}

function cancelDetachedLookup(id, token) {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id) || !token) return;
  // Cancellation is best effort when the page is leaving; it is never reported as confirmed.
  request("/api/lookup/cancel", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": token }, body: JSON.stringify({ id }), keepalive: true }).catch(() => {});
}

function rebuildLookupGroups() {
  const groups = new Map();
  for (const profile of state.profiles) {
    if (profile.auth?.enabled !== true || !profile.role_arn || !profile.source_profile || !profile.auth.mfaSerial) continue;
    const key = JSON.stringify([profile.source_profile, profile.auth.mfaSerial]);
    if (!groups.has(key)) groups.set(key, { key, source: profile.source_profile, mfa: profile.auth.mfaSerial, profiles: [] });
    groups.get(key).profiles.push(profile);
  }
  lookup.groups = [...groups.values()];
  lookup.group = lookup.groups.some((group) => group.key === lookup.group) ? lookup.group : lookup.groups[0]?.key || null;
  const options = lookup.groups.map((group) => {
    const option = makeElement("option", "", `${group.source} · ${group.profiles.length} ${group.profiles.length === 1 ? "profile" : "profiles"} · MFA ${group.mfa.slice(group.mfa.lastIndexOf("/") + 1)}`);
    option.value = group.key;
    return option;
  });
  if (!options.length) {
    const option = makeElement("option", "", "No eligible source identity");
    option.value = "";
    options.push(option);
  }
  $("lookup-group").replaceChildren(...options);
  $("lookup-group").value = lookup.group || "";
  selectLookupGroup();
}

function selectLookupGroup() {
  const group = currentLookupGroup();
  lookup.selected = new Set(group && group.profiles.length <= lookupProfileLimit ? group.profiles.map((profile) => profile.profile) : []);
  clearLookupMfa();
  renderLookupScope();
  renderLookupControls();
}

function renderLookupScope() {
  const group = currentLookupGroup();
  const rows = [];
  for (const profile of group?.profiles || []) {
    const label = makeElement("label", "lookup-scope-item");
    const checkbox = makeElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = lookup.selected.has(profile.profile);
    checkbox.value = profile.profile;
    checkbox.setAttribute("aria-label", `Search ${profile.profile} in ${effectiveRegion(profile)}`);
    checkbox.addEventListener("change", () => {
      if (busy() || lookup.running) return;
      if (checkbox.checked) lookup.selected.add(profile.profile);
      else lookup.selected.delete(profile.profile);
      clearLookupMfa();
      renderLookupControls();
    });
    const details = makeElement("span", "lookup-scope-text");
    const account = /^arn:aws:iam::([0-9]{12}):role\//.exec(profile.role_arn)?.[1] || "Account not set";
    details.append(makeElement("strong", "", profile.profile), makeElement("span", "", `${account} · ${effectiveRegion(profile)}`));
    label.append(checkbox, details);
    rows.push(label);
  }
  if (!rows.length) rows.push(makeElement("p", "lookup-empty", "Add a role profile with a source profile, region, and MFA device to search AWS resources."));
  $("lookup-profiles").replaceChildren(...rows);
}

function renderLookupControls() {
  const group = currentLookupGroup();
  const locked = busy() || lookup.running;
  const selected = lookup.selected.size;
  const eligible = lookup.groups.reduce((count, item) => count + item.profiles.length, 0);
  const unavailable = Math.max(0, state.profiles.length - eligible);
  const total = group?.profiles.length || 0;
  const limitMessage = selected > lookupProfileLimit ? `Select no more than ${lookupProfileLimit} profiles per search.` : total > lookupProfileLimit ? `This identity exceeds the ${lookupProfileLimit}-profile search limit. Select all is unavailable; choose up to ${lookupProfileLimit} profiles manually, then search the remaining profiles separately.${selected === 0 ? " None have been selected automatically." : ""}` : `Choose 1–${lookupProfileLimit} profiles sharing this source identity and MFA device.`;
  $("lookup-scope-summary").textContent = `${selected} of ${total} profiles selected. ${limitMessage}`;
  $("lookup-scope-summary").classList.toggle("is-error", selected > lookupProfileLimit);
  $("lookup-source-help").textContent = group ? `MFA device: ${group.mfa}${unavailable ? `. ${unavailable} ${unavailable === 1 ? "profile needs" : "profiles need"} role/source/MFA setup and cannot be searched.` : ""}` : "No profiles have the role, source credentials configuration, region, and MFA device required for lookup.";
  $("lookup-region-help").textContent = $("lookup-type").value === "s3" ? "S3 bucket lookup is global. A match shows the bucket’s verified region when available." : $("lookup-type").value === "route53" ? "Route 53 hosted zone lookup is global. Search by exact domain name, hosted zone ID, or ARN; individual DNS records are outside this search." : "Searches only each selected profile’s configured region: role region, then source region, or us-east-1 by default. Other regions are outside this search.";
  $("lookup-query").placeholder = ({ ec2: "For example: i-0123456789abcdef0 or web-server", ebs: "For example: vol-0123456789abcdef0", "security-group": "For example: sg-0123456789abcdef0", vpc: "For example: vpc-0123456789abcdef0", s3: "For example: my-application-bucket", rds: "For example: production-database", lambda: "For example: process-orders", eks: "For example: production-cluster or cluster ARN", elasticache: "Cache cluster, replication group, or serverless cache ID / ARN", route53: "For example: example.com or Z0123456789ABC" })[$("lookup-type").value] || "Exact resource name, ID, or ARN";
  for (const id of ["lookup-group", "lookup-type", "lookup-query", "lookup-mfa"]) $(id).disabled = locked || !group;
  for (const row of $("lookup-profiles").children) if (row.children[0]?.tagName === "INPUT") row.children[0].disabled = locked;
  $("lookup-select-all").disabled = locked || !group || total > lookupProfileLimit;
  $("lookup-select-all").textContent = total > 0 && selected === total ? "All selected" : "Select all";
  $("lookup-select-all").setAttribute("aria-describedby", "lookup-scope-summary");
  $("lookup-select-none").disabled = locked || selected === 0;
  $("lookup-submit").disabled = locked || selected < 1 || selected > lookupProfileLimit;
  $("lookup-submit-label").textContent = lookup.running ? "Searching…" : "Search resources";
  $("lookup-cancel").hidden = !lookup.running;
  $("lookup-cancel").disabled = !lookup.running || lookup.mutation || !lookup.snapshot?.id;
  $("lookup-clear").disabled = !lookup.snapshot && !lookup.message && !lookup.running;
  $("resource-lookup").setAttribute("aria-busy", String(lookup.running));
}

function lookupText(value, limit = 1024) { return typeof value === "string" && value.length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value); }

function validLookupSnapshot(snapshot, expected, id = null) {
  if (!snapshot || typeof snapshot.id !== "string" || !/^[a-f0-9]{32}$/.test(snapshot.id) || (id && snapshot.id !== id) || !["running", "complete", "error", "cancelled"].includes(snapshot.state) || snapshot.query !== expected.query || snapshot.resourceType !== expected.resourceType || !lookupText(snapshot.message, 2000)) return false;
  if (!Array.isArray(snapshot.profiles) || snapshot.profiles.length !== expected.profiles.length || !Array.isArray(snapshot.results) || snapshot.results.length > expected.profiles.length * 100 || !Array.isArray(snapshot.checks) || snapshot.checks.length > expected.profiles.length || snapshot.total !== expected.profiles.length || !Number.isInteger(snapshot.completed) || snapshot.completed !== snapshot.checks.length || (snapshot.state !== "running" && snapshot.completed !== snapshot.total)) return false;
  const scopes = new Map();
  for (const profile of snapshot.profiles) {
    const expectedScope = expected.scopes.find((scope) => scope.profile === profile?.profile);
    if (!profile || !expectedScope || scopes.has(profile.profile) || typeof profile.accountId !== "string" || !/^[0-9]{12}$/.test(profile.accountId) || profile.accountId !== expectedScope.accountId || profile.region !== expectedScope.region) return false;
    scopes.set(profile.profile, profile);
  }
  const checked = new Set();
  for (const check of snapshot.checks) {
    const scope = scopes.get(check?.profile);
    if (!scope || checked.has(check.profile) || scope.accountId !== check.accountId || scope.region !== check.region || !["found", "not_found", "access_denied", "auth_failed", "error", "skipped"].includes(check.status) || !lookupText(check.message, 2000)) return false;
    checked.add(check.profile);
  }
  for (const row of snapshot.results) {
    const scope = scopes.get(row?.profile);
    if (!scope || row.accountId !== scope.accountId || row.resourceType !== expected.resourceType || ![row.region, row.resourceId, row.name, row.arn].every((value) => lookupText(value)) || !row.resourceId) return false;
    if (expected.resourceType === "route53" ? row.region !== "global" : expected.resourceType === "s3" ? !lookupRegion.test(row.region) && !["unknown", "global"].includes(row.region) : row.region !== scope.region) return false;
  }
  if (snapshot.expiresAt != null && (typeof snapshot.expiresAt !== "string" || !Number.isFinite(Date.parse(snapshot.expiresAt)))) return false;
  return true;
}

function renderLookupSnapshot() {
  const snapshot = lookup.snapshot;
  const labels = { found: "Found", not_found: "No match", access_denied: "Access denied", auth_failed: "Authentication failed", error: "Check failed", skipped: "Not checked" };
  const status = $("lookup-status");
  status.textContent = lookup.message || snapshot?.message || "Search AWS by an exact resource ID, name, or ARN. No lookup runs until you select Search resources.";
  status.classList.toggle("is-error", lookup.error || snapshot?.state === "error");
  status.setAttribute("role", lookup.error || snapshot?.state === "error" ? "alert" : "status");
  $("lookup-progress").textContent = snapshot ? `${snapshot.completed} of ${snapshot.total} profiles processed · ${snapshot.results.length} ${snapshot.results.length === 1 ? "match" : "matches"}${snapshot.state === "running" ? " · Searching" : ""}` : lookup.running ? "Starting read-only lookup…" : "";
  $("lookup-progress").hidden = !snapshot && !lookup.running;
  $("lookup-results-panel").hidden = !snapshot;
  $("lookup-results-heading").textContent = snapshot ? `Results for “${snapshot.query}”` : "Search results";
  const rows = [];
  for (const result of snapshot?.results || []) {
    const row = makeElement("tr");
    row.append(makeElement("td", "lookup-mono", result.accountId), makeElement("td", "", result.profile), makeElement("td", "lookup-mono", result.region));
    const resource = makeElement("td");
    resource.append(makeElement("code", "lookup-resource-id", result.resourceId));
    if (result.name && result.name !== result.resourceId) resource.append(makeElement("span", "lookup-resource-name", result.name));
    if (result.arn) resource.append(makeElement("code", "lookup-resource-arn", result.arn));
    row.append(resource);
    rows.push(row);
  }
  $("lookup-results-body").replaceChildren(...rows);
  $("lookup-results-table").hidden = !rows.length;
  $("lookup-no-results").hidden = rows.length > 0;
  const incomplete = snapshot?.checks.some((check) => !["found", "not_found"].includes(check.status));
  $("lookup-no-results").textContent = snapshot?.state === "running" ? "No matches received yet. Checks are still running." : incomplete || snapshot?.state === "error" || snapshot?.state === "cancelled" ? "No matches returned. Some profiles were not fully checked; this does not prove the resource is absent." : ["s3", "route53"].includes(snapshot?.resourceType) ? "No exact match was returned from the checked profiles. Other accounts were not searched." : "No exact match was returned from the checked profiles and configured regions. Other accounts and regions were not searched.";
  const checks = [];
  for (const scope of snapshot?.profiles || []) {
    const check = snapshot.checks.find((item) => item.profile === scope.profile);
    const item = makeElement("li", `lookup-check${check && !["found", "not_found"].includes(check.status) ? " is-warning" : ""}`);
    const heading = makeElement("div", "lookup-check-heading");
    heading.append(makeElement("strong", "", scope.profile), makeElement("span", "lookup-check-state", check ? labels[check.status] : snapshot.state === "running" ? "Waiting" : "Not checked"));
    item.append(heading, makeElement("span", "lookup-check-meta", `${scope.accountId} · ${scope.region}${snapshot.resourceType === "s3" ? " · S3 global lookup" : snapshot.resourceType === "route53" ? " · Route 53 global lookup" : ""}`));
    if (check?.message) item.append(makeElement("p", "", check.message));
    checks.push(item);
  }
  $("lookup-checks").replaceChildren(...checks);
  $("lookup-coverage-note").textContent = "Searches can run for up to 10 minutes. Profiles remaining at the time limit are marked Not checked. Access denied, failed authentication, skipped checks, and errors do not prove a resource is absent. Review every profile’s check status before drawing a conclusion.";
  renderLookupControls();
}

function applyLookupSnapshot(snapshot, expected, version, id = null) {
  if (!validLookupSnapshot(snapshot, expected, id)) throw new Error("The local server returned an invalid lookup response. Results were not accepted.");
  lookup.snapshot = snapshot;
  lookup.running = snapshot.state === "running";
  lookup.message = "";
  lookup.error = false;
  clearTimeout(lookup.expiryTimer);
  lookup.expiryTimer = null;
  if (!lookup.running && snapshot.expiresAt) {
    const remaining = Date.parse(snapshot.expiresAt) - Date.now();
    if (remaining <= 0) {
      resetLookup(false, "Lookup results expired and were cleared from this page. Start a new search with a fresh MFA code.");
      renderBusy();
      return;
    }
    lookup.expiryTimer = setTimeout(() => {
      if (version !== lookup.version) return;
      resetLookup(false, "Lookup results expired and were cleared from this page. Start a new search with a fresh MFA code.");
      renderBusy();
    }, Math.min(remaining, 2_147_483_647));
  }
  renderLookupSnapshot();
  renderBusy();
}

function scheduleLookupPoll(version) {
  clearTimeout(lookup.timer);
  lookup.timer = null;
  if (version === lookup.version && lookup.running) lookup.timer = setTimeout(() => pollLookup(version), 1500);
}

async function pollLookup(version) {
  const id = lookup.snapshot?.id;
  if (!id || version !== lookup.version) return;
  try {
    const snapshot = await request(`/api/lookup?id=${encodeURIComponent(id)}`);
    if (version !== lookup.version) return;
    applyLookupSnapshot(snapshot, lookup.expected, version, id);
  } catch (error) {
    if (version !== lookup.version) return;
    lookup.message = `${error.message} Search status is uncertain; cancellation has not been confirmed. You can cancel or clear these results.`;
    lookup.error = true;
    clearLookupMfa();
    renderLookupSnapshot();
  }
  scheduleLookupPoll(version);
}

async function searchResources(event) {
  event?.preventDefault();
  if (busy() || lookup.running) return;
  let mfaCode = $("lookup-mfa").value;
  clearLookupMfa();
  clearMfa();
  const group = currentLookupGroup();
  const profiles = group?.profiles.filter((profile) => lookup.selected.has(profile.profile)).map((profile) => profile.profile) || [];
  const query = $("lookup-query").value.trim();
  const resourceType = $("lookup-type").value;
  resetLookup(false);
  if (!profiles.length || profiles.length > lookupProfileLimit || !lookupTypes.has(resourceType) || !query || query.length > 256 || /[\x00-\x1f\x7f]/.test(query)) {
    mfaCode = "";
    lookup.message = `Select 1–${lookupProfileLimit} profiles and a resource type, then enter an exact ID, name, or ARN of up to 256 characters. Wildcard searches are not supported.`;
    lookup.error = true;
    renderLookupSnapshot();
    return;
  }
  if (!/^[0-9]{6}$/.test(mfaCode)) {
    mfaCode = "";
    lookup.message = "Enter a fresh six-digit MFA code for this resource lookup.";
    lookup.error = true;
    renderLookupSnapshot();
    $("lookup-mfa").focus();
    return;
  }
  const version = lookup.version;
  const token = state.token;
  const scopes = group.profiles.filter((profile) => lookup.selected.has(profile.profile)).map((profile) => ({ profile: profile.profile, accountId: /^arn:aws:iam::([0-9]{12}):role\//.exec(profile.role_arn)?.[1], region: effectiveRegion(profile) }));
  const expected = { query, resourceType, profiles, scopes };
  lookup.expected = expected;
  lookup.running = true;
  lookup.mutation = true;
  lookup.message = "Authenticating the selected source identity and starting read-only resource checks…";
  renderLookupSnapshot();
  renderBusy();
  try {
    const pending = request("/api/lookup", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": token }, body: JSON.stringify({ profiles, resourceType, query, mfaCode }) });
    mfaCode = "";
    const snapshot = await pending;
    if (version !== lookup.version) { if (snapshot?.state === "running") cancelDetachedLookup(snapshot.id, token); return; }
    applyLookupSnapshot(snapshot, expected, version);
    scheduleLookupPoll(version);
  } catch (error) {
    if (version === lookup.version) {
      lookup.running = false;
      lookup.message = error.message;
      lookup.error = true;
      renderLookupSnapshot();
    }
  } finally {
    mfaCode = "";
    if (version === lookup.version) {
      clearLookupMfa();
      lookup.mutation = false;
      renderBusy();
      renderLookupControls();
    }
  }
}

async function cancelLookup() {
  if (!lookup.running || lookup.mutation || !lookup.snapshot?.id) return;
  clearTimeout(lookup.timer);
  lookup.timer = null;
  const version = ++lookup.version;
  const id = lookup.snapshot.id;
  lookup.mutation = true;
  clearLookupMfa();
  renderLookupControls();
  try {
    const snapshot = await request("/api/lookup/cancel", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": state.token }, body: JSON.stringify({ id }) });
    if (version !== lookup.version) return;
    applyLookupSnapshot(snapshot, lookup.expected, version, id);
  } catch (error) {
    if (version === lookup.version) {
      lookup.message = `${error.message} Cancellation was not confirmed. The search may still be running.`;
      lookup.error = true;
      renderLookupSnapshot();
    }
  } finally {
    if (version === lookup.version) {
      lookup.mutation = false;
      renderBusy();
      renderLookupControls();
      scheduleLookupPoll(version);
    }
  }
}

function fallbackCopy(text) {
  const previousFocus = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } finally {
    textarea.value = "";
    textarea.remove();
    previousFocus?.focus();
  }
}

async function copyCommand() {
  if (busy()) return;
  if (!hasCredentials()) {
    clearCredentials();
    announce("No unexpired credentials are available. Enter a fresh MFA code to get CLI credentials.");
    return;
  }
  let command = state.commands?.[state.shell];
  const version = state.sessionVersion;
  if (!command) return;
  try {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(command);
    } catch {
      if (version !== state.sessionVersion) return;
      if (!hasCredentials()) { clearCredentials(); return; }
      if (!fallbackCopy(command)) throw new Error("Clipboard unavailable");
    }
    if (version !== state.sessionVersion) return;
    if (!hasCredentials()) { clearCredentials(); return; }
    $("copy-label").textContent = "Copied!";
    announce("Temporary credentials copied. Paste into a fresh terminal. Your clipboard and shell history may retain them.");
    clearTimeout(state.copyTimer);
    state.copyTimer = setTimeout(() => { $("copy-label").textContent = "Copy commands"; }, 2200);
  } catch {
    announce("Your browser could not copy the credentials. They were cleared here; enter a fresh MFA code to try again.", true);
  } finally { command = ""; }
}

function clearPageSecrets() {
  state.authVersion++;
  state.loadVersion++;
  resetLookup(true);
  state.loading = false;
  state.switching = false;
  clearMfa();
  clearCredentials();
  renderBusy();
}

$("refresh-button").addEventListener("click", () => loadProfiles(true));
$("profile-search").addEventListener("input", renderProfiles);
$("switch-button").addEventListener("click", switchProfile);
$("mfa-code").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); switchProfile(); } });
$("console-link").addEventListener("click", () => { clearMfa(); clearLookupMfa(); clearCredentials(); });
$("console-link").addEventListener("auxclick", () => { clearMfa(); clearLookupMfa(); clearCredentials(); });
$("copy-button").addEventListener("click", copyCommand);
$("clear-credentials").addEventListener("click", () => { clearMfa(); clearCredentials(); announce("Credentials cleared from this page. Your clipboard and terminal were not changed."); });
document.querySelectorAll("[data-shell]").forEach((button) => button.addEventListener("click", () => { state.shell = button.dataset.shell; renderCommand(); }));
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    event.preventDefault();
    $("profile-search").focus();
  }
});
$("lookup-type").value = "ec2";
$("lookup-group").addEventListener("change", () => {
  if (busy() || lookup.running) return;
  resetLookup(false);
  lookup.group = $("lookup-group").value;
  selectLookupGroup();
});
$("lookup-type").addEventListener("change", () => { if (!busy() && !lookup.running) { resetLookup(false); renderLookupControls(); } });
$("lookup-query").addEventListener("input", clearLookupMfa);
$("lookup-select-all").addEventListener("click", () => {
  const group = currentLookupGroup();
  if (busy() || lookup.running || !group || group.profiles.length > lookupProfileLimit) return;
  lookup.selected = new Set(group.profiles.map((profile) => profile.profile));
  clearLookupMfa();
  renderLookupScope();
  renderLookupControls();
});
$("lookup-select-none").addEventListener("click", () => {
  if (busy() || lookup.running) return;
  lookup.selected.clear();
  clearLookupMfa();
  renderLookupScope();
  renderLookupControls();
});
$("lookup-submit").addEventListener("click", searchResources);
for (const id of ["lookup-query", "lookup-mfa"]) $(id).addEventListener("keydown", (event) => { if (event.key === "Enter") searchResources(event); });
$("lookup-cancel").addEventListener("click", cancelLookup);
$("lookup-clear").addEventListener("click", () => {
  const wasRunning = lookup.running;
  resetLookup(true, wasRunning ? "Results cleared from this page. Cancellation was requested, but the search may continue until the server confirms it or times out." : "Lookup results cleared from this page.");
  renderBusy();
});
loadProfiles();
window.addEventListener("pagehide", clearPageSecrets);
window.addEventListener("pageshow", (event) => { if (event.persisted) { clearPageSecrets(); loadProfiles(); } });
