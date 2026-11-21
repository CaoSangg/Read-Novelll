'use strict';

function executionContextLost(message) {
  return /\b(?:execution context (?:was )?destroyed|cannot find (?:the |a )?context with (?:specified|given) id|cannot find context with unique id|uniqueContextId not found|inspected target navigated or closed)\b/i.test(message ?? '');
}

function exceptionDetails(details, safeUrl, safeText) {
  return {
    exceptionId:details.exceptionId,
    text:safeText(details.text),
    message:safeText(details.exception?.description?.split('\n',1)[0]),
    className:safeText(details.exception?.className),
    executionContextId:details.executionContextId,
    scriptId:details.scriptId,
    url:safeUrl(details.url),
    line:details.lineNumber,
    column:details.columnNumber,
    stack:details.stackTrace?.callFrames.slice(0,8).map(frame=>({
      function:safeText(frame.functionName), scriptId:frame.scriptId, url:safeUrl(frame.url),
      line:frame.lineNumber, column:frame.columnNumber,
    })),
  };
}

function readerDocumentAvailable(document) {
  return Boolean(document.documentElement && document.defaultView);
}

function traceReaderScroll() {
  const content = document.querySelector('.reader-content');
  const header = document.querySelector('.reader-chapter-header');
  if (!content || !header) return;
  const entries = [];
  function record(event, details = {}) {
    const rect = content.getBoundingClientRect();
    entries.push({event,at:Math.round(performance.now()),y:scrollY,top:rect.top+scrollY,
      height:rect.height,viewport:[innerWidth,innerHeight],visibility:document.visibilityState,
      fonts:document.fonts.status,restoration:history.scrollRestoration,...details});
    if (entries.length > 48) entries.shift();
  }
  const original = window.scrollTo;
  window.scrollTo = function (x,y) {
    const from = new Error().stack;
    record('scrollTo',{requested:typeof x==='object' ? x.top : y,
      source:/\brestore\b/.test(from) ? 'Resume.restore' : 'input'});
    return original.apply(this,arguments);
  };
  for (const event of ['scroll','resize','focus','blur','pageshow']) {
    window.addEventListener(event,()=>record(event),{passive:true});
  }
  window.addEventListener('keydown',event=>{
    if (event.key==='Home') record('Home',{trusted:event.isTrusted});
  });
  document.fonts.addEventListener('loadingdone',()=>record('fonts loaded'));
  const observer = new ResizeObserver(()=>record('ResizeObserver'));
  observer.observe(header);
  observer.observe(content);
  window.qaReaderScroll = {entries,record};
}

async function shutdownBrowser(socket, checkpoint, timeout = 3000) {
  if (socket.readyState !== WebSocket.OPEN) throw Error('Browser CDP socket closed before shutdown');
  const listeners = new AbortController();
  let deadline;
  let acknowledged = false;
  try {
    await new Promise((resolve,reject)=>{
      const options = {signal:listeners.signal};
      deadline = setTimeout(()=>{
        const stage = acknowledged ? 'after acknowledgement' : 'before acknowledgement';
        reject(Error('Browser.close WebSocket did not close '+stage));
      },timeout);
      socket.addEventListener('message',event=>{
        const reply = JSON.parse(event.data);
        if (reply.id !== 1) return;
        if (reply.error) reject(Error('Browser.close rejected ('+reply.error.code+')'));
        else {
          acknowledged = true;
          checkpoint('Browser.close acknowledged; closing client socket');
          socket.close();
        }
      },options);
      socket.addEventListener('close',event=>{
        checkpoint('Browser.close WebSocket closed ('+event.code+', acknowledged='+acknowledged+')');
        resolve();
      },options);
      socket.addEventListener('error',()=>{
        checkpoint('Browser.close WebSocket error; awaiting transport close');
      },options);
      socket.send(JSON.stringify({id:1,method:'Browser.close'}));
      checkpoint('Browser.close sent');
    });
  } finally {
    clearTimeout(deadline);
    listeners.abort();
    if (socket.readyState === WebSocket.OPEN) socket.close();
  }
}

module.exports = {executionContextLost, exceptionDetails, readerDocumentAvailable, traceReaderScroll, shutdownBrowser};
