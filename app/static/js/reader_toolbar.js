/* Next.js smart-header thresholds only; no progress, auth or storage work here. */
(() => {
  'use strict';
  const toolbar = document.getElementById('reader-toolbar');
  const dialog = document.getElementById('reader-toc');
  const trigger = document.getElementById('reader-toc-open');
  const themeSelector = document.getElementById('reader-theme-selector');
  const accountMenu = document.getElementById('reader-account-menu');
  if (!toolbar || !dialog || !trigger) return;
  let lastY = Math.max(0, window.scrollY);
  let desiredVisible = true;
  let frame = null;
  let listening = false;

  function pinned() {
    return dialog.open || themeSelector?.open || accountMenu?.open ||
      trigger.getAttribute('aria-expanded') === 'true' || toolbar.contains(document.activeElement);
  }
  function paint() {
    frame = null;
    if (pinned() || window.scrollY <= 120) desiredVisible = true;
    const hidden = !desiredVisible;
    if (toolbar.classList.contains('is-hidden') !== hidden) toolbar.classList.toggle('is-hidden', hidden);
  }
  function schedule() {
    if (frame === null) frame = requestAnimationFrame(paint);
  }
  function show() {
    desiredVisible = true;
    lastY = Math.max(0, window.scrollY);
    // Reveal immediately for focus and TOC restoration, without moving document flow.
    toolbar.classList.remove('is-hidden');
  }
  function scroll() {
    const y = Math.max(0, window.scrollY);
    if (pinned() || y <= 120) desiredVisible = true;
    else if (y > lastY + 10) desiredVisible = false;
    else if (y < lastY - 10) desiredVisible = true;
    lastY = y;
    schedule();
  }
  const observer = new MutationObserver(() => { if (pinned()) show(); });
  toolbar.addEventListener('focusin', show);
  function start() {
    if (listening) return;
    listening = true;
    observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
    observer.observe(trigger, { attributes: true, attributeFilter: ['aria-expanded'] });
    if (themeSelector) observer.observe(themeSelector, { attributes: true, attributeFilter: ['open'] });
    if (accountMenu) observer.observe(accountMenu, { attributes: true, attributeFilter: ['open'] });
    window.addEventListener('scroll', scroll, { passive: true });
    show();
  }
  window.addEventListener('pagehide', () => {
    listening = false;
    window.removeEventListener('scroll', scroll);
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  });
  window.addEventListener('pageshow', start);
  start();
})();
