(() => {
  const SOURCE = "xipu-bridge";
  const ERROR_CODES = new Set(["unsupported_image_model", "unsupported_file_frontend", "attachment_limit_exceeded", "attachment_upload_failed", "debug_web_session_unavailable",
    "school_auth_required", "school_rate_limited", "school_http_error", "school_rejected", "school_invalid_response", "school_network_error",
    "school_stream_incomplete", "school_stream_error", "school_session_not_found", "school_session_ambiguous", "school_session_unsafe", "school_session_update_failed", "school_model_unavailable"]);
  const ERROR_STAGES = new Set(["authentication", "model_catalog", "session_read", "session_create", "session_configure", "session_update", "attachment_upload", "generation", "stream"]);
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
      const error = ERROR_CODES.has(event.data.code) ? event.data : {};
      port.postMessage({ type: "evt", evt: {
        job: event.data.job, kind: event.data.kind, event: event.data.event,
        result: event.data.result, message: event.data.message,
        ...(error.code ? { code: error.code } : {}),
        ...(ERROR_STAGES.has(error.stage) ? { stage: error.stage } : {}),
        ...(Number.isInteger(error.http_status) && error.http_status >= 100 && error.http_status <= 599 ? { http_status: error.http_status } : {}),
        ...(Number.isSafeInteger(error.school_code) ? { school_code: error.school_code } : {}),
        ...(error.code === "attachment_upload_failed" && Number.isInteger(error.attachment_index)
          && error.attachment_index >= 0 && error.attachment_index < 10 ? { attachment_index: error.attachment_index } : {})
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
