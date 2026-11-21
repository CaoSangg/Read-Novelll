const test = require('node:test');
const assert = require('node:assert/strict');
const {createStore, createGuestController} = require('../app/static/js/reader_guest_progress.js');
const {createGuestStore} = require('../app/static/js/reader_bookmarks.js');

const novelId = '10000000-0000-0000-0000-000000000000';
const chapter50 = '20000000-0000-0000-0000-000000000050';
const chapter100 = '20000000-0000-0000-0000-000000000100';
const key = 'readnovel.progress.guest.v1.' + novelId;
const revision = {scheme:'sha256-utf8-raw-v1', hash:'a'.repeat(64)};
const changedRevision = {...revision, hash:'b'.repeat(64)};
const resume = (chapter_id = chapter100, scroll_position = .42, content_revision = revision) =>
  ({chapter_id, scroll_position, content_revision});
const url = sequence => '/novel/story/' + sequence;
const confirmedAt = '2000-01-01T01:02:03.000Z';

function environment() {
  const values = new Map();
  let failure = '', writes = 0, generation = 0;
  const backend = {
    getItem: name => values.get(name) ?? null,
    setItem(name, value) {
      if (failure === 'quota') throw new DOMException('Storage full', 'QuotaExceededError');
      values.set(name, value);
      writes++;
    },
    removeItem: name => values.delete(name),
  };
  function store() {
    return createStore(novelId, () => {
      if (failure === 'security') throw new DOMException('Storage blocked', 'SecurityError');
      return backend;
    }, () => String(++generation).padStart(32, '0'));
  }
  return {values, store, get writes() { return writes; }, fail:reason => { failure = reason; }};
}

test('strict per-novel schema keeps only IDs, revisions, fractions and client timestamps without expiry or eviction', () => {
  const e = environment(), store = e.store();
  e.values.set('readnovel.progress.guest.v1.other', 'preserve');
  assert.equal(store.read().record.resume, null);
  const result = store.write(store.read(), {resume:resume(),
    completion:{id:chapter100, revision, confirmedAt}});
  assert.deepEqual(result.record, {version:1, novel_id:novelId, generation:null, resume:resume(),
    completions:{[chapter100]:{content_revision:revision, confirmed_at:confirmedAt}}});
  assert.deepEqual(e.store().read().record, result.record);
  assert.equal(e.values.get('readnovel.progress.guest.v1.other'), 'preserve');
  assert.equal(e.writes, 1);
  store.write(store.read(), {resume:resume(), completion:{id:chapter100, revision,
    confirmedAt:new Date().toISOString()}});
  assert.equal(e.writes, 1);
});

test('malformed, oversized and edited records survive rejected writes, including prototype keys', () => {
  const e = environment(), store = e.store();
  const fresh = store.read();
  const valid = store.write(fresh, {resume:resume()}).record;
  for (const raw of [
    '{', 'null', '[]', ' '.repeat(1024 * 1024 + 1),
    JSON.stringify({...valid, version:2}),
    JSON.stringify({...valid, novel_id:chapter50}),
    JSON.stringify({...valid, credentials:'x'}),
    JSON.stringify({...valid, resume:{...resume(), content_revision:{...revision, scheme:'other'}}}),
    JSON.stringify({...valid, resume:resume(chapter100+'\n')}),
    JSON.stringify({...valid, resume:resume('bad-id')}),
    JSON.stringify({...valid, resume:resume(chapter100, -.1)}),
    JSON.stringify({...valid, resume:resume(chapter100, 1.1)}),
    JSON.stringify({...valid, resume:resume(chapter100, '0.5')}),
    JSON.stringify({...valid, resume:resume(chapter100, .2, {...revision, hash:'A'.repeat(64)})}),
    JSON.stringify({...valid, resume:resume()}).replace('0.42', '1e999'),
    JSON.stringify({...valid, completions:{[chapter100]:{content_revision:revision, confirmed_at:'yesterday'}}}),
    JSON.stringify({...valid, completions:JSON.parse('{"__proto__":{}}')}),
    JSON.stringify({...valid, completions:JSON.parse('{"constructor":{}}')}),
  ]) {
    e.values.set(key, raw);
    assert.equal(store.read().kind, 'error');
    assert.equal(store.write(fresh, {resume:resume(chapter50)}).kind, 'error');
    assert.equal(e.values.get(key), raw);
  }
  assert.equal(store.clear().kind, 'ready');
  assert.equal(e.values.has(key), false);
});

test('quota and security failures do not claim a save or a clear', () => {
  const e = environment(), store = e.store();
  const state = store.write(store.read(), {resume:resume()});
  e.fail('quota');
  assert.equal(store.write(state, {resume:resume(chapter50)}).kind, 'error');
  assert.equal(store.clear().kind, 'error');
  assert.deepEqual(store.read().record.resume, resume());
  e.fail('security');
  assert.equal(store.read().kind, 'error');
  assert.equal(store.write(state, {resume:resume(chapter50)}).kind, 'error');
  assert.equal(store.clear().kind, 'error');
});

test('clear owns only this novel and its marker invalidates a racing stale-tab setItem', () => {
  const e = environment(), store = e.store(), oldTab = e.store();
  e.values.set('readnovel.reader.settings', 'untouched');
  const old = oldTab.write(oldTab.read(), {resume:resume()});
  const cleared = store.clear();
  assert.equal(cleared.record.resume, null);
  assert.equal(e.values.has(key), false);
  assert.equal(e.values.get('readnovel.reader.settings'), 'untouched');
  assert.equal(oldTab.write(old, {resume:resume(chapter50)}).kind, 'changed');
  e.values.set(key, old.raw); // Simulate a write already past its last generation check.
  assert.equal(store.read().record.resume, null);
  assert.equal(store.read().record.generation, cleared.record.generation);
  assert.equal(store.write(store.read(), {resume:resume(chapter50)}).record.resume.chapter_id, chapter50);
});

function guest(e, sequence = 100, contentRevision = revision, handoff = {}) {
  const store = e.store(), onChapter = sequence === 100 ? chapter100 : chapter50;
  let shown, completions, position = 0, current = true;
  const timers = new Map(), lookups = [], restores = [];
  let next = 0, lookupStatus = 'ready';
  const controller = createGuestController({store,
    chapter:{novelId, id:onChapter, url:url(sequence), revision:contentRevision},
    isCurrent:() => current,
    lookup:async id => {
      lookups.push(id);
      return {kind:lookupStatus, chapter:{url:url(id === chapter100 ? 100 : 50)}};
    },
    clock:{
      setTimeout(fn, delay) { assert.equal(delay, 5000); timers.set(++next, fn); return next; },
      clearTimeout:id => timers.delete(id),
    },
    view:{
      foreground:() => true,
      position:() => position,
      restore(value) { position = value; restores.push(value); return value; },
      takeHandoff(owner) {
        const item = handoff[owner];
        delete handoff[owner];
        return item;
      },
      rememberHandoff(owner, value) { handoff[owner] = value; },
      paint:state => { shown = state; },
      completions:claims => { completions = claims; },
    },
  });
  return {store, controller, lookups, restores, shown:() => shown, claims:() => completions,
    pending:() => timers.size, tick:() => { for (const task of [...timers.values()]) task(); },
    move:amount => { position = amount; controller.note(amount); },
    unavailable:() => { lookupStatus = 'missing'; }, endScope:() => { current = false; },
  };
}

test('Guest coalesces scroll, dirty-checks, reloads the fraction and can move back to chapter 50', () => {
  const e = environment(), first = guest(e);
  first.controller.start(true);
  assert.deepEqual(first.store.read().record.resume, resume(chapter100, 0));
  first.move(.1);
  first.move(.4);
  first.move(.42);
  assert.equal(first.pending(), 1);
  assert.equal(e.writes, 1);
  first.tick();
  first.move(.42);
  assert.equal(first.pending(), 0);
  assert.equal(e.writes, 2);
  const reload = guest(e);
  reload.controller.start(true);
  assert.deepEqual(reload.restores, []);
  assert.equal(reload.controller.follow(), false);
  assert.deepEqual(reload.restores, [.42]);
  assert.equal(e.writes, 2);
  const previous = guest(e, 50);
  previous.controller.start(true);
  assert.equal(previous.store.read().record.resume.chapter_id, chapter50);
  assert.deepEqual(previous.claims(), {});
});

test('Guest cross-chapter handoff restores only a matching generation and revision', async () => {
  const e = environment(), handoff = {};
  const store = e.store();
  store.write(store.read(), {resume:resume()});
  const other = guest(e, 50, revision, handoff);
  other.controller.start(true);
  await Promise.resolve();
  assert.deepEqual(other.lookups, [chapter100]);
  assert.equal(other.shown().target.url, url(100));
  assert.equal(other.controller.follow(), true);
  const destination = guest(e, 100, revision, handoff);
  destination.controller.start(true);
  assert.deepEqual(destination.restores, [.42]);
  assert.equal(destination.shown().target.url, url(100));
  assert.equal(destination.controller.follow(), false);
  assert.deepEqual(destination.restores, [.42,.42]);
  const stale = guest(e, 100, changedRevision);
  stale.controller.start(true);
  stale.controller.follow();
  assert.deepEqual(stale.restores, [0]);
  assert.match(stale.shown().status, /không còn khớp/);
  const again = guest(e, 50, revision, handoff);
  again.controller.start(false);
  await Promise.resolve();
  assert.equal(again.controller.follow(), true);
  store.clear();
  const cleared = guest(e, 100, revision, handoff);
  cleared.controller.start(true);
  assert.deepEqual(cleared.restores, []);
});

test('Guest unavailable chapter has no link, BFCache rereads and a stale scope cannot flush', async () => {
  const e = environment(), store = e.store();
  store.write(store.read(), {resume:resume()});
  const tab = guest(e, 50);
  tab.unavailable();
  tab.controller.start(false);
  await Promise.resolve();
  assert.equal(tab.shown().target, null);
  assert.match(tab.shown().status, /không thể mở/);
  tab.move(.2);
  tab.endScope();
  tab.controller.flush();
  assert.deepEqual(store.read().record.resume, resume());
  const restored = guest(e, 50);
  restored.controller.start(false);
  assert.deepEqual(store.read().record.resume, resume());
});

test('two Guest tabs merge distinct claims, drop stale scroll, and ignore pagehide after clear', () => {
  const e = environment(), a = guest(e), b = guest(e, 50);
  a.controller.start(true);
  b.controller.start(false);
  a.move(.66);
  b.move(.21);
  b.tick();
  a.tick(); // Browser has not delivered the storage event yet.
  assert.equal(a.store.read().record.resume.chapter_id, chapter50);
  assert.deepEqual(a.claims(), {});
  a.controller.complete();
  b.controller.complete();
  a.controller.sync();
  assert.deepEqual(Object.keys(a.claims()).sort(), [chapter50, chapter100]);
  const old = a.claims()[chapter100];
  const edited = guest(e, 100, changedRevision);
  edited.controller.start(false);
  assert.deepEqual(edited.claims()[chapter100], old);
  edited.controller.complete();
  assert.deepEqual(edited.claims()[chapter100].content_revision, changedRevision);
  a.move(.8);
  b.controller.clear();
  a.controller.flush();
  assert.equal(a.store.read().record.resume, null);
  assert.deepEqual(a.store.read().record.completions, {});
});

test('Guest Read Next uses stored Resume independently of the highest Completion and Bookmark', async () => {
  const e = environment();
  const high = guest(e,100);
  high.controller.start(false);
  high.controller.complete();
  const bookmarks = createGuestStore(novelId,()=>({
    getItem:key=>e.values.get(key) ?? null,
    setItem:(key,value)=>e.values.set(key,value),
  }));
  assert.equal(bookmarks.set(chapter100,true),true);
  const low = guest(e,50);
  low.controller.start(true);
  assert.equal(low.store.read().record.resume.chapter_id,chapter50);
  assert.ok(low.claims()[chapter100]);
  assert.equal(bookmarks.read(chapter100).record.chapter_id,chapter100);
  high.controller.sync();
  await new Promise(setImmediate);
  assert.equal(high.shown().target.url,url(50));
  low.controller.clear();
  assert.equal(low.store.read().record.resume,null);
  assert.deepEqual(low.store.read().record.completions,{});
  assert.equal(bookmarks.read(chapter100).record.chapter_id,chapter100);
});
