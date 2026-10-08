const HOST = "edu.xjtlu.xipu_bridge";
const ORIGINS = new Set([
  "https://xipuai.xjtlu.edu.cn",
  "https://xipuai-xjtlu-edu-cn-s.xjtlu.edu.cn"
]);
const ports = new Set();
const pending = new Map();
const CHUNK_BYTES = 256 * 1024, MAX_REQUEST_BYTES = 24 * 1024 * 1024;
let nativePort = null, nativeReady = false, current = null;
let reconnectTimer = null, reconnectAttempts = 0, sequence = 0;
let snapshot = { config: null, baseURL: "", apiKey: "", restartRequired: false, bridgeStatus: "offline", bridgeError: "" };
// Credentials are available only to extension pages, before any host can supply a key.
const privateStorage = Promise.resolve(chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }));

function trustedPage(port) {
  try {
    return port.name === "xipu" && port.sender?.id === chrome.runtime.id
      && port.sender.frameId === 0 && ORIGINS.has(new URL(port.sender.url).origin);
  } catch { return false; }
}

function renderStatus(error = "") {
  snapshot.bridgeStatus = current ? "busy" : nativeReady ? (ports.size ? "ready" : "no-tab") : "offline";
  snapshot.bridgeError = error;
  chrome.storage.local.set({ bridgeStatus: snapshot.bridgeStatus, bridgeError: error });
}

function sendNative(message) {
  if (!nativePort || !nativeReady) return false;
  try { nativePort.postMessage(message); return true; } catch { return false; }
}

function notifyTabs() { sendNative({ type: "status", tabs: ports.size }); }

function rejectPending(message) {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
  pending.clear();
}

function finishInspection(error = "") {
  if (current?.target !== "ui") return;
  const job = current;
  current = null;
  clearTimeout(job.timer);
  if (error || !job.result) job.reject(new Error(error || "The school did not return its models and sessions."));
  else job.resolve(job.result);
  renderStatus();
}

function cancelPage(reason = "The native connection closed; the request was not retried.") {
  if (!current) return;
  if (current.target === "assembly") {
    clearTimeout(current.timer);
    current = null;
    return;
  }
  try { current.port.postMessage({ type: "cancel", job: current.job }); } catch {}
  if (current.target === "ui") finishInspection(reason);
  else current = null;
}

function failRequest(job, message) {
  sendNative({ type: "evt", evt: { job, kind: "done", message } });
}

function dispatchRequest(message, page = [...ports].at(-1)) {
  if (current || !page) {
    failRequest(message.job, current ? "Bridge busy; request not sent." : "No connected XIPU AI tab.");
    return;
  }
  current = { job: message.job, port: page, target: "api" };
  try { page.postMessage(message); }
  catch {
    failRequest(message.job, "The XIPU AI tab disconnected; the request was not retried.");
    current = null;
  }
  renderStatus();
}

function receiveChunk(message) {
  const { job, index, total, size, data } = message;
  try {
    if (typeof job !== "string" || !job || job.length > 128
      || !Number.isInteger(size) || size < 1 || size > MAX_REQUEST_BYTES
      || !Number.isInteger(total) || total !== Math.ceil(size / CHUNK_BYTES)
      || !Number.isInteger(index) || index < 0 || index >= total
      || typeof data !== "string" || data.length > Math.ceil(CHUNK_BYTES / 3) * 4
      || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new Error("Invalid native request chunk.");
    }
    if (current && (current.target !== "assembly" || current.job !== job)) {
      failRequest(job, "Bridge busy; request not sent.");
      return;
    }
    const bytes = atob(data);
    const expected = index === total - 1 ? size - index * CHUNK_BYTES : CHUNK_BYTES;
    if (bytes.length !== expected || btoa(bytes) !== data) throw new Error("Invalid native request chunk size or encoding.");
    if (!current) {
      if (index !== 0) throw new Error("Native request chunks arrived out of order.");
      const page = [...ports].at(-1);
      if (!page) { failRequest(job, "No connected XIPU AI tab."); return; }
      const timer = setTimeout(() => {
        if (current?.target !== "assembly" || current.job !== job) return;
        cancelPage();
        failRequest(job, "Native request assembly timed out; the request was not sent.");
        renderStatus();
      }, 30000);
      current = { job, port: page, target: "assembly", total, size, next: 0, bytes: new Uint8Array(size), timer };
      renderStatus();
    }
    if (current.next !== index || current.total !== total || current.size !== size) {
      throw new Error("Native request chunks arrived out of order or changed size.");
    }
    for (let i = 0; i < bytes.length; i++) current.bytes[index * CHUNK_BYTES + i] = bytes.charCodeAt(i);
    current.next++;
    if (current.next !== total) return;
    const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(current.bytes));
    if (!request || request.type !== "req" || request.job !== job) throw new Error("Native request chunk identity did not match.");
    const page = current.port;
    cancelPage();
    dispatchRequest(request, page);
  } catch {
    if (current?.target === "assembly" && current.job === job) cancelPage();
    failRequest(job, "Invalid or incomplete native request chunks; the request was not sent.");
    renderStatus();
  }
}

function storeConfig(config, restartRequired = false) {
  snapshot.config = config;
  snapshot.restartRequired = restartRequired;
  chrome.storage.local.set({ hostConfig: config, sessionName: config.session_name, restartRequired });
}

async function connectNative() {
  try { await privateStorage; }
  catch { renderStatus("Could not protect extension storage. Reload the extension."); return; }
  if (nativePort) return;
  let port;
  try { port = chrome.runtime.connectNative(HOST); }
  catch { renderStatus("Could not launch the native host. Check the installation."); return; }
  nativePort = port;
  let hostError = "";
  port.onMessage.addListener(message => {
    if (nativePort !== port || !message) return;
    if (message.type === "ready") {
      if (!message.config || typeof message.api_key !== "string" || typeof message.base_url !== "string") {
        hostError = "Install the current Go native host to use this extension.";
        reconnectAttempts = 3;
        port.disconnect();
        return;
      }
      nativeReady = true;
      reconnectAttempts = 0;
      snapshot.apiKey = message.api_key;
      snapshot.baseURL = message.base_url;
      storeConfig(message.config);
      chrome.storage.local.set({ apiKey: message.api_key, baseURL: message.base_url, transport: "native-messaging" });
      notifyTabs();
      renderStatus();
    } else if (["config", "key", "rpc_error"].includes(message.type)) {
      const entry = pending.get(message.request_id);
      if (!entry) return;
      pending.delete(message.request_id);
      clearTimeout(entry.timer);
      if (message.type === "rpc_error") { entry.reject(new Error(message.message || "The native settings operation failed.")); return; }
      if (message.type === "config") storeConfig(message.config, !!message.restart_required);
      if (message.type === "key") {
        snapshot.apiKey = message.api_key;
        chrome.storage.local.set({ apiKey: message.api_key });
      }
      entry.resolve({ ...snapshot });
    } else if (message.type === "error") {
      hostError = message.message || "The native host could not start.";
      renderStatus(hostError);
    } else if (message.type === "cancel") {
      if (["api", "assembly"].includes(current?.target) && current.job === message.job) cancelPage();
      renderStatus();
    } else if (message.type === "req_chunk") {
      receiveChunk(message);
    } else if (message.type === "req") {
      dispatchRequest(message);
    }
  });
  port.onDisconnect.addListener(() => {
    const runtimeError = chrome.runtime.lastError?.message || "The native connection closed.";
    if (nativePort !== port) return;
    cancelPage();
    rejectPending("The native host disconnected. Reload settings to verify the saved state.");
    nativePort = null;
    nativeReady = false;
    renderStatus(hostError || runtimeError);
    // Local reconnection never replays school requests or settings mutations.
    if (reconnectAttempts < 3) {
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connectNative(); }, reconnectAttempts * 2000);
    }
  });
}

chrome.runtime.onConnect.addListener(port => {
  if (!trustedPage(port)) { port.disconnect(); return; }
  ports.add(port);
  port.onMessage.addListener(message => {
    if (message?.type !== "evt" || current?.port !== port || current.target === "assembly") return;
    const evt = message.evt;
    if (!evt || evt.job !== current.job) return;
    if (current.target === "ui") {
      if (evt.kind === "result") current.result = evt.result;
      if (evt.kind === "done" || evt.kind === "error") finishInspection(evt.message || (evt.kind === "error" ? "School inspection failed." : ""));
      return;
    }
    sendNative({ type: "evt", evt });
    if (evt.kind === "done" || evt.kind === "error") { current = null; renderStatus(); }
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (current?.port === port) {
      const error = "The active XIPU AI tab closed; the request was not retried.";
      if (current.target === "ui") finishInspection(error);
      else { failRequest(current.job, error); cancelPage(); }
    }
    notifyTabs(); renderStatus();
  });
  connectNative(); notifyTabs(); renderStatus();
});

function rpc(type, fields = {}) {
  if (!nativeReady) return Promise.reject(new Error("Connect the native host before changing or reading settings."));
  const request_id = `settings-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request_id);
      reject(new Error("The settings response timed out. Reload settings to verify the saved state."));
    }, 10000);
    pending.set(request_id, { resolve, reject, timer });
    if (!sendNative({ type, request_id, ...fields })) {
      pending.delete(request_id); clearTimeout(timer);
      reject(new Error("The native host disconnected before the settings request could be sent."));
    }
  });
}

function inspectSchool() {
  if (current || pending.size) return Promise.reject(new Error("Wait for the current operation to finish before inspecting the school tab."));
  const page = [...ports].at(-1);
  if (!nativeReady || !page) return Promise.reject(new Error("Connect the native host and open a signed-in XIPU AI tab first."));
  return new Promise((resolve, reject) => {
    const job = `inspect-${++sequence}`;
    const timer = setTimeout(() => cancelPage("School inspection timed out and was cancelled; it was not retried."), 30000);
    current = { job, port: page, target: "ui", resolve, reject, timer, result: null };
    try { page.postMessage({ type: "req", job, op: "inspect", payload: {} }); renderStatus(); }
    catch { finishInspection("The XIPU AI tab disconnected before inspection."); }
  });
}

async function handleUI(message) {
  if (message.type === "getSettings") return rpc("config_get");
  if (message.type === "inspectSchool") return inspectSchool();
  if (current || pending.size) throw new Error("Wait for the current operation to finish before changing settings or reconnecting.");
  if (message.type === "saveSettings") return rpc("config_set", { config: message.config });
  if (message.type === "rotateKey") return rpc("rotate_key");
  if (message.type === "reconnect") {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null; reconnectAttempts = 0;
    const old = nativePort;
    nativePort = null; nativeReady = false;
    old?.disconnect();
    renderStatus();
    await connectNative();
    return {};
  }
  throw new Error("Unsupported extension operation.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !["popup.html", "options.html"].some(page => sender.url === chrome.runtime.getURL(page))) return;
  if (!message || typeof message.type !== "string") return;
  handleUI(message).then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);
connectNative();
