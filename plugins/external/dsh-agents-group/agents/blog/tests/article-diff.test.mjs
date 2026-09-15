import test from 'node:test'
import assert from 'node:assert/strict'
import {articleDiff} from '../web/article-diff.js'

test('article comparison retains both texts including separate edits, additions and removals',()=>{
  for(const [before,after] of [['甲\n旧段\n中间\n删除\n结尾','甲\n新段\n中间\n结尾'],['','新增'],['删除',''],['相同','相同'],['重复\n重复\n尾','重复\n尾\n新增'],[Array(1100).fill('旧').join('\n'),Array(1100).fill('新').join('\n')]]){
    const rows=articleDiff(before,after)
    assert.equal(rows.filter(r=>r.kind!=='added').flatMap(r=>r.lines).join('\n'),before)
    assert.equal(rows.filter(r=>r.kind!=='removed').flatMap(r=>r.lines).join('\n'),after)
  }
  assert.deepEqual(articleDiff('开头\n旧段\n中间\n删除\n结尾','开头\n新段\n中间\n结尾').map(r=>r.kind),['same','removed','added','same','removed','same'])
})
