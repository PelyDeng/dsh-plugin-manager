import {describe,it,expect} from 'vitest'
import {reasoningLine} from '../web/chat-ui.js'
import {needsChineseTranslation} from '../web/thinking-translation.js'

describe('中文译文触发边界',()=>{
  it.each([
    ['aaaa bbbb cccc ddd',false],
    ['aaaa bbbb cccc dddd',true],
    ['aaaa bbbb cccccccc',false],
    ['一二三四五六七八 aaaa bbbb cccc dddd',false],
    ['一二三四五六七 aaaa bbbb cccc dddd',true],
    ['请看 `aaaa bbbb cccc dddd` 和 https://example.test/aaaa-bbbb-cccc-dddd',false],
    ['```text\naaaa bbbb cccc dddd\n```',false],
    ['',false],
  ])('%s → %s',(text,expected)=>expect(needsChineseTranslation(text)).toBe(expected))
})

describe('折叠思考预览',()=>{
  it('生成、完成和历史始终显示最新行，忽略占位与空白',()=>{
    const text='正在生成…\r\n\n  先查证当前日期。\n\n 再读取文章。  '
    expect(reasoningLine(text,false)).toBe('再读取文章。')
    expect(reasoningLine(text,true)).toBe('再读取文章。')
    expect(reasoningLine(' \n')).toBe('正在生成…')
  })
  it('保留模型原文和代码标识，不在前端伪造中文翻译',()=>{
    expect(reasoningLine('检查 blog_list_drafts <result>')).toBe('检查 blog_list_drafts <result>')
  })
})
