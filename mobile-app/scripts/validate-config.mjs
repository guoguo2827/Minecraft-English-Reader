import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

const config = JSON.parse(await read("capacitor.config.json"));
const manifest = await read("android/app/src/main/AndroidManifest.xml");
const activity = await read("android/app/src/main/java/top/eduplayer/reader/MainActivity.java");
const errorPage = await read("www/error.html");

assert.equal(config.appId, "top.eduplayer.reader");
assert.equal(config.server.url, "https://eduplayer.top");
assert.equal(config.server.cleartext, false);
assert.equal(config.server.errorPath, "error.html");
assert.deepEqual(config.server.allowNavigation, ["eduplayer.top"]);
assert.equal(config.android.allowMixedContent, false);
assert.equal(config.android.webContentsDebuggingEnabled, false);

for (const expected of [
  'android:allowBackup="false"',
  'android:usesCleartextTraffic="false"',
  'android:screenOrientation="portrait"',
  "android.permission.INTERNET",
  "android.permission.RECORD_AUDIO",
  "android.permission.ACCESS_NETWORK_STATE"
]) {
  assert.ok(manifest.includes(expected), `AndroidManifest.xml is missing ${expected}`);
}

assert.ok(activity.includes("setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW)"));
assert.ok(activity.includes("setAcceptThirdPartyCookies(webView, false)"));
assert.ok(activity.includes("WEB_BACK_HANDLER"));
assert.ok(errorPage.includes('location.replace("https://eduplayer.top/login")'));

console.log("Android shell configuration is valid.");
