// Exercise MAIN + isolated scripts together, including a rewritten proxy origin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const event = () => ({ handlers: [], addListener(fn) { this.handlers.push(fn); }, emit(x) { this.handlers.forEach(fn => fn(x)); } });
const received = [], requests = [], listeners = [];
const origin = 'https://xipuai-xjtlu-edu-cn-s.xjtlu.edu.cn';
let resolveDone;
const done = new Promise(resolve => { resolveDone = resolve; });
const port = { onMessage: event(), onDisconnect: event(), postMessage(message) {
  received.push(message);
  if (message.evt.kind === 'done') resolveDone();
}};
const window = {
  addEventListener(type, fn) { assert.equal(type, 'message'); listeners.push(fn); },
  postMessage(data) { queueMicrotask(() => listeners.forEach(fn => fn({
    source: window, origin: 'https://xipuai.xjtlu.edu.cn', data
  }))); },
  async fetch(url, options) {
    requests.push(url);
    assert.equal(options.headers['Jm-Token'], 'synthetic-school-token');
    return new Response(JSON.stringify({code:0,data:{models:[{value:'qwen-test-local'}]}}), {
      headers: {'Content-Type':'application/json'}
    });
  }
};
const shared = { window, location: {origin, pathname: '/v3/chat'}, URL, TextDecoder, AbortController };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/page.js'), 'utf8'), {
  ...shared, btoa: x => Buffer.from(x).toString('base64'),
  document: {querySelector: () => ({__vue_app__:{config:{globalProperties:{$pinia:{state:{value:{user:{token:'synthetic-school-token'}}}}}}}})},
  localStorage: {getItem: () => 'en'}
});
const chrome = {runtime:{id:'synthetic-extension',connect:()=>port}};
const contentSource = fs.readFileSync(path.join(__dirname, '../extension/bridge.js'), 'utf8');
vm.runInNewContext(contentSource, {...shared,chrome,setTimeout});
port.onMessage.emit({type:'req',job:'wire-test',op:'models',payload:{}});
(async () => {
  await done;
  assert.equal(requests.length,1);
  assert.equal(received[0].evt.job,'wire-test');
  assert.equal(received[0].evt.result.data.models[0].value,'qwen-test-local');
  assert.equal(received.at(-1).evt.kind,'done');
  assert.ok(!JSON.stringify(received).includes('synthetic-school-token'));
  port.onMessage.emit({type:'req',job:'image-error',op:'chat',payload:{}});
  window.postMessage({source:'xipu-bridge',type:'evt',job:'image-error',kind:'done',message:'Image capability mismatch',code:'unsupported_image_model'});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(received.some(message => message.evt.job === 'image-error' && message.evt.code === 'unsupported_image_model'));
  port.onMessage.emit({type:'req',job:'file-error',op:'chat',payload:{}});
  window.postMessage({source:'xipu-bridge',type:'evt',job:'file-error',kind:'done',message:'File input requires the current frontend',code:'unsupported_file_frontend'});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(received.some(message => message.evt.job === 'file-error' && message.evt.code === 'unsupported_file_frontend'));
  port.onMessage.emit({type:'req',job:'count-error',op:'chat',payload:{}});
  window.postMessage({source:'xipu-bridge',type:'evt',job:'count-error',kind:'done',message:'Attachment count exceeded',code:'attachment_limit_exceeded'});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(received.some(message => message.evt.job === 'count-error' && message.evt.code === 'attachment_limit_exceeded'));
  for (const index of [0, 1, 9, -1, 10, 1.5, '1', null, undefined]) {
    const job = `upload-error-${String(index)}-${typeof index}`;
    port.onMessage.emit({type:'req',job,op:'chat',payload:{}});
    window.postMessage({source:'xipu-bridge',type:'evt',job,kind:'done',message:'Upload failed',
      code:'attachment_upload_failed',attachment_index:index,filename:'untrusted.txt',param:'untrusted.path'});
    await new Promise(resolve => setImmediate(resolve));
    const forwarded = received.find(message => message.evt.job === job && message.evt.code === 'attachment_upload_failed').evt;
    assert.equal(forwarded.attachment_index, Number.isInteger(index) && index >= 0 && index < 10 ? index : undefined);
    assert.equal(forwarded.filename, undefined);
    assert.equal(forwarded.param, undefined);
  }
  const stages = ['authentication', 'model_catalog', 'session_read', 'session_create', 'session_configure', 'session_update', 'attachment_upload', 'generation', 'stream'];
  const schoolCodes = ['school_auth_required', 'school_rate_limited', 'school_http_error', 'school_rejected', 'school_invalid_response', 'school_network_error',
    'school_stream_incomplete', 'school_stream_error', 'school_session_not_found', 'school_session_ambiguous', 'school_session_unsafe', 'school_session_update_failed', 'school_model_unavailable'];
  for (const [index, code] of schoolCodes.entries()) {
    const job = `school-error-${index}`, stage = stages[index % stages.length];
    port.onMessage.emit({type:'req',job,op:'chat',payload:{}});
    window.postMessage({source:'xipu-bridge',type:'evt',job,kind:'done',message:'School failed',code,stage,
      http_status:200,school_code:10008,attachment_index:0,param:'private.path',url:'https://private.invalid',body:'private body'});
    await new Promise(resolve => setImmediate(resolve));
    const forwarded = received.find(message => message.evt.job === job && message.evt.code === code).evt;
    assert.equal(forwarded.stage, stage);
    assert.equal(forwarded.http_status, 200);
    assert.equal(forwarded.school_code, 10008);
    for (const field of ['attachment_index', 'param', 'url', 'body']) assert.equal(forwarded[field], undefined);
  }
  for (const [index, metadata] of [
    {stage:'private.path',http_status:'200',school_code:'10008'},
    {stage:null,http_status:99,school_code:9007199254740992},
    {stage:false,http_status:600,school_code:1.5},
    {stage:23,http_status:200.5,school_code:NaN}
  ].entries()) {
    const job = `invalid-metadata-${index}`;
    port.onMessage.emit({type:'req',job,op:'chat',payload:{}});
    window.postMessage({source:'xipu-bridge',type:'evt',job,kind:'done',code:'school_rejected',...metadata});
    await new Promise(resolve => setImmediate(resolve));
    const forwarded = received.find(message => message.evt.job === job && message.evt.code === 'school_rejected').evt;
    for (const field of ['stage','http_status','school_code']) assert.equal(forwarded[field], undefined);
  }
  port.onMessage.emit({type:'req',job:'web-error',op:'chat',payload:{}});
  window.postMessage({source:'xipu-bridge',type:'evt',job:'web-error',kind:'done',message:'Webpage is not ready',code:'debug_web_session_unavailable'});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(received.some(message => message.evt.job === 'web-error' && message.evt.code === 'debug_web_session_unavailable'));
  port.onMessage.emit({type:'req',job:'unknown-error',op:'chat',payload:{}});
  window.postMessage({source:'xipu-bridge',type:'evt',job:'unknown-error',kind:'done',message:'Unknown failure',code:'arbitrary_status',attachment_index:0,stage:'generation',http_status:200,school_code:10008});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(received.filter(message => message.evt.job === 'unknown-error').every(message => message.evt.code === undefined));
  assert.ok(received.filter(message => message.evt.job === 'unknown-error').every(message => message.evt.attachment_index === undefined));
  assert.ok(received.filter(message => message.evt.job === 'unknown-error').every(message => message.evt.stage === undefined && message.evt.http_status === undefined && message.evt.school_code === undefined));
  const invalidatedChrome = {runtime:{get id() {throw new Error('Extension context invalidated.');}}};
  assert.doesNotThrow(() => vm.runInNewContext(contentSource, {...shared,chrome:invalidatedChrome,setTimeout}));
  console.log('content bridge checks passed: MAIN/isolated round trip, rewritten origin, token containment, invalidated context');
})().catch(error => {console.error(error);process.exitCode=1;});
