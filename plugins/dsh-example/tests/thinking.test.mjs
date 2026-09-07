import {describe,it,expect} from 'vitest'
import {reasoningLine} from '../web/chat-ui.js'

describe('折叠思考预览',()=>{
  it('生成显示当前行，完成和历史显示首行，忽略占位与空白',()=>{
    const text='正在生成…\r\n\n  先查证当前日期。\n\n 再读取文章。  '
    expect(reasoningLine(text,false)).toBe('再读取文章。')
    expect(reasoningLine(text,true)).toBe('先查证当前日期。')
    expect(reasoningLine(' \n')).toBe('正在生成…')
  })
  it('保留模型原文和代码标识，不在前端伪造中文翻译',()=>{
    expect(reasoningLine('检查 blog_list_drafts <result>')).toBe('检查 blog_list_drafts <result>')
  })
})
