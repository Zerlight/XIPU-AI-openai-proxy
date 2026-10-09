const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const extension = path.join(__dirname, "../extension");
const html = fs.readFileSync(path.join(extension, "popup.html"), "utf8");
const source = fs.readFileSync(path.join(extension, "popup.js"), "utf8");
const sharedSource = fs.readFileSync(path.join(extension, "ui-settings.js"), "utf8");
const settled = () => new Promise(resolve => setImmediate(resolve));

function mount(initial = {}, options = {}) {
  const elements = new Map([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => [id, {
    value: "", textContent: "", dataset: {}, attributes: {}, listeners: {},
    disabled: /\bdisabled(?:\s|>)/.test(tag), hidden: /\bhidden(?:\s|>)/.test(tag), type: id === "key" ? "password" : "text",
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }]));
  const listeners = [];
  const state = { stored: initial, copied: [], sent: [], changed: (...args) => listeners.forEach(listener => listener(...args)), hidden: null, read: options.read || null, handlers: {}, clipboardError: false, messageError: false, optionsOpened: 0 };
  const document = {
    hidden: false,
    documentElement: { dataset: {} },
    getElementById: id => elements.get(id),
    addEventListener: (name, callback) => { if (name === "visibilitychange") state.hidden = callback; }
  };
  const context = vm.createContext({
    document,
    chrome: {
      storage: {
        local: { get: async keys => { state.requestedKeys = keys; return state.read ? state.read(keys) : state.stored; }, set: async values => { Object.assign(state.stored, values); } },
        onChanged: { addListener: callback => { listeners.push(callback); } }
      },
      runtime: {
        id: "abcdefghijklmnopabcdefghijklmnop",
        openOptionsPage: async () => { state.optionsOpened += 1; },
        sendMessage: async message => {
          state.sent.push(message);
          if (state.messageError) throw new Error("Test message failure");
          if (state.handlers[message.type]) return state.handlers[message.type](message);
          if (message.type === "skipSetup") {
            state.stored.onboardingComplete = true;
            state.changed({ onboardingComplete: { newValue: true } }, "local");
          }
          return { ok: true };
        }
      }
    },
    navigator: { clipboard: { writeText: async value => {
      if (state.clipboardError) throw new Error("Test clipboard failure");
      state.copied.push(value);
    } } }
  });
  vm.runInContext(sharedSource, context);
  vm.runInContext(source, context);
  return { state, document, get: id => elements.get(id), click: id => elements.get(id).listeners.click() };
}

test("renders dynamic session and state while keeping the API key masked", async () => {
  const popup = mount({ onboardingComplete: true, bridgeStatus: "ready", sessionName: "Bridge Test", apiKey: "synthetic-client-key", baseURL: "http://127.0.0.1:9900/v1", transport: "native-messaging" });
  await settled();
  assert.equal(popup.get("status").textContent, "Connected");
  assert.equal(popup.get("status").dataset.variant, "success");
  assert.equal(popup.get("session").textContent, "Bridge Test");
  assert.equal(popup.get("key").type, "password");
  assert.equal(popup.get("key").value, "synthetic-client-key");
  assert.equal(popup.get("retry").disabled, true);
  assert.equal(popup.get("error").hidden, true);
  assert.equal(popup.get("endpoint").value, "http://127.0.0.1:9900/v1");
  assert.ok(Array.isArray(popup.state.requestedKeys));
  assert.ok(!html.includes("qwen"));
});

test("opens settings and follows the shared appearance preference", async () => {
  const popup = mount({ onboardingComplete: true, theme: "dark" });
  await settled();
  assert.equal(popup.document.documentElement.dataset.theme, "dark");
  await popup.click("settings");
  assert.equal(popup.state.optionsOpened, 1);
  await popup.click("setup");
  assert.equal(popup.state.sent.at(-1).type, "openSetup");
  popup.state.changed({ theme: { newValue: "light" } }, "local");
  assert.equal(popup.document.documentElement.dataset.theme, "light");
});

test("copies only the requested local value and reports clipboard rejection", async () => {
  const popup = mount({ onboardingComplete: true, apiKey: "synthetic-client-key" });
  await settled();
  await popup.click("copy");
  await popup.click("copy-url");
  assert.deepEqual(popup.state.copied, ["synthetic-client-key", "http://127.0.0.1:8765/v1"]);
  assert.equal(popup.get("feedback").textContent, "Base URL copied.");
  popup.state.clipboardError = true;
  await popup.click("copy");
  assert.match(popup.get("feedback").textContent, /Copy failed/);
  assert.equal(popup.get("key").type, "password");
});

test("conceals a revealed key when hidden or replaced", async () => {
  const popup = mount({ onboardingComplete: true, apiKey: "synthetic-first" });
  await settled();
  popup.click("reveal");
  assert.equal(popup.get("key").type, "text");
  assert.equal(popup.get("reveal").attributes["aria-pressed"], "true");
  popup.document.hidden = true;
  popup.state.hidden();
  assert.equal(popup.get("key").type, "password");
  popup.click("reveal");
  popup.state.stored = { onboardingComplete: true, apiKey: "synthetic-second" };
  popup.state.changed({ apiKey: {} }, "local");
  await settled();
  assert.equal(popup.get("key").type, "password");
  assert.equal(popup.get("reveal").attributes["aria-label"], "Show API key");
});

test("handles missing keys and untrusted error strings without HTML injection", async () => {
  const message = '<img src=x onerror="alert(1)">';
  const popup = mount({ onboardingComplete: true, bridgeStatus: "offline", bridgeError: message });
  await settled();
  assert.equal(popup.get("copy").disabled, true);
  assert.equal(popup.get("reveal").disabled, true);
  assert.equal(popup.get("retry").disabled, false);
  assert.equal(popup.get("error").textContent, message);
  assert.equal(popup.get("error").hidden, false);
  assert.equal(popup.get("error").innerHTML, undefined);
  await popup.click("copy");
  assert.equal(popup.state.copied.length, 0);
});

test("reconnect invokes the existing background contract and handles failure", async () => {
  const popup = mount({ onboardingComplete: true, bridgeStatus: "offline" });
  await settled();
  await popup.click("retry");
  assert.equal(popup.state.sent.length, 1);
  assert.equal(popup.state.sent[0].type, "reconnect");
  popup.state.messageError = true;
  await popup.click("retry");
  assert.equal(popup.get("retry").disabled, false);
  assert.match(popup.get("error").textContent, /Could not reconnect/);
});

test("ignores unrelated storage changes and stale asynchronous reads", async () => {
  const popup = mount({ onboardingComplete: true, bridgeStatus: "offline" });
  await settled();
  popup.state.read = () => { throw new Error("Should not read unrelated changes"); };
  popup.state.changed({ unrelated: {} }, "local");
  popup.state.changed({ bridgeStatus: {} }, "sync");
  await settled();
  assert.equal(popup.get("status").textContent, "Offline");
  let resolveStale;
  popup.state.read = () => new Promise(resolve => { resolveStale = resolve; });
  popup.state.changed({ bridgeStatus: {} }, "local");
  popup.state.read = () => ({ onboardingComplete: true, bridgeStatus: "busy" });
  popup.state.changed({ bridgeStatus: {} }, "local");
  await settled();
  resolveStale({ bridgeStatus: "ready" });
  await settled();
  assert.equal(popup.get("status").textContent, "In progress");
});

test("storage failure returns to welcome, clears client values, and can recover", async () => {
  const popup = mount({ onboardingComplete: true, apiKey: "synthetic-client-key" });
  await settled();
  popup.state.read = () => { throw new Error("Storage failure"); };
  popup.state.changed({ bridgeStatus: {} }, "local");
  await settled();
  assert.equal(popup.get("welcome").hidden, false);
  assert.equal(popup.get("dashboard").hidden, true);
  assert.equal(popup.get("settings").hidden, true);
  assert.equal(popup.get("key").value, "");
  assert.equal(popup.get("copy").disabled, true);
  assert.equal(popup.get("endpoint").value, "");
  assert.equal(popup.get("skip-setup").disabled, true);
  assert.equal(popup.get("welcome-retry").hidden, false);
  assert.match(popup.get("welcome-error").textContent, /Could not read setup status/);
  popup.state.read = null;
  await popup.click("welcome-retry");
  assert.equal(popup.get("dashboard").hidden, false);
  assert.equal(popup.get("welcome").hidden, true);
  assert.equal(popup.get("key").type, "password");
  assert.equal(popup.get("key").value, "synthetic-client-key");
});

test("first opening shows welcome without dashboard flash or automatic navigation", async () => {
  let resolveRead;
  const popup = mount({}, { read: keys => keys.length === 1 ? {} : new Promise(resolve => { resolveRead = resolve; }) });
  assert.equal(popup.get("loading").hidden, false);
  assert.equal(popup.get("welcome").hidden, true);
  assert.equal(popup.get("dashboard").hidden, true);
  assert.equal(popup.get("settings").hidden, true);
  resolveRead({ bridgeStatus: "ready", apiKey: "synthetic-key-hidden" });
  await settled();
  assert.equal(popup.get("loading").hidden, true);
  assert.equal(popup.get("welcome").hidden, false);
  assert.equal(popup.get("dashboard").hidden, true);
  assert.equal(popup.get("start-setup").textContent, "Start setup");
  assert.equal(popup.get("key").value, "");
  assert.equal(popup.get("copy").disabled, true);
  assert.deepEqual(popup.state.sent, []);
  await popup.click("copy"); await popup.click("copy-url"); await popup.click("reveal");
  assert.deepEqual(popup.state.copied, []);
  assert.equal(popup.get("key").type, "password");
});

test("Start setup only opens the guide and leaves onboarding incomplete", async () => {
  const popup = mount(); await settled();
  await popup.click("start-setup");
  assert.deepEqual(popup.state.sent.map(message => message.type), ["openSetup"]);
  assert.equal(popup.state.stored.onboardingComplete, undefined);
  assert.equal(popup.get("welcome").hidden, false);
  assert.equal(popup.get("dashboard").hidden, true);
  popup.state.messageError = true;
  await popup.click("start-setup");
  assert.match(popup.get("welcome-error").textContent, /Could not open setup/);
  assert.equal(popup.get("start-setup").disabled, false);
});

test("interrupted progress offers Continue or Review without exposing the dashboard", async () => {
  for (const [phase, label] of [["created", "Continue setup"], ["configured", "Continue setup"], ["creating", "Review setup"], ["unrecognized", "Review setup"]]) {
    const popup = mount({ setupProgress: { phase }, apiKey: "synthetic-key-hidden" }); await settled();
    assert.equal(popup.get("start-setup").textContent, label);
    assert.equal(popup.get("welcome").hidden, false);
    assert.equal(popup.get("key").value, "");
    await popup.click("start-setup");
    assert.deepEqual(popup.state.sent.map(message => message.type), ["openSetup"]);
  }
});

test("only explicit onboarding or complete setup opens the dashboard", async () => {
  for (const stored of [{ onboardingComplete: true }, { setupProgress: { phase: "complete" } }]) {
    const popup = mount(stored); await settled();
    assert.equal(popup.get("dashboard").hidden, false);
    assert.equal(popup.get("welcome").hidden, true);
    assert.equal(popup.get("settings").hidden, false);
  }
  const popup = mount({ onboardingComplete: "true", bridgeStatus: "ready" }); await settled();
  assert.equal(popup.get("dashboard").hidden, true);
});

test("Use existing setup persists an explicit choice without school operations", async () => {
  const popup = mount({ apiKey: "synthetic-client-key" }); await settled();
  await popup.click("skip-setup");
  assert.deepEqual(popup.state.sent.map(message => message.type), ["skipSetup"]);
  assert.equal(popup.state.stored.onboardingComplete, true);
  assert.equal(popup.get("dashboard").hidden, false);
  assert.equal(popup.get("key").type, "password");
  assert.equal(popup.get("key").value, "synthetic-client-key");
});

test("skip failure and an unconfirmed preference preserve the welcome screen", async () => {
  const popup = mount(); await settled();
  popup.state.messageError = true;
  await popup.click("skip-setup");
  assert.equal(popup.get("dashboard").hidden, true);
  assert.match(popup.get("welcome-error").textContent, /Could not use the existing setup/);
  assert.equal(popup.get("skip-setup").disabled, false);
  popup.state.messageError = false;
  popup.state.handlers.skipSetup = () => ({ ok: true });
  await popup.click("skip-setup");
  assert.equal(popup.get("dashboard").hidden, true);
  assert.match(popup.get("welcome-error").textContent, /Could not confirm/);
});

test("pending welcome actions cannot open duplicate tabs or race skipping", async () => {
  const popup = mount(); await settled();
  let resolveOpen;
  popup.state.handlers.openSetup = () => new Promise(resolve => { resolveOpen = resolve; });
  const opening = popup.click("start-setup");
  await popup.click("start-setup"); await popup.click("skip-setup");
  assert.deepEqual(popup.state.sent.map(message => message.type), ["openSetup"]);
  assert.equal(popup.get("start-setup").disabled, true);
  assert.equal(popup.get("skip-setup").disabled, true);
  resolveOpen({ ok: true }); await opening;
  assert.equal(popup.get("start-setup").disabled, false);
});

test("completion updates switch views and returning to welcome conceals credentials", async () => {
  const popup = mount({ apiKey: "synthetic-client-key" }); await settled();
  popup.state.stored.setupProgress = { phase: "complete" };
  popup.state.changed({ setupProgress: {} }, "local"); await settled();
  assert.equal(popup.get("dashboard").hidden, false);
  await popup.click("reveal");
  popup.state.stored.setupProgress = { phase: "created" };
  popup.state.changed({ setupProgress: {} }, "local"); await settled();
  assert.equal(popup.get("dashboard").hidden, true);
  assert.equal(popup.get("key").type, "password");
  assert.equal(popup.get("key").value, "");
  assert.equal(popup.get("start-setup").textContent, "Continue setup");
});
