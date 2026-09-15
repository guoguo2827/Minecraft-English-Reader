"use strict";

const crypto = require("node:crypto");
const C = require("./world-content");
const terrain = C.makeTerrain();
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{12,80}$/.test(id);
function fail(code, message, status = 400) { const error = new Error(message); Object.assign(error, { code, status }); throw error; }

function migrateWorld(db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS world_saves (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        version INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS world_grants (
        user_id INTEGER NOT NULL REFERENCES users(id),
        grant_key TEXT NOT NULL,
        rewards_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, grant_key)
      );
      CREATE TABLE IF NOT EXISTS world_operations (
        user_id INTEGER NOT NULL REFERENCES users(id),
        operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, operation_id)
      );
      CREATE TABLE IF NOT EXISTS world_questions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        word_id TEXT NOT NULL,
        options_json TEXT NOT NULL,
        selected TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_world_questions_user ON world_questions(user_id, created_at);
    `);
    db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run("2026-09-07-english-camp-v1", new Date().toISOString());
  })();
}

function accessError(user, mode = process.env.WORLD_ACCESS || "admin") {
  if (!user || user.status !== "active") return { code: "ACCOUNT_DISABLED", error: "请使用正常启用的账号登录" };
  if (user.password_reset_required) return { code: "PASSWORD_RESET_REQUIRED", error: "请先设置新的登录密码" };
  if (!['admin', 'full'].includes(mode)) return { code: "WORLD_UNAVAILABLE", error: "营地正在维护，请稍后再来" };
  if (user.role === "admin") return null;
  if (user.primary_course !== "english") return { code: "COURSE_LOCKED", error: "英语营地仅面向英语主课程用户开放" };
  if (user.access_tier !== "founder_trial") return { code: "WORLD_FULL_COURSE_REQUIRED", error: "英语营地需要完整英语课程资格" };
  if (mode !== "full") return { code: "WORLD_PREVIEW_ONLY", error: "营地正在内测，暂时仅向管理员开放" };
  return null;
}

function initialState() {
  return {
    schemaVersion: 1, mapVersion: "camp-1", blocks: {}, inventory: { planks: 0, oak: 0, workbench: 0, axe: 0, chest: 0, door: 0 },
    learned: [], grants: [], recipesUnlocked: false, tasks: {}, doors: {}, harvests: {},
    position: { ...C.SPAWN }, completedAt: null
  };
}
function houseProgress(state) {
  const parts = {};
  for (const cell of C.HOUSE) {
    parts[cell.part] ||= { placed: 0, total: 0 };
    parts[cell.part].total++;
    if (state.blocks[C.key(cell.pos)] === cell.item) parts[cell.part].placed++;
  }
  const placed = Object.values(parts).reduce((n, p) => n + p.placed, 0);
  return { placed, total: C.HOUSE.length, parts, ready: placed === C.HOUSE.length };
}
function bridgeReady(state) { return C.BRIDGE.every((pos) => state.blocks[C.key(pos)] === "planks"); }
function objective(state) {
  const group = (id) => state.grants.includes(id);
  if (!group("materials")) return { id: "learn-materials", title: "认识营地的材料", detail: "掌握 block 和 oak，领取第一包木板", learn: "materials", phraseId: 22 };
  if (!state.tasks.bridge) return { id: "bridge", title: "修好小桥", detail: `桥面 ${C.BRIDGE.filter(p => state.blocks[C.key(p)]).length} / ${C.BRIDGE.length}`, target: [31, 3, 33], phraseId: 22 };
  if (!group("tools")) return { id: "learn-tools", title: "认识工具和箱子", detail: "掌握 wooden axe 和 chest", learn: "tools", phraseId: 32 };
  if (!state.tasks.borrowedAxe) return { id: "borrow", title: "领取教学木斧", detail: "到小桥对面的工具架取木斧", target: C.STATIONS.axe, phraseId: 32 };
  if (!state.tasks.harvest) return { id: "harvest", title: "采集橡木", detail: "用木斧采集带 oak 标记的小树", target: C.RESOURCES[1], phraseId: 32 };
  if (!state.tasks.chest) return { id: "chest", title: "找到营地储物箱", detail: "打开小路旁的教学箱子", target: C.STATIONS.chest, wordId: "chest" };
  if (!group("building")) return { id: "learn-building", title: "学会建造和跳跃", detail: "掌握 build 和 jump", learn: "building", phraseId: 29 };
  if (!state.tasks.step) return { id: "step", title: "放好训练台阶", detail: "在标记处放一块木板", target: C.STATIONS.step, phraseId: 29 };
  if (!state.tasks.jump) return { id: "jump", title: "跳过小台阶", detail: "走到台阶旁，听指令后跳跃", target: C.STATIONS.step, phraseId: 25 };
  if (!group("home")) return { id: "learn-home", title: "学会开门和关门", detail: "掌握 open 和 close，解锁营地配方", learn: "home", phraseId: 23 };
  if (!state.tasks.lessonOpen) return { id: "lesson-open", title: "打开教学小屋的门", detail: "前往蓝屋顶的小屋", target: C.STATIONS.door, phraseId: 23 };
  if (!state.tasks.lessonClose) return { id: "lesson-close", title: "关好教学小屋的门", detail: "再次操作这扇门", target: C.STATIONS.door, phraseId: 24 };
  if (!state.completedAt && !houseProgress(state).ready) return { id: "house", title: "建造自己的小屋", detail: "跟随轮廓放置地板、墙、屋顶、木门和箱子", target: [40, 4, 20], phraseId: 78 };
  if (!state.completedAt && !state.tasks.houseOpen) return { id: "house-open", title: "打开自己的家门", detail: "你的小屋建好了！", target: [40, 5, 19], phraseId: 23 };
  if (!state.completedAt) return { id: "house-close", title: "关好家门，完成营地", detail: "最后一步", target: [40, 5, 19], phraseId: 24 };
  return { id: "free", title: "你的营地，你来创造", detail: "继续采集、合成和搭建", phraseId: 9 };
}

function createWorldService({ db, answerQuiz, getQuizState, upsertReadProgress, rewardRead }) {
  const stamp = () => new Date().toISOString();
  function load(userId) {
    let row = db.prepare("SELECT * FROM world_saves WHERE user_id = ?").get(userId);
    if (!row) {
      db.prepare("INSERT INTO world_saves (user_id, state_json, updated_at) VALUES (?, ?, ?)").run(userId, JSON.stringify(initialState()), stamp());
      row = db.prepare("SELECT * FROM world_saves WHERE user_id = ?").get(userId);
    }
    return { ...row, state: JSON.parse(row.state_json) };
  }
  function persist(row) {
    row.version++;
    row.updated_at = stamp();
    db.prepare("UPDATE world_saves SET version = ?, state_json = ?, updated_at = ? WHERE user_id = ?")
      .run(row.version, JSON.stringify(row.state), row.updated_at, row.user_id);
  }
  function learning(userId) {
    return C.WORDS.map(word => {
      const progress = db.prepare("SELECT mastery_status, correct_count FROM word_progress WHERE user_id = ? AND theme_id = ? AND word = ?").get(userId, word.themeId, word.word);
      const review = db.prepare("SELECT * FROM review_queue WHERE user_id = ? AND theme_id = ? AND word = ? AND status = 'active'").get(userId, word.themeId, word.word);
      return { ...word, mastered: progress?.mastery_status === "mastered", reviewing: Boolean(review), reviewRemaining: review ? Math.max(0, 3 - review.consecutive_fix_count) : 0 };
    });
  }
  function syncLearning(row) {
    let changed = false;
    for (const word of learning(row.user_id)) if (word.mastered && !row.state.learned.includes(word.id)) { row.state.learned.push(word.id); changed = true; }
    for (const group of C.GROUPS) {
      if (!group.words.every(id => row.state.learned.includes(id))) continue;
      const inserted = db.prepare("INSERT OR IGNORE INTO world_grants (user_id, grant_key, rewards_json, created_at) VALUES (?, ?, ?, ?)")
        .run(row.user_id, group.id, JSON.stringify(group.reward), stamp());
      if (inserted.changes) {
        for (const [item, count] of Object.entries(group.reward)) row.state.inventory[item] += count;
        row.state.grants.push(group.id);
        changed = true;
      }
    }
    if (row.state.grants.length === 4 && !row.state.recipesUnlocked) { row.state.recipesUnlocked = true; changed = true; }
    return changed;
  }
  function snapshot(row) {
    return { version: row.version, savedAt: row.updated_at, state: row.state, words: learning(row.user_id), objective: objective(row.state), house: houseProgress(row.state) };
  }
  const bootstrap = db.transaction((userId) => {
    const row = load(userId);
    if (syncLearning(row)) persist(row);
    return snapshot(row);
  });
  const checkVersion = (row, version) => {
    if (!Number.isSafeInteger(version) || version !== row.version) fail("WORLD_VERSION_CONFLICT", "进度已在其他窗口更新，正在重新同步", 409);
  };
  function validatePosition(position) {
    if (!position || ![position.x, position.y, position.z, position.yaw, position.pitch].every(Number.isFinite)
      || position.x < 3 || position.x > 61 || position.z < 3 || position.z > 61 || position.y < 1 || position.y > 22
      || Math.abs(position.yaw) > Math.PI * 2 || Math.abs(position.pitch) > 1.5) fail("INVALID_POSITION", "请回到营地安全位置");
    return { x: position.x, y: position.y, z: position.z, yaw: position.yaw, pitch: position.pitch };
  }
  function near(position, cell, distance = 7) {
    if (Math.hypot(position.x - cell[0] - 0.5, position.y - cell[1] - 0.5, position.z - cell[2] - 0.5) > distance) fail("OUT_OF_REACH", "再走近一点试试");
  }
  function validateCell(pos) {
    if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isInteger)
      || pos[0] < 0 || pos[0] >= 64 || pos[1] < 0 || pos[1] >= 24 || pos[2] < 0 || pos[2] >= 64) fail("INVALID_CELL", "这里不能放置方块");
  }
  function reservedDoor(state, pos) {
    const below = [pos[0], pos[1] - 1, pos[2]];
    return state.blocks[C.key(below)] === "door";
  }
  const supported = (state, pos) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(delta => {
    const p = pos.map((v, i) => v + delta[i]);
    return C.baseBlock(terrain, p) || state.blocks[C.key(p)];
  });
  function debit(state, costs, multiplier = 1) {
    for (const [item, count] of Object.entries(costs)) if (state.inventory[item] < count * multiplier) fail("MATERIALS_REQUIRED", "材料还不够，去小树林采集一些橡木吧");
    for (const [item, count] of Object.entries(costs)) state.inventory[item] -= count * multiplier;
  }
  function runAction(row, body) {
    const state = row.state;
    const position = body.type === "respawn" ? { ...C.SPAWN } : validatePosition(body.position);
    state.position = position;
    if (body.pos !== undefined) validateCell(body.pos);
    const cellKey = body.pos ? C.key(body.pos) : "";
    switch (body.type) {
      case "checkpoint": case "respawn": return { message: body.type === "respawn" ? "已回到营地" : "已保存" };
      case "read": {
        const word = C.WORDS.find(w => w.id === body.wordId);
        if (!word) fail("WORD_NOT_ALLOWED", "请选择营地词汇");
        upsertReadProgress(row.user_id, word.themeId, word.word);
        return { message: "", learningReward: rewardRead(row.user_id, word.themeId, word.word) };
      }
      case "borrow":
        near(position, C.STATIONS.axe);
        state.tasks.borrowedAxe = true;
        return { message: "拿到教学木斧，去采集橡木吧" };
      case "harvest": {
        if (!Number.isInteger(body.nodeId) || !C.RESOURCES[body.nodeId]) fail("RESOURCE_NOT_FOUND", "没有找到采集点");
        near(position, C.RESOURCES[body.nodeId]);
        if (!state.tasks.borrowedAxe && !state.inventory.axe) fail("TOOL_REQUIRED", "先去工具架领取教学木斧");
        if (Date.now() - (state.harvests[body.nodeId] || 0) < 3000) fail("RESOURCE_REGROWING", "小树正在恢复，请稍等一下");
        state.harvests[body.nodeId] = Date.now();
        state.inventory.oak += 4;
        state.tasks.harvest = true;
        return { message: "采集成功 +4 橡木" };
      }
      case "inspect":
        near(position, C.STATIONS.chest);
        state.tasks.chest = true;
        return { message: "找到 chest！你的材料都收好啦" };
      case "jump": {
        near(position, C.STATIONS.step, 4);
        if (!state.tasks.step) fail("STEP_REQUIRED", "先在轮廓处放好台阶");
        const from = validatePosition(body.from);
        const crosses = (from.z > 21 && position.z < 20) || (from.z < 20 && position.z > 21);
        if (!crosses || Math.abs(from.x - 30.5) > 1 || Math.abs(position.x - 30.5) > 1
          || !Number.isFinite(body.peak) || body.peak < 5.9 || body.peak > 8)
          fail("JUMP_AGAIN", "对准台阶，向前跳到另一边试试");
        state.tasks.jump = true;
        return { message: "Jump! 跳得真棒" };
      }
      case "craft": {
        const recipe = C.RECIPES.find(r => r.id === body.recipeId);
        const count = body.count ?? 1;
        if (!recipe || !Number.isInteger(count) || count < 1 || count > 16) fail("INVALID_RECIPE", "请选择有效的配方和数量");
        if (!recipe.starter && !state.recipesUnlocked) fail("RECIPE_LOCKED", "掌握营地8个单词后解锁这个配方");
        const benches = [C.STATIONS.workbench, ...Object.entries(state.blocks).filter(([, item]) => item === "workbench").map(([k]) => k.split(",").map(Number))];
        if (!recipe.starter && !benches.some(p => Math.hypot(position.x - p[0] - 0.5, position.y - p[1] - 0.5, position.z - p[2] - 0.5) <= 7)) fail("WORKBENCH_REQUIRED", "走到公共工作台或自己放置的工作台旁合成");
        debit(state, recipe.costs, count);
        state.inventory[recipe.id] += recipe.count * count;
        return { message: `合成成功 +${recipe.count * count} ${C.ITEMS[recipe.id].name}` };
      }
      case "place": {
        validateCell(body.pos);
        near(position, body.pos);
        const bridge = C.BRIDGE.some(p => C.key(p) === cellKey);
        const step = C.key(C.STATIONS.step) === cellKey;
        if (!C.insidePlot(body.pos) && !bridge && !step) fail("PROTECTED_AREA", "这里是公共区域，请在轮廓或个人建造区搭建");
        if (!['planks', 'oak', 'chest', 'door', 'workbench'].includes(body.item)) fail("ITEM_NOT_PLACEABLE", "这个物品不能放置");
        if ((bridge || step) && body.item !== "planks") fail("PLANKS_REQUIRED", "这里需要木板");
        if (['door', 'chest', 'workbench'].includes(body.item) && !state.recipesUnlocked) fail("RECIPE_LOCKED", "先完成营地单词学习");
        if (state.blocks[cellKey] || C.baseBlock(terrain, body.pos) || reservedDoor(state, body.pos)) fail("CELL_OCCUPIED", "这个位置已经有方块了");
        const height = body.item === "door" ? 2 : 1;
        if (height === 2 && (body.pos[1] + 1 > C.PLOT.maxY || state.blocks[C.key([body.pos[0], body.pos[1] + 1, body.pos[2]])])) fail("CELL_OCCUPIED", "木门上方需要留出空间");
        if (Math.abs(position.x - body.pos[0] - 0.5) < 0.78 && Math.abs(position.z - body.pos[2] - 0.5) < 0.78
          && position.y + 0.9 > body.pos[1] && position.y - 0.9 < body.pos[1] + height) fail("PLAYER_OCCUPIED", "往旁边挪一步再放置");
        if (!bridge && !supported(state, body.pos)) fail("SUPPORT_REQUIRED", "先放好下面或旁边的方块");
        debit(state, { [body.item]: 1 });
        state.blocks[cellKey] = body.item;
        if (bridgeReady(state)) state.tasks.bridge = true;
        if (step) state.tasks.step = true;
        return { message: bridgeReady(state) && bridge ? "小桥修好了！" : "放置成功" };
      }
      case "remove": {
        validateCell(body.pos); near(position, body.pos);
        const item = state.blocks[cellKey];
        if (!item || !C.insidePlot(body.pos)) fail("PROTECTED_AREA", "公共设施和训练方块需要保留");
        delete state.blocks[cellKey]; delete state.doors[cellKey];
        state.inventory[item]++;
        return { message: `收回 ${C.ITEMS[item].name}` };
      }
      case "door": {
        validateCell(body.pos); near(position, body.pos);
        const lesson = cellKey === C.key(C.STATIONS.door);
        if (!lesson && state.blocks[cellKey] !== "door") fail("DOOR_NOT_FOUND", "请对准木门");
        const opened = !state.doors[cellKey];
        if (!opened && Math.abs(position.x - body.pos[0] - 0.5) < 0.85 && Math.abs(position.z - body.pos[2] - 0.5) < 0.85) fail("PLAYER_OCCUPIED", "离开门口后再关门");
        state.doors[cellKey] = opened;
        if (lesson) {
          if (opened) state.tasks.lessonOpen = true;
          else if (state.tasks.lessonOpen) state.tasks.lessonClose = true;
        } else if (cellKey === "40,5,19" && houseProgress(state).ready) {
          if (opened) state.tasks.houseOpen = true;
          else if (state.tasks.houseOpen) state.tasks.houseClose = true;
        }
        return { message: opened ? "Open the door." : "Close the door.", phraseId: opened ? 23 : 24 };
      }
      default: fail("INVALID_ACTION", "这个操作暂不支持");
    }
  }
  function finish(row) {
    const s = row.state;
    if (!s.completedAt && s.recipesUnlocked && houseProgress(s).ready
      && ['bridge', 'harvest', 'chest', 'step', 'jump', 'lessonOpen', 'lessonClose', 'houseOpen', 'houseClose'].every(k => s.tasks[k])) {
      s.completedAt = stamp();
      db.prepare("INSERT OR IGNORE INTO world_grants (user_id, grant_key, rewards_json, created_at) VALUES (?, 'camp-badge', '{}', ?)").run(row.user_id, s.completedAt);
    }
  }
  const act = db.transaction((userId, body) => {
    if (!validId(body.operationId)) fail("INVALID_OPERATION_ID", "操作标识无效，请重试");
    // A retry may have a refreshed version/position, but cannot change the intended command.
    const { operationId, version, position, ...command } = body;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const previous = db.prepare("SELECT * FROM world_operations WHERE user_id = ? AND operation_id = ?").get(userId, operationId);
    const row = load(userId);
    if (previous) {
      if (previous.request_hash !== requestHash) fail("OPERATION_REUSED", "该操作已经执行，请重新操作", 409);
      return { ...snapshot(row), result: JSON.parse(previous.result_json), duplicate: true };
    }
    checkVersion(row, version);
    const result = runAction(row, body);
    syncLearning(row);
    finish(row);
    persist(row);
    db.prepare("INSERT INTO world_operations (user_id, operation_id, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, operationId, requestHash, JSON.stringify(result), stamp());
    return { ...snapshot(row), result };
  });
  const nextQuestion = db.transaction((userId, wordId) => {
    const all = learning(userId);
    if (wordId && !C.WORDS.some(w => w.id === wordId)) fail("WORD_NOT_ALLOWED", "请选择营地词汇");
    const eligible = wordId ? all.filter(w => w.id === wordId) : all.filter(w => !w.mastered);
    if (!eligible.length) return { completed: true, ...bootstrap(userId) };
    const candidates = eligible.map(w => {
      const quiz = getQuizState(userId, w.themeId);
      const review = db.prepare("SELECT due_question_no FROM review_queue WHERE user_id = ? AND theme_id = ? AND word = ? AND status = 'active'").get(userId, w.themeId, w.word);
      return { w, due: review && review.due_question_no <= quiz.question_no + 1, fresh: !w.reviewing };
    });
    const chosen = candidates.find(c => c.due) || candidates.find(c => c.fresh) || candidates[0];
    const word = chosen.w;
    const pending = db.prepare("SELECT * FROM world_questions WHERE user_id = ? AND word_id = ? AND selected IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
      .get(userId, word.id, new Date(Date.now() - 10 * 60 * 1000).toISOString());
    if (pending) return { id: pending.id, wordId: word.id, options: JSON.parse(pending.options_json) };
    db.prepare("UPDATE theme_quiz_state SET question_no = question_no + 1, updated_at = ? WHERE user_id = ? AND theme_id = ?").run(stamp(), userId, word.themeId);
    const wrong = C.WORDS.filter(w => w.id !== word.id);
    for (let i = wrong.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [wrong[i], wrong[j]] = [wrong[j], wrong[i]]; }
    const options = [word, ...wrong.slice(0, 3)].map(w => ({ value: w.cn, icon: w.icon }));
    for (let i = options.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [options[i], options[j]] = [options[j], options[i]]; }
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO world_questions (id, user_id, word_id, options_json, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, word.id, JSON.stringify(options), stamp());
    db.prepare("DELETE FROM world_questions WHERE user_id = ? AND selected IS NULL AND created_at < ?").run(userId, new Date(Date.now() - 24 * 3600000).toISOString());
    return { id, wordId: word.id, options };
  });
  const answer = db.transaction((userId, body) => {
    const question = db.prepare("SELECT * FROM world_questions WHERE id = ? AND user_id = ?").get(String(body.questionId || ""), userId);
    if (!question) fail("QUESTION_NOT_FOUND", "这道题已失效，请重新读题", 404);
    if (question.selected !== null) {
      if (body.selected !== question.selected) fail("QUESTION_ALREADY_ANSWERED", "这道题已经提交过", 409);
      return { ...bootstrap(userId), result: JSON.parse(question.result_json), duplicate: true };
    }
    if (Date.now() - Date.parse(question.created_at) > 10 * 60 * 1000) fail("QUESTION_EXPIRED", "这道题已过期，请重新读题", 409);
    if (!JSON.parse(question.options_json).some(o => o.value === body.selected)) fail("INVALID_ANSWER", "请选择一个答案");
    const row = load(userId);
    checkVersion(row, body.version);
    const word = C.WORDS.find(w => w.id === question.word_id);
    const result = answerQuiz(userId, word.themeId, word.word, body.selected);
    syncLearning(row); persist(row);
    db.prepare("UPDATE world_questions SET selected = ?, result_json = ? WHERE id = ?").run(body.selected, JSON.stringify(result), question.id);
    return { ...snapshot(row), result };
  });
  return { bootstrap, act, nextQuestion, answer, learning };
}
module.exports = { migrateWorld, accessError, initialState, objective, houseProgress, createWorldService };
