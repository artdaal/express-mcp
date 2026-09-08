import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {AuthManager} from "../src/session/auth.js";
import {SessionHttp} from "../src/session/http.js";
import {SessionSocket} from "../src/session/socket.js";
import {DirectClient, DirectAdapter} from "../src/session/direct.js";
import {DEFAULT_CONFIG} from "../src/session/types.js";
import {CursorStore} from "../src/cursors.js";
import {decryptMessage, encryptMessage, type WireMessage} from "../src/session/crypto.js";
import {fixture,MemoryStore} from "./session-fixtures.js";

test("threads verify parent, paginate encrypted history, attribute senders and remain read-only", async () => {
  const own={...fixture(Date.now()),refreshAt:null,expiresAt:null};
  const peer=fixture(Date.now());
  const parent=randomUUID(),otherParent=randomUUID(),thread=randomUUID(),otherThread=randomUUID();
  const keys=[own,peer].flatMap(b=>[{id:b.ctsKey.id,body:b.ctsKey.public,kind:"cts",user_huid:b.accountId},{id:b.signing.id,body:b.signing.public,kind:"ed25519",user_huid:b.accountId}]);
  const events:WireMessage[]=[];
  for(const [sender,body] of [[own,"new self"],[peer,"peer reply"],[own,"old self"]] as const){
    const msg=await encryptMessage(thread,body,sender,[keys[0]!]);
    events.push({...msg,key:msg.keys[0]!,sender:sender.accountId,sender_key_id:sender.ctsKey.id,event_type:"message_new"});
  }
  const auth=new AuthManager(new MemoryStore(own),async()=>({kind:"temporary",code:"UNUSED"}));
  const socket=new SessionSocket(DEFAULT_CONFIG,auth);socket.ensure=async()=>{};
  let wrongList=false,wrongEvent=false,historyCalls=0;
  socket.request=async(topic,event,payload:any)=>{
    if(event==="chat_list") return {chat_list:[parent,otherParent].map(group_chat_id=>({group_chat_id,chat_type:"group_chat",name:"Synthetic group"}))};
    if(event==="thread_list") {assert.equal(payload.request_version,2);assert.equal(payload.limit,2);return{thread_list:[thread,otherThread].map(thread_id=>({thread_id,group_chat_id:wrongList?otherParent:parent}))};}
    if(event==="thread_info") return {thread_info:{thread_id:payload.thread_id,group_chat_id:parent}};
    if(event==="subscribe_to_chat_activities") return {};
    assert.equal(event,"events_history");assert.equal(topic,`groupchat:${thread}`);historyCalls++;
    if(wrongEvent) return{history:[{...events[0],group_chat_id:otherThread}]};
    const start=payload.sync_id?events.findIndex(e=>e.sync_id===payload.sync_id):0;
    return{history:events.slice(start,start+payload.limit)};
  };
  const serviceOwner=randomUUID();
  const restKeys=keys.map(k=>k.kind==="cts"?{...k,kind:"rest",user_huid:serviceOwner}:k);
  const http=new SessionHttp(DEFAULT_CONFIG,async()=>new Response(JSON.stringify({result:restKeys})));
  const client=new DirectClient(auth,http,socket),adapter=new DirectAdapter(client);
  const cursors=new CursorStore();
  try{
    await assert.rejects(decryptMessage(events[0]!,own.ctsKey,restKeys.map(k=>k.id===own.signing.id?{...k,user_huid:peer.accountId}:k)),/CRYPTO_SIGNATURE_INVALID/);
    await assert.rejects(decryptMessage(events[0]!,own.ctsKey,keys.map(k=>k.id===own.ctsKey.id?{...k,user_huid:peer.accountId}:k)),/CRYPTO_KEY_MISSING/);
    const {signature: _signature,...unsigned}=events[0]!;
    await assert.rejects(decryptMessage(unsigned,own.ctsKey,restKeys),/CRYPTO_SIGNATURE_INVALID/);
    await assert.rejects(decryptMessage({...events[0]!,payload:events[1]!.payload},own.ctsKey,restKeys),/CRYPTO_SIGNATURE_INVALID/);
    const list=await adapter.listThreads(parent,1);
    assert.equal(list.count,1);assert.equal(list.items[0]?.threadId,thread);assert.equal(list.items[0]?.parentChatId,parent);assert.equal(list.truncated,true);assert.equal(list.nextCursor,undefined);
    const first=await adapter.readThreadPage(parent,thread,{limit:1},cursors);
    assert.equal(first.items[0]?.text,"new self");assert.equal(first.items[0]?.senderId,own.accountId);assert.equal(first.items[0]?.isSelf,true);assert.ok(first.nextCursor);
    const second=await adapter.readThreadPage(parent,thread,{limit:1,cursor:first.nextCursor!},cursors);
    assert.equal(second.items[0]?.text,"peer reply");assert.equal(second.items[0]?.senderId,peer.accountId);assert.equal(second.items[0]?.isSelf,false);
    const before=historyCalls;
    await assert.rejects(adapter.readThreadPage(otherParent,thread,{limit:1},cursors),/opaque chat reference/);
    await assert.rejects(adapter.readThreadPage(parent,otherThread,{limit:1,cursor:first.nextCursor!},cursors),/cursor/);
    await assert.rejects(adapter.readThreadPage(parent,thread,{limit:1,cursor:first.nextCursor!},new CursorStore()),/cursor/);
    await assert.rejects(adapter.validateChatTarget(thread),/opaque chat reference/);
    assert.equal(historyCalls,before);
    wrongList=true;await assert.rejects(adapter.listThreads(parent,1),/UNSUPPORTED_PROTOCOL/);
    wrongEvent=true;await assert.rejects(adapter.readThreadPage(parent,thread,{limit:1},cursors),/UNSUPPORTED_PROTOCOL/);
  }finally{client.close();socket.close();await auth.close();}
});
