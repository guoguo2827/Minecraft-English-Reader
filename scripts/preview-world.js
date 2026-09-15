"use strict";
// Local-only preview always uses a separate database; never points at data/app.db.
const fs = require("node:fs");
const path = require("node:path");
const directory = path.resolve(__dirname,"../work/world-preview");
fs.mkdirSync(directory,{recursive:true});
Object.assign(process.env,{
  NODE_ENV:"development",DATABASE_PATH:path.join(directory,"app.db"),SESSION_DATABASE_PATH:path.join(directory,"sessions.db"),
  ADMIN_USERNAME:"camp-preview",ADMIN_PHONE:"13830000000",ADMIN_PASSWORD:"CampPreview2026!",
  SESSION_SECRET:"local-camp-preview-only-change-for-production",COOKIE_SECURE:"false",WORLD_ACCESS:"admin"
});
const { app } = require("../server");
const port=Number(process.env.WORLD_PREVIEW_PORT||3137);
app.listen(port,"127.0.0.1",()=>console.log(`Camp preview http://127.0.0.1:${port}/world; local account 13830000000 / CampPreview2026!`));
