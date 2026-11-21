/* Typography controls use the same validated preference state as early restore and theme controls. */
(() => {
  'use strict';
  const root = document.querySelector('.reader-page');
  const controls = document.getElementById('reader-typography-controls');
  const preferences = window.ReadNovelReaderPreferences;
  if (!root || !controls || !preferences || controls.dataset.settingsReady) return;
  const sizeValue = document.getElementById('reader-font-size-value');
  const heightValue = document.getElementById('reader-line-height-value');
  const decrease = document.getElementById('reader-font-size-decrease');
  const increase = document.getElementById('reader-font-size-increase');
  if (!sizeValue || !heightValue || !decrease || !increase) return;
  const groups = [
    ['reader-font-family', 'fontFamily'],
    ['reader-line-height', 'lineHeight'],
    ['reader-reading-width', 'readingWidth'],
  ].map(([name, key]) => [Array.from(controls.querySelectorAll(`input[name="${name}"]`)), key]);
  if (groups.some(([choices]) => !choices.length)) return;
  controls.dataset.settingsReady = 'true';

  function sync(state) {
    for (const [choices, key] of groups) {
      for (const choice of choices) choice.checked = choice.value === String(state[key]);
    }
    sizeValue.textContent = `${state.fontSize}px`;
    heightValue.textContent = String(state.lineHeight);
    decrease.disabled = state.fontSize === preferences.limits.min;
    increase.disabled = state.fontSize === preferences.limits.max;
  }
  controls.addEventListener('change', event => {
    const group = groups.find(([choices]) => choices.includes(event.target));
    if (!group) return;
    const [, key] = group;
    const value = event.target.value;
    preferences.update(key,key==='lineHeight' ? Number(value) : value);
    sync(preferences.snapshot());
  });
  controls.addEventListener('click', event => {
    const button = event.target.closest('button[data-reader-size-step]');
    if (button !== decrease && button !== increase) return;
    const delta = Number(button.dataset.readerSizeStep);
    if (!Number.isFinite(delta) || ![-1, 1].includes(delta)) return;
    preferences.adjustSize(delta);
  });
  preferences.subscribe(sync);
  controls.hidden = false;
})();
