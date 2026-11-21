/* Device-only progress for a single novel. */
(() => {
  'use strict';

  const scheme = 'sha256-utf8-raw-v1';
  const maxSize = 1024 * 1024;
  const storageMessage = 'Chưa lưu được tiến độ trên thiết bị.';
  const uuid = value => typeof value === 'string' && value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const validFraction = value => Number.isFinite(value) && value >= 0 && value <= 1;
  const validRevision = value => keys(value, ['scheme', 'hash']) && value.scheme === scheme &&
    typeof value.hash === 'string' && value.hash.length === 64 && /^[0-9a-f]{64}$/.test(value.hash);
  const sameRevision = (a, b) => validRevision(a) && validRevision(b) && a.hash === b.hash;
  const validGeneration = value => value === null ||
    (typeof value === 'string' && value.length === 32 && /^[0-9a-f]{32}$/.test(value));
  const plain = value => !!value && Object.getPrototypeOf(value) === Object.prototype;
  const keys = (value, names) => plain(value) && Object.keys(value).length === names.length &&
    names.every(name => Object.hasOwn(value, name));
  const validResume = value => keys(value, ['chapter_id', 'scroll_position', 'content_revision']) &&
    uuid(value.chapter_id) && validFraction(value.scroll_position) && validRevision(value.content_revision);
  const sameResume = (a, b) => a === b || Boolean(a && b && a.chapter_id === b.chapter_id &&
    a.scroll_position === b.scroll_position && sameRevision(a.content_revision, b.content_revision));
  const validTimestamp = value => typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

  function validRecord(value, novelId) {
    return keys(value, ['version', 'novel_id', 'generation', 'resume', 'completions']) &&
      value.version === 1 && value.novel_id === novelId && validGeneration(value.generation) &&
      (value.resume === null || validResume(value.resume)) && plain(value.completions) &&
      Object.entries(value.completions).every(([id, completion]) => uuid(id) &&
        keys(completion, ['content_revision', 'confirmed_at']) &&
        validRevision(completion.content_revision) && validTimestamp(completion.confirmed_at));
  }

  function createStore(novelId, storage, generationId) {
    const key = 'readnovel.progress.guest.v1.' + novelId;
    const clearKey = key + '.cleared';
    const empty = generation => ({version:1, novel_id:novelId, generation, resume:null, completions:{}});
    const failed = {kind:'error'};

    function read() {
      if (!uuid(novelId)) return failed;
      try {
        const backend = storage();
        const generation = backend.getItem(clearKey);
        const raw = backend.getItem(key);
        if (!validGeneration(generation) || (raw !== null && raw.length > maxSize)) return failed;
        if (raw === null) return {kind:'ready', record:empty(generation), raw};
        const record = JSON.parse(raw);
        if (!validRecord(record, novelId)) return failed;
        return {kind:'ready', record:record.generation === generation ? record : empty(generation), raw};
      } catch { return failed; }
    }

    function write(expected, {resume, completion}) {
      const state = read();
      if (state.kind !== 'ready' || expected.kind !== 'ready') return failed;
      const {record} = state;
      if (record.generation !== expected.record.generation) return {...state, kind:'changed'};
      if (resume && !sameResume(expected.record.resume, record.resume)) return {...state, kind:'changed'};
      const next = {...record};
      if (resume && !sameResume(resume, record.resume)) next.resume = resume;
      if (completion && !sameRevision(record.completions[completion.id]?.content_revision, completion.revision)) {
        next.completions = {...record.completions, [completion.id]:{
          content_revision:completion.revision, confirmed_at:completion.confirmedAt,
        }};
      }
      if (next.resume === record.resume && next.completions === record.completions) return state;
      if (!validRecord(next, novelId)) return failed;
      const raw = JSON.stringify(next);
      if (raw.length > maxSize) return failed;
      try {
        storage().setItem(key, raw);
        return {kind:'ready', record:next, raw};
      } catch { return failed; }
    }

    function clear() {
      if (!uuid(novelId)) return failed;
      try {
        const backend = storage();
        const raw = backend.getItem(key);
        const generation = generationId();
        if (!generation || !validGeneration(generation) || generation === backend.getItem(clearKey)) return failed;
        // Keep the generation in a second slot so a racing old write stays invalid.
        backend.setItem(clearKey, generation);
        if (backend.getItem(key) === raw && raw !== null) backend.removeItem(key);
        return read();
      } catch { return failed; }
    }

    return {read, write, clear, includes:changedKey => changedKey === null || changedKey === key || changedKey === clearKey};
  }

  function createGuestController({chapter, store, view, clock, isCurrent, lookup}) {
    let observed = null, target = null, selected = null, timer = null, pending = null;
    let storageError = false, message = '', running = false;

    function paint() {
      if (!running || !isCurrent() || !view.foreground()) return;
      const record = observed?.record;
      view.paint({
        target,
        status: storageError || observed?.kind === 'error' ? storageMessage : message,
        guest:true,
        canClear:observed?.kind === 'error' || !!record?.resume ||
          Object.keys(record?.completions || {}).length > 0,
      });
      view.completions(record?.completions ?? null, storageError);
    }

    function resolveTarget(resume) {
      selected = resume;
      const previousUrl = resume && target?.chapter_id === resume.chapter_id ? target.url : null;
      target = null;
      message = '';
      if (!resume) return;
      const url = resume.chapter_id === chapter.id ? chapter.url : previousUrl;
      if (url) {
        target = {...resume, url};
        return;
      }
      void lookup(resume.chapter_id).then(result => {
        if (!running || !isCurrent() || selected !== resume) return;
        if (result.kind === 'ready') target = {...resume, url:result.chapter.url};
        else message = result.kind === 'missing' ? 'Chương đã lưu hiện không thể mở.' :
          'Chưa kiểm tra được chương đã lưu.';
        paint();
      });
    }

    function cancel() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      pending = null;
    }

    function sync() {
      if (!running || !isCurrent()) return;
      const latest = store.read();
      if (latest.kind === 'error' || observed?.kind !== 'ready' ||
          latest.record.generation !== observed.record.generation ||
          !sameResume(latest.record.resume, observed.record.resume)) {
        cancel();
        resolveTarget(latest.record?.resume);
      }
      observed = latest;
      paint();
    }

    function apply(result) {
      storageError = result.kind === 'error';
      if (result.kind === 'ready') observed = result;
      if (result.kind === 'changed') sync();
      else paint();
    }

    function flush() {
      const position = pending;
      cancel();
      if (!running || !isCurrent() || !validFraction(position) || observed?.kind !== 'ready') return;
      const result = store.write(observed, {resume:{
        chapter_id:chapter.id, content_revision:chapter.revision, scroll_position:position,
      }});
      apply(result);
      return result.kind === 'ready';
    }

    function note(position) {
      if (!running || !isCurrent() || !view.foreground() || !validFraction(position) ||
          observed?.kind !== 'ready') return;
      if (pending === position) return;
      const saved = observed.record.resume;
      if (saved?.chapter_id === chapter.id && saved.scroll_position === position &&
          sameRevision(saved.content_revision, chapter.revision)) {
        cancel();
        return;
      }
      pending = position;
      if (timer === null) timer = clock.setTimeout(flush, 5000);
    }

    function restore(resume) {
      const matches = sameRevision(resume.content_revision, chapter.revision);
      if (!matches) message = 'Vị trí cũ không còn khớp với nội dung chương.';
      return view.restore(matches ? resume.scroll_position : 0);
    }

    function start(auto, allowHandoff = true) {
      running = true;
      observed = store.read();
      resolveTarget(observed.record?.resume);
      const incoming = allowHandoff ? view.takeHandoff('guest') : null;
      if (incoming && observed.kind === 'ready' && incoming.generation === observed.record.generation) {
        pending = restore(incoming);
        if (flush()) {
          selected = observed.record.resume;
          target = {...selected, url:chapter.url};
        }
      } else if (auto && observed.kind === 'ready') {
        const previous = observed.record.resume;
        // Reopening the chapter preserves its saved fraction and revision until the reader acts.
        if (previous?.chapter_id !== chapter.id) {
          pending = view.position();
          flush();
        }
      }
      paint();
    }

    function follow() {
      if (!running || !isCurrent() || !target || observed?.kind !== 'ready') return false;
      const latest = store.read();
      if (latest.kind !== 'ready' || latest.record.generation !== observed.record.generation ||
          !sameResume(latest.record.resume, observed.record.resume)) {
        sync();
        return false;
      }
      if (target.chapter_id !== chapter.id) {
        view.rememberHandoff('guest', {...target, generation:observed.record.generation});
        return true;
      }
      note(restore(target));
      paint();
      return false;
    }

    function complete() {
      if (!running || !isCurrent() || !view.foreground() || observed?.kind !== 'ready') return;
      apply(store.write(observed, {completion:{
        id:chapter.id, revision:chapter.revision, confirmedAt:new Date().toISOString(),
      }}));
    }

    function clear() {
      if (!running || !isCurrent() || !view.foreground()) return;
      cancel();
      const result = store.clear();
      if (result.kind === 'ready') {
        resolveTarget(result.record.resume);
        message = 'Đã xóa tiến độ của truyện trên thiết bị.';
      }
      apply(result);
    }

    function stop() {
      running = false;
      cancel();
      target = null;
      selected = null;
    }

    return {start, sync, note, flush, stop, follow, complete, clear};
  }

  const api = {createStore, createGuestController, sameRevision};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.ReaderGuestProgress = api;
})();
