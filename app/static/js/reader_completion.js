/* Explicit authenticated completion. Resume and its writer remain independent. */
(() => {
  'use strict';

  const scheme = 'sha256-utf8-raw-v1';
  const labels = Object.freeze({
    not_completed: 'Chưa đọc',
    completed: 'Đã đọc',
    old_revision: 'Đã đọc (bản cũ)',
  });
  const messages = {
    loading: 'Đang tải trạng thái đọc…',
    readError: 'Không tải được trạng thái đọc.',
    changed: 'Nội dung chương đã thay đổi. Hãy tải lại trang để xác nhận.',
    writeError: 'Chưa xác nhận được kết quả lưu.',
    csrf: 'Không thể lưu. Hãy tải lại trang.',
    pending: 'Xác nhận đã lưu trên thiết bị, chưa đồng bộ.',
    pendingOld: 'Xác nhận đang chờ thuộc bản cũ. Hãy xác nhận lại bản hiện tại.',
    storage: 'Không thể lưu xác nhận trên thiết bị.',
  };
  const uuid = value => typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const validRevision = value => value?.scheme === scheme &&
    typeof value.hash === 'string' && /^[0-9a-f]{64}$/.test(value.hash);
  const sameRevision = (a, b) => validRevision(a) && a.hash === b.hash && a.scheme === b.scheme;
  const statusUrl = (base, ids) => base + '?' + ids.map(id => 'chapter_ids=' + id).join('&');

  function parseStatuses(data, ids) {
    if (!Array.isArray(data?.items) || data.items.length !== ids.length) return null;
    const remaining = new Set(ids);
    const statuses = new Map();
    for (const item of data.items) {
      if (!remaining.delete(item?.chapter_id) || !Object.hasOwn(labels, item.status) ||
          !validRevision(item.content_revision)) return null;
      statuses.set(item.chapter_id, item);
    }
    return statuses;
  }

  function createController({chapter, readCsrf, csrfHeader, request, view, sessionHint,
                            offline, isCurrent = () => true, onUnauthorized = () => {}}) {
    const base = '/api/progress/novels/' + chapter.novelId + '/completions';
    const initialCsrf = sessionHint ? readCsrf() : null;
    let active = false, retired = !sessionHint, reader = {kind:'loading'};
    let revisionChanged = false;
    let readerRequest = null, page = null, mutation = null;
    let draft = null, storageError = false;
    const online = () => offline?.online() ?? true;
    const canSync = () => online() && (offline?.canWrite?.() ?? true);

    function readDraft() {
      if (!offline) return;
      const found = offline.store.read('completion',chapter.id);
      storageError = found.kind === 'error';
      if (found.kind === 'ready') draft = found;
      else if (draft?.raw) draft = null;
    }

    function saveDraft(state) {
      if (!offline) return null;
      const intent = {chapter_id:chapter.id,content_revision:chapter.revision,state};
      const saved = offline.store.save('completion',chapter.id,intent,draft?.raw);
      storageError = saved.kind !== 'ready';
      if (!storageError) draft = saved;
      else if (!draft?.raw) draft = {value:intent};
      return draft;
    }

    function clearDraft(entry) {
      if (!entry) return;
      const removed = !entry.raw || offline.store.remove(entry);
      if (removed && draft === entry) draft = null;
      if (!removed) storageError = true;
    }

    function stopReads(clearToc = true) {
      readerRequest?.abort();
      readerRequest = null;
      if (page) {
        page.request?.abort();
        page.request = null;
        if (clearToc) {
          page.statuses = new Map();
          view.toc(page.rows, page.statuses);
        }
      }
    }

    function retire(reason = '') {
      retired = true;
      stopReads();
      view.reader(active && reason ? {message:reason} : null);
    }

    function sessionCurrent() {
      if (retired) return false;
      if (isCurrent() && readCsrf() === initialCsrf) return true;
      retire();
      return false;
    }

    function paint() {
      if (!active || !sessionCurrent()) return;
      const savedLabel = reader.kind === 'known'
        ? labels[reader.status] + (reader.error ? ' · ' + reader.error : '')
        : messages[reader.kind];
      const same = draft && sameRevision(draft.value.content_revision,chapter.revision);
      const pendingOld = draft && (!same || revisionChanged || draft.value.state === 'conflict');
      const hint = draft && (pendingOld ? messages.pendingOld : draft.raw ? messages.pending :
        'Xác nhận chưa đồng bộ.');
      const message = [savedLabel, hint, storageError && messages.storage].filter(Boolean).join(' · ');
      const queued = same && !pendingOld && !!draft.raw;
      const canConfirm = !!initialCsrf && !revisionChanged && (canSync() || !queued) && (
        (reader.kind === 'known' && reader.status !== 'completed') ||
        (reader.kind === 'readError' && offline && (!canSync() || queued))
      );
      view.reader({message, saving:!!mutation,
        canConfirm:canConfirm && !mutation, retry:reader.kind === 'readError' && canSync() && !canConfirm && !mutation,
        draft:!!draft && !mutation,
        actionLabel:canConfirm && canSync() && draft ? (pendingOld ? 'Xác nhận bản này' : 'Đồng bộ xác nhận') : null});
    }

    async function send(url, options) {
      try {
        const response = await request(url, {credentials:'same-origin', cache:'no-store',
          redirect:'error', ...options});
        return {ok:response.ok, status:response.status,
          data:response.ok ? await response.json() : null};
      } catch {
        return {ok:false, status:0, data:null};
      }
    }

    function authFailure(result) {
      if (result.status !== 401 && result.status !== 403) return false;
      retire(result.status === 403 ? messages.csrf : '');
      if (result.status === 401) onUnauthorized();
      return true;
    }

    async function refreshReader() {
      if (!active || !sessionCurrent() || !canSync() || readerRequest || mutation) return;
      const selected = new AbortController();
      readerRequest = selected;
      reader = {kind:'loading'};
      paint();
      const result = await send(statusUrl(base, [chapter.id]), {signal:selected.signal});
      if (readerRequest !== selected || !sessionCurrent()) return;
      readerRequest = null;
      if (authFailure(result)) return;
      const item = result.ok && parseStatuses(result.data, [chapter.id])?.get(chapter.id);
      if (item && !sameRevision(item.content_revision, chapter.revision)) revisionChanged = true;
      if (item?.status === 'completed' && sameRevision(draft?.value.content_revision,item.content_revision)) {
        clearDraft(draft);
      }
      reader = revisionChanged ? {kind:'changed'} : !item ? {kind:'readError'} :
        {kind:'known', status:item.status, error:initialCsrf ? '' : messages.csrf};
      paint();
    }

    async function refreshToc(target) {
      if (!active || !target?.ids.length || !sessionCurrent() || !canSync()) return;
      target.request?.abort();
      const selected = new AbortController();
      target.request = selected;
      const result = await send(statusUrl(base, target.ids), {signal:selected.signal});
      if (page !== target || target.request !== selected || !sessionCurrent()) return;
      target.request = null;
      if (authFailure(result)) return;
      const statuses = result.ok && parseStatuses(result.data, target.ids);
      if (!statuses) return;
      target.statuses = statuses;
      view.toc(target.rows, statuses);
      const visibleChapter = statuses.get(chapter.id);
      if (visibleChapter && !sameRevision(visibleChapter.content_revision, chapter.revision)) {
        revisionChanged = true;
        reader = {kind:'changed'};
        paint();
      }
    }

    function setTocPage(rows) {
      page?.request?.abort();
      if (page) view.toc(page.rows, new Map());
      page = null;
      if (!rows.length || rows.length > 50 || !sessionCurrent()) return;
      const ids = rows.map(({id}) => id);
      if (!ids.every(uuid) || new Set(ids).size !== ids.length) return;
      page = {rows, ids, statuses:new Map(), request:null};
      return refreshToc(page);
    }

    async function action() {
      if (!active || !sessionCurrent() || mutation) return;
      readDraft();
      const same = draft && sameRevision(draft.value.content_revision,chapter.revision) &&
        draft.value.state !== 'conflict';
      if (reader.kind === 'readError' && (!offline || (canSync() && !same))) return refreshReader();
      if (!initialCsrf || revisionChanged ||
          !['known','readError'].includes(reader.kind) || reader.status === 'completed') return;
      if (!canSync()) {
        if (!same || !draft.raw) saveDraft('dirty');
        paint();
        return;
      }
      const selected = reader;
      let submitted = null;
      mutation = (async () => {
        if (offline && draft) {
          const verified = await send('/api/auth/me');
          if (!sessionCurrent() || authFailure(verified)) return null;
          const owner = verified.data?.id;
          if (verified.ok && uuid(owner) && owner !== offline.owner) {
            retire();
            onUnauthorized();
          }
          if (owner !== offline.owner || !active || !canSync()) return null;
          // Discard or a different explicit claim in another document cancels this intent.
          if (draft.raw && offline.store.read('completion',chapter.id).raw !== draft.raw) {
            readDraft();
            return null;
          }
        }
        submitted = saveDraft('uncertain');
        return send(base + '/' + chapter.id, {
          method:'PUT',
          headers:{'Content-Type':'application/json', [csrfHeader]:initialCsrf},
          body:JSON.stringify({confirmation:true, content_revision:chapter.revision}),
        });
      })();
      paint();
      const result = await mutation;
      mutation = null;
      if (!result) { paint(); return; }
      const saved = result.ok && result.data?.chapter_id === chapter.id &&
        sameRevision(result.data.content_revision, chapter.revision);
      if (saved && sameRevision(submitted?.value.content_revision, chapter.revision)) clearDraft(submitted);
      if (!sessionCurrent() || authFailure(result)) return;
      if (saved) {
        reader = revisionChanged ? {kind:'changed'} : {kind:'known', status:'completed'};
        if (active && page?.ids.includes(chapter.id)) {
          // An older in-flight batch may have read before this commit.
          const pending = !!page.request;
          const previous = page.statuses.get(chapter.id);
          page.statuses.set(chapter.id, {
            status:!previous || sameRevision(previous.content_revision, chapter.revision)
              ? 'completed' : 'old_revision',
            content_revision:previous?.content_revision ?? chapter.revision,
          });
          view.toc(page.rows, page.statuses);
          if (pending) void refreshToc(page);
        }
      } else if (result.status === 409 || result.status === 404) {
        saveDraft('conflict');
        revisionChanged = true;
        reader = {kind:'changed'};
      } else {
        reader = revisionChanged ? {kind:'changed'} :
          {...selected, error:messages.writeError};
      }
      paint();
    }

    async function resume(verified = false) {
      if (!sessionCurrent()) return;
      const wasActive = active;
      active = true;
      if (!wasActive) readDraft();
      if (!canSync()) {
        disconnected();
      } else if (!wasActive || (offline && verified && (draft || reader.kind === 'readError'))) {
        await Promise.all([refreshReader(), refreshToc(page)]);
      } else {
        paint();
      }
    }

    function suspend() {
      active = false;
      stopReads();
      view.reader(null);
    }

    function disconnected() {
      if (!active || !sessionCurrent()) return;
      stopReads(false);
      if (reader.kind === 'loading') reader = {kind:'readError'};
      paint();
    }

    function discard() {
      if (!offline || !active || !sessionCurrent() || mutation) return;
      if (draft && offline.confirmDiscard() && active && sessionCurrent()) {
        clearDraft(draft);
        paint();
      }
    }

    function storageChanged() {
      if (!active || mutation || !sessionCurrent()) return;
      readDraft();
      paint();
    }

    return {resume, suspend, setTocPage, action, discard, disconnected, storageChanged,
      checkAccount:sessionCurrent};
  }

  function createView(panel) {
    const output = panel.querySelector('[data-reader-completion-status]');
    const button = panel.querySelector('[data-reader-completion-action]');
    const discard = panel.querySelector('[data-reader-completion-discard]');
    return {
      button, discard,
      reader(state) {
        panel.hidden = !state;
        const message = state?.message ? 'Trạng thái: ' + state.message : '';
        if (output.textContent !== message) output.textContent = message;
        button.setAttribute('aria-disabled', String(!(state?.canConfirm || state?.retry)));
        button.textContent = state?.retry ? 'Thử lại' : state?.saving ? 'Đang lưu…' : state?.actionLabel || 'Đã đọc xong';
        discard.hidden = !state?.draft;
      },
      toc(rows, statuses) {
        for (const {id, number} of rows) {
          const item = statuses.get(id);
          let badge = number.querySelector('.reader-toc-completion');
          if (!item) { badge?.remove(); continue; }
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'reader-toc-completion';
            number.append(badge);
          }
          badge.textContent = ' · ' + (item.label || labels[item.status]);
        }
      },
    };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = {createController, parseStatuses, createView};
  } else window.ReaderCompletion = {createController, createView};
})();
