"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const published = require("../lib/ket-content");
const additions = require("../content/ket1500-units.json");
const { buildCatalog, artifacts } = require("../scripts/build-ket-catalog");
const { readLessons } = require("../lib/ket-editorial");
const { renderArt, captionLines } = require("../scripts/build-ket-lesson-art");
const crypto = require("node:crypto");

test("KET1500 vocabulary has 1500 unique entries in 150 ten-word units", () => {
  const catalog = buildCatalog();
  assert.equal(catalog.total, 1500);
  assert.equal(catalog.unitCount, 150);
  assert.equal(catalog.publishedCount, 100);
  assert.equal(catalog.draftCount, 1400);
  assert.ok(catalog.phraseCount > 0);
  assert.equal(catalog.units.at(-1).words.at(-1).word, "look up");
});

test("editorial snapshot preserves the original pilot and independent review flags", () => {
  const before = JSON.stringify(published);
  const catalog = buildCatalog();
  assert.equal(JSON.stringify(published), before);
  assert.equal(published.words.length, 100);
  for (const word of catalog.units.flatMap(unit => unit.words).slice(100)) {
    assert.equal(word.published, false);
    assert.equal(word.reviewStatus, "content-draft");
    assert.equal(word.officialListVerified, false);
    assert.equal(word.releaseReady, false);
    for (const field of ["example", "translation", "image"]) assert.ok(word[field]);
    assert.equal(word.picture.quizSafe, false);
    assert.equal(word.picture.type, "context-collage");
  }
});

test("all 1400 new lessons have original unique short examples and real local artwork", () => {
  const lessons = readLessons();
  const manifest = require("../outputs/ket-assets/expanded/manifest.json");
  const words = additions.flatMap(unit => unit[2].map(row => row[0]));
  assert.equal(lessons.size, 1400);
  assert.deepEqual([...lessons.keys()].sort(), [...words].sort());
  assert.equal(new Set([...lessons.values()].map(row => row.example)).size, 1400);
  assert.equal(manifest.files.length, 1400);
  const sources = new Map(manifest.sources.map(({code, sha256}) => {
    const bytes = fs.readFileSync(path.join(__dirname, "../outputs/ket-assets/expanded/sources", code + ".svg"));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), sha256);
    return [code, bytes.toString("utf8")];
  }));
  for (const item of manifest.files) {
    const lesson = lessons.get(item.word);
    assert.ok(lesson, item.word);
    assert.ok(lesson.example.toLowerCase().includes(item.word.toLowerCase()), item.word);
    assert.ok(lesson.example.split(/\s+/).length <= 18, item.word);
    assert.match(lesson.translation, /[\u3400-\u9fff]/);
    const bytes = fs.readFileSync(path.join(__dirname, "../outputs/ket-assets/expanded", item.file));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), item.sha256, item.word);
    assert.equal(bytes.toString("utf8"), renderArt(item.word, lesson, sources));
    assert.ok(!/<script|<foreignObject/i.test(bytes.toString("utf8")));
    assert.equal(lesson.picture.quizSafe, false);
  }
});

test("missing examples are rejected and captions do not overflow fixed artwork", () => {
  const lessons = readLessons();
  lessons.delete("family");
  assert.throws(() => buildCatalog(published, additions, lessons), /Lesson count/);
  assert.ok(captionLines("A short example.").length === 1);
  assert.throws(() => captionLines("word ".repeat(100)), /height/);
});

test("aliases cannot count as another headword and duplicate IDs fail validation", () => {
  const groups = structuredClone(additions);
  groups[0][2][0][0] = "bike";
  assert.throws(() => buildCatalog(published, groups), /Duplicate headword\/variant/);
  groups[0][2][0][0] = "apple";
  assert.throws(() => buildCatalog(published, groups), /Duplicate word ID/);
});

test("missing entries, empty Chinese and malformed units fail validation", () => {
  const groups = structuredClone(additions);
  groups[0][2].pop();
  assert.throws(() => buildCatalog(published, groups), /Expected 1500/);
  const missingMeaning = structuredClone(additions);
  missingMeaning[0][2][0][2] = "";
  assert.throws(() => buildCatalog(published, missingMeaning), /Missing editorial fields/);
  const renumbered = structuredClone(additions);
  renumbered[0][0] = "changed";
  assert.throws(() => buildCatalog(published, renumbered), /sequential/);
});

test("checked-in vocabulary exports are deterministic and current", () => {
  const catalog = buildCatalog();
  for (const [name, content] of artifacts(catalog)) {
    assert.equal(fs.readFileSync(path.join(__dirname, "../docs/ket1500", name), "utf8"), content, name);
  }
});
