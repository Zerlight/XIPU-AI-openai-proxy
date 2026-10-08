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
async function run(op, responses, body = payload, cancel = false) {
  const events = [], calls = [];
  let listener, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const window = {
    postMessage(event) { events.push(event); if (event.kind === 'done') finish(); },
    addEventListener(type, callback) { assert.equal(type, 'message'); listener = callback; },
    async fetch(url, options) {
      calls.push({ url, ...options, body: options.body instanceof FormData ? options.body : options.body && JSON.parse(options.body) });
      assert.equal(options.headers['Jm-Token'], 'synthetic-school-token');
      assert.equal(options.credentials, 'include');
      const next = responses.shift();
      assert.ok(next, 'unexpected school request');
      const cancelPath = { upload: '/api/common/upload', catalog: '/api/chat/config?lang=en', save: '/api/chat/saveSession' }[cancel];
      if (cancelPath && url.endsWith(cancelPath)) queueMicrotask(() => {
        listener({ source: window, data: { source: 'xipu-bridge', type: 'cancel', job: 'test-job' } });
      });
      return typeof next === 'function' ? next(options) : next;
    }
  };
  vm.runInNewContext(source, {
    window, location: { origin: 'https://xipuai-xjtlu-edu-cn-s.xjtlu.edu.cn' },
    TextDecoder, AbortController, FormData, File, atob, btoa,
    document: { querySelector: () => ({ __vue_app__: { config: { globalProperties: {
      $pinia: { state: { value: { user: { token: 'synthetic-school-token' } } } }
    }}}}) },
    localStorage: { getItem: () => 'en' }
  });
  const message = { source: 'xipu-bridge', type: 'req', job: 'test-job', op, payload: body };
  listener({ source: {}, data: message });
  assert.equal(calls.length, 0, 'cross-window requests must be ignored');
  listener({ source: window, origin: 'https://xipuai.xjtlu.edu.cn', data: message });
  if (cancel === true) listener({ source: window, data: { ...message, type: 'cancel' } });
  await done;
  assert.equal(responses.length, 0);
  assert.ok(!JSON.stringify(events).includes('synthetic-school-token'), 'school token leaked');
  return { events, calls, error: events.at(-1).message };
}
async function main() {
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
  assert.equal(cancelled.error, 'cancelled');
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
  assert.equal(httpWithoutCode.error, 'Read school session: HTTP 503');
  const nonnumericCode = await run('models', [json({ code: 'synthetic-school-token', message: {} })]);
  assert.equal(nonnumericCode.error, 'Load model catalog: The school API rejected the request', 'do not expose unknown code values');
  const invalidJSON = await run('models', [new Response('private response body', { status: 502 })]);
  assert.equal(invalidJSON.error, 'Load model catalog: The school API returned invalid JSON (HTTP 502). Check the logged-in tab.');
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
  for (const invalid of [[], [{ ...updated, id: 43 }], [{ ...updated, id: '42' }], [{ ...updated, name: 'Renamed session' }],
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
  assert.equal(cancelledSave.error, 'save cancelled');
  assert.equal(cancelledSave.calls.length, 3);
  const missing = await run('chat', [], { model, text: 'test' });
  assert.ok(missing.error.includes('dedicated'));
  const rateLimit = await run('chat', [list(), json({ code: 429, msg: 'rate limited' }, 429)]);
  assert.equal(rateLimit.error, 'rate limited');
  assert.equal(rateLimit.calls.length, 2, '429 must not be retried');
  const failed = await run('chat', [list(), sse('data: {"code":23,"msg":"upstream failed"}\n\n')]);
  assert.equal(failed.error, 'upstream failed');
  const malformed = await run('chat', [list(), sse('data: not-json\n\n')]);
  assert.ok(malformed.error.includes('invalid SSE'));
  const trailing = await run('chat', [list(), sse('data: {"type":"string","data":"final"}')]);
  assert.equal(trailing.events.find(x => x.event)?.event.data, 'final');
  assert.match(trailing.error, /ended before its completion marker/);
  const truncated = await run('chat', [list(), sse('data: {"type":"string","data":"partial"}\n\n')]);
  assert.equal(truncated.events.find(x => x.event)?.event.data, 'partial');
  assert.match(truncated.error, /ended before its completion marker/);
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
  const fourImages = [image,
    { mime: 'image/jpeg', name: 'sample.jpg', data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') },
    { mime: 'image/gif', name: 'sample.gif', data: Buffer.from('GIF89a').toString('base64') },
    { mime: 'image/webp', name: 'sample.webp', data: Buffer.from('RIFFxxxxWEBP').toString('base64') }
  ];
  const uploadedURLs = fourImages.map((item, index) => `https://images.example.test/${index}`);
  const multiple = await run('chat', [catalog(1), list(), ...uploadedURLs.map(url => json({ code: 0, data: { url } })), imageReply()], { ...payload, images: fourImages });
  assert.equal(multiple.error, undefined);
  assert.deepEqual(multiple.calls.at(-1).body.files, uploadedURLs, 'preserve image order across sequential uploads');
  const failedSecondUpload = await run('chat', [catalog(), list(), json({ code: 0, data: { url: uploadedURLs[0] } }), json({ code: 429, msg: 'second upload rate limited' }, 429)], { ...payload, images: fourImages });
  assert.equal(failedSecondUpload.error, 'second upload rate limited');
  assert.equal(failedSecondUpload.calls.length, 4, 'stop on first failed upload without guessing a remote cleanup endpoint');
  const unsupported = await run('chat', [catalog(false)], imagePayload);
  assert.match(unsupported.error, /does not advertise image support/);
  assert.equal(unsupported.calls.length, 1);
  const unsafeImageSession = await run('chat', [catalog(), list([{ ...session, contextCount: 1 }])], imagePayload);
  assert.match(unsafeImageSession.error, /Context Count 0/);
  assert.equal(unsafeImageSession.calls.length, 2, 'do not upload before the session check');
  for (const response of [json({ code: 429, msg: 'upload rate limited' }, 429), json({ code: 0, data: {} }), json({ code: 0, data: { url: 'javascript:bad' } })]) {
    const failedUpload = await run('chat', [catalog(), list(), response], imagePayload);
    assert.ok(failedUpload.error);
    assert.equal(failedUpload.calls.length, 3, 'failed uploads are never retried and no completion is sent');
  }
  const abortedUpload = await run('chat', [catalog(), list(), ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('upload cancelled')), { once: true });
  })], imagePayload, 'upload');
  assert.equal(abortedUpload.error, 'upload cancelled');
  assert.equal(abortedUpload.calls.length, 3);
  const large = Buffer.alloc(9 * 1024 * 1024); imageBytes.copy(large);
  for (const images of [null, [image, image, image, image, image], [{ ...image, mime: 'image/svg+xml' }], [{ ...image, data: '!!!!' }], [{ ...image, data: Buffer.from('not a PNG').toString('base64') }], [{ ...image, data: 'A'.repeat(Math.ceil(10 * 1024 * 1024 / 3) * 4 + 4) }], [{ ...image, data: large.toString('base64') }, { ...image, data: large.toString('base64') }]]) {
    const invalid = await run('chat', [], { ...payload, images });
    assert.ok(invalid.error);
    assert.equal(invalid.calls.length, 0, 'invalid images must fail before school requests');
  }
  console.log('page checks passed: verified model switching, session guards, chunked SSE, JSON, image upload, cancellation, no retry, token containment');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
