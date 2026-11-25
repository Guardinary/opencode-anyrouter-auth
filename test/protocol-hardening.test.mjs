import test from "node:test";
import assert from "node:assert/strict";
import { prepareAnthropicRequest, prepareCodexRequest, prepareRequest } from "../lib/request.mjs";
import { explainResponse } from "../lib/response.mjs";
import { createProvider } from "../lib/provider.mjs";
const url="https://anyrouter.top/v1/responses";
const frame=(value)=>`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const failure={type:"error",error:{type:"overloaded_error",message:"synthetic busy"}};
const starts=[
 {type:"content_block_start",index:0,content_block:{type:"text",text:"retain answer"}},
 {type:"content_block_start",index:0,content_block:{type:"tool_use",id:"synthetic_tool",name:"lookup",input:{}}},
 {type:"content_block_start",index:0,content_block:{type:"server_tool_use",id:"synthetic_tool",name:"search",input:{}}},
 {type:"content_block_start",index:0,content_block:{type:"redacted_thinking",data:"synthetic-sealed"}},
 {type:"content_block_start",index:0,content_block:{type:"web_search_tool_result",content:[]}},
 {type:"content_block_start",index:0,content_block:{type:"future_block",data:"unknown semantic"}},
 {type:"message_start",message:{id:"synthetic",content:[{type:"text",text:"retain answer"}]}},
];
for(const first of starts)test(`Anthropic ${first.content_block?.type??"message content"} precedes an error without losing bytes`,async()=>{
 const text=frame(first)+frame(failure), source=new Response(text,{headers:{"content-type":"text/event-stream"}});
 const result=await explainResponse(source);assert.equal(result.status,200);assert.equal(await result.text(),text);
});
test("strictly empty Anthropic text prelude still allows early error diagnosis",async()=>{
 const source=new Response(frame({type:"message_start",message:{id:"synthetic",content:[]}})+frame({type:"content_block_start",index:0,content_block:{type:"text",text:""}})+frame(failure),{headers:{"content-type":"text/event-stream"}});
 assert.equal((await explainResponse(source)).status,503);
});
for(const payload of [
 {output:[{type:"message",content:[{type:"output_text",text:"retain"}]}]},
 {response:{output:[{type:"reasoning",encrypted_content:"retain"}]}},
 {content:[{type:"tool_use",id:"synthetic"}]},
 {output:[{type:"unknown_future_output",data:"retain"}]},
])test(`JSON partial/opaque output survives (${JSON.stringify(payload)})`,async()=>{
 const source=Response.json({...payload,error:{code:"server_error",message:"synthetic"}});
 const expected=await source.clone().text();
 const result=await explainResponse(source);assert.equal(result,source);assert.equal(await result.text(),expected);
});
test("signed and unknown Codex items are not reinterpreted; assistant text remains output_text",async()=>{
 const unknown={type:"future_signed_item",role:"assistant",content:"opaque",signature:"synthetic"};
 const body={input:[unknown,{type:"message",role:"assistant",content:"known history"}],reasoning:{effort:"high"}};
 const after=JSON.parse((await prepareCodexRequest(url,{method:"POST",body:JSON.stringify(body)})).body);
 assert.deepEqual(after.input[0],unknown);assert.equal(after.input[1].content[0].type,"output_text");assert.deepEqual(after.reasoning,body.reasoning);
});
for (const item of [
 {type:"function_call",id:"fc_signed",call_id:"synthetic",name:"lookup",arguments:"{}",signature:"opaque"},
 {type:"function_call_output",id:"fco_signed",call_id:"synthetic",output:"result",signature:"opaque"},
 {type:"function_call",id:"fc_opaque",call_id:"synthetic",name:"lookup",arguments:"{}",encrypted_function_args:"opaque"},
 {type:"message",id:"msg_signed_part",role:"user",content:[{type:"input_text",text:"keep",signature:"opaque"}]},
 {type:"message",id:"msg_file_ref",role:"user",content:[{type:"input_file",file_id:"file_resource_only"}]},
]) test(`portable history does not detach signed or resource-only contents: ${item.id}`,async()=>{
 const init={method:"POST",body:JSON.stringify({store:true,input:[item]})};
 const after=await prepareRequest(url,init);
 assert.equal(after,init,"opaque contents are not proven complete inline history");
});
for (const first of [
 {type:"response.created",response:{output:[],future_signed_state:"opaque"}},
 {type:"response.in_progress",response:{output:[]},future_payload:{retain:true}},
 {type:"response.output_item.added",item:{type:"message",content:[]},opaque_payload:"retain"},
 {type:"message_start",message:{content:[],usage:{future_semantics:"retain"}}},
 {type:"message_delta",delta:{stop_reason:null},usage:{future_semantics:"retain"}},
]) test(`unknown fields in a known ${first.type} prelude release before a later error`,async()=>{
 const text=frame(first)+frame(failure);
 const result=await explainResponse(new Response(text,{headers:{"content-type":"text/event-stream"}}));
 assert.equal(result.status,200);assert.equal(await result.text(),text);
});
test("Codex default compatibility does not invent a reasoning effort",async()=>{
 const after=JSON.parse((await prepareCodexRequest(url,{method:"POST",body:JSON.stringify({input:"synthetic"})})).body);
 assert.equal(after.reasoning,undefined);
});
for(const type of ["function_call_output","custom_tool_call_output"])test(`detaching server context rejects orphan ${type}`,async()=>{
 await assert.rejects(prepareRequest(url,{method:"POST",body:JSON.stringify({previous_response_id:"resp_synthetic",input:[{type,call_id:"missing",output:"synthetic"}]})},{sessionRepair:true}),{code:"anyrouter_session_repair_opaque_tool"});
});
test("Anthropic body and beta URL change together; GET requests do not transform",async()=>{
 const body=JSON.stringify({system:"synthetic",messages:[]});
 const after=await prepareAnthropicRequest("https://anyrouter.top/v1/messages",{method:"POST",body});
 assert.equal(after.url,"https://anyrouter.top/v1/messages?beta=true");assert.ok(JSON.parse(after.body).metadata.user_id);
 const init={method:"GET",body};assert.equal(await prepareAnthropicRequest("https://anyrouter.top/v1/messages",init),init);
});
for(const codex of [false,true])for(const claude of [false,true])test(`client switches stay independent (${codex}/${claude})`,async()=>{
 let captured;
 const p=await createProvider({magpie:{option:(_,key)=>key==="send-codex-headers"?codex:key==="claude-code-compat"?claude:true}},{},{fetchImpl:async(target,init)=>{captured={url:target instanceof Request?target.url:String(target),...init};return Response.json({ok:true});}});
 const auth={type:"api",key:"sk-synthetic",metadata:{}};
 const loaded=await p.auth.loader(async()=>auth,{models:{}});
 await loaded.fetch("https://anyrouter.top/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:'{"system":"synthetic","messages":[]}'});
 assert.equal(captured.headers.has("anthropic-beta"),claude);assert.equal(captured.url.includes("beta=true"),claude);assert.equal(Array.isArray(JSON.parse(captured.body).system),claude);
});
test("foreign and unknown inference destinations are rejected before sending a Key",async()=>{
 let calls=0;const p=await createProvider({}, {}, {fetchImpl:async()=>{calls++;return Response.json({ok:true});}});
 const loaded=await p.auth.loader(async()=>({type:"api",key:"sk-synthetic",metadata:{}}),{models:{}});
 for(const destination of ["https://foreign.invalid/v1/models","https://anyrouter.top/api/user/self","http://anyrouter.top/v1/responses","https://user@anyrouter.top/v1/responses"]) {
  const response=await loaded.fetch(destination);assert.equal(response.status,400);
 }
 assert.equal(calls,0);
});
test("model redirects are never followed with credentials",async()=>{
 let calls=0;const p=await createProvider({}, {}, {fetchImpl:async(_,init)=>{calls++;assert.equal(init.redirect,"manual");return new Response(null,{status:307,headers:{location:"https://foreign.invalid/"}});}});
 const loaded=await p.auth.loader(async()=>({type:"api",key:"sk-synthetic",metadata:{}}),{models:{}});
 assert.equal((await loaded.fetch("https://anyrouter.top/v1/models")).status,502);assert.equal(calls,1);
});
