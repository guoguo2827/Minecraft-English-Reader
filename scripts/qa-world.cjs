"use strict";
const { chromium, webkit } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const out = path.resolve(__dirname,"../work/world-qa");
fs.mkdirSync(out,{recursive:true});
const base = process.env.WORLD_QA_URL || "http://127.0.0.1:3137";
const mode = process.env.WORLD_QA_ENGINE || "chromium";
async function inspectPixels(page, bytes) {
  return page.evaluate(async base64 => {
    const img = new Image();img.src=`data:image/png;base64,${base64}`;await img.decode();
    const c=document.createElement("canvas");c.width=img.width;c.height=img.height;
    const ctx=c.getContext("2d");ctx.drawImage(img,0,0);const rgba=ctx.getImageData(0,0,c.width,c.height).data;
    const bins=new Set();let green=0,black=0;
    for(let y=100;y<c.height-100;y+=4)for(let x=Math.floor(c.width*.32);x<c.width-80;x+=4){
      const i=(y*c.width+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];
      bins.add(`${r>>4},${g>>4},${b>>4}`);if(g>r*1.05&&g>b*1.05)green++;if(r+g+b<30)black++;
    }
    return { colors:bins.size, green, black };
  },bytes.toString("base64"));
}
(async()=>{
  const browser=await (mode==="webkit"?webkit:chromium).launch({headless:true,channel:mode==="webkit"?undefined:"chrome",args:process.env.WORLD_QA_SOFTWARE?["--use-angle=swiftshader","--enable-unsafe-swiftshader"]:[]});
  try {
    for(const device of [{name:"desktop",width:1440,height:900,touch:false},{name:"ipad",width:1180,height:820,touch:true},{name:"ipad-small",width:1024,height:768,touch:true}]) {
      if(process.env.WORLD_QA_DEVICE && process.env.WORLD_QA_DEVICE!==device.name)continue;
      console.log("Starting",device.name);
      const context=await browser.newContext({viewport:{width:device.width,height:device.height},hasTouch:device.touch,isMobile:device.touch,deviceScaleFactor:1});
      const login=await context.request.post(`${base}/api/auth/login`,{data:{phone:"13830000000",password:"CampPreview2026!"}});assert.equal(login.status(),200);
      const page=await context.newPage(),errors=[];
      page.on("pageerror",err=>errors.push(err.message));page.on("console",msg=>{if(msg.type()==="error")errors.push(msg.text());});
      page.on("response",async r=>{if(r.url().includes("/api/world/")&&!r.url().includes("/audio/")&&r.status()>=400)console.log("API failure",r.status(),await r.text());});
      // Audio failure is deliberately tested without sending billable Tencent requests.
      await page.route("**/api/world/audio/**",route=>route.fulfill({status:503,contentType:"application/json",body:'{"error":"QA audio unavailable"}'}));
      await page.goto(`${base}/world`);
      await page.locator("#startBtn:not([disabled])").waitFor({timeout:60000});
      console.log("Scene ready",device.name);
      await page.screenshot({path:path.join(out,`${mode}-${device.name}-welcome.png`)});
      await page.locator("#startBtn").click();
      await page.waitForFunction(()=>Number(document.getElementById("worldCanvas").dataset.frames)>30);
      await page.waitForTimeout(500);
      const screen=await page.screenshot({path:path.join(out,`${mode}-${device.name}-camp.png`)});
      const pixels=await inspectPixels(page,screen);assert.ok(pixels.colors>30,JSON.stringify(pixels));assert.ok(pixels.green>200,JSON.stringify(pixels));
      const performanceSample=await page.evaluate(()=>new Promise(resolve=>{
        const start=performance.now();let frames=0;
        const step=()=>{frames++;if(performance.now()-start>=1500)resolve({fps:frames*1000/(performance.now()-start),drawCalls:document.getElementById("worldCanvas").dataset.drawCalls});else requestAnimationFrame(step);};requestAnimationFrame(step);
      }));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.evaluate(()=>document.exitPointerLock?.());
      await page.locator("#learnBtn").click();
      await page.locator("[data-read=block]").click();
      await page.waitForFunction(()=>document.getElementById("saveStatus").textContent.includes("云端已保存")).catch(async error=>{
        await page.screenshot({path:path.join(out,"failure.png")});console.log(await page.locator("body").innerText(),errors);throw error;
      });
      await page.screenshot({path:path.join(out,`${mode}-${device.name}-learn.png`)});
      await page.locator("#beginQuiz").click();
      await page.locator("#quizSpeak").waitFor();
      await page.screenshot({path:path.join(out,`${mode}-${device.name}-quiz.png`)});
      const opts=await page.locator("[data-answer]").evaluateAll(nodes=>nodes.map(n=>({width:n.offsetWidth,height:n.offsetHeight,bottom:n.getBoundingClientRect().bottom})));
      assert.equal(opts.length,4);assert.ok(opts.every(o=>o.height>=44&&o.bottom<device.height));
      await page.locator("#closePanel").click();await page.evaluate(()=>document.exitPointerLock?.());
      const before=await context.request.get(`${base}/api/world/bootstrap`,{maxRetries:2}).then(r=>r.json());
      if(device.touch) {
        const r=await page.locator("#joystick").boundingBox();
        if(mode==="chromium"){
          const cdp=await context.newCDPSession(page),point={x:r.x+r.width/2,y:r.y+r.height/2,id:1};
          await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[point]});
          const movePoint={...point,y:point.y-35},lookPoint={x:device.width*.65,y:device.height*.55,id:2};
          await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[movePoint]});
          await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[movePoint,lookPoint]});
          await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[movePoint,{...lookPoint,x:lookPoint.x+65,y:lookPoint.y-15}]});
          await page.waitForTimeout(800);
          await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});await cdp.detach();
        }else{
          await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();
          await page.mouse.move(r.x+r.width/2,r.y+r.height/2-35);await page.waitForTimeout(800);await page.mouse.up();
        }
      } else { await page.keyboard.down("KeyW");await page.waitForTimeout(800);await page.keyboard.up("KeyW"); }
      await page.keyboard.press("Escape");
      await page.locator("#syncSave").click();await page.waitForFunction(()=>document.getElementById("saveStatus").textContent.includes("云端已保存"));
      const after=await context.request.get(`${base}/api/world/bootstrap`,{maxRetries:2}).then(r=>r.json());
      assert.ok(Object.values(after.state.position).every(Number.isFinite));
      const distance=Math.hypot(after.state.position.x-before.state.position.x,after.state.position.z-before.state.position.z);
      assert.ok(distance>.1,`movement failed ${JSON.stringify({before:before.state.position,after:after.state.position})}`);
      if(device.touch&&mode==="chromium")assert.ok(Math.abs(after.state.position.yaw-before.state.position.yaw)>.1,"two-finger movement and view control must both work");
      // Return to safety so repeated runs start in a deterministic location.
      await page.locator("#respawn").click();
      await page.locator("#panel").waitFor({state:"hidden"});
      const relevant=errors.filter(e=>!e.includes("503")&&!e.includes("pointer lock"));assert.deepEqual(relevant,[]);
      console.log(JSON.stringify({engine:mode,device:device.name,pixels,performanceSample,movement:distance,errors:relevant}));
      await context.close();
    }
    const fallback=await browser.newContext();
    await fallback.request.post(`${base}/api/auth/login`,{data:{phone:"13830000000",password:"CampPreview2026!"}});
    const page=await fallback.newPage();await page.addInitScript(()=>{
      const original=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(type,...args){return type==="webgl2"?null:original.call(this,type,...args);};
    });
    await page.goto(`${base}/world`);await page.waitForFunction(()=>document.getElementById("welcomeStatus").textContent.includes("WebGL2"));
    assert.equal(await page.locator("#startBtn").isDisabled(),true);assert.equal(await page.locator(".welcome-back").isVisible(),true);
    console.log("PASS: unavailable WebGL2 keeps a working return-to-learning entry");await fallback.close();
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
