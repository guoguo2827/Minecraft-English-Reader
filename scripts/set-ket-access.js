"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("dotenv");
const mode = process.argv[2];
if (!["full", "admin", "off"].includes(mode)) throw new Error("Usage: node scripts/set-ket-access.js full|admin|off");
const root = path.resolve(__dirname, ".."), file = path.join(root, ".env");
const text = fs.readFileSync(file, "utf8");
if (parse(text).KET_ACCESS === mode) {
  console.log(`KET_ACCESS=${mode} already configured; also update the PM2 environment.`);
} else {
  // Preserve unrelated secrets, comments and line endings; retain a private backup.
  const backups = path.join(root, "backups");
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const backup = path.join(backups, `env-ket-${Date.now()}.bak`);
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?KET_ACCESS\s*=/.test(line));
  const updated = lines.join(eol).replace(/\s*$/, "") + eol + `KET_ACCESS=${mode}` + eol;
  const before = parse(text), after = parse(updated);
  delete before.KET_ACCESS;
  delete after.KET_ACCESS;
  require("node:assert/strict").deepEqual(after, before);
  const temp = `${file}.ket-${process.pid}.tmp`;
  fs.writeFileSync(temp, updated, { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, file);
  console.log(`KET_ACCESS=${mode} configured; backup: ${path.relative(root, backup)}`);
}
