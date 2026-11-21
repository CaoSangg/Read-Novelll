/* Exercise the actual production policy and pending-jump state machine. */
const test = require('node:test');
const assert = require('node:assert/strict');
const {validSequence, chapterUrl, decision, createJump} = require('../app/static/js/reader_toc.js');

test('current chapter stays, backward chapter navigates without progress', () => {
  assert.equal(decision(9,15,9),'stay');
  for(const sequence of [1,3]) assert.equal(decision(9,15,sequence),'direct');
});
test('Published next neighbor is adjacent across gaps; other forward targets confirm', () => {
  assert.equal(decision(1,3,3),'direct');
  assert.equal(decision(1,3,9),'confirm');
  assert.equal(decision(1,3,15),'confirm');
  assert.equal(decision(9,15,15),'direct');
});
test('missing, wrong-direction or malformed next metadata requires forward confirmation', () => {
  for(const next of [null,undefined,0,NaN,9,3,'15',2147483648]) assert.equal(decision(9,next,15),'confirm');
});
test('invalid current/target types or route bounds reject rather than navigating', () => {
  for(const value of [undefined,null,false,'3',NaN,Infinity,0,-1,1.5,2147483648,{},[]]){
    assert.equal(validSequence(value),false);
    assert.equal(decision(1,3,value),'reject');
    assert.equal(decision(value,3,9),'reject');
  }
  for(const value of [1,2147483647]) assert.equal(validSequence(value),true);
});
test('URL generation encodes Unicode and only produces relative Reader paths', () => {
  assert.equal(chapterUrl('truyện-漢字_qa',9),'/novel/truy%E1%BB%87n-%E6%BC%A2%E5%AD%97_qa/9');
  assert.equal(chapterUrl('a'.repeat(255),1),`/novel/${'a'.repeat(255)}/1`);
  for(const slug of ['',null,{},'a'.repeat(256),'../x','//evil.test','https://evil.test','javascript:alert(1)','x?next=evil','x#y','a/b','a%2fb','x\n','x" onerror=x','e\u0301']) assert.equal(chapterUrl(slug,1),null);
  assert.equal(chapterUrl('safe',0),null);
});
function setup(current=1,next=3,slug='safe'){
  const navigations=[];
  return {navigations,jump:createJump(current,next,slug,url=>navigations.push(url))};
}
test('current, malformed sequence and unsafe slug produce zero navigation', () => {
  const {jump,navigations}=setup();
  assert.equal(jump.select(1).action,'stay');assert.equal(jump.select('3').action,'reject');
  assert.deepEqual(navigations,[]);
  assert.equal(setup(1,3,'//bad').jump.select(3).action,'reject');
});
test('direct adjacent/backward navigation commits once despite repeated clicks', () => {
  for(const [current,next,target] of [[1,3,3],[9,15,1]]){
    const {jump,navigations}=setup(current,next);
    assert.equal(jump.select(target).action,'direct');
    assert.equal(jump.select(target).action,'ignore');
    assert.equal(jump.confirm(1),false);
    assert.deepEqual(navigations,[`/novel/safe/${target}`]);
  }
});
test('forward selection only creates a pending target; Cancel never navigates', () => {
  const {jump,navigations}=setup();const pending=jump.select(9);
  assert.equal(pending.action,'confirm');assert.deepEqual(navigations,[]);
  jump.cancel();assert.equal(jump.confirm(pending.ticket),false);
  assert.deepEqual(navigations,[]);assert.equal(jump.select(3).action,'direct');
});
test('Confirm uses the generated pending URL, once only', () => {
  const {jump,navigations}=setup();const pending=jump.select(15);
  assert.equal(jump.confirm(pending.ticket),true);assert.equal(jump.confirm(pending.ticket),false);
  assert.equal(jump.select(9).action,'ignore');assert.deepEqual(navigations,['/novel/safe/15']);
});
test('rapid selection cannot replace an open confirmation with another target', () => {
  const {jump,navigations}=setup();const pending=jump.select(9);
  assert.equal(jump.select(15).action,'ignore');assert.equal(jump.select(3).action,'ignore');
  jump.confirm(pending.ticket);assert.deepEqual(navigations,['/novel/safe/9']);
});
test('stale tickets after Cancel or drawer reset cannot confirm a later selection', () => {
  const {jump,navigations}=setup();const old=jump.select(9);jump.cancel();const fresh=jump.select(15);
  assert.equal(jump.confirm(old.ticket),false);assert.deepEqual(navigations,[]);
  jump.reset();assert.equal(jump.confirm(fresh.ticket),false);
  const last=jump.select(9);assert.notEqual(last.ticket,old.ticket);
  assert.equal(jump.confirm(last.ticket),true);assert.deepEqual(navigations,['/novel/safe/9']);
});
test('pending decision is immutable and restore/reset permits fresh native navigation', () => {
  const {jump,navigations}=setup();const pending=jump.select(9);
  assert.equal(Object.isFrozen(pending),true);jump.confirm(pending.ticket);
  jump.reset();assert.equal(jump.select(3).action,'direct');
  assert.deepEqual(navigations,['/novel/safe/9','/novel/safe/3']);
});
