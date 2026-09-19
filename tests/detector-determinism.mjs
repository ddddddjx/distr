// 姿态推理的可复现性回归（E2E，需要浏览器，不进 test:unit）
//   node tests/detector-determinism.mjs
//
// 守的是线上事故的【第二层】：同一段上传视频，两次分析一次 50 分一次 90 分。
// 第一层（帧序列不固定）已由 frameGrid + runFileAnalysis 修掉，但那还不够——
// MediaPipe 的 VIDEO 模式用上一帧的结果做跟踪 ROI，而 landmarker 是全局长寿命
// 实例：第二次从头分析时，跟踪器里还留着第一次最后一帧的状态，开头几帧就偏、
// 基准锁错、分数天差地别。
//
// 实测（本测试的控制组）：同一串 12 帧喂两遍，鼻子关键点最大坐标差
//   VIDEO 模式 0.04（归一化坐标，足够把规则阈值整个翻过去）
//   IMAGE 模式 0.000
// 所以上传视频必须走无状态的 IMAGE 模式（PoseDetector.setStateless(true)）。
//
// 上一版测试只断言"两次走过的帧时刻一致"，正因为没验到模型输出，这个 bug
// 溜了过去。这里直接比对关键点数值。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".wasm": "application/wasm", ".task": "application/octet-stream",
};
const srv = http.createServer((q, s) => {
  const u = decodeURIComponent(new URL(q.url, "http://x").pathname);
  const f = path.join(ROOT, u === "/" ? "index.html" : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    return void s.writeHead(404).end();
  }
  s.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(s);
});
await new Promise((r) => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}`;
const PREINSTALLED = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  executablePath: fs.existsSync(PREINSTALLED) ? PREINSTALLED : undefined,
  args: ["--use-gl=swiftshader"],
});
const page = await (await browser.newContext()).newPage();
const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.error(`[${pass ? "ok" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
};
try {
  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const out = await page.evaluate(async (base) => {
    const { PoseDetector } = await import(base + "/js/poseDetector.js");
    const det = new PoseDetector();
    await det.init();

    // 合成人形（真人视频进不了容器，但 lite 模型认得出这个）
    const c = document.createElement("canvas"); c.width = 320; c.height = 460;
    const draw = (lean) => {
      const x = c.getContext("2d");
      x.fillStyle = "#cfd8dc"; x.fillRect(0, 0, c.width, c.height);
      const cx = c.width / 2 + lean;
      x.lineCap = "round"; x.fillStyle = "#e8c39e";
      x.beginPath(); x.arc(cx, 70, 28, 0, 7); x.fill();
      x.strokeStyle = "#2b3a45"; x.lineWidth = 44;
      x.beginPath(); x.moveTo(cx, 105); x.lineTo(cx, 230); x.stroke();
      x.lineWidth = 18;
      x.beginPath(); x.moveTo(cx - 20, 130); x.lineTo(cx - 70, 190); x.lineTo(cx - 40 + lean, 240); x.stroke();
      x.beginPath(); x.moveTo(cx + 20, 130); x.lineTo(cx + 70, 190); x.lineTo(cx + 40 + lean, 240); x.stroke();
      x.lineWidth = 22;
      x.beginPath(); x.moveTo(cx - 18, 230); x.lineTo(cx - 28, 330); x.lineTo(cx - 30, 410); x.stroke();
      x.beginPath(); x.moveTo(cx + 18, 230); x.lineTo(cx + 28, 330); x.lineTo(cx + 30, 410); x.stroke();
    };
    const leans = [0, 6, 14, 24, 30, 24, 14, 6, 0, -8, -16, -8]; // 一段"动作"
    const maxDiff = (a, b) => {
      let m = 0;
      for (let i = 0; i < a.length; i++) {
        if (!a[i] || !b[i]) { m = Math.max(m, a[i] === b[i] ? 0 : 1); continue; }
        for (let k = 0; k < a[i].length; k++) {
          m = Math.max(m, Math.abs(a[i][k].x - b[i][k].x), Math.abs(a[i][k].y - b[i][k].y));
        }
      }
      return m;
    };

    // ——— 上传视频走的那条路：无状态 ———
    await det.setStateless(true);
    const runStateless = () => leans.map((l) => { draw(l); return det.detectAt(c, 0); });
    const t0 = performance.now();
    const s1 = runStateless();
    const statelessMs = (performance.now() - t0) / leans.length;
    const s2 = runStateless();

    // ——— 控制组：相机走的 VIDEO 模式（有跟踪状态） ———
    await det.setStateless(false);
    // 时间戳必须够大：实测只要喂进一个倒退的时间戳，MediaPipe 的图就永久坏掉
    let ts = 1e6;
    const runVideo = () => leans.map((l) => { draw(l); return det.detect2(c, ts++); });
    det.detect2 = (img, t) => {
      const r = det.landmarker.detectForVideo(img, t);
      return r.landmarks && r.landmarks.length ? r.landmarks[0] : null;
    };
    const t1 = performance.now();
    const v1 = runVideo();
    const videoMs = (performance.now() - t1) / leans.length;
    const v2 = runVideo();

    return {
      detected: s1.filter(Boolean).length,
      statelessDiff: maxDiff(s1, s2),
      videoDiff: maxDiff(v1, v2),
      statelessMs, videoMs,
    };
  }, base);

  // 合成人形不是真人，某些倾角 lite 模型认不出来——但认不出的帧两遍都认不出，
  // 不影响"一致性"这个结论。这里只要求有足够多帧真的产出了关键点，
  // 否则这条测试就退化成"比较两串 null"，等于没测。
  check("合成人形确实被识别（否则这条测试等于没测）", out.detected >= 6, `${out.detected}/12 帧`);
  check("无状态模式：同一串帧跑两遍，关键点【完全一致】",
    out.statelessDiff === 0, `最大坐标差 ${out.statelessDiff.toExponential(3)}`);
  check("控制组：VIDEO 模式两遍结果确实不同（证明这条测试测得到东西）",
    out.videoDiff > 1e-6, `最大坐标差 ${out.videoDiff.toExponential(3)}`);
  console.error(`     每帧耗时：无状态 ${out.statelessMs.toFixed(0)}ms vs VIDEO ${out.videoMs.toFixed(0)}ms` +
    `（无状态更慢是必然：没有跟踪 ROI 加速，每帧都要全图检测）`);
} catch (err) {
  console.error("[FAIL] ", String(err).split("\n")[0]);
  results.push(false);
} finally {
  await browser.close();
  srv.close();
}
const ok = results.length > 0 && results.every(Boolean);
console.error(ok ? "PASS：上传视频的推理可复现" : "FAIL：推理仍不可复现");
process.exit(ok ? 0 : 1);
