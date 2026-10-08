(() => {
  "use strict";

  const controllers = new WeakMap();
  let nextID = 0;
  let closeCurrent = null;

  function create(button, initialItems) {
    const existing = controllers.get(button);
    if (existing) { existing.setItems(initialItems); return existing; }
    const document = button.ownerDocument;
    const view = document.defaultView;
    const popupID = `bridge-select-${++nextID}`;
    const value = document.createElement("span");
    value.dataset.slot = "select-value";
    function icon(slot, path) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.dataset.slot = slot;
      for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(name, value);
      const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
      shape.setAttribute("d", path);
      svg.appendChild(shape);
      return svg;
    }
    button.replaceChildren(value, icon("select-icon", "m7 15 5 5 5-5M7 9l5-5 5 5"));
    button.setAttribute("role", "combobox");
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-controls", popupID);
    const popup = document.createElement("div");
    popup.id = popupID;
    popup.dataset.slot = "select-popup";
    popup.setAttribute("role", "listbox");
    if (button.hasAttribute("aria-labelledby")) popup.setAttribute("aria-labelledby", button.getAttribute("aria-labelledby"));
    else if (button.hasAttribute("aria-label")) popup.setAttribute("aria-label", button.getAttribute("aria-label"));
    popup.style.position = "fixed";
    popup.style.overflowY = "auto";
    popup.hidden = true;
    document.body.appendChild(popup);

    let items = [];
    let options = [];
    let opened = false;
    let active = -1;
    let search = "";
    let lastTyped = 0;
    const observer = new view.MutationObserver(records => {
      if (!button.isConnected) { close(); return; }
      if (records.some(record => record.target === button || record.target.contains(button))) {
        if (!available()) close();
        else position();
      }
    });
    const enabled = index => index >= 0 && index < items.length && !items[index].disabled;
    const selectedIndex = () => items.findIndex(item => item.value === button.value);
    function available() {
      if (!button.isConnected || button.matches(":disabled") || button.getAttribute("aria-disabled") === "true" || button.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const style = view.getComputedStyle(button);
      return style.visibility !== "hidden" && style.visibility !== "collapse" && button.getClientRects().length > 0;
    }
    function edge(last = false) {
      for (let index = last ? items.length - 1 : 0; index >= 0 && index < items.length; index += last ? -1 : 1) if (enabled(index)) return index;
      return -1;
    }
    function highlight(index, scroll = true) {
      active = enabled(index) ? index : -1;
      options.forEach((option, index) => option.toggleAttribute("data-highlighted", opened && index === active));
      if (!opened || active < 0) { button.removeAttribute("aria-activedescendant"); return; }
      const option = options[active];
      button.setAttribute("aria-activedescendant", option.id);
      if (scroll) {
        const top = option.offsetTop;
        const bottom = top + option.offsetHeight;
        if (top < popup.scrollTop) popup.scrollTop = top;
        else if (bottom > popup.scrollTop + popup.clientHeight) popup.scrollTop = bottom - popup.clientHeight;
      }
    }
    function position() {
      if (!opened) return;
      if (!available()) { close(); return; }
      const rect = button.getBoundingClientRect();
      const viewport = view.visualViewport;
      const leftEdge = viewport?.offsetLeft || 0;
      const topEdge = viewport?.offsetTop || 0;
      const width = viewport?.width || view.innerWidth;
      const height = viewport?.height || view.innerHeight;
      if (rect.bottom <= topEdge || rect.top >= topEdge + height || rect.right <= leftEdge || rect.left >= leftEdge + width) { close(); return; }
      const margin = 8;
      const gap = 4;
      const availableWidth = Math.max(1, width - margin * 2);
      popup.style.visibility = "hidden";
      popup.style.maxWidth = `${availableWidth}px`;
      popup.style.minWidth = `${Math.min(rect.width, availableWidth)}px`;
      popup.style.width = "max-content";
      const popupWidth = Math.min(availableWidth, Math.max(rect.width, popup.getBoundingClientRect().width));
      popup.style.width = `${popupWidth}px`;
      const below = Math.max(0, topEdge + height - margin - rect.bottom - gap);
      const above = Math.max(0, rect.top - topEdge - margin - gap);
      const naturalHeight = popup.scrollHeight + popup.offsetHeight - popup.clientHeight;
      const upward = below < Math.min(naturalHeight, 320) && above > below;
      const maximumHeight = Math.min(320, upward ? above : below);
      if (maximumHeight < 1) { close(); return; }
      popup.style.maxHeight = `${maximumHeight}px`;
      const popupHeight = Math.min(naturalHeight, maximumHeight);
      const alignLeft = view.getComputedStyle(button).direction === "rtl" ? rect.left : rect.right - popupWidth;
      popup.style.left = `${Math.min(Math.max(leftEdge + margin, alignLeft), leftEdge + width - margin - popupWidth)}px`;
      popup.style.top = `${upward ? rect.top - gap - popupHeight : rect.bottom + gap}px`;
      popup.dataset.side = upward ? "top" : "bottom";
      popup.style.visibility = "";
      highlight(active);
    }
    function outside(event) {
      if (!button.contains(event.target) && !popup.contains(event.target)) close();
    }
    function onScroll(event) {
      if (event.target !== popup && !popup.contains(event.target)) position();
    }
    function close() {
      opened = false;
      popup.hidden = true;
      popup.dataset.state = "closed";
      button.dataset.state = "closed";
      button.setAttribute("aria-expanded", "false");
      search = "";
      lastTyped = 0;
      highlight(-1, false);
      observer.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", onScroll, true);
      view.removeEventListener("resize", position);
      view.removeEventListener("blur", close);
      view.visualViewport?.removeEventListener("resize", position);
      view.visualViewport?.removeEventListener("scroll", position);
      if (closeCurrent === close) closeCurrent = null;
    }
    function open(preferLast = false) {
      if (opened) return true;
      if (!available() || edge() < 0) return false;
      closeCurrent?.();
      closeCurrent = close;
      opened = true;
      popup.hidden = false;
      popup.dataset.state = "open";
      button.dataset.state = "open";
      button.setAttribute("aria-expanded", "true");
      button.focus({ preventScroll: true });
      position();
      if (!opened) return false;
      const selected = selectedIndex();
      highlight(enabled(selected) ? selected : edge(preferLast));
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("scroll", onScroll, true);
      view.addEventListener("resize", position);
      view.addEventListener("blur", close);
      view.visualViewport?.addEventListener("resize", position);
      view.visualViewport?.addEventListener("scroll", position);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "hidden", "inert", "aria-hidden", "aria-disabled", "style", "class"] });
      return true;
    }
    function sync() {
      const selected = selectedIndex();
      value.textContent = selected < 0 ? (button.value || button.dataset.placeholder || "Choose an option") : items[selected].label;
      value.toggleAttribute("data-placeholder", button.value === "");
      options.forEach((option, index) => {
        const chosen = index === selected;
        option.setAttribute("aria-selected", String(chosen));
        option.lastElementChild.toggleAttribute("hidden", !chosen);
      });
      if (opened) {
        if (!available()) close();
        else { position(); highlight(enabled(selected) ? selected : edge()); }
      }
    }
    function setValue(nextValue) { button.value = String(nextValue ?? ""); sync(); }
    function commit(index) {
      if (!opened || !available() || !enabled(index)) { if (!available()) close(); return; }
      const changed = button.value !== items[index].value;
      setValue(items[index].value);
      close();
      button.focus({ preventScroll: true });
      if (changed) {
        button.dispatchEvent(new view.Event("input", { bubbles: true }));
        button.dispatchEvent(new view.Event("change", { bubbles: true }));
      }
    }
    function setItems(nextItems) {
      const seen = new Set();
      const normalized = nextItems.map(item => {
        const value = String(item.value);
        if (seen.has(value)) throw new TypeError("Select option values must be unique");
        seen.add(value);
        return { value, label: String(item.label), disabled: Boolean(item.disabled) };
      });
      close();
      items = normalized;
      options = items.map((item, index) => {
        const option = document.createElement("div");
        option.id = `${popupID}-option-${index}`;
        option.dataset.slot = "select-item";
        option.setAttribute("role", "option");
        option.setAttribute("aria-disabled", String(item.disabled));
        option.toggleAttribute("data-disabled", item.disabled);
        const label = document.createElement("span");
        label.dataset.slot = "select-item-text";
        label.textContent = item.label;
        option.appendChild(label);
        option.appendChild(icon("select-item-indicator", "m5 12 4 4L19 6"));
        option.addEventListener("pointermove", () => { if (opened && available() && enabled(index)) highlight(index, false); });
        option.addEventListener("click", () => commit(index));
        return option;
      });
      popup.replaceChildren(...options);
      sync();
    }
    function typeahead(character) {
      const now = Date.now();
      search = now - lastTyped > 700 ? character : search + character;
      lastTyped = now;
      const repeated = [...search].every(value => value === character);
      const query = repeated ? character : search;
      const start = active + (query.length === 1 ? 1 : 0);
      for (let offset = 0; offset < items.length; offset++) {
        const index = (Math.max(0, start) + offset) % items.length;
        if (enabled(index) && items[index].label.toLocaleLowerCase().startsWith(query)) { highlight(index); break; }
      }
    }
    button.addEventListener("click", () => { if (opened) close(); else open(); });
    button.addEventListener("blur", close);
    popup.addEventListener("pointerdown", event => event.preventDefault());
    button.addEventListener("keydown", event => {
      if (!available()) { close(); return; }
      if (event.isComposing || event.ctrlKey || event.metaKey) return;
      if (event.key === "Tab") { close(); return; }
      if (event.key === "Escape") { if (opened) { event.preventDefault(); event.stopPropagation(); close(); } return; }
      if (event.altKey && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        if (opened) commit(active); else open();
      } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        if (event.altKey) { if (event.key === "ArrowUp") close(); else open(); return; }
        if (!opened) { open(event.key === "ArrowUp"); return; }
        const direction = event.key === "ArrowDown" ? 1 : -1;
        for (let index = active + direction; index >= 0 && index < items.length; index += direction) if (enabled(index)) { highlight(index); break; }
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        if (open()) highlight(edge(event.key === "End"));
      } else if ([...event.key].length === 1 && !event.altKey) {
        event.preventDefault();
        if (open()) typeahead(event.key.toLocaleLowerCase());
      }
    });
    const controller = { setItems, setValue, sync, close };
    controllers.set(button, controller);
    setItems(initialItems);
    return controller;
  }

  globalThis.BridgeSelect = { create, sync: button => controllers.get(button)?.sync() };
})();
