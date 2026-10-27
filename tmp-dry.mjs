import fs from "node:fs"; import path from "node:path"
const p = path.join(process.env.USERPROFILE, ".dsh", "feiyu.config.json")
const cfg = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""))
cfg.guard = cfg.guard || {}; cfg.guard.dryRun = true
fs.writeFileSync(p, JSON.stringify(cfg, null, 1) + "\n", "utf8"); console.log("dryRun=true")
