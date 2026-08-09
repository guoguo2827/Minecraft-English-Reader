"use strict";

const { db, sessionStore } = require("../server");

try {
  const result = db.pragma("integrity_check", { simple: true });
  if (result !== "ok") throw new Error(`Database integrity check failed: ${result}`);
  const migrations = db.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY applied_at").all();
  console.log(`Database ready. Applied migrations: ${migrations.length}`);
} finally {
  sessionStore.close();
  db.close();
}
