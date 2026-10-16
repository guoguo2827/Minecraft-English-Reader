"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { words } = require("../lib/ket-content");
async function main() {
  const dir = path.resolve(__dirname, "../outputs/ket-assets");
  await fs.mkdir(dir, { recursive: true });
  for (const art of new Set(words.map(w => w.art))) {
    const destination = path.join(dir, `${art}.png`);
    try { await fs.access(destination); continue; } catch {}
    const response = await fetch(`https://cdn.jsdelivr.net/gh/twitter/twemoji@v14.0.2/assets/72x72/${art}.png`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`${art}: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.subarray(1, 4).toString() !== "PNG") throw new Error(`Invalid PNG: ${art}`);
    await fs.writeFile(destination, data);
    console.log(`Downloaded ${art}`);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
