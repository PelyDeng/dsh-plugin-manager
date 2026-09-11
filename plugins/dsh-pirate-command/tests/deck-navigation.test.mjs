import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DECK_POINTS,DECK_EDGES,DECK_LEVELS,TRANSIT_NODES,CREW_STOPS,MIN_SEPARATION,canStopDeckNode,deckElevation,sameDeckLevel,segmentDistance,deckRoute,createDeckWalker,availableStop,moveDeckWalker,stopDeckWalker,settleDeckWalker,stepDeckWalkers,walkerBusy,meetingStop } from '../web/src/deck-navigation.js';

const fleetAt=nodes=>nodes.map((node,i)=>createDeckWalker(['jack','barbossa','elizabeth'][i],node));
function checkSeparation(fleet){
  for(const walker of fleet){
    const from=DECK_POINTS[walker.segment?.from??walker.node],to=DECK_POINTS[walker.segment?.to??walker.node];
    assert.ok(segmentDistance([walker.x,walker.y],from,to)<.002,'行走及退让必须留在标定路段');
  }
  for(let i=0;i<fleet.length;i++)for(let j=i+1;j<fleet.length;j++){
    const d=Math.hypot(fleet[i].x-fleet[j].x,fleet[i].y-fleet[j].y);
    assert.ok(d>=MIN_SEPARATION-.002,`脚底相交 ${fleet[i].id}/${fleet[j].id}: ${d}`);
  }
}
function finish(fleet,targets=null){
  const reached=fleet.map(()=>false);
  for(let i=0;i<4500&&fleet.some(walkerBusy);i++){
    stepDeckWalkers(fleet,33,105);checkSeparation(fleet);
    fleet.forEach((walker,index)=>{if(targets&&walker.node===targets[index]&&!walker.segment)reached[index]=true;});
  }
  assert.ok(fleet.every(walker=>!walkerBusy(walker)),JSON.stringify(fleet));
  if(targets)assert.ok(reached.every(Boolean),`漫游目标不能因让路而丢失: ${JSON.stringify({targets,reached})}`);
}
function inside(point,polygon){
  let result=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j];
    if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])result=!result;
  }
  return result;
}
const geometry=JSON.parse(readFileSync(new URL('../resources/tools/processing/pearl-yaw-v02/geometry-v02.json',import.meta.url)));
const polygonDistance=(point,polygon)=>Math.min(...polygon.map((a,i)=>segmentDistance(point,a,polygon[(i+1)%polygon.length])));
const samples=(from,to,count=160)=>Array.from({length:count+1},(_,i)=>DECK_POINTS[from].map((value,axis)=>value+(DECK_POINTS[to][axis]-value)*i/count));
test('新母版桌脚、火炮与后坐包络均留出角色脚底通路',()=>{
  assert.deepEqual(DECK_POINTS,geometry.points);assert.deepEqual(DECK_EDGES,geometry.edges);
  assert.equal(geometry.actorSeparation,MIN_SEPARATION);
  for(const [from,to] of DECK_EDGES)for(const p of samples(from,to)){
    for(const [label,footprint,clearance] of [['海图桌',geometry.footprint,22],...geometry.gunFootprints.map((poly,i)=>[`火炮${i+1}`,poly,19])]){
      assert.ok(!inside(p,footprint),`${label}足迹相交: ${from}->${to}`);
      assert.ok(polygonDistance(p,footprint)>=clearance,`${label}净距不足: ${from}->${to}`);
    }
  }
});
test('所有新路线连通，主甲板绕开原图桅杆、桶、格栅并保留脚底余量',()=>{
  for(const stops of Object.values(CREW_STOPS))assert.deepEqual(stops,DECK_POINTS.map((_,node)=>node).filter(canStopDeckNode));
  for(let i=0;i<DECK_POINTS.length;i++)for(let j=0;j<DECK_POINTS.length;j++)assert.ok(deckRoute(i,j).length);
  for(const [from,to] of DECK_EDGES)for(const p of samples(from,to)){
    if(from<20&&to<20){
      assert.ok(inside(p,geometry.mainDeck),`离开主甲板支撑平面: ${from}->${to}`);
      assert.ok(!inside(p,geometry.grate),`穿过格栅: ${from}->${to}`);
      assert.ok(polygonDistance(p,geometry.grate)>=19,`格栅脚底余量不足: ${from}->${to}`);
    }
    for(const [x,y,rx,ry] of geometry.solidEllipses){
      assert.ok(((p[0]-x)/rx)**2+((p[1]-y)/ry)**2>=1,`穿过底座 ${x},${y}: ${from}->${to}`);
      const boundary=Array.from({length:120},(_,i)=>[x+rx*Math.cos(i*Math.PI/60),y+ry*Math.sin(i*Math.PI/60)]);
      assert.ok(polygonDistance(p,boundary)>=19,`底座脚底余量不足 ${x},${y}: ${from}->${to}`);
    }
  }
  assert.ok(inside(DECK_POINTS[20],geometry.stairs));assert.ok(inside(DECK_POINTS[21],geometry.stairs));
  for(const node of [22,23,24])assert.ok(inside(DECK_POINTS[node],geometry.upperDeck));
});

test('楼梯连接上下甲板，楼梯和平台窄过道只通行不选作停靠位',()=>{
  const route=deckRoute(7,24);
  assert.deepEqual(route,[7,20,21,22,24]);
  const fleet=fleetAt([0,7,11]);
  for(const node of TRANSIT_NODES){
    assert.equal(canStopDeckNode(node),false);
    assert.equal(availableStop(fleet,fleet[0],node),false);
    assert.equal(moveDeckWalker(fleet,fleet[0],node),false);
    for(const stops of Object.values(CREW_STOPS))assert.ok(!stops.includes(node));
  }
  assert.equal(DECK_LEVELS[7],0);assert.equal(DECK_LEVELS[24],1);
});

test('船员沿真实楼梯上下，投影脚底和逻辑高度分别插值',()=>{
  const fleet=fleetAt([7]),walker=fleet[0];
  for(const [goal,direction] of [[24,1],[7,-1]]){
    assert.ok(moveDeckWalker(fleet,walker,goal));let previous=deckElevation(walker),sawStair=false;
    for(let frame=0;frame<800&&walkerBusy(walker);frame++){
      stepDeckWalkers(fleet,33,105);checkSeparation(fleet);
      const level=deckElevation(walker);
      assert.ok(direction*(level-previous)>=-.001);
      if(level>0&&level<1)sawStair=true;
      previous=level;
    }
    assert.equal(walker.node,goal);assert.ok(sawStair);
  }
});

test('楼梯或上层过道中途暂停仍落脚到安全平台，不留在通行点',()=>{
  for(const [start,goal,transit] of [[7,24,21],[24,7,21],[23,24,22]]){
    const fleet=fleetAt([start]),walker=fleet[0];assert.ok(moveDeckWalker(fleet,walker,goal));
    for(let frame=0;frame<800&&walker.segment?.to!==transit;frame++)stepDeckWalkers(fleet,33,105);
    assert.equal(walker.segment?.to,transit);
    stopDeckWalker(walker);walker.paused=true;finish(fleet);
    assert.ok(canStopDeckNode(walker.node));assert.equal(walker.segment,null);
  }
});

test('会面必须在同层安全落脚处，楼梯中的船员不能发起相向交谈',()=>{
  const fleet=fleetAt([8,21,0]),jack=fleet[0],crew=fleet[1];
  assert.ok(Math.hypot(jack.x-crew.x,jack.y-crew.y)<145);
  assert.equal(meetingStop(fleet,jack,crew),null);assert.equal(sameDeckLevel(jack,crew),false);
  const upper=fleetAt([7,23,0]);upper[1].pinned=true;upper[1].paused=true;
  const target=meetingStop(upper,upper[0],upper[1]);assert.equal(target,24);
  assert.equal(sameDeckLevel(upper[0],upper[1]),false);
  assert.ok(moveDeckWalker(upper,upper[0],target));finish(upper);
  assert.equal(sameDeckLevel(upper[0],upper[1]),true);
});

test('两名上层船员下楼时第三人上楼，三人的业务目标都能完成',()=>{
  const fleet=fleetAt([7,23,24]),targets=[24,9,5];
  assert.ok(moveDeckWalker(fleet,fleet[1],9));assert.ok(moveDeckWalker(fleet,fleet[2],5));
  for(let i=0;i<500&&!availableStop(fleet,fleet[0],24);i++){stepDeckWalkers(fleet,33,105);checkSeparation(fleet);}
  assert.ok(moveDeckWalker(fleet,fleet[0],24));finish(fleet,targets);
  assert.ok(fleet.every(walker=>canStopDeckNode(walker.node)));
});
test('不选被占用或其他船员已预订的停靠位',()=>{
  const fleet=fleetAt([0,7,11]);
  assert.equal(moveDeckWalker(fleet,fleet[0],7),false);
  assert.equal(moveDeckWalker(fleet,fleet[0],9),true);
  assert.equal(availableStop(fleet,fleet[1],9),false);
});
test('三人相向交错行走不穿过静止船员，也不永久卡住',()=>{
  const fleet=fleetAt([0,7,11]);
  assert.equal(moveDeckWalker(fleet,fleet[0],9),true);
  assert.equal(moveDeckWalker(fleet,fleet[1],1),true);
  assert.equal(moveDeckWalker(fleet,fleet[2],4),true);
  finish(fleet,[9,1,4]);
});
test('七个固定种子的 42 轮新母版三人漫游保留未完成目标，并解除相向与连锁堵塞',()=>{
  for(const initialSeed of [1,3,9,12,14,20,731]){
    const fleet=fleetAt([0,7,11]);let seed=initialSeed;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    for(let round=0;round<6;round++){
      const targets=fleet.map(walker=>{
        const choices=DECK_POINTS.map((_,node)=>node).filter(node=>node!==walker.node&&availableStop(fleet,walker,node));
        assert.ok(choices.length);
        const target=choices[Math.floor(random()*choices.length)];assert.ok(moveDeckWalker(fleet,walker,target));return target;
      });
      // 已抵达的闲置船员可以让出旧停靠位，但尚未完成的目的地必须保留。
      finish(fleet,targets);
    }
  }
});
test('空旷的不同路段仍允许三名船员同时行走',()=>{
  const fleet=fleetAt([0,4,7]);
  [1,16,8].forEach((target,i)=>assert.ok(moveDeckWalker(fleet,fleet[i],target)));
  stepDeckWalkers(fleet,33,54);checkSeparation(fleet);
  assert.ok(fleet.every(walker=>walker.moving));
});
test('船长只到可达空位会面，谈话船员不会被让路逻辑推走',()=>{
  for(const [start,crewNode] of [[7,1],[0,1],[0,7],[11,6]]){
    const fleet=fleetAt([start,crewNode,3]),jack=fleet[0],crew=fleet[1];
    crew.pinned=true;crew.paused=true;jack.priority=2;
    const target=meetingStop(fleet,jack,crew);assert.notEqual(target,null);
    assert.ok(moveDeckWalker(fleet,jack,target));finish(fleet);
    assert.equal(crew.node,crewNode);
    const separation=Math.hypot(jack.x-crew.x,jack.y-crew.y);
    assert.ok(separation>=52&&separation<=145);
  }
});
test('行走中接到会面要求会沿当前路段落脚，不跳到隔壁路线',()=>{
  const fleet=fleetAt([0,23,24]),walker=fleet[0];
  moveDeckWalker(fleet,walker,9);stepDeckWalkers(fleet,200,105);
  assert.ok(walker.segment);
  const endpoint=walker.next,position=[walker.x,walker.y];
  stopDeckWalker(walker);settleDeckWalker(walker);
  assert.deepEqual([walker.x,walker.y],position);
  finish(fleet);assert.equal(walker.node,endpoint);
});
test('连锁让路期间切换到会面，会撤销旧交通安排并保留相向会面位置',()=>{
  const fleet=fleetAt([0,7,11]),jack=fleet[0],crew=fleet[1];
  [9,1,4].forEach((target,i)=>moveDeckWalker(fleet,fleet[i],target));
  for(let i=0;i<100&&!fleet.some(walker=>walker.coordinating);i++){stepDeckWalkers(fleet,33,105);checkSeparation(fleet);}
  assert.ok(fleet.some(walker=>walker.coordinating));
  stopDeckWalker(jack);stopDeckWalker(fleet[2]);crew.pinned=true;settleDeckWalker(crew);
  finish(fleet);const crewNode=crew.node;crew.paused=true;jack.priority=2;
  const target=meetingStop(fleet,jack,crew);assert.notEqual(target,null);assert.ok(moveDeckWalker(fleet,jack,target));
  finish(fleet);assert.equal(jack.node,target);assert.equal(crew.node,crewNode);
});
