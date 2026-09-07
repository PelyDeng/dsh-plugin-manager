import test from 'node:test'
import assert from 'node:assert/strict'
import {shouldSendChatEnter} from '../web/chat.js'

test('chat keyboard sends only desktop Enter and leaves mobile and multiline input untouched',()=>{
  const enter={key:'Enter',shiftKey:false,isComposing:false,keyCode:13}
  assert.equal(shouldSendChatEnter(enter),true)
  assert.equal(shouldSendChatEnter(enter,{touch:true}),false)
  assert.equal(shouldSendChatEnter({...enter,shiftKey:true}),false)
  assert.equal(shouldSendChatEnter({...enter,key:'a'}),false)
})

test('composition events and legacy IME key codes cannot send a chat message',()=>{
  const enter={key:'Enter',shiftKey:false,isComposing:false,keyCode:13}
  assert.equal(shouldSendChatEnter({...enter,isComposing:true}),false)
  assert.equal(shouldSendChatEnter({...enter,keyCode:229}),false)
  assert.equal(shouldSendChatEnter(enter,{composing:true}),false)
  assert.equal(shouldSendChatEnter(enter,{composing:false}),true)
})
