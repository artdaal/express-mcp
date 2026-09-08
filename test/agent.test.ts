import test from "node:test";
import assert from "node:assert/strict";
import { agentOperation, readInput } from "../src/agent.js";

test("agent pagination stays in the same caller and does not export unusable cursors", async () => {
  const requests: any[] = [];
  const result = await agentOperation({operation:"search-chats",query:"target",limit:1,pages:2}, async (name,args) => {
    requests.push({name,args:{...args}});
    return requests.length === 1 ? {ok:true,items:[{title:"Other"}],nextCursor:"caller-token",truncated:true} : {ok:true,items:[{title:"Target",chatId:"id"}],truncated:false};
  });
  assert.equal(requests[1].args.cursor,"caller-token");
  assert.equal(result.count,1); assert.equal(result.scanned,2); assert.equal(result.truncated,false);
  assert.equal(JSON.stringify(result).includes("caller-token"),false);
});
test("agent sends exact authorized text once and keeps confirmation private", async () => {
  const calls:any[]=[];
  const result=await agentOperation({operation:"send-message",chatId:"id",text:"Text $() `literal`",confirmed:true},async(name,args)=>{
    calls.push({name,args}); return name.includes("prepare") ? {ok:true,confirmationToken:"private-token"} : {ok:true,sent:true};
  });
  assert.equal(calls.length,2);assert.equal(calls[1].args.text,"Text $() `literal`");assert.equal(calls[1].args.confirmationToken,"private-token");assert.equal(JSON.stringify(result).includes("private-token"),false);
});
test("agent rejects sends without authorization flag before connecting",async()=>{
  let calls=0;
  await assert.rejects(agentOperation({operation:"send-message",chatId:"id",text:"hello"},async()=>{calls++;}),{code:"INVALID_INPUT"});
  assert.equal(calls,0);
});
test("agent never retries an ambiguous send",async()=>{
  const calls:string[]=[];
  await assert.rejects(agentOperation({operation:"send-message",chatId:"id",text:"hello",confirmed:true},async(name)=>{
    calls.push(name);if(name.includes("prepare"))return{ok:true,confirmationToken:"one-use"};throw new Error("SEND_OUTCOME_UNKNOWN");
  }),/SEND_OUTCOME_UNKNOWN/);
  assert.deepEqual(calls,["express_prepare_message","express_send_message"]);
});
test("agent enforces page and output bounds, retaining truncation",async()=>{
  await assert.rejects(agentOperation({operation:"list-chats",pages:21},async()=>{}),{code:"INVALID_INPUT"});
  const result=await agentOperation({operation:"read-chat",chatId:"id",pages:2},async()=>({ok:true,items:[{text:"x".repeat(160000)},{text:"y".repeat(160000)}],truncated:false}));
  assert.equal(result.items.length,1);assert.equal(result.truncated,true);assert.equal(result.stopped,"output_limit");
});
test("JSON stdin is bounded and malformed input rejected",async()=>{
  async function* source(value:string){yield Buffer.from(value);}
  await assert.rejects(readInput(4,source('{"x":5}')),{code:"INVALID_INPUT"});
  await assert.rejects(readInput(100,source('not JSON')),{code:"INVALID_INPUT"});
  assert.deepEqual(await readInput(100,source('{"operation":"status"}')),{operation:"status"});
});

test("agent attachment command binds source and self-only constraint without leaking confirmation",async()=>{
  const calls:any[]=[];
  const result=await agentOperation({operation:"send-attachment",chatId:"11111111-1111-4111-8111-111111111111",filePath:"/tmp/synthetic.txt",kind:"document",caption:"test",selfOnly:true,confirmed:true},async(name,args)=>{
    calls.push({name,args});return name.includes("prepare")?{ok:true,confirmationToken:"private",messageId:"synthetic-id"}:{ok:true,messageId:"synthetic-id"};
  });
  assert.equal(calls.length,2);assert.equal(calls[1].args.selfOnly,true);assert.equal(calls[1].args.filePath,"/tmp/synthetic.txt");assert.equal(JSON.stringify(result).includes("private"),false);
});
