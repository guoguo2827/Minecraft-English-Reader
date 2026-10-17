"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const published = require("../lib/ket-content");
const additions = require("../content/ket1500-units.json");
const { readLessons, root } = require("../lib/ket-editorial");
const { renderReview } = require("./ket-review-page");
const out = path.resolve(__dirname, "../docs/ket1500");
const sourceUrl = "https://www.cambridgeenglish.org/images/506886-a2-key-2020-vocabulary-list.pdf";
const identity = text => text.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
const wordId = word => `ket-${word.toLowerCase().replace(/[^a-z]+/g, "-")}`;

function buildCatalog(base = published, draftGroups = additions, lessons = readLessons()) {
  const units = base.units.map(unit => ({
    id: unit.id, number: unit.number, title: unit.title,
    words: unit.words.map(word => ({ ...word,
      published: true, reviewStatus: "existing-pilot", officialListVerified: false,
      releaseReady: false, pendingReview: ["teacher", "picture-meaning", "live-audio"]
    }))
  }));
  draftGroups.forEach(([id, title, rows], index) => {
    assert.equal(id, `ket-u${String(index + 11).padStart(3, "0")}`, "New unit IDs must remain sequential");
    units.push({ id, number: index + 11, title, words: rows.map(row => {
      assert.ok(row.length === 3 || row.length === 4, `Invalid row in ${id}`);
      const [word, pos, meaning, variants = []] = row;
      const lesson = lessons.get(word);
      return { id: wordId(word), unitId: id, word, meaning, pos,
        example: null, translation: null, image: null, art: null,
        ...lesson,
        kind: word.includes(" ") ? "phrase" : "word", version: 1, variants,
        published: false, reviewStatus: "content-draft", officialListVerified: false,
        releaseReady: false,
        pendingReview: ["teacher", "official-list-scope", "example-language", "translation-accuracy", "picture-meaning", "live-audio",
          ...(/[A-Z]{2,}/.test(word) ? ["abbreviation-pronunciation"] : []),
          ...(word === "May" ? ["capitalisation-and-sense"] : [])]
      };
    }) });
  });
  const words = units.flatMap(unit => unit.words);
  assert.equal(units.length, 150, "Expected 150 units");
  assert.equal(words.length, 1500, "Expected 1500 entries");
  const ids = new Set(), unitIds = new Set(), spellings = new Map();
  for (const [index, unit] of units.entries()) {
    assert.equal(unit.number, index + 1);
    assert.ok(unit.title && !unitIds.has(unit.id), `Invalid/duplicate unit: ${unit.id}`);
    unitIds.add(unit.id);
    assert.equal(unit.words.length, 10, `${unit.id} must contain ten entries`);
    for (const word of unit.words) {
      assert.equal(word.unitId, unit.id);
      assert.ok(!ids.has(word.id), `Duplicate word ID: ${word.id}`);
      ids.add(word.id);
      assert.ok(/^[A-Za-z][A-Za-z '\-]*$/.test(word.word), `Invalid headword: ${word.word}`);
      assert.ok(word.pos && /[\u3400-\u9fff]/.test(word.meaning), `Missing editorial fields: ${word.id}`);
      assert.ok(word.word.length <= 80, `TTS length exceeded: ${word.id}`);
      assert.ok(Array.isArray(word.variants), `Variants must be an array: ${word.id}`);
      const local = new Set();
      for (const spelling of [word.word, ...word.variants]) {
        assert.equal(typeof spelling, "string");
        assert.ok(spelling.trim() && spelling === spelling.trim(), `Invalid spelling: ${word.id}`);
        const key = identity(spelling);
        assert.ok(!local.has(spelling.toLowerCase()), `Repeated alias: ${spelling}`);
        local.add(spelling.toLowerCase());
        assert.ok(!spellings.has(key) || spellings.get(key) === word.id,
          `Duplicate headword/variant: ${spelling} (${word.id}, ${spellings.get(key)})`);
        spellings.set(key, word.id);
      }
      assert.equal(word.releaseReady, false, "Editorial verification cannot be auto-approved");
    }
  }
  const newWords = words.filter(word => !word.published);
  assert.equal(lessons.size, newWords.length, "Lesson count must match draft words");
  const sentences = new Set();
  for (const word of newWords) {
    assert.ok(lessons.has(word.word), `Missing lesson: ${word.id}`);
    assert.ok(word.example && word.translation && word.image && word.art, `Incomplete lesson: ${word.id}`);
    assert.ok(!sentences.has(word.example), `Duplicate example: ${word.id}`);
    sentences.add(word.example);
    assert.equal(word.picture.quizSafe, false, "Unreviewed captioned art must not enter quizzes");
    assert.equal(word.image, `/ket-assets/expanded/${word.id}.svg`);
    assert.ok(fs.existsSync(path.join(root, "outputs", word.image)), `Missing picture file: ${word.id}`);
  }
  for (const word of base.words) {
    const retained = words.find(item => item.id === word.id);
    for (const [key, value] of Object.entries(word)) assert.deepEqual(retained[key], value, `Pilot field changed: ${word.id}.${key}`);
  }
  return { schemaVersion: 2, version: "ket1500-content-draft-v2", target: 1500,
    total: words.length, unitCount: units.length, publishedCount: base.words.length,
    draftCount: words.length - base.words.length,
    phraseCount: words.filter(word => word.kind === "phrase").length,
    note: "项目自编学习词表，非剑桥官方固定1500词。例句、翻译与情境联想配图初稿已补齐；未经教师、图义和语音审核，不自动发布。",
    source: { title: "Cambridge A2 Key / A2 Key for Schools vocabulary list, August 2025", url: sourceUrl,
      use: "Scope reference only; original selection, grouping and Chinese glosses; no official endorsement or exhaustive coverage claim." },
    units };
}

const cell = value => String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
function renderMarkdown(catalog) {
  const lines = ["# KET1500 完整分组词表", "",
    `共 **${catalog.total} 条**，**${catalog.unitCount} 个单元**，每单元 **10 条**。包含 ${catalog.phraseCount} 条多词表达，其余为单词；拼写或等价形式不另外计数。`, "",
    `现有课程：${catalog.publishedCount} 条；新增内容初稿：${catalog.draftCount} 条。**新增例句、翻译和情境联想图已齐备，尚需教师、图义与真实语音审核，未自动上线。**`, "",
    "中文为学习核心义，不是完整词典释义。词性：n. 名词，v. 动词，adj. 形容词，adv. 副词，pron. 代词，det. 限定词，prep. 介词，conj. 连词，num. 数词，modal 情态动词，aux. 助动词，exclam. 感叹词，phr.v. 短语动词，prep.phr. 介词短语，phrase 常用表达。", "",
    `[词库说明与发布要求](README.md) · [JSON数据](catalog.json) · [剑桥范围参考](${sourceUrl})`, "", "## 单元目录", ""];
  for (const unit of catalog.units) lines.push(`- [${String(unit.number).padStart(3, "0")} ${unit.title}](#unit-${unit.number})`);
  let number = 0;
  for (const unit of catalog.units) {
    lines.push("", `<a id="unit-${unit.number}"></a>`, "", `## ${String(unit.number).padStart(3, "0")} ${unit.title}`, "",
      unit.words.every(word => word.published) ? "状态：现有100词课程内容，保留原编号。" : "状态：例句、翻译与情境联想图初稿完整；图文和发布审核待完成。", "",
      "| 序号 | 英文 | 词性 | 中文核心义 | 变体或等价形式 | 例句 | 翻译 | 配图 |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const word of unit.words) lines.push(`| ${++number} | ${cell(word.word)} | ${cell(word.pos)} | ${cell(word.meaning)} | ${cell(word.variants.join(", ")) || "-"} | ${cell(word.example)} | ${cell(word.translation)} | [查看](../../outputs${word.image}) |`);
  }
  return lines.join("\n") + "\n";
}

function artifacts(catalog) {
  return new Map([
    ["catalog.json", JSON.stringify(catalog, null, 2) + "\n"],
    ["units.md", renderMarkdown(catalog)],
    ["review.html", renderReview(catalog)],
    ["validation.json", JSON.stringify({ version: catalog.version, total: catalog.total,
      units: catalog.unitCount, published: catalog.publishedCount, draft: catalog.draftCount,
      phrases: catalog.phraseCount, uniqueIds: true, uniqueHeadwordsAndAliases: true,
      allUnitsHaveTenEntries: true, original100Unchanged: true,
      newEntriesHavePosAndChinese: true, officialListVerificationComplete: false,
      newExampleAndArtworkCoverage: catalog.draftCount, teacherReviewComplete: false,
      newArtworkType: "captioned-context-collage", newArtworkQuizSafe: false,
      runtimeCatalogChanged: false }, null, 2) + "\n"]
  ]);
}

if (require.main === module) {
  const catalog = buildCatalog();
  fs.mkdirSync(out, { recursive: true });
  for (const [name, content] of artifacts(catalog)) {
    const file = path.join(out, name);
    if (process.argv.includes("--check")) assert.equal(fs.readFileSync(file, "utf8"), content, `Regenerate ${name}`);
    else fs.writeFileSync(file, content, "utf8");
  }
  console.log(JSON.stringify({ total: catalog.total, units: catalog.unitCount, published: catalog.publishedCount, draft: catalog.draftCount, phrases: catalog.phraseCount }));
}
module.exports = { buildCatalog, artifacts, renderMarkdown };
