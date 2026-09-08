/* Shared chat selector. Copy with the plugin assets; no Auth frontend dependency. */
globalThis.createModelPicker = function ({mount,load,iconBase,onChange=()=>{}}) {
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
  if(!document.getElementById('chat-model-picker-style')){
    const style=el('style');style.id='chat-model-picker-style';style.textContent=`
      .input-box #model-picker{display:flex;justify-content:flex-end;margin-top:6px}
      .model-picker{display:inline-flex;position:relative;min-width:0;max-width:100%}
      .model-picker-trigger{display:flex!important;align-items:center;gap:7px;border:0!important;border-radius:999px!important;background:#f1f1f1!important;color:#333!important;padding:6px 11px!important;min-height:34px;font:inherit;font-size:14px!important;max-width:min(240px,55vw);cursor:pointer}
      .model-picker-trigger span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.model-picker-trigger img{width:14px;height:14px;flex-shrink:0}.model-picker-trigger:disabled{opacity:.5;cursor:wait}
      .model-picker-menu{position:fixed;z-index:10000;box-sizing:border-box;width:318px;max-width:calc(100vw - 24px);max-height:min(420px,70vh);overflow:auto;overscroll-behavior:contain;background:#fff;border:1px solid #e5e5e5;border-radius:20px;padding:7px;box-shadow:0 8px 28px #00000014;color:#242424;font:14px/1.45 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif}
      .model-picker-menu[hidden]{display:none!important}.model-picker-heading{color:#929292;padding:5px 7px 9px;font-size:14px}
      .model-picker-option{box-sizing:border-box;display:flex!important;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:36px;padding:8px!important;border:0!important;border-radius:12px!important;background:transparent!important;color:#242424!important;text-align:left!important;font:inherit!important;cursor:pointer}
      .model-picker-option:hover,.model-picker-option:focus-visible{background:#f1f1f1!important;outline:none}.model-picker-option small{display:block;color:#8d8d8d;font-size:13px;margin-top:2px}.model-picker-option img{width:16px;height:16px;flex-shrink:0}.model-picker-option span{overflow-wrap:anywhere}.model-picker-note{font-size:12px;color:#777;padding:8px;line-height:1.5}.model-picker-trigger:focus-visible{outline:2px solid #777;outline-offset:2px}
      @media(max-width:650px){.model-picker-trigger{font-size:13px!important;min-height:36px}.model-picker-option{min-height:42px}}
    `;document.head.append(style)
  }
  const root=el('div',undefined,'model-picker'),trigger=el('button',undefined,'model-picker-trigger'),label=el('span','正在加载模型…'),arrow=el('img'),menu=el('div',undefined,'model-picker-menu')
  trigger.type='button';trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-label','选择模型');arrow.src=iconBase+'icon-chevron-down.svg';arrow.alt='';trigger.append(label,arrow)
  menu.id='model-menu-'+crypto.randomUUID();trigger.setAttribute('aria-controls',menu.id);menu.role='menu';menu.setAttribute('aria-label','选择模型');menu.hidden=true;document.body.append(menu);root.append(trigger);mount.append(root)
  let catalog,selected=null,dirty=false,ready=false,busy=false,epoch=0,errorText='',contextId
  const same=(a,b)=>a?.provider===b?.provider&&a?.model===b?.model
  const name=value=>catalog?.groups.find(g=>g.id===value?.provider)?.models.find(m=>m.id===value?.model)?.name??value?.model??'未配置'
  function close(focus=false){menu.hidden=true;trigger.setAttribute('aria-expanded','false');if(focus)trigger.focus()}
  function update(){label.textContent=ready?(selected?name(selected):'默认 · '+name(catalog.default)):errorText?'模型加载失败':'正在加载模型…';trigger.title=errorText||label.textContent;trigger.disabled=busy}
  function choose(value){selected=value;dirty=true;update();close(true);onChange(value)}
  function row(value,title,detail){const button=el('button',undefined,'model-picker-option'),text=el('span',title);button.type='button';button.role='menuitemradio';button.setAttribute('aria-checked',String(value===null?selected===null:same(value,selected)));if(detail)text.append(el('small',detail));button.append(text);if(value===null?selected===null:same(value,selected)){const check=el('img');check.src=iconBase+'icon-check.svg';check.alt='';button.append(check)}button.onclick=()=>choose(value);menu.append(button)}
  function render(){menu.replaceChildren(el('div','选择模型','model-picker-heading'));if(!ready){menu.append(el('div',errorText||'正在加载…','model-picker-note'));const retry=el('button','重新加载','model-picker-option');retry.type='button';retry.onclick=async()=>{await refresh(contextId,false);render();position()};menu.append(retry);return}
    row(null,'默认',name(catalog.default));for(const group of catalog.groups)for(const model of group.models)row({provider:group.id,model:model.id},model.name,catalog.groups.length>1?group.name:undefined)
    if(selected&&!catalog.groups.some(g=>g.id===selected.provider&&g.models.some(m=>m.id===selected.model)))menu.append(el('div','原模型已不在目录中，请重新选择。','model-picker-note'))
    if(catalog.failures.length)menu.append(el('div','部分服务商目录暂时不可用，可关闭后重新打开刷新。','model-picker-note'))
    menu.append(el('div','发送下一条消息时生效，并同步更新 Auth 默认模型。','model-picker-note'))
  }
  function position(){const rect=trigger.getBoundingClientRect();menu.style.left=Math.max(12,Math.min(rect.right-menu.offsetWidth,innerWidth-menu.offsetWidth-12))+'px';menu.style.top=Math.max(12,rect.top-menu.offsetHeight-8)+'px'}
  async function refresh(id,reset=true){contextId=id;const version=++epoch;if(reset){ready=false;selected=null;dirty=false;errorText='';close();update()}try{const value=await load(id);if(version!==epoch)return;catalog=value;ready=true;errorText='';if(reset){selected=value.selected;dirty=!id}update()}catch(e){if(version!==epoch)return;ready=false;errorText=e.message;update()}}
  trigger.onclick=async()=>{if(!menu.hidden){close();return}render();menu.hidden=false;trigger.setAttribute('aria-expanded','true');position();(menu.querySelector('[aria-checked="true"]')??menu.querySelector('button'))?.focus();await refresh(contextId,false);if(!menu.hidden){render();position();(menu.querySelector('[aria-checked="true"]')??menu.querySelector('button'))?.focus()}}
  menu.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();close(true)}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const rows=[...menu.querySelectorAll('button')],i=rows.indexOf(document.activeElement);rows[event.key==='Home'?0:event.key==='End'?rows.length-1:(i+(event.key==='ArrowDown'?1:-1)+rows.length)%rows.length]?.focus()}else if(event.key==='Tab')close()}
  document.addEventListener('pointerdown',e=>{if(!root.contains(e.target)&&!menu.contains(e.target))close()});window.addEventListener('resize',()=>close());document.addEventListener('scroll',e=>{if(!menu.contains(e.target))close()},true)
  return {refresh,setBusy(value){busy=!!value;if(busy)close();update()},payload(){if(!ready)throw Error(errorText||'模型目录正在加载，请稍后发送');return dirty?{modelSelection:selected}:{}},accept(value){if(value){selected=value;dirty=false;update()}},get value(){return selected}}
}
