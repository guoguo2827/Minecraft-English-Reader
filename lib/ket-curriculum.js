"use strict";
const assert = require("node:assert/strict");
const pilot = require("./ket-content");
const groups = require("../content/ket1500-units.json");
const { readLessons } = require("./ket-editorial");
const lessons = readLessons();

// Keep pilot IDs and fields intact so existing sessions and progress remain valid.
const units = [...pilot.units, ...groups.map(([id, title, rows], index) => ({
  id, title, number: index + 11,
  words: rows.map(([word, pos, meaning, variants = []]) => {
    const lesson = lessons.get(word);
    assert.ok(lesson, `Missing KET lesson: ${word}`);
    return {
      id: `ket-${word.toLowerCase().replace(/[^a-z]+/g, "-")}`,
      unitId: id, word, pos, meaning, variants,
      example: lesson.example, translation: lesson.translation,
      image: lesson.image, art: lesson.art,
      picture: { type: lesson.picture.type, quizSafe: false },
      kind: word.includes(" ") ? "phrase" : "word", version: 1
    };
  })
}))];
const words = units.flatMap(unit => unit.words);
assert.equal(units.length, 150);
assert.equal(words.length, 1500);
assert.equal(new Set(words.map(word => word.id)).size, 1500);
module.exports = { units, words, byId: new Map(words.map(word => [word.id, word])),
  version: "ket1500-v1", target: 1500 };
