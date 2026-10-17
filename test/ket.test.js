"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { createKetService, migrateKet, accessError, dayKey } = require("../lib/ket-service");
const C = require("../lib/ket-content");
const curriculum = require("../lib/ket-curriculum");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ket-tests-"));
Object.assign(process.env, { NODE_ENV: "test", DATABASE_PATH: path.join(dir, "app.db"), SESSION_DATABASE_PATH: path.join(dir, "sessions.db"),
  COOKIE_SECURE: "false", SESSION_SECRET: "ket-test-only-secret", ACCESS_CONTROL_ENFORCED: "true", KET_ACCESS: "full",
  ADMIN_USERNAME: "ket-admin", ADMIN_PHONE: "13840000000", ADMIN_PASSWORD: "KetTest123" });
const { app, db, sessionStore } = require("../server");
let at = new Date("2026-10-01T01:00:00Z"), server, base, index = 0;
const service = createKetService({ db, clock: () => at });
test.before(async () => { await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(resolve => server.close(resolve)); sessionStore.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function user(overrides = {}) {
  const phone = `1394000${String(++index).padStart(4, "0")}`;
  const id = Number(db.prepare("INSERT INTO users(username,phone,password_hash,nickname,access_tier,primary_course,created_at) VALUES (?,?,?,'KET','founder_trial','english',?)")
    .run(phone, phone, bcrypt.hashSync("KetTest123", 4), at.toISOString()).lastInsertRowid);
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  return { ...u, ...overrides };
}
function expose(u, s) { if (s.question.needsExposure) service.expose(u, s.question.wordId); return service.session(u, s.id); }
function finish(u, initial) {
  let s = initial;
  for (let i = 0; !s.completed && i < 80; i++) {
    s = expose(u, s);
    service.answer(u, { sessionId: s.id, questionId: s.question.id, selected: s.question.wordId });
    s = service.next(u, { sessionId: s.id, questionId: s.question.id });
  }
  assert.equal(s.completed, true); return s;
}
function counts(u) { return ["word_progress", "review_queue", "reward_events", "user_rewards", "study_sessions"].map(t => db.prepare(`SELECT count(*) AS n FROM ${t} WHERE user_id=?`).get(u.id).n); }
async function login(u) {
  const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: u.phone, password: "KetTest123" }) });
  assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0];
}
async function api(cookie, route, body) {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie || "", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
test("pilot content has 100 unique stable IDs, ten units, meaningful fields and local licensed PNGs", () => {
  assert.equal(C.words.length, 100); assert.equal(C.units.length, 10);
  assert.equal(new Set(C.words.map(w => w.id)).size, 100);
  assert.equal(new Set(C.words.map(w => w.word.toLowerCase())).size, 100);
  for (const unit of C.units) assert.equal(unit.words.length, 10);
  for (const w of C.words) {
    assert.ok(w.meaning && w.example && w.translation && w.pos);
    assert.ok(w.example.split(/\s+/).length < 20);
    const png = fs.readFileSync(path.join(__dirname, "../outputs", w.image));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
  }
});
test("migration is additive, repeatable and preserves business rows", () => {
  const tables = ["users", "word_progress", "reward_events", "speaking_attempts"];
  const sizes = () => tables.map(t => db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n);
  const before = sizes(); migrateKet(db); migrateKet(db); assert.deepEqual(sizes(), before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version='2026-10-16-ket-pilot-v1'").get().n, 1);
});

test("full curriculum retains pilot IDs and grants existing English clients 1500 words", async () => {
  assert.equal(curriculum.words.length, 1500);
  assert.equal(curriculum.units.length, 150);
  assert.deepEqual(curriculum.words.slice(0, 100), C.words);
  const u = user(), cookie = await login(u);
  const response = await api(cookie, "/api/ket/catalog");
  assert.equal(response.status, 200);
  assert.equal(response.data.published, 1500);
  assert.equal(response.data.units.filter(unit => !unit.locked).length, 150);
  assert.equal(service.report(u).published, 1500);
  const trial = { ...u, access_tier: "free_trial", trial_expires_at: "2099-01-01" };
  assert.equal(service.catalog(trial).units.filter(unit => !unit.locked).length, 2);
  assert.throws(() => service.start(trial, { mode: "free", unitId: "ket-u150" }), /完整英语/);
});

test("expanded unit practice omits captioned artwork from all quiz options and resumes normally", () => {
  const u = user(), before = counts(u);
  let s = service.start(u, { mode: "free", unitId: "ket-u150" });
  const id = s.id;
  for (let i = 0; i < 10; i++) {
    assert.equal(s.completed, false);
    assert.equal(s.question.options.length, 4);
    assert.ok(s.question.options.every(option => option.image === null && option.meaning));
    const result = service.answer(u, { sessionId: id, questionId: s.question.id, selected: s.question.wordId });
    assert.ok(result.word.image.endsWith(".svg"));
    assert.equal(result.word.picture.quizSafe, false);
    assert.equal(service.session(u, id).answer.correct, true);
    s = service.next(u, { sessionId: id, questionId: s.question.id });
  }
  assert.equal(s.completed, true);
  assert.deepEqual(counts(u), before);
});
test("access checks do not inherit legacy permissive mode", () => {
  const u = user();
  assert.equal(accessError(u, "full", at), null);
  for (const update of [{ status: "disabled" }, { primary_course: "chinese" }, { password_reset_required: 1 }, { access_tier: "free_trial", trial_expires_at: "2020-01-01" }]) {
    assert.ok(accessError({ ...u, ...update }, "full", at));
  }
  assert.equal(accessError({ ...u, role: "admin" }, "admin", at), null);
  assert.equal(accessError({ ...u, role: "admin" }, "off", at).code, "KET_UNAVAILABLE");
  assert.equal(accessError(u, "admin", at).code, "KET_PREVIEW");
  const trial = { ...u, access_tier: "free_trial", trial_expires_at: "2099-01-01" };
  assert.equal(service.catalog(trial).units.filter(u => !u.locked).length, 2);
  assert.throws(() => service.start(trial, { mode: "free", unitId: "food" }), /完整英语/);
  assert.throws(() => service.checkWord(trial, C.units[2].words[0].id), /完整英语/);
});
test("browsing records contact without mastery and still permits formal study", () => {
  const u = user(); service.expose(u, C.words[0].id);
  assert.equal(service.report(u).learned, 1); assert.equal(service.report(u).mastered, 0);
  assert.equal(service.report(u).newToday, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM ket_skills WHERE user_id=?").get(u.id).n, 0);
  const s = service.start(u); assert.equal(s.question.wordId, C.words[0].id); assert.equal(s.question.needsExposure, false);
  finish(u, s); assert.equal(service.report(u).mastered, 0);
});
test("session resume, idempotent answers, stale next and cross-user isolation", () => {
  const u = user(), other = user(); let s = service.start(u);
  assert.equal(service.start(u).id, s.id);
  assert.equal(service.session(u, s.id).question.id, s.question.id);
  assert.throws(() => service.session(other, s.id), /没有找到/);
  const body = { sessionId: s.id, questionId: s.question.id, selected: s.question.wordId };
  assert.throws(() => service.answer(u, body), /先认识/);
  s = expose(u, s);
  const first = service.answer(u, body), duplicate = service.answer(u, body);
  assert.equal(first.correct, true); assert.equal(duplicate.duplicate, true);
  assert.equal(service.report(u).firstAnswers, 1);
  assert.throws(() => service.answer(u, { ...body, selected: s.question.options.find(o => o.id !== body.selected).id }), /已经提交/);
  const next = service.next(u, body); assert.notEqual(next.question.id, s.question.id);
  assert.equal(service.next(u, body).question.id, next.question.id);
  assert.throws(() => service.answer(other, body), /没有找到/);
  assert.equal(service.session(u, s.id).question.id, next.question.id);
});
test("wrong answers retry after three intervening questions and do not rewrite first-answer statistics", () => {
  const u = user(); let s = expose(u, service.start(u)); const firstId = s.question.wordId;
  const wrong = s.question.options.find(o => o.id !== firstId).id;
  service.answer(u, { sessionId: s.id, questionId: s.question.id, selected: wrong });
  const queue = JSON.parse(db.prepare("SELECT queue_json FROM ket_sessions WHERE id=?").get(s.id).queue_json);
  assert.equal(queue[4].wordId, firstId); assert.equal(queue[4].retry, true);
  assert.equal(service.session(u, s.id).answer.correct, false);
  s = service.next(u, { sessionId: s.id, questionId: s.question.id });
  const done = finish(u, s);
  assert.equal(done.summary.firstTotal, 10); assert.equal(done.summary.firstCorrect, 9);
  assert.equal(done.summary.attempts, 11); assert.equal(service.report(u).accuracy, 90);
  const rec = db.prepare("SELECT * FROM ket_skills WHERE user_id=? AND word_id=? AND skill='recognize'").get(u.id, firstId);
  assert.deepEqual(JSON.parse(rec.success_days), []);
});
test("free practice never changes schedules, mastery, original rewards or course statistics", () => {
  const u = user(); finish(u, service.start(u));
  const before = db.prepare("SELECT * FROM ket_skills WHERE user_id=? ORDER BY word_id,skill").all(u.id);
  const business = counts(u), report = service.report(u);
  const s = service.start(u, { mode: "free", unitId: "fruit" }); finish(u, s);
  assert.deepEqual(db.prepare("SELECT * FROM ket_skills WHERE user_id=? ORDER BY word_id,skill").all(u.id), before);
  assert.deepEqual(counts(u), business); assert.equal(service.report(u).firstAnswers, report.firstAnswers);
  assert.equal(service.report(u).freeAnswers, 10);
  assert.notEqual(service.start(u, { mode: "free", unitId: "fruit" }).id, s.id);
});
test("daily settings, exhausted new-word budget and Shanghai midnight", () => {
  at = new Date("2026-10-01T15:59:59Z"); const u = user(); finish(u, service.start(u));
  assert.equal(service.start(u).empty, true);
  assert.equal(service.report(u).newToday, 5); assert.equal(service.report(u).mastered, 0);
  assert.throws(() => service.settings(u, 100), /请选择/);
  service.settings(u, 10); finish(u, service.start(u)); assert.equal(service.report(u).newToday, 10);
  at = new Date("2026-10-01T16:00:01Z"); assert.equal(dayKey(at), "2026-10-02"); assert.equal(service.report(u).newToday, 0);
});
test("mastery needs two skills across three dates and seven elapsed days; later failure needs consolidation", () => {
  at = new Date("2026-10-01T01:00:00Z"); const u = user(); finish(u, service.start(u));
  const forceDue = () => db.prepare("UPDATE ket_skills SET due=? WHERE user_id=?").run(at.toISOString(), u.id);
  at = new Date("2026-10-02T01:00:00Z"); forceDue(); finish(u, service.start(u)); assert.equal(service.report(u).mastered, 0);
  at = new Date("2026-10-08T01:00:01Z"); forceDue(); finish(u, service.start(u));
  assert.equal(service.report(u).mastered, 5); assert.equal(service.report(u).everMastered, 5);
  at = new Date("2026-10-09T01:00:00Z"); forceDue(); const s = service.start(u);
  service.answer(u, { sessionId: s.id, questionId: s.question.id, reveal: true });
  assert.equal(service.report(u).mastered, 4); assert.equal(service.report(u).everMastered, 5);
  assert.equal(service.catalog(u).units[0].words.find(w => w.id === s.question.wordId).status, "strengthen");
});
test("due reviews come before new words; listening payload conceals answer text", () => {
  at = new Date("2026-10-01T01:00:00Z"); const u = user(); finish(u, service.start(u));
  at = new Date("2026-11-01T01:00:00Z"); let s = service.start(u);
  assert.equal(service.report(u).newToday, 0);
  while (!s.completed && s.question.skill !== "listen") {
    service.answer(u, { sessionId: s.id, questionId: s.question.id, selected: s.question.wordId });
    s = service.next(u, { sessionId: s.id, questionId: s.question.id });
  }
  assert.equal(s.question.skill, "listen"); assert.equal(s.question.word, null); assert.equal(s.question.exposure, null);
});
test("passage of time cannot silently award mastery without a delayed successful check", () => {
  at = new Date("2026-10-01T01:00:00Z"); const u = user(); finish(u, service.start(u));
  for (const date of ["2026-10-02T01:00:00Z", "2026-10-03T01:00:00Z"]) {
    at = new Date(date); db.prepare("UPDATE ket_skills SET due=? WHERE user_id=?").run(date, u.id); finish(u, service.start(u));
  }
  at = new Date("2026-10-15T01:00:00Z");
  assert.equal(service.report(u).mastered, 0); assert.equal(service.report(u).everMastered, 0);
});
test("HTTP endpoints enforce auth, ownership, trial limits, feature switch and admin protection", async () => {
  const u = user(), other = user(), cookie = await login(u), otherCookie = await login(other);
  assert.equal((await api("", "/api/ket/report")).status, 401);
  assert.equal((await api(cookie, "/api/admin/ket-summary")).status, 403);
  const started = await api(cookie, "/api/ket/sessions", {}); assert.equal(started.status, 200);
  assert.equal((await api(otherCookie, `/api/ket/sessions/${started.data.id}`)).status, 404);
  assert.equal((await api(cookie, "/api/ket/audio/arbitrary-text")).status, 404);
  db.prepare("UPDATE users SET access_tier='free_trial',trial_expires_at='2099-01-01' WHERE id=?").run(u.id);
  assert.equal((await api(cookie, "/api/ket/audio/ket-bread")).status, 403);
  process.env.KET_ACCESS = "off"; assert.equal((await api(cookie, "/api/ket/report")).status, 403); process.env.KET_ACCESS = "full";
  db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(u.id); assert.equal((await api(cookie, "/api/ket/report")).status, 403);
  const page = await fetch(`${base}/ket`, { redirect: "manual" }); assert.equal(page.status, 302); assert.equal(page.headers.get("location"), "/login?next=%2Fket");
});
test("admin data excludes administrators and preserves disabled learners", () => {
  const u = user(); finish(u, service.start(u)); db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(u.id);
  const data = service.adminSummary({ phone: u.phone }); assert.equal(data.users.length, 1); assert.equal(data.users[0].learned, 5);
  assert.ok(data.users[0].recent.length === 30); assert.ok(data.learners > 0);
});
