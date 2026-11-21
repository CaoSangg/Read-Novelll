'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {
  executionContextLost, exceptionDetails, readerDocumentAvailable, shutdownBrowser,
} = require('../scripts/reader_qa_cdp.cjs');

test('context detection is limited to protocol loss messages and incomplete DOM is recognized', () => {
  assert.equal(executionContextLost('Cannot find context with specified id'),true);
  assert.equal(executionContextLost('Execution context was destroyed.'),true);
  assert.equal(executionContextLost('uniqueContextId not found'),true);
  assert.equal(executionContextLost('Navigation script threw a TypeError'),false);
  assert.equal(executionContextLost('Context setup failed'),false);
  assert.equal(readerDocumentAvailable({documentElement:null,defaultView:{}}),false);
  assert.equal(readerDocumentAvailable({documentElement:{},defaultView:{}}),true);
});

test('exception diagnostics preserve code location and context without serializing the exception object', () => {
  const sampled = exceptionDetails({
    exceptionId:7,executionContextId:11,text:'Uncaught',url:'http://test.invalid/script.js',
    lineNumber:2,columnNumber:4,
    exception:{className:'TypeError',description:'TypeError: sample\nraw unsafe stack',objectId:'private handle'},
    stackTrace:{callFrames:[{functionName:'read',scriptId:'4',url:'http://test.invalid/script.js',lineNumber:2,columnNumber:4}]},
  },()=>null,value=>value);
  assert.equal(sampled.executionContextId,11);
  assert.equal(sampled.message,'TypeError: sample');
  assert.deepEqual(sampled.stack,[{function:'read',scriptId:'4',url:null,line:2,column:4}]);
  assert.doesNotMatch(JSON.stringify(sampled),/raw unsafe stack|private handle|test.invalid/);
});

class MockBrowser extends EventTarget {
  readyState = WebSocket.OPEN;
  closes = 0;
  constructor({ack = true,end = true} = {}) {
    super();
    this.ack = ack;
    this.end = end;
  }
  send(value) {
    assert.deepEqual(JSON.parse(value),{id:1,method:'Browser.close'});
    if (this.ack) queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:'{"id":1,"result":{}}'})));
  }
  close() {
    this.closes++;
    this.readyState = WebSocket.CLOSING;
    if (this.end) queueMicrotask(()=>{
      this.readyState = WebSocket.CLOSED;
      const event = new Event('close');
      event.code = 1000;
      this.dispatchEvent(event);
    });
  }
}

test('close acknowledgement releases the client socket and waits for transport close', async () => {
  const socket = new MockBrowser();
  const trace = [];
  await shutdownBrowser(socket,line=>trace.push(line));
  assert.equal(socket.closes,1);
  assert.deepEqual(trace,[
    'Browser.close sent','Browser.close acknowledged; closing client socket',
    'Browser.close WebSocket closed (1000, acknowledged=true)',
  ]);
});

test('acknowledgement without transport close is still a shutdown failure', async () => {
  const socket = new MockBrowser({end:false});
  await assert.rejects(shutdownBrowser(socket,()=>{},10),/did not close after acknowledgement/);
  assert.equal(socket.closes,1);
});
