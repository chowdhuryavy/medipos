// Runs on Vercel before each deploy (see vercel.json "buildCommand").
// Writes "<release> · build <commit> · <date>" into js/version.js and index.html,
// so every push shows a new version. Locally it does nothing, so the repo stays clean.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

if (!process.env.VERCEL) {
  console.log("Not on Vercel: version stamp skipped.");
  process.exit(0);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
if (!sha) {
  try { sha = execSync("git rev-parse HEAD").toString().trim(); } catch { sha = ""; }
}
const build = sha ? sha.slice(0, 7) : "unknown";
const date = new Date().toISOString().slice(0, 10);
const version = `${pkg.version} · build ${build} · ${date}`;

writeFileSync("js/version.js", `// Written by scripts/stamp-version.js on every deploy.\nexport const VERSION = ${JSON.stringify(version)};\n`);
writeFileSync("index.html", readFileSync("index.html", "utf8").replace(/__APP_VERSION__/g, version));
console.log("Version:", version);
