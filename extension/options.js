(() => {
  "use strict";
  const defaults = {
    session_name: "XIPU AI Bridge", port: 8765, default_model: "", thinking: "minimal", online: false,
    chat_timeout_seconds: 300, model_timeout_seconds: 30, idle_timeout_seconds: 90, include_reasoning: true
  };
  const numeric = { port: [1, 65535], chat_timeout_seconds: [10, 1800], model_timeout_seconds: [5, 120], idle_timeout_seconds: [5, 600] };
  const labels = { ready: ["Connected", "success"], busy: ["Request in progress", "info"], offline: ["Offline", "secondary"], "no-tab": ["Open XIPU AI", "warning"] };
  const element = id => document.getElementById(id);
  const sections = ["general", "connection", "advanced"];
  const selects = {
    thinking: BridgeSelect.create(element("thinking"), [
      { value: "minimal", label: "Minimal" }, { value: "low", label: "Low" },
      { value: "medium", label: "Medium" }, { value: "high", label: "High" }
    ]),
    theme: BridgeSelect.create(element("theme"), [
      { value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }
    ]),
    schoolSession: BridgeSelect.create(element("school-session"), [{ value: "", label: "Choose a session" }])
  };
  let loaded = false, pending = false, dirty = false, status = "offline", restartRequired = false;
  let saved = null, sessions = [], loading = 0, refreshAfterOperation = false;

  function selectSection(section, focus = false) {
    for (const select of Object.values(selects)) select.close();
    for (const name of sections) {
      const active = name === section;
      element(`panel-${name}`).hidden = !active;
      element(`tab-${name}`).setAttribute("aria-selected", String(active));
      element(`tab-${name}`).tabIndex = active ? 0 : -1;
    }
    if (focus) element(`tab-${section}`).focus();
  }

  function finishOperation() {
    pending = false;
    updateControls();
    if (refreshAfterOperation) { refreshAfterOperation = false; loadSettings(false); }
  }

  function message(id, text) {
    element(id).textContent = text;
    element(id).hidden = !text;
  }

  function hideKey() {
    element("api-key").type = "password";
    element("show-key").textContent = "Show";
    element("show-key").setAttribute("aria-pressed", "false");
  }

  function updateControls() {
    const unavailable = !loaded || status === "offline";
    const busy = status === "busy";
    element("native-settings").disabled = unavailable || pending;
    element("save").disabled = unavailable || pending || busy || !dirty;
    element("reset").disabled = unavailable || pending;
    element("reload").disabled = pending;
    element("reconnect").disabled = pending || busy || (status !== "offline" && !restartRequired);
    element("restart-now").disabled = pending || busy;
    element("rotate-key").disabled = unavailable || pending || busy;
    element("confirm-rotate").disabled = unavailable || pending || busy;
    element("inspect").disabled = unavailable || pending || busy || status === "no-tab";
    element("use-session").disabled = unavailable || pending || !selectedSession();
    element("copy-key").disabled = !element("api-key").value;
    element("show-key").disabled = !element("api-key").value;
    element("copy-url").disabled = !element("base-url").value;
    element("restart").hidden = !restartRequired;
    const [label, variant] = labels[status] || labels.offline;
    element("status").textContent = label;
    element("status").dataset.variant = variant;
    element("save-state").textContent = pending ? "Working…" : unavailable ? "Connect the native app to edit settings." : dirty ? "Unsaved changes" : "All changes saved";
    for (const select of Object.values(selects)) select.sync();
  }

  function setForm(config) {
    for (const key of Object.keys(defaults)) {
      const control = element(key);
      if (typeof defaults[key] === "boolean") control.checked = config[key];
      else control.value = String(config[key]);
      control.removeAttribute("aria-invalid");
    }
    selects.thinking.sync();
  }

  function readForm() {
    const config = {};
    for (const key of Object.keys(defaults)) {
      const control = element(key);
      control.removeAttribute("aria-invalid");
      config[key] = typeof defaults[key] === "boolean" ? control.checked : control.value.trim();
    }
    function invalid(key, text) {
      selectSection(key === "port" ? "connection" : Object.hasOwn(numeric, key) ? "advanced" : "general");
      element(key).setAttribute("aria-invalid", "true");
      element(key).focus();
      throw new Error(text);
    }
    if (!config.session_name || config.session_name.length > 200) invalid("session_name", "Enter a session name of 1–200 characters.");
    if (config.default_model.length > 200) invalid("default_model", "The default model ID must be at most 200 characters.");
    if (!["minimal", "low", "medium", "high"].includes(config.thinking)) invalid("thinking", "Choose a valid thinking effort.");
    for (const [key, [minimum, maximum]] of Object.entries(numeric)) {
      const value = Number(config[key]);
      if (!config[key] || !Number.isInteger(value) || value < minimum || value > maximum) {
        invalid(key, `${key === "port" ? "Port" : "Timeout"} must be a whole number from ${minimum} to ${maximum}.`);
      }
      config[key] = value;
    }
    if (config.idle_timeout_seconds > config.chat_timeout_seconds) invalid("idle_timeout_seconds", "Idle timeout cannot be longer than chat timeout.");
    return config;
  }

  function markDirty(event) {
    if (event && !Object.hasOwn(defaults, event.target?.id)) return;
    dirty = true;
    message("notice", "");
    updateControls();
  }

  function applyResponse(response, replaceForm) {
    if (!response.config || typeof response.config !== "object") throw new Error("The native app returned invalid settings.");
    saved = { ...defaults, ...response.config };
    loaded = true;
    status = Object.hasOwn(labels, response.bridgeStatus) ? response.bridgeStatus : "ready";
    restartRequired = response.restartRequired === true;
    element("base-url").value = response.baseURL || "";
    if (element("api-key").value !== (response.apiKey || "")) hideKey();
    element("api-key").value = response.apiKey || "";
    if (replaceForm) { setForm(saved); dirty = false; }
    updateControls();
  }

  async function loadSettings(replaceForm = true) {
    if (pending) { if (!replaceForm) refreshAfterOperation = true; return; }
    const revision = ++loading;
    pending = true;
    updateControls();
    try {
      const response = await BridgeUI.request("getSettings");
      if (revision !== loading) return;
      applyResponse(response, replaceForm || !loaded);
      message("error", response.bridgeError || "");
      if (replaceForm) message("notice", "");
    } catch (error) {
      if (revision !== loading) return;
      if (!loaded) status = "offline";
      message("error", error.message || "Could not load settings.");
    } finally {
      if (revision === loading) finishOperation();
    }
  }

  async function save(event) {
    event.preventDefault();
    if (!loaded || pending || status === "offline" || status === "busy" || !dirty) return;
    message("error", "");
    let config;
    try { config = readForm(); }
    catch (error) { message("error", error.message); return; }
    pending = true;
    updateControls();
    try {
      const response = await BridgeUI.request("saveSettings", { config });
      applyResponse(response, true);
      message("notice", "Settings saved.");
    } catch (error) {
      message("error", error.message || "Could not save settings. Your changes are still in the form.");
    } finally { finishOperation(); }
  }

  async function reconnect() {
    if (pending || status === "busy") return;
    pending = true;
    updateControls();
    try {
      await BridgeUI.request("reconnect");
      message("notice", "Reconnecting. Saved settings will apply when the native app starts.");
    } catch (error) { message("error", error.message || "Could not reconnect."); }
    finally { finishOperation(); }
  }

  function selectedSession() {
    const value = element("school-session").value;
    if (!/^\d+$/.test(value)) return null;
    const session = sessions[Number(value)];
    return session?.safe ? session : null;
  }

  async function inspect() {
    if (pending || !loaded || !["ready"].includes(status)) return;
    pending = true;
    updateControls();
    message("error", "");
    try {
      const result = await BridgeUI.request("inspectSchool");
      if (!Array.isArray(result.models) || !Array.isArray(result.sessions)) throw new Error("XIPU AI returned an invalid session or model list.");
      const counts = new Map();
      for (const session of result.sessions) counts.set(session.name, (counts.get(session.name) || 0) + 1);
      sessions = result.sessions.filter(session => typeof session.name === "string" && typeof session.model === "string").map(session => ({
        ...session, safe: Boolean(session.name.trim()) && counts.get(session.name) === 1 && session.contextCount === 0
      }));
      selects.schoolSession.setItems([
        { value: "", label: "Choose a session" },
        ...sessions.map((session, index) => ({
          value: String(index),
          label: `${session.name} · ${session.model} · context ${session.contextCount}${session.safe ? "" : " · unavailable"}`,
          disabled: !session.safe
        }))
      ]);
      selects.schoolSession.setValue("");
      element("model-catalog").replaceChildren();
      for (const model of result.models) {
        if (typeof model.id !== "string") continue;
        const option = document.createElement("option");
        option.value = model.id;
        option.label = typeof model.name === "string" ? model.name : model.id;
        element("model-catalog").appendChild(option);
      }
      element("discovery-results").hidden = false;
      element("discovery-info").textContent = `${sessions.filter(session => session.safe).length} usable sessions. Duplicate names and nonzero context counts cannot be selected. Using a session fills its name and default model in this form.`;
      message("notice", "Sessions and models loaded. No school conversation was changed.");
    } catch (error) { message("error", error.message || "Could not read XIPU AI sessions."); }
    finally { finishOperation(); }
  }

  async function rotateKey() {
    if (pending || !loaded || status === "offline" || status === "busy" || element("rotate-confirm").hidden) return;
    pending = true;
    updateControls();
    try {
      const response = await BridgeUI.request("rotateKey");
      if (typeof response.apiKey !== "string" || !response.apiKey) throw new Error("The native app did not return a new key.");
      hideKey();
      element("api-key").value = response.apiKey;
      element("rotate-confirm").hidden = true;
      message("error", "");
      message("notice", "API key replaced. Copy the new key into every client.");
    } catch (error) { message("error", error.message || "Could not replace the API key."); }
    finally { finishOperation(); element("rotate-key").focus(); }
  }

  async function copy(id, label) {
    if (!element(id).value) return;
    try { await navigator.clipboard.writeText(element(id).value); message("notice", `${label} copied.`); }
    catch { message("error", id === "api-key" ? "Copy failed. Show the key, select it, and copy manually." : "Copy failed. Select the URL and copy it manually."); }
  }

  const compactNavigation = matchMedia("(max-width: 700px)");
  const updateOrientation = () => element("settings-tabs").setAttribute("aria-orientation", compactNavigation.matches ? "horizontal" : "vertical");
  compactNavigation.addEventListener("change", updateOrientation);
  updateOrientation();
  for (const [index, section] of sections.entries()) {
    element(`tab-${section}`).addEventListener("click", () => selectSection(section));
    element(`tab-${section}`).addEventListener("keydown", event => {
      let target;
      if (["ArrowRight", "ArrowDown"].includes(event.key)) target = (index + 1) % sections.length;
      else if (["ArrowLeft", "ArrowUp"].includes(event.key)) target = (index + sections.length - 1) % sections.length;
      else if (event.key === "Home") target = 0;
      else if (event.key === "End") target = sections.length - 1;
      else return;
      event.preventDefault();
      selectSection(sections[target], true);
    });
  }
  selectSection("general");
  element("extension-id").textContent = chrome.runtime.id;
  element("settings-form").addEventListener("submit", save);
  element("settings-form").addEventListener("input", markDirty);
  element("reload").addEventListener("click", () => loadSettings(true));
  element("reset").addEventListener("click", () => { if (!loaded || pending || status === "offline") return; setForm(defaults); markDirty(); message("notice", "Defaults loaded in the form. Save changes to apply them."); });
  element("reconnect").addEventListener("click", reconnect);
  element("restart-now").addEventListener("click", reconnect);
  element("inspect").addEventListener("click", inspect);
  element("school-session").addEventListener("change", updateControls);
  element("use-session").addEventListener("click", () => {
    const session = selectedSession();
    if (!session || pending || status === "offline") return;
    element("session_name").value = session.name;
    element("default_model").value = session.model;
    markDirty();
    message("notice", "Session details added to the form. Save changes to apply them.");
  });
  element("show-key").addEventListener("click", () => {
    if (element("api-key").type === "text") return hideKey();
    element("api-key").type = "text";
    element("show-key").textContent = "Hide";
    element("show-key").setAttribute("aria-pressed", "true");
  });
  element("copy-url").addEventListener("click", () => copy("base-url", "Base URL"));
  element("copy-key").addEventListener("click", () => copy("api-key", "API key"));
  element("rotate-key").addEventListener("click", () => { if (element("rotate-key").disabled) return; element("rotate-confirm").hidden = false; element("cancel-rotate").focus(); });
  element("cancel-rotate").addEventListener("click", () => { element("rotate-confirm").hidden = true; element("rotate-key").focus(); });
  element("confirm-rotate").addEventListener("click", rotateKey);
  element("theme").addEventListener("change", async () => {
    try { await BridgeUI.setTheme(element("theme").value); }
    catch (error) { message("error", error.message); }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) hideKey(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const previous = status;
    if (changes.bridgeStatus) status = Object.hasOwn(labels, changes.bridgeStatus.newValue) ? changes.bridgeStatus.newValue : "offline";
    if (changes.baseURL) element("base-url").value = changes.baseURL.newValue || "";
    if (changes.apiKey) { hideKey(); element("api-key").value = changes.apiKey.newValue || ""; }
    if (changes.restartRequired) restartRequired = changes.restartRequired.newValue === true;
    if (changes.bridgeError?.newValue) message("error", changes.bridgeError.newValue);
    updateControls();
    if (previous === "offline" && status !== "offline") {
      if (pending) refreshAfterOperation = true;
      else loadSettings(false);
    }
  });
  loadSettings(true);
})();
