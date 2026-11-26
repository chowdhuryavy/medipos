// Runs on Vercel before each deploy (see vercel.json "buildCommand").
// Writes the release number from package.json into js/version.js and index.html.
// Only the version is shown; no build hash or date.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

if (!process.env.VERCEL) {
  console.log("Not on Vercel: version stamp skipped.");
  process.exit(0);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;

writeFileSync("js/version.js", `// Written by scripts/stamp-version.js on every deploy.\nexport const VERSION = ${JSON.stringify(version)};\n`);
writeFileSync("index.html", readFileSync("index.html", "utf8").replace(/__APP_VERSION__/g, version));
console.log("Version:", version);
