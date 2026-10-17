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
  let creates=0;
  const m=wrapper({listSessions:async()=>[{id:'linn-board'}],createSession:async()=>{creates++;throw new Error('Must not create');},exec:async()=>({output:'ready',exitCode:0,duration:1})});
  assert.equal((await m.runCommand({session:'linn-board',command:'pwd'})).exitCode,0);
  assert.equal(creates,0,'no create for a session the listing holds');
});

test('runCommand lists again on a fresh connection when the first listing loses its connection, then runs the command',async()=>{
  let lists=0,creates=0,executed=false;
  const m=wrapper({listSessions:async()=>{if(lists++===0)throw new Error('Connection lost');return [{id:'board'}];},createSession:async()=>{creates++;},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  assert.equal((await m.runCommand({session:'board',command:'pwd'})).output,'ready');
  assert.equal(lists,2,'listed once more');
  assert.equal(creates,0);
  assert.equal(executed,true);
});

test("runCommand fails with the listing's error when the listing fails other than by a lost connection, and runs nothing",async()=>{
  let lists=0,creates=0,executed=false;
  const m=wrapper({listSessions:async()=>{lists++;throw new Error('Request timeout: session.list');},createSession:async()=>{creates++;},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  await assert.rejects(m.runCommand({session:'board',command:'pwd'}),/^Error: Request timeout: session\.list$/);
  assert.equal(lists,1,'not tried again');
  assert.equal(creates,0);
  assert.equal(executed,false);
});

test('runCommand creates a missing session under its service-mapped id, with the cwd given, when the listing holds only other sessions',async()=>{
  const created=[],executed=[];
  const m=wrapper({listSessions:async()=>[{id:'other'}],createSession:async(p)=>{created.push(p);return {sessionId:p.id};},exec:async(id)=>{executed.push(id);return {output:'ready',exitCode:0,duration:1};}});
  m.serviceMap.set('web','svc-1');
  assert.equal((await m.runCommand({session:'web',command:'pwd',cwd:'/srv'})).output,'ready');
  assert.deepEqual(created,[{id:'svc-1',cwd:'/srv'}]);
  assert.deepEqual(executed,['svc-1']);
});

test("the second listing, not the creation error's wording, decides whether a refused create is the session existing after all",async()=>{
  let lists=0,executed=false;
  const listed=wrapper({listSessions:async()=>lists++?[{id:'board'}]:[],createSession:async()=>{throw new Error('Session board is already running');},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  assert.equal((await listed.runCommand({session:'board',command:'pwd'})).output,'ready','other wording, and the session is listed: runs');
  assert.equal(executed,true);
  executed=false;
  const absent=wrapper({listSessions:async()=>[],createSession:async()=>{throw new Error('Session board already exists');},exec:async()=>{executed=true;return {output:'ready',exitCode:0,duration:1};}});
  await assert.rejects(absent.runCommand({session:'board',command:'pwd'}),/Session board already exists/,"the server's wording, and the session isn't listed: the creation's error");
  assert.equal(executed,false);
});
