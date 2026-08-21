"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mer-beta-"));
const databasePath = path.join(directory, "app.db");
const sessionPath = path.join(directory, "sessions.db");
const seed = new Database(databasePath);
seed.exec(`
  CREATE TABLE users (
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
`);
seed.prepare(`INSERT INTO users (username, password_hash, nickname, phone, role, status, created_at) VALUES (?, ?, ?, ?, 'user', 'active', ?)`)
  .run("legacy", bcrypt.hashSync("LegacyPass123", 4), "Legacy", "13900000001", new Date().toISOString());
seed.close();

process.env.DATABASE_PATH = databasePath;
process.env.SESSION_DATABASE_PATH = sessionPath;
process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.ACCESS_CONTROL_ENFORCED = "true";
process.env.SESSION_SECRET = "test-session-secret-with-enough-length";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "AdminPass123";
process.env.ADMIN_PHONE = "13800000000";

const { app, db, sessionStore, helpers } = require("../server");
let server;
let baseUrl;
let adminCookie;
let invitedCookie;

async function login(phone, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password })
  });
  const cookieHeader = response.headers.get("set-cookie");
  return { response, cookie: cookieHeader ? cookieHeader.split(";")[0] : "" };
}

function authHeaders(cookie) {
  return { Cookie: cookie, "Content-Type": "application/json" };
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  sessionStore.close();
  db.close();
});

test("incremental migration preserves existing user and adds public beta schema", () => {
  const legacy = db.prepare("SELECT * FROM users WHERE phone = ?").get("13900000001");
  assert.equal(legacy.username, "legacy");
  assert.equal(legacy.access_tier, "founder_trial");
  assert.equal(legacy.primary_course, "english");
  assert.match(legacy.social_name, /^BlockLearner-/);
  const migration = db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get("2026-08-09-public-beta-v1");
  assert.ok(migration);
  assert.ok(db.prepare("SELECT version FROM schema_migrations WHERE version = ?")
    .get("2026-08-09-review-three-correct-v1"));
  assert.ok(db.prepare("SELECT version FROM schema_migrations WHERE version = ?")
    .get("2026-08-10-admin-dashboard-v1"));
  assert.ok(db.prepare("SELECT version FROM schema_migrations WHERE version = ?")
    .get("2026-08-12-theme-single-pass-v1"));
  assert.ok(db.prepare("SELECT version FROM schema_migrations WHERE version = ?")
    .get("2026-08-21-speaking-assessment-v1"));
  for (const table of ["admin_audit_logs", "registration_applications", "referral_links", "friendships", "friend_pk_bonus_events", "user_login_days", "speaking_eligibility", "speaking_phrase_progress", "speaking_attempts", "speaking_theme_badges"]) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_login_days_date'").get());
});

test("admin login returns secure public user shape and persistent session cookie", async () => {
  const result = await login("13800000000", "AdminPass123");
  assert.equal(result.response.status, 200);
  adminCookie = result.cookie;
  const me = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: adminCookie } });
  assert.equal(me.status, 200);
  const payload = await me.json();
  assert.equal(payload.user.role, "admin");
  assert.equal(payload.user.accessState, "founder_trial");
  assert.ok(Array.isArray(payload.user.allowedThemeIds.english));
  assert.ok(Array.isArray(payload.user.allowedThemeIds.chinese));
});

test("referral approval creates a free user and friendship atomically", async () => {
  const founderLogin = await login("13900000001", "LegacyPass123");
  assert.equal(founderLogin.response.status, 200);
  const linkResponse = await fetch(`${baseUrl}/api/referrals/link`, {
    method: "POST", headers: authHeaders(founderLogin.cookie), body: "{}"
  });
  assert.equal(linkResponse.status, 200);
  const link = await linkResponse.json();
  const invitationUrl = new URL(link.link);
  const token = new URLSearchParams(invitationUrl.hash.slice(1)).get("ref");
  assert.equal(invitationUrl.search, "");
  assert.ok(token);

  const previewResponse = await fetch(`${baseUrl}/api/referrals/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  assert.equal(previewResponse.status, 200);
  assert.equal((await previewResponse.json()).primaryCourse, "english");

  const applicationResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "13700000002", password: "InvitePass123", referralToken: token, guardianConfirmed: true })
  });
  assert.equal(applicationResponse.status, 202);
  const application = await applicationResponse.json();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE phone = ?").get("13700000002").count, 0);

  const approval = await fetch(`${baseUrl}/api/admin/registration-applications/${application.applicationId}/approve`, {
    method: "POST", headers: authHeaders(adminCookie), body: "{}"
  });
  assert.equal(approval.status, 200);
  const invited = db.prepare("SELECT * FROM users WHERE phone = ?").get("13700000002");
  assert.equal(invited.access_tier, "free_trial");
  assert.ok(invited.trial_expires_at);
  assert.equal(db.prepare("SELECT password_hash FROM registration_applications WHERE id = ?").get(application.applicationId).password_hash, "");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM friendships WHERE user_low_id = ? OR user_high_id = ?").get(invited.id, invited.id).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM admin_audit_logs WHERE action = 'registration.approve'").get().count, 1);
});

test("free user sees only trial themes and cannot bypass locked APIs", async () => {
  const invitedLogin = await login("13700000002", "InvitePass123");
  assert.equal(invitedLogin.response.status, 200);
  invitedCookie = invitedLogin.cookie;
  const themesResponse = await fetch(`${baseUrl}/api/themes`, { headers: { Cookie: invitedLogin.cookie } });
  const themePayload = await themesResponse.json();
  assert.equal(themePayload.themes.filter((theme) => !theme.locked).length, 3);
  const lockedTheme = themePayload.themes.find((theme) => theme.locked);
  assert.ok(lockedTheme);
  const quiz = await fetch(`${baseUrl}/api/quiz/next`, {
    method: "POST", headers: authHeaders(invitedLogin.cookie), body: JSON.stringify({ themeId: lockedTheme.id })
  });
  assert.equal(quiz.status, 403);
  assert.equal((await quiz.json()).code, "THEME_LOCKED");
  const tts = await fetch(`${baseUrl}/api/tts?text=${encodeURIComponent("not in vocabulary")}`, { headers: { Cookie: invitedLogin.cookie } });
  assert.equal(tts.status, 403);
  assert.equal((await tts.json()).code, "TTS_TEXT_NOT_ALLOWED");
});

test("HTML filenames cannot bypass page authorization", async () => {
  const adminHtml = await fetch(`${baseUrl}/admin.html`, { headers: { Cookie: invitedCookie }, redirect: "manual" });
  assert.equal(adminHtml.status, 404);
  const chineseHtml = await fetch(`${baseUrl}/core-words-cn.html`, { headers: { Cookie: invitedCookie }, redirect: "manual" });
  assert.equal(chineseHtml.status, 404);
  const asset = await fetch(`${baseUrl}/minecraft-english-17.webp`, { headers: { Cookie: invitedCookie } });
  assert.equal(asset.status, 200);
});

test("admin can filter experience users and see referral usage", async () => {
  const response = await fetch(`${baseUrl}/api/admin/users?accessState=free_trial&primaryCourse=english`, { headers: { Cookie: adminCookie } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].phone, "13700000002");
  assert.equal(payload.items[0].referral_max_uses, 20);
});

test("correct quiz answers persist Emerald rewards for both courses", async () => {
  const englishThemesResponse = await fetch(`${baseUrl}/api/themes`, { headers: { Cookie: invitedCookie } });
  const englishThemes = await englishThemesResponse.json();
  const englishTheme = englishThemes.themes.find((theme) => !theme.locked);
  const englishItem = englishTheme.items[0];
  const englishAnswerResponse = await fetch(`${baseUrl}/api/quiz/answer`, {
    method: "POST",
    headers: authHeaders(invitedCookie),
    body: JSON.stringify({ themeId: englishTheme.id, word: englishItem.word, selectedCn: englishItem.cn })
  });
  assert.equal(englishAnswerResponse.status, 200);
  const englishAnswer = await englishAnswerResponse.json();
  assert.equal(englishAnswer.correct, true);
  assert.equal(englishAnswer.rewardState.totalEmeralds, 5);
  assert.equal(englishAnswer.rewardEvents[0].emeralds, 5);
  const invited = db.prepare("SELECT id FROM users WHERE phone = ?").get("13700000002");
  assert.equal(db.prepare("SELECT total_exp FROM user_rewards WHERE user_id = ?").get(invited.id).total_exp, 5);

  const chineseThemesResponse = await fetch(`${baseUrl}/api/chinese/themes`, { headers: { Cookie: adminCookie } });
  const chineseThemes = await chineseThemesResponse.json();
  const chineseTheme = chineseThemes.themes[0];
  const chineseItem = chineseTheme.items[0];
  const chineseAnswerResponse = await fetch(`${baseUrl}/api/chinese/quiz/answer`, {
    method: "POST",
    headers: authHeaders(adminCookie),
    body: JSON.stringify({ themeId: chineseTheme.id, itemId: chineseItem.id, selectedChinese: chineseItem.chinese })
  });
  assert.equal(chineseAnswerResponse.status, 200);
  const chineseAnswer = await chineseAnswerResponse.json();
  assert.equal(chineseAnswer.correct, true);
  assert.equal(chineseAnswer.rewardState.totalEmeralds, 5);
  assert.equal(chineseAnswer.rewardEvents[0].emeralds, 5);
});

test("daily Emerald cap returns an explicit zero-reward message", async () => {
  const invited = db.prepare("SELECT id FROM users WHERE phone = ?").get("13700000002");
  db.prepare("UPDATE user_rewards SET today_exp = 150 WHERE user_id = ?").run(invited.id);
  const themesResponse = await fetch(`${baseUrl}/api/themes`, { headers: { Cookie: invitedCookie } });
  const themes = await themesResponse.json();
  const theme = themes.themes.find((candidate) => !candidate.locked);
  const item = theme.items[1];
  const response = await fetch(`${baseUrl}/api/quiz/answer`, {
    method: "POST",
    headers: authHeaders(invitedCookie),
    body: JSON.stringify({ themeId: theme.id, word: item.word, selectedCn: item.cn })
  });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.correct, true);
  assert.equal(answer.rewardEvents[0].emeralds, 0);
  assert.match(answer.rewardEvents[0].label, /今日绿宝石已达上限/);
});

test("a missed word rests for the day after three correct reviews", async () => {
  const themesResponse = await fetch(`${baseUrl}/api/themes`, { headers: { Cookie: invitedCookie } });
  const themes = await themesResponse.json();
  const theme = themes.themes.find((candidate) => !candidate.locked);
  const item = theme.items[2];
  const wrongItem = theme.items.find((candidate) => candidate.cn !== item.cn);
  const wrongResponse = await fetch(`${baseUrl}/api/quiz/answer`, {
    method: "POST",
    headers: authHeaders(invitedCookie),
    body: JSON.stringify({ themeId: theme.id, word: item.word, selectedCn: wrongItem.cn })
  });
  assert.equal((await wrongResponse.json()).correct, false);

  for (let index = 0; index < 5; index += 1) {
    const nextResponse = await fetch(`${baseUrl}/api/quiz/next`, {
      method: "POST", headers: authHeaders(invitedCookie), body: JSON.stringify({ themeId: theme.id })
    });
    assert.notEqual((await nextResponse.json()).word, item.word, "pending review appeared before question 6");
  }

  for (let fixedCount = 1; fixedCount <= 3; fixedCount += 1) {
    const response = await fetch(`${baseUrl}/api/quiz/answer`, {
      method: "POST",
      headers: authHeaders(invitedCookie),
      body: JSON.stringify({ themeId: theme.id, word: item.word, selectedCn: item.cn })
    });
    assert.equal((await response.json()).correct, true);
    const queue = db.prepare(`
      SELECT status, consecutive_fix_count FROM review_queue
      WHERE user_id = (SELECT id FROM users WHERE phone = ?) AND theme_id = ? AND word = ?
    `).get("13700000002", theme.id, item.word);
    assert.equal(queue.consecutive_fix_count, fixedCount);
    assert.equal(queue.status, fixedCount === 3 ? "fixed" : "active");
  }
  const progress = db.prepare(`
    SELECT mastery_status FROM word_progress
    WHERE user_id = (SELECT id FROM users WHERE phone = ?) AND theme_id = ? AND word = ?
  `).get("13700000002", theme.id, item.word);
  assert.equal(progress.mastery_status, "mastered");

  for (let index = 0; index < 40; index += 1) {
    const nextResponse = await fetch(`${baseUrl}/api/quiz/next`, {
      method: "POST", headers: authHeaders(invitedCookie), body: JSON.stringify({ themeId: theme.id })
    });
    assert.notEqual((await nextResponse.json()).word, item.word, "fixed review reappeared on the same day");
  }
});

test("Chinese review words use the same three-correct daily rest rule", async () => {
  const themesResponse = await fetch(`${baseUrl}/api/chinese/themes`, { headers: { Cookie: adminCookie } });
  const themes = await themesResponse.json();
  const theme = themes.themes[0];
  const item = theme.items[1];
  const wrongItem = theme.items.find((candidate) => candidate.chinese !== item.chinese);
  await fetch(`${baseUrl}/api/chinese/quiz/answer`, {
    method: "POST",
    headers: authHeaders(adminCookie),
    body: JSON.stringify({ themeId: theme.id, itemId: item.id, selectedChinese: wrongItem.chinese })
  });
  for (let fixedCount = 1; fixedCount <= 3; fixedCount += 1) {
    const response = await fetch(`${baseUrl}/api/chinese/quiz/answer`, {
      method: "POST",
      headers: authHeaders(adminCookie),
      body: JSON.stringify({ themeId: theme.id, itemId: item.id, selectedChinese: item.chinese })
    });
    assert.equal((await response.json()).correct, true);
  }
  const queue = db.prepare(`
    SELECT status, consecutive_fix_count FROM chinese_review_queue
    WHERE user_id = (SELECT id FROM users WHERE role = 'admin') AND theme_id = ? AND item_id = ?
  `).get(theme.id, item.id);
  assert.equal(queue.status, "fixed");
  assert.equal(queue.consecutive_fix_count, 3);
  for (let index = 0; index < 30; index += 1) {
    const nextResponse = await fetch(`${baseUrl}/api/chinese/quiz/next`, {
      method: "POST", headers: authHeaders(adminCookie), body: JSON.stringify({ themeId: theme.id })
    });
    assert.notEqual((await nextResponse.json()).itemId, item.id, "fixed Chinese review reappeared on the same day");
  }
});

test("correct words leave the theme quiz and completion is reported", async () => {
  const user = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  const themesResponse = await fetch(`${baseUrl}/api/themes`, { headers: { Cookie: adminCookie } });
  const themes = await themesResponse.json();
  const theme = themes.themes[0];
  db.prepare("DELETE FROM review_queue WHERE user_id = ? AND theme_id = ?").run(user.id, theme.id);
  db.prepare("DELETE FROM word_progress WHERE user_id = ? AND theme_id = ?").run(user.id, theme.id);
  db.prepare("DELETE FROM theme_badges WHERE user_id = ? AND theme_id = ?").run(user.id, theme.id);

  const first = await fetch(`${baseUrl}/api/quiz/next`, {
    method: "POST", headers: authHeaders(adminCookie), body: JSON.stringify({ themeId: theme.id })
  }).then((response) => response.json());
  const firstItem = theme.items.find((item) => item.word === first.word);
  await fetch(`${baseUrl}/api/quiz/answer`, {
    method: "POST",
    headers: authHeaders(adminCookie),
    body: JSON.stringify({ themeId: theme.id, word: first.word, selectedCn: firstItem.cn })
  });
  assert.equal(db.prepare(`
    SELECT mastery_status FROM word_progress WHERE user_id = ? AND theme_id = ? AND word = ?
  `).get(user.id, theme.id, first.word).mastery_status, "mastered");
  for (let index = 0; index < 30; index += 1) {
    const next = await fetch(`${baseUrl}/api/quiz/next`, {
      method: "POST", headers: authHeaders(adminCookie), body: JSON.stringify({ themeId: theme.id })
    }).then((response) => response.json());
    assert.notEqual(next.word, first.word, "a correct regular word must not repeat in the theme run");
    if (next.completed) break;
  }

  const insertProgress = db.prepare(`
    INSERT INTO word_progress (user_id, theme_id, word, answer_count, correct_count, mastery_status, last_studied_at)
    VALUES (?, ?, ?, 1, 1, 'mastered', ?)
    ON CONFLICT(user_id, theme_id, word)
    DO UPDATE SET correct_count = 1, mastery_status = 'mastered', last_studied_at = excluded.last_studied_at
  `);
  for (const item of theme.items) insertProgress.run(user.id, theme.id, item.word, new Date().toISOString());
  const completed = await fetch(`${baseUrl}/api/quiz/next`, {
    method: "POST", headers: authHeaders(adminCookie), body: JSON.stringify({ themeId: theme.id })
  }).then((response) => response.json());
  assert.equal(completed.completed, true);
  assert.equal(completed.themeId, theme.id);
  assert.ok(Array.isArray(completed.rewardEvents));

  const chineseThemes = await fetch(`${baseUrl}/api/chinese/themes`, { headers: { Cookie: adminCookie } })
    .then((response) => response.json());
  const chineseTheme = chineseThemes.themes[0];
  db.prepare("DELETE FROM chinese_review_queue WHERE user_id = ? AND theme_id = ?").run(user.id, chineseTheme.id);
  db.prepare("DELETE FROM chinese_word_progress WHERE user_id = ? AND theme_id = ?").run(user.id, chineseTheme.id);
  db.prepare("DELETE FROM chinese_theme_badges WHERE user_id = ? AND theme_id = ?").run(user.id, chineseTheme.id);
  const chineseFirst = await fetch(`${baseUrl}/api/chinese/quiz/next`, {
    method: "POST", headers: authHeaders(adminCookie), body: JSON.stringify({ themeId: chineseTheme.id })
  }).then((response) => response.json());
  const chineseFirstItem = chineseTheme.items.find((item) => item.id === chineseFirst.itemId);
  await fetch(`${baseUrl}/api/chinese/quiz/answer`, {
    method: "POST",
    headers: authHeaders(adminCookie),
    body: JSON.stringify({ themeId: chineseTheme.id, itemId: chineseFirst.itemId, selectedChinese: chineseFirstItem.chinese })
  });
  for (let index = 0; index < 30; index += 1) {
    const next = await fetch(`${baseUrl}/api/chinese/quiz/next`, {
      method: "POST", headers: authHeaders(adminCookie), body: JSON.stringify({ themeId: chineseTheme.id })
    }).then((response) => response.json());
    assert.notEqual(next.itemId, chineseFirst.itemId, "a correct Chinese word must not repeat in the theme run");
    if (next.completed) break;
  }
  const insertChineseProgress = db.prepare(`
    INSERT INTO chinese_word_progress (user_id, theme_id, item_id, answer_count, correct_count, mastery_status, last_studied_at)
    VALUES (?, ?, ?, 1, 1, 'mastered', ?)
    ON CONFLICT(user_id, theme_id, item_id)
    DO UPDATE SET correct_count = 1, mastery_status = 'mastered', last_studied_at = excluded.last_studied_at
  `);
  for (const item of chineseTheme.items) insertChineseProgress.run(user.id, chineseTheme.id, item.id, new Date().toISOString());
  const chineseCompleted = await fetch(`${baseUrl}/api/chinese/quiz/next`, {
    method: "POST", headers: authHeaders(adminCookie), body: JSON.stringify({ themeId: chineseTheme.id })
  }).then((response) => response.json());
  assert.equal(chineseCompleted.completed, true);
  assert.equal(chineseCompleted.themeId, chineseTheme.id);
});

test("admin dashboard separates login, learning and historical totals", async () => {
  const failedLogin = await login("13900000001", "WrongPassword123");
  assert.equal(failedLogin.response.status, 401);
  const legacy = db.prepare("SELECT id FROM users WHERE phone = ?").get("13900000001");
  const legacyLoginDay = db.prepare("SELECT login_count FROM user_login_days WHERE user_id = ?").get(legacy.id);
  assert.equal(legacyLoginDay.login_count, 1, "failed logins must not increment daily login totals");

  const dashboardResponse = await fetch(`${baseUrl}/api/admin/dashboard`, { headers: { Cookie: adminCookie } });
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.summary.loginUsers, 2, "admin login should be excluded");
  assert.equal(dashboard.summary.learningUsers, 1, "learning users should be unique across courses");
  assert.equal(dashboard.summary.loggedOnlyUsers, 1);
  assert.ok(dashboard.summary.answers > 0);
  assert.equal(dashboard.courses.chinese.learningUsers, 0, "admin course activity should be excluded");
  assert.equal(dashboard.trend.length, 7);

  const activeResponse = await fetch(`${baseUrl}/api/admin/dashboard/active-users?layer=quiz&course=all`, {
    headers: { Cookie: adminCookie }
  });
  assert.equal(activeResponse.status, 200);
  const active = await activeResponse.json();
  assert.equal(active.total, 1);
  assert.equal(active.items[0].phone, "13700000002");

  const historyResponse = await fetch(`${baseUrl}/api/admin/dashboard/history`, { headers: { Cookie: adminCookie } });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.overall.totalUsers, 2);
  assert.equal(history.overall.learningUsers, 1);
  assert.equal(history.overall.studyDays, 1);
  assert.ok(history.overall.answers > 0);
  assert.equal(history.courses.chinese.learningUsers, 0);
  assert.equal(history.invitations.referralApplications.approved, 1);
  assert.match(history.loginTrackingStartedAt, /^\d{4}-\d{2}-\d{2}$/);

  const courseResponse = await fetch(`${baseUrl}/api/admin/course-summary?course=english&range=today`, {
    headers: { Cookie: adminCookie }
  });
  assert.equal(courseResponse.status, 200);
  const course = await courseResponse.json();
  assert.equal(course.emeralds, 5);
  assert.equal(course.topUsers.length, 1);
  assert.equal(course.topUsers[0].phone, "13700000002");

  const invited = db.prepare("SELECT id FROM users WHERE phone = ?").get("13700000002");
  const englishProgressResponse = await fetch(`${baseUrl}/api/admin/users/${invited.id}/progress?course=english`, {
    headers: { Cookie: adminCookie }
  });
  const chineseProgressResponse = await fetch(`${baseUrl}/api/admin/users/${invited.id}/progress?course=chinese`, {
    headers: { Cookie: adminCookie }
  });
  assert.ok((await englishProgressResponse.json()).recentDays.length > 0);
  assert.equal((await chineseProgressResponse.json()).recentDays.length, 0, "recent dates should follow the selected course");
});

test("social dashboard is read-only and reports referral relationships", async () => {
  const response = await fetch(`${baseUrl}/api/admin/social-summary`, { headers: { Cookie: adminCookie } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.summary.approvedReferrals, 1);
  assert.equal(payload.summary.friendships, 1);
  assert.equal(payload.topInviters.length, 1);
  assert.equal(payload.recentFriendships.length, 1);
  assert.equal(payload.trend.length, 7);
});

test("admin reset supports temporary login and one-step new password setup", async () => {
  const legacy = db.prepare("SELECT id FROM users WHERE phone = ?").get("13900000001");
  const firstResetResponse = await fetch(`${baseUrl}/api/admin/users/${legacy.id}/reset-password`, {
    method: "POST",
    headers: authHeaders(adminCookie),
    body: "{}"
  });
  assert.equal(firstResetResponse.status, 200);
  const firstReset = await firstResetResponse.json();
  const resetResponse = await fetch(`${baseUrl}/api/admin/users/${legacy.id}/reset-password`, {
    method: "POST",
    headers: authHeaders(adminCookie),
    body: "{}"
  });
  assert.equal(resetResponse.status, 200);
  const reset = await resetResponse.json();
  assert.equal(reset.passwordResetRequired, true);
  assert.equal(reset.password.length, 10);
  assert.notEqual(reset.password, firstReset.password);
  const expiredTemporaryLogin = await login("13900000001", firstReset.password);
  assert.equal(expiredTemporaryLogin.response.status, 401);

  const temporaryLogin = await login("１３９０００００００１", ` ${reset.password}\n`);
  assert.equal(temporaryLogin.response.status, 200);
  const temporaryPayload = await temporaryLogin.response.json();
  assert.equal(temporaryPayload.user.passwordResetRequired, true);

  const completeResponse = await fetch(`${baseUrl}/api/auth/complete-password-reset`, {
    method: "POST",
    headers: authHeaders(temporaryLogin.cookie),
    body: JSON.stringify({ newPassword: "RenewedPass123", confirmPassword: "RenewedPass123" })
  });
  assert.equal(completeResponse.status, 200);
  assert.equal((await completeResponse.json()).user.passwordResetRequired, false);

  const reusedTemporaryPassword = await login("13900000001", reset.password);
  assert.equal(reusedTemporaryPassword.response.status, 401);
  const renewedLogin = await login("13900000001", "RenewedPass123");
  assert.equal(renewedLogin.response.status, 200);
  assert.equal(db.prepare("SELECT password_reset_required FROM users WHERE id = ?").get(legacy.id).password_reset_required, 0);
});

test("disabled accounts receive a stable API error code", async () => {
  db.prepare("UPDATE users SET status = 'disabled' WHERE phone = ?").run("13700000002");
  const me = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: invitedCookie } });
  assert.equal(me.status, 403);
  assert.equal((await me.json()).code, "ACCOUNT_DISABLED");
  const disabledLogin = await login("13700000002", "InvitePass123");
  assert.equal(disabledLogin.response.status, 403);
  assert.equal((await disabledLogin.response.json()).code, "ACCOUNT_DISABLED");
  const filtered = await fetch(`${baseUrl}/api/admin/users?status=disabled`, { headers: { Cookie: adminCookie } });
  assert.equal(filtered.status, 200);
  const filteredPayload = await filtered.json();
  assert.equal(filteredPayload.total, 1);
  assert.equal(filteredPayload.items[0].phone, "13700000002");
});

test("speaking course unlocks at 80 percent and stays unlocked", async () => {
  const legacy = db.prepare("SELECT * FROM users WHERE phone = ?").get("13900000001");
  db.prepare("DELETE FROM speaking_eligibility WHERE user_id = ?").run(legacy.id);
  db.prepare("DELETE FROM word_progress WHERE user_id = ?").run(legacy.id);
  const response = await fetch(`${baseUrl}/api/themes`, { headers: { Cookie: adminCookie } });
  const payload = await response.json();
  const words = payload.themes.flatMap((theme) => theme.items.map((item) => ({ themeId: theme.id, word: item.word })));
  const required = Math.ceil(words.length * .8);
  const insert = db.prepare(`
    INSERT INTO word_progress (user_id, theme_id, word, correct_count, mastery_status, last_studied_at)
    VALUES (?, ?, ?, 1, 'mastered', ?)
  `);
  db.transaction((items) => items.forEach((item) => insert.run(legacy.id, item.themeId, item.word, new Date().toISOString())))(words.slice(0, required - 1));
  const locked = helpers.speakingEligibility(legacy, { persist: false });
  assert.equal(locked.qualified, false);
  assert.equal(locked.requiredWords, required);
  insert.run(legacy.id, words[required - 1].themeId, words[required - 1].word, new Date().toISOString());
  const unlocked = helpers.speakingEligibility(legacy);
  assert.equal(unlocked.qualified, true);
  assert.ok(db.prepare("SELECT unlocked_at FROM speaking_eligibility WHERE user_id = ?").get(legacy.id));
  db.prepare("DELETE FROM word_progress WHERE user_id = ?").run(legacy.id);
  assert.equal(helpers.speakingEligibility(legacy, { persist: false }).qualified, true);
});

test("speaking phrase data, scores and rewards stay isolated", () => {
  const items = helpers.speakingThemes.flatMap((theme) => theme.items);
  assert.equal(helpers.speakingThemes.length, 5);
  assert.equal(items.length, 100);
  assert.equal(new Set(items.map((item) => item.id)).size, 100);
  assert.ok(items.every((item) => item.english.trim().split(/\s+/).length <= 30));
  assert.equal(helpers.speakingStars(80, .8), 3);
  assert.equal(helpers.speakingStars(80, .79), 2);
  assert.equal(helpers.normalizeSoeResult({ SuggestedScore: 79, PronCompletion: 1 }).passed, false);

  const user = db.prepare("SELECT id FROM users WHERE phone = ?").get("13900000001");
  const rewardCount = db.prepare("SELECT COUNT(*) AS count FROM reward_events WHERE user_id = ?").get(user.id).count;
  const attempt = (requestId, result) => {
    db.prepare("INSERT INTO speaking_attempts (user_id, phrase_id, request_id, status, created_at) VALUES (?, 1, ?, 'processing', ?)")
      .run(user.id, requestId, new Date().toISOString());
    return helpers.recordSpeakingResult(user.id, 1, requestId, result);
  };
  assert.equal(attempt("speaking-test-1", { SuggestedScore: 82, PronAccuracy: 81, PronFluency: .8, PronCompletion: .7 }).stars, 2);
  assert.equal(attempt("speaking-test-2", { SuggestedScore: 81, PronAccuracy: 80, PronFluency: .8, PronCompletion: .8 }).passed, true);
  attempt("speaking-test-3", { SuggestedScore: 50, PronAccuracy: 50, PronFluency: .5, PronCompletion: .5 });
  const progress = db.prepare("SELECT * FROM speaking_phrase_progress WHERE user_id = ? AND phrase_id = 1").get(user.id);
  assert.equal(progress.attempt_count, 3);
  assert.equal(progress.best_score, 82);
  assert.equal(progress.stars, 3);
  assert.ok(progress.mastered_at);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reward_events WHERE user_id = ?").get(user.id).count, rewardCount);
  const columns = db.prepare("PRAGMA table_info(speaking_attempts)").all().map((column) => column.name);
  assert.equal(columns.some((name) => /audio|blob|recording/i.test(name)), false);
});

test("speaking audio waits for the Tencent SOE handshake", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalAppId = process.env.TENCENT_SOE_APP_ID;
  const originalSecretId = process.env.TENCENT_SECRET_ID;
  const originalSecretKey = process.env.TENCENT_SECRET_KEY;
  class FakeWebSocket {
    static instances = [];
    constructor() {
      this.listeners = new Map();
      this.sent = [];
      FakeWebSocket.instances.push(this);
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    emit(type, event) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
    send(value) { this.sent.push(value); }
    close() {}
  }
  try {
    globalThis.WebSocket = FakeWebSocket;
    process.env.TENCENT_SOE_APP_ID = "1234567890";
    process.env.TENCENT_SECRET_ID = "test-secret-id";
    process.env.TENCENT_SECRET_KEY = "test-secret-key";
    const assessment = helpers.assessSpeakingPcm("hello world", Buffer.alloc(16000));
    await new Promise((resolve) => setImmediate(resolve));
    const socket = FakeWebSocket.instances[0];
    assert.equal(socket.sent.length, 0);
    socket.emit("message", { data: JSON.stringify({ code: 0, message: "success", voice_id: "test" }) });
    assert.equal(socket.sent.length, 2);
    assert.ok(Buffer.isBuffer(socket.sent[0]));
    assert.equal(socket.sent[1], JSON.stringify({ type: "end" }));
    const result = { SuggestedScore: 88, PronAccuracy: 86, PronFluency: .9, PronCompletion: 1 };
    socket.emit("message", { data: JSON.stringify({ code: 0, result }) });
    socket.emit("message", { data: JSON.stringify({ code: 0, final: 1 }) });
    assert.deepEqual(await assessment, result);
  } finally {
    globalThis.WebSocket = originalWebSocket;
    if (originalAppId === undefined) delete process.env.TENCENT_SOE_APP_ID; else process.env.TENCENT_SOE_APP_ID = originalAppId;
    if (originalSecretId === undefined) delete process.env.TENCENT_SECRET_ID; else process.env.TENCENT_SECRET_ID = originalSecretId;
    if (originalSecretKey === undefined) delete process.env.TENCENT_SECRET_KEY; else process.env.TENCENT_SECRET_KEY = originalSecretKey;
  }
});

test("main inline page scripts parse", () => {
  for (const filename of ["index.html", "core-words-cn.html", "speaking.html", "admin.html", "friends.html", "register.html", "login.html", "reset-password.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", "outputs", filename), "utf8");
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).filter(Boolean);
    assert.ok(scripts.length, `${filename} should contain an inline script`);
    for (const script of scripts) assert.doesNotThrow(() => new Function(script), `${filename} script should parse`);
  }
});

test("learning pages preload a small voice batch and fetch audio with the active session", () => {
  for (const filename of ["index.html", "core-words-cn.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", "outputs", filename), "utf8");
    assert.match(html, /credentials:\s*"same-origin"/);
    assert.match(html, /items\.slice\(0, 4\)/);
    assert.match(html, /contentType\.startsWith\("audio\/"\)/);
  }
});

test("learning pages delay automatic question speech and handle theme completion", () => {
  for (const filename of ["index.html", "core-words-cn.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", "outputs", filename), "utf8");
    assert.match(html, /AUTO_SPEAK_DELAY_MS\s*=\s*1500/);
    assert.match(html, /function showThemeComplete/);
    assert.match(html, /data\?\.completed/);
  }
});
