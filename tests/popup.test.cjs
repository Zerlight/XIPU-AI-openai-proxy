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

function mount(initial = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    value: "", textContent: "", dataset: {}, attributes: {}, listeners: {},
    disabled: false, hidden: false, type: id === "key" ? "password" : "text",
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }]));
  const listeners = [];
  const state = { stored: initial, copied: [], sent: [], changed: (...args) => listeners.forEach(listener => listener(...args)), hidden: null, read: null, clipboardError: false, messageError: false, optionsOpened: 0 };
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
        local: { get: async keys => { state.requestedKeys = keys; return state.read ? state.read() : state.stored; }, set: async values => { Object.assign(state.stored, values); } },
        onChanged: { addListener: callback => { listeners.push(callback); } }
      },
      runtime: {
        id: "abcdefghijklmnopabcdefghijklmnop",
        openOptionsPage: async () => { state.optionsOpened += 1; },
        sendMessage: async message => {
          state.sent.push(message);
          if (state.messageError) throw new Error("Test message failure");
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
  const popup = mount({ bridgeStatus: "ready", sessionName: "Bridge Test", apiKey: "synthetic-client-key", baseURL: "http://127.0.0.1:9900/v1", transport: "native-messaging" });
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
  const popup = mount({ theme: "dark" });
  await settled();
  assert.equal(popup.document.documentElement.dataset.theme, "dark");
  await popup.click("settings");
  assert.equal(popup.state.optionsOpened, 1);
  popup.state.changed({ theme: { newValue: "light" } }, "local");
  assert.equal(popup.document.documentElement.dataset.theme, "light");
});

test("copies only the requested local value and reports clipboard rejection", async () => {
  const popup = mount({ apiKey: "synthetic-client-key" });
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
  const popup = mount({ apiKey: "synthetic-first" });
  await settled();
  popup.click("reveal");
  assert.equal(popup.get("key").type, "text");
  assert.equal(popup.get("reveal").attributes["aria-pressed"], "true");
  popup.document.hidden = true;
  popup.state.hidden();
  assert.equal(popup.get("key").type, "password");
  popup.click("reveal");
  popup.state.stored = { apiKey: "synthetic-second" };
  popup.state.changed({ apiKey: {} }, "local");
  await settled();
  assert.equal(popup.get("key").type, "password");
  assert.equal(popup.get("reveal").attributes["aria-label"], "Show API key");
});

test("handles missing keys and untrusted error strings without HTML injection", async () => {
  const message = '<img src=x onerror="alert(1)">';
  const popup = mount({ bridgeStatus: "offline", bridgeError: message });
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
  const popup = mount({ bridgeStatus: "offline" });
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
  const popup = mount({ bridgeStatus: "offline" });
  await settled();
  popup.state.read = () => { throw new Error("Should not read unrelated changes"); };
  popup.state.changed({ unrelated: {} }, "local");
  popup.state.changed({ bridgeStatus: {} }, "sync");
  await settled();
  assert.equal(popup.get("status").textContent, "Offline");
  let resolveStale;
  popup.state.read = () => new Promise(resolve => { resolveStale = resolve; });
  popup.state.changed({ bridgeStatus: {} }, "local");
  popup.state.read = () => ({ bridgeStatus: "busy" });
  popup.state.changed({ bridgeStatus: {} }, "local");
  await settled();
  resolveStale({ bridgeStatus: "ready" });
  await settled();
  assert.equal(popup.get("status").textContent, "In progress");
});

test("storage failure clears key and exposes a recoverable error", async () => {
  const popup = mount({ apiKey: "synthetic-client-key" });
  await settled();
  popup.state.read = () => { throw new Error("Storage failure"); };
  popup.state.changed({ bridgeStatus: {} }, "local");
  await settled();
  assert.equal(popup.get("status").textContent, "Unavailable");
  assert.equal(popup.get("key").value, "");
  assert.equal(popup.get("copy").disabled, true);
  assert.equal(popup.get("retry").disabled, false);
});
