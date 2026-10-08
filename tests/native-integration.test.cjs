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
async function main() {
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
    storage: { local: { set() {}, remove() {}, setAccessLevel() {} } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8'), { chrome, URL, atob, btoa, TextDecoder, Uint8Array, setTimeout, clearTimeout });
  const ui = message => new Promise(resolve => chrome.runtime.onMessage.emit(message, { id: extensionID, url: chrome.runtime.getURL('options.html') }, resolve));
  const [background, content] = pair();
  Object.assign(background, { name: 'xipu', sender: { id: extensionID, frameId: 0, url: schoolOrigin + '/v3/chat' } });
  chrome.runtime.onConnect.emit(background);
  const listeners = [], calls = [];
  let uploadFails = false, ignoreModelSave = false;
  let schoolSession = { ...session };
  const uploadedURL = 'https://tosai.xjtlu.edu.cn/synthetic-image.png';
  const png = imageFixture();
  const window = {
    addEventListener(type, fn) { assert.equal(type, 'message'); listeners.push(fn); },
    postMessage(data) { queueMicrotask(() => listeners.forEach(fn => fn({ source: window, origin: 'https://xipuai.xjtlu.edu.cn', data }))); },
    async fetch(url, options) {
      assert.equal(options.headers['Jm-Token'], token);
      if (url.endsWith('/api/common/upload')) {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['Content-Type'], undefined);
        assert.ok(options.body instanceof FormData);
        assert.equal(options.body.get('accept'), 'image');
        assert.equal(options.body.get('lang'), 'en');
        const file = options.body.get('file');
        assert.equal(file.type, 'image/png');
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
        calls.push({ url, fileSize: file.size });
        return new Response(JSON.stringify(uploadFails ? { code: 429, msg: 'Synthetic upload rate limit' } : { code: 0, data: { url: uploadedURL } }), { status: uploadFails ? 429 : 200 });
      }
      calls.push({ url, body: options.body && JSON.parse(options.body) });
      if (url.includes('/api/chat/config?')) return new Response(JSON.stringify({ code: 0, data: { models: [{ value: model, label: 'Synthetic model', multimodal: true }, { value: secondModel, label: 'Second model', multimodal: true }] } }));
      if (url.includes('/api/chat/session?')) return new Response(JSON.stringify({ code: 0, data: [schoolSession] }));
      if (url.endsWith('/api/chat/saveSession')) {
        const body = calls.at(-1).body;
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['Content-Type'], 'application/json');
        assert.ok([model, secondModel].includes(body.model));
        assert.deepEqual(body, { ...schoolSession, model: body.model, lang: 'en' });
        if (!ignoreModelSave) schoolSession = { ...schoolSession, model: body.model };
        return new Response(JSON.stringify({ code: 0 }));
      }
      assert.ok(url.endsWith('/api/chat/completions'));
      assert.equal(calls.at(-1).body.sessionId, session.id);
      if (calls.at(-1).body.text === 'TRUNCATE') {
        return new Response('data: {"type":"string","data":"TRUNCATED_CONTENT"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      }
      const prompt = calls.at(-1).body.text;
      let answer = 'INTEGRATION_OK';
      if (prompt.startsWith('ROUTE_CASE')) {
        answer = 'ROUTED:' + schoolSession.model;
      } else if (prompt.includes('IMAGE_CASE')) {
        assert.deepEqual(calls.at(-1).body.files, [uploadedURL]);
        answer = 'IMAGE_OK';
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
      if (answer !== 'INTEGRATION_OK') return new Response(`data: ${JSON.stringify({ type: 'string', data: answer })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('data: {"type":"string","reasoning_data":"reason"}\r\n\r\ndata: {"type":"string","data":"INTEGRATION_OK"}\r\n\r\ndata: [DONE]\r\n\r\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
  };
  const shared = { window, location: { origin: schoolOrigin }, URL, TextDecoder, AbortController, atob, Blob, File, FormData, Uint8Array };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension/page.js'), 'utf8'), { ...shared,
    document: { querySelector: () => ({ __vue_app__: { config: { globalProperties: { $pinia: { state: { value: { user: { token } } } } } } } }) },
    btoa, localStorage: { getItem: () => 'en' }
  });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension/bridge.js'), 'utf8'), { ...shared, chrome: { runtime: { id: extensionID, connect: () => content } }, setTimeout });
  try {
    const { base_url, api_key } = await readyPromise;
    const headers = { Authorization: 'Bearer ' + api_key, 'Content-Type': 'application/json' };
    const settings = await ui({ type: 'getSettings' });
    assert.equal(settings.ok, true);
    assert.equal(settings.config.session_name, session.name);
    const inspected = await ui({ type: 'inspectSchool' });
    assert.equal(inspected.models[0].id, model);
    assert.equal(inspected.sessions[0].contextCount, 0);
    assert.equal((await fetch(base_url + '/models')).status, 401);
    const catalog = await fetch(base_url + '/models', { headers });
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).data[0].id, model);
    // Compatibility fields must not change the school request.
    const probes = [
      ['/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }, 'max_tokens'],
      ['/responses', { model, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], max_output_tokens: 16 }, 'max_output_tokens'],
      ['/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 16, stream: true, stream_options: { include_usage: true } }, 'max_completion_tokens']
    ];
    for (const [endpoint, request, ignored] of probes) {
      const before = calls.filter(call => call.url.endsWith('/api/chat/completions')).length;
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
      const completions = calls.filter(call => call.url.endsWith('/api/chat/completions'));
      assert.equal(completions.length, before + 1, 'probe generated more than once');
      assert.equal(completions.at(-1).body.text, 'hi', 'compatibility fields changed the prompt');
      for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'stream_options']) {
        assert.equal(completions.at(-1).body[key], undefined, key + ' reached the school');
      }
    }
    for (const stream of [false, true]) {
      const response = await fetch(base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply INTEGRATION_OK' }], stream }) });
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
    const beforeFailedUpload = calls.filter(call => call.url.endsWith('/api/chat/completions')).length;
    const beforeUploads = calls.filter(call => call.url.endsWith('/api/common/upload')).length;
    uploadFails = true;
    const uploadError = await fetch(base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(imageRequest) });
    assert.equal(uploadError.status, 502);
    assert.match((await uploadError.json()).error.message, /rate limit/i);
    assert.equal(calls.filter(call => call.url.endsWith('/api/common/upload')).length, beforeUploads + 1, 'upload was retried');
    assert.equal(calls.filter(call => call.url.endsWith('/api/chat/completions')).length, beforeFailedUpload, 'generation ran after upload failed');
    uploadFails = false;
    assert.equal((await fetch(base_url + '/responses', { method: 'POST', body: '{}' })).status, 401);
    for (const stream of [false, true]) {
      const response = await fetch(base_url + '/responses', { method: 'POST', headers, body: JSON.stringify({ model, store: false, input: 'Reply INTEGRATION_OK', stream }) });
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
    for (const stream of [false, true]) {
      const response = await fetch(base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'TRUNCATE' }], stream }) });
      if (stream) {
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.ok(text.includes('TRUNCATED_CONTENT'));
        assert.ok(text.includes('event: error\n'));
        const frames = text.split('\n\n').map(frame => frame.split('\n').find(line => line.startsWith('data: '))).filter(Boolean).map(line => line.slice(6)).filter(data => data !== '[DONE]').map(JSON.parse);
        assert.ok(frames.some(frame => /completion marker/.test(frame.error?.message || '')));
        assert.ok(!frames.some(frame => frame.choices?.some(choice => choice.finish_reason === 'stop')));
      } else {
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.match(body.error.message, /completion marker/);
        assert.equal(body.choices, undefined);
      }
    }
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
      assert.ok(paths.at(-1).endsWith('/api/chat/completions'));
      if (changes) assert.ok(paths.at(-2).endsWith('/api/chat/session'), 'saved model was not verified before generation');
      if (stream) assert.ok(result.includes(endpoint === '/responses' ? 'response.completed' : 'data: [DONE]'));
    }
    const before = calls.filter(x => x.url.endsWith('/api/chat/completions')).length;
    const unknown = await fetch(base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'unknown-model', messages: [{ role: 'user', content: 'Do not generate' }] }) });
    assert.equal(unknown.status, 502);
    assert.match((await unknown.json()).error.message, /model/i);
    assert.equal(calls.filter(x => x.url.endsWith('/api/chat/completions')).length, before);
    ignoreModelSave = true;
    const unconfirmed = await fetch(base_url + '/responses', { method: 'POST', headers, body: JSON.stringify({ model: secondModel, input: 'Do not generate' }) });
    assert.equal(unconfirmed.status, 502);
    assert.match((await unconfirmed.json()).error.message, /model|session/i);
    assert.equal(calls.filter(x => x.url.endsWith('/api/chat/completions')).length, before);
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
    console.log('native integration passed: real Go process, all extension worlds, verified model switching, token-limit compatibility and unknown usage, chunked PNG upload, upload failure without retry, Responses JSON/SSE/vision, tool round trip, JSON Schema validation, settings/key rotation and clean EOF');
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
