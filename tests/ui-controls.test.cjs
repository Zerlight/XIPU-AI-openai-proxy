const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../extension/ui-controls.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

// A small DOM/event fixture: no layout engine or extension APIs are involved.
function mount(initialItems = [
  { value: "minimal", label: "Minimal" }, { value: "low", label: "Low" },
  { value: "medium", label: "Medium", disabled: true }, { value: "high", label: "High" }
]) {
  let document;
  let time = 1000;
  const observers = new Set();
  function changed(target, type = "attributes", attributeName = "hidden") {
    for (const observer of observers) {
      if (!observer.target || (type === "attributes" && !observer.options.attributeFilter.includes(attributeName))) continue;
      observer.records.push({ target, type, attributeName });
      if (!observer.queued) {
        observer.queued = true;
        queueMicrotask(() => {
          observer.queued = false;
          const records = observer.records.splice(0);
          if (observer.target && records.length) observer.callback(records);
        });
      }
    }
  }
  class Event {
    constructor(type, options = {}) { this.type = type; this.bubbles = Boolean(options.bubbles); Object.assign(this, options); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
  }
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback, capture = false) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      if (!this.listeners.get(type).some(item => item.callback === callback && item.capture === capture)) this.listeners.get(type).push({ callback, capture });
    }
    removeEventListener(type, callback, capture = false) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.callback !== callback || item.capture !== capture)); }
    dispatchEvent(event) {
      event.target ||= this;
      const ancestors = [];
      for (let parent = this.parentNode; parent; parent = parent.parentNode) ancestors.push(parent);
      const call = (node, capture) => {
        for (const item of [...(node.listeners.get(event.type) || [])]) if (item.capture === capture) item.callback(event);
      };
      for (const node of [...ancestors].reverse()) { call(node, true); if (event.stopped) return !event.defaultPrevented; }
      call(this, true); call(this, false);
      if (event.bubbles) for (const node of ancestors) { if (event.stopped) break; call(node, false); }
      return !event.defaultPrevented;
    }
  }
  class Element extends Target {
    constructor(tag) {
      super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.attributes = new Map();
      this.children = []; this.dataset = {}; this.style = {}; this.textContent = ""; this.value = ""; this.scrollTop = 0;
    }
    get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
    get isConnected() { return document.documentElement.contains(this); }
    get lastElementChild() { return this.children.at(-1); }
    get id() { return this.getAttribute("id") || ""; }
    set id(value) { this.setAttribute("id", value); }
    get hidden() { return this.hasAttribute("hidden"); }
    set hidden(value) { this.toggleAttribute("hidden", Boolean(value)); }
    get disabled() { return this.hasAttribute("disabled"); }
    set disabled(value) { this.toggleAttribute("disabled", Boolean(value)); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); changed(this, "attributes", name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { if (this.attributes.delete(name)) changed(this, "attributes", name); }
    toggleAttribute(name, force = !this.hasAttribute(name)) { if (force) this.setAttribute(name, ""); else this.removeAttribute(name); return force; }
    appendChild(child) { child.parentNode = this; this.children.push(child); changed(this, "childList"); return child; }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; children.forEach(child => this.appendChild(child)); changed(this, "childList"); }
    remove() { const parent = this.parentNode; parent.children = parent.children.filter(child => child !== this); this.parentNode = null; changed(parent, "childList"); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector) {
      assert.equal(selector, ":disabled");
      for (let node = this; node; node = node.parentElement) if (node.disabled && (node === this || node.tagName === "FIELDSET")) return true;
      return false;
    }
    closest() {
      for (let node = this; node; node = node.parentElement) if (node.hidden || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return node;
      return null;
    }
    focus() {
      if (document.activeElement !== this) document.activeElement?.dispatchEvent(new Event("blur"));
      document.activeElement = this;
    }
    getClientRects() {
      for (let node = this; node; node = node.parentElement) if (node.hidden || node.style.display === "none") return [];
      return [this.getBoundingClientRect()];
    }
    get offsetTop() { return 4 + this.parentNode.children.indexOf(this) * 30; }
    get offsetHeight() {
      if (this.dataset.slot === "select-popup") return Math.min(this.scrollHeight + 2, parseFloat(this.style.maxHeight) || Infinity);
      return 30;
    }
    get clientHeight() { return Math.max(0, this.offsetHeight - 2); }
    get scrollHeight() { return this.children.length * 30 + 8; }
    getBoundingClientRect() {
      if (this.rect) return this.rect;
      let width = this.children.reduce((maximum, item) => Math.max(maximum, (item.children[0]?.textContent.length || 0) * 7 + 48), 100);
      if (this.style.width !== "max-content") width = parseFloat(this.style.width) || width;
      width = Math.max(width, parseFloat(this.style.minWidth) || 0);
      width = Math.min(width, parseFloat(this.style.maxWidth) || Infinity);
      const left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
      return { left, top, width, height: this.offsetHeight, right: left + width, bottom: top + this.offsetHeight };
    }
  }
  const view = new Target();
  view.innerWidth = 1000; view.innerHeight = 600; view.Event = Event;
  view.getComputedStyle = element => ({ visibility: element.style.visibility || "visible", direction: element.style.direction || "ltr" });
  view.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.records = []; observers.add(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.target = null; this.records = []; }
  };
  document = new Target(); document.defaultView = view;
  document.documentElement = new Element("html"); document.documentElement.parentNode = document;
  document.body = new Element("body"); document.documentElement.appendChild(document.body);
  document.createElement = tag => new Element(tag); document.createElementNS = (_, tag) => new Element(tag);
  const form = document.createElement("form"); document.body.appendChild(form);
  const fieldset = document.createElement("fieldset"); form.appendChild(fieldset);
  const section = document.createElement("section"); fieldset.appendChild(section);
  function addButton(value = "low") {
    const button = document.createElement("button"); button.value = value; button.id = `button-${section.children.length}`;
    button.setAttribute("aria-labelledby", "thinking-label");
    button.rect = { left: 200, top: 100, right: 380, bottom: 132, width: 180, height: 32 };
    section.appendChild(button); return button;
  }
  const button = addButton();
  const events = [];
  for (const type of ["input", "change"]) form.addEventListener(type, event => events.push({ type, target: event.target, value: event.target.value }));
  const context = vm.createContext({ Date: { now: () => time } });
  vm.runInContext(source, context);
  const controller = context.BridgeSelect.create(button, initialItems);
  const popup = document.body.children.find(child => child.dataset.slot === "select-popup");
  const fire = (node, type, props = {}) => { const event = new Event(type, { bubbles: true, ...props }); node.dispatchEvent(event); return event; };
  return { document, view, form, fieldset, section, button, popup, controller, events, addButton, BridgeSelect: context.BridgeSelect,
    key: (key, props) => fire(button, "keydown", { key, ...props }), click: node => fire(node, "click"), pointer: node => fire(node, "pointerdown"), fire,
    advance: milliseconds => { time += milliseconds; }, active: () => popup.children.find(option => option.id === button.getAttribute("aria-activedescendant")) };
}

test("exposes combobox/listbox semantics and silent canonical value synchronization", () => {
  const ui = mount();
  assert.equal(ui.button.getAttribute("role"), "combobox");
  assert.equal(ui.popup.id, ui.button.getAttribute("aria-controls"));
  assert.equal(ui.popup.getAttribute("aria-labelledby"), "thinking-label");
  assert.equal(ui.button.getAttribute("aria-expanded"), "false");
  assert.equal(ui.button.children[0].textContent, "Low");
  assert.equal(ui.popup.children[1].getAttribute("aria-selected"), "true");
  assert.equal(ui.popup.children[0].lastElementChild.hasAttribute("hidden"), true);
  assert.equal(ui.popup.children[1].lastElementChild.hasAttribute("hidden"), false);
  assert.equal(ui.popup.children[2].getAttribute("aria-disabled"), "true");
  ui.controller.setValue("high");
  assert.equal(ui.button.value, "high"); assert.equal(ui.button.children[0].textContent, "High");
  ui.button.value = "minimal"; ui.BridgeSelect.sync(ui.button);
  assert.equal(ui.button.children[0].textContent, "Minimal");
  ui.BridgeSelect.sync(ui.addButton());
  assert.deepEqual(ui.events, []);
});

test("arrows skip disabled items and Escape discards the pending highlight", () => {
  const ui = mount(); ui.key("ArrowDown");
  assert.equal(ui.document.activeElement, ui.button);
  assert.equal(ui.active(), ui.popup.children[1]);
  ui.key("ArrowDown"); assert.equal(ui.active(), ui.popup.children[3]);
  ui.key("ArrowDown"); assert.equal(ui.active(), ui.popup.children[3]);
  ui.key("ArrowUp"); assert.equal(ui.active(), ui.popup.children[1]);
  ui.key("Home"); assert.equal(ui.active(), ui.popup.children[0]);
  ui.key("End"); assert.equal(ui.active(), ui.popup.children[3]);
  assert.equal(ui.button.value, "low");
  const escape = ui.key("Escape");
  assert.equal(escape.defaultPrevented, true); assert.equal(ui.popup.hidden, true);
  assert.equal(ui.button.value, "low"); assert.equal(ui.button.hasAttribute("aria-activedescendant"), false);
  assert.deepEqual(ui.events, []);
});

test("Enter and Space commit once and bubble input before change", () => {
  const ui = mount(); ui.key("Enter"); ui.key("End"); ui.key("Enter");
  assert.equal(ui.button.value, "high"); assert.equal(ui.popup.hidden, true);
  assert.deepEqual(ui.events.map(event => event.type), ["input", "change"]);
  assert.ok(ui.events.every(event => event.target === ui.button && event.value === "high"));
  ui.key(" "); ui.key(" "); assert.equal(ui.events.length, 2, "reselecting the same value is not a change");
  ui.key(" "); ui.key("Home"); ui.key(" ");
  assert.equal(ui.button.value, "minimal"); assert.equal(ui.document.activeElement, ui.button);
});

test("Tab, blur, and outside pointer dismiss without trapping focus or committing", () => {
  const ui = mount(); ui.key("Enter"); ui.key("End");
  assert.equal(ui.key("Tab").defaultPrevented, undefined);
  assert.equal(ui.button.value, "low"); assert.equal(ui.popup.hidden, true);
  ui.click(ui.button); ui.key("End"); ui.pointer(ui.document.body);
  assert.equal(ui.button.value, "low"); assert.equal(ui.popup.hidden, true);
  ui.click(ui.button); ui.fire(ui.button, "blur"); assert.equal(ui.popup.hidden, true);
  assert.deepEqual(ui.events, []);
});

test("typeahead matches prefixes, cycles repeated letters, and never commits navigation", () => {
  const ui = mount([{ value: "minimal", label: "Minimal" }, { value: "medium", label: "Medium" }, { value: "muted", label: "Muted", disabled: true }, { value: "high", label: "High" }]);
  ui.controller.setValue("minimal"); ui.key("m"); assert.equal(ui.active(), ui.popup.children[1]);
  ui.key("m"); assert.equal(ui.active(), ui.popup.children[0]);
  ui.advance(800); ui.key("m"); ui.key("e"); assert.equal(ui.active(), ui.popup.children[1]);
  ui.advance(800); ui.key("H"); assert.equal(ui.active(), ui.popup.children[3]);
  ui.key("a", { ctrlKey: true }); assert.equal(ui.active(), ui.popup.children[3]);
  ui.key("x", { isComposing: true }); assert.equal(ui.active(), ui.popup.children[3]);
  assert.equal(ui.button.value, "minimal"); assert.deepEqual(ui.events, []);
});

test("pointer choice retains trigger focus and ignores disabled options", () => {
  const ui = mount(); ui.click(ui.button);
  assert.equal(ui.pointer(ui.popup.children[3]).defaultPrevented, true);
  ui.click(ui.popup.children[2]); assert.equal(ui.button.value, "low"); assert.equal(ui.popup.hidden, false);
  ui.click(ui.popup.children[3]); assert.equal(ui.button.value, "high"); assert.equal(ui.popup.hidden, true);
  assert.equal(ui.document.activeElement, ui.button); assert.equal(ui.events.length, 2);
});

test("disabled fieldsets and hidden ancestors close an open popup and block commits", async () => {
  const ui = mount(); ui.fieldset.disabled = true; ui.click(ui.button); ui.key("Enter");
  assert.equal(ui.popup.hidden, true);
  ui.fieldset.disabled = false; ui.click(ui.button); ui.key("End"); ui.fieldset.disabled = true;
  ui.click(ui.popup.children[3]); await tick();
  assert.equal(ui.popup.hidden, true); assert.equal(ui.button.value, "low");
  ui.fieldset.disabled = false; ui.click(ui.button); ui.section.hidden = true; await tick();
  assert.equal(ui.popup.hidden, true);
  ui.section.hidden = false; ui.click(ui.button); ui.section.style.display = "none"; ui.controller.sync();
  assert.equal(ui.popup.hidden, true);
  ui.section.style.display = ""; ui.click(ui.button); ui.button.remove(); await tick();
  assert.equal(ui.popup.hidden, true); assert.deepEqual(ui.events, []);
});

test("setItems replaces options without selecting a new value and duplicate values fail atomically", () => {
  const ui = mount(); ui.click(ui.button);
  ui.controller.setItems([{ value: "low", label: "Low updated" }, { value: "new", label: "New" }]);
  assert.equal(ui.popup.hidden, true); assert.equal(ui.button.value, "low"); assert.equal(ui.button.children[0].textContent, "Low updated");
  assert.throws(() => ui.controller.setItems([{ value: "x", label: "One" }, { value: "x", label: "Two" }]), /unique/);
  assert.equal(ui.popup.children.length, 2); assert.equal(ui.button.value, "low");
  ui.controller.setItems([{ value: "new", label: "New", disabled: true }]);
  ui.click(ui.button); assert.equal(ui.popup.hidden, true); assert.equal(ui.button.value, "low");
  assert.deepEqual(ui.events, []);
});

test("only one popup stays open and creating the same controller does not duplicate portals", () => {
  const ui = mount(); const second = ui.addButton("a");
  const controller = ui.BridgeSelect.create(second, [{ value: "a", label: "Another" }]);
  assert.equal(ui.BridgeSelect.create(second, [{ value: "a", label: "Updated" }]), controller);
  assert.equal(ui.document.body.children.filter(child => child.dataset.slot === "select-popup").length, 2);
  ui.click(ui.button); ui.click(second);
  assert.equal(ui.popup.hidden, true); assert.equal(second.getAttribute("aria-expanded"), "true");
  controller.close(); assert.equal(second.getAttribute("aria-expanded"), "false");
});

test("long menus fit the viewport, flip above, and keep active options visible", () => {
  const items = Array.from({ length: 40 }, (_, index) => ({ value: String(index), label: `Session ${index}: ${"Long name ".repeat(12)}` }));
  const ui = mount(items); ui.controller.setValue("0");
  ui.button.rect = { left: 880, top: 550, right: 980, bottom: 582, width: 100, height: 32 };
  ui.click(ui.button);
  assert.equal(ui.popup.dataset.side, "top");
  assert.ok(parseFloat(ui.popup.style.left) >= 8);
  assert.ok(parseFloat(ui.popup.style.left) + parseFloat(ui.popup.style.width) <= 992);
  assert.ok(parseFloat(ui.popup.style.width) > ui.button.rect.width);
  assert.ok(parseFloat(ui.popup.style.top) >= 8);
  ui.key("End"); assert.ok(ui.popup.scrollTop > 0);
  const active = ui.active(); assert.ok(active.offsetTop + active.offsetHeight <= ui.popup.scrollTop + ui.popup.clientHeight);
  ui.view.innerWidth = 320; ui.view.innerHeight = 300;
  ui.button.rect = { left: 10, top: 100, right: 190, bottom: 132, width: 180, height: 32 };
  ui.fire(ui.view, "resize");
  assert.ok(parseFloat(ui.popup.style.width) <= 304);
  assert.ok(active.offsetTop + active.offsetHeight <= ui.popup.scrollTop + ui.popup.clientHeight);
  ui.button.rect = { left: 10, top: 700, right: 190, bottom: 732, width: 180, height: 32 };
  ui.fire(ui.document, "scroll"); assert.equal(ui.popup.hidden, true);
});


test("wide popups align to the control edge before viewport clamping", () => {
  const ui = mount([{ value: "low", label: "A sufficiently long session name and model label" }]);
  ui.button.rect = { left: 680, top: 100, right: 860, bottom: 132, width: 180, height: 32 };
  ui.click(ui.button);
  assert.equal(parseFloat(ui.popup.style.left) + parseFloat(ui.popup.style.width), 860);
  ui.controller.close();
  ui.button.style.direction = "rtl";
  ui.button.rect = { left: 100, top: 100, right: 280, bottom: 132, width: 180, height: 32 };
  ui.click(ui.button);
  assert.equal(parseFloat(ui.popup.style.left), 100);
});
