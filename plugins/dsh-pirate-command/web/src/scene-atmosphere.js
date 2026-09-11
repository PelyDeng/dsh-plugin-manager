// 天气只跟随后端公开阶段；等待处理和部分完成不使用胜利月夜。
export function weatherForPhase(phase) {
  if (phase === 'complete') return { name: 'moon', storm: 0, moon: 1, damage: 0 };
  if (phase === 'failed') return { name: 'failed', storm: 1, moon: 0, damage: 1 };
  if (['commanding', 'working', 'returning', 'aggregating'].includes(phase)) return { name: 'storm', storm: 1, moon: 0, damage: 0 };
  if (['thinking', 'waiting', 'partial', 'stopping'].includes(phase)) return { name: 'overcast', storm: .55, moon: 0, damage: 0 };
  return { name: 'day', storm: 0, moon: 0, damage: 0 };
}

export function stepAtmosphere(current, target, delta, immediate = false) {
  const amount = immediate ? 1 : 1 - Math.exp(-Math.max(0, delta) / 900);
  const next = { name: target.name };
  for (const key of ['storm', 'moon', 'damage']) {
    next[key] = current[key] + (target[key] - current[key]) * amount;
    if (Math.abs(next[key] - target[key]) < .002) next[key] = target[key];
  }
  // 三层按 source-over 合成，使晴天、风暴、月夜的实际权重之和为 1。
  next.stormAlpha = next.moon >= 1 ? 0 : next.storm / (1 - next.moon);
  const rgb = [255, 255, 255].map((value, index) => Math.round(value
    + ( [187, 205, 223][index] - value) * next.storm
    + ( [160, 190, 234][index] - value) * next.moon
    + ( [18, -32, -39][index]) * next.damage));
  next.tint = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  return next;
}

export function createSeaLayer(scene, key) {
  const container = scene.add.container(), texture = scene.textures.get(key);
  const { width, height } = texture.getSourceImage(), bands = [];
  // 帧彼此不重复覆盖，透明叠化时不会让波带比背景更亮。
  for (let y = 0; y < height;) {
    const size = y === 0 ? Math.min(155, height) : Math.min(14, height - y);
    const frame = 'sea-band-' + y;
    texture.add(frame, 0, 0, y, width, size);
    const image = scene.add.image(0, y, key, frame).setOrigin(0);
    container.add(image); bands.push({ image, y, height: size }); y += size;
  }
  return { key, container, bands, width, height };
}

export function createReflection(scene, parent, key, width, height, waterline) {
  const texture = scene.textures.get(key), source = texture.getSourceImage();
  const container = scene.add.container(0, waterline), bands = [];
  parent.add(container);
  // 使用船图或已合成的透明轮廓；水平分带翻转与位移产生水面折射。
  for (let index = 0; index < 24; index++) {
    const bottom = Math.round(source.height * (1 - index / 24));
    const top = Math.round(source.height * (1 - (index + 1) / 24));
    const frame = 'reflection-' + index;
    texture.add(frame, 0, 0, top, source.width, bottom - top);
    const y = Math.round(height * index / 24), nextY = Math.round(height * (index + 1) / 24);
    const image = scene.add.image(0, y, key, frame).setOrigin(0).setFlipY(true)
      .setDisplaySize(width, nextY - y).setAlpha(.48 * (1 - index / 24) ** 1.4).setTint(0x7595b0);
    container.add(image); bands.push(image);
  }
  return { container, bands };
}

export function rippleReflection(reflection, time, reduced, tint = 0xffffff) {
  if (reflection.tint !== tint) {
    reflection.tint = tint;
    const waterTint = (Math.round((tint >> 16 & 255) * 0x75 / 255) << 16)
      | (Math.round((tint >> 8 & 255) * 0x95 / 255) << 8) | Math.round((tint & 255) * 0xb0 / 255);
    reflection.bands.forEach(band => band.setTint(waterTint));
  }
  reflection.bands.forEach((band, index) => {
    band.x = reduced ? 0 : Math.sin(time * 1.5 - index * .72) * (1 + index * .25);
  });
}

export function createStormEffects(scene, images) {
  // 闪电位于海天之上、船只之后；雨线用固定数量的透明图组覆盖场景。
  const sky=scene.add.container(), rain=scene.add.container().setDepth(10);
  const bolt=images['weather-lightning']?scene.add.image(0,0,'weather-lightning','__BASE').setBlendMode('ADD').setAlpha(0):null;
  if(bolt)sky.add(bolt);
  const drops=images['weather-rain']?Array.from({length:18},()=>scene.add.image(0,0,'weather-rain','__BASE').setAlpha(0)):[];
  rain.add(drops);
  return {sky,rain,bolt,drops,time:0,elapsed:0,flash:0,sequence:0,allowFlash:false};
}

export function resetStormEffects(effects) {
  effects.time=0;effects.elapsed=0;effects.flash=0;effects.allowFlash=false;
  effects.bolt?.setAlpha(0);effects.rain.setVisible(false);
}

export function updateStormEffects(effects, {width,height,delta,phase,storm,active,reduced}) {
  const wet=!reduced&&(['commanding','working','returning','aggregating','failed'].includes(phase));
  effects.rain.setVisible(wet);
  const size=Math.max(144,Math.min(280,width*.2));
  if(wet)effects.time+=Math.min(50,Math.max(0,delta));
  effects.drops.forEach((drop,index)=>{
    const speed=130+(index%4)*18, travel=effects.time/1000*speed;
    const y=(height+size)*((index*.61803398875+travel/(height+size))%1)-size/2;
    const across=index*.38196601125-travel*.268/(width+size);
    const x=((across%1+1)%1)*(width+size)-size/2;
    drop.setPosition(x,y).setDisplaySize(size,size).setAlpha(wet?storm*(.18+(index%3)*.035):0);
  });
  // 只在新的实时战斗中低频闪现；历史恢复、终态和减少动态不补播。
  const flashing=wet&&active&&effects.allowFlash&&effects.bolt;
  if(!flashing){effects.elapsed=0;effects.flash=0;effects.bolt?.setAlpha(0);return;}
  effects.elapsed+=Math.min(50,Math.max(0,delta));
  if(effects.elapsed>=9000){
    effects.elapsed=0;effects.flash=400;
    const x=[.18,.35,.78][effects.sequence++%3]*width;
    const edge=Math.min(132,height*.12);
    effects.bolt.setPosition(x,height*.064).setDisplaySize(edge,edge);
  }
  if(effects.flash>0){
    effects.flash=Math.max(0,effects.flash-Math.max(0,delta));
    effects.bolt.setAlpha(Math.sin(Math.PI*(1-effects.flash/400))*.7*storm);
  }else effects.bolt.setAlpha(0);
}
