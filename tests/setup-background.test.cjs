const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); } });
const flush = () => new Promise(resolve => setImmediate(resolve));

async function harness(options = {}) {
  const stored = structuredClone(options.stored || {}), calls = [], opened = [], nativeEvents = [], cancelled = [], held = [];
  const timers = new Map();
  let timerID = 0;
  let config = { session_name: 'Existing bridge', default_model: 'previous-model', port: 9900, thinking: 'high' };
  let failSave = !!options.failSave, failConfigure = !!options.failConfigure;
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const native = { onMessage: event(), onDisconnect: event(), postMessage(message) {
    nativeEvents.push(message);
    if (message.type !== 'config_set') return;
    calls.push({ op: 'config_set', payload: message.config });
    queueMicrotask(() => {
      if (failSave) { failSave = false; native.onMessage.emit({ type: 'rpc_error', request_id: message.request_id, message: 'Synthetic save failure' }); }
      else { config = { ...config, ...message.config }; native.onMessage.emit({ type: 'config', request_id: message.request_id, config }); }
    });
  }};
  const page = { name: 'xipu', sender: { id, frameId: 0, url: 'https://xipuai.xjtlu.edu.cn/v3/chat' }, onMessage: event(), onDisconnect: event(), postMessage(message) {
    if (message.type === 'cancel') { cancelled.push(message.job); return; }
    calls.push({ op: message.op, payload: message.payload });
    if (message.op === 'setup_create') assert.equal(stored.setupProgress.phase, 'creating');
    if (message.op === 'setup_configure') assert.equal(stored.setupProgress.phase, 'created');
    queueMicrotask(() => {
      const emit = evt => page.onMessage.emit({ type: 'evt', evt: { job: message.job, ...evt } });
      if (options.pageOperation?.(message, emit, held)) return;
      if (options.unknownCreate && message.op === 'setup_create') return emit({ kind: 'error', message: 'Synthetic connection lost' });
      if (failConfigure && message.op === 'setup_configure') { failConfigure = false; return emit({ kind: 'error', message: 'Synthetic update failure' }); }
      const result = message.op === 'inspect' ? { models: [{ id: 'model-a' }], sessions: options.existing ? [{ id: 1, name: 'New bridge' }] : [] }
        : message.op === 'setup_create' ? { session: { id: 9, name: 'New bridge' } }
          : { session: { id: 9, name: 'New bridge', model: 'model-a', contextCount: 0, ...options.configuredSession } };
      emit({ kind: 'result', result });
      if (options.disconnectAfterCreate && message.op === 'setup_create') { page.onDisconnect.emit(); return; }
      emit({ kind: 'done' });
    });
  }};
  const chrome = { runtime: { id, getURL: file => `chrome-extension://${id}/${file}`, onConnect: event(), onMessage: event(), onStartup: event(), onInstalled: event(), connectNative: () => native },
    tabs: { create: async value => { opened.push(value); } },
    storage: { local: { setAccessLevel: async () => {}, get: async () => ({ ...stored }), set: async values => {
      if (options.failStoragePhase && values.setupProgress?.phase === options.failStoragePhase) throw new Error('Synthetic storage failure');
      if (options.beforeStorage) await options.beforeStorage(values);
      Object.assign(stored, structuredClone(values));
      if (values.setupProgress && options.interrupt) options.interrupt(native, page, values.setupProgress);
    } } }
  };
  vm.runInNewContext(source, { chrome, URL, TextDecoder, atob, btoa,
    setTimeout: options.fakeTimers ? (fn, delay) => { const id = ++timerID; timers.set(id, { fn, delay }); return id; } : setTimeout,
    clearTimeout: options.fakeTimers ? id => timers.delete(id) : clearTimeout });
  await flush();
  native.onMessage.emit({ type: 'ready', config, api_key: 'synthetic-local-key', base_url: 'http://127.0.0.1:9900/v1' });
  chrome.runtime.onConnect.emit(page);
  const ui = (message, file = 'setup.html') => new Promise(resolve => chrome.runtime.onMessage.emit(message, { id, url: chrome.runtime.getURL(file) }, result => resolve(JSON.parse(JSON.stringify(result)))));
  return { ui, calls, stored, config: () => config, nativeEvents, opened, chrome, cancelled, held, timers, page, native };
}
const setup = { type: 'setupSchool', name: 'New bridge', model: 'model-a' };

test('setup persists identity before configuration and saves only verified host fields', async () => {
  const h = await harness({ interrupt(native) { native.onMessage.emit({ type: 'req', job: 'overlap', op: 'chat', payload: {} }); } });
  const result = await h.ui(setup);
  assert.equal(result.ok, true); assert.equal(result.bridgeStatus, 'ready');
  assert.deepEqual(result.setupSession, { id: 9, name: 'New bridge', model: 'model-a', contextCount: 0 });
  assert.deepEqual(h.calls.map(call => call.op), ['inspect', 'setup_create', 'setup_configure', 'config_set']);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1).payload)), { session_name: 'New bridge', default_model: 'model-a' });
  assert.equal(h.config().port, 9900); assert.equal(h.config().thinking, 'high');
  assert.ok(h.nativeEvents.filter(evt => evt.type === 'evt').every(evt => /busy/.test(evt.evt.message)));
  assert.equal(h.stored.setupProgress.phase, 'complete');
  await h.ui(setup);
  assert.equal(h.calls.length, 4, 'completed setup must not create again');
});

test('local save failure resumes only local persistence without school mutations', async () => {
  const h = await harness({ failSave: true });
  assert.equal((await h.ui(setup)).ok, false);
  assert.equal(h.stored.setupProgress.phase, 'configured');
  assert.equal(h.config().session_name, 'Existing bridge');
  const before = h.calls.length;
  assert.equal((await h.ui(setup)).ok, true);
  assert.deepEqual(h.calls.slice(before).map(call => call.op), ['config_set']);
});

test('known creation resumes configuration without creating another session', async () => {
  const h = await harness({ failConfigure: true });
  assert.equal((await h.ui(setup)).ok, false);
  const state = await h.ui({ type: 'getSetupState' });
  assert.equal(state.setupProgress.session_id, 9); assert.equal(state.setupProgress.phase, 'created');
  assert.equal(state.setupSession, null);
  assert.equal((await h.ui(setup)).ok, true);
  assert.equal(h.calls.filter(call => call.op === 'setup_create').length, 1);
});

test('resume accepts equivalent valid IDs and persists the verified representation', async () => {
  for (const [session_id, id] of [[9, '9'], ['9', 9], ['opaque-id', 'opaque-id']]) {
    const h = await harness({ stored: { setupProgress: { name: setup.name, model: setup.model, session_id, phase: 'created' } }, configuredSession: { id } });
    const result = await h.ui(setup);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.setupSession.id, id);
    assert.equal(h.stored.setupProgress.session_id, id);
    assert.deepEqual(h.calls.map(call => call.op), ['setup_configure', 'config_set']);
  }
});

test('resume rejects different or malformed IDs and unverified configuration before local save', async () => {
  const identities = [[9, '09'], [9, '9e0'], [9, '9.0'], [9, 10], ['opaque-id', 'other-id'],
    ['undefined', undefined], ['null', null], ['true', true], ['NaN', NaN],
    [9, {}], [9, ' 9'], [9, 0], [9, Number.MAX_SAFE_INTEGER + 1]];
  for (const [session_id, id] of identities) {
    const h = await harness({ stored: { setupProgress: { name: setup.name, model: setup.model, session_id, phase: 'created' } }, configuredSession: { id } });
    const result = await h.ui(setup);
    assert.equal(result.ok, false);
    assert.match(result.error, /did not confirm/);
    assert.equal(h.stored.setupProgress.phase, 'created');
    assert.deepEqual(h.calls.map(call => call.op), ['setup_configure']);
  }
  for (const configuredSession of [{ name: 'Changed name' }, { model: 'other-model' }, { contextCount: 5 }, { contextCount: '0' }]) {
    const h = await harness({ configuredSession });
    assert.equal((await h.ui(setup)).ok, false);
    assert.equal(h.stored.setupProgress.phase, 'created');
    assert.ok(!h.calls.some(call => call.op === 'config_set'));
  }
});

test('uncertain creation never resubmits and persisted progress survives restart', async () => {
  const h = await harness({ unknownCreate: true });
  assert.equal((await h.ui(setup)).ok, false);
  const count = h.calls.length;
  assert.match((await h.ui(setup)).error, /unknown/); assert.equal(h.calls.length, count);
  const restarted = await harness({ stored: h.stored });
  assert.match((await restarted.ui(setup)).error, /unknown/);
  assert.equal(restarted.calls.length, 0);
});

test('a confirmed creation ID survives disconnect before the final done event', async () => {
  const h = await harness({ disconnectAfterCreate: true });
  assert.equal((await h.ui(setup)).ok, false);
  assert.equal(h.stored.setupProgress.phase, 'created');
  assert.equal(h.stored.setupProgress.session_id, 9);
  const restarted = await harness({ stored: h.stored });
  assert.equal((await restarted.ui(setup)).ok, true);
  assert.deepEqual(restarted.calls.map(call => call.op), ['setup_configure', 'config_set']);
});

test('pre-existing names and invalid models fail before persisting a create attempt', async () => {
  const h = await harness({ existing: true });
  assert.match((await h.ui(setup)).error, /already exists/);
  assert.equal(h.stored.setupProgress, undefined);
  assert.match((await h.ui({ ...setup, model: 'unknown' })).error, /available/);
  assert.ok(h.calls.every(call => call.op === 'inspect'));
});

test('storage failure stops before the next mutation and excludes untrusted senders', async () => {
  for (const phase of ['creating', 'created', 'configured']) {
    const h = await harness({ failStoragePhase: phase });
    assert.equal((await h.ui(setup)).ok, false);
    assert.equal(h.calls.filter(call => call.op === 'config_set').length, 0);
    if (phase === 'creating') assert.equal(h.calls.length, 1);
    if (phase === 'created') assert.ok(!h.calls.some(call => call.op === 'setup_configure'));
  }
  const h = await harness();
  let replied = false;
  h.chrome.runtime.onMessage.emit(setup, { id: h.chrome.runtime.id, url: 'https://xipuai.xjtlu.edu.cn/v3/chat' }, () => { replied = true; });
  await flush(); assert.equal(replied, false); assert.equal(h.calls.length, 0);
});

test('setup opens only from an explicit action, never on install or update', async () => {
  const h = await harness();
  h.chrome.runtime.onInstalled.emit({ reason: 'update' }); await flush(); assert.equal(h.opened.length, 0);
  h.chrome.runtime.onInstalled.emit({ reason: 'install' }); await flush(); assert.equal(h.opened.length, 0);
  await h.ui({ type: 'openSetup' }, 'popup.html'); assert.equal(h.opened.length, 1);
  assert.ok(h.opened.every(value => value.url.endsWith('/setup.html')));
});

test('using an existing setup dismisses onboarding without changing school or native configuration', async () => {
  const h = await harness();
  const before = { ...h.config() };
  assert.equal((await h.ui({ type: 'skipSetup' }, 'popup.html')).ok, true);
  assert.equal(h.stored.onboardingComplete, true);
  assert.equal(h.stored.setupProgress, undefined);
  assert.deepEqual(h.config(), before);
  assert.equal(h.calls.length, 0);
  assert.equal(h.opened.length, 0);
});

test('a failed creation preflight permits an explicit retry without an uncertain mutation', async () => {
  let fail = true;
  const h = await harness({ pageOperation(message, emit) {
    if (message.op !== 'setup_create' || !fail) return false;
    fail = false;
    emit({ kind: 'done', message: 'School HTTP 502', result: { notCreated: true } });
    return true;
  } });
  assert.match((await h.ui(setup)).error, /502/);
  assert.equal(h.stored.setupProgress, null);
  assert.equal((await h.ui({ type: 'getSetupState' })).setupRunning, false);
  assert.equal((await h.ui(setup)).ok, true);
});

test('an uncertain create is reconciled by a read before resuming the known conversation', async () => {
  for (const alreadyConfigured of [false, true]) {
    const h = await harness({ unknownCreate: true, pageOperation(message, emit) {
      if (message.op !== 'setup_check') return false;
      emit({ kind: 'result', result: { session: { id: 9, name: setup.name, model: setup.model, contextCount: alreadyConfigured ? 0 : 5, promptEmpty: true } } });
      emit({ kind: 'done' }); return true;
    } });
    await h.ui(setup);
    const before = h.calls.length;
    assert.equal((await h.ui({ type: 'getSetupState' })).setupProgress.phase, 'creating');
    assert.equal(h.calls.length, before, 'status reads must never call the school');
    const checked = await h.ui({ type: 'checkSetup' });
    assert.equal(checked.ok, true, checked.error);
    assert.equal(checked.setupProgress.session_id, 9);
    assert.equal(checked.setupProgress.phase, alreadyConfigured ? 'configured' : 'created');
    assert.equal((await h.ui(setup)).ok, true);
    assert.deepEqual(h.calls.slice(before).map(call => call.op), alreadyConfigured ? ['setup_check', 'config_set'] : ['setup_check', 'setup_configure', 'config_set']);
    assert.equal(h.calls.filter(call => call.op === 'setup_create').length, 1);
  }
});

test('failed or missing school checks keep ambiguous creation recoverable and never retry creation', async () => {
  let attempt = 0;
  const h = await harness({ stored: { setupProgress: { name: setup.name, model: setup.model, phase: 'creating' } }, pageOperation(message, emit) {
    if (message.op !== 'setup_check') return false;
    if (++attempt === 1) emit({ kind: 'done', message: 'School HTTP 502' });
    else { emit({ kind: 'result', result: { session: null } }); emit({ kind: 'done' }); }
    return true;
  } });
  assert.match((await h.ui({ type: 'checkSetup' })).error, /502/);
  assert.equal((await h.ui({ type: 'getSetupState' })).setupRunning, false);
  assert.match((await h.ui({ type: 'checkSetup' })).error, /not visible/);
  assert.match((await h.ui(setup)).error, /unknown/);
  assert.equal(h.stored.setupProgress.phase, 'creating');
  assert.deepEqual(h.calls.map(call => call.op), ['setup_check', 'setup_check']);
});

test('recovery checks reject a changed identity and only trust verified context and prompt', async () => {
  for (const session of [{ id: 10, name: setup.name }, { id: 9, name: 'Changed' }, { id: false, name: setup.name }]) {
    const h = await harness({ stored: { setupProgress: { name: setup.name, model: setup.model, session_id: 9, phase: 'created' } }, pageOperation(message, emit) {
      emit({ kind: 'result', result: { session } }); emit({ kind: 'done' }); return true;
    } });
    assert.equal((await h.ui({ type: 'checkSetup' })).ok, false);
    assert.equal(h.stored.setupProgress.phase, 'created');
  }
  for (const override of [{ promptEmpty: false }, { promptEmpty: undefined }, { contextCount: '0' }, { model: 'other' }]) {
    const h = await harness({ stored: { setupProgress: { name: setup.name, model: setup.model, phase: 'creating' } }, pageOperation(message, emit) {
      emit({ kind: 'result', result: { session: { id: 9, name: setup.name, model: setup.model, contextCount: 0, promptEmpty: true, ...override } } }); emit({ kind: 'done' }); return true;
    } });
    assert.equal((await h.ui({ type: 'checkSetup' })).ok, true);
    assert.equal(h.stored.setupProgress.phase, 'created');
  }
});

test('successful manual settings exit onboarding after uncertain or invalid saved progress', async () => {
  for (const setupProgress of [{ name: setup.name, model: setup.model, phase: 'creating' }, { phase: 'broken' }]) {
    const h = await harness({ failSave: true, stored: { setupProgress } });
    const save = { type: 'saveSettings', config: { session_name: 'Manually selected', default_model: 'model-a' } };
    assert.equal((await h.ui(save, 'options.html')).ok, false);
    assert.notEqual((await h.ui({ type: 'getSetupState' })).onboardingComplete, true);
    assert.equal((await h.ui(save, 'options.html')).ok, true);
    const state = await h.ui({ type: 'getSetupState' });
    assert.equal(state.ok, true); assert.equal(state.onboardingComplete, true);
    assert.equal(state.config.session_name, save.config.session_name);
    assert.equal(state.setupSession, null, 'manual settings must not claim school verification');
    assert.deepEqual(h.stored.setupProgress, setupProgress, 'keep ambiguous identity for later recovery');
    assert.ok(h.calls.every(call => call.op === 'config_set'));
    const restarted = await harness({ stored: h.stored });
    assert.equal((await restarted.ui({ type: 'getSetupState' })).onboardingComplete, true);
  }
});

test('stop waiting frees setup, preserves uncertainty, and ignores late creation replies', async () => {
  const h = await harness({ pageOperation(message, emit, held) {
    if (message.op !== 'setup_create') return false;
    held.push(emit); return true;
  } });
  const running = h.ui(setup); await flush();
  const state = await h.ui({ type: 'getSetupState' });
  assert.equal(state.setupRunning, true);
  await h.ui({ type: 'cancelSetup' });
  assert.equal((await running).ok, false);
  assert.equal((await h.ui({ type: 'getSetupState' })).setupRunning, false);
  assert.equal(h.cancelled.length, 1);
  h.held[0]({ kind: 'result', result: { session: { id: 9, name: setup.name } } });
  h.held[0]({ kind: 'done' }); await flush();
  assert.equal(h.stored.setupProgress.phase, 'creating');
  assert.ok(!h.calls.some(call => call.op === 'setup_configure'));
  assert.equal((await h.ui({ type: 'saveSettings', config: { session_name: 'Manual' } }, 'options.html')).ok, true);
});

test('a timed-out read frees recovery and an old timer cannot cancel a newer school operation', async () => {
  const h = await harness({ fakeTimers: true, pageOperation(message, emit, held) { held.push(emit); return true; } });
  const first = h.ui({ type: 'inspectSchool' }); await flush();
  const expired = [...h.timers.values()].find(timer => timer.delay === 30000);
  expired.fn();
  assert.match((await first).error, /timed out/);
  assert.equal((await h.ui({ type: 'getSetupState' })).setupRunning, false);
  const next = h.ui({ type: 'inspectSchool' }); await flush();
  expired.fn();
  assert.equal(h.cancelled.length, 1);
  h.held[1]({ kind: 'result', result: { models: [], sessions: [] } }); h.held[1]({ kind: 'done' });
  assert.equal((await next).ok, true);
});

test('cancelling between stages prevents the next mutation and keeps confirmed progress', async () => {
  for (const phase of ['creating', 'created', 'configured']) {
    let h;
    h = await harness({ interrupt(native, page, progress) {
      if (progress.phase === phase) void h.ui({ type: 'cancelSetup' });
    } });
    assert.equal((await h.ui(setup)).ok, false);
    if (phase === 'creating') {
      assert.equal(h.stored.setupProgress, null, 'creation was never attempted');
      assert.deepEqual(h.calls.map(call => call.op), ['inspect']);
    } else {
      assert.equal(h.stored.setupProgress.phase, phase);
      assert.equal(h.stored.setupProgress.session_id, 9);
      assert.ok(!h.calls.some(call => call.op === 'config_set'));
      if (phase === 'created') assert.ok(!h.calls.some(call => call.op === 'setup_configure'));
    }
  }
});

test('recovery owns the workflow until confirmed progress is persisted', async () => {
  let release;
  const h = await harness({ stored: { setupProgress: { name: setup.name, model: setup.model, phase: 'creating' } },
    beforeStorage(values) { if (values.setupProgress?.phase === 'created') return new Promise(resolve => { release = resolve; }); },
    pageOperation(message, emit) {
      emit({ kind: 'result', result: { session: { id: 9, name: setup.name, model: setup.model, contextCount: 5, promptEmpty: true } } });
      emit({ kind: 'done' }); return true;
    }
  });
  const checking = h.ui({ type: 'checkSetup' }); await flush();
  assert.equal(typeof release, 'function');
  assert.equal((await h.ui({ type: 'getSetupState' })).setupRunning, true);
  for (const action of [setup, { type: 'checkSetup' }, { type: 'saveSettings', config: { session_name: 'Manual' } }]) {
    assert.equal((await h.ui(action)).ok, false);
  }
  assert.deepEqual(h.calls.map(call => call.op), ['setup_check']);
  release();
  assert.equal((await checking).ok, true);
  assert.equal((await h.ui({ type: 'getSetupState' })).setupRunning, false);
  assert.equal(h.stored.setupProgress.phase, 'created');
});

test('stop waiting never cancels an API generation', async () => {
  const h = await harness({ pageOperation() { return true; } });
  h.native.onMessage.emit({ type: 'req', job: 'api-generation', op: 'chat', payload: {} });
  await h.ui({ type: 'cancelSetup' });
  assert.equal(h.cancelled.length, 0);
  const state = await h.ui({ type: 'getSetupState' });
  assert.equal(state.setupRunning, false); assert.equal(state.bridgeStatus, 'busy');
});
