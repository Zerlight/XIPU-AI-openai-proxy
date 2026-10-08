(() => {
  const API = "https://xipuai.xjtlu.edu.cn/jmapi";
  const SOURCE = "xipu-bridge";
  const controllers = new Map();
  const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

  function validateImages(images = []) {
    if (!Array.isArray(images) || images.length > 4) throw new Error("Use at most four supported images per request.");
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

  function emit(job, message) {
    window.postMessage({ source: SOURCE, type: "evt", job, ...message }, location.origin);
  }

  function readToken() {
    // The official store persists with Zipson; prefer its hydrated state.
    const user = document.querySelector("#app")?.__vue_app__?.config?.globalProperties?.$pinia?.state?.value?.user;
    if (typeof user?.token === "string" && user.token) return user.token;
    try {
      const stored = JSON.parse(localStorage.getItem(btoa("__XP_JM_USER__")) || "null");
      const token = stored?.token || stored?.state?.token;
      return typeof token === "string" ? token : "";
    } catch { return ""; }
  }

  function schoolError(body, fallback, operation = "") {
    const message = [body?.msg, body?.message].find(value => typeof value === "string" && value.trim());
    const code = body?.code;
    const numericCode = Number.isSafeInteger(code)
      || (typeof code === "string" && /^-?\d{1,16}$/.test(code) && Number.isSafeInteger(Number(code)));
    const detail = message || `${fallback}${numericCode ? ` (school code ${code})` : ""}`;
    return new Error(`${operation ? `${operation}: ` : ""}${detail}`);
  }

  function check(body, operation = "") {
    if (body?.code !== undefined && body.code !== 0 && body.code !== "0") {
      throw schoolError(body, "The school API rejected the request", operation);
    }
    return body;
  }

  async function asJSON(response, operation = "") {
    let body;
    try { body = await response.json(); }
    catch { throw schoolError(null, `The school API returned invalid JSON (HTTP ${response.status}). Check the logged-in tab.`, operation); }
    if (!response.ok) throw schoolError(body, `HTTP ${response.status}`, operation);
    return check(body, operation);
  }

  async function pump(job, response) {
    if (!(response.headers.get("content-type") || "").includes("text/event-stream")) {
      emit(job, { kind: "event", event: await asJSON(response) });
      return;
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
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
        catch { throw new Error("The school API returned an invalid SSE event."); }
        emit(job, { kind: "event", event: check(event) });
      } else if (value === "data" || value.startsWith("data:")) {
        const part = value === "data" ? "" : value.slice(5).replace(/^ /, "");
        size += part.length + 1;
        if (size > 1024 * 1024) throw new Error("The school API event exceeded the size limit.");
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
      if (buffer.length > 1024 * 1024) throw new Error("The school API event exceeded the size limit.");
      if (eof && !finished) {
        if (buffer) line(buffer);
        line("");
      }
    }

    try {
      while (!finished) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        consume(done);
        if (done) break;
      }
      if (!finished) throw new Error("The school stream ended before its completion marker; the response may be incomplete.");
    } finally {
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
  }

  async function run(job, op, payload) {
    const token = readToken();
    if (!token) throw new Error("Sign in to XIPU AI in this tab first.");
    const lang = localStorage.getItem(btoa("__XP_JM_LANG__")) || "zh";
    const options = { credentials: "include", signal: controllers.get(job).signal, headers: { "Jm-Token": token } };
    if (op === "models" || op === "inspect") {
      const response = await window.fetch(`${API}/api/chat/config?lang=${encodeURIComponent(lang)}`, options);
      const catalog = await asJSON(response, "Load model catalog");
      if (op === "models") {
        emit(job, { kind: "result", result: catalog });
        return;
      }
      const listing = await window.fetch(`${API}/api/chat/session?lang=${encodeURIComponent(lang)}`, options);
      const sessions = await asJSON(listing, "Read school session");
      if (!Array.isArray(catalog?.data?.models) || !Array.isArray(sessions?.data)) {
        throw new Error("The school API returned an invalid model or session list.");
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
      }});
      return;
    }
    if (typeof payload.session_name !== "string" || !payload.session_name.trim()) {
      throw new Error("Configure a dedicated school session before sending chat requests.");
    }
    if (typeof payload.model !== "string" || !payload.model.trim()) throw new Error("Specify a school model.");
    const images = validateImages(payload.images);
    let catalog;
    async function requestedModel() {
      if (!catalog) {
        options.signal.throwIfAborted();
        const response = await window.fetch(`${API}/api/chat/config?lang=${encodeURIComponent(lang)}`, options);
        catalog = await asJSON(response, "Load model catalog");
      }
      if (!Array.isArray(catalog?.data?.models)) throw new Error("The school API returned an invalid model list.");
      const model = catalog.data.models.find(item => (typeof item === "string" ? item : item?.value || item?.model || item?.name) === payload.model);
      if (!model) throw new Error("The requested model is not available in the school model list.");
      return model;
    }
    async function readSession() {
      options.signal.throwIfAborted();
      const response = await window.fetch(`${API}/api/chat/session?lang=${encodeURIComponent(lang)}`, options);
      const body = await asJSON(response, "Read school session");
      if (!Array.isArray(body?.data)) throw new Error("The school API returned an invalid session list.");
      const matches = body.data.filter(item => item?.name === payload.session_name);
      if (matches.length !== 1) throw new Error(`Exactly one school session must be named "${payload.session_name}".`);
      const session = matches[0];
      const validID = typeof session.id === "string" ? !!session.id.trim() && session.id === session.id.trim()
        : Number.isSafeInteger(session.id) && session.id > 0;
      if (!validID) throw new Error("The school API did not return a valid session ID.");
      if (session.contextCount !== 0) throw new Error("The dedicated session must use Context Count 0. No completion was sent.");
      return { session, status: response.status, code: body.code };
    }
    if (images.length) {
      const model = await requestedModel();
      if (model?.multimodal !== true && model?.multimodal !== 1) {
        throw new Error("The requested school model does not advertise image support. No image was uploaded.");
      }
    }
    let selected = await readSession();
    let session = selected.session;
    if (session.model !== payload.model) {
      await requestedModel();
      options.signal.throwIfAborted();
      const saved = await asJSON(await window.fetch(`${API}/api/chat/saveSession`, {
        ...options, method: "POST", headers: { ...options.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...session, model: payload.model, lang })
      }), "Update school session");
      if (!saved || typeof saved !== "object" || Array.isArray(saved) || (saved.code !== 0 && saved.code !== "0")) {
        throw new Error("The school API returned an invalid session update result.");
      }
      selected = await readSession();
      if (selected.session.id !== session.id || selected.session.model !== payload.model) {
        throw new Error("The school session did not retain the requested model and identity. No completion was sent.");
      }
      session = selected.session;
    }
    emit(job, { kind: "lifecycle", result: {
      path: "/api/chat/session", status: selected.status, code: selected.code,
      id: session.id, model: session.model, contextCount: session.contextCount
    }});
    const files = [];
    for (const image of images) {
      options.signal.throwIfAborted();
      const raw = atob(image.data);
      const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
      const form = new FormData();
      form.append("accept", "image");
      form.append("file", new File([bytes], image.name, { type: image.mime }));
      form.append("lang", lang);
      // Let fetch set the multipart boundary, as the official upload helper does.
      const uploaded = await asJSON(await window.fetch(`${API}/api/common/upload`, { ...options, method: "POST", body: form }));
      const url = uploaded?.data?.url || uploaded?.data?.file_url;
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("The school upload did not return a valid image URL.");
      files.push(url);
    }
    options.signal.throwIfAborted();
    const completion = await window.fetch(`${API}/api/chat/completions`, {
      ...options, method: "POST", headers: { ...options.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: payload.text, files, online: payload.online ? 1 : 0,
        thinking: payload.thinking || "minimal", sessionId: session.id, responseId: null, lang
      })
    });
    await pump(job, completion);
  }

  window.addEventListener("message", event => {
    // Sangfor can rewrite event.origin between the MAIN and isolated worlds.
    if (event.source !== window || event.data?.source !== SOURCE) return;
    const { job, type, op, payload } = event.data;
    if (typeof job !== "string" || !job || job.length > 128) return;
    if (type === "cancel") { controllers.get(job)?.abort(); return; }
    if (type !== "req" || controllers.has(job)) return;
    if (!["models", "chat", "inspect"].includes(op) || controllers.size) {
      emit(job, { kind: "done", message: "Unsupported operation or another school request is active." });
      return;
    }
    controllers.set(job, new AbortController());
    run(job, op, payload || {}).then(
      () => emit(job, { kind: "done" }),
      error => emit(job, { kind: "done", message: error?.message || "The school request failed." })
    ).finally(() => controllers.delete(job));
  });
})();
