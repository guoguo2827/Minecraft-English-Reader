"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const session = require("express-session");
const createStore = require("../lib/sqlite-session-store");

function call(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

test("SQLite session survives store restart and expires cleanly", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mer-session-"));
  const databasePath = path.join(directory, "sessions.db");
  const Store = createStore(session);
  const first = new Store({ path: databasePath, cleanupIntervalMs: 60_000 });
  await call(first, "set", "session-a", { userId: 42, cookie: { expires: new Date(Date.now() + 60_000) } });
  first.close();

  const second = new Store({ path: databasePath, cleanupIntervalMs: 60_000 });
  const restored = await call(second, "get", "session-a");
  assert.equal(restored.userId, 42);
  await call(second, "destroy", "session-a");
  assert.equal(await call(second, "get", "session-a"), null);
  second.close();
});
