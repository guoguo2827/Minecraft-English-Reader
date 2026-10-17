"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { chromium } = require("@playwright/test");
const { readLessons, root } = require("../lib/ket-editorial");
const { captionLines } = require("./build-ket-lesson-art");
const out = path.join(root, "work/ket-qa");

async function main() {
  await fs.mkdir(out, { recursive: true });
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (!pathname.startsWith("/docs/ket1500/") && !pathname.startsWith("/outputs/ket-assets/")) {
        res.writeHead(404).end(); return;
      }
      const file = path.resolve(root, "." + pathname);
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const types = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
      const bytes = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "text/plain" }).end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    for (const [width, height] of [[320,568],[390,844],[1280,900]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/docs/ket1500/review.html#ket-u011`);
      await page.locator(".word").first().waitFor();
      await page.locator(".word img").evaluateAll(async imgs => {
        for (const img of imgs) { img.loading = "eager"; await img.decode(); }
      });
      assert.equal(await page.locator(".word").count(), 10);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Page overflow at ${width}`);
      assert.deepEqual(await page.locator(".copy p,.copy h2").evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent)), []);
      await page.screenshot({ path: path.join(out, `catalog-review-${width}.png`), fullPage: true });
      await page.screenshot({ path: path.join(out, `catalog-review-viewport-${width}.png`) });
      await page.locator("#nextUnit").click();
      await page.waitForFunction(() => document.querySelector("#unit").value === "ket-u012");
      await page.locator("#search").fill("raincoat");
      assert.equal(await page.locator('[data-word="raincoat"]').count(), 1);
      await page.locator("#search").fill("no-such-word-9999");
      assert.equal(await page.locator("#empty").isVisible(), true);
      await page.locator("#search").fill("");
      assert.equal(await page.locator(".word").count(), 18);
      await page.locator("#nextPage").click();
      assert.equal(await page.locator("#page").textContent(), "2 / 84");
    }
    const assets = [...readLessons()].map(([word, row]) => ({ word, url: `/outputs${row.image}`, lines: captionLines(row.example) }));
    const result = await page.evaluate(async assets => {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const failed = []; let checked = 0;
      for (const asset of assets) {
        try {
          const img = new Image(); img.src = asset.url; await img.decode();
          if (img.naturalWidth !== 640 || img.naturalHeight !== 360) throw Error("dimensions");
          ctx.clearRect(0,0,160,90); ctx.drawImage(img,0,0,160,90);
          const data = ctx.getImageData(0,0,160,55).data;
          let nonBackground = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (Math.max(Math.abs(data[i]-data[0]),Math.abs(data[i+1]-data[1]),Math.abs(data[i+2]-data[2])) > 14) nonBackground++;
          }
          if (nonBackground < 45) throw Error("blank icon region");
          ctx.font = "22px Arial";
          if (asset.lines.some(line => ctx.measureText(line).width > 600)) throw Error("caption overflow");
          checked++;
        } catch (e) { failed.push({ word: asset.word, error: e.message }); }
      }
      return { checked, failed };
    }, assets);
    assert.deepEqual(result.failed, []);
    assert.equal(result.checked, 1400);
    assert.deepEqual(errors, []);
    const report = { ...result, viewports: [[320,568],[390,844],[1280,900]], scope: "File loading, layout, nonblank image region and caption bounds; NOT semantic or teacher approval." };
    await fs.writeFile(path.join(out, "catalog-review-check.json"), JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
