/* Chapter bookmarks share Reader's verified scope. Guest records stay on this device. */
(() => {
  'use strict';

  const uuid = value => typeof value === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
  const pageSize = 20;
  const storageError = 'Không thể đọc hoặc lưu đánh dấu trên thiết bị.';
  const offlineMessage = 'Chưa kết nối được với máy chủ. Đánh dấu trên tài khoản cần kết nối.';
  const loadError = 'Không tải được dấu trang. Hãy thử lại.';
  const writeError = 'Không xác nhận được thay đổi dấu trang. Hãy thử lại.';

  const guestPrefix = 'readnovel.bookmarks.guest.v1.';

  function parseGuest(raw, novelId, id) {
    if (raw === null) return null;
    if (!uuid(novelId) || !uuid(id) || raw.length > 512) throw Error('Invalid bookmark');
    const record = JSON.parse(raw);
    if (!record || Object.keys(record).length !== 4 ||
        record.version !== 1 || record.novel_id !== novelId || record.chapter_id !== id ||
        typeof record.created_at !== 'string' || !Number.isFinite(Date.parse(record.created_at)) ||
        new Date(record.created_at).toISOString() !== record.created_at) throw Error('Invalid bookmark');
    return record;
  }

  function createGuestStore(novelId, storage, now = () => new Date().toISOString()) {
    const prefix = guestPrefix + novelId + '.';
    function read(id) {
      try { return {record:parseGuest(storage().getItem(prefix + id), novelId, id)}; }
      catch { return {failed:true}; }
    }
    function set(id, marked) {
      if (!uuid(id)) return false;
      try {
        const backend = storage();
        const key = prefix + id;
        const existing = parseGuest(backend.getItem(key), novelId, id);
        if (marked && !existing) backend.setItem(key, JSON.stringify({
          version:1, novel_id:novelId, chapter_id:id, created_at:now(),
        }));
        else if (!marked && existing) backend.removeItem(key);
        return true;
      } catch { return false; }
    }
    function list() {
      const records = [];
      let failed = false;
      try {
        const backend = storage();
        for (let index = 0; index < backend.length; index++) {
          const key = backend.key(index);
          if (!key?.startsWith(prefix)) continue;
          const raw = backend.getItem(key);
          try {
            const record = parseGuest(raw, novelId, key.slice(prefix.length));
            if (record) records.push(record);
          } catch { failed = true; }
        }
      } catch { failed = true; }
      records.sort((a,b) => b.created_at.localeCompare(a.created_at) || b.chapter_id.localeCompare(a.chapter_id));
      return {records, failed};
    }
    return {read, set, list, includes:key => key === null || key.startsWith(prefix)};
  }

  function createController({chapter, readerPath, guestStore, lookup, request, view}) {
    const base = '/api/bookmarks/novels/' + chapter.novelId;
    const chapterUrl = id => base + '/chapters/' + id;
    let active = null;
    const current = run => Boolean(run && run === active && run.scope.isCurrent());
    const account = run => Boolean(run.scope.owner);
    const reachable = run => !account(run) || run.scope.canUseServer();

    function paint(run) {
      if (!current(run) || run.suspended) { view.paint(null); return; }
      const warning = reachable(run) ? '' : offlineMessage;
      view.paint({
        marked:run.marked, busy:run.mutating, statusLoading:run.reading,
        needsRefresh:run.marked === null || run.error === writeError,
        toggleDisabled:!!(warning || run.mutating || run.reading),
        message:warning || run.error,
        source:account(run) ? 'Trên tài khoản' : 'Trên thiết bị này',
        list:run.list, listLoading:run.listLoading, listError:warning || run.listError,
        listDisabled:!!(warning || run.mutating || run.listLoading),
      });
    }

    function cancelReads(run) {
      run.statusRead?.abort();
      run.listRead?.abort();
      run.statusRead = run.listRead = null;
      run.reading = run.listLoading = false;
    }

    function suspend() {
      if (!active) return;
      active.suspended = true;
      cancelReads(active);
      view.paint(null);
    }

    function stop() {
      if (active) cancelReads(active);
      active = null;
      view.paint(null);
      view.close();
    }

    function start(scope) {
      stop();
      active = {scope, marked:null, page:1, error:'', listError:''};
      resume();
    }

    async function send(run, url, options) {
      try {
        const deadline = AbortSignal.timeout(7000);
        const response = await request(url, {cache:'no-store', credentials:'same-origin',
          redirect:'error', ...options,
          signal:options.signal ? AbortSignal.any([options.signal,deadline]) : deadline});
        if (!current(run) || options.signal?.aborted) return null;
        if (response.status === 401) {
          run.scope.onUnauthorized();
          return null;
        }
        return response;
      } catch { return null; }
    }

    async function readStatus(run) {
      if (!current(run) || run.suspended || run.mutating || !reachable(run)) return;
      run.error = '';
      if (!account(run)) {
        const state = guestStore.read(chapter.id);
        if (state.failed) run.error = storageError;
        else run.marked = !!state.record;
        paint(run);
        return;
      }
      run.statusRead?.abort();
      const read = new AbortController();
      run.statusRead = read;
      run.reading = true;
      paint(run);
      const response = await send(run, chapterUrl(chapter.id), {signal:read.signal});
      let status;
      try { if (response?.ok) status = await response.json(); }
      catch { /* Invalid status keeps the previous acknowledgement. */ }
      if (!current(run) || run.statusRead !== read) return;
      run.statusRead = null;
      run.reading = false;
      if (status?.chapter_id === chapter.id && typeof status.bookmarked === 'boolean' &&
          typeof status.available === 'boolean') run.marked = status.bookmarked;
      else run.error = loadError;
      paint(run);
    }

    function authPage(data, page) {
      if (data?.novel_id !== chapter.novelId || data.page !== page ||
          data.page_size !== pageSize || !Number.isSafeInteger(data.total_pages) || data.total_pages < 0 ||
          !Array.isArray(data.items) || data.items.length > pageSize) throw Error('Invalid bookmark page');
      const items = data.items.map(item => {
        if (!uuid(item?.chapter_id) || typeof item.available !== 'boolean') throw Error('Invalid bookmark item');
        if (!item.available) return {id:item.chapter_id};
        if (!Number.isInteger(item.chapter_sequence) || item.chapter_sequence < 1 ||
            item.chapter_sequence > 2147483647 || typeof item.chapter_number !== 'string' ||
            typeof item.title !== 'string') throw Error('Invalid Published bookmark');
        return {id:item.chapter_id, title:item.title, number:item.chapter_number,
          url:readerPath + item.chapter_sequence};
      });
      return {items, pages:data.total_pages, page};
    }

    async function guestPage(number) {
      const {records, failed} = guestStore.list();
      const pages = Math.ceil(records.length / pageSize);
      const page = Math.min(number, Math.max(1,pages));
      const items = await Promise.all(records.slice((page-1)*pageSize,page*pageSize).map(async record => {
        const id = record.chapter_id;
        if (id === chapter.id) return {id, title:chapter.title, number:chapter.number, url:chapter.url};
        const result = await lookup(id);
        if (result.kind === 'ready') return {id, ...result.chapter};
        return {id, unknown:result.kind !== 'missing'};
      }));
      return {items, pages, page, warning:failed ? storageError : ''};
    }

    async function loadList(number) {
      const run = active;
      if (!current(run) || !run.open || run.suspended || run.mutating || !reachable(run)) return;
      run.listRead?.abort();
      const read = new AbortController();
      run.listRead = read;
      run.listLoading = true;
      run.listError = '';
      paint(run);
      let list;
      try {
        if (account(run)) {
          const response = await send(run, base + '?page=' + number + '&page_size=' + pageSize,
            {signal:read.signal});
          if (response?.ok) list = authPage(await response.json(), number);
        } else list = await guestPage(number);
      } catch { /* Keep any same-scope page already shown. */ }
      if (!current(run) || run.listRead !== read) return;
      run.listRead = null;
      run.listLoading = false;
      const last = Math.max(1,list?.pages ?? 1);
      if (list && list.page > last) { await loadList(last); return; }
      if (list) {
        run.list = list;
        run.page = list.page;
      }
      run.listError = list ? list.warning || '' : loadError;
      paint(run);
    }

    function resume() {
      const run = active;
      if (!current(run)) return;
      run.suspended = false;
      if (!reachable(run)) {
        cancelReads(run);
        paint(run);
        return;
      }
      void readStatus(run);
      if (run.open) void loadList(run.page);
    }

    function open() {
      const run = active;
      if (!current(run) || run.suspended || run.open || !view.open()) return;
      run.open = true;
      paint(run);
      void loadList(run.page);
    }

    function close() {
      if (!active) return;
      active.open = false;
      active.listRead?.abort();
      active.listRead = null;
      active.listLoading = false;
    }

    async function change(run, id, marked) {
      if (!current(run) || run.suspended || run.mutating || !reachable(run)) return;
      if (!account(run)) {
        if (!guestStore.set(id, marked)) {
          run.error = run.listError = storageError;
          paint(run);
          return;
        }
      } else {
        const credentials = run.scope.csrf();
        if (!credentials) {
          run.error = run.listError = 'Phiên cần xác minh lại. Hãy tải lại trang.';
          paint(run);
          return;
        }
        run.error = run.listError = '';
        cancelReads(run);
        run.mutating = true;
        paint(run);
        const response = await send(run, chapterUrl(id), {
          method:marked ? 'PUT' : 'DELETE', headers:{[credentials.header]:credentials.value},
        });
        if (!current(run)) return;
        run.mutating = false;
        if (response?.status !== 204) {
          run.error = run.listError = writeError;
          paint(run);
          return;
        }
      }
      if (id === chapter.id) run.marked = marked;
      if (!marked && run.list) run.list = {...run.list, items:run.list.items.filter(item => item.id !== id)};
      run.error = run.listError = '';
      paint(run);
      if (run.open) void loadList(run.page);
    }

    function toggle() {
      const run = active;
      if (!current(run) || run.suspended || run.reading || run.mutating || !reachable(run)) return;
      if (run.marked === null || (account(run) && run.error === writeError)) return readStatus(run);
      return change(run, chapter.id, !run.marked);
    }

    function remove(id) {
      const run = active;
      if (current(run) && run.open && !run.listLoading &&
          run.list?.items.some(item => item.id === id)) return change(run, id, false);
    }

    function storageChanged(key) {
      const run = active;
      if (current(run) && !run.suspended && !account(run) && guestStore.includes(key)) resume();
    }

    return {start, stop, suspend, resume, open, close, toggle, remove, loadList, storageChanged};
  }

  function bindDialogDismissal(dialog, button, opener, closed) {
    let opened = false, backdropDown = false;
    function finish(restoreFocus) {
      if (dialog.open || !opened) return;
      opened = false;
      closed();
      if (restoreFocus && opener.isConnected && !opener.disabled && !opener.closest('[hidden]') &&
          opener.getClientRects().length && opener.ownerDocument.defaultView.getComputedStyle(opener).visibility === 'visible') {
        opener.focus({preventScroll:true});
      }
    }
    function close(restoreFocus = true) {
      if (!dialog.open) return;
      dialog.close();
      finish(restoreFocus);
    }
    function backdrop(event) {
      const box = dialog.getBoundingClientRect();
      return event.target === dialog &&
        (event.clientX < box.left || event.clientX > box.right ||
         event.clientY < box.top || event.clientY > box.bottom);
    }
    button.addEventListener('click', () => close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('pointerdown', event => { backdropDown = backdrop(event); });
    dialog.addEventListener('click', event => {
      if (backdropDown && backdrop(event)) close();
      backdropDown = false;
    });
    dialog.addEventListener('close', () => finish(true));
    return {opened:() => { opened = true; backdropDown = false; }, close};
  }

  function bookmarkDestination(item) {
    const title = item.title?.trim();
    if (!item.url || !title) {
      return {href:null, label:item.url || item.unknown ?
        'Chưa kiểm tra được tên chương' : 'Chương không còn khả dụng'};
    }
    const number = item.number?.trim();
    const label = number && title !== number && title !== 'Chương ' + number
      ? number + ' · ' + title : title;
    return {href:item.url, label};
  }

  function mount({page, chapter, readerPath, lookup, request}) {
    const toggle = page.querySelector('#reader-bookmark-toggle');
    const opener = page.querySelector('#reader-bookmarks-open');
    const dialog = page.querySelector('#reader-bookmarks');
    if (!toggle || !opener || !dialog || typeof dialog.showModal !== 'function') return null;
    const feedback = page.querySelector('#reader-bookmark-feedback');
    const find = selector => dialog.querySelector(selector);
    const closeButton = find('[data-bookmarks-close]');
    const listing = find('[data-bookmarks-items]');
    const notice = find('[data-bookmarks-status]');
    const source = find('[data-bookmarks-source]');
    const navigation = find('[data-bookmarks-pagination]');
    const previous = find('[data-bookmarks-prev]');
    const next = find('[data-bookmarks-next]');
    const count = find('[data-bookmarks-page]');
    const retry = find('[data-bookmarks-retry]');
    let rendered, controls = [], pageNumber = 1, restoreIndex = null;
    const disabled = (button, value) => button.setAttribute('aria-disabled', String(value));

    function renderItems(list) {
      if (rendered === list) return;
      const focused = controls.indexOf(document.activeElement);
      if (focused >= 0) restoreIndex = focused;
      rendered = list;
      controls = [];
      const items = (list?.items || []).map(item => {
        const row = document.createElement('li');
        const {href, label} = bookmarkDestination(item);
        const name = document.createElement(href ? 'a' : 'span');
        if (href) name.href = href;
        name.textContent = label;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Bỏ dấu';
        remove.setAttribute('aria-label', 'Bỏ dấu: ' + name.textContent);
        remove.addEventListener('click', () => void controller.remove(item.id));
        row.append(name, remove);
        controls.push(remove);
        return row;
      });
      listing.replaceChildren(...items);
    }

    const view = {
      paint(state) {
        disabled(toggle,!state || state.toggleDisabled);
        disabled(opener,!state);
        toggle.setAttribute('aria-busy',String(!!(state?.statusLoading || state?.busy)));
        if (state?.marked == null) toggle.removeAttribute('aria-pressed');
        else toggle.setAttribute('aria-pressed',String(state.marked));
        toggle.title = state?.needsRefresh && !state.statusLoading ? 'Kiểm tra lại dấu trang' :
          state?.marked ? 'Bỏ đánh dấu chương này' : 'Đánh dấu chương này';
        const message = state?.message || (state?.busy ? 'Đang lưu dấu trang…' : '');
        if (feedback.textContent !== message) feedback.textContent = message;
        feedback.toggleAttribute('data-visible',Boolean(message) && !dialog.open);
        const list = state?.list;
        renderItems(list);
        const loading = !!state?.listLoading;
        dialog.setAttribute('aria-busy',String(loading || !!state?.busy));
        source.textContent = state?.source || '';
        const status = state?.listError || (state?.busy ? 'Đang lưu thay đổi…' : loading ? 'Đang tải dấu trang…' :
          !list ? 'Đang kiểm tra dấu trang…' : !list.items.length ? 'Chưa có chương nào được đánh dấu.' : '');
        if (notice.textContent !== status) notice.textContent = status;
        pageNumber = list?.page || 1;
        navigation.hidden = !list || list.pages < 2;
        count.textContent = list ? pageNumber + ' / ' + list.pages : '';
        retry.hidden = !state?.listError || state.listDisabled;
        disabled(previous,!state || state.listDisabled || pageNumber <= 1);
        disabled(next,!state || state.listDisabled || !list || pageNumber >= list.pages);
        for (const button of controls) disabled(button,!state || state.listDisabled);
        if (restoreIndex !== null && !loading && list && dialog.open) {
          (controls[Math.min(restoreIndex,controls.length-1)] || closeButton).focus({preventScroll:true});
          restoreIndex = null;
        }
      },
      open() {
        if (page.querySelector('dialog[open]')) return false;
        dialog.showModal();
        dismissal.opened();
        opener.setAttribute('aria-expanded','true');
        closeButton.focus({preventScroll:true});
        return true;
      },
      close() { dismissal.close(false); },
    };
    const controller = createController({chapter, readerPath, lookup, request, view,
      guestStore:createGuestStore(chapter.novelId, () => window.localStorage)});
    toggle.disabled = opener.disabled = false;
    toggle.addEventListener('click', () => void controller.toggle());
    opener.addEventListener('click', () => controller.open());
    const dismissal = bindDialogDismissal(dialog, closeButton, opener, () => {
      opener.setAttribute('aria-expanded','false');
      restoreIndex = null;
      controller.close();
    });
    retry.addEventListener('click', () => void controller.loadList(pageNumber));
    previous.addEventListener('click', () => {
      if (previous.getAttribute('aria-disabled') === 'false') void controller.loadList(pageNumber-1);
    });
    next.addEventListener('click', () => {
      if (next.getAttribute('aria-disabled') === 'false') void controller.loadList(pageNumber+1);
    });
    return {...controller, isOpen:() => dialog.open};
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = {createGuestStore, createController, bindDialogDismissal, bookmarkDestination};
  } else window.ReaderBookmarks = {mount};
})();
