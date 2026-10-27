// Author: jperch1987
"use strict";

const $ = (id) => document.getElementById(id);
const state = { profiles: [], selected: null, active: null, commands: null, expiration: 0, expiryTimer: null, sessionVersion: 0, authVersion: 0, consoleTab: null, token: "", shell: "posix", loading: false, switching: false, authenticating: false, loaded: false, copyTimer: null };

function busy() { return state.loading || state.switching || state.authenticating; }
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
    return url.protocol === "https:" && url.hostname === "signin.aws.amazon.com" && url.pathname === "/switchrole" && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

function approvedFederationUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "signin.aws.amazon.com" || url.pathname !== "/federation" || url.username || url.password || url.port || url.hash) return null;
    const allowed = new Set(["Action", "Destination", "SigninToken"]);
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
    }
    if (url.searchParams.get("Action") !== "login" || !url.searchParams.get("SigninToken")) return null;
    const destination = new URL(url.searchParams.get("Destination"));
    if (destination.protocol !== "https:" || destination.hostname !== "console.aws.amazon.com" || destination.pathname !== "/console/home" || destination.username || destination.password || destination.port || destination.hash) return null;
    if (destination.searchParams.getAll("region").length !== 1 || !destination.searchParams.get("region") || [...destination.searchParams.keys()].some((key) => key !== "region")) return null;
    return url.href;
  } catch { return null; }
}

function clearConsoleAction() {
  $("console-link").hidden = true;
  $("console-link").removeAttribute("href");
  $("console-button").disabled = true;
  $("mfa-code").disabled = true;
  $("console-reason").hidden = true;
  $("console-reason").textContent = "";
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
  $("switch-button").disabled = busy() || !enabled;
  $("switch-help").textContent = "Use a fresh MFA code for either action. CLI credentials appear below after AWS authenticates the role.";
  $("console-label").textContent = state.authenticating ? "Signing in…" : "Open AWS Console";
  $("console-button").disabled = busy() || !enabled;
  $("mfa-code").disabled = busy() || !enabled;
  $("detail-mfa").textContent = selected.auth?.mfaSerial || "Not set";
  $("detail-mfa").classList.toggle("not-set", !selected.auth?.mfaSerial);
  if (!enabled) {
    $("console-reason").textContent = typeof selected.auth?.reason === "string" && selected.auth.reason ? selected.auth.reason : "Direct Console sign-in and MFA CLI commands require a supported role, source profile, MFA device, and region.";
    $("console-reason").hidden = false;
  }
  if (busy()) return;
  const url = approvedConsoleUrl(selected.console?.url);
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
}

function setLoading(loading) {
  state.loading = loading;
  renderBusy();
}

async function loadProfiles(isRefresh = false) {
  if (busy()) return;
  const previousSelection = state.selected;
  clearMfa();
  clearNotice();
  forgetCredentials();
  state.profiles = [];
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
    if (!Array.isArray(data.profiles) || !data.profiles.every((profile) => profile && typeof profile.profile === "string" && [profile.role_arn, profile.source_profile, profile.region].every((value) => value == null || typeof value === "string"))) throw new Error("The local server returned invalid profile data.");
    state.profiles = data.profiles;
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
    announce(error.message, true);
    state.profiles = [];
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
    setLoading(false);
  }
}

async function switchProfile() {
  if (busy() || state.profiles.find((profile) => profile.profile === state.selected)?.auth?.enabled !== true) return;
  const selected = state.profiles.find((profile) => profile.profile === state.selected);
  let mfaCode = $("mfa-code").value;
  clearMfa();
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

async function openConsole(event) {
  event.preventDefault();
  if (busy()) return;
  const selected = state.profiles.find((profile) => profile.profile === state.selected);
  let mfaCode = $("mfa-code").value;
  clearMfa();
  clearCredentials();
  if (selected?.auth?.enabled !== true) return;
  if (!/^[0-9]{6}$/.test(mfaCode)) {
    mfaCode = "";
    announce("Enter a fresh six-digit code from your authenticator to open AWS Console.", true);
    $("mfa-code").focus();
    return;
  }
  // Open during the user gesture; a later async open would be blocked by browsers.
  let consoleTab;
  try {
    consoleTab = window.open("about:blank", "_blank");
    if (!consoleTab) throw new Error("Popup blocked");
    consoleTab.opener = null;
  } catch {
    mfaCode = "";
    consoleTab?.close();
    announce("Allow pop-ups for this local app, then enter a fresh MFA code and try again.", true);
    return;
  }
  state.authenticating = true;
  state.consoleTab = consoleTab;
  const authVersion = ++state.authVersion;
  clearNotice();
  renderBusy();
  try {
    const pending = request("/api/console", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": state.token }, body: JSON.stringify({ profile: selected.profile, mfaCode }) });
    mfaCode = "";
    const result = await pending;
    if (authVersion !== state.authVersion) { consoleTab.close(); return; }
    const url = approvedFederationUrl(result.url);
    if (!url) throw new Error("AWS Console returned an invalid sign-in link. Enter a fresh MFA code and try again.");
    if (consoleTab.closed) throw new Error("The new tab was closed. Enter a fresh MFA code and try again.");
    // The short-lived sign-in URL is never saved in state, storage, or a page link.
    consoleTab.location.replace(url);
    announce(`Opened AWS Console for “${selected.profile}” in a new tab. The temporary session expires; sign in again with MFA when needed.`);
  } catch (error) {
    consoleTab.close();
    if (authVersion === state.authVersion) announce(error.message, true);
  } finally {
    mfaCode = "";
    if (authVersion === state.authVersion) {
      clearMfa();
      state.consoleTab = null;
      state.authenticating = false;
      renderBusy();
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
  state.consoleTab?.close();
  state.consoleTab = null;
  state.switching = false;
  state.authenticating = false;
  clearMfa();
  clearCredentials();
  renderBusy();
}

$("refresh-button").addEventListener("click", () => loadProfiles(true));
$("profile-search").addEventListener("input", renderProfiles);
$("switch-button").addEventListener("click", switchProfile);
$("console-form").addEventListener("submit", openConsole);
$("console-link").addEventListener("click", () => { clearMfa(); clearCredentials(); });
$("console-link").addEventListener("auxclick", () => { clearMfa(); clearCredentials(); });
$("copy-button").addEventListener("click", copyCommand);
$("clear-credentials").addEventListener("click", () => { clearMfa(); clearCredentials(); announce("Credentials cleared from this page. Your clipboard and terminal were not changed."); });
document.querySelectorAll("[data-shell]").forEach((button) => button.addEventListener("click", () => { state.shell = button.dataset.shell; renderCommand(); }));
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    event.preventDefault();
    $("profile-search").focus();
  }
});
loadProfiles();
window.addEventListener("pagehide", clearPageSecrets);
window.addEventListener("pageshow", (event) => { if (event.persisted) clearPageSecrets(); });
