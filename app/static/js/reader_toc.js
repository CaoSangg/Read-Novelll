/* Published, paginated TOC. Confirmation is a temporary UX policy, never a progress/security gate. */
(() => {
  'use strict';
  function validSequence(value) {
    return Number.isInteger(value) && value >= 1 && value <= 2147483647;
  }
  function chapterUrl(slug, sequence) {
    if (typeof slug !== 'string' || Array.from(slug).length > 255 ||
        !/^[\p{L}\p{N}_-]+$/u.test(slug) || !validSequence(sequence)) return null;
    return `/novel/${encodeURIComponent(slug)}/${sequence}`;
  }
  function decision(current, next, sequence) {
    if (!validSequence(current) || !validSequence(sequence)) return 'reject';
    if (sequence === current) return 'stay';
    if (sequence < current || (validSequence(next) && next > current && sequence === next)) return 'direct';
    return 'confirm';
  }
  function createJump(current, next, slug, navigate) {
    let phase = 'idle', pending = null, serial = 0;
    function commit(href) { phase = 'navigating'; pending = null; navigate(href); }
    return Object.freeze({
      select(sequence) {
        if (phase !== 'idle') return {action:'ignore'};
        const href = chapterUrl(slug, sequence);
        const action = href ? decision(current, next, sequence) : 'reject';
        if (action === 'direct') commit(href);
        if (action === 'confirm') { phase = 'confirm'; pending = Object.freeze({action,sequence,href,ticket:++serial}); return pending; }
        return {action};
      },
      cancel() { if (phase === 'confirm') { pending = null; phase = 'idle'; serial++; } },
      confirm(ticket) {
        if (phase !== 'confirm' || pending.ticket !== ticket) return false;
        commit(pending.href); return true;
      },
      reset() { phase = 'idle'; pending = null; serial++; },
    });
  }
  // Node tests execute the same production policy/state machine without emulating the browser DOM.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {validSequence,chapterUrl,decision,createJump}; return;
  }
  const dialog = document.getElementById('reader-toc');
  const triggers = Array.from(document.querySelectorAll('[data-reader-toc-open]'));
  if (!dialog || !triggers.length || typeof dialog.showModal !== 'function' || dialog.dataset.tocReady) return;
  dialog.dataset.tocReady = 'true';
  const close = document.getElementById('reader-toc-close');
  const list = document.getElementById('reader-toc-list');
  const status = document.getElementById('reader-toc-status');
  const retry = document.getElementById('reader-toc-retry');
  const pageLabel = document.getElementById('reader-toc-page');
  const totalLabel = document.getElementById('reader-toc-total');
  const pageForm = document.getElementById('reader-toc-page-form');
  const pageInput = document.getElementById('reader-toc-page-input');
  const pageGo = document.getElementById('reader-toc-page-go');
  const buttons = Array.from(dialog.querySelectorAll('[data-toc-page]'));
  const current = Number(dialog.dataset.sequence);
  const next = Number(dialog.dataset.nextSequence);
  const browse = document.getElementById('reader-toc-browse');
  const confirmation = document.getElementById('reader-jump-confirmation');
  const jumpTitle = document.getElementById('reader-jump-title');
  const jumpTarget = document.getElementById('reader-jump-target');
  const jumpCancel = document.getElementById('reader-jump-cancel');
  const jumpContinue = document.getElementById('reader-jump-continue');
  const initialPage = Number(dialog.dataset.initialPage);
  const pageSize = 50;
  class TocError extends Error {}
  let target = initialPage, totalPages = null, serial = 0;
  let controller = null, timer = null, cached = null;
  let savedOverflow = '', savedScroll = 0;
  let modalActive = false;
  let opener = null;
  let pendingJump = null, selectedControl = null, listScroll = 0;
  const jump = createJump(current, next, dialog.dataset.slug, href => {
    closeDrawer();
    window.location.assign(href);
  });

  function clearConfirmation(restoreFocus = false) {
    const control = selectedControl;
    jump.cancel(); pendingJump = null; selectedControl = null;
    confirmation.hidden = true; browse.hidden = false;
    dialog.setAttribute('aria-labelledby', 'reader-toc-title');
    dialog.removeAttribute('aria-describedby');
    if (restoreFocus) {
      list.scrollTop = listScroll;
      (control?.isConnected ? control : close).focus({preventScroll:true});
    }
  }
  function selectChapter(event, item, control) {
    // Modified/middle clicks keep native anchor behavior. This dialog is UX, not authorization.
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const result = jump.select(item.chapter_sequence);
    if (result.action === 'stay') closeDrawer();
    if (result.action !== 'confirm') return;
    pendingJump = result; selectedControl = control; listScroll = list.scrollTop;
    jumpTitle.textContent = `Chuyển đến ${item.chapter_number}?`;
    jumpTarget.textContent = item.title;
    browse.hidden = true; confirmation.hidden = false;
    dialog.setAttribute('aria-labelledby', 'reader-jump-title');
    dialog.setAttribute('aria-describedby', 'reader-jump-message');
    jumpCancel.focus({preventScroll:true});
  }

  function cancel() {
    serial++;
    controller?.abort();
    controller = null;
    clearTimeout(timer);
    timer = null;
    dialog.dispatchEvent(new CustomEvent('reader:toc-completion-page', {detail: []}));
  }
  function controls() {
    const unavailable = !totalPages;
    for (const button of buttons) {
      const before = ['first', 'previous'].includes(button.dataset.tocPage);
      button.disabled = unavailable || (before ? target <= 1 : target >= totalPages);
    }
    pageInput.disabled = pageGo.disabled = unavailable;
    pageInput.max = String(totalPages || 1);
    pageInput.value = String(target);
  }
  function busy(value) {
    list.setAttribute('aria-busy', String(value));
  }
  function valid(data, page) {
    return data && data.page === page && data.page_size === pageSize &&
      Number.isSafeInteger(data.total) && data.total >= 0 &&
      data.total_pages === Math.ceil(data.total / pageSize) &&
      Array.isArray(data.items) && data.items.length <= pageSize &&
      data.items.every((item, index) => Number.isInteger(item.chapter_sequence) &&
        validSequence(item.chapter_sequence) && chapterUrl(dialog.dataset.slug, item.chapter_sequence) && typeof item.title === 'string' &&
        typeof item.chapter_number === 'string' &&
        (index === 0 || item.chapter_sequence > data.items[index - 1].chapter_sequence));
  }
  function render(data) {
    target = data.page;
    totalPages = data.total_pages;
    totalLabel.textContent = `Tổng số: ${data.total} chương`;
    pageLabel.textContent = `Trang ${totalPages ? target : 0}/${totalPages}`;
    status.textContent = data.items.length ? '' : 'Chưa có chương trong trang này.';
    list.replaceChildren();
    const completionRows = [];
    for (const item of data.items) {
      const row = document.createElement('li');
      row.dataset.sequence = String(item.chapter_sequence);
      const control = document.createElement(item.chapter_sequence === current ? 'button' : 'a');
      control.className = 'reader-toc-chapter';
      if (item.chapter_sequence === current) { control.type = 'button'; control.setAttribute('aria-current', 'page'); }
      else control.href = chapterUrl(dialog.dataset.slug, item.chapter_sequence);
      const number = document.createElement('span');
      number.className = 'reader-toc-number';
      number.textContent = item.chapter_number;
      const title = document.createElement('span');
      title.className = 'reader-toc-title';
      title.textContent = item.title;
      control.append(number, title);
      control.addEventListener('click', event => selectChapter(event, item, control));
      row.append(control);
      if (item.chapter_sequence === current) row.setAttribute('aria-current', 'page');
      list.append(row);
      completionRows.push({id: item.id, number});
    }
    controls();
    list.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
    dialog.dispatchEvent(new CustomEvent('reader:toc-completion-page', {detail: completionRows}));
  }

  async function load(page, correctRange = true) {
    if (!dialog.open) return;
    page = Math.max(1, Math.min(page, totalPages || page));
    if (!Number.isSafeInteger(page) || (controller && target === page)) return;
    cancel();
    const version = serial;
    target = page;
    retry.hidden = true;
    if (cached?.page === page) { render(cached); busy(false); return; }
    const request = new AbortController();
    controller = request;
    let timedOut = false;
    timer = setTimeout(() => { timedOut = true; request.abort(); }, 15000);
    busy(true);
    list.replaceChildren();
    status.textContent = 'Đang tải mục lục...';
    pageLabel.textContent = `Đang tải trang ${page}...`;
    controls();
    try {
      const url = `/api/novels/${encodeURIComponent(dialog.dataset.slug)}/chapters?page=${page}&page_size=${pageSize}`;
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: request.signal });
      if (version !== serial || !dialog.open) return;
      if (!response.ok) {
        const messages = { 404: 'Không tìm thấy mục lục truyện.', 422: 'Trang mục lục không hợp lệ.', 503: 'Mục lục tạm thời không khả dụng.' };
        throw new TocError(messages[response.status] || 'Không thể tải mục lục.');
      }
      const data = await response.json();
      if (version !== serial || !dialog.open) return;
      if (!valid(data, page)) throw new TocError('Dữ liệu mục lục không hợp lệ.');
      if (page > Math.max(1, data.total_pages) && correctRange) {
        totalPages = data.total_pages;
        controller = null;
        await load(Math.max(1, data.total_pages), false);
        return;
      }
      // Keep just the last successful page, never accumulate the whole TOC.
      cached = data;
      render(data);
    } catch (error) {
      if (version !== serial || !dialog.open) return;
      status.textContent = timedOut ? 'Tải mục lục quá thời gian chờ. Vui lòng thử lại.'
        : error.name === 'AbortError' ? 'Đã hủy tải mục lục. Vui lòng thử lại.'
        : error instanceof TocError ? error.message : 'Không thể tải mục lục. Vui lòng kiểm tra kết nối và thử lại.';
      retry.hidden = false;
    } finally {
      if (version === serial) {
        clearTimeout(timer);
        controller = null;
        busy(false);
      }
    }
  }
  function expanded(value) { for (const trigger of triggers) trigger.setAttribute('aria-expanded', String(value)); }
  for (const trigger of triggers) {
    trigger.disabled = false;
    trigger.addEventListener('click', () => {
      if (dialog.open) return;
      opener = trigger;
      jump.reset(); clearConfirmation();
      savedScroll = window.scrollY;
      savedOverflow = document.documentElement.style.overflow;
      modalActive = true;
      dialog.showModal();
      document.documentElement.style.overflow = 'hidden';
      expanded(true);
      close.focus({ preventScroll: true });
      load(initialPage);
    });
  }
  function restoreReader() {
    // A queued close event from an earlier opening must not cancel a reopened drawer.
    if (!modalActive || dialog.open) return;
    modalActive = false;
    clearConfirmation();
    cancel();
    busy(false);
    document.documentElement.style.overflow = savedOverflow;
    expanded(false);
    const available = trigger => trigger?.isConnected && !trigger.disabled && !trigger.hidden && trigger.getClientRects().length && getComputedStyle(trigger).visibility !== 'hidden';
    const focusTarget = available(opener) ? opener : triggers.find(available) || document.getElementById('reader-chapter-title');
    if (focusTarget) {
      if (!focusTarget.matches('button')) focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus({ preventScroll: true });
    }
    window.scrollTo(0, savedScroll);
  }
  function closeDrawer() { dialog.close(); restoreReader(); }
  close.addEventListener('click', closeDrawer);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (pendingJump) clearConfirmation(true); else closeDrawer(); });
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) {
      if (pendingJump) clearConfirmation(true); else closeDrawer();
    }
  });
  dialog.addEventListener('close', restoreReader);
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialog.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled)')).filter(el => el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  for (const button of buttons) button.addEventListener('click', () => {
    const page = { first: 1, previous: target - 1, next: target + 1, last: totalPages }[button.dataset.tocPage];
    load(page);
  });
  pageForm.addEventListener('submit', event => {
    event.preventDefault();
    if (pageForm.reportValidity()) load(Number(pageInput.value));
  });
  retry.addEventListener('click', () => { cached = null; load(target); });
  jumpCancel.addEventListener('click', () => clearConfirmation(true));
  jumpContinue.addEventListener('click', () => { if (pendingJump) jump.confirm(pendingJump.ticket); });
  window.addEventListener('pageshow', () => jump.reset());
  window.addEventListener('pagehide', () => {
    if (dialog.open) closeDrawer();
    cancel();
    document.documentElement.style.overflow = savedOverflow;
  });
})();
