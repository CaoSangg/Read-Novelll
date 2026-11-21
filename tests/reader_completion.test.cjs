const test = require('node:test');
const assert = require('node:assert/strict');
const {createController, parseStatuses, createView} = require('../app/static/js/reader_completion.js');

test('footer labels Guest and Auth consistently while keeping pending distinct', () => {
  const output = {}, button = {setAttribute() {}}, discard = {};
  const fields = [output,button,discard];
  const view = createView({querySelector:()=>fields.shift()});
  for (const message of ['Chưa đọc','Đã đọc','Đã đọc — lưu trên thiết bị','Chờ đồng bộ xác nhận']) {
    view.reader({message});
    assert.equal(output.textContent,'Trạng thái: '+message);
  }
  assert.equal(button.textContent,'Đã đọc xong');
  view.reader(null);
  assert.equal(output.textContent,'');
});

const id = n => '10000000-0000-0000-0000-' + String(n).padStart(12,'0');
const A = {scheme:'sha256-utf8-raw-v1', hash:'a'.repeat(64)};
const B = {...A, hash:'b'.repeat(64)};
const chapter = {id:id(1), novelId:id(100), revision:A};
const item = (status, revision = A, n = 1) => ({chapter_id:id(n),status,content_revision:revision});
const response = (status, data) => ({status,ok:status>=200 && status<300,json:async()=>data});
const rows = (...ids) => ids.map(n => ({id:id(n)}));
const result = {chapter_id:chapter.id,content_revision:A,completed_at:'2026-11-19T00:00:00Z'};

function setup(sessionHint = true, initialCookie = 'csrf-fixture') {
  let csrf = initialCookie, current = null, badges = new Map();
  const requests = [], queue = [];
  const controller = createController({
    chapter, sessionHint, csrfHeader:'X-CSRF-Token', readCsrf:()=>csrf,
    request:async (url, options) => {
      requests.push({url,...options});
      const next = queue.shift();
      if (!next) throw Error('Unexpected request');
      return next();
    },
    view:{
      reader(state) { current=state; },
      toc(inScope,statuses) {
        for (const row of inScope) {
          if (statuses.has(row.id)) badges.set(row.id,statuses.get(row.id).status);
          else badges.delete(row.id);
        }
      },
    },
  });
  return {controller, requests, badges, current:()=>current, changeCookie:value=>{csrf=value;},
    reply(status,data){queue.push(()=>response(status,data));},
    status(...items){queue.push(()=>response(200,{items}));},
    fail(){queue.push(()=>Promise.reject(Error('network')));},
    hold(){
      let resolve;
      const pending=new Promise(done=>{resolve=done;});
      queue.push(()=>pending);
      return (status,data)=>resolve(response(status,data));
    },
  };
}

test('guest bypasses Reader and TOC status even when lifecycle or actions fire', async () => {
  const h=setup(false);
  await h.controller.resume();
  await h.controller.setTocPage(rows(1,3));
  await h.controller.action();
  h.controller.suspend();
  assert.deepEqual(h.requests,[]);
  assert.equal(h.current(),null);
});

test('authenticated status loads read-only and distinguishes all three evidence states', async () => {
  for (const [status,label,canConfirm] of [
    ['not_completed','Chưa đọc',true],
    ['completed','Đã đọc',false],
    ['old_revision','Đã đọc (bản cũ)',true],
  ]) {
    const h=setup(), read=h.hold(), started=h.controller.resume();
    assert.equal(h.current().message,'Đang tải trạng thái đọc…');
    assert.equal(h.current().canConfirm,false);
    await h.controller.action();
    read(200,{items:[item(status)]});
    await started;
    assert.equal(h.current().message,label);
    assert.equal(h.current().canConfirm,canConfirm);
    assert.equal(h.requests.length,1);
    assert.equal(h.requests[0].credentials,'same-origin');
    assert.ok(h.requests[0].url.endsWith('/completions?chapter_ids='+chapter.id));
    assert.equal(h.requests[0].method,undefined);
  }
});

test('read failure is unknown; explicit retry only reads', async () => {
  const h=setup();
  h.fail();
  await h.controller.resume();
  assert.equal(h.current().message,'Không tải được trạng thái đọc.');
  assert.equal(h.current().retry,true);
  h.status(item('not_completed'));
  await h.controller.action();
  assert.equal(h.current().message,'Chưa đọc');
  assert.ok(h.requests.every(r=>!r.method));
});

test('explicit click sends only authenticated SSR revision, commits UI after server acknowledgement', async () => {
  const h=setup();
  h.status(item('old_revision'));
  await h.controller.resume();
  h.status(item('old_revision'),item('not_completed',A,2));
  await h.controller.setTocPage(rows(1,2));
  const finish=h.hold();
  const write=h.controller.action();
  await h.controller.action();
  assert.equal(h.current().message,'Đã đọc (bản cũ)');
  assert.equal(h.current().canConfirm,false);
  assert.equal(h.badges.get(id(1)),'old_revision');
  const request=h.requests[2];
  assert.equal(request.method,'PUT');
  assert.equal(request.credentials,'same-origin');
  assert.equal(request.headers['X-CSRF-Token'],'csrf-fixture');
  assert.ok(request.url.endsWith('/completions/'+chapter.id));
  assert.deepEqual(JSON.parse(request.body),{confirmation:true,content_revision:A});
  finish(200,{...result,already_completed:true});
  await write;
  assert.equal(h.current().message,'Đã đọc');
  assert.equal(h.badges.get(id(1)),'completed');
  assert.equal(h.badges.get(id(2)),'not_completed');
  await h.controller.action();
  assert.equal(h.requests.length,3);
});

test('stale SSR blocks writes even when GET supplies a new revision', async () => {
  const h=setup();
  h.status(item('old_revision',B));
  await h.controller.resume();
  assert.match(h.current().message,/tải lại/);
  await h.controller.action();
  assert.equal(h.requests.length,1);
  assert.equal(chapter.revision,A);
});

test('409/404 requires reload, auth rejection retires the UI, and network failure keeps prior evidence', async () => {
  for (const status of [409,404,401,403,0]) {
    const h=setup();
    h.status(item('old_revision'));
    await h.controller.resume();
    if (status) h.reply(status,{});
    else h.fail();
    await h.controller.action();
    if (status===401) assert.equal(h.current(),null);
    else if (status===0) assert.match(h.current().message,/^Đã đọc \(bản cũ\).*Chưa xác nhận/);
    else assert.match(h.current().message,/tải lại/);
    if (status!==0) {
      await h.controller.action();
      assert.equal(h.requests.length,2);
    } else {
      h.reply(200,{...result,already_completed:true});
      await h.controller.action();
      assert.equal(h.current().message,'Đã đọc');
      assert.deepEqual(JSON.parse(h.requests[2].body),JSON.parse(h.requests[1].body));
    }
  }
});

test('absent CSRF permits visible server status but guards mutation', async () => {
  const h=setup(true,null);
  h.status(item('not_completed'));
  await h.controller.resume();
  assert.equal(h.current().canConfirm,false);
  await h.controller.action();
  assert.equal(h.requests.length,1);
});

test('TOC sends one page batch and an aborted stale response cannot paint another page', async () => {
  const h=setup();
  h.status(item('not_completed'));
  await h.controller.resume();
  const hold=h.hold(), first=h.controller.setTocPage(rows(...Array.from({length:50},(_,i)=>i+1)));
  assert.equal(h.requests.length,2);
  assert.equal(new URL(h.requests[1].url,'https://test.invalid').searchParams.getAll('chapter_ids').length,50);
  h.status(item('completed',B,51));
  await h.controller.setTocPage(rows(51));
  assert.equal(h.requests[1].signal.aborted,true);
  hold(200,{items:Array.from({length:50},(_,i)=>item('old_revision',A,i+1))});
  await first;
  assert.deepEqual([...h.badges],[[id(51),'completed']]);
  const closing=h.hold(), pending=h.controller.setTocPage(rows(52));
  await h.controller.setTocPage([]);
  assert.equal(h.requests.at(-1).signal.aborted,true);
  closing(200,{items:[item('completed',A,52)]});
  await pending;
  assert.equal(h.badges.size,0);
  assert.ok(h.requests.every(r=>!r.method));
});

test('completion supersedes in-flight TOC statuses without overwriting a later revision', async () => {
  const h=setup();
  h.status(item('not_completed'));
  await h.controller.resume();
  const finish=h.hold(), pendingWrite=h.controller.action();
  const stale=h.hold(), pendingPage=h.controller.setTocPage(rows(1));
  h.status(item('old_revision',B));
  finish(200,result);
  await pendingWrite;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.requests[2].signal.aborted,true);
  stale(200,{items:[item('not_completed')]});
  await pendingPage;
  assert.match(h.current().message,/tải lại/);
  assert.equal(h.badges.get(id(1)),'old_revision');
});

test('a TOC batch can invalidate the SSR revision before any click', async () => {
  const h=setup();
  h.status(item('not_completed'));
  await h.controller.resume();
  h.status(item('not_completed',B));
  await h.controller.setTocPage(rows(1));
  assert.match(h.current().message,/tải lại/);
  await h.controller.action();
  assert.equal(h.requests.length,2);
});

test('closing or restoring a page does not PUT; BFCache read revalidates stale UI', async () => {
  const h=setup();
  h.status(item('completed'));
  await h.controller.resume();
  assert.equal(h.current().message,'Đã đọc');
  h.controller.suspend();
  assert.equal(h.current(),null);
  h.status(item('old_revision',B));
  await Promise.all([h.controller.resume(),h.controller.resume()]);
  assert.match(h.current().message,/tải lại/);
  assert.equal(h.requests.length,2);
  assert.ok(h.requests.every(r=>!r.method));
});

test('account switch clears completed badges and ignores pending confirmation', async () => {
  const h=setup();
  h.status(item('not_completed'));
  await h.controller.resume();
  h.status(item('not_completed'),item('completed',A,2));
  await h.controller.setTocPage(rows(1,2));
  const finish=h.hold(), pending=h.controller.action();
  h.changeCookie('other-account');
  h.controller.checkAccount();
  finish(200,result);
  await pending;
  assert.equal(h.current(),null);
  assert.equal(h.badges.size,0);
  await h.controller.resume();
  await h.controller.action();
  assert.equal(h.requests.length,3);
});

test('batch decoder rejects missing, duplicate and unknown evidence', () => {
  for (const items of [[],[item('completed'),item('completed')],[item('bogus'),item('completed',A,2)],
    [item('completed'),item('completed',A,3)]]) {
    assert.equal(parseStatuses({items},[id(1),id(2)]),null);
  }
});
