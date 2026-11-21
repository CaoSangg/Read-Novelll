/* Execute the production bootstrap in isolated browser-like contexts; no copied validator. */
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const assert=require('node:assert/strict');
const source=readFileSync(join(__dirname,'../app/static/js/reader_preferences.js'),'utf8');
const KEY='readnovel.reader.settings';
const defaults={theme:'sepia',fontFamily:'Lora',fontSize:19,lineHeight:1.85,readingWidth:'normal'};
const desired={theme:'dark',fontFamily:'Merriweather',fontSize:23,lineHeight:2.1,readingWidth:'wide'};
const saved={version:1,...desired};
function boot(entries={},failure=null,parsed=true){
  const data=new Map(Object.entries(entries)),reads=[],writes=[],events=new Map(),styles=new Map();
  const root={dataset:{readerTheme:'sepia'},style:{setProperty:(key,value)=>styles.set(key,value)}};
  let present=parsed,observer;
  const storage={getItem:key=>{reads.push(key);if(failure==='read')throw Error('denied');return data.get(key)??null;},setItem:(key,value)=>{if(failure==='write')throw Error('quota');writes.push([key,value]);data.set(key,value);}};
  const window={addEventListener:(name,handler)=>events.set(name,handler)};
  Object.defineProperty(window,'localStorage',{get(){if(failure==='getter')throw Error('blocked');return storage;}});
  const context=vm.createContext({window,document:{documentElement:{},querySelector:()=>present?root:null,addEventListener:()=>{}},MutationObserver:class{constructor(callback){observer=callback;}observe(){}disconnect(){}}});
  vm.runInContext(source,context);
  return {api:window.ReadNovelReaderPreferences,data,reads,writes,root,styles,
    state:()=>JSON.parse(JSON.stringify(window.ReadNovelReaderPreferences.snapshot())),
    pageshow:persisted=>events.get('pageshow')({persisted}),
    parse:()=>{present=true;observer();},again:()=>vm.runInContext(source,context)};
}
test('empty storage: SSR defaults, only six settings reads, zero bootstrap writes',()=>{
  const app=boot({'unrelated.app':'keep'});
  assert.deepEqual(app.state(),defaults);assert.equal(app.reads.length,6);assert.equal(app.writes.length,0);
  assert.equal(app.data.get('unrelated.app'),'keep');assert.equal(app.styles.get('--reader-font-size'),'19px');
});
test('canonical v1 restore: one read, whitelisted values applied before parser content',()=>{
  const app=boot({[KEY]:JSON.stringify({...saved,unknown:'ignored'})},null,false);
  assert.equal(app.reads.length,1);assert.deepEqual(app.state(),desired);
  app.parse();assert.equal(app.root.dataset.readerTheme,'dark');assert.equal(app.styles.get('--reader-font-family'),"'Merriweather', Georgia, serif");
  assert.equal(app.styles.get('--reader-content-width'),'48rem');assert.equal(app.writes.length,0);
});
test('invalid fields fall back separately while valid preferences survive',()=>{
  const app=boot({[KEY]:JSON.stringify({...saved,fontFamily:'url(invalid)',fontSize:'23',readingWidth:'999px'})});
  assert.deepEqual(app.state(),{...desired,fontFamily:'Lora',fontSize:19,readingWidth:'normal'});
});
test('malformed JSON, primitives, missing/unsupported version and arrays are safe',()=>{
  for(const raw of ['{','null','[]','23','"dark"','true','{}','{"version":2,"theme":"dark"}']){
    const app=boot({[KEY]:raw,reader_theme:'dark'});
    assert.deepEqual(app.state(),defaults,raw);assert.equal(app.data.get(KEY),raw);assert.equal(app.writes.length,0);
  }
});
test('strict font-size types/bounds, including exponent overflow, reject unsafe CSS',()=>{
  for(const fontSize of ['23',null,false,14,29,15.5]){
    assert.deepEqual(boot({[KEY]:JSON.stringify({...saved,fontSize})}).state(),{...desired,fontSize:19});
  }
  assert.equal(boot({[KEY]:'{"version":1,"theme":"dark","fontSize":1e999}'}).state().fontSize,19);
  for(const fontSize of [15,28]) assert.equal(boot({[KEY]:JSON.stringify({...saved,fontSize})}).state().fontSize,fontSize);
});
test('line height accepts only numeric presets, missing fields use defaults',()=>{
  for(const lineHeight of ['2.1',null,false,0,1.75,99]){
    assert.equal(boot({[KEY]:JSON.stringify({...saved,lineHeight})}).state().lineHeight,1.85);
  }
  assert.deepEqual(boot({[KEY]:'{"version":1,"theme":"light"}'}).state(),{...defaults,theme:'light'});
});
test('all enum fields reject unknown types/values without erasing other valid fields',()=>{
  for(const [field,values] of Object.entries({theme:['unknown',{},null,1],fontFamily:['Arial',{},null],readingWidth:['68ch',{},false]})){
    for(const value of values) assert.deepEqual(boot({[KEY]:JSON.stringify({...saved,[field]:value})}).state(),{...desired,[field]:defaults[field]});
  }
});
test('Next.js settings are read-only legacy fallback, unrelated and legacy keys survive',()=>{
  const legacy={reader_theme:'dark',reader_fontFamily:'Merriweather',reader_fontSize:'23',reader_lineHeight:'2.1',reader_maxWidth:'wide',reader_bookmarks:'unread',other:'keep'};
  const app=boot(legacy);assert.deepEqual(app.state(),desired);assert.equal(app.writes.length,0);
  app.api.update('fontSize',24);assert.equal(app.writes.length,1);assert.equal(app.writes[0][0],KEY);
  for(const [key,value] of Object.entries(legacy))assert.equal(app.data.get(key),value);
  assert(!app.reads.includes('reader_bookmarks'));
});
test('invalid legacy numeric values cannot become CSS or bypass presets',()=>{
  for(const value of ['Infinity','NaN','23px','-1','29','null']){
    const app=boot({reader_theme:'dark',reader_fontSize:value,reader_lineHeight:'2'});
    assert.deepEqual(app.state(),{...defaults,theme:'dark'});
  }
});
test('blocked getter/read and quota failures keep all in-page settings functional',()=>{
  for(const failure of ['getter','read','write']){
    const app=boot({},failure);app.api.update('theme','dark');app.api.update('fontFamily','Roboto');app.api.adjustSize(1);
    assert.deepEqual(app.state(),{...defaults,theme:'dark',fontFamily:'Roboto',fontSize:20});
    assert.equal(app.root.dataset.readerTheme,'dark');assert.equal(app.styles.get('--reader-font-size'),'20px');
  }
});
test('one changed value creates one sanitized write; no-op/invalid values create none',()=>{
  const app=boot({[KEY]:JSON.stringify({...saved,profile:'do not copy',chapterContent:'do not copy'})});
  app.api.update('fontSize',24);app.api.update('fontSize',24);app.api.update('fontSize','25');app.api.update('__proto__',{});
  assert.equal(app.writes.length,1);assert.deepEqual(JSON.parse(app.writes[0][1]),{...saved,fontSize:24});
  for(let i=0;i<50;i++)app.api.adjustSize(1);
  assert.equal(app.state().fontSize,28);assert.equal(app.writes.length,5);
  assert.equal(app.api.adjustSize(Infinity),false);assert.equal(app.api.adjustSize(.5),false);
});
test('snapshot clones and bootstrap/controller subscriptions do not become conflicting state',()=>{
  const app=boot();const first=app.api.snapshot();first.theme='dark';assert.equal(app.state().theme,'sepia');
  let calls=0;const unsubscribe=app.api.subscribe(()=>calls++);
  const reads=app.reads.length;app.again();assert.equal(app.reads.length,reads);
  app.api.update('theme','dark');assert.equal(calls,2);unsubscribe();app.api.update('theme','light');assert.equal(calls,2);
});
test('BFCache resume reads latest preferences once, not on normal pageshow or unchanged values',()=>{
  const app=boot({[KEY]:JSON.stringify(saved)});let calls=0;app.api.subscribe(()=>calls++);
  app.pageshow(false);assert.equal(app.reads.length,1);
  app.data.set(KEY,JSON.stringify({...saved,theme:'light'}));app.pageshow(true);
  assert.equal(app.reads.length,2);assert.equal(app.state().theme,'light');assert.equal(calls,2);
  app.pageshow(true);assert.equal(calls,2);assert.equal(app.writes.length,0);
});
test('failed write preserves unsaved state across BFCache; full reload reads saved data',()=>{
  const initial={[KEY]:JSON.stringify(saved)};const app=boot(initial,'write');
  app.api.update('fontSize',24);app.pageshow(true);assert.equal(app.state().fontSize,24);
  assert.equal(boot(initial).state().fontSize,23);
});
