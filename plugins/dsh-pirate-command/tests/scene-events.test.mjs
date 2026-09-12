import { createSceneAudio } from '../web/src/scene-audio.js';
import { createShipDamage } from '../web/src/scene-damage.js';
import { createShipDetails } from '../web/src/ship-details.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as eventsModule from '../web/src/scene-events.js';
import * as navigation from '../web/src/deck-navigation.js';
import * as atmosphere from '../web/src/scene-atmosphere.js';
import { TaskSignals } from '../web/src/task-signals.js';
const { createSceneEventFeed, previewText } = eventsModule;

const mission = state => ({ id: 'mission-a', state });
const event = (seq, stage, role = 'closedoff') => ({ seq, stage, role, type: 'status', text: '真实状态' });

test('准备素材期间缓存新动作，恢复的历史不进入待演队列', () => {
  const feed = createSceneEventFeed();
  feed.push(mission('running'), [event(1, 'commanding')], { restore: true });
  feed.push(mission('running'), [event(1, 'commanding'), event(2, 'working')]);
  const snapshot = feed.drain();
  assert.equal(snapshot.restoreWorld, true);
  assert.deepEqual(snapshot.events.map(item => item.seq), [2]);
  assert.equal(snapshot.roles.barbossa, '处理中');
  feed.push(mission('running'), [event(1, 'commanding'), event(2, 'working')]);
  assert.deepEqual(feed.drain().events, []);
});

test('正常终态保留真实动作，partial和waiting不作为全部完成', () => {
  for (const state of ['completed', 'partial', 'waiting', 'failed']) {
    const feed = createSceneEventFeed();
    feed.push(mission('running'), [event(1, 'commanding')]);
    feed.push(mission(state), [event(1, 'commanding'), event(2, 'returning')]);
    const snapshot = feed.drain();
    assert.deepEqual(snapshot.events.map(item => item.seq), [1, 2]);
    assert.equal(snapshot.perform, false);
    assert.equal(snapshot.stop, false);
    assert.equal(snapshot.phase, state === 'completed' ? 'complete' : state);
    feed.push(mission(state), [event(1, 'commanding'), event(2, 'returning')]);
    assert.deepEqual(feed.drain().events, []);
  }
});

test('停止清空积压及本批分工和命中，只保留新的公开反馈', () => {
  for (const state of ['stopping', 'cancelled', 'interrupted']) {
    const feed = createSceneEventFeed();
    feed.push(mission('running'), [event(1, 'commanding')]);
    feed.push(mission(state), [event(1, 'commanding'), event(2, 'returning'),
      { seq: 3, role: 'closedoff', type: 'message', text: '已停止的公开反馈' }]);
    const snapshot = feed.drain();
    assert.deepEqual(snapshot.events.map(item => item.seq), [3]);
    assert.equal(snapshot.stop, true);
    assert.equal(snapshot.perform, false);
  }
});

test('新会话游标独立，气泡来自实际文本并按Unicode字符截断', () => {
  const feed = createSceneEventFeed();
  feed.push(mission('running'), [event(20, 'commanding')]);
  feed.drain();
  feed.push({ id: 'mission-b', state: 'running' }, [
    { seq: 1, role: 'jack', type: 'message', text: '伊丽莎白：请整理已确认的查询摘要。' }, event(2, 'commanding', 'blog'),
  ]);
  const snapshot = feed.drain();
  assert.deepEqual(snapshot.events.map(item => item.seq), [1, 2]);
  assert.equal(snapshot.commands.elizabeth, '请整理已确认的查询摘要。');
  assert.equal(snapshot.events[1].commandText, '请整理已确认的查询摘要。');
  assert.equal(previewText('🦜 🦜 🦜', 4), '🦜 🦜…');
});

test('轮询未见上一轮终态时，新轮thinking仍清除旧会面', () => {
  for (const drained of [false, true]) {
    const feed = createSceneEventFeed();
    feed.push(mission('running'), [event(1, 'commanding')]);
    if (drained) feed.drain();
    feed.push(mission('running'), [event(1, 'commanding'), event(2, 'thinking', 'jack'), event(3, 'commanding', 'blog')]);
    const snapshot = feed.drain();
    assert.equal(snapshot.initialize, true);
    assert.deepEqual(snapshot.events.map(item => item.seq), [2, 3]);
    assert.equal(snapshot.roleStages.barbossa, undefined);
  }
});

test('新任务先返回空事件或用户消息，首轮thinking不重复初始化已入场世界', () => {
  const user = { seq: 40, role: 'user', type: 'message', text: '请查询记录' };
  for (const initial of [[], [user]]) {
    const feed = createSceneEventFeed();
    feed.push(mission('running'), initial);
    assert.equal(feed.drain().initialize, true, '任务首次选中仍初始化');
    feed.push(mission('running'), [user]);
    assert.equal(feed.drain().initialize, false, '用户消息不构成另一轮');
    feed.push(mission('running'), [user, event(41, 'thinking', 'jack'), event(42, 'commanding')]);
    const firstTurn = feed.drain();
    assert.equal(firstTurn.initialize, false, '首轮thinking沿用已入场世界');
    assert.deepEqual(firstTurn.events.map(item => item.seq), [41, 42]);
    feed.push(mission('running'), [user, event(41, 'thinking', 'jack'), event(42, 'commanding')]);
    assert.deepEqual(feed.drain().events, [], '相同轮询不重播');
  }
});

test('同批只保留最新轮，首次初始化在素材未就绪时不会丢失', () => {
  const pending = createSceneEventFeed();
  pending.push(mission('running'), []);
  pending.push(mission('running'), [event(1, 'thinking', 'jack'), event(2, 'commanding')]);
  assert.equal(pending.drain().initialize, true);
  const feed = createSceneEventFeed();
  feed.push(mission('running'), []); feed.drain();
  feed.push(mission('running'), [event(1, 'thinking', 'jack'), event(2, 'commanding'),
    event(3, 'thinking', 'jack'), event(4, 'commanding', 'blog')]);
  const snapshot = feed.drain();
  assert.equal(snapshot.initialize, true, '同批实际已有上一轮');
  assert.deepEqual(snapshot.events.map(item => item.seq), [3, 4]);
  assert.equal(snapshot.roleStages.barbossa, undefined);
});

test('待演队列截断或排空不遗忘旧轮，切换任务后重新识别首轮', () => {
  const feed = createSceneEventFeed();
  feed.push(mission('running'), [event(1, 'thinking', 'jack'), event(2, 'commanding')]);
  feed.drain();
  const messages = Array.from({ length: 150 }, (_, i) => ({ seq: i + 3, role: 'user', type: 'message', text: '补充资料' }));
  feed.push(mission('running'), messages);
  assert.equal(feed.drain().events.length, 128);
  feed.push(mission('running'), [...messages, event(153, 'thinking', 'jack'), event(154, 'commanding', 'blog')]);
  assert.equal(feed.drain().initialize, true, '实际旧轮标记不依赖保留的事件');
  const next = { id: 'mission-b', state: 'running' };
  feed.push(next, []); assert.equal(feed.drain().initialize, true);
  feed.push(next, [event(1, 'thinking', 'jack')]);
  assert.equal(feed.drain().initialize, false, '新任务不继承旧任务轮次');
});

test('分页恢复不补演历史，随后新轮仍初始化', () => {
  const feed = createSceneEventFeed();
  const user = { seq: 1, role: 'user', type: 'message', text: '历史要求' };
  feed.push(mission('running'), [user], { restore: true }); feed.drain();
  feed.push(mission('running'), [user, event(2, 'thinking', 'jack'), event(3, 'commanding')], { restore: true });
  const restored = feed.drain();
  assert.equal(restored.restoreWorld, true); assert.deepEqual(restored.events, []);
  feed.push(mission('running'), [user, event(2, 'thinking', 'jack'), event(3, 'commanding'), event(4, 'working')]);
  const continued = feed.drain();
  assert.equal(continued.initialize, false); assert.deepEqual(continued.events.map(item => item.seq), [4]);
  feed.push(mission('running'), [event(5, 'thinking', 'jack'), event(6, 'commanding', 'blog')]);
  assert.equal(feed.drain().initialize, true);
});

test('首轮快速终态保留返回动作，已见终态后新轮不依赖事件游标', () => {
  const feed = createSceneEventFeed();
  feed.push(mission('running'), []); feed.drain();
  feed.push(mission('completed'), [event(1, 'thinking', 'jack'), event(2, 'returning')]);
  const completed = feed.drain();
  assert.equal(completed.initialize, false); assert.equal(completed.phase, 'complete');
  assert.deepEqual(completed.events.map(item => item.seq), [1, 2]);
  feed.push(mission('running'), [event(3, 'thinking', 'jack')]);
  assert.equal(feed.drain().initialize, true);
  const emptyHistory = createSceneEventFeed();
  emptyHistory.push(mission('failed'), [], { restore: true }); emptyHistory.drain();
  emptyHistory.push(mission('running'), [event(1, 'thinking', 'jack')]);
  assert.equal(emptyHistory.drain().initialize, true, '已见失败终态足以区分新轮');
});

test('同ID新轮被接收后，旧历史在真实thinking到达前不能恢复主题或船员状态', () => {
  const previous = [event(1, 'thinking', 'jack'), { seq: 2, type: 'topic', role: 'jack', text: '旧范围' },
    event(3, 'failed'), event(4, 'returning', 'blog')];
  for (const terminal of ['failed', 'completed', 'waiting']) {
    const feed = createSceneEventFeed();
    feed.push(mission(terminal), previous, { restore: true }); feed.drain();
    const boundary = { roundStart: { id: 'mission-a', afterSeq: 4 } };
    for (let poll = 0; poll < 3; poll++) {
      feed.push(mission('running'), previous, boundary);
      const snapshot = feed.drain();
      assert.equal(snapshot.initialize, poll === 0, '新轮只初始化一次');
      assert.equal(snapshot.restoreWorld, false);
      assert.equal(snapshot.phase, 'thinking');
      assert.equal(snapshot.topic, '');
      assert.deepEqual(snapshot.roleStages, {});
      assert.deepEqual(snapshot.commands, {});
      assert.deepEqual(snapshot.replies, {});
      assert.deepEqual(snapshot.events, [], '旧事件不能进入待演队列');
    }
    const waitingForMarker = [...previous, { seq: 5, role: 'user', type: 'message', text: '新要求' }, event(6, 'returning')];
    feed.push(mission('running'), waitingForMarker, boundary);
    assert.deepEqual(feed.drain().roleStages, {}, '序号较新也不能代替后端的真实新轮标记');
    const newTurn = [...waitingForMarker, event(7, 'thinking', 'jack')];
    feed.push(mission('running'), newTurn, boundary);
    const thinking = feed.drain();
    assert.equal(thinking.initialize, false, '首条thinking不再让敌舰入场第二次');
    assert.deepEqual(thinking.events.map(item => item.seq), [7]);
    assert.equal(thinking.topic, '');
    assert.deepEqual(thinking.roleStages, { jack: 'thinking' });
    const published = [...newTurn, { seq: 8, type: 'topic', role: 'jack', text: '新范围' }, event(9, 'working', 'blog')];
    feed.push(mission('running'), published, boundary);
    assert.equal(feed.drain().topic, '新范围');
    feed.push(mission('running'), published, boundary);
    const repeated = feed.drain();
    assert.equal(repeated.topic, '新范围');
    assert.equal(repeated.roleStages.elizabeth, 'working');
    assert.equal(repeated.initialize, false);
    assert.deepEqual(repeated.events, []);
    assert.equal(previous[1].text, '旧范围', '原始完整对话不被修改');
  }
});

test('普通补充保留当前事实，历史恢复与切换任务不继承本地新轮边界', () => {
  const feed = createSceneEventFeed();
  const old = [event(1, 'thinking', 'jack'), { seq: 2, type: 'topic', role: 'jack', text: '当前范围' }, event(3, 'working')];
  feed.push(mission('running'), old); feed.drain();
  const supplement = [...old, { seq: 4, type: 'message', role: 'user', text: '尚未处理的新补充' }];
  feed.push(mission('running'), supplement);
  const current = feed.drain();
  assert.equal(current.topic, '当前范围');
  assert.equal(current.phase, 'working');
  assert.equal(current.roleStages.barbossa, 'working');
  assert.equal(current.initialize, false);
  feed.push(mission('failed'), supplement); feed.drain();
  feed.push(mission('running'), supplement, { roundStart: { id: 'mission-a', afterSeq: 4 } }); feed.drain();
  feed.push(mission('failed'), supplement, { restore: true });
  const restored = feed.drain();
  assert.equal(restored.topic, '当前范围');
  assert.equal(restored.restoreWorld, true);
  assert.deepEqual(restored.events, []);
  feed.push(mission('failed'), supplement);
  assert.equal(feed.drain().topic, '当前范围', '恢复后的普通轮询保留主题');
  feed.push({ id: 'mission-b', state: 'running' }, old, { roundStart: { id: 'mission-a', afterSeq: 4 } });
  assert.equal(feed.drain().topic, '当前范围', '另一个任务不使用旧任务边界');
});

test('只有message更新回复正文，终态恢复也不补演公开历史', () => {
  const feed = createSceneEventFeed();
  const items = [{ seq: 1, role: 'closedoff', type: 'message', text: '公开正文' },
    event(2, 'returning'), { seq: 3, role: 'closedoff', type: 'artifact', text: '成果标题' }];
  feed.push(mission('waiting'), items);
  assert.equal(feed.drain().replies.barbossa, '公开正文');
  feed.push(mission('waiting'), items, { restore: true });
  const restored = feed.drain();
  assert.equal(restored.replies.barbossa, '公开正文');
  assert.deepEqual(restored.events, []);
});

// 使用真实场景方法与寻路；只替代 Phaser 的绘制对象，不声称覆盖浏览器渲染。
const gameSource = readFileSync(new URL('../web/src/pirate-game.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replace(/^export \{.*;\r?$/gm, '')
  .replace('export function createPirateGame', 'function createPirateGame');
function display(x = 0, y = 0) {
  const object = { x, y, rotation:0, scaleX:1, scaleY:1, depth:0, visible: true, displayOriginX: 0, displayOriginY: 0, list: [],
    add(children) { for(const child of Array.isArray(children)?children:[children]){this.list.push(child);child.parentContainer=this;}return this; },
    moveTo(child,index) { this.list.splice(this.list.indexOf(child),1);this.list.splice(index,0,child);return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    setScale(x,y=x) { this.scaleX=x;this.scaleY=y;return this; },
    setRotation(value) { this.rotation=value;return this; },
    setDepth(value) { this.depth=value;return this; },
    sort(key) { this.list.sort((a,b)=>a[key]-b[key]);return this; },
    setVisible(value) { this.visible = value; return this; },
    setAlpha(value) { this.alpha = value; return this; },
    setDisplaySize(width,height) { this.displayWidth=width;this.displayHeight=height;return this; },
    setFrame(value) { this.frame=value;return this; },
    setTint(value) { this.tintTopLeft=value;return this; },
    setOrigin(x,y=x) { this.originX=x;this.originY=y;return this; },
    setX(x) { this.x = x; return this; }, setY(y) { this.y = y; return this; },
    destroy() { this.destroyed = true;if(this.parentContainer)this.parentContainer.list=this.parentContainer.list.filter(child=>child!==this); },
    getLocalTransformMatrix() { return { applyInverse:(x,y)=>{
      const dx=x-this.x,dy=y-this.y,c=Math.cos(this.rotation),s=Math.sin(this.rotation);
      return {x:(dx*c+dy*s)/this.scaleX,y:(-dx*s+dy*c)/this.scaleY};
    } }; },
    getWorldTransformMatrix() { return { transformPoint: (x, y) => ({ x: x + this.x, y: y + this.y }), applyInverse: (x, y) => ({ x, y }) }; },
  };
  for (const method of ['setCrop', 'setAngle', 'setFlipX', 'setFlipY', 'setBlendMode']) object[method] = function () { return this; };
  return object;
}
async function sceneFixture({ jack = false, signals = false, storm = false, damage = false, details = false, shotEffects = false, enemyPoses = false, fog = false, companions = false, newShotArt = false } = {}) {
  let scene;
  const sceneManifest=JSON.parse(readFileSync(new URL('../web/public/assets/manifest.json', import.meta.url), 'utf8'));
  const manifest = { images: {'enemy-foreground':sceneManifest.images['enemy-foreground']}, enemyCrew:sceneManifest.enemyCrew, shipLayout: sceneManifest.shipLayout, characters: { barbossa: {}, elizabeth: {}, ...(jack ? { jack: sceneManifest.characters.jack } : {}) }, cannon: { muzzle: [0, 0] } };
  manifest.enemyCrew=manifest.enemyCrew.map((asset,index)=>({...asset,poses:enemyPoses?(index===0?{command:'enemy-tricorne-command'}:index===2?{coverEars:'enemy-beige-cover-ears'}:undefined):undefined}));
  if(shotEffects)manifest.occlusion=sceneManifest.occlusion;
  if(storm)Object.assign(manifest.images,{'weather-rain':'rain.png','weather-lightning':'lightning.png'});
  if(fog){manifest.images['fog-ribbon']=sceneManifest.images['fog-ribbon'];manifest.fogRibbons=sceneManifest.fogRibbons;}
  if(companions){manifest.images['monkey-sit']=sceneManifest.images['monkey-sit'];manifest.companions=sceneManifest.companions;}
  if(newShotArt){manifest.images.cannonball=sceneManifest.images.cannonball;manifest.images['muzzle-flash']=sceneManifest.images['muzzle-flash'];}
  if(jack)manifest.images.jack=sceneManifest.images.jack;
  if(damage)manifest.damage={scar:'scar',fire:'fire',spots:[{x:700,y:845,size:100,fire:[565,680]},{x:1200,y:835,size:100,fire:[1130,795]}]};
  if(details)manifest.shipDetails={figurehead:{key:'statue',eye:'eye',x:155,y:443,size:200},projection:{x:550,y:323,fontSize:15,angle:17}};
  if(shotEffects)manifest.shotEffects={
    smoke:{key:'smoke-sequence',frames:[[0,0,256,256],[256,0,256,256],[512,0,256,256],[768,0,256,256]],origin:[.5,.703125],size:96},
    splash:{key:'splash-sequence',frames:[[0,0,256,256],[256,0,256,256],[512,0,256,256],[768,0,256,256]],origin:[.5,.78125],size:96},
  };
  if (signals) manifest.taskSignals = {
    table: { key: 'chart-table', x: 1041, y: 718, origin: [322 / 512, 448 / 512], size: 128, target: [1041, 682] },
    crew: {
      barbossa: { coin: 'coin-closedoff', token: 'medal', slot: -12, tint: 0xe9c277 },
      elizabeth: { coin: 'coin-blog', token: 'draft-bottle', slot: 12, tint: 0x88d8b2 },
    },
  };
  const Phaser = { Scene: class {}, AUTO: 0, Scale: { RESIZE: 0, CENTER_BOTH: 0 },
    Math: { Linear: (a, b, p) => a + (b - a) * p, Easing: { Sine: { InOut: p => p } } },
    Game: class { constructor(config) {
      scene = new config.scene[0]();
      const textures = new Map();
      const callbacks=new Map();scene.events={once:(name,callback)=>callbacks.set(name,callback),emit:name=>callbacks.get(name)?.()};
      scene.textures = { get: key => {
        if (!textures.has(key)) textures.set(key, { key, firstFrame: '__BASE',
          add(name) { if (this.firstFrame === '__BASE') this.firstFrame = name; },
          get:()=>({source:{image:{key}},cutX:0,cutY:0,cutWidth:512,cutHeight:384}),
          getSourceImage: () => ({ width: 1672, height: 200 }) });
        return textures.get(key);
      } };
      scene.textures.createCanvas=(key,width,height)=>{
        assert.equal(textures.has(key),false);
        const texture=scene.textures.get(key);texture.draws=[];texture.refreshes=0;
        texture.context={clearRect:()=>texture.draws=[],save(){},restore(){},scale:(x,y)=>texture.scale=[x,y],drawImage:(...args)=>texture.draws.push(args)};
        texture.refresh=()=>texture.refreshes++;
        texture.getSourceImage=()=>({width,height});return texture;
      };
      scene.textures.remove=key=>{scene.textures.get(key).removed=true;textures.delete(key);};
      scene.add = { image: (x, y, key, frame) => Object.assign(display(x, y), { key, texture:scene.textures.get(key), frame: frame ?? scene.textures.get(key).firstFrame,
        setTexture(key,frame){this.key=key;this.texture=scene.textures.get(key);this.frame=frame;return this;} }), container: (x, y) => display(x, y) };
      scene.add.text=(x,y,text)=>Object.assign(display(x,y),{text,setText(value){this.text=value;return this;}});
      scene.scale = { width: 1672, height: 941, on() {} };
      scene.create();
    } },
  };
  const create = runInNewContext(gameSource + '\ncreatePirateGame', {
    Phaser, TaskSignals, createSceneAudio, createShipDamage, createShipDetails, ...eventsModule, ...navigation, ...atmosphere, URL, AbortController,
    matchMedia: () => ({ matches: false }), document: { baseURI: 'http://localhost/' },
    fetch: async () => ({ ok: true, json: async () => manifest }),
  });
  const host = { dataset: {}, clientWidth: 1672, clientHeight: 941 };
  const api = create(host);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(scene, '场景已建立');
  const advance = duration => { for (let elapsed = 0; elapsed < duration; elapsed += 50) scene.update(scene.now + 50, 50); };
  return { api, scene, host, advance };
}
const assigned = [event(1, 'thinking', 'jack'),
  { seq: 2, role: 'jack', type: 'message', text: '巴博萨：查询自造记录' },
  event(3, 'commanding'), event(4, 'working')];
const returned = [...assigned, { seq: 5, role: 'closedoff', type: 'message', text: '公开返回正文' },
  event(6, 'returning'), { seq: 7, role: 'closedoff', type: 'artifact', text: '成果标题不能覆盖正文' }];

test('Jack六帧素材接入角色协议，行走和交谈使用有效帧',async()=>{
  const {api,scene,host}=await sceneFixture({jack:true});
  const jack=scene.actor('jack');
  assert.ok(jack);
  assert.equal(jack.asset.frames.length,6);
  assert.deepEqual(jack.asset.frames.map(frame=>frame.name),['stand','walk1','walk2','walk3','walk4','talk']);
  assert.ok(jack.asset.frames.every(frame=>frame.footY===448));
  api.sync({id:'mission-jack-art',state:'running'},[
    {seq:1,role:'jack',type:'message',text:'巴博萨：检查新素材'},
    event(2,'commanding'),event(3,'working')
  ]);
  const frames=new Set();
  for(let step=0;step<80;step++){scene.update(scene.now+50,50);if(jack.moving)frames.add(jack.sprite.frame);}
  assert.ok([...frames].every(frame=>[1,2,3,4].includes(frame)),'行走只能使用四个步态帧');
  jack.bubble='新素材';scene.update(scene.now+50,50);
  assert.equal(jack.sprite.frame,5,'气泡使用交谈帧');
});

test('海雾素材按清单挂载并漂移，减少动态时保持静止',async()=>{
  const {api,scene,host,advance}=await sceneFixture({fog:true});
  assert.equal(scene.fogEffects.layers.length,3);
  assert.ok(scene.world.list.includes(scene.fogEffects.container));
  advance(50);
  const initial=JSON.parse(host.dataset.fogRibbons);
  assert.deepEqual(initial.map(item=>item.key),['fog-ribbon','fog-ribbon','fog-ribbon']);
  assert.ok(initial.every(item=>item.width>0&&item.height>0&&item.alpha>0));
  advance(3200);
  const moving=JSON.parse(host.dataset.fogRibbons);
  assert.ok(moving.some((item,index)=>Math.abs(item.x-initial[index].x)>=1),'雾条应缓慢漂移');
  api.setReducedMotion(true);
  const frozen=JSON.parse(host.dataset.fogRibbons);
  advance(3200);
  assert.deepEqual(JSON.parse(host.dataset.fogRibbons),frozen);
});

test('静态猴子作为氛围伴随层挂载且不进入业务角色协议',async()=>{
  const {scene,host}=await sceneFixture({companions:true});
  assert.equal(scene.companions.length,1);
  const monkey=scene.companions[0];
  assert.equal(monkey.texture.key,'monkey-sit');
  assert.equal(monkey.parentContainer,scene.ship);
  assert.ok(scene.ship.list.includes(monkey));
  assert.ok(!scene.actors.some(actor=>actor.id==='monkey'));
  scene.update(scene.now+50,50);
  const values=JSON.parse(host.dataset.companions);
  assert.deepEqual(values,[{key:'monkey-sit',x:1145,y:640,depth:640,width:36,height:36}]);
});

test('独立炮弹和炮口闪光替换旧混合图且保持炮口锚点',async()=>{
  const {scene,host}=await sceneFixture({newShotArt:true});
  scene.fire(0,false);
  const shot=scene.balls[0],flash=scene.fx.find(f=>f.frame===2);
  assert.equal(shot.obj.key,'cannonball');
  assert.equal(shot.obj.frame,'__BASE');
  assert.equal(flash.obj.key,'muzzle-flash');
  assert.equal(flash.obj.originX,.5);
  assert.equal(flash.obj.originY,.703125);
  scene.update(scene.now+50,50);
  assert.equal(JSON.parse(host.dataset.shotEffectPhases).length,0,'静态闪光不伪装成四相位序列');
});

test('竖屏构图填满可用船宽，并为完整首尾桅顶和颠簸船底保留屏幕余量',async()=>{
  const {scene}=await sceneFixture();
  const layout=structuredClone(scene.shipLayout),[left,top,right,bottom]=layout.bounds;
  for(const [width,height] of [[390,844],[390,540],[540,844]]){
    Object.assign(scene.scale,{width,height});scene.layout();
    const visibleWidth=(right-left)*layout.scale*scene.fit;
    assert.ok(visibleWidth>=width*.92,'不能继续为整个世界透明空边牺牲主船宽度');
    for(const bob of [-1.8,0,1.8])for(const rotation of [-.0014,0,.0014]){
      const points=[[left,top],[right,top],[right,bottom],[left,bottom]].map(([x,y])=>({
        x:scene.world.x+(layout.x+layout.scale*(x*Math.cos(rotation)-y*Math.sin(rotation)))*scene.fit,
        y:scene.world.y+(layout.y+bob+layout.scale*(x*Math.sin(rotation)+y*Math.cos(rotation)))*scene.fit,
      }));
      assert.ok(Math.min(...points.map(p=>p.x))>=8-1e-6,'船首不被左右边缘裁切');
      assert.ok(Math.max(...points.map(p=>p.x))<=width-8+1e-6,'船尾不被左右边缘裁切');
      assert.ok(Math.min(...points.map(p=>p.y))>=8,'桅顶完整');
      const bottomMargin=height-Math.max(...points.map(p=>p.y));
      assert.ok(bottomMargin>=8-1e-6&&bottomMargin<14,'船底留屏幕像素余量，仍保持贴底');
    }
    assert.equal(scene.world.scaleX,scene.world.scaleY);
    const transform=[scene.fit,scene.world.x,scene.world.y];scene.layout();
    assert.deepEqual([scene.fit,scene.world.x,scene.world.y],transform,'相同视口布局稳定');
    assert.deepEqual(scene.shipLayout,layout,'不改船体内部坐标或素材水线');
  }
});

test('横屏构图保留桌面和短横屏的原世界缩放与定位',async()=>{
  const {scene}=await sceneFixture();
  for(const [width,height] of [[1500,940],[844,390],[1672,941]]){
    Object.assign(scene.scale,{width,height});scene.layout();
    const scale=Math.min(width/1672,height/941);
    assert.equal(scene.fit,scale);assert.equal(scene.world.x,(width-1672*scale)/2);assert.equal(scene.world.y,height-941*scale);
  }
});

test('空敌船三名固定站姿仅创建一次，保持脚点、前景层序、随船光照和显隐',async()=>{
  const {api,scene,host,advance}=await sceneFixture();
  const crew=[...scene.enemyCrew],foreground=scene.enemyForeground,children=[...scene.enemy.list];
  assert.equal(crew.length,3);assert.equal(children.length,7);
  assert.deepEqual(children,[scene.enemyReflection.container,scene.enemyWake,scene.enemyPicture,...crew,foreground]);
  for(const [index,[x,y,height,key]] of [[265,693,32,'enemy-tricorne'],[656,795,32,'enemy-red'],[885,824,34,'enemy-beige']].entries()){
    const obj=crew[index];assert.equal(obj.key,key);assert.equal(obj.x,x*400/1448);assert.equal(obj.y,y*300/1086);
    assert.equal(obj.originX,.5);assert.equal(obj.originY,.875);assert.equal(obj.displayHeight,height*128/90);assert.equal(obj.displayWidth,obj.displayHeight);
    assert.equal(obj.parentContainer,scene.enemy);assert.ok(scene.lit.includes(obj));assert.ok(!scene.actors.some(a=>a.sprite===obj||a.group===obj));
  }
  assert.equal(foreground.originX,0);assert.equal(foreground.originY,0);assert.equal(foreground.displayWidth,400);assert.equal(foreground.displayHeight,300);
  advance(50);const initialTint=crew[0].tintTopLeft;assert.equal(JSON.parse(host.dataset.enemyCrew).visible,false);
  api.sync(mission('running'),assigned);advance(5500);
  assert.equal(JSON.parse(host.dataset.enemyCrew).visible,true);assert.notEqual(crew[0].tintTopLeft,initialTint);
  for(const state of ['running','completed','waiting','cancelled']){
    api.sync(mission(state),assigned,{restore:true});api.setReducedMotion(true);advance(50);api.setReducedMotion(false);
    assert.deepEqual([...scene.enemy.list],children);assert.deepEqual([...scene.enemyCrew],crew);
    assert.ok([...crew,foreground].every(obj=>obj.tintTopLeft===scene.enemyPicture.tintTopLeft&&!obj.destroyed));
  }
  api.sync(null,[]);advance(50);assert.equal(JSON.parse(host.dataset.enemyCrew).visible,false);
  assert.deepEqual([...scene.enemy.list],children);assert.equal(scene.actors.length,2);
});

test('敌船倒影一次合成船体三人与前景，24分带随光照及减少动态且释放内部纹理',async()=>{
  const {api,scene,advance}=await sceneFixture(),key='enemy-reflection-composite',texture=scene.textures.get(key);
  assert.deepEqual(texture.scale,[512/400,384/300]);assert.equal(texture.refreshes,1);
  assert.deepEqual(texture.draws.map(args=>args[0].key),['enemy','enemy-tricorne','enemy-red','enemy-beige','enemy-foreground']);
  for(const [i,obj] of [scene.enemyPicture,...scene.enemyCrew,scene.enemyForeground].entries()){
    assert.deepEqual(texture.draws[i].slice(5),[obj.x-obj.originX*obj.displayWidth,obj.y-obj.originY*obj.displayHeight,obj.displayWidth,obj.displayHeight]);
  }
  assert.equal(scene.enemyReflection.bands.length,24);assert.ok(scene.enemyReflection.bands.every(b=>b.key===key));
  assert.equal(scene.enemy.list[0],scene.enemyReflection.container);assert.equal(scene.enemyReflection.container.y,291);
  advance(50);const dayTint=scene.enemyReflection.bands[0].tintTopLeft;assert.equal(dayTint,0x7595b0);
  api.sync(mission('running'),assigned);advance(5500);
  const bands=scene.enemyReflection.bands;assert.ok(bands.some(b=>b.x!==0));assert.notEqual(bands[0].tintTopLeft,dayTint);
  api.setReducedMotion(true);advance(50);assert.ok(bands.every(b=>b.x===0));
  api.sync(mission('running'),assigned,{restore:true});advance(1000);assert.equal(texture.refreshes,1);assert.equal(texture.draws.length,5);
  assert.equal(scene.enemyReflection.container.parentContainer,scene.enemy);
  scene.events.emit('shutdown');assert.equal(texture.removed,true,'场景shutdown清理；整个Game.destroy的全局纹理释放由Phaser负责');
});

test('敌方发令先于反击，捂耳跨越发射后有限复位，姿态保持脚点体尺且倒影仅随换图刷新',async()=>{
  const {api,scene,advance}=await sceneFixture({enemyPoses:true}),texture=scene.enemyReflectionTexture;
  const keys=()=>scene.enemyCrew.map(image=>image.texture.key),standing=['enemy-tricorne','enemy-red','enemy-beige'];
  const geometry=()=>scene.enemyCrew.map(image=>[image.x,image.y,image.displayWidth,image.displayHeight,image.originX,image.originY]);
  const original=geometry();let shots=0;const fire=scene.fireEnemy.bind(scene);scene.fireEnemy=()=>{shots++;fire();};
  api.sync(mission('running'),assigned);advance(5000);assert.deepEqual(keys(),standing);assert.equal(texture.refreshes,1);
  advance(100);assert.deepEqual(keys(),['enemy-tricorne-command','enemy-red','enemy-beige']);assert.equal(shots,0);assert.equal(texture.refreshes,2);
  advance(150);assert.deepEqual(keys(),['enemy-tricorne-command','enemy-red','enemy-beige-cover-ears']);assert.equal(shots,0);assert.equal(texture.refreshes,3);
  advance(200);assert.equal(shots,1);assert.equal(scene.enemyCue.firedAt,5450);assert.equal(texture.refreshes,3);
  advance(150);assert.deepEqual(keys(),['enemy-tricorne','enemy-red','enemy-beige-cover-ears']);assert.equal(texture.refreshes,4);
  advance(500);assert.deepEqual(keys(),standing);assert.equal(scene.enemyCue,null);assert.equal(texture.refreshes,5);
  assert.deepEqual(geometry(),original);assert.equal(scene.enemyReflectionTexture,texture);assert.equal(texture.draws.length,5);
  assert.ok(scene.enemyCrew.every(image=>image.tintTopLeft===scene.enemyPicture.tintTopLeft));
  advance(500);assert.equal(texture.refreshes,5,'重复帧不重复上传纹理');
});

test('停止历史切换减少动态同时复位两姿态，只刷新一次且不补播口令',async()=>{
  for(const boundary of ['stopping','cancelled','interrupted','restore','switch','reduced']){
    const {api,scene,advance}=await sceneFixture({enemyPoses:true});api.sync(mission('running'),assigned);advance(5450);
    const texture=scene.enemyReflectionTexture,before=texture.refreshes;
    assert.equal(scene.enemyCrew[0].texture.key,'enemy-tricorne-command');assert.equal(scene.enemyCrew[2].texture.key,'enemy-beige-cover-ears');
    if(boundary==='restore')api.sync(mission('running'),assigned,{restore:true});
    else if(boundary==='switch')api.sync({id:'other',state:'running'},[]);
    else if(boundary==='reduced')api.setReducedMotion(true);
    else api.sync(mission(boundary),assigned);
    assert.deepEqual(scene.enemyCrew.map(image=>image.texture.key),['enemy-tricorne','enemy-red','enemy-beige'],boundary);
    assert.equal(scene.enemyCue,null);assert.equal(texture.refreshes,before+1,'两人同帧复位合并刷新');
    if(boundary==='reduced')api.setReducedMotion(false);
    advance(12000);assert.equal(texture.refreshes,before+1,boundary);assert.equal(scene.enemyCue,null);
  }
});

test('正常终态取消未发射口令，已发射捂耳可有限收尾，旧资格与错过窗口不补令',async()=>{
  for(const state of ['completed','waiting','partial','failed'])for(const at of [5250,5450]){
    const {api,scene,advance}=await sceneFixture({enemyPoses:true});let shots=0;scene.fireEnemy=()=>shots++;
    api.sync(mission('running'),assigned);advance(at);api.sync(mission(state),assigned);advance(50);
    if(at===5250)assert.equal(scene.enemyCue,null,'终态不把未发射准备继续演成炮击');
    else assert.equal(scene.enemyCrew[2].texture.key,'enemy-beige-cover-ears','已发射反应允许短暂收尾');
    advance(8000);assert.equal(scene.enemyCue,null);assert.equal(shots,at===5250?0:1,state);
    assert.deepEqual(scene.enemyCrew.map(image=>image.texture.key),['enemy-tricorne','enemy-red','enemy-beige']);
  }
  const {scene}=await sceneFixture({enemyPoses:true});scene.perform=true;scene.combat=true;scene.roleStages={barbossa:'working'};scene.enemy.setVisible(true);scene.enemyMode='hold';
  scene.now=5000;scene.lastEnemyShot=0;scene.lastShot=4450;scene.tickCollaboration();assert.equal(scene.enemyCue,null,'晚于预备窗口不临时造口令');
  scene.lastShot=4900;scene.roleStages={barbossa:'waiting'};scene.tickCollaboration();assert.equal(scene.enemyCue,null,'同一反击资格控制姿态');
});

test('雨线只在战斗或失败天气出现，远空闪电低频且在终态熄灭',async()=>{
  const {api,scene,host,advance}=await sceneFixture({storm:true});
  advance(10000);assert.equal(host.dataset.rainActive,'false');assert.equal(scene.stormFx.bolt.alpha,0);
  api.sync(mission('running'),assigned);advance(500);
  assert.equal(host.dataset.rainActive,'true');assert.equal(scene.stormFx.drops.length,18);
  const before=scene.stormFx.drops.map(drop=>[drop.x,drop.y]);advance(500);
  assert.ok(scene.stormFx.drops.some((drop,i)=>drop.x!==before[i][0]&&drop.y!==before[i][1]));
  advance(7850);assert.equal(scene.stormFx.bolt.alpha,0,'首次闪电不能刚开战就出现');
  advance(300);assert.ok(scene.stormFx.bolt.alpha>0&&scene.stormFx.bolt.alpha<=.7);
  assert.ok(scene.stormFx.bolt.y<941*.14,'闪电位于远空');
  api.sync(mission('waiting'),[...returned,event(8,'waiting','blog')]);advance(50);
  assert.equal(host.dataset.rainActive,'false');assert.equal(scene.stormFx.bolt.alpha,0);
  for(const state of ['completed','partial','cancelled']){
    api.sync(mission(state),returned);advance(10000);
    assert.equal(host.dataset.rainActive,'false');assert.equal(scene.stormFx.bolt.alpha,0);
  }
  api.sync(mission('failed'),[...assigned,event(8,'failed')]);advance(10000);
  assert.equal(host.dataset.rainActive,'true');assert.equal(scene.stormFx.bolt.alpha,0,'失败保留雨但不继续闪电');
});

test('恢复历史不补闪电，减少动态和停止会清理雨闪，重新开启不补演',async()=>{
  const {api,scene,host,advance}=await sceneFixture({storm:true});
  api.sync(mission('running'),assigned,{restore:true});advance(20000);
  assert.equal(host.dataset.rainActive,'true');assert.equal(scene.stormFx.bolt.alpha,0);
  assert.equal(scene.stormFx.sequence,0,'历史未产生闪电');
  api.sync(mission('running'),[...assigned,event(5,'working')]);advance(9150);
  assert.ok(scene.stormFx.bolt.alpha>0,'新的公开工作事件允许之后的低频闪电');
  api.setReducedMotion(true);assert.equal(scene.stormFx.bolt.alpha,0);advance(1000);
  assert.equal(host.dataset.rainActive,'false');assert.equal(host.dataset.rainDrift,'0');
  api.setReducedMotion(false);advance(12000);
  assert.equal(host.dataset.rainActive,'true');assert.equal(scene.stormFx.bolt.alpha,0);
  assert.equal(scene.stormFx.sequence,1,'恢复动态不追加错过的闪电');
  api.sync(mission('stopping'),[...assigned,event(5,'working')]);advance(50);
  assert.equal(host.dataset.rainActive,'false');assert.equal(scene.stormFx.bolt.alpha,0);
});

test('天气随公开阶段渐变，等待和部分完成不触发月夜；恢复和减少动态直接到位', async () => {
  const { api, scene, host, advance } = await sceneFixture();
  // Phaser 新增第一个帧后会改变默认帧，主船与敌船仍须显示整图。
  assert.equal(scene.enemyPicture.frame, '__BASE');
  assert.equal(scene.lit.find(image => image.key === 'ship').frame, '__BASE');
  api.sync(mission('running'), assigned);
  advance(500);
  assert.equal(host.dataset.weather, 'storm');
  assert.ok(scene.atmosphere.storm > 0 && scene.atmosphere.storm < 1);
  api.sync(mission('completed'), returned);
  advance(1000);
  assert.ok(scene.atmosphere.moon > 0 && scene.atmosphere.moon < 1);
  assert.ok(scene.atmosphere.moon + scene.atmosphere.storm <= 1.000001);
  for (const state of ['waiting', 'partial', 'failed', 'cancelled', 'interrupted']) {
    api.sync({ id: state, state }, [], { restore: true });
    assert.equal(scene.atmosphere.moon, 0, state);
    assert.equal(scene.atmosphere.name, atmosphere.weatherForPhase(state).name);
  }
  api.sync(mission('completed'), [], { restore: true });
  assert.equal(scene.atmosphere.moon, 1);
  api.sync(mission('running'), [event(20, 'thinking', 'jack')]);
  api.setReducedMotion(true);
  assert.equal(scene.atmosphere.moon, 0);
  assert.equal(scene.atmosphere.storm, .55);
  advance(1000);
  assert.ok(scene.shipReflection.bands.every(band => band.x === 0));
  assert.ok(scene.enemyReflection.bands.every(band => band.x === 0));
});

test('无Jack的快速终态保留公开气泡，等待入场后命中并有限收尾', async () => {
  const { api, scene, host, advance } = await sceneFixture();
  api.sync(mission('waiting'), [...returned, event(8, 'working', 'blog')]);
  assert.equal(scene.perform, false);
  assert.equal(scene.actor('barbossa').bubble, '公开返回正文');
  assert.equal(scene.pendingHits, 1);
  assert.equal(scene.enemyMode, 'enter');
  advance(4950);
  assert.equal(host.dataset.phase, 'waiting');
  assert.equal(scene.balls.length, 0);
  assert.equal(scene.pendingHits, 1);
  advance(100);
  assert.equal(scene.balls.length, 1);
  assert.equal(scene.balls[0].hit, true);
  advance(2500);
  assert.equal(scene.enemyMode, 'leave');
  assert.equal(scene.pendingHits, 0);
  advance(8000);
  assert.equal(scene.balls.length, 0);
  assert.equal(scene.enemy.visible, false, '终态旧working不能持续发炮');
});

test('终态保留飞行炮弹；Jack会面在业务结束后仍展示message正文并结束', async () => {
  const { api, scene, advance } = await sceneFixture({ jack: true });
  api.sync(mission('running'), assigned);
  advance(5000);
  const flying = scene.balls[0];
  assert.ok(flying);
  api.sync(mission('completed'), returned);
  assert.equal(scene.balls[0], flying);
  assert.equal(flying.obj.destroyed, undefined);
  let sawReply = false;
  for (let step = 0; step < 700; step++) {
    advance(50);
    if (scene.actor('barbossa').bubble === '公开返回正文') sawReply = true;
  }
  assert.equal(sawReply, true);
  assert.equal(scene.meeting, null);
  assert.equal(scene.meetings.length, 0);
  assert.equal(scene.enemy.visible, false);
});

test('Jack的快速终态批次仍依次会面，敌船等待会面和炮弹一起结束', async () => {
  const { api, scene, advance } = await sceneFixture({ jack: true });
  api.sync(mission('waiting'), [...returned,
    { seq: 8, role: 'jack', type: 'message', text: '伊丽莎白：核对公开摘要' },
    event(9, 'commanding', 'blog'), event(10, 'working', 'blog'),
    { seq: 11, role: 'blog', type: 'message', text: '公开待处理正文' }, event(12, 'waiting', 'blog')]);
  const observed = new Set();
  for (let step = 0; step < 1000; step++) {
    advance(50);
    for (const actor of scene.actors) if (actor.bubble) observed.add(actor.bubble);
    if (scene.meeting || scene.meetings.length) assert.notEqual(scene.enemyMode, 'leave');
  }
  assert.ok(observed.has('公开返回正文'));
  assert.ok(observed.has('公开待处理正文'));
  assert.ok(!observed.has('成果标题不能覆盖正文'));
  assert.equal(scene.meeting, null);
  assert.equal(scene.meetings.length, 0);
  assert.equal(scene.enemy.visible, false);
});

test('停止、恢复和任务切换清理旧炮弹与会面', async () => {
  for (const boundary of ['stopping', 'cancelled', 'interrupted', 'restore', 'switch']) {
    const { api, scene, advance } = await sceneFixture({ jack: true, shotEffects: true });
    api.sync(mission('running'), returned);
    advance(5000);
    const flying = scene.balls[0];
    assert.ok(flying);
    const oldEffects=[...scene.fx.map(f=>f.obj),scene.makeFx(3,300,360,58,66,650,.9)];
    if (boundary === 'restore') api.sync(mission('waiting'), returned, { restore: true });
    else if (boundary === 'switch') api.sync({ id: 'mission-b', state: 'completed' }, []);
    else api.sync(mission(boundary), [...returned, event(8, 'returning')]);
    assert.equal(flying.obj.destroyed, true, boundary);
    assert.equal(scene.balls.length, 0, boundary);
    assert.equal(scene.fx.length, 0, boundary);
    assert.ok(oldEffects.every(obj=>obj.destroyed),boundary+' clears sequence images');
    assert.ok(scene.guns.every(gun=>gun.muzzleFx.list.length===0),boundary+' clears every gun layer');
    assert.equal(scene.pendingHits, 0, boundary);
    assert.equal(scene.meeting, null, boundary);
    assert.equal(scene.meetings.length, 0, boundary);
    advance(8000);
    assert.equal(scene.balls.length, 0, boundary);
  }
});

test('减少动态清空并跳过会面和炮击，关闭后不补演；无派单及非成功结果不制造命中', async () => {
  const { api, scene, advance } = await sceneFixture({ jack: true, shotEffects: true });
  api.sync(mission('running'), assigned);
  advance(5000);
  assert.equal(scene.balls.length, 1);
  const oldEffects=[...scene.fx.map(f=>f.obj),scene.makeFx(3,300,360,58,66,650,.9)];
  api.setReducedMotion(true);
  assert.ok(oldEffects.every(obj=>obj.destroyed),'reducing motion destroys existing sequence images');
  assert.ok(scene.guns.every(gun=>gun.muzzleFx.list.length===0));
  api.sync(mission('completed'), returned);
  assert.equal(scene.balls.length, 0);
  assert.equal(scene.pendingHits, 0);
  assert.equal(scene.meetings.length, 0);
  assert.equal(scene.meeting, null);
  assert.equal(scene.actor('barbossa').bubble, '公开返回正文');
  api.setReducedMotion(false);
  advance(8000);
  assert.equal(scene.balls.length, 0);
  for (const state of ['completed', 'waiting', 'partial', 'failed']) {
    const items = state === 'completed' ? [{ seq: 1, role: 'jack', type: 'message', text: '直接公开答复' }]
      : [...assigned, event(5, state === 'partial' ? 'failed' : state)];
    api.sync({ id: state, state }, items);
    advance(8000);
    assert.equal(scene.pendingHits, 0, state);
    assert.equal(scene.balls.length, 0, state);
  }
});

test('恢复进行中任务跳过已有炮击，后续公开返回才消费一次命中', async () => {
  const { api, scene, advance } = await sceneFixture();
  api.sync(mission('running'), assigned, { restore: true });
  let shots = 0;
  const fire = scene.fire.bind(scene);
  scene.fire = (...args) => { shots++; return fire(...args); };
  advance(8000);
  assert.equal(shots, 0);
  api.sync(mission('completed'), returned);
  advance(8000);
  assert.equal(shots, 1);
});

function captureShots(scene) {
  const hits = [], fire = scene.fire.bind(scene);
  scene.fire = (index, hit) => { hits.push(hit); return fire(index, hit); };
  return hits;
}

test('敌船只在新实时执行且入场完成后稀疏反击，与主炮错开',async()=>{
  const {api,scene,advance}=await sceneFixture({shotEffects:true});
  const shots=[],fireEnemy=scene.fireEnemy.bind(scene);
  scene.fireEnemy=()=>{shots.push({time:scene.now,gap:scene.now-scene.lastShot,phase:scene.enemyMode});return fireEnemy();};
  api.sync(mission('running'),assigned);
  advance(4950);assert.equal(shots.length,0,'入场期间不反击');
  advance(50);assert.equal(scene.balls.length,1,'主船原有第一炮保持');assert.equal(shots.length,0);
  advance(400);assert.equal(shots.length,0,'两方不同时开火');
  advance(50);assert.equal(shots.length,1);
  assert.equal(scene.balls.find(b=>b.side==='enemy').hit,false);
  advance(12000);assert.ok(shots.length>=3);
  assert.ok(shots.every(s=>s.phase==='hold'&&s.gap>=450&&s.gap<=1000));
  assert.ok(shots.slice(1).every((s,i)=>s.time-shots[i].time>=3600));
  assert.equal(scene.pendingHits,0,'氛围反击不产生成功命中');
});

test('待命、未派单、船员等待、历史及所有非运行状态不产生敌船反击',async()=>{
  for(const state of ['idle','thinking','crew-waiting','history','completed','waiting','partial','failed','stopping','cancelled','interrupted']){
    const {api,scene,advance}=await sceneFixture();
    let shots=0;const fireEnemy=scene.fireEnemy.bind(scene);
    scene.fireEnemy=()=>{shots++;return fireEnemy();};
    const items=state==='thinking'?[event(1,'thinking','jack')]:state==='crew-waiting'?[...assigned,event(5,'waiting')]:assigned;
    api.sync(state==='idle'?null:mission(['thinking','crew-waiting','history'].includes(state)?'running':state),items,{restore:state==='history'});
    advance(12000);assert.equal(shots,0,state);
  }
});

test('敌炮用真实前舷炮口和主船旁海区，经两船变换定位且只在到达后溅水',async()=>{
  const {scene,host,advance}=await sceneFixture({shotEffects:true});
  scene.enemy.getWorldTransformMatrix=()=>({transformPoint:(x,y)=>({x:600-2*y,y:100+2*x})});
  scene.ship.getWorldTransformMatrix=()=>({transformPoint:(x,y)=>({x:200+3*x,y:80+3*y})});
  scene.world.getWorldTransformMatrix=()=>({applyInverse:(x,y)=>({x:(x-100)/2,y:(y-20)/2})});
  scene.fireEnemy();
  const shot=scene.balls[0],smoke=scene.fx.find(f=>f.frame===1).obj,flash=scene.fx.find(f=>f.frame===2).obj;
  assert.equal(shot.side,'enemy');assert.equal(shot.hit,false);
  assert.equal(shot.start.x,250-919*300/1086);assert.equal(shot.start.y,40+736*400/1448);
  assert.equal(shot.localEnd.x,239.286453);assert.equal(shot.localEnd.y,367.659081);
  assert.equal(shot.end.x,50+1.5*shot.localEnd.x);assert.equal(shot.end.y,30+1.5*shot.localEnd.y);
  assert.equal(smoke.x,shot.start.x);assert.equal(smoke.y,shot.start.y);assert.equal(smoke.displayWidth,96);
  assert.equal(smoke.originX,.5);assert.equal(smoke.originY,.703125);
  assert.ok(Math.abs(smoke.rotation-(Math.atan2(shot.end.y-shot.start.y,shot.end.x-shot.start.x)+3*Math.PI/4))<1e-9,'现有朝左上烟按真实出射线转向');
  assert.ok([shot.obj,smoke,flash].every(obj=>obj.parentContainer===scene.projectiles));
  assert.ok(scene.world.list.indexOf(scene.enemy)<scene.world.list.indexOf(scene.projectiles));
  assert.ok(scene.world.list.indexOf(scene.projectiles)<scene.world.list.indexOf(scene.ship));
  assert.equal(scene.fx.filter(f=>f.frame===3).length,0,'发射时不能提前落水');
  advance(50);
  const p=(scene.now-shot.born)/shot.duration;
  assert.ok(Math.abs(shot.obj.y-(shot.start.y+(shot.end.y-shot.start.y)*p))<1e-9,'arc 0 沿可见炮轴直行，不能回退成主弹38或旧12');
  assert.equal(JSON.parse(host.dataset.projectileTargets)[0].side,'enemy','目标坐标系可被浏览器区分');
  scene.enemy.setPosition(-1000,200).setRotation(.2);scene.ship.setPosition(300,400).setScale(.5);
  advance(200);assert.equal(smoke.x,shot.start.x);assert.equal(smoke.y,shot.start.y);
  advance(1200);
  const splash=scene.fx.find(f=>f.frame===3);
  assert.ok(splash);assert.equal(shot.obj.destroyed,true);assert.equal(scene.balls.length,0);
  assert.equal(splash.obj.x,shot.end.x);assert.equal(splash.obj.y,shot.end.y);
  assert.equal(splash.obj.originY,.78125);assert.equal(splash.obj.displayWidth,96);
  assert.equal(scene.pendingHits,0);assert.equal(scene.fx.filter(f=>f.frame===2).length,0,'到达时不产生命中闪光');
  advance(800);assert.equal(scene.fx.length,0);assert.equal(scene.projectiles.list.length,0);
});

test('敌弹在正常终态有限落水并离场，旧working与返回成果不续发反击',async()=>{
  for(const state of ['completed','waiting','partial','failed']){
    const {api,scene,host,advance}=await sceneFixture({shotEffects:true});
    let count=0;const fireEnemy=scene.fireEnemy.bind(scene);
    scene.fireEnemy=()=>{count++;return fireEnemy();};
    api.sync(mission('running'),assigned);advance(5450);
    const shot=scene.balls.find(b=>b.side==='enemy');assert.ok(shot,state);
    api.sync(mission(state),state==='completed'?returned:assigned);
    assert.equal(scene.perform,false);assert.equal(shot.obj.destroyed,undefined);
    advance(50);assert.equal(host.dataset.phase,state==='completed'?'complete':state);
    advance(1200);assert.ok(scene.fx.some(f=>f.frame===3&&f.obj.x===shot.end.x&&f.obj.y===shot.end.y));
    advance(12000);assert.equal(count,1,state);assert.equal(scene.balls.length,0);assert.equal(scene.fx.length,0);assert.equal(scene.enemy.visible,false);
  }
});

test('停止、恢复、切换和减少动态销毁敌弹烟水，重复同步及恢复动态不补发',async()=>{
  for(const boundary of ['stopping','cancelled','interrupted','restore','switch','reduced']){
    const {api,scene,advance}=await sceneFixture({shotEffects:true});
    let count=0;const fireEnemy=scene.fireEnemy.bind(scene);
    scene.fireEnemy=()=>{count++;return fireEnemy();};
    api.sync(mission('running'),assigned);advance(5450);
    const shot=scene.balls.find(b=>b.side==='enemy');assert.ok(shot,boundary);
    const objects=[...scene.balls.map(b=>b.obj),...scene.fx.map(f=>f.obj),scene.makeFx(3,375,415,58,66,650,.9)];
    if(boundary==='restore')api.sync(mission('running'),assigned,{restore:true});
    else if(boundary==='switch')api.sync({id:'other',state:'running'},[event(1,'thinking','jack')]);
    else if(boundary==='reduced')api.setReducedMotion(true);
    else api.sync(mission(boundary),assigned);
    assert.ok(objects.every(obj=>obj.destroyed),boundary);
    assert.equal(scene.projectiles.list.length,0);assert.equal(scene.balls.length,0);assert.equal(scene.fx.length,0);
    if(boundary==='reduced'){api.setReducedMotion(false);api.sync(mission('running'),assigned);}
    advance(12000);assert.equal(count,1,boundary);assert.equal(scene.balls.length,0);assert.equal(scene.fx.length,0);
  }
});

test('炮烟和水花按四相位有限播放，固定画布与锚点，末段淡出不回绕',async()=>{
  const {scene,advance}=await sceneFixture({shotEffects:true});
  const smoke=scene.makeFx(1,450,500,52,42,800,.7),splash=scene.makeFx(3,300,360,58,66,800,.9);
  assert.equal(smoke.key,'smoke-sequence');assert.equal(splash.key,'splash-sequence');
  for(const expectedFrame of [0,1,2,3]){
    for(const [obj,x,y,originY] of [[smoke,450,500,.703125],[splash,300,360,.78125]]){
      assert.equal(obj.frame,expectedFrame);
      assert.equal(obj.x,x);assert.equal(obj.y,y);
      assert.equal(obj.displayWidth,96);assert.equal(obj.displayHeight,96);
      assert.equal(obj.originX,.5);assert.equal(obj.originY,originY);
    }
    if(expectedFrame<3)advance(200);
  }
  assert.ok(smoke.alpha>0&&smoke.alpha<.7);assert.ok(splash.alpha>0&&splash.alpha<.9);
  advance(200);assert.equal(scene.fx.length,0);assert.ok(smoke.destroyed&&splash.destroyed);
  advance(1600);assert.equal(scene.fx.length,0,'expired sequences never restart');
});

test('炮口烟光按炮位深度被近侧船员遮挡，颠簸与缩放不改变其世界位置和大小',async()=>{
  const {scene,advance}=await sceneFixture({shotEffects:true});
  scene.fire(0,false);
  const shot=scene.balls[0], smoke=scene.fx.find(f=>f.frame===1).obj, flash=scene.fx.find(f=>f.frame===2).obj;
  const layer=smoke.parentContainer,gun=scene.guns[0];
  assert.equal(layer.parentContainer,scene.ship);
  assert.ok(layer.depth>gun.obj.depth);
  assert.ok(layer.depth<scene.actor('barbossa').group.depth);
  assert.equal(flash.parentContainer,smoke.parentContainer);
  assert.ok(scene.world.list.indexOf(shot.obj.parentContainer)<scene.world.list.indexOf(scene.ship));
  for(let index=1;index<scene.guns.length;index++)scene.fire(index,false);
  assert.equal(new Set(scene.guns.map(gun=>gun.muzzleFx)).size,4);
  advance(50);
  const position=obj=>scene.ship.list.indexOf(obj);
  for(const gun of scene.guns){
    assert.equal(gun.muzzleFx.list.length,2);
    assert.ok(position(gun.muzzleFx)>position(gun.obj));
  }
  assert.ok(position(layer)<position(scene.actor('barbossa').group));
  assert.ok(position(scene.guns[0].muzzleFx)<position(scene.lit.find(obj=>obj.key==='mast-fore-lower-v02')));
  assert.ok(position(scene.guns[2].muzzleFx)<position(scene.lit.find(obj=>obj.key==='mast-main-lower-v02')));
  // 独立组合两层正向变换，检查抵消后仍是原世界坐标，而非只核对局部诊断值。
  const transform=(obj,p)=>({x:obj.x+p.x*obj.scaleX*Math.cos(obj.rotation)-p.y*obj.scaleY*Math.sin(obj.rotation),
    y:obj.y+p.x*obj.scaleX*Math.sin(obj.rotation)+p.y*obj.scaleY*Math.cos(obj.rotation)});
  for(const [x,y,rotation,scale] of [[-4,-9,.0014,.952929],[35,20,-.12,.7]]){
    scene.ship.setPosition(x,y).setRotation(rotation).setScale(scale);scene.syncMuzzleLayers();
    const origin=transform(scene.ship,transform(layer,{x:smoke.x,y:smoke.y}));
    const corner=transform(scene.ship,transform(layer,{x:smoke.x+96,y:smoke.y+96}));
    assert.ok(Math.abs(origin.x-smoke.x)<1e-9&&Math.abs(origin.y-smoke.y)<1e-9);
    assert.ok(Math.abs(corner.x-origin.x-96)<1e-9&&Math.abs(corner.y-origin.y-96)<1e-9);
  }
  advance(50);
  const next=transform(scene.ship,transform(layer,{x:smoke.x,y:smoke.y}));
  assert.ok(Math.abs(next.x-smoke.x)<1e-9&&Math.abs(next.y-smoke.y)<1e-9,'每次颠簸更新后仍保持世界锚点');
  advance(1300);
  assert.equal(scene.fx.find(f=>f.frame===3).obj.parentContainer,shot.obj.parentContainer);
  advance(300);assert.ok(scene.guns.every(gun=>gun.muzzleFx.list.length===0),'烟光到期从各炮位容器清理');
});

test('命中落在船壳、未命中落在水线下；水花基盘保持海面接触点',async()=>{
  const {scene,advance}=await sceneFixture();
  scene.enemy.setPosition(95,50).setVisible(true);
  // 独立已知变换：敌船旋转90度并缩放2，再经过世界画布平移和缩放的逆变换。
  scene.enemy.getWorldTransformMatrix=()=>({transformPoint:(x,y)=>({x:600-2*y,y:100+2*x})});
  scene.world.getWorldTransformMatrix=()=>({applyInverse:(x,y)=>({x:(x-100)/2,y:(y-20)/2})});
  scene.fire(0,true);scene.fire(1,false);
  const [hit,miss]=scene.balls;
  assert.ok(hit.localEnd.x>=125&&hit.localEnd.x<260&&hit.localEnd.y>=235&&hit.localEnd.y<258);
  assert.ok(miss.localEnd.x>=190&&miss.localEnd.x<225&&miss.localEnd.y>=310&&miss.localEnd.y<320);
  for(const shot of [hit,miss]){
    assert.ok(Math.abs(shot.end.x-(250-shot.localEnd.y))<1e-9);
    assert.ok(Math.abs(shot.end.y-(40+shot.localEnd.x))<1e-9);
  }
  advance(1300);
  assert.equal(scene.balls.length,0);
  const splash=scene.fx.find(f=>f.frame===3);
  assert.ok(splash,'只有实际到达后的未命中弹生成落水反馈');
  assert.equal(splash.obj.originX,.5);assert.equal(splash.obj.originY,.9);
  assert.equal(splash.obj.x,miss.end.x);assert.equal(splash.obj.y,miss.end.y);
  advance(1000);assert.equal(scene.fx.length,0,'有限时长的水花不能阻止敌船离场');
});
const blogWaiting = [event(1, 'commanding', 'blog'), event(2, 'waiting', 'blog')];
const blogReturned = [event(1, 'commanding', 'blog'), event(2, 'returning', 'blog')];

test('启用信物后waiting稿瓶飞入自己的槽位，落桌及敌船收尾均不制造命中', async () => {
  const { api, scene, host, advance } = await sceneFixture({ signals: true });
  const hits = captureShots(scene);
  api.sync(mission('waiting'), blogWaiting);
  advance(50);
  const flight = scene.taskSignals.flights[0];
  assert.equal(flight.kind, 'return');
  assert.equal(flight.obj.key, 'draft-bottle');
  assert.equal(host.dataset.coinFlights, '0', '没有船长素材时不能伪造银币发射者');
  const positions = [], setPosition = flight.obj.setPosition.bind(flight.obj);
  flight.obj.setPosition = (x, y) => { positions.push([x, y]); return setPosition(x, y); };
  advance(1550);
  assert.equal(scene.taskSignals.collected.size, 0, '尚未落桌');
  assert.equal(scene.pendingHits, 0);
  advance(50);
  const item = scene.taskSignals.collected.get('elizabeth');
  assert.equal(item.stage, 'waiting');
  assert.equal(item.obj.alpha, .55);
  assert.deepEqual(positions.at(-2), positions.at(-1), '飞行终点与落桌位置一致，没有横向跳跃');
  assert.equal(item.obj.x, 1053);
  assert.equal(item.obj.y, 682);
  advance(10000);
  assert.deepEqual(hits, []);
  assert.equal(scene.pendingHits, 0);
  assert.equal(scene.taskSignals.busy, false);
  assert.equal(scene.enemy.visible, false);
  assert.equal(host.dataset.phase, 'waiting');
});

test('returning信物落桌后才产生一次命中，正常终态保留飞行并有限收尾，重复事件不补演', async () => {
  const { api, scene, host, advance } = await sceneFixture({ signals: true });
  const hits = captureShots(scene);
  api.sync(mission('running'), blogReturned);
  advance(50);
  const flight = scene.taskSignals.flights[0];
  api.sync(mission('completed'), blogReturned);
  assert.equal(scene.taskSignals.flights[0], flight);
  assert.equal(flight.obj.destroyed, undefined);
  assert.equal(scene.perform, false, '业务终态不等待动画');
  advance(1550);
  assert.equal(scene.pendingHits, 0);
  assert.deepEqual(hits, []);
  advance(50);
  const item = scene.taskSignals.collected.get('elizabeth');
  assert.equal(item.stage, 'returning');
  assert.equal(item.obj.alpha, .95);
  assert.equal(scene.pendingHits, 1, '落桌后才获得命中');
  assert.deepEqual(hits, [], '入场未结束，炮弹还未发射');
  advance(10000);
  assert.deepEqual(hits, [true]);
  assert.equal(scene.taskSignals.busy, false);
  assert.equal(scene.enemy.visible, false);
  assert.equal(host.dataset.phase, 'complete');
  api.sync(mission('completed'), blogReturned);
  advance(8000);
  assert.deepEqual(hits, [true]);
  assert.equal(scene.taskSignals.collected.get('elizabeth').obj, item.obj);
  assert.equal(scene.taskSignals.busy, false);
});

test('有船长时银币先交付船员，同一船员的返回信物随后起飞', async () => {
  const { api, scene, advance } = await sceneFixture({ jack: true, signals: true });
  api.sync(mission('completed'), returned);
  advance(50);
  const coin = scene.taskSignals.flights[0];
  assert.equal(coin.kind, 'coin');
  assert.equal(coin.obj.key, 'coin-closedoff');
  assert.equal(scene.taskSignals.flights.length, 1);
  assert.equal(scene.taskSignals.jobs.length, 1);
  advance(900);
  assert.equal(coin.obj.destroyed, true);
  assert.equal(scene.pendingHits, 0);
  advance(50);
  assert.equal(scene.taskSignals.flights[0].kind, 'return');
  assert.equal(scene.taskSignals.flights[0].obj.key, 'medal');
});

test('停止、历史、切换和减少动态清理信物与拖尾，静态恢复不触发迟到命中', async () => {
  for (const boundary of ['stopping', 'cancelled', 'interrupted', 'restore', 'switch', 'reduced']) {
    const { api, scene, advance } = await sceneFixture({ signals: true });
    const hits = captureShots(scene);
    api.sync(mission('running'), blogReturned);
    advance(100);
    const flight = scene.taskSignals.flights[0];
    assert.ok(flight, boundary);
    if (boundary === 'restore') api.sync(mission('completed'), blogReturned, { restore: true });
    else if (boundary === 'switch') api.sync({ id: 'mission-b', state: 'completed' }, []);
    else if (boundary === 'reduced') api.setReducedMotion(true);
    else api.sync(mission(boundary), blogReturned);
    assert.equal(flight.obj.destroyed, true, boundary);
    assert.ok(flight.trail.every(image => image.destroyed), boundary);
    assert.equal(scene.taskSignals.busy, false, boundary);
    assert.equal(scene.pendingHits, 0, boundary);
    assert.equal(scene.taskSignals.collected.size, boundary === 'switch' ? 0 : 1, boundary);
    if (boundary === 'reduced') api.setReducedMotion(false);
    advance(10000);
    assert.deepEqual(hits, [], boundary);
    assert.equal(scene.taskSignals.busy, false, boundary);
  }
});

test('历史中的waiting稿瓶只恢复静态状态，之后真实returning才飞行和命中一次', async () => {
  const { api, scene, advance } = await sceneFixture({ signals: true });
  const hits = captureShots(scene);
  api.sync(mission('waiting'), blogWaiting, { restore: true });
  const waiting = scene.taskSignals.collected.get('elizabeth');
  assert.equal(waiting.stage, 'waiting');
  assert.equal(waiting.obj.alpha, .55);
  advance(5000);
  assert.deepEqual(hits, []);
  assert.equal(scene.taskSignals.busy, false);
  api.sync(mission('completed'), [...blogWaiting, event(3, 'returning', 'blog')]);
  advance(8000);
  assert.equal(waiting.obj.destroyed, true);
  assert.equal(scene.taskSignals.collected.get('elizabeth').stage, 'returning');
  assert.deepEqual(hits, [true]);
});

test('失败只撤销该船员的信物，其他船员已经公开的返回仍可落桌', async () => {
  const { api, scene, advance } = await sceneFixture({ signals: true });
  const hits = captureShots(scene);
  const both = [event(1, 'returning'), event(2, 'returning', 'blog')];
  api.sync(mission('running'), both);
  advance(100);
  const bottle = scene.taskSignals.flights.find(flight => flight.id === 'elizabeth');
  api.sync(mission('partial'), [...both, event(3, 'failed', 'blog')]);
  assert.equal(bottle.obj.destroyed, true);
  assert.ok(bottle.trail.every(image => image.destroyed));
  assert.equal(scene.taskSignals.flights.length, 1);
  assert.equal(scene.taskSignals.flights[0].id, 'barbossa');
  advance(10000);
  assert.equal(scene.taskSignals.collected.has('elizabeth'), false);
  assert.equal(scene.taskSignals.collected.get('barbossa').stage, 'returning');
  assert.deepEqual(hits, [true]);
});

test('子任务失败只留局部损伤；整轮失败才起火，历史/减少动态不补演，停止清除', async () => {
  const {api,scene,host,advance}=await sceneFixture({damage:true});
  api.sync(mission('running'),[event(1,'working'),event(2,'failed')]);advance(50);
  assert.equal(scene.shipDamage.severity,.45);assert.equal(host.dataset.damageFlames,'0');assert.equal(scene.weatherTarget.name,'storm');
  api.sync(mission('failed'),[event(1,'working'),event(2,'failed')]);advance(50);
  assert.equal(scene.shipDamage.severity,1);assert.equal(host.dataset.damageFlames,'2');
  api.setReducedMotion(true);advance(50);assert.equal(host.dataset.damageFlames,'0');assert.equal(scene.shipDamage.scars[0].visible,true);
  api.setReducedMotion(false);api.sync(mission('failed'),[event(1,'working'),event(2,'failed')],{restore:true});advance(50);
  assert.equal(host.dataset.damageFlames,'0');assert.equal(scene.shipDamage.severity,1);
  api.sync(mission('failed'),[event(1,'working'),event(2,'failed')]);advance(3000);
  assert.equal(host.dataset.damageFlames,'0','历史后的重复同步仍保持静态损伤');
  api.sync(mission('running'),[event(3,'thinking','jack'),event(4,'working')]);advance(50);
  api.sync(mission('failed'),[event(3,'thinking','jack'),event(4,'working'),event(5,'failed')]);advance(50);
  assert.equal(host.dataset.damageFlames,'2','历史之后的新一轮真实失败可重新起火');
  api.sync(mission('cancelled'),[]);advance(50);assert.equal(scene.shipDamage.severity,0);assert.equal(scene.shipDamage.group.visible,false);
});

test('船帆只取当前轮次公开主题，补充接收不替换，历史与队列排空保留',()=>{
  const feed=createSceneEventFeed(),first=[event(1,'thinking','jack'),{seq:2,type:'topic',role:'jack',text:'异常通行 · 分析稿'}];
  feed.push({...mission('running'),title:'旧标题'},first);assert.equal(feed.drain().topic,'异常通行 · 分析稿');
  const supplemented=[...first,{seq:3,type:'message',role:'user',text:'尚未处理的其他要求'}];
  feed.push(mission('running'),supplemented);assert.equal(feed.drain().topic,'异常通行 · 分析稿');assert.equal(feed.drain().topic,'异常通行 · 分析稿');
  feed.push(mission('running'),[...supplemented,event(4,'thinking','jack')]);assert.equal(feed.drain().topic,'');
  const next=[...supplemented,event(4,'thinking','jack'),{seq:5,type:'topic',role:'jack',text:'新公开主题'}];
  feed.push(mission('completed'),next,{restore:true,loading:true});assert.equal(feed.drain().topic,'');
  feed.push(mission('completed'),next,{restore:true});assert.equal(feed.drain().topic,'新公开主题');
  feed.push(mission('cancelled'),next);assert.equal(feed.drain().topic,'');
  feed.push({id:'different',state:'running',title:'不能猜测的标题'},[]);assert.equal(feed.drain().topic,'');
});

test('船首眼光只在整轮完成短闪，重复同步、历史、减少动态不补闪',async()=>{
  const {api,scene,host,advance}=await sceneFixture({details:true});
  for(const status of ['running','waiting','partial','failed','cancelled','interrupted']){
    api.sync(mission(status),[]);advance(50);assert.equal(host.dataset.figureheadEye,'0.000');assert.equal(scene.shipDetails.caption.visible,false);
  }
  const topic=[event(1,'thinking','jack'),{seq:2,type:'topic',role:'jack',text:'异常通行 · 分析稿'}];
  api.sync(mission('completed'),topic);advance(400);assert.equal(host.dataset.figureheadPulse,'true');assert.ok(+host.dataset.figureheadEye>.8);
  assert.equal(scene.shipDetails.caption.text,'异常通行\n分析稿');
  advance(2000);assert.equal(host.dataset.figureheadPulse,'false');assert.equal(host.dataset.figureheadEye,'0.300');
  api.sync(mission('completed'),topic);advance(400);assert.equal(host.dataset.figureheadEye,'0.300');
  api.sync(mission('completed'),topic,{restore:true});advance(400);assert.equal(host.dataset.figureheadPulse,'false');
  api.sync({id:'new',state:'completed'},topic);advance(50);api.setReducedMotion(true);advance(50);assert.equal(host.dataset.figureheadPulse,'false');
  api.setReducedMotion(false);advance(500);assert.equal(host.dataset.figureheadEye,'0.300');
  api.sync(null,[]);advance(50);assert.equal(host.dataset.figureheadEye,'0.000');assert.equal(host.dataset.sailTopic,'');
});
