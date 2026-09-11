// 银币和信物只表现公开协作事件，落桌回调只触发场景效果。
export class TaskSignals {
  constructor(scene, config, actor) {
    this.scene=scene;this.config=config;this.actor=actor;this.jobs=[];this.flights=[];this.collected=new Map();
    if(!config)return;
    const {table}=config;
    this.table=scene.add.image(table.x,table.y,table.key,'__BASE').setOrigin(...table.origin).setDisplaySize(table.size,table.size).setDepth(table.y);
    scene.ship.add(this.table);scene.lit.push(this.table);
    this.air=scene.add.container().setDepth(2000);scene.ship.add(this.air);
    this.items=scene.add.container().setDepth(table.y+1);scene.ship.add(this.items);
  }
  get busy(){return this.jobs.length+this.flights.length>0;}
  command(id){
    if(!this.config?.crew[id])return;
    this.jobs.push({id,kind:'coin'});
  }
  receive(id,stage){
    if(!this.config?.crew[id]||!this.actor(id))return false;
    this.jobs.push({id,kind:'return',stage});return true;
  }
  removeItem(id){this.collected.get(id)?.obj.destroy();this.collected.delete(id);}
  clear(){
    for(const flight of this.flights){flight.obj.destroy();flight.trail.forEach(image=>image.destroy());}
    for(const id of this.collected.keys())this.removeItem(id);
    this.jobs=[];this.flights=[];
  }
  restore(stages={}){
    this.clear();
    for(const [id,stage] of Object.entries(stages))if(this.config?.crew[id]&&['returning','waiting'].includes(stage))this.place(id,stage);
  }
  fail(id){
    this.jobs=this.jobs.filter(job=>job.id!==id);
    this.flights=this.flights.filter(flight=>{if(flight.id!==id)return true;flight.obj.destroy();flight.trail.forEach(image=>image.destroy());return false;});
    this.removeItem(id);
  }
  place(id,stage,obj){
    this.removeItem(id);
    const {table,crew}=this.config, slot=crew[id].slot;
    obj??=this.scene.add.image(0,0,crew[id].token,'__BASE');
    this.items.add(obj);obj.setPosition(table.target[0]+slot,table.target[1]).setDisplaySize(32,32).setAngle(0).setAlpha(stage==='waiting'?.55:.95);
    this.collected.set(id,{stage,obj});
  }
  update(time,onReturn,onCoin=()=>{}){
    if(!this.config)return;
    const pending=[];
    for(const job of this.jobs){
      if(this.flights.some(flight=>flight.id===job.id)){pending.push(job);continue;}
      const from=this.actor(job.kind==='coin'?'jack':job.id),to=this.actor(job.id);
      if(job.kind==='coin')this.removeItem(job.id);
      // 杰克素材未接入时不从空中伪造银币发射者；后续信物仍可落到真实海图桌。
      if(!from||!to)continue;
      const part=this.config.crew[job.id],key=job.kind==='coin'?part.coin:part.token;
      const obj=this.scene.add.image(0,0,key,'__BASE').setDisplaySize(job.kind==='coin'?52:64,job.kind==='coin'?52:64);
      const trail=Array.from({length:5},()=>this.scene.add.image(0,0,'fx',2).setDisplaySize(8,8).setTint(job.kind==='coin'?0xffd184:part.tint));
      this.air.add([...trail,obj]);
      this.flights.push({...job,obj,trail,start:time,duration:job.kind==='coin'?900:job.id==='elizabeth'?1600:1250,from:{x:from.group.x,y:from.group.y-65}});
    }
    this.jobs=pending;
    this.flights=this.flights.filter(flight=>{
      const p=Math.min(1,Math.max(0,(time-flight.start)/flight.duration)),actor=this.actor(flight.id);
      const end=flight.kind==='coin'?{x:actor.group.x,y:actor.group.y-108}:{x:this.config.table.target[0]+this.config.crew[flight.id].slot,y:this.config.table.target[1]};
      const height=flight.kind==='coin'?45:flight.id==='elizabeth'?110:38;
      const point=q=>({x:flight.from.x+(end.x-flight.from.x)*q,y:flight.from.y+(end.y-flight.from.y)*q-Math.sin(q*Math.PI)*height});
      const here=point(p);flight.obj.setPosition(here.x,here.y);
      if(flight.kind==='coin')flight.obj.setDisplaySize(52*Math.max(.16,Math.abs(Math.cos(p*Math.PI*3))),52);
      else flight.obj.setAngle(Math.sin(p*Math.PI*3)*(flight.id==='elizabeth'?18:9)).setDisplaySize(64-p*12,64-p*12);
      flight.trail.forEach((image,index)=>{const q=Math.max(0,p-(index+1)*.024),at=point(q);image.setPosition(at.x,at.y).setAlpha(p>0&&p<1?.3*(1-index/5):0);});
      if(p<1)return true;
      flight.trail.forEach(image=>image.destroy());
      if(flight.kind==='coin'){flight.obj.destroy();onCoin(flight.id);}
      else{this.place(flight.id,flight.stage,flight.obj);onReturn(flight.stage==='returning',flight.id);}
      return false;
    });
  }
}
