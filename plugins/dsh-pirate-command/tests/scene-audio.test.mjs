import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneAudio } from '../web/src/scene-audio.js';
import { createSceneEventFeed } from '../web/src/scene-events.js';

function fixture(suspended=false){
  const nodes=[],params=[],parameter=()=>({value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(value){params.push(value);}});
  const node=()=>{const n={gain:parameter(),frequency:parameter(),Q:parameter(),threshold:parameter(),ratio:parameter(),connect(){return this;},disconnect(){},start(){this.started=true;},stop(){this.stopped=true;this.onended?.();}};nodes.push(n);return n;};
  let resolveResume,rejectResume;
  const context={state:suspended?'suspended':'running',currentTime:0,sampleRate:200,destination:{},createGain:node,createDynamicsCompressor:node,createBiquadFilter:node,createOscillator:node,createBufferSource:node,
    createBuffer:(_,length)=>({getChannelData:()=>new Float32Array(length)}),
    resume:()=>new Promise((resolve,reject)=>{resolveResume=()=>{context.state='running';resolve();};rejectResume=reject;}),
    close:async()=>{context.state='closed';}};
  let created=0;const audio=createSceneAudio({contextFactory:()=>{created++;return context;}});
  return {audio,context,nodes,params,resume:()=>resolveResume(),reject:()=>rejectResume(new Error('suspended')),created:()=>created};
}
const snap=(phase,extra={})=>({phase,perform:['working','commanding','aggregating'].includes(phase),events:[],...extra});
test('默认静音不创建音频；晚到resume在再次静音或销毁后不恢复输出',async()=>{
  const f=fixture(true);f.audio.play('cannon');assert.equal(f.created(),0);
  const enabling=f.audio.setMuted(false);await f.audio.setMuted(true);f.resume();await enabling;
  assert.equal(f.audio.status().muted,true);assert.ok(!f.params.includes(.42));
  const g=fixture(true),pending=g.audio.setMuted(false);g.audio.destroy();g.resume();await pending;
  assert.ok(!g.params.includes(.42));assert.equal(g.audio.play('victory'),false);
});
test('历史和停止清理声音，终态不重复；新回合相同终态仍提示一次',async()=>{
  const f=fixture();await f.audio.setMuted(false);
  f.audio.sync(snap('commanding',{events:[{type:'status',stage:'commanding'}]}));assert.equal(f.audio.status().counts.dispatch,1);
  f.audio.sync(snap('working',{restoreWorld:true}));assert.equal(f.audio.status().voices,0);
  f.audio.sync(snap('waiting'));assert.equal(f.audio.status().counts.waiting,1);assert.equal(f.audio.status().counts.victory,undefined);
  f.audio.sync(snap('waiting'));assert.equal(f.audio.status().counts.waiting,1);
  f.audio.sync(snap('complete'));f.audio.sync(snap('complete'));assert.equal(f.audio.status().counts.victory,1);
  f.audio.sync(snap('complete',{initialize:true}));assert.equal(f.audio.status().counts.victory,2);
  f.audio.sync(snap('cancelled',{stop:true}));assert.equal(f.audio.status().voices,0);
  f.context.currentTime=3;f.audio.update();assert.equal(f.audio.status().counts.drum,undefined);
  f.audio.destroy();
});
test('取消静音只恢复当前氛围，不把静音期间的终态曲补播',async()=>{
  const f=fixture();f.audio.sync(snap('complete'));await f.audio.setMuted(false);f.audio.update();
  assert.equal(f.audio.status().counts.victory,undefined);
  f.audio.sync(snap('working'));f.context.currentTime=1;f.audio.update();assert.equal(f.audio.status().counts.drum,1);
  await f.audio.setMuted(true);assert.equal(f.audio.status().voices,0);f.context.currentTime=4;f.audio.update();assert.equal(f.audio.status().counts.drum,1);f.audio.destroy();
});

test('公开局部等待或失败保留其他船员的战鼓；整体等待仍提示一次',async()=>{
  for(const stage of ['waiting','failed']){
    const f=fixture(),feed=createSceneEventFeed();await f.audio.setMuted(false);
    feed.push({id:'a',state:'running'},[{seq:1,role:'closedoff',type:'status',stage:'working'},{seq:2,role:'blog',type:'status',stage}]);
    f.audio.sync(feed.drain());f.context.currentTime=1;f.audio.update();assert.equal(f.audio.status().counts.drum,1);
    f.audio.destroy();
  }
  const f=fixture(),feed=createSceneEventFeed();await f.audio.setMuted(false);
  const events=[{seq:1,role:'blog',type:'status',stage:'waiting'}];
  feed.push({id:'a',state:'running'},events);f.audio.sync(feed.drain());
  feed.push({id:'a',state:'waiting'},events);f.audio.sync(feed.drain());
  feed.push({id:'a',state:'waiting'},events);f.audio.sync(feed.drain());
  assert.equal(f.audio.status().counts.waiting,1);f.audio.destroy();
});

test('停止状态轮询不按轮询频率重触发环境短音；开启失败返回实际结果',async()=>{
  const f=fixture();assert.equal(await f.audio.setMuted(false),true);
  for(let time=1;time<=8;time++){
    f.audio.sync(snap('cancelled',{stop:true}));f.context.currentTime=time;f.audio.update();
  }
  assert.equal(f.audio.status().counts.creak,1);assert.equal(f.audio.status().counts.gull,undefined);f.audio.destroy();
  const g=fixture(true),pending=g.audio.setMuted(false);g.reject();assert.equal(await pending,false);assert.equal(g.audio.status().muted,true);g.audio.destroy();
});
