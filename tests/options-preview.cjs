// Ordinary web fixture with synthetic data only; no extension or native-host access.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const root = path.join(__dirname, "../extension");
const assets = new Set(["popup.js", "options.js", "ui-settings.js", "ui-controls.js", "styles/coss.css", "styles/popup.css", "styles/options.css", "icons/bridge.svg", "icons/icon-16.png", "icons/icon-24.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png"]);

function startPreview(startPath = "/") {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/popup-preview") {
      const search = url.search.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      return response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>XIPU AI Bridge preview</title><style>body{margin:0;padding:24px;background:#888;font:14px system-ui;color:#fff}p{margin:0 0 16px}iframe{display:block;width:380px;height:600px;border:0;border-radius:12px;box-shadow:0 8px 32px #0003}</style><p>Development preview · synthetic data · 380 × 600</p><iframe title="XIPU AI Bridge popup" src="/popup.html${search}"></iframe></html>`);
    }
    if (["/", "/options.html", "/popup.html"].includes(url.pathname)) {
      const file = url.pathname === "/popup.html" ? "popup.html" : "options.html";
      const html = fs.readFileSync(path.join(root, file), "utf8")
        .replace('<script src="ui-settings.js">', '<script src="/preview.js"></script><script src="ui-settings.js">');
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      return response.end(html);
    }
    if (url.pathname === "/preview.js") {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      return response.end(`
        const previewParams = new URLSearchParams(location.search);
        const previewListeners = [];
        const previewConfig = {
          session_name: "XIPU AI Bridge", port: 8765, default_model: "", thinking: "minimal", online: false,
          chat_timeout_seconds: 300, model_timeout_seconds: 30, idle_timeout_seconds: 90, include_reasoning: true
        };
        let activePort = 8765;
        const previewStore = {
          bridgeStatus: previewParams.get("state") || "ready", bridgeError: "",
          apiKey: "preview-only-key-not-valid", baseURL: "http://127.0.0.1:8765/v1",
          sessionName: "XIPU AI Bridge", transport: "native-messaging", theme: previewParams.get("theme") || "system",
          restartRequired: false
        };
        function publish(values) {
          Object.assign(previewStore, values);
          const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, {newValue}]));
          for (const listener of previewListeners) listener(changes, "local");
        }
        const snapshot = () => ({ok:true, config:{...previewConfig}, ...previewStore});
        globalThis.chrome = {
          runtime: {
            id: "abcdefghijklmnopabcdefghijklmnop",
            openOptionsPage: async () => { location.href = "/?theme=" + encodeURIComponent(previewStore.theme); },
            sendMessage: async ({type, config}) => {
              if (previewParams.get("fail") === type) return {ok:false, error:"Preview: the native app rejected this action."};
              if (type === "reconnect") {
                publish({bridgeStatus:"offline"});
                setTimeout(() => { activePort = previewConfig.port; publish({bridgeStatus:"ready", baseURL:"http://127.0.0.1:" + activePort + "/v1", restartRequired:false}); }, 50);
                return {ok:true};
              }
              if (previewStore.bridgeStatus === "offline") return {ok:false, error:"The native app is offline. Reconnect to edit settings."};
              if (type === "getSettings") return snapshot();
              if (previewStore.bridgeStatus === "busy") return {ok:false, error:"A request is in progress. Wait before changing settings."};
              if (type === "saveSettings") {Object.assign(previewConfig, config); publish({sessionName:config.session_name, restartRequired:config.port !== activePort}); return snapshot();}
              if (type === "rotateKey") {publish({apiKey:"preview-replacement-key-not-valid"}); return {ok:true, apiKey:previewStore.apiKey};}
              if (type === "inspectSchool") return {ok:true, models:[{id:"example-local",name:"Example local model"},{id:"example-paid",name:"Example paid model"}], sessions:[
                {id:1,name:"XIPU AI Bridge",model:"example-local",contextCount:0},
                {id:2,name:"Research session",model:"example-paid",contextCount:0},
                {id:3,name:"Regular chat",model:"example-local",contextCount:6},
                {id:4,name:"Duplicate name",model:"example-local",contextCount:0},
                {id:5,name:"Duplicate name",model:"example-paid",contextCount:0}
              ]};
              return {ok:false,error:"Unknown preview operation."};
            }
          },
          storage:{local:{get:async()=>({...previewStore}),set:async values=>publish(values)},onChanged:{addListener:callback=>previewListeners.push(callback)}}
        };
        Object.defineProperty(navigator,"clipboard",{value:{writeText:async()=>{
          if (previewParams.get("clipboard") === "fail") throw new Error("Preview clipboard failure");
        }}});
      `);
    }
    const file = url.pathname.slice(1);
    if (!assets.has(file)) { response.writeHead(404); return response.end(); }
    const mime = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
    response.setHeader("Content-Type", mime[path.extname(file)]);
    response.end(fs.readFileSync(path.join(root, file)));
  });
  server.listen(0, "127.0.0.1", () => {
    console.log(`Synthetic UI preview: http://127.0.0.1:${server.address().port}${startPath}?theme=light&state=ready`);
    console.log("Options: theme=system|light|dark; state=ready|busy|offline|no-tab; fail=saveSettings|rotateKey|inspectSchool; clipboard=fail");
  });
  return server;
}
module.exports = { startPreview };
if (require.main === module) startPreview();
