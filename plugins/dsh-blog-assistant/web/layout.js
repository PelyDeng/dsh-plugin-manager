import {icon} from './icons.js'
import {glyph} from './chat-ui.js'

/** Keep one set of live controls: narrow layouts move panels into native dialogs. */
export function initLayout(){
  const $=id=>document.getElementById(id),mobile=matchMedia('(max-width:760px)'),compact=matchMedia('(max-width:1000px)')
  for(const el of document.querySelectorAll('[data-icon]'))el.prepend(icon(el.dataset.icon))
  for(const [id,name] of [['chat-send','send'],['chat-stop','stop']])$(id).replaceChildren(glyph(name))
  for(const dialog of document.querySelectorAll('dialog')){const heading=dialog.querySelector('h2');if(heading){heading.id||=dialog.id+'-heading';dialog.setAttribute('aria-labelledby',heading.id)}}
  const panels=new Map()
  for(const id of ['library','assistant']){const el=$(id),anchor=document.createComment(id);el.before(anchor);panels.set(id,{el,anchor})}
  function restore(dialog){for(const {el,anchor} of panels.values())if(el.parentElement===dialog)anchor.after(el)}
  function openPanel(id,dialogId,title){const dialog=$(dialogId);restore(dialog);dialog.append(panels.get(id).el);if(title)$('navigation-title').textContent=title;dialog.showModal()}
  function closeNavigation(){if($('navigation-dialog').open)$('navigation-dialog').close()}
  function library(){openPanel('library','navigation-dialog','文章库');$('search').focus()}
  for(const id of ['navigation-dialog','assistant-dialog']){
    const dialog=$(id);dialog.addEventListener('close',()=>restore(dialog))
    dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close()}})
  }
  $('library-toggle').addEventListener('click',library)
  $('empty-library').addEventListener('click',library)
  $('quick-new').addEventListener('click',()=>{$('chat-view').click();window.dispatchEvent(new Event('blog:new-conversation'))})
  $('manage-open').addEventListener('click',()=>$('management-dialog').showModal())
  $('backup-open').addEventListener('click',()=>$('management-dialog').close())
  $('mode-ai').addEventListener('click',()=>{if(compact.matches)openPanel('assistant','assistant-dialog')})
  $('mode-manual').addEventListener('click',()=>{if($('assistant-dialog').open)$('assistant-dialog').close()})
  $('metadata-open').addEventListener('click',()=>$('metadata-dialog').showModal())
  $('operations-open').addEventListener('click',()=>$('operations-dialog').showModal())
  const assistantTabs=[...document.querySelectorAll('[data-assistant-tab]')]
  function assistantTab(name){for(const b of assistantTabs){const active=b.dataset.assistantTab===name;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;$(b.getAttribute('aria-controls')).hidden=!active}}
  for(const [i,b]of assistantTabs.entries()){
    b.addEventListener('click',()=>assistantTab(b.dataset.assistantTab))
    b.addEventListener('keydown',event=>{const index=event.key==='Home'?0:event.key==='End'?assistantTabs.length-1:event.key==='ArrowRight'?(i+1)%assistantTabs.length:event.key==='ArrowLeft'?(i-1+assistantTabs.length)%assistantTabs.length:-1;if(index<0)return;event.preventDefault();assistantTabs[index].click();assistantTabs[index].focus()})
  }
  window.addEventListener('blog:assistant-tab',event=>assistantTab(event.detail))
  for(const button of document.querySelectorAll('[data-instruction]'))button.addEventListener('click',()=>{const input=$('instruction');input.setRangeText(button.dataset.instruction,input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input'));input.focus()})
  $('ask').disabled=true
  window.addEventListener('blog:conversation',closeNavigation)
  window.addEventListener('blog:draft',closeNavigation)
  window.addEventListener('blog:view',({detail})=>{
    closeNavigation()
  })
  const area=$('chat-input')
  function resizeComposer(){area.style.height='auto';area.style.height=Math.min(area.scrollHeight,mobile.matches?110:144)+'px'}
  area.addEventListener('input',resizeComposer)
  window.addEventListener('blog:conversation',resizeComposer)
  const resizeObserver=new ResizeObserver(()=>{const h=$('chat-form').getBoundingClientRect().height;$('chat-bottom').style.bottom=(h+26)+'px'})
  resizeObserver.observe($('chat-form'))
  let maxHeight=innerHeight
  function revealEditorField(){
    const field=document.activeElement
    if(!mobile.matches||!field?.matches('input:not([type=checkbox]),textarea,select'))return
    const dialog=field.closest('dialog[open]')
    if(dialog){const r=field.getBoundingClientRect(),frame=dialog.getBoundingClientRect(),top=frame.top+12,bottom=Math.min(frame.bottom,window.visualViewport?.height??innerHeight)-20;if(r.bottom>bottom||r.top<top)field.scrollIntoView({block:'nearest',behavior:'instant'});return}
    if(!field.matches('.title-input'))return
    const container=document.querySelector('.writing'),r=field.getBoundingClientRect(),frame=container.getBoundingClientRect(),footer=document.querySelector('.editor-footer').getBoundingClientRect()
    const toolbar=document.querySelector('.formatbar').getBoundingClientRect()
    const top=field.matches('.title-input')?frame.top+12:Math.max(frame.top+12,toolbar.bottom+12),bottom=footer.top-16
    const fieldTop=field.closest('label')?.getBoundingClientRect().top??r.top
    let delta=Math.max(0,r.bottom-bottom)
    if(fieldTop-delta<top)delta=fieldTop-top
    container.scrollTop+=delta
  }
  function viewport(){
    const v=window.visualViewport,editing=document.activeElement?.matches('input:not([type=checkbox]),textarea,[contenteditable=true]')
    if(!editing)maxHeight=innerHeight
    const height=v?.scale===1?v.height:innerHeight
    const keyboard=mobile.matches&&editing&&maxHeight-height>120
    document.body.classList.toggle('keyboard-open',!!keyboard)
    document.documentElement.style.setProperty('--app-height',height+'px')
    document.documentElement.style.setProperty('--app-top',mobile.matches&&v?.scale===1?v.offsetTop+'px':'0px')
    requestAnimationFrame(revealEditorField)
  }
  window.visualViewport?.addEventListener('resize',viewport)
  window.visualViewport?.addEventListener('scroll',viewport)
  window.addEventListener('resize',()=>{viewport();resizeComposer()})
  document.addEventListener('focusin',viewport);document.addEventListener('focusout',()=>requestAnimationFrame(viewport))
  mobile.addEventListener('change',()=>{closeNavigation();if(mobile.matches&&$('document').classList.contains('split'))document.querySelector('[data-view=source]').click()})
  compact.addEventListener('change',()=>{if(!compact.matches&&$('assistant-dialog').open)$('assistant-dialog').close()})
  document.querySelector('[data-view=source]').click()
  viewport();resizeComposer()
}
