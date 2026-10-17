"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const dir = path.join(root, "content/ket1500-lessons");

function readLessons() {
  const lessons = new Map();
  for (const file of fs.readdirSync(dir).filter(name => /^\d{3}-\d{3}\.json$/.test(name)).sort()) {
    for (const row of JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))) {
      assert.equal(row.length, 4, `Invalid lesson in ${file}`);
      const [word, example, translation, codes] = row;
      assert.ok(!lessons.has(word), `Duplicate lesson: ${word}`);
      assert.ok(typeof example === "string" && /^[A-Z]/.test(example) && /[.!?]$/.test(example), `Invalid example: ${word}`);
      assert.ok(example.length <= 200 && !/[\u3400-\u9fff]/.test(example), `Invalid TTS example: ${word}`);
      assert.ok(typeof translation === "string" && /[\u3400-\u9fff]/.test(translation), `Missing translation: ${word}`);
      assert.ok(typeof codes === "string" && /^[a-f0-9]+(?:-[a-f0-9]+)*(?: [a-f0-9]+(?:-[a-f0-9]+)*){0,3}$/.test(codes), `Invalid art recipe: ${word}`);
      const id = `ket-${word.toLowerCase().replace(/[^a-z]+/g, "-")}`;
      lessons.set(word, { example, translation,
        image: `/ket-assets/expanded/${id}.svg`, art: id,
        picture: { type: "context-collage", icons: codes.split(" "),
          alt: translation, quizSafe: false, reviewStatus: "pending-visual-review",
          source: "Twemoji 14.0.2", license: "CC-BY-4.0",
          note: "情境联想辅助图，不是每个词的独立写实图；不可直接用作听音选图的唯一判分依据。" }
      });
    }
  }
  return lessons;
}

module.exports = { readLessons, root };
