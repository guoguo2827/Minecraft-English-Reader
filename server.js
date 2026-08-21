const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const vm = require("vm");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const createSqliteSessionStore = require("./lib/sqlite-session-store");
const { createWindowCounter, rateLimitMiddleware } = require("./lib/rate-limit");

const app = express();
const rootDir = __dirname;
const publicDir = path.join(rootDir, "outputs");
const dataDir = path.join(rootDir, "data");
const audioDir = path.join(dataDir, "audio");
const dbPath = process.env.DATABASE_PATH || path.join(dataDir, "app.db");
const sessionsDbPath = process.env.SESSION_DATABASE_PATH || path.join(dataDir, "sessions.db");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const sessionSecret = process.env.SESSION_SECRET || "dev-change-this-session-secret";
const appTimezone = process.env.APP_TIMEZONE || "Asia/Shanghai";
const accessControlEnforced = process.env.ACCESS_CONTROL_ENFORCED === "true";
const cookieSecure = process.env.COOKIE_SECURE === undefined
  ? process.env.NODE_ENV === "production"
  : process.env.COOKIE_SECURE === "true";
const trialDays = 14;
const referralLimit = 20;
const auditRetentionDays = 90;
const inviteAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const passwordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const dailyExpLimit = 150;
const speakingUnlockPercent = 80;
const speakingDailyLimit = positiveInt(process.env.TENCENT_SOE_DAILY_LIMIT, 20);
const speakingPhraseDailyLimit = positiveInt(process.env.TENCENT_SOE_PHRASE_DAILY_LIMIT, 5);
const speakingPackageTotal = positiveInt(process.env.TENCENT_SOE_PACKAGE_TOTAL, 10000);
const speakingPackageReserve = Math.min(
  speakingPackageTotal,
  positiveInt(process.env.TENCENT_SOE_PACKAGE_RESERVE, 500)
);
const speakingEnabled = process.env.TENCENT_SOE_ENABLED === "true";
const speakingInFlight = new Set();

if (process.env.NODE_ENV === "production" && sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters in production");
}
if (process.env.NODE_ENV === "production" && !cookieSecure) {
  console.warn("WARNING: COOKIE_SECURE=false; login traffic must be moved back to HTTPS as soon as possible.");
}
const rewardLevels = [
  { level: 1, minExp: 0, title: "煤炭新手", gemKey: "coal" },
  { level: 2, minExp: 120, title: "铁锭学徒", gemKey: "iron" },
  { level: 3, minExp: 320, title: "金锭冒险家", gemKey: "gold" },
  { level: 4, minExp: 650, title: "红石能手", gemKey: "redstone" },
  { level: 5, minExp: 1100, title: "青金石法师", gemKey: "lapis" },
  { level: 6, minExp: 1700, title: "绿宝石大师", gemKey: "emerald" },
  { level: 7, minExp: 2500, title: "钻石勇士", gemKey: "diamond" },
  { level: 8, minExp: 3600, title: "下界合金传奇", gemKey: "netherite" }
];
const chineseRewardLevels = [
  { level: 1, minExp: 0, title: "Coal Beginner", gemKey: "coal" },
  { level: 2, minExp: 120, title: "Iron Learner", gemKey: "iron" },
  { level: 3, minExp: 320, title: "Gold Explorer", gemKey: "gold" },
  { level: 4, minExp: 650, title: "Redstone Speaker", gemKey: "redstone" },
  { level: 5, minExp: 1100, title: "Lapis Scholar", gemKey: "lapis" },
  { level: 6, minExp: 1700, title: "Emerald Communicator", gemKey: "emerald" },
  { level: 7, minExp: 2500, title: "Diamond Master", gemKey: "diamond" },
  { level: 8, minExp: 3600, title: "Netherite Legend", gemKey: "netherite" }
];

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const SqliteSessionStore = createSqliteSessionStore(session);
const sessionStore = new SqliteSessionStore({ path: sessionsDbPath });

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
  return String(value || "").normalize("NFKC").replace(/[^\d]/g, "");
}

function passwordMatchesHash(value, hash) {
  const password = String(value || "");
  if (!hash) return false;
  try {
    if (bcrypt.compareSync(password, hash)) return true;
    const trimmed = password.trim();
    return trimmed !== password && bcrypt.compareSync(trimmed, hash);
  } catch {
    return false;
  }
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

function safeAudioName(text, voiceType, codec, lang = "en") {
  const normalized = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  const voiceKey = voiceType === undefined ? "default" : String(voiceType);
  return sha256(`${normalized}|lang:${lang}|voice:${voiceKey}|codec:${codec}`).slice(0, 32);
}

function parseVoiceType(raw) {
  if (/^-?\d+$/.test(String(raw).trim())) return Number(raw);
  return undefined;
}

function getTencentVoiceType(lang = "en") {
  if (lang === "zh") {
    return parseVoiceType(process.env.TENCENT_TTS_ZH_VOICE_TYPE || "501002");
  }
  return parseVoiceType(process.env.TENCENT_TTS_VOICE_TYPE || process.env.TENCENT_TTS_VOICE_NAME || "");
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

async function ensureTtsAudio(text, options = {}) {
  const normalizedText = String(text || "").trim().replace(/\s+/g, " ");
  if (!normalizedText || normalizedText.length > 80) throw new Error("Invalid TTS text");
  const lang = options.lang === "zh" ? "zh" : "en";
  const codec = (process.env.TENCENT_TTS_CODEC || "mp3").toLowerCase();
  const ext = codec === "wav" ? "wav" : "mp3";
  const voiceType = getTencentVoiceType(lang);
  const filePath = path.join(audioDir, `${safeAudioName(normalizedText, voiceType, ext, lang)}.${ext}`);
  if (fs.existsSync(filePath)) return { filePath, contentType: ext === "wav" ? "audio/wav" : "audio/mpeg", cached: true };

  if (options.beforeGenerate) options.beforeGenerate();

  const payload = {
    Text: normalizedText,
    SessionId: crypto.randomUUID(),
    Codec: ext,
    ModelType: 1,
    Speed: 0,
    Volume: 0,
    PrimaryLanguage: lang === "zh" ? 1 : 2,
    SampleRate: 16000
  };
  if (voiceType !== undefined) payload.VoiceType = voiceType;

  const response = await tencentTtsRequest(payload);
  if (!response?.Audio) throw new Error("Tencent TTS returned no audio");
  fs.writeFileSync(filePath, Buffer.from(response.Audio, "base64"));
  return { filePath, contentType: ext === "wav" ? "audio/wav" : "audio/mpeg", cached: false };
}

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function addColumn(table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migrationApplied(version) {
  return Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version));
}

function markMigration(version) {
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, now());
}

function generatedSocialName(userId) {
  const suffix = Number(userId).toString(36).toUpperCase().padStart(4, "0");
  return `BlockLearner-${suffix}`;
}

function applyPublicBetaMigration() {
  const version = "2026-08-09-public-beta-v1";
  if (migrationApplied(version)) return;
  db.transaction(() => {
    addColumn("users", "access_tier TEXT NOT NULL DEFAULT 'founder_trial'");
    addColumn("users", "trial_expires_at TEXT");
    addColumn("users", "primary_course TEXT NOT NULL DEFAULT 'english'");
    addColumn("users", "social_name TEXT");
    addColumn("phone_whitelist", "primary_course TEXT NOT NULL DEFAULT 'english'");

    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_user_id INTEGER,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT '',
        target_id TEXT NOT NULL DEFAULT '',
        details_json TEXT NOT NULL DEFAULT '{}',
        ip_hash TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(admin_user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS registration_applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        social_name TEXT NOT NULL,
        inviter_user_id INTEGER NOT NULL,
        referral_version INTEGER NOT NULL,
        primary_course TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        terms_version TEXT NOT NULL DEFAULT '2026-08-09',
        guardian_confirmed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by INTEGER,
        rejection_reason TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(inviter_user_id) REFERENCES users(id),
        FOREIGN KEY(reviewed_by) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS referral_links (
        user_id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        success_count INTEGER NOT NULL DEFAULT 0,
        max_uses INTEGER NOT NULL DEFAULT 20,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inviter_user_id INTEGER NOT NULL,
        invitee_user_id INTEGER NOT NULL UNIQUE,
        referral_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(inviter_user_id) REFERENCES users(id),
        FOREIGN KEY(invitee_user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS friendships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_low_id INTEGER NOT NULL,
        user_high_id INTEGER NOT NULL,
        primary_course TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK(user_low_id < user_high_id),
        UNIQUE(user_low_id, user_high_id),
        FOREIGN KEY(user_low_id) REFERENCES users(id),
        FOREIGN KEY(user_high_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS friend_weekly_challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        friendship_id INTEGER NOT NULL,
        week_key TEXT NOT NULL,
        primary_course TEXT NOT NULL,
        required_study_days INTEGER NOT NULL DEFAULT 3,
        required_answers INTEGER NOT NULL DEFAULT 30,
        status TEXT NOT NULL DEFAULT 'active',
        completed_at TEXT,
        UNIQUE(friendship_id, week_key),
        FOREIGN KEY(friendship_id) REFERENCES friendships(id)
      );

      CREATE TABLE IF NOT EXISTS friend_pk_bonus_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        friendship_id INTEGER NOT NULL,
        week_key TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 20,
        unique_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(friendship_id) REFERENCES friendships(id)
      );

      CREATE TABLE IF NOT EXISTS friend_badges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        friendship_id INTEGER NOT NULL,
        week_key TEXT NOT NULL,
        badge_key TEXT NOT NULL DEFAULT 'weekly-coop',
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, friendship_id, week_key, badge_key),
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(friendship_id) REFERENCES friendships(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_social_name ON users(social_name) WHERE social_name IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_application_phone
        ON registration_applications(phone) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_audit_created_at ON admin_audit_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_applications_status_created ON registration_applications(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_reward_events_user_created ON reward_events(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_chinese_reward_events_user_created ON chinese_reward_events(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_friendships_low ON friendships(user_low_id);
      CREATE INDEX IF NOT EXISTS idx_friendships_high ON friendships(user_high_id);
    `);

    const users = db.prepare("SELECT id, role FROM users").all();
    const englishActivity = db.prepare(`
      SELECT COALESCE(SUM(read_count + answer_count), 0) AS score FROM word_progress WHERE user_id = ?
    `);
    const chineseActivity = db.prepare(`
      SELECT COALESCE(SUM(read_count + answer_count), 0) AS score FROM chinese_word_progress WHERE user_id = ?
    `);
    const updateUser = db.prepare(`
      UPDATE users
      SET access_tier = 'founder_trial', trial_expires_at = NULL,
          primary_course = ?, social_name = ?
      WHERE id = ?
    `);
    for (const user of users) {
      const course = user.role === "admin" || englishActivity.get(user.id).score >= chineseActivity.get(user.id).score
        ? "english"
        : "chinese";
      updateUser.run(course, generatedSocialName(user.id), user.id);
    }
    markMigration(version);
  })();
}

function applyThreeCorrectReviewMigration() {
  const version = "2026-08-09-review-three-correct-v1";
  if (migrationApplied(version)) return;
  db.transaction(() => {
    const updatedAt = now();
    db.prepare(`
      UPDATE review_queue
      SET status = 'active', updated_at = ?
      WHERE status = 'fixed' AND consecutive_fix_count < 3
    `).run(updatedAt);
    db.prepare(`
      UPDATE chinese_review_queue
      SET status = 'active', updated_at = ?
      WHERE status = 'fixed' AND consecutive_fix_count < 3
    `).run(updatedAt);
    markMigration(version);
  })();
}

function applyAdminDashboardMigration() {
  const version = "2026-08-10-admin-dashboard-v1";
  if (migrationApplied(version)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_login_days (
        user_id INTEGER NOT NULL,
        login_date TEXT NOT NULL,
        login_count INTEGER NOT NULL DEFAULT 1,
        first_login_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL,
        PRIMARY KEY(user_id, login_date),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_login_days_date ON user_login_days(login_date, user_id);
      CREATE INDEX IF NOT EXISTS idx_study_sessions_date ON study_sessions(study_date, user_id);
      CREATE INDEX IF NOT EXISTS idx_chinese_study_sessions_date ON chinese_study_sessions(study_date, user_id);
      CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login_at);
      CREATE INDEX IF NOT EXISTS idx_friendships_created ON friendships(created_at);
    `);
    markMigration(version);
  })();
}

function applySinglePassQuizMigration() {
  const version = "2026-08-12-theme-single-pass-v1";
  if (migrationApplied(version)) return;
  db.transaction(() => {
    db.prepare(`
      UPDATE word_progress
      SET mastery_status = 'mastered'
      WHERE correct_count > 0
        AND NOT EXISTS (
          SELECT 1 FROM review_queue
          WHERE review_queue.user_id = word_progress.user_id
            AND review_queue.theme_id = word_progress.theme_id
            AND review_queue.word = word_progress.word
            AND review_queue.status = 'active'
        )
    `).run();
    db.prepare(`
      UPDATE chinese_word_progress
      SET mastery_status = 'mastered'
      WHERE correct_count > 0
        AND NOT EXISTS (
          SELECT 1 FROM chinese_review_queue
          WHERE chinese_review_queue.user_id = chinese_word_progress.user_id
            AND chinese_review_queue.theme_id = chinese_word_progress.theme_id
            AND chinese_review_queue.item_id = chinese_word_progress.item_id
            AND chinese_review_queue.status = 'active'
        )
    `).run();
    markMigration(version);
  })();
}

function applySpeakingMigration() {
  const version = "2026-08-21-speaking-assessment-v1";
  if (migrationApplied(version)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS speaking_eligibility (
        user_id INTEGER PRIMARY KEY,
        unlocked_at TEXT NOT NULL,
        mastered_words_snapshot INTEGER NOT NULL,
        total_words_snapshot INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS speaking_phrase_progress (
        user_id INTEGER NOT NULL,
        phrase_id INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        best_score REAL NOT NULL DEFAULT 0,
        best_accuracy REAL NOT NULL DEFAULT 0,
        best_fluency REAL NOT NULL DEFAULT 0,
        best_completion REAL NOT NULL DEFAULT 0,
        stars INTEGER NOT NULL DEFAULT 0,
        mastered_at TEXT,
        last_attempt_at TEXT NOT NULL,
        PRIMARY KEY(user_id, phrase_id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS speaking_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        phrase_id INTEGER NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        score REAL,
        accuracy REAL,
        fluency REAL,
        completion REAL,
        passed INTEGER NOT NULL DEFAULT 0,
        error_code TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS speaking_theme_badges (
        user_id INTEGER NOT NULL,
        theme_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(user_id, theme_id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_speaking_attempts_user_date
        ON speaking_attempts(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_speaking_attempts_phrase_date
        ON speaking_attempts(user_id, phrase_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_speaking_attempts_status
        ON speaking_attempts(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_speaking_progress_mastered
        ON speaking_phrase_progress(user_id, mastered_at);
    `);
    markMigration(version);
  })();
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
      password_reset_required INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS chinese_word_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      theme_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      read_count INTEGER NOT NULL DEFAULT 0,
      answer_count INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      consecutive_correct INTEGER NOT NULL DEFAULT 0,
      mastery_status TEXT NOT NULL DEFAULT 'new',
      last_studied_at TEXT,
      UNIQUE(user_id, theme_id, item_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS chinese_review_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      theme_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      due_question_no INTEGER NOT NULL,
      consecutive_fix_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, theme_id, item_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS chinese_theme_quiz_state (
      user_id INTEGER NOT NULL,
      theme_id TEXT NOT NULL,
      question_no INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, theme_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS chinese_study_sessions (
      user_id INTEGER NOT NULL,
      study_date TEXT NOT NULL,
      read_count INTEGER NOT NULL DEFAULT 0,
      answer_count INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, study_date),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS chinese_user_rewards (
      user_id INTEGER PRIMARY KEY,
      total_exp INTEGER NOT NULL DEFAULT 0,
      today_exp INTEGER NOT NULL DEFAULT 0,
      reward_date TEXT NOT NULL,
      streak_correct INTEGER NOT NULL DEFAULT 0,
      fixed_reviews INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS chinese_reward_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      exp INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL DEFAULT '',
      theme_id TEXT DEFAULT '',
      item_id TEXT DEFAULT '',
      unique_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS chinese_theme_badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      theme_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, theme_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
  if (!userColumns.includes("password_reset_required")) {
    db.exec("ALTER TABLE users ADD COLUMN password_reset_required INTEGER NOT NULL DEFAULT 0");
  }
  applyPublicBetaMigration();
  applyThreeCorrectReviewMigration();
  applyAdminDashboardMigration();
  applySinglePassQuizMigration();
  applySpeakingMigration();
}

function ensureAdmin() {
  const admins = db.prepare("SELECT id, social_name FROM users WHERE role = 'admin'").all();
  if (admins.length > 0) {
    const repair = db.prepare(`
      UPDATE users SET access_tier = 'founder_trial', trial_expires_at = NULL,
        primary_course = 'english', social_name = COALESCE(social_name, ?)
      WHERE id = ?
    `);
    for (const admin of admins) repair.run(generatedSocialName(admin.id), admin.id);
    return;
  }
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "admin123456";
  if (process.env.NODE_ENV === "production" && password.length < 12) {
    throw new Error("ADMIN_PASSWORD must contain at least 12 characters when creating the production administrator");
  }
  const phone = normalizePhone(process.env.ADMIN_PHONE || "13800000000");
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, nickname, phone, role, status, created_at)
    VALUES (?, ?, ?, ?, 'admin', 'active', ?)
  `).run(username, bcrypt.hashSync(password, 10), "管理员", phone, now());
  db.prepare("UPDATE users SET social_name = ?, access_tier = 'founder_trial', primary_course = 'english' WHERE id = ?")
    .run(generatedSocialName(result.lastInsertRowid), result.lastInsertRowid);
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

function loadChineseThemes() {
  const source = fs.readFileSync(path.join(publicDir, "core-words-data.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: "core-words-data.js" });
  const sourceThemes = sandbox.window.CORE_WORD_THEMES;
  if (!Array.isArray(sourceThemes)) throw new Error("Cannot find Core Words themes");
  return sourceThemes.map((theme) => ({
    id: String(theme.id),
    title: String(theme.title),
    subtitle: String(theme.subtitle || `${theme.items.length} words`),
    items: theme.items.map((item) => ({
      id: `${theme.id}:${String(item.word).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      english: String(item.word),
      chinese: String(item.cn),
      image: `/${String(item.image).replace(/^\/+/, "")}`
    }))
  }));
}

function loadSpeakingThemes() {
  const source = fs.readFileSync(path.join(publicDir, "minecraft-phrases-data.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: "minecraft-phrases-data.js" });
  const sourceThemes = sandbox.window.MINECRAFT_PHRASE_THEMES;
  if (!Array.isArray(sourceThemes)) throw new Error("Cannot find speaking phrase themes");
  const seenIds = new Set();
  return sourceThemes.map((theme) => ({
    id: String(theme.id),
    title: String(theme.title),
    subtitle: String(theme.subtitle || ""),
    items: theme.items.map((item) => {
      const id = Number(item.id);
      const english = String(item.english || "").trim();
      const chinese = String(item.chinese || "").trim();
      if (!Number.isInteger(id) || seenIds.has(id) || !english || !chinese) {
        throw new Error(`Invalid speaking phrase item: ${item.id}`);
      }
      if (english.split(/\s+/).length > 30) throw new Error(`Speaking phrase ${id} exceeds 30 words`);
      seenIds.add(id);
      return { id, english, chinese, themeId: String(theme.id) };
    })
  }));
}

const themes = loadThemes();
const themeMap = new Map(themes.map((theme) => [theme.id, theme]));
const chineseThemes = loadChineseThemes();
const chineseThemeMap = new Map(chineseThemes.map((theme) => [theme.id, theme]));
const speakingThemes = loadSpeakingThemes();
const speakingItems = speakingThemes.flatMap((theme) => theme.items);
const speakingItemMap = new Map(speakingItems.map((item) => [item.id, item]));

const freeThemeIds = {
  english: new Set(["animals", "tools", "concepts"]),
  chinese: new Set(chineseThemes.filter((theme) => ["Animal", "Food"].includes(theme.title)).map((theme) => theme.id))
};

function shanghaiDateKey(value = new Date()) {
  const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function weekRange(value = new Date()) {
  const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  const day = shifted.getUTCDay() || 7;
  const mondayLocal = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - day + 1
  ));
  const start = new Date(mondayLocal.getTime() - 8 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { weekKey: mondayLocal.toISOString().slice(0, 10), start: start.toISOString(), end: end.toISOString() };
}

function validDateKey(value) {
  const key = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const parsed = new Date(`${key}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === key ? key : "";
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateKeyRange(dateKey) {
  const start = new Date(`${dateKey}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function adminDashboardDate(value) {
  const today = shanghaiDateKey();
  const requested = value ? validDateKey(value) : today;
  const earliest = shiftDateKey(today, -29);
  if (!requested || requested < earliest || requested > today) return null;
  return requested;
}

function userAccessState(user, at = new Date()) {
  if (!user) return "expired";
  if (user.role === "admin" || user.access_tier === "founder_trial") return "founder_trial";
  if (!user.trial_expires_at || new Date(user.trial_expires_at) <= at) return "expired";
  return "free_trial";
}

function courseThemeList(course) {
  return course === "chinese" ? chineseThemes : themes;
}

function allowedThemeIds(user, course) {
  if (!user) return [];
  if (user.role === "admin") return courseThemeList(course).map((theme) => theme.id);
  if (user.primary_course !== course || userAccessState(user) === "expired") return [];
  if (user.access_tier === "founder_trial") return courseThemeList(course).map((theme) => theme.id);
  return [...freeThemeIds[course]];
}

function learningAccessError(user, course, themeId) {
  if (user.role === "admin") return null;
  if (userAccessState(user) === "expired") {
    return { status: 403, code: "TRIAL_EXPIRED", error: "体验已到期，请联系管理员" };
  }
  if (user.primary_course !== course) {
    return { status: 403, code: "COURSE_LOCKED", error: "该课程不属于你的当前学习方向" };
  }
  if (themeId && !allowedThemeIds(user, course).includes(themeId)) {
    return { status: 403, code: "THEME_LOCKED", error: "该主题尚未解锁" };
  }
  return null;
}

function enforceLearningAccess(req, res, course, themeId) {
  if (!accessControlEnforced) return true;
  const problem = learningAccessError(req.user, course, themeId);
  if (!problem) return true;
  res.status(problem.status).json({ code: problem.code, error: problem.error });
  return false;
}

function canonicalTtsAllowed(user, lang, text) {
  const course = lang === "zh" ? "chinese" : "english";
  if (accessControlEnforced && learningAccessError(user, course)) return false;
  const allowed = new Set(accessControlEnforced
    ? allowedThemeIds(user, course)
    : courseThemeList(course).map((theme) => theme.id));
  const normalized = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  return courseThemeList(course).some((theme) => {
    if (!allowed.has(theme.id)) return false;
    return theme.items.some((item) => {
      const candidate = course === "chinese" ? item.chinese : item.word;
      return String(candidate || "").trim().toLowerCase().replace(/\s+/g, " ") === normalized;
    });
  });
}

function auditIpHash(req) {
  const secret = process.env.AUDIT_HASH_SECRET || process.env.SESSION_SECRET || "dev-audit-secret";
  return hmacSha256(secret, String(req.ip || req.socket?.remoteAddress || ""), "hex").slice(0, 24);
}

function auditAdmin(req, action, targetType = "", targetId = "", details = {}) {
  db.prepare(`
    INSERT INTO admin_audit_logs (
      admin_user_id, action, target_type, target_id, details_json, ip_hash, user_agent, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user?.id || null,
    action,
    targetType,
    String(targetId || ""),
    JSON.stringify(details),
    auditIpHash(req),
    String(req.get("user-agent") || "").slice(0, 255),
    now()
  );
}

function cleanupAuditLogs() {
  const cutoff = new Date(Date.now() - auditRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM admin_audit_logs WHERE created_at < ?").run(cutoff);
}

function limiterHash(value) {
  const secret = process.env.RATE_LIMIT_SECRET || process.env.SESSION_SECRET || "dev-rate-limit-secret";
  return hmacSha256(secret, String(value || ""), "hex").slice(0, 32);
}

const loginIpCounter = createWindowCounter({ windowMs: 15 * 60 * 1000, max: 30 });
const loginPhoneCounter = createWindowCounter({ windowMs: 15 * 60 * 1000, max: 8 });
const registerIpCounter = createWindowCounter({ windowMs: 60 * 60 * 1000, max: 10 });
const registerPhoneCounter = createWindowCounter({ windowMs: 24 * 60 * 60 * 1000, max: 3 });
const ttsUserCounter = createWindowCounter({ windowMs: 10 * 60 * 1000, max: 180 });
const ttsIpCounter = createWindowCounter({ windowMs: 10 * 60 * 1000, max: 300 });
const ttsGenerationCounter = createWindowCounter({ windowMs: 60 * 60 * 1000, max: 120 });
const speakingIpCounter = createWindowCounter({ windowMs: 10 * 60 * 1000, max: 60 });

const limitLoginIp = rateLimitMiddleware({
  counter: loginIpCounter,
  key: (req) => `login-ip:${limiterHash(req.ip)}`,
  code: "LOGIN_IP_RATE_LIMITED",
  message: "登录尝试过于频繁，请稍后再试"
});
const limitLoginPhone = rateLimitMiddleware({
  counter: loginPhoneCounter,
  key: (req) => {
    const phone = normalizePhone(req.body?.phone || req.body?.username);
    return isValidPhone(phone) ? `login-phone:${limiterHash(phone)}` : "";
  },
  code: "LOGIN_PHONE_RATE_LIMITED",
  message: "该手机号登录尝试过于频繁，请稍后再试"
});
const limitRegisterIp = rateLimitMiddleware({
  counter: registerIpCounter,
  key: (req) => `register-ip:${limiterHash(req.ip)}`,
  code: "REGISTER_IP_RATE_LIMITED",
  message: "注册申请过于频繁，请稍后再试"
});
const limitRegisterPhone = rateLimitMiddleware({
  counter: registerPhoneCounter,
  key: (req) => {
    const phone = normalizePhone(req.body?.phone);
    return isValidPhone(phone) ? `register-phone:${limiterHash(phone)}` : "";
  },
  code: "REGISTER_PHONE_RATE_LIMITED",
  message: "该手机号提交申请过于频繁，请明天再试"
});
const limitTtsUser = rateLimitMiddleware({
  counter: ttsUserCounter,
  key: (req) => `tts-user:${req.user.id}`,
  code: "TTS_USER_RATE_LIMITED",
  message: "语音请求过于频繁，请稍后再试"
});
const limitTtsIp = rateLimitMiddleware({
  counter: ttsIpCounter,
  key: (req) => `tts-ip:${limiterHash(req.ip)}`,
  code: "TTS_IP_RATE_LIMITED",
  message: "当前网络的语音请求过于频繁，请稍后再试"
});
const limitSpeakingIp = rateLimitMiddleware({
  counter: speakingIpCounter,
  key: (req) => `speaking-ip:${limiterHash(req.ip)}`,
  code: "SPEAKING_IP_RATE_LIMITED",
  message: "当前网络的口语评测请求过于频繁，请稍后再试"
});

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    phone: user.phone,
    role: user.role,
    status: user.status,
    accountStatus: user.status,
    accessState: userAccessState(user),
    accessTier: user.access_tier,
    trialExpiresAt: user.trial_expires_at,
    primaryCourse: user.primary_course,
    socialName: user.social_name,
    allowedThemeIds: {
      english: allowedThemeIds(user, "english"),
      chinese: allowedThemeIds(user, "chinese")
    },
    accessControlEnforced,
    passwordResetRequired: Boolean(user.password_reset_required)
  };
}

function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(req.session.userId) || null;
}

function sessionUser(req) {
  if (!req.session.userId) return null;
  return db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId) || null;
}

function establishSession(req, userId, callback) {
  req.session.regenerate((error) => {
    if (error) return callback(error);
    req.session.userId = userId;
    return req.session.save(callback);
  });
}

function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: "请先登录" });
  if (user.status !== "active") return res.status(403).json({ code: "ACCOUNT_DISABLED", error: "账号已被禁用，请联系管理员" });
  req.user = user;
  return next();
}

function requirePasswordReadyPage(req, res, next) {
  const user = currentUser(req);
  const returnPath = ["/progress", "/chinese", "/chinese/progress", "/friends", "/access-status", "/speaking"].includes(req.path) ? req.path : "";
  const suffix = returnPath ? `?next=${encodeURIComponent(returnPath)}` : "";
  if (!user) return res.redirect(`/login${suffix}`);
  if (user.password_reset_required) return res.redirect(`/reset-password${suffix}`);
  req.user = user;
  return next();
}

function requireStudyPage(course) {
  return (req, res, next) => {
    const user = currentUser(req);
    const suffix = `?next=${encodeURIComponent(req.originalUrl)}`;
    if (!user) return res.redirect(`/login${suffix}`);
    if (user.password_reset_required) return res.redirect(`/reset-password${suffix}`);
    req.user = user;
    if (accessControlEnforced && learningAccessError(user, course)) {
      return res.sendFile(path.join(publicDir, "access-status.html"));
    }
    return next();
  };
}

function requireAdmin(req, res, next) {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: "请先登录" });
  if (user.status !== "active") return res.status(403).json({ code: "ACCOUNT_DISABLED", error: "账号已被禁用" });
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
  const today = shanghaiDateKey();
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
  const reviewItems = db.prepare(`
    SELECT word, due_question_no, status, updated_at FROM review_queue
    WHERE user_id = ? AND theme_id = ?
  `).all(userId, themeId);
  const activeReviews = reviewItems.filter((item) => item.status === "active");
  const activeWords = new Set(activeReviews.map((item) => item.word));
  const dueWords = new Set(activeReviews
    .filter((item) => item.due_question_no <= questionNo)
    .map((item) => item.word));
  const correctWords = new Set(db.prepare(`
    SELECT word FROM word_progress
    WHERE user_id = ? AND theme_id = ? AND correct_count > 0
  `).all(userId, themeId).map((item) => item.word));
  const freshItems = theme.items.filter((item) => !correctWords.has(item.word) && !activeWords.has(item.word));
  let candidates = dueWords.size
    ? theme.items.filter((item) => dueWords.has(item.word))
    : freshItems;
  if (!candidates.length && activeReviews.length) {
    const earliestDue = Math.min(...activeReviews.map((item) => item.due_question_no));
    const earliestWords = new Set(activeReviews
      .filter((item) => item.due_question_no === earliestDue)
      .map((item) => item.word));
    candidates = theme.items.filter((item) => earliestWords.has(item.word));
  }
  if (!candidates.length) {
    const badge = maybeGrantThemeBadge(userId, theme);
    return {
      completed: true,
      themeId,
      themeTitle: theme.title,
      totalWords: theme.items.length,
      rewardEvents: badge.events,
      rewardState: badge.state
    };
  }
  db.prepare("UPDATE theme_quiz_state SET question_no = ?, updated_at = ? WHERE user_id = ? AND theme_id = ?")
    .run(questionNo, now(), userId, themeId);
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
  const reviewFixCount = correct && hadActiveReview ? queue.consecutive_fix_count + 1 : 0;
  const masteryStatus = !correct
    ? "review"
    : hadActiveReview && reviewFixCount < 3
      ? "review"
      : "mastered";

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
    masteryStatus,
    now()
  );

  if (!correct) {
    scheduleReview(userId, themeId, word, state.question_no, 0);
  } else if (queue && queue.status === "active") {
    const fixedCount = queue.consecutive_fix_count + 1;
    if (fixedCount >= 3) {
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
      answerCount: answers,
      correctCount: correct,
      accuracy: answers ? Math.round((correct / answers) * 100) : 0,
      completion: Math.round((mastered / theme.items.length) * 100),
      lastStudiedAt: words.reduce((latest, item) => {
        if (!item.last_studied_at) return latest;
        return !latest || item.last_studied_at > latest ? item.last_studied_at : latest;
      }, "")
    };
  });

  const totals = themesSummary.reduce((acc, theme) => {
    acc.totalWords += theme.totalWords;
    acc.studiedWords += theme.studiedWords;
    acc.masteredWords += theme.masteredWords;
    acc.reviewCount += theme.reviewCount;
    acc.answerCount += theme.answerCount;
    acc.correctCount += theme.correctCount;
    if (theme.lastStudiedAt && (!acc.lastStudiedAt || theme.lastStudiedAt > acc.lastStudiedAt)) {
      acc.lastStudiedAt = theme.lastStudiedAt;
    }
    return acc;
  }, {
    totalWords: 0,
    studiedWords: 0,
    masteredWords: 0,
    reviewCount: 0,
    answerCount: 0,
    correctCount: 0,
    lastStudiedAt: ""
  });
  totals.accuracy = totals.answerCount ? Math.round((totals.correctCount / totals.answerCount) * 100) : 0;
  totals.completion = totals.totalWords ? Math.round((totals.masteredWords / totals.totalWords) * 100) : 0;

  return { totals, themes: themesSummary };
}

function speakingEligibility(user, options = {}) {
  const persist = options.persist !== false;
  const totals = progressSummary(user.id).totals;
  const requiredWords = Math.ceil(totals.totalWords * speakingUnlockPercent / 100);
  let eligibility = db.prepare("SELECT * FROM speaking_eligibility WHERE user_id = ?").get(user.id);
  const adminBypass = user.role === "admin";
  const reachedRequirement = totals.masteredWords >= requiredWords;

  if (!eligibility && !adminBypass && user.primary_course === "english" && reachedRequirement && persist) {
    db.prepare(`
      INSERT OR IGNORE INTO speaking_eligibility (
        user_id, unlocked_at, mastered_words_snapshot, total_words_snapshot
      ) VALUES (?, ?, ?, ?)
    `).run(user.id, now(), totals.masteredWords, totals.totalWords);
    eligibility = db.prepare("SELECT * FROM speaking_eligibility WHERE user_id = ?").get(user.id);
  }

  const qualified = adminBypass || Boolean(eligibility) || (user.primary_course === "english" && reachedRequirement);
  let reason = "";
  if (user.status !== "active") reason = "ACCOUNT_DISABLED";
  else if (!adminBypass && user.primary_course !== "english") reason = "COURSE_LOCKED";
  else if (!adminBypass && userAccessState(user) === "expired") reason = "TRIAL_EXPIRED";
  else if (!qualified) reason = "PROGRESS_REQUIRED";

  return {
    qualified,
    canAssess: qualified && !reason,
    adminBypass,
    unlockedAt: eligibility?.unlocked_at || (adminBypass ? "admin" : null),
    masteredWords: totals.masteredWords,
    totalWords: totals.totalWords,
    requiredWords,
    remainingWords: Math.max(0, requiredWords - totals.masteredWords),
    percent: totals.totalWords ? Math.floor(totals.masteredWords / totals.totalWords * 100) : 0,
    reason
  };
}

function enforceSpeakingAccess(req, res) {
  const eligibility = speakingEligibility(req.user);
  if (eligibility.canAssess) return eligibility;
  const messages = {
    ACCOUNT_DISABLED: "账号已被禁用",
    COURSE_LOCKED: "口语测评只对英语主课程用户开放",
    TRIAL_EXPIRED: "体验已到期，请联系管理员",
    PROGRESS_REQUIRED: `掌握英语主课程 ${speakingUnlockPercent}% 的单词后即可解锁`
  };
  res.status(403).json({
    code: "SPEAKING_LOCKED",
    reason: eligibility.reason,
    error: messages[eligibility.reason] || "口语测评尚未解锁",
    eligibility
  });
  return null;
}

function speakingStars(score, completion) {
  if (score >= 80 && completion >= 0.8) return 3;
  if (score >= 70) return 2;
  if (score >= 60) return 1;
  return 0;
}

function speakingDateBounds(date = shanghaiDateKey()) {
  return dateKeyRange(date);
}

function speakingUsageCount(userId, phraseId = null, date = shanghaiDateKey()) {
  const bounds = speakingDateBounds(date);
  const phraseSql = phraseId === null ? "" : " AND phrase_id = ?";
  const values = phraseId === null
    ? [userId, bounds.start, bounds.end]
    : [userId, bounds.start, bounds.end, phraseId];
  return db.prepare(`
    SELECT COUNT(*) AS count FROM speaking_attempts
    WHERE user_id = ? AND created_at >= ? AND created_at < ?${phraseSql}
  `).get(...values).count;
}

function speakingPackageUsage() {
  return db.prepare("SELECT COUNT(*) AS count FROM speaking_attempts").get().count;
}

function speakingProgressSummary(userId) {
  const rows = db.prepare("SELECT * FROM speaking_phrase_progress WHERE user_id = ?").all(userId);
  const attempted = rows.filter((row) => row.attempt_count > 0);
  const mastered = rows.filter((row) => row.mastered_at);
  const badges = db.prepare(`
    SELECT theme_id AS themeId, title, created_at AS createdAt
    FROM speaking_theme_badges WHERE user_id = ? ORDER BY created_at
  `).all(userId);
  const todayUsed = speakingUsageCount(userId);
  const bestScoreTotal = attempted.reduce((sum, row) => sum + Number(row.best_score || 0), 0);
  return {
    totalPhrases: speakingItems.length,
    attemptedPhrases: attempted.length,
    masteredPhrases: mastered.length,
    averageBestScore: attempted.length ? Math.round(bestScoreTotal / attempted.length) : 0,
    todayUsed,
    todayLimit: speakingDailyLimit,
    todayRemaining: Math.max(0, speakingDailyLimit - todayUsed),
    badges
  };
}

function speakingThemesForUser(userId) {
  const progress = new Map(db.prepare(`
    SELECT phrase_id, attempt_count, best_score, stars, mastered_at, last_attempt_at
    FROM speaking_phrase_progress WHERE user_id = ?
  `).all(userId).map((row) => [row.phrase_id, row]));
  return speakingThemes.map((theme) => ({
    id: theme.id,
    title: theme.title,
    subtitle: theme.subtitle,
    items: theme.items.map((item) => {
      const row = progress.get(item.id);
      return {
        id: item.id,
        english: item.english,
        chinese: item.chinese,
        attempts: row?.attempt_count || 0,
        bestScore: Math.round(row?.best_score || 0),
        stars: row?.stars || 0,
        mastered: Boolean(row?.mastered_at),
        lastAttemptAt: row?.last_attempt_at || null
      };
    })
  }));
}

function grantSpeakingBadges(userId) {
  const created = [];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO speaking_theme_badges (user_id, theme_id, title, created_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const theme of speakingThemes) {
    const mastered = db.prepare(`
      SELECT COUNT(*) AS count FROM speaking_phrase_progress
      WHERE user_id = ? AND mastered_at IS NOT NULL AND phrase_id IN (${theme.items.map(() => "?").join(",")})
    `).get(userId, ...theme.items.map((item) => item.id)).count;
    if (mastered === theme.items.length) {
      const result = insert.run(userId, theme.id, `${theme.title}口语徽章`, now());
      if (result.changes) created.push({ themeId: theme.id, title: `${theme.title}口语徽章` });
    }
  }
  const allMastered = db.prepare(`
    SELECT COUNT(*) AS count FROM speaking_phrase_progress
    WHERE user_id = ? AND mastered_at IS NOT NULL
  `).get(userId).count;
  if (allMastered >= speakingItems.length) {
    const result = insert.run(userId, "all", "方块口语大师", now());
    if (result.changes) created.push({ themeId: "all", title: "方块口语大师" });
  }
  return created;
}

function normalizeSoeResult(raw) {
  let result = raw;
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { result = {}; }
  }
  const score = Math.max(0, Math.min(100, Number(result?.SuggestedScore || 0)));
  const accuracy = Math.max(0, Math.min(100, Number(result?.PronAccuracy || 0)));
  const fluency = Math.max(0, Math.min(1, Number(result?.PronFluency || 0)));
  const completion = Math.max(0, Math.min(1, Number(result?.PronCompletion || 0)));
  const passed = score >= 80 && completion >= 0.8;
  return { score, accuracy, fluency, completion, passed, stars: speakingStars(score, completion) };
}

function recordSpeakingResult(userId, phraseId, requestId, rawResult) {
  const result = normalizeSoeResult(rawResult);
  const timestamp = now();
  return db.transaction(() => {
    db.prepare(`
      UPDATE speaking_attempts SET status = 'succeeded', score = ?, accuracy = ?, fluency = ?,
        completion = ?, passed = ?, finished_at = ? WHERE request_id = ? AND user_id = ?
    `).run(result.score, result.accuracy, result.fluency, result.completion, result.passed ? 1 : 0, timestamp, requestId, userId);
    db.prepare(`
      INSERT INTO speaking_phrase_progress (
        user_id, phrase_id, attempt_count, best_score, best_accuracy, best_fluency,
        best_completion, stars, mastered_at, last_attempt_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, phrase_id) DO UPDATE SET
        attempt_count = speaking_phrase_progress.attempt_count + 1,
        best_accuracy = CASE WHEN excluded.best_score > speaking_phrase_progress.best_score THEN excluded.best_accuracy ELSE speaking_phrase_progress.best_accuracy END,
        best_fluency = CASE WHEN excluded.best_score > speaking_phrase_progress.best_score THEN excluded.best_fluency ELSE speaking_phrase_progress.best_fluency END,
        best_completion = CASE WHEN excluded.best_score > speaking_phrase_progress.best_score THEN excluded.best_completion ELSE speaking_phrase_progress.best_completion END,
        best_score = MAX(speaking_phrase_progress.best_score, excluded.best_score),
        stars = MAX(speaking_phrase_progress.stars, excluded.stars),
        mastered_at = COALESCE(speaking_phrase_progress.mastered_at, excluded.mastered_at),
        last_attempt_at = excluded.last_attempt_at
    `).run(
      userId, phraseId, result.score, result.accuracy, result.fluency,
      result.completion, result.stars, result.passed ? timestamp : null, timestamp
    );
    const badges = grantSpeakingBadges(userId);
    return { ...result, badges, progress: speakingProgressSummary(userId) };
  })();
}

function buildSoeWebSocketUrl(referenceText, voiceId = crypto.randomUUID()) {
  const appId = String(process.env.TENCENT_SOE_APP_ID || "").trim();
  const secretId = String(process.env.TENCENT_SECRET_ID || "").trim();
  const secretKey = String(process.env.TENCENT_SECRET_KEY || "").trim();
  if (!appId || !secretId || !secretKey) throw new Error("Tencent SOE credentials are not configured");
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    eval_mode: 1,
    expired: timestamp + 3600,
    nonce: crypto.randomInt(100000000, 999999999),
    rec_mode: 1,
    ref_text: referenceText,
    score_coeff: "1.0",
    secretid: secretId,
    sentence_info_enabled: 0,
    server_engine_type: "16k_en",
    text_mode: 0,
    timestamp,
    voice_format: 0,
    voice_id: voiceId
  };
  const entries = Object.entries(params).sort(([left], [right]) => left.localeCompare(right));
  const signingQuery = entries.map(([key, value]) => `${key}=${value}`).join("&");
  const signingText = `soe.cloud.tencent.com/soe/api/${appId}?${signingQuery}`;
  const signature = crypto.createHmac("sha1", secretKey).update(signingText).digest("base64");
  const requestQuery = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .concat(`signature=${encodeURIComponent(signature)}`)
    .join("&");
  return { url: `wss://soe.cloud.tencent.com/soe/api/${appId}?${requestQuery}`, voiceId };
}

function assessSpeakingPcm(referenceText, pcmBuffer) {
  if (typeof globalThis.WebSocket !== "function") {
    return Promise.reject(new Error("Node.js WebSocket client is unavailable"));
  }
  const { url } = buildSoeWebSocketUrl(referenceText);
  return new Promise((resolve, reject) => {
    const socket = new globalThis.WebSocket(url);
    let settled = false;
    let handshakeAccepted = false;
    let audioSent = false;
    let latestResult = null;
    const timeout = setTimeout(() => finish(new Error("Tencent SOE request timed out")), 30000);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(result);
    }
    // Transport open is not the SOE authentication handshake. Tencent sends a
    // code=0 text response first; only then may the recording be uploaded.
    socket.addEventListener("open", () => {});
    socket.addEventListener("error", () => finish(new Error("Tencent SOE connection failed")));
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("Tencent SOE connection closed before final result"));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (Number(message.code || 0) !== 0) {
        finish(new Error(`Tencent SOE error ${message.code}: ${message.message || "unknown error"}`));
        return;
      }
      if (!handshakeAccepted) {
        handshakeAccepted = true;
        if (!audioSent && !settled) {
          audioSent = true;
          socket.send(pcmBuffer);
          socket.send(JSON.stringify({ type: "end" }));
        }
        return;
      }
      if (message.result !== undefined) latestResult = message.result;
      if (Number(message.final || 0) === 1) {
        if (!latestResult) finish(new Error("Tencent SOE returned no assessment result"));
        else finish(null, latestResult);
      }
    });
  });
}

function todayKey() {
  return shanghaiDateKey();
}

function recordSuccessfulLogin(userId) {
  const timestamp = now();
  const loginDate = shanghaiDateKey();
  db.prepare(`
    INSERT INTO user_login_days (user_id, login_date, login_count, first_login_at, last_login_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(user_id, login_date)
    DO UPDATE SET login_count = login_count + 1, last_login_at = excluded.last_login_at
  `).run(userId, loginDate, timestamp, timestamp);
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(timestamp, userId);
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
    currencyKey: "emerald",
    currencyLabel: "绿宝石",
    dailyLimit: dailyExpLimit,
    levelEmeralds: level.levelExp,
    levelNeedEmeralds: level.levelNeed,
    totalEmeralds: row.total_exp,
    todayEmeralds: row.today_exp,
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
    emeralds: event.exp || 0,
    exp: event.exp || 0,
    label: event.label || "",
    themeId: event.theme_id || event.themeId || "",
    word: event.word || ""
  };
}

function grantReward(userId, event) {
  const row = ensureRewardRow(userId);
  const beforeLevel = levelInfo(row.total_exp).level;
  const requestedExp = Math.max(0, Number(event.exp || 0));
  const remainingDailyExp = Math.max(0, dailyExpLimit - row.today_exp);
  const grantedExp = Math.min(requestedExp, remainingDailyExp);
  const label = event.label || "";
  const awardedLabel = requestedExp > 0 && grantedExp === 0
    ? `${label}（今日绿宝石已达上限）`
    : label;
  let inserted = null;
  try {
    const result = db.prepare(`
      INSERT INTO reward_events (user_id, event_type, exp, label, theme_id, word, unique_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      event.type,
      grantedExp,
      awardedLabel,
      event.themeId || "",
      event.word || "",
      event.uniqueKey || null,
      now()
    );
    inserted = { id: result.lastInsertRowid, ...event, label: awardedLabel, exp: grantedExp };
  } catch (error) {
    if (!event.uniqueKey || !String(error.message || "").includes("UNIQUE")) throw error;
    return { events: [], state: rewardSummary(userId) };
  }

  if (grantedExp > 0) {
    db.prepare(`
      UPDATE user_rewards
      SET total_exp = total_exp + ?,
          today_exp = today_exp + ?,
          updated_at = ?
      WHERE user_id = ?
    `).run(grantedExp, grantedExp, now(), userId);
  }

  const state = rewardSummary(userId);
  const events = [eventPayload(inserted)];
  if (state.level > beforeLevel) {
    events.push({
      type: "level_up",
      emeralds: 0,
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
    exp: 30,
    label: `完成主题：${theme.title}`,
    themeId: theme.id,
    uniqueKey: `theme:${userId}:${theme.id}`
  });
}

function rewardRead(userId, themeId, word) {
  const date = todayKey();
  return grantReward(userId, {
    type: "read",
    exp: 0,
    label: "点读练习",
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
    exp: hadActiveReview ? 4 : 5,
    label: hadActiveReview ? "错题答对 +4" : "答题正确 +5",
    themeId: theme.id,
    word
  }));

  if (nextStreak === 3 || nextStreak === 5 || nextStreak === 10 || (nextStreak > 10 && nextStreak % 10 === 0)) {
    const bonus = nextStreak >= 10 ? 8 : nextStreak === 5 ? 5 : 3;
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
      exp: 10,
      label: "错题已修正 +10",
      themeId: theme.id,
      word
    }));
  }

  mergeRewardResult(result, maybeGrantThemeBadge(userId, theme));
  result.rewardState = rewardSummary(userId);
  return result;
}

function touchChineseSession(userId, kind, correct) {
  const date = todayKey();
  db.prepare(`
    INSERT INTO chinese_study_sessions (user_id, study_date, read_count, answer_count, correct_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, study_date)
    DO UPDATE SET read_count = read_count + excluded.read_count,
                  answer_count = answer_count + excluded.answer_count,
                  correct_count = correct_count + excluded.correct_count,
                  updated_at = excluded.updated_at
  `).run(userId, date, kind === "read" ? 1 : 0, kind === "answer" ? 1 : 0, correct ? 1 : 0, now());
}

function upsertChineseReadProgress(userId, themeId, itemId) {
  const theme = chineseThemeMap.get(themeId);
  if (!theme || !theme.items.some((item) => item.id === itemId)) throw new Error("Unknown Chinese course item");
  db.prepare(`
    INSERT INTO chinese_word_progress (user_id, theme_id, item_id, read_count, last_studied_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(user_id, theme_id, item_id)
    DO UPDATE SET read_count = read_count + 1, last_studied_at = excluded.last_studied_at
  `).run(userId, themeId, itemId, now());
  touchChineseSession(userId, "read", false);
}

function getChineseQuizState(userId, themeId) {
  const existing = db.prepare("SELECT * FROM chinese_theme_quiz_state WHERE user_id = ? AND theme_id = ?").get(userId, themeId);
  if (existing) return existing;
  db.prepare("INSERT INTO chinese_theme_quiz_state (user_id, theme_id, question_no, updated_at) VALUES (?, ?, 0, ?)")
    .run(userId, themeId, now());
  return { user_id: userId, theme_id: themeId, question_no: 0 };
}

function scheduleChineseReview(userId, themeId, itemId, questionNo, consecutiveFixCount) {
  const due = questionNo + crypto.randomInt(6, 11);
  db.prepare(`
    INSERT INTO chinese_review_queue (user_id, theme_id, item_id, due_question_no, consecutive_fix_count, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(user_id, theme_id, item_id)
    DO UPDATE SET due_question_no = excluded.due_question_no,
                  consecutive_fix_count = excluded.consecutive_fix_count,
                  status = 'active',
                  updated_at = excluded.updated_at
  `).run(userId, themeId, itemId, due, consecutiveFixCount, now(), now());
}

function chooseChineseQuizItem(userId, themeId) {
  const theme = chineseThemeMap.get(themeId);
  if (!theme) throw new Error("Unknown Chinese course theme");
  const state = getChineseQuizState(userId, themeId);
  const questionNo = state.question_no + 1;
  const reviewItems = db.prepare(`
    SELECT item_id, due_question_no, status, updated_at FROM chinese_review_queue
    WHERE user_id = ? AND theme_id = ?
  `).all(userId, themeId);
  const activeReviews = reviewItems.filter((item) => item.status === "active");
  const activeIds = new Set(activeReviews.map((item) => item.item_id));
  const dueIds = new Set(activeReviews
    .filter((item) => item.due_question_no <= questionNo)
    .map((item) => item.item_id));
  const correctIds = new Set(db.prepare(`
    SELECT item_id FROM chinese_word_progress
    WHERE user_id = ? AND theme_id = ? AND correct_count > 0
  `).all(userId, themeId).map((item) => item.item_id));
  const freshItems = theme.items.filter((item) => !correctIds.has(item.id) && !activeIds.has(item.id));
  let candidates = dueIds.size
    ? theme.items.filter((item) => dueIds.has(item.id))
    : freshItems;
  if (!candidates.length && activeReviews.length) {
    const earliestDue = Math.min(...activeReviews.map((item) => item.due_question_no));
    const earliestIds = new Set(activeReviews
      .filter((item) => item.due_question_no === earliestDue)
      .map((item) => item.item_id));
    candidates = theme.items.filter((item) => earliestIds.has(item.id));
  }
  if (!candidates.length) {
    const badge = maybeGrantChineseThemeBadge(userId, theme);
    return {
      completed: true,
      themeId,
      themeTitle: theme.title,
      totalWords: theme.items.length,
      rewardEvents: badge.events,
      rewardState: badge.state
    };
  }
  db.prepare("UPDATE chinese_theme_quiz_state SET question_no = ?, updated_at = ? WHERE user_id = ? AND theme_id = ?")
    .run(questionNo, now(), userId, themeId);
  const item = candidates[crypto.randomInt(candidates.length)];
  const seenChinese = new Set([item.chinese]);
  const wrongPool = shuffle(theme.items.filter((candidate) => candidate.id !== item.id)).filter((candidate) => {
    if (seenChinese.has(candidate.chinese)) return false;
    seenChinese.add(candidate.chinese);
    return true;
  }).slice(0, 3);
  return {
    questionNo,
    themeId,
    itemId: item.id,
    english: item.english,
    image: item.image,
    speechText: item.chinese,
    options: shuffle([item, ...wrongPool]).map((candidate) => candidate.chinese)
  };
}

function chineseLevelInfo(totalExp) {
  let current = chineseRewardLevels[0];
  for (const level of chineseRewardLevels) {
    if (totalExp >= level.minExp) current = level;
  }
  const next = chineseRewardLevels.find((level) => level.minExp > current.minExp);
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

function ensureChineseRewardRow(userId) {
  const date = todayKey();
  let row = db.prepare("SELECT * FROM chinese_user_rewards WHERE user_id = ?").get(userId);
  if (!row) {
    db.prepare("INSERT INTO chinese_user_rewards (user_id, reward_date, updated_at) VALUES (?, ?, ?)").run(userId, date, now());
    row = db.prepare("SELECT * FROM chinese_user_rewards WHERE user_id = ?").get(userId);
  }
  if (row.reward_date !== date) {
    db.prepare("UPDATE chinese_user_rewards SET today_exp = 0, reward_date = ?, updated_at = ? WHERE user_id = ?")
      .run(date, now(), userId);
    row = db.prepare("SELECT * FROM chinese_user_rewards WHERE user_id = ?").get(userId);
  }
  return row;
}

function chineseRewardSummary(userId) {
  const row = ensureChineseRewardRow(userId);
  const level = chineseLevelInfo(row.total_exp);
  const badges = db.prepare(`
    SELECT theme_id AS themeId, title, created_at AS createdAt
    FROM chinese_theme_badges WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId);
  const recentEvents = db.prepare(`
    SELECT event_type AS type, exp, label, theme_id AS themeId, item_id AS itemId, created_at AS createdAt
    FROM chinese_reward_events WHERE user_id = ? ORDER BY id DESC LIMIT 5
  `).all(userId);
  return {
    ...level,
    currencyKey: "emerald",
    currencyLabel: "Emeralds",
    dailyLimit: dailyExpLimit,
    levelEmeralds: level.levelExp,
    levelNeedEmeralds: level.levelNeed,
    totalEmeralds: row.total_exp,
    todayEmeralds: row.today_exp,
    totalExp: row.total_exp,
    todayExp: row.today_exp,
    streakCorrect: row.streak_correct,
    fixedReviews: row.fixed_reviews,
    badges,
    recentEvents
  };
}

function chineseGrantReward(userId, event) {
  const row = ensureChineseRewardRow(userId);
  const beforeLevel = chineseLevelInfo(row.total_exp).level;
  const requestedExp = Math.max(0, Number(event.exp || 0));
  const grantedExp = Math.min(requestedExp, Math.max(0, dailyExpLimit - row.today_exp));
  const awardedLabel = requestedExp > 0 && grantedExp === 0
    ? `${event.label || "Reward"} (daily Emerald limit reached)`
    : (event.label || "");
  try {
    db.prepare(`
      INSERT INTO chinese_reward_events (user_id, event_type, exp, label, theme_id, item_id, unique_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      event.type,
      grantedExp,
      awardedLabel,
      event.themeId || "",
      event.itemId || "",
      event.uniqueKey || null,
      now()
    );
  } catch (error) {
    if (!event.uniqueKey || !String(error.message || "").includes("UNIQUE")) throw error;
    return { events: [], state: chineseRewardSummary(userId) };
  }

  if (grantedExp > 0) {
    db.prepare(`
      UPDATE chinese_user_rewards
      SET total_exp = total_exp + ?, today_exp = today_exp + ?, updated_at = ?
      WHERE user_id = ?
    `).run(grantedExp, grantedExp, now(), userId);
  }
  const state = chineseRewardSummary(userId);
  const events = [{ type: event.type, emeralds: grantedExp, exp: grantedExp, label: awardedLabel, themeId: event.themeId || "", itemId: event.itemId || "" }];
  if (state.level > beforeLevel) {
    events.push({ type: "level_up", emeralds: 0, exp: 0, label: `Level up: ${state.title}`, level: state.level, gemKey: state.gemKey });
  }
  return { events, state };
}

function mergeChineseRewardResult(target, rewardResult) {
  target.rewardEvents.push(...(rewardResult?.events || []));
  if (rewardResult?.state) target.rewardState = rewardResult.state;
  return target;
}

function maybeGrantChineseThemeBadge(userId, theme) {
  const mastered = db.prepare(`
    SELECT COUNT(*) AS count FROM chinese_word_progress
    WHERE user_id = ? AND theme_id = ? AND mastery_status = 'mastered'
  `).get(userId, theme.id).count;
  if (mastered < theme.items.length) return { events: [], state: chineseRewardSummary(userId) };
  try {
    db.prepare("INSERT INTO chinese_theme_badges (user_id, theme_id, title, created_at) VALUES (?, ?, ?, ?)")
      .run(userId, theme.id, theme.title, now());
  } catch (error) {
    if (!String(error.message || "").includes("UNIQUE")) throw error;
    return { events: [], state: chineseRewardSummary(userId) };
  }
  return chineseGrantReward(userId, {
    type: "theme_badge",
    exp: 30,
    label: `Theme completed: ${theme.title}`,
    themeId: theme.id,
    uniqueKey: `theme:${userId}:${theme.id}`
  });
}

function chineseRewardRead(userId, themeId, itemId) {
  return chineseGrantReward(userId, {
    type: "read",
    exp: 0,
    label: "Reading practice",
    themeId,
    itemId,
    uniqueKey: `read:${userId}:${todayKey()}:${themeId}:${itemId}`
  });
}

function chineseRewardAnswer(userId, theme, itemId, correct, hadActiveReview, fixedReview) {
  const result = { rewardEvents: [], rewardState: chineseRewardSummary(userId) };
  const row = ensureChineseRewardRow(userId);
  if (!correct) {
    db.prepare("UPDATE chinese_user_rewards SET streak_correct = 0, updated_at = ? WHERE user_id = ?").run(now(), userId);
    result.rewardState = chineseRewardSummary(userId);
    return result;
  }

  const nextStreak = row.streak_correct + 1;
  db.prepare("UPDATE chinese_user_rewards SET streak_correct = ?, updated_at = ? WHERE user_id = ?").run(nextStreak, now(), userId);
  mergeChineseRewardResult(result, chineseGrantReward(userId, {
    type: hadActiveReview ? "review_correct" : "correct",
    exp: hadActiveReview ? 4 : 5,
    label: hadActiveReview ? "Review correct +4" : "Correct answer +5",
    themeId: theme.id,
    itemId
  }));
  if (nextStreak === 3 || nextStreak === 5 || nextStreak === 10 || (nextStreak > 10 && nextStreak % 10 === 0)) {
    const bonus = nextStreak >= 10 ? 8 : nextStreak === 5 ? 5 : 3;
    mergeChineseRewardResult(result, chineseGrantReward(userId, {
      type: "streak",
      exp: bonus,
      label: `Streak x${nextStreak} +${bonus}`,
      themeId: theme.id,
      itemId
    }));
  }
  if (fixedReview) {
    db.prepare("UPDATE chinese_user_rewards SET fixed_reviews = fixed_reviews + 1, updated_at = ? WHERE user_id = ?").run(now(), userId);
    mergeChineseRewardResult(result, chineseGrantReward(userId, {
      type: "review_fixed",
      exp: 10,
      label: "Review fixed +10",
      themeId: theme.id,
      itemId
    }));
  }
  mergeChineseRewardResult(result, maybeGrantChineseThemeBadge(userId, theme));
  result.rewardState = chineseRewardSummary(userId);
  return result;
}

function answerChineseQuiz(userId, themeId, itemId, selectedChinese) {
  const theme = chineseThemeMap.get(themeId);
  if (!theme) throw new Error("Unknown Chinese course theme");
  const item = theme.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("Unknown Chinese course item");
  const state = getChineseQuizState(userId, themeId);
  const correct = item.chinese === selectedChinese;
  const queue = db.prepare("SELECT * FROM chinese_review_queue WHERE user_id = ? AND theme_id = ? AND item_id = ?")
    .get(userId, themeId, itemId);
  const hadActiveReview = Boolean(queue && queue.status === "active");
  let fixedReview = false;
  const existingProgress = db.prepare(`
    SELECT consecutive_correct FROM chinese_word_progress
    WHERE user_id = ? AND theme_id = ? AND item_id = ?
  `).get(userId, themeId, itemId);
  const consecutiveCorrect = correct ? (existingProgress?.consecutive_correct || 0) + 1 : 0;
  const reviewFixCount = correct && hadActiveReview ? queue.consecutive_fix_count + 1 : 0;
  const masteryStatus = !correct
    ? "review"
    : hadActiveReview && reviewFixCount < 3
      ? "review"
      : "mastered";

  db.prepare(`
    INSERT INTO chinese_word_progress (
      user_id, theme_id, item_id, answer_count, correct_count, wrong_count,
      consecutive_correct, mastery_status, last_studied_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, theme_id, item_id)
    DO UPDATE SET answer_count = answer_count + 1,
                  correct_count = correct_count + excluded.correct_count,
                  wrong_count = wrong_count + excluded.wrong_count,
                  consecutive_correct = excluded.consecutive_correct,
                  mastery_status = excluded.mastery_status,
                  last_studied_at = excluded.last_studied_at
  `).run(
    userId,
    themeId,
    itemId,
    correct ? 1 : 0,
    correct ? 0 : 1,
    consecutiveCorrect,
    masteryStatus,
    now()
  );

  if (!correct) {
    scheduleChineseReview(userId, themeId, itemId, state.question_no, 0);
  } else if (hadActiveReview) {
    const fixedCount = queue.consecutive_fix_count + 1;
    if (fixedCount >= 3) {
      db.prepare("UPDATE chinese_review_queue SET status = 'fixed', consecutive_fix_count = ?, updated_at = ? WHERE id = ?")
        .run(fixedCount, now(), queue.id);
      fixedReview = true;
    } else {
      scheduleChineseReview(userId, themeId, itemId, state.question_no, fixedCount);
    }
  }
  touchChineseSession(userId, "answer", correct);
  return {
    correct,
    correctChinese: item.chinese,
    ...chineseRewardAnswer(userId, theme, itemId, correct, hadActiveReview, fixedReview)
  };
}

function chineseProgressSummary(userId) {
  const progress = db.prepare("SELECT * FROM chinese_word_progress WHERE user_id = ?").all(userId);
  const queue = db.prepare("SELECT * FROM chinese_review_queue WHERE user_id = ? AND status = 'active'").all(userId);
  const byKey = new Map(progress.map((item) => [`${item.theme_id}:${item.item_id}`, item]));
  const activeReview = new Set(queue.map((item) => `${item.theme_id}:${item.item_id}`));
  const themeSummaries = chineseThemes.map((theme) => {
    const words = theme.items.map((item) => byKey.get(`${theme.id}:${item.id}`)).filter(Boolean);
    const mastered = words.filter((item) => item.mastery_status === "mastered").length;
    const answers = words.reduce((sum, item) => sum + item.answer_count, 0);
    const correct = words.reduce((sum, item) => sum + item.correct_count, 0);
    const reviewCount = theme.items.filter((item) => activeReview.has(`${theme.id}:${item.id}`)).length;
    return {
      id: theme.id,
      title: theme.title,
      subtitle: theme.subtitle,
      totalWords: theme.items.length,
      studiedWords: words.length,
      masteredWords: mastered,
      reviewCount,
      answerCount: answers,
      correctCount: correct,
      accuracy: answers ? Math.round((correct / answers) * 100) : 0,
      completion: Math.round((mastered / theme.items.length) * 100),
      lastStudiedAt: words.reduce((latest, item) => {
        if (!item.last_studied_at) return latest;
        return !latest || item.last_studied_at > latest ? item.last_studied_at : latest;
      }, "")
    };
  });
  const totals = themeSummaries.reduce((result, theme) => {
    result.totalWords += theme.totalWords;
    result.studiedWords += theme.studiedWords;
    result.masteredWords += theme.masteredWords;
    result.reviewCount += theme.reviewCount;
    result.answerCount += theme.answerCount;
    result.correctCount += theme.correctCount;
    if (theme.lastStudiedAt && (!result.lastStudiedAt || theme.lastStudiedAt > result.lastStudiedAt)) {
      result.lastStudiedAt = theme.lastStudiedAt;
    }
    return result;
  }, {
    totalWords: 0,
    studiedWords: 0,
    masteredWords: 0,
    reviewCount: 0,
    answerCount: 0,
    correctCount: 0,
    lastStudiedAt: ""
  });
  totals.accuracy = totals.answerCount ? Math.round((totals.correctCount / totals.answerCount) * 100) : 0;
  totals.completion = totals.totalWords ? Math.round((totals.masteredWords / totals.totalWords) * 100) : 0;
  return { totals, themes: themeSummaries };
}

function adminThemeOverview(course) {
  const isChinese = course === "chinese";
  const progressTable = isChinese ? "chinese_word_progress" : "word_progress";
  const courseThemes = isChinese ? chineseThemes : themes;
  const rows = db.prepare(`
    SELECT p.theme_id AS themeId, COUNT(DISTINCT p.user_id) AS learnerCount,
           COALESCE(SUM(p.read_count), 0) AS readCount,
           COALESCE(SUM(p.answer_count), 0) AS answerCount,
           COALESCE(SUM(p.correct_count), 0) AS correctCount,
           COALESCE(SUM(CASE WHEN p.mastery_status = 'mastered' THEN 1 ELSE 0 END), 0) AS masteredWords
    FROM ${progressTable} p JOIN users u ON u.id = p.user_id
    WHERE u.role != 'admin' GROUP BY p.theme_id
  `).all();
  const byTheme = new Map(rows.map((row) => [row.themeId, row]));
  return courseThemes.map((theme) => {
    const row = byTheme.get(theme.id) || {};
    return {
      id: theme.id,
      title: theme.title,
      totalWords: theme.items.length,
      learnerCount: row.learnerCount || 0,
      readCount: row.readCount || 0,
      answerCount: row.answerCount || 0,
      correctCount: row.correctCount || 0,
      masteredWords: row.masteredWords || 0,
      accuracy: row.answerCount ? Math.round((row.correctCount / row.answerCount) * 100) : 0
    };
  });
}

function adminCourseRanking(course, range) {
  const isChinese = course === "chinese";
  const progressTable = isChinese ? "chinese_word_progress" : "word_progress";
  const sessionTable = isChinese ? "chinese_study_sessions" : "study_sessions";
  if (range === "today" || range === "7d") {
    const end = shanghaiDateKey();
    const start = range === "today" ? end : shiftDateKey(end, -6);
    return db.prepare(`
      SELECT u.id, u.phone, u.social_name AS socialName,
             COALESCE(SUM(s.read_count), 0) AS readCount,
             COALESCE(SUM(s.answer_count), 0) AS answerCount,
             COALESCE(SUM(s.correct_count), 0) AS correctCount,
             COALESCE((SELECT COUNT(*) FROM ${progressTable} p
                       WHERE p.user_id = u.id AND p.mastery_status = 'mastered'), 0) AS masteredWords
      FROM ${sessionTable} s JOIN users u ON u.id = s.user_id
      WHERE u.role != 'admin' AND s.study_date >= ? AND s.study_date <= ?
      GROUP BY u.id
      ORDER BY answerCount DESC, readCount DESC, u.id ASC
      LIMIT 10
    `).all(start, end);
  }
  return db.prepare(`
    SELECT u.id, u.phone, u.social_name AS socialName,
           COALESCE(SUM(p.read_count), 0) AS readCount,
           COALESCE(SUM(p.answer_count), 0) AS answerCount,
           COALESCE(SUM(p.correct_count), 0) AS correctCount,
           COALESCE(SUM(CASE WHEN p.mastery_status = 'mastered' THEN 1 ELSE 0 END), 0) AS masteredWords
    FROM ${progressTable} p JOIN users u ON u.id = p.user_id
    WHERE u.role != 'admin'
    GROUP BY u.id
    ORDER BY answerCount DESC, readCount DESC, u.id ASC
    LIMIT 10
  `).all();
}

function adminCourseOverview(course, range = "history") {
  const isChinese = course === "chinese";
  const progressTable = isChinese ? "chinese_word_progress" : "word_progress";
  const reviewTable = isChinese ? "chinese_review_queue" : "review_queue";
  const sessionTable = isChinese ? "chinese_study_sessions" : "study_sessions";
  const rewardEventsTable = isChinese ? "chinese_reward_events" : "reward_events";
  const courseThemes = isChinese ? chineseThemes : themes;
  const vocabularySize = courseThemes.reduce((total, theme) => total + theme.items.length, 0);
  const users = db.prepare(`
    SELECT
      COUNT(*) AS totalUsers,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeUsers
    FROM users WHERE role != 'admin'
  `).get();
  let learning;
  if (range === "today" || range === "7d") {
    const end = shanghaiDateKey();
    const start = range === "today" ? end : shiftDateKey(end, -6);
    learning = db.prepare(`
      SELECT COUNT(DISTINCT s.user_id) AS learnerCount,
             COALESCE(SUM(s.read_count), 0) AS readCount,
             COALESCE(SUM(s.answer_count), 0) AS answerCount,
             COALESCE(SUM(s.correct_count), 0) AS correctCount,
             MAX(s.updated_at) AS lastStudiedAt
      FROM ${sessionTable} s JOIN users u ON u.id = s.user_id
      WHERE u.role != 'admin' AND s.study_date >= ? AND s.study_date <= ?
    `).get(start, end);
    learning.masteredWords = db.prepare(`
      SELECT COUNT(*) AS count FROM ${progressTable} p JOIN users u ON u.id = p.user_id
      WHERE p.mastery_status = 'mastered' AND u.role != 'admin'
    `).get().count;
  } else {
    learning = db.prepare(`
      SELECT
        COUNT(DISTINCT p.user_id) AS learnerCount,
        COALESCE(SUM(p.read_count), 0) AS readCount,
        COALESCE(SUM(p.answer_count), 0) AS answerCount,
        COALESCE(SUM(p.correct_count), 0) AS correctCount,
        COALESCE(SUM(CASE WHEN p.mastery_status = 'mastered' THEN 1 ELSE 0 END), 0) AS masteredWords,
        MAX(p.last_studied_at) AS lastStudiedAt
      FROM ${progressTable} p
      JOIN users u ON u.id = p.user_id
      WHERE u.role != 'admin'
    `).get();
  }
  const reviewCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ${reviewTable} q
    JOIN users u ON u.id = q.user_id
    WHERE q.status = 'active' AND u.role != 'admin'
  `).get().count;
  let emeralds;
  if (range === "today" || range === "7d") {
    const endDate = shanghaiDateKey();
    const startDate = range === "today" ? endDate : shiftDateKey(endDate, -6);
    const start = dateKeyRange(startDate).start;
    const end = dateKeyRange(endDate).end;
    emeralds = db.prepare(`
      SELECT COALESCE(SUM(r.exp), 0) AS value FROM ${rewardEventsTable} r
      JOIN users u ON u.id = r.user_id
      WHERE u.role != 'admin' AND r.created_at >= ? AND r.created_at < ?
    `).get(start, end).value;
  } else {
    emeralds = db.prepare(`
      SELECT COALESCE(SUM(r.exp), 0) AS value FROM ${rewardEventsTable} r
      JOIN users u ON u.id = r.user_id WHERE u.role != 'admin'
    `).get().value;
  }
  return {
    course,
    themeCount: courseThemes.length,
    vocabularySize,
    totalUsers: users.totalUsers || 0,
    activeUsers: users.activeUsers || 0,
    learnerCount: learning.learnerCount || 0,
    readCount: learning.readCount || 0,
    answerCount: learning.answerCount || 0,
    correctCount: learning.correctCount || 0,
    masteredWords: learning.masteredWords || 0,
    reviewCount,
    accuracy: learning.answerCount ? Math.round((learning.correctCount / learning.answerCount) * 100) : 0,
    lastStudiedAt: learning.lastStudiedAt || "",
    emeralds: emeralds || 0,
    range,
    themes: adminThemeOverview(course),
    topUsers: adminCourseRanking(course, range)
  };
}

function referralSecret() {
  return process.env.REFERRAL_SECRET || process.env.SESSION_SECRET || "dev-referral-secret";
}

function referralToken(userId, version) {
  const payload = `${userId}.${version}`;
  const signature = hmacSha256(referralSecret(), payload, "base64url").slice(0, 32);
  return `${Buffer.from(payload).toString("base64url")}.${signature}`;
}

function parseReferralToken(token) {
  try {
    const [encoded, signature] = String(token || "").split(".");
    if (!encoded || !signature) return null;
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const expected = hmacSha256(referralSecret(), payload, "base64url").slice(0, 32);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const [userIdRaw, versionRaw] = payload.split(".");
    const userId = Number(userIdRaw);
    const version = Number(versionRaw);
    if (!Number.isInteger(userId) || !Number.isInteger(version) || userId <= 0 || version <= 0) return null;
    return { userId, version };
  } catch {
    return null;
  }
}

function activeReferralFromToken(token) {
  const parsed = parseReferralToken(token);
  if (!parsed) return null;
  const row = db.prepare(`
    SELECT r.*, u.social_name, u.primary_course, u.status AS user_status,
           u.access_tier, u.trial_expires_at, u.role
    FROM referral_links r
    JOIN users u ON u.id = r.user_id
    WHERE r.user_id = ? AND r.version = ?
  `).get(parsed.userId, parsed.version);
  if (!row || !row.active || row.user_status !== "active" || row.success_count >= row.max_uses) return null;
  if (userAccessState(row) === "expired") return null;
  return row;
}

function uniqueSocialName() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `BlockLearner-${randomCode(4)}`;
    const user = db.prepare("SELECT 1 FROM users WHERE social_name = ?").get(candidate);
    const application = db.prepare("SELECT 1 FROM registration_applications WHERE social_name = ? AND status = 'pending'").get(candidate);
    if (!user && !application) return candidate;
  }
  return `BlockLearner-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function createFriendship(userA, userB, course) {
  const low = Math.min(userA, userB);
  const high = Math.max(userA, userB);
  db.prepare(`
    INSERT OR IGNORE INTO friendships (user_low_id, user_high_id, primary_course, created_at)
    VALUES (?, ?, ?, ?)
  `).run(low, high, course, now());
  return db.prepare("SELECT * FROM friendships WHERE user_low_id = ? AND user_high_id = ?").get(low, high);
}

function referralUrl(req, userId, version) {
  const configuredBase = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const base = configuredBase || `${req.protocol}://${req.get("host")}`;
  return `${base}/register#ref=${encodeURIComponent(referralToken(userId, version))}`;
}

function primaryCourseTables(course) {
  return course === "chinese"
    ? {
        rewards: "chinese_reward_events",
        sessions: "chinese_study_sessions",
        progress: "chinese_word_progress"
      }
    : { rewards: "reward_events", sessions: "study_sessions", progress: "word_progress" };
}

function friendStats(userId, course, range = weekRange()) {
  const tables = primaryCourseTables(course);
  const nextWeekKey = shanghaiDateKey(new Date(range.end));
  const weeklyEmeralds = db.prepare(`
    SELECT COALESCE(SUM(exp), 0) AS value FROM ${tables.rewards}
    WHERE user_id = ? AND created_at >= ? AND created_at < ?
  `).get(userId, range.start, range.end).value;
  const bonusPoints = db.prepare(`
    SELECT COALESCE(SUM(points), 0) AS value FROM friend_pk_bonus_events
    WHERE user_id = ? AND week_key = ?
  `).get(userId, range.weekKey).value;
  const weekly = db.prepare(`
    SELECT COUNT(*) AS studyDays, COALESCE(SUM(answer_count), 0) AS answers
    FROM ${tables.sessions}
    WHERE user_id = ? AND study_date >= ? AND study_date < ?
  `).get(userId, range.weekKey, nextWeekKey);
  const lifetime = db.prepare(`
    SELECT COUNT(*) AS studyDays, COALESCE(SUM(answer_count), 0) AS answers
    FROM ${tables.sessions} WHERE user_id = ?
  `).get(userId);
  const masteredWords = db.prepare(`
    SELECT COUNT(*) AS value FROM ${tables.progress}
    WHERE user_id = ? AND mastery_status = 'mastered'
  `).get(userId).value;
  return {
    weekKey: range.weekKey,
    weeklyEmeralds,
    pkBonusPoints: bonusPoints,
    pkScore: weeklyEmeralds + bonusPoints,
    weeklyStudyDays: weekly.studyDays,
    weeklyAnswers: weekly.answers,
    studyDays: lifetime.studyDays,
    completedQuestions: lifetime.answers,
    masteredWords
  };
}

function friendshipsForUser(userId) {
  return db.prepare(`
    SELECT f.*,
           CASE WHEN f.user_low_id = ? THEN f.user_high_id ELSE f.user_low_id END AS friend_user_id
    FROM friendships f
    WHERE f.user_low_id = ? OR f.user_high_id = ?
    ORDER BY f.created_at DESC
  `).all(userId, userId, userId);
}

function ensureWeeklyChallenge(friendship, range = weekRange()) {
  db.prepare(`
    INSERT OR IGNORE INTO friend_weekly_challenges (
      friendship_id, week_key, primary_course, required_study_days, required_answers, status
    ) VALUES (?, ?, ?, 3, 30, 'active')
  `).run(friendship.id, range.weekKey, friendship.primary_course);
  return db.prepare(`
    SELECT * FROM friend_weekly_challenges WHERE friendship_id = ? AND week_key = ?
  `).get(friendship.id, range.weekKey);
}

function evaluateFriendChallenges(userId) {
  const range = weekRange();
  const completed = [];
  for (const friendship of friendshipsForUser(userId)) {
    const challenge = ensureWeeklyChallenge(friendship, range);
    if (challenge.status === "completed") continue;
    const first = friendStats(friendship.user_low_id, friendship.primary_course, range);
    const second = friendStats(friendship.user_high_id, friendship.primary_course, range);
    const ready = first.weeklyStudyDays >= challenge.required_study_days
      && second.weeklyStudyDays >= challenge.required_study_days
      && first.weeklyAnswers >= challenge.required_answers
      && second.weeklyAnswers >= challenge.required_answers;
    if (!ready) continue;
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE friend_weekly_challenges SET status = 'completed', completed_at = ?
        WHERE id = ? AND status = 'active'
      `).run(now(), challenge.id);
      if (!changed.changes) return;
      for (const participantId of [friendship.user_low_id, friendship.user_high_id]) {
        db.prepare(`
          INSERT OR IGNORE INTO friend_pk_bonus_events (
            user_id, friendship_id, week_key, points, unique_key, created_at
          ) VALUES (?, ?, ?, 20, ?, ?)
        `).run(participantId, friendship.id, range.weekKey, `coop:${participantId}:${friendship.id}:${range.weekKey}`, now());
        db.prepare(`
          INSERT OR IGNORE INTO friend_badges (
            user_id, friendship_id, week_key, badge_key, title, created_at
          ) VALUES (?, ?, ?, 'weekly-coop', ?, ?)
        `).run(participantId, friendship.id, range.weekKey, "Weekly Teamwork", now());
      }
    })();
    completed.push({ friendshipId: friendship.id, type: "friend_challenge_completed", points: 20 });
  }
  return completed;
}

initDb();
ensureAdmin();
cleanupAuditLogs();
const auditCleanupTimer = setInterval(cleanupAuditLogs, 24 * 60 * 60 * 1000);
auditCleanupTimer.unref?.();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self), payment=()");
  return next();
});
app.use(session({
  name: "mer.sid",
  secret: sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

app.get("/portal.css", (req, res) => res.sendFile(path.join(publicDir, "portal.css")));
app.get("/login", (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.sendFile(path.join(publicDir, "login.html"));
});
app.get("/admin-login", (req, res) => res.sendFile(path.join(publicDir, "admin-login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(publicDir, "register.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(publicDir, "privacy.html")));
app.get("/reset-password", requirePageAuth, (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.sendFile(path.join(publicDir, "reset-password.html"));
});
app.get("/progress", requirePasswordReadyPage, (req, res) => res.sendFile(path.join(publicDir, "progress.html")));
app.get("/speaking", requirePasswordReadyPage, (req, res) => res.sendFile(path.join(publicDir, "speaking.html")));
app.get("/", requireStudyPage("english"), (req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/chinese", requireStudyPage("chinese"), (req, res) => res.sendFile(path.join(publicDir, "core-words-cn.html")));
app.get("/chinese/progress", requirePasswordReadyPage, (req, res) => res.sendFile(path.join(publicDir, "chinese-progress.html")));
app.get("/friends", requirePasswordReadyPage, (req, res) => res.sendFile(path.join(publicDir, "friends.html")));
app.get("/access-status", requirePasswordReadyPage, (req, res) => res.sendFile(path.join(publicDir, "access-status.html")));
app.get("/admin", requireAdminPage, (req, res) => res.sendFile(path.join(publicDir, "admin.html")));

function sendReferralPreview(token, res) {
  const referral = activeReferralFromToken(token);
  if (!referral) return res.status(404).json({ code: "REFERRAL_INVALID", error: "邀请链接无效或已达到使用上限" });
  return res.json({
    socialName: referral.social_name,
    primaryCourse: referral.primary_course,
    remainingUses: referral.max_uses - referral.success_count
  });
}

app.get("/api/referrals/preview", (req, res) => {
  return sendReferralPreview(req.query.token, res);
});

app.post("/api/referrals/preview", (req, res) => {
  return sendReferralPreview(req.body?.token, res);
});

app.post("/api/auth/register", limitRegisterIp, limitRegisterPhone, (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const inviteCode = normalizeInvite(req.body.inviteCode);
  const referralTokenValue = String(req.body.referralToken || "").trim();
  const username = phone;
  const password = String(req.body.password || "");
  const nickname = phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
  if (!isValidPhone(phone) || password.length < 8) {
    return res.status(400).json({ error: "请填写正确手机号和至少8位密码" });
  }
  if (db.prepare("SELECT id FROM users WHERE phone = ?").get(phone)) return res.status(409).json({ error: "该手机号已注册" });

  if (referralTokenValue) {
    if (req.body.guardianConfirmed !== true) {
      return res.status(400).json({ code: "GUARDIAN_CONFIRMATION_REQUIRED", error: "请确认监护人已知情并同意体验规则" });
    }
    const referral = activeReferralFromToken(referralTokenValue);
    if (!referral) return res.status(400).json({ code: "REFERRAL_INVALID", error: "邀请链接无效或已达到使用上限" });
    const pendingCount = db.prepare(`
      SELECT COUNT(*) AS count FROM registration_applications
      WHERE inviter_user_id = ? AND status = 'pending'
    `).get(referral.user_id).count;
    if (pendingCount >= 5) {
      return res.status(429).json({ code: "REFERRAL_PENDING_LIMIT", error: "该邀请人当前待审核申请较多，请稍后再试" });
    }
    if (db.prepare("SELECT id FROM registration_applications WHERE phone = ? AND status = 'pending'").get(phone)) {
      return res.status(409).json({ code: "APPLICATION_PENDING", error: "该手机号已有待审核申请" });
    }
    const socialName = uniqueSocialName();
    const result = db.prepare(`
      INSERT INTO registration_applications (
        phone, password_hash, social_name, inviter_user_id, referral_version,
        primary_course, status, terms_version, guardian_confirmed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '2026-08-09', ?, ?)
    `).run(
      phone,
      bcrypt.hashSync(password, 10),
      socialName,
      referral.user_id,
      referral.version,
      referral.primary_course,
      now(),
      now()
    );
    return res.status(202).json({
      ok: true,
      pendingReview: true,
      applicationId: result.lastInsertRowid,
      socialName,
      primaryCourse: referral.primary_course
    });
  }

  if (!inviteCode) return res.status(400).json({ error: "请填写邀请码" });
  const whitelist = db.prepare("SELECT * FROM phone_whitelist WHERE phone = ?").get(phone);
  if (!whitelist || whitelist.status !== "unused") return res.status(400).json({ error: "手机号不在白名单或邀请码已失效" });
  if (whitelist.invite_hash !== hashInvite(inviteCode)) return res.status(400).json({ error: "邀请码不正确" });

  const tx = db.transaction(() => {
    const socialName = uniqueSocialName();
    const result = db.prepare(`
      INSERT INTO users (
        username, password_hash, nickname, phone, role, status, password_reset_required,
        access_tier, trial_expires_at, primary_course, social_name, created_at
      ) VALUES (?, ?, ?, ?, 'user', 'active', 0, 'founder_trial', NULL, ?, ?, ?)
    `).run(username, bcrypt.hashSync(password, 10), nickname, phone, whitelist.primary_course || "english", socialName, now());
    db.prepare(`
      UPDATE phone_whitelist
      SET status = 'used', used_by = ?, used_at = ?, invite_display = ''
      WHERE id = ?
    `).run(result.lastInsertRowid, now(), whitelist.id);
    return result.lastInsertRowid;
  });
  const userId = tx();
  return establishSession(req, userId, (error) => {
    if (error) return res.status(500).json({ error: "注册成功，但登录会话创建失败，请重新登录" });
    recordSuccessfulLogin(userId);
    return res.json({ ok: true, user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId)) });
  });
});

app.post("/api/auth/login", limitLoginIp, limitLoginPhone, (req, res) => {
  const login = String(req.body.phone || req.body.username || "").trim();
  const phone = normalizePhone(login);
  const password = String(req.body.password || "");
  const user = isValidPhone(phone)
    ? db.prepare("SELECT * FROM users WHERE phone = ?").get(phone)
    : db.prepare("SELECT * FROM users WHERE username = ?").get(login);
  if (!user) {
    const pending = isValidPhone(phone)
      ? db.prepare("SELECT id FROM registration_applications WHERE phone = ? AND status = 'pending'").get(phone)
      : null;
    if (pending) return res.status(403).json({ code: "ACCOUNT_PENDING_REVIEW", error: "注册申请正在等待管理员审核" });
  }
  const passwordMatches = Boolean(user && passwordMatchesHash(password, user.password_hash));
  if (user && passwordMatches && user.status !== "active") {
    return res.status(403).json({ code: "ACCOUNT_DISABLED", error: "账号已被禁用，请联系管理员" });
  }
  if (!user || !passwordMatches) {
    return res.status(401).json({ error: "账号或密码不正确" });
  }
  if (isValidPhone(phone)) loginPhoneCounter.reset(`login-phone:${limiterHash(phone)}`);
  return establishSession(req, user.id, (error) => {
    if (error) return res.status(500).json({ error: "登录会话创建失败，请重试" });
    recordSuccessfulLogin(user.id);
    return res.json({ ok: true, user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) });
  });
});

app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  if (newPassword.length < 8) return res.status(400).json({ error: "新密码至少8位" });
  if (!passwordMatchesHash(currentPassword, req.user.password_hash)) {
    return res.status(401).json({ error: "当前密码不正确" });
  }
  db.prepare("UPDATE users SET password_hash = ?, password_reset_required = 0 WHERE id = ?")
    .run(bcrypt.hashSync(newPassword, 10), req.user.id);
  return res.json({ ok: true, user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id)) });
});

app.post("/api/auth/complete-password-reset", requireAuth, (req, res) => {
  if (!req.user.password_reset_required) {
    return res.status(409).json({ code: "PASSWORD_RESET_NOT_REQUIRED", error: "当前账号不需要重置密码" });
  }
  const newPassword = String(req.body.newPassword || "");
  const confirmPassword = String(req.body.confirmPassword || "");
  if (newPassword.length < 8) return res.status(400).json({ error: "新密码至少需要 8 位" });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: "两次输入的新密码不一致" });
  db.prepare("UPDATE users SET password_hash = ?, password_reset_required = 0 WHERE id = ?")
    .run(bcrypt.hashSync(newPassword, 10), req.user.id);
  return res.json({ ok: true, user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id)) });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
app.get("/api/themes", requireAuth, (req, res) => {
  const allowed = new Set(allowedThemeIds(req.user, "english"));
  return res.json({ themes: themes.map((theme) => ({ ...theme, locked: accessControlEnforced && !allowed.has(theme.id) })) });
});
app.get("/api/progress", requireAuth, (req, res) => res.json(progressSummary(req.user.id)));
app.get("/api/rewards", requireAuth, (req, res) => res.json({ rewardState: rewardSummary(req.user.id) }));

app.get("/api/chinese/themes", requireAuth, (req, res) => {
  const allowed = new Set(allowedThemeIds(req.user, "chinese"));
  return res.json({ themes: chineseThemes.map((theme) => ({ ...theme, locked: accessControlEnforced && !allowed.has(theme.id) })) });
});
app.get("/api/chinese/progress", requireAuth, (req, res) => res.json(chineseProgressSummary(req.user.id)));
app.get("/api/chinese/rewards", requireAuth, (req, res) => res.json({ rewardState: chineseRewardSummary(req.user.id) }));

app.post("/api/chinese/progress/word", requireAuth, (req, res) => {
  try {
    const themeId = String(req.body.themeId || "");
    const itemId = String(req.body.itemId || "");
    if (!enforceLearningAccess(req, res, "chinese", themeId)) return;
    upsertChineseReadProgress(req.user.id, themeId, itemId);
    const reward = chineseRewardRead(req.user.id, themeId, itemId);
    return res.json({ ok: true, rewardEvents: reward.events, rewardState: reward.state });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/chinese/quiz/next", requireAuth, (req, res) => {
  try {
    const themeId = String(req.body.themeId || "");
    if (!enforceLearningAccess(req, res, "chinese", themeId)) return;
    return res.json(chooseChineseQuizItem(req.user.id, themeId));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/chinese/quiz/answer", requireAuth, (req, res) => {
  try {
    const themeId = String(req.body.themeId || "");
    if (!enforceLearningAccess(req, res, "chinese", themeId)) return;
    const answer = answerChineseQuiz(
      req.user.id,
      themeId,
      String(req.body.itemId || ""),
      String(req.body.selectedChinese || "")
    );
    answer.friendEvents = evaluateFriendChallenges(req.user.id);
    return res.json(answer);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/progress/word", requireAuth, (req, res) => {
  const themeId = String(req.body.themeId || "");
  const word = String(req.body.word || "");
  if (!enforceLearningAccess(req, res, "english", themeId)) return;
  if (!themeMap.get(themeId)) return res.status(400).json({ error: "未知主题" });
  upsertReadProgress(req.user.id, themeId, word);
  const reward = rewardRead(req.user.id, themeId, word);
  return res.json({ ok: true, rewardEvents: reward.events, rewardState: reward.state });
});

app.get("/api/tts", requireAuth, limitTtsUser, limitTtsIp, async (req, res) => {
  try {
    const text = String(req.query.text || "");
    const lang = String(req.query.lang || "").trim().toLowerCase() === "zh" ? "zh" : "en";
    const course = lang === "zh" ? "chinese" : "english";
    if (!enforceLearningAccess(req, res, course)) return;
    if (!canonicalTtsAllowed(req.user, lang, text)) {
      return res.status(403).json({ code: "TTS_TEXT_NOT_ALLOWED", error: "该语音内容不在已解锁词库中" });
    }
    const requestedVoice = String(req.query.voice || "").trim();
    const voiceType = getTencentVoiceType(lang);
    const audio = await ensureTtsAudio(text, {
      lang,
      beforeGenerate: () => {
        const result = ttsGenerationCounter.consume(`tts-generate:${req.user.id}`);
        if (!result.allowed) {
          const error = new Error("新语音生成额度已达到上限，请稍后再试");
          error.status = 429;
          error.code = "TTS_GENERATION_RATE_LIMITED";
          error.retryAfter = result.retryAfter;
          throw error;
        }
      }
    });
    res.setHeader("Content-Type", audio.contentType);
    res.setHeader("X-TTS-Lang", lang);
    res.setHeader("X-TTS-Voice-Type", voiceType === undefined ? "default" : String(voiceType));
    if (requestedVoice) res.setHeader("X-TTS-Requested-Voice", requestedVoice);
    res.setHeader("X-TTS-Cache", audio.cached ? "HIT" : "MISS");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    return res.sendFile(audio.filePath);
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    if (error.status === 429) {
      res.setHeader("Retry-After", String(error.retryAfter || 60));
      return res.status(429).json({ code: error.code, error: error.message, retryAfter: error.retryAfter });
    }
    return res.status(503).json({ code: "TTS_UNAVAILABLE", error: "腾讯云 TTS 暂不可用", detail: error.message });
  }
});

app.get("/api/speaking/eligibility", requireAuth, (req, res) => {
  return res.json(speakingEligibility(req.user));
});

app.get("/api/speaking/phrases", requireAuth, (req, res) => {
  if (!enforceSpeakingAccess(req, res)) return;
  return res.json({ themes: speakingThemesForUser(req.user.id) });
});

app.get("/api/speaking/progress", requireAuth, (req, res) => {
  if (!enforceSpeakingAccess(req, res)) return;
  return res.json(speakingProgressSummary(req.user.id));
});

app.get("/api/speaking/phrases/:id/audio", requireAuth, limitTtsUser, limitTtsIp, async (req, res) => {
  if (!enforceSpeakingAccess(req, res)) return;
  const phrase = speakingItemMap.get(Number(req.params.id));
  if (!phrase) return res.status(404).json({ code: "PHRASE_NOT_FOUND", error: "句子不存在" });
  try {
    const audio = await ensureTtsAudio(phrase.english, {
      lang: "en",
      beforeGenerate: () => {
        const result = ttsGenerationCounter.consume(`tts-generate:${req.user.id}`);
        if (!result.allowed) {
          const error = new Error("新语音生成额度已达到上限，请稍后再试");
          error.status = 429;
          error.code = "TTS_GENERATION_RATE_LIMITED";
          error.retryAfter = result.retryAfter;
          throw error;
        }
      }
    });
    res.setHeader("Content-Type", audio.contentType);
    res.setHeader("X-TTS-Voice-Type", String(getTencentVoiceType("en") ?? "default"));
    res.setHeader("X-TTS-Cache", audio.cached ? "HIT" : "MISS");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    return res.sendFile(audio.filePath);
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    if (error.status === 429) {
      res.setHeader("Retry-After", String(error.retryAfter || 60));
      return res.status(429).json({ code: error.code, error: error.message, retryAfter: error.retryAfter });
    }
    return res.status(503).json({ code: "TTS_UNAVAILABLE", error: "标准音暂不可用，请稍后重试" });
  }
});

app.post(
  "/api/speaking/assess/:phraseId",
  requireAuth,
  limitSpeakingIp,
  express.raw({ type: "application/octet-stream", limit: "512kb" }),
  async (req, res) => {
    const eligibility = enforceSpeakingAccess(req, res);
    if (!eligibility) return;
    if (!speakingEnabled) {
      return res.status(503).json({ code: "SOE_UNAVAILABLE", error: "口语评测服务尚未开启" });
    }
    const phrase = speakingItemMap.get(Number(req.params.phraseId));
    if (!phrase) return res.status(404).json({ code: "PHRASE_NOT_FOUND", error: "句子不存在" });
    if (!Buffer.isBuffer(req.body) || req.body.length < 16000 || req.body.length > 480000 || req.body.length % 2 !== 0) {
      return res.status(400).json({ code: "INVALID_AUDIO", error: "录音需为0.5至15秒的16kHz单声道PCM音频" });
    }
    if (speakingInFlight.has(req.user.id)) {
      return res.status(409).json({ code: "ASSESSMENT_BUSY", error: "上一条评测仍在处理中" });
    }
    const userUsed = speakingUsageCount(req.user.id);
    if (userUsed >= speakingDailyLimit) {
      return res.status(429).json({ code: "DAILY_LIMIT_REACHED", error: "今天的口语评测次数已用完" });
    }
    const phraseUsed = speakingUsageCount(req.user.id, phrase.id);
    if (phraseUsed >= speakingPhraseDailyLimit) {
      return res.status(429).json({ code: "PHRASE_LIMIT_REACHED", error: `这句话今天已经练习${speakingPhraseDailyLimit}次，请明天再试` });
    }
    const packageUsed = speakingPackageUsage();
    const packageLimit = req.user.role === "admin"
      ? speakingPackageTotal
      : Math.max(0, speakingPackageTotal - speakingPackageReserve);
    if (packageUsed >= packageLimit) {
      return res.status(503).json({ code: "PACKAGE_LIMIT_REACHED", error: "本期口语评测额度已用完" });
    }

    const requestId = crypto.randomUUID();
    const createdAt = now();
    db.prepare(`
      INSERT INTO speaking_attempts (user_id, phrase_id, request_id, status, created_at)
      VALUES (?, ?, ?, 'processing', ?)
    `).run(req.user.id, phrase.id, requestId, createdAt);
    speakingInFlight.add(req.user.id);
    try {
      const rawResult = await assessSpeakingPcm(phrase.english, req.body);
      const result = recordSpeakingResult(req.user.id, phrase.id, requestId, rawResult);
      const encouragement = result.stars === 3
        ? "发音真棒，这句话已掌握！"
        : result.stars === 2
          ? "很接近了！放慢一点，再试一次。"
          : result.stars === 1
            ? "已经开口了，很棒！再清楚一点。"
            : "先听一遍标准音，再试一次吧！";
      return res.json({
        ok: true,
        phraseId: phrase.id,
        score: Math.round(result.score),
        stars: result.stars,
        passed: result.passed,
        encouragement,
        newBadges: result.badges,
        progress: result.progress
      });
    } catch (error) {
      db.prepare(`
        UPDATE speaking_attempts
        SET status = 'failed', error_code = 'SOE_UNAVAILABLE', finished_at = ?
        WHERE request_id = ? AND user_id = ?
      `).run(now(), requestId, req.user.id);
      console.error("Tencent SOE assessment failed:", error.message);
      return res.status(503).json({ code: "SOE_UNAVAILABLE", error: "本次评测未完成，请稍后重试" });
    } finally {
      speakingInFlight.delete(req.user.id);
    }
  }
);

app.post("/api/quiz/next", requireAuth, (req, res) => {
  try {
    const themeId = String(req.body.themeId || "");
    if (!enforceLearningAccess(req, res, "english", themeId)) return;
    return res.json(chooseQuizItem(req.user.id, themeId));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/quiz/answer", requireAuth, (req, res) => {
  try {
    const themeId = String(req.body.themeId || "");
    if (!enforceLearningAccess(req, res, "english", themeId)) return;
    const answer = answerQuiz(req.user.id, themeId, String(req.body.word || ""), String(req.body.selectedCn || ""));
    answer.friendEvents = evaluateFriendChallenges(req.user.id);
    return res.json(answer);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/referrals/link", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM referral_links WHERE user_id = ?").get(req.user.id);
  if (!row) return res.json({ link: null, active: false, successCount: 0, maxUses: referralLimit });
  return res.json({
    link: referralUrl(req, req.user.id, row.version),
    active: Boolean(row.active),
    successCount: row.success_count,
    maxUses: row.max_uses,
    remainingUses: Math.max(0, row.max_uses - row.success_count)
  });
});

app.post("/api/referrals/link", requireAuth, (req, res) => {
  if (userAccessState(req.user) === "expired") {
    return res.status(403).json({ code: "TRIAL_EXPIRED", error: "体验到期后不能生成新邀请" });
  }
  db.prepare(`
    INSERT OR IGNORE INTO referral_links (user_id, version, active, success_count, max_uses, created_at, updated_at)
    VALUES (?, 1, 1, 0, ?, ?, ?)
  `).run(req.user.id, referralLimit, now(), now());
  const row = db.prepare("SELECT * FROM referral_links WHERE user_id = ?").get(req.user.id);
  return res.json({
    link: referralUrl(req, req.user.id, row.version),
    active: Boolean(row.active),
    successCount: row.success_count,
    maxUses: row.max_uses,
    remainingUses: Math.max(0, row.max_uses - row.success_count)
  });
});

app.post("/api/referrals/link/regenerate", requireAuth, (req, res) => {
  if (userAccessState(req.user) === "expired") {
    return res.status(403).json({ code: "TRIAL_EXPIRED", error: "体验到期后不能换新邀请链接" });
  }
  db.prepare(`
    INSERT INTO referral_links (user_id, version, active, success_count, max_uses, created_at, updated_at)
    VALUES (?, 1, 1, 0, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET version = version + 1, active = 1, updated_at = excluded.updated_at
  `).run(req.user.id, referralLimit, now(), now());
  const row = db.prepare("SELECT * FROM referral_links WHERE user_id = ?").get(req.user.id);
  return res.json({ link: referralUrl(req, req.user.id, row.version), active: true, successCount: row.success_count, maxUses: row.max_uses });
});

app.patch("/api/referrals/link", requireAuth, (req, res) => {
  const active = req.body.active === true ? 1 : 0;
  if (active && userAccessState(req.user) === "expired") {
    return res.status(403).json({ code: "TRIAL_EXPIRED", error: "体验到期后不能恢复邀请链接" });
  }
  const result = db.prepare("UPDATE referral_links SET active = ?, updated_at = ? WHERE user_id = ?")
    .run(active, now(), req.user.id);
  if (!result.changes) return res.status(404).json({ error: "尚未生成邀请链接" });
  return res.json({ ok: true, active: Boolean(active) });
});

app.get("/api/friends/summary", requireAuth, (req, res) => {
  const requested = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.week || ""))
    ? new Date(`${req.query.week}T00:00:00+08:00`)
    : new Date();
  const range = weekRange(requested);
  evaluateFriendChallenges(req.user.id);
  const me = friendStats(req.user.id, req.user.primary_course, range);
  const friends = friendshipsForUser(req.user.id).map((friendship) => {
    const friend = db.prepare("SELECT id, social_name, primary_course FROM users WHERE id = ? AND status = 'active'")
      .get(friendship.friend_user_id);
    if (!friend) return null;
    const stats = friendStats(friend.id, friendship.primary_course, range);
    return {
      friendshipId: friendship.id,
      userId: friend.id,
      socialName: friend.social_name,
      primaryCourse: friendship.primary_course,
      stats,
      pk: {
        myScore: me.pkScore,
        friendScore: stats.pkScore,
        difference: Math.abs(me.pkScore - stats.pkScore),
        result: me.pkScore === stats.pkScore ? "tie" : me.pkScore > stats.pkScore ? "leading" : "behind"
      }
    };
  }).filter(Boolean);
  return res.json({ weekKey: range.weekKey, primaryCourse: req.user.primary_course, me, friends });
});

app.get("/api/friends/challenge", requireAuth, (req, res) => {
  const range = weekRange();
  evaluateFriendChallenges(req.user.id);
  const challenges = friendshipsForUser(req.user.id).map((friendship) => {
    const challenge = ensureWeeklyChallenge(friendship, range);
    const friendId = friendship.friend_user_id;
    const friend = db.prepare("SELECT social_name FROM users WHERE id = ?").get(friendId);
    return {
      friendshipId: friendship.id,
      friendUserId: friendId,
      friendSocialName: friend?.social_name || "Friend",
      status: challenge.status,
      requiredStudyDays: challenge.required_study_days,
      requiredAnswers: challenge.required_answers,
      me: friendStats(req.user.id, friendship.primary_course, range),
      friend: friendStats(friendId, friendship.primary_course, range),
      reward: { badge: "Weekly Teamwork", pkBonusPoints: 20 }
    };
  });
  const badges = db.prepare(`
    SELECT week_key AS weekKey, badge_key AS badgeKey, title, created_at AS createdAt
    FROM friend_badges WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(req.user.id);
  return res.json({ weekKey: range.weekKey, challenges, badges });
});

function dashboardCourseStats(course, dateKey) {
  const tables = primaryCourseTables(course);
  const range = dateKeyRange(dateKey);
  const row = db.prepare(`
    SELECT
      COUNT(*) AS learningUsers,
      SUM(CASE WHEN s.read_count > 0 THEN 1 ELSE 0 END) AS readUsers,
      SUM(CASE WHEN s.answer_count > 0 THEN 1 ELSE 0 END) AS quizUsers,
      COALESCE(SUM(s.read_count), 0) AS reads,
      COALESCE(SUM(s.answer_count), 0) AS answers,
      COALESCE(SUM(s.correct_count), 0) AS correct
    FROM ${tables.sessions} s
    JOIN users u ON u.id = s.user_id
    WHERE s.study_date = ? AND u.role != 'admin'
  `).get(dateKey);
  const emeralds = db.prepare(`
    SELECT COALESCE(SUM(r.exp), 0) AS value
    FROM ${tables.rewards} r
    JOIN users u ON u.id = r.user_id
    WHERE r.created_at >= ? AND r.created_at < ? AND u.role != 'admin'
  `).get(range.start, range.end).value;
  return {
    learningUsers: row.learningUsers || 0,
    readUsers: row.readUsers || 0,
    quizUsers: row.quizUsers || 0,
    reads: row.reads || 0,
    answers: row.answers || 0,
    correct: row.correct || 0,
    accuracy: row.answers ? Math.round((row.correct / row.answers) * 100) : 0,
    emeralds: emeralds || 0
  };
}

function dashboardOverallStats(dateKey) {
  const range = dateKeyRange(dateKey);
  const activity = db.prepare(`
    WITH combined AS (
      SELECT user_id, read_count, answer_count, correct_count FROM study_sessions WHERE study_date = ?
      UNION ALL
      SELECT user_id, read_count, answer_count, correct_count FROM chinese_study_sessions WHERE study_date = ?
    ), per_user AS (
      SELECT user_id, SUM(read_count) AS reads, SUM(answer_count) AS answers, SUM(correct_count) AS correct
      FROM combined GROUP BY user_id
    )
    SELECT
      COUNT(*) AS learningUsers,
      SUM(CASE WHEN p.reads > 0 THEN 1 ELSE 0 END) AS readUsers,
      SUM(CASE WHEN p.answers > 0 THEN 1 ELSE 0 END) AS quizUsers,
      COALESCE(SUM(p.reads), 0) AS reads,
      COALESCE(SUM(p.answers), 0) AS answers,
      COALESCE(SUM(p.correct), 0) AS correct
    FROM per_user p JOIN users u ON u.id = p.user_id
    WHERE u.role != 'admin'
  `).get(dateKey, dateKey);
  const login = db.prepare(`
    SELECT COUNT(*) AS users, COALESCE(SUM(l.login_count), 0) AS count
    FROM user_login_days l JOIN users u ON u.id = l.user_id
    WHERE l.login_date = ? AND u.role != 'admin'
  `).get(dateKey);
  const loggedOnlyUsers = db.prepare(`
    SELECT COUNT(*) AS count
    FROM user_login_days l JOIN users u ON u.id = l.user_id
    WHERE l.login_date = ? AND u.role != 'admin'
      AND NOT EXISTS (SELECT 1 FROM study_sessions s WHERE s.user_id = l.user_id AND s.study_date = ?)
      AND NOT EXISTS (SELECT 1 FROM chinese_study_sessions s WHERE s.user_id = l.user_id AND s.study_date = ?)
  `).get(dateKey, dateKey, dateKey).count;
  const emeralds = db.prepare(`
    SELECT COALESCE(SUM(exp), 0) AS value FROM (
      SELECT r.exp FROM reward_events r JOIN users u ON u.id = r.user_id
      WHERE r.created_at >= ? AND r.created_at < ? AND u.role != 'admin'
      UNION ALL
      SELECT r.exp FROM chinese_reward_events r JOIN users u ON u.id = r.user_id
      WHERE r.created_at >= ? AND r.created_at < ? AND u.role != 'admin'
    )
  `).get(range.start, range.end, range.start, range.end).value;
  return {
    loginUsers: login.users || 0,
    loginCount: login.count || 0,
    learningUsers: activity.learningUsers || 0,
    readUsers: activity.readUsers || 0,
    quizUsers: activity.quizUsers || 0,
    loggedOnlyUsers: loggedOnlyUsers || 0,
    reads: activity.reads || 0,
    answers: activity.answers || 0,
    correct: activity.correct || 0,
    accuracy: activity.answers ? Math.round((activity.correct / activity.answers) * 100) : 0,
    emeralds: emeralds || 0
  };
}

function dashboardHistoryCourse(course) {
  const tables = primaryCourseTables(course);
  const progressKey = course === "chinese" ? "item_id" : "word";
  const session = db.prepare(`
    SELECT COUNT(DISTINCT s.user_id) AS learningUsers,
           COUNT(*) AS studyDays,
           COALESCE(SUM(s.read_count), 0) AS reads,
           COALESCE(SUM(s.answer_count), 0) AS answers,
           COALESCE(SUM(s.correct_count), 0) AS correct
    FROM ${tables.sessions} s JOIN users u ON u.id = s.user_id WHERE u.role != 'admin'
  `).get();
  const masteredWords = db.prepare(`
    SELECT COUNT(${progressKey}) AS count FROM ${tables.progress} p
    JOIN users u ON u.id = p.user_id
    WHERE p.mastery_status = 'mastered' AND u.role != 'admin'
  `).get().count;
  const reviewTable = course === "chinese" ? "chinese_review_queue" : "review_queue";
  const rewardSummaryTable = course === "chinese" ? "chinese_user_rewards" : "user_rewards";
  const activeReviews = db.prepare(`
    SELECT COUNT(*) AS count FROM ${reviewTable} q JOIN users u ON u.id = q.user_id
    WHERE q.status = 'active' AND u.role != 'admin'
  `).get().count;
  const fixedReviews = db.prepare(`
    SELECT COALESCE(SUM(r.fixed_reviews), 0) AS count FROM ${rewardSummaryTable} r
    JOIN users u ON u.id = r.user_id WHERE u.role != 'admin'
  `).get().count;
  const emeralds = db.prepare(`
    SELECT COALESCE(SUM(r.exp), 0) AS value FROM ${tables.rewards} r
    JOIN users u ON u.id = r.user_id WHERE u.role != 'admin'
  `).get().value;
  return {
    learningUsers: session.learningUsers || 0,
    studyDays: session.studyDays || 0,
    reads: session.reads || 0,
    answers: session.answers || 0,
    correct: session.correct || 0,
    accuracy: session.answers ? Math.round((session.correct / session.answers) * 100) : 0,
    masteredWords: masteredWords || 0,
    activeReviews: activeReviews || 0,
    fixedReviews: fixedReviews || 0,
    emeralds: emeralds || 0
  };
}

function loginTrackingStartDate() {
  const row = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = ?")
    .get("2026-08-10-admin-dashboard-v1");
  return row?.applied_at ? shanghaiDateKey(new Date(row.applied_at)) : shanghaiDateKey();
}

function dashboardHistory() {
  const users = db.prepare(`
    SELECT COUNT(*) AS totalUsers,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeUsers,
           SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabledUsers
    FROM users WHERE role != 'admin'
  `).get();
  const learningUsers = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT user_id FROM study_sessions
      UNION
      SELECT user_id FROM chinese_study_sessions
    ) x JOIN users u ON u.id = x.user_id WHERE u.role != 'admin'
  `).get().count;
  const studyDays = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT user_id, study_date FROM study_sessions
      UNION
      SELECT user_id, study_date FROM chinese_study_sessions
    ) x JOIN users u ON u.id = x.user_id WHERE u.role != 'admin'
  `).get().count;
  const english = dashboardHistoryCourse("english");
  const chinese = dashboardHistoryCourse("chinese");
  const login = db.prepare(`
    SELECT COUNT(DISTINCT l.user_id) AS users, COALESCE(SUM(l.login_count), 0) AS count
    FROM user_login_days l JOIN users u ON u.id = l.user_id WHERE u.role != 'admin'
  `).get();
  const whitelist = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) AS used,
           SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) AS unused,
           SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled
    FROM phone_whitelist
  `).get();
  const applications = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
    FROM registration_applications
  `).get();
  const invitationRecords = (whitelist.total || 0) + (applications.total || 0);
  const completedInvitations = (whitelist.used || 0) + (applications.approved || 0);
  const social = {
    friendships: db.prepare("SELECT COUNT(*) AS count FROM friendships").get().count,
    completedChallenges: db.prepare("SELECT COUNT(*) AS count FROM friend_weekly_challenges WHERE status = 'completed'").get().count
  };
  return {
    loginTrackingStartedAt: loginTrackingStartDate(),
    overall: {
      totalUsers: users.totalUsers || 0,
      activeUsers: users.activeUsers || 0,
      disabledUsers: users.disabledUsers || 0,
      learningUsers: learningUsers || 0,
      neverLearnedUsers: Math.max(0, (users.totalUsers || 0) - (learningUsers || 0)),
      studyDays: studyDays || 0,
      reads: english.reads + chinese.reads,
      answers: english.answers + chinese.answers,
      correct: english.correct + chinese.correct,
      accuracy: english.answers + chinese.answers
        ? Math.round(((english.correct + chinese.correct) / (english.answers + chinese.answers)) * 100)
        : 0,
      masteredWords: english.masteredWords + chinese.masteredWords,
      activeReviews: english.activeReviews + chinese.activeReviews,
      fixedReviews: english.fixedReviews + chinese.fixedReviews,
      emeralds: english.emeralds + chinese.emeralds,
      loginUsers: login.users || 0,
      loginCount: login.count || 0
    },
    courses: { english, chinese },
    invitations: {
      total: invitationRecords,
      completed: completedInvitations,
      conversion: invitationRecords ? Math.round((completedInvitations / invitationRecords) * 100) : 0,
      whitelist: {
        total: whitelist.total || 0,
        used: whitelist.used || 0,
        unused: whitelist.unused || 0,
        disabled: whitelist.disabled || 0
      },
      referralApplications: {
        total: applications.total || 0,
        approved: applications.approved || 0
      }
    },
    social
  };
}

function dashboardTodo() {
  const timestamp = now();
  const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  return {
    pendingApplications: db.prepare("SELECT COUNT(*) AS count FROM registration_applications WHERE status = 'pending'").get().count,
    passwordResetRequired: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role != 'admin' AND status = 'active' AND password_reset_required = 1").get().count,
    expiringSoon: db.prepare(`
      SELECT COUNT(*) AS count FROM users
      WHERE role != 'admin' AND status = 'active' AND access_tier = 'free_trial'
        AND trial_expires_at > ? AND trial_expires_at <= ?
    `).get(timestamp, inThreeDays).count,
    expiredEnabled: db.prepare(`
      SELECT COUNT(*) AS count FROM users
      WHERE role != 'admin' AND status = 'active' AND access_tier = 'free_trial'
        AND (trial_expires_at IS NULL OR trial_expires_at <= ?)
    `).get(timestamp).count,
    unusedWhitelist: db.prepare("SELECT COUNT(*) AS count FROM phone_whitelist WHERE status = 'unused'").get().count,
    disabledWhitelist: db.prepare("SELECT COUNT(*) AS count FROM phone_whitelist WHERE status = 'disabled'").get().count
  };
}

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  const date = adminDashboardDate(req.query.date);
  if (!date) return res.status(400).json({ error: "日期只能选择今天及之前近30天" });
  const trend = [];
  for (let offset = -6; offset <= 0; offset += 1) {
    const trendDate = shiftDateKey(date, offset);
    trend.push({ date: trendDate, ...dashboardOverallStats(trendDate) });
  }
  return res.json({
    date,
    generatedAt: now(),
    loginTrackingStartedAt: loginTrackingStartDate(),
    summary: dashboardOverallStats(date),
    courses: {
      english: dashboardCourseStats("english", date),
      chinese: dashboardCourseStats("chinese", date)
    },
    trend,
    todo: dashboardTodo()
  });
});

app.get("/api/admin/dashboard/history", requireAdmin, (req, res) => {
  return res.json({ generatedAt: now(), ...dashboardHistory() });
});

app.get("/api/admin/dashboard/active-users", requireAdmin, (req, res) => {
  const date = adminDashboardDate(req.query.date);
  if (!date) return res.status(400).json({ error: "日期只能选择今天及之前近30天" });
  const layer = ["login", "learn", "read", "quiz", "login_only"].includes(req.query.layer)
    ? req.query.layer
    : "learn";
  const course = ["english", "chinese"].includes(req.query.course) ? req.query.course : "all";
  const pageSize = Math.min(50, positiveInt(req.query.pageSize, 10));
  const page = positiveInt(req.query.page, 1);
  const phone = normalizePhone(req.query.phone);
  const needsAllActivity = course === "all" || layer === "login" || layer === "login_only";
  const activityRows = needsAllActivity
    ? `
      SELECT user_id, read_count AS english_reads, answer_count AS english_answers,
             correct_count AS english_correct, 0 AS chinese_reads, 0 AS chinese_answers,
             0 AS chinese_correct, updated_at
      FROM study_sessions WHERE study_date = ?
      UNION ALL
      SELECT user_id, 0, 0, 0, read_count, answer_count, correct_count, updated_at
      FROM chinese_study_sessions WHERE study_date = ?`
    : course === "chinese"
      ? `SELECT user_id, 0 AS english_reads, 0 AS english_answers, 0 AS english_correct,
                read_count AS chinese_reads, answer_count AS chinese_answers,
                correct_count AS chinese_correct, updated_at
         FROM chinese_study_sessions WHERE study_date = ?`
      : `SELECT user_id, read_count AS english_reads, answer_count AS english_answers,
                correct_count AS english_correct, 0 AS chinese_reads, 0 AS chinese_answers,
                0 AS chinese_correct, updated_at
         FROM study_sessions WHERE study_date = ?`;
  const cte = `
    WITH activity_rows AS (${activityRows}), activity AS (
      SELECT user_id,
             SUM(english_reads) AS englishReads, SUM(english_answers) AS englishAnswers,
             SUM(english_correct) AS englishCorrect, SUM(chinese_reads) AS chineseReads,
             SUM(chinese_answers) AS chineseAnswers, SUM(chinese_correct) AS chineseCorrect,
             MAX(updated_at) AS lastActivityAt
      FROM activity_rows GROUP BY user_id
    ), logins AS (
      SELECT user_id, login_count AS loginCount, last_login_at AS loginAt
      FROM user_login_days WHERE login_date = ?
    )`;
  const cteValues = needsAllActivity ? [date, date, date] : [date, date];
  const filters = ["u.role != 'admin'"];
  const values = [];
  if (phone) {
    filters.push("u.phone LIKE ?");
    values.push(`%${phone}%`);
  }
  if ((layer === "login" || layer === "login_only") && course !== "all") {
    filters.push("u.primary_course = ?");
    values.push(course);
  }
  if (layer === "login") filters.push("COALESCE(l.loginCount, 0) > 0");
  if (layer === "learn") filters.push("COALESCE(a.englishReads + a.englishAnswers + a.chineseReads + a.chineseAnswers, 0) > 0");
  if (layer === "read") filters.push("COALESCE(a.englishReads + a.chineseReads, 0) > 0");
  if (layer === "quiz") filters.push("COALESCE(a.englishAnswers + a.chineseAnswers, 0) > 0");
  if (layer === "login_only") {
    filters.push("COALESCE(l.loginCount, 0) > 0");
    filters.push("COALESCE(a.englishReads + a.englishAnswers + a.chineseReads + a.chineseAnswers, 0) = 0");
  }
  const where = `WHERE ${filters.join(" AND ")}`;
  const total = db.prepare(`${cte}
    SELECT COUNT(*) AS count FROM users u
    LEFT JOIN activity a ON a.user_id = u.id LEFT JOIN logins l ON l.user_id = u.id ${where}
  `).get(...cteValues, ...values).count;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = db.prepare(`${cte}
    SELECT u.id, u.phone, u.username, u.social_name AS socialName, u.status,
           u.access_tier AS accessTier, u.trial_expires_at AS trialExpiresAt,
           u.primary_course AS primaryCourse, u.last_login_at AS lastLoginAt,
           COALESCE(l.loginCount, 0) AS loginCount, l.loginAt,
           COALESCE(a.englishReads, 0) AS englishReads,
           COALESCE(a.englishAnswers, 0) AS englishAnswers,
           COALESCE(a.englishCorrect, 0) AS englishCorrect,
           COALESCE(a.chineseReads, 0) AS chineseReads,
           COALESCE(a.chineseAnswers, 0) AS chineseAnswers,
           COALESCE(a.chineseCorrect, 0) AS chineseCorrect,
           a.lastActivityAt
    FROM users u LEFT JOIN activity a ON a.user_id = u.id LEFT JOIN logins l ON l.user_id = u.id
    ${where}
    ORDER BY COALESCE(a.lastActivityAt, l.loginAt, u.last_login_at) DESC, u.id DESC
    LIMIT ? OFFSET ?
  `).all(...cteValues, ...values, pageSize, (safePage - 1) * pageSize);
  return res.json({ items: rows, date, layer, course, page: safePage, pageSize, total, totalPages });
});

app.get("/api/admin/social-summary", requireAdmin, (req, res) => {
  const range = weekRange();
  const summary = {
    activeLinks: db.prepare("SELECT COUNT(*) AS count FROM referral_links WHERE active = 1").get().count,
    approvedReferrals: db.prepare("SELECT COUNT(*) AS count FROM referrals").get().count,
    friendships: db.prepare("SELECT COUNT(*) AS count FROM friendships").get().count,
    completedChallenges: db.prepare("SELECT COUNT(*) AS count FROM friend_weekly_challenges WHERE status = 'completed'").get().count,
    weeklyChallenges: db.prepare("SELECT COUNT(*) AS count FROM friend_weekly_challenges WHERE week_key = ?").get(range.weekKey).count,
    weeklyCompleted: db.prepare("SELECT COUNT(*) AS count FROM friend_weekly_challenges WHERE week_key = ? AND status = 'completed'").get(range.weekKey).count
  };
  const topInviters = db.prepare(`
    SELECT u.id, u.phone, u.social_name AS socialName, COUNT(r.id) AS invitedCount
    FROM referrals r JOIN users u ON u.id = r.inviter_user_id
    GROUP BY u.id ORDER BY invitedCount DESC, u.id ASC LIMIT 10
  `).all();
  const recentFriendships = db.prepare(`
    SELECT f.id, f.primary_course AS primaryCourse, f.created_at AS createdAt,
           low.social_name AS firstName, high.social_name AS secondName
    FROM friendships f
    JOIN users low ON low.id = f.user_low_id JOIN users high ON high.id = f.user_high_id
    ORDER BY f.created_at DESC LIMIT 20
  `).all();
  const trend = [];
  const today = shanghaiDateKey();
  for (let offset = -6; offset <= 0; offset += 1) {
    const date = shiftDateKey(today, offset);
    const day = dateKeyRange(date);
    trend.push({
      date,
      friendships: db.prepare("SELECT COUNT(*) AS count FROM friendships WHERE created_at >= ? AND created_at < ?")
        .get(day.start, day.end).count
    });
  }
  return res.json({ weekKey: range.weekKey, summary, topInviters, recentFriendships, trend });
});

app.get("/api/admin/whitelist", requireAdmin, (req, res) => {
  const pageSize = Math.min(50, positiveInt(req.query.pageSize, 10));
  const page = positiveInt(req.query.page, 1);
  const total = db.prepare("SELECT COUNT(*) AS count FROM phone_whitelist").get().count;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const rows = db.prepare(`
    SELECT id, phone, note, invite_display AS inviteCode, status, primary_course AS primaryCourse,
           created_at, used_at, disabled_at
    FROM phone_whitelist ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, offset);
  return res.json({ items: rows, page: safePage, pageSize, total, totalPages });
});

app.post("/api/admin/whitelist", requireAdmin, (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const note = String(req.body.note || "").trim();
  const primaryCourse = req.body.primaryCourse === "chinese" ? "chinese" : "english";
  if (!isValidPhone(phone)) return res.status(400).json({ error: "请输入正确的11位手机号" });
  const code = randomCode(6);
  try {
    const result = db.prepare(`
      INSERT INTO phone_whitelist (
        phone, note, invite_hash, invite_display, status, primary_course, created_by, created_at
      ) VALUES (?, ?, ?, ?, 'unused', ?, ?, ?)
    `).run(phone, note, hashInvite(code), code, primaryCourse, req.user.id, now());
    auditAdmin(req, "whitelist.create", "phone_whitelist", result.lastInsertRowid, { phoneLast4: phone.slice(-4), primaryCourse });
    return res.json({ id: result.lastInsertRowid, phone, note, inviteCode: code, status: "unused", primaryCourse });
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
  if (req.body.status === "unused") {
    db.prepare(`
      UPDATE phone_whitelist
      SET status = 'unused', disabled_at = NULL
      WHERE id = ? AND status = 'disabled' AND used_by IS NULL
    `).run(id);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "note")) {
    db.prepare("UPDATE phone_whitelist SET note = ? WHERE id = ?").run(note, id);
  }
  if (req.body.primaryCourse === "english" || req.body.primaryCourse === "chinese") {
    db.prepare("UPDATE phone_whitelist SET primary_course = ? WHERE id = ? AND status != 'used'")
      .run(req.body.primaryCourse, id);
  }
  auditAdmin(req, "whitelist.update", "phone_whitelist", id, {
    status: req.body.status || undefined,
    noteChanged: Object.prototype.hasOwnProperty.call(req.body, "note"),
    primaryCourse: req.body.primaryCourse
  });
  return res.json({ ok: true });
});

app.get("/api/admin/course-summary", requireAdmin, (req, res) => {
  const course = req.query.course === "chinese" ? "chinese" : "english";
  const range = ["today", "7d", "history"].includes(req.query.range) ? req.query.range : "history";
  return res.json(adminCourseOverview(course, range));
});

app.get("/api/admin/speaking-summary", requireAdmin, (req, res) => {
  const bounds = speakingDateBounds();
  const today = db.prepare(`
    SELECT COUNT(*) AS calls,
           COUNT(DISTINCT user_id) AS activeUsers,
           SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status = 'succeeded' AND passed = 1 THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS errors
    FROM speaking_attempts WHERE created_at >= ? AND created_at < ?
  `).get(bounds.start, bounds.end);
  const total = db.prepare(`
    SELECT COUNT(*) AS calls,
           COUNT(DISTINCT user_id) AS activeUsers,
           SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status = 'succeeded' AND passed = 1 THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS errors
    FROM speaking_attempts
  `).get();
  const unlockedUsers = db.prepare("SELECT COUNT(*) AS count FROM speaking_eligibility").get().count;
  const masteredPhrases = db.prepare("SELECT COUNT(*) AS count FROM speaking_phrase_progress WHERE mastered_at IS NOT NULL").get().count;
  const badges = db.prepare("SELECT COUNT(*) AS count FROM speaking_theme_badges").get().count;
  const used = Number(total.calls || 0);
  const percent = speakingPackageTotal ? Math.min(100, Math.round(used / speakingPackageTotal * 100)) : 100;
  const warningLevel = percent >= 100 ? "critical" : percent >= 90 ? "danger" : percent >= 70 ? "warning" : "normal";
  const shape = (row) => ({
    calls: Number(row.calls || 0),
    activeUsers: Number(row.activeUsers || 0),
    succeeded: Number(row.succeeded || 0),
    passed: Number(row.passed || 0),
    errors: Number(row.errors || 0),
    passRate: Number(row.succeeded || 0) ? Math.round(Number(row.passed || 0) / Number(row.succeeded) * 100) : 0
  });
  return res.json({
    enabled: speakingEnabled,
    configured: Boolean(process.env.TENCENT_SOE_APP_ID && process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY),
    today: shape(today),
    total: { ...shape(total), unlockedUsers, masteredPhrases, badges },
    package: {
      total: speakingPackageTotal,
      used,
      reserve: speakingPackageReserve,
      normalUserLimit: Math.max(0, speakingPackageTotal - speakingPackageReserve),
      remaining: Math.max(0, speakingPackageTotal - used),
      percent,
      warningLevel
    },
    limits: { daily: speakingDailyLimit, phraseDaily: speakingPhraseDailyLimit }
  });
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const pageSize = Math.min(50, positiveInt(req.query.pageSize, 10));
  const page = positiveInt(req.query.page, 1);
  const phone = normalizePhone(req.query.phone);
  const filters = [];
  const values = [];
  if (phone) {
    filters.push("phone LIKE ?");
    values.push(`%${phone}%`);
  }
  if (["english", "chinese"].includes(req.query.primaryCourse)) {
    filters.push("primary_course = ?");
    values.push(req.query.primaryCourse);
  }
  if (["active", "disabled"].includes(req.query.status)) {
    filters.push("status = ?");
    values.push(req.query.status);
  }
  if (["free_trial", "founder_trial"].includes(req.query.accessTier)) {
    filters.push("access_tier = ?");
    values.push(req.query.accessTier);
  }
  if (req.query.accessState === "founder_trial") filters.push("access_tier = 'founder_trial'");
  if (req.query.accessState === "free_trial") {
    filters.push("access_tier = 'free_trial' AND trial_expires_at IS NOT NULL AND trial_expires_at > ?");
    values.push(now());
  }
  if (req.query.accessState === "expired") {
    filters.push("access_tier = 'free_trial' AND (trial_expires_at IS NULL OR trial_expires_at <= ?)");
    values.push(now());
  }
  const activityStatus = ["active_today", "login_today", "never", "inactive_30"].includes(req.query.activityStatus)
    ? req.query.activityStatus
    : "";
  const today = shanghaiDateKey();
  if (activityStatus === "active_today") {
    filters.push(`(
      EXISTS (SELECT 1 FROM study_sessions s WHERE s.user_id = users.id AND s.study_date = ?)
      OR EXISTS (SELECT 1 FROM chinese_study_sessions s WHERE s.user_id = users.id AND s.study_date = ?)
    )`);
    values.push(today, today);
  }
  if (activityStatus === "login_today") {
    filters.push("EXISTS (SELECT 1 FROM user_login_days l WHERE l.user_id = users.id AND l.login_date = ?)");
    values.push(today);
  }
  if (activityStatus === "never") {
    filters.push("NOT EXISTS (SELECT 1 FROM study_sessions s WHERE s.user_id = users.id)");
    filters.push("NOT EXISTS (SELECT 1 FROM chinese_study_sessions s WHERE s.user_id = users.id)");
  }
  if (activityStatus === "inactive_30") {
    const cutoff = shiftDateKey(today, -29);
    filters.push("NOT EXISTS (SELECT 1 FROM study_sessions s WHERE s.user_id = users.id AND s.study_date >= ?)");
    filters.push("NOT EXISTS (SELECT 1 FROM chinese_study_sessions s WHERE s.user_id = users.id AND s.study_date >= ?)");
    values.push(cutoff, cutoff);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS count FROM users ${where}`).get(...values).count;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const users = db.prepare(`
    SELECT id, username, nickname, phone, role, status, password_reset_required,
           access_tier, trial_expires_at, primary_course, social_name, created_at, last_login_at,
           COALESCE((SELECT success_count FROM referral_links WHERE user_id = users.id), 0) AS referral_success_count,
           COALESCE((SELECT max_uses FROM referral_links WHERE user_id = users.id), ?) AS referral_max_uses
    FROM users ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(referralLimit, ...values, pageSize, offset);
  const course = req.query.course === "chinese" ? "chinese" : "english";
  const items = users.map((user) => ({
    ...user,
    accessState: userAccessState(user),
    progress: course === "chinese" ? chineseProgressSummary(user.id).totals : progressSummary(user.id).totals,
    todayActivity: db.prepare(`
      SELECT
        COALESCE((SELECT read_count FROM study_sessions WHERE user_id = ? AND study_date = ?), 0)
          + COALESCE((SELECT read_count FROM chinese_study_sessions WHERE user_id = ? AND study_date = ?), 0) AS reads,
        COALESCE((SELECT answer_count FROM study_sessions WHERE user_id = ? AND study_date = ?), 0)
          + COALESCE((SELECT answer_count FROM chinese_study_sessions WHERE user_id = ? AND study_date = ?), 0) AS answers,
        COALESCE((SELECT correct_count FROM study_sessions WHERE user_id = ? AND study_date = ?), 0)
          + COALESCE((SELECT correct_count FROM chinese_study_sessions WHERE user_id = ? AND study_date = ?), 0) AS correct
    `).get(user.id, today, user.id, today, user.id, today, user.id, today, user.id, today, user.id, today)
  }));
  return res.json({ items, page: safePage, pageSize, total, totalPages, course });
});

app.get("/api/admin/users/:id/progress", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "用户编号无效" });
  const user = db.prepare(`
    SELECT id, username, nickname, phone, role, status, created_at, last_login_at
    FROM users WHERE id = ?
  `).get(id);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const course = req.query.course === "chinese" ? "chinese" : "english";
  const progress = course === "chinese" ? chineseProgressSummary(id) : progressSummary(id);
  const rewardTable = course === "chinese" ? "chinese_user_rewards" : "user_rewards";
  const rewardRow = db.prepare(`
    SELECT total_exp, today_exp, streak_correct, fixed_reviews
    FROM ${rewardTable} WHERE user_id = ?
  `).get(id) || { total_exp: 0, today_exp: 0, streak_correct: 0, fixed_reviews: 0 };
  const rewardLevel = course === "chinese"
    ? chineseLevelInfo(rewardRow.total_exp)
    : levelInfo(rewardRow.total_exp);
  const cutoff = shiftDateKey(shanghaiDateKey(), -29);
  const sessionTable = course === "chinese" ? "chinese_study_sessions" : "study_sessions";
  const recentDays = db.prepare(`
    SELECT study_date AS date, read_count AS reads, answer_count AS answers,
           correct_count AS correct
    FROM ${sessionTable}
    WHERE user_id = ? AND study_date >= ?
    ORDER BY study_date DESC
  `).all(id, cutoff);

  return res.json({
    course,
    user,
    progress,
    recentDays,
    reward: {
      ...rewardLevel,
      currencyKey: "emerald",
      currencyLabel: course === "chinese" ? "Emeralds" : "绿宝石",
      dailyLimit: dailyExpLimit,
      levelEmeralds: rewardLevel.levelExp,
      levelNeedEmeralds: rewardLevel.levelNeed,
      totalEmeralds: rewardRow.total_exp,
      todayEmeralds: rewardRow.today_exp,
      totalExp: rewardRow.total_exp,
      todayExp: rewardRow.today_exp,
      streakCorrect: rewardRow.streak_correct,
      fixedReviews: rewardRow.fixed_reviews
    }
  });
});

app.patch("/api/admin/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "不能禁用当前管理员账号" });
  const status = req.body.status === "disabled" ? "disabled" : "active";
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
  auditAdmin(req, "user.account_status", "user", id, { status });
  return res.json({ ok: true });
});

app.patch("/api/admin/users/:id/access", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  if (user.role === "admin") return res.status(400).json({ error: "管理员账号不使用体验权益" });
  const requestedState = ["free_trial", "founder_trial", "expired"].includes(req.body.accessState)
    ? req.body.accessState
    : userAccessState(user);
  const primaryCourse = ["english", "chinese"].includes(req.body.primaryCourse)
    ? req.body.primaryCourse
    : user.primary_course;
  if (primaryCourse !== user.primary_course) {
    const friendshipCount = db.prepare(`
      SELECT COUNT(*) AS count FROM friendships WHERE user_low_id = ? OR user_high_id = ?
    `).get(id, id).count;
    if (friendshipCount) return res.status(409).json({ error: "该用户已有好友关系，暂不能更换主课程" });
  }
  let accessTier = requestedState === "founder_trial" ? "founder_trial" : "free_trial";
  let trialExpiresAt = null;
  if (requestedState === "free_trial") {
    const supplied = req.body.trialExpiresAt ? new Date(req.body.trialExpiresAt) : null;
    trialExpiresAt = supplied && Number.isFinite(supplied.getTime())
      ? supplied.toISOString()
      : new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString();
  } else if (requestedState === "expired") {
    trialExpiresAt = now();
  }
  db.prepare(`
    UPDATE users SET access_tier = ?, trial_expires_at = ?, primary_course = ? WHERE id = ?
  `).run(accessTier, trialExpiresAt, primaryCourse, id);
  auditAdmin(req, "user.access", "user", id, { accessState: requestedState, primaryCourse, trialExpiresAt });
  return res.json({ ok: true, user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id)) });
});

app.get("/api/admin/registration-applications", requireAdmin, (req, res) => {
  const pageSize = Math.min(50, positiveInt(req.query.pageSize, 10));
  const page = positiveInt(req.query.page, 1);
  const status = ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : "pending";
  const total = db.prepare("SELECT COUNT(*) AS count FROM registration_applications WHERE status = ?").get(status).count;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const items = db.prepare(`
    SELECT a.id, a.phone, a.social_name AS socialName, a.primary_course AS primaryCourse,
           a.status, a.created_at AS createdAt, a.reviewed_at AS reviewedAt,
           a.rejection_reason AS rejectionReason, u.social_name AS inviterSocialName
    FROM registration_applications a
    JOIN users u ON u.id = a.inviter_user_id
    WHERE a.status = ?
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(status, pageSize, (safePage - 1) * pageSize);
  return res.json({ items, page: safePage, pageSize, total, totalPages, status });
});

app.post("/api/admin/registration-applications/:id/approve", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const application = db.prepare("SELECT * FROM registration_applications WHERE id = ?").get(id);
  if (!application || application.status !== "pending") return res.status(404).json({ error: "待审核申请不存在" });
  try {
    const userId = db.transaction(() => {
      if (db.prepare("SELECT id FROM users WHERE phone = ?").get(application.phone)) throw new Error("该手机号已注册");
      const link = db.prepare(`
        SELECT * FROM referral_links
        WHERE user_id = ? AND version = ? AND active = 1
      `).get(application.inviter_user_id, application.referral_version);
      if (!link || link.success_count >= link.max_uses) throw new Error("邀请链接已失效或达到使用上限");
      const inviter = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(application.inviter_user_id);
      if (!inviter || userAccessState(inviter) === "expired") throw new Error("邀请人账号当前不可用");
      const nickname = application.phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
      const expiresAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString();
      const inserted = db.prepare(`
        INSERT INTO users (
          username, password_hash, nickname, phone, role, status, password_reset_required,
          access_tier, trial_expires_at, primary_course, social_name, created_at
        ) VALUES (?, ?, ?, ?, 'user', 'active', 0, 'free_trial', ?, ?, ?, ?)
      `).run(
        application.phone,
        application.password_hash,
        nickname,
        application.phone,
        expiresAt,
        application.primary_course,
        application.social_name,
        now()
      );
      const newUserId = Number(inserted.lastInsertRowid);
      db.prepare(`
        INSERT INTO referrals (inviter_user_id, invitee_user_id, referral_version, created_at)
        VALUES (?, ?, ?, ?)
      `).run(application.inviter_user_id, newUserId, application.referral_version, now());
      createFriendship(application.inviter_user_id, newUserId, application.primary_course);
      db.prepare("UPDATE referral_links SET success_count = success_count + 1, updated_at = ? WHERE user_id = ?")
        .run(now(), application.inviter_user_id);
      db.prepare(`
        UPDATE registration_applications
        SET status = 'approved', password_hash = '', reviewed_at = ?, reviewed_by = ? WHERE id = ?
      `).run(now(), req.user.id, id);
      return newUserId;
    })();
    auditAdmin(req, "registration.approve", "registration_application", id, { userId, primaryCourse: application.primary_course });
    return res.json({ ok: true, userId });
  } catch (error) {
    return res.status(409).json({ error: error.message });
  }
});

app.post("/api/admin/registration-applications/:id/reject", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body.reason || "").trim().slice(0, 200);
  const result = db.prepare(`
    UPDATE registration_applications
    SET status = 'rejected', password_hash = '', reviewed_at = ?, reviewed_by = ?, rejection_reason = ?
    WHERE id = ? AND status = 'pending'
  `).run(now(), req.user.id, reason, id);
  if (!result.changes) return res.status(404).json({ error: "待审核申请不存在" });
  auditAdmin(req, "registration.reject", "registration_application", id, { reason });
  return res.json({ ok: true });
});

app.get("/api/admin/audit-logs", requireAdmin, (req, res) => {
  const pageSize = Math.min(100, positiveInt(req.query.pageSize, 20));
  const page = positiveInt(req.query.page, 1);
  const action = String(req.query.action || "").trim();
  const where = action ? "WHERE l.action = ?" : "";
  const values = action ? [action] : [];
  const total = db.prepare(`SELECT COUNT(*) AS count FROM admin_audit_logs l ${where}`).get(...values).count;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = db.prepare(`
    SELECT l.id, l.action, l.target_type AS targetType, l.target_id AS targetId,
           l.details_json AS detailsJson, l.ip_hash AS ipHash, l.user_agent AS userAgent,
           l.created_at AS createdAt, u.username AS adminUsername
    FROM admin_audit_logs l
    LEFT JOIN users u ON u.id = l.admin_user_id
    ${where}
    ORDER BY l.id DESC LIMIT ? OFFSET ?
  `).all(...values, pageSize, (safePage - 1) * pageSize);
  const items = rows.map(({ detailsJson, ...row }) => {
    try {
      return { ...row, details: JSON.parse(detailsJson) };
    } catch {
      return { ...row, details: {} };
    }
  });
  return res.json({ items, page: safePage, pageSize, total, totalPages });
});

app.post("/api/admin/users/:id/reset-password", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT id, username, phone, role FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  if (user.role === "admin") return res.status(400).json({ error: "不能在这里重置管理员密码" });
  const password = randomPassword(10);
  db.prepare("UPDATE users SET password_hash = ?, password_reset_required = 1 WHERE id = ?").run(bcrypt.hashSync(password, 10), id);
  auditAdmin(req, "user.password_reset", "user", id, { phoneLast4: String(user.phone || "").slice(-4) });
  return res.json({ ok: true, phone: user.phone, username: user.username, password, passwordResetRequired: true });
});

app.use("/", requirePasswordReadyPage, (req, res, next) => {
  if (path.extname(req.path).toLowerCase() === ".html") return res.status(404).end();
  return next();
}, express.static(publicDir, { index: false, extensions: false }));
app.get("*", requirePasswordReadyPage, (req, res) => res.redirect(req.user.primary_course === "chinese" ? "/chinese" : "/"));

let server = null;
if (require.main === module) {
  server = app.listen(port, host, () => {
    console.log(`Minecraft English Reader listening on http://${host}:${port}`);
  });
}

module.exports = {
  app,
  db,
  sessionStore,
  helpers: {
    allowedThemeIds,
    assessSpeakingPcm,
    normalizeSoeResult,
    recordSpeakingResult,
    friendStats,
    parseReferralToken,
    referralToken,
    shanghaiDateKey,
    speakingEligibility,
    speakingProgressSummary,
    speakingStars,
    speakingThemes,
    speakingUsageCount,
    userAccessState,
    weekRange
  }
};
