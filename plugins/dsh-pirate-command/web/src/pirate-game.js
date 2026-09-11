import Phaser from 'phaser';
import { ACTOR_FOR_CREW, createSceneEventFeed, previewText } from './scene-events.js';
import { weatherForPhase, stepAtmosphere, createSeaLayer, createReflection, rippleReflection, createStormEffects, resetStormEffects, updateStormEffects } from './scene-atmosphere.js';
import { TaskSignals } from './task-signals.js';
import { createSceneAudio } from './scene-audio.js';
import { createShipDamage } from './scene-damage.js';
import { createShipDetails } from './ship-details.js';
import { DECK_POINTS, CREW_STOPS, createDeckWalker, walkerBusy, availableStop, moveDeckWalker, stopDeckWalker, settleDeckWalker, stepDeckWalkers, meetingStop, sameDeckLevel } from './deck-navigation.js';
export { DECK_POINTS, deckRoute } from './deck-navigation.js';

// 场景只表现后端已经发布的事件；动画不提交任务，也不决定任务是否完成。
const ROLES = {jack:'杰克',barbossa:'巴博萨',elizabeth:'伊丽莎白'};

export function createPirateGame(host, handlers={}) {
  let game, scene, disposed=false, manifest, reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const feed=createSceneEventFeed(), assetRoot=new URL('assets/',document.baseURI), loading=new AbortController();
  const sceneAudio=createSceneAudio();
  const sound=kind=>sceneAudio.play(kind);
  const state={phase:'loading',label:'场景素材加载中',ready:false,error:null,runActive:false,roles:{jack:'待命',barbossa:'待命',elizabeth:'待命'}};
  const publish=()=>handlers.onState?.({...state,roles:{...state.roles}});
  function phase(name,label){state.phase=name;state.label=label;publish();}

  class PirateScene extends Phaser.Scene {
    constructor(){super('pirate-command');this.actors=[];this.fx=[];this.balls=[];this.lastPublish=0;this.lastShot=0;this.lastEnemyShot=0;this.enemyCue=null;this.seaBands=[];this.visualTime=0;this.now=0;this.meetings=[];this.meeting=null;this.perform=false;this.combat=false;this.pendingHits=0;this.nextGun=0;}
    preload(){
      for(const [key,file] of Object.entries(manifest.images))this.load.image(key,new URL(file,assetRoot).href);
      this.load.on('loaderror',file=>{state.error='素材加载失败：'+file.key;publish();});
    }
    create(){
      if(state.error)return;
      this.atmosphere=stepAtmosphere(weatherForPhase('idle'),weatherForPhase('idle'),0,true);
      this.weatherTarget=weatherForPhase('idle');
      this.seas=['sea','sea-storm','sea-moon'].filter(key=>key==='sea'||manifest.images[key]).map(key=>createSeaLayer(this,key));
      this.seas.forEach(layer=>layer.container.setAlpha(layer.key==='sea'?1:0));
      this.stormFx=createStormEffects(this,manifest.images);
      this.lit=[];
      this.world=this.add.container();
      this.shipLayout=manifest.shipLayout;
      const {x:shipX,y:shipY,scale:shipScale,wake}=this.shipLayout;
      this.shipReflectionGroup=this.add.container(shipX,shipY).setScale(shipScale);this.world.add(this.shipReflectionGroup);
      this.shipReflection=createReflection(this,this.shipReflectionGroup,'ship',1536,140,this.shipLayout.waterline);
      this.wake=this.add.image(wake.x,wake.y,'foam').setDisplaySize(wake.width,wake.height).setAngle(wake.angle).setAlpha(.65);
      this.world.add(this.wake);
      this.enemy=this.add.container(-420,50).setVisible(false);
      this.enemyWake=this.add.image(205,250,'foam').setDisplaySize(405,225).setAngle(-5).setAlpha(.6);
      this.enemyPicture=this.add.image(0,0,'enemy','__BASE').setOrigin(0).setDisplaySize(400,300);
      this.enemy.add([this.enemyWake,this.enemyPicture]);this.world.add(this.enemy);
      // 固定站姿只随船体变换，不参与主船角色的导航或业务动作。
      this.enemyCrew=(manifest.enemyCrew||[]).map(({key,displayFoot,bodyHeight})=>{
        const size=bodyHeight*128/90;
        return this.add.image(...displayFoot,key).setOrigin(.5,.875).setDisplaySize(size,size);
      });
      this.enemy.add(this.enemyCrew);
      this.enemyForeground=manifest.images['enemy-foreground']?this.add.image(0,0,'enemy-foreground').setOrigin(0).setDisplaySize(400,300):null;
      if(this.enemyForeground)this.enemy.add(this.enemyForeground);
      this.lit.push(this.wake,this.enemyWake,this.enemyPicture,...this.enemyCrew,...(this.enemyForeground?[this.enemyForeground]:[]));
      const reflectionKey='enemy-reflection-composite';this.enemyReflectionTexture=this.textures.createCanvas(reflectionKey,512,384);
      this.refreshEnemyReflection();
      this.enemyReflection=createReflection(this,this.enemy,reflectionKey,400,88,291);this.enemy.moveTo(this.enemyReflection.container,0);
      this.events.once('shutdown',()=>this.textures.remove(reflectionKey));
      this.projectiles=this.add.container();this.world.add(this.projectiles);
      this.ship=this.add.container(shipX,shipY).setScale(shipScale);this.world.add(this.ship);
      const shipImage=this.add.image(0,0,'ship','__BASE').setOrigin(0).setDepth(0);this.ship.add(shipImage);this.lit.push(shipImage);
      for(const layer of manifest.occlusion||[]){
        const image=this.add.image(0,0,layer.key).setOrigin(0).setDepth(layer.depth);this.ship.add(image);this.lit.push(image);
      }
      this.guns=[];
      for(const [x,y] of this.shipLayout.guns){
        const obj=this.add.image(x,y,'cannon').setDisplaySize(96,96).setOrigin(.67,.70).setDepth(y);
        const muzzleFx=this.add.container().setDepth(y+.5);this.ship.add(muzzleFx);
        this.ship.add(obj);this.lit.push(obj);this.guns.push({obj,muzzleFx,x,y,last:0});
      }
      this.syncMuzzleLayers();
      const fxFrames=manifest.fxFrames||[[0,0,512,512],[512,0,512,512],[0,512,512,512],[512,512,512,512]];
      for(let i=0;i<fxFrames.length;i++)this.textures.get('fx').add(i,0,...fxFrames[i]);
      for(const sequence of Object.values(manifest.shotEffects||{}))sequence.frames.forEach((rect,i)=>this.textures.get(sequence.key).add(i,0,...rect));
      this.shipDamage=createShipDamage(this,manifest.damage);
      this.shipDetails=createShipDetails(this,manifest.shipDetails);
      this.taskSignals=new TaskSignals(this,manifest.taskSignals,id=>this.actor(id));
      for(const [id,node] of Object.entries(this.shipLayout.spawn)){
        const asset=manifest.characters[id];
        if(!asset)continue;
        const frames=asset.frames||[];
        for(let i=0;i<frames.length;i++){const r=frames[i].rect;this.textures.get(id).add(i,0,...r);}
        const [x,y]=DECK_POINTS[node], group=this.add.container(x,y).setDepth(y);
        const shadow=this.add.image(0,1,'fx',0).setAlpha(.17).setDisplaySize(46,10);
        group.add(shadow);
        let sprite,parts;
        if(asset.parts){
          parts=asset.parts.map(p=>{
            const im=this.add.image(p.x,p.y,p.key).setOrigin(...p.origin).setDisplaySize(p.width,p.height);group.add(im);this.lit.push(im);return {im,...p};
          });
        }else{
          sprite=this.add.image(0,0,id,frames.length?0:undefined).setOrigin(.5,1);
          sprite.setDisplaySize(asset.displayWidth||136,asset.displayHeight||136);group.add(sprite);this.lit.push(sprite);
        }
        this.ship.add(group);
        this.actors.push({id,nav:createDeckWalker(id,node),group,sprite,parts,asset,waitUntil:500+Math.random()*1800,walkPhase:0,holdUntil:0,bubble:'',bubbleUntil:0,facing:1,moving:false});
      }
      this.scale.on('resize',this.layout,this);this.layout();
      state.notice=Object.keys(ROLES).filter(id=>!manifest.characters[id]).map(id=>ROLES[id]+'素材待接入').join(' · ');
      scene=this;state.ready=true;
      const pending=feed.drain();if(pending)this.sync(pending);else phase('idle','待命航行');
      publish();
    }
    layout(){
      const w=this.scale.width,h=this.scale.height;
      let s=Math.min(w/1672,h/941),x=(w-1672*s)/2,y=h-941*s;
      if(w<h){
        const {x:sx,y:sy,scale,bounds:[left,top,right,bottom]}=this.shipLayout;
        const width=(right-left)*scale,height=(bottom-top)*scale;
        // 竖屏按完整船体填宽；四边4世界单位覆盖当前颠簸，另留8屏幕像素。
        s=Math.min((w-16)/(width+8),(h-16)/(height+8));
        x=(w-width*s)/2-(sx+left*scale)*s;y=h-8-(sy+bottom*scale+4)*s;
      }
      this.fit=s;this.world.setScale(s).setPosition(x,y);
      for(const layer of this.seas)for(const band of layer.bands){
        const top=Math.round(band.y*h/layer.height),bottom=Math.round((band.y+band.height)*h/layer.height);
        band.image.setPosition(-8,top).setDisplaySize(w+16,bottom-top);
      }
    }
    actor(id){return this.actors.find(a=>a.id===id);}
    screenToWorld(x,y){return this.world.getWorldTransformMatrix().applyInverse(x,y);}
    pointOn(obj,x=0,y=0){const p=obj.getWorldTransformMatrix().transformPoint(x,y);return this.screenToWorld(p.x,p.y);}
    go(id,node){
      const a=this.actor(id);if(!a)return false;
      const accepted=moveDeckWalker(this.actors.map(actor=>actor.nav),a.nav,node);
      if(accepted)a.waitUntil=0;
      return accepted;
    }
    bubble(id,text,ms=4500){const a=this.actor(id);if(a){a.bubble=text;a.bubbleUntil=this.now+ms;}}
    sync(snapshot){
      this.lastSnapshot=snapshot;
      sceneAudio.sync(snapshot);this.shipDamage.sync(snapshot);
      this.shipDetails.sync(snapshot);
      const wasPerform=this.perform, priorId=this.missionId;
      this.missionId=snapshot.mission?.id??null;this.perform=snapshot.perform;
      state.runActive=snapshot.runActive;state.roles=snapshot.roles;phase(snapshot.phase,snapshot.label);
      this.weatherTarget=weatherForPhase(snapshot.perform&&snapshot.phase==='failed'?'working':snapshot.phase);
      if(snapshot.restoreWorld||reduced)this.updateAtmosphere(0,true);
      if(snapshot.initialize||snapshot.restoreWorld||snapshot.stop||reduced){
        this.clearMeetings();this.cancelVisuals();this.combat=false;this.pendingHits=0;
        this.taskSignals.restore(snapshot.restoreWorld||snapshot.stop||reduced?snapshot.roleStages:{});
        resetStormEffects(this.stormFx);
      }
      if(snapshot.initialize||(!wasPerform&&this.perform)){
        this.actors.forEach(a=>{stopDeckWalker(a.nav);a.holdUntil=0;a.waitUntil=this.now+800;});
      }
      if(snapshot.initialize||snapshot.restoreWorld||!snapshot.mission){this.enemy.setVisible(false);this.enemyMode=null;}
      this.roleStages=snapshot.roleStages;
      for(const event of snapshot.events){
        const actor=ACTOR_FOR_CREW[event.role];
        const animate=!snapshot.stop&&!reduced;
        if(animate&&event.type==='status'&&event.stage==='commanding'&&this.actor(actor)&&this.actor('jack')){
          this.meetings=this.meetings.filter(meeting=>meeting.actor!==actor);
          this.meetings.push({actor,command:event.commandText||previewText(event.text),reply:snapshot.replies[actor]||''});
          this.meetings=this.meetings.slice(-8);
        }
        if(actor&&event.type==='message'&&event.text){
          const meetings=[...this.meetings,...(this.meeting?[this.meeting]:[])].filter(meeting=>meeting.actor===actor);
          if(!meetings.length)this.bubble(actor,previewText(event.text));
          for(const meeting of meetings)meeting.reply=previewText(event.text);
          if(this.meeting?.actor===actor&&this.meeting.talking)this.bubble(actor,previewText(event.text),3200);
        }
        if(animate&&actor&&event.type==='status'){
          if(event.stage==='working'||event.stage==='commanding'){this.combat=true;this.stormFx.allowFlash=true;}
          if(event.stage==='commanding')this.taskSignals.command(actor);
          if(event.stage==='returning'&&!this.taskSignals.receive(actor,event.stage))this.pendingHits++;
          if(event.stage==='waiting')this.taskSignals.receive(actor,event.stage);
          if(event.stage==='failed'||event.stage==='cancelled')this.taskSignals.fail(actor);
        }
        if(event.role==='jack'&&event.type==='message'&&!this.meeting&&!/^巴博萨：|^伊丽莎白：/.test(event.text))this.bubble('jack',previewText(event.text));
      }
      if(this.perform||this.pendingHits>0||this.taskSignals.busy){
        if(snapshot.restoreWorld||reduced){this.enemy.setPosition(95,50).setVisible(true);this.enemyMode='hold';}
        else if(!this.enemy.visible||this.enemyMode==='leave'||priorId!==this.missionId){
          this.enemy.setPosition(-420,50).setVisible(true);this.enemyMode='enter';this.enemyStart=this.now;this.lastShot=this.now;this.lastEnemyShot=this.now;sound('horn');
        }
      }
    }
    clearMeetings(){
      this.meetings=[];this.meeting=null;
      this.actors.forEach(a=>{stopDeckWalker(a.nav);a.nav.pinned=false;a.holdUntil=0;a.bubble='';a.waitUntil=this.now+800+Math.random()*800;});
    }
    cancelVisuals(){for(const f of this.fx)f.obj.destroy();for(const b of this.balls)b.obj.destroy();this.fx=[];this.balls=[];this.lastEnemyShot=this.now;this.enemyCue=null;this.setEnemyCrewPoses(false,false);this.actors.forEach(a=>{a.bubble='';});}
    refreshEnemyReflection(){
      // 只在实际姿态变化时重绘同一纹理；不包含浪花或倒影自身，不烘焙天气光照。
      const texture=this.enemyReflectionTexture,context=texture.context;
      context.clearRect(0,0,512,384);context.save();context.scale(512/400,384/300);
      for(const image of [this.enemyPicture,...this.enemyCrew,...(this.enemyForeground?[this.enemyForeground]:[])]){
        const frame=image.texture.get('__BASE');
        context.drawImage(frame.source.image,frame.cutX,frame.cutY,frame.cutWidth,frame.cutHeight,
          image.x-image.originX*image.displayWidth,image.y-image.originY*image.displayHeight,image.displayWidth,image.displayHeight);
      }
      context.restore();texture.refresh();
    }
    setEnemyCrewPoses(command,coverEars){
      let changed=false;
      this.enemyCrew.forEach((image,index)=>{
        const asset=manifest.enemyCrew[index],key=(command&&asset.poses?.command)||(coverEars&&asset.poses?.coverEars)||asset.key;
        if(image.texture.key!==key){image.setTexture(key,'__BASE');changed=true;}
      });
      if(changed)this.refreshEnemyReflection();
    }
    select(id){const a=this.actor(id);if(a){if(!state.runActive)a.holdUntil=this.now+1400;handlers.onSelect?.(id);}}
    tickCollaboration(){
      if(reduced)return;
      const jack=this.actor('jack');
      this.meetings=this.meetings.filter(meeting=>jack&&this.actor(meeting.actor));
      if(!this.meeting&&this.meetings.length){
        this.meeting=this.meetings.shift();const crew=this.actor(this.meeting.actor);
        crew.nav.pinned=true;crew.holdUntil=0;settleDeckWalker(crew.nav);
        stopDeckWalker(jack.nav);this.meeting.target=null;
      }
      if(this.meeting){
        const crew=this.actor(this.meeting.actor);
        if(!walkerBusy(crew.nav)){
          crew.holdUntil=Infinity;
          if(this.meeting.target===null){
            const target=meetingStop(this.actors.map(actor=>actor.nav),jack.nav,crew.nav);
            if(target!==null&&this.go('jack',target))this.meeting.target=target;
          }
        }
        const separation=Math.hypot(jack.group.x-crew.group.x,jack.group.y-crew.group.y);
        if(!this.meeting.talking&&this.meeting.target!==null&&!walkerBusy(jack.nav)&&jack.nav.node===this.meeting.target&&sameDeckLevel(jack.nav,crew.nav)&&separation>=52&&separation<=145){
          this.meeting.talking=true;this.meeting.until=this.now+3300;jack.holdUntil=this.meeting.until;
          jack.facing=crew.group.x<jack.group.x?1:-1;crew.facing=-jack.facing;
          this.actors.forEach(a=>{a.bubble='';});
          this.bubble('jack',this.meeting.command,3300);this.bubble(crew.id,this.meeting.reply,3300);
        }
        if(this.meeting.talking&&this.now>=this.meeting.until){
          stopDeckWalker(jack.nav);jack.holdUntil=0;jack.bubble='';crew.nav.pinned=false;crew.holdUntil=0;crew.bubble='';this.meeting=null;
        }
      }
      const working=this.perform&&Object.entries(this.roleStages??{}).some(([actor,stage])=>actor!=='jack'&&['working','commanding'].includes(stage));
      if((this.pendingHits>0||(this.combat&&working))&&this.enemyMode==='hold'&&this.now-this.lastShot>1450){
        this.lastShot=this.now;const hit=this.pendingHits>0;if(hit)this.pendingHits--;
        this.fire(this.nextGun++%this.guns.length,hit);
      }
      const sinceMainShot=this.now-this.lastShot;
      const canCounterfire=this.combat&&working&&this.enemy.visible&&this.enemyMode==='hold'&&this.now-this.lastEnemyShot>=3600;
      if(this.enemyCue?.firedAt==null&&(!canCounterfire||this.enemyCue?.mainShot!==this.lastShot||sinceMainShot>1000))this.enemyCue=null;
      if(!this.enemyCue&&canCounterfire&&sinceMainShot>=100&&sinceMainShot<=450)this.enemyCue={mainShot:this.lastShot,started:this.now,firedAt:null};
      if(this.enemyCue&&this.enemyCue.firedAt==null&&canCounterfire&&sinceMainShot>=450&&sinceMainShot<=1000&&this.now-this.enemyCue.started>=250){
        this.lastEnemyShot=this.now;this.enemyCue.firedAt=this.now;this.fireEnemy();
      }
      if(this.enemyCue?.firedAt!=null&&this.now-this.enemyCue.firedAt>=650)this.enemyCue=null;
      const cue=this.enemyCue;
      this.setEnemyCrewPoses(!!cue&&(cue.firedAt==null||this.now-cue.firedAt<150),!!cue&&(cue.firedAt!=null||this.now-cue.started>=150));
    }
    syncMuzzleLayers(){
      // 沿炮位参与甲板深度排序，抵消船体变换，让已发射烟光仍固定在世界坐标。
      const origin=this.ship.getLocalTransformMatrix().applyInverse(0,0);
      for(const gun of this.guns)gun.muzzleFx.setPosition(origin.x,origin.y).setRotation(-this.ship.rotation).setScale(1/this.ship.scaleX);
    }
    makeFx(frame,x,y,width,height,life=900,alpha=1,container=this.projectiles){
      const sequence=frame===1?manifest.shotEffects?.smoke:frame===3?manifest.shotEffects?.splash:null;
      if(sequence)width=height=sequence.size;
      const origin=sequence?.origin||[.5,frame===3?.9:.5];
      const obj=this.add.image(x,y,sequence?.key||'fx',sequence?0:frame).setOrigin(...origin).setDisplaySize(width,height).setAlpha(alpha);container.add(obj);
      this.fx.push({obj,frame,sequence,phaseIndex:sequence?0:null,start:this.now,life,width,height,alpha,x,y});return obj;
    }
    fire(index,hit=false){
      const gun=this.guns[index];gun.last=this.now;
      const [mx,my]=manifest.cannon.muzzle;
      const start=this.pointOn(gun.obj,mx-gun.obj.displayOriginX,my-gun.obj.displayOriginY);
      // 命中区位于船壳；未命中区在水线 291 下方，水花以基盘接触海面。
      const localEnd=hit?{x:125+Math.random()*135,y:235+Math.random()*23}:{x:190+Math.random()*35,y:310+Math.random()*10};
      const end=this.pointOn(this.enemy,localEnd.x,localEnd.y);
      this.makeFx(2,start.x,start.y,70,70,150,1,gun.muzzleFx);
      this.makeFx(1,start.x,start.y,52,42,1450,.7,gun.muzzleFx);
      const obj=this.add.image(start.x,start.y,'fx',0).setDisplaySize(16,16);this.projectiles.add(obj);
      this.balls.push({obj,start,end,localEnd,born:this.now,duration:1000+Math.random()*250,hit});
      sound('cannon');
    }
    fireEnemy(){
      // 空船 1448×1086 母版下层外伸炮管 (736,919)，映射到 400×300 显示画布。
      const start=this.pointOn(this.enemy,736*400/1448,919*300/1086);
      // 主船局部海面，零姿态约世界 (224,341)，沿可见炮管朝左下出射。
      const localEnd={x:239.286453,y:367.659081};
      const end=this.pointOn(this.ship,localEnd.x,localEnd.y);
      this.makeFx(2,start.x,start.y,42,42,150);
      this.makeFx(1,start.x,start.y,52,42,1450,.55).setRotation(Math.atan2(end.y-start.y,end.x-start.x)+3*Math.PI/4);
      const obj=this.add.image(start.x,start.y,'fx',0).setDisplaySize(16,16);this.projectiles.add(obj);
      // 仅在船首旁海面落水，不触发船损、返回信物或业务命中。
      this.balls.push({obj,start,end,localEnd,born:this.now,duration:1000+Math.random()*250,hit:false,side:'enemy',arc:0});
      sound('cannon');
    }
    moveActors(delta){
      const walkers=this.actors.map(a=>a.nav),arrivals=new Map(walkers.map(walker=>[walker.id,walker.arrivals]));
      for(const a of this.actors){a.nav.paused=this.now<a.holdUntil;a.nav.priority=this.meeting&&(a.id==='jack'||a.id===this.meeting.actor)?2:0;}
      stepDeckWalkers(walkers,delta,state.runActive||this.meeting?105:54);
      for(const a of this.actors){
        a.group.setPosition(a.nav.x,a.nav.y);a.moving=a.nav.moving;if(a.moving)a.facing=a.nav.facing;
        if(a.nav.arrivals!==arrivals.get(a.id))a.waitUntil=this.now+1500+Math.random()*2200;
        if(!state.runActive&&!this.meeting&&!this.meetings.length&&!walkerBusy(a.nav)&&this.now>a.waitUntil&&this.now>a.holdUntil){
          const choices=CREW_STOPS[a.id].filter(node=>node!==a.nav.node&&availableStop(walkers,a.nav,node));
          if(choices.length)this.go(a.id,choices[Math.floor(Math.random()*choices.length)]);else a.waitUntil=this.now+1200;
        }
        a.group.setDepth(a.group.y);
        if(a.moving)a.walkPhase+=delta*.010;
        const walk=a.moving?Math.sin(a.walkPhase):0;
        if(a.sprite){
          const n=(a.asset.frames||[]).length;
          const frame=n>1?(a.moving?[1,2,3,4][Math.floor(a.walkPhase*1.3)%4]:(a.bubble?Math.min(5,n-1):0)):undefined;
          if(frame!==undefined)a.sprite.setFrame(frame);
          a.sprite.setFlipX(a.facing<0).setY(a.moving?-Math.abs(walk)*1.5:0);
          if(n>1){const f=a.asset.frames[frame];a.sprite.setOrigin(.5,(f.footY||a.asset.frameHeight)/a.asset.frameHeight);}
        }
        if(a.parts){
          for(const p of a.parts){p.im.setFlipX(a.facing<0);p.im.setX(p.x*a.facing);p.im.angle=(p.swing||0)*walk*a.facing;p.im.y=p.y-(a.moving?Math.abs(walk)*1.3:0);}
        }
        if(a.bubble&&this.now>a.bubbleUntil)a.bubble='';
      }
      this.ship.sort('depth');
    }
    updateAtmosphere(delta,immediate=false){
      this.atmosphere=stepAtmosphere(this.atmosphere,this.weatherTarget,delta,immediate);
      const {stormAlpha,moon,tint}=this.atmosphere;
      for(const layer of this.seas){const alpha=layer.key==='sea'?1:layer.key==='sea-storm'?stormAlpha:moon;layer.container.setAlpha(alpha).setVisible(alpha>0);}
      if(tint!==this.lightingTint){this.lightingTint=tint;for(const image of this.lit)image.setTint(tint);}
      host.dataset.weather=this.weatherTarget.name;host.dataset.weatherMoon=moon.toFixed(3);host.dataset.weatherStorm=this.atmosphere.storm.toFixed(3);
    }
    update(time,delta){
      if(!state.ready||disposed)return;
      this.now=time;delta=Math.min(delta,50);this.visualTime+=reduced?0:delta;const t=this.visualTime/1000;
      this.ship.y=this.shipLayout.y+(reduced?0:Math.sin(t*1.35)*1.8);this.ship.rotation=reduced?0:Math.sin(t*.64)*.0014;
      this.syncMuzzleLayers();
      this.shipReflectionGroup.y=this.ship.y;this.shipReflectionGroup.rotation=this.ship.rotation;
      this.updateAtmosphere(delta,reduced);
      updateStormEffects(this.stormFx,{width:this.scale.width,height:this.scale.height,delta,phase:state.phase,storm:this.atmosphere.storm,active:this.perform,reduced});
      rippleReflection(this.shipReflection,t,reduced);rippleReflection(this.enemyReflection,t,reduced,this.atmosphere.tint);
      this.wake.setPosition(this.shipLayout.wake.x+Math.sin(t*.45)*4,this.shipLayout.wake.y+Math.sin(t*.7)*3).setAlpha(.65+Math.sin(t*.9)*.12);
      this.enemyWake.setAlpha(.6+Math.sin(t*.8+1)*.1);
      for(const layer of this.seas)if(layer.container.visible)for(const {image,y} of layer.bands){image.x=-8+(reduced||y===0?0:Math.sin(t*1.1-y*.031)*(1.5+y*.004));}
      if(this.enemy.visible){
        if(this.enemyMode==='enter'){const p=Math.min(1,(time-this.enemyStart)/5000);this.enemy.x=-420+515*Phaser.Math.Easing.Sine.InOut(p);if(p===1)this.enemyMode='hold';}
        if(this.enemyMode==='leave'){const p=Math.min(1,(time-this.enemyStart)/4000);this.enemy.x=(this.enemyFrom??95)-600*p;if(p===1){this.enemy.setVisible(false);this.enemyMode=null;}}
        this.enemy.y=50+Math.sin(t*1.4+2)*3;this.enemy.rotation=reduced?0:Math.sin(t*.9)*.006;
      }
      this.taskSignals.update(time,(hit,id)=>{if(hit)this.pendingHits++;sound(id==='elizabeth'?'bottle':'paper');},()=>sound('coin'));
      this.shipDamage.update(delta,reduced);sceneAudio.update();
      this.shipDetails.update(delta,reduced);
      this.tickCollaboration();this.moveActors(delta);
      for(const gun of this.guns){const p=(time-gun.last)/550;gun.obj.setPosition(gun.x+(p<1?Math.sin(p*Math.PI)*4:0),gun.y+(p<1?Math.sin(p*Math.PI)*3:0));}
      this.balls=this.balls.filter(b=>{
        const p=Math.min(1,(time-b.born)/b.duration);
        const x=Phaser.Math.Linear(b.start.x,b.end.x,p),y=Phaser.Math.Linear(b.start.y,b.end.y,p)-Math.sin(p*Math.PI)*(b.arc??38);
        b.obj.setPosition(x,y).setDisplaySize(16-p*6,16-p*6);
        if(p<1)return true;
        b.obj.destroy();this.makeFx(b.hit?2:3,b.end.x,b.end.y,b.hit?42:58,b.hit?42:66,650,.9);sound(b.hit?'impact':'splash');return false;
      });
      this.fx=this.fx.filter(f=>{
        const p=(time-f.start)/f.life;if(p>=1){f.obj.destroy();return false;}
        if(f.sequence){
          // 各帧已表现扩张与回落；固定画布、接触点，只在尾段淡出，不循环。
          f.phaseIndex=Math.min(f.sequence.frames.length-1,Math.floor(p*f.sequence.frames.length));
          f.obj.setFrame(f.phaseIndex).setAlpha(f.alpha*Math.min(1,(1-p)/.3));
        }else{
          f.obj.setAlpha(f.alpha*(1-p));
          if(f.frame===1)f.obj.setDisplaySize(f.width*(1+p*1.2),f.height*(1+p*1.1)).setPosition(f.x-p*28,f.y-p*22);
          else if(f.frame===3)f.obj.setDisplaySize(f.width*(.8+p*.6),f.height*(1-p*.3));
        }
        return true;
      });
      // 终态立即生效；已收到的公开会面和炮弹完成后，敌船再离场。
      if(!this.perform&&!this.meeting&&!this.meetings.length&&!this.taskSignals.busy&&!this.pendingHits&&!this.balls.length&&!this.fx.length&&this.enemy.visible&&this.enemyMode!=='leave'){
        this.enemyMode='leave';this.enemyStart=this.now;this.enemyFrom=this.enemy.x;
      }
      const audioState=sceneAudio.status();host.dataset.audioReady=String(audioState.ready);host.dataset.audioMuted=String(audioState.muted);host.dataset.audioCues=JSON.stringify(audioState.counts);host.dataset.damageSeverity=String(this.shipDamage.severity);host.dataset.damageFlames=String(this.shipDamage.fires.filter(fire=>fire.visible).length);
      host.dataset.damageFireFrames=this.shipDamage.fires.map(fire=>fire.frame?.name??fire.frame).join(',');host.dataset.damageFireTime=String(Math.floor(this.shipDamage.time));
      host.dataset.sailTopic=this.shipDetails.topic;host.dataset.figureheadEye=(this.shipDetails.eye?.alpha||0).toFixed(3);host.dataset.figureheadPulse=String(this.shipDetails.live);
      handlers.onFrame?.(this.actors.map(a=>{const p=a.group.getWorldTransformMatrix().transformPoint(0,0);return {id:a.id,name:ROLES[a.id],x:p.x,y:p.y,width:76*this.fit*this.shipLayout.scale,height:(a.asset.visualHeight||128)*this.fit*this.shipLayout.scale,bubble:a.bubble,moving:a.moving};}));
      if(time-this.lastPublish>500){this.lastPublish=time;publish();}
      host.dataset.sceneReady='true';host.dataset.projectiles=String(this.balls.length);host.dataset.phase=state.phase;
      host.dataset.projectileTargets=JSON.stringify(this.balls.map(({hit,localEnd,end,start,side='main'})=>({hit,localEnd,end,start,side})));
      host.dataset.splashContacts=JSON.stringify(this.fx.filter(f=>f.frame===3).map(f=>({x:f.obj.x,y:f.obj.y,originX:f.obj.originX,originY:f.obj.originY,width:f.obj.displayWidth,height:f.obj.displayHeight,age:time-f.start})));
      host.dataset.shotEffectPhases=JSON.stringify(this.fx.filter(f=>f.sequence).map(f=>({kind:f.frame===1?'smoke':'splash',key:f.sequence.key,phase:f.phaseIndex,displayFrame:f.obj.frame?.name??f.obj.frame,x:f.obj.x,y:f.obj.y,width:f.obj.displayWidth,height:f.obj.displayHeight,originX:f.obj.originX,originY:f.obj.originY,alpha:f.obj.alpha,age:time-f.start,life:f.life})));
      host.dataset.enemyMode=this.enemyMode||'hidden';host.dataset.pendingHits=String(this.pendingHits);host.dataset.effects=String(this.fx.length);host.dataset.meetings=String(this.meetings.length+Number(!!this.meeting));
      host.dataset.enemyCrew=JSON.stringify({visible:this.enemy.visible,layers:this.enemy.list.map(obj=>obj.texture?.key||'reflection'),tint:this.enemyPicture.tintTopLeft,foregroundTint:this.enemyForeground?.tintTopLeft,crew:this.enemyCrew.map(obj=>({key:obj.texture?.key,x:obj.x,y:obj.y,width:obj.width,height:obj.height,displayWidth:obj.displayWidth,size:obj.displayHeight,originX:obj.originX,originY:obj.originY,visible:obj.visible,tint:obj.tintTopLeft}))});
      host.dataset.coinFlights=String(this.taskSignals.flights.filter(flight=>flight.kind==='coin').length);host.dataset.returnFlights=String(this.taskSignals.flights.filter(flight=>flight.kind==='return').length);
      host.dataset.collectedTokens=[...this.taskSignals.collected].map(([id,item])=>id+':'+item.stage).join(',');
      host.dataset.rainActive=String(this.stormFx.rain.visible&&this.stormFx.drops.length>0);host.dataset.rainDrift=this.stormFx.time.toFixed(0);
      host.dataset.lightningAlpha=(this.stormFx.bolt?.alpha||0).toFixed(3);
    }
  }

  publish();
  fetch(new URL('manifest.json',assetRoot),{signal:loading.signal}).then(r=>{if(!r.ok)throw new Error('素材清单尚未准备好');return r.json();}).then(data=>{
    if(disposed)return;manifest=data;
    game=new Phaser.Game({type:Phaser.AUTO,parent:host,width:host.clientWidth,height:host.clientHeight,backgroundColor:'#153448',transparent:false,render:{antialias:true,pixelArt:false},scale:{mode:Phaser.Scale.RESIZE,autoCenter:Phaser.Scale.CENTER_BOTH},scene:[PirateScene],audio:{noAudio:true},banner:false});
  }).catch(e=>{if(!disposed){state.error=e.message;state.label='素材准备未完成';publish();}});
  return {
    sync(mission,events,options){
      if(disposed)return;
      feed.push(mission,events,options);
      if(scene){const snapshot=feed.drain();if(snapshot)scene.sync(snapshot);}
    },
    selectRole:id=>scene?.select(id),
    setMuted:value=>sceneAudio.setMuted(value),
    setReducedMotion(value){reduced=value;if(value&&scene){scene.clearMeetings();scene.cancelVisuals();scene.pendingHits=0;scene.combat=false;scene.taskSignals.restore(scene.lastSnapshot?.roleStages);resetStormEffects(scene.stormFx);scene.updateAtmosphere(0,true);}},
    destroy(){disposed=true;loading.abort();game?.destroy(true);sceneAudio.destroy();},
  };
}
