(() => {
  const API = "https://xipuai.xjtlu.edu.cn/jmapi";
  const SOURCE = "xipu-bridge";
  const controllers = new Map();
  const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  const FILE_TYPES = { pdf: "application/pdf", txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv" };
  const ERROR_CODES = new Set(["unsupported_image_model", "unsupported_file_frontend", "attachment_limit_exceeded", "attachment_upload_failed", "debug_web_session_unavailable",
    "school_auth_required", "school_rate_limited", "school_http_error", "school_rejected", "school_invalid_response", "school_network_error",
    "school_stream_incomplete", "school_stream_error", "school_session_not_found", "school_session_ambiguous", "school_session_unsafe", "school_session_update_failed", "school_model_unavailable"]);
  const OPERATION_STAGES = { "Load model catalog": "model_catalog", "Read school session": "session_read", "Create school session": "session_create",
    "Configure school session": "session_configure", "Update school session": "session_update", "Upload attachment": "attachment_upload", "Generate response": "generation" };
  const ERROR_STAGES = new Set(["authentication", ...Object.values(OPERATION_STAGES), "stream"]);

  function errorFields(error = {}) {
    if (!ERROR_CODES.has(error?.code)) return {};
    return { code: error.code,
      ...(ERROR_STAGES.has(error.stage) ? { stage: error.stage } : {}),
      ...(Number.isInteger(error.http_status) && error.http_status >= 100 && error.http_status <= 599 ? { http_status: error.http_status } : {}),
      ...(Number.isSafeInteger(error.school_code) ? { school_code: error.school_code } : {}),
      ...(error.code === "attachment_upload_failed" && Number.isInteger(error.attachment_index) && error.attachment_index >= 0 && error.attachment_index < 10 ? { attachment_index: error.attachment_index } : {}) };
  }

  function diagnosticError(message, code, stage, httpStatus) {
    return Object.assign(new Error(message), { code, stage, ...(httpStatus !== undefined ? { http_status: httpStatus } : {}) });
  }

  function modernChat() { return /^\/chat\/?$/.test(location.pathname); }

  function validateAttachmentCount(items, limit) {
    if (!Array.isArray(items)) throw new Error("Invalid attachment list.");
    if (items.length > limit) throw Object.assign(new Error(`This school frontend supports at most ${limit} attachment${limit === 1 ? "" : "s"} per request. No attachment was uploaded.`), { code: "attachment_limit_exceeded" });
  }

  function validateImages(images = []) {
    validateAttachmentCount(images, 10);
    let total = 0;
    for (const image of images) {
      const data = image?.data;
      if (!IMAGE_TYPES.has(image?.mime) || typeof image?.name !== "string" || !image.name || image.name.length > 255
        || typeof data !== "string" || !data || data.length > Math.ceil(10 * 1024 * 1024 / 3) * 4
        || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new Error("Invalid image data. Use PNG, JPEG, WebP or GIF images up to 10 MiB each.");
      }
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      if (btoa(atob(data.slice(-4))) !== data.slice(-4)) throw new Error("Invalid image encoding.");
      const size = data.length / 4 * 3 - padding;
      total += size;
      if (!size || size > 10 * 1024 * 1024 || total > 16 * 1024 * 1024) throw new Error("Images exceeded the request size limit.");
      const start = atob(data.slice(0, 16));
      const valid = image.mime === "image/png" ? start.startsWith("\x89PNG\r\n\x1a\n")
        : image.mime === "image/jpeg" ? start.startsWith("\xff\xd8\xff")
          : image.mime === "image/gif" ? /^GIF8[79]a/.test(start)
            : start.startsWith("RIFF") && start.slice(8, 12) === "WEBP";
      if (!valid) throw new Error("The image content did not match its declared type.");
    }
    return images;
  }

  function validateAttachments(payload) {
    if (payload.attachments === undefined) return validateImages(payload.images).map(image => ({ ...image, kind: "image" }));
    if (payload.images !== undefined) throw new Error("Use attachments or images, not both.");
    const attachments = payload.attachments;
    validateAttachmentCount(attachments, 10);
    if (attachments.some(item => !item || !["image", "file"].includes(item.kind))) throw new Error("Invalid attachment kind.");
    validateImages(attachments.filter(item => item.kind === "image"));
    let total = 0;
    for (const item of attachments) {
      const { name, mime, data } = item;
      if (item.kind === "file") {
        const extension = typeof name === "string" ? /\.([^.]+)$/.exec(name)?.[1].toLowerCase() : "";
        if (typeof name !== "string" || name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name)
          || /[. ]$/.test(name) || !Object.hasOwn(FILE_TYPES, extension) || FILE_TYPES[extension] !== mime
          || typeof data !== "string" || !data || data.length > Math.ceil(10 * 1024 * 1024 / 3) * 4
          || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
          throw new Error("Invalid file data. Use PDF, TXT, Markdown or CSV files up to 10 MiB each with a matching filename and type.");
        }
        if (btoa(atob(data.slice(-4))) !== data.slice(-4)) throw new Error("Invalid file encoding.");
        const raw = atob(data);
        if (mime === "application/pdf") {
          if (!/^%PDF-[12]\.[0-9]/.test(raw) || !raw.slice(-1024).includes("%%EOF")) throw new Error("Invalid PDF signature.");
        } else {
          let text;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(raw, character => character.charCodeAt(0))); }
          catch { throw new Error("Text files must use valid UTF-8."); }
          if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw new Error("Text files must not contain binary control characters.");
        }
      }
      const size = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
      total += size;
      if (!size || size > 10 * 1024 * 1024 || total > 16 * 1024 * 1024) throw new Error("Attachments exceeded the request size limit.");
    }
    return attachments;
  }

  function emit(job, message, signal) {
    if (signal && (signal.aborted || controllers.get(job)?.signal !== signal)) return;
    window.postMessage({ source: SOURCE, type: "evt", job, ...message }, location.origin);
  }

  function readToken() {
    // The frontends use different persistence formats; read their hydrated stores.
    const stores = document.querySelector("#app")?.__vue_app__?.config?.globalProperties?.$pinia?.state?.value;
    const user = modernChat() ? stores?.[btoa("__XP_JM_USER__")]?.data : stores?.user;
    if (typeof user?.token === "string" && user.token) return user.token;
    if (modernChat()) return "";
    try {
      const stored = JSON.parse(localStorage.getItem(btoa("__XP_JM_USER__")) || "null");
      const token = stored?.token || stored?.state?.token;
      return typeof token === "string" ? token : "";
    } catch { return ""; }
  }

  function schoolError(body, fallback, operation = "", errorCode = "school_rejected", httpStatus) {
    const message = [body?.msg, body?.message].find(value => typeof value === "string" && value.trim());
    const code = body?.code;
    const numericCode = Number.isSafeInteger(code)
      || (typeof code === "string" && /^-?\d{1,16}$/.test(code) && Number.isSafeInteger(Number(code)));
    const detail = message || `${fallback}${numericCode ? ` (school code ${code})` : ""}`;
    const prefix = operation && operation !== "Upload attachment" ? `${operation}: ` : "";
    const error = diagnosticError(`${prefix}${detail}`, errorCode, OPERATION_STAGES[operation], httpStatus);
    if (numericCode) error.school_code = Number(code);
    return error;
  }

  function check(body, operation = "", httpStatus) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw schoolError(null, "The school API returned an invalid response object.", operation, "school_invalid_response", httpStatus);
    }
    if (body?.code !== undefined && body.code !== 0 && body.code !== "0") {
      throw schoolError(body, "The school API rejected the request", operation, "school_rejected", httpStatus);
    }
    if (body?.data?.errorjson) {
      throw schoolError(null, "The school reported a generation failure", operation, "school_rejected", httpStatus);
    }
    return body;
  }

  async function asJSON(response, operation = "") {
    const httpCode = response.status === 401 ? "school_auth_required" : response.status === 429 ? "school_rate_limited" : "school_http_error";
    if ([502, 503, 504].includes(response.status)) {
      throw schoolError(null, `The school service is temporarily unavailable (HTTP ${response.status}). Try again later; no automatic retry was made.`, operation, httpCode, response.status);
    }
    let body;
    try { body = await response.json(); }
    catch (error) {
      if (error?.name === "AbortError") throw error;
      const invalid = error?.name === "SyntaxError";
      const message = invalid ? `The school API returned invalid JSON (HTTP ${response.status}). Check the logged-in tab.`
        : `The school response body could not be read (HTTP ${response.status}).`;
      throw schoolError(null, message, operation, response.ok ? (invalid ? "school_invalid_response" : "school_network_error") : httpCode, response.status);
    }
    if (!response.ok) throw schoolError(body, `HTTP ${response.status}`, operation, httpCode, response.status);
    return check(body, operation, response.status);
  }

  async function schoolFetch(url, options, operation) {
    try { return await window.fetch(url, options); }
    catch (error) {
      if (options.signal?.aborted || error?.name === "AbortError") throw error;
      throw schoolError(null, "The school network request failed.", operation, "school_network_error");
    }
  }

  async function loadCatalog(options, lang, modern) {
    const path = modern ? "/api/v2/chat/configV3" : "/api/chat/config";
    const body = await asJSON(await schoolFetch(`${API}${path}?lang=${encodeURIComponent(lang)}`, options, "Load model catalog"), "Load model catalog");
    const models = modern ? body?.data?.model?.chat?.list : body?.data?.models;
    if (!Array.isArray(models)) throw diagnosticError("The school API returned an invalid model list.", "school_invalid_response", "model_catalog");
    return { code: body.code, data: { models } };
  }

  function validSessionID(id) {
    return typeof id === "string" ? !!id.trim() && id === id.trim()
      : Number.isSafeInteger(id) && id > 0;
  }

  function sameSessionID(left, right) {
    return validSessionID(left) && validSessionID(right) && String(left) === String(right);
  }

  async function setupSession(job, op, payload, options, lang, state, modern) {
    for (const field of ["name", "model"]) {
      const value = payload[field];
      if (typeof value !== "string" || !value || value !== value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error(`Specify a valid setup ${field}, using at most 200 characters on one line.`);
      }
    }
    if ((op === "setup_configure" || (op === "setup_check" && payload.session_id !== undefined)) && !validSessionID(payload.session_id)) {
      throw new Error("Resume setup with the confirmed school session ID.");
    }
    if (op !== "setup_check") {
      options.signal.throwIfAborted();
      const catalog = await loadCatalog(options, lang, modern);
      if (!catalog.data.models.some(item => (typeof item === "string" ? item : item?.value || item?.model || item?.name) === payload.model)) {
        throw diagnosticError("The requested model is not available in the school model list.", "school_model_unavailable", "model_catalog");
      }
    }
    async function readSessions() {
      options.signal.throwIfAborted();
      const body = await asJSON(await schoolFetch(`${API}/api/chat/session?lang=${encodeURIComponent(lang)}`, options, "Read school session"), "Read school session");
      if (!Array.isArray(body?.data) || body.data.some(item => !item || typeof item !== "object" || Array.isArray(item)
        || !validSessionID(item.id) || typeof item.name !== "string")) {
        throw diagnosticError("The school API returned an invalid session list.", "school_invalid_response", "session_read");
      }
      return body.data;
    }
    async function saveSession(body, operation) {
      options.signal.throwIfAborted();
      if (op === "setup_create") state.createAttempted = true;
      const saved = await asJSON(await schoolFetch(`${API}/api/chat/saveSession`, {
        ...options, method: "POST", headers: { ...options.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, lang })
      }, operation), operation);
      if (!saved || typeof saved !== "object" || Array.isArray(saved) || (saved.code !== 0 && saved.code !== "0")) {
        throw diagnosticError(`${operation}: The school API returned an invalid acknowledgement.`, "school_invalid_response", OPERATION_STAGES[operation]);
      }
      return saved;
    }
    function exactSession(sessions) {
      const matches = sessions.filter(item => item.name === payload.name);
      if (!matches.length && op === "setup_check") return null;
      if (!matches.length) throw diagnosticError("The created conversation is missing or has been renamed. Refresh XIPU AI, then resume setup with its original name.", "school_session_not_found", "session_read");
      if (matches.length !== 1) throw diagnosticError("Multiple conversations have the setup name. Give each conversation a unique name before resuming setup.", "school_session_ambiguous", "session_read");
      if (payload.session_id !== undefined && !sameSessionID(matches[0].id, payload.session_id)) throw diagnosticError("The conversation with the setup name has a different ID. Select the intended conversation in Settings.", "school_session_unsafe", "session_read");
      if (sessions.filter(item => sameSessionID(item.id, matches[0].id)).length !== 1) throw diagnosticError("The school returned a duplicate conversation ID. Refresh XIPU AI before resuming setup.", "school_session_ambiguous", "session_read");
      return matches[0];
    }
    const sessions = await readSessions();
    if (op === "setup_check") {
      const session = exactSession(sessions);
      if (session && typeof session.model !== "string") throw diagnosticError("The school API returned an invalid session model.", "school_invalid_response", "session_read");
      emit(job, { kind: "result", result: { session: session ? {
        id: session.id, name: session.name, model: session.model,
        contextCount: typeof session.contextCount === "number" ? session.contextCount : null,
        promptEmpty: session.prompt === ""
      } : null } }, options.signal);
      return;
    }
    if (op === "setup_create") {
      if (sessions.some(item => item.name === payload.name)) {
        throw diagnosticError("A school session already has this name. Choose a new name or select the existing session in settings.", "school_session_ambiguous", "session_create");
      }
      const saved = await saveSession({ name: payload.name }, "Create school session");
      const created = saved.data;
      if (!created || typeof created !== "object" || Array.isArray(created) || !validSessionID(created.id)
        || (Object.hasOwn(created, "name") && created.name !== payload.name)
        || sessions.some(item => sameSessionID(item.id, created.id))) {
        throw diagnosticError("The school API did not confirm a new session identity. Inspect the school session list before starting another setup.", "school_invalid_response", "session_create");
      }
      // Return a confirmed identity immediately so the extension can persist recovery state.
      emit(job, { kind: "result", result: { session: { id: created.id, name: payload.name } } }, options.signal);
      return;
    }
    let session = exactSession(sessions);
    const configured = value => value.model === payload.model && value.contextCount === 0 && value.prompt === "";
    if (!configured(session)) {
      await saveSession({ ...session, model: payload.model, contextCount: 0, prompt: "" }, "Configure school session");
      session = exactSession(await readSessions());
      if (!configured(session)) {
        throw diagnosticError("The school session did not retain the requested model, Context Count 0 and empty prompt. Setup is incomplete.", "school_session_update_failed", "session_configure");
      }
    }
    options.signal.throwIfAborted();
    emit(job, { kind: "result", result: { session: {
      id: session.id, name: session.name, model: session.model, contextCount: session.contextCount
    } } }, options.signal);
  }

  async function pump(job, response, signal) {
    signal.throwIfAborted();
    if (!(response.headers.get("content-type") || "").includes("text/event-stream")) {
      emit(job, { kind: "event", event: await asJSON(response, "Generate response") }, signal);
      return;
    }
    if (!response.ok) await asJSON(response, "Generate response");
    if (!response.body) throw diagnosticError(`HTTP ${response.status}`, "school_invalid_response", "stream", response.status);
    const reader = response.body.getReader();
    const cancelReader = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancelReader, { once: true });
    const decoder = new TextDecoder();
    let buffer = "", data = [], size = 0, finished = false;

    function line(value) {
      if (value === "") {
        const frame = data.join("\n");
        data = []; size = 0;
        if (!frame) return;
        if (frame === "[DONE]") { finished = true; return; }
        let event;
        try { event = JSON.parse(frame); }
        catch { throw diagnosticError("The school API returned an invalid SSE event.", "school_stream_error", "stream", response.status); }
        emit(job, { kind: "event", event: check(event, "Generate response", response.status) }, signal);
      } else if (value === "data" || value.startsWith("data:")) {
        const part = value === "data" ? "" : value.slice(5).replace(/^ /, "");
        size += part.length + 1;
        if (size > 1024 * 1024) throw diagnosticError("The school API event exceeded the size limit.", "school_stream_error", "stream", response.status);
        data.push(part);
      }
    }

    function consume(eof = false) {
      while (!finished) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (!eof && end === buffer.length - 1 && buffer[end] === "\r")) break;
        const value = buffer.slice(0, end);
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(end + width);
        line(value);
      }
      if (buffer.length > 1024 * 1024) throw diagnosticError("The school API event exceeded the size limit.", "school_stream_error", "stream", response.status);
      if (eof && !finished) {
        // The school frontends finish on clean EOF; [DONE] is optional.
        if (buffer || data.length) {
          if (buffer) line(buffer);
          if (data.length && data.join("\n") !== "[DONE]") throw diagnosticError("The school stream ended with an incomplete SSE event; the response may be incomplete.", "school_stream_incomplete", "stream", response.status);
        }
        finished = true;
      }
    }

    try {
      while (!finished) {
        signal.throwIfAborted();
        let chunk;
        try { chunk = await reader.read(); }
        catch (error) {
          if (signal.aborted || error?.name === "AbortError") throw error;
          throw diagnosticError("The school response stream could not be read; the response may be incomplete.", "school_stream_error", "stream", response.status);
        }
        const { value, done } = chunk;
        signal.throwIfAborted();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        consume(done);
        if (done) break;
      }
    } finally {
      signal.removeEventListener("abort", cancelReader);
      try { await reader.cancel(); } catch { /* Preserve the original stream failure. */ }
      finally { reader.releaseLock(); }
    }
  }

  function webSendError(message) {
    return Object.assign(new Error(`Webpage send: ${message}`), { code: "debug_web_session_unavailable" });
  }

  function webSendTarget(session, payload) {
    const fail = detail => { throw webSendError(`${detail} No completion was sent.`); };
    const composers = [...document.querySelectorAll("textarea")].filter(element => element.getClientRects().length);
    if (composers.length !== 1) fail("Open the legacy /v3/chat page with the dedicated conversation visible.");
    const composer = composers[0], root = document.querySelector("#app");
    if (!root || !root.contains(composer)) fail("The visible composer is outside the official chat app.");
    if (root.inert) fail("Wait for the active webpage bridge operation to finish.");
    let input = composer.__vueParentComponent;
    while (input && input.type?.__name !== "ChatInput") input = input.parent;
    if (!input) {
      // The production Vue bundle omits element parent hooks but retains the mounted root vnode.
      if (!root._vnode?.component) fail("The mounted Vue app tree is unavailable; reload the legacy chat page.");
      const candidates = new Set();
      visit(root._vnode, node => {
        const component = node.component;
        if (component?.type?.__name !== "ChatInput" || component.isUnmounted) return;
        visit(component.subTree, child => { if (child.el === composer) candidates.add(component); });
      });
      if (candidates.size !== 1) fail("The visible composer could not be matched to one official ChatInput component.");
      [input] = candidates;
    }
    if (input.isUnmounted) fail("The official composer was unmounted; wait for the page to finish loading.");
    if (typeof input.vnode?.props?.onSend !== "function") fail("The official ChatInput send handler is unavailable or has changed.");
    const item = input.props?.item;
    if (!sameSessionID(item?.id, session.id) || item.name !== payload.session_name
      || item.model !== payload.model || session.model !== payload.model || item.contextCount !== 0) {
      fail("Select the dedicated conversation and requested model in the webpage, with Context Count 0.");
    }
    // The legacy first-message handler always renames an empty conversation.
    if (!Number.isSafeInteger(input.props.showExport) || input.props.showExport < 1 || input.props.disableClearBtn !== false) {
      fail("Load a conversation with existing messages; an empty conversation would be renamed by the webpage.");
    }
    if (composer.value !== "") fail("Clear or save the existing webpage draft first.");
    function visit(node, inspect, seen = new Set()) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      if (seen.size >= 10000) fail("The official chat page is too complex to verify.");
      seen.add(node);
      if (Array.isArray(node)) { for (const child of node) visit(child, inspect, seen); return; }
      inspect(node);
      visit(node.children, inspect, seen);
      visit(node.component?.subTree, inspect, seen);
    }
    let attachmentCounts = 0;
    visit(input.subTree, node => {
      const props = node.props;
      // ChatInput's upload badge reflects its pending attachment array, even with the dialog closed.
      if (props?.max === 15 && Number.isSafeInteger(props.value)) {
        attachmentCounts++;
        if (props.value !== 0) fail("Remove the pending webpage attachments first.");
      }
      if (props?.preset === "dialog" && props.show) fail("Close the webpage upload dialog first.");
    });
    if (attachmentCounts !== 1) fail("The webpage attachment state could not be verified.");
    let chat = input.parent;
    while (chat && chat.type?.__name !== "chat") chat = chat.parent;
    if (!chat) fail("The official chat component could not be verified.");
    visit(chat.subTree, node => {
      if (node.props?.loading === true) fail("Wait for the active webpage operation to finish.");
      if (node.props?.show === true) fail("Wait for webpage history to load and close open dialogs first.");
    });
    const messages = () => {
      const result = [];
      visit(chat.subTree, node => { if (node.type?.__name === "MessageGroup") result.push(node.props); });
      return result;
    };
    const existing = messages(), stop = existing.at(-1)?.onStop;
    if (existing.length !== input.props.showExport || typeof stop !== "function"
      || existing.some(message => message.onStop !== stop)) fail("The webpage message and stop interfaces could not be verified.");
    return { input, root, send: input.vnode.props.onSend, messages, stop, previous: existing.at(-1).item };
  }

  async function sendFromWeb(job, target, session, payload, files, options, lang) {
    if (webSendTarget(session, payload).input !== target.input) throw webSendError("The visible conversation changed. No completion was sent.");
    const originalFetch = window.fetch, priorInert = target.root.inert, controller = new AbortController();
    const expected = { text: payload.text, files, online: payload.online ? 1 : 0, thinking: payload.thinking || "minimal", sessionId: session.id, lang };
    let resolveResponse, rejectResponse, rejectStopped, pageSignal, pageAbort, requested = false, active = true;
    const responseReady = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    const stopped = new Promise((_, reject) => { rejectStopped = reject; });
    function stop(message, unavailable = false) {
      controller.abort();
      const error = unavailable ? webSendError(message) : new Error(message);
      rejectResponse(error); rejectStopped(error);
    }
    const cancelled = () => stop("The school request was cancelled.");
    const timer = setTimeout(() => stop("The official page did not start the request in time; it was not retried.", true), 10000);
    function refuse(message) {
      const error = webSendError(message);
      rejectResponse(error); rejectStopped(error);
      throw error;
    }
    const intercepted = async (url, init) => {
      const address = typeof url === "string" ? url : url?.url;
      if (!/\/api\/chat\/completions(?:[?#]|$)/.test(address || "")) return originalFetch.call(window, url, init);
      if (url !== `${API}/api/chat/completions`) refuse("The official completion destination changed.");
      if (!active || requested || options.signal.aborted) refuse("A cancelled or duplicate completion was blocked.");
      const visible = target.input.props?.item;
      if (!sameSessionID(visible?.id, session.id) || visible?.name !== payload.session_name
        || visible?.model !== payload.model || visible?.contextCount !== 0) refuse("The visible conversation changed. No completion was sent.");
      let body;
      try { body = JSON.parse(init?.body); } catch { refuse("The official request format changed."); }
      if (init?.method !== "POST" || !body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some(key => ![...Object.keys(expected), "responseId"].includes(key))
        || Object.entries(expected).some(([key, value]) => JSON.stringify(body[key]) !== JSON.stringify(value))) {
        refuse("The official request did not match the verified bridge request.");
      }
      requested = true;
      clearTimeout(timer);
      // Keep stateless client replay isolated while the official handler updates its visible messages.
      body.responseId = null;
      pageSignal = init.signal;
      pageAbort = () => stop("Webpage send: The official page cancelled the request.");
      pageSignal?.addEventListener("abort", pageAbort, { once: true });
      if (pageSignal?.aborted) pageAbort();
      try {
        const response = await originalFetch.call(window, url, { ...init, body: JSON.stringify(body), signal: controller.signal });
        if (!active || controller.signal.aborted) {
          await response.body?.cancel();
          throw new Error("The school request was cancelled.");
        }
        resolveResponse(response.clone());
        return response;
      } catch (error) { rejectResponse(error); throw error; }
    };
    options.signal.addEventListener("abort", cancelled, { once: true });
    target.root.inert = true;
    window.fetch = intercepted;
    try {
      options.signal.throwIfAborted();
      let officialError;
      const official = Promise.resolve().then(() => target.send({ ...expected })).catch(error => {
        officialError = error?.code === "debug_web_session_unavailable" ? error
          : new Error("Webpage send: The official page could not complete its send flow.");
        rejectResponse(officialError);
      });
      const response = await Promise.race([responseReady, stopped]);
      await Promise.race([Promise.all([pump(job, response, options.signal), official]), stopped]);
      if (officialError) throw officialError;
    } finally {
      active = false;
      controller.abort();
      clearTimeout(timer);
      options.signal.removeEventListener("abort", cancelled);
      pageSignal?.removeEventListener("abort", pageAbort);
      if (window.fetch === intercepted) window.fetch = originalFetch;
      target.root.inert = priorInert;
      // The legacy fetch rejects before clearing loading on network/HTTP failures.
      // Its public Stop handler clears that state, but also appends to the last message.
      await Promise.resolve();
      const item = target.input.props?.item, last = target.messages().at(-1);
      if (!target.input.isUnmounted && sameSessionID(item?.id, session.id) && item?.name === payload.session_name
        && item?.model === payload.model && last?.loading === true && last.onStop === target.stop
        && last.item !== target.previous && last.item?.userText === payload.text && last.item?.model === payload.model
        && last.item?.userFile === (files[0] || null)) target.stop();
    }
  }

  async function run(job, op, payload, state) {
    if (!/^\/(?:v3\/)?chat\/?$/.test(location.pathname)) throw new Error("Open an XIPU AI /chat or /v3/chat page first.");
    const modern = modernChat();
    const attachments = op === "chat" ? validateAttachments(payload) : [];
    if (attachments.some(item => item.kind === "file") && (!modern || payload.debug_web_session === true)) {
      throw Object.assign(new Error("File input requires the /chat frontend with Use webpage send flow turned off. No file was uploaded."), { code: "unsupported_file_frontend" });
    }
    if (!modern) validateAttachmentCount(attachments, 1);
    if (modern && op === "chat" && payload.debug_web_session === true) {
      throw webSendError("Use webpage send flow currently requires /v3/chat. Turn it off to use /chat. No completion was sent.");
    }
    const token = readToken();
    if (!token) throw diagnosticError("Sign in to XIPU AI in this tab first.", "school_auth_required", "authentication");
    const lang = localStorage.getItem(btoa("__XP_JM_LANG__")) || "zh";
    const options = { credentials: "include", signal: controllers.get(job).signal, headers: { "Jm-Token": token } };
    if (modern) Object.assign(options.headers, { "x-lang": lang, "x-platform": "web" });
    if (op === "models" || op === "inspect") {
      const catalog = await loadCatalog(options, lang, modern);
      if (op === "models") {
        emit(job, { kind: "result", result: catalog }, options.signal);
        return;
      }
      options.signal.throwIfAborted();
      const listing = await schoolFetch(`${API}/api/chat/session?lang=${encodeURIComponent(lang)}`, options, "Read school session");
      const sessions = await asJSON(listing, "Read school session");
      if (!Array.isArray(catalog?.data?.models) || !Array.isArray(sessions?.data)) {
        throw diagnosticError("The school API returned an invalid model or session list.", "school_invalid_response", "session_read");
      }
      // Only display metadata crosses into the settings page, never tokens or chat history.
      const models = catalog.data.models.map(item => {
        const id = typeof item === "string" ? item : item?.value || item?.model || item?.name;
        return { id, name: typeof item === "string" ? item : item?.label || item?.name || id };
      }).filter(item => typeof item.id === "string" && typeof item.name === "string");
      emit(job, { kind: "result", result: {
        models,
        sessions: sessions.data.filter(item => item && typeof item.name === "string" && typeof item.model === "string"
          && ["string", "number"].includes(typeof item.id))
          .map(({ id, name, model, contextCount }) => ({ id, name, model, contextCount: typeof contextCount === "number" ? contextCount : null }))
      }}, options.signal);
      return;
    }
    if (["setup_create", "setup_configure", "setup_check"].includes(op)) {
      await setupSession(job, op, payload, options, lang, state, modern);
      return;
    }
    if (typeof payload.session_name !== "string" || !payload.session_name.trim()) {
      throw diagnosticError("Configure a dedicated school session before sending chat requests.", "school_session_not_found", "session_read");
    }
    if (typeof payload.model !== "string" || !payload.model.trim()) throw diagnosticError("Specify a school model.", "school_model_unavailable", "model_catalog");
    let catalog;
    async function requestedModel() {
      if (!catalog) {
        options.signal.throwIfAborted();
        catalog = await loadCatalog(options, lang, modern);
      }
      if (!Array.isArray(catalog?.data?.models)) throw diagnosticError("The school API returned an invalid model list.", "school_invalid_response", "model_catalog");
      const model = catalog.data.models.find(item => (typeof item === "string" ? item : item?.value || item?.model || item?.name) === payload.model);
      if (!model) throw diagnosticError("The requested model is not available in the school model list.", "school_model_unavailable", "model_catalog");
      return model;
    }
    async function readSession() {
      options.signal.throwIfAborted();
      const response = await schoolFetch(`${API}/api/chat/session?lang=${encodeURIComponent(lang)}`, options, "Read school session");
      const body = await asJSON(response, "Read school session");
      if (!Array.isArray(body?.data)) throw diagnosticError("The school API returned an invalid session list.", "school_invalid_response", "session_read", response.status);
      const matches = body.data.filter(item => item?.name === payload.session_name);
      if (matches.length !== 1) throw diagnosticError(`Exactly one school session must be named "${payload.session_name}".`, matches.length ? "school_session_ambiguous" : "school_session_not_found", "session_read");
      const session = matches[0];
      if (!validSessionID(session.id)) throw diagnosticError("The school API did not return a valid session ID.", "school_invalid_response", "session_read");
      if (session.contextCount !== 0) throw diagnosticError("The dedicated session must use Context Count 0. No completion was sent.", "school_session_unsafe", "session_read");
      return { session, status: response.status, code: body.code };
    }
    if (attachments.some(item => item.kind === "image")) {
      const model = await requestedModel();
      if (model?.multimodal !== true && model?.multimodal !== 1) {
        throw Object.assign(new Error("The requested school model does not advertise image support. This request includes an image, possibly from conversation history. Use an image-capable model, start a text-only conversation, or enable Text-only image history in Settings for earlier images. No image was uploaded."), { code: "unsupported_image_model" });
      }
    }
    let selected = await readSession();
    let session = selected.session;
    const webTarget = payload.debug_web_session === true ? webSendTarget(session, payload) : null;
    if (session.model !== payload.model) {
      await requestedModel();
      options.signal.throwIfAborted();
      const saved = await asJSON(await schoolFetch(`${API}/api/chat/saveSession`, {
        ...options, method: "POST", headers: { ...options.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...session, model: payload.model, lang })
      }, "Update school session"), "Update school session");
      if (!saved || typeof saved !== "object" || Array.isArray(saved) || (saved.code !== 0 && saved.code !== "0")) {
        throw diagnosticError("The school API returned an invalid session update result.", "school_invalid_response", "session_update");
      }
      selected = await readSession();
      if (!sameSessionID(selected.session.id, session.id) || selected.session.model !== payload.model) {
        throw diagnosticError("The school session did not retain the requested model and identity. No completion was sent.", "school_session_update_failed", "session_update");
      }
      session = selected.session;
    }
    emit(job, { kind: "lifecycle", result: {
      path: "/api/chat/session", status: selected.status, code: selected.code,
      id: session.id, model: session.model, contextCount: session.contextCount
    }}, options.signal);
    const files = [];
    for (const [attachmentIndex, attachment] of attachments.entries()) {
      options.signal.throwIfAborted();
      try {
        const raw = atob(attachment.data);
        const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
        const form = new FormData();
        if (!modern) form.append("accept", "image");
        form.append("file", new File([bytes], attachment.name, { type: attachment.mime }));
        form.append("lang", lang);
        // Let fetch set the multipart boundary, as the official upload helper does.
        const uploaded = await asJSON(await schoolFetch(`${API}/api/common/upload`, { ...options, method: "POST", body: form }, "Upload attachment"), "Upload attachment");
        const url = uploaded?.data?.url || uploaded?.data?.file_url;
        if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("The school upload did not return a valid attachment URL.");
        files.push(url);
      } catch (error) {
        if (options.signal.aborted || error?.name === "AbortError") throw error;
        const operation = `Upload ${attachment.kind} ${attachmentIndex + 1}/${attachments.length} (${JSON.stringify(attachment.name)})`;
        throw Object.assign(new Error(`${operation}: ${error?.message || "The school upload failed."}`), {
          ...errorFields(error), code: "attachment_upload_failed", stage: "attachment_upload", attachment_index: attachmentIndex
        });
      }
    }
    options.signal.throwIfAborted();
    if (webTarget) {
      await sendFromWeb(job, webTarget, session, payload, files, options, lang);
      return;
    }
    const completion = await schoolFetch(`${API}${modern ? "/api/v2/chat/response" : "/api/chat/completions"}`, {
      ...options, method: "POST", headers: { ...options.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: payload.text, online: payload.online ? 1 : 0,
        thinking: payload.thinking || "minimal", sessionId: session.id, responseId: null,
        ...(modern ? { intent: "chat", attachments: files, options: null } : { files, lang })
      })
    }, "Generate response");
    await pump(job, completion, options.signal);
  }

  window.addEventListener("message", event => {
    // Sangfor can rewrite event.origin between the MAIN and isolated worlds.
    if (event.source !== window || event.data?.source !== SOURCE) return;
    const { job, type, op, payload } = event.data;
    if (typeof job !== "string" || !job || job.length > 128) return;
    if (type === "cancel") { controllers.get(job)?.abort(); return; }
    if (type !== "req" || controllers.has(job)) return;
    if (!["models", "chat", "inspect", "setup_create", "setup_configure", "setup_check"].includes(op) || controllers.size) {
      emit(job, { kind: "done", message: "Unsupported operation or another school request is active.",
        ...(op === "setup_create" ? { result: { notCreated: true } } : {}) });
      return;
    }
    const controller = new AbortController(), state = { createAttempted: false };
    let settled = false;
    function settle(message = "", error = {}) {
      if (settled) return;
      settled = true;
      controller.signal.removeEventListener("abort", cancelled);
      if (controllers.get(job) === controller) controllers.delete(job);
      emit(job, { kind: "done", ...(message ? { message } : {}),
        ...errorFields(error),
        ...(message && op === "setup_create" && !state.createAttempted ? { result: { notCreated: true } } : {}) });
    }
    const cancelled = () => settle("The school request was cancelled.");
    controllers.set(job, controller);
    controller.signal.addEventListener("abort", cancelled, { once: true });
    run(job, op, payload || {}, state).then(
      () => settle(),
      error => settle(error?.message || "The school request failed.", error)
    );
  });
})();
