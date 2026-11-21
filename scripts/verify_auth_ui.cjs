/* Local Edge/CDP smoke tests. API responses are simulated; no database is written.
 * Run: node scripts/verify_auth_ui.cjs
 * Real backend CSRF checks only: node scripts/verify_auth_ui.cjs --csrf-only
 * Requires Node 22+, local Microsoft Edge, and the project's Python environment.
 */
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:8763';
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = mkdtempSync(path.join(tmpdir(), 'readnovel-auth-ui-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server, browser, socket;
const pending = new Map();
let sequence = 0;
let behavior = 'error';
let meAuthenticated = false;
let csrfCount = 0;
const posts = [];
const consoleErrors = [];

async function until(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (await check()) return; } catch {}
    await delay(100);
  }
  throw new Error(message);
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function intercept(event) {
  const url = new URL(event.request.url);
  let code = 200;
  let body = {};
  const headers = [{ name: 'Content-Type', value: 'application/json' }];
  if (url.pathname.endsWith('/csrf-token')) {
    csrfCount++;
    body = { csrf_token: 'browser-test-csrf' };
    headers.push({ name: 'Set-Cookie', value: 'csrf_token=browser-test-csrf; Path=/; SameSite=Lax' });
  } else if (url.pathname.endsWith('/me')) {
    code = meAuthenticated ? 200 : 401;
    body = meAuthenticated ? { username: 'testreader', role: 'Reader' } : { detail: 'Authentication required.' };
  } else {
    posts.push({ url: url.pathname, payload: JSON.parse(event.request.postData), headers: event.request.headers });
    if (behavior === 'network') {
      await send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionFailed' });
      return;
    }
    if (behavior === 'pending') await delay(600);
    if (behavior === 'success' || behavior === 'pending') {
      code = url.pathname.endsWith('/register') ? 201 : 200;
      body = { user: { username: 'testreader', role: 'Reader' }, csrf_token: 'rotated-browser-csrf', message: 'ok' };
    } else if (behavior === 'rate') {
      code = 429;
      headers.push({ name: 'Retry-After', value: '2' });
    } else if (behavior === 'validation') {
      code = 422;
      body = { detail: [{ loc: ['body', 'password'], msg: 'private internal detail', input: 'private-input' }] };
    } else if (behavior === 'csrf') {
      code = 403;
    } else if (behavior === 'server') {
      code = 500;
      body = { detail: '<img src=x onerror=alert(1)> database internal error' };
    } else {
      code = 401;
      body = { detail: 'Invalid username/email or password' };
    }
  }
  await send('Fetch.fulfillRequest', {
    requestId: event.requestId, responseCode: code, responseHeaders: headers,
    body: Buffer.from(JSON.stringify(body)).toString('base64'),
  });
}

async function open(route) {
  await send('Page.navigate', { url: `${origin}${route}` });
  await until(() => evaluate(`location.pathname === ${JSON.stringify(route.split('?')[0])} && !!document.querySelector('#auth-submit') && !document.querySelector('#auth-submit').disabled`), 'Form failed to initialize');
}

async function fill(register = false) {
  await evaluate(`(() => {
    document.getElementById('identifier').value = ${JSON.stringify(register ? 'reader@example.com' : 'testreader')};
    document.getElementById('password').value = 'BrowserTest123!';
    ${register ? "document.getElementById('username').value = 'testreader'; document.getElementById('confirm-password').value = 'BrowserTest123!';" : ''}
  })()`);
}

async function submit() {
  await evaluate("document.getElementById('auth-form').requestSubmit()");
}

async function errorReady() {
  await until(() => evaluate("!document.getElementById('auth-error').hidden && document.getElementById('auth-form').getAttribute('aria-busy') === 'false'"), 'Expected error feedback');
}

async function main() {
  server = spawn(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8763', '--lifespan', 'off', '--no-access-log'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  browser = spawn(edgePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9233', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  server.on('error', (error) => { console.error(error.message); });
  browser.on('error', (error) => { console.error(error.message); });
  await until(async () => (await fetch(`${origin}/login`, { signal: AbortSignal.timeout(1000) })).ok, 'Local HTTP server unavailable');
  let targets;
  await until(async () => { targets = await (await fetch('http://127.0.0.1:9233/json', { signal: AbortSignal.timeout(1000) })).json(); return targets.some((item) => item.type === 'page'); }, 'Headless Edge unavailable');
  socket = new WebSocket(targets.find((item) => item.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') {
      intercept(message.params).catch((error) => consoleErrors.push(error.message));
    } else if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.text);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  if (process.argv.includes('--csrf-only')) {
    // No Fetch interception: these requests exercise the real backend dependency.
    await open('/login');
    const results = await evaluate(`(async () => {
      const statuses = [];
      const post = async (route, token) => (await fetch('/api/auth/' + route, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}) },
        body: JSON.stringify({}),
      })).status;
      for (const route of ['login', 'register']) {
        statuses.push(await post(route));
        const response = await fetch('/api/auth/csrf-token', { credentials: 'same-origin', cache: 'no-store' });
        const token = (await response.json()).csrf_token;
        statuses.push(await post(route, 'forged-header'));
        statuses.push(await post(route, token));
      }
      for (const route of ['logout', 'change-password']) statuses.push(await post(route));
      return statuses;
    })()`);
    assert.deepEqual(results, [403, 403, 422, 403, 403, 422, 403, 403]);
    assert.equal(await evaluate('localStorage.length + sessionStorage.length'), 0);
    assert.deepEqual(consoleErrors, []);
    console.log('PASS: real backend in Edge: guest CSRF bootstrap, Login/Register missing or wrong CSRF 403, valid CSRF reaches validation 422, Logout/Change Password remain 403 without CSRF.');
    console.log('NOT TESTED: successful authentication/session with PostgreSQL; no valid user payload or database write performed.');
    return;
  }
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/auth/*' }] });
  const output = path.join(root, 'docs', 'screenshots', 'step4_3');
  mkdirSync(output, { recursive: true });
  for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844], [360, 800]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const route of ['/login', '/register']) {
      await open(route);
      await evaluate('document.fonts.ready.then(() => true)');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Overflow ${route} ${width}`);
      const dimensions = await evaluate(`Array.from(document.querySelectorAll('.auth-page button,.auth-page a,.auth-page input')).map(el => { const r = el.getBoundingClientRect(); return [r.width, r.height]; })`);
      assert(dimensions.every(([w, h]) => w >= 44 && h >= 44), `Small target ${route} ${width}`);
      if (width === 1920 || width === 390) {
        const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(path.join(output, `${route.slice(1)}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }
  }
  console.log('PASS: 8 responsive page checks, 44px targets; 4 screenshots saved.');

  await open('/register');
  await submit();
  assert.equal(await evaluate("document.activeElement.id"), 'username');
  assert.equal(posts.length, 0);
  await fill(true);
  await evaluate("document.getElementById('confirm-password').value = 'mismatch'");
  await submit();
  assert.equal(await evaluate("document.activeElement.id"), 'confirm-password');
  assert.equal(posts.length, 0);
  await evaluate("document.querySelector('.auth-toggle').click()");
  assert.equal(await evaluate("document.getElementById('password').type"), 'text');
  assert.equal(await evaluate("document.querySelector('.auth-toggle').getAttribute('aria-pressed')"), 'true');
  await evaluate("document.querySelector('.auth-toggle').click()");
  assert.equal(await evaluate("document.getElementById('password').type"), 'password');

  for (const scenario of ['error', 'validation', 'csrf', 'server', 'network', 'rate']) {
    behavior = scenario;
    await open('/login');
    await fill();
    await submit();
    await errorReady();
    assert.equal(await evaluate("document.getElementById('password').value.length > 0"), true);
    assert.equal(await evaluate("document.querySelector('#auth-error img') === null"), true);
    assert.equal(await evaluate("document.getElementById('auth-error').textContent.includes('private')"), false);
    if (scenario === 'rate') {
      assert.equal(await evaluate("document.getElementById('auth-submit').disabled"), true);
      await until(() => evaluate("!document.getElementById('auth-submit').disabled"), 'Retry-After failed');
    } else assert.equal(await evaluate("document.getElementById('auth-submit').disabled"), false);
  }
  console.log('PASS: validation, password toggles, 401/403/422/429/500/network errors and Retry-After.');

  behavior = 'error';
  await open('/login');
  await fill();
  await evaluate("document.getElementById('identifier').focus()");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate('document.activeElement.id'), 'password');
  const keyboardPosts = posts.length;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await errorReady();
  assert.equal(posts.length, keyboardPosts + 1);
  console.log('PASS: Tab navigation and Enter submit.');

  for (const route of ['/login', '/register']) {
    behavior = 'pending';
    await open(`${route}?returnUrl=https://evil.invalid`);
    await fill(route === '/register');
    const count = posts.length;
    const csrfBefore = csrfCount;
    await submit();
    await submit();
    assert.equal(await evaluate("document.getElementById('auth-submit').disabled"), true);
    await until(() => evaluate("location.pathname === '/'"), 'Success did not redirect home');
    assert.equal(posts.length, count + 1, 'Duplicate POST');
    assert.equal(csrfCount, csrfBefore + 1);
    const post = posts.at(-1);
    assert.equal(post.headers['X-CSRF-Token'], 'browser-test-csrf');
    assert.equal(post.url, `/api/auth${route}`);
    assert.deepEqual(Object.keys(post.payload).sort(), route === '/register' ? ['email', 'password', 'username'] : ['password', 'username_or_email']);
    assert.equal(await evaluate('localStorage.length + sessionStorage.length'), 0);
  }
  meAuthenticated = true;
  await send('Page.navigate', { url: `${origin}/login` });
  await until(() => evaluate("location.pathname === '/'"), 'Current user did not redirect home');
  assert.deepEqual(consoleErrors, []);
  console.log('PASS: CSRF bootstrap/header, payload mapping, loading, duplicate guard, safe redirects, current-user state, empty storage, no JS exceptions.');
  console.log('PARTIAL: API responses simulated; PostgreSQL integration and Next.js visual parity require separate checks.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) {
    await send('Browser.close').catch(() => {});
    socket.close();
  }
  server?.kill();
  browser?.kill();
  // Keep the unique temporary profile; never delete a shared browser profile.
});
