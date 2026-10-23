const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/page.js'), 'utf8');
const model = 'synthetic-model';
const session = { id: 42, name: 'Test session', model, contextCount: 0 };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' }
});
const list = (items = [session]) => json({ code: 0, data: items });
const payload = { session_name: session.name, model, text: 'Reply OK', thinking: 'minimal' };
const sse = (wire) => {
  const bytes = new TextEncoder().encode(wire);
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  }}), { headers: { 'Content-Type': 'text/event-stream' } });
};
const flush = () => new Promise(resolve => setImmediate(resolve));
function mount(responses, cancel = false, web = null, modern = false) {
  const events = [], calls = [];
  const pending = new Map();
  let listener;
  const window = {
    postMessage(event) {
      events.push(event);
      if (event.kind === 'done') {
        const finish = pending.get(event.job);
        pending.delete(event.job);
        finish?.();
      }
    },
    addEventListener(type, callback) { assert.equal(type, 'message'); listener = callback; },
    async fetch(url, options) {
      calls.push({ url, ...options, body: options.body instanceof FormData ? options.body : options.body && JSON.parse(options.body) });
      assert.equal(options.headers['Jm-Token'], 'synthetic-school-token');
      if (!web || !url.endsWith('/api/chat/completions')) assert.equal(options.credentials, 'include');
      const next = responses.shift();
      assert.ok(next, 'unexpected school request');
      const cancelPath = { upload: '/api/common/upload', catalog: '/api/chat/config?lang=en',
        session: '/api/chat/session?lang=en', save: '/api/chat/saveSession' }[cancel];
      if (cancelPath && url.endsWith(cancelPath)) queueMicrotask(() => {
        listener({ source: window, data: { source: 'xipu-bridge', type: 'cancel', job: 'test-job' } });
      });
      return typeof next === 'function' ? next(options) : next;
    }
  };
  const root = { inert: false, contains: element => element === composer,
    __vue_app__: { config: { globalProperties: { $pinia: { state: { value: { user: { token: 'synthetic-school-token' } } } } } } } };
  if (modern) root.__vue_app__.config.globalProperties.$pinia.state.value = {
    [btoa('__XP_JM_USER__')]: { data: { token: 'synthetic-school-token' } }
  };
  const location = { origin: 'https://xipuai-xjtlu-edu-cn-s.xjtlu.edu.cn', pathname: modern ? '/chat' : '/v3/chat' };
  const composer = { value: web?.draft || '', getClientRects: () => [{}] };
  const webState = { sendCalls: [], visibleResponses: [], stopCalls: 0, root, originalFetch: window.fetch, timer: null, pageController: new AbortController() };
  const message = item => ({ type: { __name: 'MessageGroup' }, props: { item, loading: false, onStop: stop } });
  const messages = [message({ userText: 'Prior synthetic message' })];
  function stop() {
    webState.stopCalls++;
    webState.pageController.abort();
    messages.at(-1).props.loading = false;
  }
  const chat = { type: { __name: 'chat' }, subTree: { props: { loading: web?.busy === true },
    children: [{ props: { show: web?.historyLoading === true, size: 'small' } }, { props: { show: web?.dialog === true } }, messages] } };
  const input = { type: { __name: 'ChatInput' }, parent: chat,
    props: { item: { ...session, ...web?.session }, showExport: web?.emptyHistory ? 0 : 1, disableClearBtn: web?.emptyHistory === true },
    subTree: { children: [{ props: { max: 15, value: web?.attachments || 0 } }] },
    vnode: { props: { onSend: async request => {
      webState.sendCalls.push(request);
      assert.equal(root.inert, true, 'official send must run with page interaction locked');
      if (web?.stall) return new Promise(() => {});
      messages.push(message({ userText: request.text, model: input.props.item.model, userFile: request.files[0] || null }));
      messages.at(-1).props.loading = true;
      input.props.showExport++;
      if (web?.background) await window.fetch('https://xipuai.xjtlu.edu.cn/jmapi/api/common/config', {
        headers: { 'Jm-Token': 'synthetic-school-token' }, credentials: 'include'
      });
      const body = { ...request, responseId: 'previous-web-response', ...web?.requestChanges };
      let response;
      try {
        response = await window.fetch(web?.url || 'https://xipuai.xjtlu.edu.cn/jmapi/api/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Jm-Token': 'synthetic-school-token' },
          signal: webState.pageController.signal, body: JSON.stringify(body)
        });
      } catch (error) { if (web?.swallow) return; throw error; }
      if (response.status !== 200) throw response;
      webState.visibleResponses.push(await response.text());
      if (web?.hangAfterResponse) return new Promise(() => {});
      messages.at(-1).props.loading = false;
    } } }
  };
  input.subTree.children.push({ type: 'textarea', el: composer });
  chat.subTree.children.push({ component: input });
  root._vnode = { component: { subTree: { children: [{ component: chat }] } } };
  if (!web?.production) composer.__vueParentComponent = input;
  if (web?.missingTree) delete root._vnode;
  if (web?.missingSend) delete input.vnode.props.onSend;
  if (web?.decoy || web?.ambiguous) root._vnode.component.subTree.children.push({ component: {
    ...input, subTree: { children: [{ type: 'textarea', el: web.ambiguous ? composer : {} }] }
  } });
  webState.input = input;
  webState.messages = messages;
  vm.runInNewContext(source, {
    window, location,
    TextDecoder, AbortController, FormData, File, atob, btoa,
    setTimeout: callback => { webState.timer = callback; return 1; },
    clearTimeout: () => { webState.timer = null; },
    document: { querySelector: () => root, querySelectorAll: () => web ? [composer] : [] },
    localStorage: { getItem: () => 'en' }
  });
  return {
    events, calls, web: webState, window, location,
    request(op, body = payload, job = 'test-job') {
      const done = new Promise(resolve => pending.set(job, resolve));
      const message = { source: 'xipu-bridge', type: 'req', job, op, payload: body };
      const count = calls.length;
      listener({ source: {}, data: message });
      assert.equal(calls.length, count, 'cross-window requests must be ignored');
      listener({ source: window, origin: 'https://xipuai.xjtlu.edu.cn', data: message });
      return done;
    },
    cancel(job = 'test-job') { listener({ source: window, data: { source: 'xipu-bridge', type: 'cancel', job } }); }
  };
}
async function run(op, responses, body = payload, cancel = false, web = null) {
  const h = mount(responses, cancel, web);
  const done = h.request(op, body);
  if (cancel === true) h.cancel();
  await done;
  await flush();
  const { events, calls } = h;
  assert.equal(responses.length, 0);
  assert.ok(!JSON.stringify(events).includes('synthetic-school-token'), 'school token leaked');
  return { events, calls, error: events.at(-1).message, web: h.web, window: h.window };
}

async function webSendChecks() {
  const request = { ...payload, debug_web_session: true, text: '  Exact synthetic text\n', online: 1, thinking: 'high' };
  const reply = () => sse('data: {"code":0,"type":"string","data":"VISIBLE_OK"}\n\n');
  const direct = await run('chat', [list(), reply()], { ...request, debug_web_session: false }, false, {});
  assert.equal(direct.web.sendCalls.length, 0, 'the default fetch path must not call the webpage handler');
  assert.equal(direct.calls.length, 2);
  const sent = await run('chat', [list(), reply()], request, false, {});
  assert.equal(sent.error, undefined);
  assert.equal(sent.web.sendCalls.length, 1);
  assert.equal(sent.calls.length, 2, 'one official send must produce one completion');
  assert.equal(sent.calls[1].body.text, request.text, 'the official handler must receive exact untrimmed text');
  assert.equal(sent.calls[1].body.responseId, null, 'web history must not become school context');
  assert.equal(sent.calls[1].body.online, 1);
  assert.equal(sent.calls[1].body.thinking, 'high');
  assert.equal(sent.calls[1].body.sessionId, session.id);
  assert.ok(sent.web.visibleResponses[0].includes('VISIBLE_OK'), 'the official reader must receive its own response body');
  assert.equal(sent.events.find(event => event.kind === 'event').event.data, 'VISIBLE_OK');
  assert.equal(sent.web.root.inert, false);
  assert.equal(sent.window.fetch, sent.web.originalFetch);
  const production = await run('chat', [list(), reply()], request, false, { production: true, decoy: true });
  assert.equal(production.error, undefined, 'production traversal must match the actual visible textarea, ignoring other composers');
  assert.equal(production.web.sendCalls.length, 1);
  assert.equal(production.calls[1].body.responseId, null);
  assert.equal(production.web.root.inert, false);
  assert.equal(production.window.fetch, production.web.originalFetch);
  for (const [page, diagnostic] of [
    [{ production: true, missingTree: true }, /mounted Vue app tree/],
    [{ production: true, ambiguous: true }, /matched to one official ChatInput/],
    [{ production: true, missingSend: true }, /ChatInput send handler/]
  ]) {
    const rejected = await run('chat', [list()], request, false, page);
    assert.match(rejected.error, diagnostic);
    assert.equal(rejected.events.at(-1).code, 'debug_web_session_unavailable');
    assert.equal(rejected.calls.length, 1);
    assert.equal(rejected.web.sendCalls.length, 0);
    assert.equal(rejected.web.root.inert, false);
    assert.equal(rejected.window.fetch, rejected.web.originalFetch);
  }
  for (const page of [{ draft: 'Existing unsent draft' }, { attachments: 1 }, { emptyHistory: true }, { busy: true },
    { historyLoading: true }, { dialog: true },
    { session: { id: 99 } }, { session: { name: 'Other session' } }, { session: { model: 'other-model' } }, { session: { contextCount: 1 } }]) {
    const rejected = await run('chat', [list()], request, false, { production: true, ...page });
    assert.match(rejected.error, /^Webpage send:/);
    assert.equal(rejected.events.at(-1).code, 'debug_web_session_unavailable');
    assert.equal(rejected.calls.length, 1, 'web preflight failures must stop before mutations or generation');
    assert.equal(rejected.web.sendCalls.length, 0);
    assert.equal(rejected.web.root.inert, false);
    assert.equal(rejected.window.fetch, rejected.web.originalFetch);
  }
  for (const page of [{ requestChanges: { text: 'Changed text' } }, { requestChanges: { files: ['https://other.example/image.png'] } },
    { requestChanges: { sessionId: 99 } }, { requestChanges: { online: 0 } }, { requestChanges: { thinking: 'low' } },
    { url: 'https://other.example/api/chat/completions' }, { requestChanges: { text: 'Changed text' }, swallow: true }]) {
    const rejected = await run('chat', [list()], request, false, page);
    assert.match(rejected.error, /^Webpage send:/);
    assert.equal(rejected.calls.length, 1, 'mismatched official requests must never reach fetch');
    assert.equal(rejected.events.at(-1).code, 'debug_web_session_unavailable');
    assert.equal(rejected.web.root.inert, false);
    assert.equal(rejected.window.fetch, rejected.web.originalFetch);
    assert.equal(rejected.web.messages.at(-1).props.loading, false);
  }
  const background = await run('chat', [list(), json({ code: 0 }), reply()], request, false, { background: true });
  assert.equal(background.error, undefined);
  assert.equal(background.calls.length, 3, 'unrelated webpage requests must retain the original fetch path');
  const httpFailure = await run('chat', [list(), json({ code: 10008 }, 502)], request, false, {});
  assert.match(httpFailure.error, /^Generate response: .*HTTP 502/);
  assert.equal(httpFailure.web.stopCalls, 1, 'HTTP rejection must clear the official page loading state');
  assert.equal(httpFailure.web.messages.at(-1).props.loading, false);
  assert.equal(httpFailure.web.root.inert, false);
  assert.equal(httpFailure.window.fetch, httpFailure.web.originalFetch);
  const schoolFailure = await run('chat', [list(), sse('data: {"code":10008}\n\n')], request, false, {});
  assert.equal(schoolFailure.error, 'Generate response: The school API rejected the request (school code 10008)');
  assert.equal(schoolFailure.web.root.inert, false);
  assert.equal(schoolFailure.web.messages.at(-1).props.loading, false);
  const stalled = mount([list()], false, { stall: true });
  const stalledDone = stalled.request('chat', request);
  await flush();
  assert.equal(stalled.web.root.inert, true);
  stalled.web.timer();
  await stalledDone; await flush();
  assert.match(stalled.events.at(-1).message, /did not start the request in time/);
  assert.equal(stalled.events.at(-1).code, 'debug_web_session_unavailable');
  assert.equal(stalled.calls.length, 1);
  assert.equal(stalled.web.root.inert, false);
  assert.equal(stalled.window.fetch, stalled.web.originalFetch);
  let aborted = false;
  const pending = mount([list(), ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('Synthetic fetch cancelled')); }, { once: true });
  })], false, {});
  const pendingDone = pending.request('chat', request);
  await flush();
  pending.cancel();
  await pendingDone; await flush();
  assert.equal(aborted, true, 'native cancellation must abort the official network request');
  assert.equal(pending.calls.length, 2);
  assert.equal(pending.web.root.inert, false);
  assert.equal(pending.window.fetch, pending.web.originalFetch);
  assert.equal(pending.web.visibleResponses.length, 0);
  assert.equal(pending.web.messages.at(-1).props.loading, false);
  const hanging = mount([list(), reply()], false, { hangAfterResponse: true });
  const hangingDone = hanging.request('chat', request);
  for (let count = 0; count < 10 && !hanging.web.visibleResponses.length; count++) await flush();
  assert.equal(hanging.web.visibleResponses.length, 1);
  hanging.cancel();
  await hangingDone; await flush();
  assert.equal(hanging.web.root.inert, false, 'cancellation must unlock even a hanging official send promise');
  assert.equal(hanging.window.fetch, hanging.web.originalFetch);
  assert.equal(hanging.web.messages.at(-1).props.loading, false);
  const changed = mount([list(), reply()], false, { hangAfterResponse: true });
  const changedDone = changed.request('chat', request);
  for (let count = 0; count < 10 && !changed.web.visibleResponses.length; count++) await flush();
  assert.equal(changed.web.visibleResponses.length, 1);
  changed.web.input.props.item = { ...session, id: 99 };
  changed.cancel();
  await changedDone; await flush();
  assert.equal(changed.web.stopCalls, 0, 'cleanup must not append an abort event to another visible conversation');
  assert.equal(changed.web.root.inert, false);
  assert.equal(changed.window.fetch, changed.web.originalFetch);
}

async function setupChecks() {
  const name = 'New bridge session';
  const create = { name, model };
  const resume = { ...create, session_id: 73 };
  const catalog = () => json({ code: 0, data: { models: [{ value: model }] } });
  const initial = { id: resume.session_id, name, model: 'initial-model', contextCount: 5,
    prompt: 'Synthetic instruction', temperature: 0.5, maxToken: 128, plugins: ['synthetic-plugin'], extra: { keep: true } };
  const configured = { ...initial, model, contextCount: 0, prompt: '' };
  const resultOf = result => JSON.parse(JSON.stringify(result.events.find(event => event.kind === 'result')?.result));
  const assertFailure = result => {
    assert.ok(result.error);
    assert.equal(result.events.filter(event => event.kind === 'result').length, 0);
    assert.ok(result.calls.every(call => !/completions|upload|delSession/.test(call.url)), 'setup never generates, uploads or deletes');
  };

  for (const [code, data] of [[0, { ...initial, token: 'synthetic-school-token' }], ['0', { id: 'new-opaque-id' }]]) {
    const created = await run('setup_create', [catalog(), list([session]), json({ code, data })], create);
    assert.equal(created.error, undefined);
    assert.deepEqual(resultOf(created), { session: { id: data.id, name } }, 'return only the confirmed recovery identity');
    assert.deepEqual(created.calls.map(call => new URL(call.url).pathname), [
      '/jmapi/api/chat/config', '/jmapi/api/chat/session', '/jmapi/api/chat/saveSession'
    ], 'do not risk losing the created ID to another request');
    assert.equal(created.calls[2].method, 'POST');
    assert.equal(created.calls[2].headers['Content-Type'], 'application/json');
    assert.deepEqual(created.calls[2].body, { name, lang: 'en' }, 'create using the official minimal body');
    assert.ok(!JSON.stringify(created.events).includes('Synthetic instruction'));
  }
  for (const field of ['name', 'model']) {
    for (const value of [undefined, null, false, 1, '', ' ', ' padded', 'padded ', 'x'.repeat(201), 'line\nbreak', 'tab\t', 'null\0', 'delete\x7f']) {
      for (const op of ['setup_create', 'setup_configure', 'setup_check']) {
        const failed = await run(op, [], { ...resume, [field]: value });
        assertFailure(failed);
        assert.equal(failed.calls.length, 0, 'invalid setup fields fail locally');
      }
    }
  }
  for (const session_id of [undefined, null, 0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1, '', ' ', ' 73', false, {}]) {
    const failed = await run('setup_configure', [], { ...resume, session_id });
    assertFailure(failed);
    assert.equal(failed.calls.length, 0);
  }
  for (const op of ['setup_create', 'setup_configure']) {
    for (const body of [null, {}, { code: 0, data: { models: {} } }, { code: 0, data: { models: ['unknown-model'] } }]) {
      const failed = await run(op, [json(body)], resume);
      assertFailure(failed);
      assert.equal(failed.calls.length, 1, 'catalog failures must not mutate sessions');
    }
    for (const data of [null, {}, [null], [{ ...session, id: null }], [{ id: 42 }]]) {
      const failed = await run(op, [catalog(), list(data)], resume);
      assertFailure(failed);
      assert.equal(failed.calls.length, 2, 'malformed lists must not mutate sessions');
    }
  }
  for (const existing of [[initial], [configured], [initial, initial]]) {
    const failed = await run('setup_create', [catalog(), list(existing)], create);
    assertFailure(failed);
    assert.match(failed.error, /already has this name/);
    assert.equal(failed.calls.length, 2, 'never overwrite a pre-existing same-name session');
  }
  for (const data of [null, [], {}, { id: 0 }, { id: ' ' }, { id: 73, name: 'Different name' }, { id: 73, name: null },
    { id: session.id }, { id: String(session.id) }]) {
    const failed = await run('setup_create', [catalog(), list([session]), json({ code: 0, data })], create);
    assertFailure(failed);
    assert.equal(failed.calls.length, 3, 'an unconfirmed identity never triggers another mutation');
  }
  for (const op of ['setup_create', 'setup_configure']) {
    for (const response of [json({ code: 23 }), json({ code: 429 }, 429), json({ code: 0 }, 429),
      json(null), json({}), json([]), new Response('invalid JSON')]) {
      const failed = await run(op, [catalog(), list(op === 'setup_create' ? [] : [initial]), response], resume);
      assertFailure(failed);
      assert.equal(failed.calls.length, 3, 'failed mutations are never retried or followed by another request');
    }
  }
  for (const code of [0, '0']) {
    const completed = await run('setup_configure', [catalog(), list([initial]), json({ code }), list([configured])], resume);
    assert.equal(completed.error, undefined);
    assert.deepEqual(completed.calls[2].body, { ...initial, model, contextCount: 0, prompt: '', lang: 'en' },
      'clear only the setup-owned fields and preserve unrelated configuration');
    assert.deepEqual(resultOf(completed), { session: { id: initial.id, name, model, contextCount: 0 } });
    assert.equal(completed.calls.length, 4);
    assert.ok(!JSON.stringify(completed.events).includes('Synthetic instruction'));
  }
  const recovered = await run('setup_configure', [catalog(), list([configured])], resume);
  assert.equal(recovered.error, undefined);
  assert.deepEqual(resultOf(recovered), { session: { id: initial.id, name, model, contextCount: 0 } });
  assert.equal(recovered.calls.length, 2, 'a verified configuration can resume without another save');
  const opaque = await run('setup_configure', [catalog(), list([{ ...configured, id: 'new-opaque-id' }])],
    { ...resume, session_id: 'new-opaque-id' });
  assert.equal(opaque.error, undefined);
  for (const [session_id, listedID, savedID] of [[73, '73', '73'], ['73', 73, 73], [73, 73, '73'], ['73', '73', 73]]) {
    const listed = { ...initial, id: listedID };
    const completed = await run('setup_configure', [catalog(), list([listed]), json({ code: 0 }), list([{ ...configured, id: savedID }])], { ...resume, session_id });
    assert.equal(completed.error, undefined);
    assert.equal(completed.calls[2].body.id, listedID, 'save the fetched ID without converting it');
    assert.equal(completed.calls[2].body.contextCount, 0, 'configure a newly created session with default context 5');
    assert.equal(resultOf(completed).session.id, savedID, 'return the verified readback representation');
    const recovered = await run('setup_configure', [catalog(), list([{ ...configured, id: listedID }])], { ...resume, session_id });
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.calls.length, 2, 'equivalent IDs do not require another save');
  }
  for (const [sessions, error] of [[[], /missing or has been renamed/], [[{ ...initial, id: 74 }], /different ID/],
    [[{ ...initial, name: 'Renamed session' }], /missing or has been renamed/], [[initial, initial], /Multiple conversations/],
    [[initial, { ...initial, name: 'Other name' }], /duplicate conversation ID/],
    [[initial, { ...initial, id: String(initial.id), name: 'Other name' }], /duplicate conversation ID/],
    ...['073', '7.3e1', '73.0', 'different-opaque-id'].map(id => [[{ ...initial, id }], /different ID/])]) {
    const failed = await run('setup_configure', [catalog(), list(sessions)], resume);
    assertFailure(failed);
    assert.match(failed.error, error);
    assert.equal(failed.calls.length, 2, 'resume must never create a missing session or overwrite another identity');
  }
  for (const sessions of [[], [{ ...configured, id: 74 }], [{ ...configured, id: '073' }],
    [{ ...configured, name: 'Renamed session' }], [configured, configured],
    [configured, { ...configured, id: String(initial.id), name: 'Other name' }],
    [{ ...configured, model: 'other-model' }], [{ ...configured, contextCount: 1 }], [{ ...configured, contextCount: '0' }],
    ...['Synthetic instruction', null, undefined].map(prompt => [{ ...configured, prompt }])]) {
    const failed = await run('setup_configure', [catalog(), list([initial]), json({ code: 0 }), list(sessions)], resume);
    assertFailure(failed);
    assert.equal(failed.calls.length, 4, 'readback failure must not retry or undo the accepted update');
    assert.equal(failed.calls.filter(call => call.method === 'POST').length, 1);
  }
  for (const op of ['setup_create', 'setup_configure']) {
    for (const cancelAt of ['catalog', 'session']) {
      const responses = [catalog()];
      if (cancelAt === 'session') responses.push(list(op === 'setup_create' ? [] : [initial]));
      const cancelled = await run(op, responses, resume, cancelAt);
      assertFailure(cancelled);
      assert.ok(cancelled.calls.every(call => !call.method), 'cancellation before saving must not mutate');
    }
    const cancelled = await run(op, [catalog(), list(op === 'setup_create' ? [] : [initial]), ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('setup save cancelled')), { once: true });
    })], resume, 'save');
    assertFailure(cancelled);
    assert.equal(cancelled.error, 'The school request was cancelled.');
    assert.equal(cancelled.calls.length, 3);
  }
  const acknowledged = await run('setup_create', [catalog(), list([]), json({ code: 0, data: { id: 73 } })], create, 'save');
  assertFailure(acknowledged);
  assert.equal(acknowledged.events.at(-1).result, undefined, 'a creation acknowledgement received after cancellation remains unknown');
  const cancelledConfiguration = await run('setup_configure', [catalog(), list([initial]), json({ code: 0 })], resume, 'save');
  assertFailure(cancelledConfiguration);
  assert.equal(cancelledConfiguration.calls.length, 3, 'cancellation after an accepted update stops verification without rollback');
}

async function recoveryChecks() {
  const request = { name: session.name, model };
  const catalog = () => json({ code: 0, data: { models: [model] } });
  const resultOf = result => JSON.parse(JSON.stringify(result.events.find(event => event.kind === 'result')?.result));
  for (const status of [502, 503, 504]) {
    for (const before of [[], [catalog()]]) {
      const failed = await run('setup_create', [...before, new Response('private gateway details', { status })], request);
      assert.match(failed.error, new RegExp(`temporarily unavailable \\(HTTP ${status}\\)`));
      assert.match(failed.error, /no automatic retry/);
      assert.deepEqual(JSON.parse(JSON.stringify(failed.events.at(-1).result)), { notCreated: true });
      assert.ok(failed.calls.every(call => !call.method), 'safe failure metadata requires no attempted creation');
      assert.ok(!JSON.stringify(failed.events).includes('private gateway details'));
    }
    const unknown = await run('setup_create', [catalog(), list([]), json({ msg: 'private gateway details' }, status)], request);
    assert.match(unknown.error, new RegExp(`HTTP ${status}`));
    assert.equal(unknown.events.at(-1).result, undefined, 'a failed create POST does not prove that nothing was created');
    assert.equal(unknown.calls.length, 3, 'never retry a failed create POST');
  }
  const thrown = await run('setup_create', [catalog(), list([]), () => { throw new Error('Synthetic fetch failure'); }], request);
  assert.equal(thrown.events.at(-1).result, undefined, 'a synchronous fetch failure after attempting the POST also remains unknown');
  const invalid = await run('setup_create', [], { ...request, name: '' });
  assert.equal(invalid.events.at(-1).result.notCreated, true);
  for (const body of [request, { ...request, session_id: session.id }, { ...request, session_id: String(session.id) }]) {
    const checked = await run('setup_check', [list([{ ...session, model: 'current-model', contextCount: 5,
      prompt: 'Private synthetic prompt', history: ['Private synthetic history'], token: 'synthetic-school-token' }])], body);
    assert.equal(checked.error, undefined);
    assert.deepEqual(resultOf(checked), { session: { ...session, model: 'current-model', contextCount: 5, promptEmpty: false } });
    assert.equal(checked.calls.length, 1);
    assert.ok(checked.calls[0].url.endsWith('/api/chat/session?lang=en'));
    assert.equal(checked.calls[0].method, undefined, 'recovery checks must neither read the catalog nor mutate the session');
    assert.ok(!JSON.stringify(checked.events).includes('Private synthetic'));
    const missing = await run('setup_check', [list([])], body);
    assert.deepEqual(resultOf(missing), { session: null });
  }
  for (const prompt of ['', null, undefined, ' ']) {
    const checked = await run('setup_check', [list([{ ...session, prompt }])], request);
    assert.equal(resultOf(checked).session.promptEmpty, prompt === '');
  }
  const nonnumericContext = await run('setup_check', [list([{ ...session, contextCount: '0' }])], request);
  assert.equal(resultOf(nonnumericContext).session.contextCount, null, 'do not treat malformed context as verified zero');
  for (const session_id of [null, 0, false, {}, Number.MAX_SAFE_INTEGER + 1]) {
    const failed = await run('setup_check', [], { ...request, session_id });
    assert.ok(failed.error);
    assert.equal(failed.events.at(-1).result, undefined);
  }
  for (const [sessions, body] of [
    [[session, session], request],
    [[session, { ...session, id: String(session.id), name: 'Other name' }], request],
    [[session], { ...request, session_id: '042' }],
    [[session], { ...request, session_id: 43 }],
    [[{ ...session, id: null }], request],
    [[{ ...session, model: { private: 'Private synthetic field' } }], request]
  ]) {
    const failed = await run('setup_check', [list(sessions)], body);
    assert.ok(failed.error);
    assert.equal(failed.events.filter(event => event.kind === 'result').length, 0);
    assert.equal(failed.events.at(-1).result, undefined);
    assert.equal(failed.calls.length, 1);
    assert.ok(!JSON.stringify(failed.events).includes('Private synthetic field'));
  }
}

async function cancellationChecks() {
  const setup = { name: session.name, model };
  const catalog = () => json({ code: 0, data: { models: [model] } });
  const cases = [
    { op: 'models', before: [], late: catalog },
    { op: 'inspect', before: [], late: catalog },
    { op: 'setup_check', before: [], late: () => list(), body: setup },
    { op: 'setup_create', before: [], late: catalog, body: setup, notCreated: true },
    { op: 'setup_create', before: [catalog(), list([])], late: () => json({ code: 0, data: { id: 73 } }), body: setup },
    { op: 'setup_configure', before: [catalog(), list([{ ...session, contextCount: 5 }])],
      late: () => json({ code: 0 }), body: { ...setup, session_id: session.id } },
    { op: 'chat', before: [list()], late: () => json({ code: 0, type: 'object', data: { aiText: 'Late result' } }) }
  ];
  for (const item of cases) {
    let releaseOld, releaseNew;
    const h = mount([...item.before, () => new Promise(resolve => { releaseOld = resolve; }),
      () => new Promise(resolve => { releaseNew = resolve; })]);
    const first = h.request(item.op, item.body);
    await flush();
    assert.equal(typeof releaseOld, 'function');
    h.cancel();
    assert.equal(h.events.filter(event => event.kind === 'done').length, 1, 'abort settles immediately when fetch ignores its signal');
    await first;
    const cancelled = h.events.at(-1);
    assert.equal(cancelled.message, 'The school request was cancelled.');
    assert.equal(cancelled.result?.notCreated, item.notCreated);
    const afterCancel = h.events.length;
    const recovered = h.request('setup_check', setup);
    await flush();
    assert.equal(typeof releaseNew, 'function', 'a cancelled request must release its page slot');
    releaseOld(item.late());
    await flush();
    assert.equal(h.events.length, afterCancel, 'late output must not escape into a new task with the same job ID');
    assert.equal(h.calls.length, item.before.length + 2, 'aborted work must not make subsequent requests');
    await h.request('models', {}, 'overlap');
    assert.match(h.events.at(-1).message, /another school request is active/, 'late settlement must not release the new task slot');
    releaseNew(list([]));
    await recovered;
    assert.equal(h.events.filter(event => event.job === 'test-job' && event.kind === 'done').length, 2);
    assert.equal(h.events.filter(event => event.job === 'test-job' && event.kind === 'result').length, 1);
    assert.equal(h.events.find(event => event.kind === 'result').result.session, null);
    assert.ok(!JSON.stringify(h.events).includes('synthetic-school-token'));
  }
  let readerCancelled = false;
  const stream = new ReadableStream({ cancel() { readerCancelled = true; } });
  const h = mount([list(), new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), list([])]);
  const first = h.request('chat');
  await flush();
  h.cancel();
  assert.equal(h.events.at(-1).kind, 'done');
  await first;
  await flush();
  assert.equal(readerCancelled, true, 'abort releases an active SSE reader');
  await h.request('setup_check', setup);
  assert.equal(h.events.at(-1).message, undefined);
}

async function modernChecks() {
  const catalog = () => json({ code: 0, data: { model: { chat: { list: [{ value: model, multimodal: true }] } } } });
  const h = mount([catalog()], false, null, true);
  await h.request('models');
  assert.equal(h.events[0].result.data.models[0].value, model);
  assert.ok(h.calls[0].url.endsWith('/api/v2/chat/configV3?lang=en'));
  assert.equal(h.calls[0].headers['x-lang'], 'en');
  assert.equal(h.calls[0].headers['x-platform'], 'web');
  assert.ok(!JSON.stringify(h.events).includes('synthetic-school-token'));

  const sent = mount([list(), sse('data: {"type":"string","data":"OK"}\n\n')], false, null, true);
  await sent.request('chat');
  assert.equal(sent.events.at(-1).message, undefined);
  assert.ok(sent.calls.at(-1).url.endsWith('/api/v2/chat/response'));
  assert.deepEqual(sent.calls.at(-1).body, { text: payload.text, online: 0, thinking: 'minimal', sessionId: 42,
    responseId: null, intent: 'chat', attachments: [], options: null });

  const image = { name: 'sample.png', mime: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') };
  const url = 'https://images.example.test/sample.png';
  const uploaded = mount([catalog(), list(), json({ code: 0, data: { file_url: url } }),
    sse('data: {"type":"string","data":"IMAGE_OK"}\n\n')], false, null, true);
  await uploaded.request('chat', { ...payload, images: [image] });
  assert.equal(uploaded.events.at(-1).message, undefined);
  assert.equal(uploaded.calls[2].body.has('accept'), false);
  assert.deepEqual(uploaded.calls[3].body.attachments, [url]);
  assert.equal(uploaded.calls[3].body.files, undefined);

  const secondImage = { ...image, name: 'second.png' };
  const secondURL = 'https://images.example.test/second.png';
  const multiple = mount([catalog(), list(), json({ code: 0, data: { file_url: url } }),
    json({ code: 0, data: { file_url: secondURL } }),
    sse('data: {"type":"string","data":"IMAGES_OK"}\n\n')], false, null, true);
  await multiple.request('chat', { ...payload, images: [image, secondImage] });
  assert.equal(multiple.events.at(-1).message, undefined);
  assert.deepEqual(multiple.calls.slice(2, 4).map(call => call.body.get('file').name), ['sample.png', 'second.png']);
  assert.deepEqual(multiple.calls[4].body.attachments, [url, secondURL]);
  assert.equal(multiple.calls.length, 5);

  const uploadFailed = mount([catalog(), list(), json({ code: 0, data: { file_url: url } }),
    json({ code: 10008 })], false, null, true);
  await uploadFailed.request('chat', { ...payload, images: [image, secondImage] });
  assert.match(uploadFailed.events.at(-1).message, /Upload image 2\/2 \("second.png"\):.*10008/);
  assert.equal(uploadFailed.events.at(-1).code, 'attachment_upload_failed');
  assert.equal(uploadFailed.events.at(-1).attachment_index, 1);
  assert.deepEqual(uploadFailed.calls.slice(2).map(call => call.body.get('file').name), ['sample.png', 'second.png']);
  assert.equal(uploadFailed.calls.length, 4, 'neither completed nor failed uploads are retried');
  assert.ok(uploadFailed.calls.every(call => !call.url.endsWith('/api/v2/chat/response')), 'an upload failure prevents generation');

  const unsafe = mount([list([{ ...session, contextCount: 5 }])], false, null, true);
  await unsafe.request('chat');
  assert.match(unsafe.events.at(-1).message, /Context Count 0/);
  assert.equal(unsafe.calls.length, 1);
  for (const body of [{ code: 0, data: { models: [model] } }, { code: 0, data: { model: { chat: { list: {} } } } }]) {
    const invalid = mount([json(body)], false, null, true);
    await invalid.request('models');
    assert.match(invalid.events.at(-1).message, /invalid model list/);
    assert.equal(invalid.calls.length, 1, 'never fall back to legacy endpoints');
  }
  const refused = mount([], false, null, true);
  await refused.request('chat', { ...payload, debug_web_session: true });
  assert.equal(refused.events.at(-1).code, 'debug_web_session_unavailable');
  assert.equal(refused.calls.length, 0);
  const signedOut = mount([], false, null, true);
  signedOut.web.root.__vue_app__.config.globalProperties.$pinia.state.value = { user: { token: 'synthetic-school-token' } };
  await signedOut.request('models');
  assert.match(signedOut.events.at(-1).message, /Sign in/);
  assert.equal(signedOut.calls.length, 0, 'never reuse another frontend login store');
  const rejected = mount([list(), json({ code: 10008 })], false, null, true);
  await rejected.request('chat');
  assert.match(rejected.events.at(-1).message, /Generate response:.*10008/);
  assert.equal(rejected.calls.length, 2, 'never retry a rejected generation');
  const finalError = { type: 'object', data: { errorjson: { message: 'synthetic upstream detail' } } };
  for (const response of [json(finalError), sse('data: {"type":"string","data":"Partial"}\n\n'
    + `data: ${JSON.stringify(finalError)}\n\n`)]) {
    const failed = mount([list(), response], false, null, true);
    await failed.request('chat');
    assert.match(failed.events.at(-1).message, /Generate response:.*generation failure/);
    assert.ok(!JSON.stringify(failed.events).includes('synthetic upstream detail'));
    assert.equal(failed.events.filter(event => event.kind === 'done').length, 1);
    assert.equal(failed.calls.length, 2);
  }
  const finished = mount([list(), sse('data: {"type":"string","data":"OK"}\n\n'
    + 'data: {"type":"object","data":{"errorjson":null}}\n\n')], false, null, true);
  await finished.request('chat');
  assert.equal(finished.events.at(-1).message, undefined);
  const navigated = mount([() => { navigated.location.pathname = '/user'; return catalog(); }], false, null, true);
  await navigated.request('models');
  assert.equal(navigated.events[0].result.data.models[0].value, model, 'in-flight catalog keeps its protocol');
  const navigationError = mount([list(), () => { navigationError.location.pathname = '/user'; return json(finalError); }], false, null, true);
  await navigationError.request('chat');
  assert.match(navigationError.events.at(-1).message, /generation failure/);
  h.location.pathname = '/user';
  await h.request('models');
  assert.match(h.events.at(-1).message, /Open an XIPU AI/);
  assert.equal(h.calls.length, 1, 'navigation outside chat must prevent further requests');
}

async function fileChecks() {
  const file = { kind: 'file', name: 'inventory.txt', mime: 'text/plain', data: Buffer.from('Blue: 17\nRed: 26\n').toString('base64') };
  const pdf = { kind: 'file', name: 'report.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n').toString('base64') };
  const image = { kind: 'image', name: 'chart.png', mime: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') };
  const url = name => `https://files.example.test/${name}`;
  const upload = name => json({ code: 0, data: { file_url: url(name) } });
  const reply = () => sse('data: {"type":"string","data":"FILE_OK"}\n\n');
  const catalog = multimodal => json({ code: 0, data: { model: { chat: { list: [{ value: model, multimodal }] } } } });
  const previous = { ...session, model: 'another-model' };
  const textModel = mount([list([previous]), catalog(false), json({ code: 0 }), list(), upload(file.name), reply()], false, null, true);
  await textModel.request('chat', { ...payload, attachments: [file] });
  assert.equal(textModel.events.at(-1).message, undefined, 'document input does not require image support');
  assert.deepEqual(textModel.calls.at(-1).body.attachments, [url(file.name)]);
  assert.equal(textModel.calls.at(-1).body.intent, 'chat', 'the school chooses document processing from ordinary-chat attachments');

  let finishUpload;
  const ordered = mount([catalog(true), list(), () => new Promise(resolve => { finishUpload = resolve; }),
    upload(image.name), upload(file.name), reply()], false, null, true);
  const waiting = ordered.request('chat', { ...payload, attachments: [pdf, image, file] });
  await flush();
  assert.equal(ordered.calls.length, 3, 'the next attachment waits for the previous upload');
  finishUpload(upload(pdf.name));
  await waiting;
  assert.equal(ordered.events.at(-1).message, undefined);
  assert.deepEqual(ordered.calls.slice(2, 5).map(call => call.body.get('file').name), [pdf.name, image.name, file.name]);
  assert.deepEqual(ordered.calls.at(-1).body.attachments, [pdf.name, image.name, file.name].map(url));
  for (const [index, attachment] of [pdf, image, file].entries()) {
    const call = ordered.calls[index + 2];
    assert.equal(call.body.has('accept'), false);
    assert.equal(call.headers['Content-Type'], undefined);
    assert.equal(call.body.get('file').type, attachment.mime);
    assert.deepEqual(Buffer.from(await call.body.get('file').arrayBuffer()), Buffer.from(attachment.data, 'base64'));
  }
  assert.ok(!JSON.stringify(ordered.events).includes('files.example.test'), 'uploaded attachment URLs stay in the school page');

  const markdown = { ...file, name: 'guide.markdown', mime: 'text/markdown', data: Buffer.from('# Guide\nSynthetic text: 文档\n').toString('base64') };
  const csv = { ...file, name: 'table.CSV', mime: 'text/csv', data: Buffer.from('color,count\nblue,17\n').toString('base64') };
  const four = [file, pdf, markdown, csv];
  const formats = mount([list(), ...four.map(item => upload(item.name)), reply()], false, null, true);
  await formats.request('chat', { ...payload, attachments: four });
  assert.equal(formats.events.at(-1).message, undefined);
  assert.deepEqual(formats.calls.at(-1).body.attachments, four.map(item => url(item.name)));
  const failed = mount([list(), upload(pdf.name), json({ code: 10008 })], false, null, true);
  await failed.request('chat', { ...payload, attachments: [pdf, file, markdown] });
  assert.match(failed.events.at(-1).message, /Upload file 2\/3 \("inventory.txt"\):.*10008/);
  assert.equal(failed.events.at(-1).code, 'attachment_upload_failed');
  assert.equal(failed.events.at(-1).attachment_index, 1);
  assert.equal(failed.calls.length, 3, 'a failed upload is not retried and stops later uploads and generation');
  assert.ok(failed.calls.every(call => !call.url.endsWith('/api/v2/chat/response')));
  const aborted = mount([list(), ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('upload cancelled')), { once: true });
  })], 'upload', null, true);
  await aborted.request('chat', { ...payload, attachments: [file, pdf] });
  assert.equal(aborted.events.at(-1).message, 'The school request was cancelled.');
  assert.equal(aborted.events.at(-1).code, undefined);
  assert.equal(aborted.events.at(-1).attachment_index, undefined);
  assert.equal(aborted.calls.length, 2);

  for (const response of [
    () => { throw new Error('Network connection failed'); },
    new Response('invalid JSON'),
    new Response('upstream unavailable', { status: 502 }),
    json({ code: 10008 }),
    json({ code: 0, data: { url: 'javascript:bad' } })
  ]) {
    const failure = mount([catalog(true), list(), upload(image.name), response], false, null, true);
    await failure.request('chat', { ...payload, attachments: [image, pdf, file] });
    const event = failure.events.at(-1);
    assert.equal(event.code, 'attachment_upload_failed');
    assert.equal(event.attachment_index, 1, 'image and document uploads share one ordinal');
    assert.match(event.message, /^Upload file 2\/3 \("report.pdf"\): /);
    assert.equal(failure.calls.length, 4, 'all upload failures stop later uploads and generation without retry');
    assert.ok(!JSON.stringify(failure.events).includes(pdf.data));
    assert.ok(!JSON.stringify(failure.events).includes('synthetic-school-token'));
  }

  for (const [modern, debug] of [[false, false], [false, true], [true, true]]) {
    const rejected = mount([], false, null, modern);
    await rejected.request('chat', { ...payload, attachments: [file], debug_web_session: debug });
    assert.equal(rejected.events.at(-1).code, 'unsupported_file_frontend');
    assert.equal(rejected.calls.length, 0, 'unsupported frontend rejects documents before reading or changing the school session');
  }
  const noVision = mount([catalog(false)], false, null, true);
  await noVision.request('chat', { ...payload, attachments: [file, image] });
  assert.equal(noVision.events.at(-1).code, 'unsupported_image_model');
  assert.equal(noVision.calls.length, 1, 'a document does not bypass image capability validation');

  const largeText = Buffer.alloc(9 * 1024 * 1024, 65);
  const largeImage = Buffer.from(largeText);
  Buffer.from(image.data, 'base64').copy(largeImage);
  const invalidRequests = [
    { attachments: null }, { attachments: {} }, { attachments: [null] },
    { attachments: [{ ...file, kind: 'document' }] }, { attachments: Array(11).fill(file) },
    { attachments: [file], images: [] },
    ...['../inventory.txt', '.inventory.txt', 'nested/inventory.txt', 'nested\\inventory.txt', 'inventory.txt ', 'inventory.txt.',
      'inventory\n.txt', '文件.txt', `${'a'.repeat(125)}.txt`, 'txt', 'file.exe'].map(name => ({ attachments: [{ ...file, name }] })),
    { attachments: [{ ...file, mime: 'application/pdf' }] }, { attachments: [{ ...file, mime: undefined }] },
    { attachments: [{ ...file, name: 'unknown.bin', mime: undefined }] },
    ...['', '!!!!', 'QQ=', 'QR==', 'A'.repeat(Math.ceil(10 * 1024 * 1024 / 3) * 4 + 4)].map(data => ({ attachments: [{ ...file, data }] })),
    ...[Buffer.from([0xc3, 0x28]), Buffer.from([65, 0, 66]), Buffer.from([65, 0x0b, 66]), Buffer.from([65, 0x7f, 66])].map(bytes => ({ attachments: [{ ...file, data: bytes.toString('base64') }] })),
    ...['not a PDF\n%%EOF', '%PDF-3.0\n%%EOF', '%PDF-1.7\n', `%PDF-1.7\n%%EOF${' '.repeat(1024)}`].map(content => ({ attachments: [{ ...pdf, data: Buffer.from(content).toString('base64') }] })),
    { attachments: [{ ...file, data: largeText.toString('base64') }, { ...image, data: largeImage.toString('base64') }] }
  ];
  for (const request of invalidRequests) {
    const invalid = mount([], false, null, true);
    await invalid.request('chat', { ...payload, ...request });
    assert.ok(invalid.events.at(-1).message, 'invalid attachments are rejected');
    assert.equal(invalid.calls.length, 0, 'attachment validation must complete before school requests');
  }
}

async function attachmentCountChecks() {
  const image = { kind: 'image', name: 'sample.png', mime: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') };
  const file = { kind: 'file', name: 'sample.txt', mime: 'text/plain', data: Buffer.from('Synthetic text').toString('base64') };
  const catalog = () => json({ code: 0, data: { model: { chat: { list: [{ value: model, multimodal: true }] } } } });
  for (const [field, inputs] of [
    ['images', Array.from({ length: 10 }, () => image)],
    ['attachments', Array.from({ length: 10 }, (_, index) => index % 2 ? file : image)],
    ['attachments', Array.from({ length: 10 }, () => file)]
  ]) {
    const urls = inputs.map((_, index) => `https://files.example.test/attachment-${index}`);
    const responses = [list(), ...urls.map(file_url => json({ code: 0, data: { file_url } })),
      sse('data: {"type":"string","data":"OK"}\n\n')];
    if (inputs.some(item => item.kind === 'image')) responses.unshift(catalog());
    const accepted = mount(responses, false, null, true);
    await accepted.request('chat', { ...payload, [field]: inputs });
    assert.equal(accepted.events.at(-1).message, undefined, 'the current frontend accepts ten attachments');
    assert.equal(accepted.calls.filter(call => call.url.endsWith('/api/common/upload')).length, 10);
    assert.deepEqual(accepted.calls.at(-1).body.attachments, urls, 'the attachment limit must not reorder or omit inputs');
    const rejected = mount([], false, null, true);
    await rejected.request('chat', { ...payload, [field]: [...inputs, inputs[0]] });
    assert.equal(rejected.events.at(-1).code, 'attachment_limit_exceeded');
    assert.match(rejected.events.at(-1).message, /at most 10 attachments/);
    assert.equal(rejected.calls.length, 0, 'eleven attachments must fail before school requests');
  }
  for (const debug of [false, true]) {
    for (const field of ['images', 'attachments']) {
      const legacy = mount([], false, null, false);
      await legacy.request('chat', { ...payload, [field]: [image, image], debug_web_session: debug });
      assert.equal(legacy.events.at(-1).code, 'attachment_limit_exceeded');
      assert.match(legacy.events.at(-1).message, /at most 1 attachment/);
      assert.equal(legacy.calls.length, 0, 'legacy image count must fail before reading or changing the school session');
    }
  }
}

async function diagnosticChecks() {
  for (const [status, code] of [[401, 'school_auth_required'], [403, 'school_http_error'], [429, 'school_rate_limited'],
    [500, 'school_http_error'], [502, 'school_http_error'], [503, 'school_http_error'], [504, 'school_http_error']]) {
    const rejected = await run('models', [json({ code: '10008' }, status)]);
    const error = rejected.events.at(-1);
    assert.equal(error.code, code);
    assert.equal(error.stage, 'model_catalog');
    assert.equal(error.http_status, status);
    assert.equal(error.school_code, [502, 503, 504].includes(status) ? undefined : 10008);
    assert.equal(rejected.calls.length, 1);
  }
  for (const [status, code] of [[200, 'school_invalid_response'], [401, 'school_auth_required'], [403, 'school_http_error'], [429, 'school_rate_limited']]) {
    const invalid = await run('models', [new Response('<private-response>', { status })]);
    assert.equal(invalid.events.at(-1).code, code);
    assert.equal(invalid.events.at(-1).http_status, status);
    assert.equal(invalid.events.at(-1).school_code, undefined);
    assert.ok(!JSON.stringify(invalid.events).includes('private-response'));
  }
  const failedRead = await run('models', [{ ok: true, status: 200, json: async () => { throw new TypeError('private download URL'); } }]);
  assert.equal(failedRead.events.at(-1).code, 'school_network_error');
  assert.equal(failedRead.events.at(-1).stage, 'model_catalog');
  assert.equal(failedRead.events.at(-1).http_status, 200);
  assert.ok(!JSON.stringify(failedRead.events).includes('private download URL'));
  for (const schoolCode of [10008, '10008', -17, '-17', 9007199254740992, 'unsafe-code', {}, null]) {
    const rejected = await run('chat', [list(), json({ code: schoolCode })]);
    const error = rejected.events.at(-1);
    assert.equal(error.code, 'school_rejected');
    assert.equal(error.stage, 'generation');
    assert.equal(error.http_status, 200);
    assert.equal(error.school_code, typeof schoolCode === 'number' && Number.isSafeInteger(schoolCode) ? schoolCode
      : typeof schoolCode === 'string' && /^-?\d+$/.test(schoolCode) ? Number(schoolCode) : undefined);
  }
  const catalog = () => json({ code: 0, data: { models: [{ value: model }] } });
  const failNetwork = () => { throw new TypeError('private network URL'); };
  for (const [op, responses, body, stage] of [
    ['models', [failNetwork], {}, 'model_catalog'],
    ['chat', [failNetwork], payload, 'session_read'],
    ['chat', [list(), failNetwork], payload, 'generation'],
    ['chat', [list([{ ...session, model: 'another-model' }]), catalog(), failNetwork], payload, 'session_update'],
    ['setup_create', [catalog(), list([]), failNetwork], { name: session.name, model }, 'session_create'],
    ['setup_configure', [catalog(), list([{ ...session, contextCount: 5 }]), failNetwork], { name: session.name, model, session_id: session.id }, 'session_configure']
  ]) {
    const failed = await run(op, responses, body);
    assert.equal(failed.events.at(-1).code, 'school_network_error');
    assert.equal(failed.events.at(-1).stage, stage);
    assert.equal(failed.events.at(-1).http_status, undefined);
    assert.ok(!JSON.stringify(failed.events).includes('private network URL'));
  }
  const image = { name: 'sample.png', mime: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') };
  for (const failure of [json({ code: '10008' }), json({ code: 429 }, 429), failNetwork]) {
    const uploaded = await run('chat', [json({ code: 0, data: { models: [{ value: model, multimodal: true }] } }), list(), failure], { ...payload, images: [image] });
    assert.equal(uploaded.events.at(-1).code, 'attachment_upload_failed');
    assert.equal(uploaded.events.at(-1).stage, 'attachment_upload');
    assert.equal(uploaded.events.at(-1).attachment_index, 0);
    assert.equal(uploaded.events.at(-1).http_status, typeof failure === 'function' ? undefined : failure.status);
    assert.equal(uploaded.events.at(-1).school_code, typeof failure === 'function' ? undefined : failure.status === 429 ? 429 : 10008);
  }
  for (const [items, code] of [[[], 'school_session_not_found'], [[session, session], 'school_session_ambiguous'],
    [[{ ...session, contextCount: 5 }], 'school_session_unsafe'], [[{ ...session, id: null }], 'school_invalid_response']]) {
    const guarded = await run('chat', [list(items)]);
    assert.equal(guarded.events.at(-1).code, code);
    assert.equal(guarded.events.at(-1).stage, 'session_read');
    assert.equal(guarded.calls.length, 1);
  }
  const previous = { ...session, model: 'another-model' };
  const unavailable = await run('chat', [list([previous]), json({ code: 0, data: { models: [] } })]);
  assert.equal(unavailable.events.at(-1).code, 'school_model_unavailable');
  assert.equal(unavailable.events.at(-1).stage, 'model_catalog');
  const unchanged = await run('chat', [list([previous]), catalog(), json({ code: 0 }), list([previous])]);
  assert.equal(unchanged.events.at(-1).code, 'school_session_update_failed');
  assert.equal(unchanged.events.at(-1).stage, 'session_update');
  const signedOut = mount([], false, null, true);
  signedOut.web.root.__vue_app__.config.globalProperties.$pinia.state.value = {};
  await signedOut.request('models');
  assert.equal(signedOut.events.at(-1).code, 'school_auth_required');
  assert.equal(signedOut.events.at(-1).stage, 'authentication');
  assert.equal(signedOut.calls.length, 0);
  for (const [wire, code, stage] of [
    ['data: not-json\n\n', 'school_stream_error', 'stream'],
    ['data: {"type":"string","data":"partial"}', 'school_stream_incomplete', 'stream'],
    ['data: {"type":"string","data":"partial"}\n\ndata: {"code":"10008"}\n\n', 'school_rejected', 'generation']
  ]) {
    const failed = await run('chat', [list(), sse(wire)]);
    assert.equal(failed.events.at(-1).code, code);
    assert.equal(failed.events.at(-1).stage, stage);
    assert.equal(failed.events.at(-1).http_status, 200);
    assert.equal(failed.events.at(-1).school_code, code === 'school_rejected' ? 10008 : undefined);
  }
  const cancelled = await run('chat', [({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new TypeError('cancelled transport')), { once: true });
  })], payload, true);
  assert.equal(cancelled.error, 'The school request was cancelled.');
  assert.equal(cancelled.events.at(-1).code, undefined, 'cancellation is not a network or upload failure');
}

async function main() {
  await modernChecks();
  await fileChecks();
  await attachmentCountChecks();
  await diagnosticChecks();
  await setupChecks();
  await webSendChecks();
  await recoveryChecks();
  await cancellationChecks();
  const models = await run('models', [json({ code: 0, data: { models: [{ value: model }] } })]);
  assert.equal(models.events[0].result.data.models[0].value, model);
  assert.ok(models.calls[0].url.endsWith('/api/chat/config?lang=en'));
  const inspected = await run('inspect', [
    json({ code: 0, data: { models: [{ value: model, label: 'Test model', private: 'synthetic-school-token' }] } }),
    list([{ ...session, token: 'synthetic-school-token', history: ['private conversation'] }])
  ]);
  assert.equal(inspected.events[0].result.models[0].id, model);
  assert.equal(inspected.events[0].result.sessions[0].name, session.name);
  assert.ok(!JSON.stringify(inspected.events).includes('private conversation'));
  assert.ok(inspected.calls.every(call => !call.body), 'inspection only reads school metadata');
  const cancelled = await run('models', [({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  })], {}, true);
  assert.equal(cancelled.error, 'The school request was cancelled.');
  assert.equal(cancelled.calls.length, 1);

  // A multibyte character and CRLF separators are split across every byte boundary.
  const unicode = String.fromCodePoint(0x1f30d);
  const response = await run('chat', [list(), sse(
    ': keepalive\r\ndata: {"code":0,"type":"string",\r\ndata: "reasoning_data":"reason"}\r\n\r\n'
    + `data: {"type":"string","data":"${unicode} OK"}\r\n\r\n`
    + 'data: [DONE]\r\n\r\ndata: {"type":"string","data":"IGNORE"}\r\n\r\n'
  )]);
  assert.equal(response.error, undefined);
  assert.equal(response.events.filter(x => x.kind === 'event').length, 2);
  assert.equal(response.events.find(x => x.event?.data).event.data, unicode + ' OK');
  assert.equal(response.events.find(x => x.event?.reasoning_data).event.reasoning_data, 'reason');
  assert.deepEqual(response.calls[1].body, {
    text: payload.text, files: [], online: 0, thinking: 'minimal', sessionId: 42, responseId: null, lang: 'en'
  });
  assert.equal(response.calls.length, 2, 'same-model requests must not fetch the catalog or change the session');
  for (const invalid of [[], [session, session], [{ ...session, contextCount: 1 }], [{ ...session, contextCount: '0' }],
    ...[null, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '', ' ', ' 42', false, {}].map(id => [{ ...session, id }])]) {
    const result = await run('chat', [list(invalid)]);
    assert.ok(result.error);
    assert.equal(result.calls.length, 1, 'reject invalid session before any completion');
  }
  const previous = { ...session, model: 'another-model', maxToken: 128, temperature: 0.7, top_p: 0.9,
    presencePenalty: 0.3, frequencyPenalty: 0.1, prompt: 'Synthetic session instruction', topSort: 2,
    icon: 'synthetic-icon', plugins: ['synthetic-plugin'], extra: { preserved: true } };
  const updated = { ...previous, model };
  const switchCatalog = () => json({ code: 0, data: { models: [{ value: model }] } });
  const reply = () => json({ code: 0, type: 'object', data: { aiText: 'OK' } });
  for (const [op, responses, operation, code] of [
    ['models', [], 'Load model catalog', 17],
    ['chat', [], 'Read school session', '23'],
    ['chat', [list([previous]), switchCatalog()], 'Update school session', -9]
  ]) {
    const rejected = await run(op, [...responses, json({ code, msg: { token: 'synthetic-school-token' },
      message: ['private error details'], data: { request: 'private response body', token: 'synthetic-school-token' } })]);
    assert.equal(rejected.error, `${operation}: The school API rejected the request (school code ${code})`);
    assert.ok(!JSON.stringify(rejected.events).includes('private'), 'error objects and response bodies must not be exposed');
  }
  const namedError = await run('chat', [list([previous]), switchCatalog(), json({ code: 23, msg: 'Model update denied' })]);
  assert.equal(namedError.error, 'Update school session: Model update denied', 'preserve the server message with an operation prefix');
  const httpError = await run('models', [json({ code: '403', msg: {}, data: 'private response body' }, 403)]);
  assert.equal(httpError.error, 'Load model catalog: HTTP 403 (school code 403)');
  const httpWithoutCode = await run('chat', [json({ data: 'private response body' }, 503)]);
  assert.equal(httpWithoutCode.error, 'Read school session: The school service is temporarily unavailable (HTTP 503). Try again later; no automatic retry was made.');
  const nonnumericCode = await run('models', [json({ code: 'synthetic-school-token', message: {} })]);
  assert.equal(nonnumericCode.error, 'Load model catalog: The school API rejected the request', 'do not expose unknown code values');
  const invalidJSON = await run('models', [new Response('private response body', { status: 502 })]);
  assert.equal(invalidJSON.error, 'Load model catalog: The school service is temporarily unavailable (HTTP 502). Try again later; no automatic retry was made.');
  for (const code of [0, '0']) {
    const switched = await run('chat', [list([previous]), switchCatalog(), json({ code }), list([updated]), reply()]);
    assert.equal(switched.error, undefined);
    assert.deepEqual(switched.calls.map(x => new URL(x.url).pathname), ['/jmapi/api/chat/session', '/jmapi/api/chat/config',
      '/jmapi/api/chat/saveSession', '/jmapi/api/chat/session', '/jmapi/api/chat/completions']);
    assert.equal(switched.calls[2].method, 'POST');
    assert.equal(switched.calls[2].headers['Content-Type'], 'application/json');
    assert.deepEqual(switched.calls[2].body, { ...previous, model, lang: 'en' }, 'preserve every unrelated session field');
    assert.equal(switched.calls[4].body.sessionId, session.id);
    assert.equal(switched.calls[4].body.responseId, null);
    assert.equal(switched.events.find(x => x.kind === 'lifecycle').result.model, model, 'report the verified session model');
    assert.ok(!JSON.stringify(switched.events).includes('Synthetic session instruction'), 'session configuration stays in the page');
  }
  const opaqueID = 'synthetic-session-id';
  const stringID = await run('chat', [list([{ ...previous, id: opaqueID }]),
    json({ code: 0, data: { models: [model] } }), json({ code: 0 }), list([{ ...updated, id: opaqueID }]), reply()]);
  assert.equal(stringID.error, undefined);
  assert.equal(stringID.calls.at(-1).body.sessionId, opaqueID);
  for (const [before, after] of [[42, '42'], ['42', 42]]) {
    const switched = await run('chat', [list([{ ...previous, id: before }]), switchCatalog(), json({ code: 0 }), list([{ ...updated, id: after }]), reply()]);
    assert.equal(switched.error, undefined);
    assert.equal(switched.calls[2].body.id, before);
    assert.equal(switched.calls.at(-1).body.sessionId, after);
  }
  for (const invalid of [[], [{ ...updated, id: 43 }], [{ ...updated, id: '042' }], [{ ...updated, name: 'Renamed session' }],
    [{ ...updated, model: previous.model }], [{ ...updated, contextCount: 1 }], [updated, updated]]) {
    const rejected = await run('chat', [list([previous]), switchCatalog(), json({ code: 0 }), list(invalid)]);
    assert.ok(rejected.error, 'reject a changed or ambiguous session after saving');
    assert.ok(!rejected.error.includes('No session was changed'), 'an accepted update may remain after failed verification');
    assert.equal(rejected.calls.length, 4, 'failed verification must not complete, retry or roll back');
    assert.equal(rejected.calls.filter(x => x.url.endsWith('/api/chat/saveSession')).length, 1);
  }
  for (const body of [null, {}, { code: 0, data: null }, { code: 0, data: { models: {} } },
    { code: 0, data: { models: [{ value: 'unknown-model' }] } }]) {
    const rejected = await run('chat', [list([previous]), json(body)]);
    assert.ok(rejected.error);
    assert.equal(rejected.calls.length, 2, 'unknown models and malformed catalogs must not mutate the session');
  }
  const unsafeSwitch = await run('chat', [list([{ ...previous, contextCount: 1 }])]);
  assert.match(unsafeSwitch.error, /Context Count/);
  assert.equal(unsafeSwitch.calls.length, 1);
  for (const response of [json({ code: 23, msg: 'update rejected' }), json({ code: 429, msg: 'rate limited' }, 429),
    json({ code: 0 }, 429), json(null), json({}), json([]), json('invalid'), new Response('invalid JSON')]) {
    const rejected = await run('chat', [list([previous]), switchCatalog(), response]);
    assert.ok(rejected.error);
    assert.equal(rejected.calls.length, 3, 'failed updates must not be retried, verified or completed');
  }
  for (const cancelAt of ['catalog', 'save']) {
    const responses = [list([previous]), switchCatalog()];
    if (cancelAt === 'save') responses.push(json({ code: 0 }));
    const cancelled = await run('chat', responses, payload, cancelAt);
    assert.ok(cancelled.error);
    assert.equal(cancelled.calls.length, cancelAt === 'catalog' ? 2 : 3, 'cancellation must stop following requests without rollback');
  }
  const cancelledSave = await run('chat', [list([previous]), switchCatalog(), ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('save cancelled')), { once: true });
  })], payload, 'save');
  assert.equal(cancelledSave.error, 'The school request was cancelled.');
  assert.equal(cancelledSave.calls.length, 3);
  const missing = await run('chat', [], { model, text: 'test' });
  assert.ok(missing.error.includes('dedicated'));
  const rateLimit = await run('chat', [list(), json({ code: 429, msg: 'rate limited' }, 429)]);
  assert.equal(rateLimit.error, 'Generate response: rate limited');
  assert.equal(rateLimit.calls.length, 2, '429 must not be retried');
  const schoolRejection = { code: 10008, msg: { token: 'synthetic-school-token' },
    message: ['private error details'], data: { request: 'private prompt content' } };
  for (const response of [json(schoolRejection), sse(`data: ${JSON.stringify(schoolRejection)}\n\n`)]) {
    const rejected = await run('chat', [list(), response]);
    assert.equal(rejected.error, 'Generate response: The school API rejected the request (school code 10008)');
    assert.equal(rejected.calls.length, 2, 'rejected completions must not be retried');
    assert.equal(rejected.events.filter(event => event.kind === 'event').length, 0, 'rejected bodies must not be forwarded');
    assert.ok(!JSON.stringify(rejected.events).includes('private'), 'error details and prompt content must not be exposed');
  }
  const failed = await run('chat', [list(), sse('data: {"code":23,"msg":"upstream failed"}\n\n')]);
  assert.equal(failed.error, 'Generate response: upstream failed');
  const malformed = await run('chat', [list(), sse('data: not-json\n\n')]);
  assert.ok(malformed.error.includes('invalid SSE'));
  const trailing = await run('chat', [list(), sse('data: {"type":"string","data":"final"}')]);
  assert.equal(trailing.events.find(x => x.event), undefined, 'unterminated data must not be emitted');
  assert.match(trailing.error, /incomplete SSE event/);
  for (const ending of ['\n\n', '\r\n\r\n', '\r\r']) {
    const clean = await run('chat', [list(), sse('data: {"type":"string","data":"complete"}' + ending)]);
    assert.equal(clean.error, undefined, 'the school permits clean EOF without a sentinel');
    assert.equal(clean.events.find(x => x.event)?.event.data, 'complete');
  }
  for (const tail of ['data: {"type":"string","data":"unfinished"}', 'data: {"type":"string","data":"unfinished"}\n', 'data: {"type":']) {
    const truncated = await run('chat', [list(), sse('data: {"type":"string","data":"partial"}\n\n' + tail)]);
    assert.equal(truncated.events.find(x => x.event)?.event.data, 'partial');
    assert.match(truncated.error, /incomplete SSE event/);
    assert.equal(truncated.events.filter(x => x.kind === 'event').length, 1);
  }
  for (const ending of ['data: [DONE]', 'data: [DONE]\n']) {
    const explicit = await run('chat', [list(), sse('data: {"type":"string","data":"complete"}\n\n' + ending)]);
    assert.equal(explicit.error, undefined, 'an explicit marker also confirms EOF without a trailing separator');
  }
  for (const tail of [': heartbeat', 'id: next-record', 'event: message']) {
    const metadata = await run('chat', [list(), sse('data: {"type":"string","data":"complete"}\n\n' + tail)]);
    assert.equal(metadata.error, undefined, 'trailing control lines without data do not form an incomplete message');
    assert.equal(metadata.events.filter(x => x.kind === 'event').length, 1);
  }
  const lateError = await run('chat', [list(), sse('data: {"type":"string","data":"partial"}\n\ndata: {"code":23,"msg":"upstream failed"}\n\n')]);
  assert.equal(lateError.error, 'Generate response: upstream failed');
  const readFailure = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"string","data":"partial"}\n\n'));
  }, pull(controller) { controller.error(new Error('Synthetic stream read failure')); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const interrupted = await run('chat', [list(), readFailure]);
  assert.equal(interrupted.error, 'The school response stream could not be read; the response may be incomplete.');
  assert.equal(interrupted.events.at(-1).code, 'school_stream_error');
  assert.equal(interrupted.events.at(-1).stage, 'stream');
  assert.equal(interrupted.events.at(-1).http_status, 200);
  // One large value and empty data lines exercise the cap without millions of stream chunks.
  const limit = 1024 * 1024;
  const largeText = 'x'.repeat(limit - 2 - JSON.stringify({ type: 'string', data: '' }).length);
  const largeFrame = JSON.stringify({ type: 'string', data: largeText });
  assert.equal(largeFrame.length, limit - 2);
  const boundedSSE = wire => new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } });
  const atLimit = await run('chat', [list(), boundedSSE(`data: ${largeFrame}\ndata:\n\ndata: [DONE]\n\n`)]);
  assert.equal(atLimit.error, undefined);
  assert.equal(atLimit.events.find(x => x.event)?.event.data.length, largeText.length);
  const overLimit = await run('chat', [list(), boundedSSE(`data: ${largeFrame}\ndata:\ndata:\n\ndata: [DONE]\n\n`)]);
  assert.match(overLimit.error, /exceeded the size limit/);
  assert.equal(overLimit.events.filter(x => x.kind === 'event').length, 0);
  const fallback = await run('chat', [list(), json({ code: 0, type: 'object', data: { aiText: 'OK' } })]);
  assert.equal(fallback.error, undefined);
  const catalog = (multimodal = true) => json({ code: 0, data: { models: [{ value: model, multimodal }] } });
  const imageBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const image = { mime: 'image/png', name: 'sample.png', data: imageBytes.toString('base64') };
  const imagePayload = { ...payload, images: [image] };
  const imageReply = () => json({ code: 0, type: 'object', data: { aiText: 'image result' } });
  const switchedImage = await run('chat', [catalog(), list([previous]), json({ code: 0 }), list([updated]),
    json({ code: 0, data: { url: 'https://images.example.test/switched.png' } }), imageReply()], imagePayload);
  assert.equal(switchedImage.error, undefined);
  assert.deepEqual(switchedImage.calls.map(x => new URL(x.url).pathname), ['/jmapi/api/chat/config', '/jmapi/api/chat/session',
    '/jmapi/api/chat/saveSession', '/jmapi/api/chat/session', '/jmapi/api/common/upload', '/jmapi/api/chat/completions']);
  assert.equal(switchedImage.calls.filter(x => x.url.includes('/api/chat/config')).length, 1, 'reuse the image model catalog');
  assert.deepEqual(switchedImage.calls[2].body, { ...previous, model, lang: 'en' });
  const rejectedImageSwitch = await run('chat', [catalog(), list([previous]), json({ code: 0 }), list([previous])], imagePayload);
  assert.ok(rejectedImageSwitch.error);
  assert.equal(rejectedImageSwitch.calls.length, 4, 'image upload must wait for successful switch verification');
  const cancelledImageSwitch = await run('chat', [catalog(), list([previous]), json({ code: 0 })], imagePayload, 'save');
  assert.ok(cancelledImageSwitch.error);
  assert.equal(cancelledImageSwitch.calls.length, 3, 'cancelled updates must not upload images');
  for (const field of ['url', 'file_url']) {
    const result = await run('chat', [catalog(), list(), json({ code: 0, data: { [field]: 'https://images.example.test/upload.png', private: 'synthetic-school-token' } }), imageReply()], imagePayload);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.calls.map(x => new URL(x.url).pathname), ['/jmapi/api/chat/config', '/jmapi/api/chat/session', '/jmapi/api/common/upload', '/jmapi/api/chat/completions']);
    const upload = result.calls[2];
    assert.equal(upload.method, 'POST');
    assert.equal(upload.headers['Content-Type'], undefined, 'fetch must supply the multipart boundary');
    assert.deepEqual([...upload.body.keys()], ['accept', 'file', 'lang']);
    assert.equal(upload.body.get('accept'), 'image');
    assert.equal(upload.body.get('lang'), 'en');
    assert.equal(upload.body.get('file').name, image.name);
    assert.equal(upload.body.get('file').type, image.mime);
    assert.deepEqual(Buffer.from(await upload.body.get('file').arrayBuffer()), imageBytes);
    assert.deepEqual(result.calls[3].body.files, ['https://images.example.test/upload.png']);
    assert.ok(!JSON.stringify(result.events).includes('upload.png'), 'upload metadata stays within the school page');
  }
  const imageFormats = [image,
    { mime: 'image/jpeg', name: 'sample.jpg', data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') },
    { mime: 'image/gif', name: 'sample.gif', data: Buffer.from('GIF89a').toString('base64') },
    { mime: 'image/webp', name: 'sample.webp', data: Buffer.from('RIFFxxxxWEBP').toString('base64') }
  ];
  for (const [index, format] of imageFormats.entries()) {
    const url = `https://images.example.test/${index}`;
    const single = await run('chat', [catalog(1), list(), json({ code: 0, data: { url } }), imageReply()], { ...payload, images: [format] });
    assert.equal(single.error, undefined);
    assert.deepEqual(single.calls.at(-1).body.files, [url], 'legacy uploads one supported image');
  }
  const rejectedUpload = await run('chat', [catalog(), list(), json({ ...schoolRejection, code: '10008' })], imagePayload);
  assert.equal(rejectedUpload.error, `Upload image 1/1 (${JSON.stringify(image.name)}): The school API rejected the request (school code 10008)`);
  assert.equal(rejectedUpload.events.at(-1).code, 'attachment_upload_failed');
  assert.equal(rejectedUpload.events.at(-1).attachment_index, 0);
  assert.equal(rejectedUpload.calls.length, 3, 'rejected uploads must not be retried or followed by completion');
  assert.equal(rejectedUpload.events.filter(event => event.kind === 'event').length, 0, 'rejected upload bodies must not be forwarded');
  assert.ok(!JSON.stringify(rejectedUpload.events).includes('private'), 'upload error details and prompt content must not be exposed');
  const unsupported = await run('chat', [catalog(false)], imagePayload);
  assert.match(unsupported.error, /does not advertise image support/);
  assert.match(unsupported.error, /conversation history/);
  assert.equal(unsupported.events.at(-1).code, 'unsupported_image_model');
  assert.equal(unsupported.calls.length, 1);
  const unsafeImageSession = await run('chat', [catalog(), list([{ ...session, contextCount: 1 }])], imagePayload);
  assert.match(unsafeImageSession.error, /Context Count 0/);
  assert.equal(unsafeImageSession.calls.length, 2, 'do not upload before the session check');
  for (const response of [json({ code: 429, msg: 'upload rate limited' }, 429), json({ code: 0, data: {} }), json({ code: 0, data: { url: 'javascript:bad' } })]) {
    const failedUpload = await run('chat', [catalog(), list(), response], imagePayload);
    assert.ok(failedUpload.error);
    assert.equal(failedUpload.events.at(-1).code, 'attachment_upload_failed');
    assert.equal(failedUpload.events.at(-1).attachment_index, 0);
    assert.equal(failedUpload.calls.length, 3, 'failed uploads are never retried and no completion is sent');
  }
  const abortedUpload = await run('chat', [catalog(), list(), ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('upload cancelled')), { once: true });
  })], imagePayload, 'upload');
  assert.equal(abortedUpload.error, 'The school request was cancelled.');
  assert.equal(abortedUpload.events.at(-1).code, undefined);
  assert.equal(abortedUpload.events.at(-1).attachment_index, undefined);
  assert.equal(abortedUpload.calls.length, 3);
  const large = Buffer.alloc(9 * 1024 * 1024); imageBytes.copy(large);
  for (const images of [null, [image, image, image, image, image], [{ ...image, mime: 'image/svg+xml' }], [{ ...image, data: '!!!!' }], [{ ...image, data: Buffer.from('not a PNG').toString('base64') }], [{ ...image, data: 'A'.repeat(Math.ceil(10 * 1024 * 1024 / 3) * 4 + 4) }], [{ ...image, data: large.toString('base64') }, { ...image, data: large.toString('base64') }]]) {
    const invalid = await run('chat', [], { ...payload, images });
    assert.ok(invalid.error);
    assert.equal(invalid.calls.length, 0, 'invalid images must fail before school requests');
  }
  console.log('page checks passed: recoverable setup, verified model switching, session guards, chunked SSE, JSON, image upload, cancellation, no retry, token containment');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
