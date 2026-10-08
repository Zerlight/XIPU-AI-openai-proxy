(() => {
  "use strict";
  const states = {
    ready: ["Connected", "success", "Ready. Keep XIPU AI open and signed in."],
    busy: ["In progress", "info", "A request is running. Keep XIPU AI open."],
    offline: ["Offline", "secondary", "The native app is not connected."],
    "no-tab": ["Sign in needed", "warning", "The native app is ready. Open XIPU AI and sign in."]
  };
  const keys = ["bridgeStatus", "bridgeError", "apiKey", "baseURL", "sessionName", "transport"];
  const element = id => document.getElementById(id);
  let revision = 0;

  function showError(message) {
    element("error").textContent = message;
    element("error").hidden = !message;
  }

  function hideKey() {
    element("key").type = "password";
    element("reveal").setAttribute("aria-pressed", "false");
    element("reveal").setAttribute("aria-label", "Show API key");
    element("reveal").title = "Show API key";
  }

  async function refresh() {
    const current = ++revision;
    try {
      const stored = await chrome.storage.local.get(keys);
      if (current !== revision) return;
      const state = Object.hasOwn(states, stored.bridgeStatus) ? stored.bridgeStatus : "offline";
      const [label, variant, detail] = states[state];
      element("status").textContent = label;
      element("status").dataset.variant = variant;
      element("status-detail").textContent = detail;
      showError(typeof stored.bridgeError === "string" ? stored.bridgeError : "");
      element("endpoint").value = stored.baseURL || "http://127.0.0.1:8765/v1";
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
      element("status").textContent = "Unavailable";
      element("status").dataset.variant = "warning";
      element("status-detail").textContent = "Close and reopen the extension to read its status.";
      hideKey();
      element("key").value = "";
      element("copy").disabled = true;
      element("reveal").disabled = true;
      element("retry").disabled = false;
      showError("Could not read bridge status.");
    }
  }

  async function copy(id, label) {
    const value = element(id).value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      element("feedback").textContent = `${label} copied.`;
    } catch {
      element("feedback").textContent = id === "key"
        ? "Copy failed. Show the key, select it, and copy manually."
        : "Copy failed. Select the URL and copy it manually.";
    }
  }

  element("extension-id").textContent = chrome.runtime.id;
  element("settings").addEventListener("click", async () => {
    try { await chrome.runtime.openOptionsPage(); }
    catch { showError("Could not open settings. Try reopening the extension."); }
  });
  element("copy").addEventListener("click", () => copy("key", "API key"));
  element("copy-url").addEventListener("click", () => copy("endpoint", "Base URL"));
  element("reveal").addEventListener("click", () => {
    if (element("key").type === "text") return hideKey();
    element("key").type = "text";
    element("reveal").setAttribute("aria-pressed", "true");
    element("reveal").setAttribute("aria-label", "Hide API key");
    element("reveal").title = "Hide API key";
  });
  element("retry").addEventListener("click", async () => {
    element("retry").disabled = true;
    showError("");
    try {
      await BridgeUI.request("reconnect");
      await refresh();
    } catch {
      element("retry").disabled = false;
      showError("Could not reconnect. Close and reopen the extension, then try again.");
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
