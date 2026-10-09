(() => {
  "use strict";
  const element = id => document.getElementById(id);
  const modelSelect = BridgeSelect.create(element("model"), [{ value: "", label: "Load models to choose" }]);
  const watched = ["bridgeStatus", "bridgeError", "baseURL", "apiKey", "hostConfig", "setupProgress", "setupWaiting", "onboardingComplete"];
  let snapshot = {}, models = [], sessionNames = new Set();
  let loaded = false, pending = false, refreshing = false, refreshQueued = false, uncertain = false, progressStamp = "";
  let stage = 1;
  let statusReadError = false;
  let operationRevision = 0, stateRevision = 0;

  function request(type, fields = {}, timeout = 10000) {
    let timer;
    return Promise.race([
      BridgeUI.request(type, fields),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(type === "setupSchool"
          ? "Setup timed out. A school change may already have completed. Check setup before continuing."
          : "The extension response timed out. Refresh local status, stop waiting, or open Settings.")), timeout);
      })
    ]).finally(() => clearTimeout(timer));
  }

  function beginOperation(kind) {
    pending = kind;
    const revision = ++operationRevision;
    render();
    return revision;
  }

  function message(id, text) {
    if (id === "error") statusReadError = false;
    element(id).textContent = text;
    element(id).hidden = !text;
  }

  function hideKey() {
    element("api-key").type = "password";
    element("show-key").textContent = "Show";
    element("show-key").setAttribute("aria-pressed", "false");
  }

  function verified() {
    const progress = snapshot.setupProgress, session = snapshot.setupSession, config = snapshot.config;
    return progress?.phase === "complete" && session && session.id != null && String(session.id) !== "" && session.contextCount === 0
      && String(session.id) === String(progress.session_id) && session.name === progress.name && session.model === progress.model
      && config?.session_name === progress.name && config.default_model === progress.model;
  }

  function render() {
    const status = snapshot.bridgeStatus || "offline";
    const connected = loaded && status === "ready" && !snapshot.setupRunning;
    const progress = snapshot.setupProgress;
    const invalidProgress = Boolean(snapshot.setupError);
    const locked = Boolean(pending || refreshing);
    const confirmed = connected && verified();
    const saved = loaded && snapshot.onboardingComplete === true && snapshot.config;
    const clientReady = Boolean(confirmed || saved);
    const waiting = ["models", "check", "setup"].includes(pending) || snapshot.setupRunning === true;
    if (clientReady) stage = 3;
    else if (connected || (loaded && snapshot.setupRunning === true)) stage = 2;
    else if (!loaded || status !== "busy") stage = 1;
    for (let step = 1; step <= 3; step++) {
      const active = step === stage;
      element(`step-${step}`).dataset.state = active ? "active" : step < stage ? "complete" : "upcoming";
      element(["connection-panel", "session-panel", "client-panel"][step - 1]).hidden = !active;
      if (active) element(`step-${step}`).setAttribute("aria-current", "step");
      else element(`step-${step}`).removeAttribute("aria-current");
    }
    const states = {
      ready: ["Connected", "success", "The native app and XIPU AI tab are connected."],
      busy: ["In progress", "info", pending || snapshot.setupRunning ? "Setup is running. Keep XIPU AI open." : "A bridge request is running. Setup will be available when it finishes."],
      "no-tab": ["Sign in needed", "warning", "The native app is connected. Open XIPU AI and sign in."],
      offline: ["Native app offline", "secondary", "Install the native app if needed, then reconnect."]
    };
    const [label, variant, detail] = states[status] || states.offline;
    element("connection-status").textContent = loaded ? label : refreshing ? "Checking connection" : "Status unavailable";
    element("connection-status").dataset.variant = variant;
    element("connection-detail").textContent = !loaded ? refreshing ? "Checking the native app and signed-in tab." : "Refresh to check the connection again."
      : pending === "cancel" ? "Stopping the wait. A school change may already have completed."
      : snapshot.setupWaiting === true ? "Waiting briefly before configuring the conversation."
      : pending === "models" ? "Reading available models from XIPU AI."
      : pending === "setup" ? "Preparing your conversation. Keep XIPU AI open."
      : pending === "check" ? "Checking the existing conversation in XIPU AI."
      : pending === "reconnect" ? "Connecting to the native app." : detail;
    element("reconnect").disabled = locked || status === "busy" || status === "ready";
    element("check-connection").disabled = refreshing;
    element("stop-waiting").hidden = !waiting && pending !== "cancel";
    element("stop-waiting").disabled = pending === "cancel";

    const stamp = progress ? JSON.stringify(progress) : "";
    if (progress && stamp !== progressStamp) {
      element("session-name").value = progress.name || "";
      modelSelect.setItems([{ value: progress.model || "", label: progress.model || "Selected model" }]);
      modelSelect.setValue(progress.model || "");
    }
    progressStamp = stamp;
    let recovery = "";
    const resumable = progress?.session_id && ["created", "configured"].includes(progress.phase);
    const healthyWait = ["models", "check", "setup"].includes(pending) || (snapshot.setupRunning && !uncertain);
    if (healthyWait) recovery = "";
    else if (progress?.phase === "creating") recovery = "The conversation creation outcome is not yet confirmed. Check setup to look for the existing conversation, or select it in Settings. Do not create another one.";
    else if (resumable) recovery = "Your conversation already exists. Resume setup to verify its configuration and save the local connection. No new conversation will be created.";
    else if (progress?.phase === "complete" && !verified()) recovery = "Setup was completed, but the saved connection has changed. Review the existing session in Settings.";
    else if (uncertain && pending !== "setup") recovery = "Could not confirm the setup outcome. Check the connection again before continuing. No new conversation will be created automatically.";
    message("recovery", recovery);
    element("check-setup").hidden = !recovery;
    element("check-setup").disabled = locked || !connected;
    element("inspect").disabled = !connected || locked || Boolean(progress) || uncertain || invalidProgress;
    element("inspect").hidden = Boolean(progress);
    element("inspect").textContent = pending === "models" ? "Loading models…" : "Load models";
    element("model").disabled = !connected || locked || Boolean(progress) || models.length === 0 || uncertain || invalidProgress;
    element("session-name").disabled = !connected || locked || Boolean(progress) || uncertain || invalidProgress;
    element("create-session").textContent = snapshot.setupWaiting === true ? "Waiting…" : pending === "setup" ? "Setting up…" : resumable ? "Resume setup" : "Create bridge session";
    element("create-session").disabled = !connected || locked || uncertain || invalidProgress || (progress ? !resumable : !models.some(model => model.id === element("model").value));
    modelSelect.sync();

    element("client-heading").textContent = confirmed ? "Ready to connect" : "Client connection";
    element("client-status").textContent = confirmed ? "Configured" : "Saved locally";
    element("client-status").dataset.variant = confirmed ? "success" : "secondary";
    element("client-verification").hidden = !clientReady || confirmed;
    element("ready-session").textContent = clientReady ? [snapshot.config.session_name, snapshot.config.default_model].filter(Boolean).join(" · ") : "";
    element("base-url").value = clientReady && typeof snapshot.baseURL === "string" ? snapshot.baseURL : "";
    const apiKey = clientReady && typeof snapshot.apiKey === "string" ? snapshot.apiKey : "";
    if (element("api-key").value !== apiKey) hideKey();
    element("api-key").value = apiKey;
    element("copy-url").disabled = !element("base-url").value;
    element("copy-key").disabled = !apiKey;
    element("show-key").disabled = !apiKey;
    element("finish").disabled = !clientReady;
    element("settings").hidden = clientReady;
  }

  function apply(response, reconciled = false) {
    stateRevision++;
    if (response.onboardingComplete === true && snapshot.onboardingComplete !== true) message("error", "");
    snapshot = response;
    loaded = true;
    if (reconciled || response.onboardingComplete === true || ["created", "configured", "complete"].includes(response.setupProgress?.phase)) uncertain = false;
    if (statusReadError) message("error", "");
    if (response.setupError && response.onboardingComplete !== true && !verified()) message("error", response.setupError);
    if (typeof response.bridgeError === "string" && response.bridgeError && !element("error").textContent) message("error", response.bridgeError);
    render();
  }

  async function refresh() {
    if (refreshing) { refreshQueued = true; return; }
    refreshing = true;
    const revision = stateRevision;
    render();
    try {
      const response = await request("getSetupState");
      if (revision === stateRevision) apply(response);
    }
    catch (error) {
      if (revision === stateRevision) {
        loaded = false;
        message("error", error.message || "Could not read setup state. Check the connection again.");
        statusReadError = true;
      }
    }
    finally {
      refreshing = false;
      render();
      if (refreshQueued) { refreshQueued = false; await refresh(); }
    }
  }

  async function finishOperation(revision, reload = false) {
    if (revision !== operationRevision) return;
    pending = false;
    render();
    if (reload) await refresh();
  }

  async function inspect() {
    if (element("inspect").disabled) return;
    message("error", "");
    message("notice", "");
    const revision = beginOperation("models");
    let failed = false;
    try {
      const response = await request("inspectSchool", {}, 35000);
      if (revision !== operationRevision) return;
      models = (Array.isArray(response.models) ? response.models : []).filter(model => typeof model?.id === "string" && model.id);
      sessionNames = new Set((Array.isArray(response.sessions) ? response.sessions : []).map(session => session.name));
      const previous = element("model").value;
      modelSelect.setItems([{ value: "", label: "Choose a model" }, ...models.map(model => ({ value: model.id, label: model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id }))]);
      modelSelect.setValue(models.some(model => model.id === previous) ? previous : models.some(model => model.id === "qwen3.6-27b") ? "qwen3.6-27b" : "");
      if (!models.length) throw new Error("No models are available for this account.");
    } catch (error) {
      if (revision === operationRevision) {
        message("error", error.message || "Could not load models. Sign in to XIPU AI and try again.");
        failed = true;
      }
    }
    finally { await finishOperation(revision, failed); }
  }

  async function setup(event) {
    event.preventDefault();
    if (element("create-session").disabled) return;
    message("error", "");
    message("notice", "");
    const progress = snapshot.setupProgress;
    const name = progress?.name || element("session-name").value.trim();
    const model = progress?.model || element("model").value;
    element("session-name").removeAttribute("aria-invalid");
    if (!name || name.length > 200 || (!progress && sessionNames.has(name))) {
      element("session-name").setAttribute("aria-invalid", "true");
      element("session-name").focus();
      message("error", sessionNames.has(name) ? "That conversation name already exists. Choose a new name, or select the existing session in Settings." : "Enter a conversation name of 1–200 characters.");
      return;
    }
    uncertain = true;
    const revision = beginOperation("setup");
    let failed = false;
    try {
      const response = await request("setupSchool", { name, model }, 110000);
      if (revision !== operationRevision) return;
      apply(response, true);
      if (verified() && snapshot.bridgeStatus === "ready") element("client-heading").focus();
    }
    catch (error) {
      if (revision !== operationRevision) return;
      message("error", error.message || "Setup could not finish. Check its status before continuing.");
      failed = true;
    } finally { await finishOperation(revision, failed); }
  }

  async function checkSetup() {
    if (element("check-setup").disabled) return;
    message("error", "");
    const revision = beginOperation("check");
    let failed = false;
    try {
      const response = await request("checkSetup", {}, 35000);
      if (revision !== operationRevision) return;
      apply(response, true);
    } catch (error) {
      if (revision === operationRevision) {
        message("error", error.message || "Could not check the school conversation. Use Settings to select it manually.");
        failed = true;
      }
    }
    finally { await finishOperation(revision, failed); }
  }

  async function stopWaiting() {
    if (element("stop-waiting").disabled) return;
    uncertain = true;
    message("error", "");
    message("notice", "Stopped waiting for the previous reply. A school change may already have completed. Check setup or use Settings before continuing.");
    const revision = beginOperation("cancel");
    try {
      const response = await request("cancelSetup");
      if (revision === operationRevision) apply(response);
    } catch (error) { if (revision === operationRevision) message("error", error.message || "Could not confirm cancellation. Refresh local status before continuing."); }
    finally { await finishOperation(revision, true); }
  }

  async function copy(id, label) {
    if (!element(id).value) return;
    try { await navigator.clipboard.writeText(element(id).value); message("notice", `${label} copied.`); }
    catch { message("error", id === "api-key" ? "Copy failed. Show the key, select it, and copy manually." : "Copy failed. Select the URL and copy it manually."); }
  }

  async function openSettings() {
    try { await chrome.runtime.openOptionsPage(); }
    catch { message("error", "Could not open settings. Reopen the extension and try again."); }
  }

  element("session-form").addEventListener("submit", setup);
  element("model").addEventListener("change", render);
  element("inspect").addEventListener("click", inspect);
  element("check-connection").addEventListener("click", refresh);
  element("check-setup").addEventListener("click", checkSetup);
  element("stop-waiting").addEventListener("click", stopWaiting);
  element("reconnect").addEventListener("click", async () => {
    if (element("reconnect").disabled) return;
    message("notice", "");
    const revision = beginOperation("reconnect");
    try { await request("reconnect"); }
    catch (error) { if (revision === operationRevision) message("error", error.message || "Could not reconnect."); }
    finally { await finishOperation(revision, true); }
  });
  element("show-key").addEventListener("click", () => {
    if (!element("api-key").value) return;
    if (element("api-key").type === "text") return hideKey();
    element("api-key").type = "text";
    element("show-key").textContent = "Hide";
    element("show-key").setAttribute("aria-pressed", "true");
  });
  element("copy-url").addEventListener("click", () => copy("base-url", "Base URL"));
  element("copy-key").addEventListener("click", () => copy("api-key", "API key"));
  element("settings").addEventListener("click", openSettings);
  element("finish").addEventListener("click", openSettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && watched.some(key => Object.hasOwn(changes, key))) refresh();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) hideKey(); });
  refresh();
})();
