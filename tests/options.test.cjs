const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const root = path.join(__dirname, "../extension");
const html = fs.readFileSync(path.join(root, "options.html"), "utf8");
const shared = fs.readFileSync(path.join(root, "ui-settings.js"), "utf8");
const source = fs.readFileSync(path.join(root, "options.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const initialConfig = () => ({ session_name: "Native session", port: 9876, default_model: "model-a", thinking: "low", online: false, chat_timeout_seconds: 300, model_timeout_seconds: 30, idle_timeout_seconds: 90, include_reasoning: true });

function mount(status = "ready") {
  let document;
  const makeElement = (id = "") => ({
    id, value: "", textContent: "", dataset: {}, attributes: {}, listeners: {}, children: [], disabled: false,
    hidden: ["error", "notice", "restart", "rotate-confirm", "discovery-results"].includes(id), checked: false,
    type: id === "api-key" ? "password" : "text",
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; this.value = ""; },
    focus() { document.activeElement = this; }
  });
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, makeElement(id)]));
  const selects = new Map();
  const BridgeSelect = {
    create(button, items) {
      const select = {
        items, syncCount: 0,
        setItems(values) { this.items = values; this.sync(); },
        setValue(value) { button.value = value; this.sync(); },
        sync() { ++this.syncCount; button.textContent = this.items.find(item => item.value === button.value)?.label || ""; },
        close() {}
      };
      selects.set(button.id, select);
      return select;
    },
    sync(button) { selects.get(button.id)?.sync(); }
  };
  const changed = [];
  const state = {
    config: initialConfig(), status, apiKey: "synthetic-key-before", messages: [], errors: {}, handlers: {}, copied: [],
    local: { theme: "system" }, writeFailure: false, restartRequired: false,
    sessions: [
      { id: 1, name: "Safe session", model: "model-b", contextCount: 0 },
      { id: 2, name: "Unsafe context", model: "model-a", contextCount: 3 },
      { id: 3, name: "Duplicate", model: "model-a", contextCount: 0 },
      { id: 4, name: "Duplicate", model: "model-b", contextCount: 0 }
    ],
    emit(changes) { for (const listener of changed) listener(changes, "local"); }
  };
  state.media = { matches: false, addEventListener(name, callback) { this.listener = callback; } };
  document = { hidden: false, documentElement: { dataset: {} }, getElementById: id => elements.get(id), createElement: () => makeElement(), addEventListener() {} };
  const snapshot = () => ({ ok: true, config: { ...state.config }, bridgeStatus: state.status, bridgeError: "", baseURL: `http://127.0.0.1:${state.config.port}/v1`, apiKey: state.apiKey, restartRequired: state.restartRequired });
  const context = vm.createContext({
    document,
    BridgeSelect,
    matchMedia: () => state.media,
    chrome: {
      runtime: { id: "abcdefghijklmnopabcdefghijklmnop", sendMessage: async message => {
        state.messages.push(message);
        if (state.handlers[message.type]) return state.handlers[message.type](message);
        if (state.errors[message.type]) return { ok: false, error: state.errors[message.type] };
        if (state.status === "offline" && message.type !== "reconnect") return { ok: false, error: "The native app is offline." };
        if (message.type === "getSettings") return snapshot();
        if (message.type === "saveSettings") { state.restartRequired = message.config.port !== state.config.port; state.config = { ...message.config }; return snapshot(); }
        if (message.type === "rotateKey") { state.apiKey = "synthetic-key-after"; return { ok: true, apiKey: state.apiKey }; }
        if (message.type === "inspectSchool") return { ok: true, models: [{ id: "model-b", name: "Example model" }], sessions: state.sessions };
        if (message.type === "reconnect") return { ok: true };
        throw new Error("Unexpected test message " + message.type);
      } },
      storage: {
        local: { get: async () => state.local, set: async values => {
          if (state.writeFailure) throw new Error("Write failed");
          Object.assign(state.local, values);
          state.emit(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])));
        } },
        onChanged: { addListener: callback => changed.push(callback) }
      }
    },
    navigator: { clipboard: { writeText: async value => state.copied.push(value) } }
  });
  vm.runInContext(shared, context);
  vm.runInContext(source, context);
  return {
    state, document, selects, get: id => elements.get(id), click: id => elements.get(id).listeners.click(),
    edit(id, value) { const target = elements.get(id); if (typeof value === "boolean") target.checked = value; else target.value = String(value); elements.get("settings-form").listeners.input({ target }); },
    submit: () => elements.get("settings-form").listeners.submit({ preventDefault() {} })
  };
}

test("loads native settings, masks the key, and saves a validated explicit draft", async () => {
  const ui = mount(); await tick();
  assert.equal(ui.get("session_name").value, "Native session");
  assert.equal(ui.get("native-settings").disabled, false);
  assert.equal(ui.get("api-key").type, "password");
  assert.equal(ui.get("save").disabled, true);
  assert.equal(ui.get("thinking").textContent, "Low");
  ui.edit("port", "8766");
  ui.edit("thinking", "high");
  ui.edit("online", true);
  await ui.submit();
  assert.equal(ui.state.config.port, 8766);
  assert.equal(ui.state.config.thinking, "high");
  assert.equal(ui.state.config.online, true);
  assert.equal(ui.get("thinking").textContent, "High");
  assert.equal(ui.get("restart").hidden, false);
  assert.equal(ui.get("save-state").textContent, "All changes saved");
  assert.equal(ui.get("notice").textContent, "Settings saved.");
});

test("failed saves preserve the draft and do not claim success", async () => {
  const ui = mount(); await tick();
  ui.state.errors.saveSettings = "Native app is busy.";
  ui.edit("session_name", "Unsaved draft");
  await ui.submit();
  assert.equal(ui.state.config.session_name, "Native session");
  assert.equal(ui.get("session_name").value, "Unsaved draft");
  assert.equal(ui.get("save-state").textContent, "Unsaved changes");
  assert.equal(ui.get("error").textContent, "Native app is busy.");
  assert.equal(ui.get("save").disabled, false);
});

test("offline and busy states prevent mutations without queuing changes", async () => {
  for (const status of ["offline", "busy"]) {
    const ui = mount(status); await tick();
    ui.edit("session_name", "Draft");
    await ui.submit();
    await ui.click("inspect");
    await ui.click("confirm-rotate");
    assert.equal(ui.state.messages.filter(message => message.type !== "getSettings").length, 0);
    assert.equal(ui.get("save").disabled, true);
    assert.equal(ui.get("rotate-key").disabled, true);
  }
});

test("validates whole-number ranges, required session and timeout relationship", async () => {
  const ui = mount(); await tick();
  for (const [id, value, error] of [["port", 0, /Port/], ["port", 12.5, /whole number/], ["session_name", " ", /session name/], ["idle_timeout_seconds", 301, /longer than chat/]]) {
    await ui.click("reload");
    ui.edit(id, value);
    await ui.submit();
    assert.match(ui.get("error").textContent, error);
    assert.equal(ui.get(id).attributes["aria-invalid"], "true");
  }
  assert.equal(ui.state.messages.filter(message => message.type === "saveSettings").length, 0);
});

test("status updates preserve unsaved edits; reset defaults only changes the form", async () => {
  const ui = mount(); await tick();
  ui.edit("session_name", "Keep this draft");
  ui.state.emit({ bridgeStatus: { newValue: "busy" } });
  ui.state.emit({ bridgeStatus: { newValue: "ready" } });
  assert.equal(ui.get("session_name").value, "Keep this draft");
  await ui.click("reset");
  assert.equal(ui.get("session_name").value, "XIPU AI Bridge");
  assert.equal(ui.get("port").value, "8765");
  assert.equal(ui.get("thinking").textContent, "Minimal");
  assert.equal(ui.state.config.session_name, "Native session");
  assert.match(ui.get("notice").textContent, /Save changes to apply/);
  assert.equal(ui.state.messages.filter(message => message.type === "saveSettings").length, 0);
});

test("read-only discovery disables unsafe sessions and only fills a draft", async () => {
  const ui = mount(); await tick();
  await ui.click("inspect");
  assert.equal(ui.get("model-catalog").children[0].value, "model-b");
  const items = ui.selects.get("school-session").items;
  assert.equal(items[1].disabled, false);
  assert.equal(items[2].disabled, true);
  assert.equal(items[3].disabled, true);
  assert.equal(items[4].disabled, true);
  ui.get("school-session").value = "1";
  await ui.click("use-session");
  assert.equal(ui.get("session_name").value, "Native session");
  ui.get("school-session").value = "0";
  await ui.click("use-session");
  assert.equal(ui.get("session_name").value, "Safe session");
  assert.equal(ui.get("default_model").value, "model-b");
  assert.equal(ui.state.config.session_name, "Native session");
  assert.deepEqual(ui.state.messages.map(message => message.type), ["getSettings", "inspectSchool"]);
  await ui.click("inspect");
  assert.equal(ui.get("school-session").value, "");
  assert.equal(ui.get("school-session").textContent, "Choose a session");
  assert.equal(ui.get("use-session").disabled, true);
});

test("key replacement requires confirmation and preserves the key on failure", async () => {
  const ui = mount(); await tick();
  await ui.click("confirm-rotate");
  assert.equal(ui.state.messages.length, 1);
  await ui.click("rotate-key");
  assert.equal(ui.get("rotate-confirm").hidden, false);
  assert.equal(ui.state.messages.length, 1);
  ui.state.errors.rotateKey = "Key write failed.";
  await ui.click("confirm-rotate");
  assert.equal(ui.get("api-key").value, "synthetic-key-before");
  assert.equal(ui.get("rotate-confirm").hidden, false);
  delete ui.state.errors.rotateKey;
  await ui.click("confirm-rotate");
  assert.equal(ui.get("api-key").value, "synthetic-key-after");
  assert.equal(ui.get("api-key").type, "password");
  assert.equal(ui.get("rotate-confirm").hidden, true);
  await ui.click("copy-key");
  assert.deepEqual(ui.state.copied, ["synthetic-key-after"]);
});

test("appearance persists immediately and rolls back after storage failure", async () => {
  const ui = mount(); await tick();
  ui.get("theme").value = "dark";
  await ui.get("theme").listeners.change();
  assert.equal(ui.document.documentElement.dataset.theme, "dark");
  assert.equal(ui.state.local.theme, "dark");
  assert.equal(ui.get("theme").textContent, "Dark");
  ui.state.writeFailure = true;
  ui.get("theme").value = "light";
  await ui.get("theme").listeners.change();
  assert.equal(ui.document.documentElement.dataset.theme, "dark");
  assert.equal(ui.get("theme").value, "dark");
  assert.equal(ui.get("theme").textContent, "Dark");
  assert.match(ui.get("error").textContent, /save appearance/);
  assert.equal(ui.state.messages.filter(message => message.type === "saveSettings").length, 0);
});

test("a failed appearance write does not roll back a newer storage update", async () => {
  const ui = mount(); await tick();
  ui.state.writeFailure = true;
  ui.get("theme").value = "dark";
  const pending = ui.get("theme").listeners.change();
  ui.state.emit({ theme: { newValue: "light" } });
  await pending;
  assert.equal(ui.document.documentElement.dataset.theme, "light");
  assert.equal(ui.get("theme").value, "light");
  assert.equal(ui.get("theme").textContent, "Light");
  assert.equal(ui.get("save").disabled, true);
});

test("reconnect refreshes metadata without replacing unsaved form values", async () => {
  const ui = mount(); await tick();
  ui.edit("session_name", "Unsaved session");
  ui.state.emit({ bridgeStatus: { newValue: "offline" } });
  await ui.click("reconnect");
  ui.state.emit({ bridgeStatus: { newValue: "ready" }, restartRequired: { newValue: false } });
  await tick();
  assert.equal(ui.get("session_name").value, "Unsaved session");
  assert.equal(ui.get("save-state").textContent, "Unsaved changes");
  assert.equal(ui.get("restart").hidden, true);
});

test("a deferred status refresh serializes saves and preserves the draft", async () => {
  const ui = mount(); await tick();
  ui.edit("session_name", "Draft during reconnect");
  let resolveRefresh;
  ui.state.handlers.getSettings = () => new Promise(resolve => { resolveRefresh = resolve; });
  ui.state.emit({ bridgeStatus: { newValue: "offline" } });
  ui.state.emit({ bridgeStatus: { newValue: "ready" } });
  assert.equal(ui.get("native-settings").disabled, true);
  assert.equal(ui.get("save").disabled, true);
  await ui.submit();
  assert.equal(ui.state.messages.filter(message => message.type === "saveSettings").length, 0);
  resolveRefresh({ ok: true, config: initialConfig(), bridgeStatus: "ready", apiKey: ui.state.apiKey, baseURL: "http://127.0.0.1:9876/v1" });
  await tick();
  assert.equal(ui.get("session_name").value, "Draft during reconnect");
  assert.equal(ui.get("save").disabled, false);
  await ui.submit();
  assert.equal(ui.state.config.session_name, "Draft during reconnect");
});

test("section tabs support keyboard navigation without losing unsaved values", async () => {
  const ui = mount(); await tick();
  assert.equal(ui.get("settings-tabs").attributes["aria-orientation"], "vertical");
  ui.state.media.matches = true;
  ui.state.media.listener();
  assert.equal(ui.get("settings-tabs").attributes["aria-orientation"], "horizontal");
  assert.equal(ui.get("panel-general").hidden, false);
  assert.equal(ui.get("panel-connection").hidden, true);
  ui.edit("default_model", "Draft model");
  let prevented = false;
  ui.get("tab-general").listeners.keydown({ key: "ArrowRight", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(ui.get("panel-general").hidden, true);
  assert.equal(ui.get("panel-connection").hidden, false);
  assert.equal(ui.get("tab-connection").attributes["aria-selected"], "true");
  assert.equal(ui.get("tab-general").tabIndex, -1);
  assert.equal(ui.document.activeElement, ui.get("tab-connection"));
  ui.get("tab-connection").listeners.keydown({ key: "End", preventDefault() {} });
  assert.equal(ui.get("panel-advanced").hidden, false);
  await ui.click("tab-general");
  assert.equal(ui.get("default_model").value, "Draft model");
  assert.equal(ui.get("save-state").textContent, "Unsaved changes");
  assert.deepEqual(ui.state.messages.map(message => message.type), ["getSettings"]);
});

test("validation reveals a hidden invalid setting before focusing it", async () => {
  const ui = mount(); await tick();
  ui.edit("port", 0);
  await ui.submit();
  assert.equal(ui.get("panel-connection").hidden, false);
  assert.equal(ui.document.activeElement, ui.get("port"));
  ui.edit("port", 8765);
  ui.edit("idle_timeout_seconds", 301);
  await ui.click("tab-general");
  await ui.submit();
  assert.equal(ui.get("panel-advanced").hidden, false);
  assert.equal(ui.document.activeElement, ui.get("idle_timeout_seconds"));
  assert.equal(ui.state.messages.filter(message => message.type === "saveSettings").length, 0);
});
