/* Authenticated Resume. One controller per document; the epoch stays in memory. */
(() => {
  'use strict';

  const scheme = 'sha256-utf8-raw-v1';
  const handoffKey = 'readnovel.reader.resume-handoff.v1';
  const messages = {
    conflict: 'Vị trí đã lưu có thể đã đổi ở tab khác.',
    content: 'Nội dung chương đã đổi. Hãy tải lại trang để lưu vị trí.',
    unavailable: 'Chưa lưu được vị trí đọc.',
    network: 'Mất kết nối. Chưa xác nhận được vị trí đã lưu.',
    authUnavailable: 'Không kiểm tra được phiên. Hãy tải lại trang.',
    csrf: 'Không thể lưu vị trí. Hãy tải lại trang.',
    oldPosition: 'Vị trí cũ không còn khớp với nội dung chương.',
    offline: 'Không có kết nối.',
    dirty: 'Vị trí đọc chưa đồng bộ.',
    savedDraft: 'Bản nháp đã lưu trên thiết bị, chưa đồng bộ.',
    syncing: 'Đang đồng bộ vị trí…',
    synced: 'Đã đồng bộ vị trí.',
    storage: 'Không thể lưu bản nháp trên thiết bị.',
  };

  const validFraction = value => Number.isFinite(value) && value >= 0 && value <= 1;
  const uuid = value => typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const validRevision = value => value?.scheme === scheme &&
    typeof value.hash === 'string' && /^[0-9a-f]{64}$/.test(value.hash);
  const matchesRevision = (stored, current) =>
    validRevision(stored) && stored.hash === current.hash && stored.scheme === current.scheme;

  function createAccountMenu(menu) {
    const doc = menu.ownerDocument;
    const trigger = menu.querySelector('summary');
    const guest = menu.querySelector('[data-reader-account-guest]');
    const auth = menu.querySelector('[data-reader-account]');
    const unknown = menu.querySelector('[data-reader-account-unknown]');
    const name = menu.querySelector('[data-reader-account-name]');
    function close(restoreFocus) {
      menu.open = false;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus({preventScroll:true});
    }
    menu.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(menu.open)));
    menu.addEventListener('keydown', event => {
      if (menu.open && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    });
    menu.addEventListener('focusout', event => {
      if (menu.open && event.relatedTarget && !menu.contains(event.relatedTarget)) close(false);
    });
    doc.addEventListener('pointerdown', event => {
      if (menu.open && !menu.contains(event.target)) close(menu.contains(doc.activeElement));
    });
    doc.defaultView.addEventListener('pagehide', () => close(menu.contains(doc.activeElement)));
    menu.hidden = false;
    return {
      show(owner, username = '') {
        const isGuest = owner === null, isAuth = typeof owner === 'string';
        if (doc.visibilityState === 'visible' &&
            ((!isGuest && guest.contains(doc.activeElement)) || (!isAuth && auth.contains(doc.activeElement)))) {
          trigger.focus({preventScroll:true});
        }
        guest.hidden = !isGuest;
        auth.hidden = !isAuth;
        unknown.hidden = isGuest || isAuth;
        name.textContent = isAuth ? username || 'Đã đăng nhập' : '';
      },
    };
  }

  async function requestLogout(request, csrfHeader, csrf) {
    if (!csrf) return 0;
    try {
      const response = await request('/api/auth/logout', {
        method:'POST', cache:'no-store', credentials:'same-origin', redirect:'error',
        headers:{[csrfHeader]:csrf}, signal:AbortSignal.timeout(8000),
      });
      return response.status;
    } catch { return 0; }
  }

  function contentRange({top, height, viewport, inset}) {
    if (![top, height, viewport, inset].every(Number.isFinite) ||
        height < 0 || inset < 0 || viewport <= inset) return null;
    const start = Math.max(0, top - inset);
    const end = Math.max(start, top + height - viewport);
    return {start, span: end - start};
  }

  function contentFraction(range, y) {
    if (!range || !Number.isFinite(y)) return null;
    if (range.span === 0) return 0;
    return Math.round(Math.min(1, Math.max(0, (y - range.start) / range.span)) * 10000) / 10000;
  }

  function resumeSnapshot(resume) {
    if (!resume?.available || !uuid(resume.chapter_id) || !validFraction(resume.scroll_position) ||
        typeof resume.url !== 'string') return null;
    const path = /^\/novel\/((?:[\w-]|%[0-9a-fA-F]{2})+)\/[1-9]\d*$/.exec(resume.url);
    if (!path) return null;
    try {
      if (!/^[\p{L}\p{N}_-]+$/u.test(decodeURIComponent(path[1]))) return null;
    } catch { return null; }
    return {
      chapter_id: resume.chapter_id, url: resume.url, scroll_position: resume.scroll_position,
      content_revision: validRevision(resume.content_revision) ? resume.content_revision : null,
    };
  }

  function createController({chapter, csrfHeader, readCsrf, request, view, clock, sessionHint,
                            verifiedOwner, offline, isCurrent = () => true, onUnauthorized = () => {}}) {
    const base = '/api/progress/novels/' + chapter.novelId;
    const pageCsrf = sessionHint ? readCsrf() : null;
    let account = null;
    let state = null;
    let retired = false;
    let timer = null;
    let storageTimer = null;
    const online = () => offline?.online() ?? true;
    const retryLimit = 2;

    function cancelTimer() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    }

    function retire() {
      cancelTimer();
      finishLocal(state);
      state = null;
      retired = true;
      view.clearHandoff();
      view.paint(null);
    }

    function unauthorized() {
      retire();
      onUnauthorized();
    }

    function current(run) {
      if (retired || state !== run || !run) return false;
      if (isCurrent() && readCsrf() === pageCsrf) return true;
      retire();
      return false;
    }

    function paint(run) {
      if (!current(run)) return;
      const draft = selectedDraft(run);
      const status = [draft && !draftUsable(run,draft) ? messages.content : run.status,
        run.storageError ? messages.storage :
        draft && !run.busy && run.status !== messages.savedDraft ? messages.savedDraft : '']
        .filter(Boolean).join(' ');
      view.paint(view.foreground() && account ? {
        target: run.target, status, canActivate: run.allowActivate && !run.busy,
        draft:draft ? {
          position:draft.value.scroll_position, sameChapter:draft.value.chapter_id === chapter.id,
          canApply:!run.busy && !run.epoch && online() && !!pageCsrf && draftUsable(run,draft),
          canDiscard:!run.busy,
        } : null,
      } : null);
    }

    async function send(path, options) {
      try {
        const response = await request(path, {cache: 'no-store', credentials: 'same-origin',
          redirect:'error', ...(offline && !options?.keepalive ? {signal:AbortSignal.timeout(8000)} : {}),
          ...options});
        const data = await response.json().catch(() => null);
        return {ok: response.ok, status: response.status, data};
      } catch {
        return {ok: false, status: 0, data: null};
      }
    }

    async function readProgress(run) {
      const result = await send(base);
      if (!current(run)) return false;
      if (result.status === 401) {
        unauthorized();
        return false;
      }
      if (!result.ok || result.data?.novel_id !== chapter.novelId ||
          !(result.data.resume_etag === null || typeof result.data.resume_etag === 'string')) {
        run.etag = undefined;
        return false;
      }
      run.etag = result.data.resume_etag;
      run.target = resumeSnapshot(result.data.resume);
      return true;
    }

    function writerBody(position) {
      return {chapter_id: chapter.id, content_revision: chapter.revision, scroll_position: position};
    }

    function selectedDraft(run) {
      return run.own || run.recovered[0] || null;
    }

    function draftUsable(run,entry) {
      return run.blockedDraft !== entry.value.id && (entry.value.chapter_id !== chapter.id ||
        matchesRevision(entry.value.content_revision,chapter.revision));
    }

    function refreshDrafts(run) {
      if (!offline) return;
      const {entries,failed} = offline.store.resumes();
      run.storageError = failed;
      run.recovered = entries.filter(entry => entry.value.id !== run.slot);
    }

    function cancelStorageTimer() {
      if (storageTimer !== null) clock.clearTimeout(storageTimer);
      storageTimer = null;
    }

    function persist(run, status, attempt = null) {
      if (!offline || !validFraction(run.pending)) return;
      cancelStorageTimer();
      const value = {...writerBody(run.pending), state:status,
        attempt:attempt ? {etag:attempt.etag, position:attempt.position} : null};
      run.slot ??= offline.newId();
      const entry = offline.store.save('resume',run.slot,value,run.own?.raw);
      run.storageError = entry.kind !== 'ready';
      if (!run.storageError) run.own = entry;
    }

    function finishLocal(run) {
      cancelStorageTimer();
      if (run?.capture && (dirty(run) || run.attempt || run.activation)) {
        const attempt = run.attempt || run.activation;
        persist(run,attempt ? 'uncertain' : 'dirty',attempt);
      }
    }

    function releaseDraft(run, entry) {
      if (entry && !offline.store.remove(entry) && offline.store.read('resume',entry.value.id).kind !== 'empty') {
        run.storageError = true;
        return false;
      }
      if (run.own === entry) {
        run.own = null;
        run.slot = null;
      }
      run.recovered = run.recovered.filter(item=>item !== entry);
      return true;
    }

    async function verifyWriter(run) {
      const profile = await send('/api/auth/me');
      if (!current(run)) return false;
      if (profile.status === 401) unauthorized();
      else if (profile.ok && uuid(profile.data?.id) && account !== profile.data.id) unauthorized();
      return current(run) && profile.ok && profile.data?.id === account;
    }

    async function failure(run, result) {
      run.epoch = null;
      if (run.capture && dirty(run)) persist(run,'conflict');
      run.capture = false;
      run.attempt = null;
      cancelTimer();
      run.etag = undefined;
      if (result.status === 401) {
        unauthorized();
        return;
      }
      if (result.status === 403) {
        // Require reload rather than resubmitting under a potentially changed session.
        run.target = null;
        run.status = messages.csrf;
        run.allowActivate = false;
        return;
      }
      const conflict = [409, 412].includes(result.status);
      const edited = result.data?.detail?.code === 'content_revision_changed' || result.status === 404;
      if (edited) run.blockedDraft = selectedDraft(run)?.value.id;
      run.status = edited ? messages.content : conflict ? messages.conflict :
        result.status === 0 ? messages.network : messages.unavailable;
      run.allowActivate = !edited;
      if (conflict) {
        run.target = null;
        paint(run);
        await readProgress(run);
      }
    }

    function sendActivation(run, body) {
      const precondition = run.etag === null ? {'If-None-Match': '*'} : {'If-Match': run.etag};
      return send(base + '/resume/activate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', [csrfHeader]: pageCsrf, ...precondition},
        body: JSON.stringify(body),
      });
    }

    async function activate(run, position, followed = false) {
      if (!current(run) || !view.foreground() || !validFraction(position) || !pageCsrf ||
          run.etag === undefined) return;
      if (!online()) {
        run.pending ??= position;
        run.capture = true;
        persist(run,'dirty');
        run.status = messages.offline;
        run.allowActivate = true;
        return;
      }
      const activateAttempt = {position, etag:run.etag};
      if (offline) {
        run.pending ??= position;
        run.capture = true;
        run.activation = activateAttempt;
        persist(run,'uncertain',activateAttempt);
      }
      const result = await sendActivation(run, writerBody(position));
      const target = resumeSnapshot(result.data?.resume);
      const submitted = result.ok && typeof result.data?.resume_etag === 'string' &&
        (!offline || offline.observedWrite({...writerBody(position),attempt:activateAttempt},
          result.data.resume_etag,target));
      if (!current(run)) {
        if (submitted && run.pending === position) releaseDraft(run,run.own);
        return;
      }
      run.activation = null;
      if (!submitted || !uuid(result.data?.writer_epoch)) {
        if (offline && (result.status === 0 || result.status >= 500 || result.ok)) {
          run.pending ??= position;
          persist(run,'uncertain',activateAttempt);
          run.capture = false;
          run.allowActivate = true;
          run.status = messages.network;
          run.target = null;
          if (online() && await readProgress(run) && current(run)) reconcileDrafts(run);
          return;
        }
        await failure(run, result);
        return;
      }
      run.epoch = result.data.writer_epoch;
      run.etag = result.data.resume_etag;
      run.saved = position;
      if (followed && target?.chapter_id === chapter.id) run.target = target;
      run.capture = true;
      run.allowActivate = false;
      if (dirty(run)) persist(run,'dirty');
      else releaseDraft(run,run.own);
    }

    function dirty(run) {
      return validFraction(run.pending) && run.pending !== run.saved;
    }

    function schedule(run) {
      cancelTimer();
      if (!current(run) || !run.epoch || run.busy || !view.foreground() || !online()) return;
      if (run.attempt) {
        if (run.attempt.retries < retryLimit) {
          timer = clock.setTimeout(() => { void reconcile(run); }, 1000 * (2 ** run.attempt.retries));
        }
        return;
      }
      if (!dirty(run)) return;
      timer = clock.setTimeout(() => { void flush(); }, 5000);
    }

    async function flush(keepalive = false) {
      const run = state;
      if (!current(run) || !run.epoch || run.busy || run.attempt || !dirty(run) ||
          (!keepalive && !view.foreground())) return;
      cancelTimer();
      if (!online()) { disconnected(); return; }
      const attempt = {position:run.pending,etag:run.etag,retries:0};
      run.busy = true;
      await write(run,attempt,keepalive);
      if (!current(run)) return;
      run.busy = false;
      paint(run);
      schedule(run);
    }

    async function write(run, attempt, keepalive = false) {
      const position = attempt.position;
      run.attempt = attempt;
      persist(run,'uncertain',attempt);
      run.status = messages.syncing;
      if (offline) paint(run);
      const result = await send(base + '/resume', {
        method: 'PUT', keepalive,
        headers: {'Content-Type': 'application/json', [csrfHeader]: pageCsrf, 'If-Match': attempt.etag},
        body: JSON.stringify({...writerBody(position), writer_epoch: run.epoch}),
      });
      const saved = result.ok && typeof result.data?.resume_etag === 'string' &&
        (!offline || offline.observedWrite({...writerBody(position),attempt}, result.data.resume_etag,
          resumeSnapshot(result.data.resume)));
      if (!current(run)) {
        // A late acknowledgement may retire only the exact submitted draft, never paint a new owner.
        if (saved && run.pending === position) releaseDraft(run,run.own);
        return;
      }
      if (saved) {
        run.attempt = null;
        run.etag = result.data.resume_etag;
        run.saved = position;
        if (dirty(run)) {
          persist(run,'dirty');
          run.status = messages.dirty;
        } else {
          releaseDraft(run,run.own);
          run.status = messages.synced;
        }
      } else if (offline && (result.status === 0 || result.status >= 500 || result.ok)) {
        run.status = messages.network;
        if (attempt.retries >= retryLimit) endUncertain(run);
      } else {
        await failure(run, result);
      }
    }

    function endUncertain(run) {
      if (run.attempt) persist(run,'uncertain',run.attempt);
      run.epoch = null;
      run.capture = false;
      run.attempt = null;
      run.allowActivate = true;
    }

    function reconcileDrafts(run) {
      if (!offline) return;
      const entries = [run.own, ...run.recovered].filter(Boolean);
      for (const entry of entries) {
        if (entry.value.state === 'uncertain' &&
            offline.observedWrite(entry.value,run.etag,run.target) && releaseDraft(run,entry)) {
          run.status = messages.synced;
        }
      }
    }

    async function reconcile(run, verified = false) {
      if (!current(run) || run.busy || !view.foreground() || !online() ||
          !run.attempt || run.attempt.retries >= retryLimit) return;
      cancelTimer();
      run.busy = true;
      const attempt = run.attempt;
      attempt.retries++;
      const ownerOK = verified || await verifyWriter(run);
      if (!current(run)) return;
      const loaded = ownerOK && await readProgress(run);
      if (!current(run)) return;
      if (loaded && run.etag === attempt.etag && run.pending === attempt.position && run.epoch) {
        if (view.foreground() && online()) await write(run,attempt);
        else if (attempt.retries >= retryLimit) endUncertain(run);
      } else if (loaded) {
        const matched = offline.observedWrite({...writerBody(run.pending),attempt},run.etag,run.target);
        endUncertain(run);
        if (matched) {
          releaseDraft(run,run.own);
          run.saved = run.pending;
          run.status = messages.synced;
        } else {
          persist(run,'conflict');
          run.status = messages.conflict;
        }
      } else if (attempt.retries >= retryLimit) endUncertain(run);
      if (!current(run)) return;
      run.busy = false;
      paint(run);
      schedule(run);
    }

    async function start(auto) {
      if (!sessionHint || retired || state || !view.foreground()) return;
      const run = {auto, busy: true, epoch: null, etag: undefined, saved: null, pending: null,
        target:null, status:'', allowActivate:false, capture:false, own:null, slot:null,
        attempt:null, recovered:[], storageError:false};
      state = run;
      if (!current(run)) return;
      const profile = verifiedOwner ? {ok:true, data:{id:verifiedOwner}} : await send('/api/auth/me');
      if (!current(run)) return;
      if (!profile.ok || !uuid(profile.data?.id) || (account && account !== profile.data.id)) {
        retire();
        if (!profile.ok && profile.status !== 401 && view.foreground()) {
          view.paint({status: messages.authUnavailable});
        }
        return;
      }
      account = profile.data.id;
      refreshDrafts(run);
      const incoming = auto ? view.takeHandoff(account) : null;
      if (!auto) view.clearHandoff();
      const loaded = await readProgress(run);
      if (!current(run)) return;
      if (loaded) reconcileDrafts(run);
      if (!loaded || !pageCsrf) {
        run.status = pageCsrf ? messages.unavailable : messages.csrf;
        run.allowActivate = Boolean(pageCsrf);
        run.capture = Boolean(offline && run.auto && !selectedDraft(run) && pageCsrf);
      } else if (run.auto && !selectedDraft(run) && !run.storageError && view.foreground()) {
        let position = view.position();
        const followed = Boolean(incoming && run.pending === null && view.foreground());
        if (followed) {
          position = restorePosition(run, incoming);
        } else if (run.pending === null && run.target?.chapter_id === chapter.id &&
                   matchesRevision(run.target.content_revision, chapter.revision)) {
          // A reload keeps the saved position until the reader scrolls or chooses Đọc tiếp.
          position = run.target.scroll_position;
        }
        paint(run); // Keep the GET snapshot accessible before an initial write.
        if (validFraction(position)) await activate(run, position, followed);
        else run.allowActivate = true;
      } else {
        run.allowActivate = true;
      }
      run.busy = false;
      paint(run);
      schedule(run);
    }

    async function deliberateActivate() {
      const run = state;
      if (!current(run) || !run.allowActivate || run.busy || !view.foreground()) return;
      const freshCheck = Boolean(offline && selectedDraft(run));
      if (freshCheck) {
        if (!online()) return;
        if (run.own) run.recovered.unshift(run.own);
        run.own = null;
        run.slot = null;
        run.pending = null;
        run.capture = false;
      }
      run.busy = true;
      run.status = '';
      paint(run);
      const verified = !freshCheck || await verifyWriter(run);
      if (verified && ((!freshCheck && run.etag !== undefined) || await readProgress(run))) {
        await activate(run, view.position());
      } else {
        run.status = messages.unavailable;
      }
      run.busy = false;
      paint(run);
      schedule(run);
    }

    function note(position) {
      const run = state;
      if (!current(run) || !view.foreground() || !validFraction(position)) return;
      if (offline && !run.capture) return;
      if (run.pending === position) return;
      run.pending = position;
      if (offline) {
        if (!dirty(run) && !run.attempt) {
          cancelStorageTimer();
          releaseDraft(run,run.own);
        } else if (storageTimer === null) {
          storageTimer = clock.setTimeout(() => {
            storageTimer = null;
            if (!current(run) || !run.capture || (!dirty(run) && !run.attempt && !run.activation)) return;
            const attempt = run.attempt || run.activation;
            persist(run,attempt ? 'uncertain' : 'dirty',attempt);
            paint(run);
          },250);
        }
        if (!run.attempt && !run.activation) {
          run.status = !online() ? messages.offline : dirty(run) ? messages.dirty : '';
        }
        paint(run);
      }
      // The current request's recovery clock is independent of incoming scroll events.
      if (run.attempt) return;
      schedule(run);
    }

    async function applyDraft() {
      const run = state;
      if (!current(run) || !view.foreground() || !online() || !pageCsrf || run.epoch ||
          run.busy) return;
      const entry = selectedDraft(run);
      if (!entry || !draftUsable(run,entry)) return;
      run.busy = true;
      run.status = messages.syncing;
      paint(run);
      if (await verifyWriter(run) && await readProgress(run) && current(run) &&
          view.foreground() && online()) {
        if (offline.store.read('resume',entry.value.id).raw === entry.raw &&
            releaseIfObserved(run,entry) === false) {
          const {chapter_id, scroll_position, content_revision} = entry.value;
          const attempt = {etag:run.etag,position:scroll_position};
          const inflight = offline.store.save('resume',entry.value.id,{
            chapter_id,scroll_position,content_revision,state:'uncertain',attempt,
          },entry.raw);
          if (inflight.kind !== 'ready') run.storageError = true;
          else {
            if (run.own === entry) run.own = inflight;
            run.recovered = run.recovered.map(item=>item === entry ? inflight : item);
            const result = await sendActivation(run,{chapter_id,scroll_position,content_revision});
            const target = resumeSnapshot(result.data?.resume);
            const saved = result.ok && offline.observedWrite(inflight.value,result.data.resume_etag,target);
            if (!current(run)) {
              if (saved) offline.store.remove(inflight);
              return;
            }
            if (saved) {
              releaseDraft(run,inflight);
              run.etag = result.data.resume_etag;
              run.target = target;
              run.pending = null;
              run.capture = false;
              run.status = messages.synced;
            } else if (result.status === 401) unauthorized();
            else {
              const uncertain = result.status === 0 || result.status >= 500 || result.ok;
              if (!uncertain) {
                const failed = offline.store.save('resume',entry.value.id,{
                  chapter_id,scroll_position,content_revision,state:'conflict',attempt:null,
                },inflight.raw);
                if (failed.kind === 'ready') {
                  if (run.own === inflight) run.own = failed;
                  run.recovered = run.recovered.map(item=>item === inflight ? failed : item);
                } else run.storageError = true;
              }
              await failure(run,result);
              // A lost Activate may have committed. No new writer is taken from its GET.
              if (current(run) && uncertain && online()) {
                await readProgress(run);
                if (current(run)) reconcileDrafts(run);
              }
            }
          }
        } else if (selectedDraft(run) === entry) {
          refreshDrafts(run);
          run.status = messages.conflict;
        }
      } else if (current(run)) run.status = messages.network;
      if (!current(run)) return;
      run.busy = false;
      paint(run);
    }

    function releaseIfObserved(run, entry) {
      if (entry.value.state !== 'uncertain' || !offline.observedWrite(entry.value,run.etag,run.target)) {
        return false;
      }
      if (releaseDraft(run,entry)) {
        run.pending = null;
        run.status = messages.synced;
      }
      return true;
    }

    function discardDraft() {
      const run = state;
      if (!current(run) || !view.foreground() || run.busy) return;
      const entry = selectedDraft(run);
      if (!entry || !offline.confirmDiscard() || !current(run) || !view.foreground()) return;
      const own = entry === run.own;
      if (releaseDraft(run,entry)) {
        if (own) {
          cancelTimer();
          cancelStorageTimer();
          if (run.attempt) {
            run.epoch = null;
            run.capture = false;
          }
          run.attempt = null;
          run.pending = null;
        }
        run.status = '';
        refreshDrafts(run);
      }
      paint(run);
    }

    function disconnected() {
      const run = state;
      if (!current(run) || !offline) return;
      cancelTimer();
      finishLocal(run);
      if (dirty(run) || selectedDraft(run)) run.status = messages.offline;
      paint(run);
    }

    function restorePosition(run, target) {
      const sameRevision = matchesRevision(target.content_revision, chapter.revision);
      const position = view.restore(sameRevision ? target.scroll_position : 0);
      if (!sameRevision) run.status = messages.oldPosition;
      return position;
    }

    function follow() {
      const run = state;
      if (!current(run) || !view.foreground() || !run.target) return {allowLink: false};
      if (run.target.chapter_id !== chapter.id) {
        view.rememberHandoff(account, run.target);
        return {allowLink: true};
      }
      note(restorePosition(run, run.target));
      paint(run);
      return {allowLink: false};
    }

    function hide() {
      if (!current(state)) return;
      state.auto = false;
      cancelTimer();
      finishLocal(state);
      void flush(true);
      view.paint(null);
    }

    function leave(flushPending = true) {
      if (flushPending) hide();
      finishLocal(state);
      cancelTimer();
      state = null;
    }

    async function foreground(verified = false) {
      if (!state) return start(false);
      if (!current(state)) return;
      const run = state;
      if (verified && offline && !run.busy) {
        refreshDrafts(run);
        if (run.attempt) return reconcile(run,true);
        if (selectedDraft(run)?.value.state === 'uncertain' && !run.epoch && online()) {
          run.busy = true;
          if (await readProgress(run) && current(run)) reconcileDrafts(run);
          if (!current(run)) return;
          run.busy = false;
        }
      }
      paint(run);
      schedule(run);
    }

    function storageChanged() {
      const run = state;
      if (!offline || !current(run) || run.busy || !view.foreground()) return;
      refreshDrafts(run);
      if (run.own && offline.store.read('resume',run.slot).kind === 'empty') {
        run.own = null;
        run.slot = null;
        run.pending = null;
        run.attempt = null;
        run.epoch = null;
        run.capture = false;
        run.allowActivate = true;
        run.status = '';
        cancelTimer();
        cancelStorageTimer();
      }
      paint(run);
    }

    return {start, note, hide, leave, foreground, follow, deliberateActivate,
      applyDraft, discardDraft, disconnected, storageChanged,
      checkAccount: () => current(state)};
  }

  function mount() {
    const page = document.querySelector('.reader-page');
    if (!page || page.dataset.resumeReady) return;
    const {novelId, chapterId: id, contentHash, hashScheme, csrfHeader, csrfCookie} = page.dataset;
    const slug = page.dataset.novelSlug;
    const readerPath = '/novel/' + encodeURIComponent(slug) + '/';
    const chapter = {novelId, id, revision:{scheme:hashScheme, hash:contentHash},
      url:readerPath + page.dataset.chapterSequence,
      title:page.dataset.chapterTitle, number:page.dataset.chapterNumber};
    if (![novelId, id].every(uuid) || !validRevision(chapter.revision) || !csrfHeader || !csrfCookie) return;
    const content = page.querySelector('.reader-content');
    const header = page.querySelector('.reader-chapter-header');
    const toolbar = document.getElementById('reader-toolbar');
    const toc = document.getElementById('reader-toc');
    const group = page.querySelector('.reader-resume');
    const link = group?.querySelector('[data-reader-resume-link]');
    const action = group?.querySelector('[data-reader-resume-activate]');
    const status = group?.querySelector('[data-reader-resume-status]');
    const draftControls = group?.querySelector('[data-reader-resume-draft]');
    const draftLabel = draftControls?.querySelector('[data-reader-draft-position]');
    const applyDraftButton = draftControls?.querySelector('[data-reader-draft-apply]');
    const discardDraftButton = draftControls?.querySelector('[data-reader-draft-discard]');
    const progressSettings = toolbar?.querySelector('[data-reader-progress-settings]');
    const clearButton = progressSettings?.querySelector('[data-reader-guest-clear]');
    const accountMenu = toolbar?.querySelector('#reader-account-menu');
    const completionPanel = page.querySelector('.reader-completion');
    const clearDialog = document.getElementById('reader-guest-clear');
    if (!content || !header || !toolbar || !link || !action || !status || !draftControls || !clearButton ||
        !completionPanel || !clearDialog || !accountMenu) return;
    page.dataset.resumeReady = 'true';
    const guestProgress = window.ReaderGuestProgress;
    const completion = window.ReaderCompletion;
    const completionView = completion.createView(completionPanel);
    const store = guestProgress.createStore(novelId, () => window.localStorage, () =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''));
    const authHint = page.hasAttribute('data-resume-candidate');
    const entryQuery = new URLSearchParams(window.location.search);
    // Old auth-return URLs can still be present in browser history.
    const authReturn = entryQuery.get('reader_entry') === 'auth' || entryQuery.get('guest_progress') === '1';
    const request = window.fetch.bind(window);
    const visible = () => document.visibilityState === 'visible';
    const connected = () => window.navigator.onLine;
    const readOnly = {cache:'no-store', credentials:'same-origin', redirect:'error'};
    let context = null, probe = null, tocRows = [];
    let hasOpenedScope = false, exited = false, recheck = false;
    let guestProof = null;
    let signingOut = null;
    const account = createAccountMenu(accountMenu);
    const logoutButton = accountMenu.querySelector('[data-reader-logout]');
    const logoutStatus = accountMenu.querySelector('[data-reader-logout-status]');
    const settingsTrigger = toolbar.querySelector('#reader-theme-trigger');
    const bookmarks = window.ReaderBookmarks?.mount({page, chapter, readerPath, lookup, request});

    function readCsrf() {
      const prefix = csrfCookie + '=';
      const matches = document.cookie.split(';').map(part => part.trimStart())
        .filter(part => part.startsWith(prefix));
      return matches.length === 1 ? matches[0].slice(prefix.length) || null : null;
    }

    function measure() {
      const box = content.getBoundingClientRect();
      return {y: window.scrollY, range: contentRange({top: box.top + window.scrollY, height: box.height,
        viewport: window.innerHeight, inset: toolbar.offsetHeight})};
    }

    let last = measure();
    let anchor = null;
    const clearHandoff = () => {
      try { window.sessionStorage.removeItem(handoffKey); } catch { /* Storage may be disabled. */ }
    };
    const view = {
      foreground: visible,
      position: () => {
        const {range, y} = measure();
        return contentFraction(range, y);
      },
      restore(position) {
        const {range} = measure();
        if (!range || !validFraction(position) || !visible()) return null;
        anchor = position;
        window.scrollTo({top: range.start + range.span * position, behavior: 'instant'});
        last = measure();
        return range.span ? position : 0;
      },
      clearHandoff,
      takeHandoff(owner) {
        try {
          const candidate = JSON.parse(window.sessionStorage.getItem(handoffKey));
          if (candidate?.owner === owner && candidate.novelId === novelId && candidate.id === id &&
              Number.isFinite(candidate.expires) && candidate.expires >= Date.now() &&
              validFraction(candidate.scroll_position) &&
              (owner !== 'guest' || validRevision(candidate.content_revision))) return candidate;
        } catch { /* Corrupt or inaccessible handoff. */ }
        finally { clearHandoff(); }
        return null;
      },
      rememberHandoff(owner, target) {
        try {
          window.sessionStorage.setItem(handoffKey, JSON.stringify({owner, novelId, id: target.chapter_id,
            scroll_position: target.scroll_position, content_revision: target.content_revision,
            generation: target.generation, expires: Date.now() + 60000}));
        } catch { /* Native navigation remains available. */ }
      },
      paint(state) {
        const next = state?.target;
        link.hidden = !next;
        if (next) link.setAttribute('href', next.url);
        else link.removeAttribute('href');
        action.hidden = !state?.canActivate;
        const draft = state?.draft;
        draftControls.hidden = !draft;
        const draftText = draft ?
          (draft.sameChapter ? 'Chương này' : 'Chương khác') + ' · ' + Math.round(draft.position * 100) + '%' : '';
        if (draftLabel.textContent !== draftText) draftLabel.textContent = draftText;
        applyDraftButton.disabled = !draft?.canApply;
        discardDraftButton.disabled = !draft?.canDiscard;
        progressSettings.hidden = !state?.canClear;
        if (status.textContent !== (state?.status || '')) status.textContent = state?.status || '';
        group.hidden = link.hidden && action.hidden && draftControls.hidden && !status.textContent;
      },
    };

    async function lookup(chapterId) {
      try {
        const response = await request('/api/novels/' + encodeURIComponent(slug) +
          '/chapters/by-id/' + chapterId + '/revision', {...readOnly, signal:AbortSignal.timeout(5000)});
        if (response.status === 404) return {kind:'missing'};
        if (!response.ok) return {kind:'error'};
        const data = await response.json();
        const seq = data.chapter_sequence;
        if (data.id !== chapterId || data.novel_id !== novelId || !validRevision(data.content_revision) ||
            !Number.isInteger(seq) || seq < 1 || seq > 2147483647 || typeof data.title !== 'string' ||
            typeof data.chapter_number !== 'string') return {kind:'error'};
        return {kind:'ready', chapter:{url:readerPath + seq, number:data.chapter_number,
          title:data.title, revision:data.content_revision}};
      } catch { return {kind:'error'}; }
    }

    function current(scope) {
      return context === scope && !exited && readCsrf() === scope.csrf;
    }

    function stop(flushPending = false) {
      bookmarks?.stop();
      context?.guest?.stop();
      context?.resume?.leave(flushPending);
      context?.completion?.suspend();
      context = null;
      account.show(undefined);
      logoutStatus.textContent = '';
      anchor = null;
      view.paint(null);
      completionView.reader(null);
      completionView.toc(tocRows, new Map());
      if (clearDialog.open) clearDialog.close();
    }

    function guestCompletions(claims, writeFailed) {
      const claim = claims?.[id];
      const done = guestProgress.sameRevision(claim?.content_revision, chapter.revision);
      const message = !claims ? 'Chưa xác định' :
        writeFailed ? 'Chưa xác định · Chưa lưu được thay đổi trên thiết bị.' : done ? 'Đã đọc — lưu trên thiết bị' :
        claim ? 'Đã đọc (bản cũ)' : 'Chưa đọc';
      completionView.reader({message, canConfirm:!!claims && !done});
      const statuses = new Map();
      for (const row of tocRows) {
        if (claims?.[row.id]) statuses.set(row.id, {label:row.id !== id ? 'Đã đọc trên thiết bị' :
          done ? 'Đã đọc trên thiết bị' : 'Đã đọc (bản cũ)'});
      }
      completionView.toc(tocRows, statuses);
    }

    function openScope(owner, csrf, auto, username) {
      const newDocument = !hasOpenedScope;
      const entryOwner = history.state?.readerEntryOwner;
      const sameEntryOwner = entryOwner === undefined || entryOwner === owner;
      if (entryOwner === undefined) {
        try { history.replaceState({...history.state, readerEntryOwner:owner}, ''); }
        catch { /* The current document still enforces its verified scope. */ }
      }
      hasOpenedScope = true;
      // Returning from auth or opening another owner's history entry is read-only until action.
      auto = auto && sameEntryOwner && (!owner || !authReturn);
      if (!sameEntryOwner) clearHandoff();
      const scope = {owner, csrf, verifiedOnline:Boolean(owner)};
      context = scope;
      account.show(owner, username);
      bookmarks?.start({owner, isCurrent:() => current(scope), onUnauthorized,
        canUseServer:() => connected() && scope.verifiedOnline,
        csrf:() => current(scope) && csrf ? {header:csrfHeader, value:csrf} : null});
      if (!owner) {
        guestProof = {csrf};
        scope.guest = guestProgress.createGuestController({chapter, store, clock:window, lookup,
          isCurrent:() => current(scope), view:{...view, completions:guestCompletions}});
        if (!newDocument) clearHandoff();
        scope.guest.start(auto, newDocument && sameEntryOwner);
        return;
      }
      guestProof = null;
      function onUnauthorized() {
        if (!current(scope) || signingOut === scope) return;
        stop();
        void verify(false, false, scope);
      }
      const shared = {chapter, csrfHeader, readCsrf, request, sessionHint:true, onUnauthorized,
        isCurrent:() => current(scope)};
      const offline = {
        store:window.ReaderOffline.createStore(owner,novelId,() => window.localStorage),
        observedWrite:window.ReaderOffline.observedWrite,
        newId:window.ReaderOffline.newId,
        online:connected,
        canWrite:() => scope.verifiedOnline,
        confirmDiscard:() => window.confirm('Bỏ thay đổi chưa đồng bộ này trên thiết bị?'),
        owner,
      };
      scope.offlineStore = offline.store;
      scope.resume = createController({...shared, verifiedOwner:owner, clock:window,
        offline:{...offline, online:() => connected() && scope.verifiedOnline}, view:{
        ...view, paint:state => { if (context === scope && signingOut !== scope) view.paint(state); },
      }});
      scope.completion = completion.createController({...shared, offline, view:{
        reader:state => { if (context === scope) completionView.reader(state); },
        toc:(rows, states) => { if (context === scope) completionView.toc(rows, states); },
      }});
      void scope.resume.start(auto);
      void scope.completion.setTocPage(tocRows);
      void scope.completion.resume();
    }

    function disconnect(scope) {
      scope.verifiedOnline = false;
      scope.resume.disconnected();
      if (visible()) {
        void scope.completion.resume();
        bookmarks?.resume();
      }
    }

    async function verify(auto, force = false, rejectedScope = null) {
      if (exited || signingOut || !visible()) return;
      const csrf = readCsrf();
      if (context && !current(context)) stop();
      if (!connected() && context?.resume) {
        disconnect(context);
        return;
      }
      if (probe?.csrf === csrf) return;
      if (context && !force) return;
      if (context?.resume) {
        context.verifiedOnline = false;
        account.show(undefined);
        bookmarks?.suspend();
      }
      const checking = {csrf};
      probe = checking;
      let profile;
      try {
        const response = await request('/api/auth/me', {...readOnly, signal:AbortSignal.timeout(4000)});
        if (response.status === 401) profile = {owner:null};
        else if (response.ok) {
          const data = await response.json();
          if (uuid(data?.id)) profile = {owner:data.id,
            username:typeof data.username === 'string' ? data.username : ''};
        }
      } catch { /* Transport failure leaves the session unconfirmed. */ }
      if (probe !== checking || exited) return;
      probe = null;
      if (!visible()) return;
      if (csrf !== readCsrf()) { void verify(false); return; }
      if (!connected() && profile?.owner) profile = null;
      if (rejectedScope?.csrf === csrf && rejectedScope.owner === profile?.owner) profile = null;
      if (!profile && (guestProof?.csrf === csrf || (!authHint && !hasOpenedScope && csrf === initialCsrf))) {
        profile = {owner:null};
      }
      if (!profile) {
        if (context?.resume && current(context)) {
          disconnect(context);
          return;
        }
        stop();
        view.paint({status:messages.authUnavailable});
        return;
      }
      if (context?.owner === profile.owner) {
        account.show(profile.owner, profile.username);
        if (context.guest) context.guest.sync();
        else {
          context.verifiedOnline = true;
          void context.resume.foreground(true);
          void context.completion.resume(true);
        }
        bookmarks?.resume();
        return;
      }
      const freshNavigation = !hasOpenedScope;
      stop();
      if (!freshNavigation && profile.owner) clearHandoff();
      openScope(profile.owner, csrf, auto && freshNavigation, profile.username);
    }

    const initialCsrf = readCsrf();

    function checkScope() {
      if (signingOut) return false;
      if (context && current(context)) return true;
      if (context) stop();
      void verify(false);
      return false;
    }

    async function signOut() {
      if (!visible() || !checkScope() || !context.owner) return;
      const scope = context;
      if (!connected() || !scope.csrf) {
        logoutStatus.textContent = connected() ? 'Phiên cần xác minh lại. Hãy tải lại trang.' :
          'Đăng xuất cần kết nối mạng.';
        return;
      }
      signingOut = scope;
      probe = null;
      scope.verifiedOnline = false;
      accountMenu.querySelector('[data-reader-account-name]').textContent = '';
      bookmarks?.suspend();
      scope.completion.suspend();
      view.paint(null);
      // Keep focus on the control while the request is pending.
      logoutButton.setAttribute('aria-disabled','true');
      logoutStatus.textContent = 'Đang đăng xuất…';
      const status = await requestLogout(request, csrfHeader, scope.csrf);
      if (signingOut !== scope) return;
      signingOut = null;
      logoutButton.removeAttribute('aria-disabled');
      if (context !== scope || exited) return;
      if (status === 200) {
        stop();
        clearHandoff();
        const csrf = readCsrf();
        if (csrf === null && visible()) openScope(null, csrf, false);
        void verify(false, true);
      } else {
        logoutStatus.textContent = 'Chưa xác nhận được đăng xuất. Hãy thử lại.';
        void verify(false, true);
      }
    }

    function layoutChanged(next) {
      return !last.range || !next.range || Math.abs(last.range.start - next.range.start) > .5 ||
        Math.abs(last.range.span - next.range.span) > .5;
    }
    function layout() {
      const next = measure();
      const changed = layoutChanged(next);
      last = next;
      if (changed && visible() && !toc?.open && anchor !== null) view.restore(anchor);
    }
    function noteScroll(next) {
      if (!visible() || toc?.open || clearDialog.open ||
          bookmarks?.isOpen() || !checkScope()) return;
      const position = contentFraction(next.range, next.y);
      if (context.resume && next.range && next.y > next.range.start + next.range.span) anchor = null;
      else if (anchor !== null || (context.guest && position > 0)) anchor = position;
      (context.guest || context.resume).note(position);
    }
    function scroll() {
      const next = measure();
      if (layoutChanged(next)) {
        layout();
        return;
      }
      const moved = next.y !== last.y;
      last = next;
      if (moved) noteScroll(next);
    }

    link.addEventListener('click', event => {
      if (!checkScope()) { event.preventDefault(); return; }
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const allow = context.guest ? context.guest.follow() : context.resume.follow().allowLink;
      if (!allow) event.preventDefault();
    });
    action.addEventListener('click', () => { if (checkScope()) void context.resume?.deliberateActivate(); });
    applyDraftButton.addEventListener('click', () => { if (checkScope()) void context.resume?.applyDraft(); });
    discardDraftButton.addEventListener('click', () => { if (checkScope()) context.resume?.discardDraft(); });
    completionView.button.addEventListener('click', () => {
      if (!visible() || !checkScope()) return;
      if (context.guest) context.guest.complete();
      else void context.completion.action();
    });
    completionView.discard.addEventListener('click', () => {
      if (visible() && checkScope()) context.completion?.discard();
    });
    toc?.addEventListener('reader:toc-completion-page', event => {
      tocRows = event.detail;
      if (!checkScope()) return;
      if (context.guest) context.guest.sync();
      else void context.completion.setTocPage(tocRows);
    });
    toc?.addEventListener('close', () => {
      if (checkScope()) void context.resume?.foreground();
    });
    window.addEventListener('storage', event => {
      bookmarks?.storageChanged(event.key);
      if (context?.guest && store.includes(event.key) && checkScope()) context.guest.sync();
      if (context?.offlineStore?.includes(event.key) && checkScope()) {
        context.resume?.storageChanged();
        context.completion?.storageChanged();
      }
    });
    clearButton.addEventListener('click', () => {
      if (checkScope() && context.guest && !clearDialog.open) clearDialog.showModal();
    });
    clearDialog.querySelector('[data-reader-clear-cancel]').addEventListener('click', () => clearDialog.close());
    clearDialog.querySelector('[data-reader-clear-confirm]').addEventListener('click', () => {
      clearDialog.close();
      if (checkScope()) context.guest?.clear();
    });
    clearDialog.addEventListener('close', () => {
      if (visible() && context?.guest && current(context)) settingsTrigger?.focus({preventScroll:true});
    });
    logoutButton?.addEventListener('click', () => void signOut());
    document.addEventListener('visibilitychange', () => {
      if (visible()) {
        layout();
        recheck = false;
        void verify(false, true);
      } else {
        bookmarks?.suspend();
        if (context && current(context)) {
          context.guest?.flush();
          context.resume?.hide();
          context.completion?.suspend();
        }
      }
    });
    window.addEventListener('focus', () => {
      if (recheck) {
        recheck = false;
        void verify(false, true);
      } else checkScope();
    });
    window.addEventListener('blur', () => { recheck = true; });
    window.cookieStore?.addEventListener('change', event => {
      if ([...event.changed, ...event.deleted].some(cookie => cookie.name === csrfCookie)) checkScope();
    });
    window.addEventListener('online', () => { void verify(false, true); });
    window.addEventListener('offline', () => {
      probe = null;
      if (signingOut) return;
      if (context?.resume && current(context)) disconnect(context);
      else if (context?.guest && current(context) && visible()) bookmarks?.resume();
    });
    window.addEventListener('pagehide', () => {
      if (context && current(context)) context.guest?.flush();
      stop(true);
      signingOut = null;
      logoutButton?.removeAttribute('aria-disabled');
      probe = null;
      exited = true;
    });
    window.addEventListener('pageshow', event => {
      if (event.persisted) {
        exited = false;
        layout();
        void verify(false, true);
      }
    });
    window.addEventListener('keydown', event => {
      if (anchor === null || !event.isTrusted || event.defaultPrevented || event.key !== 'Home' ||
          event.shiftKey || event.altKey || event.metaKey || !visible() ||
          toc?.open || clearDialog.open || bookmarks?.isOpen() ||
          event.target?.isContentEditable || event.target?.closest?.('input, textarea, select')) return;
      const before = window.scrollY;
      // An animated Home scroll can pick up anchoring offsets from header reflow.
      event.preventDefault();
      anchor = null;
      window.scrollTo({top: 0, behavior: 'instant'});
      last = measure();
      if (last.y !== before) noteScroll(last);
    });
    window.addEventListener('resize', layout, {passive: true});
    window.addEventListener('scroll', scroll, {passive: true});
    const observer = new ResizeObserver(layout);
    observer.observe(header);
    observer.observe(content);
    void verify(true);
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = {contentRange, contentFraction, createController, resumeSnapshot, requestLogout, createAccountMenu};
  } else mount();
})();
