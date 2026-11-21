/* Theme controls share the validated preference state; menu/focus handling remains local. */
(() => {
  'use strict';
  const root = document.querySelector('.reader-page');
  const selector = document.getElementById('reader-theme-selector');
  const trigger = document.getElementById('reader-theme-trigger');
  const preferences = window.ReadNovelReaderPreferences;
  if (!root || !selector || !trigger || !preferences || selector.dataset.themeReady) return;
  selector.dataset.themeReady = 'true';
  const choices = Array.from(selector.querySelectorAll('input[name="reader-theme"]'));
  function sync(state) {
    for (const choice of choices) choice.checked = choice.value === state.theme;
  }
  function close(restoreFocus) {
    selector.open = false;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
  function change(event) {
    const value = event.target.value;
    if (!choices.includes(event.target)) return;
    preferences.update('theme',value);
    sync(preferences.snapshot());
  }
  selector.addEventListener('change', change);
  selector.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(selector.open)));
  selector.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selector.open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  });
  selector.addEventListener('focusout', event => {
    // Clicking label text temporarily blurs the summary to body before the label
    // focuses its radio on mouseup. A null destination must not close it mid-click.
    if (selector.open && event.relatedTarget && !selector.contains(event.relatedTarget)) close(false);
  });
  document.addEventListener('pointerdown', event => {
    if (selector.open && !selector.contains(event.target)) close(selector.contains(document.activeElement));
  });
  window.addEventListener('pagehide', () => close(selector.contains(document.activeElement)));
  preferences.subscribe(sync);
  // Content and sepia colors already render without JS; show the now-functional control.
  selector.hidden = false;
})();
