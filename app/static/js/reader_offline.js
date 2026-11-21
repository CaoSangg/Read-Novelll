/* Drafts contain reading intent. Session and writer authority stay in memory. */
(() => {
  'use strict';
  const scheme = 'sha256-utf8-raw-v1';
  const idPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const idRegex = new RegExp('^' + idPattern + '$');
  const tagRegex = new RegExp('^"(' + idPattern + '):(0|[1-9][0-9]{0,18})"$');
  const uuid = value => typeof value === 'string' && value.length === 36 && idRegex.test(value);
  const fraction = value => Number.isFinite(value) && value >= 0 && value <= 1;
  const exact = (value, fields) => !!value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value,field));
  const revision = value => exact(value,['scheme','hash']) && value.scheme === scheme &&
    typeof value.hash === 'string' && value.hash.length === 64 && /^[a-f0-9]{64}$/.test(value.hash);
  const matches = (a,b) => revision(a) && revision(b) && a.hash === b.hash;
  const tag = value => typeof value === 'string' ? tagRegex.exec(value) : null;
  const states = ['dirty','uncertain','conflict'];

  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('');
    return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
  }

  function observedWrite(intent, etag, target) {
    const before = tag(intent?.attempt?.etag), after = tag(etag);
    // The API's row UUID and monotonic revision prove the position at the next version.
    // GET has no operation identity or writer epoch, so this never grants a writer.
    const next = intent?.attempt?.etag === null ? after?.[2] === '1' :
      before && after && before[1] === after[1] && BigInt(before[2]) + 1n === BigInt(after[2]);
    return Boolean(next && intent.attempt.position === intent.scroll_position &&
      target?.chapter_id === intent.chapter_id && target.scroll_position === intent.scroll_position &&
      matches(target.content_revision,intent.content_revision));
  }

  function createStore(owner, novel, storage) {
    const prefix = 'readnovel.progress.auth.v1.' + owner + '.' + novel + '.';
    const maxRecord = 2048;
    const error = {kind:'error'};
    const keyFor = (kind,id) => prefix + kind + '.' + id;
    function valid(entry,kind,id) {
      const common = ['version','owner_id','novel_id','id','kind','chapter_id','content_revision','state'];
      const fields = kind === 'resume' ? [...common,'scroll_position','attempt'] : common;
      if (!exact(entry,fields) || entry.version !== 1 || entry.owner_id !== owner ||
          entry.novel_id !== novel || entry.kind !== kind || entry.id !== id ||
          !uuid(entry.chapter_id) || !revision(entry.content_revision) || !states.includes(entry.state)) return false;
      if (kind === 'completion') return entry.chapter_id === id;
      return fraction(entry.scroll_position) && (entry.attempt === null ||
        (exact(entry.attempt,['etag','position']) && fraction(entry.attempt.position) &&
          (entry.attempt.etag === null || tag(entry.attempt.etag))));
    }
    function read(kind,id) {
      if (![owner,novel,id].every(uuid) || !['resume','completion'].includes(kind)) return error;
      try {
        const raw = storage().getItem(keyFor(kind,id));
        if (raw === null) return {kind:'empty', raw:null};
        if (raw.length > maxRecord) return error;
        const value = JSON.parse(raw);
        return valid(value,kind,id) ? {kind:'ready',raw,value} : error;
      } catch { return error; }
    }
    function save(kind,id,intent,expected = null) {
      const current = read(kind,id);
      if (current.kind === 'error' || current.raw !== expected) return error;
      const value = {...intent, version:1, owner_id:owner, novel_id:novel, kind, id};
      if (!valid(value,kind,id)) return error;
      const raw = JSON.stringify(value);
      if (raw.length > maxRecord) return error;
      try {
        if (raw !== expected) storage().setItem(keyFor(kind,id),raw);
        return {kind:'ready',raw,value};
      } catch { return error; }
    }
    function remove(entry) {
      if (entry?.kind !== 'ready') return false;
      const {kind,id} = entry.value;
      if (read(kind,id).raw !== entry.raw) return false;
      try {
        storage().removeItem(keyFor(kind,id));
        return true;
      } catch { return false; }
    }
    function resumes() {
      const entries = [];
      let failed = false;
      try {
        const backend = storage();
        const resumePrefix = prefix + 'resume.';
        for (let i = 0; i < backend.length; i++) {
          const key = backend.key(i);
          if (!key?.startsWith(resumePrefix)) continue;
          const entry = read('resume',key.slice(resumePrefix.length));
          if (entry.kind === 'ready') entries.push(entry);
          else if (entry.kind === 'error') failed = true;
        }
      } catch { failed = true; }
      // A stable presentation order only. No position or timestamp wins automatically.
      entries.sort((a,b)=>a.value.id.localeCompare(b.value.id));
      return {entries,failed};
    }
    return {read,save,remove,resumes,includes:key=>key === null || key.startsWith(prefix)};
  }
  const api = {createStore,observedWrite,newId};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.ReaderOffline = api;
})();
