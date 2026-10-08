const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const origin = 'https://xipuai-xjtlu-edu-cn-s.xjtlu.edu.cn';
const event = () => ({ listeners: [], addListener(f) { this.listeners.push(f); }, emit(...args) { this.listeners.forEach(f => f(...args)); } });
function port(sender = {}) {
  return { name: 'xipu', sender, sent: [], onMessage: event(), onDisconnect: event(),
    postMessage(x) { this.sent.push(x); }, disconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
}
const natives = [], timers = new Map(), stored = {};
let timerID = 0;
const config = { session_name: 'XIPU AI Bridge', port: 8765 };
const chrome = {
  runtime: { id, getURL: file => `chrome-extension://${id}/${file}`,
    onConnect: event(), onMessage: event(), onStartup: event(), onInstalled: event(),
    connectNative(host) { assert.equal(host, 'edu.xjtlu.xipu_bridge'); const p = port(); natives.push(p); return p; } },
  storage: { local: { set(x) { Object.assign(stored, x); },
    setAccessLevel(x) { assert.equal(x.accessLevel, 'TRUSTED_CONTEXTS'); return Promise.resolve(); } } }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), {
  chrome, URL, TextDecoder, atob, btoa, setTimeout(f) { const id = ++timerID; timers.set(id, f); return id; }, clearTimeout(id) { timers.delete(id); }
});
const flush = () => new Promise(resolve => setImmediate(resolve));
const ui = (message, page = 'options.html') => new Promise(resolve => chrome.runtime.onMessage.emit(message, { id, url: chrome.runtime.getURL(page) }, resolve));
const ready = p => p.onMessage.emit({ type: 'ready', api_key: 'synthetic-local-key', base_url: 'http://127.0.0.1:8765/v1', config });
const chunkSize = 256 * 1024;
function chunks(job, bytes = Buffer.from(JSON.stringify({ type: 'req', job, op: 'chat', payload: { text: 'x'.repeat(chunkSize) + '\u{1f30d}' } }))) {
  const total = Math.ceil(bytes.length / chunkSize);
  return Array.from({ length: total }, (_, index) => ({ type: 'req_chunk', job, index, total, size: bytes.length, data: bytes.subarray(index * chunkSize, (index + 1) * chunkSize).toString('base64') }));
}
(async () => {
  await flush();
  assert.equal(natives.length, 1);
  let native = natives[0];
  ready(native);
  assert.equal(stored.bridgeStatus, 'no-tab');
  for (const sender of [{ id, frameId: 0, url: 'https://evil.test' }, { id, frameId: 1, url: origin }, { id: 'wrong', frameId: 0, url: origin }]) {
    const p = port(sender); chrome.runtime.onConnect.emit(p); assert.equal(p.disconnected, true);
  }
  const a = port({ id, frameId: 0, url: origin + '/v3/chat' });
  const b = port({ id, frameId: 0, url: origin + '/v3/chat' });
  chrome.runtime.onConnect.emit(a); chrome.runtime.onConnect.emit(b);
  assert.equal(native.sent.at(-1).tabs, 2);
  assert.equal(stored.bridgeStatus, 'ready');
  native.onMessage.emit({ type: 'req', job: 'one', op: 'chat', payload: {} });
  let count = native.sent.length;
  a.onMessage.emit({ type: 'evt', evt: { job: 'one', kind: 'done' } });
  b.onMessage.emit({ type: 'evt', evt: { job: 'other', kind: 'done' } });
  assert.equal(native.sent.length, count);
  const busy = await ui({ type: 'saveSettings', config });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /current operation/);
  assert.equal((await ui({ type: 'reconnect' })).ok, false);
  b.onMessage.emit({ type: 'evt', evt: { job: 'one', kind: 'done' } });

  const reading = ui({ type: 'getSettings' });
  const readRequest = native.sent.at(-1);
  assert.equal(readRequest.type, 'config_get');
  native.onMessage.emit({ type: 'config', request_id: 'unknown', config: { session_name: 'wrong' } });
  assert.equal(stored.sessionName, config.session_name);
  native.onMessage.emit({ type: 'config', request_id: readRequest.request_id, config });
  assert.equal((await reading).config.session_name, config.session_name);

  const saving = ui({ type: 'saveSettings', config: { ...config, port: 9900 } });
  const saveRequest = native.sent.at(-1);
  assert.equal(saveRequest.type, 'config_set');
  native.onMessage.emit({ type: 'config', request_id: saveRequest.request_id, config: saveRequest.config, restart_required: true });
  assert.equal((await saving).restartRequired, true);
  assert.equal(stored.baseURL, 'http://127.0.0.1:8765/v1', 'saving a port must not advertise an unbound endpoint');

  const rotating = ui({ type: 'rotateKey' });
  native.onMessage.emit({ type: 'key', request_id: native.sent.at(-1).request_id, api_key: 'synthetic-new-key' });
  assert.equal((await rotating).apiKey, 'synthetic-new-key');
  const refused = ui({ type: 'saveSettings', config: { port: 0 } });
  native.onMessage.emit({ type: 'rpc_error', request_id: native.sent.at(-1).request_id, message: 'Invalid port' });
  assert.equal((await refused).error, 'Invalid port');
  assert.equal(stored.hostConfig.port, 9900);

  const inspecting = ui({ type: 'inspectSchool' });
  const request = b.sent.at(-1);
  assert.equal(request.op, 'inspect');
  assert.equal(stored.bridgeStatus, 'busy');
  native.onMessage.emit({ type: 'req', job: 'conflict', op: 'chat', payload: {} });
  assert.match(native.sent.at(-1).evt.message, /busy/);
  const inspection = { models: [{ id: 'model-a', name: 'Model A' }], sessions: [] };
  count = native.sent.length;
  b.onMessage.emit({ type: 'evt', evt: { job: request.job, kind: 'result', result: inspection } });
  b.onMessage.emit({ type: 'evt', evt: { job: request.job, kind: 'done' } });
  assert.equal((await inspecting).models[0].id, 'model-a');
  assert.equal(native.sent.length, count, 'UI inspection must not reach the native API job queue');
  let replied = false;
  chrome.runtime.onMessage.emit({ type: 'rotateKey' }, { id, url: origin }, () => { replied = true; });
  assert.equal(replied, false);
  assert.equal(native.sent.length, count, 'content scripts must not access settings RPC');

  const successfulChunks = chunks('large');
  count = b.sent.length;
  native.onMessage.emit(successfulChunks[0]);
  assert.equal(stored.bridgeStatus, 'busy', 'assembly must reserve the operation before dispatch');
  assert.equal(b.sent.length, count);
  assert.equal((await ui({ type: 'saveSettings', config })).ok, false);
  assert.equal((await ui({ type: 'inspectSchool' })).ok, false);
  assert.equal((await ui({ type: 'reconnect' })).ok, false);
  b.onMessage.emit({ type: 'evt', evt: { job: 'large', kind: 'done' } });
  assert.equal(stored.bridgeStatus, 'busy', 'a page cannot finish an unassembled request');
  native.onMessage.emit({ type: 'req', job: 'other-during-assembly', op: 'chat', payload: {} });
  assert.match(native.sent.at(-1).evt.message, /busy/);
  native.onMessage.emit(successfulChunks[1]);
  assert.equal(b.sent.length, count + 1, 'dispatch exactly once after complete assembly');
  assert.equal(b.sent.at(-1).payload.text, 'x'.repeat(chunkSize) + '\u{1f30d}');
  b.onMessage.emit({ type: 'evt', evt: { job: 'large', kind: 'done' } });
  assert.equal(stored.bridgeStatus, 'ready');
  assert.equal(timers.size, 0);

  const invalidChunkGroups = [
    [{ ...chunks('oversize')[0], size: 24 * 1024 * 1024 + 1 }],
    [{ ...chunks('bad-total')[0], total: 1000000 }],
    [{ ...chunks('bad-base64')[0], data: 'not base64' }],
    [{ ...chunks('oversize-chunk')[0], data: 'A'.repeat(Math.ceil(chunkSize / 3) * 4 + 4) }],
    [chunks('out-of-order')[1]],
    [chunks('duplicate')[0], chunks('duplicate')[0]],
    [chunks('changed-size')[0], { ...chunks('changed-size')[1], size: chunks('changed-size')[1].size + 1 }],
    chunks('bad-json', Buffer.from('{not JSON}')),
    chunks('bad-utf8', Buffer.from([0xff])),
    chunks('wrong-job', Buffer.from(JSON.stringify({ type: 'req', job: 'different' }))),
    chunks('wrong-type', Buffer.from(JSON.stringify({ type: 'ready', job: 'wrong-type' })))
  ];
  count = b.sent.length;
  for (const group of invalidChunkGroups) {
    for (const message of group) native.onMessage.emit(message);
    assert.match(native.sent.at(-1).evt.message, /Invalid or incomplete/);
    assert.equal(stored.bridgeStatus, 'ready');
    assert.equal(b.sent.length, count, 'malformed chunks never reach a page');
    assert.equal(timers.size, 0, 'malformed assembly must release its timer');
  }
  const interrupted = chunks('cancel-chunks');
  native.onMessage.emit(interrupted[0]);
  native.onMessage.emit({ type: 'cancel', job: 'cancel-chunks' });
  assert.equal(stored.bridgeStatus, 'ready');
  assert.equal(timers.size, 0);
  native.onMessage.emit(interrupted[1]);
  assert.match(native.sent.at(-1).evt.message, /Invalid or incomplete/);
  assert.equal(b.sent.length, count, 'cancelled assembly is never dispatched');
  native.onMessage.emit(chunks('missing-chunk')[0]);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.equal(stored.bridgeStatus, 'ready');
  assert.match(native.sent.at(-1).evt.message, /assembly timed out/);
  assert.equal(b.sent.length, count);
  assert.equal(timers.size, 0);
  native.onMessage.emit(chunks('missing-chunk')[1]);
  assert.match(native.sent.at(-1).evt.message, /Invalid or incomplete/);
  assert.equal(b.sent.length, count, 'late chunks cannot revive an expired assembly');

  const temporaryPage = port({ id, frameId: 0, url: origin + '/v3/chat' });
  chrome.runtime.onConnect.emit(temporaryPage);
  native.onMessage.emit(chunks('closed-page')[0]);
  temporaryPage.disconnect();
  assert.equal(stored.bridgeStatus, 'ready');
  assert.equal(timers.size, 0);
  assert.equal(temporaryPage.sent.length, 0, 'disconnect while assembling sends no partial request');

  native.onMessage.emit({ type: 'req', job: 'two', op: 'chat', payload: {} });
  b.disconnect();
  assert.match(native.sent.at(-2).evt.message, /request was not retried/);
  native.onMessage.emit({ type: 'req', job: 'three', op: 'chat', payload: {} });
  native.onMessage.emit({ type: 'cancel', job: 'three' });
  assert.equal(a.sent.at(-1).type, 'cancel');
  native.onMessage.emit(chunks('host-disconnect')[0]);
  const disconnecting = ui({ type: 'getSettings' });
  native.disconnect();
  assert.equal((await disconnecting).ok, false);
  assert.equal(stored.bridgeStatus, 'offline');
  count = a.sent.length;
  const reconnect = [...timers.values()].at(-1); timers.clear(); reconnect();
  await flush();
  native = natives[1]; ready(native);
  assert.equal(a.sent.length, count, 'local reconnect must not replay school work');
  assert.equal((await ui({ type: 'reconnect' }, 'popup.html')).ok, true);
  assert.equal(natives.length, 3);
  ready(natives[2]);
  assert.equal(stored.restartRequired, false);
  console.log('background checks passed: trusted routing, bounded chunk assembly, settings RPC, inspection, busy guards and reconnect without replay');
})().catch(error => { console.error(error); process.exitCode = 1; });
