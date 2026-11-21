/* Real SSR smoke checks. Start through check_reader_browser.py for safe fixture cleanup. */
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const url = process.argv[2];
const tocMode = process.argv.includes('--toc');
const toolbarMode = process.argv.includes('--toolbar');
const themeMode = process.argv.includes('--theme');
const typographyMode = process.argv.includes('--typography');
const persistenceMode = process.argv.includes('--persistence');
const preferenceKey = 'readnovel.reader.settings';
const visualMode = process.argv.includes('--settings-visual');
const captureBefore = process.argv.includes('--capture-before');
const referenceMode = process.argv.includes('--next-reference');
const navigationMode = process.argv.includes('--navigation');
const jumpMode = process.argv.includes('--toc-jump');
const finalMode = process.argv.includes('--navigation-final');
const visualOutput = path.resolve(persistenceMode ? 'docs/screenshots/step4_5_4b/regression' : 'docs/screenshots/step4_5_4a', captureBefore ? 'before' : 'after');
const profile = mkdtempSync(path.join(tmpdir(), 'readnovel-reader-browser-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket, sequence = 0;
const pending = new Map();
const errors = [];
const requests = [];
const networkWrites = [];
const documentResponses = [];
let responseCookies = 0;
let bootstrapDelay = 0;
let responseMode = 'real';
let tocFetches = 0;
let heldTocRequests = [];
const failedRequests = new Map();
async function handleFetch(event) {
  if(event.request.url.includes('/static/js/reader_preferences.js')){
    if(bootstrapDelay) await delay(bootstrapDelay);
    return send('Fetch.continueRequest',{requestId:event.requestId});
  }
  tocFetches++;
  if (responseMode === 'held') {
    // Keep the response impossible until the application's AbortController cancels this request.
    heldTocRequests.push({ requestId: event.requestId, networkId: event.networkId });
    return;
  }
  if (responseMode === 'real') return send('Fetch.continueRequest', { requestId: event.requestId });
  if (responseMode === 'slow') { await delay(400); return send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {}); }
  if (responseMode === 'network') return send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionFailed' });
  const page = Number(new URL(event.request.url).searchParams.get('page'));
  const body = responseMode === 'empty' ? { page, page_size: 50, total: 0, total_pages: 0, items: [] } : { detail: '<img src=x onerror=alert(1)>PRIVATE_SQL_DETAIL' };
  return send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: responseMode === 'empty' ? 200 : Number(responseMode), responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
}
async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    try { if (await check()) return; } catch {}
    await delay(100);
  }
  throw new Error(message);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert(!result.exceptionDetails, 'Browser evaluation failed');
  return result.result.value;
}
async function pointerClick(selector, reveal = false, part = 'center') {
  if (reveal) await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
  const point = await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});let r=el.getBoundingClientRect();if(${JSON.stringify(part)}==='text'){const range=document.createRange();range.selectNodeContents(el);r=range.getBoundingClientRect();}const x=${JSON.stringify(part)}==='padding'?r.right-6:r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:el.contains(document.elementFromPoint(x,y))};})()`);
  assert(point.hit, `Click target is obscured: ${selector}`);
  delete point.hit;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await delay(80); // Allow normal focus/default actions between physical press and release.
  if (selector.startsWith('.reader-theme-panel label')) {
    assert.equal(await evaluate("document.getElementById('reader-theme-selector').open"), true, 'Settings menu closed between label press and release');
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function inputKey(key, code, virtual, shift = false) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual, modifiers: shift ? 8 : 0, ...(key === 'Enter' ? {text:'\r',unmodifiedText:'\r'} : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, modifiers: shift ? 8 : 0 });
}
async function main() {
  await until(async () => (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok, 'Reader server unavailable');
  browser = spawn(process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9234', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => errors.push('Edge launch failed'));
  let targets;
  await until(async () => { targets = await (await fetch('http://127.0.0.1:9234/json', { signal: AbortSignal.timeout(1000) })).json(); return targets.some(t => t.type === 'page'); }, 'Edge unavailable');
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const item = JSON.parse(data);
    if (item.id) {
      const handler = pending.get(item.id);
      if (!handler) return;
      pending.delete(item.id);
      item.error ? handler.reject(new Error(item.error.message)) : handler.resolve(item.result);
    } else if (item.method === 'Fetch.requestPaused') handleFetch(item.params).catch(() => errors.push('Fetch interception failed'));
    else if (item.method === 'Runtime.exceptionThrown') errors.push('JavaScript exception');
    else if (item.method === 'Runtime.consoleAPICalled' && item.params.type === 'error') errors.push('Console error');
    else if (item.method === 'Network.requestWillBeSent') {
      requests.push(item.params.request.url);
      if(new URL(item.params.request.url).origin===new URL(url).origin && !['GET','HEAD'].includes(item.params.request.method)) networkWrites.push(item.params.request.method);
    } else if(item.method==='Network.responseReceived' && item.params.type==='Document') {
      documentResponses.push({url:item.params.response.url,status:item.params.response.status});
    } else if(item.method==='Network.responseReceivedExtraInfo') {
      // Count header names only; never retain or print cookie/token values.
      if(Object.keys(item.params.headers).some(key=>key.toLowerCase()==='set-cookie'))responseCookies++;
    } else if(item.method==='Network.loadingFailed') {
      failedRequests.set(item.params.requestId,{canceled:item.params.canceled===true,errorText:item.params.errorText});
    }
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (persistenceMode && process.argv.includes('--persistence-only')) { await checkPersistence(); return; }
  if (referenceMode) { await captureNextReference(); return; }
  if (finalMode) {
    const before=fixtureAction('--fixture-state');await checkNavigationFinal();assert.deepEqual(fixtureAction('--fixture-state'),before);
    await checkTocJump();return;
  }
  if (jumpMode) { await checkTocJump(); return; }
  if (navigationMode) { await checkNavigation(); return; }
  if (visualMode && (captureBefore || process.argv.includes('--visual-only'))) { await captureSettingsVisual(); return; }
  if (tocMode) { await checkToc(); return; }
  const output = path.resolve('docs/screenshots/step4_4_3a');
  mkdirSync(output, { recursive: true });
  for (const [width, height] of [[1920, 1080], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    await until(() => evaluate("!!document.querySelector('.reader-content')"), 'No Reader content');
    await evaluate('document.fonts.ready.then(() => true)');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate("document.querySelectorAll('.reader-content p').length"), 4);
    assert.equal(await evaluate("document.querySelectorAll('.reader-content p')[1].textContent"), 'Dòng một\nDòng hai');
    assert.equal(await evaluate("document.querySelectorAll('.reader-content script').length"), 0);
    assert.equal(await evaluate('window.readerXss === undefined'), true);
    assert.equal(await evaluate('document.documentElement.scrollHeight > innerHeight'), true);
    await evaluate('scrollTo(0, document.documentElement.scrollHeight)');
    assert.equal(await evaluate('scrollY > 0'), true);
    await evaluate('scrollTo(0, 0)');
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(output, `reader-${width}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  assert(!requests.some(value => value.includes('/api/auth/') || value.includes('/api/progress') || value.includes('/api/bookmarks')));
  assert.deepEqual(errors, []);
  console.log('PASS: real PostgreSQL SSR in Edge at 1920x1080 and 390x844; paragraphs, Unicode, XSS text, scrolling, no horizontal overflow or JS exceptions; no auth/progress/bookmark requests.');
}
async function checkNavigation() {
  const output=path.resolve('docs/screenshots/step4_6_1');mkdirSync(output,{recursive:true});
  const metrics=[];
  const base=new URL(url);
  const target=seq=>new URL(base.pathname.replace(/\/\d+$/,`/${seq}`),base.origin).href;
  const ready=async seq=>{
    await until(()=>evaluate(`location.href===${JSON.stringify(target(seq))} && document.readyState==='complete' && !document.getElementById('reader-typography-controls')?.hidden && document.getElementById('reader-chapter-title')?.textContent.trim()==='Navigation chapter ${seq}'`),'Navigation document not ready');
    assert.equal(await evaluate("document.querySelector('.reader-content p').textContent"),`NAVIGATION_CONTENT_${seq}`);
    assert.equal(await evaluate("document.body.textContent.includes('HIDDEN_NAVIGATION_SECRET')"),false);
  };
  const shot=async name=>{
    await evaluate('document.fonts.ready.then(()=>true)');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await evaluate("Promise.all(document.getElementById('reader-toolbar').getAnimations().map(animation=>animation.finished.catch(()=>{})))");
    const s=await send('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(output,name),Buffer.from(s.data,'base64'));
  };
  const footer=async()=>{await evaluate("document.activeElement.blur();document.querySelector('.reader-navigation').scrollIntoView({block:'center'})");await delay(60);};
  const top=async()=>{
    await evaluate('document.activeElement.blur();scrollTo(0,0)');
    await until(()=>evaluate("!document.getElementById('reader-toolbar').classList.contains('is-hidden')"),'Header did not return at top');
    await evaluate("Promise.all(document.getElementById('reader-toolbar').getAnimations().map(animation=>animation.finished.catch(()=>{})))");
  };
  const choose=async(name,value)=>pointerClick(`.reader-theme-panel label:has(input[name="${name}"][value="${value}"]) .reader-option-text`,true);
  const toc=async(seq,page=1,total=1)=>{
    await top();await pointerClick('#reader-toc-open');
    await until(()=>evaluate(`document.querySelector('#reader-toc-list [aria-current="page"]')?.dataset.sequence==='${seq}' && document.getElementById('reader-toc-page').textContent==='Trang ${page}/${total}'`),'Current TOC chapter/page mismatch');
    assert.equal(await evaluate("document.querySelectorAll('#reader-toc-list .reader-toc-chapter').length===document.querySelectorAll('#reader-toc-list li').length"),true);
    assert.equal(await evaluate("document.querySelector('#reader-toc-list button[aria-current]')?.closest('li').dataset.sequence"),String(seq));
    await evaluate("Promise.all(document.getElementById('reader-toc').getAnimations().map(animation=>animation.finished.catch(()=>{})))");
    await pointerClick('#reader-toc-close');
    await until(()=>evaluate("!document.getElementById('reader-toc').open && document.activeElement.id==='reader-toc-open'"),'TOC did not close/restore focus');
    assert.equal(await evaluate('document.activeElement.id'),'reader-toc-open');
  };
  const desired=async()=>{
    assert.deepEqual(await typographyStyles(),{family:'Merriweather, Georgia, serif',size:'23px',height:'48.3px',width:'768px'});
    assert.equal(await evaluate("document.querySelector('.reader-page').dataset.readerTheme"),'dark');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.reader-page')).backgroundColor"),'rgb(19, 21, 24)');
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#reader-theme-panel input:checked'),el=>el.value)"),['dark','Merriweather','2.1','wide']);
    assert.equal(await evaluate("document.getElementById('reader-font-size-value').textContent"),'23px');
  };
  const hook=await send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {
    const q=window.__navigationQa={writes:0,frames:[]};const set=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){if(key==='${preferenceKey}')q.writes++;return set.call(this,key,value);};
    function frame(){const root=document.querySelector('.reader-page'),text=document.querySelector('.reader-content');
      if(root&&text)q.frames.push({theme:root.dataset.readerTheme,background:getComputedStyle(root).backgroundColor,size:getComputedStyle(text).fontSize});
      if(q.frames.length<10)requestAnimationFrame(frame);
    }requestAnimationFrame(frame);
  })()`});
  for(const [width,height] of [[1528,826],[1366,768],[1920,1080],[390,844],[360,800],[320,800]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:target(1)});await ready(1);
    await resetPreferenceFixture();await send('Page.reload');await ready(1);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.reader-page')).backgroundColor"),'rgb(247, 242, 231)');
    assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-next-chapter')).color"),'rgb(56, 46, 37)');
    await checkToolbar(width,height,output);
    await footer();
    assert.equal(await evaluate("document.getElementById('reader-previous-chapter').tagName"),'SPAN');
    const firstTime=await evaluate('performance.timeOrigin');await pointerClick('#reader-previous-chapter');await delay(80);
    assert.equal(await evaluate('performance.timeOrigin'),firstTime);
    if(width===1528||width===390)await shot(`first-sepia-${width}.png`);
    const before=requests.length;
    await pointerClick('#reader-next-chapter');await ready(3);
    assert(!requests.slice(before).some(value=>value.includes('/api/novels/')),'Navigation fetched chapter API/whole TOC');
    assert.equal(await evaluate('scrollY'),0);
    assert.equal(await evaluate("document.getElementById('reader-toolbar').classList.contains('is-hidden')"),false);
    assert.equal(await evaluate("document.querySelector('.reader-content p').textContent"),'NAVIGATION_CONTENT_3');
    await toc(3);await footer();
    assert.equal(await evaluate("document.getElementById('reader-previous-chapter').getAttribute('href')"),new URL(target(1)).pathname);
    assert.equal(await evaluate("document.getElementById('reader-next-chapter').getAttribute('href')"),new URL(target(9)).pathname);
    if(width===1528||width===390)await shot(`middle-sepia-${width}.png`);
    for(const theme of ['light','dark']){
      await top();await pointerClick('#reader-theme-trigger');await choose('reader-theme',theme);await inputKey('Escape','Escape',27);await footer();
      const state=await evaluate(`(() => {const nav=document.querySelector('.reader-navigation'),a=document.getElementById('reader-next-chapter'),r=a.getBoundingClientRect(),s=getComputedStyle(a);return {width:innerWidth,theme:document.querySelector('.reader-page').dataset.readerTheme,background:getComputedStyle(document.querySelector('.reader-page')).backgroundColor,color:s.color,border:s.borderColor,radius:s.borderRadius,font:s.fontSize,height:r.height,left:r.left,right:r.right,outline:s.outlineStyle};})()`);
      assert.equal(state.theme,theme);assert.equal(state.background,theme==='dark'?'rgb(19, 21, 24)':'rgb(250, 248, 245)');
      assert.equal(state.color,theme==='dark'?'rgb(220, 224, 230)':'rgb(30, 35, 42)');
      assert.equal(state.radius,'12px');metrics.push(state);
      const point=await evaluate("(() => {const r=document.getElementById('reader-next-chapter').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:height/2});
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await delay(180);
      await until(()=>evaluate("getComputedStyle(document.getElementById('reader-next-chapter')).backgroundColor!=='rgba(0, 0, 0, 0)'"),'Navigation hover style did not apply');
      if(width===1528||width===390)await shot(`middle-${theme}-${width}.png`);
    }
    await top();await pointerClick('#reader-theme-trigger');await choose('reader-font-family','Merriweather');
    for(let i=0;i<4;i++)await pointerClick('#reader-font-size-increase',true);
    await choose('reader-line-height','2.1');await choose('reader-reading-width','wide');await desired();
    assert.equal(await evaluate('window.__navigationQa.writes'),9);
    if(width===1528||width===390)await shot(`settings-dark-${width}.png`);
    await inputKey('Escape','Escape',27);await footer();
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.reader-navigation-control')).every(el=>{const r=el.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth})"),true);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    // Focus is only test setup; Tab and Enter drive the actual native link activation.
    await evaluate("document.getElementById('reader-previous-chapter').focus()");await inputKey('Tab','Tab',9);
    assert.equal(await evaluate('document.activeElement.id'),'reader-next-chapter');
    assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineWidth"),'2px');
    if(width===1528||width===390)await shot(`middle-dark-focus-${width}.png`);
    await inputKey('Enter','Enter',13);await ready(9);await desired();
    assert.equal(await evaluate('window.__navigationQa.writes'),0,'Restore created duplicate settings writes');
    await delay(100);
    assert.equal(await evaluate("window.__navigationQa.frames.length>0 && window.__navigationQa.frames.every(frame=>frame.theme==='dark'&&frame.background==='rgb(19, 21, 24)'&&frame.size==='23px')"),true,'Settings not restored in initial frames');
    await toc(9);await footer();
    assert.equal(await evaluate("document.getElementById('reader-next-chapter').tagName"),'SPAN');
    const lastTime=await evaluate('performance.timeOrigin');await pointerClick('#reader-next-chapter');await delay(80);
    assert.equal(await evaluate('performance.timeOrigin'),lastTime);
    if(width===1528||width===390)await shot(`last-dark-${width}.png`);
    await pointerClick('#reader-previous-chapter');await ready(3);await desired();await toc(3);await footer();
    await evaluate("document.getElementById('reader-next-chapter').focus()");await inputKey('Tab','Tab',9,true);
    assert.equal(await evaluate('document.activeElement.id'),'reader-previous-chapter');
    await inputKey('Enter','Enter',13);await ready(1);await desired();await toc(1);await footer();
    if(width===1528||width===390)await shot(`first-dark-${width}.png`);
    console.log(`PASS: Navigation ${width}x${height}: physical clicks 1/3/9/3/1, Tab/Enter, boundaries, three themes, 44px targets, no overflow, TOC current, five restored settings/initial frames, Smart Header.`);
  }
  const rankArg=process.argv.find(value=>value.startsWith('--rank-url='));
  const rankUrl=rankArg.slice('--rank-url='.length);
  await send('Page.navigate',{url:rankUrl});
  await until(()=>evaluate("document.readyState==='complete' && document.getElementById('reader-toc')?.dataset.sequence==='2440' && !document.getElementById('reader-toc-open').disabled"),'Rank fixture failed');
  await toc(2440,1,3);await footer();await pointerClick('#reader-next-chapter');
  await until(()=>evaluate("document.readyState==='complete' && document.getElementById('reader-toc')?.dataset.sequence==='2470' && !document.getElementById('reader-toc-open').disabled"),'Rank boundary navigation failed');
  await desired();await toc(2470,2,3);
  assert.equal(await evaluate("document.querySelector('#reader-toc-list [aria-current]').dataset.sequence"),'2470');
  await send('Emulation.setScriptExecutionDisabled',{value:true});
  try {
    await send('Page.navigate',{url:target(1)});
    await until(()=>evaluate(`location.href===${JSON.stringify(target(1))} && document.readyState==='complete'`),'No-JS load failed');
    await footer();await pointerClick('#reader-next-chapter');
    await until(()=>evaluate(`location.href===${JSON.stringify(target(3))} && document.readyState==='complete'`),'No-JS native anchor failed');
  } finally {await send('Emulation.setScriptExecutionDisabled',{value:false});}
  assert(!requests.some(value=>value.includes('/api/auth/')||value.includes('/api/progress')||value.includes('/api/bookmarks')));
  assert.deepEqual(networkWrites,[]);assert.deepEqual(errors,[]);
  writeFileSync(path.join(output,'measurements.json'),JSON.stringify({mode:'PostgreSQL fixtures',metrics,networkWrites:networkWrites.length,errors},null,2));
  await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:hook.identifier});
  console.log('PASS: TOC published-rank page 1 to 2 across 2440/2470; native links with JavaScript disabled; no auth/progress/bookmark requests or backend writes.');
}
function fixtureAction(flag) {
  const fixture=process.argv.find(value=>value.startsWith('--fixture-novel=')).split('=')[1];
  const result=spawnSync(path.resolve('.venv/Scripts/python.exe'),['scripts/check_reader_browser.py',flag,fixture],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,'Isolated fixture state/publication helper failed');return JSON.parse(result.stdout);
}
async function checkNavigationFinal() {
  const output=path.resolve('docs/screenshots/step4_6_3');mkdirSync(output,{recursive:true});
  const measurements=[];
  const target=seq=>url.replace(/\/\d+$/,`/${seq}`);
  const ready=seq=>until(()=>evaluate(`location.href===${JSON.stringify(target(seq))} && document.readyState==='complete' && document.getElementById('reader-toc')?.dataset.sequence==='${seq}' && !document.getElementById('reader-toc-footer').disabled`),'Final Reader not ready');
  const waitAnimations=()=>evaluate("Promise.all(document.getElementById('reader-toolbar').getAnimations().concat(document.getElementById('reader-toc').getAnimations()).map(a=>a.finished.catch(()=>{})))");
  const footer=async()=>{await evaluate("document.activeElement.blur();document.querySelector('.reader-navigation').scrollIntoView({block:'center'})");await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await waitAnimations();};
  const top=async()=>{await evaluate('document.activeElement.blur();scrollTo(0,0)');await until(()=>evaluate("!document.getElementById('reader-toolbar').classList.contains('is-hidden')"),'Final header did not show');await waitAnimations();};
  const shot=async name=>{await evaluate('document.fonts.ready.then(()=>true)');await waitAnimations();const s=await send('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(output,name),Buffer.from(s.data,'base64'));};
  const open=async trigger=>{
    const before=tocFetches;await pointerClick(`#${trigger}`);
    await until(()=>evaluate("document.getElementById('reader-toc').open && document.getElementById('reader-toc-list').getAttribute('aria-busy')==='false' && document.querySelector('#reader-toc-list li[aria-current]')"),'Shared drawer not ready');await waitAnimations();
    assert.equal(await evaluate("document.querySelectorAll('#reader-toc').length"),1);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('[data-reader-toc-open]')).every(el=>el.getAttribute('aria-expanded')==='true')"),true);
    return tocFetches-before;
  };
  const closed=async(trigger,y)=>{
    await until(()=>evaluate(`!document.getElementById('reader-toc').open && document.activeElement.id==='${trigger}'`),'Wrong TOC opener focus restored');
    // Drain scroll-lock reflow/restoration before measuring the next independent scroll gesture.
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await waitAnimations();
    assert(Math.abs(await evaluate('scrollY')-y)<1,'Closing Footer TOC moved the Reader');
    assert.equal(await evaluate("Array.from(document.querySelectorAll('[data-reader-toc-open]')).every(el=>el.getAttribute('aria-expanded')==='false')"),true);
  };
  const choose=seq=>pointerClick(`#reader-toc-list li[data-sequence="${seq}"] .reader-toc-chapter`,true,'padding');
  const confirm=()=>until(()=>evaluate("!document.getElementById('reader-jump-confirmation').hidden"),'Footer confirmation did not open');
  const desired=async()=>{
    assert.deepEqual(await evaluate('window.ReadNovelReaderPreferences.snapshot()'),{theme:'dark',fontFamily:'Merriweather',fontSize:23,lineHeight:2.1,readingWidth:'wide'});
    assert.deepEqual(await typographyStyles(),{family:'Merriweather, Georgia, serif',size:'23px',height:'48.3px',width:'768px'});
  };
  const setting=(name,value)=>pointerClick(`.reader-theme-panel label:has(input[name="${name}"][value="${value}"]) .reader-option-text`,true);
  const layout=async(width,theme,chapter)=>{
    const data=await evaluate(`(() => {const nav=document.querySelector('.reader-navigation'),n=nav.getBoundingClientRect();return {width:innerWidth,theme:document.querySelector('.reader-page').dataset.readerTheme,chapter:${chapter},footer:{width:n.width,height:n.height},overflow:document.documentElement.scrollWidth>innerWidth,controls:Array.from(nav.children,el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),range=document.createRange();range.selectNodeContents(el.querySelector('span')||el);const rects=Array.from(range.getClientRects());return {id:el.id,width:r.width,height:r.height,left:r.left,right:r.right,font:s.fontSize,radius:s.borderRadius,border:s.borderWidth,color:s.color,textFits:rects.every(t=>t.left>=r.left&&t.right<=r.right&&t.top>=r.top&&t.bottom<=r.bottom)};})};})()`);
    assert.equal(data.theme,theme);assert.equal(data.overflow,false);
    assert.deepEqual(data.controls.map(c=>c.id),['reader-previous-chapter','reader-toc-footer','reader-next-chapter']);
    for(const c of data.controls){assert(c.width>=44&&c.height>=44&&c.left>=0&&c.right<=width,JSON.stringify(data));assert.equal(c.radius,'12px');assert.equal(c.border,'1px');assert(c.textFits,JSON.stringify(data));}
    assert(data.footer.height<=100,'Navigation footer controls too tall');
    assert(data.controls[0].right<=data.controls[1].left&&data.controls[1].right<=data.controls[2].left,'Footer controls overlap');
    measurements.push(data);
  };
  const hook=await send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {const q=window.__navigationFinalQa={writes:[],pageshows:[]};const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){q.writes.push(key);return set.call(this,key,value);};window.addEventListener('pageshow',e=>q.pageshows.push(e.persisted));})()`});
  await send('Fetch.enable',{patterns:[{urlPattern:'*/api/novels/*/chapters?*'}]});
  for(const [width,height] of [[1528,826],[1366,768],[1920,1080],[390,844],[360,800],[320,800]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:target(1)});await ready(1);await resetPreferenceFixture();await send('Page.reload');await ready(1);await evaluate('document.fonts.ready.then(()=>true)');
    await footer();await layout(width,'sepia',1);const y=await evaluate('scrollY');
    if([1528,390,320].includes(width))await shot(`footer-first-sepia-${width}.png`);
    assert.equal(await open('reader-toc-footer'),1);if([1528,390].includes(width))await shot(`toc-from-footer-${width}.png`);
    await pointerClick('#reader-toc-close');await closed('reader-toc-footer',y);
    assert.equal(await open('reader-toc-footer'),0);await inputKey('Escape','Escape',27);await closed('reader-toc-footer',y);
    if(width>320){
      await open('reader-toc-footer');await send('Input.dispatchMouseEvent',{type:'mousePressed',x:width-5,y:height/2,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:width-5,y:height/2,button:'left',clickCount:1});await closed('reader-toc-footer',y);
    }
    await open('reader-toc-footer');const time=await evaluate('performance.timeOrigin');await choose(1);await closed('reader-toc-footer',y);assert.equal(await evaluate('performance.timeOrigin'),time);
    await open('reader-toc-footer');await choose(9);await confirm();
    if([1528,390].includes(width))await shot(`confirmation-from-footer-${width}.png`);
    await pointerClick('#reader-jump-cancel');assert.equal(await evaluate("document.activeElement.closest('li')?.dataset.sequence"),'9');
    await choose(9);await confirm();await pointerClick('#reader-toc-close');await closed('reader-toc-footer',y);
    await top();assert.equal(await open('reader-toc-open'),0);await inputKey('Escape','Escape',27);await closed('reader-toc-open',0);
    await footer();assert.equal(await open('reader-toc-footer'),0);await pointerClick('#reader-toc-close');await closed('reader-toc-footer',y);
    // Focused Footer must not leave the Smart Header pinned after its dialog closes.
    await evaluate(`scrollTo(0,${y-30})`);await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.equal(await evaluate("document.getElementById('reader-toolbar').classList.contains('is-hidden')"),false);
    await evaluate(`scrollTo(0,${y-10})`);await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.equal(await evaluate("document.getElementById('reader-toolbar').classList.contains('is-hidden')"),true,JSON.stringify(await evaluate("({active:document.activeElement.id,open:document.getElementById('reader-toc').open,expanded:document.getElementById('reader-toc-open').getAttribute('aria-expanded'),scrollY})")));
    await top();await pointerClick('#reader-theme-trigger');await setting('reader-theme','dark');await setting('reader-font-family','Merriweather');
    for(let i=0;i<4;i++)await pointerClick('#reader-font-size-increase',true);
    await setting('reader-line-height','2.1');await setting('reader-reading-width','wide');await inputKey('Escape','Escape',27);await desired();
    await footer();await layout(width,'dark',1);if([1528,390,320].includes(width))await shot(`footer-first-dark-${width}.png`);
    await open('reader-toc-footer');await choose(9);await confirm();await pointerClick('#reader-jump-continue');await ready(9);await desired();
    await footer();await layout(width,'dark',9);if([1528,390,320].includes(width))await shot(`footer-middle-dark-${width}.png`);
    await pointerClick('#reader-next-chapter');await ready(15);await desired();await footer();await layout(width,'dark',15);
    assert.equal(await evaluate("document.getElementById('reader-next-chapter').tagName"),'SPAN');
    if([1528,390,320].includes(width))await shot(`footer-last-dark-${width}.png`);
    await open('reader-toc-footer');await pointerClick('#reader-toc-close');await closed('reader-toc-footer',await evaluate('scrollY'));
    await pointerClick('#reader-previous-chapter');await ready(9);await desired();await top();await pointerClick('#reader-theme-trigger');await setting('reader-theme','light');await inputKey('Escape','Escape',27);
    await footer();await layout(width,'light',9);if([1528,390].includes(width))await shot(`footer-middle-light-${width}.png`);
    // Keyboard follows DOM/visual order, skipping disabled first/last controls.
    await evaluate("document.getElementById('reader-previous-chapter').focus()");await inputKey('Tab','Tab',9);assert.equal(await evaluate('document.activeElement.id'),'reader-toc-footer');
    assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineWidth"),'2px');if([1528,390].includes(width))await shot(`footer-focus-${width}.png`);
    await inputKey(' ','Space',32);await until(()=>evaluate("document.getElementById('reader-toc').open"),'Space did not activate Footer');await waitAnimations();await inputKey('Escape','Escape',27);
    await until(()=>evaluate("document.activeElement.id==='reader-toc-footer'"),'Keyboard close did not restore Footer');
    assert.equal(await evaluate("window.__navigationFinalQa.writes.every(key=>key==='readnovel.reader.settings')"),true,'Navigation wrote non-preference storage');
    console.log(`PASS: final Footer ${width}x${height}: three controls, all themes/44px, shared cache, X/Escape/backdrop/current/confirmation focus+scroll, Toolbar switch, header unpin, keyboard and persisted settings.`);
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1528,height:826,deviceScaleFactor:1,mobile:false});
  const freshFooter=async()=>{
    const previousDocument=await evaluate('performance.timeOrigin');
    await send('Page.navigate',{url:target(1)});
    await until(async()=>await evaluate('performance.timeOrigin')!==previousDocument,'Footer fixture reused an old document');
    await ready(1);await footer();
  };
  // A completed request legitimately populates the shared cache, even if loading was seen earlier.
  await freshFooter();responseMode='slow';const completedY=await evaluate('scrollY');
  assert.equal(await open('reader-toc-footer'),1);await pointerClick('#reader-toc-close');await closed('reader-toc-footer',completedY);responseMode='real';
  const completedReopenGets=await open('reader-toc-footer');
  assert.equal(completedReopenGets,0,'Successfully loaded Footer page must reopen from cache');
  await pointerClick('#reader-toc-close');await closed('reader-toc-footer',completedY);

  // The abort scenario must close while the request is still paused, not race a 400ms response.
  await freshFooter();heldTocRequests=[];responseMode='held';
  await evaluate("(() => {window.__footerAbortSignals=0;const original=window.fetch;window.fetch=(resource,options)=>{options?.signal?.addEventListener('abort',()=>window.__footerAbortSignals++,{once:true});return original(resource,options);};})()");
  const loadingY=await evaluate('scrollY');await pointerClick('#reader-toc-footer');
  await until(()=>heldTocRequests.length>0,'Footer request was not intercepted');
  assert.equal(heldTocRequests.length,1,'Footer loading must start exactly one TOC GET');
  const held=heldTocRequests[0];assert.equal(typeof held.networkId,'string','Missing Network ID for Footer abort verification');
  await until(()=>evaluate("document.getElementById('reader-toc-list').getAttribute('aria-busy')==='true' && document.getElementById('reader-toc-status').textContent.includes('Đang tải')"),'No Footer loading state');
  await waitAnimations();
  assert.equal(await evaluate("document.getElementById('reader-toc-list').children.length"),0,'Held request unexpectedly rendered a page');
  assert.equal(await evaluate('window.__footerAbortSignals'),0,'Footer load aborted before the close action');
  await pointerClick('#reader-toc-close');await closed('reader-toc-footer',loadingY);
  await until(()=>evaluate('window.__footerAbortSignals===1'),'Closing Footer did not abort its request');
  const abortSignals=await evaluate('window.__footerAbortSignals');
  await until(()=>failedRequests.has(held.networkId),'Canceled Footer request did not reach a terminal Network event');
  assert.equal(failedRequests.get(held.networkId).canceled,true,'Footer request ended without network cancellation');
  assert.equal(heldTocRequests.length,1,'Duplicate requests started while Footer load was held');
  responseMode='real';
  const interruptedReopenGets=await open('reader-toc-footer');
  assert.equal(interruptedReopenGets,1,'Interrupted Footer load must issue exactly one fresh TOC GET');
  await pointerClick('#reader-toc-close');await closed('reader-toc-footer',loadingY);
  console.log('PASS: Footer completed-load cache uses zero GETs; held-load close emits one abort/canceled request, then reopen issues exactly one GET.');
  await open('reader-toc-footer');await evaluate("document.getElementById('reader-toc-footer').remove()");await pointerClick('#reader-toc-close');await closed('reader-toc-open',loadingY);
  await send('Page.reload');await ready(1);await footer();const fallbackY=await evaluate('scrollY');await open('reader-toc-footer');await evaluate("document.querySelectorAll('[data-reader-toc-open]').forEach(el=>el.remove())");await pointerClick('#reader-toc-close');await closed('reader-chapter-title',fallbackY);
  await send('Page.reload');await ready(1);await top();await pointerClick('#reader-theme-trigger');await setting('reader-theme','dark');await inputKey('Escape','Escape',27);await desired();
  const firstHistory=await send('Page.getNavigationHistory');const firstEntry=firstHistory.entries[firstHistory.currentIndex].id;
  await footer();await pointerClick('#reader-next-chapter');await ready(3);await desired();
  const secondHistory=await send('Page.getNavigationHistory');const secondEntry=secondHistory.entries[secondHistory.currentIndex].id;
  await send('Page.navigateToHistoryEntry',{entryId:firstEntry});await ready(1);await desired();
  const backCached=await evaluate('window.__navigationFinalQa.pageshows.includes(true)');await footer();await open('reader-toc-footer');await pointerClick('#reader-toc-close');
  await send('Page.navigateToHistoryEntry',{entryId:secondEntry});await ready(3);await desired();
  const forwardCached=await evaluate('window.__navigationFinalQa.pageshows.includes(true)');await send('Page.reload');await ready(3);await desired();
  await send('Runtime.evaluate',{expression:`window.__readerFinalPopup=window.open(${JSON.stringify(target(9))},'reader-navigation-final');Boolean(window.__readerFinalPopup)`,userGesture:true,returnByValue:true});
  await until(()=>evaluate("window.__readerFinalPopup?.document.readyState==='complete' && !!window.__readerFinalPopup.ReadNovelReaderPreferences"),'New Reader tab did not initialize');
  assert.deepEqual(await evaluate('window.__readerFinalPopup.ReadNovelReaderPreferences.snapshot()'),{theme:'dark',fontFamily:'Merriweather',fontSize:23,lineHeight:2.1,readingWidth:'wide'});
  assert.equal(await evaluate("window.__readerFinalPopup.document.getElementById('reader-toc').dataset.sequence"),'9');await evaluate('window.__readerFinalPopup.close();delete window.__readerFinalPopup');
  // Low viewport and 200%-equivalent reflow; do not call deviceScaleFactor a native browser zoom test.
  for(const [width,height] of [[390,400],[764,413]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:target(1)});await ready(1);await footer();await layout(width,'dark',1);
    await open('reader-toc-footer');await choose(15);await confirm();
    const confirmationAx=await send('Accessibility.getFullAXTree');
    assert(confirmationAx.nodes.some(n=>!n.ignored&&n.role?.value==='dialog'&&n.name?.value?.startsWith('Chuyển đến')));
    for(const name of ['Ở lại','Tiếp tục đọc'])assert(confirmationAx.nodes.some(n=>!n.ignored&&n.role?.value==='button'&&n.name?.value===name));
    const box=await evaluate("(() => {const p=document.getElementById('reader-jump-confirmation'),h=document.getElementById('reader-jump-title');p.scrollTop=0;const a=p.getBoundingClientRect(),b=h.getBoundingClientRect();return {top:a.top,titleTop:b.top,height:a.height,scroll:p.scrollHeight,client:p.clientHeight};})()");
    await shot(`confirmation-low-${width}x${height}.png`);assert(box.titleTop>=box.top-1,`Confirmation title clipped at scroll start: ${JSON.stringify(box)}`);
    await pointerClick('#reader-jump-cancel',true);await pointerClick('#reader-toc-close');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await footer();await open('reader-toc-footer');
    assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-toc')).animationName"),'none');assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-toc-footer')).transitionDuration"),'0s');await pointerClick('#reader-toc-close');
    await send('Emulation.setEmulatedMedia',{features:[]});
  }
  const ax=await send('Accessibility.getFullAXTree');
  assert(ax.nodes.some(n=>!n.ignored&&n.role?.value==='button'&&n.name?.value==='Mở mục lục chương'));
  assert(!requests.some(value=>/\/api\/(auth|progress|bookmarks)/.test(value)));assert.deepEqual(networkWrites,[]);assert.deepEqual(errors,[]);assert.equal(responseCookies,0);
  writeFileSync(path.join(output,'measurements.json'),JSON.stringify({measurements,backCached,forwardCached,footerLoading:{completedReopenGets,interruptedReopenGets,abortSignals,networkCanceled:failedRequests.get(held.networkId).canceled},advanced:['390x400','764x413 reflow'],nativeZoom200:'NOT TESTED',httpWrites:0,responseCookies,errors},null,2));
  await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:hook.identifier});
  console.log(`PASS: Footer loading abort, missing-trigger fallbacks, Back/Forward (BFCache ${backCached}/${forwardCached}), reload/new tab preferences, low viewport/reflow, reduced motion and DOM accessibility; no progress storage/writes.`);
}
async function checkTocJump() {
  const output=path.resolve(finalMode?'docs/screenshots/step4_6_3/regression':'docs/screenshots/step4_6_2');mkdirSync(output,{recursive:true});
  const confirmationMeasurements=[];
  const luminance=color=>{const channels=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;};
  const rankUrl=process.argv.find(value=>value.startsWith('--rank-url=')).slice('--rank-url='.length);
  const fixtureCommand=fixtureAction;
  const initialState=fixtureCommand('--fixture-state');
  const destination=seq=>url.replace(/\/\d+$/,`/${seq}`);
  const ready=seq=>until(()=>evaluate(`location.href===${JSON.stringify(destination(seq))} && document.readyState==='complete' && document.getElementById('reader-toc')?.dataset.sequence==='${seq}' && !document.getElementById('reader-toc-open').disabled`),'Jump destination not ready');
  const top=async()=>{
    await evaluate('document.activeElement.blur();scrollTo(0,0)');
    await until(()=>evaluate("!document.getElementById('reader-toolbar').classList.contains('is-hidden')"),'Header did not show');
    await evaluate("Promise.all(document.getElementById('reader-toolbar').getAnimations().map(a=>a.finished.catch(()=>{})))");
  };
  const listReady=(page=1,pages=1)=>until(()=>evaluate(`document.getElementById('reader-toc-page').textContent==='Trang ${page}/${pages}' && document.getElementById('reader-toc-list').getAttribute('aria-busy')==='false'`),'Jump TOC list not ready');
  const open=async(page=1,pages=1)=>{
    await top();const before=tocFetches;await pointerClick('#reader-toc-open');await listReady(page,pages);
    await evaluate("Promise.all(document.getElementById('reader-toc').getAnimations().map(a=>a.finished.catch(()=>{})))");
    return tocFetches-before;
  };
  const close=async()=>{await pointerClick('#reader-toc-close');await until(()=>evaluate("!document.getElementById('reader-toc').open && document.activeElement.id==='reader-toc-open'"),'Jump TOC close/focus failed');};
  const choose=(seq,part='text')=>pointerClick(`#reader-toc-list li[data-sequence="${seq}"] ${part==='text'?'.reader-toc-title':'.reader-toc-chapter'}`,true,part);
  const confirmReady=async()=>{
    await until(()=>evaluate("!document.getElementById('reader-jump-confirmation').hidden && document.getElementById('reader-toc-browse').hidden"),'Confirmation not shown');
    const data=await evaluate("(() => {const button=document.getElementById('reader-jump-continue'),s=getComputedStyle(button),r=button.getBoundingClientRect();return {width:innerWidth,theme:document.querySelector('.reader-page').dataset.readerTheme,background:getComputedStyle(document.getElementById('reader-toc')).backgroundColor,buttonBackground:s.backgroundColor,buttonColor:s.color,buttonHeight:r.height,overflow:document.documentElement.scrollWidth>innerWidth};})()");
    const values=[luminance(data.buttonBackground),luminance(data.buttonColor)].sort((a,b)=>b-a);
    data.buttonContrast=(values[0]+.05)/(values[1]+.05);assert(data.buttonContrast>=4.5,JSON.stringify(data));assert(data.buttonHeight>=44);assert.equal(data.overflow,false);
    assert.equal(data.background,{sepia:'rgb(247, 242, 231)',light:'rgb(250, 248, 245)',dark:'rgb(19, 21, 24)'}[data.theme]);
    confirmationMeasurements.push(data);
  };
  const shot=async name=>{await evaluate('document.fonts.ready.then(()=>true)');const s=await send('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(output,name),Buffer.from(s.data,'base64'));};
  const state=()=>evaluate(`({href:location.href,time:performance.timeOrigin,settings:localStorage.getItem('${preferenceKey}'),page:document.getElementById('reader-toc-page').textContent,scroll:document.getElementById('reader-toc-list').scrollTop})`);
  const cancel=async(seq,method='pointer')=>{
    const before=await state();
    if(method==='escape')await inputKey('Escape','Escape',27);else await pointerClick('#reader-jump-cancel');
    await until(()=>evaluate("document.getElementById('reader-jump-confirmation').hidden && !document.getElementById('reader-toc-browse').hidden"),'Cancel did not return to list');
    const after=await state();assert.equal(after.href,before.href);assert.equal(after.time,before.time);assert.equal(after.settings,before.settings);assert.equal(after.page,before.page);
    assert.equal(await evaluate("document.activeElement.closest('li')?.dataset.sequence"),String(seq));
  };
  const desired=async()=>{
    assert.deepEqual(await typographyStyles(),{family:'Merriweather, Georgia, serif',size:'23px',height:'48.3px',width:'768px'});
    assert.equal(await evaluate("document.querySelector('.reader-page').dataset.readerTheme"),'dark');
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#reader-theme-panel input:checked'),el=>el.value)"),['dark','Merriweather','2.1','wide']);
    assert.equal(await evaluate("document.getElementById('reader-font-size-value').textContent"),'23px');
  };
  const chooseSetting=(name,value)=>pointerClick(`.reader-theme-panel label:has(input[name="${name}"][value="${value}"]) .reader-option-text`,true);
  const hook=await send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {window.__tocQa={writes:0};const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='${preferenceKey}')window.__tocQa.writes++;return set.call(this,key,value);};})()`});
  // Preserve all prior error/abort/cache/focus/race checks; only obsolete noninteractive assertions changed.
  await checkToc(rankUrl);
  await send('Emulation.setEmulatedMedia',{features:[]});
  const results=[];
  for(const [width,height] of [[1528,826],[1366,768],[1920,1080],[390,844],[360,800],[320,800]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:destination(1)});await ready(1);await resetPreferenceFixture();await send('Page.reload');await ready(1);
    // Deliberately load the same external controller twice; the production DOM guard must prevent duplicate listeners.
    await evaluate("new Promise(resolve=>{const script=document.createElement('script');script.src='/static/js/reader_toc.js';script.onload=()=>resolve(true);document.head.append(script);})");
    assert.equal(await open(),1);
    assert.equal(await evaluate("document.querySelectorAll('#reader-toc-list .reader-toc-chapter').length"),4);
    assert.equal(await evaluate("document.querySelectorAll('#reader-toc-list img,#reader-toc-list script').length"),0);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('#reader-toc-list li')).some(el=>['2','4','7'].includes(el.dataset.sequence))"),false);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('#reader-toc-list a')).every(el=>new URL(el.href).origin===location.origin && el.getBoundingClientRect().height>=44)"),true);
    if(width===1528||width===390)await shot(`toc-sepia-${width}.png`);
    const currentTime=await evaluate('performance.timeOrigin');await choose(1);
    await until(()=>evaluate("!document.getElementById('reader-toc').open"),'Current chapter did not close TOC');
    assert.equal(await evaluate('performance.timeOrigin'),currentTime);assert.equal(await evaluate('location.href'),destination(1));
    assert.equal(await open(),0,'Reopen duplicated list fetch');
    await choose(9);await confirmReady();
    assert.equal(await evaluate('document.activeElement.id'),'reader-jump-cancel');
    assert.equal(await evaluate("document.getElementById('reader-toc').getAttribute('aria-labelledby')"),'reader-jump-title');
    assert.equal(await evaluate('location.href'),destination(1));
    assert.equal(await evaluate("document.body.textContent.includes('NAVIGATION_CONTENT_9')"),false);
    if(width===1528||width===390)await shot(`confirm-sepia-${width}.png`);
    await cancel(9);
    if(width===1528||width===390)await shot(`after-cancel-sepia-${width}.png`);
    await choose(9);await confirmReady();await cancel(9,'escape');
    if(width>320){
      await choose(15);await confirmReady();
      assert.equal(await evaluate("document.querySelectorAll('#reader-jump-confirmation img,#reader-jump-confirmation script').length"),0);
      assert.equal(await evaluate('window.jumpXss === undefined'),true);
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:width-5,y:height/2,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:width-5,y:height/2,button:'left',clickCount:1});
      await until(()=>evaluate("document.getElementById('reader-jump-confirmation').hidden && document.getElementById('reader-toc').open"),'Backdrop did not cancel confirmation');
      assert.equal(await evaluate("document.activeElement.closest('li')?.dataset.sequence"),'15');
    }
    await close();await top();await pointerClick('#reader-theme-trigger');
    if(width===1528){
      await chooseSetting('reader-theme','light');await inputKey('Escape','Escape',27);await open();await choose(9);await confirmReady();
      await shot('confirm-light-1528.png');await cancel(9);await close();await top();await pointerClick('#reader-theme-trigger');
    }
    await chooseSetting('reader-theme','dark');await chooseSetting('reader-font-family','Merriweather');
    for(let i=0;i<4;i++)await pointerClick('#reader-font-size-increase',true);
    await chooseSetting('reader-line-height','2.1');await chooseSetting('reader-reading-width','wide');
    await inputKey('Escape','Escape',27);await desired();
    await open();await choose(3,'padding');await ready(3);await desired();
    assert.equal(await evaluate('window.__tocQa.writes'),0);
    assert.equal(await evaluate("document.querySelector('.reader-content p').textContent"),'NAVIGATION_CONTENT_3');
    await open();
    assert.equal(await evaluate("document.querySelector('#reader-toc-list li[aria-current]').dataset.sequence"),'3');
    // Tab from close enters the first native link. Enter performs a backward jump.
    await inputKey('Tab','Tab',9);assert.equal(await evaluate("document.activeElement.closest('li')?.dataset.sequence"),'1');
    await inputKey('Enter','Enter',13);await ready(1);await desired();
    await open();const beforeConfirm=requests.length;await choose(9);await confirmReady();
    assert(!requests.slice(beforeConfirm).some(value=>value===destination(9)),'Target prefetched before confirmation');
    assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-toc')).backgroundColor"),'rgb(19, 21, 24)');
    assert.equal(await evaluate("document.getElementById('reader-toolbar').classList.contains('is-hidden')"),false);
    if(width===1528||width===390)await shot(`confirm-dark-${width}.png`);
    // Tab trap stays in the same native dialog while the browse controls are hidden.
    await inputKey('Tab','Tab',9,true);assert.equal(await evaluate('document.activeElement.id'),'reader-toc-close');
    await inputKey('Tab','Tab',9,true);assert.equal(await evaluate('document.activeElement.id'),'reader-jump-continue');
    await inputKey('Tab','Tab',9);assert.equal(await evaluate('document.activeElement.id'),'reader-toc-close');
    await inputKey('Tab','Tab',9);assert.equal(await evaluate('document.activeElement.id'),'reader-jump-cancel');
    await inputKey('Tab','Tab',9);assert.equal(await evaluate('document.activeElement.id'),'reader-jump-continue');
    assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineWidth"),'2px');
    const documentStart=documentResponses.length;
    if(width===1366){
      const p=await evaluate("(() => {const r=document.getElementById('reader-jump-continue').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
      for(const clickCount of [1,2]){
        await send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount});
        await send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount});
      }
    } else if(width===390)await inputKey(' ','Space',32);else await pointerClick('#reader-jump-continue');
    await ready(9);await desired();await delay(100);
    assert.equal(documentResponses.slice(documentStart).filter(item=>item.url===destination(9)).length,1,'Confirm navigated more than once');
    await open();assert.equal(await evaluate("document.querySelector('#reader-toc-list li[aria-current]').dataset.sequence"),'9');
    if(width===1528||width===390)await shot(`after-confirm-dark-${width}.png`);
    await choose(15);await ready(15);await desired();
    assert.equal(await evaluate("document.getElementById('reader-next-chapter').tagName"),'SPAN');
    await open();await choose(3);await ready(3);await desired();
    await evaluate("document.querySelector('.reader-navigation').scrollIntoView({block:'center'})");
    await pointerClick('#reader-next-chapter');await ready(9);await desired();
    await evaluate("document.querySelector('.reader-navigation').scrollIntoView({block:'center'})");
    await pointerClick('#reader-previous-chapter');await ready(3);await desired();
    await top();await checkToolbar(width,height,output);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    await open();assert.equal(await evaluate("document.getElementById('reader-toc').scrollWidth<=document.getElementById('reader-toc').clientWidth"),true);await close();
    results.push({width,height,passed:true});
    console.log(`PASS: TOC jump ${width}x${height}: current/backward/gapped next/forward confirm, pointer text/row/buttons, Cancel/Escape/backdrop, Tab/Enter/Space, one navigation, Dark/Merriweather/23/2.1/Wide, footer and Smart Header.`);
  }
  // Page-2 confirmation preserves exact browsing page, list scroll and selected anchor focus.
  await send('Page.navigate',{url:rankUrl});await until(()=>evaluate("document.readyState==='complete' && document.getElementById('reader-toc')?.dataset.sequence==='2500' && !document.getElementById('reader-toc-open').disabled"),'Rank fixture not loaded');
  await open(2,3);
  const scrolledTarget='#reader-toc-list li[data-sequence="3940"] .reader-toc-chapter';
  await evaluate(`document.querySelector(${JSON.stringify(scrolledTarget)}).scrollIntoView({block:'nearest'})`);
  const scrollBeforeCancel=await evaluate("document.getElementById('reader-toc-list').scrollTop");
  assert(scrollBeforeCancel>0,'Page-2 fixture did not exercise a scrolled list');
  const cancelFetches=tocFetches;await pointerClick(scrolledTarget);await confirmReady();await cancel(3940);
  assert.equal(await evaluate("document.getElementById('reader-toc-list').scrollTop"),scrollBeforeCancel);
  assert.equal(await evaluate("document.getElementById('reader-toc-page').textContent"),'Trang 2/3');
  assert.equal(tocFetches,cancelFetches,'Cancel fetched a new list page');
  await shot('after-cancel-page2-scrolled-320.png');
  const beforeLast=tocFetches;await pointerClick('[data-toc-page="last"]');await listReady(3,3);
  assert.equal(tocFetches,beforeLast+1,'Pagination should fetch exactly one metadata page');
  const far='#reader-toc-list li[data-sequence="4000"] .reader-toc-chapter';
  await pointerClick(far,true,'padding');await confirmReady();await cancel(4000);
  assert.equal(await evaluate("document.getElementById('reader-toc-page').textContent"),'Trang 3/3');
  const savedListScroll=await evaluate("document.getElementById('reader-toc-list').scrollTop");
  await pointerClick(far);await confirmReady();await cancel(4000,'escape');
  assert.equal(await evaluate("document.getElementById('reader-toc-list').scrollTop"),savedListScroll);
  await pointerClick(far);await confirmReady();await pointerClick('#reader-jump-continue');
  await until(()=>evaluate("document.readyState==='complete' && document.getElementById('reader-toc')?.dataset.sequence==='4000' && !document.getElementById('reader-toc-open').disabled"),'Cross-page confirmation failed');
  await desired();await open(3,3);assert.equal(await evaluate("document.querySelector('#reader-toc-list li[aria-current]').dataset.sequence"),'4000');
  await close();await send('Page.navigate',{url:rankUrl.replace(/\/2500$/,'/2440')});
  await until(()=>evaluate("document.readyState==='complete' && document.getElementById('reader-toc')?.dataset.sequence==='2440' && !document.getElementById('reader-toc-open').disabled"),'Rank50 load failed');
  await open(1,3);await pointerClick('[data-toc-page="next"]');await listReady(2,3);
  await choose(2500);await confirmReady();
  assert.equal(await evaluate("document.getElementById('reader-jump-target').textContent.includes('<img src=x')"),true);
  assert.equal(await evaluate("document.querySelectorAll('#reader-jump-confirmation img,#reader-jump-confirmation script').length"),0);
  assert.equal(await evaluate('window.tocXss === undefined'),true);
  await cancel(2500);
  await choose(2470);await until(()=>evaluate("document.readyState==='complete' && document.getElementById('reader-toc')?.dataset.sequence==='2470' && !document.getElementById('reader-toc-open').disabled"),'Adjacent rank50/51 jump failed');
  await open(2,3);assert.equal(await evaluate("document.querySelector('#reader-toc-list li[aria-current]').dataset.sequence"),'2470');await close();
  // Archive only the UUID fixture's target after confirmation has already been rendered.
  await send('Page.navigate',{url:destination(1)});await ready(1);await open();await choose(15);await confirmReady();
  assert.deepEqual(fixtureCommand('--archive-target'),{archived:1});
  const raceStart=documentResponses.length;await pointerClick('#reader-jump-continue');
  await until(()=>evaluate(`location.href===${JSON.stringify(destination(15))} && document.readyState==='complete' && !document.querySelector('.reader-content')`),'Publication race did not return 404');
  assert.deepEqual(documentResponses.slice(raceStart).filter(item=>item.url===destination(15)).map(item=>item.status),[404]);
  assert.equal(await evaluate("document.body.textContent.includes('NAVIGATION_CONTENT_15')"),false);
  assert.deepEqual(fixtureCommand('--fixture-state'),initialState);
  assert(!requests.some(value=>value.includes('/api/auth/')||value.includes('/api/progress')||value.includes('/api/bookmarks')));
  assert.deepEqual(networkWrites,[]);assert.deepEqual(errors,[]);assert.equal(responseCookies,0,'Guest Reader received Set-Cookie');
  writeFileSync(path.join(output,'measurements.json'),JSON.stringify({viewports:results,confirmationMeasurements,networkWrites:0,responseCookies,errors,fixtureStateUnchanged:true,publicationRace:404,tocFetches},null,2));
  await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:hook.identifier});
  console.log('PASS: real PostgreSQL cross-page cancellation/focus/scroll, rank50/51, publication-race 404, unchanged fixture progress/bookmarks/session count; no auth/progress/bookmark requests or HTTP writes.');
}
async function checkToc(readerUrl = url) {
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/novels/*/chapters?*' }] });
  const output = jumpMode ? path.resolve(finalMode?'docs/screenshots/step4_6_3/regression/toc':'docs/screenshots/step4_6_2/regression') : visualMode ? visualOutput : path.resolve(typographyMode ? 'docs/screenshots/step4_5_3' : themeMode ? 'docs/screenshots/step4_5_2' : toolbarMode ? 'docs/screenshots/step4_5_1' : 'docs/screenshots/step4_4_3b');
  mkdirSync(output, { recursive: true });
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const opened = () => evaluate("document.getElementById('reader-toc').open");
  const ready = page => until(() => evaluate(`document.getElementById('reader-toc-page').textContent === 'Trang ${page}/3' && document.getElementById('reader-toc-list').getAttribute('aria-busy') === 'false'`), 'TOC page did not load');
  const key = async (value, shift = false) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: value === 'Tab' ? 9 : 27, modifiers: shift ? 8 : 0 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value, windowsVirtualKeyCode: value === 'Tab' ? 9 : 27, modifiers: shift ? 8 : 0 });
  };
  async function navigate() {
    await resetPreferenceFixture();
    await send('Page.navigate', { url:readerUrl });
    await until(() => evaluate("document.readyState === 'complete' && !!document.getElementById('reader-toc-open') && !document.getElementById('reader-toc-open').disabled"), 'TOC did not initialize');
  }
  if (typographyMode) {
    await send('Emulation.setScriptExecutionDisabled', { value: true });
    try {
      await send('Page.navigate', { url:readerUrl });
      await until(() => evaluate("document.readyState === 'complete' && !!document.querySelector('.reader-content')"), 'No-JS SSR failed');
      assert.deepEqual(await typographyStyles(), {family:'Lora, Merriweather, Georgia, serif',size:'19px',height:'35.15px',width:'672px'});
      assert.equal(await evaluate("document.getElementById('reader-theme-selector').hidden"), true);
      assert.equal(await evaluate("document.querySelectorAll('.reader-content p').length"), 4);
      console.log('PASS: real browser SSR with page JavaScript disabled: default typography and escaped chapter content remain readable.');
    } finally { await send('Emulation.setScriptExecutionDisabled', { value: false }); }
  }
  const regressionViewports=visualMode ? [[1528,826],[1366,768],[1920,1080],[390,844],[360,800]] : [[1920,1080],[1366,768],[390,844],[360,800]];
  for (const [width, height] of regressionViewports) {
    responseMode = 'real';
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await navigate();
    if (toolbarMode) {
      await checkToolbar(width, height, output);
      await navigate();
    }
    if (themeMode) {
      await checkThemes(width, height, output);
      await navigate();
    }
    if (typographyMode) {
      await checkTypography(width, height, output);
      await navigate();
    }
    const before = tocFetches;
    await evaluate('scrollTo(0,500)');
    const savedScroll = await evaluate('scrollY');
    await click('#reader-toc-open'); await ready(2);
    assert.equal(tocFetches, before + 1);
    assert.equal(await evaluate("document.querySelector('#reader-toc-list [aria-current]').dataset.sequence"), '2500');
    assert.equal(await evaluate("document.getElementById('reader-toc').dataset.initialPage"), '2');
    assert.equal(await evaluate("document.querySelectorAll('#reader-toc-list img,#reader-toc-list script,#reader-toc-list iframe').length"), 0);
    assert.equal(await evaluate("document.querySelectorAll('#reader-toc-list a').length"),49);
    assert.equal(await evaluate("document.querySelectorAll('#reader-toc-list button[aria-current=page]').length"),1);
    assert.equal(await evaluate("document.getElementById('reader-toc-list').textContent.includes('DRAFT_OR_ARCHIVED_SECRET')"), false);
    assert.equal(await evaluate('window.tocXss === undefined'), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate("document.getElementById('reader-toc').scrollWidth <= document.getElementById('reader-toc').clientWidth"), true);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('#reader-toc a,#reader-toc button')).filter(el => el.getClientRects().length).every(el => el.getBoundingClientRect().height >= 44)"), true);
    await evaluate("document.getElementById('reader-toc-page-go').focus()"); await key('Tab');
    assert.equal(await evaluate('document.activeElement.id'), 'reader-toc-close');
    await key('Tab', true);
    assert.equal(await evaluate('document.activeElement.id'), 'reader-toc-page-go');
    await click('#reader-toc-title'); assert.equal(await opened(), true);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(output, `toc-${width}.png`), Buffer.from(shot.data, 'base64'));
    await key('Escape');
    await until(() => evaluate("!document.getElementById('reader-toc').open && document.activeElement.id === 'reader-toc-open'"), 'Escape did not close and restore focus');
    assert.equal(await evaluate('document.activeElement.id'), 'reader-toc-open');
    assert.equal(await evaluate('scrollY'), savedScroll);
    await click('#reader-toc-open'); await ready(2);
    assert.equal(tocFetches, before + 1, 'Repeated open duplicated fetch');
    await click('[data-toc-page="last"]'); await ready(3);
    assert.equal(await evaluate("document.querySelector('[data-toc-page=next]').disabled"), true);
    await click('[data-toc-page="first"]'); await ready(1);
    assert.equal(await evaluate("document.querySelector('[data-toc-page=previous]').disabled"), true);
    await evaluate("document.getElementById('reader-toc-page-input').value = '2'; document.getElementById('reader-toc-page-form').requestSubmit()"); await ready(2);
    await click('#reader-toc-close');
    await until(async () => !(await opened()), 'X did not close');
    await click('#reader-toc-open'); await ready(2);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: width - 5, y: 100, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: width - 5, y: 100, button: 'left', clickCount: 1 });
    await until(async () => !(await opened()), 'Backdrop did not close');
  }
  console.log('PASS: real TOC pagination/rank/highlight, XSS safety, modal close modes, Tab trap/restore, scroll restore, cache, bounds and four responsive sizes.');
  responseMode = 'real'; await navigate(); await click('#reader-toc-open'); await ready(2);
  const cachedCount = tocFetches;
  await evaluate("document.getElementById('reader-toc-close').click(); document.getElementById('reader-toc-open').click()");
  await ready(2); await delay(100);
  assert.equal(await evaluate("document.getElementById('reader-toc-open').getAttribute('aria-expanded')"), 'true');
  assert.equal(await evaluate('document.documentElement.style.overflow'), 'hidden');
  assert.equal(tocFetches, cachedCount);
  await click('#reader-toc-close');
  assert.equal(await evaluate('document.documentElement.style.overflow'), '');
  for (const mode of ['404','422','503','network','empty']) {
    responseMode = mode;
    await navigate(); await click('#reader-toc-open');
    await until(() => evaluate(mode === 'empty' ? "document.getElementById('reader-toc-page').textContent === 'Trang 0/0'" : "!document.getElementById('reader-toc-retry').hidden"), 'Missing error or empty state');
    assert.equal(await evaluate("document.getElementById('reader-toc').textContent.includes('PRIVATE_SQL_DETAIL')"), false);
    if (mode !== 'empty') {
      responseMode = 'real'; await click('#reader-toc-retry'); await ready(2);
    }
    await click('#reader-toc-close');
  }
  // Shorten only the application's 15-second timeout; exercise its actual abort path.
  responseMode = 'slow'; await navigate();
  await evaluate("window.nativeTimeout = window.setTimeout; window.setTimeout = (callback, ms, ...args) => window.nativeTimeout(callback, ms === 15000 ? 60 : ms, ...args)");
  await click('#reader-toc-open');
  await until(() => evaluate("document.getElementById('reader-toc-status').textContent.includes('quá thời gian chờ')"), 'Timeout state missing');
  await evaluate('window.setTimeout = window.nativeTimeout');
  await click('#reader-toc-close'); await delay(450);
  responseMode = 'slow'; await navigate(); await click('#reader-toc-open');
  assert.equal(await evaluate("document.getElementById('reader-toc-status').textContent"), 'Đang tải mục lục...');
  await click('#reader-toc-close'); await delay(500);
  assert.equal(await opened(), false);
  responseMode = 'real';
  await click('#reader-toc-open'); await ready(2);
  // Ignore AbortSignal in a controlled fetch stub to force out-of-order completion.
  await evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (url, options) => {
      const page = Number(new URL(url, location.origin).searchParams.get('page'));
      const response = await original(url, { ...options, signal: undefined });
      if (page === 1) await new Promise(resolve => setTimeout(resolve, 400));
      return response;
    };
  })()`);
  await click('[data-toc-page="first"]'); await click('[data-toc-page="last"]'); await ready(3); await delay(500);
  assert.equal(await evaluate("document.getElementById('reader-toc-page').textContent"), 'Trang 3/3');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-toc')).animationName"), 'none');
  if (toolbarMode) assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-toolbar')).transitionDuration"), '0s');
  assert(!requests.some(value => value.includes('/api/auth/') || value.includes('/api/progress') || value.includes('/api/bookmarks')));
  assert.deepEqual(errors, []);
  console.log('PASS: 404/422/503/network/empty/timeout and manual retry, loading, close cancellation, stale-response guard, reduced motion; no auth/progress/bookmark calls or JS/console errors.');
  if (visualMode) await captureSettingsVisual();
  if (persistenceMode) await checkPersistence();
}
async function resetPreferenceFixture() {
  if(await evaluate('location.origin')===new URL(url).origin) await evaluate(`localStorage.removeItem('${preferenceKey}')`);
}
const unrelatedStorage = () => evaluate(`JSON.stringify([Object.entries(localStorage).filter(([key])=>key!=='${preferenceKey}'),Object.entries(sessionStorage),document.cookie])`);
async function captureSettingsVisual() {
  mkdirSync(visualOutput,{recursive:true});
  const measurements=[];
  for (const [width,height] of [[1528,826],[1366,768],[1366,650],[1920,1080],[390,844],[360,800],[320,800]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await resetPreferenceFixture();
    await send('Page.navigate',{url});
    await until(()=>evaluate("document.readyState==='complete' && !document.getElementById('reader-typography-controls').hidden"),'Settings did not initialize');
    await pointerClick('#reader-theme-trigger');
    await evaluate('document.fonts.ready.then(()=>true)');
    for (const theme of ['sepia','light','dark']) {
      await pointerClick(`.reader-theme-panel label:has(input[name="reader-theme"][value="${theme}"])${captureBefore ? '' : ' .reader-option-text'}`,true);
      await evaluate("document.getElementById('reader-theme-panel').scrollTop=0");
      const metrics=await evaluate(`(() => {
        const panel=document.getElementById('reader-theme-panel'),r=panel.getBoundingClientRect(),style=getComputedStyle(panel);
        const labels=Array.from(panel.querySelectorAll('label')).map(label=>{
          const rect=label.getBoundingClientRect();let lines=0,textFits=true;
          const walker=document.createTreeWalker(label,NodeFilter.SHOW_TEXT);
          while(walker.nextNode()){if(!walker.currentNode.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(walker.currentNode);lines=Math.max(lines,range.getClientRects().length);const text=range.getBoundingClientRect();textFits=textFits && text.left>=rect.left && text.right<=rect.right;}
          return {text:label.textContent.trim(),height:rect.height,width:rect.width,lines,textFits};
        });
        return {width:innerWidth,height:innerHeight,theme:document.querySelector('.reader-page').dataset.readerTheme,panel:{left:r.left,top:r.top,width:r.width,height:r.height,bottom:r.bottom,scrollHeight:panel.scrollHeight,clientHeight:panel.clientHeight,background:style.backgroundColor,scrollbarWidth:style.scrollbarWidth},labels};
      })()`);
      measurements.push(metrics);
      assert.equal(metrics.theme,theme);
      assert(metrics.panel.left>=0 && metrics.panel.left+metrics.panel.width<=width && metrics.panel.bottom<=height);
      if(!captureBefore){
        assert(metrics.labels.every(label=>label.height>=44 && label.width>=44 && label.lines===1 && label.textFits),JSON.stringify(metrics));
        if(width>=360 && height>=650) assert(metrics.panel.scrollHeight<=metrics.panel.clientHeight+1,'Panel unnecessarily scrolls in a standard viewport');
      }
      const shot=await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(path.join(visualOutput,`settings-${theme}-${width}x${height}.png`),Buffer.from(shot.data,'base64'));
      await evaluate("document.getElementById('reader-theme-panel').scrollTop=10000");
      if(width===1528 || width===1366 || width===390){
        const lower=await send('Page.captureScreenshot',{format:'png'});
        writeFileSync(path.join(visualOutput,`settings-${theme}-${width}x${height}-lower.png`),Buffer.from(lower.data,'base64'));
      }
    }
    if(!captureBefore){
      for(const font of ['Merriweather','Roboto','Lora']){
        await pointerClick(`.reader-theme-panel label:has(input[name="reader-font-family"][value="${font}"]) .reader-option-text`,true);
        assert.match((await typographyStyles()).family,new RegExp(`^${font}`));
        assert.equal(await evaluate(`(() => {const span=document.querySelector('label:has(input[name="reader-font-family"][value="${font}"]) .reader-option-text'),r=span.getBoundingClientRect(),p=span.parentElement.getBoundingClientRect();return r.left>=p.left && r.right<=p.right;})()`),true,`${font} label overflows at ${width}px`);
      }
    }
    console.log(`${captureBefore?'BEFORE':'AFTER'} Settings ${width}x${height}: ${JSON.stringify(measurements.at(-3).panel)}`);
  }
  writeFileSync(path.join(visualOutput,'measurements.json'),JSON.stringify(measurements,null,2));
  assert.deepEqual(errors,[]);
}
async function captureNextReference() {
  if(process.argv.includes('--toc-reference')) {await captureTocReference();return;}
  if(process.argv.includes('--navigation-reference')) {await captureNavigationReference();return;}
  const output=path.resolve('docs/screenshots/step4_5_4a/reference');
  mkdirSync(output,{recursive:true});
  await send('Network.setBlockedURLs',{urls:['*supabase.co*']});
  const metrics=[];
  for(const [width,height] of [[1528,826],[1366,768],[1366,650],[1920,1080],[390,844],[360,800],[320,800]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url});
    await until(()=>evaluate("document.readyState==='complete' && !!document.querySelector('button[title=\"Tùy chỉnh đọc sách\"]')"),'Next.js Reader not available');
    await pointerClick('button[title="Tùy chỉnh đọc sách"]');
    await until(()=>evaluate("!!document.querySelector('div.fixed.top-16.right-4')"),'Next.js settings did not open');
    await evaluate('document.fonts.ready.then(()=>true)');
    const data=await evaluate(`(() => {const p=document.querySelector('div.fixed.top-16.right-4'),r=p.getBoundingClientRect(),s=getComputedStyle(p);return {width:innerWidth,height:innerHeight,panel:{width:r.width,height:r.height,top:r.top,right:innerWidth-r.right,padding:s.padding,borderRadius:s.borderRadius,background:s.backgroundColor,font:s.font,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight},buttons:Array.from(p.querySelectorAll('button')).map(el=>({text:el.textContent.trim(),height:el.getBoundingClientRect().height}))};})()`);
    metrics.push(data);
    const shot=await send('Page.captureScreenshot',{format:'png'});
    writeFileSync(path.join(output,`next-settings-sepia-${width}x${height}.png`),Buffer.from(shot.data,'base64'));
    console.log(`NEXT REFERENCE ${width}x${height}: ${JSON.stringify(data.panel)}`);
  }
  assert(!requests.some(value=>value.includes('supabase.co')),'Reference tried to access Supabase');
  writeFileSync(path.join(output,'measurements.json'),JSON.stringify(metrics,null,2));
}
async function captureTocReference() {
  const output=path.resolve('docs/screenshots/step4_6_2/reference');mkdirSync(output,{recursive:true});
  await send('Network.setBlockedURLs',{urls:['*supabase.co*']});
  await send('Page.navigate',{url});
  await until(()=>evaluate("document.readyState==='complete' && !!document.querySelector('header button')"),'Next Reader unavailable');
  const measurements=[];
  for(const [width,height] of [[1528,826],[1366,768],[1920,1080],[390,844],[360,800],[320,800]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    for(const theme of ['sepia','dark']){
      await evaluate(`localStorage.setItem('reader_theme','${theme}')`);await send('Page.navigate',{url});
      await until(()=>evaluate("document.readyState==='complete' && !!document.querySelector('header button')"),'Next Reader not ready');
      // Wait for hydration/legacy restoration before exercising the original button.
      await delay(300);await pointerClick('header button');
      await until(()=>evaluate("!!document.querySelector('input[placeholder=\"Tìm số chương hoặc tên...\"]')"),'Next TOC did not open');
      await evaluate('document.fonts.ready.then(()=>true)');
      const data=await evaluate(`(() => {const input=document.querySelector('input[placeholder="Tìm số chương hoặc tên..."]'),panel=input.parentElement.parentElement,r=panel.getBoundingClientRect(),s=getComputedStyle(panel);return {width:innerWidth,height:innerHeight,theme:'${theme}',panel:{width:r.width,height:r.height,padding:s.padding,background:s.backgroundColor},rows:Array.from(panel.querySelectorAll('a')).map(a=>({href:a.getAttribute('href'),height:a.getBoundingClientRect().height,text:a.textContent.trim()}))};})()`);
      assert.equal(data.panel.background,theme==='dark'?'rgb(19, 21, 24)':'rgb(247, 242, 231)');
      measurements.push(data);const screenshot=await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(path.join(output,`next-toc-${theme}-${width}.png`),Buffer.from(screenshot.data,'base64'));
    }
  }
  assert(!requests.some(value=>value.includes('supabase.co')));
  writeFileSync(path.join(output,'measurements.json'),JSON.stringify(measurements,null,2));
  console.log('PASS: original Next.js TOC link/current-row visual reference at six viewports, Sepia/Dark, mock only, no Supabase requests.');
}
async function captureNavigationReference() {
  const output=path.resolve(process.argv.includes('--final-reference')?'docs/screenshots/step4_6_3/reference':'docs/screenshots/step4_6_1/reference');mkdirSync(output,{recursive:true});
  await send('Network.setBlockedURLs',{urls:['*supabase.co*']});
  const measurements=[];
  await send('Page.navigate',{url});
  await until(()=>evaluate("document.readyState==='complete' && !!document.querySelector('nav[aria-label=\"Điều hướng chương\"]')"),'Next navigation not ready');
  for(const [width,height] of [[1528,826],[1366,768],[1920,1080],[390,844],[360,800],[320,800]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    for(const theme of ['sepia','dark']){
      for(const chapter of (width===1528||width===390 ? [1,2,3] : [2])){
        await evaluate(`localStorage.setItem('reader_theme','${theme}')`);
        const destination=new URL(url);destination.pathname=destination.pathname.replace(/\/\d+$/,`/${chapter}`);
        await send('Page.navigate',{url:destination.href});
        await until(()=>evaluate(`location.href===${JSON.stringify(destination.href)} && document.readyState==='complete' && !!document.querySelector('nav[aria-label="Điều hướng chương"]')`),'Next reference navigation failed');
        await until(()=>evaluate(`getComputedStyle(document.querySelector('nav[aria-label="Điều hướng chương"]')).color==='${theme==='dark'?'rgb(220, 224, 230)':'rgb(56, 46, 37)'}'`),'Next theme not restored');
        await evaluate('document.fonts.ready.then(()=>true)');
        await evaluate("document.querySelector('nav[aria-label=\"Điều hướng chương\"]').scrollIntoView({block:'center'})");await delay(250);
        const data=await evaluate(`(() => {const nav=document.querySelector('nav[aria-label="Điều hướng chương"]'),s=getComputedStyle(nav);return {width:innerWidth,chapter:${chapter},theme:'${theme}',overflow:document.documentElement.scrollWidth>innerWidth,font:s.font,fontFamily:s.fontFamily,marginTop:s.marginTop,paddingTop:s.paddingTop,border:s.borderTopColor,controls:Array.from(nav.children,el=>{const r=el.getBoundingClientRect(),c=getComputedStyle(el);return {tag:el.tagName,text:el.textContent.trim(),width:r.width,height:r.height,left:r.left,right:r.right,padding:c.padding,radius:c.borderRadius,opacity:c.opacity};})};})()`);
        measurements.push(data);
        const screenshot=await send('Page.captureScreenshot',{format:'png'});
        writeFileSync(path.join(output,`next-${chapter}-${theme}-${width}.png`),Buffer.from(screenshot.data,'base64'));
      }
    }
  }
  assert(!requests.some(value=>value.includes('supabase.co')));
  writeFileSync(path.join(output,'measurements.json'),JSON.stringify(measurements,null,2));
  console.log('PASS: unmodified Next.js mock navigation reference, first/middle/last and six desktop/mobile viewports, Sepia/Dark, no Supabase access.');
}
async function checkToolbar(width, height, output) {
  async function scroll(y) {
    await evaluate(`document.activeElement.blur(); window.scrollTo(0, ${y})`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
  const visible = () => evaluate("!document.getElementById('reader-toolbar').classList.contains('is-hidden')");
  assert.equal(await visible(), true);
  assert.equal(await evaluate("document.querySelectorAll('#reader-toolbar').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('#reader-toc-open').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('#reader-toc').length"), 1);
  assert.equal(await evaluate("document.querySelector('.reader-toolbar-home').getAttribute('href')"), '/');
  assert.equal(await evaluate("Array.from(document.querySelectorAll('#reader-toolbar button,#reader-toolbar a')).filter(el=>el.getClientRects().length).every(el => {const r=el.getBoundingClientRect();return r.width>=44 && r.height>=44;})"), true);
  assert.equal(await evaluate("(() => {const title=document.querySelector('.reader-toolbar-title').getBoundingClientRect();const controls=document.querySelector('.reader-toolbar-actions').getBoundingClientRect(); return title.left >= controls.right + 6 && title.right <= innerWidth;})()"), true);
  const articleTop = await evaluate("document.querySelector('.reader-container').getBoundingClientRect().top + scrollY");
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(output, `toolbar-${width}.png`), Buffer.from(screenshot.data, 'base64'));
  await scroll(119); assert.equal(await visible(), true);
  await scroll(120); assert.equal(await visible(), true);
  await scroll(131); assert.equal(await visible(), false);
  await scroll(140); assert.equal(await visible(), false); // +9 does not toggle.
  await scroll(135); assert.equal(await visible(), false); // -5 does not toggle.
  await scroll(124); assert.equal(await visible(), true); // -11 shows.
  await scroll(135); assert.equal(await visible(), false);
  await scroll(120); assert.equal(await visible(), true);
  await evaluate("document.querySelector('.reader-toolbar-home').focus({preventScroll:true});scrollTo(0,500)");
  await delay(30); assert.equal(await visible(), true); // Never hide focused controls.
  await scroll(520); assert.equal(await visible(), false);
  assert.equal(await evaluate('scrollY'), 520);
  assert.equal(await evaluate("document.querySelector('.reader-container').getBoundingClientRect().top + scrollY"), articleTop);
  await evaluate("document.getElementById('reader-toc-open').focus({preventScroll:true})");
  assert.equal(await visible(), true, JSON.stringify(await evaluate("({ active: document.activeElement.id, disabled: document.getElementById('reader-toc-open').disabled, dialogOpen: document.getElementById('reader-toc').open, toolbarClass: document.getElementById('reader-toolbar').className })")));
  await scroll(540); assert.equal(await visible(), false);
  // A programmatically opened TOC also pins a previously hidden toolbar.
  await evaluate("document.getElementById('reader-toc-open').click()");
  await until(() => visible(), 'Toolbar did not reveal for TOC');
  await until(() => evaluate("document.getElementById('reader-toc-list').getAttribute('aria-busy') === 'false'"), 'TOC not ready');
  await evaluate("Promise.all(document.getElementById('reader-toc').getAnimations().map(animation => animation.finished.catch(() => {})))");
  assert.equal(await evaluate("(() => {const button=document.getElementById('reader-toc-close'); const r=button.getBoundingClientRect();return document.getElementById('reader-toc').contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()"), true);
  await evaluate('scrollTo(0,600)'); await delay(30);
  assert.equal(await visible(), true);
  await evaluate("document.getElementById('reader-toc-close').click()");
  assert.equal(await evaluate('document.activeElement.id'), 'reader-toc-open');
  assert.equal(await visible(), true);
  assert.equal(await evaluate('scrollY'), 540);
  await scroll(10000); assert.equal(await visible(), false); // No invented show-at-bottom rule.
  const bottom = await evaluate('scrollY');
  await scroll(bottom - 11); assert.equal(await visible(), true);
  await scroll(0); assert.equal(await visible(), true);
  // Physical wheel input supplements exact scrollTo threshold checks above.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width / 2, y: height / 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: width / 2, y: height / 2, deltaX: 0, deltaY: 400 });
  await until(async () => await evaluate('scrollY > 120') && !(await visible()), 'Wheel down did not hide toolbar');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: width / 2, y: height / 2, deltaX: 0, deltaY: -150 });
  await until(() => visible(), 'Wheel up did not reveal toolbar');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: width / 2, y: height / 2, deltaX: 0, deltaY: -10000 });
  await until(async () => await evaluate('scrollY === 0') && await visible(), 'Wheel to top failed');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  console.log(`PASS: Toolbar ${width}x${height}: source scroll thresholds, physical wheel down/up/top, small deltas, no layout shift, keyboard/focus pin, hidden-header TOC integration, safe long title and 44px controls.`);
}
async function checkThemes(width, height, output) {
  const click = pointerClick;
  const key = async (key, code, virtual) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual });
  };
  const expected = {
    sepia: ['rgb(247, 242, 231)','rgb(56, 46, 37)','rgba(237, 229, 206, 0.95)'],
    light: ['rgb(250, 248, 245)','rgb(30, 35, 42)','rgba(240, 236, 228, 0.95)'],
    dark: ['rgb(19, 21, 24)','rgb(220, 224, 230)','rgba(26, 29, 36, 0.95)'],
  };
  const assertPalette = async theme => {
    const palette = await evaluate("(() => {const r=getComputedStyle(document.querySelector('.reader-page'));const t=getComputedStyle(document.getElementById('reader-toolbar'));return [r.backgroundColor,r.color,t.backgroundColor];})()");
    assert.deepEqual(palette, expected[theme]);
    const surfaces = {sepia:'rgb(237, 229, 206)',light:'rgb(240, 236, 228)',dark:'rgb(26, 29, 36)'};
    assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-theme-panel')).backgroundColor"), surfaces[theme]);
    for (const selector of ['.reader-content', '#reader-chapter-title', '#reader-toolbar']) {
      assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color`), expected[theme][1]);
    }
  };
  await evaluate('document.fonts.ready.then(() => true)');
  assert.equal(await evaluate("document.querySelector('.reader-page').dataset.readerTheme"), 'sepia');
  assert.equal(await evaluate("document.querySelectorAll('#reader-theme-selector').length"), 1);
  const originalStorage = await unrelatedStorage();
  const originTime = await evaluate('performance.timeOrigin');
  await evaluate("document.getElementById('reader-theme-trigger').focus({preventScroll:true})");
  await key(' ', 'Space', 32);
  await until(() => evaluate("document.getElementById('reader-theme-trigger').getAttribute('aria-expanded') === 'true'"), 'Theme keyboard open failed');
  await key('Tab', 'Tab', 9);
  assert.equal(await evaluate('document.activeElement.value'), 'sepia', JSON.stringify(await evaluate("({tag:document.activeElement.tagName,id:document.activeElement.id,open:document.getElementById('reader-theme-selector').open})")));
  await key('ArrowRight', 'ArrowRight', 39);
  assert.equal(await evaluate("document.querySelector('.reader-page').dataset.readerTheme"), 'light');
  await assertPalette('light');
  await key('ArrowRight', 'ArrowRight', 39);
  await assertPalette('dark');
  await key('ArrowLeft', 'ArrowLeft', 37);
  await assertPalette('light');
  await key('Escape', 'Escape', 27);
  assert.equal(await evaluate("document.getElementById('reader-theme-selector').open"), false);
  assert.equal(await evaluate('document.activeElement.id'), 'reader-theme-trigger');
  await evaluate('document.fonts.ready.then(() => true)');
  // Diagnostic capture only: no app state mutation or synthetic change/click events.
  await evaluate(`(() => {
    window.themeInteractionTrace = [];
    for (const type of ['pointerdown','mousedown','focusout','pointerup','click','change','toggle']) {
      document.addEventListener(type, event => {
        if (window.themeInteractionTrace.length >= 60) window.themeInteractionTrace.shift();
        window.themeInteractionTrace.push({type, target:event.target.tagName, trusted:event.isTrusted,
          related:event.relatedTarget?.tagName ?? null,
          open:document.getElementById('reader-theme-selector').open,
          theme:document.querySelector('.reader-page').dataset.readerTheme});
      }, true);
    }
  })()`);
  for (const theme of ['sepia','light','dark','sepia']) {
    await click('#reader-theme-trigger');
    const networkBefore = requests.length;
    await evaluate('scrollTo(0,400)');
    const y = await evaluate('scrollY');
    const articleTop = await evaluate("document.querySelector('.reader-container').getBoundingClientRect().top + scrollY");
    await click(`.reader-theme-panel label:has(input[value="${theme}"])`);
    assert.equal(await evaluate("document.querySelector('.reader-page').dataset.readerTheme"), theme, JSON.stringify(await evaluate('window.themeInteractionTrace')));
    assert.equal(await evaluate("document.querySelector('input[name=reader-theme]:checked').value"), theme);
    assert.equal(await evaluate('scrollY'), y);
    assert.equal(await evaluate("document.querySelector('.reader-container').getBoundingClientRect().top + scrollY"), articleTop);
    assert.equal(await evaluate('performance.timeOrigin'), originTime);
    assert.equal(requests.length, networkBefore, 'Theme selection sent a request');
    await assertPalette(theme);
    const menuBox = await evaluate("(() => {const r=document.getElementById('reader-theme-panel').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom};})()");
    assert(menuBox.left >= 0 && menuBox.right <= width && menuBox.bottom <= height);
    assert.equal(await evaluate("document.getElementById('reader-toolbar').classList.contains('is-hidden')"), false);
    await key('Escape','Escape',27);
    assert.equal(await evaluate('document.activeElement.id'), 'reader-theme-trigger');
    assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-theme-trigger')).outlineStyle"), 'solid');
    assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-theme-trigger')).outlineWidth"), '2px');
    if (width === 1920 || width === 390) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(output, `reader-${theme}-${width}.png`), Buffer.from(shot.data,'base64'));
    }
    await click('#reader-toc-open');
    await until(() => evaluate("!!document.querySelector('#reader-toc-list [aria-current]') && document.getElementById('reader-toc-list').getAttribute('aria-busy') === 'false'"), 'Themed TOC did not load');
    await evaluate("Promise.all(document.getElementById('reader-toc').getAnimations().map(a=>a.finished.catch(()=>{})))");
    assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-toc')).backgroundColor"), expected[theme][0]);
    assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-toc')).color"), expected[theme][1]);
    const ratios = await evaluate(`(() => {
      const rgb = value => value.trim().startsWith('#') ? value.trim().slice(1).match(/../g).map(v=>parseInt(v,16)) : value.match(/[\\d.]+/g).map(Number);
      const blend = (top, base) => top.slice(0,3).map((v,i) => v*(top[3]??1)+base[i]*(1-(top[3]??1)));
      const luminance = c => c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
      const ratio = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
      const root=getComputedStyle(document.querySelector('.reader-page'));
      const row=getComputedStyle(document.querySelector('#reader-toc-list [aria-current]'));
      const muted=getComputedStyle(document.querySelector('.reader-toc-number'));
      const bg=rgb(root.backgroundColor), active=blend(rgb(row.backgroundColor),bg);
      return {body:ratio(rgb(root.color),bg),muted:ratio(rgb(muted.color),bg),current:ratio(rgb(row.color),active),focus:ratio(rgb(root.getPropertyValue('--reader-accent')),bg)};
    })()`);
    assert(ratios.body >= 4.5 && ratios.muted >= 4.5 && ratios.current >= 4.5 && ratios.focus >= 3, JSON.stringify(ratios));
    console.log(`CONTRAST ${theme}: ${JSON.stringify(ratios)}`);
    if (width === 1920 || width === 390) {
      const shot = await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(path.join(output,`toc-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
    }
    await click('#reader-toc-close');
  }
  // Also exercise the radio circle itself: text-label and input hit targets differ.
  for (const theme of ['light','dark','sepia']) {
    await click('#reader-theme-trigger');
    await click(`input[name="reader-theme"][value="${theme}"]`);
    await assertPalette(theme);
    await key('Escape','Escape',27);
  }
  assert.equal(await evaluate("window.themeInteractionTrace.some(event => event.type === 'change' && event.trusted)"), true);
  // Native Tab away still closes the menu without stealing the destination focus.
  await click('#reader-theme-trigger');
  await key('Tab','Tab',9);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  assert.equal(await evaluate('document.activeElement.id'), 'reader-theme-trigger');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  assert.equal(await evaluate("document.getElementById('reader-theme-selector').open"), false);
  assert.equal(await evaluate('document.activeElement.id'), 'reader-toc-open');
  assert.equal(await unrelatedStorage(), originalStorage);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('${preferenceKey}')).theme`),'sepia');
  await send('Page.navigate',{url});
  await until(() => evaluate("document.readyState === 'complete' && !!document.getElementById('reader-theme-trigger')"), 'Reload failed');
  assert.equal(await evaluate("document.querySelector('.reader-page').dataset.readerTheme"), 'sepia');
  console.log(`PASS: Themes ${width}x${height}: trusted label/radio clicks, keyboard/Tab-away, computed colors, no reload/scroll shift/network calls; unrelated storage unchanged and last chosen theme restored.`);
}
async function typographyStyles() {
  return evaluate(`(() => {
    const text=getComputedStyle(document.querySelector('.reader-content'));
    return {family:text.fontFamily,size:text.fontSize,height:text.lineHeight,
      width:getComputedStyle(document.querySelector('.reader-container')).maxWidth};
  })()`);
}
async function checkTypography(width, height, output) {
  const defaults = {family:'Lora, Merriweather, Georgia, serif',size:'19px',height:'35.15px',width:'672px'};
  assert.deepEqual(await typographyStyles(), defaults);
  const content = () => evaluate("Array.from(document.querySelectorAll('.reader-content p'),p=>p.textContent)");
  const uiStyles = () => evaluate(`['#reader-toolbar','.reader-toolbar-title','#reader-toc','#reader-toc-page-input','#reader-toc-open'].map(selector=>{
    const s=getComputedStyle(document.querySelector(selector));return [s.fontFamily,s.fontSize,s.lineHeight];})`);
  const paragraphs = await content(), originalUi = await uiStyles();
  assert.equal(paragraphs.length, 4);
  assert.equal(paragraphs[1], 'Dòng một\nDòng hai');
  const headingSize = await evaluate("getComputedStyle(document.getElementById('reader-chapter-title')).fontSize");
  const storage = await unrelatedStorage();
  const time = await evaluate('performance.timeOrigin');
  const appRequests = () => requests.filter(value => new URL(value).origin === new URL(url).origin).length;
  const beforeRequests = appRequests();
  await evaluate(`window.typographyChanges=[];document.getElementById('reader-typography-controls').addEventListener('change',event=>window.typographyChanges.push({name:event.target.name,trusted:event.isTrusted}));`);
  await evaluate("scrollTo(0,400);document.getElementById('reader-theme-trigger').focus({preventScroll:true})");
  await inputKey(' ','Space',32);
  await inputKey('Tab','Tab',9); // Current theme radio.
  await inputKey('Tab','Tab',9); // Current font radio.
  assert.equal(await evaluate('document.activeElement.name'), 'reader-font-family');
  await inputKey('ArrowRight','ArrowRight',39);
  assert.match((await typographyStyles()).family, /^Merriweather/);
  await inputKey('ArrowRight','ArrowRight',39);
  assert.match((await typographyStyles()).family, /^Roboto/);
  await inputKey('Escape','Escape',27);
  assert.equal(await evaluate('document.activeElement.id'), 'reader-theme-trigger');
  await pointerClick('#reader-theme-trigger');
  for (const font of ['Merriweather','Lora','Roboto']) {
    await pointerClick(`.reader-theme-panel label:has(input[name="reader-font-family"][value="${font}"]) .reader-option-text`, true);
    assert.match((await typographyStyles()).family, new RegExp(`^${font}`));
    assert.match(await evaluate("getComputedStyle(document.getElementById('reader-chapter-title')).fontFamily"), new RegExp(`^${font}`));
    assert.equal(await evaluate('document.activeElement.name'), 'reader-font-family');
  }
  // Direct radio hit target, separately from clicking the font label text.
  await pointerClick('input[name="reader-font-family"][value="Merriweather"]', true);
  assert.match((await typographyStyles()).family, /^Merriweather/);
  await pointerClick('input[name="reader-font-family"][value="Roboto"]', true);
  for (let i=0;i<4;i++) await pointerClick('#reader-font-size-decrease', true);
  assert.equal((await typographyStyles()).size, '15px');
  assert.equal(await evaluate("document.getElementById('reader-font-size-decrease').disabled"), true);
  for (let i=0;i<13;i++) await pointerClick('#reader-font-size-increase', true);
  assert.equal((await typographyStyles()).size, '28px');
  assert.equal(await evaluate("document.getElementById('reader-font-size-increase').disabled"), true);
  assert.equal(await evaluate("document.getElementById('reader-font-size-value').textContent"), '28px');
  for (let i=0;i<5;i++) await pointerClick('#reader-font-size-decrease', true);
  assert.equal((await typographyStyles()).size, '23px');
  await inputKey('Tab','Tab',9); // Increase button, from decrease.
  assert.equal(await evaluate('document.activeElement.id'), 'reader-font-size-increase');
  await inputKey(' ','Space',32);
  assert.equal((await typographyStyles()).size, '24px');
  await inputKey('Tab','Tab',9,true);
  assert.equal(await evaluate('document.activeElement.id'), 'reader-font-size-decrease');
  await inputKey('Enter','Enter',13);
  assert.equal((await typographyStyles()).size, '23px');
  await inputKey('Tab','Tab',9);
  await inputKey('Tab','Tab',9); // Current line-height radio.
  assert.equal(await evaluate('document.activeElement.name'), 'reader-line-height');
  await inputKey('ArrowRight','ArrowRight',39);
  assert(Math.abs(parseFloat((await typographyStyles()).height) - 23*2.1) < .01);
  for (const value of ['1.65','1.85','2.1']) {
    await pointerClick(`.reader-theme-panel label:has(input[name="reader-line-height"][value="${value}"])`, true);
    assert(Math.abs(parseFloat((await typographyStyles()).height) - 23*Number(value)) < .01);
    assert.equal(await evaluate("document.getElementById('reader-line-height-value').textContent"), value);
  }
  for (const [value, max] of [['wide','768px'],['normal','672px'],['wide','768px']]) {
    await pointerClick(`.reader-theme-panel label:has(input[name="reader-reading-width"][value="${value}"])`, true);
    assert.equal((await typographyStyles()).width, max);
    assert.equal(await evaluate('document.activeElement.name'), 'reader-reading-width');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate("document.querySelector('.reader-container').getBoundingClientRect().width <= innerWidth"), true);
  }
  await inputKey('ArrowLeft','ArrowLeft',37);
  assert.equal((await typographyStyles()).width, '672px');
  await inputKey('ArrowRight','ArrowRight',39);
  assert.equal((await typographyStyles()).width, '768px');
  // Adversarial values use synthetic events only to check validation, never to stand in for user QA.
  const valid = await typographyStyles();
  for (const [name, values] of [
    ['reader-font-family',['Unknown','url(https://invalid.example/font)']],
    ['reader-reading-width',['9999px','calc(100vw + 1px)']],
    ['reader-line-height',['NaN','Infinity','0','99','1.75','calc(2)']],
  ]) {
    for (const value of values) {
      await evaluate(`(() => {const el=document.querySelector('input[name="${name}"]');const original=el.value;el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));el.value=original;})()`);
      assert.deepEqual(await typographyStyles(), valid);
    }
  }
  for (const value of ['NaN','Infinity','99','0.5','calc(1)']) {
    await evaluate(`(() => {const el=document.getElementById('reader-font-size-decrease');el.dataset.readerSizeStep=${JSON.stringify(value)};el.dispatchEvent(new MouseEvent('click',{bubbles:true}));el.dataset.readerSizeStep='-1';})()`);
    assert.deepEqual(await typographyStyles(), valid);
  }
  assert.equal(await evaluate("getComputedStyle(document.getElementById('reader-chapter-title')).fontSize"), headingSize);
  assert.deepEqual(await uiStyles(), originalUi);
  assert.deepEqual(await content(), paragraphs);
  assert.equal(await evaluate('scrollY > 0'), true, 'Settings jumped to the beginning');
  assert.equal(await evaluate('performance.timeOrigin'), time);
  assert.equal(appRequests(), beforeRequests, 'Typography made an application request');
  for (const name of ['reader-font-family','reader-line-height','reader-reading-width']) {
    assert.equal(await evaluate(`window.typographyChanges.some(e=>e.name==='${name}' && e.trusted)`), true);
  }
  const bounds = await evaluate("(() => {const el=document.getElementById('reader-theme-panel'),r=el.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,scroll:el.scrollHeight,client:el.clientHeight};})()");
  assert(bounds.left>=0 && bounds.right<=width && bounds.bottom<=height);
  if (width<=390) {
    // A compact panel should fit normal phone heights; exercise overflow only when it is needed.
    await send('Emulation.setDeviceMetricsOverride',{width,height:400,deviceScaleFactor:1,mobile:false});
    assert.equal(await evaluate("document.getElementById('reader-theme-panel').scrollHeight > document.getElementById('reader-theme-panel').clientHeight"),true);
    await evaluate("document.getElementById('reader-theme-panel').scrollTop=0");
    const y = await evaluate('scrollY');
    const point = await evaluate("(() => {const r=document.getElementById('reader-theme-panel').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:600});
    await until(() => evaluate("document.getElementById('reader-theme-panel').scrollTop>0"), 'Panel wheel scrolling failed');
    assert.equal(await evaluate('scrollY'), y);
    await evaluate("document.getElementById('reader-theme-panel').scrollTop=0");
    await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    const touch=await evaluate("(() => {const r=document.getElementById('reader-theme-panel').getBoundingClientRect();return {x:r.right-12,y:r.bottom-25};})()");
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});
    for(const delta of [20,40,60,80,100]){
      await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touch.x,y:touch.y-delta}]});
      await delay(30);
    }
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await until(()=>evaluate("document.getElementById('reader-theme-panel').scrollTop>0"),'Panel touch scrolling failed');
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await evaluate("document.getElementById('reader-theme-panel').scrollTop=0");
    await inputKey('Tab','Tab',9,true);
    await inputKey('Tab','Tab',9);
    assert.equal(await evaluate('document.activeElement.name'),'reader-reading-width');
    assert.equal(await evaluate("(() => {const r=document.activeElement.getBoundingClientRect(),p=document.getElementById('reader-theme-panel').getBoundingClientRect();return r.top>=p.top && r.bottom<=p.bottom;})()"),true);
    if(visualMode){
      const short=await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(path.join(output,`settings-scroll-${width}x400.png`),Buffer.from(short.data,'base64'));
    }
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  }
  await evaluate('scrollTo(0,600)');
  assert.equal(await evaluate("document.getElementById('reader-toolbar').classList.contains('is-hidden')"), false);
  if (width===1920 || width===390) {
    await evaluate("document.getElementById('reader-theme-panel').scrollTop=0");
    const shot=await send('Page.captureScreenshot',{format:'png'});
    writeFileSync(path.join(output,`settings-${width}.png`),Buffer.from(shot.data,'base64'));
  }
  await inputKey('Escape','Escape',27);
  if (width===1920 || width===390) {
    const shot=await send('Page.captureScreenshot',{format:'png'});
    writeFileSync(path.join(output,`reader-roboto-23-wide-${width}.png`),Buffer.from(shot.data,'base64'));
  }
  await pointerClick('#reader-toc-open');
  await until(() => evaluate("document.getElementById('reader-toc-page').textContent === 'Trang 2/3'"), 'Typography TOC page failed');
  assert.deepEqual(await uiStyles(), originalUi);
  await evaluate("Promise.all(document.getElementById('reader-toc').getAnimations().map(a=>a.finished.catch(()=>{})))");
  await pointerClick('[data-toc-page="next"]');
  await until(() => evaluate("document.getElementById('reader-toc-page').textContent === 'Trang 3/3'"), 'Typography TOC next page failed');
  await pointerClick('#reader-toc-close');
  assert.equal(await unrelatedStorage(), storage);
  await send('Page.navigate',{url});
  await until(() => evaluate("document.readyState === 'complete' && !document.getElementById('reader-typography-controls').hidden"), 'Typography reload failed');
  assert.deepEqual(await typographyStyles(), valid);
  assert.equal(await evaluate("document.getElementById('reader-font-size-value').textContent"), '23px');
  console.log(`PASS: Typography ${width}x${height}: real pointer/keyboard, source bounds/options, computed styles, stable UI/content, no application calls; last preferences survive reload and unrelated storage is unchanged.`);
}
async function checkPersistence() {
  const output=path.resolve('docs/screenshots/step4_5_4b');mkdirSync(output,{recursive:true});
  const defaults={theme:'sepia',fontFamily:'Lora',fontSize:19,lineHeight:1.85,readingWidth:'normal'};
  const desired={theme:'dark',fontFamily:'Merriweather',fontSize:23,lineHeight:2.1,readingWidth:'wide'};
  const legacy=['reader_theme','reader_fontFamily','reader_fontSize','reader_lineHeight','reader_maxWidth'];
  const ready=()=>until(()=>evaluate("document.readyState==='complete' && !document.getElementById('reader-typography-controls').hidden"),'Preferences controls did not initialize');
  await send('Page.navigate',{url});await ready();
  // Test-only instrumentation, installed before the real external bootstrap on subsequent documents.
  const hook=await send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {
    const q=window.__readerQa={reads:[],writes:[],frames:[],fcp:0,pageshows:[],layoutShifts:[]};
    const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
    Storage.prototype.getItem=function(key){q.reads.push(key);return get.call(this,key);};
    Storage.prototype.setItem=function(key,value){q.writes.push(key);return set.call(this,key,value);};
    window.addEventListener('pageshow',event=>q.pageshows.push(event.persisted));
    new PerformanceObserver(list=>{for(const entry of list.getEntries())if(entry.name==='first-contentful-paint')q.fcp=entry.startTime;}).observe({type:'paint',buffered:true});
    new PerformanceObserver(list=>{for(const entry of list.getEntries())q.layoutShifts.push({time:entry.startTime,value:entry.value,recentInput:entry.hadRecentInput});}).observe({type:'layout-shift',buffered:true});
    function frame(time){const root=document.querySelector('.reader-page'),text=document.querySelector('.reader-content');
      if(root&&text){const s=getComputedStyle(root),t=getComputedStyle(text);q.frames.push({time,theme:root.dataset.readerTheme,background:s.backgroundColor,font:t.fontFamily,size:t.fontSize,height:t.lineHeight,width:getComputedStyle(document.querySelector('.reader-container')).maxWidth,fontReady:document.fonts.check(t.fontSize+' '+t.fontFamily)});}
      if(!q.fcp && performance.now()<15000)requestAnimationFrame(frame);
    }requestAnimationFrame(frame);
  })()`});
  const seed=async value=>{
    await evaluate(`(() => {for(const key of ${JSON.stringify(legacy)})localStorage.removeItem(key);${value===null ? `localStorage.removeItem('${preferenceKey}')` : `localStorage.setItem('${preferenceKey}',${JSON.stringify(typeof value==='string'?value:JSON.stringify(value))})`};localStorage.setItem('qa.unrelated','keep');})()`);
  };
  const assertState=async expected=>{
    const value=await evaluate(`(() => {const root=document.querySelector('.reader-page'),style=getComputedStyle(document.querySelector('.reader-content'));return {theme:root.dataset.readerTheme,font:style.fontFamily,size:parseFloat(style.fontSize),height:parseFloat(style.lineHeight),width:getComputedStyle(document.querySelector('.reader-container')).maxWidth,themeChoice:document.querySelector('input[name="reader-theme"]:checked')?.value,fontChoice:document.querySelector('input[name="reader-font-family"]:checked')?.value,heightChoice:document.querySelector('input[name="reader-line-height"]:checked')?.value,widthChoice:document.querySelector('input[name="reader-reading-width"]:checked')?.value,sizeOutput:document.getElementById('reader-font-size-value').textContent,heightOutput:document.getElementById('reader-line-height-value').textContent};})()`);
    assert.equal(value.theme,expected.theme);assert.equal(value.themeChoice,expected.theme);
    assert.match(value.font,new RegExp(`^${expected.fontFamily}`));assert.equal(value.fontChoice,expected.fontFamily);
    assert.equal(value.size,expected.fontSize);assert.equal(value.sizeOutput,`${expected.fontSize}px`);
    assert(Math.abs(value.height-expected.fontSize*expected.lineHeight)<.01);
    assert.equal(value.heightChoice,String(expected.lineHeight));assert.equal(value.heightOutput,String(expected.lineHeight));
    assert.equal(value.width,expected.readingWidth==='wide'?'768px':'672px');assert.equal(value.widthChoice,expected.readingWidth);
  };
  const choose=async(name,value)=>pointerClick(`.reader-theme-panel label:has(input[name="${name}"][value="${value}"]) .reader-option-text`,true);
  const shot=async name=>{const image=await send('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(output,name),Buffer.from(image.data,'base64'));};
  const performanceResults=[];
  for(const [width,height] of [[1528,826],[1366,768],[1920,1080],[390,844],[360,800],[320,800]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await seed(null);await send('Page.navigate',{url});await ready();await assertState(defaults);
    assert.equal(await evaluate('window.__readerQa.reads.length'),6);assert.equal(await evaluate('window.__readerQa.writes.length'),0);
    const originalContent=await evaluate("Array.from(document.querySelectorAll('.reader-content p'),p=>p.textContent)");
    const originTime=await evaluate('performance.timeOrigin');
    await pointerClick('#reader-theme-trigger');
    await choose('reader-theme','dark');await choose('reader-font-family','Merriweather');
    for(let i=0;i<4;i++)await pointerClick('#reader-font-size-increase',true);
    await choose('reader-line-height','2.1');await choose('reader-reading-width','wide');
    await assertState(desired);assert.equal(await evaluate('performance.timeOrigin'),originTime);
    assert.equal(await evaluate('window.__readerQa.writes.length'),8);
    await choose('reader-theme','dark');assert.equal(await evaluate('window.__readerQa.writes.length'),8);
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('${preferenceKey}'))`),{version:1,...desired});
    if(width===1528 || width===390)await shot(`dark-merriweather-23-wide-${width}-before-reload.png`);
    await send('Page.reload',{ignoreCache:false});await ready();await assertState(desired);
    assert.equal(await evaluate('window.__readerQa.reads.length'),1);assert.equal(await evaluate('window.__readerQa.writes.length'),0);
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.reader-content p'),p=>p.textContent)"),originalContent);
    assert.equal(await evaluate("localStorage.getItem('qa.unrelated')"),'keep');
    await pointerClick('#reader-theme-trigger');
    if(width===1528 || width===390)await shot(`dark-merriweather-23-wide-${width}-after-reload.png`);
    await inputKey('Escape','Escape',27);assert.equal(await evaluate('document.activeElement.id'),'reader-theme-trigger');
    if(width===390){
      await pointerClick('#reader-theme-trigger');await choose('reader-theme','light');await choose('reader-font-family','Lora');
      for(let i=0;i<4;i++)await pointerClick('#reader-font-size-decrease',true);
      await choose('reader-line-height','1.85');await choose('reader-reading-width','normal');
      await shot('light-lora-19-mobile-before-reload.png');await send('Page.reload');await ready();
      await assertState({...defaults,theme:'light'});await pointerClick('#reader-theme-trigger');await shot('light-lora-19-mobile-after-reload.png');
    }
    console.log(`PASS: Persistence ${width}x${height}: empty defaults, eight real changes/eight writes, no-op zero writes, all five settings and controls restored on reload, unchanged chapter text/unrelated storage.`);
  }
  await seed({version:1,...desired});await send('Page.navigate',{url});await ready();
  const initialHistory=await send('Page.getNavigationHistory');const originalEntry=initialHistory.entries[initialHistory.currentIndex].id;
  const other=new URL(url);other.pathname=other.pathname.replace(/\/\d+$/,'/1');
  await send('Page.navigate',{url:other.href});await ready();await assertState(desired);
  const secondHistory=await send('Page.getNavigationHistory');const secondEntry=secondHistory.entries[secondHistory.currentIndex].id;
  await send('Page.navigateToHistoryEntry',{entryId:originalEntry});
  await until(()=>evaluate(`location.pathname===${JSON.stringify(new URL(url).pathname)} && !!document.getElementById('reader-typography-controls') && !document.getElementById('reader-typography-controls').hidden`),'Back navigation failed');
  await assertState(desired);const backCached=await evaluate('window.__readerQa.pageshows.includes(true)');
  await send('Page.navigateToHistoryEntry',{entryId:secondEntry});await until(()=>evaluate(`location.pathname===${JSON.stringify(other.pathname)} && !document.getElementById('reader-typography-controls').hidden`),'Forward navigation failed');await assertState(desired);
  const forwardCached=await evaluate('window.__readerQa.pageshows.includes(true)');
  const writesBefore=await evaluate('window.__readerQa.writes.length');
  await pointerClick('#reader-theme-trigger');await pointerClick('#reader-font-size-increase',true);
  await assertState({...desired,fontSize:24});assert.equal(await evaluate('window.__readerQa.writes.length'),writesBefore+1);
  await pointerClick('#reader-font-size-decrease',true);await assertState(desired);
  await inputKey('Escape','Escape',27);
  const popup=await send('Runtime.evaluate',{expression:`window.__readerPopup=window.open(${JSON.stringify(url)},'reader-settings-qa');Boolean(window.__readerPopup)`,userGesture:true,returnByValue:true});
  assert.equal(popup.result.value,true);
  await until(()=>evaluate("window.__readerPopup.document.readyState==='complete' && !!window.__readerPopup.ReadNovelReaderPreferences"),'New Reader tab failed');
  assert.deepEqual(await evaluate('window.__readerPopup.ReadNovelReaderPreferences.snapshot()'),desired);
  await evaluate("window.__readerPopup.ReadNovelReaderPreferences.update('theme','light');window.__readerPopup.close();delete window.__readerPopup");
  await send('Page.reload');await ready();await assertState({...desired,theme:'light'});
  performanceResults.push({backCached,forwardCached});
  for(const [raw,expected] of [
    ['{broken',defaults],['null',defaults],['[]',defaults],['{"version":2,"theme":"dark"}',defaults],
    [JSON.stringify({...desired,version:1,fontSize:'23',fontFamily:'url(invalid)',readingWidth:'9999px'}),{...defaults,theme:'dark',lineHeight:2.1}],
  ]){await seed(raw);await send('Page.navigate',{url});await ready();await assertState(expected);}
  await seed(null);await evaluate("localStorage.setItem('reader_theme','dark');localStorage.setItem('reader_fontFamily','Merriweather');localStorage.setItem('reader_fontSize','23');localStorage.setItem('reader_lineHeight','2.1');localStorage.setItem('reader_maxWidth','wide')");
  await send('Page.navigate',{url});await ready();await assertState(desired);
  assert.equal(await evaluate(`localStorage.getItem('${preferenceKey}')`),null);
  assert.equal(await evaluate('window.__readerQa.writes.length'),0);
  for(const failure of ['getter','read','write']){
    await seed({version:1,...desired});
    const failSource=failure==='getter' ? "Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError')}})" : failure==='read' ? "Storage.prototype.getItem=function(){throw new DOMException('Blocked','SecurityError')}" : "Storage.prototype.setItem=function(){throw new DOMException('Full','QuotaExceededError')}";
    const fault=await send('Page.addScriptToEvaluateOnNewDocument',{source:failSource});
    await send('Page.navigate',{url});await ready();const initial=failure==='write'?desired:defaults;await assertState(initial);
    await pointerClick('#reader-theme-trigger');await choose('reader-theme','light');await choose('reader-font-family','Roboto');await pointerClick('#reader-font-size-increase',true);
    await assertState({...initial,theme:'light',fontFamily:'Roboto',fontSize:initial.fontSize+1});
    await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:fault.identifier});
    await send('Page.reload');await ready();await assertState(failure==='read'?{...defaults,theme:'light',fontFamily:'Roboto',fontSize:20}:desired);
    console.log(`PASS: ${failure} storage fault: in-page controls work, reload reflects only successful writes.`);
  }
  // Cold/slow bootstrap: observe root styles in requestAnimationFrame before FCP, not just after load.
  await send('Emulation.setDeviceMetricsOverride',{width:1528,height:826,deviceScaleFactor:1,mobile:false});
  await seed({version:1,...desired});await send('Network.setCacheDisabled',{cacheDisabled:true});
  await send('Emulation.setCPUThrottlingRate',{rate:4});bootstrapDelay=400;
  await send('Fetch.enable',{patterns:[{urlPattern:'*/static/js/reader_preferences.js*'}]});
  await send('Page.navigate',{url});await ready();await assertState(desired);
  await until(()=>evaluate('window.__readerQa.fcp>0 && window.__readerQa.frames.length>0'),'Paint measurement unavailable');
  await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
  const paint=await evaluate("(() => {const q=window.__readerQa,resource=performance.getEntriesByType('resource').find(e=>e.name.includes('/js/reader_preferences.js'));return {fcp:q.fcp,frames:q.frames,bootstrapDuration:resource?.duration,reads:q.reads.length,writes:q.writes.length,layoutShifts:q.layoutShifts,cls:q.layoutShifts.filter(e=>!e.recentInput).reduce((sum,e)=>sum+e.value,0)};})()");
  const prePaint=paint.frames.filter(frame=>frame.time<=paint.fcp);
  assert(prePaint.length>0,`No pre-FCP sample: ${JSON.stringify(paint)}`);
  assert(prePaint.every(frame=>frame.theme==='dark' && frame.background==='rgb(19, 21, 24)' && frame.size==='23px' && frame.width==='768px' && frame.font.startsWith('Merriweather')),JSON.stringify(paint));
  performanceResults.push(paint);console.log(`FIRST PAINT: ${JSON.stringify(paint)}`);
  await send('Emulation.setCPUThrottlingRate',{rate:1});await send('Network.setCacheDisabled',{cacheDisabled:false});bootstrapDelay=0;await send('Fetch.disable');
  assert.deepEqual(networkWrites,[]);assert(!requests.some(value=>/\/api\/(auth|progress|bookmarks)/.test(value)));assert.deepEqual(errors,[]);
  writeFileSync(path.join(output,'measurements.json'),JSON.stringify(performanceResults,null,2));
  await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:hook.identifier});
  console.log(`PASS: persistence across chapters/back/forward/new tab, malformed/legacy/blocked/quota storage, first-paint restoration and no backend writes. Real BFCache: back=${backCached}, forward=${forwardCached}.`);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); socket.close(); }
  browser?.kill();
});
