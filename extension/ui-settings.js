(() => {
  "use strict";
  const themes = new Set(["system", "light", "dark"]);
  let currentTheme = "system";
  let themeRevision = 0;

  function applyTheme(value) {
    currentTheme = themes.has(value) ? value : "system";
    document.documentElement.dataset.theme = currentTheme;
    const control = document.getElementById("theme");
    if (control) {
      control.value = currentTheme;
      globalThis.BridgeSelect?.sync(control);
    }
  }

  async function setTheme(value) {
    if (!themes.has(value)) throw new Error("Choose a valid appearance.");
    const previous = currentTheme;
    const revision = ++themeRevision;
    applyTheme(value);
    try { await chrome.storage.local.set({ theme: value }); }
    catch {
      if (revision === themeRevision) applyTheme(previous);
      throw new Error("Could not save appearance.");
    }
  }

  async function request(type, extra = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (!response || response.ok !== true) {
      throw new Error(typeof response?.error === "string" ? response.error : "The native app is unavailable. Reconnect and try again.");
    }
    return response;
  }

  globalThis.BridgeUI = { request, setTheme };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.hasOwn(changes, "theme")) {
      ++themeRevision;
      applyTheme(changes.theme.newValue);
    }
  });
  const revision = themeRevision;
  chrome.storage.local.get(["theme"]).then(stored => {
    if (revision === themeRevision) applyTheme(stored.theme);
  }).catch(() => {
    if (revision === themeRevision) applyTheme("system");
  });
})();
