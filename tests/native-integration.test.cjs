// Run the real Go process through all three extension worlds with a synthetic school API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { deflateSync, crc32 } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xipu-integration-'));
const extensionID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const schoolOrigin = 'https://xipuai-xjtlu-edu-cn-s.xjtlu.edu.cn';
const token = 'synthetic-school-token';
const model = 'synthetic-paid-model';
const secondModel = 'synthetic-second-model';
const textOnlyModel = 'synthetic-text-only-model';
const session = { id: 8, name: 'Synthetic dedicated session', model, contextCount: 0, temperature: 0.3, prompt: '', plugins: [] };
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); } });
const pair = () => {
  const a = { onMessage: event(), onDisconnect: event() }, b = { onMessage: event(), onDisconnect: event() };
  a.postMessage = message => queueMicrotask(() => b.onMessage.emit(message));
  b.postMessage = message => queueMicrotask(() => a.onMessage.emit(message));
  a.disconnect = b.disconnect = () => { a.onDisconnect.emit(); b.onDisconnect.emit(); };
  return [a, b];
};
// A deterministic, valid PNG large enough to cross the native frame boundary.
function imageFixture() {
  const width = 768, height = 512;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  let seed = 123456789;
  for (let row = 0; row < height; row++) {
    for (let column = 1; column <= width * 3; column++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      pixels[row * (1 + width * 3) + column] = seed & 255;
    }
  }
  function chunk(type, data) {
    const label = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
    return Buffer.concat([length, label, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
async function main(modern = false) {
  const chatPath = modern ? '/chat' : '/v3/chat';
  const catalogPath = modern ? '/api/v2/chat/configV3' : '/api/chat/config';
  const completionPath = modern ? '/api/v2/chat/response' : '/api/chat/completions';
  const attachmentField = modern ? 'attachments' : 'files';
  const binary = path.join(directory, process.platform === 'win32' ? 'bridge.exe' : 'bridge');
  execFileSync('go', ['build', '-o', binary, './cmd/xipu-bridge'], { cwd: root, stdio: 'pipe' });
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ session_name: session.name, port, allowed_origins: ['chrome-extension://' + extensionID + '/'] }));
  fs.writeFileSync(path.join(directory, 'api-key.txt'), 'synthetic-local-client-key-for-tests-only\n', { mode: 0o600 });
  const child = spawn(binary, ['chrome-extension://' + extensionID + '/'], { env: { ...process.env, XIPU_BRIDGE_CONFIG_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  const deadline = setTimeout(() => child.kill(), 60000);
  let nativeChunks = 0;
  let errorOutput = '', bytes = Buffer.alloc(0), ready, resolveReady, rejectReady;
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child.stderr.on('data', chunk => { errorOutput += chunk; });
  child.on('error', rejectReady);
  child.on('exit', code => { if (!ready) rejectReady(new Error('Host exited before ready: ' + code + ' ' + errorOutput)); });
  const native = { onMessage: event(), onDisconnect: event(), postMessage(message) {
    const body = Buffer.from(JSON.stringify(message));
    assert.ok(!body.includes(token), 'school token reached the native host');
    const length = Buffer.alloc(4); length.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([length, body]));
  }};
  child.stdout.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE()) {
      const size = bytes.readUInt32LE();
      assert.ok(size <= 1024 * 1024);
      const message = JSON.parse(bytes.subarray(4, 4 + size));
      if (message.type === 'req_chunk') nativeChunks++;
      bytes = bytes.subarray(4 + size);
      if (message.type === 'ready') { ready = message; resolveReady(message); }
      native.onMessage.emit(message);
    }
  });
  const chrome = {
    runtime: { id: extensionID, getURL: file => 'chrome-extension://' + extensionID + '/' + file,
      onConnect: event(), onMessage: event(), onStartup: event(), onInstalled: event(), connectNative: () => native },
    storage: { local: { get: async () => ({}), set() {}, remove() {}, setAccessLevel() {} } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8'), { chrome, URL, atob, btoa, TextDecoder, Uint8Array, setTimeout, clearTimeout });
  const ui = message => new Promise(resolve => chrome.runtime.onMessage.emit(message, { id: extensionID, url: chrome.runtime.getURL('options.html') }, resolve));
  const [background, content] = pair();
  Object.assign(background, { name: 'xipu', sender: { id: extensionID, frameId: 0, url: schoolOrigin + chatPath } });
  chrome.runtime.onConnect.emit(background);
  const listeners = [], calls = [], pageRequests = [];
  let uploadFails = false, failUploadNumber = 0, ignoreModelSave = false;
  let schoolOverride;
  let schoolSession = { ...session };
  let setupSession;
  let setupCreatedAt;
  const uploadedURL = 'https://tosai.xjtlu.edu.cn/synthetic-image.png';
  const png = imageFixture();
  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
  const textFile = Buffer.from('Item,Quantity\nBlue,7\nRed,9\n');
  const fileURLs = {
    'image/png': uploadedURL,
    'application/pdf': 'https://tosai.xjtlu.edu.cn/synthetic-file.pdf',
    'text/plain': 'https://tosai.xjtlu.edu.cn/synthetic-file.txt'
  };
  const models = [{ value: model, label: 'Synthetic model', multimodal: true }, { value: secondModel, label: 'Second model', multimodal: true }, { value: textOnlyModel, label: 'Text-only model', multimodal: false }];
  const window = {
    addEventListener(type, fn) { assert.equal(type, 'message'); listeners.push(fn); },
    postMessage(data) {
      if (data.type === 'req' && data.op === 'chat') pageRequests.push(JSON.parse(JSON.stringify(data.payload)));
      queueMicrotask(() => listeners.forEach(fn => fn({ source: window, origin: 'https://xipuai.xjtlu.edu.cn', data })));
    },
    async fetch(url, options) {
      assert.equal(options.headers['Jm-Token'], token);
      assert.equal(options.headers['x-lang'], modern ? 'en' : undefined);
      assert.equal(options.headers['x-platform'], modern ? 'web' : undefined);
      if (url.endsWith('/api/common/upload')) {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['Content-Type'], undefined);
        assert.ok(options.body instanceof FormData);
        assert.equal(options.body.get('accept'), modern ? null : 'image');
        assert.equal(options.body.get('lang'), 'en');
        const file = options.body.get('file');
        const expected = { 'image/png': png, 'application/pdf': pdf, 'text/plain': textFile }[file.type];
        assert.ok(expected, 'unexpected attachment type');
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), expected);
        if (file.type !== 'image/png') {
          assert.ok(modern, 'legacy frontend uploaded a document');
          assert.equal(file.name, file.type === 'application/pdf' ? 'sample.pdf' : 'sample.txt');
        }
        calls.push({ url, fileSize: file.size, fileType: file.type, fileName: file.name });
        const failed = uploadFails || calls.filter(call => call.url.endsWith('/api/common/upload')).length === failUploadNumber;
        return new Response(JSON.stringify(failed ? { code: 429, msg: 'Synthetic upload rate limit' } : { code: 0, data: { [modern ? 'file_url' : 'url']: fileURLs[file.type] } }), { status: failed ? 429 : 200 });
      }
      calls.push({ url, body: options.body && JSON.parse(options.body) });
      if (schoolOverride && url.includes(schoolOverride.path)) {
        return new Response(schoolOverride.body, { status: schoolOverride.status || 200, headers: { 'Content-Type': schoolOverride.contentType || 'application/json' } });
      }
      if (url.includes(catalogPath + '?')) return new Response(JSON.stringify({ code: 0, data: modern ? { model: { chat: { list: models } } } : { models } }));
      if (url.includes('/api/chat/session?')) return new Response(JSON.stringify({ code: 0, data: [schoolSession, ...(setupSession ? [setupSession] : [])] }));
      if (url.endsWith('/api/chat/saveSession')) {
        const body = calls.at(-1).body;
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['Content-Type'], 'application/json');
        if (body.id === undefined) {
          assert.deepEqual(body, { name: 'New dedicated session', lang: 'en' });
          assert.equal(setupSession, undefined, 'setup must not create duplicate conversations');
          setupSession = { id: '9', name: body.name, model: 'school-default', contextCount: 5, prompt: 'Default school prompt', temperature: 0.4 };
          setupCreatedAt = performance.now();
          return new Response(JSON.stringify({ code: 0, data: { ...setupSession, id: 9 } }));
        }
        if (body.id === '9') {
          assert.ok(performance.now() - setupCreatedAt >= 2900, 'configuration must leave a gap after creation');
          assert.deepEqual(body, { ...setupSession, model, contextCount: 0, prompt: '', lang: 'en' });
          setupSession = { ...setupSession, model, contextCount: 0, prompt: '' };
          return new Response(JSON.stringify({ code: 0 }));
        }
        assert.ok([model, secondModel, textOnlyModel].includes(body.model));
        assert.deepEqual(body, { ...schoolSession, model: body.model, lang: 'en' });
        if (!ignoreModelSave) schoolSession = { ...schoolSession, model: body.model };
        return new Response(JSON.stringify({ code: 0 }));
      }
      assert.ok(url.endsWith(completionPath));
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(Object.keys(calls.at(-1).body).sort(), modern
        ? ['attachments', 'intent', 'online', 'options', 'responseId', 'sessionId', 'text', 'thinking']
        : ['files', 'lang', 'online', 'responseId', 'sessionId', 'text', 'thinking']);
      assert.equal(calls.at(-1).body.sessionId, session.id);
      assert.equal(calls.at(-1).body.responseId, null);
      if (modern) {
        assert.equal(calls.at(-1).body.intent, 'chat');
        assert.equal(calls.at(-1).body.options, null);
      } else assert.equal(calls.at(-1).body.lang, 'en');
      const prompt = calls.at(-1).body.text;
      const cleanEOF = prompt.includes('CLEAN_EOF');
      let answer = 'INTEGRATION_OK';
      if (prompt.startsWith('ROUTE_CASE')) {
        answer = 'ROUTED:' + schoolSession.model;
      } else if (prompt.includes('IMAGE_CASE')) {
        assert.deepEqual(calls.at(-1).body[attachmentField], [uploadedURL]);
        answer = 'IMAGE_OK';
      } else if (prompt.includes('FILE_CASE')) {
        answer = 'FILE_OK';
      } else if (prompt.includes('TOOL_SECOND')) {
        assert.ok(prompt.includes('14'));
        answer = JSON.stringify({ content: 'TOOL_SECOND_OK', tool_calls: [] });
      } else if (prompt.includes('TOOL_FIRST')) {
        answer = JSON.stringify({ content: null, tool_calls: [{ name: 'double', arguments: { value: 7 } }] });
      } else if (prompt.includes('SCHEMA_VALID')) {
        answer = '{"answer":42}';
      } else if (prompt.includes('SCHEMA_INVALID')) {
        answer = '{"answer":"wrong"}';
      }
      if (answer !== 'INTEGRATION_OK') return new Response(`data: ${JSON.stringify({ type: 'string', data: answer })}\n\n${cleanEOF ? '' : 'data: [DONE]\n\n'}`, { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('data: {"type":"string","reasoning_data":"reason"}\r\n\r\ndata: {"type":"string","data":"INTEGRATION_OK"}\r\n\r\n' + (cleanEOF ? '' : 'data: [DONE]\r\n\r\n'), { headers: { 'Content-Type': 'text/event-stream' } });
    }
  };
  const shared = { window, location: { origin: schoolOrigin, pathname: chatPath }, URL, TextDecoder, AbortController, atob, Blob, File, FormData, Uint8Array };
  const stores = modern ? { [btoa('__XP_JM_USER__')]: { data: { token } } } : { user: { token } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension/page.js'), 'utf8'), { ...shared,
    document: { querySelector: () => ({ __vue_app__: { config: { globalProperties: { $pinia: { state: { value: stores } } } } } }) },
    btoa, localStorage: { getItem: () => 'en' }
  });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension/bridge.js'), 'utf8'), { ...shared, chrome: { runtime: { id: extensionID, connect: () => content } }, setTimeout });
  try {
    const { base_url, api_key } = await readyPromise;
    const headers = { Authorization: 'Bearer ' + api_key, 'Content-Type': 'application/json' };
    const settings = await ui({ type: 'getSettings' });
    assert.equal(settings.ok, true);
    assert.equal(settings.config.session_name, session.name);
    assert.equal(settings.config.omit_historical_images, false);
    const inspected = await ui({ type: 'inspectSchool' });
    assert.equal(inspected.models[0].id, model);
    assert.equal(inspected.sessions[0].contextCount, 0);
    const originalConfig = settings.config;
    const setupResult = await ui({ type: 'setupSchool', name: 'New dedicated session', model });
    assert.equal(setupResult.ok, true, setupResult.error);
    assert.equal(setupResult.setupProgress.phase, 'complete');
    assert.equal(setupResult.config.session_name, setupSession.name);
    assert.equal(setupResult.config.port, originalConfig.port);
    assert.equal(setupResult.setupProgress.session_id, '9');
    assert.deepEqual(setupSession, { id: '9', name: 'New dedicated session', model, contextCount: 0, prompt: '', temperature: 0.4 });
    assert.equal(calls.filter(call => call.url.endsWith(completionPath)).length, 0, 'setup must not generate');
    const setupCallCount = calls.length;
    assert.equal((await ui({ type: 'setupSchool', name: 'New dedicated session', model })).ok, true);
    assert.equal(calls.length, setupCallCount, 'completed setup must not issue new school mutations');
    assert.equal((await ui({ type: 'saveSettings', config: originalConfig })).ok, true);
    assert.equal((await fetch(base_url + '/models')).status, 401);
    const catalog = await fetch(base_url + '/models', { headers });
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).data[0].id, model);
    schoolOverride = { path: catalogPath, status: 429, body: JSON.stringify({ code: 429, msg: 'Synthetic rate limit' }) };
    const catalogBefore = calls.length;
    const limitedCatalog = await fetch(base_url + '/models', { headers });
    assert.equal(limitedCatalog.status, 429);
    const catalogError = (await limitedCatalog.json()).error;
    assert.equal(catalogError.code, 'school_rate_limited');
    assert.equal(catalogError.type, 'rate_limit_error');
    assert.equal(catalogError.stage, 'model_catalog');
    assert.deepEqual(catalogError.upstream, { http_status: 429, school_code: 429 });
    assert.equal(calls.length, catalogBefore + 1, 'catalog failure was retried');
    schoolOverride = undefined;
    const schoolUser = modern ? stores[btoa('__XP_JM_USER__')].data : stores.user;
    delete schoolUser.token;
    for (const endpoint of ['/chat/completions', '/responses']) for (const stream of [false, true]) {
      const before = calls.length;
      const request = { model, stream, ...(endpoint === '/responses' ? { input: 'Synthetic authentication check' } : { messages: [{ role: 'user', content: 'Synthetic authentication check' }] }) };
      const response = await fetch(base_url + endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
      assert.equal(response.status, 502);
      assert.match(response.headers.get('Content-Type'), /application\/json/);
      const error = (await response.json()).error;
      assert.equal(error.code, 'school_auth_required');
      assert.equal(error.stage, 'authentication');
      assert.equal(error.upstream, undefined);
      assert.equal(calls.length, before, 'missing school authentication caused a request');
    }
    schoolUser.token = token;
    for (const failure of [
      { path: completionPath, body: { code: 10008 }, code: 'school_rejected', status: 502, stage: 'generation', upstream: { http_status: 200, school_code: 10008 } },
      { path: completionPath, httpStatus: 503, body: { message: 'Synthetic unavailable service' }, code: 'school_http_error', status: 502, stage: 'generation', upstream: { http_status: 503 } },
      { path: '/api/chat/session?', body: { code: 0, data: [] }, code: 'school_session_not_found', status: 400, stage: 'session_read' },
      { path: '/api/chat/session?', body: { code: 0, data: [session, { ...session, id: 18 }] }, code: 'school_session_ambiguous', status: 400, stage: 'session_read' },
      { path: '/api/chat/session?', body: { code: 0, data: [{ ...session, contextCount: 5 }] }, code: 'school_session_unsafe', status: 400, stage: 'session_read' }
    ]) for (const endpoint of ['/chat/completions', '/responses']) for (const stream of [false, true]) {
      const before = calls.length;
      schoolOverride = { path: failure.path, body: JSON.stringify(failure.body), status: failure.httpStatus };
      const request = { model, stream, ...(endpoint === '/responses' ? { input: 'Synthetic error check' } : { messages: [{ role: 'user', content: 'Synthetic error check' }] }) };
      const response = await fetch(base_url + endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
      assert.equal(response.status, failure.status);
      assert.match(response.headers.get('Content-Type'), /application\/json/);
      const error = (await response.json()).error;
      assert.equal(error.code, failure.code);
      assert.equal(error.stage, failure.stage);
      if (failure.upstream) assert.deepEqual(error.upstream, failure.upstream);
      assert.ok(!JSON.stringify(error).includes(token), 'school credentials entered the HTTP error');
      assert.equal(calls.slice(before).filter(call => call.url.includes(failure.path)).length, 1, 'failed operation was retried');
      assert.equal(calls.slice(before).filter(call => call.url.endsWith(completionPath)).length, failure.stage === 'generation' ? 1 : 0, 'session rejection reached generation');
    }
    schoolOverride = undefined;
    // Compatibility fields must not change the school request.
    const probes = [
      ['/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }, 'max_tokens'],
      ['/responses', { model, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], max_output_tokens: 16 }, 'max_output_tokens'],
      ['/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 16, stream: true, stream_options: { include_usage: true } }, 'max_completion_tokens']
    ];
    for (const [endpoint, request, ignored] of probes) {
      const before = calls.filter(call => call.url.endsWith(completionPath)).length;
      const response = await fetch(base_url + endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('X-XIPU-Ignored-Parameters'), ignored);
      assert.match(response.headers.get('Access-Control-Expose-Headers'), /X-XIPU-Ignored-Parameters/);
      if (request.stream) {
        assert.equal(response.headers.get('X-XIPU-Usage'), 'unavailable');
        const text = await response.text();
        assert.ok(text.endsWith('data: [DONE]\n\n'));
        const frames = text.split('\n\n').filter(frame => frame.startsWith('data: {')).map(frame => JSON.parse(frame.slice(6)));
        assert.ok(frames.some(frame => frame.choices[0].delta.content === 'INTEGRATION_OK'));
        assert.ok(frames.every(frame => frame.usage === null && frame.choices.length === 1));
        assert.equal(frames.at(-1).choices[0].finish_reason, 'stop');
      } else {
        const body = await response.json();
        const text = endpoint === '/responses' ? body.output.find(item => item.type === 'message').content[0].text : body.choices[0].message.content;
        assert.equal(text, 'INTEGRATION_OK');
      }
      const completions = calls.filter(call => call.url.endsWith(completionPath));
      assert.equal(completions.length, before + 1, 'probe generated more than once');
      assert.equal(completions.at(-1).body.text, 'hi', 'compatibility fields changed the prompt');
      for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'stream_options']) {
        assert.equal(completions.at(-1).body[key], undefined, key + ' reached the school');
      }
    }
    for (const ending of ['', ' CLEAN_EOF']) for (const stream of [false, true]) {
      const response = await fetch(base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply INTEGRATION_OK' + ending }], stream }) });
      assert.equal(response.status, 200);
      if (stream) {
        const text = await response.text();
        assert.ok(text.includes('INTEGRATION_OK'));
        assert.ok(text.includes('reasoning_content'));
        assert.ok(text.endsWith('data: [DONE]\n\n'));
      } else {
        const body = await response.json();
        assert.equal(body.choices[0].message.content, 'INTEGRATION_OK');
        assert.equal(body.choices[0].message.reasoning_content, 'reason');
      }
    }
    const imageURL = 'data:image/png;base64,' + png.toString('base64');
    assert.ok(png.length > 1024 * 1024);
    const imageRequest = { model, messages: [{ role: 'user', content: [{ type: 'text', text: 'IMAGE_CASE' }, { type: 'image_url', image_url: { url: imageURL } }] }] };
    const imageResponse = await fetch(base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(imageRequest) });
    assert.equal(imageResponse.status, 200, await imageResponse.clone().text());
    assert.equal((await imageResponse.json()).choices[0].message.content, 'IMAGE_OK');
    assert.ok(nativeChunks > 1, 'large image never crossed chunked Native Messaging');
    assert.equal(pageRequests.at(-1).images.length, 1);
    assert.equal(pageRequests.at(-1).attachments, undefined, 'image-only payload compatibility changed');
    uploadFails = true;
    for (const endpoint of ['/chat/completions', '/responses']) for (const stream of [false, true]) {
      const before = calls.length;
      const request = endpoint === '/responses'
        ? { model, stream, instructions: 'Use the supplied attachment.', input: [{ role: 'user', content: [{ type: 'input_text', text: 'IMAGE_CASE' }, { type: 'input_image', image_url: imageURL }] }] }
        : { ...imageRequest, stream };
      const response = await fetch(base_url + endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
      assert.equal(response.status, 502);
      assert.match(response.headers.get('Content-Type'), /application\/json/);
      const error = (await response.json()).error;
      const filename = pageRequests.at(-1).images[0].name;
      assert.equal(error.type, 'bridge_error');
      assert.equal(error.code, 'attachment_upload_failed');
      assert.equal(error.stage, 'attachment_upload');
      assert.deepEqual(error.upstream, { http_status: 429, school_code: 429 });
      assert.equal(error.param, `${endpoint === '/responses' ? 'input' : 'messages'}[0].content[1]`);
      assert.deepEqual(error.attachment, { index: 0, total: 1, filename, kind: 'image' });
      assert.equal(error.message, `Attachment 1/1 (${filename}): Synthetic upload rate limit`);
      assert.equal(calls.slice(before).filter(call => call.url.endsWith('/api/common/upload')).length, 1, 'upload was retried');
      assert.equal(calls.slice(before).filter(call => call.url.endsWith(completionPath)).length, 0, 'generation ran after upload failed');
    }
    uploadFails = false;
    assert.equal((await fetch(base_url + '/responses', { method: 'POST', body: '{}' })).status, 401);
    for (const ending of ['', ' CLEAN_EOF']) for (const stream of [false, true]) {
      const response = await fetch(base_url + '/responses', { method: 'POST', headers, body: JSON.stringify({ model, store: false, input: 'Reply INTEGRATION_OK' + ending, stream }) });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.text();
      if (stream) {
        assert.ok(result.includes('response.output_text.delta'));
        assert.ok(result.includes('response.completed'));
        assert.ok(result.includes('INTEGRATION_OK'));
      } else {
        const body = JSON.parse(result);
        assert.equal(body.object, 'response');
        assert.equal(body.status, 'completed');
        assert.equal(body.output.find(item => item.type === 'message').content[0].text, 'INTEGRATION_OK');
      }
    }
    const vision = await fetch(base_url + '/responses', { method: 'POST', headers, body: JSON.stringify({ model, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: 'IMAGE_CASE' }, { type: 'input_image', image_url: imageURL }] }] }) });
    assert.equal(vision.status, 200, await vision.clone().text());
    assert.equal((await vision.json()).output.find(item => item.type === 'message').content[0].text, 'IMAGE_OK');
    const pdfPart = { type: 'input_file', filename: 'sample.pdf', file_data: 'data:application/pdf;base64,' + pdf.toString('base64') };
    const textFilePart = { type: 'input_file', filename: 'sample.txt', file_data: textFile.toString('base64') };
    const fileRequest = { model: textOnlyModel, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: 'FILE_CASE' }, pdfPart, textFilePart] }] };
    const fileCases = [
      ['/responses', fileRequest, ['application/pdf', 'text/plain']],
      ['/responses', { model, store: false, stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'FILE_CASE' }, pdfPart, { type: 'input_image', image_url: imageURL }, textFilePart] }] }, ['application/pdf', 'image/png', 'text/plain']],
      ['/chat/completions', { model: textOnlyModel, messages: [{ role: 'user', content: [{ type: 'text', text: 'FILE_CASE' }, { type: 'file', file: { filename: textFilePart.filename, file_data: textFilePart.file_data } }] }] }, ['text/plain']]
    ];
    for (const [endpoint, request, types] of fileCases) {
      const before = calls.length;
      const response = await fetch(base_url + endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
      assert.equal(response.status, modern ? 200 : 400, await response.clone().text());
      const payload = pageRequests.at(-1);
      assert.equal(payload.images, undefined, 'document payload used both attachment representations');
      assert.deepEqual(payload.attachments.map(item => item.mime), types);
      assert.deepEqual(payload.attachments.map(item => item.kind), types.map(type => type === 'image/png' ? 'image' : 'file'));
      if (!modern) {
        assert.match(response.headers.get('Content-Type'), /application\/json/);
        const error = (await response.json()).error;
        assert.equal(error.type, 'invalid_request_error');
        assert.equal(error.code, 'unsupported_file_frontend');
        assert.equal(calls.length, before, 'unsupported file caused a school request');
        continue;
      }
      const result = await response.text();
      assert.ok(result.includes('FILE_OK'));
      if (request.stream) assert.ok(result.includes('response.completed'));
      assert.equal(schoolSession.model, request.model, 'documents unnecessarily required an image-capable model');
      const uploaded = calls.slice(before).filter(call => call.url.endsWith('/api/common/upload'));
      assert.deepEqual(uploaded.map(call => call.fileType), types, 'attachment upload order changed');
      const generated = calls.slice(before).filter(call => call.url.endsWith(completionPath));
      assert.equal(generated.length, 1, 'document request generated more than once');
      assert.deepEqual(generated[0].body.attachments, types.map(type => fileURLs[type]), 'completion lost or reordered uploaded attachments');
    }
    const countBefore = calls.length;
    const countInput = modern ? Array(10).fill(textFilePart) : Array(2).fill({ type: 'input_image', image_url: imageURL });
    const countResponse = await fetch(base_url + '/responses', { method: 'POST', headers, body: JSON.stringify({ model, stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'FILE_CASE' }, ...countInput] }] }) });
    assert.equal(countResponse.status, modern ? 200 : 400, await countResponse.clone().text());
    if (modern) {
      const result = await countResponse.text();
      assert.ok(result.includes('response.completed') && result.includes('FILE_OK'));
      assert.equal(calls.slice(countBefore).filter(call => call.url.endsWith('/api/common/upload')).length, 10);
      assert.deepEqual(calls.at(-1).body.attachments, Array(10).fill(fileURLs['text/plain']));
    } else {
      const error = (await countResponse.json()).error;
      assert.equal(error.code, 'attachment_limit_exceeded');
      assert.equal(error.type, 'invalid_request_error');
      assert.equal(calls.length, countBefore, 'legacy image limit caused a school request');
    }
    if (modern) {
      const files = [pdfPart, textFilePart, pdfPart];
      for (const endpoint of ['/chat/completions', '/responses']) for (const stream of [false, true]) {
        const before = calls.length;
        failUploadNumber = calls.filter(call => call.url.endsWith('/api/common/upload')).length + 2;
        const request = endpoint === '/responses'
          ? { model: textOnlyModel, stream, instructions: 'Use the supplied attachments.', input: [{ role: 'user', content: [{ type: 'input_text', text: 'FILE_CASE' }, ...files] }] }
          : { model: textOnlyModel, stream, messages: [{ role: 'user', content: [{ type: 'text', text: 'FILE_CASE' }, ...files.map(({ type, ...file }) => ({ type: 'file', file }))] }] };
        const response = await fetch(base_url + endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
        assert.equal(response.status, 502, await response.clone().text());
        assert.match(response.headers.get('Content-Type'), /application\/json/);
        const error = (await response.json()).error;
        assert.equal(error.type, 'bridge_error');
        assert.equal(error.code, 'attachment_upload_failed');
        assert.equal(error.stage, 'attachment_upload');
        assert.deepEqual(error.upstream, { http_status: 429, school_code: 429 });
        assert.equal(error.param, `${endpoint === '/responses' ? 'input' : 'messages'}[0].content[2]`);
        assert.deepEqual(error.attachment, { index: 1, total: 3, filename: 'sample.txt', kind: 'file' });
        assert.equal(error.message, 'Attachment 2/3 (sample.txt): Synthetic upload rate limit');
        assert.equal(calls.slice(before).filter(call => call.url.endsWith('/api/common/upload')).length, 2, 'failed upload was retried or later files were uploaded');
        assert.equal(calls.slice(before).filter(call => call.url.endsWith(completionPath)).length, 0, 'generation ran after the second upload failed');
      }
      failUploadNumber = 0;
    }
    const omission = '[Earlier image omitted; image content is unavailable. Use only the existing text descriptions.]';
    const caption = 'The earlier image shows a blue circle.';
    const historyRequest = (endpoint, stream, variant = 'answered') => {
      const responses = endpoint === '/responses';
      const imagePart = responses ? { type: 'input_image', image_url: imageURL } : { type: 'image_url', image_url: { url: imageURL } };
      const textPart = text => ({ type: responses ? 'input_text' : 'text', text });
      const messages = [{ role: 'user', content: [textPart('Describe this image.'), imagePart] }];
      if (variant !== 'unanswered') messages.push({ role: 'assistant', content: caption });
      messages.push({ role: 'user', content: variant === 'new-image' ? [textPart('Describe the new image.'), imagePart] : 'Continue using the previous description.' });
      return { model: textOnlyModel, stream, ...(responses ? { store: false, input: messages } : { messages }) };
    };
    const rejectUnsupportedImage = async (endpoint, request) => {
      const before = calls.length;
      const previousModel = schoolSession.model;
      const response = await fetch(base_url + endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
      assert.equal(response.status, 400, await response.clone().text());
      assert.match(response.headers.get('Content-Type'), /application\/json/);
      const error = (await response.json()).error;
      assert.equal(error.type, 'invalid_request_error');
      assert.equal(error.code, 'unsupported_image_model');
      assert.match(error.message, /image support/i);
      assert.equal(schoolSession.model, previousModel, 'unsupported image changed the selected school model');
      assert.ok(calls.slice(before).every(call => !/\/(?:saveSession|upload|completions|response)$/.test(call.url)), 'unsupported image caused a school mutation, upload, or generation');
    };
    // Capability errors travel through every extension world and stay JSON even for streaming clients.
    for (const endpoint of ['/chat/completions', '/responses']) for (const stream of [false, true]) {
      await rejectUnsupportedImage(endpoint, historyRequest(endpoint, stream));
    }
    const historySettings = await ui({ type: 'saveSettings', config: { omit_historical_images: true } });
    assert.equal(historySettings.ok, true, historySettings.error);
    assert.equal(historySettings.config.omit_historical_images, true);
    assert.equal(historySettings.restartRequired, false);
    assert.equal((await ui({ type: 'getSettings' })).config.omit_historical_images, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).omit_historical_images, true);
    for (const endpoint of ['/chat/completions', '/responses']) for (const stream of [false, true]) {
      const before = calls.length;
      const response = await fetch(base_url + endpoint, { method: 'POST', headers, body: JSON.stringify(historyRequest(endpoint, stream)) });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.text();
      assert.ok(result.includes('INTEGRATION_OK'));
      if (stream) assert.ok(result.includes(endpoint === '/responses' ? 'response.completed' : 'data: [DONE]'));
      const generated = calls.slice(before).filter(call => call.url.endsWith(completionPath));
      assert.equal(generated.length, 1, 'text continuation generated more than once');
      assert.equal(schoolSession.model, textOnlyModel);
      assert.deepEqual(generated[0].body[attachmentField], []);
      assert.ok(generated[0].body.text.includes(omission), 'omission was not disclosed to the model');
      assert.ok(generated[0].body.text.includes(caption), 'previous textual description was lost');
      assert.ok(generated[0].body.text.includes('Continue using the previous description.'));
      assert.equal(calls.slice(before).filter(call => call.url.endsWith('/api/common/upload')).length, 0, 'historical image was uploaded');
      // Opt-in never drops current images or unanswered images in consecutive user turns.
      await rejectUnsupportedImage(endpoint, historyRequest(endpoint, stream, 'new-image'));
      await rejectUnsupportedImage(endpoint, historyRequest(endpoint, stream, 'unanswered'));
    }
    const strictSettings = await ui({ type: 'saveSettings', config: { omit_historical_images: false } });
    assert.equal(strictSettings.ok, true, strictSettings.error);
    assert.equal(strictSettings.config.omit_historical_images, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).omit_historical_images, false);
    await rejectUnsupportedImage('/chat/completions', historyRequest('/chat/completions', false));
    const parameters = { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false };
    const tools = [{ type: 'function', function: { name: 'double', description: 'Double a number', parameters, strict: true } }];
    const first = await fetch(base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'TOOL_FIRST' }], tools, tool_choice: 'required' }) });
    assert.equal(first.status, 200, await first.clone().text());
    const firstChoice = (await first.json()).choices[0];
    assert.equal(firstChoice.finish_reason, 'tool_calls');
    const call = firstChoice.message.tool_calls[0];
    assert.equal(call.function.name, 'double');
    assert.deepEqual(JSON.parse(call.function.arguments), { value: 7 });
    const second = await fetch(base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, tools, messages: [{ role: 'user', content: 'TOOL_FIRST' }, firstChoice.message, { role: 'tool', tool_call_id: call.id, content: '14' }, { role: 'user', content: 'TOOL_SECOND' }] }) });
    assert.equal(second.status, 200, await second.clone().text());
    assert.equal((await second.json()).choices[0].message.content, 'TOOL_SECOND_OK');
    const responseTools = [{ type: 'function', name: 'double', description: 'Double a number', parameters, strict: true }];
    const responseFirst = await fetch(base_url + '/responses', { method: 'POST', headers, body: JSON.stringify({ model, store: false, input: 'TOOL_FIRST', tools: responseTools, tool_choice: 'required' }) });
    assert.equal(responseFirst.status, 200, await responseFirst.clone().text());
    const responseCall = (await responseFirst.json()).output.find(item => item.type === 'function_call');
    assert.equal(responseCall.name, 'double');
    assert.deepEqual(JSON.parse(responseCall.arguments), { value: 7 });
    const responseSecond = await fetch(base_url + '/responses', { method: 'POST', headers, body: JSON.stringify({ model, store: false, tools: responseTools, input: [{ role: 'user', content: 'TOOL_FIRST' }, responseCall, { type: 'function_call_output', call_id: responseCall.call_id, output: '14' }, { role: 'user', content: 'TOOL_SECOND' }] }) });
    assert.equal(responseSecond.status, 200, await responseSecond.clone().text());
    assert.equal((await responseSecond.json()).output.find(item => item.type === 'message').content[0].text, 'TOOL_SECOND_OK');
    const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false };
    for (const valid of [true, false]) {
      const structured = await fetch(base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: valid ? 'SCHEMA_VALID' : 'SCHEMA_INVALID' }], response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } } }) });
      assert.equal(structured.status, valid ? 200 : 502, await structured.clone().text());
      const result = await structured.json();
      if (valid) assert.deepEqual(JSON.parse(result.choices[0].message.content), { answer: 42 });
      else assert.ok(result.error);
    }
    // Buffered tool/schema validation must also finish on clean school EOF.
    for (const endpoint of ['/chat/completions', '/responses']) for (const stream of [false, true]) for (const kind of ['tool', 'schema']) {
      const responses = endpoint === '/responses';
      const prompt = (kind === 'tool' ? 'TOOL_FIRST' : 'SCHEMA_VALID') + ' CLEAN_EOF';
      const request = { model, stream, ...(responses ? { store: false, input: prompt } : { messages: [{ role: 'user', content: prompt }] }) };
      if (kind === 'tool') Object.assign(request, { tools: responses ? responseTools : tools, tool_choice: 'required' });
      else if (responses) request.text = { format: { type: 'json_schema', name: 'answer', strict: true, schema } };
      else request.response_format = { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } };
      const response = await fetch(base_url + endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
      assert.equal(response.status, 200, await response.clone().text());
      let result;
      if (stream) {
        const text = await response.text();
        const frames = text.split('\n\n').map(frame => frame.split('\n').find(line => line.startsWith('data: '))).filter(Boolean).map(line => line.slice(6)).filter(data => data !== '[DONE]').map(JSON.parse);
        assert.ok(frames.every(frame => !frame.error && frame.type !== 'response.failed'));
        if (responses) {
          assert.equal(frames.at(-1).type, 'response.completed');
          result = frames.at(-1).response;
        } else {
          assert.ok(text.endsWith('data: [DONE]\n\n'));
          assert.equal(frames.at(-1).choices[0].finish_reason, kind === 'tool' ? 'tool_calls' : 'stop');
          result = { choices: [{ message: {
            content: frames.map(frame => frame.choices[0].delta.content || '').join(''),
            tool_calls: frames.flatMap(frame => frame.choices[0].delta.tool_calls || [])
          } }] };
        }
      } else result = await response.json();
      if (kind === 'tool') {
        const call = responses ? result.output.find(item => item.type === 'function_call') : result.choices[0].message.tool_calls[0].function;
        assert.equal(call.name, 'double');
        assert.deepEqual(JSON.parse(call.arguments), { value: 7 });
      } else {
        const text = responses ? result.output.find(item => item.type === 'message').content[0].text : result.choices[0].message.content;
        assert.deepEqual(JSON.parse(text), { answer: 42 });
      }
    }
    for (const endpoint of ['/chat/completions', '/responses']) for (const stream of [false, true]) for (const rejected of [false, true]) {
      const before = calls.length;
      schoolOverride = { path: completionPath, contentType: 'text/event-stream', body: 'data: {"type":"string","data":"PARTIAL_CONTENT"}\n\n' + (rejected ? 'data: {"code":10008}\n\n' : 'data: {"type":"string","data":"unfinished') };
      const request = { model, stream, ...(endpoint === '/responses' ? { input: 'Synthetic stream error check' } : { messages: [{ role: 'user', content: 'Synthetic stream error check' }] }) };
      const response = await fetch(base_url + endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
      let error;
      if (stream) {
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.ok(text.includes('PARTIAL_CONTENT'));
        const frames = text.split('\n\n').map(frame => frame.split('\n').find(line => line.startsWith('data: '))).filter(Boolean).map(line => line.slice(6)).filter(data => data !== '[DONE]').map(JSON.parse);
        error = frames.map(frame => endpoint === '/responses' ? frame.response?.error : frame.error).find(Boolean);
        assert.ok(error, 'stream failure lost its error payload');
        assert.ok(!frames.some(frame => frame.type === 'response.completed'));
        assert.ok(!frames.some(frame => frame.choices?.some(choice => choice.finish_reason === 'stop')));
      } else {
        assert.equal(response.status, 502);
        const body = await response.json();
        error = body.error;
        assert.equal(body.choices, undefined);
        assert.equal(body.output, undefined);
      }
      assert.equal(error.code, rejected ? 'school_rejected' : 'school_stream_incomplete');
      assert.equal(error.stage, rejected ? 'generation' : 'stream');
      assert.deepEqual(error.upstream, { http_status: 200, ...(rejected ? { school_code: 10008 } : {}) });
      assert.equal(calls.slice(before).filter(call => call.url.endsWith(completionPath)).length, 1, 'stream failure was retried');
    }
    schoolOverride = undefined;
    for (const [endpoint, requestedModel, stream] of [
      ['/chat/completions', secondModel, false], ['/responses', model, true],
      ['/responses', secondModel, false], ['/chat/completions', model, true],
      ['/chat/completions', model, false]
    ]) {
      const beforeCalls = calls.length;
      const changes = schoolSession.model !== requestedModel;
      const input = endpoint === '/responses' ? { input: 'ROUTE_CASE' } : { messages: [{ role: 'user', content: 'ROUTE_CASE' }] };
      const routed = await fetch(base_url + endpoint, { method: 'POST', headers, body: JSON.stringify({ model: requestedModel, stream, ...input }) });
      assert.equal(routed.status, 200, await routed.clone().text());
      const result = await routed.text();
      assert.ok(result.includes('ROUTED:' + requestedModel), 'completion used the wrong school model');
      assert.equal(schoolSession.model, requestedModel);
      const paths = calls.slice(beforeCalls).map(call => new URL(call.url).pathname);
      assert.equal(paths.filter(path => path.endsWith('/api/chat/saveSession')).length, changes ? 1 : 0);
      assert.equal(paths.filter(path => path.endsWith('/api/chat/session')).length, changes ? 2 : 1);
      assert.ok(paths.at(-1).endsWith(completionPath));
      if (changes) assert.ok(paths.at(-2).endsWith('/api/chat/session'), 'saved model was not verified before generation');
      if (stream) assert.ok(result.includes(endpoint === '/responses' ? 'response.completed' : 'data: [DONE]'));
    }
    const before = calls.filter(x => x.url.endsWith(completionPath)).length;
    const unknown = await fetch(base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'unknown-model', messages: [{ role: 'user', content: 'Do not generate' }] }) });
    assert.equal(unknown.status, 400);
    const unknownError = (await unknown.json()).error;
    assert.equal(unknownError.code, 'school_model_unavailable');
    assert.equal(unknownError.stage, 'model_catalog');
    assert.equal(calls.filter(x => x.url.endsWith(completionPath)).length, before);
    ignoreModelSave = true;
    const unconfirmed = await fetch(base_url + '/responses', { method: 'POST', headers, body: JSON.stringify({ model: secondModel, input: 'Do not generate' }) });
    assert.equal(unconfirmed.status, 502);
    const updateError = (await unconfirmed.json()).error;
    assert.equal(updateError.code, 'school_session_update_failed');
    assert.equal(updateError.stage, 'session_update');
    assert.equal(calls.filter(x => x.url.endsWith(completionPath)).length, before);
    ignoreModelSave = false;
    const saved = await ui({ type: 'saveSettings', config: { default_model: model, thinking: 'high', online: true, include_reasoning: false } });
    assert.equal(saved.ok, true);
    assert.equal(saved.restartRequired, false);
    const defaults = await fetch(base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'USE_DEFAULTS' }] }) });
    assert.equal(defaults.status, 200);
    const defaultBody = await defaults.json();
    assert.equal(defaultBody.model, model);
    assert.equal(defaultBody.choices[0].message.reasoning_content, undefined);
    assert.equal(calls.at(-1).body.thinking, 'high');
    assert.equal(calls.at(-1).body.online, 1);
    const savedFile = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
    assert.equal(savedFile.include_reasoning, false);
    assert.equal(savedFile.default_model, model);
    const bad = await ui({ type: 'saveSettings', config: { allowed_origins: [] } });
    assert.equal(bad.ok, false);
    const rotated = await ui({ type: 'rotateKey' });
    assert.equal(rotated.ok, true);
    assert.notEqual(rotated.apiKey, api_key);
    assert.equal((await fetch(base_url + '/models', { headers })).status, 401);
    assert.equal((await fetch(base_url + '/models', { headers: { Authorization: 'Bearer ' + rotated.apiKey } })).status, 200);
    const exited = once(child, 'exit');
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0, errorOutput);
    assert.equal(errorOutput, '');
    console.log((modern ? 'modern' : 'legacy') + ' native integration passed: real Go process, all extension worlds, verified model switching, token-limit compatibility and unknown usage, chunked PNG upload, ordered document attachments and frontend capability errors, upload failure without retry, image capability errors and opt-in historical omission, Responses JSON/SSE/vision, tool round trip, JSON Schema validation, optional school DONE with clean EOF, incomplete-frame errors, settings/key rotation and host EOF');
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
  }
}
main().then(() => main(true)).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
