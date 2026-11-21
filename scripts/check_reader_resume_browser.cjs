/* Real pointer/keyboard navigation and HTTP assertions in an isolated Edge profile. */
'use strict';
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {join} = require('node:path');
const {readFileSync, writeFileSync, writeSync} = require('node:fs');
const assert = require('node:assert/strict');
const {traceResumeRequests} = require('./reader_resume_qa_trace.cjs');
const {executionContextLost, exceptionDetails, readerDocumentAvailable, traceReaderScroll, shutdownBrowser} = require('./reader_qa_cdp.cjs');

const config = JSON.parse(readFileSync(0, 'utf8'));
const invoke = promisify(execFile);
const caseLabel = '['+config.suite+'/'+config.history+(config.round == null ? '' : ' round='+config.round)+']';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = config.profile;
let scenario = 'startup';
let browserSocket;

function checkpoint(message) {
  // Preserve the last reached stage even if the native process terminates before a JS catch.
  writeSync(1, 'Browser QA '+caseLabel+' '+message+'\n');
}

function enterScenario(label) {
  scenario = label;
  checkpoint('scenario='+label);
}

function cdpFailure(message) {
  return Object.assign(new Error(message), {failureKind:'CDP'});
}

function requestAttempt(headers) {
  const value = Object.entries(headers).find(([name])=>name.toLowerCase()==='x-reader-qa-attempt')?.[1];
  return /^[AB]\d+-\d+$/.test(value ?? '') ? value : undefined;
}

checkpoint('Node ready '+process.version+' '+process.arch+
  ' V8 '+process.versions.v8+' Undici '+process.versions.undici+' libuv '+process.versions.uv);

function safeUrl(value) {
  if (value === 'about:blank') return value;
  try {
    const url = new URL(value, config.origin);
    if (url.origin !== config.origin) return null;
    const path = url.pathname;
    if (path === config.path || path.startsWith(config.path + '/') ||
        path === config.progress || path.startsWith(config.progress + '/') ||
        path === '/api/bookmarks/novels/'+config.novel ||
        path.startsWith('/api/bookmarks/novels/'+config.novel+'/chapters/') ||
        /^\/api\/bookmarks\/import(?:\/preview)?$/.test(path) ||
        /^\/api\/auth\/(me|login|register|logout|csrf-token)$/.test(path) ||
        /^\/api\/novels\/resume-qa-[a-f0-9]+\/chapters(?:\/by-id\/[a-f0-9-]+\/revision)?$/.test(path) ||
        /^\/(login|register|api\/health)$/.test(path)) return url.origin + path;
  } catch { /* Unavailable or unrecognized URL. */ }
  return null;
}

function safeScriptUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === config.origin && /^\/static\/js\/[a-z0-9_.-]+\.js$/.test(url.pathname)) {
      return url.origin+url.pathname;
    }
  } catch { /* Anonymous scripts and other origins are omitted. */ }
  return safeUrl(value);
}

function safeText(value) {
  if (typeof value !== 'string') return undefined;
  let text = value;
  for (const secret of [...(config.tokens ?? []),...(config.csrf ?? []),config.password,config.signupEmail]) {
    if (secret) text = text.replaceAll(secret,'[redacted]');
  }
  return text.replace(/https?:\/\/[^\s"'<>]+/g,url=>safeScriptUrl(url) ?? '[URL]')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi,'[UUID]').slice(0,240);
}

async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(35);
  }
  const error = Error(label);
  if (scenario !== 'startup') {
    error.failureKind = 'assertion';
    error.expected = label;
    error.actual = 'condition did not become true';
  }
  throw error;
}

async function openCdpSocket(url, label) {
  checkpoint('CDP opening socket '+label);
  const ws = new WebSocket(url);
  const handshake = new AbortController();
  let deadline;
  try {
    await new Promise((resolve, reject) => {
      const listener = {once:true, signal:handshake.signal};
      const fail = message => reject(cdpFailure(message));
      deadline = setTimeout(() => fail('CDP connection timed out: '+label),6000);
      ws.addEventListener('open', resolve, listener);
      ws.addEventListener('error', () => fail('CDP connection failed'), listener);
      ws.addEventListener('close', event =>
        fail('CDP socket closed before open (WebSocket '+event.code+')'), listener);
    });
  } catch (error) {
    ws.close();
    throw error;
  } finally {
    clearTimeout(deadline);
    handshake.abort();
  }
  return ws;
}

async function connect(target) {
  const ws = await openCdpSocket(target.webSocketDebuggerUrl,target.id);
  checkpoint('CDP target attached '+target.id);
  let index = 0;
  const resumeAttempts = [];
  const pending = new Map(), requests = [], found = new Map(), exceptions = [];
  const cacheMisses = [], paused = [], navigation = [], pointers = [], dialogs = [];
  let expectedNavigation = null;
  let lastPointer = null;
  let mainFrame;
  let frameIdentity = null;
  let lastDocument = null;
  let lastNavigationContextLoss = null;
  const contexts = new Map();
  const contextEvents = [];
  const runtimeErrors = [];
  let closing = false, transportError = null;
  const transport = () => ({targetId:target.id, readyState:ws.readyState, closing,
    error:transportError?.message});
  const contextIdentity = () => ({frame:frameIdentity, document:lastDocument,
    contexts:[...contexts.values()].filter(context=>context.frameId===mainFrame),transport:transport()});
  function addContextEvent(event) {
    contextEvents.push(event);
    if (contextEvents.length > 12) contextEvents.shift();
  }
  function failTransport(message) {
    if (closing || transportError) return;
    transportError = cdpFailure(message);
    checkpoint(message);
    for (const {fail} of pending.values()) fail(transportError);
    pending.clear();
  }
  ws.addEventListener('close', event => failTransport('CDP target disconnected (WebSocket '+event.code+')'));
  ws.addEventListener('error', () => failTransport('CDP target WebSocket error'));
  function noteNavigation(event, frameId, url, details) {
    const sanitized = safeUrl(url);
    if (!sanitized || (mainFrame && frameId !== mainFrame)) return;
    navigation.push({event, url:sanitized, ...details});
    if (navigation.length > 16) navigation.shift();
  }
  ws.onmessage = ({data}) => {
    const payload = JSON.parse(data);
    if (payload.id) {
      const deliver = pending.get(payload.id);
      if (deliver) {
        pending.delete(payload.id);
        deliver.reply(payload);
      }
    }
    if (payload.method === 'Network.requestWillBeSent') {
      const {requestId, request} = payload.params;
      const url = new URL(request.url);
      if (url.origin === config.origin) {
        const entry = {path:url.pathname, method:request.method, loader:payload.params.loaderId,
          type:payload.params.type, id:requestId,
          chapterCount:url.searchParams.getAll('chapter_ids').length};
        entry.attempt = requestAttempt(request.headers);
        found.set(requestId, entry);
        requests.push(entry);
      }
    }
    if (payload.method === 'Network.responseReceived') {
      const entry = found.get(payload.params.requestId);
      if (entry) entry.status = payload.params.response.status;
    }
    if (payload.method === 'Network.loadingFinished' || payload.method === 'Network.loadingFailed') {
      const entry = found.get(payload.params.requestId);
      if (entry) {
        entry.terminal = payload.method === 'Network.loadingFinished' ? 'finished' : 'failed';
        if (/^net::ERR_[A-Z_]+$/.test(payload.params.errorText || '')) entry.networkError = payload.params.errorText;
      }
    }
    if (payload.method === 'Page.backForwardCacheNotUsed') {
      cacheMisses.push((payload.params.notRestoredExplanations || []).map(({reason}) => reason));
    }
    if (payload.method === 'Page.frameNavigated' && !payload.params.frame.parentId) {
      const frame = payload.params.frame;
      mainFrame = frame.id;
      frameIdentity = {id:frame.id,loader:frame.loaderId,url:safeUrl(frame.url)};
      noteNavigation(payload.method, frame.id, frame.url, {loader:frame.loaderId});
    }
    if (payload.method === 'Runtime.executionContextCreated') {
      const {id, uniqueId, auxData} = payload.params.context;
      if (auxData?.isDefault) {
        const context = {id,uniqueId,frameId:auxData.frameId};
        contexts.set(id,context);
        addContextEvent({event:'created',...context});
      }
    }
    if (payload.method === 'Runtime.executionContextDestroyed') {
      const {executionContextId:id,executionContextUniqueId:uniqueId} = payload.params;
      const previous = contexts.get(id);
      if (previous && (!uniqueId || previous.uniqueId===uniqueId)) contexts.delete(id);
      addContextEvent({event:'destroyed',id,uniqueId,frameId:previous?.frameId});
    }
    if (payload.method === 'Runtime.executionContextsCleared') {
      contexts.clear();
      addContextEvent({event:'cleared'});
    }
    if (['Page.frameRequestedNavigation','Page.frameStartedNavigating','Page.navigatedWithinDocument'].includes(payload.method)) {
      const {frameId, url, reason, navigationType, loaderId} = payload.params;
      noteNavigation(payload.method, frameId, url, {reason, navigationType, loader:loaderId});
    }
    if (payload.method === 'Fetch.requestPaused') {
      const {requestId, request, networkId, responseStatusCode} = payload.params;
      paused.push({id:requestId, method:request.method, url:safeUrl(request.url), networkId, responseStatusCode,
        attempt:requestAttempt(request.headers)});
    }
    if (payload.method === 'Page.javascriptDialogOpening') dialogs.push(payload.params.type);
    if (payload.method === 'Inspector.targetCrashed') failTransport('CDP reports a crashed Edge target');
    if (payload.method === 'Runtime.bindingCalled' && payload.params.name === 'readnovelQaPointer') {
      const event = JSON.parse(payload.params.payload);
      pointers.push({...event, url:safeUrl(event.url)});
      if (pointers.length > 12) pointers.shift();
    }
    if (payload.method === 'Runtime.bindingCalled' && payload.params.name === 'readnovelQaResume') {
      resumeAttempts.push(JSON.parse(payload.params.payload));
    }
    if (payload.method === 'Runtime.exceptionThrown') {
      exceptions.push(payload.method);
      runtimeErrors.push(exceptionDetails(payload.params.exceptionDetails,safeScriptUrl,safeText));
      if (runtimeErrors.length > 8) runtimeErrors.shift();
    }
  };
  function send(method, params = {}) {
    if (transportError || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(transportError || cdpFailure('CDP target is closed'));
    }
    return new Promise((resolve, reject) => {
      const id = ++index;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(cdpFailure('CDP command timed out: ' + method));
      }, 6000);
      const fail = error => {
        pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      };
      pending.set(id, {
        fail,
        reply(reply) {
          clearTimeout(timeout);
          if (reply.error) {
            const error = cdpFailure('CDP command failed: ' + method + ' (' + reply.error.code + ')');
            error.contextChanged = method === 'Runtime.evaluate' && executionContextLost(reply.error.message)
              && ws.readyState===WebSocket.OPEN && !transportError;
            error.protocolMessage = safeText(reply.error.message);
            reject(error);
          } else resolve(reply.result);
        },
      });
      try { ws.send(JSON.stringify({id, method, params})); }
      catch { fail(cdpFailure('CDP send failed: ' + method)); }
    });
  }
  async function evaluate(expression, {pinContext = false} = {}) {
    const before = contextIdentity();
    const context = pinContext ? before.contexts.at(-1) : null;
    const contextParam = context?.uniqueId ? {uniqueContextId:context.uniqueId} :
      context ? {contextId:context.id} : {};
    try {
      const answer = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true,...contextParam});
      if (answer.exceptionDetails) {
        const error = Error('Reader evaluation threw');
        error.failureKind = 'JavaScript';
        error.exceptionDetails = exceptionDetails(answer.exceptionDetails,safeScriptUrl,safeText);
        // An exception object denotes real JavaScript and must remain a failure.
        error.contextChanged = !answer.exceptionDetails.exception && executionContextLost(answer.exceptionDetails.text)
          && ws.readyState===WebSocket.OPEN && !transportError;
        throw error;
      }
      return answer.result.value;
    } catch (error) {
      error.evaluation = {context:context ?? null,before,after:contextIdentity(),
        navigation:navigation.slice(-4),expectedUrl:expectedNavigation?.expectedUrl};
      if (pinContext && error.contextChanged) {
        lastNavigationContextLoss = {...error.evaluation,protocolMessage:error.protocolMessage,
          exceptionDetails:error.exceptionDetails};
      }
      throw error;
    }
  }
  async function hitTest(selector, {position = null, reveal = false, settle = false} = {}) {
    return evaluate(`(async () => {
      const selector = ${JSON.stringify(selector)};
      const position = ${JSON.stringify(position)};
      const element = document.querySelector(selector);
      if (${reveal} && element?.getClientRects().length) element.scrollIntoView({block:'center'});
      function sample() {
        const rect = element?.getBoundingClientRect();
        const x = position?.x ?? (rect ? Math.floor(rect.x + rect.width / 2) : -1);
        const y = position?.y ?? (rect ? Math.floor(rect.y + rect.height / 2) : -1);
        const hit = document.elementFromPoint(x, y);
        return {x, y, hit:hit?.closest('a,button,[role]')?.id || hit?.tagName || null,
          valid:!!(element?.isConnected && rect.width && rect.height && hit && element.contains(hit)),
          visible:!!(rect?.width && rect.height), disabled:element?.matches(':disabled') ?? null,
          href:element?.getAttribute('href') || null,
          documentId:performance.timeOrigin, visibility:document.visibilityState};
      }
      const first = sample();
      if (!${settle} || !first.valid || first.visibility !== 'visible') return first;
      await new Promise(requestAnimationFrame);
      const next = sample();
      if (first.x !== next.x || first.y !== next.y) next.valid = false;
      return next;
    })()`);
  }
  async function click(selector, {reveal = false, foreground = false} = {}) {
    let position;
    try {
      await until(async () => {
        const initial = await hitTest(selector,{reveal, settle:true});
        lastPointer = {selector, ...initial, href:safeUrl(initial.href)};
        if (initial.visibility !== 'visible' && foreground) await focusTab({send,evaluate});
        if (!initial.valid || initial.visibility !== 'visible') return false;
        const {x,y} = initial;
        await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
        const confirmed = await hitTest(selector,{position:{x,y}, settle:true});
        lastPointer = {selector, ...confirmed, href:safeUrl(confirmed.href)};
        if (!confirmed.valid || confirmed.visibility !== 'visible' || initial.documentId !== confirmed.documentId) return false;
        position = {x,y};
        return true;
      }, 'Control not clickable: ' + selector, 4000);
    } catch (error) {
      error.expected = {selector, visibility:'visible', hitTarget:'requested control'};
      error.actual = lastPointer;
      throw error;
    }
    // Queue the press and release on the same CDP session without a round trip in between.
    await Promise.all([
      send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...position}),
      send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...position}),
    ]);
  }
  function close() {
    closing = true;
    ws.close();
  }
  function setup(method, params) {
    checkpoint('CDP setup '+target.id+' '+method);
    return send(method, params);
  }
  try {
    for (const domain of ['Page','Runtime','Network','Inspector']) {
      await setup(domain+'.enable');
    }
    const {frameTree} = await setup('Page.getFrameTree');
    const frame = frameTree.frame;
    if (!mainFrame) {
      mainFrame = frame.id;
      frameIdentity = {id:frame.id,loader:frame.loaderId,url:safeUrl(frame.url)};
    }
    await setup('Runtime.addBinding',{name:'readnovelQaPointer'});
    await setup('Emulation.setFocusEmulationEnabled',{enabled:true});
    await setup('Page.addScriptToEvaluateOnNewDocument', {
      source:`window.resumeQaHistory={id:performance.timeOrigin,shows:0,persisted:false,
        wasHidden:document.visibilityState==='hidden'};
      document.addEventListener('visibilitychange',()=>{
        if(document.visibilityState==='hidden') window.resumeQaHistory.wasHidden=true;
      });
       for (const type of ['mousedown','mouseup','click']) {
         addEventListener(type, event => {
           if (!event.isTrusted) return;
           const control = event.target.closest('a,button,[role]');
           const action = ['data-reader-completion-action','data-reader-clear-confirm']
             .find(attribute=>control?.hasAttribute(attribute));
           readnovelQaPointer(JSON.stringify({event:type,target:control?.id || event.target.tagName,
             x:event.clientX,y:event.clientY,url:location.href,documentId:performance.timeOrigin,
             visibility:document.visibilityState,action}));
         }, true);
       }
      addEventListener('pageshow',e=>{window.resumeQaHistory.shows++;window.resumeQaHistory.persisted=e.persisted;});`,
    });
  } catch (error) {
    close();
    throw error;
  }
  checkpoint('CDP target ready '+target.id);
  function expectChapter(sequence, label, from) {
    expectRoute(pathFor(sequence),label,from,sequence);
  }
  function expectRoute(path, label, from, chapter = null) {
    expectedNavigation = {label, expectedUrl:config.origin+path, chapter, from};
  }
  return {send,evaluate,click,hitTest,expectChapter,expectRoute,requests,exceptions,cacheMisses,paused,dialogs,
    rememberDocument:state=>{ lastDocument = state; },
    diagnostics:() => ({expectedNavigation, lastPointer, pointers, navigation, identity:contextIdentity(),
      contextEvents,runtimeErrors,lastNavigationContextLoss}),
    close,resumeAttempts};
}

const link = '[data-reader-resume-link]:not([hidden])';
const action = '[data-reader-resume-activate]:not([hidden])';
const activations = tab => tab.requests.filter(r => r.path === config.progress+'/resume/activate');
const scrolls = tab => tab.requests.filter(r => r.path === config.progress+'/resume' && r.method === 'PUT');
const progressCalls = tab => tab.requests.filter(r => r.path === config.progress ||
  r.path.startsWith(config.progress+'/resume'));
const finished = (entry, status) => entry.status === status && entry.terminal === 'finished';
const pathFor = n => config.path+'/'+n;

async function readResume(account = 0) {
  // Check committed state independently of the browser document and its network trace.
  // The synthesized fixture session is in memory, never in a command line or log.
  const response = await fetch(config.origin + config.progress, {
    headers:{Cookie:config.sessionCookie + '=' + config.tokens[account]},
    signal:AbortSignal.timeout(5000),
  });
  assert.equal(response.status,200);
  const data = await response.json();
  const token = typeof data.resume_etag === 'string' ? data.resume_etag : '';
  return {chapter:data.resume?.chapter_sequence ?? null,
    revision:token ? Number(token.slice(token.lastIndexOf(':')+1,-1)) : null,
    position:data.resume?.scroll_position ?? null};
}

function safeTrace(tab) {
  return tab.requests.filter(r=>safeUrl(r.path)).slice(-24).map(
    ({path,method,status,terminal,networkError,id,loader,type,attempt}) =>
      ({url:safeUrl(path), method, status:status ?? 'pending',
        terminal:networkError || terminal || 'pending', id, loader, type, attempt}));
}

async function inspectFixture(operation) {
  checkpoint('fixture '+operation+' started');
  const output = await invoke(config.python, ['-X','utf8','-m','scripts.check_reader_resume_browser',
    '--database',config.database,'--fixture-novel',config.novel,'--fixture-operation',operation],
  {encoding:'utf8',windowsHide:true,timeout:8000});
  checkpoint('fixture '+operation+' finished');
  return ['snapshot','bookmark-snapshot'].includes(operation) ? JSON.parse(output.stdout) : null;
}

async function readerState(tab, {navigation = false} = {}) {
  try {
    const state = await tab.evaluate(`(${readerDocumentAvailable})(document) ? ({
      url:location.href, chapter:document.querySelector('.reader-page')?.dataset.chapterSequence,
      chapterId:document.querySelector('.reader-page')?.dataset.chapterId,
      ready:document.readyState, history:window.resumeQaHistory,
      visibility:document.visibilityState, scrollY, focused:document.activeElement?.id || null,
      hasFocus:document.hasFocus(),
      toc:document.querySelector('#reader-toc')?.open ?? null,
      confirming:document.querySelector('#reader-jump-confirmation')?.hidden === false,
      overflow:document.documentElement.style.overflow,
      guest:document.querySelector('[data-reader-account-guest]')?.hidden === false,
      guestClear:document.querySelector('#reader-guest-clear')?.open ?? null,
      authSubmitDisabled:document.querySelector('#auth-submit')?.disabled ?? null,
      completion:{
        shown:document.querySelector('.reader-completion')?.hidden === false,
        status:document.querySelector('[data-reader-completion-status]')?.textContent ?? null,
        disabled:document.querySelector('[data-reader-completion-action]')?.getAttribute('aria-disabled') ?? null,
        tocOpenStatusCount:document.querySelectorAll('#reader-toc[open] .reader-toc-completion').length
      },
      authHint:document.querySelector('.reader-page')?.hasAttribute('data-resume-candidate'),
      resumeReady:document.querySelector('.reader-page')?.dataset.resumeReady ?? null
    }) : null`,{pinContext:navigation});
    if (!state) return null;
    const normalized = {...state, url:safeUrl(state.url)};
    tab.rememberDocument({id:state.history?.id ?? null,url:normalized.url,ready:state.ready});
    return normalized;
  } catch (error) {
    if (navigation && error.contextChanged) return null;
    throw error;
  }
}

async function waitForChapter(tab, sequence, label, from = null) {
  tab.expectChapter(sequence,label,from);
  let state;
  try {
    await until(async () => {
      state = await readerState(tab,{navigation:true});
      return state?.url === config.origin+pathFor(sequence) && state.chapter === String(sequence) &&
        state.ready === 'complete' && state.history?.shows > 0 &&
        (!from?.history || state.history.id !== from.history.id || state.history.shows > from.history.shows);
    },label);
  } catch (error) {
    error.expected = {url:config.origin+pathFor(sequence), chapter:String(sequence), pageshow:'after navigation'};
    error.actual = state;
    throw error;
  }
}

async function clickChapter(tab, selector, sequence, label) {
  const from = await readerState(tab);
  tab.expectChapter(sequence,label,from);
  const control = await tab.hitTest(selector);
  assert.equal(safeUrl(control.href), config.origin+pathFor(sequence), label + ' href');
  await tab.click(selector,{reveal:true});
  await waitForChapter(tab,sequence,label,from);
}

async function probeReaderContexts(tab) {
  enterScenario('controlled Reader evaluation probe');
  const previous = tab.diagnostics().identity.contexts.at(-1);
  assert.ok(previous?.uniqueId,'Main default context is known');
  await tab.evaluate('document.documentElement.remove()');
  let diagnostic;
  await assert.rejects(tab.evaluate('document.documentElement.style.overflow',{pinContext:true}),error=>{
    diagnostic = error.exceptionDetails;
    return error.failureKind==='JavaScript' && !error.contextChanged &&
      diagnostic?.className==='TypeError' && diagnostic.message?.includes('style') &&
      error.evaluation.context.id===previous.id && diagnostic.stack.length>0;
  });
  assert.equal(await readerState(tab,{navigation:true}),null,'Incomplete DOM cannot satisfy a Reader assertion');
  await tab.send('Page.navigate',{url:config.origin+'/api/health'});
  await until(()=>tab.diagnostics().identity.contexts.some(context=>context.uniqueId!==previous.uniqueId),
    'New default execution context');
  await assert.rejects(tab.send('Runtime.evaluate',{expression:'true',uniqueContextId:previous.uniqueId}),
    error=>error.failureKind==='CDP' && error.contextChanged);
  console.log('PASS controlled incomplete DOM, JavaScript exception and stale context',JSON.stringify(diagnostic));
}

async function confirmClick(tab,selector) {
  const count = tab.dialogs.length;
  const click = tab.click(selector,{reveal:true});
  await until(()=>tab.dialogs.length > count,'Draft discard confirmation');
  assert.equal(tab.dialogs[count],'confirm');
  await tab.send('Page.handleJavaScriptDialog',{accept:true});
  await click;
}

async function verifyHistory(tab, second) {
  enterScenario('history return');
  const history = await tab.send('Page.getNavigationHistory');
  const priorPage = await tab.evaluate('window.resumeQaHistory');
  const beforeNext = await readResume();
  await clickChapter(tab,'#reader-next-chapter',9,'QA history navigation via Next');
  await awaitActivation(tab,3,200,'Next activation before Back');
  const beforeBack = await readResume();
  assert.equal(beforeBack.chapter,9);
  assert.equal(beforeBack.revision,beforeNext.revision+1);
  const start = progressCalls(tab).length;
  const misses = tab.cacheMisses.length;
  const forceFresh = config.history === 'fresh';
  if (forceFresh) {
    // Hold the prerequisite GET. pageshow can complete while this is paused, but the
    // fresh document cannot send its Activate. This reproduces the old counter window.
    await tab.send('Fetch.enable',{patterns:[{urlPattern:config.origin+config.progress}]});
  }
  await focusTab(tab);
  tab.expectChapter(3,'QA history return pageshow',await readerState(tab));
  await tab.send('Page.navigateToHistoryEntry',{entryId:history.entries[history.currentIndex].id});
  await tab.send('Page.bringToFront');
  await until(() => tab.evaluate(`location.pathname===${JSON.stringify(pathFor(3))} &&
    window.resumeQaHistory?.shows > (window.resumeQaHistory?.id===${priorPage.id} ? ${priorPage.shows} : 0)`),
    'QA history return pageshow');
  const page = await tab.evaluate('window.resumeQaHistory');
  const {frameTree:{frame:{loaderId}}} = await tab.send('Page.getFrameTree');
  const returnedCalls = () => progressCalls(tab).slice(start);
  if (page.persisted) {
    assert.equal(forceFresh,false);
    assert.equal(page.id,priorPage.id);
    await until(() => tab.evaluate(`Boolean(document.querySelector('${action}'))`),'BFCache reconcile UI');
    await tab.evaluate(fractionScript('window.scrollTo(0,start+span*.4);'));
    await until(async () => Math.abs(await tab.evaluate(fractionScript())-.4)<.025,
      'BFCache scroll reached the test position');
    // The interaction helper emulates focus for pointer/keyboard inputs. Drop that
    // override on both targets so this check exercises real hidden/visible events.
    await tab.send('Emulation.setFocusEmulationEnabled',{enabled:false});
    await second.send('Emulation.setFocusEmulationEnabled',{enabled:false});
    await focusTab(second);
    await until(() => tab.evaluate("document.visibilityState==='hidden'"), 'BFCache tab did not become hidden');
    await focusTab(tab);
    await tab.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    await second.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    assert.deepEqual(returnedCalls().map(r=>[r.method,r.status]),[['GET',200]]);
    assert.deepEqual(await readResume(),beforeBack);
    console.log('PASS native BFCache: same document, pageshow.persisted=true, GET only, revision',
      beforeBack.revision,'unchanged.');
    return beforeBack;
  }
  assert.notEqual(page.id,priorPage.id);
  const reasons = tab.cacheMisses.slice(misses).flat();
  console.log('NOT TESTED native BFCache in this run: new document, pageshow.persisted=false; CDP reasons:',
    reasons.length ? [...new Set(reasons)].join(', ') : 'none reported');
  if (forceFresh) {
    const selectedGet = () => tab.paused.find(r=>r.method==='GET' &&
      r.url===config.origin+config.progress &&
      returnedCalls().some(call=>call.id===r.networkId && call.loader===loaderId));
    await until(selectedGet, 'Fresh document GET interception');
    const oldCount = activations(tab).length;
    assert.equal(oldCount,4);
    await tab.send('Fetch.continueRequest',{requestId:selectedGet().id});
    await tab.send('Fetch.disable');
    console.log('Reproduced old counter snapshot: pageshow complete and GET paused, expected count would be',oldCount);
  }
  // Auto mode may load a new document while the window is hidden. Confirm the
  // controller waited for intent instead of treating that as a foreground write.
  if (!forceFresh) {
    await focusTab(tab);
    await until(async () => returnedCalls().some(r=>r.method==='POST') ||
      await tab.evaluate(`Boolean(document.querySelector('${action}'))`),'Fresh Back startup decision');
    if (!returnedCalls().some(r=>r.method==='POST')) {
      assert.equal(await tab.evaluate('window.resumeQaHistory.wasHidden'),true);
      assert.deepEqual(returnedCalls().map(r=>[r.method,r.status]),[['GET',200]]);
      assert.equal(activations(tab).length,4);
      assert.deepEqual(await readResume(),beforeBack);
      console.log('PASS fresh Back with hidden lifecycle: GET only, waiting for explicit intent.');
      return beforeBack;
    }
  }
  await until(() => returnedCalls().some(r=>r.method==='POST' && finished(r,200)),
    'Fresh foreground Back activation must finish before switching accounts');
  assert.deepEqual(returnedCalls().map(r=>[r.method,r.status]),[['GET',200],['POST',200]]);
  assert.ok(returnedCalls().every(r=>r.loader===loaderId),'Back requests must come from the new document');
  assert.equal(activations(tab).length,5);
  const afterBack = await readResume();
  assert.equal(afterBack.chapter,3);
  assert.equal(afterBack.revision,beforeBack.revision+1);
  console.log('PASS fresh foreground Back: one GET + one POST, activation count 5, revision',
    beforeBack.revision,'->',afterBack.revision,'before account switch.');
  return afterBack;
}

function fractionScript(command = '') {
  return `(() => {
     const box=document.querySelector('.reader-content').getBoundingClientRect();
     const offset=document.querySelector('#reader-toolbar').offsetHeight;
     const top=box.top+window.scrollY;
     const start=Math.max(0,top-offset);
     const span=Math.max(0,top+box.height-innerHeight-start);
     ${command}
     return span ? Math.min(1,Math.max(0,(scrollY-start)/span)) : 0;
  })()`;
}

async function settleReaderLayout(tab) {
  await tab.evaluate('document.fonts.ready.then(()=>true)');
  await until(()=>tab.evaluate(`(async () => {
    function geometry() {
      const rect=document.querySelector('.reader-content').getBoundingClientRect();
      return JSON.stringify([innerWidth,innerHeight,rect.top+scrollY,rect.width,rect.height,
        document.querySelector('#reader-toolbar').offsetHeight,document.fonts.status]);
    }
    await new Promise(requestAnimationFrame);
    const before=geometry();
    await new Promise(requestAnimationFrame);
    return before===geometry() && document.fonts.status==='loaded' &&
      document.visibilityState==='visible';
  })()`),'Reader fonts and viewport geometry settled');
}

async function cookie(tab, index) {
  for (const [name,value,httpOnly] of [
    [config.sessionCookie,config.tokens[index],true],[config.csrfCookie,config.csrf[index],false],
  ]) {
    const answer = await tab.send('Network.setCookie',{name,value,httpOnly,url:config.origin,
      sameSite:'Lax',path:'/'});
    assert.ok(answer.success);
  }
}

async function navigate(tab, sequence) {
  const from = await readerState(tab);
  tab.expectChapter(sequence,'Reader did not finish loading',from);
  const result = await tab.send('Page.navigate',{url:config.origin+pathFor(sequence)});
  assert.equal(result.errorText,undefined,'Reader navigation CDP error');
  await waitForChapter(tab,sequence,'Reader did not finish loading',from);
}

async function navigateBlank(tab) {
  const result = await tab.send('Page.navigate',{url:'about:blank'});
  assert.equal(result.errorText,undefined,'Navigation to about:blank CDP error');
  await until(() => tab.evaluate("location.href === 'about:blank'"),'Blank document committed');
}

async function focusTab(tab) {
  await tab.send('Page.bringToFront');
  await until(() => tab.evaluate("document.visibilityState==='visible'"), 'Reader tab did not become visible');
}

async function openToolbarMenu(tab, name) {
  const id = name === 'account' ? 'reader-account-menu' : 'reader-theme-selector';
  const trigger = name === 'account' ? '#reader-account-trigger' : '#reader-theme-trigger';
  await focusTab(tab);
  if (!await tab.evaluate(`document.getElementById('${id}').open`)) {
    await tab.evaluate(`document.querySelector('${trigger}').focus({preventScroll:true})`);
    await tab.click(trigger,{foreground:true});
  }
  await until(()=>tab.evaluate(`document.getElementById('${id}').open`),name+' disclosure open');
}

async function pressHome(tab) {
  for (const type of ['keyDown','keyUp']) {
    await tab.send('Input.dispatchKeyEvent',{type,key:'Home',code:'Home',windowsVirtualKeyCode:36});
  }
}

async function awaitActivation(tab, count, status, label) {
  // A newly added Edge tab can begin loading before it is visible. In that case
  // the controller waits for a deliberate action after its foreground read.
  await focusTab(tab);
  await until(async () => activations(tab).length > count ||
    await tab.evaluate(`Boolean(document.querySelector('${action}'))`), label + ' intent');
  if (activations(tab).length === count) {
    await tab.evaluate('window.scrollTo(0,0)');
    await tab.click(action);
  }
  await until(() => activations(tab).length === count+1 && finished(activations(tab)[count],status),
    label + ' response');
}

async function viewport(tab,width,height) {
  await tab.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await until(() => tab.evaluate('innerWidth=== '+width), 'Viewport did not update');
  assert.ok(await tab.evaluate('document.documentElement.scrollWidth <= innerWidth'));
}

async function verifyCompletion(tab) {
  enterScenario('completion guest and initial read');
  const status = '[data-reader-completion-status]';
  const completionAction = '[data-reader-completion-action]';
  const part = config.progress + '/completions';
  const reads = () => tab.requests.filter(r => r.path === part && r.method === 'GET');
  const writes = () => tab.requests.filter(r => r.path.startsWith(part + '/') && r.method === 'PUT');
  const label = expected => until(() => tab.evaluate(
    `document.querySelector('${status}')?.textContent===${JSON.stringify('Trạng thái: '+expected)}`),expected);
  const badge = (sequence, expected) => until(() => tab.evaluate(
    `document.querySelector('#reader-toc-list li[data-sequence="${sequence}"] .reader-toc-completion')?.textContent.trim()===${JSON.stringify('· '+expected)}`),
    'TOC '+sequence+' '+expected);
  const reveal = selector => tab.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
  async function reload(expected) {
    const previous = await tab.evaluate('performance.timeOrigin');
    await tab.send('Page.reload');
    await until(() => tab.evaluate(`performance.timeOrigin!==${previous}`),'Reloaded document');
    await label(expected);
  }
  async function closeToc() {
    await tab.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await tab.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await until(() => tab.evaluate("!document.querySelector('#reader-toc').open"),'TOC closed');
  }

  await viewport(tab,1366,768);
  await navigate(tab,1);
  await label('Chưa đọc');
  await tab.evaluate('window.scrollTo(0,document.documentElement.scrollHeight)');
  assert.ok(await tab.evaluate(`document.querySelector('${completionAction}')?.getAttribute('aria-disabled')==='false'`));
  assert.equal(reads().length+writes().length,0);
  await navigateBlank(tab);
  await cookie(tab,0);
  await navigate(tab,1);
  await awaitActivation(tab,0,200,'Authenticated chapter 1');
  await label('Chưa đọc');
  assert.deepEqual(reads().map(r=>r.chapterCount),[1]);
  assert.equal(writes().length,0);
  assert.deepEqual((await inspectFixture('snapshot')).evidence,[]);
  console.log('PASS guest, authenticated initial status and zero automatic completion.');

  enterScenario('explicit completion and TOC batch');
  const scrollCount = scrolls(tab).length;
  await reveal(completionAction);
  // Settle the independent Resume scroll before comparing the whole Resume row.
  await until(() => scrolls(tab).slice(scrollCount).some(r=>finished(r,200)),
    'Footer scroll Resume settled before completion');
  const before = await inspectFixture('snapshot');
  await tab.send('Fetch.enable',{patterns:[{urlPattern:config.origin+part+'/*'}]});
  await tab.click(completionAction,{reveal:true});
  await until(() => tab.paused.length === 1, 'Held explicit completion');
  assert.equal(tab.paused[0].method,'PUT');
  assert.ok(await tab.evaluate(`document.querySelector('${completionAction}').getAttribute('aria-disabled')==='true'`));
  await tab.click(completionAction,{reveal:true});
  assert.deepEqual(await inspectFixture('snapshot'),before);
  await tab.evaluate("document.querySelector('#reader-toc-open').focus({preventScroll:true})");
  await tab.click('#reader-toc-open');
  await badge(1,'Chưa đọc');
  assert.deepEqual(reads().map(r=>r.chapterCount),[1,50]);
  await tab.send('Fetch.continueRequest',{requestId:tab.paused[0].id});
  await tab.send('Fetch.disable');
  await label('Đã đọc');
  await badge(1,'Đã đọc');
  assert.equal(writes().length,1);
  const after = await inspectFixture('snapshot');
  assert.deepEqual(after.evidence,[[1,true]]);
  assert.ok(after.resume === before.resume,'Completion changed the Resume row');
  await viewport(tab,320,800);
  assert.ok(await tab.evaluate("document.querySelector('#reader-toc').scrollWidth <= innerWidth"));
  await tab.click('[data-toc-page="next"]');
  await badge(57,'Chưa đọc');
  assert.deepEqual(reads().map(r=>r.chapterCount),[1,50,3]);
  assert.ok(await tab.evaluate(`!document.querySelector('#reader-toc-list li[data-sequence="1"]')`));
  await closeToc();
  console.log('PASS explicit PUT, rapid second click guarded, live TOC update, two batches 50/3, 320px and Resume unchanged.');

  enterScenario('completion history and edited content');
  await reload('Đã đọc');
  const history = await tab.send('Page.getNavigationHistory');
  const historyPage = await tab.evaluate('window.resumeQaHistory');
  await clickChapter(tab,'#reader-next-chapter',3,'Native Next before Completion Back');
  await label('Chưa đọc');
  assert.equal(writes().length,1);
  tab.expectChapter(1,'Completion history return',await readerState(tab));
  await tab.send('Page.navigateToHistoryEntry',{entryId:history.entries[history.currentIndex].id});
  await focusTab(tab);
  await until(() => tab.evaluate(`location.pathname===${JSON.stringify(pathFor(1))} &&
    window.resumeQaHistory?.shows > (window.resumeQaHistory?.id===${historyPage.id} ? ${historyPage.shows} : 0)`),
    'Completion history return');
  const persisted=await tab.evaluate('window.resumeQaHistory.persisted');
  await label('Đã đọc');
  assert.equal(writes().length,1);
  console.log(persisted ? 'PASS native BFCache refresh without completion PUT.' :
    'PASS fresh Back without completion PUT; native BFCache NOT TESTED in this run.');

  await inspectFixture('edit-1');
  assert.deepEqual((await inspectFixture('snapshot')).evidence,[[1,false]]);
  await reload('Đã đọc (bản cũ)');
  await reveal(completionAction);
  await tab.click(completionAction);
  await label('Đã đọc');
  assert.equal(writes().length,2);
  assert.deepEqual((await inspectFixture('snapshot')).evidence,[[1,true]]);
  await clickChapter(tab,'#reader-next-chapter',3,'Native Next before stale Completion');
  await label('Chưa đọc');
  await inspectFixture('edit-3');
  await reveal(completionAction);
  await tab.click(completionAction);
  await label('Nội dung chương đã thay đổi. Hãy tải lại trang để xác nhận. · ' +
    'Xác nhận đang chờ thuộc bản cũ. Hãy xác nhận lại bản hiện tại.');
  assert.ok(await tab.evaluate("!document.querySelector('[data-reader-completion-discard]').hidden"));
  assert.deepEqual(writes().map(r=>r.status),[200,200,409]);
  assert.deepEqual((await inspectFixture('snapshot')).evidence,[[1,true]]);
  console.log('PASS content edit retains old evidence; explicit B reconfirm, stale A receives 409.');

  enterScenario('completion account isolation');
  const beforePrevious = activations(tab).length;
  await clickChapter(tab,'#reader-previous-chapter',1,'Native Previous before account switch');
  await awaitActivation(tab,beforePrevious,200,'Account A entered chapter 1');
  await label('Đã đọc');
  const beforeSwitch = activations(tab).length;
  const originalA = await readResume();
  await cookie(tab,1);
  await label('Chưa đọc'); // The open document revalidates and now displays B's status.
  await reload('Chưa đọc');
  await until(()=>tab.evaluate(`Boolean(document.querySelector('${action}'))`),'Account B Resume is ready');
  assert.equal(activations(tab).length,beforeSwitch);
  assert.equal((await readResume(1)).chapter,null);
  assert.deepEqual(await readResume(),originalA);
  await tab.click(action,{foreground:true});
  await until(() => activations(tab).length===beforeSwitch+1 && finished(activations(tab).at(-1),201),
    'Account B explicitly creates only its own Resume');
  assert.equal((await readResume(1)).chapter,1);
  assert.deepEqual(await readResume(),originalA);
  assert.equal(writes().length,3);
  assert.equal(tab.exceptions.length,0);
  console.log('PASS native Previous and cross-account completion isolation.');
}

async function verifyGuest(tab, second) {
  const key = 'readnovel.progress.guest.v1.' + config.novel;
  const completion = '[data-reader-completion-action]';
  const waitForUi = (browser, expression, message) => until(async () => {
    // Edge can commit a navigation in a background tab after a foreground click.
    const ready = await browser.evaluate(`document.visibilityState==='visible' ? (${expression}) : null`);
    if (ready === null) await focusTab(browser);
    return ready === true;
  }, message);
  const label = (browser, value) => waitForUi(browser,
    `document.querySelector('[data-reader-completion-status]')?.textContent===${JSON.stringify('Trạng thái: ' + value)}`,
    'Completion label ' + value);
  const snapshot = browser => browser.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`);
  const bookmarkToggle = '#reader-bookmark-toggle';
  const bookmarkState = expected => waitForUi(tab,
    `document.querySelector('${bookmarkToggle}').getAttribute('aria-pressed')==='${expected}'`,
    'Bookmark pressed equals '+expected);
  const localBookmarks = ()=>tab.evaluate(`Object.keys(localStorage)
    .filter(key=>key.startsWith(${JSON.stringify('readnovel.bookmarks.guest.v1.'+config.novel+'.')}))
    .sort().map(key=>[key,localStorage.getItem(key)])`);
  async function authReady(browser) {
    await waitForUi(browser,
      "!document.querySelector('[data-reader-account]').hidden && !document.querySelector('[data-reader-resume-activate]').hidden",
      'Verified Auth scope can explicitly save the current chapter');
    assert.equal(await browser.evaluate(
      "!!document.querySelector('#reader-guest-merge,#reader-bookmark-import,[data-bookmark-import-offer],[data-bookmark-import-manual]')"
    ),false,'Reader contains no Guest import controls');
  }
  const writes = ()=>[...tab.requests,...second.requests].filter(r=>r.method!=='GET' &&
    (r.path.startsWith(config.progress) || r.path.startsWith('/api/bookmarks/')));
  let realVisibility = false;
  async function withGuestForeground(browser, action) {
    await focusTab(browser);
    await browser.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    try {
      return await action();
    } finally {
      await browser.send('Emulation.setFocusEmulationEnabled',{enabled:false});
    }
  }
  async function click(browser, selector) {
    const stableGesture = realVisibility && [completion,'[data-reader-clear-confirm]'].includes(selector);
    if (!stableGesture) return browser.click(selector,{reveal:true,foreground:true});
    const pointerEvents = browser.diagnostics().pointers;
    const previousClick = pointerEvents.at(-1);
    const action = selector.slice(1,-1);
    // Keep the physically dispatched gesture in the just-activated target.
    // Visibility assertions between gestures still use the browser's real state.
    await withGuestForeground(browser,async () => {
      await browser.click(selector,{reveal:true});
      await until(()=>pointerEvents.slice(pointerEvents.indexOf(previousClick)+1).some(event=>
        event.event==='click' && event.action===action && event.visibility==='visible'),
        'Trusted foreground click on '+selector);
    });
  }
  const show = (browser, selector) => waitForUi(browser,
    `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`,
    'Visible control: ' + selector);
  const section = (browser, sequence, from) => waitForChapter(browser,sequence,'Reader chapter '+sequence,from);
  const measure = browser => browser.evaluate(fractionScript());
  const scrollTo = (browser, fraction) => browser.evaluate(
    fractionScript(`window.scrollTo(0,start+span*${fraction});`));
  const waitFraction = (browser, expected) => until(async () =>
    Math.abs(await measure(browser)-expected)<.025,'Restore fraction '+expected);
  async function reload(browser) {
    const before = await browser.evaluate('performance.timeOrigin');
    await browser.send('Page.reload');
    await until(() => browser.evaluate(`performance.timeOrigin!==${before} && document.readyState==='complete'`),
      'Reader reload completed');
  }
  async function auth(mode, {checkBackground = false} = {}) {
    const signup = mode === 'register';
    await focusTab(tab);
    const from = await readerState(tab);
    tab.expectRoute('/'+mode,'Ready '+mode+' form',from);
    await openToolbarMenu(tab,'account');
    await click(tab,`[data-reader-account-guest] a[href^="/${mode}?"]`);
    await until(() => tab.evaluate(`location.pathname==='/${mode}' && document.readyState==='complete' &&
      performance.timeOrigin!==${from.history.id} && window.resumeQaHistory?.shows > 0 &&
      document.querySelector('#auth-submit')?.disabled===false`),
      'Ready ' + mode + ' form');
    await tab.evaluate(`(() => {
      const fields = ${JSON.stringify(signup ?
        {'#username':config.signupName,'#identifier':config.signupEmail,
          '#password':config.password,'#confirm-password':config.password} :
        {'#identifier':config.login,'#password':config.password})};
      for (const [selector,value] of Object.entries(fields)) document.querySelector(selector).value=value;
    })()`);
    if (checkBackground) {
      // Use real visibility to reproduce a ready form in A while B owns the foreground.
      await focusTab(second);
      await until(()=>tab.evaluate("document.visibilityState==='hidden'"),'Auth tab is in the background');
      const hidden = await tab.hitTest('#auth-submit',{reveal:true});
      assert.equal(hidden.disabled,false);
      assert.equal(hidden.valid,true,'The hidden tab still has a valid submit hit target');
    }
    await focusTab(tab);
    await click(tab, '#auth-submit');
    if (checkBackground) console.log('PASS activated the backgrounded auth target before native submit.');
    await section(tab,100);
    await authReady(tab);
    assert.equal(await tab.evaluate("new URLSearchParams(location.search).get('reader_entry')"),'auth');
  }
  async function logout() {
    await openToolbarMenu(tab,'account');
    const start = tab.requests.length;
    await click(tab,'#reader-logout');
    await until(()=>tab.requests.slice(start).some(r=>r.path==='/api/auth/logout' && finished(r,200)),
      'Logout returns HTTP 200');
    await show(tab,'[data-reader-account-guest]:not([hidden])');
    if (await tab.evaluate("document.querySelector('#reader-account-menu').open")) {
      await click(tab,'#reader-account-trigger');
    }
  }

  enterScenario('Guest storage, completion, TOC and offline');
  await focusTab(tab);
  await viewport(tab,1920,1080);
  await tab.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.guestQaWrites=0;
    const guestOriginalSet=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){
      if(key===${JSON.stringify(key)}) guestQaWrites++;
      return guestOriginalSet.call(this,key,value);
    };
  `});
  await navigate(tab,100);
  await label(tab,'Chưa đọc');
  assert.equal(tab.requests.filter(r=>r.path==='/api/auth/me').length,1);
  assert.equal(await tab.evaluate('window.guestQaWrites'),1);
  await click(tab,completion);
  await label(tab,'Đã đọc — lưu trên thiết bị');
  const first = await snapshot(tab);
  assert.equal(Object.keys(first.completions).length,1);
  assert.equal(first.completions[first.resume.chapter_id].content_revision.hash,
    await tab.evaluate("document.querySelector('.reader-page').dataset.contentHash"));
  await tab.evaluate('window.scrollTo(0,0)');
  await click(tab,'#reader-toc-open');
  await until(() => tab.evaluate("document.querySelector('.reader-toc-completion')?.textContent.includes('Đã đọc trên thiết bị')"),
    'Guest TOC claim');
  await tab.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await tab.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(() => tab.evaluate("!document.querySelector('#reader-toc').open"),'Guest TOC closed');
  await tab.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await scrollTo(tab,.42);
  await until(async () => Math.abs((await snapshot(tab)).resume.scroll_position-.42)<.025,'Offline Guest save',8000);
  const saved = await snapshot(tab);
  assert.equal(await tab.evaluate('window.guestQaWrites'),3);
  await viewport(tab,1366,768);
  await waitFraction(tab,.42);
  assert.deepEqual(await snapshot(tab),saved);
  await tab.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await reload(tab);
  await label(tab,'Đã đọc — lưu trên thiết bị');
  assert.deepEqual(await snapshot(tab),saved);
  await click(tab,link);
  await waitFraction(tab,.42);
  assert.ok(!tab.requests.some(r=>r.path.startsWith(config.progress)));
  assert.equal(tab.requests.filter(r=>r.path.includes('/chapters/')).length,0);
  console.log('PASS Guest: 1 initial auth probe, 0 Progress calls, 3 record writes (open, click, coalesced offline scroll), TOC one list with 0 chapter reads.');

  enterScenario('Guest history and cross-chapter resume');
  await tab.evaluate("document.querySelector('#reader-previous-chapter').scrollIntoView({block:'center'})");
  await until(async () => (await snapshot(tab)).resume.scroll_position===1,'Departure position saved',8000);
  await clickChapter(tab,'#reader-previous-chapter',50,'Guest native Previous before handoff');
  await label(tab,'Chưa đọc');
  await until(() => tab.evaluate(`document.querySelector('${link}')?.pathname===${JSON.stringify(pathFor(100))}`),
    'Published Guest chapter lookup');
  const priorPage = await tab.evaluate('window.resumeQaHistory');
  const priorHistory = await tab.send('Page.getNavigationHistory');
  const misses = tab.cacheMisses.length;
  await clickChapter(tab,link,100,'Guest cross-chapter Resume link');
  await waitFraction(tab,1);
  await until(()=>tab.evaluate(`document.querySelector('${link}')?.pathname===${JSON.stringify(pathFor(100))}`),
    'Guest handoff points to its destination without a reverse link');
  const destination = await readerState(tab);
  await click(tab,link);
  await waitFraction(tab,1);
  assert.equal((await readerState(tab)).history.id,destination.history.id);
  await focusTab(tab);
  await tab.send('Page.navigateToHistoryEntry',{entryId:priorHistory.entries[priorHistory.currentIndex].id});
  await section(tab,50);
  await until(() => tab.evaluate(`window.resumeQaHistory?.shows >
    (window.resumeQaHistory?.id===${priorPage.id} ? ${priorPage.shows} : 0)`),'Guest Back pageshow');
  const history = await tab.evaluate('window.resumeQaHistory');
  assert.equal(history.persisted,history.id===priorPage.id);
  if (config.history==='fresh') assert.equal(history.persisted,false);
  await label(tab,'Chưa đọc');
  await clickChapter(tab,'#reader-next-chapter',100,'Guest native Next after Back');
  await label(tab,'Đã đọc — lưu trên thiết bị');
  assert.ok(!tab.requests.some(r=>r.path.startsWith(config.progress)));
  console.log('PASS Guest Previous, chapter-to-chapter handoff and Back:',history.persisted?'native BFCache':
    'fresh document (' + [...new Set(tab.cacheMisses.slice(misses).flat())].join(', ') + ')');

  enterScenario('Guest concurrent tabs, per-novel clear and blocked localStorage');
  await tab.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  await second.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  realVisibility = true;
  await focusTab(second);
  await until(() => tab.evaluate("document.visibilityState==='hidden'"),'First Guest tab hidden');
  await viewport(second,390,844);
  const blocked = await second.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError');}});
  `});
  await navigate(second,50);
  await label(second,'Chưa xác định');
  assert.ok(await second.evaluate("document.querySelector('[data-reader-resume-status]').textContent.includes('Chưa lưu')"));
  await second.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:blocked.identifier});
  await reload(second);
  await label(second,'Chưa đọc');
  enterScenario('Second Guest tab confirms a different chapter');
  await click(second,completion);
  await label(second,'Đã đọc — lưu trên thiết bị');
  assert.equal(Object.keys((await snapshot(second)).completions).length,2);
  enterScenario('Guest per-novel clear and reinitialization');
  const beforeClear = await snapshot(second);
  await openToolbarMenu(second,'settings');
  assert.deepEqual(await snapshot(second),beforeClear,'Opening settings does not clear progress');
  await click(second,'[data-reader-guest-clear]');
  await show(second,'#reader-guest-clear[open] [data-reader-clear-cancel]');
  await click(second,'[data-reader-clear-cancel]');
  await waitForUi(second,"!document.querySelector('#reader-guest-clear').open && document.activeElement.id==='reader-theme-trigger'",
    'Cancel preserves progress and restores Settings focus');
  assert.deepEqual(await snapshot(second),beforeClear);
  await openToolbarMenu(second,'settings');
  await click(second,'[data-reader-guest-clear]');
  const confirm = '[data-reader-clear-confirm]';
  const dialogReady = "document.querySelector('#reader-guest-clear').open && "+
    "document.querySelector('[data-reader-clear-confirm]')?.disabled===false";
  await waitForUi(second,dialogReady,'Guest clear dialog opened');
  await focusTab(tab);
  await until(()=>second.evaluate("document.visibilityState==='hidden'"),'Guest clear target is in the background');
  const hidden = await second.hitTest(confirm);
  assert.equal(hidden.valid,true,'Open dialog retains the confirm hit target in the background');
  assert.equal(hidden.disabled,false);
  await waitForUi(second,dialogReady,'Guest clear dialog is open in the foreground');
  await click(second,confirm);
  await until(()=>second.evaluate("!document.querySelector('#reader-guest-clear').open"),'Guest clear dialog closed');
  await label(second,'Chưa đọc');
  assert.equal(await snapshot(second),null);
  await focusTab(tab);
  await label(tab,'Chưa đọc');
  assert.equal(await snapshot(tab),null);
  // A background reload cannot auto-create a fresh Guest Resume.
  await focusTab(second);
  await until(()=>tab.evaluate("document.visibilityState==='hidden'"),'Cleared Guest tab is in the background');
  await reload(tab);
  assert.equal(await snapshot(tab),null);
  await label(tab,'Chưa đọc');
  enterScenario('First Guest tab explicitly confirms after clear');
  await click(tab,completion);
  await label(tab,'Đã đọc — lưu trên thiết bị');
  const completionOnly = await snapshot(tab);
  assert.equal(completionOnly.resume,null);
  assert.ok(completionOnly.completions[(await readerState(tab)).chapterId]);
  await withGuestForeground(tab,async () => {
    await settleReaderLayout(tab);
    await scrollTo(tab,.42);
    await until(async () => {
      const resume=(await snapshot(tab))?.resume;
      return Boolean(resume && Math.abs(resume.scroll_position-.42)<.025);
    },'New Guest position after clear',8000);
  });
  const local = await snapshot(tab);
  console.log('PASS two Guest tabs, blocked localStorage and explicit clear without stale resurrection.');

  enterScenario('Existing Auth owner reads only account state after login, Back and reload');
  await bookmarkState(false);
  await click(tab,bookmarkToggle);
  await bookmarkState(true);
  const deviceBookmarks = await localBookmarks();
  assert.equal(deviceBookmarks.length,1);
  assert.deepEqual(await snapshot(tab),local);
  const beforeLogin = await inspectFixture('bookmark-snapshot');
  const accountResume = await readResume();
  assert.equal(accountResume.chapter,50);
  assert.equal(accountResume.position,.55);
  const guestEntry = await second.send('Page.getNavigationHistory');
  const guestPage = await second.evaluate('window.resumeQaHistory');
  await second.send('Page.navigate',{url:config.origin+'/api/health'});
  await until(() => second.evaluate("location.pathname==='/api/health'"),'Park the second Guest document');
  await viewport(tab,320,800);
  await auth('login',{checkBackground:true});
  await label(tab,'Chưa đọc');
  await bookmarkState(false);
  assert.equal(await tab.evaluate(`document.querySelector('${link}').pathname`),pathFor(50));
  assert.equal(writes().length,0);
  assert.deepEqual(await inspectFixture('bookmark-snapshot'),beforeLogin);
  assert.equal(progressCalls(tab).filter(r=>r.path===config.progress && r.method==='GET').length,1);
  await focusTab(second);
  await second.send('Page.navigateToHistoryEntry',{entryId:guestEntry.entries[guestEntry.currentIndex].id});
  await section(second,50);
  await until(() => second.evaluate(`window.resumeQaHistory?.shows >
    (window.resumeQaHistory?.id===${guestPage.id} ? ${guestPage.shows} : 0)`),'Previous Guest entry restored');
  await authReady(second);
  assert.equal(await second.evaluate(`document.querySelector('${link}').pathname`),pathFor(50));
  assert.equal(writes().length,0);
  const cachedGuestEntry = await second.evaluate('window.resumeQaHistory.persisted');
  if (config.history==='fresh') assert.equal(cachedGuestEntry,false);
  console.log('PASS Guest entry after login in another tab:',cachedGuestEntry?'native BFCache':'fresh document',
    'with verified Auth data and no mutation.');
  await focusTab(tab);
  assert.deepEqual(await snapshot(tab),local);
  assert.deepEqual(await localBookmarks(),deviceBookmarks);
  await reload(tab);
  await authReady(tab);
  await label(tab,'Chưa đọc');
  assert.equal(writes().length,0);
  assert.deepEqual(await inspectFixture('bookmark-snapshot'),beforeLogin);
  await logout();
  await label(tab,'Đã đọc — lưu trên thiết bị');
  await bookmarkState(true);
  assert.equal(await tab.evaluate(`document.querySelector('${link}').pathname`),pathFor(100));
  assert.deepEqual(await snapshot(tab),local);
  assert.deepEqual(await localBookmarks(),deviceBookmarks);
  assert.deepEqual(await inspectFixture('bookmark-snapshot'),beforeLogin);
  console.log('PASS Login A keeps server Resume, Completion and Bookmarks. Logout restores all three Guest states.');

  enterScenario('New Auth account stays empty until an explicit save in the open chapter');
  await auth('register');
  await label(tab,'Chưa đọc');
  await bookmarkState(false);
  assert.deepEqual(await tab.evaluate(`(() => {
    const resumeLink=document.querySelector('[data-reader-resume-link]');
    return [resumeLink.hidden,resumeLink.hasAttribute('href')];
  })()`),[true,false]);
  assert.equal(writes().length,0);
  assert.deepEqual(await inspectFixture('bookmark-snapshot'),beforeLogin);
  await tab.evaluate('window.scrollTo(0,0)');
  await click(tab,'[data-reader-resume-activate]');
  await until(() => activations(tab).length===1 && finished(activations(tab)[0],201),'One deliberate Resume creation');
  assert.equal(writes().length,1);
  const explicit = await inspectFixture('bookmark-snapshot');
  assert.deepEqual(explicit.progress,[[50,0,.55,777],[100,1,0,0]]);
  assert.deepEqual(explicit.evidence,beforeLogin.evidence);
  assert.deepEqual(explicit.bookmarks,beforeLogin.bookmarks);
  assert.deepEqual(await snapshot(tab),local);
  assert.deepEqual(await localBookmarks(),deviceBookmarks);
  await focusTab(second);
  await label(second,'Chưa đọc');
  assert.equal(activations(second).length,0);
  assert.equal(tab.exceptions.length+second.exceptions.length,0);
  assert.deepEqual(await readResume(),accountResume);
  console.log('PASS new account stays empty until explicit Resume save at fraction 0. Guest fraction and claims stay on-device.');
}

async function verifyBookmarks(tab, second) {
  const toggle = '#reader-bookmark-toggle', opener = '#reader-bookmarks-open';
  const panel = '#reader-bookmarks', items = panel+' [data-bookmarks-items]';
  const account = '#reader-account-trigger', logoutButton = '#reader-logout';
  const prefix = '/api/bookmarks/novels/' + config.novel;
  const calls = () => tab.requests.filter(r=>r.path.startsWith(prefix));
  const writes = () => calls().filter(r=>r.method!=='GET');
  const pressed = expected => until(()=>tab.evaluate(
    `document.querySelector('${toggle}')?.getAttribute('aria-pressed')==='${expected}'`),
    'Bookmark pressed = '+expected);
  async function ready(message, expression) {
    await until(()=>tab.evaluate(expression),message);
  }
  async function openList() {
    await tab.click(opener,{foreground:true});
    await ready('Bookmark list needs a rendered page',
      `document.querySelector('${panel}').open && document.querySelector('${panel}').getAttribute('aria-busy')==='false'`);
  }
  async function closeList() {
    await tab.click('[data-bookmarks-close]');
    await restoredListFocus('X closes Bookmark list and restores focus');
  }
  async function restoredListFocus(message) {
    await ready(message,`!document.querySelector('${panel}').open &&
      document.activeElement.id==='reader-bookmarks-open'`);
  }
  async function destinations() {
    const rows = await tab.evaluate(`[...document.querySelectorAll('${items} a')].map(a=>[a.pathname,a.textContent,
      a.nextElementSibling.getAttribute('aria-label')])`);
    for (const [href, title, remove] of rows) {
      assert.equal(title,'Chương '+href.split('/').at(-1),'Published row retains chapter name');
      assert.equal(remove,'Bỏ dấu: '+title,'Remove names the same chapter');
    }
    return rows.map(([href])=>href);
  }
  const progressStore = () => tab.evaluate(
    `localStorage.getItem('readnovel.progress.guest.v1.'+${JSON.stringify(config.novel)})`);
  const bookmarksStore = () => tab.evaluate(`Object.keys(localStorage).filter(key=>
    key.startsWith(${JSON.stringify('readnovel.bookmarks.guest.v1.'+config.novel+'.')}))
    .map(key=>localStorage.getItem(key))`);
  const accountBookmarkProgress = ({resume,evidence,progress})=>({resume,evidence,progress});
  const readProgress = async ()=>accountBookmarkProgress(await inspectFixture('bookmark-snapshot'));
  const enableNetwork = offline => tab.send('Network.emulateNetworkConditions',{
    offline,latency:0,downloadThroughput:offline?0:-1,uploadThroughput:offline?0:-1,
  });
  async function screenshot(name) {
    const directory = process.env.READNOVEL_QA_BOOKMARK_SCREENSHOT_DIR;
    if (!directory) return;
    const image = await tab.send('Page.captureScreenshot',{format:'png'});
    writeFileSync(join(directory,config.history+'-'+name+'.png'),Buffer.from(image.data,'base64'));
  }
  async function capture(name,width,height) {
    assert.deepEqual(await tab.evaluate(`(() => {
      const buttons = ['${toggle}','${opener}'].map(s=>document.querySelector(s).getBoundingClientRect());
      const modal = document.querySelector('${panel}');
      return [innerWidth,innerHeight,document.documentElement.scrollWidth<=innerWidth,
        buttons.every(b=>b.width>=44&&b.height>=44),
        modal.scrollWidth<=modal.clientWidth,modal.getBoundingClientRect().left>=0];
    })()`),[width,height,true,true,true,true]);
    await screenshot(name);
  }
  async function guestList() {
    await openList();
    assert.deepEqual(await destinations(),[pathFor(1)]);
    assert.equal(await tab.evaluate("document.querySelector('[data-bookmarks-source]').textContent"),'Trên thiết bị này');
  }
  async function openAccount() {
    await openToolbarMenu(tab,'account');
    await ready('Account actions visible',`document.querySelector('${logoutButton}').getClientRects().length>0`);
  }
  async function finishLogout(code, start) {
    await until(()=>tab.requests.slice(start).some(r=>r.path==='/api/auth/logout' && finished(r,code)),
      'Logout POST returns '+code);
    await until(async()=> (await readerState(tab))?.guest,'Logout restores Guest scope');
    assert.equal(await tab.evaluate(`document.querySelector('[data-reader-account]').hidden &&
      document.activeElement.id==='${account.slice(1)}'`),true);
    if (await tab.evaluate("document.querySelector('#reader-account-menu').open")) {
      await tab.click(account,{foreground:true});
    }
  }
  async function checkToolbar(width,height) {
    await viewport(tab,width,height);
    const layout = await tab.evaluate(`(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const toolbar=rect('#reader-toolbar'), left=rect('.reader-toolbar-start'),
        right=rect('.reader-toolbar-end'), heading=rect('.reader-toolbar-title');
      const settings=rect('#reader-theme-trigger'), style=getComputedStyle(document.querySelector('#reader-toolbar'));
      const hits=['.reader-toolbar-home','#reader-toc-open','${toggle}','${opener}','#reader-theme-trigger','${account}']
        .map(selector=>{
          const button=rect(selector);
          const hit=document.elementFromPoint(button.left+button.width/2,button.top+button.height/2);
          return button.width>=44 && button.height>=44 && !!hit?.closest(selector);
        });
      const near=(a,b)=>Math.abs(a-b)<=1;
      return [innerWidth,innerHeight,document.documentElement.scrollWidth<=innerWidth,
        style.position==='fixed',near(left.left,toolbar.left+parseFloat(style.paddingLeft)),
        near(right.right,toolbar.right-parseFloat(style.paddingRight)),
        near(settings.right,right.right),near((heading.left+heading.right)/2,(toolbar.left+toolbar.right)/2),
        heading.width>0 && left.right+4<=heading.left && (heading.bottom+4<=right.top || heading.right+4<=right.left),
        hits.every(Boolean),settings.width>=44 &&
          rect('#reader-theme-trigger svg').width===22 && rect('#reader-theme-trigger svg').height===22 &&
          document.querySelector('#reader-theme-trigger svg').getAttribute('viewBox')==='0 0 24 24',
        document.querySelector('.reader-toolbar-title').textContent==='S-ReadNovel' &&
          document.querySelector('.reader-toolbar-title').scrollWidth<=heading.width+1 &&
          document.querySelector('.reader-novel-title').textContent==='Đọc tiếp QA'];
    })()`);
    assert.deepEqual(layout,[width,height,true,true,true,true,true,true,true,true,true,true],
      'Toolbar centering, docking, targets and no overlap at '+width);
  }

  enterScenario('Bookmark Guest toolbar, list, reload and offline');
  await focusTab(tab);
  await viewport(tab,1920,1080);
  await tab.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    const qaOriginalFetch=window.fetch.bind(window);
    window.qaLogoutCalls=0;
    window.fetch=(url,options)=>{
      if (url!=='/api/auth/logout') return qaOriginalFetch(url,options);
      window.qaLogoutCalls++;
      const fault=window.qaLogoutFault;
      window.qaLogoutFault=null;
      if (fault==='csrf') {
        const headers=new Headers(options.headers);
        headers.set(document.querySelector('.reader-page').dataset.csrfHeader,'invalid QA token');
        return qaOriginalFetch(url,{...options,headers});
      }
      if (fault==='network') return Promise.reject(new TypeError('QA transport failure'));
      if (fault==='hold') return new Promise(resolve=>{
        window.qaReleaseLogout=()=>resolve(qaOriginalFetch(url,options));
      });
      return qaOriginalFetch(url,options);
    };
  `});
  await navigate(tab,1);
  await pressed(false);
  assert.equal(await tab.evaluate("document.querySelector('[data-reader-account]').hidden"),true);
  for (const [width,height] of [[1920,1080],[1366,768],[768,1024],[390,844],[320,800]]) {
    await checkToolbar(width,height);
  }
  await tab.evaluate("document.querySelector('#reader-account-trigger').focus()");
  for (const [key,code,virtual] of [['Enter','Enter',13],['Escape','Escape',27],[' ','Space',32]]) {
    for (const type of ['keyDown','keyUp']) {
      const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : '';
      await tab.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:virtual,
        ...(type === 'keyDown' && text ? {text,unmodifiedText:text} : {})});
    }
    await ready('Native Account menu keyboard '+code,
      `document.querySelector('#reader-account-menu').open===${code !== 'Escape'} &&
        document.activeElement.id==='reader-account-trigger'`);
  }
  assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('[data-reader-account-guest] a')].map(a=>a.textContent)`),
    ['Đăng nhập','Đăng ký']);
  assert.equal(await tab.evaluate(`(() => {
    const panel=document.querySelector('#reader-account-panel'), bounds=panel.getBoundingClientRect();
    return bounds.left>=0 && bounds.right<=innerWidth && panel.scrollWidth<=panel.clientWidth &&
      [...panel.querySelectorAll('[data-reader-account-guest] a')].every(a=>a.getBoundingClientRect().height>=44);
  })()`),true,'Account menu fits 320px with full touch targets');
  await screenshot('guest-account-320');
  const outside = await tab.evaluate(`(() => {
    const brand=document.querySelector('.reader-toolbar-title').getBoundingClientRect();
    const x=Math.floor((brand.left+brand.right)/2),y=Math.floor((brand.top+brand.bottom)/2);
    const hit=document.elementFromPoint(x,y);
    return hit?.closest('#reader-toolbar') && !hit.closest('a,button,summary,#reader-account-menu') ? {x,y} : null;
  })()`);
  assert.ok(outside,'Outside click resolves to inert toolbar space');
  for (const type of ['mousePressed','mouseReleased']) {
    await tab.send('Input.dispatchMouseEvent',{type,...outside,button:'left',clickCount:1});
  }
  await ready('Outside click closes Account menu',"!document.querySelector('#reader-account-menu').open");
  await viewport(tab,390,844);
  await openToolbarMenu(tab,'settings');
  await ready('Guest clear lives in Settings',
    "!!document.querySelector('#reader-theme-panel [data-reader-progress-settings]:not([hidden])') && !document.querySelector('#reader-theme-panel [data-reader-logout]')");
  await settleReaderLayout(tab);
  assert.equal(await tab.evaluate(`(() => {
    const panel=document.querySelector('#reader-theme-panel'), bounds=panel.getBoundingClientRect();
    const fontLabel=panel.querySelector('label:has(input[value="Merriweather"]) .reader-option-text');
    const range=document.createRange();
    range.selectNodeContents(fontLabel);
    return bounds.left>=0 && bounds.right<=innerWidth && panel.scrollWidth<=panel.clientWidth &&
      getComputedStyle(panel.querySelector('h2')).fontSize==='18px' && getComputedStyle(panel).fontSize==='14px' &&
      range.getClientRects().length===1;
  })()`),true,'Settings fits at 390px and uses larger menu typography');
  for (const theme of ['light','dark','sepia']) {
    await tab.click(`#reader-theme-panel label:has(input[name="reader-theme"][value="${theme}"])`,
      {foreground:true});
    await ready('Settings gear contrast in '+theme,`(() => {
      const root=document.querySelector('.reader-page');
      const gear=document.querySelector('#reader-theme-trigger svg');
      const style=getComputedStyle(gear);
      return root.dataset.readerTheme===${JSON.stringify(theme)} && style.stroke===style.color &&
        style.color!==getComputedStyle(root).backgroundColor;
    })()`);
  }
  await tab.click('#reader-font-size-increase',{reveal:true,foreground:true});
  await ready('Reading size preference still applies',
    "getComputedStyle(document.querySelector('.reader-content')).fontSize==='20px'");
  await tab.click('#reader-font-size-decrease',{foreground:true});
  await ready('Reading content keeps its default size',
    "getComputedStyle(document.querySelector('.reader-content')).fontSize==='19px'");
  await screenshot('guest-settings-390');
  await tab.click('#reader-theme-trigger',{foreground:true});
  await ready('Settings closes before opening Bookmarks',"!document.querySelector('#reader-theme-selector').open");
  await viewport(tab,1920,1080);
  console.log('PASS fixed toolbar edges, true title center, 44px hit targets and no overlap at 1920/1366/768/390/320.');
  await openList();
  assert.deepEqual(await tab.evaluate(`(() => {
    const button=document.querySelector('[data-bookmarks-close]'), box=button.getBoundingClientRect();
    const header=button.parentElement.getBoundingClientRect();
    return [button.getAttribute('aria-label'),!!button.querySelector('svg'),box.width,box.height,
      Math.abs(header.right-box.right)<=1,Math.abs(header.top-box.top)<=1];
  })()`),['Đóng dấu trang',true,44,44,true,true]);
  assert.match(await tab.evaluate("document.querySelector('[data-bookmarks-status]').textContent"),/Chưa có/);
  await closeList();
  const start = await readerState(tab);
  const guestProgress = await progressStore();
  const guestSql = await readProgress();
  await enableNetwork(true);
  await ready('Offline Guest','!navigator.onLine');
  await tab.click(toggle);
  await pressed(true);
  assert.equal(await progressStore(),guestProgress);
  assert.deepEqual(await readProgress(),guestSql);
  assert.equal((await readerState(tab)).history.id,start.history.id);
  assert.equal(calls().length,0);
  await guestList();
  await capture('desktop-guest',1920,1080);
  await tab.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await tab.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await restoredListFocus('Escape restores Bookmark list trigger focus');
  await guestList();
  await closeList();
  await guestList();
  for (const type of ['mousePressed','mouseReleased']) {
    await tab.send('Input.dispatchMouseEvent',{type,x:0,y:0,button:'left',clickCount:1});
  }
  await restoredListFocus('Backdrop click restores Bookmark list trigger focus');
  await guestList();
  await closeList();
  console.log('PASS accessible 44px X, Escape, backdrop and repeated opens preserve rows and return focus.');
  await enableNetwork(false);
  const beforeReload = await readerState(tab);
  await tab.send('Page.reload');
  await waitForChapter(tab,1,'Guest Bookmark reload',beforeReload);
  await pressed(true);
  const guestBookmark = await bookmarksStore();
  assert.equal(guestBookmark.length,1);
  await guestList();
  await closeList();
  await navigate(tab,3);
  await pressed(false);
  await guestList();
  const beforeGuestBack = await readerState(tab);
  const guestHistory = await tab.send('Page.getNavigationHistory');
  await clickChapter(tab,`${items} a[href="${pathFor(1)}"]`,1,'Guest bookmark title links to its chapter');
  await pressed(true);
  await guestList();
  await closeList();
  await tab.send('Page.navigateToHistoryEntry',{entryId:guestHistory.entries[guestHistory.currentIndex].id});
  await waitForChapter(tab,3,'Guest Back to bookmark source',beforeGuestBack);
  await pressed(false);
  await guestList();
  await clickChapter(tab,`${items} a[href="${pathFor(1)}"]`,1,'Guest bookmark retains named link after Back');
  await pressed(true);
  console.log('PASS Guest offline toggle, empty/list and reload; no Bookmark API requests, no Resume/Completion changes.');

  enterScenario('Bookmark Guest login without import and Auth pagination');
  const authBeforeLogin = await inspectFixture('bookmark-snapshot');
  const loginLink = '[data-reader-account-guest] a[href^="/login?"]';
  await openToolbarMenu(tab,'account');
  await tab.click(loginLink,{reveal:true,foreground:true});
  await ready('Login form ready',"location.pathname==='/login' && document.querySelector('#auth-submit')?.disabled===false");
  await tab.evaluate(`(() => {
    document.querySelector('#identifier').value=${JSON.stringify(config.login)};
    document.querySelector('#password').value=${JSON.stringify(config.password)};
  })()`);
  await tab.click('#auth-submit',{foreground:true});
  await waitForChapter(tab,1,'Login returns to Reader');
  await ready('Verified Auth reader controls', "!document.querySelector('[data-reader-account]').hidden");
  assert.equal(await tab.evaluate("!!document.querySelector('#reader-guest-merge,#reader-bookmark-import,[data-bookmark-import-offer],[data-bookmark-import-manual]')"),false);
  assert.deepEqual((await inspectFixture('bookmark-snapshot')).bookmarks,authBeforeLogin.bookmarks);
  assert.deepEqual(await readProgress(),accountBookmarkProgress(authBeforeLogin));
  await pressed(false);
  assert.deepEqual(await bookmarksStore(),guestBookmark);
  assert.equal(writes().length,0);
  await openList();
  assert.equal((await destinations()).length,20);
  assert.equal((await destinations())[0],pathFor(9));
  assert.ok(!(await destinations()).includes(pathFor(1)));
  await tab.click('[data-bookmarks-next]');
  await ready('Bookmark API second page',
    "document.querySelector('[data-bookmarks-page]').textContent==='2 / 2'");
  assert.deepEqual(await destinations(),[pathFor(29),pathFor(30)]);
  await tab.click('[data-bookmarks-prev]');
  await ready('Bookmark API first page',"document.querySelector('[data-bookmarks-page]').textContent==='1 / 2'");
  await closeList();
  const beforeAuth = await readProgress();
  await tab.click(toggle,{foreground:true});
  await pressed(true);
  assert.equal(writes().filter(r=>finished(r,204)).length,1);
  assert.deepEqual(await readProgress(),beforeAuth);
  await tab.click(toggle,{foreground:true});
  await pressed(false);
  await tab.click(toggle,{foreground:true});
  await pressed(true);
  assert.deepEqual(writes().map(r=>[r.method,r.status]),[['PUT',204],['DELETE',204],['PUT',204]]);
  assert.deepEqual(await readProgress(),beforeAuth);
  const beforeAuthReload = await readerState(tab);
  await tab.send('Page.reload');
  await waitForChapter(tab,1,'Auth Bookmark reload',beforeAuthReload);
  await pressed(true);
  await viewport(tab,390,844);
  await openList();
  await enableNetwork(true);
  await ready('Auth offline preserves acknowledgement',
    `!navigator.onLine && document.querySelector('${toggle}').getAttribute('aria-pressed')==='true' &&
      document.querySelector('${toggle}').getAttribute('aria-disabled')==='true' &&
      document.querySelector('[data-bookmarks-status]').textContent.includes('cần kết nối')`);
  assert.ok((await destinations()).includes(pathFor(1)));
  assert.equal(writes().length,3);
  await enableNetwork(false);
  await ready('Auth online refresh',
    `document.querySelector('${toggle}').getAttribute('aria-disabled')==='false' &&
      document.querySelector('${panel}').getAttribute('aria-busy')==='false'`);
  await closeList();
  console.log('PASS real login A preserves PostgreSQL, Auth pagination/toggle/reload and no offline mutation.');

  enterScenario('Bookmark archived row, mobile layout and logout A');
  await inspectFixture('archive-bookmark');
  await openList();
  await ready('Archived row shown without link',
    `[...document.querySelectorAll('${items} li')].some(li=>
      li.textContent.includes('Chương không còn khả dụng') && !li.querySelector('a'))`);
  assert.ok(!(await destinations()).includes(pathFor(9)));
  await capture('mobile-auth',390,844);
  const beforeRemove = await readProgress();
  await tab.click(`${items} li:has(span) button`,{reveal:true});
  await ready('Archived bookmark removed from list',
    `![...document.querySelectorAll('${items} li')].some(li=>li.textContent.includes('Chương không còn khả dụng'))`);
  assert.deepEqual((await inspectFixture('bookmark-snapshot')).bookmarks.find(row=>row[0]===9),[9,false,true]);
  assert.deepEqual(await readProgress(),beforeRemove);
  await closeList();
  const authBeforeLogout = await inspectFixture('bookmark-snapshot');
  await openAccount();
  await screenshot('account');
  const failedStart = tab.requests.length;
  await tab.evaluate("window.qaLogoutFault='csrf'");
  await tab.click(logoutButton);
  await until(()=>tab.requests.slice(failedStart).some(r=>r.path==='/api/auth/logout' && finished(r,403)),
    'CSRF-invalid UI logout rejected');
  await ready('Logout failure shown with Auth still active',
    "document.querySelector('[data-reader-logout-status]').textContent.includes('Chưa xác nhận') && !document.querySelector('[data-reader-account]').hidden");
  await pressed(true);
  assert.equal((await inspectFixture('bookmark-snapshot')).a_sessions,authBeforeLogout.a_sessions);
  await tab.evaluate("window.qaLogoutFault='network'");
  await tab.click(logoutButton);
  await ready('Transport failure leaves Auth active',
    "window.qaLogoutCalls===2 && document.querySelector('[data-reader-logout-status]').textContent.includes('Chưa xác nhận') && !document.querySelector('[data-reader-account]').hidden");
  await pressed(true);
  const signedOutStart = tab.requests.length;
  await tab.evaluate("window.qaLogoutFault='hold'");
  await tab.click(logoutButton);
  await ready('Pending logout masks private UI and blocks mutation',
    `!!window.qaReleaseLogout && document.querySelector('${logoutButton}').getAttribute('aria-disabled')==='true' &&
      !document.querySelector('[data-reader-account-name]').textContent &&
      document.querySelector('${toggle}').getAttribute('aria-pressed')===null &&
      document.querySelector('.reader-completion').hidden && document.querySelector('.reader-resume').hidden`);
  for (const type of ['keyDown','keyUp']) {
    await tab.send('Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32});
  }
  assert.equal(await tab.evaluate('window.qaLogoutCalls'),3);
  await tab.evaluate('window.qaReleaseLogout()');
  await finishLogout(200,signedOutStart);
  assert.equal((await inspectFixture('bookmark-snapshot')).a_sessions,authBeforeLogout.a_sessions-1);
  assert.deepEqual(await readProgress(),beforeRemove);
  assert.equal(tab.requests.slice(signedOutStart).filter(r=>
    r.method!=='GET' && (r.path.startsWith(config.progress)||r.path.startsWith(prefix))).length,0);
  await pressed(true);
  assert.deepEqual(await bookmarksStore(),guestBookmark);
  await guestList();
  await closeList();
  console.log('PASS archive redaction and explicit removal preserve legacy note; logout A restores original Guest bookmark.');

  enterScenario('Bookmark account change on native history and TOC');
  await cookie(second,0);
  await focusTab(second);
  await focusTab(tab);
  await ready('A scope re-established',
    `document.querySelector('${toggle}').getAttribute('aria-disabled')==='false' &&
      !document.querySelector('[data-reader-account-guest]:not([hidden])')`);
  await openList();
  assert.ok((await destinations()).includes(pathFor(10)));
  const documentA = await readerState(tab);
  const history = await tab.send('Page.getNavigationHistory');
  await clickChapter(tab,`${items} a[href="${pathFor(10)}"]`,10,'Native published Bookmark link');
  await pressed(true);
  await openList();
  assert.ok((await destinations()).includes(pathFor(10)));
  await closeList();
  await openAccount();
  const beforeHistoryLogout = tab.requests.length;
  await tab.click(logoutButton);
  await finishLogout(200,beforeHistoryLogout);
  const signedOut = await readerState(tab);
  await tab.send('Page.reload');
  await waitForChapter(tab,10,'Logout remains Guest across reload',signedOut);
  await ready('Guest account actions hidden after reload',
    "document.querySelector('[data-reader-account]').hidden && !document.querySelector('[data-reader-account-guest]').hidden");
  await cookie(second,1);
  await tab.send('Page.navigateToHistoryEntry',{entryId:history.entries[history.currentIndex].id});
  await waitForChapter(tab,1,'Back to chapter 1 with session B',documentA);
  await pressed(false);
  const restored = await readerState(tab);
  assert.equal(restored.history.persisted,restored.history.id===documentA.history.id);
  if (config.history==='fresh') assert.equal(restored.history.persisted,false);
  await openList();
  assert.deepEqual(await destinations(),[pathFor(3)]);
  assert.deepEqual(await bookmarksStore(),guestBookmark);
  await closeList();
  await tab.click('#reader-toc-open',{foreground:true});
  await tab.click('#reader-toc-list li[data-sequence="10"] a',{reveal:true});
  await ready('Forward TOC jump still needs confirmation',"!document.querySelector('#reader-jump-confirmation').hidden");
  await tab.click('#reader-jump-cancel');
  assert.equal((await readerState(tab)).chapter,'1');
  await tab.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await tab.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await ready('TOC closed',"!document.querySelector('#reader-toc').open");
  await openAccount();
  await inspectFixture('expire-bookmark-b');
  const expired = tab.requests.length;
  await tab.click(logoutButton);
  await finishLogout(401,expired);
  await pressed(true);
  assert.deepEqual(await bookmarksStore(),guestBookmark);
  assert.equal(writes().length,4);
  assert.equal(tab.exceptions.length+second.exceptions.length,0);
  assert.deepEqual((await readProgress()).evidence,[]);
  console.log('PASS account B only sees its own list after',restored.history.persisted?'native BFCache':'fresh document',
    '; Published bookmark opens normally and TOC forward jump still confirms.');
  console.log('PASS logout 403/transport errors retain Auth; successful POST revokes a DB session; expired 401 restores verified Guest.');
}

async function verifyManualOffline(tab, second) {
  const button = '[data-reader-completion-action]';
  const status = '[data-reader-completion-status]';
  const label = text => until(()=>tab.evaluate(`document.querySelector('${status}')?.textContent.includes(${JSON.stringify(text)})`),
    'Completion displays '+text);
  const ready = text => until(()=>tab.evaluate(`(() => {
    const button = document.querySelector('${button}');
    return button?.textContent === ${JSON.stringify(text)} && button.getClientRects().length > 0 &&
      button.getAttribute('aria-disabled') === 'false';
  })()`),'Completion control visible and enabled: '+text);
  const useNetwork = offline => tab.send('Network.emulateNetworkConditions',{
    offline,latency:0,downloadThroughput:offline?0:-1,uploadThroughput:offline?0:-1,
  });
  const writes = () => tab.requests.filter(r=>r.method==='PUT' && r.path.includes('/completions/'));
  const authProbes = () => tab.requests.filter(r=>r.path==='/api/auth/me');
  const setFocusEmulation = (browser,enabled) =>
    browser.send('Emulation.setFocusEmulationEnabled',{enabled});
  const offlineState = () => tab.evaluate('!navigator.onLine');
  const claim = owner => tab.evaluate(`(() => {
    const prefix = ${JSON.stringify('readnovel.progress.auth.v1.'+config.owners[owner]+'.'+config.novel+'.completion.')};
    const key = prefix + document.querySelector('.reader-page').dataset.chapterId;
    const record = JSON.parse(localStorage.getItem(key));
    return record && {state:record.state, ownerMatches:key.startsWith('readnovel.progress.auth.v1.'+record.owner_id+'.')};
  })()`);
  async function pressCompletion() {
    await tab.evaluate(`document.querySelector('${button}').focus({preventScroll:true})`);
    for (const type of ['keyDown','keyUp']) {
      await tab.send('Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32});
    }
  }
  async function pauseOwnerVerification() {
    const start = tab.paused.length;
    await tab.send('Fetch.enable',{patterns:[{urlPattern:config.origin+'/api/auth/me',requestStage:'Request'}]});
    return async () => {
      const paused = () => tab.paused.slice(start).find(r=>r.url===config.origin+'/api/auth/me');
      await until(paused,'Intercepted pending owner verification');
      return paused().id;
    };
  }
  const assertSameDocument = async before => {
    const after = await readerState(tab);
    assert.equal(after.history.id,before.history.id);
    assert.equal(after.url,before.url);
  };
  enterScenario('Manual Completion: DevTools Offline in the same document');
  await navigateBlank(second);
  await setFocusEmulation(second,false);
  await setFocusEmulation(tab,false);
  await cookie(tab,0);
  await focusTab(tab);
  await viewport(tab,1920,1080);
  await navigate(tab,1);
  await awaitActivation(tab,0,200,'Owner A initial writer');
  await label('Chưa đọc');
  await ready('Đã đọc xong');
  const before = await readerState(tab);
  const initial = await inspectFixture('snapshot');
  assert.deepEqual(initial.evidence,[]);
  await useNetwork(true);
  await until(offlineState,'Edge reports network offline');
  await assertSameDocument(before);
  await ready('Đã đọc xong');
  console.log('QA network-only transition kept Completion visible.');

  enterScenario('Manual Completion: DevTools Offline with focus and visibility changes');
  await focusTab(second);
  await until(()=>tab.evaluate("document.visibilityState==='hidden'"),'Verified document hidden');
  await focusTab(tab);
  await assertSameDocument(before);
  await ready('Đã đọc xong');
  await pressCompletion();
  await label('chưa đồng bộ');
  assert.deepEqual(await claim(0),{state:'dirty',ownerMatches:true});
  assert.equal(writes().length,0);
  assert.deepEqual(await inspectFixture('snapshot'),initial);
  console.log('PASS same-document offline and focus cycle: explicit pending claim, zero PUT, unchanged PostgreSQL.');

  enterScenario('Manual Completion: reconnect requires explicit sync');
  const start = authProbes().length;
  const nextVerification = await pauseOwnerVerification();
  await useNetwork(false);
  const verification = await nextVerification();
  await assertSameDocument(before);
  assert.equal(await tab.evaluate(`document.querySelector('${button}').getAttribute('aria-disabled')`),'true');
  assert.equal(writes().length,0);
  assert.deepEqual(await inspectFixture('snapshot'),initial);
  await tab.send('Fetch.continueRequest',{requestId:verification});
  await tab.send('Fetch.disable');
  await until(()=>authProbes().slice(start).some(r=>finished(r,200)),'Reconnection verifies the owner');
  await ready('Đồng bộ xác nhận');
  assert.equal(writes().length,0);
  await pressCompletion();
  await until(()=>writes().length===1 && finished(writes()[0],200),'Explicit sync PUT completes');
  await label('Đã đọc');
  assert.deepEqual((await inspectFixture('snapshot')).evidence,[[1,true]]);
  assert.equal(await claim(0),null);
  console.log('PASS reconnect verified owner first, explicit sync made one PUT and one PostgreSQL evidence.');

  enterScenario('Manual Completion: storage quota while offline');
  await viewport(tab,390,844);
  await navigate(tab,3);
  await until(()=>activations(tab).length===2 && finished(activations(tab)[1],200),'A chapter 3 activation');
  await ready('Đã đọc xong');
  const beforeBlocked = await inspectFixture('snapshot');
  await useNetwork(true);
  await until(offlineState,'Offline on chapter 3');
  await tab.evaluate(`(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key,value) {
      if (key.includes('.completion.')) throw new DOMException('QA storage quota','QuotaExceededError');
      return original.call(this,key,value);
    };
    window.restoreQaStorage = () => { Storage.prototype.setItem = original; };
  })()`);
  await pressCompletion();
  await label('Không thể lưu xác nhận trên thiết bị');
  assert.equal(await claim(0),null);
  assert.deepEqual(await inspectFixture('snapshot'),beforeBlocked);
  await tab.evaluate('window.restoreQaStorage()');
  await pressCompletion();
  await until(async()=> (await claim(0))?.state==='dirty','Explicit second click persists an offline claim');
  assert.deepEqual(await claim(0),{state:'dirty',ownerMatches:true});
  await useNetwork(false);
  await ready('Đồng bộ xác nhận');
  assert.equal(writes().length,1);
  console.log('PASS quota gives an explicit storage error, no server or durable evidence until a successful local write.');

  enterScenario('Manual Completion: Back after account switch and real logout');
  const departure = await readerState(tab);
  const history = await tab.send('Page.getNavigationHistory');
  await tab.send('Page.navigate',{url:config.origin+'/api/health'});
  await until(()=>tab.evaluate("location.pathname==='/api/health'"),'Park A document');
  const beforeBackCalls = progressCalls(tab).length;
  await cookie(second,1);
  await tab.send('Page.navigateToHistoryEntry',{entryId:history.entries[history.currentIndex].id});
  await waitForChapter(tab,3,'Back to chapter 3 as B',departure);
  await ready('Đã đọc xong');
  const returned = await readerState(tab);
  assert.equal(returned.history.persisted,returned.history.id===departure.history.id);
  if (config.history==='fresh') assert.equal(returned.history.persisted,false);
  else if (!returned.history.persisted) console.log('NOT TESTED native BFCache: Edge restored a fresh document.');
  assert.equal(await claim(1),null);
  assert.deepEqual(await claim(0),{state:'dirty',ownerMatches:true});
  assert.equal(writes().length,1);
  await until(()=>tab.evaluate(`Boolean(document.querySelector('${action}'))`),'Read-only B ownership bootstrap');
  assert.equal(progressCalls(tab).slice(beforeBackCalls).filter(r=>r.method!=='GET').length,0);
  const accountB = await readResume(1);
  assert.equal(accountB.chapter,null);
  console.log('PASS A claim isolated from B on Back:',returned.history.persisted?'native BFCache':'fresh document');
  assert.equal(await tab.evaluate(`(async () => {
    const {csrfCookie,csrfHeader} = document.querySelector('.reader-page').dataset;
    const prefix = csrfCookie + '=';
    const token = document.cookie.split('; ').find(value=>value.startsWith(prefix))?.slice(prefix.length);
    return (await fetch('/api/auth/logout',{method:'POST',headers:{[csrfHeader]:token}})).status;
  })()`),200);
  await focusTab(second);
  await focusTab(tab);
  await until(async()=> (await readerState(tab)).guest,'Confirmed logout retires B scope');
  assert.equal(writes().length,1);

  enterScenario('Manual Completion: authenticated offline reload and unknown fresh session');
  await cookie(second,0);
  await focusTab(second);
  await focusTab(tab);
  await ready('Đồng bộ xác nhận');
  const accountA = await readResume();
  assert.equal(accountA.chapter,3);
  const priorReload = await inspectFixture('snapshot');
  await useNetwork(true);
  await until(offlineState,'Verified A is offline before reload');
  const requestsBeforeReload = tab.requests.length;
  await tab.send('Page.reload');
  await until(()=>tab.requests.slice(requestsBeforeReload)
    .some(r=>r.type==='Document' && r.networkError==='net::ERR_INTERNET_DISCONNECTED'),'Offline reload cannot fetch Reader HTML');
  await until(()=>tab.evaluate("document.readyState==='complete' && !document.querySelector('.reader-page')"),
    'Offline reload has no authenticated Reader UI');
  assert.deepEqual(await inspectFixture('snapshot'),priorReload);
  await useNetwork(false);
  const unavailable = await pauseOwnerVerification();
  await navigate(tab,3);
  await tab.send('Fetch.failRequest',{requestId:await unavailable(),errorReason:'ConnectionReset'});
  await tab.send('Fetch.disable');
  await until(()=>tab.evaluate("document.querySelector('[data-reader-resume-status]').textContent.includes('Không kiểm tra được phiên')"),
    'Fresh authenticated hint without owner proof stays unknown');
  assert.equal((await readerState(tab)).completion.shown,false);
  assert.equal(writes().length,1);
  assert.deepEqual(await inspectFixture('snapshot'),priorReload);
  console.log('PASS offline reload fails network safely; fresh SSR hint with failed /me cannot expose A claim.');

  enterScenario('Manual Completion: session expires while offline');
  await focusTab(second);
  await focusTab(tab);
  // The expiry case needs a foreground reconnect. Real visibility was tested above.
  await setFocusEmulation(tab,true);
  await ready('Đồng bộ xác nhận');
  await useNetwork(true);
  await until(offlineState,'Online-verified session goes offline');
  await inspectFixture('expire-a');
  const expiredStart = authProbes().length;
  await useNetwork(false);
  await until(()=>authProbes().slice(expiredStart).some(r=>finished(r,401)),'Expired A session returns 401');
  await until(async()=> (await readerState(tab)).guest,'Expired session retires authenticated scope');
  assert.deepEqual(await claim(0),{state:'dirty',ownerMatches:true});
  assert.equal(writes().length,1);
  assert.deepEqual(await inspectFixture('snapshot'),priorReload);
  assert.equal(tab.exceptions.length+second.exceptions.length,0);
  console.log('PASS actual logout and PostgreSQL session expiry retire the scope without replay.');
  console.log('RESUME_QA_FINAL',JSON.stringify([[accountA.chapter,accountA.revision],
    accountB.chapter===null ? null : [accountB.chapter,accountB.revision]]));
}

async function verifyOffline(tab, second) {
  const draft = '[data-reader-resume-draft]';
  const resumeStatus = '[data-reader-resume-status]';
  const completionStatus = '[data-reader-completion-status]';
  const completion = '[data-reader-completion-action]';
  const completionWrites = browser => browser.requests.filter(r=>r.method==='PUT' && r.path.includes('/completions/'));
  const label = (selector,text) => until(()=>tab.evaluate(
    `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(text)})`),
    selector + ' displays ' + text);
  const move = value => tab.evaluate(fractionScript(`window.scrollTo(0,start+span*${value});`));
  async function pressCompletion() {
    await tab.evaluate(`document.querySelector('${completion}').focus({preventScroll:true})`);
    await tab.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await tab.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  }
  const setOnline = value => tab.evaluate(`window.qaOnline=${value};
    window.dispatchEvent(new Event(${JSON.stringify(value?'online':'offline')}));`);
  const drafts = (browser,index = 0) => browser.evaluate(`Object.keys(localStorage)
    .filter(key=>key.startsWith(${JSON.stringify('readnovel.progress.auth.v1.'+config.owners[index]+'.'+config.novel+'.')}))
    .map(key=>JSON.parse(localStorage.getItem(key)))`);
  const closeTo = (expected,actual) => Math.abs(expected - actual) < .015;
  const receipts = async () => {
    const response = await fetch(config.origin+'/_reader_qa/resume-receipts',{signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);
    return response.json();
  };
  const waitStored = (position,state) => until(async () =>
    (await drafts(tab)).some(d=>d.kind==='resume' && d.state===state && closeTo(position,d.scroll_position)),
    'Stored ' + state + ' draft at ' + position);
  const watch = async stage => {
    let index = tab.paused.length;
    await tab.send('Fetch.enable',{patterns:[{urlPattern:config.origin+config.progress+'/resume',requestStage:stage}]});
    return async () => {
      const selected = () => tab.paused.slice(index).find(item=>item.method==='PUT');
      await until(selected,'Intercepted Resume '+stage);
      const item = selected();
      index = tab.paused.indexOf(item)+1;
      assert.ok(item.attempt, 'Interception matches a tagged QA Resume attempt');
      return item;
    };
  };
  const fail = request => tab.send('Fetch.failRequest',{requestId:request.id,errorReason:'ConnectionReset'});
  const failedAttempt = async (held, reason, timeout) => {
    const outcome = () => tab.resumeAttempts.find(item=>item.id===held.attempt && item.phase==='reject');
    await until(()=>outcome() && scrolls(tab).some(item=>item.id===held.networkId && item.networkError===reason),
      'Client rejection and CDP failure for '+held.attempt+' '+reason);
    assert.equal(outcome().timeout,timeout);
  };

  enterScenario('offline initial verified account and debounce');
  for (const [browser,name] of [[tab,'A'],[second,'B']]) {
    await browser.send('Runtime.addBinding',{name:'readnovelQaResume'});
    const args = [config.origin,config.progress+'/resume',name].map(value=>JSON.stringify(value)).join(',');
    await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`(${traceResumeRequests})(${args});`});
  }
  await tab.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.qaOnline=true;
    const forwardFetch=window.fetch;
    Object.defineProperty(navigator,'onLine',{get:()=>window.qaOnline});
    window.fetch=(url,options)=>{
      if (options?.keepalive && options.method==='PUT' && url.endsWith('/resume')) {
        const key='readnovel.qa.keepalive';
        sessionStorage.setItem(key,String(1+Number(sessionStorage.getItem(key))));
      }
      return forwardFetch(url,options);
    };
  `});
  await cookie(tab,0);
  await focusTab(tab);
  await viewport(tab,320,800);
  await navigate(tab,1);
  await awaitActivation(tab,0,200,'Initial Auth writer');
  await label(completionStatus,'Chưa đọc');
  await move(.2);
  await waitStored(.2,'dirty');
  assert.equal(scrolls(tab).length,0);
  await until(()=>scrolls(tab).some(r=>finished(r,200)),'Five-second successful debounce');
  await label(resumeStatus,'Đã đồng bộ');
  const online = await readResume();
  const initialWrites = await receipts();
  assert.deepEqual(initialWrites,[{id:scrolls(tab)[0].attempt,status:200}]);
  const onlineDispatch = tab.resumeAttempts.find(item=>item.phase==='dispatch' && item.id===initialWrites[0].id);
  assert.equal(onlineDispatch?.source,'debounce');
  assert.ok(closeTo(.2,online.position));
  assert.deepEqual(await drafts(tab),[]);
  console.log('PASS Auth online scroll: one PUT after five-second debounce and server acknowledgement.');

  enterScenario('offline scroll and explicit Completion, retry before commit');
  await move(.33);
  await waitStored(.33,'dirty');
  await setOnline(false);
  const beforeOffline = progressCalls(tab).length;
  // Real keyboard activation of the button without moving the reading position.
  await pressCompletion();
  await label(completionStatus,'chưa đồng bộ');
  assert.equal(completionWrites(tab).length,0);
  assert.equal(progressCalls(tab).length,beforeOffline);
  assert.deepEqual((await inspectFixture('snapshot')).evidence,[]);
  const beforeRetry = progressCalls(tab).length;
  const beforeAttempts = tab.resumeAttempts.length;
  const beforeCommit = await inspectFixture('snapshot');
  assert.deepEqual(beforeCommit.progress,[[1,online.revision,online.position,777]]);
  await tab.evaluate('window.qaResumeFailure.hold()');
  const pendingPut = await watch('Request');
  await setOnline(true);
  let held = await pendingPut();
  const networkFailures = [];
  if (process.env.READNOVEL_QA_PRECOMMIT_ABORT === '1') {
    // Let the application's existing AbortSignal fire while CDP holds the first request.
    await failedAttempt(held,'net::ERR_ABORTED',true);
    networkFailures.push({id:held.attempt,terminal:'ERR_ABORTED'});
    assert.deepEqual(await receipts(),initialWrites);
    assert.deepEqual(await inspectFixture('snapshot'),beforeCommit);
    await tab.evaluate('window.qaResumeFailure.advance()');
    held = await pendingPut();
  }
  await fail(held);
  await failedAttempt(held,'net::ERR_CONNECTION_RESET',false);
  networkFailures.push({id:held.attempt,terminal:'ERR_CONNECTION_RESET'});
  await tab.send('Fetch.disable');
  assert.deepEqual(await receipts(),initialWrites,'FastAPI received no PUT from the failed attempts');
  assert.deepEqual(await inspectFixture('snapshot'),beforeCommit,'Rejected attempts changed no PostgreSQL state');
  await tab.evaluate('window.qaResumeFailure.release()');
  const sent = () => tab.resumeAttempts.slice(beforeAttempts).filter(item=>item.phase==='dispatch');
  const accepted = () => tab.resumeAttempts.slice(beforeAttempts).find(item=>item.phase==='response' && item.status===200);
  await until(()=>accepted() && scrolls(tab).some(item=>item.attempt===accepted().id && finished(item,200)),
    'Same writer retry after pre-commit failure');
  await label(resumeStatus,'Đã đồng bộ');
  const attempts = sent();
  assert.deepEqual(attempts.map(item=>item.id),[...networkFailures.map(item=>item.id),accepted().id]);
  assert.deepEqual(attempts.map(item=>item.source),['debounce',...networkFailures.map(()=> 'retry')]);
  for (const item of attempts) {
    assert.equal(item.writer,onlineDispatch.writer);
    assert.equal(item.row,onlineDispatch.row);
    assert.equal(item.precondition,online.revision);
    assert.equal(item.keepalive,false);
    assert.ok(closeTo(.33,item.fraction));
    assert.equal(item.fraction,attempts[0].fraction);
  }
  assert.deepEqual(await receipts(),[...initialWrites,{id:accepted().id,status:200}]);
  const saved = await readResume();
  assert.equal(saved.revision,online.revision+1);
  assert.ok(closeTo(.33,saved.position));
  assert.deepEqual((await inspectFixture('snapshot')).progress,[[1,saved.revision,saved.position,777]]);
  assert.deepEqual(progressCalls(tab).slice(beforeRetry).map(r=>r.method),
    ['PUT',...networkFailures.flatMap(()=> ['GET','PUT'])]);
  console.log('QA pre-commit PUT',JSON.stringify({initial:onlineDispatch,attempts,networkFailures,
    fastapi:[...initialWrites,{id:accepted().id,status:200}],postgres:[online.revision,saved.revision]}));
  assert.equal(completionWrites(tab).length,0);
  assert.deepEqual((await inspectFixture('snapshot')).evidence,[]);
  await pressCompletion();
  await label(completionStatus,'Đã đọc');
  assert.equal(completionWrites(tab).length,1);
  assert.deepEqual((await inspectFixture('snapshot')).evidence,[[1,true]]);
  console.log('PASS offline writes: 0 until reconnect. Resume retries retain CAS; Completion waits for explicit sync.');

  enterScenario('response lost after commit');
  const beforeLoss = progressCalls(tab).length;
  const previousReceipts = await receipts();
  const heldResponse = await watch('Response');
  await tab.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await move(.46);
  await waitStored(.46,'dirty');
  const response = await heldResponse();
  assert.equal(response.responseStatusCode,200);
  const committed = await readResume();
  assert.equal(committed.revision,saved.revision+1);
  assert.ok(closeTo(.46,committed.position),'Committed position: '+committed.position);
  const lostReceipt = {id:response.attempt,status:200};
  assert.deepEqual(await receipts(),[...previousReceipts,lostReceipt]);
  const committedDb = await inspectFixture('snapshot');
  assert.deepEqual(committedDb.progress,[[1,committed.revision,committed.position,777]]);
  await fail(response);
  await tab.send('Fetch.disable');
  await label(resumeStatus,'Đã đồng bộ');
  assert.deepEqual(await readResume(),committed);
  assert.deepEqual(progressCalls(tab).slice(beforeLoss).map(r=>r.method),['PUT','GET']);
  assert.deepEqual(await receipts(),[...previousReceipts,lostReceipt]);
  assert.deepEqual(await inspectFixture('snapshot'),committedDb);
  assert.deepEqual(await drafts(tab),[]);
  console.log('PASS response lost after PostgreSQL commit: one GET, zero retry PUT and zero Activate.');

  enterScenario('pagehide keepalive then tab conflict and reload');
  await awaitActivation(tab,1,200,'Deliberate writer after lost acknowledgement');
  await move(.49);
  await waitStored(.49,'dirty');
  const keepaliveCount = () => tab.evaluate("Number(sessionStorage.getItem('readnovel.qa.keepalive'))");
  const beforeHide = await keepaliveCount();
  await navigateBlank(tab);
  await until(async()=> {
    const saved = await readResume();
    return saved.revision === committed.revision+2 && closeTo(.49,saved.position);
  },'Keepalive commits pending position on pagehide');
  await navigate(tab,1);
  assert.equal(await keepaliveCount(),beforeHide+1,'Outgoing document called fetch keepalive once');
  const departure = await tab.evaluate("JSON.parse(sessionStorage.getItem('readnovel.qa.keepaliveContext'))");
  assert.ok(['pagehide','visibilitychange'].includes(departure.source));
  assert.equal(departure.precondition,committed.revision+1);
  assert.ok((await receipts()).some(item=>item.id===departure.id && item.status===200));
  console.log('QA departure PUT',JSON.stringify(departure));
  await awaitActivation(tab,2,200,'New document writer after keepalive');
  await setOnline(false);
  await move(.61);
  await waitStored(.61,'dirty');
  await focusTab(second);
  await navigate(second,3);
  await awaitActivation(second,0,200,'Deliberate new writer in second tab');
  const newer = await readResume();
  assert.equal(newer.chapter,3);
  const newerDb = await inspectFixture('snapshot');
  await focusTab(tab);
  await setOnline(true);
  const staleStart = scrolls(tab).length;
  await until(()=>scrolls(tab).slice(staleStart).some(r=>finished(r,412)),'Stale offline writer receives 412');
  await waitStored(.61,'conflict');
  const stale = scrolls(tab).slice(staleStart).find(item=>finished(item,412));
  const staleWrite = tab.resumeAttempts.find(item=>item.id===stale.attempt && item.phase==='dispatch');
  assert.equal(staleWrite.precondition,newer.revision-1);
  assert.ok((await receipts()).some(item=>item.id===stale.attempt && item.status===412));
  assert.deepEqual(await inspectFixture('snapshot'),newerDb);
  assert.deepEqual(await readResume(),newer);
  const prior = await readerState(tab);
  await tab.send('Page.reload');
  await waitForChapter(tab,1,'Reload existing draft',prior);
  await label(resumeStatus,'chưa đồng bộ');
  assert.equal(activations(tab).length,3);
  assert.equal(scrolls(tab).length,staleStart+1);
  assert.deepEqual(await readResume(),newer);
  assert.deepEqual(await inspectFixture('snapshot'),newerDb);
  console.log('QA stale PUT',JSON.stringify({attempt:staleWrite,status:412,committedRevision:newer.revision}));
  console.log('PASS pagehide one keepalive, old writer 412, reload keeps draft and sends no write.');

  enterScenario('offline account switch and Back');
  assert.ok(await tab.evaluate(`document.querySelector('${draft}').scrollWidth <= innerWidth`));
  const history = await tab.send('Page.getNavigationHistory');
  const beforeBack = await readerState(tab);
  await clickChapter(tab,'#reader-next-chapter',3,'Park the authenticated draft document');
  await label(resumeStatus,'chưa đồng bộ');
  await cookie(second,1);
  const priorB = progressCalls(tab).length;
  await tab.send('Page.navigateToHistoryEntry',{entryId:history.entries[history.currentIndex].id});
  await focusTab(tab);
  await waitForChapter(tab,1,'History after account switch',beforeBack);
  await label(completionStatus,'Chưa đọc');
  const restored = await readerState(tab);
  if (config.history==='fresh') assert.equal(restored.history.persisted,false);
  if (restored.history.persisted) assert.equal(restored.history.id,beforeBack.history.id);
  await until(()=>tab.evaluate(`Boolean(document.querySelector('${action}'))`),'Read-only B bootstrap completes');
  assert.equal(progressCalls(tab).slice(priorB).filter(r=>r.method!=='GET').length,0);
  assert.equal(await tab.evaluate(`document.querySelector('${draft}').hidden`),true);
  await waitStored(.61,'conflict');
  assert.deepEqual(await drafts(tab,1),[]);
  assert.deepEqual(await readResume(),newer);
  assert.equal(completionWrites(tab).length,1);
  assert.equal(tab.exceptions.length+second.exceptions.length,0);
  const accountB = await readResume(1);
  assert.equal(accountB.chapter,null);
  console.log('PASS old account draft stays isolated across Back:',
    restored.history.persisted?'native BFCache':'fresh document');
  console.log('RESUME_QA_FINAL',JSON.stringify(
    [[newer.chapter,newer.revision],accountB.chapter===null ? null : [accountB.chapter,accountB.revision]]));
}

async function main() {
  let port;
  await until(() => {
    try { port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]); }
    catch { return false; }
    return port > 0;
  }, 'Edge did not start');
  checkpoint('Edge DevTools port ready');
  const debug='http://127.0.0.1:'+port;
  const version = await (await fetch(debug+'/json/version',{signal:AbortSignal.timeout(5000)})).json();
  checkpoint('Edge DevTools HTTP ready '+version.Browser+' CDP '+version['Protocol-Version']);
  browserSocket = await openCdpSocket(version.webSocketDebuggerUrl,'browser');
  checkpoint('CDP browser socket ready');
  checkpoint('Opening primary CDP target');
  const tab = await connect(await (await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json());
  let second;
  try {
    if (config.suite === 'guest') {
      second = await connect(await (await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json());
      await verifyGuest(tab,second);
      return;
    }
    if (config.suite === 'bookmarks') {
      second = await connect(await (await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json());
      await verifyBookmarks(tab,second);
      return;
    }
    if (config.suite === 'completion') {
      if (process.env.READNOVEL_QA_CONTEXT_PROBE==='1') await probeReaderContexts(tab);
      await verifyCompletion(tab);
      return;
    }
    if (config.suite === 'offline' || config.suite === 'manual-offline') {
      second = await connect(await (await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json());
      if (config.suite === 'offline') await verifyOffline(tab,second);
      else await verifyManualOffline(tab,second);
      return;
    }
    enterScenario('guest and TOC');
    await viewport(tab,1366,768);
    await navigate(tab,1);
    assert.equal(await tab.evaluate("Boolean(document.querySelector('[data-resume-candidate]'))"),false);
    await until(async () => (await readerState(tab))?.guest,'Guest chapter 1 bootstrap');
    // Reproduce the boundary between pageshow and the layout changes from Guest bootstrap.
    await tab.send('Fetch.enable',{patterns:[{urlPattern:config.origin+'/api/auth/me'}]});
    await clickChapter(tab,'#reader-next-chapter',3,'Native Next navigation');
    const guestProbe = () => tab.paused.find(r=>r.url===config.origin+'/api/auth/me' && r.method==='GET');
    await until(guestProbe,'Guest chapter 3 profile request intercepted');
    assert.equal((await readerState(tab)).guest,false,'Guest mode must still be pending');
    await tab.send('Fetch.continueRequest',{requestId:guestProbe().id});
    await tab.send('Fetch.disable');
    await until(() => tab.evaluate(`document.querySelector('${link}')?.pathname===${JSON.stringify(pathFor(1))} &&
      !document.querySelector('.reader-completion').hidden`),'Guest chapter 3 bootstrap and Resume link');
    await clickChapter(tab,'#reader-previous-chapter',1,'Native Previous navigation');
    await until(async () => (await readerState(tab))?.guest,'Guest after Previous');
    await tab.click('#reader-toc-open');
    const far = `#reader-toc a[href="${pathFor(9)}"]`;
    await tab.click(far,{reveal:true});
    await until(async () => (await readerState(tab))?.confirming,'Guest TOC asks before jumping to chapter 9');
    const beforeConfirm = await readerState(tab);
    assert.equal(beforeConfirm.chapter,'1');
    tab.expectChapter(9,'Guest TOC Confirm navigation',beforeConfirm);
    await tab.click('#reader-jump-continue');
    await waitForChapter(tab,9,'Guest TOC Confirm navigation',beforeConfirm);
    assert.ok(!tab.requests.some(r => r.path.startsWith('/api/progress')));
    await navigateBlank(tab);
    await cookie(tab,0);
    await navigate(tab,1);
    await awaitActivation(tab,0,200,'Initial authenticated activation');
    await until(() => tab.evaluate(`document.querySelector('${link}')?.pathname===${JSON.stringify(pathFor(3))}`),
      'Initial snapshot lost before Resume link was shown');
    const beforeToc=activations(tab).length;
    const overflowBefore = await tab.evaluate('document.documentElement.style.overflow');
    await tab.click('#reader-toc-open');
    await until(() => tab.evaluate(`Boolean(document.querySelector(${JSON.stringify(far)}))`),'TOC did not load');
    await tab.evaluate(`document.querySelector(${JSON.stringify(far)}).scrollIntoView({block:'nearest'})`);
    await tab.click(far);
    await tab.click('#reader-jump-cancel');
    await until(() => tab.evaluate("document.querySelector('#reader-jump-confirmation').hidden"),
      'Cancel returns TOC to the chapter list');
    await tab.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await tab.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await until(() => tab.evaluate(`!document.querySelector('#reader-toc').open &&
      document.documentElement.style.overflow===${JSON.stringify(overflowBefore)}`),
      'TOC close/scroll restoration');
    assert.equal(activations(tab).length,beforeToc);
    assert.ok(await tab.evaluate(`document.querySelector('#reader-next-chapter').pathname===${JSON.stringify(pathFor(3))}`));
    console.log('PASS Guest Next/Previous and TOC Confirm, authenticated activation and TOC Cancel.');
    enterScenario('Resume restoration and layout');
    await focusTab(tab);
    await tab.evaluate('window.scrollTo(0,0)');
    await until(() => tab.evaluate(`scrollY===0 && Boolean(document.querySelector('${link}'))`),
      'Initial Resume link visible');
    await clickChapter(tab,link,3,'Resume link did not navigate');
    await until(() => activations(tab).filter(r=>r.status===200).length===2,'Destination activation');
    assert.ok(Math.abs(await tab.evaluate(fractionScript())-.55)<.025, 'Cross-chapter restore fraction');
    await until(()=>tab.evaluate(`document.querySelector('${link}')?.pathname===${JSON.stringify(pathFor(3))}`),
      'Authenticated handoff points to its destination without a reverse link');
    const destination = await readerState(tab);
    await tab.click(link,{reveal:true});
    assert.equal((await readerState(tab)).history.id,destination.history.id);
    assert.ok(Math.abs(await tab.evaluate(fractionScript())-.55)<.025, 'Repeat click restores in the same chapter');
    assert.ok(await tab.evaluate(`document.querySelector('#reader-previous-chapter').pathname===${JSON.stringify(pathFor(1))}`));
    const beforeReload = await readerState(tab);
    await tab.send('Page.reload');
    await waitForChapter(tab,3,'Reload document completed pageshow',beforeReload);
    await until(() => activations(tab).filter(r=>r.status===200).length===3, 'Reload activation');
    await settleReaderLayout(tab);
    await tab.evaluate('window.scrollTo(0,0)');
    await until(() => tab.evaluate(`Boolean(document.querySelector('${link}')) && scrollY===0`),'Reload Resume link');
    await tab.evaluate(`(${traceReaderScroll})()`);
    await tab.click(link);
    assert.ok(Math.abs(await tab.evaluate(fractionScript())-.55)<.025, 'Same-chapter restore fraction');
    if (process.env.READNOVEL_QA_TOP_INTENT_PROBE==='1') {
      const before = await readResume();
      const start = scrolls(tab).length;
      await tab.evaluate(`window.addEventListener('keydown',event=>{
        if (event.key!=='Home' || !event.isTrusted) return;
        document.querySelector('.reader-chapter-header').style.paddingBottom='24px';
        window.qaReaderScroll.record('reflow during Home');
      },{once:true})`);
      await pressHome(tab);
      await until(()=>tab.evaluate('scrollY===0'),'Trusted Home scrolls to start during reflow');
      await settleReaderLayout(tab);
      assert.equal(await tab.evaluate('scrollY'),0);
      await until(()=>scrolls(tab).slice(start).some(request=>finished(request,200)),
        'Trusted Home position committed');
      assert.deepEqual((await inspectFixture('snapshot')).progress,[[3,before.revision+1,0,777]]);
      console.log('QA Resume Home probe',JSON.stringify(await tab.evaluate('window.qaReaderScroll.entries')));
      console.log('PASS guarded Home/reflow probe and PostgreSQL fraction 0.');
      return;
    }
    // Focus only reveals the Smart Header; the pointer drives the settings control.
    await tab.evaluate("document.querySelector('#reader-theme-trigger').focus({preventScroll:true})");
    await tab.click('#reader-theme-trigger');
    await until(() => tab.evaluate("document.querySelector('#reader-theme-selector').open"),'Reader settings did not open');
    await tab.click('label:has(input[value="Roboto"])');
    await tab.click('label:has(input[value="wide"])');
    await tab.click('#reader-theme-trigger');
    await viewport(tab,320,800);
    await focusTab(tab);
    const layoutProbe=process.env.READNOVEL_QA_REFLOW_AT_TOP;
    if (layoutProbe) await tab.evaluate(`(() => {
      const header=document.querySelector('.reader-chapter-header');
      window.qaTopReflow={applied:false,calls:[],headerBefore:header.offsetHeight};
      const scrollTo=window.scrollTo.bind(window);
      window.scrollTo=(options,y)=>{
        window.qaTopReflow.calls.push({top:typeof options==='object' ? options.top : y,
          before:scrollY,restore:new Error().stack.includes('at Object.restore')});
        return scrollTo(options,y);
      };
      function reflow() {
        header.style.paddingBottom='24px';
        window.qaTopReflow.applied=true;
        window.qaTopReflow.headerAfter=header.offsetHeight;
      }
      if (${JSON.stringify(layoutProbe)}==='before') reflow();
      else window.addEventListener('scroll',reflow,{once:true});
    })()`);
    await settleReaderLayout(tab);
    await until(async () => Math.abs(await tab.evaluate(fractionScript())-.55)<.025,
      'Font/width/viewport change lost the content-relative anchor');
    const beforeScroll = await readResume();
    const scrollStart = scrolls(tab).length;
    const scrollStartY = await tab.evaluate('scrollY');
    assert.ok(scrollStartY>0,'Explicit scroll to top starts at the restored reading position');
    await pressHome(tab);
    if (layoutProbe) {
      await until(()=>tab.evaluate('window.qaTopReflow.applied'),'Test reflow applied');
      await settleReaderLayout(tab);
      console.log('QA scroll/reflow',JSON.stringify(await tab.evaluate("({...window.qaTopReflow,finalY:scrollY})")));
    }
    await until(() => tab.evaluate('scrollY===0'), 'Reader did not scroll to start');
    await until(() => scrolls(tab).slice(scrollStart).some(r=>finished(r,200)), 'Tab A successful scroll');
    const afterScroll = await readResume();
    assert.equal(afterScroll.revision,beforeScroll.revision+1);
    assert.equal(afterScroll.position,0);
    assert.ok(await tab.evaluate(`['.reader-toolbar-home','#reader-toc-open','#reader-theme-trigger'].every(s=>{
      const r=document.querySelector(s).getBoundingClientRect(); return r.left>=0&&r.right<=innerWidth;
    })`));
    console.log('PASS cross-chapter and reload restore, font/width changes and responsive 320px.');
    enterScenario('stale tab CAS');
    second=await connect(await (await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json());
    await focusTab(second);
    await viewport(second,1366,768);
    await navigate(second,1);
    await awaitActivation(second,0,200,'Foreground tab B activation');
    const writerB = await readResume();
    assert.equal(writerB.chapter,1);
    assert.equal(writerB.revision,afterScroll.revision+1);
    await focusTab(tab);
    await tab.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const beforeStale = progressCalls(tab).length;
    // Place A at a known content position and wait for the actual scroll/layout.
    // Wheel targeting between two headless tabs depends on OS focus.
    await tab.evaluate(fractionScript('window.scrollTo(0,start+span*.65);'));
    await until(async () => Math.abs(await tab.evaluate(fractionScript())-.65)<.025,
      'Tab A did not reach the stale test position');
    await until(() => progressCalls(tab).slice(beforeStale).some(r=>r.method==='PUT' && finished(r,412)),
      'Stale tab PUT did not fail with 412');
    await focusTab(tab);
    try {
      await until(() => tab.evaluate(`Boolean(document.querySelector('${action}'))`),'Conflict action not shown');
    } catch (error) {
      console.error('Conflict diagnostics:', await tab.evaluate(`[document.visibilityState,
        document.querySelector('[data-reader-resume-status]')?.textContent,
        document.querySelector('[data-reader-resume-activate]')?.hidden]`),
      tab.requests.filter(r=>r.path.startsWith(config.progress)).map(r=>[r.method,r.status]),
      'script exceptions:', tab.exceptions.length);
      throw error;
    }
    assert.equal(activations(tab).length,3);
    assert.deepEqual(progressCalls(tab).slice(beforeStale).map(r=>[r.method,r.status]),
      [['PUT',412],['GET',200]]);
    assert.deepEqual(await readResume(),writerB);
    console.log('PASS stale PUT and reconcile GET: revision',writerB.revision,'unchanged.');
    assert.ok(await tab.evaluate("!document.querySelector('[data-reader-resume-draft]').hidden"),
      'Stale position remains available as a draft');
    await confirmClick(tab,'[data-reader-draft-discard]');
    await until(()=>tab.evaluate("document.querySelector('[data-reader-resume-draft]').hidden"),
      'User discarded the conflict before starting the clean Back regression');
    assert.deepEqual(await readResume(),writerB);
    const finalA = await verifyHistory(tab, second);
    assert.equal(finalA.revision,[...progressCalls(tab),...progressCalls(second)]
      .filter(r=>r.method!=='GET' && finished(r,200)).length);
    enterScenario('account switch');
    const writesBeforeSwitch = progressCalls(tab).filter(r=>r.method!=='GET').length;
    await cookie(second,1);
    await tab.evaluate(fractionScript('window.scrollTo(0,start+span*.24);'));
    await until(() => tab.evaluate(`!document.querySelector('${link}') && !document.querySelector('${action}')`),
      'Private Resume state persisted after account switch');
    await focusTab(second);
    await navigate(second,9);
    await awaitActivation(second,1,201,'New account activation');
    assert.equal(progressCalls(tab).filter(r=>r.method!=='GET').length,writesBeforeSwitch);
    const finalB = await readResume(1);
    assert.equal(finalB.chapter,9);
    assert.equal(finalB.revision,1);
    assert.equal(tab.exceptions.length+second.exceptions.length,0);
    assert.ok(![...tab.requests,...second.requests].some(r=>r.method==='PUT'&&r.path.includes('/completions')));
    console.log('PASS two real tabs, stale PUT 412 without rebase, account isolation and zero completion requests.');
    console.log('RESUME_QA_FINAL',JSON.stringify([finalA,finalB].map(({chapter,revision})=>[chapter,revision])));
  } catch (error) {
    reportFailure(error);
    await Promise.all([failureTrace(tab,'A'), second && failureTrace(second,'B')]);
  } finally {
    second?.close();
    tab.close();
  }
}

async function failureTrace(tab, name) {
  const state = await readerState(tab).catch(error=>({error:error.message}));
  const [previous,next] = await Promise.all(['previous','next'].map(direction=>
    tab.hitTest('#reader-'+direction+'-chapter').then(result=>
      ({...result, href:safeUrl(result.href)})).catch(error=>({error:error.message}))));
  console.error('Reader diagnostics '+name+':',JSON.stringify({
    state, previous, next, ...tab.diagnostics(), cacheMisses:tab.cacheMisses.slice(-3),
    paused:tab.paused.slice(-5).map(({url,method,networkId,attempt})=>({url,method,networkId,attempt})),
    resumeAttempts:tab.resumeAttempts.slice(-16),
    requests:safeTrace(tab),
  }));
  if (config.suite==='resume') {
    const scrollTrace = await tab.evaluate('window.qaReaderScroll?.entries ?? []').catch(()=>[]);
    if (scrollTrace.length) console.error('QA Resume scroll timeline:',JSON.stringify(scrollTrace));
  }
}

async function closeEdge() {
  if (!browserSocket) return;
  checkpoint('Browser.close requested');
  await shutdownBrowser(browserSocket,checkpoint);
  checkpoint('Browser.close transport finished');
}

function reportFailure(error) {
  const locations = error.stack?.match(/check_reader_resume_browser\.cjs:\d+:\d+/g) ?? [];
  const kind = error.failureKind || (error instanceof assert.AssertionError || error.expected ? 'assertion' : 'runner');
  console.error(`FAIL Browser QA ${caseLabel} ${kind} [${scenario}] ${locations.join(' <- ')}:`, error.message);
  if ('expected' in error || 'actual' in error) {
    console.error('Actual:',JSON.stringify(error.actual),'Expected:',JSON.stringify(error.expected));
  }
  if (error.evaluation) console.error('CDP evaluation:',JSON.stringify({
    ...error.evaluation,contextChanged:error.contextChanged,protocolMessage:error.protocolMessage,
    exceptionDetails:error.exceptionDetails,
  }));
  process.exitCode=1;
}

main().catch(reportFailure).finally(closeEdge).catch(error => {
  console.error(`FAIL Browser QA ${caseLabel} Edge shutdown:`,error.message);
  process.exitCode=1;
});
