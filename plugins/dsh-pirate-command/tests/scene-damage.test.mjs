import test from 'node:test';
import assert from 'node:assert/strict';
import { createShipDamage } from '../web/src/scene-damage.js';

test('四帧火焰固定基部和体尺，减少动态及历史不推进，新轮清零',()=>{
  const image=()=>({visible:true,setVisible(v){this.visible=v;return this;},setFrame(v){this.frame=v;return this;},setAlpha(){return this;},setPosition(){return this;},setDisplaySize(w,h){this.size=[w,h];return this;},setAngle(){return this;},setOrigin(x,y){this.origin=[x,y];return this;}});
  const group={add(){},setDepth(){return this;},setVisible(){return this;}};
  const registered=[];
  const scene={ship:{add(){}},add:{container:()=>group,image},textures:{get:()=>({add:(...args)=>registered.push(args)})}};
  const config={scar:'scar',fire:'fire',fireFrames:[0,256,512,768].map(x=>[x,0,256,256]),fireFrameMs:120,spots:[{x:700,y:845,size:100,fire:[565,684]},{x:1000,y:928,size:112,fire:[1130,795]}]};
  const damage=createShipDamage(scene,config);
  assert.deepEqual(registered,config.fireFrames.map((rect,i)=>[i,0,...rect]));
  const tick=()=>{for(let i=0;i<3;i++)damage.update(40,false);};
  damage.sync({mission:{state:'failed'},initialize:true});damage.update(0,false);
  const order=[damage.fires[0].frame];
  for(let i=0;i<4;i++){tick();order.push(damage.fires[0].frame);assert.equal(damage.fires[1].frame,(damage.fires[0].frame+2)%4);}
  assert.deepEqual(order,[0,1,2,3,0]);
  for(const fire of damage.fires){assert.deepEqual(fire.size,[96,96]);assert.deepEqual(fire.origin,[.5,.8125]);assert.equal(fire.visible,true);}
  const paused=damage.time;damage.update(40,true);assert.equal(damage.time,paused);assert.ok(damage.fires.every(f=>!f.visible));
  damage.sync({mission:{state:'failed'}});tick();assert.equal(damage.time,paused+120,'重复失败状态不重播开头');
  damage.sync({mission:{state:'failed'},restoreWorld:true});tick();assert.equal(damage.time,0);assert.ok(damage.fires.every(f=>!f.visible));
  damage.sync({mission:{state:'running'},roleStages:{elizabeth:'failed'},initialize:true});tick();assert.equal(damage.severity,.45);assert.ok(damage.fires.every(f=>!f.visible));
  damage.sync({mission:{state:'failed'},initialize:true});damage.update(0,false);assert.deepEqual(damage.fires.map(f=>f.frame),[0,2]);
  damage.sync({stop:true});tick();assert.equal(damage.severity,0);assert.equal(damage.time,0);assert.ok(damage.fires.every(f=>!f.visible));
});
