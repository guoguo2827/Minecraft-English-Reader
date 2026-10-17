"use strict";

// Compose the existing licensed icon system, without replacing pilot artwork.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { readLessons, root } = require("../lib/ket-editorial");
const dest = path.join(root, "outputs/ket-assets/expanded");
const sourceDir = path.join(dest, "sources");
const sourceBase = "https://raw.githubusercontent.com/twitter/twemoji/v14.0.2/assets/svg/";
const xml = text => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function captionLines(text, width = 53) {
  const lines = [""];
  for (const word of text.split(" ")) {
    if (lines.at(-1).length + word.length + 1 > width) lines.push(word);
    else lines[lines.length - 1] += (lines.at(-1) ? " " : "") + word;
  }
  assert.ok(lines.length <= 3, "Caption exceeds picture height");
  return lines;
}

function renderArt(word, lesson, sources) {
  const icons = lesson.picture.icons;
  const size = icons.length > 2 ? 104 : 144;
  const gap = 22;
  const left = (640 - icons.length * size - (icons.length - 1) * gap) / 2;
  // For spatial words, the placement must illustrate the relation, not just list symbols.
  const spatial = {
    above: [[0,256,8,128],[1,248,98,144]],
    over: [[0,276,2,88],[1,236,90,168]],
    under: [[1,256,15,128],[0,278,144,84]],
    below: [[0,260,2,120],[1,255,98,130]],
    top: [[1,245,65,150],[0,285,0,70]],
    bottom: [[1,247,20,145],[0,283,125,74]],
    behind: [[1,340,20,96],[0,235,62,155]]
  };
  const positions = spatial[word] || icons.map((_, i) => [i,left+i*(size+gap),(220-size)/2,size]);
  const artwork = positions.map(([i,x,y,width]) => {
    const code = icons[i];
    const source = sources.get(code);
    assert.ok(source, `Missing source ${code}`);
    return `<image x="${x}" y="${y}" width="${width}" height="${width}" href="data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}"/>`;
  }).join("");
  const caption = captionLines(lesson.example).map((line, i) => `<tspan x="320" y="${270 + i * 28}">${xml(line)}</tspan>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" role="img"><title>${xml(word)}</title><desc>${xml(lesson.translation)}</desc><metadata>Twemoji 14.0.2, Twitter and contributors, CC-BY-4.0. Composition and example by this project. Context aid, not quiz artwork.</metadata><rect width="640" height="360" fill="#d1e5d9"/><path d="M0 222H640V360H0Z" fill="#ffffff"/>${artwork}<text text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#193d36">${caption}</text></svg>\n`;
}

async function main() {
  const check = process.argv.includes("--check");
  const lessons = readLessons();
  const codes = [...new Set([...lessons.values()].flatMap(row => row.picture.icons))].sort();
  const sources = new Map();
  const localSource = process.argv.find(arg => arg.startsWith("--source-dir="))?.slice("--source-dir=".length);
  await fs.mkdir(sourceDir, { recursive: true });
  for (const code of codes) {
    const file = path.join(sourceDir, `${code}.svg`);
    let source;
    try { source = await fs.readFile(file, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT" || check) throw error;
      if (localSource) source = await fs.readFile(path.resolve(localSource, `${code}.svg`), "utf8");
      else {
        const response = await fetch(`${sourceBase}${code}.svg`, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`Artwork ${code}: HTTP ${response.status}`);
        source = await response.text();
      }
      assert.ok(source.includes("<svg") && !/<script|<foreignObject|https?:|onload=/i.test(source.replace(/xmlns="http:\/\/www.w3.org\/2000\/svg"/, "")), `Unsafe artwork: ${code}`);
      await fs.writeFile(file, source);
      console.log(`Source ${code}`);
    }
    sources.set(code, source);
  }
  const files = [];
  for (const [word, lesson] of lessons) {
    const name = `${lesson.art}.svg`;
    const svg = renderArt(word, lesson, sources);
    const file = path.join(dest, name);
    if (check) assert.equal(await fs.readFile(file, "utf8"), svg, `Stale image: ${word}`);
    else await fs.writeFile(file, svg);
    files.push({ word, file: name, sha256: digest(svg), sources: lesson.picture.icons });
  }
  const manifest = JSON.stringify({ version: 1, type: "context-collage", quizSafe: false,
    sourceBase, license: "CC-BY-4.0", exampleCount: lessons.size,
    sources: codes.map(code => ({ code, sha256: digest(sources.get(code)) })), files }, null, 2) + "\n";
  const file = path.join(dest, "manifest.json");
  if (check) assert.equal(await fs.readFile(file, "utf8"), manifest, "Stale artwork manifest");
  else await fs.writeFile(file, manifest);
  console.log(JSON.stringify({ pictures: files.length, sources: codes.length, checked: check }));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { renderArt, captionLines };
