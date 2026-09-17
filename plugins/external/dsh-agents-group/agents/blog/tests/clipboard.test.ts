import test from 'node:test'
import assert from 'node:assert/strict'
import {transferredFiles,attachmentName} from '../web/clipboard.js'
test('clipboard images and copied files use file payloads once; plain text remains ordinary paste',()=>{
  const image=new File(['image'],'image.png',{type:'image/png'}),document=new File(['doc'],'notes.docx')
  assert.deepEqual(transferredFiles({files:[image,document],items:[{kind:'file',getAsFile:()=>image}]}),[image,document])
  assert.deepEqual(transferredFiles({items:[{kind:'string'},{kind:'file',getAsFile:()=>image},{kind:'file',getAsFile:()=>null}]}),[image])
  assert.deepEqual(transferredFiles({files:[],items:[{kind:'string'}]}),[])
  assert.deepEqual(transferredFiles(null),[])
  assert.equal(attachmentName(document),'notes.docx')
  assert.match(attachmentName(new File(['image'],'image',{type:'image/png'})),/\.png$/)
})
