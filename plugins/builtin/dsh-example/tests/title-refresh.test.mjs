import {afterEach,expect,test,vi} from 'vitest'
import {createConversationTitleRefresh} from '../web/conversation-history.js'

afterEach(()=>vi.useRealTimers())

function setup(source='automatic'){
  vi.useFakeTimers()
  let current='new',items=[{id:'new',title:'首句摘要',titleSource:source}]
  const shown=[]
  const refresh=vi.fn(async()=>{shown.push(items.map(item=>item.title));watch.observe(items)})
  const watch=createConversationTitleRefresh({currentId:()=>current,refresh})
  return{watch,refresh,shown,setCurrent(value){current=value},setItems(value){items=value}}
}

test('首次 session 立即刷新，回答结束后的延迟标题通过原列表刷新出现',async()=>{
  const f=setup()
  f.watch.start('new')
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(f.shown.at(-1)).toEqual(['首句摘要'])
  await vi.advanceTimersByTimeAsync(1999)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.refresh).toHaveBeenCalledTimes(2)
  // No live stream is needed once the host publishes the generated title.
  f.setItems([{id:'new',title:'生成后的标题',titleSource:'generated'}])
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.shown.at(-1)).toEqual(['生成后的标题'])
  await vi.advanceTimersByTimeAsync(65000)
  expect(f.refresh).toHaveBeenCalledTimes(3)
})

test.each(['generated','manual',undefined])('首个列表来源为 %s 时不轮询',async source=>{
  const f=setup()
  f.setItems([{id:'new',titleSource:source}])
  f.watch.start('new')
  await vi.advanceTimersByTimeAsync(70000)
  expect(f.refresh).toHaveBeenCalledTimes(1)
})

test('当前会话不在列表结果中时停止，不按其他会话的来源继续刷新',async()=>{
  const f=setup()
  f.watch.start('new')
  f.setItems([{id:'other',titleSource:'automatic'}])
  await vi.advanceTimersByTimeAsync(70000)
  expect(f.refresh).toHaveBeenCalledTimes(2)
})

test('automatic 最多追踪 65 秒，之后的列表结果也不能重启',async()=>{
  const f=setup()
  f.watch.start('new')
  await vi.advanceTimersByTimeAsync(65000)
  expect(f.refresh).toHaveBeenCalledTimes(33)
  expect(vi.getTimerCount()).toBe(0)
  f.watch.observe([{id:'new',titleSource:'automatic'}])
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.refresh).toHaveBeenCalledTimes(33)
})

test('切换会话或新建会话后，旧会话的计时器和迟到结果均不再刷新',async()=>{
  const f=setup()
  f.watch.start('new')
  f.setCurrent('other')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  f.watch.observe([{id:'new',titleSource:'automatic'}])
  f.setCurrent('next');f.setItems([{id:'next',titleSource:'automatic'}])
  f.watch.start('next')
  f.watch.stop();f.setCurrent(undefined)
  f.watch.observe([{id:'next',titleSource:'automatic'}])
  await vi.advanceTimersByTimeAsync(65000)
  expect(f.refresh).toHaveBeenCalledTimes(2)
})

test.each(['generated','manual'])('当前 %s 标题事件立即刷新并阻止旧 automatic 结果重启轮询',async titleSource=>{
  const f=setup()
  f.watch.start('new')
  f.watch.title({type:'title',conversationId:'other',title:'其他标题',titleSource})
  expect(f.refresh).toHaveBeenCalledTimes(1)
  f.watch.title({type:'title',conversationId:'new',title:'新标题',titleSource})
  expect(f.refresh).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(65000)
  expect(f.refresh).toHaveBeenCalledTimes(2)
})

test('手动重命名成功后的停止不会被正在返回的列表请求重新启动',async()=>{
  vi.useFakeTimers()
  let finish
  const refresh=vi.fn(()=>new Promise(resolve=>{finish=()=>{watch.observe([{id:'new',titleSource:'automatic'}]);resolve()}}))
  const watch=createConversationTitleRefresh({currentId:()=> 'new',refresh})
  watch.start('new');watch.stop();finish()
  await vi.advanceTimersByTimeAsync(65000)
  expect(refresh).toHaveBeenCalledTimes(1)
})
