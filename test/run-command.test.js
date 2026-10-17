const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectomeTestingMCP}=require('../dist/src/mcp/mcp-server');

function wrapper(client){const m=new ConnectomeTestingMCP();m.getClient=()=>client;return m;}

test('runCommand retains session-limit failure instead of executing a missing session',async()=>{
  let executed=false;
  const m=wrapper({listSessions:async()=>[],createSession:async()=>{throw new Error('Session limit reached (150). Reuse an existing one.');},exec:async()=>{executed=true;throw new Error('Session board not found');}});
  await assert.rejects(m.runCommand({session:'board',command:'pwd'}),/Session limit reached/);
  assert.equal(executed,false);
});

test('runCommand preserves the creation cause even if the race-check also fails',async()=>{
  let lists=0;
  const m=wrapper({listSessions:async()=>{if(lists++)throw new Error('Disconnected');return [];},createSession:async()=>{throw new Error('Invalid working directory');}});
  await assert.rejects(m.runCommand({session:'board',command:'pwd'}),/Invalid working directory/);
});

test('runCommand tolerates another caller creating the same session concurrently',async()=>{
  let lists=0,executed=false;
  const m=wrapper({listSessions:async()=>lists++?[{id:'board'}]:[],createSession:async()=>{throw new Error('Session board already exists');},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  assert.equal((await m.runCommand({session:'board',command:'pwd'})).output,'ready');assert.equal(executed,true);
});

test('runCommand reuses existing sessions at capacity without creating another',async()=>{
  const m=wrapper({listSessions:async()=>[{id:'linn-board'}],createSession:async()=>{throw new Error('Must not create');},exec:async()=>({output:'ready',exitCode:0,duration:1})});
  assert.equal((await m.runCommand({session:'linn-board',command:'pwd'})).exitCode,0);
});
