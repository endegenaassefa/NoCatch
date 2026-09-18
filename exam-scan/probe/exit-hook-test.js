const path = require("path");
const fs = require("fs");
const { app } = require("electron");

const DEATH_LOG = path.join(require("os").homedir(), ".screen-reader-util", "logs", "death-watch.log");
function _deathNote(msg) {
  try { fs.appendFileSync(DEATH_LOG, new Date().toISOString() + " " + msg + "\n"); } catch (_) {}
}
process.on("exit", (code) => { _deathNote("process exit event, code=" + code); });
app.on("render-process-gone", (_e, _w, d) => { _deathNote("render-process-gone reason=" + (d && d.reason) + " exitCode=" + (d && d.exitCode)); });
app.on("child-process-gone", (_e, d) => { _deathNote("child-process-gone type=" + (d && d.type) + " reason=" + (d && d.reason)); });
app.whenReady().then(() => { setTimeout(() => { app.exit(7); }, 2500); });
