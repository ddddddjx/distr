// 规则精度验证工具：把一批带标签的真实挥杆视频喂给真实应用（无头 Chromium），
// 汇总每条规则的误报率（职业选手阴性对照集）与检出率（故意做错的阳性样本集），
// 顺带统计挥杆识别率、相位时刻误差与职业节奏分布。
//
// 素材不进 git（tests/assets/ 已 gitignore），标签由目录约定 + 可选 manifest.json 给出，
// 详见 tests/validation/README.md。
//
// 用法：
//   node tests/validation/run-validation.mjs init           # 建素材目录骨架
//   node tests/validation/run-validation.mjs                # 跑全部素材
//   node tests/validation/run-validation.mjs --only pro/side  # 只跑路径含该子串的素材
//   RATE=0.25 LIMIT=3 DEBUG=1 node tests/validation/run-validation.mjs
//
// 产出：tests/output/validation/report.md（人读）、results.json（机读），
//       每段素材一个子目录：session.json（SwingSession 契约实例）+ 问题标注截图。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "../../js/rules.js";
import { LEGACY_TO_CODE } from "../../js/legacyCodeMap.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ASSETS = path.join(ROOT, "tests", "assets", "validation");
const OUT = path.join(ROOT, "tests", "output", "validation");
const MANIFEST = path.join(ROOT, "tests", "validation", "manifest.json");
const VIDEO_EXT = new Set([".webm", ".mp4", ".mov"]);
const VIEWS = new Set(["side", "front"]);

// 规则码 → { view, severity }（契约码是目录名与报告里的统一标识）
const CODE_INFO = {};
for (const [key, rule] of Object.entries(RULES)) {
  CODE_INFO[LEGACY_TO_CODE[key]] = { key, view: rule.view, severity: rule.severity, title: rule.title };
}

/* ---------------- 子命令：init ---------------- */
if (process.argv[2] === "init") {
  const dirs = ["pro/side", "pro/front"];
  for (const [code, info] of Object.entries(CODE_INFO)) dirs.push(`faults/${code}/${info.view}`);
  for (const d of dirs) fs.mkdirSync(path.join(ASSETS, d), { recursive: true });
  console.log("已创建素材目录骨架：" + path.relative(ROOT, ASSETS));
  for (const d of dirs) console.log("  " + d + "/");
  console.log("\n把转码后的 .webm 放进对应目录即可；标注细节见 tests/validation/README.md");
  process.exit(0);
}

/* ---------------- 收集素材与标签 ---------------- */
const only = (() => {
  const i = process.argv.indexOf("--only");
  return i > 0 ? process.argv[i + 1] : null;
})();
const LIMIT = Number(process.env.LIMIT || 0);
const DEFAULT_RATE = Number(process.env.RATE || 0.5);

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) return { defaults: {}, clips: {} };
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  return { defaults: m.defaults || {}, clips: m.clips || {} };
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(fp, out);
    else if (VIDEO_EXT.has(path.extname(ent.name).toLowerCase())) out.push(fp);
  }
  return out.sort();
}

/**
 * 由路径约定推导标签：
 *   pro/<view>/x.webm                 → 阴性对照，期望零检出
 *   faults/<code>/<view>/x.webm       → 阳性样本，期望检出 code
 * manifest.clips[rel] 可覆盖/补充：codes、allow、swings、events、playbackRate、note、source
 */
function describeClip(abs, manifest) {
  const rel = path.relative(ASSETS, abs).split(path.sep).join("/");
  const parts = rel.split("/");
  const warnings = [];
  let category, view, codes = [];
  if (parts[0] === "pro" && parts.length === 3) {
    category = "pro";
    view = parts[1];
  } else if (parts[0] === "faults" && parts.length === 4) {
    category = "faults";
    codes = [parts[1]];
    view = parts[2];
    const info = CODE_INFO[parts[1]];
    if (!info) warnings.push(`未知规则码 ${parts[1]}`);
    else if (info.view !== view) warnings.push(`规则 ${parts[1]} 只在 ${info.view} 机位检测，目录却是 ${view}`);
  } else {
    warnings.push("路径不符合 pro/<view>/ 或 faults/<code>/<view>/ 约定");
  }
  if (view && !VIEWS.has(view)) warnings.push(`机位目录必须是 side 或 front，实际 ${view}`);
  const m = manifest.clips[rel] || {};
  if (Array.isArray(m.codes)) codes = m.codes;
  for (const c of codes) if (!CODE_INFO[c]) warnings.push(`manifest 中的未知规则码 ${c}`);
  return {
    rel, abs, category, view, codes,
    allow: Array.isArray(m.allow) ? m.allow : [],
    expectedSwings: typeof m.swings === "number" ? m.swings : null,
    events: m.events || null,
    playbackRate: Number(m.playbackRate || manifest.defaults.playbackRate || DEFAULT_RATE),
    note: m.note || "",
    source: m.source || "",
    warnings,
  };
}

/* ---------------- 静态服务与浏览器 ---------------- */
const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".wasm": "application/wasm",
  ".task": "application/octet-stream", ".webm": "video/webm", ".mp4": "video/mp4",
};

function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const fp = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

const log = (...a) => console.error(...a);

/** 驱动应用分析一段视频，返回契约实例 + 各杆视频时间元数据 + 问题截图 */
async function analyzeClip(page, base, clip) {
  const r = { swings: [], meta: [], shots: [], consoleErrors: [], error: null, duration: null };
  const onConsole = (m) => { if (m.type() === "error") r.consoleErrors.push(m.text().slice(0, 200)); };
  page.on("console", onConsole);
  try {
    await page.goto(base + "/?ff=EXPORT_ENABLED", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chooser:not(.hidden)", { timeout: 180000 });
    const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click("#chooseUpload")]);
    await fc.setFiles(clip.abs);
    await page.waitForFunction(
      () => document.getElementById("phasePill").textContent.includes("就绪"),
      { timeout: 30000 }
    );
    r.duration = await page.evaluate(() => document.getElementById("video").duration);
    if (clip.view === "side") await page.click('#viewSeg button[data-view="side"]');
    await page.click("#startBtn");
    await page.evaluate((rate) => { document.getElementById("video").playbackRate = rate; }, clip.playbackRate);

    const poller = setInterval(async () => {
      const s = await page.evaluate(() => ({
        pill: document.getElementById("phasePill").textContent,
        fps: document.getElementById("fpsLabel").textContent,
        t: +document.getElementById("video").currentTime.toFixed(1),
      })).catch(() => null);
      if (s && process.env.DEBUG) log(`  [poll] t=${s.t}s ${s.pill} ${s.fps}`);
    }, 2000);
    try {
      // 三种结局：报告弹出 / 播完提示未识别到挥杆 / 播完但报告还在等击球声解码
      await page.waitForFunction(() => {
        const modal = !document.getElementById("summaryModal").classList.contains("hidden");
        const noSwing = document.getElementById("hint").textContent.includes("未识别到完整挥杆");
        const v = document.getElementById("video");
        return modal || noSwing || (v.ended && document.getElementById("phasePill").textContent.includes("播放结束"));
      }, { timeout: (r.duration / clip.playbackRate) * 1000 * 1.5 + 60000 });
      const noSwing = await page.$eval("#hint", (e) => e.textContent.includes("未识别到完整挥杆"));
      if (!noSwing) {
        await page.waitForSelector("#summaryModal:not(.hidden)", { timeout: 30000 }).catch(() => {});
      }
    } finally {
      clearInterval(poller);
    }
    const hasReport = await page.$eval("#summaryModal", (e) => !e.classList.contains("hidden"));
    if (hasReport) {
      await page.waitForTimeout(800);
      const session = await page.evaluate(() => window.__exportSession({ userId: null }));
      r.swings = session.swings;
      r.meta = await page.evaluate(() => window.__videoSwingsMeta());
      r.session = session;
      r.shots = await page.$$eval(".summary-item", (els) =>
        els.map((e) => ({
          title: (e.querySelector(".si-title") || {}).textContent || "",
          src: (e.querySelector(".si-shot") || {}).src || "",
        }))
      );
    }
  } catch (e) {
    r.error = String(e).slice(0, 400);
  } finally {
    page.off("console", onConsole);
  }
  return r;
}

/* ---------------- 统计 ---------------- */
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : "—");
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const f2 = (v) => (v === null || v === undefined ? "—" : v.toFixed(2));

/** 导出的相位时间是墙钟毫秒（相对 t0）；用击球的视频时刻把它换算回视频秒 */
function phaseVideoTimes(swing, meta, rate) {
  if (!meta || typeof meta.impactVideoT !== "number" || swing.phases.P7 === null) return null;
  const toVideo = (ms) => (ms === null ? null : meta.impactVideoT + ((ms - swing.phases.P7) / 1000) * rate);
  return { backswing: toVideo(swing.phases.P2), top: toVideo(swing.phases.P4), impact: meta.impactVideoT, finish: toVideo(swing.phases.P10) };
}

function summarize(results) {
  const byCat = { pro: results.filter((r) => r.clip.category === "pro"), faults: results.filter((r) => r.clip.category === "faults") };
  const detectedIn = (r) => r.swings.length > 0;

  // 识别率
  const recognition = {};
  for (const cat of ["pro", "faults"]) {
    for (const view of ["side", "front"]) {
      const rs = byCat[cat].filter((r) => r.clip.view === view && !r.error);
      if (!rs.length) continue;
      recognition[`${cat}/${view}`] = {
        clips: rs.length,
        recognized: rs.filter(detectedIn).length,
        swings: rs.reduce((s, r) => s + r.swings.length, 0),
        countMismatch: rs.filter((r) => r.clip.expectedSwings !== null && r.swings.length !== r.clip.expectedSwings).map((r) => `${r.clip.rel}（期望 ${r.clip.expectedSwings}，实际 ${r.swings.length}）`),
        missed: rs.filter((r) => !detectedIn(r)).map((r) => r.clip.rel),
      };
    }
  }

  // 误报率：职业集，按规则适用机位取分母
  const falsePositives = {};
  for (const [code, info] of Object.entries(CODE_INFO)) {
    const rs = byCat.pro.filter((r) => r.clip.view === info.view && !r.error);
    const swings = rs.flatMap((r) => r.swings.map((s) => ({ s, r })));
    const fired = swings.filter(({ s, r }) => !r.clip.allow.includes(code) && s.vision.findings.some((f) => f.code === code));
    const ratios = fired.map(({ s }) => s.vision.findings.find((f) => f.code === code).ratio).filter((x) => typeof x === "number");
    falsePositives[code] = {
      view: info.view, severity: info.severity, title: info.title,
      swings: swings.length, fired: fired.length,
      meanRatio: mean(ratios), maxRatio: ratios.length ? Math.max(...ratios) : null,
      clips: [...new Set(fired.map(({ r }) => r.clip.rel))],
    };
  }

  // 检出率：阳性集，按标注码
  const recall = {};
  for (const r of byCat.faults) {
    if (r.error) continue;
    for (const code of r.clip.codes) {
      const e = (recall[code] ||= { labeled: 0, detected: 0, ratios: [], missed: [] });
      e.labeled++;
      const hits = r.swings.map((s) => s.vision.findings.find((f) => f.code === code)).filter(Boolean);
      if (hits.length) {
        e.detected++;
        e.ratios.push(Math.max(...hits.map((h) => h.ratio ?? 0)));
      } else e.missed.push(r.clip.rel + (detectedIn(r) ? "" : "（未识别到挥杆）"));
    }
  }

  // 阳性集上的附带检出（未标注却触发的规则，仅供参考，不能直接算误报）
  const collateral = {};
  for (const r of byCat.faults) {
    if (r.error) continue;
    for (const s of r.swings) {
      for (const f of s.vision.findings) {
        if (r.clip.codes.includes(f.code) || r.clip.allow.includes(f.code)) continue;
        collateral[f.code] = (collateral[f.code] || 0) + 1;
      }
    }
  }
  const faultSwings = byCat.faults.filter((r) => !r.error).reduce((s, r) => s + r.swings.length, 0);

  // 相位误差（有 events 标注的素材）
  const phaseErrors = [];
  for (const r of results) {
    if (!r.clip.events || r.error) continue;
    for (let i = 0; i < r.swings.length; i++) {
      const vt = phaseVideoTimes(r.swings[i], r.meta[i], r.clip.playbackRate);
      if (!vt) continue;
      // 多杆视频：取与标注击球时刻最近的那一杆
      const row = { clip: r.clip.rel, swing: i + 1 };
      for (const ev of ["top", "impact"]) {
        if (typeof r.clip.events[ev] === "number" && typeof vt[ev] === "number") {
          row[ev] = Math.round((vt[ev] - r.clip.events[ev]) * 1000);
        }
      }
      if ("impact" in row || "top" in row) phaseErrors.push(row);
    }
  }
  // 每段素材只保留击球最接近标注的那一杆
  const bestPhase = {};
  for (const row of phaseErrors) {
    const key = row.clip;
    const cur = bestPhase[key];
    const score = Math.abs(row.impact ?? row.top ?? 1e9);
    if (!cur || score < Math.abs(cur.impact ?? cur.top ?? 1e9)) bestPhase[key] = row;
  }

  // 职业节奏分布
  const tempos = byCat.pro.flatMap((r) => r.swings.map((s) => s.vision.metrics.tempo_ratio)).filter((x) => typeof x === "number");
  const tempo = { n: tempos.length, mean: mean(tempos), sd: sd(tempos), min: tempos.length ? Math.min(...tempos) : null, max: tempos.length ? Math.max(...tempos) : null };

  return { recognition, falsePositives, recall, collateral, faultSwings, phaseErrors: Object.values(bestPhase), tempo };
}

/* ---------------- 报告 ---------------- */
function renderReport(results, stats, startedAt) {
  const L = [];
  const errors = results.filter((r) => r.error);
  L.push(`# 规则精度验证报告`);
  L.push(``);
  L.push(`- 生成时间：${new Date().toISOString()}（耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s）`);
  L.push(`- 素材：${results.length} 段（职业 ${results.filter((r) => r.clip.category === "pro").length} / 阳性 ${results.filter((r) => r.clip.category === "faults").length}），运行失败 ${errors.length} 段`);
  L.push(`- 默认播放倍率 ${DEFAULT_RATE}（无头推理约 3fps，倍率越低采样越密）`);
  L.push(``);
  L.push(`## 1. 挥杆识别率`);
  L.push(``);
  L.push(`| 集合/机位 | 素材 | 识别到挥杆 | 识别率 | 挥杆总数 |`);
  L.push(`|---|---|---|---|---|`);
  for (const [k, v] of Object.entries(stats.recognition)) L.push(`| ${k} | ${v.clips} | ${v.recognized} | ${pct(v.recognized, v.clips)} | ${v.swings} |`);
  for (const [k, v] of Object.entries(stats.recognition)) {
    if (v.missed.length) L.push(`\n未识别（${k}）：\n` + v.missed.map((m) => `- ${m}`).join("\n"));
    if (v.countMismatch.length) L.push(`\n杆数与标注不符（${k}）：\n` + v.countMismatch.map((m) => `- ${m}`).join("\n"));
  }
  L.push(``);
  L.push(`## 2. 误报率（职业选手阴性对照集）`);
  L.push(``);
  L.push(`触发即视为误报（manifest 里 allow 放行的除外）。分母是该规则适用机位下识别到的职业挥杆数。`);
  L.push(``);
  L.push(`| 规则 | 机位 | 严重度 | 职业挥杆数 | 触发 | 误报率 | 平均 ratio | 最大 ratio |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  for (const [code, v] of Object.entries(stats.falsePositives)) {
    L.push(`| ${code}（${v.title}） | ${v.view} | ${v.severity} | ${v.swings} | ${v.fired} | ${pct(v.fired, v.swings)} | ${f2(v.meanRatio)} | ${f2(v.maxRatio)} |`);
  }
  const fpClips = Object.entries(stats.falsePositives).filter(([, v]) => v.clips.length);
  if (fpClips.length) {
    L.push(``);
    for (const [code, v] of fpClips) L.push(`- ${code} 触发于：${v.clips.slice(0, 6).join("、")}${v.clips.length > 6 ? " …" : ""}`);
  }
  L.push(``);
  L.push(`## 3. 检出率（阳性样本集）`);
  L.push(``);
  L.push(`| 规则 | 标注素材 | 检出 | 检出率 | 平均 ratio |`);
  L.push(`|---|---|---|---|---|`);
  for (const [code, v] of Object.entries(stats.recall)) L.push(`| ${code} | ${v.labeled} | ${v.detected} | ${pct(v.detected, v.labeled)} | ${f2(mean(v.ratios))} |`);
  if (!Object.keys(stats.recall).length) L.push(`| （无阳性素材） | | | | |`);
  for (const [code, v] of Object.entries(stats.recall)) {
    if (v.missed.length) L.push(`\n${code} 漏检：\n` + v.missed.map((m) => `- ${m}`).join("\n"));
  }
  L.push(``);
  L.push(`### 3b. 阳性集上未标注却触发的规则（参考）`);
  L.push(``);
  L.push(`阳性样本可能确实同时带有其他问题，这里只列频次，不能直接算误报。阳性集挥杆总数 ${stats.faultSwings}。`);
  L.push(``);
  const col = Object.entries(stats.collateral).sort((a, b) => b[1] - a[1]);
  L.push(col.length ? col.map(([c, n]) => `- ${c}：${n} 次`).join("\n") : "- 无");
  L.push(``);
  L.push(`## 4. 相位时刻误差（有 events 标注的素材）`);
  L.push(``);
  if (stats.phaseErrors.length) {
    L.push(`| 素材 | 杆 | 顶点误差 ms | 击球误差 ms |`);
    L.push(`|---|---|---|---|`);
    for (const row of stats.phaseErrors) L.push(`| ${row.clip} | ${row.swing} | ${row.top ?? "—"} | ${row.impact ?? "—"} |`);
    const tops = stats.phaseErrors.map((r) => r.top).filter((x) => typeof x === "number").map(Math.abs);
    const imps = stats.phaseErrors.map((r) => r.impact).filter((x) => typeof x === "number").map(Math.abs);
    L.push(``);
    L.push(`平均绝对误差：顶点 ${tops.length ? Math.round(mean(tops)) + " ms" : "—"}，击球 ${imps.length ? Math.round(mean(imps)) + " ms" : "—"}（正值 = 检测偏晚）`);
  } else L.push(`无（在 manifest.json 的 events 里标注 top / impact 的视频秒数即可启用）`);
  L.push(``);
  L.push(`## 5. 职业节奏分布（上杆:下杆）`);
  L.push(``);
  L.push(`n=${stats.tempo.n}，均值 ${f2(stats.tempo.mean)}，标准差 ${f2(stats.tempo.sd)}，范围 ${f2(stats.tempo.min)} ~ ${f2(stats.tempo.max)}（教学参考 3.0）`);
  L.push(``);
  L.push(`## 6. 逐段明细`);
  L.push(``);
  L.push(`| 素材 | 机位 | 标签 | 挥杆数 | 检出 | 评分 | 节奏 | 备注 |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of results) {
    const findings = r.swings.map((s, i) => (r.swings.length > 1 ? `#${i + 1}:` : "") + (s.vision.findings.map((f) => `${f.code}(${f2(f.ratio)})`).join(" ") || "无")).join("；");
    const scores = r.swings.map((s) => s.vision.score).join("/");
    const tempo = r.swings.map((s) => f2(s.vision.metrics.tempo_ratio)).join("/");
    const note = [r.error ? "运行失败：" + r.error.slice(0, 80) : "", ...r.clip.warnings, r.clip.note].filter(Boolean).join("；");
    L.push(`| ${r.clip.rel} | ${r.clip.view} | ${r.clip.codes.join(",") || (r.clip.category === "pro" ? "阴性" : "")} | ${r.swings.length} | ${findings} | ${scores} | ${tempo} | ${note} |`);
  }
  L.push(``);
  L.push(`## 阅读提示`);
  L.push(``);
  L.push(`- 误报率高的规则：先看触发素材的截图（tests/output/validation/<素材名>/），分清是关键点抖动还是阈值过严。`);
  L.push(`- 检出率低的规则：先确认相位切分是否正确（第 4 节），相位错了下游一定错。`);
  L.push(`- 职业选手个人特征（如上杆路线特别的球员）用 manifest 的 allow 放行，不要为此放宽阈值。`);
  return L.join("\n");
}

/* ---------------- 主流程 ---------------- */
const startedAt = Date.now();
const manifest = loadManifest();
let clips = walk(ASSETS).map((abs) => describeClip(abs, manifest));
if (only) clips = clips.filter((c) => c.rel.includes(only));
if (LIMIT > 0) clips = clips.slice(0, LIMIT);

for (const [rel, m] of Object.entries(manifest.clips)) {
  if (!fs.existsSync(path.join(ASSETS, rel))) log(`[warn] manifest 引用的素材不存在（跳过）：${rel}${m.source ? "  来源 " + m.source : ""}`);
}
if (!clips.length) {
  log(`没有找到素材：请先运行 init 建目录，再把转码后的 .webm 放进 ${path.relative(ROOT, ASSETS)}/`);
  process.exit(2);
}
log(`共 ${clips.length} 段素材，开始验证…`);

fs.mkdirSync(OUT, { recursive: true });
const { chromium } = await import("playwright"); // init 子命令不需要浏览器，延迟加载
const server = await serve();
const base = `http://localhost:${server.address().port}`;
const PREINSTALLED = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  executablePath: fs.existsSync(PREINSTALLED) ? PREINSTALLED : undefined,
  args: ["--use-gl=swiftshader", "--disable-web-security"],
});
const page = await browser.newPage();

const results = [];
try {
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    log(`[${i + 1}/${clips.length}] ${clip.rel}（${clip.view}，${clip.playbackRate}x）`);
    for (const w of clip.warnings) log(`  [warn] ${w}`);
    const r = await analyzeClip(page, base, clip);
    const outDir = path.join(OUT, clip.rel.replace(/[\\/]/g, "__").replace(/\.\w+$/, ""));
    fs.mkdirSync(outDir, { recursive: true });
    if (r.session) fs.writeFileSync(path.join(outDir, "session.json"), JSON.stringify(r.session, null, 2));
    r.shots.forEach((s, k) => {
      const b64 = (s.src || "").split(",")[1];
      if (b64) fs.writeFileSync(path.join(outDir, `fault-${k}-${s.title.replace(/[^\w一-龥]+/g, "_")}.jpg`), Buffer.from(b64, "base64"));
    });
    const summary = r.error
      ? "失败 " + r.error.slice(0, 120)
      : `挥杆 ${r.swings.length}，检出 ${r.swings.map((s) => s.vision.findings.map((f) => f.code).join("+") || "无").join(" | ")}`;
    log(`  → ${summary}`);
    results.push({ clip, swings: r.swings, meta: r.meta, error: r.error, consoleErrors: r.consoleErrors, duration: r.duration });
  }
} finally {
  await browser.close();
  server.close();
}

const stats = summarize(results);
const report = renderReport(results, stats, startedAt);
fs.writeFileSync(path.join(OUT, "report.md"), report);
fs.writeFileSync(
  path.join(OUT, "results.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), defaultRate: DEFAULT_RATE, stats, results: results.map((r) => ({ ...r, swings: r.swings.map((s) => ({ ...s, vision: { ...s.vision, keypoints_2d: undefined } })) })) }, null, 2)
);
console.log(report);
log(`\n报告：${path.relative(ROOT, path.join(OUT, "report.md"))}`);
process.exit(results.some((r) => r.error) ? 1 : 0);
