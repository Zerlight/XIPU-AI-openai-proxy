(() => {
  "use strict";
  const states = {
    ready: ["Connected", "success", "Keep your XIPU AI chat tab open and signed in."],
    busy: ["In progress", "info", "A request is running. Keep your XIPU AI tab open."],
    offline: ["Offline", "secondary", "The native host is not connected."],
    "no-tab": ["Sign in needed", "warning", "The native host is ready. Open the XIPU AI chat page via Setup and sign in."]
  };
  const keys = ["bridgeStatus", "bridgeError", "apiKey", "baseURL", "sessionName", "transport", "onboardingComplete", "setupProgress"];
  const element = id => document.getElementById(id);
  let revision = 0, onboarded = false, storageReady = false, onboardingPending = false;

  function showError(message) {
    for (const id of ["error", "welcome-error"]) {
      const visible = id === (onboarded ? "error" : "welcome-error");
      element(id).textContent = visible ? message : "";
      element(id).hidden = !visible || !message;
    }
  }

  function hideKey() {
    element("key").type = "password";
    element("reveal").setAttribute("aria-pressed", "false");
    element("reveal").setAttribute("aria-label", "Show API key");
    element("reveal").title = "Show API key";
  }

  function clearClient() {
    hideKey();
    element("key").value = "";
    element("endpoint").value = "";
    element("copy").disabled = true;
    element("copy-url").disabled = true;
    element("reveal").disabled = true;
    element("feedback").textContent = "";
  }

  function updateActions() {
    element("start-setup").disabled = onboardingPending;
    element("skip-setup").disabled = onboardingPending || !storageReady;
    element("setup").disabled = onboardingPending;
    element("welcome-retry").disabled = onboardingPending;
  }

  function showView(complete) {
    onboarded = complete;
    element("loading").hidden = true;
    element("welcome").hidden = complete;
    element("dashboard").hidden = !complete;
    element("settings").hidden = !complete;
    if (!complete) clearClient();
    updateActions();
  }

  function renderWelcome(progress) {
    const continuing = ["created", "configured"].includes(progress?.phase);
    const reviewing = progress != null && !continuing;
    element("welcome-title").textContent = continuing ? "Continue setup" : reviewing ? "Review setup" : "Welcome";
    element("welcome-description").textContent = continuing ? "Pick up where you left off on this computer."
      : reviewing ? "Check your earlier setup attempt before continuing." : "Use XIPU AI with your local OpenAI-compatible apps.";
    element("start-setup").textContent = continuing ? "Continue setup" : reviewing ? "Review setup" : "Start setup";
    element("welcome-status").textContent = reviewing ? "Setup will check your saved progress without creating a duplicate conversation."
      : "Setup opens in a new tab. Already set up on this computer? Choose Use existing setup.";
  }

  async function refresh() {
    const current = ++revision;
    try {
      const stored = await chrome.storage.local.get(keys);
      if (current !== revision) return;
      storageReady = true;
      showView(stored.onboardingComplete === true || stored.setupProgress?.phase === "complete");
      element("welcome-retry").hidden = true;
      showError("");
      if (!onboarded) { renderWelcome(stored.setupProgress); return; }
      const state = Object.hasOwn(states, stored.bridgeStatus) ? stored.bridgeStatus : "offline";
      const [label, variant, detail] = states[state];
      element("status").textContent = label;
      element("status").dataset.variant = variant;
      element("status-detail").textContent = detail;
      showError(typeof stored.bridgeError === "string" ? stored.bridgeError : "");
      element("endpoint").value = stored.baseURL || "http://127.0.0.1:8765/v1";
      element("copy-url").disabled = false;
      element("session").textContent = stored.sessionName || "Waiting for the native app";
      element("transport").textContent = stored.transport === "native-messaging" ? "Native Messaging" : "Not connected";
      const apiKey = typeof stored.apiKey === "string" ? stored.apiKey : "";
      if (element("key").value !== apiKey) hideKey();
      element("key").value = apiKey;
      element("copy").disabled = !apiKey;
      element("reveal").disabled = !apiKey;
      element("retry").disabled = state !== "offline";
    } catch {
      if (current !== revision) return;
      storageReady = false;
      showView(false);
      element("welcome-title").textContent = "Setup unavailable";
      element("welcome-description").textContent = "Could not load your saved setup status.";
      element("start-setup").textContent = "Open setup";
      element("welcome-status").textContent = "Click Try again to reload your connection, or open Setup.";
      element("welcome-retry").hidden = false;
      showError("Could not read setup status. Try again or reopen the extension.");
    }
  }

  async function copy(id, label) {
    if (!onboarded) return;
    const value = element(id).value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      element("feedback").textContent = `${label} copied.`;
    } catch {
      element("feedback").textContent = id === "key"
        ? "Copy failed. Reveal the key and copy it manually."
        : "Copy failed. Select the URL and copy it manually.";
    }
  }

  async function openSetup() {
    if (onboardingPending) return;
    onboardingPending = true;
    updateActions();
    showError("");
    try { await BridgeUI.request("openSetup"); }
    catch { showError("Could not open setup. Try reopening the extension."); }
    finally { onboardingPending = false; updateActions(); }
  }

  element("extension-id").textContent = chrome.runtime.id;
  element("setup").addEventListener("click", openSetup);
  element("start-setup").addEventListener("click", openSetup);
  element("welcome-retry").addEventListener("click", refresh);
  element("skip-setup").addEventListener("click", async () => {
    if (onboarded || onboardingPending || !storageReady) return;
    onboardingPending = true;
    updateActions();
    showError("");
    try {
      await BridgeUI.request("skipSetup");
      await refresh();
      if (storageReady && !onboarded) showError("Could not confirm the saved preference. Try again.");
    } catch { showError("Could not use the existing setup. Try again."); }
    finally { onboardingPending = false; updateActions(); }
  });
  element("settings").addEventListener("click", async () => {
    try { await chrome.runtime.openOptionsPage(); }
    catch { showError("Could not open settings. Try reopening the extension."); }
  });
  element("copy").addEventListener("click", () => copy("key", "API key"));
  element("copy-url").addEventListener("click", () => copy("endpoint", "Base URL"));
  element("reveal").addEventListener("click", () => {
    if (!onboarded || !element("key").value) return;
    if (element("key").type === "text") return hideKey();
    element("key").type = "text";
    element("reveal").setAttribute("aria-pressed", "true");
    element("reveal").setAttribute("aria-label", "Hide API key");
    element("reveal").title = "Hide API key";
  });
  element("retry").addEventListener("click", async () => {
    if (!onboarded) return;
    element("retry").disabled = true;
    showError("");
    try {
      await BridgeUI.request("reconnect");
      await refresh();
    } catch {
      element("retry").disabled = false;
      showError("Could not reconnect. Reopen the extension and try again.");
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && keys.some(key => Object.hasOwn(changes, key))) refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hideKey();
  });
  refresh();
})();
