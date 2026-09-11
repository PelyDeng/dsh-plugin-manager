// 船上的公开文字与雕像反馈；不从标题或模型内部内容猜测主题。
export function createShipDetails(scene,{figurehead,projection}={}){
  let statue,eye,caption;
  if(figurehead){
    statue=scene.add.image(figurehead.x,figurehead.y,figurehead.key,'__BASE').setOrigin(0).setDisplaySize(figurehead.size,figurehead.size).setDepth(100);
    eye=scene.add.image(figurehead.x,figurehead.y,figurehead.eye,'__BASE').setOrigin(0).setDisplaySize(figurehead.size,figurehead.size).setDepth(101).setAlpha(0);
    scene.ship.add([statue,eye]);scene.lit.push(statue);
  }
  if(projection){
    caption=scene.add.text(projection.x,projection.y,'',{
      fontFamily:'Microsoft YaHei, sans-serif',fontSize:projection.fontSize+'px',color:'#ecd9a6',align:'center',lineSpacing:2,
      shadow:{offsetX:0,offsetY:0,color:'#d8bc73',blur:3,fill:true},resolution:2,
    }).setOrigin(.5).setAngle(projection.angle).setDepth(102).setAlpha(.78).setVisible(false);
    scene.ship.add(caption);
  }
  return {statue,eye,caption,complete:false,live:false,elapsed:0,topic:'',
    sync(snapshot){
      const completed=!snapshot.stop&&snapshot.mission?.state==='completed';
      if(!completed){this.live=false;this.elapsed=0;}
      else if(!this.complete||snapshot.initialize||snapshot.restoreWorld){this.live=!snapshot.restoreWorld;this.elapsed=0;}
      this.complete=completed;
      this.topic=snapshot.topic||'';
      if(caption){
        const text=this.topic.split(' · ').join('\n');
        if(caption.text!==text)caption.setText(text);
        caption.setVisible(Boolean(text));
      }
    },
    update(delta,reduced){
      if(reduced)this.live=false;
      if(this.live){this.elapsed+=Math.min(50,Math.max(0,delta));if(this.elapsed>=1800)this.live=false;}
      eye?.setAlpha(!this.complete?0:this.live?.3+.7*Math.sin(Math.PI*this.elapsed/900)**2:.3);
    },
  };
}
