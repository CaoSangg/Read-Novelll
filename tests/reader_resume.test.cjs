const test = require('node:test');
const assert = require('node:assert/strict');
const {contentRange, contentFraction, createController, resumeSnapshot, requestLogout, createAccountMenu} =
  require('../app/static/js/reader_resume.js');

const chapter = {
  novelId: '10000000-0000-0000-0000-000000000000',
  id: '20000000-0000-0000-0000-000000000000',
  revision: {scheme: 'sha256-utf8-raw-v1', hash: 'a'.repeat(64)},
};
const owner = '30000000-0000-0000-0000-000000000000';
const other = '40000000-0000-0000-0000-000000000000';
const epoch = '50000000-0000-0000-0000-000000000000';
const etag = revision => '"' + chapter.id + ':' + revision + '"';
const target = (id = chapter.id, position = .4) => ({
  available: true, chapter_id: id, url: '/novel/fixture/10', scroll_position: position,
  content_revision: chapter.revision,
});
const progress = (resume = null, version = null) => ({
  novel_id: chapter.novelId, resume, resume_etag: version,
});
const saved = revision => ({resume_etag: etag(revision), writer_epoch: epoch});
const response = (status, data) => ({status, ok: status >= 200 && status < 300, json: async () => data});

test('Account disclosure removes the previous identity during verification and separates Guest from Auth', () => {
  const doc = new EventTarget();
  doc.defaultView = new EventTarget();
  doc.visibilityState = 'visible';
  const trigger = {focus:()=>{doc.activeElement=trigger;},setAttribute() {}};
  const signOut = {};
  const guest = {contains:()=>false}, auth = {contains:node=>node===signOut};
  const state = new Map([
    ['summary',trigger],['[data-reader-account-guest]',guest],['[data-reader-account]',auth],
    ['[data-reader-account-unknown]',{}],['[data-reader-account-name]',{}],
  ]);
  const menu = new EventTarget();
  menu.ownerDocument = doc;
  menu.querySelector = selector=>state.get(selector);
  const view = createAccountMenu(menu);
  const name = state.get('[data-reader-account-name]');
  view.show(null);
  assert.equal(guest.hidden,false);
  assert.equal(auth.hidden,true);
  view.show(owner,'Alice');
  assert.equal(name.textContent,'Alice');
  assert.equal(guest.hidden,true);
  doc.activeElement=signOut;
  view.show(undefined);
  assert.equal(auth.hidden,true);
  assert.equal(name.textContent,'');
  assert.equal(doc.activeElement,trigger);
  view.show(other,'Bob');
  assert.equal(name.textContent,'Bob');
  assert.equal(state.get('[data-reader-account-unknown]').hidden,true);
});

test('Reader logout uses POST, same-origin session and CSRF with a bounded request', async () => {
  const calls = [];
  const request = async (url,options) => {calls.push({url,options}); return {status:200};};
  assert.equal(await requestLogout(request,'X-CSRF-Token','fixture-csrf'),200);
  assert.equal(calls.length,1);
  const {signal,...options} = calls[0].options;
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual({url:calls[0].url,options},{
    url:'/api/auth/logout',options:{method:'POST',cache:'no-store',credentials:'same-origin',
      redirect:'error',headers:{'X-CSRF-Token':'fixture-csrf'}},
  });
});

test('Reader logout preserves invalid-CSRF and expired responses and fails closed without a token', async () => {
  for (const code of [403,401,503]) {
    assert.equal(await requestLogout(async()=>({status:code}),'X-CSRF-Token','fixture-csrf'),code);
  }
  assert.equal(await requestLogout(async()=>{throw Error('network');},'X-CSRF-Token','fixture-csrf'),0);
  let sent = false;
  assert.equal(await requestLogout(async()=>{sent=true;},'X-CSRF-Token',null),0);
  assert.equal(sent,false);
});

function setup({hint = true, visible = true, csrf = 'mock-token'} = {}) {
  let last;
  let position = 0;
  let handoff = null;
  const requests = [], queue = [], restores = [], timers = new Map();
  let nextTimer = 0;
  const controller = createController({
    chapter, csrfHeader: 'X-CSRF-Token', sessionHint: hint, readCsrf: () => csrf,
    request: async (path, options) => {
      requests.push({path, options, body: options.body ? JSON.parse(options.body) : null});
      const next = queue.shift();
      if (!next) throw Error('Unexpected request');
      return typeof next === 'function' ? next() : next;
    },
    clock: {
      setTimeout(callback, delay) { timers.set(++nextTimer, {callback, delay}); return nextTimer; },
      clearTimeout(id) { timers.delete(id); },
    },
    view: {
      foreground: () => visible, position: () => position,
      restore(value) { restores.push(value); position = value; return value; },
      paint(state) { last = state; },
      rememberHandoff(id, value) { handoff = {id, value}; },
      takeHandoff(id) {
        const value = handoff?.id === id ? handoff.value : null;
        handoff = null;
        return value;
      },
      clearHandoff() { handoff = null; },
    },
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return {
    controller, requests, restores, timers, tick, queue,
    last: () => last, show: value => { visible = value; },
    setCsrf: value => { csrf = value; },
    setPosition: value => { position = value; },
    setHandoff: (id, value) => { handoff = {id, value}; },
    getHandoff: () => handoff,
    reply(status, data) { queue.push(response(status, data)); },
    defer() {
      let resolve;
      queue.push(new Promise(done => { resolve = done; }));
      return (status, data) => resolve(response(status, data));
    },
    async fire() {
      for (const [id, {callback, delay}] of timers) {
        assert.equal(delay, 5000);
        timers.delete(id);
        callback();
      }
      await tick();
    },
  };
}

async function initial(harness, resume = null, version = null) {
  harness.reply(200, {id: owner});
  harness.reply(200, progress(resume, version));
  harness.reply(version ? 200 : 201, saved(1));
  await harness.controller.start(true);
}

test('passive Auth return uses the account snapshot without adopting scroll or a stale handoff', async () => {
  const h = setup();
  h.setPosition(.73);
  h.setHandoff(other, target(chapter.id,.9));
  h.reply(200,{id:owner});
  h.reply(200,progress(target(chapter.id,.31),etag(4)));
  await h.controller.start(false);
  h.controller.note(.8);
  await h.fire();
  assert.deepEqual(h.requests.map(r=>r.path),['/api/auth/me','/api/progress/novels/'+chapter.novelId]);
  assert.equal(h.last().target.scroll_position,.31);
  assert.equal(h.getHandoff(),null);
  assert.deepEqual(h.restores,[]);
  assert.equal(h.last().canActivate,true);
});

test('empty Auth return waits for an explicit save in the current chapter under create CAS', async () => {
  const h = setup();
  h.reply(200,{id:owner});
  h.reply(200,progress());
  await h.controller.start(false);
  assert.equal(h.last().target,null);
  assert.equal(h.requests.length,2);
  h.setPosition(0);
  h.reply(201,saved(1));
  await h.controller.deliberateActivate();
  const write = h.requests.at(-1);
  assert.equal(write.options.headers['If-None-Match'],'*');
  assert.equal(write.body.chapter_id,chapter.id);
  assert.equal(write.body.scroll_position,0);
});

test('content geometry excludes header and footer, clamps and handles a short chapter', () => {
  const range = contentRange({top: 248, height: 2000, viewport: 800, inset: 48});
  assert.deepEqual(range, {start: 200, span: 1248});
  for (const [scroll, fraction] of [[0,0],[200,0],[824,.5],[1448,1],[1800,1]]) {
    assert.equal(contentFraction(range, scroll), fraction);
  }
  assert.equal(contentFraction(contentRange({top: 300, height: 40, viewport: 800, inset: 48}), 400), 0);
  assert.equal(contentRange({top: 200, height: NaN, viewport: 800, inset: 48}), null);
  assert.equal(contentRange({top: 200, height: 40, viewport: 40, inset: 48}), null);
  assert.equal(contentFraction(range, Infinity), null);
  const resized = contentRange({top: 290, height: 3800, viewport: 500, inset: 52});
  assert.equal(contentFraction(resized, resized.start + resized.span * .5), .5);
});

test('Resume target allows a valid reader path only', () => {
  assert.ok(resumeSnapshot({...target(), url: '/novel/Truy%E1%BB%87n/1'}));
  for (const url of ['//offsite.test/novel/x/1', '/novel/%2e%2e/1', '/novel/foo%2Fbar/1',
    '/novel/fixture/1#other','/novel/fixture/0']) assert.equal(resumeSnapshot({...target(), url}), null);
  assert.equal(resumeSnapshot({...target(), available: false}), null);
});

test('guest and expired session never call authenticated progress', async () => {
  const guest = setup({hint: false});
  await guest.controller.start(true);
  assert.equal(guest.requests.length, 0);
  const expired = setup();
  expired.reply(401, {});
  await expired.controller.start(true);
  assert.deepEqual(expired.requests.map(x => x.path), ['/api/auth/me']);
  assert.equal(expired.last(), null);
});

test('GET precedes activate and picks the right creation or update precondition', async () => {
  for (const version of [null, etag(12)]) {
    const h = setup();
    const old = version ? target(other) : null;
    h.reply(200, {id: owner});
    h.reply(200, progress(old, version));
    const activate = h.defer();
    const started = h.controller.start(true);
    await h.tick();
    const [me, read, write] = h.requests;
    assert.equal(me.path, '/api/auth/me');
    assert.equal(read.options.method, undefined);
    assert.equal(write.options.method, 'POST');
    assert.equal(write.options.headers['X-CSRF-Token'], 'mock-token');
    assert.deepEqual(Object.keys(write.options.headers).slice(2), [version ? 'If-Match' : 'If-None-Match']);
    assert.equal(write.options.headers[version ? 'If-Match' : 'If-None-Match'], version || '*');
    assert.deepEqual(write.body, {chapter_id: chapter.id, content_revision: chapter.revision, scroll_position: 0});
    if (old) assert.equal(h.last().target.chapter_id, other);
    activate(200, saved(13));
    await started;
    assert.equal(h.last().target?.chapter_id, old?.chapter_id);
  }
});

test('same-chapter snapshot survives reload and restores only on explicit choice', async () => {
  const h = setup();
  await initial(h, target(), etag(0));
  assert.equal(h.requests.at(-1).body.scroll_position, .4);
  assert.deepEqual(h.restores, []);
  assert.deepEqual(h.controller.follow(), {allowLink: false});
  assert.deepEqual(h.restores, [.4]);
  assert.equal(h.timers.size, 0);
});

test('cross-chapter handoff is consumed by the same account and old revisions open at zero', async () => {
  const from = setup();
  await initial(from, target(other), etag(0));
  assert.deepEqual(from.controller.follow(), {allowLink: true});
  assert.equal(from.getHandoff().id, owner);
  assert.equal(from.getHandoff().value.chapter_id, other);
  for (const [id, contentRevision, expected] of [
    [owner, chapter.revision, [.6]], [owner, {...chapter.revision, hash: 'b'.repeat(64)}, [0]],
    [other, chapter.revision, []],
  ]) {
    const h = setup();
    h.setHandoff(id, {...target(chapter.id, .6), content_revision: contentRevision});
    await initial(h);
    assert.deepEqual(h.restores, expected);
    assert.equal(h.requests.at(-1).body.scroll_position, expected[0] || 0);
    assert.equal(h.getHandoff(), null);
  }
});

test('accepted handoff stays at its destination, while a rejected activation keeps the server choice', async () => {
  for (const accepted of [true,false]) {
    const h = setup();
    h.setHandoff(owner,target(chapter.id,.6));
    h.reply(200,{id:owner});
    h.reply(200,progress(target(other,0),etag(1)));
    if (accepted) h.reply(200,{...saved(2),resume:target(chapter.id,.6)});
    else {
      h.reply(412,{});
      h.reply(200,progress(target(other,0),etag(2)));
    }
    await h.controller.start(true);
    assert.equal(h.requests[2].options.headers['If-Match'],etag(1));
    assert.equal(h.last().target.chapter_id,accepted ? chapter.id : other);
    assert.equal(h.controller.follow().allowLink,!accepted);
    assert.deepEqual(h.restores,accepted ? [.6,.6] : [.6]);
  }
});

test('dirty debounce sends one in-flight PUT and carries forward the accepted ETag', async () => {
  const h = setup();
  await initial(h);
  for (const invalid of [0, -1, 1.1, NaN, Infinity, '0.2']) h.controller.note(invalid);
  assert.equal(h.timers.size, 0);
  for (const value of [.1, .2, .2, .3]) h.controller.note(value);
  assert.equal(h.timers.size, 1);
  const commit = h.defer();
  await h.fire();
  assert.equal(h.requests.at(-1).body.scroll_position, .3);
  h.controller.note(.9);
  h.controller.note(1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.filter(x => x.options.method === 'PUT').length, 1);
  commit(200, {resume_etag: etag(2)});
  await h.tick();
  h.reply(200, {resume_etag: etag(3)});
  await h.fire();
  assert.equal(h.requests.at(-1).options.headers['If-Match'], etag(2));
  assert.equal(h.requests.at(-1).body.scroll_position, 1);
  assert.equal(h.requests.at(-1).body.writer_epoch, epoch);
  h.controller.note(1);
  assert.equal(h.timers.size, 0);
});

test('409 and 412 stop the old writer, GET reconcile permits only a fresh deliberate action', async () => {
  for (const code of [409, 412]) {
    const h = setup();
    await initial(h);
    h.controller.note(.3);
    h.reply(code, {});
    h.reply(200, progress(target(other), etag(9)));
    await h.fire();
    assert.equal(h.last().canActivate, true);
    assert.equal(h.last().target.chapter_id, other);
    h.controller.note(.8);
    h.controller.foreground();
    await h.fire();
    assert.equal(h.requests.length, 5);
    h.setPosition(.7);
    h.reply(200, saved(10));
    await h.controller.deliberateActivate();
    assert.equal(h.requests.at(-1).options.method, 'POST');
    assert.equal(h.requests.at(-1).options.headers['If-Match'], etag(9));
    assert.equal(h.requests.at(-1).body.scroll_position, .7);
  }
});

test('initial activate race and content conflict never silently replay', async () => {
  for (const [status, data] of [[412, {}], [409, {detail: {code: 'content_revision_changed'}}]]) {
    const h = setup();
    h.reply(200, {id: owner});
    h.reply(200, progress());
    h.reply(status, data);
    h.reply(200, progress(target(other), etag(3)));
    await h.controller.start(true);
    h.controller.note(.8);
    await h.fire();
    assert.equal(h.requests.length, 4);
    assert.equal(h.requests.at(-1).options.method, undefined);
    assert.equal(h.last().canActivate, status === 412);
  }
});

test('missing CSRF, rejected CSRF, expired session and lost network stop mutation', async () => {
  const missing = setup({csrf: null});
  await initial(missing);
  assert.equal(missing.requests.length, 2);
  for (const status of [401, 403, 503, 0]) {
    const h = setup();
    await initial(h, target(), etag(0));
    h.controller.note(.4);
    h.controller.note(.9);
    if (status) h.reply(status, {});
    else h.queue.push(() => Promise.reject(new Error('offline')));
    await h.fire();
    h.controller.note(.3);
    await h.fire();
    assert.equal(h.requests.filter(x => x.options.method === 'PUT').length, 1);
    if (status === 401) assert.equal(h.last(), null);
    else assert.equal(h.last().canActivate, status !== 403);
  }
});

test('hidden start and BFCache restore read state without automatic activation', async () => {
  const h = setup({visible: false});
  await h.controller.start(true);
  assert.equal(h.requests.length, 0);
  h.show(true);
  h.reply(200, {id: owner});
  h.reply(200, progress(target(), etag(0)));
  await h.controller.foreground();
  assert.equal(h.requests.length, 2);
  h.reply(200, saved(1));
  await h.controller.deliberateActivate();
  h.controller.note(.7);
  h.show(false);
  h.reply(200, {resume_etag: etag(2)});
  h.controller.hide();
  h.controller.leave();
  assert.equal(h.requests.filter(x => x.options.method === 'PUT').length, 1);
  assert.equal(h.requests.at(-1).options.keepalive, true);
  assert.equal(h.requests.at(-1).options.headers['X-CSRF-Token'], 'mock-token');
  h.show(true);
  h.reply(200, {id: owner});
  h.reply(200, progress(target(), etag(2)));
  await h.controller.foreground();
  assert.deepEqual(h.requests.slice(-2).map(x => x.options.method), [undefined, undefined]);
  assert.equal(h.last().canActivate, true);
});

test('account change clears private UI and pending writes before a response can be applied', async () => {
  const h = setup();
  await initial(h, target(other), etag(0));
  h.controller.note(.3);
  const reply = h.defer();
  await h.fire();
  h.controller.note(.8);
  h.setCsrf('rotated-for-another-account');
  h.controller.checkAccount();
  reply(200, {resume_etag: etag(3)});
  await h.tick();
  assert.equal(h.last(), null);
  await h.controller.foreground();
  await h.fire();
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.controller.follow(), {allowLink: false});
});
