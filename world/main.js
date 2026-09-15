import { createIcons, Blocks, Volume2, VolumeX, Pause, CloudCheck, BookOpen, ArrowUpRight, ChevronDown, MapPin, Scan, Hammer, Backpack, ArrowUp, Hand, Pickaxe, Play, X, RotateCcw, Award, PackageCheck, Package, ArrowRight, Headphones, BadgeCheck, Plus, LockKeyhole, CloudUpload, Box, TreePine, Axe, Archive, DoorOpen, DoorClosed, Layers } from "lucide";
import C from "../lib/world-content.js";
import { CampScene } from "./scene.js";
import { itemSprite } from "./art.js";

const $ = id => document.getElementById(id);
const icon = name => `<i data-lucide="${name}"></i>`;
const icons = { Blocks, Volume2, VolumeX, Pause, CloudCheck, BookOpen, ArrowUpRight, ChevronDown, MapPin, Scan, Hammer, Backpack, ArrowUp, Hand, Pickaxe, Play, X, RotateCcw, Award, PackageCheck, Package, ArrowRight, Headphones, BadgeCheck, Plus, LockKeyhole, CloudUpload, Box, TreePine, Axe, Archive, DoorOpen, DoorClosed, Layers };
const paintIcons = () => createIcons({ icons, attrs: { "aria-hidden": "true", "stroke-width": 1.8 } });
const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isTouch = matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 1;
let camp, snapshot, phrases = [], started = false, selected = "planks", guided = true;
let busy = false, pending = null, disconnected = false, panelKind = "", epoch = 0;
let quizTimer, speechTimer, toastTimer, lastCheckpoint = "", lastObjective = "", learningGroup = "materials";
let currentQuestion = null, answerLocked = false, completedShown = false;
const audio = new Audio();
audio.preload = "auto";
let audioTicket = 0, muted = false;
const objectiveAudio = () => snapshot.objective.wordId ? `word-${snapshot.objective.wordId}` : `phrase-${snapshot.objective.phraseId}`;

function toast(message) {
  if (!message) return;
  $("toast").textContent = message; $("toast").hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2800);
}
function saveStatus(message, saving = false) {
  $("saveStatus").querySelector("span").textContent = message;
  $("saveStatus").classList.toggle("saving", saving);
}
function stopAudio() {
  audioTicket++; audio.pause(); audio.removeAttribute("src"); audio.load(); clearTimeout(speechTimer);
}
function setAudioStatus(message) {
  $("audioStatus").textContent = message;
  if ($("panel").open && /^(learn|quiz)/.test(panelKind)) {
    let status = $("panelAudioStatus");
    if (!status) {
      status = document.createElement("p"); status.id = "panelAudioStatus";
      status.className = "audio-status"; status.setAttribute("role", "status"); $("panelBody").appendChild(status);
    }
    status.textContent = message;
  }
}
async function speak(id) {
  stopAudio();
  if (muted || document.hidden || disconnected) return;
  const ticket = audioTicket;
  setAudioStatus("正在准备标准音...");
  // Start play in the click's activation context; fetching a Blob first loses it on Safari.
  audio.src = `/api/world/audio/${encodeURIComponent(id)}`;
  const timeout = setTimeout(() => {
    if (ticket === audioTicket) {
      audio.pause(); audio.removeAttribute("src"); audio.load();
      setAudioStatus("语音未播放，可看字幕并点击喇叭重试");
    }
  }, 20000);
  try {
    await audio.play();
    if (ticket === audioTicket) setAudioStatus("");
  } catch (error) {
    if (ticket === audioTicket) setAudioStatus("语音未播放，可看字幕并点击喇叭重试");
  } finally { clearTimeout(timeout); }
}
async function request(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/world${path}`, {
      method: body ? "POST" : "GET", credentials: "same-origin", signal: controller.signal,
      headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) location.assign("/login?next=%2Fworld");
      const error = new Error(data.error || "营地暂时无法连接");
      Object.assign(error, { status: response.status, code: data.code }); throw error;
    }
    return data;
  } finally { clearTimeout(timeout); }
}
function setDisconnected(message = "连接中断，改动尚未确认") {
  disconnected = true; camp?.setActive(false); cancelTasks();
  $("networkBanner").hidden = false; $("networkBanner").querySelector("span").textContent = message;
  positionNetworkBanner();
  saveStatus("等待确认", true);
}
function positionNetworkBanner() {
  const inPanel = $("panel").open;
  $("networkBanner").classList.toggle("in-panel", inPanel);
  if (inPanel) $("panel").insertBefore($("networkBanner"), $("panelBody"));
  else $("camp").appendChild($("networkBanner"));
}
function applySnapshot(data, restorePosition = false) {
  if (data.phrases) phrases = data.phrases;
  const oldGrants = snapshot?.state.grants || [];
  snapshot = data; camp?.setState(data, { restorePosition }); render();
  saveStatus("云端已保存");
  if (started) for (const grant of data.state.grants.filter(g => !oldGrants.includes(g))) {
    const group = C.GROUPS.find(g => g.id === grant);
    if (group) toast(`${group.title}完成！${Object.entries(group.reward).map(([id,n]) => `+${n} ${C.ITEMS[id].name}`).join("、")}`);
  }
  if (lastObjective && lastObjective !== data.objective.id && started && !$("panel").open) {
    speechTimer = setTimeout(() => speak(objectiveAudio()), 700);
  }
  lastObjective = data.objective.id;
  if (started && data.state.completedAt && !completedShown) showCompletion();
}
// Only one uncertain mutation is retained; its ID survives retries and version resyncs.
async function commit(path, command, { quiet = false } = {}) {
  if (busy || pending || disconnected || !snapshot) return null;
  pending = { path, body: { ...command, version: snapshot.version }, quiet };
  if (path === "/actions") Object.assign(pending.body, { operationId: crypto.randomUUID(), position: camp.getPosition() });
  return flushPending();
}
async function flushPending() {
  if (!pending || busy) return null;
  busy = true; const operation = pending; saveStatus("正在保存", true);
  try {
    let data;
    try { data = await request(operation.path, operation.body); }
    catch (error) {
      if (error.code !== "WORLD_VERSION_CONFLICT") throw error;
      const fresh = await request("/bootstrap");
      applySnapshot(fresh, true); operation.body.version = fresh.version;
      toast("已同步其他窗口的最新进度");
      data = await request(operation.path, operation.body);
    }
    pending = null; disconnected = false; $("networkBanner").hidden = true;
    applySnapshot(data, operation.body.type === "respawn");
    if (!operation.quiet) toast(data.result?.message);
    return data;
  } catch (error) {
    if (!error.status || error.status >= 500) setDisconnected();
    else {
      pending = null; saveStatus("操作未保存"); toast(error.message);
      if (error.status === 403 || error.status === 401) setDisconnected(error.message);
    }
    return null;
  } finally { busy = false; }
}
async function reconnect() {
  if (busy) return;
  $("retryNetwork").disabled = true;
  try {
    const recovered = pending ? await flushPending() : null;
    if (pending) return;
    applySnapshot(await request("/bootstrap"), true);
    disconnected = false; $("networkBanner").hidden = true;
    if (recovered && panelKind === "quiz") showLearning(learningGroup);
    else if (started && !$("panel").open && !document.hidden) camp.setActive(true);
    if (panelKind === "quiz" && !recovered) showLearning(learningGroup);
    toast("已重新连接，进度已同步");
  } catch (error) { setDisconnected(error.message); }
  finally { $("retryNetwork").disabled = false; }
}
function render() {
  if (!snapshot) return;
  const { state, objective, house } = snapshot;
  $("questTitle").textContent = objective.title; $("questDetail").textContent = objective.detail;
  $("wordCount").innerHTML = `${state.learned.length} <small>/ 8</small>`;
  $("wordDots").innerHTML = C.WORDS.map(w => `<span class="${state.learned.includes(w.id) ? "done" : ""}" title="${w.word}"></span>`).join("");
  $("badgeCount").innerHTML = state.completedAt ? icon("award") : "";
  const phrase = phrases.find(p => p.id === objective.phraseId);
  const word = C.WORDS.find(w => w.id === objective.wordId);
  $("phraseText").textContent = phrase?.english || word?.word || "Place the block.";
  $("phraseChinese").textContent = phrase?.chinese || word?.cn || "放置方块。";
  $("houseProgress").hidden = !state.recipesUnlocked;
  $("houseProgress").innerHTML = `<span>我的小屋 <strong>${house.placed} / ${house.total}</strong></span><progress value="${house.placed}" max="${house.total}"></progress>`;
  $("hotbar").innerHTML = Object.entries(C.ITEMS).map(([id,item], index) => `<button class="slot ${id === selected ? "selected" : ""}" data-item="${id}" title="${item.name}" aria-label="${item.name} ${state.inventory[id]}" aria-pressed="${id === selected}"><small>${index+1}</small><img src="${itemSprite(id)}" alt=""><b>${state.inventory[id]}</b></button>`).join("");
  $("selectionLabel").innerHTML = `${C.ITEMS[selected].name} <span>${C.ITEMS[selected].english.toUpperCase()}</span>`;
  paintIcons();
}
function cancelTasks() { epoch++; clearTimeout(quizTimer); stopAudio(); }
function openPanel(kind, title, html, kicker = "ENGLISH CAMP") {
  cancelTasks(); panelKind = kind; camp?.setActive(false);
  $("panelTitle").textContent = title; $("panelKicker").textContent = kicker;
  $("panelBody").innerHTML = html;
  if (!$("panel").open) $("panel").showModal();
  positionNetworkBanner();
  paintIcons();
}
function closePanel() {
  cancelTasks(); $("panel").close(); panelKind = "";
  positionNetworkBanner();
  if (started && !disconnected && !document.hidden) camp.setActive(true);
}
function showLearning(groupId = snapshot.objective.learn || learningGroup) {
  learningGroup = groupId;
  const group = C.GROUPS.find(g => g.id === groupId) || C.GROUPS[0];
  const words = snapshot.words.filter(w => group.words.includes(w.id));
  openPanel("learn", group.title, `
    <div class="group-tabs">${C.GROUPS.map((g,i) => `<button data-group="${g.id}" class="${g.id === group.id ? "active" : ""}">${i+1}. ${g.title}${snapshot.state.grants.includes(g.id) ? " ✓" : ""}</button>`).join("")}</div>
    <div class="learn-grid">${words.map(w => `<button class="learn-word" data-read="${w.id}"><span class="learn-illustration">${icon(w.icon)}</span><strong>${w.word}</strong><span>${w.cn}</span><small>${w.mastered ? "已掌握" : w.reviewing ? `复习中，还需答对 ${w.reviewRemaining} 次` : "未掌握"}</small>${icon("volume-2")}</button>`).join("")}</div>
    <div class="grant-note">${icon(snapshot.state.grants.includes(group.id) ? "package-check" : "package")}<span>${snapshot.state.grants.includes(group.id) ? "本单元材料已领取，复习不会收回" : `掌握这两个词，获得 ${Object.entries(group.reward).map(([id,n]) => `${n} 块${C.ITEMS[id].name}`).join("、")}`}</span></div>
    <button id="beginQuiz" class="primary wide">${icon("headphones")}听音挑战${icon("arrow-right")}</button>`);
  $("panelBody").querySelectorAll("[data-group]").forEach(b => b.onclick = () => showLearning(b.dataset.group));
  $("panelBody").querySelectorAll("[data-read]").forEach(b => b.onclick = () => {
    speak(`word-${b.dataset.read}`); commit("/actions", { type: "read", wordId: b.dataset.read }, { quiet: true });
  });
  $("beginQuiz").onclick = () => nextQuestion();
}
async function nextQuestion(repeat = false) {
  if (busy || disconnected) { toast("请先等待当前操作确认"); return; }
  const group = C.GROUPS.find(g => g.id === learningGroup);
  const candidate = group.words.find(id => !snapshot.words.find(w => w.id === id).mastered);
  if (!candidate && !repeat) {
    openPanel("unit-complete", "这一组学会了！", `<div class="unit-complete">${icon("badge-check")}<h3>${group.title}完成</h3><p>材料已放进背包，回到营地试试吧。</p><button id="backCamp" class="primary wide">${icon("arrow-right")}回到营地</button><button id="reviewAgain" class="text-btn">再复习一次</button></div>`);
    $("backCamp").onclick = closePanel; $("reviewAgain").onclick = () => nextQuestion(true); return;
  }
  openPanel("quiz-loading", "听音挑战", '<p class="loading-copy">正在准备题目...</p>');
  const token = epoch;
  try {
    const question = await request("/learning/next", { wordId: candidate || group.words[0] });
    if (token !== epoch || !$("panel").open) return;
    currentQuestion = question; answerLocked = false; panelKind = "quiz";
    const word = C.WORDS.find(w => w.id === question.wordId);
    $("panelBody").innerHTML = `<div class="quiz-prompt"><button id="quizSpeak" class="sound-orb" title="重播单词" aria-label="重播单词">${icon("volume-2")}</button><h3>${word.word}</h3></div><div class="quiz-options">${question.options.map(o => `<button data-answer="${escape(o.value)}">${icon(o.icon)}<span>${o.value}</span></button>`).join("")}</div><p id="quizFeedback" class="quiz-feedback" role="status">听一听，选出它的意思</p><button id="quizNext" class="primary wide" hidden>下一题${icon("arrow-right")}</button>`;
    paintIcons(); $("quizSpeak").onclick = () => speak(`word-${word.id}`);
    $("panelBody").querySelectorAll("[data-answer]").forEach(b => b.onclick = () => submitAnswer(b.dataset.answer));
    $("quizNext").onclick = () => nextQuestion();
    speechTimer = setTimeout(() => { if (token === epoch) speak(`word-${word.id}`); }, 1500);
  } catch (error) {
    if (token !== epoch) return;
    openPanel("quiz-error", "题目没有加载完成", '<p>当前学习进度已经保留。</p><button id="retryQuestion" class="primary wide">重新取题</button>');
    $("retryQuestion").onclick = () => nextQuestion();
  }
}
async function submitAnswer(selectedAnswer) {
  if (answerLocked || busy || disconnected) return;
  answerLocked = true; stopAudio(); const token = epoch;
  $("panelBody").querySelectorAll("[data-answer]").forEach(b => { b.disabled = true; });
  $("quizFeedback").textContent = "正在确认答案...";
  const data = await commit("/learning/answer", { questionId: currentQuestion.id, selected: selectedAnswer }, { quiet: true });
  if (token !== epoch || panelKind !== "quiz") return;
  if (!data) {
    answerLocked = Boolean(pending);
    $("quizFeedback").textContent = pending ? "答案尚未确认，请重新连接" : "答案没有提交成功，请重试";
    $("panelBody").querySelectorAll("[data-answer]").forEach(b => { b.disabled = answerLocked; }); return;
  }
  const result = data.result;
  $("panelBody").querySelectorAll("[data-answer]").forEach(b => {
    b.classList.toggle("correct", b.dataset.answer === result.correctCn);
    b.classList.toggle("wrong", b.dataset.answer === selectedAnswer && !result.correct);
  });
  const labels = (result.events || []).filter(e => e.label).map(e => e.label).join("；");
  $("quizFeedback").textContent = result.correct ? `答对了！${labels || "又向前进了一步"}` : `正确答案是：${result.correctCn}。再听一次，下次会更好。`;
  $("quizFeedback").classList.toggle("success", result.correct);
  if (result.correct) quizTimer = setTimeout(() => { if (token === epoch) nextQuestion(); }, 1000);
  else { $("quizNext").hidden = false; speak(`word-${currentQuestion.wordId}`); }
}
function showCraft() {
  openPanel("craft", "营地工作台", `<div class="craft-list">${C.RECIPES.map(r => {
    const locked = !r.starter && !snapshot.state.recipesUnlocked;
    const enough = Object.entries(r.costs).every(([id,n]) => snapshot.state.inventory[id] >= n);
    return `<div class="craft-row"><img src="${itemSprite(r.id)}" alt=""><div><h3>${C.ITEMS[r.id].name} <small>×${r.count}</small></h3><p>${Object.entries(r.costs).map(([id,n]) => `${C.ITEMS[id].name} ${n}`).join(" + ")}</p></div><button class="icon-btn" data-craft="${r.id}" ${locked || !enough ? "disabled" : ""} title="${locked ? "掌握8词后解锁" : !enough ? "材料不足" : "合成"}" aria-label="合成${C.ITEMS[r.id].name}">${icon(locked ? "lock-keyhole" : "plus")}</button></div>`;
  }).join("")}</div><p class="craft-note">橡木 ${snapshot.state.inventory.oak} · 木板 ${snapshot.state.inventory.planks}${snapshot.state.recipesUnlocked ? "" : " · 营地8词通关后解锁更多配方"}</p>`);
  $("panelBody").querySelectorAll("[data-craft]").forEach(b => b.onclick = async () => {
    b.disabled = true; const data = await commit("/actions", { type: "craft", recipeId: b.dataset.craft });
    if (panelKind === "craft") { if (data) showCraft(); else b.disabled = false; }
  });
}
function showInventory() {
  openPanel("inventory", "我的背包", `<div class="inventory-grid">${Object.entries(C.ITEMS).map(([id,item]) => `<div><img src="${itemSprite(id)}" alt=""><strong>${item.name}</strong><span>${snapshot.state.inventory[id]}</span></div>`).join("")}</div><div class="grant-note">${icon("award")}<span>${snapshot.state.completedAt ? "营地建造师徽章 · 已获得" : "营地建造师徽章 · 等待你建成小屋"}</span></div>`);
}
function showPause() {
  if (!started) return;
  openPanel("pause", "营地已暂停", `<div class="pause-actions"><button id="resume" class="primary">${icon("play")}继续建造</button><button id="pauseLearn" class="secondary">${icon("book-open")}营地单词</button><button id="pauseCraft" class="secondary">${icon("hammer")}合成配方</button><button id="respawn" class="secondary">${icon("map-pin")}回到安全点</button><button id="syncSave" class="secondary">${icon("cloud-upload")}保存当前位置</button><a href="/">返回英语学习</a></div>`);
  $("resume").onclick = closePanel;
  $("pauseLearn").onclick = () => showLearning(); $("pauseCraft").onclick = showCraft;
  $("respawn").onclick = async () => { if (await commit("/actions", { type: "respawn" })) closePanel(); };
  $("syncSave").onclick = () => commit("/actions", { type: "checkpoint" });
}
function showCompletion() {
  completedShown = true;
  openPanel("complete", "营地建造师", `<div class="completion"><img class="house-memory" src="${camp.captureHouse()}" alt="你亲手搭建的营地小屋"><span class="eyebrow">${icon("award")}CHAPTER COMPLETE</span><h3>This is my house.</h3><p>8个单词，一座属于你的小屋。营地徽章已永久保存。</p><button id="keepBuilding" class="primary wide">${icon("hammer")}继续自由搭建</button></div>`);
  $("keepBuilding").onclick = closePanel; speak("phrase-9");
}
function describeTarget(target) {
  const tip = $("targetTip");
  tip.hidden = !target || !started || Boolean(panelKind);
  if (!target) return;
  const names = { resource: "采集 oak", guide: `放置 ${C.ITEMS[target.item]?.name || "木板"}`, borrow: "领取教学木斧", inspect: "查看营地箱子", door: "开 / 关门", craft: "打开工作台" };
  tip.textContent = names[target.action] || names[target.kind] || (target.type === "workbench" ? "打开工作台" : `使用 ${C.ITEMS[selected].name}`);
}
async function interact(remove = false) {
  if (!started || panelKind || busy || disconnected) return;
  const target = camp.targetAtCenter();
  if (!target) { toast("走近一些，把准星对准方块或物品"); return; }
  if (remove) return commit("/actions", { type: "remove", pos: target.pos });
  if (target.kind === "resource") return commit("/actions", { type: "harvest", nodeId: target.nodeId });
  if (target.action === "borrow") return commit("/actions", { type: "borrow" });
  if (target.action === "inspect") return commit("/actions", { type: "inspect" });
  if (target.type === "door") return commit("/actions", { type: "door", pos: target.pos });
  if (target.type === "workbench") return showCraft();
  if (target.type === "chest") return showInventory();
  const item = target.kind === "guide" ? target.item : selected;
  if (item === "axe") { toast("对准橡木采集点使用木斧"); return; }
  if (!snapshot.state.inventory[item]) { toast(`背包里没有${C.ITEMS[item].name}，先学习、采集或合成吧`); return; }
  return commit("/actions", { type: "place", item, pos: target.kind === "guide" ? target.pos : target.place });
}

$("learnBtn").onclick = () => showLearning();
$("craftBtn").onclick = showCraft; $("inventoryBtn").onclick = showInventory;
$("pauseBtn").onclick = showPause; $("closePanel").onclick = closePanel;
$("panel").addEventListener("cancel", e => { e.preventDefault(); closePanel(); });
$("retryNetwork").onclick = reconnect;
$("translationBtn").onclick = () => { $("phraseChinese").hidden = !$("phraseChinese").hidden; };
$("speakBtn").onclick = () => speak(objectiveAudio());
$("muteBtn").onclick = () => {
  muted = !muted; stopAudio(); $("muteBtn").innerHTML = icon(muted ? "volume-x" : "volume-2");
  $("muteBtn").title = muted ? "开启标准音" : "关闭标准音"; $("muteBtn").setAttribute("aria-label", $("muteBtn").title); paintIcons();
};
$("guideBtn").onclick = () => { guided = !guided; camp.setGuide(guided); $("guideBtn").classList.toggle("active", guided); $("guideBtn").setAttribute("aria-pressed", guided); };
$("hotbar").onclick = e => { const b = e.target.closest("[data-item]"); if (b) { selected = b.dataset.item; render(); } };
$("jumpBtn").onclick = () => camp.jump(); $("useBtn").onclick = () => interact(); $("removeBtn").onclick = () => interact(true);
const joystick = $("joystick");
function dragJoystick(e) {
  const r = joystick.getBoundingClientRect(), dx = (e.clientX-r.x-r.width/2)/(r.width*.34), dy = (e.clientY-r.y-r.height/2)/(r.height*.34);
  const length = Math.max(1, Math.hypot(dx,dy));
  camp.joystick = { x: dx/length, z: dy/length };
  $("joystickKnob").style.transform = `translate(${dx/length*34}px,${dy/length*34}px)`;
}
joystick.onpointerdown = e => { e.preventDefault(); joystick.setPointerCapture(e.pointerId); dragJoystick(e); };
joystick.onpointermove = e => { if (joystick.hasPointerCapture(e.pointerId)) dragJoystick(e); };
for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) joystick.addEventListener(name, () => { if (camp) camp.joystick = { x: 0, z: 0 }; $("joystickKnob").style.transform = ""; });
document.addEventListener("keydown", e => {
  if (e.code === "Escape" && !$("panel").open) { e.preventDefault(); showPause(); }
  if (!panelKind && /^Digit[1-6]$/.test(e.code)) { selected = Object.keys(C.ITEMS)[Number(e.code.slice(-1))-1]; render(); }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (started) showPause(); cancelTasks(); camp?.setActive(false); }
});
window.addEventListener("offline", () => setDisconnected("网络已断开，已确认的进度仍在云端"));
window.addEventListener("online", reconnect);
window.addEventListener("pagehide", () => { cancelTasks(); camp?.setActive(false); });
setInterval(() => {
  if (!started || busy || pending || disconnected || document.hidden || panelKind) return;
  const p = camp.getPosition(), fingerprint = [p.x,p.y,p.z,p.yaw,p.pitch].map(v => v.toFixed(1)).join();
  if (lastCheckpoint !== fingerprint) { lastCheckpoint = fingerprint; commit("/actions", { type: "checkpoint" }, { quiet: true }); }
}, 10000);
setInterval(() => {
  if (!camp || !snapshot || !started) return;
  const p = camp.getPosition(); $("compass").textContent = ["N","W","S","E"][((Math.round(p.yaw/(Math.PI/2))%4)+4)%4];
  const target = snapshot.objective.target;
  $("waypoint").hidden = !target || Boolean(panelKind);
  if (target) $("waypoint").querySelector("span").textContent = `${snapshot.objective.title} · ${Math.round(Math.hypot(p.x-target[0],p.z-target[2]))}m`;
}, 500);
$("worldCanvas").addEventListener("webglcontextlost", event => { event.preventDefault(); if (started) showPause(); setDisconnected("画面资源已暂停，请刷新恢复营地"); });
$("startBtn").onclick = () => {
  started = true; completedShown = Boolean(snapshot.state.completedAt); $("welcome").hidden = true;
  for (const id of ["questPanel", "sideTools", "bottomBar"]) $(id).hidden = false;
  $("touchControls").hidden = !isTouch;
  camp.setActive(true); speak(objectiveAudio());
};

async function init() {
  paintIcons();
  try {
    const data = await request("/bootstrap");
    camp = new CampScene($("worldCanvas"), {
      onTarget: describeTarget, onInteract: () => interact(), onRemove: () => interact(true), onPause: showPause,
      onJump: jump => {
        if (snapshot?.state.tasks.step && !snapshot.state.tasks.jump && Math.hypot(jump.from.x-30.5,jump.from.z-20.5) < 3.5)
          commit("/actions", { type: "jump", from: jump.from, peak: jump.peak }, { quiet: true });
      }
    });
    await camp.init(); applySnapshot(data, true);
    $("welcomeStatus").textContent = "修好小桥，学会8个单词，建成属于你的小屋。";
    $("startBtn").disabled = false;
  } catch (error) {
    $("welcomeStatus").textContent = error.status ? error.message : "营地未能加载，请检查网络与 WebGL2 支持后刷新重试";
    saveStatus("尚未进入营地"); console.warn("Camp initialization:", error.message);
  }
}
init();
