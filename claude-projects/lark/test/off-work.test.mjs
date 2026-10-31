import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createMessageCoordinator } from '../src/message-coordinator.mjs';
import { createInternalSkillRegistry } from '../src/internal-skills.mjs';
import { resolveIntent } from '../src/resolver.mjs';
import { createOffWorkSkill, parseOffWorkCommand } from '../src/off-work.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-off-work-'));
  const store=new Store(path.join(root,'test.sqlite'));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const scheduler=new Scheduler({store,executors:{},onMessage:async()=>{},maxConcurrentProjects:0});
  return {root,store,scheduler};
}
const message=(id,content)=>({message_id:id,content,message_type:'text',sender_id:'ou_test',chat_id:'oc_test',reply_to:null});
const complete=()=>({status:'completed',released:true,outcomes:[],remaining:[],retained:[],unknown:[],codexLocks:{complete:true,held:[]}});

test('only standalone explicit text commands authorize off-work, including replies; model output cannot', async t=>{
  const {store}=fixture(t);
  const config={projects:[],gateway:{recentSessionLimit:20}};
  const registry=createInternalSkillRegistry({});
  const coordinator=createMessageCoordinator({config,store,internalSkills:registry,
    router:{route:async()=>({action:'internal_skill',skill_name:'off_work'})}});
  for(const content of ['下班','SessionMgr 下班']) {
    const result=await coordinator.coordinate({...message('om_a',content),reply_to:'om_unknown_notification'});
    assert.deepEqual(result,{type:'internal_skill',skillName:'off_work',execute:true});
  }
  assert.equal(parseOffWorkCommand('下班检查').execute,false);
  for(const content of ['不要下班','下班是什么意思','实现下班功能','“下班”','下班后提交','codex PC共享 下班']) {
    assert.equal(parseOffWorkCommand(content),null);
    const result=await coordinator.coordinate(message('om_a',content));
    assert.notEqual(result.skillName,'off_work');
  }
  for(const type of ['audio','post','image']) {
    assert.equal(parseOffWorkCommand('下班',type),null);
    const result=await coordinator.coordinate({...message('om_audio','下班'),message_type:type});
    assert.notEqual(result.skillName,'off_work');
  }
  assert.equal(resolveIntent({action:'internal_skill',skill_name:'off_work'},config,store,{},registry).type,'reply');
});

test('shutdown pauses starts, cancels queued tasks, rejects pending approvals and preserves Gateway', async t=>{
  const {store,scheduler,root}=fixture(t);
  const session=store.createSession({executor:'codex',projectAlias:'fixture',projectPath:root,name:'fixture'});
  const task=store.createTask({sessionId:session.id,action:'new',content:'fixture'});
  scheduler.enqueue(task,session,{defer:true});
  const token=scheduler.beginOffWork();
  assert.equal(store.getTask(task.id).status,'cancelled');
  let creates=0;
  assert.throws(()=>scheduler.enqueueFactory(session,()=>{creates++;}),/下班/);
  assert.equal(creates,0);assert.equal(scheduler.canEnqueue(session.id),false);
  assert.equal(scheduler.endOffWork(token),true);assert.equal(scheduler.canEnqueue(session.id),true);
});

test('cancellation while start message is pending cannot launch a new executor afterward', async t=>{
  const {store,root}=fixture(t);let release;let calls=0;
  const started=new Promise(resolve=>release=resolve);
  const scheduler=new Scheduler({store,executors:{codex:{run:async()=>{calls++;return {summary:'bad'};}}},
    onMessage:async(_s,_text,key)=>{if(key.startsWith('start-')) await started;}});
  const session=store.createSession({executor:'codex',projectAlias:'fixture',projectPath:root,name:'fixture'});
  const task=store.createTask({sessionId:session.id,action:'new',content:'fixture'});
  scheduler.enqueue(task,session);
  const fence=scheduler.beginOffWork();release();
  for(let i=0;i<20&&scheduler.active.size;i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(calls,0);assert.equal(store.getTask(task.id).status,'cancelled');scheduler.endOffWork(fence);
});

test('old messages remain fenced after shutdown finishes and cannot create a new Session', async t=>{
  const {store,root}=fixture(t);
  store.acceptInbox(message('om_before','codex new fixture run'));
  store.acceptInbox(message('om_off','下班'));
  store.claimOffWork('om_off');
  store.acceptInbox(message('om_during','codex new during run'));
  store.finishOffWork('om_off',complete(),'finished');
  for(const id of ['om_before','om_during']) {
    assert.deepEqual(store.commitNamedTask({messageId:id,executor:'codex',project:{path:root,alias:'fixture'},name:'fixture',content:'run',action:'new'}),{ok:false,reason:'off_work'});
  }
  assert.equal(store.listSessions(20).length,0);
  store.acceptInbox(message('om_after','new work'));
  assert.equal(store.taskBlockedByOffWork('om_after'),false);
});

test('duplicate deliveries and crash replay never shut down newly opened clients', async t=>{
  const {store,scheduler}=fixture(t);let calls=0;
  store.acceptInbox(message('om_off','下班'));
  const handler=createOffWorkSkill({store,scheduler,execute:async options=>{assert.ok(options.protectedPids.includes(process.pid));calls++;return complete();}});
  const first=await handler({messageId:'om_off',execute:true});
  assert.equal(await handler({messageId:'om_off',execute:true}),first);assert.equal(calls,1);
  store.claimOffWork('om_interrupted');
  assert.match(await handler({messageId:'om_interrupted',execute:true}),/已开始过/);assert.equal(calls,1);
});

test('preview never cancels, and execution failure releases the admission barrier', async t=>{
  const {store,scheduler}=fixture(t);let calls=0;
  const handler=createOffWorkSkill({store,scheduler,inspect:async()=>({status:'preview',complete:true,targets:[],retained:[],unknown:[]}),
    execute:async()=>{calls++;throw new Error('failure');}});
  assert.match(await handler({messageId:'om_preview',execute:false}),/未关闭进程/);assert.equal(calls,0);
  assert.match(await handler({messageId:'om_fail',execute:true}),/未完成/);
  assert.equal(scheduler.offWork,null);assert.equal(store.taskAdmissionBlocked,false);
});

test('unfinished Gateway tasks make the final result partial, never fully released', async t=>{
  const {store,scheduler}=fixture(t);
  scheduler.active.set('CX-stuck',{task:{id:'TK-stuck'},abort:new AbortController()});
  const handler=createOffWorkSkill({store,scheduler,execute:async()=>complete(),waitMs:0});
  const result=await handler({messageId:'om_stuck',execute:true});
  assert.match(result,/未完全完成/);assert.match(result,/尚未停止/);
  assert.equal(scheduler.offWork,null);
});

test('crash recovery cancels persisted queued work and fences messages received during shutdown', t=>{
  const {store,root}=fixture(t);
  const session=store.createSession({executor:'codex',projectAlias:'fixture',projectPath:root,name:'fixture'});
  const task=store.createTask({sessionId:session.id,action:'new',content:'must not restart'});
  store.acceptInbox(message('om_off','下班'));
  store.claimOffWork('om_off');
  assert.equal(store.getTask(task.id).status,'cancelled');
  store.acceptInbox(message('om_during','new work'));
  assert.equal(store.recoverOffWorkRequests(),1);
  assert.equal(store.taskBlockedByOffWork('om_during'),true);
  const replay=store.claimOffWork('om_off');
  assert.equal(replay.ownsExecution,false);assert.match(replay.reply_text,/不会自动再次关闭/);
  assert.equal(store.recoverOffWorkRequests(),0);
});

test('shutdown rejects live approvals while aborting the owning task', t=>{
  const {scheduler}=fixture(t);const abort=new AbortController();let decision=null;
  scheduler.active.set('CX-active',{task:{id:'TK-active'},abort});
  scheduler.approvalWaiters.set('RQ-active',{sessionId:'CX-active',taskId:'TK-active',resolve:value=>{decision=value;}});
  const fence=scheduler.beginOffWork();
  assert.equal(abort.signal.aborted,true);assert.equal(decision,'reject');assert.equal(scheduler.approvalWaiters.size,0);
  scheduler.active.clear();scheduler.endOffWork(fence);
});
