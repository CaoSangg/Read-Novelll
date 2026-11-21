'use strict';

// Serialized by the runner into a disposable browser document.
function traceResumeRequests(origin, path, tab) {
  if (location.origin !== origin) return;
  const fetchOriginal = window.fetch;
  const suffix = 'readnovel.qa.document.'+tab;
  const documentNumber = Number(sessionStorage.getItem(suffix))+1;
  sessionStorage.setItem(suffix,String(documentNumber));
  let sequence = 0;
  const writers = new Map(), rows = new Map();
  let failureGate = null;
  window.qaResumeFailure = {
    hold() { failureGate = Promise.withResolvers(); },
    advance() {
      const previous = failureGate;
      failureGate = Promise.withResolvers();
      previous.resolve();
    },
    release() {
      failureGate.resolve();
      failureGate = null;
    },
  };
  const report = value => readnovelQaResume(JSON.stringify(value));
  const alias = (map, value) => {
    if (!map.has(value)) map.set(value,map.size+1);
    return map.get(value);
  };
  window.fetch = (url, options) => {
    if (options?.method !== 'PUT' || url !== path) return fetchOriginal(url,options);
    const id = tab+documentNumber+'-'+(++sequence);
    const data = JSON.parse(options.body);
    const headers = new Headers(options.headers);
    const etag = /^"([0-9a-f-]+):(\d+)"$/.exec(headers.get('If-Match'));
    const frame = new Error().stack;
    const source = options.keepalive ? (window.event?.type ?? 'keepalive') :
      frame.includes('reconcile') ? 'retry' : frame.includes('flush') ? 'debounce' : 'foreground';
    const dispatch = {id, phase:'dispatch', source, writer:alias(writers,data.writer_epoch),
      row:etag ? alias(rows,etag[1]) : null, precondition:etag ? Number(etag[2]) : null,
      fraction:data.scroll_position, keepalive:Boolean(options.keepalive)};
    if (options.keepalive) sessionStorage.setItem('readnovel.qa.keepaliveContext',JSON.stringify(dispatch));
    report(dispatch);
    headers.set('X-Reader-QA-Attempt',id);
    return fetchOriginal(url,{...options,headers}).then(response=>{
      report({id,phase:'response',status:response.status});
      return response;
    },async error=>{
      report({id,phase:'reject',timeout:options.signal?.aborted===true});
      if (failureGate) await failureGate.promise;
      throw error;
    });
  };
}

module.exports = {traceResumeRequests};
