import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { identifyAgentProcess, planOffWork, executeOffWork, verifyCodexLocks, windowsOffWork } from '../scripts/off-work.mjs';

const root = path.win32.join(path.parse(process.cwd()).root || path.win32.parse(process.execPath).root, 'sessionmgr-fixture');
const exe = (...parts) => path.win32.join(root, ...parts);
const sid = 'S-1-5-21-111-222-333-1001';
function row(pid, parentPid = 1, more = {}) {
  return { pid, parentPid, procStart: String(134000000000000000n + BigInt(pid)), ownerSid: sid,
    executable: exe('node.exe'), name: 'node.exe', commandLine: `"${exe('node.exe')}" tools.mjs`, ...more };
}
function claude(pid, parentPid = 1) { return row(pid, parentPid, { executable: exe('claude.exe'), name: 'claude.exe', product: 'Claude Code', company: 'Anthropic PBC' }); }
function desktop(pid, parentPid = 1) { return row(pid, parentPid, { executable: exe('desktop', 'ChatGPT.exe'), name: 'ChatGPT.exe', product: 'Codex', company: 'OpenAI OpCo, LLC' }); }
const snapshot = processes => ({ complete: true, ownerSid: sid, sessionId: 1, processes });

test('known clients require executable/package identity; prompt strings and unrelated desktop names do not match', () => {
  assert.equal(identifyAgentProcess(desktop(10)).kind, 'desktop');
  assert.equal(identifyAgentProcess(claude(11)).harness, 'claude');
  assert.equal(identifyAgentProcess(row(12, 1, { executable: exe('OpenAI', 'Codex', 'bin', 'build-id', 'codex.exe') })).harness, 'codex');
  assert.equal(identifyAgentProcess(row(13, 1, { executable: exe('.opencode', 'bin', 'opencode.exe') })).harness, 'opencode');
  const entry = exe('node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  assert.equal(identifyAgentProcess(row(14, 1, { commandLine: `"${exe('node.exe')}" "${entry}" prompt` })).harness, 'claude');
  assert.equal(identifyAgentProcess(row(15, 1, { commandLine: `"${exe('node.exe')}" unrelated.mjs "${entry}"` })), null);
  assert.equal(identifyAgentProcess(row(16, 1, { executable: exe('ChatGPT.exe'), product: 'ChatGPT', company: 'OpenAI' })), null);
});

test('planning closes idle and active clients and their verified children, not shells, other users, or reused parent identities', () => {
  const client = claude(10), child = row(20, 10), otherUser = { ...claude(30), ownerSid: 'S-1-5-21-other' };
  const oldChild = row(5, 10), shell = row(40, 1, { executable: exe('pwsh.exe'), name: 'pwsh.exe' });
  const plan = planOffWork(snapshot([client, child, otherUser, oldChild, shell]), { selfPid: 999 });
  assert.deepEqual(plan.targets.map(p => p.pid).sort((a,b)=>a-b), [10,20]);
  assert.equal(plan.targets.some(p => 'commandLine' in p), false);
});

test('gateway and listener subtrees protect ancestors; independent worker alone may outlive the caller', () => {
  const app = desktop(10), worker = row(20, 10), probe = row(21, 20);
  assert.equal(planOffWork(snapshot([app,worker,probe]), { selfPid:20 }).retained[0].pid, 10);
  assert.deepEqual(planOffWork(snapshot([app,worker,probe]), { selfPid:20, detachedWorker:true }).targets.map(p=>p.pid), [10]);
  const gateway = row(30, 10, { commandLine:`"${exe('node.exe')}" "${exe('lark','src','gateway.mjs')}"` });
  const gatewayChild = claude(40,30);
  const plan = planOffWork(snapshot([app,worker,probe,gateway,gatewayChild]), { selfPid:20, detachedWorker:true });
  assert.equal(plan.targets.length,0);
  assert.deepEqual(plan.retained.map(p=>p.pid),[10,40]);
});

test('inaccessible or unverified same-user client is reported instead of claiming no active sessions', () => {
  const plan = planOffWork(snapshot([row(10, 1, { name:'claude.exe', executable:exe('unknown','claude.exe') }),
    row(11,1,{ name:'codex.exe', executable:null, ownerSid:null, sessionId:1 })]), { selfPid:999 });
  assert.equal(plan.targets.length,0); assert.equal(plan.unknown.length,2);
});

test('shutdown only uses captured targets and detects newly spawned clients, failed exits and incomplete final locks', async () => {
  const first = snapshot([claude(10)]), empty = snapshot([]);
  for (const outcome of ['terminated','identity_changed']) {
    let scans=0; const calls=[];
    const backend=async request=>{ calls.push(request); return request.action==='snapshot' ? (scans++ ? empty:first)
      : {outcomes:[{pid:10,procStart:first.processes[0].procStart,state:outcome}]}; };
    const result=await executeOffWork({backend,selfPid:999,verifyLocks:async()=>({complete:true,held:[],unknown:[]})});
    assert.equal(result.released,outcome==='terminated');
    assert.equal(calls.filter(c=>c.action==='shutdown').length,1);
  }
  let scans=0;
  const result=await executeOffWork({selfPid:999,
    backend:async request=>request.action==='snapshot' ? (scans++ ? snapshot([claude(22)]):first)
      : {outcomes:[{pid:10,procStart:first.processes[0].procStart,state:'closed'}]},
    verifyLocks:async()=>({complete:false,held:['native-id'],unknown:['unreadable']})});
  assert.equal(result.status,'partial'); assert.equal(result.remaining[0].pid,22);
});

test('an incomplete snapshot never sends a shutdown request', async () => {
  let actions=[];
  const result=await executeOffWork({backend:async request=>{actions.push(request.action);return {...snapshot([claude(10)]),complete:false};}});
  assert.deepEqual(actions,['snapshot']); assert.equal(result.released,false);
});

test('malformed snapshots and protected browser descendants cannot be reported fully shut down', () => {
  assert.equal(planOffWork({complete:true}).complete,false);
  assert.equal(planOffWork(snapshot([claude(10),claude(10)])).complete,false);
  const browser=row(20,10,{executable:exe('chrome.exe'),name:'chrome.exe'});
  const plan=planOffWork(snapshot([desktop(10),browser]),{selfPid:999});
  assert.equal(plan.targets.length,0);assert.equal(plan.retained[0].pid,10);
});

test('Codex lock verification distinguishes file existence, held and failed probes without deleting locks', async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'off-work-locks-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const locks=path.join(folder,'thread-writer-locks');fs.mkdirSync(locks);
  const ids=['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333'];
  ids.forEach(id=>fs.writeFileSync(path.join(locks,`${id}.lock`),''));
  const result=await verifyCodexLocks({codexRoot:folder,probe:async()=>({locks:new Map(ids.map((id,i)=>[id,{state:['free','held','accessDenied'][i]}]))})});
  assert.deepEqual(result.held,[ids[1]]);assert.deepEqual(result.unknown,[ids[2]]);assert.equal(result.complete,false);
  assert.equal(fs.readdirSync(locks).length,3);
});

test('native backend rejects a wrong creation time and stops only a disposable test child', {
  skip:process.env.SESSIONMGR_TEST_OWN_PROCESS !== '1' || process.platform!=='win32',
}, async t => {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  t.after(()=>{try{child.kill();}catch{}});
  const captured=await windowsOffWork({action:'snapshot'});
  const own=captured.processes.find(p=>p.pid===child.pid);assert.ok(own?.procStart);
  const wrong=await windowsOffWork({action:'shutdown',targets:[{...own,procStart:'100000000000000000',kind:'desktop'}]});
  assert.equal(wrong.outcomes[0].state,'identity_changed');
  assert.doesNotThrow(()=>process.kill(child.pid,0));
  const stopped=await windowsOffWork({action:'shutdown',targets:[{...own,kind:'child'}]});
  assert.ok(['terminated','closed'].includes(stopped.outcomes[0].state));
});
