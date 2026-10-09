// Ordinary web fixture with synthetic data only; no extension or native-host access.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const root = path.join(__dirname, "../extension");
const assets = new Set(["popup.js", "options.js", "setup.js", "ui-settings.js", "ui-controls.js", "styles/coss.css", "styles/brand.css", "styles/popup.css", "styles/options.css", "styles/setup.css", "icons/bridge.svg", "icons/icon-16.png", "icons/icon-24.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png"]);

function startPreview(startPath = "/") {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/popup-preview") {
      const search = url.search.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      return response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>XIPU AI Bridge preview</title><style>body{margin:0;padding:24px;background:#888;font:14px system-ui;color:#fff}p{margin:0 0 16px}iframe{display:block;width:380px;height:600px;border:0;border-radius:12px;box-shadow:0 8px 32px #0003}</style><p>Development preview · synthetic data · 380 × 600</p><iframe title="XIPU AI Bridge popup" src="/popup.html${search}"></iframe></html>`);
    }
    if (["/", "/options.html", "/popup.html", "/setup.html"].includes(url.pathname)) {
      const file = url.pathname === "/popup.html" ? "popup.html" : url.pathname === "/setup.html" ? "setup.html" : "options.html";
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
        const setupPage = location.pathname === "/setup.html";
        const previewConfig = {
          session_name: "XIPU AI Bridge", port: 8765, default_model: "", thinking: "minimal", online: false,
          chat_timeout_seconds: 300, model_timeout_seconds: 30, idle_timeout_seconds: 90, include_reasoning: true,
          omit_historical_images: false
        };
        let activePort = 8765;
        const previewStore = {
          bridgeStatus: previewParams.get("state") || "ready", bridgeError: "",
          apiKey: "preview-only-key-not-valid", baseURL: "http://127.0.0.1:8765/v1",
          sessionName: "XIPU AI Bridge", transport: "native-messaging", theme: previewParams.get("theme") || "system",
          restartRequired: false, onboardingComplete: previewParams.get("onboarded") === "1",
          setupRunning: previewParams.get("waiting") === "1"
        };
        let setupFailedOnce = false;
        const initialPhase = previewParams.get("phase");
        if (["creating", "created", "configured", "complete"].includes(initialPhase)) {
          previewStore.setupProgress = {name:"XIPU AI Bridge",model:"qwen3.6-27b",phase:initialPhase};
          if (initialPhase !== "creating") previewStore.setupProgress.session_id = "preview-created-session";
          if (initialPhase === "complete") previewConfig.default_model = previewParams.has("mismatch") ? "example-paid" : "qwen3.6-27b";
        }
        function publish(values) {
          Object.assign(previewStore, values);
          const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, {newValue}]));
          for (const listener of previewListeners) listener(changes, "local");
        }
        const snapshot = () => {
          const progress = previewStore.setupProgress;
          const setupSession = progress?.phase === "complete" && progress.name === previewConfig.session_name && progress.model === previewConfig.default_model
            ? {id:progress.session_id,name:progress.name,model:progress.model,contextCount:0} : null;
          return {ok:true, config:{...previewConfig}, ...previewStore, setupProgress:progress || null, setupSession};
        };
        globalThis.chrome = {
          runtime: {
            id: "abcdefghijklmnopabcdefghijklmnop",
            openOptionsPage: async () => { location.href = "/?theme=" + encodeURIComponent(previewStore.theme); },
            sendMessage: async ({type, config, name, model}) => {
              if (previewParams.get("fail") === type) return {ok:false, error:"Preview: the native app rejected this action."};
              if (type === "openSetup") {
                const search = new URLSearchParams(previewParams);
                search.set("theme", previewStore.theme);
                window.open("/setup.html?" + search.toString(), "_blank", "noopener");
                return {ok:true};
              }
              if (type === "skipSetup") { publish({onboardingComplete:true}); return {ok:true}; }
              if (type === "getSetupState") return snapshot();
              if (type === "cancelSetup") { publish({setupRunning:false,bridgeStatus:"ready"}); return snapshot(); }
              if (type === "reconnect") {
                publish({bridgeStatus:"offline"});
                setTimeout(() => { activePort = previewConfig.port; publish({bridgeStatus:"ready", baseURL:"http://127.0.0.1:" + activePort + "/v1", restartRequired:false}); }, 50);
                return {ok:true};
              }
              if (previewStore.bridgeStatus === "offline") return {ok:false, error:"The native app is offline. Reconnect to edit settings."};
              if (type === "getSettings") return snapshot();
              if (previewStore.bridgeStatus === "busy") return {ok:false, error:"A request is in progress. Wait before changing settings."};
              if (type === "saveSettings") {Object.assign(previewConfig, config); publish({sessionName:config.session_name, restartRequired:config.port !== activePort,onboardingComplete:true}); return snapshot();}
              if (type === "rotateKey") {publish({apiKey:"preview-replacement-key-not-valid"}); return {ok:true, apiKey:previewStore.apiKey};}
              if (type === "checkSetup") {
                if (previewStore.setupProgress?.phase === "creating") publish({setupProgress:{...previewStore.setupProgress,phase:"created",session_id:"preview-created-session"}});
                return snapshot();
              }
              if (type === "setupSchool") {
                const previous = previewStore.setupProgress;
                if (previous?.phase === "creating") return {ok:false,error:"The creation outcome is unknown. Inspect XIPU AI before continuing."};
                const progress = previous || {name,model,phase:"creating"};
                const partial = previewParams.get("partial");
                if (!setupFailedOnce && ["creating", "created", "configured"].includes(partial)) {
                  setupFailedOnce = true;
                  publish({setupProgress:{...progress,phase:partial,...(partial === "creating" ? {} : {session_id:"preview-created-session"})}});
                  return {ok:false,error:partial === "creating" ? "The connection was interrupted during creation." : "The conversation exists, but setup did not finish."};
                }
                Object.assign(previewConfig,{session_name:progress.name,default_model:progress.model});
                publish({sessionName:progress.name,onboardingComplete:true,setupProgress:{...progress,phase:"complete",session_id:"preview-created-session"}});
                return snapshot();
              }
              if (type === "inspectSchool") return {ok:true, models:[...(setupPage && !previewParams.has("no-free") ? [{id:"qwen3.6-27b",name:"Qwen (preview)"}] : []),{id:"example-local",name:"Example local model"},{id:"example-paid",name:"Example paid model"}], sessions:[
                {id:1,name:"XIPU AI Bridge",model:"example-local",contextCount:0},
                {id:2,name:"Research session",model:"example-paid",contextCount:0},
                {id:3,name:"Regular chat",model:"example-local",contextCount:6},
                {id:4,name:"Duplicate name",model:"example-local",contextCount:0},
                {id:5,name:"Duplicate name",model:"example-paid",contextCount:0}
              ].filter(session => !setupPage || previewParams.has("duplicate") || session.id !== 1)};
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
    console.log("Options: theme=system|light|dark; state=ready|busy|offline|no-tab; onboarded=1; fail=saveSettings|rotateKey|inspectSchool|setupSchool|skipSetup|openSetup; clipboard=fail");
    console.log("Setup: /setup.html; phase=creating|created|configured|complete; partial=creating|created|configured; waiting=1&state=busy; duplicate=1; no-free=1; mismatch=1");
  });
  return server;
}
module.exports = { startPreview };
if (require.main === module) startPreview();
