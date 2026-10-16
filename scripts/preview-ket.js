"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dir = path.resolve(__dirname, "../work/ket-preview");
fs.mkdirSync(dir, { recursive: true });
const accountPath = path.join(dir, "account.json");
const account = fs.existsSync(accountPath) ? JSON.parse(fs.readFileSync(accountPath, "utf8")) : { phone: "13860000000", password: String(crypto.randomInt(10000000, 99999999)) };
fs.writeFileSync(accountPath, JSON.stringify(account));
Object.assign(process.env, { NODE_ENV: "development", DATABASE_PATH: path.join(dir, "app.db"), SESSION_DATABASE_PATH: path.join(dir, "sessions.db"),
  COOKIE_SECURE: "false", SESSION_SECRET: "local-ket-preview-only-not-production", ADMIN_USERNAME: "ket-preview", ADMIN_PHONE: account.phone,
  ADMIN_PASSWORD: account.password, KET_ACCESS: "full", PUBLIC_APP_URL: "http://127.0.0.1:3010" });
const { app, db, sessionStore } = require("../server");
const server = app.listen(3010, "127.0.0.1", () => {
  console.log("KET preview: http://127.0.0.1:3010/ket");
  console.log(`Local-only login: ${account.phone} / ${account.password}`);
});
const close = () => server.close(() => { sessionStore.close(); db.close(); process.exit(0); });
process.on("SIGINT", close); process.on("SIGTERM", close);
