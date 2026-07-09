const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const app = express();
const rootDir = __dirname;
const publicDir = path.join(rootDir, "outputs");
const dataDir = path.join(rootDir, "data");
const audioDir = path.join(dataDir, "audio");
const dbPath = process.env.DATABASE_PATH || path.join(dataDir, "app.db");
const port = Number(process.env.PORT || 3000);
const inviteAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const passwordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const rewardLevels = [
  { level: 1, minExp: 0, title: "煤炭新手", gemKey: "coal" },
  { level: 2, minExp: 60, title: "铁锭学徒", gemKey: "iron" },
  { level: 3, minExp: 150, title: "金锭冒险家", gemKey: "gold" },
  { level: 4, minExp: 290, title: "红石能手", gemKey: "redstone" },
  { level: 5, minExp: 480, title: "青金石法师", gemKey: "lapis" },
  { level: 6, minExp: 730, title: "绿宝石大师", gemKey: "emerald" },
  { level: 7, minExp: 1050, title: "钻石勇士", gemKey: "diamond" },
  { level: 8, minExp: 1450, title: "下界合金传奇", gemKey: "netherite" }
];

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function now() {
  return new Date().toISOString();
}

function randomCode(length = 6) {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += inviteAlphabet[crypto.randomInt(inviteAlphabet.length)];
  }
  return code;
}

function randomPassword(length = 10) {
  let password = "";
  for (let i = 0; i < length; i += 1) {
    password += passwordAlphabet[crypto.randomInt(passwordAlphabet.length)];
  }
  return password;
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function isValidPhone(value) {
  return /^1[3-9]\d{9}$/.test(normalizePhone(value));
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeInvite(value) {
  return String(value || "").trim().toUpperCase();
}

function hashInvite(code) {
  return crypto.createHash("sha256").update(normalizeInvite(code)).digest("hex");
}

function sha256(value, encoding = "hex") {
  return crypto.createHash("sha256").update(value).digest(encoding);
}

function hmacSha256(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function safeAudioName(text, voiceType, codec) {
  const normalized = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  const voiceKey = voiceType === undefined ? "default" : String(voiceType);
  return sha256(`${normalized}|voice:${voiceKey}|codec:${codec}`).slice(0, 32);
}

function getTencentVoiceType() {
  const raw = process.env.TENCENT_TTS_VOICE_TYPE || process.env.TENCENT_TTS_VOICE_NAME || "";
  if (/^-?\d+$/.test(String(raw).trim())) return Number(raw);
  return undefined;
}

function tencentTtsRequest(payload) {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  const region = process.env.TENCENT_TTS_REGION || "ap-guangzhou";
  if (!secretId || !secretKey) throw new Error("Tencent TTS credentials are not configured");

  const service = "tts";
  const host = "tts.tencentcloudapi.com";
  const action = "TextToVoice";
  const version = "2019-08-23";
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const hashedPayload = sha256(body);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedPayload
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    timestamp,
    credentialScope,
    sha256(canonicalRequest)
  ].join("\n");
  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = hmacSha256(secretSigning, stringToSign, "hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const request = https.request({
      method: "POST",
      host,
      path: "/",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json; charset=utf-8",
        Host: host,
        "X-TC-Action": action,
        "X-TC-Version": version,
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Region": region
      }
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.Response?.Error) {
            reject(new Error(json.Response.Error.Message || json.Response.Error.Code));
            return;
          }
          resolve(json.Response);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function ensureTtsAudio(text) {
  const normalizedText = String(text || "").trim().replace(/\s+/g, " ");
  if (!normalizedText || normalizedText.length > 80) throw new Error("Invalid TTS text");
  const codec = (process.env.TENCENT_TTS_CODEC || "mp3").toLowerCase();
  const ext = codec === "wav" ? "wav" : "mp3";
  const voiceType = getTencentVoiceType();
  const filePath = path.join(audioDir, `${safeAudioName(normalizedText, voiceType, ext)}.${ext}`);
  if (fs.existsSync(filePath)) return { filePath, contentType: ext === "wav" ? "audio/wav" : "audio/mpeg" };

  const payload = {
    Text: normalizedText,
    SessionId: crypto.randomUUID(),
    Codec: ext,
    ModelType: 1,
    Speed: 0,
    Volume: 0,
    PrimaryLanguage: 2,
    SampleRate: 16000
  };
  if (voiceType !== undefined) payload.VoiceType = voiceType;

  const response = await tencentTtsRequest(payload);
  if (!response?.Audio) throw new Error("Tencent TTS returned no audio");
  fs.writeFileSync(filePath, Buffer.from(response.Audio, "base64"));
  return { filePath, contentType: ext === "wav" ? "audio/wav" : "audio/mpeg" };
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nickname TEXT NOT NULL,
      phone TEXT UNIQUE,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS phone_whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      note TEXT DEFAULT '',
      invite_hash TEXT NOT NULL,
      invite_display TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unused',
      created_by INTEGER,
      used_by INTEGER,
      created_at TEXT NOT NULL,
      used_at TEXT,
      disabled_at TEXT,
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(used_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS word_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      theme_id TEXT NOT NULL,
      word TEXT NOT NULL,
      read_count INTEGER NOT NULL DEFAULT 0,
      answer_count INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      consecutive_correct INTEGER NOT NULL DEFAULT 0,
      mastery_status TEXT NOT NULL DEFAULT 'new',
      last_studied_at TEXT,
      UNIQUE(user_id, theme_id, word),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS review_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      theme_id TEXT NOT NULL,
      word TEXT NOT NULL,
      due_question_no INTEGER NOT NULL,
      consecutive_fix_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, theme_id, word),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS theme_quiz_state (
      user_id INTEGER NOT NULL,
      theme_id TEXT NOT NULL,
      question_no INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, theme_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS study_sessions (
      user_id INTEGER NOT NULL,
      study_date TEXT NOT NULL,
      read_count INTEGER NOT NULL DEFAULT 0,
      answer_count INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, study_date),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_rewards (
      user_id INTEGER PRIMARY KEY,
      total_exp INTEGER NOT NULL DEFAULT 0,
      today_exp INTEGER NOT NULL DEFAULT 0,
      reward_date TEXT NOT NULL,
      streak_correct INTEGER NOT NULL DEFAULT 0,
      fixed_reviews INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS reward_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      exp INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL DEFAULT '',
      theme_id TEXT DEFAULT '',
      word TEXT DEFAULT '',
      unique_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS theme_badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      theme_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, theme_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);
}

function ensureAdmin() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
  if (count > 0) return;
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "admin123456";
  const phone = normalizePhone(process.env.ADMIN_PHONE || "13800000000");
  db.prepare(`
    INSERT INTO users (username, password_hash, nickname, phone, role, status, created_at)
    VALUES (?, ?, ?, ?, 'admin', 'active', ?)
  `).run(username, bcrypt.hashSync(password, 10), "管理员", phone, now());
}

function loadThemes() {
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const startToken = "const themes = ";
  const endToken = "    const crop = ";
  const start = html.indexOf(startToken);
  const end = html.indexOf(endToken, start);
  if (start < 0 || end < 0) throw new Error("Cannot find themes in outputs/index.html");
  const source = html.slice(start + startToken.length, end).trim().replace(/;\s*$/, "");
  const script = `return (${source});`;
  return Function(script)();
}

const themes = loadThemes();
const themeMap = new Map(themes.map((theme) => [theme.id, theme]));

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    phone: user.phone,
    role: user.role,
    status: user.status
  };
}

function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(req.session.userId) || null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "请先登录" });
  req.user = user;
  return next();
}

function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "请先登录" });
  if (user.role !== "admin") return res.status(403).json({ error: "没有管理员权限" });
  req.user = user;
  return next();
}

function requirePageAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.redirect("/login");
  req.user = user;
  return next();
}

function requireAdminPage(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.redirect("/admin-login");
  if (user.role !== "admin") return res.redirect("/");
  req.user = user;
  return next();
}

function touchSession(userId, kind, correct) {
  const today = new Date().toISOString().slice(0, 10);
  const existing = db.prepare("SELECT * FROM study_sessions WHERE user_id = ? AND study_date = ?").get(userId, today);
  if (existing) {
    db.prepare(`
      UPDATE study_sessions
      SET read_count = read_count + ?,
          answer_count = answer_count + ?,
          correct_count = correct_count + ?,
          updated_at = ?
      WHERE user_id = ? AND study_date = ?
    `).run(kind === "read" ? 1 : 0, kind === "answer" ? 1 : 0, correct ? 1 : 0, now(), userId, today);
  } else {
    db.prepare(`
      INSERT INTO study_sessions (user_id, study_date, read_count, answer_count, correct_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, today, kind === "read" ? 1 : 0, kind === "answer" ? 1 : 0, correct ? 1 : 0, now());
  }
}

function upsertReadProgress(userId, themeId, word) {
  db.prepare(`
    INSERT INTO word_progress (user_id, theme_id, word, read_count, last_studied_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(user_id, theme_id, word)
    DO UPDATE SET read_count = read_count + 1, last_studied_at = excluded.last_studied_at
  `).run(userId, themeId, word, now());
  touchSession(userId, "read", false);
}

function getQuizState(userId, themeId) {
  const existing = db.prepare("SELECT * FROM theme_quiz_state WHERE user_id = ? AND theme_id = ?").get(userId, themeId);
  if (existing) return existing;
  db.prepare("INSERT INTO theme_quiz_state (user_id, theme_id, question_no, updated_at) VALUES (?, ?, 0, ?)")
    .run(userId, themeId, now());
  return { user_id: userId, theme_id: themeId, question_no: 0 };
}

function chooseQuizItem(userId, themeId) {
  const theme = themeMap.get(themeId);
  if (!theme) throw new Error("未知主题");
  const state = getQuizState(userId, themeId);
  const questionNo = state.question_no + 1;
  db.prepare("UPDATE theme_quiz_state SET question_no = ?, updated_at = ? WHERE user_id = ? AND theme_id = ?")
    .run(questionNo, now(), userId, themeId);

  const dueItems = db.prepare(`
    SELECT word FROM review_queue
    WHERE user_id = ? AND theme_id = ? AND status = 'active' AND due_question_no <= ?
  `).all(userId, themeId, questionNo);
  const dueWords = new Set(dueItems.map((item) => item.word));
  const candidates = dueWords.size
    ? theme.items.filter((item) => dueWords.has(item.word))
    : theme.items;
  const quizItem = candidates[crypto.randomInt(candidates.length)];
  const wrongPool = shuffle(theme.items.filter((item) => item.cn !== quizItem.cn)).slice(0, 3);
  return {
    questionNo,
    themeId,
    word: quizItem.word,
    options: shuffle([quizItem, ...wrongPool]).map((item) => item.cn)
  };
}

function shuffle(array) {
  const items = array.slice();
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function scheduleReview(userId, themeId, word, questionNo, consecutiveFixCount) {
  const due = questionNo + crypto.randomInt(6, 11);
  db.prepare(`
    INSERT INTO review_queue (user_id, theme_id, word, due_question_no, consecutive_fix_count, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(user_id, theme_id, word)
    DO UPDATE SET due_question_no = excluded.due_question_no,
                  consecutive_fix_count = excluded.consecutive_fix_count,
                  status = 'active',
                  updated_at = excluded.updated_at
  `).run(userId, themeId, word, due, consecutiveFixCount, now(), now());
}

function answerQuiz(userId, themeId, word, selectedCn) {
  const theme = themeMap.get(themeId);
  if (!theme) throw new Error("未知主题");
  const item = theme.items.find((candidate) => candidate.word === word);
  if (!item) throw new Error("未知单词");
  const state = getQuizState(userId, themeId);
  const correct = item.cn === selectedCn;
  const queue = db.prepare("SELECT * FROM review_queue WHERE user_id = ? AND theme_id = ? AND word = ?").get(userId, themeId, word);
  const hadActiveReview = Boolean(queue && queue.status === "active");
  let fixedReview = false;

  let consecutiveCorrect = correct ? 1 : 0;
  const existingProgress = db.prepare("SELECT consecutive_correct FROM word_progress WHERE user_id = ? AND theme_id = ? AND word = ?")
    .get(userId, themeId, word);
  if (correct && existingProgress) consecutiveCorrect = existingProgress.consecutive_correct + 1;

  db.prepare(`
    INSERT INTO word_progress (
      user_id, theme_id, word, answer_count, correct_count, wrong_count,
      consecutive_correct, mastery_status, last_studied_at
    )
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, theme_id, word)
    DO UPDATE SET answer_count = answer_count + 1,
                  correct_count = correct_count + excluded.correct_count,
                  wrong_count = wrong_count + excluded.wrong_count,
                  consecutive_correct = excluded.consecutive_correct,
                  mastery_status = excluded.mastery_status,
                  last_studied_at = excluded.last_studied_at
  `).run(
    userId,
    themeId,
    word,
    correct ? 1 : 0,
    correct ? 0 : 1,
    correct ? consecutiveCorrect : 0,
    correct ? (consecutiveCorrect >= 2 ? "mastered" : "learning") : "review",
    now()
  );

  if (!correct) {
    scheduleReview(userId, themeId, word, state.question_no, 0);
  } else if (queue && queue.status === "active") {
    const fixedCount = queue.consecutive_fix_count + 1;
    if (fixedCount >= 2) {
      db.prepare("UPDATE review_queue SET status = 'fixed', consecutive_fix_count = ?, updated_at = ? WHERE id = ?")
        .run(fixedCount, now(), queue.id);
      fixedReview = true;
    } else {
      scheduleReview(userId, themeId, word, state.question_no, fixedCount);
    }
  }

  touchSession(userId, "answer", correct);
  return {
    correct,
    correctCn: item.cn,
    ...rewardAnswer(userId, theme, word, correct, hadActiveReview, fixedReview)
  };
}

function progressSummary(userId) {
  const progress = db.prepare("SELECT * FROM word_progress WHERE user_id = ?").all(userId);
  const queue = db.prepare("SELECT * FROM review_queue WHERE user_id = ? AND status = 'active'").all(userId);
  const byKey = new Map(progress.map((item) => [`${item.theme_id}:${item.word}`, item]));
  const activeReview = new Set(queue.map((item) => `${item.theme_id}:${item.word}`));

  const themesSummary = themes.map((theme) => {
    const words = theme.items.map((item) => byKey.get(`${theme.id}:${item.word}`)).filter(Boolean);
    const mastered = words.filter((item) => item.mastery_status === "mastered").length;
    const answers = words.reduce((sum, item) => sum + item.answer_count, 0);
    const correct = words.reduce((sum, item) => sum + item.correct_count, 0);
    const reviewCount = theme.items.filter((item) => activeReview.has(`${theme.id}:${item.word}`)).length;
    return {
      id: theme.id,
      title: theme.title,
      subtitle: theme.subtitle,
      totalWords: theme.items.length,
      studiedWords: words.length,
      masteredWords: mastered,
      reviewCount,
      accuracy: answers ? Math.round((correct / answers) * 100) : 0,
      completion: Math.round((mastered / theme.items.length) * 100)
    };
  });

  const totals = themesSummary.reduce((acc, theme) => {
    acc.totalWords += theme.totalWords;
    acc.studiedWords += theme.studiedWords;
    acc.masteredWords += theme.masteredWords;
    acc.reviewCount += theme.reviewCount;
    return acc;
  }, { totalWords: 0, studiedWords: 0, masteredWords: 0, reviewCount: 0 });

  return { totals, themes: themesSummary };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function ensureRewardRow(userId) {
  const date = todayKey();
  let row = db.prepare("SELECT * FROM user_rewards WHERE user_id = ?").get(userId);
  if (!row) {
    db.prepare(`
      INSERT INTO user_rewards (user_id, reward_date, updated_at)
      VALUES (?, ?, ?)
    `).run(userId, date, now());
    row = db.prepare("SELECT * FROM user_rewards WHERE user_id = ?").get(userId);
  }
  if (row.reward_date !== date) {
    db.prepare(`
      UPDATE user_rewards
      SET today_exp = 0, reward_date = ?, updated_at = ?
      WHERE user_id = ?
    `).run(date, now(), userId);
    row = db.prepare("SELECT * FROM user_rewards WHERE user_id = ?").get(userId);
  }
  return row;
}

function levelInfo(totalExp) {
  let current = rewardLevels[0];
  for (const level of rewardLevels) {
    if (totalExp >= level.minExp) current = level;
  }
  const next = rewardLevels.find((level) => level.minExp > current.minExp);
  const nextMinExp = next ? next.minExp : current.minExp + 500;
  const levelExp = Math.max(0, totalExp - current.minExp);
  const levelNeed = Math.max(1, nextMinExp - current.minExp);
  return {
    level: current.level,
    title: current.title,
    gemKey: current.gemKey,
    levelExp,
    levelNeed,
    progressPercent: Math.min(100, Math.round((levelExp / levelNeed) * 100))
  };
}

function rewardSummary(userId) {
  const row = ensureRewardRow(userId);
  const level = levelInfo(row.total_exp);
  const badges = db.prepare(`
    SELECT theme_id AS themeId, title, created_at AS createdAt
    FROM theme_badges WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId);
  const recentEvents = db.prepare(`
    SELECT event_type AS type, exp, label, theme_id AS themeId, word, created_at AS createdAt
    FROM reward_events WHERE user_id = ? ORDER BY id DESC LIMIT 5
  `).all(userId);
  return {
    ...level,
    totalExp: row.total_exp,
    todayExp: row.today_exp,
    streakCorrect: row.streak_correct,
    fixedReviews: row.fixed_reviews,
    badges,
    recentEvents
  };
}

function eventPayload(event) {
  return {
    type: event.event_type || event.type,
    exp: event.exp || 0,
    label: event.label || "",
    themeId: event.theme_id || event.themeId || "",
    word: event.word || ""
  };
}

function grantReward(userId, event) {
  const beforeLevel = levelInfo(ensureRewardRow(userId).total_exp).level;
  let inserted = null;
  try {
    const result = db.prepare(`
      INSERT INTO reward_events (user_id, event_type, exp, label, theme_id, word, unique_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      event.type,
      event.exp,
      event.label || "",
      event.themeId || "",
      event.word || "",
      event.uniqueKey || null,
      now()
    );
    inserted = { id: result.lastInsertRowid, ...event };
  } catch (error) {
    if (!event.uniqueKey || !String(error.message || "").includes("UNIQUE")) throw error;
    return { events: [], state: rewardSummary(userId) };
  }

  if (event.exp > 0) {
    db.prepare(`
      UPDATE user_rewards
      SET total_exp = total_exp + ?,
          today_exp = today_exp + ?,
          updated_at = ?
      WHERE user_id = ?
    `).run(event.exp, event.exp, now(), userId);
  }

  const state = rewardSummary(userId);
  const events = [eventPayload(inserted)];
  if (state.level > beforeLevel) {
    events.push({
      type: "level_up",
      exp: 0,
      label: `升级到 ${state.title}`,
      level: state.level,
      gemKey: state.gemKey
    });
  }
  return { events, state };
}

function mergeRewardResult(target, rewardResult) {
  if (!rewardResult) return target;
  target.rewardEvents.push(...rewardResult.events);
  target.rewardState = rewardResult.state;
  return target;
}

function maybeGrantThemeBadge(userId, theme) {
  const mastered = db.prepare(`
    SELECT COUNT(*) AS count FROM word_progress
    WHERE user_id = ? AND theme_id = ? AND mastery_status = 'mastered'
  `).get(userId, theme.id).count;
  if (mastered < theme.items.length) return { events: [], state: rewardSummary(userId) };
  try {
    db.prepare(`
      INSERT INTO theme_badges (user_id, theme_id, title, created_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, theme.id, theme.title, now());
  } catch (error) {
    if (!String(error.message || "").includes("UNIQUE")) throw error;
    return { events: [], state: rewardSummary(userId) };
  }
  return grantReward(userId, {
    type: "theme_badge",
    exp: 60,
    label: `完成主题：${theme.title}`,
    themeId: theme.id,
    uniqueKey: `theme:${userId}:${theme.id}`
  });
}

function rewardRead(userId, themeId, word) {
  const date = todayKey();
  return grantReward(userId, {
    type: "read",
    exp: 1,
    label: "点读练习 +1",
    themeId,
    word,
    uniqueKey: `read:${userId}:${date}:${themeId}:${word}`
  });
}

function rewardAnswer(userId, theme, word, correct, hadActiveReview, fixedReview) {
  const result = { rewardEvents: [], rewardState: rewardSummary(userId) };
  const row = ensureRewardRow(userId);
  if (!correct) {
    db.prepare("UPDATE user_rewards SET streak_correct = 0, updated_at = ? WHERE user_id = ?").run(now(), userId);
    result.rewardState = rewardSummary(userId);
    return result;
  }

  const nextStreak = row.streak_correct + 1;
  db.prepare("UPDATE user_rewards SET streak_correct = ?, updated_at = ? WHERE user_id = ?").run(nextStreak, now(), userId);
  mergeRewardResult(result, grantReward(userId, {
    type: hadActiveReview ? "review_correct" : "correct",
    exp: hadActiveReview ? 12 : 8,
    label: hadActiveReview ? "错题答对 +12" : "答题正确 +8",
    themeId: theme.id,
    word
  }));

  if (nextStreak === 3 || nextStreak === 5 || nextStreak === 10 || (nextStreak > 10 && nextStreak % 10 === 0)) {
    const bonus = nextStreak >= 10 ? 22 : nextStreak === 5 ? 15 : 10;
    mergeRewardResult(result, grantReward(userId, {
      type: "streak",
      exp: bonus,
      label: `连对 x${nextStreak} +${bonus}`,
      themeId: theme.id,
      word
    }));
  }

  if (fixedReview) {
    db.prepare("UPDATE user_rewards SET fixed_reviews = fixed_reviews + 1, updated_at = ? WHERE user_id = ?").run(now(), userId);
    mergeRewardResult(result, grantReward(userId, {
      type: "review_fixed",
      exp: 25,
      label: "错题已修正 +25",
      themeId: theme.id,
      word
    }));
  }

  mergeRewardResult(result, maybeGrantThemeBadge(userId, theme));
  result.rewardState = rewardSummary(userId);
  return result;
}

initDb();
ensureAdmin();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(session({
  name: "mer.sid",
  secret: process.env.SESSION_SECRET || "dev-change-this-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

app.get("/portal.css", (req, res) => res.sendFile(path.join(publicDir, "portal.css")));
app.get("/login", (req, res) => res.sendFile(path.join(publicDir, "login.html")));
app.get("/admin-login", (req, res) => res.sendFile(path.join(publicDir, "admin-login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(publicDir, "register.html")));
app.get("/progress", requirePageAuth, (req, res) => res.sendFile(path.join(publicDir, "progress.html")));
app.get("/admin", requireAdminPage, (req, res) => res.sendFile(path.join(publicDir, "admin.html")));

app.post("/api/auth/register", (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const inviteCode = normalizeInvite(req.body.inviteCode);
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const nickname = username;
  if (!isValidPhone(phone) || !inviteCode || !username || password.length < 6) {
    return res.status(400).json({ error: "请填写正确手机号、邀请码、用户名和至少6位密码" });
  }
  const whitelist = db.prepare("SELECT * FROM phone_whitelist WHERE phone = ?").get(phone);
  if (!whitelist || whitelist.status !== "unused") return res.status(400).json({ error: "手机号不在白名单或邀请码已失效" });
  if (whitelist.invite_hash !== hashInvite(inviteCode)) return res.status(400).json({ error: "邀请码不正确" });
  if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) return res.status(409).json({ error: "用户名已被使用" });
  if (db.prepare("SELECT id FROM users WHERE phone = ?").get(phone)) return res.status(409).json({ error: "该手机号已注册" });

  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, nickname, phone, role, status, created_at)
      VALUES (?, ?, ?, ?, 'user', 'active', ?)
    `).run(username, bcrypt.hashSync(password, 10), nickname, phone, now());
    db.prepare(`
      UPDATE phone_whitelist
      SET status = 'used', used_by = ?, used_at = ?, invite_display = ''
      WHERE id = ?
    `).run(result.lastInsertRowid, now(), whitelist.id);
    return result.lastInsertRowid;
  });
  const userId = tx();
  req.session.userId = userId;
  return res.json({ ok: true, user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId)) });
});

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || user.status !== "active" || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "用户名或密码不正确" });
  }
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), user.id);
  req.session.userId = user.id;
  return res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
app.get("/api/themes", requireAuth, (req, res) => res.json({ themes }));
app.get("/api/progress", requireAuth, (req, res) => res.json(progressSummary(req.user.id)));
app.get("/api/rewards", requireAuth, (req, res) => res.json({ rewardState: rewardSummary(req.user.id) }));

app.post("/api/progress/word", requireAuth, (req, res) => {
  const themeId = String(req.body.themeId || "");
  const word = String(req.body.word || "");
  if (!themeMap.get(themeId)) return res.status(400).json({ error: "未知主题" });
  upsertReadProgress(req.user.id, themeId, word);
  const reward = rewardRead(req.user.id, themeId, word);
  return res.json({ ok: true, rewardEvents: reward.events, rewardState: reward.state });
});

app.get("/api/tts", requireAuth, async (req, res) => {
  try {
    const text = String(req.query.text || "");
    const audio = await ensureTtsAudio(text);
    res.setHeader("Content-Type", audio.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.sendFile(audio.filePath);
  } catch (error) {
    return res.status(503).json({ error: "腾讯云 TTS 暂不可用", detail: error.message });
  }
});

app.post("/api/quiz/next", requireAuth, (req, res) => {
  try {
    return res.json(chooseQuizItem(req.user.id, String(req.body.themeId || "")));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/quiz/answer", requireAuth, (req, res) => {
  try {
    return res.json(answerQuiz(req.user.id, String(req.body.themeId || ""), String(req.body.word || ""), String(req.body.selectedCn || "")));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/admin/whitelist", requireAdmin, (req, res) => {
  const pageSize = Math.min(50, positiveInt(req.query.pageSize, 10));
  const page = positiveInt(req.query.page, 1);
  const total = db.prepare("SELECT COUNT(*) AS count FROM phone_whitelist").get().count;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const rows = db.prepare(`
    SELECT id, phone, note, invite_display AS inviteCode, status, created_at, used_at, disabled_at
    FROM phone_whitelist ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, offset);
  return res.json({ items: rows, page: safePage, pageSize, total, totalPages });
});

app.post("/api/admin/whitelist", requireAdmin, (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const note = String(req.body.note || "").trim();
  if (!isValidPhone(phone)) return res.status(400).json({ error: "请输入正确的11位手机号" });
  const code = randomCode(6);
  try {
    const result = db.prepare(`
      INSERT INTO phone_whitelist (phone, note, invite_hash, invite_display, status, created_by, created_at)
      VALUES (?, ?, ?, ?, 'unused', ?, ?)
    `).run(phone, note, hashInvite(code), code, req.user.id, now());
    return res.json({ id: result.lastInsertRowid, phone, note, inviteCode: code, status: "unused" });
  } catch (error) {
    return res.status(409).json({ error: "该手机号已在白名单中" });
  }
});

app.patch("/api/admin/whitelist/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const note = String(req.body.note || "").trim();
  if (req.body.status === "disabled") {
    db.prepare("UPDATE phone_whitelist SET status = 'disabled', disabled_at = ? WHERE id = ? AND status = 'unused'")
      .run(now(), id);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "note")) {
    db.prepare("UPDATE phone_whitelist SET note = ? WHERE id = ?").run(note, id);
  }
  return res.json({ ok: true });
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const pageSize = Math.min(50, positiveInt(req.query.pageSize, 10));
  const page = positiveInt(req.query.page, 1);
  const phone = normalizePhone(req.query.phone);
  const where = phone ? "WHERE phone LIKE ?" : "";
  const values = phone ? [`%${phone}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) AS count FROM users ${where}`).get(...values).count;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const users = db.prepare(`
    SELECT id, username, nickname, phone, role, status, created_at, last_login_at
    FROM users ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...values, pageSize, offset);
  const items = users.map((user) => ({ ...user, progress: progressSummary(user.id).totals }));
  return res.json({ items, page: safePage, pageSize, total, totalPages });
});

app.patch("/api/admin/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "不能禁用当前管理员账号" });
  const status = req.body.status === "disabled" ? "disabled" : "active";
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
  return res.json({ ok: true });
});

app.post("/api/admin/users/:id/reset-password", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  if (user.role === "admin") return res.status(400).json({ error: "不能在这里重置管理员密码" });
  const password = randomPassword(10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 10), id);
  return res.json({ ok: true, username: user.username, password });
});

app.use("/", requirePageAuth, express.static(publicDir, { extensions: ["html"] }));
app.get("*", requirePageAuth, (req, res) => res.sendFile(path.join(publicDir, "index.html")));

app.listen(port, () => {
  console.log(`Minecraft English Reader listening on http://127.0.0.1:${port}`);
});
