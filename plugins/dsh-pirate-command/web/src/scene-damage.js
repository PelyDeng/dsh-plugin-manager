// 失败只改变视觉；损伤不改导航、不判定业务结果，也不把停止当失败。
export function createShipDamage(scene,config){
  const group=scene.add.container().setDepth(1900);scene.ship.add(group);
  const frames=config?.fireFrames||[];
  for(const [index,rect]of frames.entries())scene.textures.get(config.fire).add(index,0,...rect);
  const scars=[],fires=[],smoke=[];
  for(const [index,point]of(config?.spots||[]).entries()){
    const scar=scene.add.image(point.x,point.y,config.scar,'__BASE').setDisplaySize(point.size,point.size).setAngle(point.angle||0);
    const fire=scene.add.image(point.fire[0],point.fire[1],config.fire,frames.length?0:'__BASE').setOrigin(.5,.8125).setDisplaySize(96,96);
    group.add([scar,fire]);scars.push(scar);fires.push(fire);
    for(let i=0;i<3;i++){const obj=scene.add.image(0,0,'fx',1).setDisplaySize(36,30);group.add(obj);smoke.push({obj,index,offset:i/3});}
  }
  group.setVisible(false);
  return {group,scars,fires,smoke,severity:0,live:false,time:0,
    sync(snapshot){
      const state=snapshot.mission?.state,previous=this.severity;
      this.severity=snapshot.stop||!state||state==='completed'?0:state==='failed'?1:Object.values(snapshot.roleStages||{}).includes('failed')?.45:0;
      if(snapshot.restoreWorld||snapshot.stop)this.live=false;
      else if(snapshot.initialize||previous!==this.severity)this.live=true;
      if(snapshot.initialize||snapshot.restoreWorld||snapshot.stop)this.time=0;
    },
    update(delta,reduced){
      const severe=this.severity===1,moving=severe&&this.live&&!reduced;
      this.group.setVisible(this.severity>0);if(moving)this.time+=Math.min(50,Math.max(0,delta));
      this.scars.forEach((obj,i)=>obj.setVisible(severe||i===0).setAlpha(severe?.92:.6));
      const frame=Math.floor(this.time/(config?.fireFrameMs||120));
      this.fires.forEach((obj,i)=>obj.setVisible(moving).setFrame(frames.length?(frame+i*2)%frames.length:'__BASE').setAlpha(.8+Math.sin(this.time*.009+i*2)*.12));
      this.smoke.forEach(({obj,index,offset})=>{
        const p=(this.time/2800+offset)%1,point=config.spots[index].fire;
        obj.setVisible(moving).setPosition(point[0]-p*22,point[1]-52-p*52).setDisplaySize(34+p*40,28+p*33).setAlpha(moving?Math.sin(p*Math.PI)*.28:0);
      });
    },
  };
}
