const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const extension = path.join(__dirname, "../extension");
const html = fs.readFileSync(path.join(extension, "setup.html"), "utf8");
const source = fs.readFileSync(path.join(extension, "setup.js"), "utf8");
const shared = fs.readFileSync(path.join(extension, "ui-settings.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

function mount(initial = {}) {
  let document;
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    id, value: id === "session-name" ? "XIPU AI Bridge" : "", textContent: "", dataset: {}, attributes: {}, listeners: {},
    disabled: false, hidden: false, type: id === "api-key" ? "password" : "text",
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    focus() { document.activeElement = this; }
  }]));
  const state = {
    status: "ready", config: { session_name: "XIPU AI Bridge", default_model: "", port: 8765 },
    progress: null, session: null, onboardingComplete: false, setupRunning: false, messages: [], handlers: {}, copied: [], opened: 0, clipboardError: false,
    models: [{ id: "paid-model", name: "Paid model" }, { id: "qwen3.6-27b", name: "Qwen" }], sessions: [], theme: "system", ...initial
  };
  const changed = [];
  state.emit = changes => { for (const listener of changed) listener(changes, "local"); };
  const snapshot = () => ({
    ok: true, bridgeStatus: state.status, bridgeError: "", config: { ...state.config },
    baseURL: "http://127.0.0.1:8765/v1", apiKey: "synthetic-local-key",
    setupProgress: state.progress, setupSession: state.session, onboardingComplete: state.onboardingComplete,
    setupRunning: state.setupRunning, setupError: state.setupError
  });
  state.complete = (name = "XIPU AI Bridge", model = "qwen3.6-27b") => {
    state.progress = { name, model, phase: "complete", session_id: "created-session" };
    state.session = { id: "created-session", name, model, contextCount: 0 };
    Object.assign(state.config, { session_name: name, default_model: model });
    return snapshot();
  };
  const selects = new Map();
  const BridgeSelect = {
    create(button, items) {
      const select = {
        items,
        setItems(values) { this.items = values; this.sync(); },
        setValue(value) { button.value = value; this.sync(); },
        sync() { button.textContent = this.items.find(item => item.value === button.value)?.label || ""; }
      };
      selects.set(button.id, select);
      return select;
    },
    sync(button) { selects.get(button.id)?.sync(); }
  };
  document = {
    hidden: false, documentElement: { dataset: {} }, getElementById: id => elements.get(id),
    addEventListener(name, callback) { if (name === "visibilitychange") state.visibility = callback; }
  };
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({ document, BridgeSelect,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: {
    runtime: {
      openOptionsPage: async () => { state.opened++; },
      sendMessage: async message => {
        state.messages.push(message);
        if (state.handlers[message.type]) return state.handlers[message.type](message);
        if (message.type === "getSetupState") return snapshot();
        if (message.type === "inspectSchool") return { ok: true, models: state.models, sessions: state.sessions };
        if (message.type === "setupSchool") return state.complete(message.name, message.model);
        if (message.type === "checkSetup") return snapshot();
        if (message.type === "cancelSetup") { state.setupRunning = false; state.status = "ready"; return snapshot(); }
        if (message.type === "reconnect") return { ok: true };
        throw new Error(`Unexpected message: ${message.type}`);
      }
    },
    storage: {
      local: { get: async () => ({ theme: state.theme }) },
      onChanged: { addListener: callback => changed.push(callback) }
    }
  }, navigator: { clipboard: { writeText: async value => {
    if (state.clipboardError) throw new Error("Clipboard unavailable");
    state.copied.push(value);
  } } } });
  vm.runInContext(shared, context);
  vm.runInContext(source, context);
  return {
    state, document, get: id => elements.get(id), selects, snapshot,
    expire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } },
    click: id => elements.get(id).listeners.click(),
    choose(value) { elements.get("model").value = value; elements.get("model").listeners.change(); },
    submit: () => elements.get("session-form").listeners.submit({ preventDefault() {} })
  };
}

test("connected tab alone is not setup complete and has no implicit school request", async () => {
  const ui = mount(); await tick();
  assert.deepEqual(ui.state.messages.map(message => message.type), ["getSetupState"]);
  assert.equal(ui.get("session-panel").hidden, false);
  assert.equal(ui.get("client-panel").hidden, true);
  assert.equal(ui.get("api-key").value, "");
  assert.equal(ui.get("create-session").disabled, true);
  assert.equal(ui.get("step-2").attributes["aria-current"], "step");
  assert.equal(ui.get("step-1").dataset.state, "complete");
  assert.equal(ui.get("step-2").dataset.state, "active");
  assert.equal(ui.get("step-3").dataset.state, "upcoming");
});

test("a busy bridge preserves the current step and disables actions until ready", async () => {
  const ui = mount(); await tick(); await ui.click("inspect");
  ui.state.status = "busy";
  ui.state.emit({ bridgeStatus: {} }); await tick();
  assert.equal(ui.get("session-panel").hidden, false);
  assert.equal(ui.get("connection-panel").hidden, true);
  assert.equal(ui.get("connection-status").textContent, "In progress");
  assert.equal(ui.get("create-session").disabled, true);
  ui.state.status = "ready";
  ui.state.emit({ bridgeStatus: {} }); await tick();
  assert.equal(ui.get("session-panel").hidden, false);
  assert.equal(ui.get("create-session").disabled, false);
});

test("model loading names the active operation without implying session creation", async () => {
  const ui = mount(); await tick();
  let resolveModels;
  ui.state.handlers.inspectSchool = () => new Promise(resolve => { resolveModels = resolve; });
  const loading = ui.click("inspect");
  assert.equal(ui.get("inspect").textContent, "Loading models…");
  assert.equal(ui.get("create-session").textContent, "Create bridge session");
  assert.equal(ui.get("create-session").disabled, true);
  assert.match(ui.get("connection-detail").textContent, /Reading available models/);
  resolveModels({ ok: true, models: ui.state.models, sessions: [] }); await loading;
  assert.equal(ui.get("inspect").textContent, "Load models");
  assert.equal(ui.get("create-session").disabled, false);
});

test("model discovery selects available Qwen and creation requires an explicit submit", async () => {
  const ui = mount(); await tick();
  await ui.click("inspect");
  assert.equal(ui.get("model").value, "qwen3.6-27b");
  assert.equal(ui.get("create-session").disabled, false);
  assert.equal(ui.state.messages.some(message => message.type === "setupSchool"), false);
  ui.get("session-name").value = "  My dedicated session  ";
  await ui.submit();
  const request = ui.state.messages.find(message => message.type === "setupSchool");
  assert.equal(request.name, "My dedicated session");
  assert.equal(request.model, "qwen3.6-27b");
  assert.equal(ui.get("client-panel").hidden, false);
  assert.equal(ui.get("api-key").type, "password");
  assert.match(ui.get("ready-session").textContent, /My dedicated session/);
});

test("absence of free Qwen requires an explicit model choice", async () => {
  const ui = mount({ models: [{ id: "paid-model", name: "Paid model" }] }); await tick();
  await ui.click("inspect");
  assert.equal(ui.get("model").value, "");
  assert.equal(ui.get("create-session").disabled, true);
  await ui.submit();
  assert.equal(ui.state.messages.some(message => message.type === "setupSchool"), false);
  ui.choose("paid-model");
  await ui.submit();
  assert.equal(ui.state.session.model, "paid-model");
});

test("rejects blank, duplicate, and unavailable choices before creating", async () => {
  const ui = mount({ sessions: [{ name: "Existing conversation" }] }); await tick(); await ui.click("inspect");
  for (const name of [" ", "x".repeat(201), "Existing conversation"]) {
    ui.get("session-name").value = name;
    await ui.submit();
    assert.equal(ui.get("session-name").attributes["aria-invalid"], "true");
    assert.equal(ui.get("error").hidden, false);
  }
  ui.choose("unavailable-model");
  await ui.submit();
  assert.equal(ui.state.messages.some(message => message.type === "setupSchool"), false);
});

test("offline, missing tab, and busy states block discovery and creation", async () => {
  for (const status of ["offline", "no-tab", "busy"]) {
    const ui = mount({ status }); await tick();
    assert.equal(ui.get("connection-panel").hidden, false);
    assert.equal(ui.get("client-panel").hidden, true);
    await ui.click("inspect"); await ui.submit();
    assert.deepEqual(ui.state.messages.map(message => message.type), ["getSetupState"]);
  }
});

test("known partial setup resumes with the original identity without rediscovery", async () => {
  for (const phase of ["created", "configured"]) {
    const ui = mount({ progress: { name: "Recovery session", model: "paid-model", phase, session_id: "created-session" } }); await tick();
    assert.equal(ui.get("create-session").textContent, "Resume setup");
    assert.equal(ui.get("model").disabled, true);
    assert.equal(ui.get("session-name").disabled, true);
    assert.equal(ui.get("inspect").disabled, true);
    await ui.submit();
    const request = ui.state.messages.find(message => message.type === "setupSchool");
    assert.equal(request.name, "Recovery session");
    assert.equal(request.model, "paid-model");
    assert.equal(ui.get("client-panel").hidden, false);
  }
});

test("uncertain creation needs an explicit school check and cannot be resubmitted", async () => {
  const ui = mount({ progress: { name: "Uncertain session", model: "qwen3.6-27b", phase: "creating" } }); await tick();
  assert.equal(ui.get("create-session").disabled, true);
  assert.match(ui.get("recovery").textContent, /not yet confirmed/);
  await ui.submit(); await ui.click("inspect"); await ui.click("check-setup");
  assert.deepEqual(ui.state.messages.map(message => message.type), ["getSetupState", "checkSetup"]);
});

test("failed setup refreshes persisted recovery and never retries automatically", async () => {
  const ui = mount(); await tick(); await ui.click("inspect");
  ui.state.handlers.setupSchool = message => {
    ui.state.progress = { name: message.name, model: message.model, phase: "configured", session_id: "created-session" };
    return { ok: false, error: "Could not save local settings." };
  };
  await ui.submit();
  assert.equal(ui.get("create-session").textContent, "Resume setup");
  assert.equal(ui.get("client-panel").hidden, true);
  assert.match(ui.get("error").textContent, /save local settings/);
  assert.equal(ui.state.messages.filter(message => message.type === "setupSchool").length, 1);
});

test("failed recovery read keeps creation blocked until status is confirmed", async () => {
  const ui = mount(); await tick(); await ui.click("inspect");
  ui.state.handlers.setupSchool = () => { throw new Error("Connection lost"); };
  ui.state.handlers.getSetupState = () => { throw new Error("Status unavailable"); };
  await ui.submit();
  assert.equal(ui.get("create-session").disabled, true);
  assert.equal(ui.get("connection-panel").hidden, false);
  await ui.submit();
  assert.equal(ui.state.messages.filter(message => message.type === "setupSchool").length, 1);
});

test("successful refresh clears a previous status-read failure", async () => {
  const ui = mount(); await tick();
  ui.state.handlers.getSetupState = () => { throw new Error("Temporary status failure"); };
  await ui.click("check-connection");
  assert.match(ui.get("error").textContent, /Temporary status failure/);
  assert.equal(ui.get("connection-status").textContent, "Status unavailable");
  delete ui.state.handlers.getSetupState;
  await ui.click("check-connection");
  assert.equal(ui.get("error").hidden, true);
  assert.equal(ui.get("connection-status").textContent, "Connected");
});

test("ready requires matching saved settings, verified session, and a connected tab", async () => {
  const ui = mount(); await tick();
  ui.state.complete();
  ui.state.emit({ setupProgress: {} }); await tick();
  assert.equal(ui.get("client-panel").hidden, false);
  ui.state.config.default_model = "another-model";
  ui.state.emit({ hostConfig: {} }); await tick();
  assert.equal(ui.get("client-panel").hidden, true);
  assert.equal(ui.get("create-session").disabled, true);
  assert.match(ui.get("recovery").textContent, /saved connection has changed/);
  ui.state.complete(); ui.state.status = "no-tab";
  ui.state.emit({ bridgeStatus: {} }); await tick();
  assert.equal(ui.get("client-panel").hidden, true);
  assert.equal(ui.get("api-key").value, "");
});

test("pending creation permits local refresh without retrying or warning about a healthy request", async () => {
  const ui = mount(); await tick(); await ui.click("inspect");
  let resolveSetup;
  ui.state.handlers.setupSchool = () => new Promise(resolve => { resolveSetup = resolve; });
  const first = ui.submit();
  assert.equal(ui.get("recovery").hidden, true);
  assert.equal(ui.get("create-session").textContent, "Setting up…");
  assert.equal(ui.get("check-connection").disabled, false);
  assert.equal(ui.get("stop-waiting").hidden, false);
  ui.state.progress = { name: "XIPU AI Bridge", model: "qwen3.6-27b", phase: "creating" };
  ui.state.setupRunning = true;
  ui.state.emit({ bridgeStatus: {} });
  await tick();
  assert.equal(ui.get("recovery").hidden, true);
  await ui.submit();
  assert.equal(ui.state.messages.filter(message => message.type === "setupSchool").length, 1);
  assert.equal(ui.state.messages.filter(message => message.type === "getSetupState").length, 2);
  ui.state.setupRunning = false;
  resolveSetup(ui.state.complete()); await first;
  assert.equal(ui.get("client-panel").hidden, false);
  assert.equal(ui.state.messages.filter(message => message.type === "getSetupState").length, 2);
});

test("manual settings completion reveals locally saved client details despite uncertain old progress", async () => {
  const ui = mount({ setupError: "Stored setup progress is invalid.", progress: { name: "Old attempt", model: "paid-model", phase: "creating" } }); await tick();
  ui.state.config = { session_name: "Manually selected", default_model: "qwen3.6-27b", port: 8765 };
  ui.state.onboardingComplete = true;
  ui.state.emit({ onboardingComplete: {} }); await tick();
  assert.equal(ui.get("client-panel").hidden, false);
  assert.equal(ui.get("client-status").textContent, "Saved locally");
  assert.equal(ui.get("client-verification").hidden, false);
  assert.equal(ui.get("ready-session").textContent, "Manually selected · qwen3.6-27b");
  assert.equal(ui.get("api-key").value, "synthetic-local-key");
  assert.equal(ui.get("error").hidden, true);
  assert.equal(ui.state.messages.some(message => message.type !== "getSetupState"), false);
});

test("school recovery is explicit and updates confirmed identity without automatically resuming", async () => {
  const ui = mount({ progress: { name: "Recovery", model: "qwen3.6-27b", phase: "creating" } }); await tick();
  await ui.click("check-connection");
  assert.equal(ui.state.messages.some(message => message.type === "checkSetup"), false);
  ui.state.handlers.checkSetup = () => {
    ui.state.progress = { ...ui.state.progress, phase: "created", session_id: "recovered-id" };
    return ui.snapshot();
  };
  await ui.click("check-setup");
  assert.equal(ui.get("create-session").textContent, "Resume setup");
  assert.equal(ui.get("create-session").disabled, false);
  assert.equal(ui.state.messages.filter(message => message.type === "checkSetup").length, 1);
  assert.equal(ui.state.messages.some(message => message.type === "setupSchool"), false);
});

test("status deadline releases refresh and ignores a later stale response", async () => {
  const ui = mount(); await tick();
  const stale = { ...ui.snapshot(), bridgeStatus: "offline" };
  let resolveStatus;
  ui.state.handlers.getSetupState = () => new Promise(resolve => { resolveStatus = resolve; });
  const refresh = ui.click("check-connection");
  ui.expire(10000); await refresh;
  assert.equal(ui.get("check-connection").disabled, false);
  assert.match(ui.get("error").textContent, /timed out/);
  delete ui.state.handlers.getSetupState;
  await ui.click("check-connection");
  resolveStatus(stale); await tick();
  assert.equal(ui.get("connection-status").textContent, "Connected");
});

test("setup deadline unlocks recovery and ignores late success without retrying", async () => {
  const ui = mount(); await tick(); await ui.click("inspect");
  let resolveSetup;
  ui.state.handlers.setupSchool = () => new Promise(resolve => { resolveSetup = resolve; });
  const setup = ui.submit();
  ui.state.progress = { name: "XIPU AI Bridge", model: "qwen3.6-27b", phase: "creating" };
  ui.expire(110000); await setup;
  assert.equal(ui.get("check-connection").disabled, false);
  assert.equal(ui.get("check-setup").disabled, false);
  assert.equal(ui.get("create-session").disabled, true);
  assert.equal(ui.get("settings").hidden, false);
  assert.match(ui.get("error").textContent, /may already have completed/);
  resolveSetup(ui.state.complete()); await tick();
  assert.equal(ui.get("client-panel").hidden, true);
  assert.equal(ui.state.messages.filter(message => message.type === "setupSchool").length, 1);
});

test("model and school-check deadlines unlock controls and do not replay requests", async () => {
  for (const type of ["inspectSchool", "checkSetup"]) {
    const progress = type === "checkSetup" ? { name: "Recovery", model: "qwen3.6-27b", phase: "creating" } : null;
    const ui = mount({ progress }); await tick();
    ui.state.handlers[type] = () => new Promise(() => {});
    const request = ui.click(type === "checkSetup" ? "check-setup" : "inspect");
    ui.expire(35000); await request;
    assert.equal(ui.get("check-connection").disabled, false);
    assert.equal(ui.get("settings").hidden, false);
    assert.match(ui.get("error").textContent, /timed out/);
    assert.equal(ui.state.messages.filter(message => message.type === type).length, 1);
  }
});

test("Stop waiting cancels only through the dedicated RPC and ignores the old setup reply", async () => {
  const ui = mount(); await tick(); await ui.click("inspect");
  let resolveSetup;
  ui.state.handlers.setupSchool = () => new Promise(resolve => { resolveSetup = resolve; });
  const first = ui.submit();
  ui.state.progress = { name: "XIPU AI Bridge", model: "qwen3.6-27b", phase: "creating" };
  await ui.click("stop-waiting");
  assert.match(ui.get("notice").textContent, /may already have completed/);
  assert.equal(ui.get("create-session").disabled, true);
  assert.equal(ui.get("check-setup").disabled, false);
  assert.equal(ui.state.messages.filter(message => message.type === "cancelSetup").length, 1);
  resolveSetup(ui.state.complete()); await first;
  assert.equal(ui.get("client-panel").hidden, true);
  assert.equal(ui.state.messages.filter(message => message.type === "setupSchool").length, 1);
});

test("API requests do not offer a setup cancellation action", async () => {
  const ui = mount({ status: "busy", setupRunning: false }); await tick();
  assert.equal(ui.get("stop-waiting").hidden, true);
  assert.equal(ui.get("check-connection").disabled, false);
});

test("reopening an active setup preserves its step and exposes local recovery controls", async () => {
  const ui = mount({ status: "busy", setupRunning: true, progress: { name: "XIPU AI Bridge", model: "qwen3.6-27b", phase: "creating" } }); await tick();
  assert.equal(ui.get("session-panel").hidden, false);
  assert.equal(ui.get("connection-panel").hidden, true);
  assert.equal(ui.get("stop-waiting").hidden, false);
  assert.equal(ui.get("check-connection").disabled, false);
  assert.equal(ui.get("recovery").hidden, true);
  assert.match(ui.get("connection-detail").textContent, /Setup is running/);
});

test("invalid saved setup state leaves local status and manual settings available", async () => {
  const ui = mount({ setupError: "Stored setup progress is invalid. Select a conversation in Settings." }); await tick();
  assert.equal(ui.get("connection-status").textContent, "Connected");
  assert.match(ui.get("error").textContent, /Stored setup progress/);
  assert.equal(ui.get("settings").hidden, false);
  assert.equal(ui.get("check-connection").disabled, false);
  assert.equal(ui.get("inspect").disabled, true);
  assert.equal(ui.get("create-session").disabled, true);
  await ui.click("settings"); assert.equal(ui.state.opened, 1);
});

test("copies only local client values, masks on hide, and shares the theme", async () => {
  const ui = mount({ theme: "dark" }); await tick();
  assert.equal(ui.document.documentElement.dataset.theme, "dark");
  ui.state.complete(); ui.state.emit({ setupProgress: {} }); await tick();
  await ui.click("copy-url"); await ui.click("copy-key");
  assert.deepEqual(ui.state.copied, ["http://127.0.0.1:8765/v1", "synthetic-local-key"]);
  await ui.click("show-key"); assert.equal(ui.get("api-key").type, "text");
  ui.document.hidden = true; ui.state.visibility(); assert.equal(ui.get("api-key").type, "password");
  ui.state.clipboardError = true; await ui.click("copy-key");
  assert.match(ui.get("error").textContent, /copy manually/);
  await ui.click("finish"); assert.equal(ui.state.opened, 1);
});
