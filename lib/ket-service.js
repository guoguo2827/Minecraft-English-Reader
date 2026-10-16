"use strict";
const { randomUUID, randomInt } = require("node:crypto");
const { fsrs, createEmptyCard, Rating } = require("ts-fsrs");
const C = require("./ket-content");
const DAY = 86400000;
const dayKey = date => new Date(new Date(date).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const parse = value => JSON.parse(value);
function fail(code, message, status = 400) { throw Object.assign(new Error(message), { code, status }); }
function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
function migrateKet(db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ket_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id), daily_new INTEGER NOT NULL DEFAULT 5 CHECK(daily_new IN (5,10,15))
      );
      CREATE TABLE IF NOT EXISTS ket_words (
        user_id INTEGER NOT NULL REFERENCES users(id), word_id TEXT NOT NULL,
        reserved_at TEXT NOT NULL, first_seen TEXT, last_seen TEXT, ever_mastered_at TEXT, last_failure TEXT,
        PRIMARY KEY(user_id,word_id)
      );
      CREATE TABLE IF NOT EXISTS ket_skills (
        user_id INTEGER NOT NULL REFERENCES users(id), word_id TEXT NOT NULL,
        skill TEXT NOT NULL CHECK(skill IN ('recognize','listen')), card_json TEXT NOT NULL,
        success_days TEXT NOT NULL DEFAULT '[]', practice_days TEXT NOT NULL DEFAULT '[]',
        last_good TEXT, last_scheduled_day TEXT, due TEXT NOT NULL,
        PRIMARY KEY(user_id,word_id,skill)
      );
      CREATE TABLE IF NOT EXISTS ket_sessions (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), mode TEXT NOT NULL,
        unit_id TEXT, content_version TEXT NOT NULL, queue_json TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ket_one_active ON ket_sessions(user_id) WHERE completed_at IS NULL;
      CREATE TABLE IF NOT EXISTS ket_attempts (
        question_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES ket_sessions(id),
        user_id INTEGER NOT NULL REFERENCES users(id), word_id TEXT NOT NULL, skill TEXT NOT NULL,
        mode TEXT NOT NULL, is_retry INTEGER NOT NULL, is_review INTEGER NOT NULL,
        correct INTEGER NOT NULL, revealed INTEGER NOT NULL, selected TEXT,
        request_json TEXT NOT NULL, result_json TEXT NOT NULL, answered_at TEXT NOT NULL, study_day TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ket_attempts_user_day ON ket_attempts(user_id,study_day);
      CREATE INDEX IF NOT EXISTS ket_skills_due ON ket_skills(user_id,due);
    `);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)")
      .run("2026-10-16-ket-pilot-v1", new Date().toISOString());
  })();
}
function accessError(user, mode = process.env.KET_ACCESS || "admin", at = new Date()) {
  if (!user || user.status !== "active") return { code: "ACCOUNT_DISABLED", error: "请使用正常启用的账号登录" };
  if (user.password_reset_required) return { code: "PASSWORD_RESET_REQUIRED", error: "请先设置新密码" };
  if (!["admin", "full"].includes(mode)) return { code: "KET_UNAVAILABLE", error: "KET课程正在维护，请稍后再来" };
  if (user.role === "admin") return null;
  if (mode !== "full") return { code: "KET_PREVIEW", error: "KET课程正在内测，暂未开放" };
  if (user.primary_course !== "english") return { code: "COURSE_LOCKED", error: "KET课程面向英语学习用户开放" };
  if (user.access_tier !== "founder_trial" && (!user.trial_expires_at || new Date(user.trial_expires_at) <= at)) {
    return { code: "TRIAL_EXPIRED", error: "课程已到期，请联系管理员" };
  }
  return null;
}
function allowedWords(user) { return user.role === "admin" || user.access_tier === "founder_trial" ? C.words : C.units.slice(0, 2).flatMap(u => u.words); }

function createKetService({ db, clock = () => new Date() }) {
  // Same-group repairs are separate from FSRS's day-level review schedule.
  const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: false, enable_short_term: false });
  const now = () => clock().toISOString();
  const checkWord = (user, id) => {
    const word = C.byId.get(id);
    if (!word) fail("WORD_NOT_FOUND", "没有找到这个词", 404);
    if (!allowedWords(user).some(w => w.id === id)) fail("THEME_LOCKED", "这个单元需要完整英语课程资格", 403);
    return word;
  };
  const wordRows = id => db.prepare("SELECT * FROM ket_words WHERE user_id=?").all(id);
  const skillRows = id => db.prepare("SELECT * FROM ket_skills WHERE user_id=?").all(id);
  function mastered(row, skills, at = clock()) {
    if (!row?.first_seen || at - new Date(row.first_seen) < 7 * DAY || skills.length !== 2) return false;
    if (Math.max(...skills.map(s => s.last_good ? new Date(s.last_good).getTime() : 0)) - new Date(row.first_seen).getTime() < 7 * DAY) return false;
    const days = new Set(skills.flatMap(s => parse(s.practice_days)));
    return days.size >= 3 && skills.every(s => parse(s.success_days).length >= 2 && s.last_good && (!row.last_failure || s.last_good > row.last_failure));
  }
  function wordStatus(row, skills) {
    if (!row?.first_seen) return "new";
    if (row.last_failure && !mastered(row, skills)) return "strengthen";
    return mastered(row, skills) ? "mastered" : "learning";
  }
  const active = id => db.prepare("SELECT * FROM ket_sessions WHERE user_id=? AND completed_at IS NULL").get(id);
  function getSession(user, id) {
    const session = db.prepare("SELECT * FROM ket_sessions WHERE id=? AND user_id=?").get(id, user.id);
    if (!session) fail("SESSION_NOT_FOUND", "没有找到这次学习", 404);
    for (const q of parse(session.queue_json)) checkWord(user, q.wordId);
    return session;
  }
  function report(user) {
    const rows = wordRows(user.id), skills = skillRows(user.id), today = dayKey(clock());
    const visible = new Set(allowedWords(user).map(w => w.id));
    const due = skills.filter(s => s.last_scheduled_day && visible.has(s.word_id) && new Date(s.due) <= clock() && s.last_scheduled_day !== today);
    const attempts = db.prepare("SELECT * FROM ket_attempts WHERE user_id=? ORDER BY answered_at").all(user.id);
    const formal = attempts.filter(a => a.mode === "formal" && !a.is_retry);
    const todayAttempts = formal.filter(a => a.study_day === today);
    const learned = rows.filter(r => r.first_seen).length;
    const masterCount = rows.filter(r => mastered(r, skills.filter(s => s.word_id === r.word_id))).length;
    const reviewed = todayAttempts.filter(a => a.is_review).length;
    const recent = Array.from({ length: 30 }, (_, i) => {
      const date = dayKey(new Date(clock().getTime() - (29 - i) * DAY));
      const dayAttempts = formal.filter(a => a.study_day === date);
      return { date, answers: dayAttempts.length, correct: dayAttempts.filter(a => a.correct).length,
        newWords: rows.filter(r => r.first_seen && dayKey(r.first_seen) === date).length };
    });
    return { published: C.words.length, target: C.target, learned, mastered: masterCount,
      everMastered: rows.filter(r => r.ever_mastered_at).length,
      coverage: Math.round(learned / C.words.length * 100), mastery: Math.round(masterCount / C.words.length * 100),
      dueSkills: due.length, dueWords: new Set(due.map(s => s.word_id)).size,
      dailyNew: db.prepare("SELECT daily_new FROM ket_settings WHERE user_id=?").get(user.id)?.daily_new || 5,
      newToday: rows.filter(r => dayKey(r.reserved_at) === today && skills.some(s => s.word_id === r.word_id)).length,
      firstAnswers: formal.length, firstCorrect: formal.filter(a => a.correct).length,
      accuracy: formal.length ? Math.round(formal.filter(a => a.correct).length / formal.length * 100) : null,
      retries: attempts.filter(a => a.mode === "formal" && a.is_retry).length,
      freeAnswers: attempts.filter(a => a.mode === "free").length,
      reviewCompleted: reviewed, reviewCompletion: reviewed + due.length ? Math.round(reviewed / (reviewed + due.length) * 100) : null,
      lastStudy: rows.map(r => r.last_seen).filter(Boolean).sort().at(-1) || null,
      badges: C.units.filter(u => u.words.every(w => mastered(rows.find(r => r.word_id === w.id), skills.filter(s => s.word_id === w.id)))).map(u => ({ id: u.id, title: u.title })),
      recent, activeSession: active(user.id)?.id || null, date: today };
  }
  function catalog(user) {
    const rows = wordRows(user.id), skills = skillRows(user.id), allowed = new Set(allowedWords(user).map(w => w.id));
    return { version: C.version, published: C.words.length, target: C.target, units: C.units.map(u => ({
      ...u, locked: !allowed.has(u.words[0].id), words: u.words.map(w => {
        const row = rows.find(r => r.word_id === w.id), ws = skills.filter(s => s.word_id === w.id);
        return { ...w, status: wordStatus(row, ws), due: ws.some(s => s.last_scheduled_day && new Date(s.due) <= clock() && s.last_scheduled_day !== dayKey(clock())),
          everMastered: !!row?.ever_mastered_at, skills: ws.map(s => ({ skill: s.skill, successDays: parse(s.success_days).length, due: s.due })) };
      })
    })) };
  }
  function question(wordId, skill, isReview = false, retry = false) {
    const w = C.byId.get(wordId);
    const same = C.words.filter(x => x.unitId === w.unitId && x.id !== wordId);
    return { id: randomUUID(), wordId, skill, isReview, retry,
      options: shuffle([wordId, ...shuffle(same).slice(0, 3).map(x => x.id)]) };
  }
  function present(user, session) {
    const queue = parse(session.queue_json);
    if (session.completed_at) {
      const records = db.prepare("SELECT * FROM ket_attempts WHERE session_id=?").all(session.id);
      const first = records.filter(r => !r.is_retry);
      return { id: session.id, mode: session.mode, completed: true, summary: {
        firstCorrect: first.filter(r => r.correct).length, firstTotal: first.length, attempts: records.length,
        accuracy: first.length ? Math.round(first.filter(r => r.correct).length / first.length * 100) : 0
      } };
    }
    const q = queue[session.cursor], w = checkWord(user, q.wordId);
    const row = db.prepare("SELECT * FROM ket_words WHERE user_id=? AND word_id=?").get(user.id, w.id);
    const prior = db.prepare("SELECT result_json FROM ket_attempts WHERE question_id=? AND user_id=?").get(q.id, user.id);
    const needsExposure = session.mode === "formal" && !row?.first_seen;
    return { id: session.id, mode: session.mode, completed: false, position: session.cursor + 1, total: queue.length,
      question: { id: q.id, wordId: w.id, skill: q.skill, retry: q.retry,
        word: q.skill === "recognize" ? w.word : null, needsExposure,
        exposure: needsExposure ? w : null,
        options: q.options.map(id => { const item = C.byId.get(id); return { id, meaning: item.meaning, image: item.image }; }) },
      answer: prior ? parse(prior.result_json) : null };
  }
  const start = db.transaction((user, { mode = "formal", unitId } = {}) => {
    if (!["formal", "free"].includes(mode)) fail("INVALID_MODE", "练习方式不正确");
    if (unitId && !C.units.some(u => u.id === unitId)) fail("UNIT_NOT_FOUND", "没有找到这个单元");
    if (unitId) checkWord(user, C.units.find(u => u.id === unitId).words[0].id);
    const existing = active(user.id);
    if (existing) return present(user, getSession(user, existing.id));
    const allowed = allowedWords(user), today = dayKey(clock());
    let queue = [];
    if (mode === "free") {
      if (!unitId) fail("UNIT_REQUIRED", "请选择一个单元");
      queue = shuffle(allowed.filter(w => w.unitId === unitId)).map(w => question(w.id, randomInt(2) ? "listen" : "recognize"));
    } else {
      const skills = skillRows(user.id), rows = wordRows(user.id);
      const due = skills.filter(s => allowed.some(w => w.id === s.word_id) && new Date(s.due) <= clock() && s.last_scheduled_day !== today)
        .sort((a, b) => a.due.localeCompare(b.due)).slice(0, 10);
      queue = due.map(s => question(s.word_id, s.skill, !!s.last_scheduled_day));
      const limit = report(user).dailyNew;
      const reserved = rows.filter(r => dayKey(r.reserved_at) === today && skills.some(s => s.word_id === r.word_id)).length;
      const newWords = allowed.filter(w => !skills.some(s => s.word_id === w.id)).slice(0, Math.min(5, Math.max(0, limit - reserved), Math.floor((10 - queue.length) / 2)));
      for (const w of newWords) {
        db.prepare("INSERT INTO ket_words(user_id,word_id,reserved_at) VALUES (?,?,?) ON CONFLICT(user_id,word_id) DO UPDATE SET reserved_at=excluded.reserved_at").run(user.id, w.id, now());
        for (const skill of ["recognize", "listen"]) {
          const card = createEmptyCard(clock());
          db.prepare("INSERT INTO ket_skills(user_id,word_id,skill,card_json,due) VALUES (?,?,?,?,?)")
            .run(user.id, w.id, skill, JSON.stringify(card), card.due.toISOString());
        }
      }
      // Show each new word before testing recognition; listening follows later in the group.
      queue.push(...newWords.map(w => question(w.id, "recognize")), ...shuffle(newWords).map(w => question(w.id, "listen")));
    }
    if (!queue.length) return { completed: true, empty: true, message: "今天的任务完成了，也可以到词库自由练习。" };
    const id = randomUUID();
    db.prepare("INSERT INTO ket_sessions(id,user_id,mode,unit_id,content_version,queue_json,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, user.id, mode, unitId || null, C.version, JSON.stringify(queue), now());
    return present(user, getSession(user, id));
  });
  const expose = db.transaction((user, wordId) => {
    checkWord(user, wordId);
    db.prepare("INSERT INTO ket_words(user_id,word_id,reserved_at,first_seen,last_seen) VALUES (?,?,?,?,?) ON CONFLICT(user_id,word_id) DO UPDATE SET first_seen=COALESCE(first_seen,excluded.first_seen),last_seen=excluded.last_seen")
      .run(user.id, wordId, now(), now(), now());
    // Browsing counts as contact, but does not create or advance a scheduling card.
    return { saved: true };
  });
  const answer = db.transaction((user, { sessionId, questionId, selected = null, reveal = false }) => {
    const session = getSession(user, sessionId);
    if (typeof reveal !== "boolean" || (selected !== null && typeof selected !== "string")) fail("INVALID_ANSWER", "答案格式不正确");
    const request = JSON.stringify({ selected, reveal });
    const old = db.prepare("SELECT * FROM ket_attempts WHERE question_id=? AND user_id=?").get(questionId, user.id);
    if (old) {
      if (old.session_id !== sessionId || old.request_json !== request) fail("ANSWER_CONFLICT", "这道题已经提交过，请继续下一题", 409);
      return { ...parse(old.result_json), duplicate: true };
    }
    const queue = parse(session.queue_json), q = queue[session.cursor];
    if (session.completed_at || q?.id !== questionId) fail("STALE_QUESTION", "题目已更新，请恢复当前学习", 409);
    if (!reveal && !q.options.includes(selected)) fail("INVALID_ANSWER", "请选择一个答案");
    const w = checkWord(user, q.wordId), correct = !reveal && selected === w.id;
    const row = db.prepare("SELECT * FROM ket_words WHERE user_id=? AND word_id=?").get(user.id, w.id);
    if (session.mode === "formal" && !row?.first_seen) fail("EXPOSURE_REQUIRED", "请先认识这个新词");
    const at = now(), today = dayKey(clock());
    if (session.mode === "formal") {
      db.prepare("UPDATE ket_words SET last_seen=? WHERE user_id=? AND word_id=?").run(at, user.id, w.id);
      const skill = db.prepare("SELECT * FROM ket_skills WHERE user_id=? AND word_id=? AND skill=?").get(user.id, w.id, q.skill);
      if (!q.retry && skill.last_scheduled_day !== today) {
        const card = parse(skill.card_json);
        card.due = new Date(card.due); if (card.last_review) card.last_review = new Date(card.last_review);
        const updated = scheduler.next(card, clock(), correct ? Rating.Good : Rating.Again).card;
        const successDays = new Set(parse(skill.success_days)), practiceDays = new Set(parse(skill.practice_days));
        practiceDays.add(today); if (correct) successDays.add(today);
        db.prepare("UPDATE ket_skills SET card_json=?,success_days=?,practice_days=?,last_good=?,last_scheduled_day=?,due=? WHERE user_id=? AND word_id=? AND skill=?")
          .run(JSON.stringify(updated), JSON.stringify([...successDays]), JSON.stringify([...practiceDays]), correct ? at : skill.last_good, today, updated.due.toISOString(), user.id, w.id, q.skill);
        if (!correct) db.prepare("UPDATE ket_words SET last_failure=? WHERE user_id=? AND word_id=?").run(at, user.id, w.id);
        const refreshed = db.prepare("SELECT * FROM ket_words WHERE user_id=? AND word_id=?").get(user.id, w.id);
        if (mastered(refreshed, skillRows(user.id).filter(s => s.word_id === w.id))) {
          db.prepare("UPDATE ket_words SET ever_mastered_at=COALESCE(ever_mastered_at,?) WHERE user_id=? AND word_id=?").run(at, user.id, w.id);
        }
      }
    }
    if (!correct) {
      queue.splice(Math.min(session.cursor + 4, queue.length), 0, question(w.id, q.skill, false, true));
      db.prepare("UPDATE ket_sessions SET queue_json=? WHERE id=?").run(JSON.stringify(queue), session.id);
    }
    const result = { correct, word: w, message: correct ? "答对了！又记牢了一点。" : "先看看正确答案，再试一次。", saved: true };
    db.prepare("INSERT INTO ket_attempts(question_id,session_id,user_id,word_id,skill,mode,is_retry,is_review,correct,revealed,selected,request_json,result_json,answered_at,study_day) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(q.id, session.id, user.id, w.id, q.skill, session.mode, Number(q.retry), Number(q.isReview), Number(correct), Number(reveal), selected, request, JSON.stringify(result), at, today);
    return result;
  });
  const next = db.transaction((user, { sessionId, questionId }) => {
    let session = getSession(user, sessionId);
    if (session.completed_at) return present(user, session);
    const queue = parse(session.queue_json), q = queue[session.cursor];
    // A stale/retried next call returns the current question without skipping it.
    if (q.id !== questionId) return present(user, session);
    if (!db.prepare("SELECT 1 FROM ket_attempts WHERE question_id=?").get(q.id)) fail("ANSWER_REQUIRED", "请先完成当前题目");
    db.prepare("UPDATE ket_sessions SET cursor=cursor+1,completed_at=? WHERE id=?")
      .run(session.cursor + 1 >= queue.length ? now() : null, session.id);
    session = getSession(user, session.id);
    return present(user, session);
  });
  function settings(user, value) {
    if (![5, 10, 15].includes(value)) fail("INVALID_GOAL", "每天的新词数请选择5、10或15");
    db.prepare("INSERT INTO ket_settings(user_id,daily_new) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET daily_new=excluded.daily_new").run(user.id, value);
    return report(user);
  }
  function adminSummary({ page = 1, phone = "" } = {}) {
    const pageNum = Math.max(1, Math.min(100000, Math.trunc(Number(page) || 1))), size = 20;
    const users = db.prepare("SELECT id,phone,nickname,role,access_tier FROM users WHERE role!='admin' AND phone LIKE ? ORDER BY id DESC").all(`%${String(phone).slice(0, 30)}%`);
    const learners = db.prepare("SELECT COUNT(DISTINCT k.user_id) AS n FROM ket_words k JOIN users u ON u.id=k.user_id WHERE u.role!='admin' AND k.first_seen IS NOT NULL").get().n;
    const totals = db.prepare("SELECT COUNT(*) AS answers,COALESCE(SUM(a.correct),0) AS correct FROM ket_attempts a JOIN users u ON u.id=a.user_id WHERE u.role!='admin' AND a.mode='formal' AND a.is_retry=0").get();
    return { enabled: process.env.KET_ACCESS || "admin", published: C.words.length, learners, ...totals,
      page: pageNum, total: users.length, users: users.slice((pageNum - 1) * size, pageNum * size).map(u => ({ id: u.id, phone: u.phone, nickname: u.nickname, ...report(u) })) };
  }
  return { report, catalog, start, answer, next, expose, settings, checkWord, adminSummary,
    session: (user, id) => present(user, getSession(user, id)) };
}
module.exports = { migrateKet, createKetService, accessError, allowedWords, dayKey };
