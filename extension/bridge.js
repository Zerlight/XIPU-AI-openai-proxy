(() => {
  const SOURCE = "xipu-bridge";
  let port = null;
  let currentJob = null;

  function connect() {
    // Extension reload invalidates the old content-script context.
    try {
      if (!chrome.runtime?.id) return;
      port = chrome.runtime.connect({ name: "xipu" });
    } catch { return; }
    port.onDisconnect.addListener(() => {
      if (currentJob) window.postMessage({ source: SOURCE, type: "cancel", job: currentJob }, location.origin);
      currentJob = null;
      port = null;
      setTimeout(connect, 500);
    });
    port.onMessage.addListener((message) => {
      if (!message || !["req", "cancel"].includes(message.type)) return;
      if (message.type === "req") currentJob = message.job;
      window.postMessage({
        source: SOURCE, type: message.type, job: message.job,
        op: message.op, payload: message.payload
      }, location.origin);
    });
  }

  window.addEventListener("message", (event) => {
    // Sangfor may rewrite origin strings across the MAIN/isolated worlds.
    // The window identity and the background's exact sender URL bind the page.
    if (event.source !== window || !event.data
      || event.data.source !== SOURCE || event.data.type !== "evt") return;
    if (!port || event.data.job !== currentJob) return;
    try {
      port.postMessage({ type: "evt", evt: {
        job: event.data.job, kind: event.data.kind, event: event.data.event,
        result: event.data.result, message: event.data.message
      }});
    } catch {
      // Reload can invalidate a context before onDisconnect is delivered.
      window.postMessage({ source: SOURCE, type: "cancel", job: currentJob }, location.origin);
      currentJob = null;
      port = null;
      return;
    }
    if (["done", "error"].includes(event.data.kind)) currentJob = null;
  });
  connect();
})();
