const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.isConnected = false;
    this.id = "";
    this.textContent = "";
    this.style = {
      setProperty: (name, value) => {
        this.style[name] = value;
      },
    };
  }

  appendChild(child) {
    child.parentElement = this;
    child.isConnected = true;
    this.children.push(child);
    this.ownerDocument.elements.push(child);
    return child;
  }

  remove() {
    this.isConnected = false;
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
  }

  querySelectorAll() {
    return [];
  }

  getAttribute() {
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.elements = [];
    this.title = "Udacity: Mentor Dashboard";
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement.isConnected = true;
    this.head.isConnected = true;
    this.body.isConnected = true;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.elements.find((element) => element.isConnected && element.id === id) || null;
  }

  querySelectorAll(selector) {
    if (/^#[A-Za-z0-9_-]+$/.test(selector)) {
      const id = selector.slice(1);
      return this.elements.filter((element) => element.isConnected && element.id === id);
    }
    return [];
  }
}

function createHarness() {
  const document = new FakeDocument();
  const storage = new Map();
  const listeners = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  let timerRegistrations = 0;

  const context = {
    Array,
    Date,
    JSON,
    Math,
    String,
    console: { log() {} },
    document,
    location: { pathname: "/queue/overview", hash: "" },
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timerRegistrations += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval(callback) {
      const id = nextTimerId++;
      timerRegistrations += 1;
      timers.set(id, callback);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
  };
  context.window = context;
  context.top = context;
  vm.createContext(context);
  return {
    context,
    document,
    listenerCount: () => Array.from(listeners.values()).reduce((sum, set) => sum + set.size, 0),
    timerRegistrations: () => timerRegistrations,
  };
}

const source = fs.readFileSync(path.join(__dirname, "..", "auto-refresh.js"), "utf8");
const harness = createHarness();

vm.runInContext(source, harness.context);
const runtime = harness.context.__UDACITY_AUTO_REFRESH_RUNTIME_V2__;
assert.equal(runtime?.active, true);
assert.equal(runtime?.version, "1.0.6");
assert.equal(harness.document.querySelectorAll("#udacity-mentor-auto-refresh-badge").length, 1);
const initialTimerRegistrations = harness.timerRegistrations();
const initialListenerCount = harness.listenerCount();

const duplicate = harness.document.createElement("div");
duplicate.id = "udacity-mentor-auto-refresh-badge";
harness.document.body.appendChild(duplicate);
const legacy = harness.document.createElement("div");
legacy.id = "tm-udacity-auto-refresh-bar";
harness.document.body.appendChild(legacy);

vm.runInContext(source, harness.context);
assert.equal(harness.context.__UDACITY_AUTO_REFRESH_RUNTIME_V2__, runtime);
assert.equal(harness.document.querySelectorAll("#udacity-mentor-auto-refresh-badge").length, 1);
assert.equal(legacy.style.display, "none");
assert.equal(harness.timerRegistrations(), initialTimerRegistrations);
assert.equal(harness.listenerCount(), initialListenerCount);

console.log("auto-refresh singleton regression checks passed");
