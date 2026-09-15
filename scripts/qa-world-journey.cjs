"use strict";
const {chromium}=require("@playwright/test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const path=require("node:path");
const C=require("../lib/world-content");
const {createAccount}=require("./world-qa-fixture.cjs");
const base="http://127.0.0.1:3137",out=path.resolve(__dirname,"../work/world-qa");
const near=pos=>({x:pos[0]+2.5,y:Math.max(4.95,pos[1]+.95),z:pos[2]+2.5,yaw:0,pitch:0});
(async()=>{
  const browser=await chromium.launch({channel:"chrome",headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    await context.request.post(`${base}/api/auth/login`,{data:createAccount(base)});
    const get=()=>context.request.get(`${base}/api/world/bootstrap`,{maxRetries:2}).then(r=>r.json());
    const post=async(route,data)=>{
      const r=await context.request.post(`${base}/api/world${route}`,{data,maxRetries:2});
      const body=await r.json();assert.equal(r.status(),200,JSON.stringify(body));return body;
    };
    const action=async(command,position=C.SPAWN)=>post("/actions",{operationId:crypto.randomUUID(),version:(await get()).version,position,...command});
    for(const word of C.WORDS){const q=await post("/learning/next",{wordId:word.id});await post("/learning/answer",{questionId:q.id,selected:word.cn,version:(await get()).version});}
    for(const pos of C.BRIDGE)await action({type:"place",item:"planks",pos},near(pos));
    await action({type:"borrow"},near(C.STATIONS.axe));
    for(let nodeId=0;nodeId<6;nodeId++)await action({type:"harvest",nodeId},near(C.RESOURCES[nodeId]));
    await action({type:"inspect"},near(C.STATIONS.chest));
    await action({type:"place",item:"planks",pos:C.STATIONS.step},near(C.STATIONS.step));
    const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.route("**/api/world/audio/**",r=>r.fulfill({status:503,contentType:"application/json",body:'{"error":"QA no TTS"}'}));
    const enter=async position=>{
      if(page.url().includes("/world"))await page.locator("#pauseBtn").click();
      await action({type:"checkpoint"},position);await page.goto(`${base}/world`);
      await page.locator("#startBtn:not([disabled])").waitFor({timeout:60000});await page.locator("#startBtn").click();await page.waitForTimeout(250);
    };
    const use=async type=>{
      const response=page.waitForResponse(r=>r.url().endsWith("/actions")&&r.request().postDataJSON()?.type===type);
      await page.keyboard.press("KeyE");const r=await response,body=await r.json();assert.equal(r.status(),200,JSON.stringify(body));return body;
    };
    await enter({...C.SPAWN,x:21.5,y:4.95,z:24.2,pitch:-.12});
    await page.keyboard.down("KeyW");await page.waitForTimeout(1000);await page.keyboard.up("KeyW");
    await page.locator("#pauseBtn").click();await page.locator("#syncSave").click();await page.waitForFunction(()=>document.getElementById("saveStatus").textContent.includes("云端已保存"));
    const stopped=await get();assert.ok(stopped.state.position.z>21.7&&stopped.state.position.z<22.5,JSON.stringify(stopped.state.position));
    await page.locator("#closePanel").click();await use("door");
    await page.keyboard.down("KeyW");await page.waitForTimeout(800);await page.keyboard.up("KeyW");
    await page.locator("#pauseBtn").click();await page.locator("#syncSave").click();await page.waitForFunction(()=>document.getElementById("saveStatus").textContent.includes("云端已保存"));
    const inside=await get();assert.ok(inside.state.position.z<20.8,JSON.stringify(inside.state.position));
    await page.screenshot({path:path.join(out,"door-collision.png")});await page.locator("#closePanel").click();
    await action({type:"door",pos:C.STATIONS.door},near(C.STATIONS.door));
    console.log("PASS: closed door blocks movement; open door permits entering the cabin");

    await enter({...C.SPAWN,x:30.5,z:22.4,pitch:0});
    const jumpResponse=page.waitForResponse(r=>r.url().endsWith("/actions")&&r.request().postDataJSON()?.type==="jump");
    await page.keyboard.down("KeyW");await page.keyboard.press("Space");await page.waitForTimeout(950);await page.keyboard.up("KeyW");
    const jr=await jumpResponse;assert.equal(jr.status(),200,await jr.text());assert.equal((await get()).state.tasks.jump,true);
    await page.locator("#pauseBtn").click();
    console.log("PASS: Rapier jump crosses the training step and completes the sentence task");

    await action({type:"craft",recipeId:"planks",count:16});await action({type:"craft",recipeId:"planks",count:10});
    await action({type:"craft",recipeId:"chest"},near(C.STATIONS.workbench));await action({type:"craft",recipeId:"door"},near(C.STATIONS.workbench));
    for(const part of ["floor","wall","roof","door"])for(const cell of C.HOUSE.filter(c=>c.part===part))await action({type:"place",pos:cell.pos,item:cell.item},near(cell.pos));
    await page.locator("#closePanel").click();
    await enter({...C.SPAWN,x:40.5,y:5.9,z:18.5,yaw:.4636,pitch:-.43});
    const placed=await use("place");assert.equal(placed.house.ready,true);
    await enter({...C.SPAWN,x:40.5,y:5.9,z:17.5,yaw:Math.PI,pitch:-.15});
    await use("door");await use("door");
    await page.locator("#keepBuilding").waitFor();
    assert.ok(await page.locator(".house-memory").evaluate(img=>img.complete&&img.naturalWidth>0));
    await page.screenshot({path:path.join(out,"camp-completed.png")});
    assert.ok((await get()).state.completedAt);await page.locator("#keepBuilding").click();
    await page.screenshot({path:path.join(out,"free-build.png")});assert.deepEqual(errors,[]);
    console.log("PASS: final blueprint placement, house-door tasks, rendered house souvenir and permanent badge");
    await context.close();
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
