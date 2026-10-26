// Author: jperch1987
"use strict";

const $ = (id) => document.getElementById(id);
const state = { profiles: [], selected: null, active: null, commands: null, token: "", shell: "posix", loading: false, switching: false, authenticating: false, loaded: false, copyTimer: null };

function busy() { return state.loading || state.switching || state.authenticating; }
function clearMfa() { $("mfa-code").value = ""; }

function announce(message, error = false) {
  if (error) clearMfa();
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
    button.setAttribute("aria-label", `${profile.profile}, ${profile.region || "region not set"}${profile.profile === state.active?.profile ? ", saved CLI profile" : ""}`);
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
      state.selected = profile.profile;
      for (const item of $("profile-list").children) {
        const selected = item === button;
        item.classList.toggle("is-selected", selected);
        item.setAttribute("aria-pressed", String(selected));
      }
      renderDetails();
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
  $("selection-badge").textContent = isActive ? "Selected for CLI" : "Preview";
  $("selection-badge").classList.toggle("is-active", isActive);
  for (const [id, value] of [["detail-profile", selected.profile], ["detail-region", selected.region], ["detail-role", selected.role_arn], ["detail-source", selected.source_profile]]) {
    $(id).textContent = value || "Not set";
    $(id).classList.toggle("not-set", !value);
  }
  const enabled = selected.auth?.enabled === true;
  $("switch-label").textContent = state.switching ? "Saving…" : isActive ? "Refresh CLI command" : "Use for CLI";
  $("switch-button").disabled = busy() || !enabled;
  $("switch-help").textContent = "CLI: copy and run the command below. Enter a fresh MFA code in your terminal each time.";
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
  $("active-name").textContent = state.active?.profile || "No CLI profile selected";
  $("active-meta").textContent = state.active ? `${state.active.region || "Region not set"}${state.active.source_profile ? ` · from ${state.active.source_profile}` : ""}` : "Choose a profile and select “Use for CLI”.";
  $("active-status").textContent = state.active ? "Selection only" : "CLI selection";
  renderCommand();
}

function renderCommand() {
  const command = state.commands?.[state.shell];
  $("terminal-command").textContent = command || "# Your CLI profile command will appear here";
  $("terminal-command").classList.toggle("is-placeholder", !command);
  $("terminal-description").textContent = command ? `Run for “${state.active.profile}”, then enter MFA in your terminal.` : state.active ? "The saved profile cannot authenticate. Check its configuration and select it again." : "Choose “Use for CLI” to generate your shell command.";
  document.querySelector(".terminal-prompt").textContent = state.shell === "powershell" ? ">" : "$";
  $("copy-button").disabled = !command || busy();
  $("copy-label").textContent = "Copy command";
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
    if (data.activeProfile) {
      try {
        const active = await request("/api/active");
        state.active = active.profile;
        state.commands = active.commands;
      } catch (error) {
        announce(`Profiles loaded, but the saved CLI selection could not be read. ${error.message}`, true);
      }
    }
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
  const profileName = state.selected;
  clearMfa();
  state.switching = true;
  clearNotice();
  renderBusy();
  try {
    const result = await request("/api/active", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": state.token }, body: JSON.stringify({ profile: profileName }) });
    state.active = result.profile;
    state.profiles = state.profiles.map((profile) => profile.profile === result.profile.profile ? result.profile : profile);
    state.commands = result.commands;
    announce(`“${result.profile.profile}” is selected for CLI use. Run the command below and enter a fresh MFA code in your terminal to authenticate.`);
    renderProfiles();
    renderActive();
  } catch (error) {
    announce(error.message, true);
  } finally {
    state.switching = false;
    renderBusy();
  }
}

async function openConsole(event) {
  event.preventDefault();
  if (busy()) return;
  const selected = state.profiles.find((profile) => profile.profile === state.selected);
  let mfaCode = $("mfa-code").value;
  clearMfa();
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
  clearNotice();
  renderBusy();
  try {
    const pending = request("/api/console", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": state.token }, body: JSON.stringify({ profile: selected.profile, mfaCode }) });
    mfaCode = "";
    const result = await pending;
    const url = approvedFederationUrl(result.url);
    if (!url) throw new Error("AWS Console returned an invalid sign-in link. Enter a fresh MFA code and try again.");
    if (consoleTab.closed) throw new Error("The new tab was closed. Enter a fresh MFA code and try again.");
    // The short-lived sign-in URL is never saved in state, storage, or a page link.
    consoleTab.location.replace(url);
    announce(`Opened AWS Console for “${selected.profile}” in a new tab. The temporary session expires; sign in again with MFA when needed.`);
  } catch (error) {
    consoleTab.close();
    announce(error.message, true);
  } finally {
    mfaCode = "";
    clearMfa();
    state.authenticating = false;
    renderBusy();
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
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  previousFocus?.focus();
  return copied;
}

async function copyCommand() {
  if (busy()) return;
  const command = state.commands?.[state.shell];
  if (!command) return;
  try {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(command);
    } catch {
      if (!fallbackCopy(command)) throw new Error("Clipboard unavailable");
    }
    $("copy-label").textContent = "Copied!";
    announce("Command copied. Run it in your terminal and enter a fresh MFA code to authenticate.");
    clearTimeout(state.copyTimer);
    state.copyTimer = setTimeout(() => { $("copy-label").textContent = "Copy command"; }, 2200);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents($("terminal-command"));
    selection?.removeAllRanges();
    selection?.addRange(range);
    announce("Your browser could not copy automatically. The command is selected; press Ctrl+C or ⌘C to copy it.", true);
  }
}

$("refresh-button").addEventListener("click", () => loadProfiles(true));
$("profile-search").addEventListener("input", renderProfiles);
$("switch-button").addEventListener("click", switchProfile);
$("console-form").addEventListener("submit", openConsole);
$("console-link").addEventListener("click", clearMfa);
$("console-link").addEventListener("auxclick", clearMfa);
$("copy-button").addEventListener("click", copyCommand);
document.querySelectorAll("[data-shell]").forEach((button) => button.addEventListener("click", () => { state.shell = button.dataset.shell; renderCommand(); }));
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    event.preventDefault();
    $("profile-search").focus();
  }
});
loadProfiles();
window.addEventListener("pagehide", clearMfa);
