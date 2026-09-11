// 原创合成音效；不是电影配乐、现场录音或角色语音。
const noiseBuffers=new WeakMap();
function noise(context){
  if(!noiseBuffers.has(context)){
    const buffer=context.createBuffer(1,context.sampleRate*2,context.sampleRate),data=buffer.getChannelData(0);
    let seed=7321;for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed/2147483648-1;}
    noiseBuffers.set(context,buffer);
  }
  return noiseBuffers.get(context);
}

export function schedulePirateCue(context,output,kind,at=context.currentTime,register=()=>{}){
  const voices=[];
  function note(frequency,duration,volume,type='triangle',offset=0,end=frequency){
    const source=context.createOscillator(),gain=context.createGain(),start=at+offset;
    source.type=type;source.frequency.setValueAtTime(frequency,start);source.frequency.exponentialRampToValueAtTime(Math.max(10,end),start+duration);
    gain.gain.setValueAtTime(.0001,start);gain.gain.exponentialRampToValueAtTime(volume,start+.018);gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
    source.connect(gain).connect(output);source.start(start);source.stop(start+duration+.02);
    source.onended=()=>{source.disconnect();gain.disconnect();};voices.push(source);register(source);return source;
  }
  function burst(duration,volume,frequency,offset=0,type='lowpass'){
    const source=context.createBufferSource(),filter=context.createBiquadFilter(),gain=context.createGain(),start=at+offset;
    source.buffer=noise(context);filter.type=type;filter.frequency.value=frequency;filter.Q.value=.7;
    gain.gain.setValueAtTime(.0001,start);gain.gain.linearRampToValueAtTime(volume,start+.008);gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
    source.connect(filter).connect(gain).connect(output);source.start(start);source.stop(start+duration+.01);
    source.onended=()=>{source.disconnect();filter.disconnect();gain.disconnect();};voices.push(source);register(source);
  }
  function melody(notes,step,volume,type='triangle'){
    notes.forEach((n,i)=>{const f=440*2**((n-69)/12);note(f,step*.92,volume,type,i*step);note(f/2,step*.8,volume*.28,'sine',i*step);});
  }
  switch(kind){
    case 'cannon':burst(.65,.7,240);note(82,.4,.22,'sine',0,30);break;
    case 'splash':burst(.6,.3,1700);burst(.34,.12,3200,.1);break;
    case 'impact':burst(.16,.44,780);note(110,.22,.16,'triangle',0,42);break;
    case 'horn':note(146.83,1.3,.10,'sawtooth');note(220,1.3,.065,'triangle');break;
    case 'dispatch':melody([62,69,67,65,69,74],.16,.07);break;
    case 'coin':note(1568,.24,.10,'sine');note(2349,.19,.035,'sine',.03);break;
    case 'paper':burst(.32,.15,2100,0,'bandpass');burst(.22,.07,3200,.14,'bandpass');break;
    case 'bottle':note(610,.09,.13,'sine',0,240);note(1760,.3,.045,'sine',.1);break;
    case 'aggregate':melody([62,65,69,74,72,69,77,74],.19,.065);break;
    case 'victory':melody([74,77,81,79,77,86,81,74],.24,.055,'sine');break;
    case 'failure':melody([62,61,57,50],.35,.055);break;
    case 'waiting':note(392,.35,.055,'sine');note(440,.42,.035,'sine',.22);break;
    case 'drum':note(95,.18,.12,'sine',0,42);burst(.11,.12,330);break;
    case 'gull':note(1250,.32,.016,'sine',0,780);note(1120,.25,.013,'sine',.32,640);break;
    case 'creak':note(165,.65,.016,'sawtooth',0,105);break;
  }
  return voices;
}

export function createSceneAudio({contextFactory=()=>new (window.AudioContext||window.webkitAudioContext)()}={}){
  let context,master,sea,seaGain,disposed=false,muted=true,epoch=0,phase='idle',perform=false,nextBeat=0,nextAmbient=0,ambientIndex=0;
  const voices=new Set(),counts={};
  function clear(){
    for(const source of voices){try{source.stop();}catch{}}voices.clear();nextBeat=0;
  }
  function ready(){return !disposed&&!muted&&context?.state==='running';}
  function play(kind){
    if(!ready())return false;
    const sources=schedulePirateCue(context,master,kind,context.currentTime,source=>voices.add(source));
    for(const source of sources){const cleanup=source.onended;source.onended=()=>{voices.delete(source);cleanup?.();};}
    counts[kind]=(counts[kind]||0)+1;return true;
  }
  async function setMuted(value){
    muted=value;const ticket=++epoch;
    if(value){clear();if(master&&context)master.gain.setTargetAtTime(0,context.currentTime,.025);return false;}
    if(disposed)return false;
    try{
      if(!context){
        context=contextFactory();master=context.createGain();master.gain.value=0;
        const limiter=context.createDynamicsCompressor();limiter.threshold.value=-18;limiter.ratio.value=4;
        master.connect(limiter).connect(context.destination);
        sea=context.createBufferSource();sea.buffer=noise(context);sea.loop=true;
        const filter=context.createBiquadFilter();filter.type='lowpass';filter.frequency.value=520;
        seaGain=context.createGain();seaGain.gain.value=.065;
        sea.connect(filter).connect(seaGain).connect(master);sea.start();
      }
      if(context.state==='suspended')await context.resume();
      if(disposed||muted||ticket!==epoch)return false;
      master.gain.setTargetAtTime(.42,context.currentTime,.08);nextBeat=context.currentTime+.5;nextAmbient=context.currentTime+4;
      return ready();
    }catch{if(ticket===epoch&&!disposed){muted=true;clear();}}
    return false;
  }
  function sync(snapshot){
    const previous=phase,wasPerforming=perform;
    if(snapshot.initialize||snapshot.restoreWorld||snapshot.stop)clear();
    perform=snapshot.perform;
    phase=perform&&['waiting','failed'].includes(snapshot.phase)&&Object.values(snapshot.roleStages||{}).some(stage=>['commanding','working','returning'].includes(stage))?'working':snapshot.phase;
    if(snapshot.restoreWorld||snapshot.stop)return;
    // 新的公开事件只播放一次。短任务合批只提示实际终态，不补演整段战鼓。
    if(!snapshot.perform){
      if(previous!==phase||snapshot.initialize||wasPerforming){clear();if(phase==='complete')play('victory');else if(phase==='failed')play('failure');else if(['waiting','partial'].includes(phase))play('waiting');}
      return;
    }
    if(snapshot.events.some(e=>e.type==='status'&&e.stage==='commanding'))play('dispatch');
    if(previous!=='aggregating'&&phase==='aggregating')play('aggregate');
    if(snapshot.events.some(e=>e.type==='status'&&e.stage==='failed'))play('failure');
  }
  return {setMuted,play,sync,clear,
    update(){
      if(!ready())return;
      const now=context.currentTime;
      seaGain.gain.setTargetAtTime(.06+Math.sin(now*.7)*.013,now,.2);
      if(['commanding','working','returning','aggregating'].includes(phase)&&now>=nextBeat){play('drum');nextBeat=now+(phase==='aggregating'?.42:phase==='commanding'?.85:.64);}
      if(now>=nextAmbient){play(ambientIndex++%2?'gull':'creak');nextAmbient=now+10;}
    },
    status:()=>({muted,ready:ready(),phase,voices:voices.size,counts:{...counts}}),
    destroy(){disposed=true;epoch++;clear();try{sea?.stop();}catch{}context?.close().catch(()=>{});},
  };
}
