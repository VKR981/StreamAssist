import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceAuthFlow } from '../src/twitch/device-auth.js';
const SECRET = 'secret-device-never-display';
const ACCESS = 'secret-access-never-display';
const REFRESH = 'secret-refresh-never-display';
const device = {device_code:SECRET,user_code:'ABCD1234',verification_uri:'https://www.twitch.tv/activate?public=true&device-code=ABCD1234',expires_in:1800,interval:5};
const response = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function fixture(replies=[]) {
  let time=100000; const requests=[];const saved=[];
  const flow=new DeviceAuthFlow({clientId:'fixture-client',now:()=>time,fetchImpl:async(url,options)=>{
    requests.push({url,form:new URLSearchParams(options.body)});
    const next=replies.shift();if(next instanceof Error)throw next;return next||response(device);
  },validate:async(id,token)=>{assert.equal(token,ACCESS);return {login:'streamer',userId:'42',scopes:['user:read:chat','user:write:chat'],expiresIn:14400};},save:(...args)=>saved.push(args),credentialsPath:'/fixture/credentials.json'});
  return {flow,requests,saved,advance:ms=>{time+=ms;}};
}
function privateValuesAbsent(value) {
  const text=JSON.stringify(value);
  for(const secret of [SECRET,ACCESS,REFRESH]) assert.ok(!text.includes(secret),'Secret escaped through a public result');
}

test('Device auth: starts one flow with public client ID and never reveals device token',async()=>{
  const {flow,requests}=fixture();
  const started=await flow.begin();assert.equal(started.status,'authorization_required');assert.match(started.verification_url,/twitch.tv\/activate/);
  assert.equal(requests[0].form.get('client_id'),'fixture-client');assert.equal(requests[0].form.get('scopes'),'user:read:chat user:write:chat moderator:manage:chat_messages moderator:manage:banned_users');
  assert.equal(requests[0].form.has('client_secret'),false);
  await flow.begin();assert.equal(requests.length,1);privateValuesAbsent(started);privateValuesAbsent(flow.status());
});

test('Device auth: waits for interval, handles pending, validates and privately saves approved credentials',async()=>{
  const {flow,requests,saved,advance}=fixture([response(device),response({message:'authorization_pending'},400),response({access_token:ACCESS,refresh_token:REFRESH,expires_in:14400})]);
  await flow.begin();const early=await flow.complete();assert.equal(early.status,'pending');assert.equal(requests.length,1);
  advance(5000);const pending=await flow.complete();assert.equal(pending.status,'pending');privateValuesAbsent(pending);
  advance(5000);const approved=await flow.complete();assert.equal(approved.status,'authorized');assert.equal(approved.login,'streamer');privateValuesAbsent(approved);
  assert.equal(saved.length,1);assert.equal(saved[0][1],ACCESS);assert.equal(saved[0][3].refreshToken,REFRESH);
  assert.equal(requests[2].form.get('grant_type'),'urn:ietf:params:oauth:grant-type:device_code');
  privateValuesAbsent(flow.status());
});

test('Device auth: slow_down increases polling interval and does not flood Twitch',async()=>{
  const {flow,requests,advance}=fixture([response(device),response({message:'slow_down'},400),response({message:'authorization_pending'},400)]);
  await flow.begin();advance(5000);const slow=await flow.complete();assert.ok(slow.poll_after_seconds>=10);
  advance(5000);await flow.complete();assert.equal(requests.length,2);
  advance(5000);await flow.complete();assert.equal(requests.length,3);
});

test('Device auth: denial and expiry never save credentials',async()=>{
  const {flow,saved,advance}=fixture([response(device),response({message:'access_denied'},400)]);
  await flow.begin();advance(5000);const denied=await flow.complete();assert.notEqual(denied.status,'authorized');assert.notEqual(flow.status().status,'authorization_required');assert.equal(saved.length,0);privateValuesAbsent(denied);
  const second=fixture();await second.flow.begin();second.advance(1801000);const expired=await second.flow.complete();assert.notEqual(expired.status,'authorized');assert.equal(second.requests.length,1);
});

test('Device auth: cancellation during token request prevents credential storage',async()=>{
  let release;let time=0;const saved=[];let calls=0;
  const flow=new DeviceAuthFlow({clientId:'fixture-client',now:()=>time,fetchImpl:async()=>++calls===1?response(device):new Promise(r=>{release=r;}),validate:async()=>({login:'streamer',userId:'1',scopes:['user:read:chat']}),save:(...args)=>saved.push(args)});
  await flow.begin();time=5000;const pending=flow.complete();await Promise.resolve();flow.cancel();release(response({access_token:ACCESS,expires_in:3600}));
  const result=await pending;assert.notEqual(result.status,'authorized');assert.equal(saved.length,0);privateValuesAbsent(result);
});

test('Device auth: external error text cannot leak secret tokens',async()=>{
  const {flow,advance}=fixture([response(device),new Error(`upstream ${ACCESS} ${SECRET}`)]);
  await flow.begin();advance(5000);const result=await flow.complete();privateValuesAbsent(result);assert.notEqual(result.status,'authorized');
});

test('Device auth: refuses a verification link outside Twitch',async()=>{
  const {flow}=fixture([response({...device,verification_uri:'https://example.com/activate'})]);
  await assert.rejects(flow.begin(),/Untrusted verification URI/);
});

test('Device auth: cancellation while parsing a response cannot recreate an attempt',async()=>{
  let release;
  const flow=new DeviceAuthFlow({clientId:'fixture',fetchImpl:async()=>({ok:true,json:()=>new Promise(r=>{release=r;})})});
  const pending=flow.begin();await Promise.resolve();await Promise.resolve();
  flow.cancel();release(device);await assert.rejects(pending,/cancelled/);
  assert.equal(flow.status().status,'not_started');
});
