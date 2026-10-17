import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeQueue } from '../src/bridgequeue.js';
process.env.DISCORD_TOKEN='test-token';process.env.BRIDGE_SECRET='test-secret';
const { createMcApi }=await import('../src/mcapi.js');
const silent={log(){},warn(){}};
const response={enabled:true,active:true,matchKey:'mc-a:7',teams:[{number:1}],links:[]};

function environment() {
  let now=1000;
  const queue=createBridgeQueue({now:()=>now});
  const api=createMcApi({queue,cfg:{mcApiUrl:'',bridgeSecret:'test'},logger:silent});
  return {queue,api,advance:ms=>{now+=ms;}};
}

test('voice response is rejected if a second instance connects while the request is in flight',async()=>{
  const e=environment();try {
    await e.queue.takeJobs(0,{instanceId:'mc-a'});
    const result=e.api.voiceSnapshot();const [job]=await e.queue.takeJobs(0,{instanceId:'mc-a'});
    await e.queue.takeJobs(0,{instanceId:'mc-b'});
    e.queue.completeJobFrom(job.jobId,200,response,'mc-a');
    const res=await result;assert.equal(res.ok,false);assert.equal(res.errorCode,'multiple_plugin_instances');
  } finally {e.queue.reset();}
});

test('voice bridge refuses duplicate instance IDs behind a proxy then recovers after the ambiguity window',async()=>{
  const e=environment();try {
    const first=new AbortController(),second=new AbortController();
    const polls=[e.queue.takeJobs(100,{instanceId:'same',signal:first.signal}),e.queue.takeJobs(100,{instanceId:'same',signal:second.signal})];
    assert.equal((await e.api.voiceSnapshot()).errorCode,'multiple_plugin_instances');
    first.abort();second.abort();await Promise.all(polls);
    e.advance(60001);assert.equal((await e.api.voiceSnapshot()).errorCode,'plugin_not_connected');
    await e.queue.takeJobs(0,{instanceId:'same'});const result=e.api.voiceSnapshot();
    const [job]=await e.queue.takeJobs(0,{instanceId:'same'});e.queue.completeJobFrom(job.jobId,200,response,'same');
    assert.equal((await result).ok,true);assert.equal(e.queue.stats().waiting,0);
  } finally {e.queue.reset();}
});

test('timed out voice work leaves the queue and a later healthy response can succeed',async()=>{
  const e=environment();try {
    await e.queue.takeJobs(0,{instanceId:'mc-a'});
    const short=createMcApi({queue:e.queue,cfg:{mcApiUrl:''},logger:silent,readTimeoutMs:10});
    assert.equal((await short.voiceSnapshot()).errorCode,'bridge_timeout');
    assert.equal(e.queue.stats().pending,0);assert.equal(e.queue.stats().waiting,0);
    const result=e.api.voiceSnapshot();const [job]=await e.queue.takeJobs(0,{instanceId:'mc-a'});
    e.queue.completeJobFrom(job.jobId,200,response,'mc-a');assert.equal((await result).ok,true);
  } finally {e.queue.reset();}
});
