/**
 * MediPOS – Updater.gs
 * Keeps this Apps Script project in step with the GitHub repo (the apps-script/ folder). Every 5 minutes it
 * checks the branch. When there is a new commit it loads the files, makes a new version and moves the web app
 * to it. Nobody has to copy code or deploy by hand.
 *
 * Script properties (Project Settings → Script properties):
 *   GITHUB_TOKEN   fine-grained token with read-only "Contents" access to the repo (required)
 *   GITHUB_REPO    owner/repo (optional, default chowdhuryavy/medipos)
 *   GITHUB_BRANCH  branch to follow (optional, default "main")
 *
 * One-time setup:
 *  1. script.google.com/home/usersettings → turn on "Google Apps Script API".
 *  2. Add GITHUB_TOKEN above, then run enableAutoUpdate() once and accept the permissions.
 *  3. The web app must already be deployed once (Deploy → New deployment → Web app, Execute as Me, Anyone).
 */

var UPDATER_DEFAULT_REPO = "chowdhuryavy/medipos";
var UPDATER_FOLDER = "apps-script/";
// Only the Apps Script files of the repo are deployed: Code.gs, Updater.gs and appsscript.json.
var UPDATER_FILE_RX = /^apps-script\/([^\/]+\.gs|appsscript\.json)$/;
var AUTO_UPDATE_HANDLER = "autoUpdateCheck";

function updaterConfig_() {
  var p = PropertiesService.getScriptProperties();
  var cfg = {
    token: String(p.getProperty("GITHUB_TOKEN") || "").replace(/\s+/g, ""),   // a paste can add spaces or line breaks
    repo: p.getProperty("GITHUB_REPO") || UPDATER_DEFAULT_REPO,
    branch: p.getProperty("GITHUB_BRANCH") || "main"
  };
  if (!cfg.token) throw new Error("Add GITHUB_TOKEN in Script properties first (Project Settings → Script properties).");
  return cfg;
}

/** Calls the GitHub API and returns the response text. */
function gh_(cfg, path, accept) {
  var res = UrlFetchApp.fetch("https://api.github.com/repos/" + cfg.repo + path, {
    headers: { Authorization: "Bearer " + cfg.token, Accept: accept || "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error("GitHub returned " + res.getResponseCode() + " for " + path + ". Check GITHUB_TOKEN and GITHUB_REPO.");
  }
  return res.getContentText();
}

/** The newest commit on the branch. */
function headSha_(cfg) {
  return gh_(cfg, "/commits/" + encodeURIComponent(cfg.branch), "application/vnd.github.sha").trim();
}

/** Reads the Apps Script files of one commit from GitHub. Returns [{ path, text }]. */
function fetchRepoFiles_(cfg, sha) {
  var tree = JSON.parse(gh_(cfg, "/git/trees/" + sha + "?recursive=1"));
  return tree.tree
    .filter(function (t) { return t.type === "blob" && UPDATER_FILE_RX.test(t.path); })
    .map(function (t) {
      var blob = JSON.parse(gh_(cfg, "/git/blobs/" + t.sha));
      var bytes = Utilities.base64Decode(blob.content.replace(/\n/g, ""));
      return { path: t.path, text: Utilities.newBlob(bytes).getDataAsString("UTF-8") };
    });
}

/** Calls the Apps Script API for this project. */
function scriptApi_(method, path, body) {
  var res = UrlFetchApp.fetch("https://script.googleapis.com/v1/projects/" + ScriptApp.getScriptId() + path, {
    method: method,
    contentType: "application/json",
    payload: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  var text = res.getContentText();
  if (res.getResponseCode() >= 300) {
    if (/User has not enabled the Apps Script API/i.test(text)) {
      throw new Error('Turn on "Google Apps Script API" at script.google.com/home/usersettings, wait 2–3 minutes and try again.');
    }
    throw new Error("Apps Script API " + res.getResponseCode() + ": " + text.slice(0, 300));
  }
  return text ? JSON.parse(text) : {};
}

/** Replaces every file of this project with the repo's files. */
function pushFiles_(files) {
  scriptApi_("put", "/content", {
    files: files.map(function (f) {
      if (f.path === UPDATER_FOLDER + "appsscript.json") return { name: "appsscript", type: "JSON", source: f.text };
      return { name: f.path.replace(UPDATER_FOLDER, "").replace(/\.gs$/, ""), type: "SERVER_JS", source: f.text };
    })
  });
}

/** Makes a numbered version of the project. */
function createVersion_(description) {
  return scriptApi_("post", "/versions", { description: description }).versionNumber;
}

/** Every web app deployment of this project (the links the staff use). */
function webAppDeployments_() {
  var list = scriptApi_("get", "/deployments?pageSize=50");
  return (list.deployments || []).filter(function (d) {
    return d.deploymentConfig && d.deploymentConfig.versionNumber &&
      (d.entryPoints || []).some(function (e) { return e.entryPointType === "WEB_APP"; });
  });
}

/** Moves one web app deployment to a version. */
function pointDeployment_(deployId, versionNumber, description) {
  scriptApi_("put", "/deployments/" + deployId, {
    deploymentConfig: { scriptId: ScriptApp.getScriptId(), versionNumber: versionNumber, manifestFileName: "appsscript", description: description }
  });
}

/**
 * Loads the newest Apps Script code of the branch, makes a version and moves the web app to it.
 * Returns a message for the log. A push that changes no Apps Script file does nothing.
 */
function updateFromGitHub(auto) {
  var cfg = updaterConfig_();
  var p = PropertiesService.getScriptProperties();
  var sha = headSha_(cfg);
  var files = fetchRepoFiles_(cfg, sha);
  var has = function (path) { return files.some(function (f) { return f.path === path; }); };
  if (!has(UPDATER_FOLDER + "Updater.gs")) throw new Error("Updater.gs is missing in the repo; the update was stopped to keep the updater working.");
  if (!has(UPDATER_FOLDER + "Code.gs")) throw new Error("Code.gs is missing in the repo; the update was stopped.");
  if (!has(UPDATER_FOLDER + "appsscript.json")) throw new Error("appsscript.json is missing in the repo.");

  var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    files.map(function (f) { return f.path + "\n" + f.text; }).join("\n\u0000\n"), Utilities.Charset.UTF_8));
  if (hash === p.getProperty("CONTENT_HASH") && !p.getProperty("PENDING_SHA")) {
    p.setProperty("LAST_SHA", sha);
    return "No Apps Script changes in GitHub " + sha.slice(0, 7) + " – nothing to update.";
  }

  // Remember that publishing is still due: a run can be cut off after the code has been replaced.
  p.setProperty("PENDING_SHA", sha);
  pushFiles_(files);
  var desc = "From GitHub " + sha.slice(0, 7);
  var version = createVersion_(desc);

  var deps = webAppDeployments_();
  var failed = [];
  deps.forEach(function (d) {
    try { pointDeployment_(d.deploymentId, version, desc); } catch (e) { failed.push(e.message); }
  });
  // Only a fully moved update counts as applied. Otherwise it stays pending and the next run tries again.
  if (!failed.length) {
    p.setProperty("CONTENT_HASH", hash);
    p.setProperty("LAST_SHA", sha);
    p.deleteProperty("PENDING_SHA");
  }

  var msg = (auto ? "Automatic update: " : "Update: ") + desc + " is now version " + version + ".";
  if (deps.length) msg += " " + (deps.length - failed.length) + " web app link(s) now run it – reload the app.";
  else msg += " No web app deployment was found: use Deploy → New deployment → Web app once.";
  if (failed.length) msg += " Could not move: " + failed.join(" | ");
  return msg;
}

/** The 5-minute timer. It does real work only when the branch has a new commit. */
function autoUpdateCheck() {
  var cfg;
  try { cfg = updaterConfig_(); } catch (e) { return "Updater is not configured yet (GITHUB_TOKEN)."; }
  var p = PropertiesService.getScriptProperties();
  var sha = headSha_(cfg);
  if (sha === p.getProperty("LAST_SHA") && !p.getProperty("PENDING_SHA")) return "No new commit.";
  return updateFromGitHub(true);
}

function autoUpdateTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === AUTO_UPDATE_HANDLER; });
}

/** Turns on the 5-minute check (replaces any earlier one). Run once from the editor. */
function enableAutoUpdate() {
  autoUpdateTriggers_().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger(AUTO_UPDATE_HANDLER).timeBased().everyMinutes(5).create();
  return "Automatic updates are on. GitHub is checked every 5 minutes.";
}

/** Updates now, without waiting for the timer. Run from the editor when needed. */
function updateNow() {
  return updateFromGitHub(false);
}
