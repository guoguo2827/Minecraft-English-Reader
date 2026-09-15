"use strict";
const path = require("node:path");
const { build } = require("esbuild");

build({
  absWorkingDir: path.join(__dirname, ".."),
  entryPoints: ["world/main.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2022", "safari16"],
  outfile: "outputs/world-assets/camp.js",
  legalComments: "linked",
  logLevel: "info"
}).catch(() => { process.exitCode = 1; });
