'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createGuestStore, createController, bindDialogDismissal, bookmarkDestination} =
  require('../app/static/js/reader_bookmarks.js');
const {decision} = require('../app/static/js/reader_toc.js');

const id = n => '10000000-0000-0000-0000-' + String(n).padStart(12,'0');
const novel = id(100), one = id(1), two = id(2), other = id(101);
const path = '/novel/fixture/';
const api = '/api/bookmarks/novels/' + novel;
const prefix = 'readnovel.bookmarks.guest.v1.' + novel + '.';
const chapter = {novelId:novel,id:one,title:'Chương 1',number:'1',url:path+'1'};
const record = (chapterId = one, version = 1, novelId = novel) => ({
  version,novel_id:novelId,chapter_id:chapterId,created_at:'2026-11-20T00:00:00.000Z',
});
const status = bookmarked => ({chapter_id:one,available:true,bookmarked});
const page = (items, number = 1, pages = 1) => ({novel_id:novel,page:number,page_size:20,total_pages:pages,items});
const item = (chapterId = one, seq = 1) => ({
  chapter_id:chapterId,available:true,chapter_sequence:seq,chapter_number:String(seq),
  title:'Chương '+seq,url:'https://untrusted.invalid/',
});
const response = (code, data) => ({status:code,ok:code>=200&&code<300,json:async()=>data});
const idle = () => new Promise(resolve=>setImmediate(resolve));

function device() {
  let blocked = false, quota = false;
  const values = new Map();
  const local = {
    get length() { return values.size; },
    key:i=>[...values.keys()][i] ?? null,
    getItem:key=>values.get(key) ?? null,
    setItem(key,value) {
      if (quota) throw new DOMException('Full','QuotaExceededError');
      values.set(key,value);
    },
    removeItem:key=>values.delete(key),
  };
  const store = createGuestStore(novel,()=>{
    if (blocked) throw new DOMException('Blocked','SecurityError');
    return local;
  },()=>record().created_at);
  return {store,values,block:value=>{blocked=value;},quota:value=>{quota=value;}};
}

function harness(dev = device()) {
  let output, open = false, unauthorized = 0, verified = true;
  const calls = [], queue = [], lookups = [];
  const publicChapters = new Map([[two,{title:'Chương 2',number:'2',url:path+'2'}]]);
  const controller = createController({chapter,readerPath:path,guestStore:dev.store,
    lookup:async chapterId=>{
      lookups.push(chapterId);
      const found = publicChapters.get(chapterId);
      return found ? {kind:'ready',chapter:found} : {kind:'missing'};
    },
    request:async (url, options)=>{
      calls.push({url,options});
      const next = queue.shift();
      if (!next) throw Error('Unexpected request');
      return next();
    },
    view:{paint:state=>{output=state;},open:()=>{open=true;return true;},close:()=>{open=false;}},
  });
  function start(owner = null) {
    controller.start({owner,isCurrent:()=>true,canUseServer:()=>verified,
      csrf:()=>({header:'X-CSRF-Token',value:'fixture-csrf'}),
      onUnauthorized:()=>{unauthorized++;controller.stop();},
    });
  }
  return {dev,controller,calls,lookups,publicChapters,state:()=>output,open:()=>open,
    unauthorized:()=>unauthorized,start, network:value=>{verified=value;},
    reply:(code,data)=>queue.push(()=>response(code,data)),
    fail:()=>queue.push(()=>Promise.reject(Error('offline'))),
    hold(){
      let resolve;
      const pending = new Promise(done=>{resolve=done;});
      queue.push(()=>pending);
      return (code,data)=>resolve(response(code,data));
    },
  };
}

test('Guest toggle is local and survives new Reader instances', async () => {
  const h = harness();
  h.start();
  assert.equal(h.state().marked,false);
  await h.controller.toggle();
  assert.equal(h.state().marked,true);
  assert.deepEqual(JSON.parse(h.dev.values.get(prefix+one)),record());
  const reload = harness(h.dev);
  reload.start();
  assert.equal(reload.state().marked,true);
  await reload.controller.toggle();
  assert.equal(reload.state().marked,false);
  assert.equal(h.dev.values.size,0);
  assert.deepEqual([...h.calls,...reload.calls],[]);
});

test('Guest current and remote chapter names persist on repeated open and a fresh document', async () => {
  const dev = device();
  dev.store.set(one,true);
  dev.store.set(two,true);
  for (const h of [harness(dev),harness(dev)]) {
    h.start();
    for (let i=0;i<3;i++) {
      h.controller.open();
      await idle();
      assert.deepEqual(h.state().list.items.map(bookmarkDestination),
        [{href:path+'2',label:'Chương 2'},{href:path+'1',label:'Chương 1'}]);
      h.controller.close();
    }
    h.controller.stop();
  }
});

test('missing or blank chapter metadata never renders a destination without a real label', () => {
  for (const item of [{url:path+'1'}, {url:path+'1',number:'1',title:'  '}, {unknown:true}]) {
    assert.deepEqual(bookmarkDestination(item),{href:null,label:'Chưa kiểm tra được tên chương'});
  }
  assert.deepEqual(bookmarkDestination({url:path+'1',number:'1',title:'<script>Chương</script>'}),
    {href:path+'1',label:'1 · <script>Chương</script>'});
});

test('Guest validates Published targets, isolates novel keys and can remove unavailable records', async () => {
  const h = harness(), missing = id(3);
  h.dev.store.set(one,true);
  h.dev.store.set(two,true);
  h.dev.store.set(missing,true);
  h.dev.values.set('readnovel.bookmarks.guest.v1.'+other+'.'+two,JSON.stringify(record(two,1,other)));
  h.start();
  h.controller.open();
  await idle();
  assert.deepEqual(h.lookups,[missing,two]);
  assert.deepEqual(h.state().list.items,[
    {id:missing,unknown:false}, {id:two,title:'Chương 2',number:'2',url:path+'2'},
    {id:one,title:'Chương 1',number:'1',url:path+'1'},
  ]);
  await h.controller.remove(missing);
  await idle();
  assert.deepEqual(h.state().list.items.map(row=>row.id),[two,one]);
});

test('Guest list resolves only the requested page and resets an emptied last page', async () => {
  const h = harness();
  for (let i=1;i<=21;i++) h.dev.store.set(id(i),true);
  h.start();
  h.controller.open();
  await idle();
  assert.equal(h.lookups.length,20);
  assert.equal(h.state().list.pages,2);
  await h.controller.loadList(2);
  assert.deepEqual(h.state().list.items.map(row=>row.id),[one]);
  await h.controller.remove(one);
  await idle();
  assert.equal(h.state().list.page,1);
  assert.equal(h.state().list.items.length,20);
});

test('Guest storage errors preserve prior values and display an error', async () => {
  const h = harness();
  h.dev.block(true);
  h.start();
  assert.equal(h.state().marked,null);
  assert.match(h.state().message,/Không thể/);
  h.controller.open();
  await idle();
  assert.match(h.state().listError,/Không thể/);
  h.dev.block(false);
  h.controller.resume();
  h.dev.quota(true);
  await h.controller.toggle();
  assert.equal(h.state().marked,false);
  assert.match(h.state().message,/Không thể/);
  assert.equal(h.dev.values.size,0);
});

test('Invalid JSON, unsupported version and injected locators are retained and rejected', async () => {
  for (const raw of ['{',JSON.stringify(record(one,2)),JSON.stringify({...record(),url:'javascript:bad()'}),
    JSON.stringify(record(one,1,other))]) {
    const h = harness();
    h.dev.values.set(prefix+one,raw);
    h.dev.values.set('readnovel.progress.guest.v1.'+novel,'progress record');
    h.start();
    await h.controller.toggle();
    assert.match(h.state().message,/Không thể/);
    assert.equal(h.dev.values.get(prefix+one),raw);
    assert.equal(h.dev.values.get('readnovel.progress.guest.v1.'+novel),'progress record');
  }
});

test('Guest storage events synchronize toggle and list in another tab only for this novel', async () => {
  const a = harness(), b = harness(a.dev);
  a.start(); b.start();
  b.controller.open();
  await idle();
  await a.controller.toggle();
  b.controller.storageChanged('readnovel.progress.guest.v1.'+novel);
  assert.equal(b.state().marked,false);
  b.controller.storageChanged(prefix+one);
  await idle();
  assert.equal(b.state().marked,true);
  assert.deepEqual(b.state().list.items.map(row=>row.id),[one]);
  b.controller.suspend();
  await a.controller.toggle();
  b.controller.storageChanged(null);
  assert.equal(b.state(),null);
  b.controller.resume();
  assert.equal(b.state().marked,false);
});

test('Auth GET status and PUT/DELETE use same-origin cookies and CSRF with a server acknowledgement', async () => {
  const h = harness();
  h.reply(200,status(false));
  h.start(id(200));
  await idle();
  assert.equal(h.calls[0].url,api+'/chapters/'+one);
  assert.equal(h.calls[0].options.credentials,'same-origin');
  const finish = h.hold();
  const pending = h.controller.toggle();
  assert.equal(h.state().marked,false);
  assert.equal(h.state().toggleDisabled,true);
  await h.controller.toggle();
  assert.equal(h.calls.length,2);
  finish(204);
  await pending;
  assert.equal(h.state().marked,true);
  h.reply(204);
  await h.controller.toggle();
  assert.equal(h.state().marked,false);
  assert.deepEqual(h.calls.slice(1).map(c=>[c.options.method,c.options.headers,c.options.body]),[
    ['PUT',{'X-CSRF-Token':'fixture-csrf'},undefined],
    ['DELETE',{'X-CSRF-Token':'fixture-csrf'},undefined],
  ]);
  assert.equal(h.dev.values.size,0);
});

test('Auth rejects failed or malformed acknowledgements and retries with a GET', async () => {
  for (const code of [200,403,503,0]) {
    const h = harness();
    h.reply(200,status(false));
    h.start(id(200));
    await idle();
    if (code) h.reply(code,{});
    else h.fail();
    await h.controller.toggle();
    assert.equal(h.state().marked,false);
    assert.match(h.state().message,/Không xác nhận được/);
    h.reply(200,status(false));
    await h.controller.toggle();
    assert.equal(h.calls.at(-1).options.method,undefined);
    assert.equal(h.state().message,'');
  }
});

test('Auth list preserves API ordering, redacts archived content and removes it through DELETE', async () => {
  const h = harness();
  h.reply(200,status(false));
  h.start(id(200));
  await idle();
  h.reply(200,page([item(two,2),{...item(),available:false}],1,2));
  h.controller.open();
  await idle();
  assert.deepEqual(h.state().list.items,[{id:two,number:'2',title:'Chương 2',url:path+'2'}, {id:one}]);
  assert.equal(h.calls.at(-1).url,api+'?page=1&page_size=20');
  h.reply(200,page([item(two,2)],2,2));
  await h.controller.loadList(2);
  assert.equal(h.state().list.page,2);
  assert.equal(h.calls.at(-1).url,api+'?page=2&page_size=20');
  h.reply(200,page([{...item(),available:false}],1,2));
  await h.controller.loadList(1);
  h.reply(204);
  h.reply(200,page([],1,0));
  await h.controller.remove(one);
  await idle();
  assert.equal(h.calls.at(-2).options.method,'DELETE');
  assert.deepEqual(h.state().list.items,[]);
});

test('Auth preserves confirmed state offline and blocks mutations until coordinator verifies again', async () => {
  const h = harness();
  h.reply(200,status(true));
  h.start(id(200));
  await idle();
  h.reply(200,page([item()]));
  h.controller.open();
  await idle();
  const requests = h.calls.length;
  h.network(false);
  h.controller.resume();
  assert.equal(h.state().marked,true);
  assert.equal(h.state().list.items.length,1);
  assert.match(h.state().message,/cần kết nối/);
  await h.controller.toggle();
  await h.controller.remove(one);
  assert.equal(h.calls.length,requests);
  assert.equal(h.dev.values.size,0);
  h.network(true);
  h.reply(200,status(true));
  h.reply(200,page([item()]));
  h.controller.resume();
  await idle();
  assert.ok(h.calls.every(c=>!c.options.method));
  assert.equal(h.state().toggleDisabled,false);
});

test('Guest, A and B never mix, and late replies cannot repaint another scope', async () => {
  const h = harness();
  h.start();
  await h.controller.toggle();
  const before = h.dev.values.get(prefix+one);
  h.reply(200,status(false));
  h.start(id(200));
  await idle();
  const late = h.hold();
  const mutation = h.controller.toggle();
  h.reply(200,status(false));
  h.start(id(201));
  await idle();
  late(204);
  await mutation;
  assert.equal(h.state().marked,false);
  assert.equal(h.dev.values.get(prefix+one),before);
  h.start();
  assert.equal(h.state().marked,true);
  assert.equal(h.calls.filter(c=>c.options.method).length,1);
});

test('Account removal while a list read is pending redacts immediately and ignores the late page', async () => {
  const h = harness();
  h.reply(200,status(true));
  h.start(id(200));
  await idle();
  const finish = h.hold();
  h.controller.open();
  h.controller.stop();
  assert.equal(h.open(),false);
  assert.equal(h.state(),null);
  h.start();
  finish(200,page([item()]));
  await idle();
  assert.equal(h.state().source,'Trên thiết bị này');
  assert.equal(h.state().list,undefined);
  assert.equal(h.state().marked,false);
});

test('Session expiry retires scope on 401 and never falls back to Guest writes', async () => {
  const h = harness();
  h.reply(200,status(false));
  h.start(id(200));
  await idle();
  h.reply(401);
  await h.controller.toggle();
  assert.equal(h.unauthorized(),1);
  assert.equal(h.state(),null);
  assert.equal(h.dev.values.size,0);
});

test('Bookmark actions leave Guest Progress, Completion and TOC decision independent', async () => {
  const h = harness(), guestProgress = 'readnovel.progress.guest.v1.'+novel;
  h.dev.values.set(guestProgress,'existing resume and claims');
  h.start();
  await h.controller.toggle();
  assert.equal(h.dev.values.get(guestProgress),'existing resume and claims');
  assert.equal(decision(1,2,3),'confirm');
  assert.ok(h.calls.every(c=>c.url.startsWith(api)));
});

function dialogFixture() {
  const dialog = new EventTarget(), button = new EventTarget();
  const calls = [];
  const opener = {
    isConnected:true,disabled:false,hidden:false,
    closest() {return this.hidden ? this : null;},
    getClientRects:()=>[{}],
    ownerDocument:{defaultView:{getComputedStyle:()=>({visibility:'visible'})}},
    focus:options=>calls.push(options),
  };
  dialog.getBoundingClientRect = () => ({top:10,left:10,right:100,bottom:100});
  dialog.close = () => {dialog.open=false;};
  const binding = bindDialogDismissal(dialog,button,opener,()=>calls.push('closed'));
  const open = () => {dialog.open=true;binding.opened();};
  const dispatch = (type,x,y) => dialog.dispatchEvent(Object.assign(new Event(type,{cancelable:true}),{clientX:x,clientY:y}));
  return {dialog,button,opener,binding,calls,open,dispatch};
}

test('Close button and native cancellation restore focus exactly once each over repeated opens', () => {
  const h = dialogFixture();
  h.open();
  h.button.dispatchEvent(new Event('click'));
  assert.equal(h.dialog.open,false);
  h.open();
  h.dispatch('close');
  assert.equal(h.dialog.open,true,'Queued close cannot reset a reopened dialog');
  assert.equal(h.dispatch('cancel'),false);
  h.dispatch('close');
  assert.deepEqual(h.calls,['closed',{preventScroll:true},'closed',{preventScroll:true}]);
});

test('A backdrop drag does not dismiss the dialog, but a backdrop click does', () => {
  const h = dialogFixture();
  h.open();
  h.dispatch('pointerdown',20,20);
  h.dispatch('click',0,0);
  assert.equal(h.dialog.open,true);
  h.dispatch('pointerdown',0,0);
  h.dispatch('click',0,0);
  assert.equal(h.dialog.open,false);
  assert.deepEqual(h.calls,['closed',{preventScroll:true}]);
});

test('Scope retirement and hidden opener never receive explicit focus restoration', () => {
  const h = dialogFixture();
  h.open();
  h.binding.close(false);
  h.open();
  h.opener.hidden=true;
  h.button.dispatchEvent(new Event('click'));
  assert.deepEqual(h.calls,['closed','closed']);
});
