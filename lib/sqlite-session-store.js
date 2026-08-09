"use strict";

const Database = require("better-sqlite3");

module.exports = function createSqliteSessionStore(session) {
  return class SqliteSessionStore extends session.Store {
    constructor(options = {}) {
      super();
      this.db = options.client || new Database(options.path);
      this.defaultTtlMs = options.defaultTtlMs || 14 * 24 * 60 * 60 * 1000;
      this.cleanupIntervalMs = options.cleanupIntervalMs || 15 * 60 * 1000;
      this.db.pragma("journal_mode = WAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
      `);
      this.getStatement = this.db.prepare("SELECT sess, expires_at FROM sessions WHERE sid = ?");
      this.setStatement = this.db.prepare(`
        INSERT INTO sessions (sid, sess, expires_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET
          sess = excluded.sess,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `);
      this.destroyStatement = this.db.prepare("DELETE FROM sessions WHERE sid = ?");
      this.touchStatement = this.db.prepare("UPDATE sessions SET sess = ?, expires_at = ?, updated_at = ? WHERE sid = ?");
      this.clearExpiredStatement = this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?");
      this.cleanupTimer = setInterval(() => this.clearExpired(), this.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
      this.clearExpired();
    }

    expiresAt(sess) {
      const cookieExpiry = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
      return Number.isFinite(cookieExpiry) ? cookieExpiry : Date.now() + this.defaultTtlMs;
    }

    get(sid, callback) {
      try {
        const row = this.getStatement.get(sid);
        if (!row || row.expires_at <= Date.now()) {
          if (row) this.destroyStatement.run(sid);
          return callback(null, null);
        }
        return callback(null, JSON.parse(row.sess));
      } catch (error) {
        return callback(error);
      }
    }

    set(sid, sess, callback = () => {}) {
      try {
        const timestamp = Date.now();
        this.setStatement.run(sid, JSON.stringify(sess), this.expiresAt(sess), timestamp);
        return callback(null);
      } catch (error) {
        return callback(error);
      }
    }

    destroy(sid, callback = () => {}) {
      try {
        this.destroyStatement.run(sid);
        return callback(null);
      } catch (error) {
        return callback(error);
      }
    }

    touch(sid, sess, callback = () => {}) {
      try {
        this.touchStatement.run(JSON.stringify(sess), this.expiresAt(sess), Date.now(), sid);
        return callback(null);
      } catch (error) {
        return callback(error);
      }
    }

    clearExpired() {
      try {
        this.clearExpiredStatement.run(Date.now());
      } catch (error) {
        this.emit("disconnect", error);
      }
    }

    close() {
      clearInterval(this.cleanupTimer);
      this.db.close();
    }
  };
};
