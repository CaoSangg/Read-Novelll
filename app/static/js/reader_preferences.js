/* Shared, validated Reader preferences. Loaded synchronously before the Reader markup. */
(() => {
  'use strict';
  if (window.ReadNovelReaderPreferences) return;
  const storageKey = 'readnovel.reader.settings';
  const defaults = Object.freeze({theme:'sepia',fontFamily:'Lora',fontSize:19,lineHeight:1.85,readingWidth:'normal'});
  const limits = Object.freeze({min:15,max:28});
  const fonts = new Map([
    ['Lora', "'Lora', 'Merriweather', Georgia, serif"],
    ['Merriweather', "'Merriweather', Georgia, serif"],
    ['Roboto', "'Roboto', Georgia, serif"],
  ]);
  const widths = new Map([['normal','42rem'],['wide','48rem']]);
  const validators = {
    theme: value => ['sepia','light','dark'].includes(value),
    fontFamily: value => fonts.has(value),
    fontSize: value => Number.isInteger(value) && value>=limits.min && value<=limits.max,
    lineHeight: value => typeof value==='number' && [1.65,1.85,2.1].includes(value),
    readingWidth: value => widths.has(value),
  };
  const fields = Object.keys(defaults);
  function validate(value) {
    const result = {...defaults};
    if (!value || typeof value!=='object' || Array.isArray(value) || value.version!==1) return result;
    for (const field of fields) {
      if (Object.hasOwn(value,field) && validators[field](value[field])) result[field]=value[field];
    }
    return result;
  }
  function read() {
    try {
      const storage = window.localStorage;
      const raw = storage.getItem(storageKey);
      // Existing canonical data is authoritative, including an unsupported version or bad JSON.
      if (raw!==null) {
        try { return validate(JSON.parse(raw)); } catch { return {...defaults}; }
      }
      // Read-only compatibility with Next.js. Never modify/delete its keys or read progress/auth data.
      const size = storage.getItem('reader_fontSize');
      const height = storage.getItem('reader_lineHeight');
      return validate({version:1,
        theme:storage.getItem('reader_theme'),
        fontFamily:storage.getItem('reader_fontFamily'),
        fontSize:size!==null && /^\d+$/.test(size) ? Number(size) : null,
        lineHeight:['1.65','1.85','2.1'].includes(height) ? Number(height) : null,
        readingWidth:storage.getItem('reader_maxWidth'),
      });
    } catch { return null; } // Storage may be unavailable; in-page interaction must remain usable.
  }
  let state = read() || {...defaults};
  let root = null, writeFailed = false;
  const listeners = new Set();
  const snapshot = () => ({...state});
  function apply() {
    if (!root) return;
    root.dataset.readerTheme = state.theme;
    root.style.setProperty('--reader-font-family',fonts.get(state.fontFamily));
    root.style.setProperty('--reader-font-size',`${state.fontSize}px`);
    root.style.setProperty('--reader-line-height',String(state.lineHeight));
    root.style.setProperty('--reader-content-width',widths.get(state.readingWidth));
  }
  function notify() {
    apply();
    for (const listener of listeners) listener(snapshot());
  }
  function update(field,value) {
    if (!Object.hasOwn(validators,field) || !validators[field](value) || state[field]===value) return false;
    state = {...state,[field]:value};
    notify();
    try {
      window.localStorage.setItem(storageKey,JSON.stringify({version:1,...state}));
      writeFailed=false;
    } catch { writeFailed=true; }
    return true;
  }
  function adjustSize(delta) {
    if (![-1,1].includes(delta)) return false;
    return update('fontSize',Math.max(limits.min,Math.min(limits.max,state.fontSize+delta)));
  }
  function subscribe(listener) {
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
  }
  window.ReadNovelReaderPreferences = Object.freeze({snapshot,update,adjustSize,subscribe,limits});
  function attachRoot() {
    root = document.querySelector('.reader-page');
    if (!root) return false;
    apply();
    return true;
  }
  // Observe parser-created markup rather than hiding SSR or duplicating validation in inline JS.
  if (!attachRoot()) {
    const observer = new MutationObserver(() => { if (attachRoot()) observer.disconnect(); });
    observer.observe(document.documentElement,{childList:true,subtree:true});
    document.addEventListener('DOMContentLoaded',() => { observer.disconnect(); attachRoot(); },{once:true});
  }
  window.addEventListener('pageshow',event => {
    if (!event.persisted || writeFailed) return;
    const restored = read();
    if (!restored || fields.every(field=>restored[field]===state[field])) return;
    state=restored;
    notify();
  });
})();
