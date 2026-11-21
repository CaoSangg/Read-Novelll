const test = require('node:test');
const assert = require('node:assert/strict');
const offlineModule = require('../app/static/js/reader_offline.js');
const {createController:resumeController} = require('../app/static/js/reader_resume.js');
const {createController:completionController} = require('../app/static/js/reader_completion.js');

const uid = number => '00000000-0000-0000-0000-' + String(number).padStart(12,'0');
const owner = uid(1), other = uid(2), novel = uid(3), id = uid(4), epoch = uid(5);
const revision = {scheme:'sha256-utf8-raw-v1',hash:'a'.repeat(64)};
const secondRevision = {...revision,hash:'b'.repeat(64)};
const chapter = {novelId:novel,id,revision};
const tag = number => '"' + uid(6) + ':' + number + '"';
const target = (position, chapterId = id, hash = revision) => ({
  available:true,chapter_id:chapterId,scroll_position:position,content_revision:hash,url:'/novel/story/1',
});
const progress = (number, position, chapterId) => ({
  novel_id:novel,resume_etag:tag(number),resume:target(position,chapterId),
});
const accepted = (number, position) => ({...progress(number,position),writer_epoch:epoch});
const intent = (position, state = 'dirty', attempt = null) => ({
  chapter_id:id,content_revision:revision,scroll_position:position,state,attempt,
});
const tick = () => new Promise(resolve => setImmediate(resolve));

function device() {
  const entries = new Map();
  let blocked = false, quota = false, writes = 0;
  const storage = {
    get length() {return entries.size;},
    key:index=>[...entries.keys()][index] ?? null,
    getItem:key=>entries.get(key) ?? null,
    setItem(key,value) {
      if (quota) throw new DOMException('Full','QuotaExceededError');
      entries.set(key,value);
      writes++;
    },
    removeItem:key=>entries.delete(key),
  };
  const store = (account=owner, novelId=novel) => offlineModule.createStore(account,novelId,() => {
    if (blocked) throw new DOMException('Blocked','SecurityError');
    return storage;
  });
  return {entries, store, count:()=>writes, block:value=>{blocked=value;}, quota:value=>{quota=value;}};
}

function harness({dev=device(), account=owner, knownChapter=chapter, merge, completion=false,
                  csrfSeed='captured-csrf'} = {}) {
  const store = dev.store(account);
  const calls = [], responses = [], timers = new Map();
  let sequence = 20, connected = true, verified = true, active = true, visible = true, csrf = csrfSeed, position = 0;
  let status, unauthorized = 0;
  const memory = {
    store, owner:account, newId:()=>uid(sequence++), online:()=>connected, canWrite:()=>verified, confirmDiscard:()=>true,
    observedWrite:offlineModule.observedWrite,
  };
  const shared = {
    chapter:knownChapter, sessionHint:true, verifiedOwner:account, csrfHeader:'X-CSRF-Token',
    offline:memory, onUnauthorized:()=>{unauthorized++;},
    isCurrent:()=>active, readCsrf:()=>csrf, merge,
    async request(path,options) {
      calls.push({path,options,body:options?.body && JSON.parse(options.body)});
      const answer = responses.shift();
      if (typeof answer === 'function') return answer();
      if (!answer) return Promise.reject(new Error('Unexpected request'));
      return {status:answer[0],ok:answer[0]>=200 && answer[0]<300,json:async()=>answer[1]};
    },
  };
  const view = {
    paint:state=>{status=state;}, reader:state=>{status=state;}, toc(){},
    foreground:()=>visible, position:()=>position, restore:x=>x,
    takeHandoff:()=>null, clearHandoff(){},
  };
  const clock = {
    setTimeout(fn,delay) { const key = sequence++; timers.set(key,{fn,delay}); return key; },
    clearTimeout:key=>timers.delete(key),
  };
  const controller = completion ? completionController({...shared,view}) :
    resumeController({...shared,view,clock});
  return {
    controller, dev, store, calls, responses, status:()=>status, unauthorized:()=>unauthorized,
    network:value=>{connected=value;}, visible:value=>{visible=value;}, move:value=>{position=value;},
    verification:value=>{verified=value;},
    switchAccount(){active=false;csrf='other-account-csrf';},
    reply:(status,data)=>responses.push([status,data]),
    lost:()=>responses.push(()=>Promise.reject(new Error('connection reset'))),
    async fire(delay) {
      for (const [timer, entry] of timers) {
        if (entry.delay !== delay) continue;
        timers.delete(timer);
        entry.fn();
        break;
      }
      await tick();
    },
    delays:()=>[...timers.values()].map(timer=>timer.delay).sort((a,b)=>a-b),
    writes:()=>calls.filter(call=>call.options?.method),
    async start() {
      responses.push([200,progress(0,.1)],[200,accepted(1,.1)]);
      await controller.start(true);
    },
  };
}

test('strict draft storage isolates account, novel and writer slots and has no TTL or eviction', () => {
  const d = device(), store = d.store();
  const a = store.save('resume',uid(20),intent(.91));
  const b = store.save('resume',uid(21),intent(.1,'conflict'));
  assert.equal(a.kind,'ready');
  assert.equal(b.kind,'ready');
  assert.deepEqual(store.resumes().entries.map(e=>e.value.scroll_position),[.91,.1]);
  assert.deepEqual(d.store(other).resumes().entries,[]);
  assert.deepEqual(d.store(owner,uid(90)).resumes().entries,[]);
  assert.equal(store.save('resume',uid(20),intent(.2)).kind,'error');
  assert.equal(store.save('resume',uid(20),{...intent(.2),writer_epoch:epoch},a.raw).kind,'error');
  assert.equal(store.save('resume',uid(20),{...intent(.2),csrf:'secret'},a.raw).kind,'error');
  assert.equal(store.remove(a),true);
  assert.deepEqual(store.resumes().entries.map(e=>e.value.scroll_position),[.1]);
});

test('malformed, invalid and oversized draft records remain recoverable and storage failures are explicit', () => {
  const d = device(), store = d.store();
  const saved = store.save('resume',uid(20),intent(.3));
  const key = [...d.entries.keys()][0];
  for (const raw of ['{',' '.repeat(2049),
    JSON.stringify({...saved.value,version:2}), JSON.stringify({...saved.value,owner_id:other}),
    JSON.stringify({...saved.value,scroll_position:'0.3'}), JSON.stringify({...saved.value,attempt:{etag:'*',position:.1}}),
    JSON.stringify({...saved.value,content_revision:{...revision,hash:'x'.repeat(64)}}),
    saved.raw.replace('{','{"__proto__":{},')]) {
    d.entries.set(key,raw);
    assert.equal(store.resumes().failed,true);
    assert.equal(store.save('resume',uid(20),intent(.2)).kind,'error');
    assert.equal(d.entries.get(key),raw);
  }
  d.block(true);
  assert.equal(store.resumes().failed,true);
  d.block(false);
  d.quota(true);
  assert.equal(store.save('resume',uid(21),intent(.9)).kind,'error');
});

test('5-second dirty debounce coalesces scroll and the draft is persisted before sending', async () => {
  const h = harness();
  await h.start();
  for (const value of [0.2,0.3,0.3,0.34,Infinity,-1]) h.controller.note(value);
  assert.deepEqual(h.delays(),[250,5000]);
  assert.match(h.status().status,/chưa đồng bộ/);
  await h.fire(250);
  assert.equal(h.store.resumes().entries[0].value.scroll_position,.34);
  assert.equal(h.writes().length,1);
  let finish;
  h.responses.push(()=>new Promise(resolve=>{finish=resolve;}));
  await h.fire(5000);
  assert.match(h.status().status,/Đang đồng bộ/);
  assert.equal(h.store.resumes().entries[0].value.state,'uncertain');
  assert.equal(h.writes().length,2);
  finish({status:200,ok:true,json:async()=>progress(2,.34)});
  await tick();
  assert.equal(h.status().status,'Đã đồng bộ vị trí.');
  assert.equal(h.store.resumes().entries.length,0);
});

test('offline scroll is persisted without PUT and reconnect only schedules the live writer', async () => {
  const h = harness();
  await h.start();
  h.controller.note(.2);
  h.network(false);
  h.controller.disconnected();
  h.controller.note(.3);
  assert.deepEqual(h.delays(),[250]);
  await h.fire(250);
  assert.equal(h.store.resumes().entries[0].value.scroll_position,.3);
  assert.equal(h.writes().length,1);
  await h.controller.foreground(true);
  assert.deepEqual(h.delays(),[]);
  h.network(true);
  await h.controller.foreground(true);
  h.reply(200,progress(2,.3));
  await h.fire(5000);
  assert.equal(h.writes().at(-1).options.headers['If-Match'],tag(1));
  assert.equal(h.store.resumes().entries.length,0);
});

test('network retry verifies owner, reads canonical state and repeats only the original CAS twice', async () => {
  const h = harness();
  await h.start();
  h.controller.note(.38);
  h.lost();
  await h.fire(5000);
  const submitted = h.writes().at(-1);
  assert.deepEqual(h.delays(),[1000]);
  for (const [delay,status] of [[1000,0],[2000,503]]) {
    h.reply(200,{id:owner});
    h.reply(200,progress(1,.1));
    if (status) h.reply(status,{});
    else h.lost();
    await h.fire(delay);
    const retry = h.writes().at(-1);
    assert.deepEqual(retry.body,submitted.body);
    assert.deepEqual(retry.options.headers,submitted.options.headers);
  }
  assert.deepEqual(h.delays(),[]);
  assert.equal(h.writes().filter(write=>write.options.method==='PUT').length,3);
  assert.equal(h.status().draft.canApply,true);
  assert.equal(h.store.resumes().entries[0].value.state,'uncertain');
  assert.doesNotMatch(h.status().status,/Đã đồng bộ/);
});

test('response-lost commit is reconciled by row, next revision and exact position without a new writer', async () => {
  const h = harness();
  await h.start();
  h.controller.note(.43);
  h.lost();
  await h.fire(5000);
  h.reply(200,{id:owner});
  h.reply(200,progress(2,.43));
  await h.fire(1000);
  assert.equal(h.status().status,'Đã đồng bộ vị trí.');
  assert.equal(h.store.resumes().entries.length,0);
  h.controller.note(.66);
  assert.deepEqual(h.delays(),[]);
  assert.equal(h.writes().length,2);
});

test('server next revision with a different row, position, hash or superseding intent is conflict', async () => {
  for (const changed of [progress(2,.3), progress(3,.4),progress(2,.4,uid(91)),
    {...progress(2,.4),resume:target(.4,id,secondRevision)},
    {...progress(2,.4),resume_etag:'"'+uid(99)+':2"'}]) {
    const h = harness();
    await h.start();
    h.controller.note(.4); h.lost(); await h.fire(5000);
    h.reply(200,{id:owner}); h.reply(200,changed); await h.fire(1000);
    assert.equal(h.writes().length,2);
    assert.equal(h.store.resumes().entries[0].value.state,'conflict');
    assert.equal(h.status().draft.canApply,true);
  }
  const h = harness();
  await h.start();
  h.controller.note(.4); h.lost(); await h.fire(5000);
  h.controller.note(.8);
  h.reply(200,{id:owner}); h.reply(200,progress(1,.1)); await h.fire(1000);
  assert.equal(h.writes().length,2);
  assert.equal(h.store.resumes().entries[0].value.scroll_position,.8);
});

test('412, stale revision and archived chapter stop writes and preserve drafts for explicit handling', async () => {
  for (const [status,code] of [[412,'resume_precondition_failed'],[409,'content_revision_changed'],[404,'chapter_not_found']]) {
    const h = harness();
    await h.start();
    h.controller.note(.65);
    h.reply(status,{detail:{code}});
    if (status!==404) h.reply(200,progress(3,.44));
    await h.fire(5000);
    assert.deepEqual(h.delays(),[]);
    assert.equal(h.store.resumes().entries[0].value.state,'conflict');
    assert.equal(h.writes().length,2);
  }
});

test('ambiguous Activate reconciles via GET and never repeats POST or assumes a writer', async () => {
  const h = harness();
  h.reply(200,progress(0,.1));
  h.lost();
  h.reply(200,progress(1,.1));
  await h.controller.start(true);
  assert.equal(h.writes().length,1);
  assert.equal(h.status().status,'Đã đồng bộ vị trí.');
  h.controller.note(.7);
  assert.deepEqual(h.delays(),[]);
});

test('keepalive once across hidden and pagehide, then BFCache only reads and can reconcile committed draft', async () => {
  const h = harness();
  await h.start();
  h.controller.note(.58);
  let settle;
  h.responses.push(()=>new Promise(resolve=>{settle=resolve;}));
  h.visible(false);
  h.controller.hide();
  h.controller.leave();
  assert.equal(h.writes().filter(call=>call.options.keepalive).length,1);
  assert.equal(h.writes().at(-1).options.headers['X-CSRF-Token'],'captured-csrf');
  settle({status:200,ok:true,json:async()=>progress(2,.58)});
  await tick();
  h.visible(true);
  h.reply(200,progress(2,.58));
  await h.controller.foreground();
  assert.equal(h.writes().length,2);
  assert.equal(h.status().canActivate,true);
});

test('reload and a new session recover position for same owner, verify a fresh CAS on explicit apply only', async () => {
  const dev = device(), a = harness({dev});
  await a.start();
  a.controller.note(.6);
  a.network(false);
  a.controller.leave();
  const b = harness({dev,account:other});
  b.reply(200,progress(0,.1));
  await b.controller.start(false);
  assert.equal(b.status().draft,null);
  assert.equal(b.writes().length,0);
  const reopened = harness({dev,csrfSeed:'new-session-csrf'});
  reopened.reply(200,progress(3,.8));
  await reopened.controller.start(true);
  assert.equal(reopened.writes().length,0);
  assert.equal(reopened.status().draft.position,.6);
  reopened.reply(200,{id:owner}); reopened.reply(200,progress(4,.88));
  reopened.reply(200,accepted(5,.6));
  await reopened.controller.applyDraft();
  assert.equal(reopened.writes().at(-1).options.headers['If-Match'],tag(4));
  assert.equal(reopened.writes().at(-1).options.headers['X-CSRF-Token'],'new-session-csrf');
  assert.deepEqual(reopened.writes().at(-1).body,{
    chapter_id:id,content_revision:revision,scroll_position:.6,
  });
  assert.equal(dev.store().resumes().entries.length,0);
});

test('session expiry and account switch keep A draft and cancel recovery without another mutation', async () => {
  for (const expired of [true,false]) {
    const h = harness();
    await h.start();
    h.controller.note(.4); h.lost(); await h.fire(5000);
    if (expired) h.reply(401,{});
    else h.switchAccount();
    await h.fire(1000);
    assert.equal(h.writes().length,2);
    assert.equal(h.status(),null);
    assert.equal(h.unauthorized(),Number(expired));
    assert.equal(h.store.resumes().entries[0].value.scroll_position,.4);
    assert.equal(h.dev.store(other).resumes().entries.length,0);
  }
});

test('login merge consent gates offline draft application and records no new data', async () => {
  const dev = device(), store = dev.store();
  store.save('resume',uid(30),intent(.7));
  const candidate = {resume:{...intent(.44),chapter_id:id}};
  const h = harness({dev,merge:{
    guarded:()=>true, candidate:()=>candidate, paint(){},
    lookup:async()=>({kind:'ready',chapter:{revision}}),
  }});
  h.reply(200,progress(0,.1));
  await h.controller.start(true);
  await h.controller.applyDraft();
  h.controller.note(.8);
  await h.controller.foreground(true);
  assert.equal(h.writes().length,0);
  assert.equal(store.resumes().entries[0].value.scroll_position,.7);
});

const completionStatus = (digest = revision,status='not_completed') => ({
  items:[{chapter_id:id,status,content_revision:digest}],
});
const completionAck = (already_completed = false) => ({
  chapter_id:id,content_revision:revision,already_completed,completed_at:'2026-11-19T01:00:00Z',
});

test('offline Completion queues only a click and reconnect reads ledger until user explicitly syncs', async () => {
  const h = harness({completion:true});
  h.reply(200,completionStatus());
  await h.controller.resume();
  h.network(false);
  h.verification(false);
  h.controller.disconnected();
  h.controller.suspend();
  assert.equal(h.status(),null);
  await h.controller.resume();
  assert.equal(h.status().canConfirm,true);
  assert.equal(h.calls.length,1);
  assert.equal(h.store.read('completion',id).kind,'empty');
  await h.controller.action();
  assert.match(h.status().message,/chưa đồng bộ/);
  assert.equal(h.writes().length,0);
  assert.equal(h.store.read('completion',id).value.state,'dirty');
  h.network(true);
  await h.controller.action();
  assert.equal(h.calls.length,1);
  assert.equal(h.status().canConfirm,false);
  h.verification(true);
  h.reply(200,completionStatus());
  await h.controller.resume(true);
  assert.equal(h.writes().length,0);
  h.reply(200,{id:owner}); h.reply(200,completionAck(true));
  await h.controller.action();
  assert.deepEqual(h.writes().at(-1).body,{confirmation:true,content_revision:revision});
  assert.equal(h.status().message,'Đã đọc');
  assert.equal(h.store.read('completion',id).kind,'empty');
});

test('pending Completion rejects a different verified owner even when the local CSRF marker looks unchanged', async () => {
  const h = harness({completion:true});
  h.reply(200,completionStatus()); await h.controller.resume();
  h.network(false); await h.controller.action();
  h.network(true);
  h.reply(200,{id:other});
  await h.controller.action();
  assert.deepEqual(h.writes(),[]);
  assert.equal(h.status(),null);
  assert.equal(h.unauthorized(),1);
  assert.equal(h.store.read('completion',id).value.state,'dirty');
  assert.equal(h.dev.store(other).read('completion',id).kind,'empty');
});

test('Completion changed revision and 409 retain claim and B cannot replay it', async () => {
  const dev = device(), a = harness({dev,completion:true});
  a.reply(200,completionStatus());
  await a.controller.resume();
  a.network(false);
  await a.controller.action();
  const b = harness({dev,account:other,completion:true});
  b.reply(200,completionStatus());
  await b.controller.resume();
  assert.equal(b.status().draft,false);
  assert.equal(b.writes().length,0);
  a.network(true);
  a.reply(200,{id:owner});
  a.reply(409,{});
  await a.controller.action();
  assert.equal(a.store.read('completion',id).value.state,'conflict');
  assert.match(a.status().message,/bản cũ/);
  const fresh = harness({dev,knownChapter:{...chapter,revision:secondRevision},completion:true});
  fresh.reply(200,completionStatus(secondRevision,'old_revision'));
  await fresh.controller.resume();
  assert.match(fresh.status().message,/bản cũ/);
  assert.equal(fresh.writes().length,0);
  assert.equal(fresh.store.read('completion',id).value.content_revision.hash,revision.hash);
});

test('quota does not make unsent Resume or Completion look synced', async () => {
  const dev = device(), h = harness({dev});
  await h.start();
  dev.quota(true);
  h.network(false);
  h.controller.note(.4);
  await h.fire(250);
  assert.match(h.status().status,/Không thể lưu/);
  assert.equal(h.status().draft,null);
  const c = harness({dev,completion:true});
  c.reply(200,completionStatus()); await c.controller.resume();
  c.network(false); await c.controller.action();
  assert.match(c.status().message,/Không thể lưu/);
  assert.equal(c.writes().length,0);
});

test('newer scroll back to the saved fraction survives leaving during an older in-flight PUT', async () => {
  const h = harness();
  await h.start();
  let respond;
  h.responses.push(()=>new Promise(resolve=>{respond=resolve;}));
  h.controller.note(.5);
  await h.fire(5000);
  h.controller.note(.1);
  h.controller.leave();
  const draft = h.store.resumes().entries[0].value;
  assert.equal(draft.scroll_position,.1);
  assert.equal(draft.attempt.position,.5);
  respond({status:200,ok:true,json:async()=>progress(2,.5)});
  await tick();
  assert.equal(h.store.resumes().entries[0].value.scroll_position,.1);
});

test('discard removes only the chosen account Resume and issues no request', async () => {
  const dev = device(), a = harness({dev});
  a.store.save('resume',uid(30),intent(.7));
  a.store.save('completion',id,{chapter_id:id,content_revision:revision,state:'dirty'});
  dev.store(other).save('resume',uid(31),intent(.3));
  dev.entries.set('readnovel.progress.guest.v1.'+novel,'guest-data');
  a.reply(200,progress(2,.1));
  await a.controller.start(false);
  a.controller.discardDraft();
  assert.equal(a.calls.length,1);
  assert.equal(a.store.resumes().entries.length,0);
  assert.equal(a.store.read('completion',id).kind,'ready');
  assert.equal(dev.store(other).resumes().entries.length,1);
  assert.equal(dev.entries.get('readnovel.progress.guest.v1.'+novel),'guest-data');
});

test('a stored Resume from the old SSR revision stays blocked without sending a request', async () => {
  const dev = device();
  dev.store().save('resume',uid(30),intent(.7));
  const h = harness({dev,knownChapter:{...chapter,revision:secondRevision}});
  h.reply(200,progress(3,.6));
  await h.controller.start(true);
  assert.equal(h.status().draft.canApply,false);
  assert.match(h.status().status,/đã đổi/);
  await h.controller.applyDraft();
  assert.equal(h.writes().length,0);
});

test('going offline again while reconciling does not dispatch the retry', async () => {
  const h = harness();
  await h.start();
  h.controller.note(.4);
  h.lost();
  await h.fire(5000);
  h.reply(200,{id:owner});
  let finishRead;
  h.responses.push(()=>new Promise(resolve=>{finishRead=resolve;}));
  await h.fire(1000);
  h.network(false);
  h.visible(false);
  h.controller.hide();
  finishRead({status:200,ok:true,json:async()=>progress(1,.1)});
  await tick();
  assert.equal(h.writes().length,2);
  assert.deepEqual(h.delays(),[]);
  h.network(true);
  h.visible(true);
  h.reply(200,progress(1,.1));
  h.reply(200,progress(2,.4));
  await h.controller.foreground(true);
  assert.equal(h.writes().length,3);
  assert.equal(h.writes().at(-1).options.headers['If-Match'],tag(1));
});
