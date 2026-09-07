export const element=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n}
export function glyph(name){const n=element('span',undefined,'qa-icon');n.setAttribute('aria-hidden','true');n.style.setProperty('--icon',`url("${document.body.dataset.base}/media/icon-${name}.svg")`);return n}
export function action(name,label,fn){const b=element('button',undefined,'qa-action');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.append(glyph(name));b.addEventListener('click',fn);return b}
export function stat(name,label,rows){const d=element('details',undefined,'qa-meta'),s=element('summary',undefined,'qa-stat');s.title=label;s.setAttribute('aria-label',label);s.append(glyph(name),element('span',label,'qa-stat-label'));const p=element('div',undefined,'qa-popover'),dl=element('dl');p.append(element('strong',label));for(const [k,v]of rows)dl.append(element('dt',k),element('dd',v===null||v===undefined?'未提供':String(v)));p.append(dl);d.append(s,p);return d}
export const compactTokens=n=>Number.isFinite(n)?n>=1000?(n/1000).toFixed(1)+'K':String(n):'—'
export function keyboardSend(event){return event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229&&!matchMedia('(pointer:coarse), (max-width:650px)').matches}

// Match the closed-off chat: current nonempty line while streaming, first line at rest.
export function reasoningLine(text,done=true){const lines=String(text??'').split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&line!=='正在生成…');return (done?lines[0]:lines.at(-1))??'正在生成…'}
export function thinking(text='',{className='',id,done=true}={}){
  const details=element('details',undefined,`qa-thinking ${className}`.trim()),summary=element('summary'),separator=element('span',undefined,'qa-thinking-sep');separator.setAttribute('aria-hidden','true')
  summary.append(glyph('think'),element('span','思考','qa-thinking-title'),separator,element('span',undefined,'qa-thinking-preview'))
  details.append(summary,element('div',undefined,'qa-thinking-body'));if(id)details.id=id;updateThinking(details,text,done);return details
}
export function updateThinking(details,text,done=true){
  const body=details.querySelector('.qa-thinking-body'),follow=body.scrollHeight-body.scrollTop-body.clientHeight<=24
  details.hidden=!text;details.classList.toggle('running',!done)
  details.querySelector('.qa-thinking-preview').textContent=reasoningLine(text,done);body.textContent=text
  if(details.open&&follow)body.scrollTop=body.scrollHeight
}
