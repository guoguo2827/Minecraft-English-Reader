"use strict";
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const path = require("node:path");
exports.createAccount = function createAccount(base) {
  if (base !== "http://127.0.0.1:3137") throw new Error("Fixtures only target the isolated preview server on 127.0.0.1:3137");
  const db = new Database(path.resolve(__dirname,"../work/world-preview/app.db"),{fileMustExist:true});
  try {
    const phone=`138${String(crypto.randomInt(100000000)).padStart(8,"0")}`,password=crypto.randomUUID();
    db.prepare("INSERT INTO users (username,phone,password_hash,nickname,role,access_tier,primary_course,created_at) VALUES (?,?,?,'Camp QA','admin','founder_trial','english',?)")
      .run(phone,phone,bcrypt.hashSync(password,4),new Date().toISOString());
    return {phone,password};
  } finally { db.close(); }
};
