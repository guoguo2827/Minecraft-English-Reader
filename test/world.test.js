"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const C = require("../lib/world-content");
const { migrateWorld, accessError } = require("../lib/world-service");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mer-world-"));
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_PATH: path.join(dir, "app.db"), SESSION_DATABASE_PATH: path.join(dir, "session.db"),
  COOKIE_SECURE: "false", SESSION_SECRET: "world-tests-not-a-production-secret", ACCESS_CONTROL_ENFORCED: "false",
  WORLD_ACCESS: "full", ADMIN_USERNAME: "camp-admin", ADMIN_PHONE: "13830000000", ADMIN_PASSWORD: "CampTest123"
});
const { app, db, sessionStore, helpers } = require("../server");
let server, base, cookie, userId, state;
let userIndex = 0;
test.before(async () => { await new Promise(resolve => { server = app.listen(0,"127.0.0.1",resolve); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(resolve => server.close(resolve)); sessionStore.close(); db.close(); });
async function user() {
  const phone = `139300000${String(++userIndex).padStart(2,"0")}`;
  const id = Number(db.prepare("INSERT INTO users (username, phone, password_hash, nickname, access_tier, primary_course, created_at) VALUES (?, ?, ?, 'Camp', 'founder_trial', 'english', ?)")
    .run(phone, phone, bcrypt.hashSync("CampTest123",4), new Date().toISOString()).lastInsertRowid);
  const login = await fetch(`${base}/api/auth/login`, { method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone,password:"CampTest123"}) });
  assert.equal(login.status,200); return { id, cookie: login.headers.get("set-cookie").split(";")[0] };
}
async function api(route, body, expected = 200, auth = cookie) {
  const response = await fetch(`${base}/api/world${route}`, { method:body?"POST":"GET",headers:{Cookie:auth||"","Content-Type":"application/json"},body:body?JSON.stringify(body):undefined });
  const data = await response.json(); assert.equal(response.status,expected,JSON.stringify(data));
  if (data.state && auth === cookie) state = data;
  return data;
}
async function action(command, position = C.SPAWN, expected = 200) {
  return api("/actions", { operationId:crypto.randomUUID(), version:state.version, position, ...command },expected);
}
const near = pos => ({x:pos[0]+2.5,y:Math.max(4.95,pos[1]+.95),z:pos[2]+2.5,yaw:0,pitch:0});
function markMastered(id) {
  for (const w of C.WORDS) db.prepare("INSERT INTO word_progress (user_id,theme_id,word,mastery_status) VALUES (?,?,?,'mastered') ON CONFLICT(user_id,theme_id,word) DO UPDATE SET mastery_status='mastered'").run(id,w.themeId,w.word);
}
test("world access is independent of the legacy permissive access flag", async () => {
  const u = await user(); cookie=u.cookie;userId=u.id;
  await api("/bootstrap",null,401,"");
  process.env.WORLD_ACCESS="admin";
  assert.equal((await api("/bootstrap",null,403)).code,"WORLD_PREVIEW_ONLY");
  process.env.WORLD_ACCESS="full";
  for (const changes of ["access_tier='free_trial',trial_expires_at='2099-01-01'", "access_tier='free_trial',trial_expires_at='2000-01-01'", "access_tier='founder_trial',primary_course='chinese'", "primary_course='english',password_reset_required=1", "password_reset_required=0,status='disabled'"]) {
    db.prepare(`UPDATE users SET ${changes} WHERE id=?`).run(userId); await api("/bootstrap",null,403);
  }
  db.prepare("UPDATE users SET status='active' WHERE id=?").run(userId);
  state=await api("/bootstrap"); assert.equal(state.words.length,8);assert.equal(state.phrases.length,8);
  assert.deepEqual(state.phrases.map(p=>p.id).sort((a,b)=>a-b),C.PHRASE_IDS);
  for (const p of state.phrases) assert.ok(p.english && p.chinese);
  assert.equal(accessError({status:"active",role:"admin"},"admin"),null);
  assert.equal(accessError({status:"active",role:"admin"},"off").code,"WORLD_UNAVAILABLE");
  await api("/audio/arbitrary-text",null,404);
  await api("/learning/next",{wordId:"diamond"},400);
});
test("incremental world migration is repeatable and preserves original rows", () => {
  const tables=["users","word_progress","review_queue","user_rewards","reward_events","speaking_attempts"];
  const counts=()=>tables.map(t=>db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n);
  const original=counts();migrateWorld(db);migrateWorld(db);assert.deepEqual(counts(),original);
  assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version='2026-09-07-english-camp-v1'").get().n,1);
});
test("login and password reset recognize the world return path without allowing external URLs", () => {
  for (const name of ["login.html","reset-password.html"]) {
    const html=fs.readFileSync(path.resolve(__dirname,"../outputs",name),"utf8");
    const paths=JSON.parse(html.match(/const allowedNextPaths = new Set\((\[[^;]+\])\);/)[1]);
    assert.ok(paths.includes("/world"));assert.ok(paths.every(p=>p.startsWith("/")&&!p.startsWith("//")));
  }
});
test("single-use world questions reuse source mastery, wrong-answer repair and rewards", async () => {
  const q=await api("/learning/next",{wordId:"block"});
  assert.equal((await api("/learning/next",{wordId:"block"})).id,q.id);
  const wrong=q.options.find(o=>o.value!=="方块").value;
  const request={questionId:q.id,selected:wrong,version:state.version};
  const failed=await api("/learning/answer",request);
  assert.equal(failed.result.correct,false);assert.equal(failed.words.find(w=>w.id==="block").reviewRemaining,3);
  const count=db.prepare("SELECT count(*) AS n FROM reward_events WHERE user_id=?").get(userId).n;
  assert.equal((await api("/learning/answer",request)).duplicate,true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM reward_events WHERE user_id=?").get(userId).n,count);
  await api("/learning/answer",{...request,selected:"方块"},409);
  for (let i=0;i<3;i++) {
    const next=await api("/learning/next",{wordId:"block"});
    const result=await api("/learning/answer",{questionId:next.id,selected:"方块",version:state.version});
    assert.equal(result.result.correct,true);assert.equal(result.words.find(w=>w.id==="block").mastered,i===2);
  }
  assert.equal(db.prepare("SELECT status FROM review_queue WHERE user_id=? AND word='block'").get(userId).status,"fixed");
  assert.equal(state.state.inventory.planks,0);
  const oak=await api("/learning/next",{wordId:"oak"});
  const body={questionId:oak.id,selected:"橡木",version:state.version};
  await api("/learning/answer",body);assert.equal(state.state.inventory.planks,8);
  const rewardCount=db.prepare("SELECT count(*) AS n FROM reward_events WHERE user_id=?").get(userId).n;
  await api("/learning/answer",body);assert.equal(state.state.inventory.planks,8);
  assert.equal(db.prepare("SELECT count(*) AS n FROM reward_events WHERE user_id=?").get(userId).n,rewardCount);
  assert.equal(db.prepare("SELECT count(*) AS n FROM word_progress WHERE user_id=? AND theme_id='concepts' AND mastery_status='mastered'").get(userId).n,1);
  await action({type:"craft",recipeId:"chest"},near(C.STATIONS.workbench),400);
  await action({type:"craft",recipeId:"planks"},C.SPAWN,400);
});
test("old mastery grants each material milestone once and stays unlocked after review", async () => {
  const u=await user();cookie=u.cookie;userId=u.id;markMastered(userId);
  state=await api("/bootstrap");
  assert.equal(state.state.inventory.planks,24);assert.equal(state.state.inventory.oak,4);assert.equal(state.state.recipesUnlocked,true);
  const version=state.version;await api("/bootstrap");assert.equal(state.version,version);
  db.prepare("UPDATE word_progress SET mastery_status='review' WHERE user_id=?").run(userId);
  await api("/bootstrap");assert.equal(state.state.learned.length,8);assert.equal(state.state.recipesUnlocked,true);assert.equal(state.state.inventory.planks,24);
  assert.equal(db.prepare("SELECT count(*) AS n FROM reward_events WHERE user_id=?").get(userId).n,0);
});
test("world actions validate material, range, placement, versions and idempotency", async () => {
  const body={type:"craft",recipeId:"planks",count:2,position:C.SPAWN,version:state.version,operationId:crypto.randomUUID()};
  const made=await api("/actions",body);assert.equal(made.state.inventory.planks,32);assert.equal(made.state.inventory.oak,2);
  const savedVersion=state.version;
  assert.equal((await api("/actions",body)).duplicate,true);assert.equal(state.version,savedVersion);assert.equal(state.state.inventory.oak,2);
  await api("/actions",{...body,count:3},409);
  await api("/actions",{...body,operationId:crypto.randomUUID()},409);
  await action({type:"craft",recipeId:"planks",count:-1},C.SPAWN,400);
  await action({type:"craft",recipeId:"door",count:100},C.SPAWN,400);
  await action({type:"place",item:"planks",pos:"bad"},C.SPAWN,400);
  await action({type:"place",item:"planks",pos:[5,4,5]},near([5,4,5]),400);
  await action({type:"place",item:"planks",pos:[38,12,12]},near([38,12,12]),400);
  await action({type:"place",item:"planks",pos:[38,4,12]},C.SPAWN,400);
  const inv=state.state.inventory.planks;
  await action({type:"place",item:"planks",pos:[38,4,12]},near([38,4,12]));
  await action({type:"remove",pos:[38,4,12]},near([38,4,12]));assert.equal(state.state.inventory.planks,inv);
  await action({type:"remove",pos:C.STATIONS.door},near(C.STATIONS.door),400);
});
test("all eight new words -> materials -> bridge and commands -> house -> permanent badge", async () => {
  const u=await user();cookie=u.cookie;userId=u.id;state=await api("/bootstrap");
  for (const w of C.WORDS) {
    const q=await api("/learning/next",{wordId:w.id});
    const result=await api("/learning/answer",{questionId:q.id,selected:w.cn,version:state.version});
    assert.equal(result.result.correct,true,`source word mismatch ${w.word}`);
  }
  assert.equal(state.state.learned.length,8);assert.equal(state.state.recipesUnlocked,true);
  const emeraldBefore=db.prepare("SELECT sum(exp) AS n FROM reward_events WHERE user_id=?").get(userId).n;
  for(const pos of C.BRIDGE) await action({type:"place",pos,item:"planks"},near(pos));
  assert.equal(state.state.tasks.bridge,true);
  await action({type:"remove",pos:C.BRIDGE[0]},near(C.BRIDGE[0]),400);
  await action({type:"borrow"},near(C.STATIONS.axe));
  for(let i=0;i<6;i++) await action({type:"harvest",nodeId:i},near(C.RESOURCES[i]));
  await action({type:"harvest",nodeId:0},near(C.RESOURCES[0]),400);
  await action({type:"inspect"},near(C.STATIONS.chest));
  await action({type:"place",pos:C.STATIONS.step,item:"planks"},near(C.STATIONS.step));
  await action({type:"jump",from:{...C.SPAWN,x:30.5,z:22},peak:6.2},{...C.SPAWN,x:30.5,z:19});
  await action({type:"door",pos:C.STATIONS.door},near(C.STATIONS.door));
  await action({type:"door",pos:C.STATIONS.door},near(C.STATIONS.door));
  await action({type:"craft",recipeId:"planks",count:16});
  await action({type:"craft",recipeId:"planks",count:10});
  await action({type:"craft",recipeId:"chest"},near(C.STATIONS.workbench));
  await action({type:"craft",recipeId:"door"},near(C.STATIONS.workbench));
  await action({type:"craft",recipeId:"axe"},near(C.STATIONS.workbench));
  await action({type:"craft",recipeId:"workbench"},near(C.STATIONS.workbench));
  for (const part of ["floor","wall","roof","door","chest"]) for (const cell of C.HOUSE.filter(c=>c.part===part)) {
    await action({type:"place",pos:cell.pos,item:cell.item},near(cell.pos));
  }
  assert.equal(state.house.ready,true);assert.equal(state.state.completedAt,null);
  await action({type:"door",pos:[40,5,19]},near([40,5,19]));
  await action({type:"door",pos:[40,5,19]},near([40,5,19]));
  assert.ok(state.state.completedAt);assert.equal(state.objective.id,"free");
  const date=state.state.completedAt;
  await action({type:"remove",pos:[38,8,15]},near([38,8,15]));
  assert.equal(state.state.completedAt,date);assert.equal(state.house.ready,false);
  const saved=JSON.stringify(state.state);await api("/bootstrap");assert.equal(JSON.stringify(state.state),saved);
  assert.equal(db.prepare("SELECT count(*) AS n FROM world_grants WHERE user_id=? AND grant_key='camp-badge'").get(userId).n,1);
  assert.equal(db.prepare("SELECT sum(exp) AS n FROM reward_events WHERE user_id=?").get(userId).n,emeraldBefore);
  assert.equal(helpers.speakingEligibility(db.prepare("SELECT * FROM users WHERE id=?").get(userId)).qualified,false);
});
