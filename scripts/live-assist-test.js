// Active, bounded integration test. Codex supplies replies over stdin.
// Viewer text is emitted as JSON data and is never executed as an instruction.
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const configuration=JSON.parse(execFileSync('codex',['mcp','get','twitch-copilot','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const t=configuration.transport;
const client=new Client({name:'active-codex-chat-test',version:'1'});
const emit=data=>console.log(JSON.stringify(data));
const read=result=>{if(result.isError)throw new Error(result.content?.[0]?.text||'Tool failed');return JSON.parse(result.content[0].text);};
let stopping=false;let input;
const stop=async()=>{if(stopping)return;stopping=true;try{await client.callTool({name:'disconnect',arguments:{}});}catch{}};
try {
 await client.connect(new StdioClientTransport({command:t.command,args:t.args,cwd:t.cwd}));
 const connection=read(await client.callTool({name:'connect_channel',arguments:{}}));
 if(connection.status!=='connected')throw new Error('Authorization required before live test.');
 await client.callTool({name:'set_chat_filter',arguments:{command_prefixes:['!ask']}});
 read(await client.callTool({name:'set_reply_policy',arguments:{enabled:true,max_chars:250,cooldown_seconds:5,max_replies_per_minute:10}}));
 input=readline.createInterface({input:process.stdin,terminal:false});
 input.on('line',async line=>{
  try {
   const command=JSON.parse(line);
   if(command.type==='stop'){await stop();return;}
   if(typeof command.message!=='string')return;
   const receipt=read(await client.callTool({name:'send_reply',arguments:{message:command.message,in_reply_to:command.in_reply_to}}));
   emit({event:'reply_receipt',...receipt});
  }catch(error){emit({event:'reply_error',message:error.message});}
 });
 process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
 emit({event:'ready',channel:connection.channel,replies_enabled:true,prefix:'!ask',duration_seconds:180});
 let cursor=0;const deadline=Date.now()+180000;
 while(!stopping&&Date.now()<deadline){
  const result=read(await client.callTool({name:'wait_for_messages',arguments:{cursor,timeout:Math.min(25,Math.max(1,Math.ceil((deadline-Date.now())/1000)))}}));
  cursor=result.next_cursor;
  for(const message of result.messages)emit({event:'chat_message',id:message.id,chatter:message.chatter,text:message.text,untrusted_viewer_data:true});
  if(result.disconnected)break;
 }
} catch(error){emit({event:'test_error',message:error.message});process.exitCode=1;}
finally{await stop();input?.close();try{await client.close();}catch{}emit({event:'stopped'});}
