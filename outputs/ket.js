"use strict";
(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = name => `<i data-lucide="${name}"></i>`;
  const icons = () => window.lucide?.createIcons();
  const stateNames = { new: "还未认识", learning: "学习中", mastered: "已掌握", strengthen: "需巩固" };
  let catalog, report, session, view = "study", epoch = 0, timer, speechTimer, pending = false, retryAction, selectedWord;
  const mobile = window.matchMedia("(max-width: 760px)");
  let sidebarOpen = false;
  let audio = new Audio(), audioRequest, audioUrl, audioEpoch = 0;
  function notice(message = "", action) {
    retryAction = action;
    $("#message").hidden = !message;
    $("#message").innerHTML = `${esc(message)}${action ? ' <button class="text-button" id="retryBtn">重试</button>' : ""}`;
    $("#retryBtn")?.addEventListener("click", () => retryAction?.());
  }
  async function api(path, body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/ket${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      const data = await response.json();
      if (response.status === 401) { location.assign("/login?next=%2Fket"); throw new Error("请先登录"); }
      if (data.code === "PASSWORD_RESET_REQUIRED") location.assign("/reset-password?next=%2Fket");
      if (!response.ok) throw Object.assign(new Error(data.error || "暂时无法连接，请重试"), { status: response.status });
      return data;
    } finally { clearTimeout(timeout); }
  }
  function stopAudio() {
    audioEpoch++; audioRequest?.abort(); audio.pause(); audio.removeAttribute("src"); audio.load();
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  }
  function cancelTasks() { epoch++; clearTimeout(timer); clearTimeout(speechTimer); stopAudio(); }
  async function speak(wordId, part = "word") {
    clearTimeout(speechTimer);
    stopAudio(); const token = audioEpoch;
    audioRequest = new AbortController();
    $("#voiceStatus").textContent = "正在准备标准音…";
    const request = audioRequest;
    const timeout = setTimeout(() => { request.abort(); if (token === audioEpoch) audio.pause(); }, 15000);
    try {
      const url = `/api/ket/audio/${encodeURIComponent(wordId)}?part=${part}`;
      // Call play synchronously in the click gesture before trying the blob fallback.
      audio.src = url;
      try {
        await audio.play();
        if (token === audioEpoch) $("#voiceStatus").textContent = "正在播放标准音";
        return;
      } catch { if (token !== audioEpoch || document.hidden) return; }
      const response = await fetch(url, { signal: request.signal });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("audio/")) throw new Error("audio");
      const blob = await response.blob();
      if (token !== audioEpoch || document.hidden) return;
      audioUrl = URL.createObjectURL(blob); audio.src = audioUrl;
      await audio.play();
      if (token === audioEpoch) $("#voiceStatus").textContent = "正在播放标准音";
    } catch {
      if (token === audioEpoch) $("#voiceStatus").textContent = "语音未播放，请点喇叭重试";
    } finally { clearTimeout(timeout); }
  }
  audio.addEventListener("ended", () => { $("#voiceStatus").textContent = "标准音已准备"; });
  new MutationObserver(() => {
    const message = $("#voiceStatus").textContent;
    $("#studyVoiceStatus").textContent = message;
    $("#studyVoiceStatus").hidden = !message.includes("未播放");
  }).observe($("#voiceStatus"), { childList: true });
  function metric(label, value, symbol) { return `<div class="metric"><span class="metric-icon">${icon(symbol)}</span><div><strong>${esc(value)}</strong><small>${esc(label)}</small></div></div>`; }
  function unitTile(unit) {
    const mastered = unit.words.filter(w => w.status === "mastered").length;
    return `<button class="route-unit" data-unit="${unit.id}"><img src="${unit.words[0].image}" width="30" height="30" loading="lazy" alt=""><span><strong>${esc(unit.title)}</strong><small>${unit.locked ? "完整课程开放" : `${mastered} / 10 词已掌握`}</small></span>${unit.locked ? icon("lock-keyhole") : `<span class="route-number">${String(unit.number).padStart(2, "0")}</span>`}</button>`;
  }
  function renderSidebar() {
    $("#courseCount").textContent = `KET1500 · 已上线 ${catalog.published} 词`;
    $("#taskDescription").textContent = `今日安排新词 ${report.newToday} / ${report.dailyNew} · ${report.dueWords} 个词待复习`;
    $("#startBtn span").textContent = report.activeSession ? "继续学习" : "今日学习";
    $("#dailyNew").value = report.dailyNew;
    $("#sidebarMastered").textContent = `${report.mastery}%`;
    $("#sidebarProgress").value = report.mastery;
    $("#sidebarStats").innerHTML = `<span><strong>${report.learned}</strong>已认识</span><span><strong>${report.mastered}</strong>已掌握</span><span><strong>${report.dueWords}</strong>待复习</span>`;
    $("#sidebarUnits").innerHTML = catalog.units.map(unitTile).join("");
    $("#sidebarUnitCount").textContent = `${catalog.units.length} 单元`;
    if (session?.question) $("#studyUnit").textContent = catalog.units.find(u => u.words.some(w => w.id === session.question.wordId))?.title || "";
    markCurrentUnit();
    icons();
  }
  function renderLibrary() {
    const selected = $("#unitFilter").value, filter = $("#statusFilter").value, search = $("#wordSearch").value.trim().toLowerCase();
    $("#libraryWords").innerHTML = catalog.units.filter(u => selected === "all" || u.id === selected).map(unit => {
      const words = unit.words.filter(w => (filter === "all" || (filter === "due" ? w.due : w.status === filter)) && `${w.word} ${w.meaning}`.toLowerCase().includes(search));
      if (!words.length) return "";
      return `<section><div class="section-heading"><h2>${esc(unit.title)}</h2>${unit.locked ? '<span class="locked">完整课程开放</span>' : `<button class="text-button" data-practice="${unit.id}">${icon("rotate-ccw")}自由练习</button>`}</div><div class="word-grid">${words.map(w => `<button class="word-tile" data-word="${w.id}" ${unit.locked ? 'disabled title="需要完整英语课程资格"' : ""}><img src="${w.image}" alt="" loading="lazy" width="64" height="64"><strong>${esc(w.word)}</strong><span>${esc(w.meaning)}</span><small>${w.due ? "待复习 · " : ""}${stateNames[w.status]}</small></button>`).join("")}</div></section>`;
    }).join("") || '<p class="muted">暂时没有符合条件的单词。</p>';
    icons();
  }
  function renderProgress() {
    $("#progressMetrics").innerHTML = metric("已学覆盖率", `${report.coverage}%`, "book-open") + metric("当前掌握率", `${report.mastery}%`, "sprout") + metric("今日复习完成率", report.reviewCompletion === null ? "暂无" : `${report.reviewCompletion}%`, "check-check");
    $("#badges").innerHTML = report.badges.length ? report.badges.map(b => `<div class="badge">${icon("award")}<span>${esc(b.title)}星章</span></div>`).join("") : '<p class="muted">一个单元的10个词全部掌握，就能点亮一枚星章。</p>';
    $("#calendar").innerHTML = report.recent.map(d => `<div class="day ${d.answers ? "done" : ""}" title="${d.date}：正式作答${d.answers}题，新词${d.newWords}个"><span>${d.date.slice(8)}</span><small>${d.answers ? `${d.answers}题` : ""}</small></div>`).join("");
    const fields = [["已认识 / 已上线", `${report.learned} / ${report.published}`], ["当前掌握 / 曾经掌握", `${report.mastered} / ${report.everMastered}`], ["正式题首次正确率", report.accuracy === null ? "暂无记录" : `${report.accuracy}%`], ["正式首次作答", `${report.firstAnswers}次`], ["补答练习", `${report.retries}次`], ["自由加练", `${report.freeAnswers}次`], ["今日已完成复习", `${report.reviewCompleted}道`], ["最近学习", report.lastStudy ? new Date(report.lastStudy).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "尚未开始"]];
    $("#parentReport").innerHTML = fields.map(([key, val]) => `<div class="report-row"><span>${key}</span><strong>${esc(val)}</strong></div>`).join("");
    icons();
  }
  async function refresh(showError = true) {
    const token = epoch;
    try {
      const nextCatalog = await api("/catalog"), nextReport = await api("/report");
      if (token !== epoch) return false;
      catalog = nextCatalog; report = nextReport;
      const old = $("#unitFilter").value;
      $("#unitFilter").innerHTML = '<option value="all">全部主题</option>' + catalog.units.map(u => `<option value="${u.id}">${esc(u.title)}</option>`).join("");
      $("#unitFilter").value = old || "all";
      renderSidebar(); renderLibrary(); renderProgress();
      return true;
    } catch (error) { if (showError && token === epoch) notice(error.message || "连接中断，请重试", () => refresh()); return false; }
  }
  function setSidebar(open, restoreFocus = true) {
    sidebarOpen = mobile.matches && open;
    document.body.classList.toggle("sidebar-open", sidebarOpen);
    $("#sidebarBackdrop").hidden = !sidebarOpen;
    $("#sidebarToggle").setAttribute("aria-expanded", String(sidebarOpen));
    $("#sidebar").inert = mobile.matches && !sidebarOpen;
    $("#sidebar").setAttribute("aria-hidden", String(mobile.matches && !sidebarOpen));
    $("#main").inert = sidebarOpen;
    if (sidebarOpen) {
      $("#sidebar").setAttribute("role", "dialog"); $("#sidebar").setAttribute("aria-modal", "true");
      cancelTasks(); pending = false; $("#startBtn").disabled = false;
      $("#sidebarClose").focus({ preventScroll: true }); refresh(false);
    } else {
      $("#sidebar").removeAttribute("role"); $("#sidebar").removeAttribute("aria-modal");
      if (mobile.matches && restoreFocus) $("#sidebarToggle").focus({ preventScroll: true });
    }
  }
  function markCurrentUnit() {
    const id = view === "study" && session?.question ? catalog?.units.find(u => u.words.some(w => w.id === session.question.wordId))?.id : $("#unitFilter").value;
    document.querySelectorAll(".route-unit").forEach(b => b.classList.toggle("current", b.dataset.unit === id));
  }
  function showView(next, updateHash = true) {
    cancelTasks(); view = next; pending = false;
    document.body.classList.toggle("is-studying", next === "study");
    $("#wordDialog").close();
    setSidebar(false, false);
    for (const name of ["library", "progress", "study"]) $(`#${name}View`).hidden = name !== next;
    document.querySelectorAll(".sidebar-nav button").forEach(b => { b.classList.toggle("active", b.dataset.view === next); b.setAttribute("aria-current", b.dataset.view === next ? "page" : "false"); });
    if (updateHash) history.replaceState(null, "", `#${next}`);
    notice(); window.scrollTo({ top: 0, behavior: "instant" });
    $("#main").focus({ preventScroll: true });
    markCurrentUnit();
  }
  function navigate(next, updateHash = true) {
    if (!["library", "progress"].includes(next)) return start();
    showView(next, updateHash); refresh();
  }
  async function start(mode = "formal", unitId) {
    if (pending) return;
    showView("study"); const token = epoch; pending = true;
    session = null;
    $("#studyLabel").textContent = "今日学习";
    $("#studyUnit").textContent = ""; $("#studyCount").textContent = "";
    $("#studyProgress").value = 0;
    $("#studyContent").innerHTML = '<p class="loading-task" role="status">正在准备你的学习任务…</p>';
    $("#startBtn").disabled = true; notice();
    try {
      const data = await api("/sessions", { mode, unitId });
      if (token !== epoch) return;
      session = data; renderStudy(true); refresh(false);
    } catch (error) { if (token === epoch) notice(error.message || "学习任务未加载，请重试", () => start(mode, unitId)); }
    finally { if (token === epoch) { pending = false; $("#startBtn").disabled = false; } }
  }
  function wordMarkup(w) {
    return `<div class="learning-word"><img class="word-picture${w.picture?.type === "context-collage" ? " context-picture" : ""}" src="${w.image}" alt="${esc(w.meaning)}" width="132" height="132"><h1>${esc(w.word)}</h1><p class="word-meaning"><small>${esc(w.pos)}</small> ${esc(w.meaning)}</p><button class="text-button" data-audio="${w.id}">${icon("volume-2")}听标准音</button><p class="word-example">${esc(w.example)}</p><p class="translation">${esc(w.translation)}</p><button class="text-button" data-audio="${w.id}" data-part="example">${icon("volume-2")}听例句</button></div>`;
  }
  function renderStudy(autoSpeak = false) {
    clearTimeout(timer); clearTimeout(speechTimer);
    $("#studyLabel").textContent = session.mode === "free" ? "自由练习 · 不改变掌握进度" : "今日学习";
    $("#studyUnit").textContent = session.question ? (catalog?.units.find(u => u.words.some(w => w.id === session.question.wordId))?.title || "") : "";
    markCurrentUnit();
    if (session.completed) {
      $("#studyCount").textContent = "已完成"; $("#studyProgress").value = 10; $("#studyProgress").max = 10;
      const summary = session.summary;
      $("#studyContent").innerHTML = `<div class="summary-screen"><img class="summary-art" src="/ket-assets/1f33c.png" width="96" height="96" alt="盛开的花"><h1>今天的努力，开花了。</h1><p class="muted">${session.empty ? esc(session.message) : "这一组已经完成，休息一下也很棒。"}</p>${summary ? `<div class="summary-numbers"><div><strong>${summary.firstCorrect}/${summary.firstTotal}</strong><small>首次答对</small></div><div><strong>${summary.accuracy}%</strong><small>首次正确率</small></div><div><strong>${summary.attempts}</strong><small>总练习次数</small></div></div>` : ""}<div class="study-actions"><button class="primary" id="continueBtn">继续今日任务 ${icon("arrow-right")}</button><button data-view="library">去词库</button></div></div>`;
      $("#continueBtn").addEventListener("click", () => start()); icons(); return;
    }
    const q = session.question;
    $("#studyCount").textContent = `${session.position} / ${session.total}`;
    $("#studyProgress").max = session.total; $("#studyProgress").value = session.position - 1;
    if (q.needsExposure) {
      $("#studyContent").innerHTML = `${wordMarkup(q.exposure)}<div class="study-actions"><button class="primary" id="exposureBtn">认识了，试试看 ${icon("arrow-right")}</button></div>`;
      $("#exposureBtn").addEventListener("click", () => saveExposure(q.wordId));
    } else {
      $("#studyContent").innerHTML = `${q.skill === "listen" ? `<div class="listen-prompt"><h2>听一听，是哪个词？</h2><button class="listen-button" data-audio="${q.wordId}" title="重播题目" aria-label="重播题目">${icon("volume-2")}</button></div>` : `<p class="muted" style="text-align:center">选出这个单词的意思</p><h1 class="question-word">${esc(q.word)}</h1><div class="study-actions"><button class="text-button" data-audio="${q.wordId}">${icon("volume-2")}读题</button></div>`}<div class="options">${q.options.map(o => `<button class="option" data-answer="${o.id}">${o.image ? `<img src="${o.image}" alt="" width="48" height="48">` : ""}<span>${esc(o.meaning)}</span></button>`).join("")}</div><div class="answer-feedback" id="feedback" aria-live="polite"></div><div class="study-actions"><button class="text-button" id="revealBtn">还没记住，看看答案</button><button class="primary" id="nextBtn" hidden>下一题 ${icon("arrow-right")}</button></div>`;
      $("#revealBtn").addEventListener("click", () => submit(null, true));
      $("#nextBtn").addEventListener("click", nextQuestion);
      if (session.answer) showAnswer(session.answer, false);
    }
    icons();
    if (autoSpeak && !session.answer && !document.hidden) {
      const token = epoch; speechTimer = setTimeout(() => { if (token === epoch && view === "study") speak(q.wordId); }, 1500);
    }
  }
  async function saveExposure(wordId) {
    if (pending) return;
    pending = true; const token = epoch; $("#exposureBtn").disabled = true;
    try {
      await api("/exposure", { wordId });
      const updated = await api(`/sessions/${session.id}`);
      if (token === epoch) { session = updated; notice(); renderStudy(true); refresh(false); }
    } catch (error) { if (token === epoch) { notice(`尚未保存：${error.message}`, () => saveExposure(wordId)); $("#exposureBtn").disabled = false; } }
    finally { if (token === epoch) pending = false; }
  }
  function showAnswer(result, autoNext) {
    document.querySelectorAll("[data-answer]").forEach(b => { b.disabled = true; b.classList.toggle("correct", b.dataset.answer === result.word.id); });
    $("#revealBtn").hidden = true; $("#nextBtn").hidden = false;
    $("#feedback").classList.toggle("wrong", !result.correct);
    $("#feedback").innerHTML = `${esc(result.message)}<small>${esc(result.word.word)} · ${esc(result.word.meaning)}</small>`;
    if (result.correct && autoNext && !document.hidden) {
      const token = epoch; timer = setTimeout(() => { if (token === epoch) nextQuestion(); }, 1000);
    } else if (!result.correct && autoNext && !document.hidden) speak(result.word.id);
  }
  async function submit(selected, reveal = false) {
    if (pending || session.answer) return;
    clearTimeout(speechTimer); stopAudio(); pending = true; const token = epoch;
    const payload = { sessionId: session.id, questionId: session.question.id, selected, reveal };
    document.querySelectorAll("[data-answer],#revealBtn").forEach(b => b.disabled = true);
    try {
      const result = await api("/answer", payload);
      if (token !== epoch) return;
      session.answer = result; notice(); showAnswer(result, true); refresh(false);
      if (!result.correct && selected) document.querySelector(`[data-answer="${selected}"]`)?.classList.add("wrong");
    } catch (error) {
      if (token === epoch) notice(`答案尚未确认保存：${error.message}`, () => submit(selected, reveal));
      // Keep the original answer frozen until its idempotent retry resolves.
    } finally { if (token === epoch) pending = false; }
  }
  async function nextQuestion() {
    if (pending || !session.answer) return;
    clearTimeout(timer); clearTimeout(speechTimer); stopAudio(); pending = true; const token = epoch;
    $("#nextBtn").disabled = true;
    try {
      const updated = await api("/next", { sessionId: session.id, questionId: session.question.id });
      if (token !== epoch) return;
      session = updated; notice(); renderStudy(true);
    } catch (error) {
      if (token === epoch) { notice("下一题加载失败，已保存的成绩不会丢失。请点击下一题重试。"); $("#nextBtn").disabled = false; }
    } finally { if (token === epoch) pending = false; }
  }
  async function openWord(id) {
    const w = catalog.units.flatMap(u => u.words).find(w => w.id === id);
    if (!w) return;
    stopAudio(); selectedWord = w;
    $("#dialogUnit").textContent = catalog.units.find(u => u.id === w.unitId).title;
    $("#wordDetail").innerHTML = wordMarkup(w) + `<details class="spelling"><summary>拼词小挑战 · 自由练习</summary><div class="spelling-answer" id="spellingAnswer"></div><div class="letter-bank" id="letterBank"></div><div class="spelling-controls"><button class="icon-button" id="undoLetter" title="撤销一个字母" aria-label="撤销一个字母">${icon("undo-2")}</button><button class="text-button" id="checkSpelling">检查拼词</button></div><p class="muted" id="spellingMessage" role="status"></p></details>`;
    const chars = w.word.toLowerCase().replace(/[^a-z]/g, "").split("").map((char, index) => ({ char, index }));
    for (let i = chars.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    $("#letterBank").innerHTML = chars.map(c => `<button data-letter="${c.index}">${c.char}</button>`).join("");
    const picked = [];
    $("#letterBank").addEventListener("click", e => { const b = e.target.closest("[data-letter]"); if (!b || b.disabled) return; picked.push(b); b.disabled = true; $("#spellingAnswer").textContent = picked.map(b => b.textContent).join(""); });
    $("#undoLetter").addEventListener("click", () => { const b = picked.pop(); if (b) b.disabled = false; $("#spellingAnswer").textContent = picked.map(b => b.textContent).join(""); });
    $("#checkSpelling").addEventListener("click", () => { $("#spellingMessage").textContent = picked.map(b => b.textContent).join("") === w.word.toLowerCase().replace(/[^a-z]/g, "") ? "拼对了！真棒。" : "再看看单词，试一次吧。"; });
    $("#wordDialog").showModal(); icons();
    try { await api("/exposure", { wordId: id }); } catch (error) { notice(`本次点读未保存：${error.message}`, () => openWord(id)); }
  }
  document.addEventListener("click", event => {
    const b = event.target.closest("button"); if (!b || b.disabled) return;
    if (b.dataset.view) navigate(b.dataset.view);
    if (b.dataset.unit) { navigate("library"); $("#unitFilter").value = b.dataset.unit; if (catalog) renderLibrary(); }
    if (b.dataset.word) openWord(b.dataset.word);
    if (b.dataset.audio) speak(b.dataset.audio, b.dataset.part || "word");
    if (b.dataset.answer) submit(b.dataset.answer);
    if (b.dataset.practice) start("free", b.dataset.practice);
  });
  $("#sidebarToggle").addEventListener("click", () => setSidebar(!sidebarOpen));
  $("#sidebarClose").addEventListener("click", () => { setSidebar(false); reconnect(); });
  $("#sidebarBackdrop").addEventListener("click", () => { setSidebar(false); reconnect(); });
  mobile.addEventListener("change", () => { const wasOpen = sidebarOpen; setSidebar(false, false); if (wasOpen) reconnect(); });
  document.addEventListener("keydown", event => {
    if (!sidebarOpen) return;
    if (event.key === "Escape") { event.preventDefault(); setSidebar(false); reconnect(); }
    if (event.key === "Tab") {
      const items = [...$("#sidebar").querySelectorAll('button:not(:disabled),select,a[href]')].filter(el => el.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  $("#refreshBtn").addEventListener("click", refresh);
  $("#closeWordBtn").addEventListener("click", () => $("#wordDialog").close());
  $("#wordDialog").addEventListener("close", () => { selectedWord = null; stopAudio(); if (view !== "study") refresh(); });
  for (const selector of ["#unitFilter", "#statusFilter", "#wordSearch"]) $(selector).addEventListener("input", () => { if (catalog) renderLibrary(); });
  $("#dailyNew").addEventListener("change", async () => {
    $("#dailyNew").disabled = true;
    try { await api("/settings", { dailyNew: Number($("#dailyNew").value) }); await refresh(); }
    catch (error) { notice(error.message); $("#dailyNew").value = report.dailyNew; }
    finally { $("#dailyNew").disabled = false; }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { cancelTasks(); pending = false; }
    else if (!sidebarOpen && view === "study" && session?.id && !session.completed) {
      const token = epoch;
      api(`/sessions/${session.id}`).then(data => { if (token === epoch) { session = data; renderStudy(false); } }).catch(() => notice("恢复学习失败，请重试。", reconnect));
    } else if (view === "study" && !session && !sidebarOpen) start();
    else refresh();
  });
  window.addEventListener("pagehide", cancelTasks);
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1), false));
  async function reconnect() {
    pending = false;
    if (sidebarOpen) return refresh(false);
    if (view === "study" && !session) return start();
    if (view === "study" && session?.id && !session.completed) {
      const token = epoch;
      try { const updated = await api(`/sessions/${session.id}`); if (token === epoch) { session = updated; notice(); renderStudy(false); } }
      catch { notice("恢复学习失败，请联网后重试。", reconnect); }
    } else refresh();
  }
  window.addEventListener("offline", () => { cancelTasks(); pending = false; notice("网络已断开，成绩以服务器保存成功为准。请联网后重试。", reconnect); });
  window.addEventListener("online", reconnect);
  icons(); setSidebar(false, false); navigate(location.hash.slice(1));
})();
