// Author: jperch1987
"use strict";

const $ = (id) => document.getElementById(id);
const state = { profiles: [], selected: null, active: null, commands: null, token: "", shell: "posix", loading: false, switching: false, loaded: false, copyTimer: null };

function announce(message, error = false) {
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

function clearConsoleAction() {
  $("console-link").hidden = true;
  $("console-link").removeAttribute("href");
  $("console-unavailable").hidden = false;
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
  $("switch-label").textContent = state.switching ? "Saving…" : isActive ? "Selected for CLI" : "Use for CLI";
  $("switch-button").disabled = state.loading || state.switching || isActive;
  $("switch-help").textContent = isActive ? "CLI selection saved. Run the command below to apply it in your terminal." : "Open AWS to confirm a role switch, or generate a CLI command below.";
  if (state.loading) return;
  const url = approvedConsoleUrl(selected.console?.url);
  if (url) {
    $("console-link").href = url;
    $("console-link").hidden = false;
    $("console-unavailable").hidden = true;
  } else {
    $("console-reason").textContent = typeof selected.console?.reason === "string" && selected.console.reason ? selected.console.reason : "This profile does not have a supported AWS Console switch-role link. You can still select it for CLI use.";
    $("console-reason").hidden = false;
  }
}

function renderActive() {
  $("active-name").textContent = state.active?.profile || "No CLI profile selected";
  $("active-meta").textContent = state.active ? `${state.active.region || "Region not set"}${state.active.source_profile ? ` · from ${state.active.source_profile}` : ""}` : "Choose a profile and select “Use for CLI”.";
  $("active-status").textContent = state.active ? "Saved locally" : "CLI selection";
  renderCommand();
}

function renderCommand() {
  const command = state.commands?.[state.shell];
  $("terminal-command").textContent = command || "# Your CLI profile command will appear here";
  $("terminal-command").classList.toggle("is-placeholder", !command);
  $("terminal-description").textContent = state.active ? `Apply saved CLI profile “${state.active.profile}” to your current shell.` : "Choose “Use for CLI” to generate your shell command.";
  document.querySelector(".terminal-prompt").textContent = state.shell === "powershell" ? ">" : "$";
  $("copy-button").disabled = !command || state.loading || state.switching;
  $("copy-label").textContent = "Copy command";
  clearTimeout(state.copyTimer);
  document.querySelectorAll("[data-shell]").forEach((tab) => {
    const selected = tab.dataset.shell === state.shell;
    tab.classList.toggle("is-selected", selected);
    tab.setAttribute("aria-pressed", String(selected));
  });
}

function setLoading(loading) {
  state.loading = loading;
  $("refresh-button").disabled = loading || state.switching;
  $("refresh-button").classList.toggle("is-loading", loading);
  $("refresh-button").querySelector("span").textContent = loading ? "Reading…" : "Refresh";
  $("profile-list").setAttribute("aria-busy", String(loading));
  $("profile-details").setAttribute("aria-busy", String(loading));
  renderDetails();
  renderCommand();
}

async function loadProfiles(isRefresh = false) {
  if (state.loading || state.switching) return;
  const previousSelection = state.selected;
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
    state.selected = state.profiles.some((profile) => profile.profile === previousSelection) ? previousSelection : state.profiles.find((profile) => approvedConsoleUrl(profile.console?.url))?.profile || state.profiles[0]?.profile || null;
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
  if (state.loading || state.switching || !state.selected) return;
  const profileName = state.selected;
  state.switching = true;
  clearNotice();
  $("refresh-button").disabled = true;
  renderDetails();
  renderCommand();
  try {
    const result = await request("/api/active", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": state.token }, body: JSON.stringify({ profile: profileName }) });
    state.active = result.profile;
    state.profiles = state.profiles.map((profile) => profile.profile === result.profile.profile ? result.profile : profile);
    state.commands = result.commands;
    announce(`“${result.profile.profile}” is saved for CLI use. Copy and run the command below to apply it in your terminal.`);
    renderProfiles();
    renderActive();
  } catch (error) {
    announce(error.message, true);
  } finally {
    state.switching = false;
    $("refresh-button").disabled = false;
    renderDetails();
    renderCommand();
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
    announce("Command copied. Paste and run it in your terminal to apply the profile.");
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
$("copy-button").addEventListener("click", copyCommand);
document.querySelectorAll("[data-shell]").forEach((button) => button.addEventListener("click", () => { state.shell = button.dataset.shell; renderCommand(); }));
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    event.preventDefault();
    $("profile-search").focus();
  }
});
loadProfiles();
