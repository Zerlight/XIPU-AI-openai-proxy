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
const shared = { window, location: {origin}, URL, TextDecoder, AbortController };
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
  port.onMessage.emit({type:'req',job:'web-error',op:'chat',payload:{}});
  window.postMessage({source:'xipu-bridge',type:'evt',job:'web-error',kind:'done',message:'Webpage is not ready',code:'debug_web_session_unavailable'});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(received.some(message => message.evt.job === 'web-error' && message.evt.code === 'debug_web_session_unavailable'));
  port.onMessage.emit({type:'req',job:'unknown-error',op:'chat',payload:{}});
  window.postMessage({source:'xipu-bridge',type:'evt',job:'unknown-error',kind:'done',message:'Unknown failure',code:'arbitrary_status'});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(received.filter(message => message.evt.job === 'unknown-error').every(message => message.evt.code === undefined));
  const invalidatedChrome = {runtime:{get id() {throw new Error('Extension context invalidated.');}}};
  assert.doesNotThrow(() => vm.runInNewContext(contentSource, {...shared,chrome:invalidatedChrome,setTimeout}));
  console.log('content bridge checks passed: MAIN/isolated round trip, rewritten origin, token containment, invalidated context');
})().catch(error => {console.error(error);process.exitCode=1;});
