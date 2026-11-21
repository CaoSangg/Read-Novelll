// Dependency-free browser QA using an isolated Edge/Chromium CDP session.
// Start the two local servers and a browser on 127.0.0.1:9333 before running.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(".pytest_cache_step4_2/browser");
await mkdir(output, { recursive: true });
const target = await (await fetch("http://127.0.0.1:9333/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, reject) => { ws.onopen = ok; ws.onerror = reject; });
let sequence = 0;
const pending = new Map();
const errors = [];
const results = [];
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(JSON.stringify(message.error)));
    else handlers.resolve(message.result);
  } else if (message.method === "Runtime.exceptionThrown") {
    errors.push(message.params.exceptionDetails);
  }
};
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error(`Timed out: ${expression}`);
}
async function screenshot(name) {
  const result = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(output, `${name}.png`), Buffer.from(result.data, "base64"));
}
async function click(selector) {
  const point = await evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}
async function key(key, code = key, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
}

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__homeProbe = {pending: new Set(), frames:0, arcs:0};
    const nativeFrame = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => {
      const id = nativeFrame(time => {
        window.__homeProbe.pending.delete(id);
        window.__homeProbe.frames++;
        callback(time);
      });
      window.__homeProbe.pending.add(id);
      return id;
    };
    window.cancelAnimationFrame = id => {window.__homeProbe.pending.delete(id); nativeCancel(id);};
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function(...args) {window.__homeProbe.arcs++; return arc.apply(this,args);};
  ` });
  const dimensions = [[1920, 1080], [1366, 768], [390, 844], [360, 800]];
  for (const [width, height] of dimensions) {
    const pages = {};
    for (const [name, origin] of [["fastapi", "http://127.0.0.1:8000"], ["next", "http://localhost:3000"]]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: width < 640 ? 2 : 1, mobile: false,
      });
      await send("Page.navigate", { url: origin });
      await until(`document.querySelector('.stage-box') && [...document.images].length === 4 && [...document.images].every(i=>i.complete && i.naturalWidth>0)`);
      await evaluate(`Promise.race([document.fonts.ready, new Promise(r=>setTimeout(r,3000))]).then(()=>true)`);
      const metrics = await evaluate(`(() => {
        const rect = selector => { const r=document.querySelector(selector).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
        const canvas=document.querySelector('canvas');
        return {
          stage:rect('.stage-box'),
          layers:[...document.images].map(i=>({rect:rect('.'+i.classList[i.classList.length-1]),src:new URL(i.src).pathname,z:getComputedStyle(i).zIndex,fit:getComputedStyle(i).objectFit})),
          targets:['.hitbox-tome','.hitbox-buddha','.hitbox-map'].map(rect),
          overflow:document.documentElement.scrollWidth>innerWidth,
          canvas:{width:canvas.width,height:canvas.height,pointer:getComputedStyle(canvas).pointerEvents},
          font:getComputedStyle(document.body).fontFamily,
          loraLoaded:document.fonts.check('16px Lora'),
          pending:window.__homeProbe.pending.size
        };
      })()`);
      assert.equal(metrics.overflow, false, `${name} overflow at ${width}`);
      assert.equal(metrics.canvas.pointer, "none");
      if (name === "fastapi") {
        assert(metrics.targets.every(r => r.width >= 44 && r.height >= 44));
        assert.equal(metrics.pending, 1, "exactly one live animation frame");
      }
      pages[name] = metrics;
      await screenshot(`${name}-${width}x${height}`);
    }
    const a = pages.fastapi;
    const b = pages.next;
    for (const field of ["x", "y", "width", "height"]) {
      assert(Math.abs(a.stage[field] - b.stage[field]) < 0.1, `stage ${field} at ${width}`);
    }
    a.targets.forEach((r, i) => {
      const other = b.targets[i];
      assert(Math.abs(r.x + r.width / 2 - other.x - other.width / 2) < 0.1);
      assert(Math.abs(r.y + r.height / 2 - other.y - other.height / 2) < 0.1);
    });
    assert.deepEqual(a.layers.map(i=>[i.rect,i.z,i.fit]), b.layers.map(i=>[i.rect,i.z,i.fit]));
    results.push({ viewport: [width, height], pages, layoutComparison: "PASS" });
  }

  await send("Page.navigate", { url: "http://127.0.0.1:8000" });
  await until("document.querySelector('[data-modal-open]') && window[Symbol.for('read-novel.home')]");
  await click("[data-modal-open=buddha]");
  await until("document.querySelector('#modal-buddha').classList.contains('active')");
  assert(await evaluate("document.activeElement.matches('#modal-buddha .modal-x')"));
  assert(await evaluate("document.body.style.overflow==='hidden' && document.querySelector('#home-stage').inert"));
  await key("Tab", "Tab", 8);
  assert(await evaluate("document.activeElement.matches('#modal-buddha .modal-close')"));
  await key("Tab");
  assert(await evaluate("document.activeElement.matches('#modal-buddha .modal-x')"));
  await key("Escape");
  await until("document.querySelector('#modal-buddha').hidden");
  assert(await evaluate("document.activeElement.matches('[data-modal-open=buddha]') && !document.querySelector('#home-stage').inert && document.body.style.overflow===''") );

  await click("[data-modal-open=map]");
  await until("document.querySelector('#modal-map').classList.contains('active')");
  await click("#modal-map p");
  assert(await evaluate("!document.querySelector('#modal-map').hidden"));
  await screenshot("fastapi-modal-map-360x800");
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 4, y: 4, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 4, y: 4, button: "left", clickCount: 1 });
  await until("document.querySelector('#modal-map').hidden");
  assert(await evaluate("document.activeElement.matches('[data-modal-open=map]')"));
  await key("Enter");
  await until("document.querySelector('#modal-map').classList.contains('active')");
  await click("#modal-map .modal-x");
  await until("document.querySelector('#modal-map').hidden");
  await click("[data-modal-open=buddha]");
  await until("document.querySelector('#modal-buddha').classList.contains('active')");
  await click("#modal-buddha .modal-btn");
  await until("document.querySelector('#modal-buddha').hidden");
  results.push({ modals: "PASS: mouse/Enter open, X/action/ESC/overlay close, interior click, focus trap/restore and scroll lock" });

  await send("Emulation.setEmulatedMedia", { features: [{name:"prefers-reduced-motion",value:"reduce"}] });
  await until("window.__homeProbe.pending.size===0");
  const first = await evaluate("window.__homeProbe.arcs");
  await new Promise(ok=>setTimeout(ok,300));
  assert.equal(await evaluate("window.__homeProbe.arcs"), first);
  await send("Emulation.setEmulatedMedia", { features: [{name:"prefers-reduced-motion",value:"no-preference"}] });
  await until("window.__homeProbe.pending.size===1");
  await evaluate(`new Promise((ok, fail) => {
    const script=document.createElement('script'); script.src='/static/js/home.js';
    script.onload=ok; script.onerror=fail; document.head.append(script);
  })`);
  await until("window.__homeProbe.pending.size===1");
  await evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))");
  assert.equal(await evaluate("window.__homeProbe.pending.size"),0);
  await evaluate("dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
  await until("window.__homeProbe.pending.size===1");
  results.push({ lifecycle: "PASS: reduced motion stops/resumes, duplicate script keeps one loop, synthetic pagehide cleans/pageshow restarts" });
  assert.equal(errors.length, 0, "No uncaught JavaScript exceptions in either app");
  console.log(JSON.stringify({ results, javascriptErrors: errors.length, output }, null, 2));
  await writeFile(resolve(output,"results.json"),JSON.stringify({results,errors},null,2));
} finally {
  // This is a separate profile created for QA; close only this owned browser.
  await send("Browser.close").catch(()=>{});
  ws.close();
}
