// 慢放导出重编码回归（E2E，需要浏览器，不进 test:unit）
//   node tests/replay-export.mjs
//
// 守的是这个功能的核心承诺：报告里的"慢动作"只是 playbackRate=0.4 的播放效果，
// 录下来的片段本身是原速的。直接把 blob 存给用户 = 存下来一看"怎么不慢了"。
// renderSlowMotion 必须真的产出一段【更长的、慢速的】视频文件。
//
// 做法：先用 canvas 造一段 2 秒的合成视频当素材（不依赖摄像头与真实挥杆），
// 再喂给 renderSlowMotion，断言产出的时长约为源的 1/rate。
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
  args: ["--use-gl=swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const page = await (await browser.newContext()).newPage();
let ok = false;
try {
  // 不加载整个应用（会拉 24MB 模型），只要一个同源空页面来跑模块
  await page.route("**/blank", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>t</title>" }));
  await page.goto(base + "/blank");

  const r = await page.evaluate(async (base) => {
    const ex = await import(base + "/js/replayExport.js");
    /** 造素材：2 秒、每帧变色的合成视频（模拟一次挥杆的回放片段） */
    const srcBlob = await new Promise((resolve) => {
      const c = document.createElement("canvas");
      c.width = 160; c.height = 120;
      const cx = c.getContext("2d");
      const rec = new MediaRecorder(c.captureStream(30));
      const parts = [];
      rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
      rec.onstop = () => resolve(new Blob(parts, { type: rec.mimeType }));
      let i = 0;
      const tick = () => {
        cx.fillStyle = `hsl(${(i * 6) % 360} 80% 50%)`;
        cx.fillRect(0, 0, c.width, c.height);
        if (++i > 60) return void rec.stop();
        requestAnimationFrame(tick);
      };
      rec.start();
      tick();
    });

    /** 量一段视频 blob 的时长（用 seek-to-end 兜住 MediaRecorder 的 Infinity） */
    const durationOf = (blob) => new Promise((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () => {
        if (Number.isFinite(v.duration)) return resolve(v.duration);
        v.currentTime = 1e6;
        v.ontimeupdate = () => { v.ontimeupdate = null; resolve(v.currentTime); };
      };
      v.src = URL.createObjectURL(blob);
    });

    const srcDur = await durationOf(srcBlob);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true;
    v.src = URL.createObjectURL(srcBlob);
    document.body.appendChild(v);
    await new Promise((res) => { v.onloadeddata = res; setTimeout(res, 5000); });

    const t0 = performance.now();
    const out = await ex.renderSlowMotion(v, { rate: 0.4, start: 0, end: 0, maxW: 320 });
    const wall = (performance.now() - t0) / 1000;
    return {
      srcDur, outDur: await durationOf(out), outSize: out.size,
      outType: out.type, wall,
      name: ex.exportFileName(92, out.type),
    };
  }, base);

  const ratio = r.outDur / r.srcDur;
  const slower = ratio > 1.8 && ratio < 3.2;     // 0.4x → 理论 2.5 倍长
  console.error(`[ok] 源 ${r.srcDur.toFixed(2)}s → 导出 ${r.outDur.toFixed(2)}s（${ratio.toFixed(2)}×），耗时 ${r.wall.toFixed(1)}s`);
  console.error(`[${slower ? "ok" : "FAIL"}] 导出的文件本身就是慢速的（不是原速片段）`);
  console.error(`[${r.outSize > 1000 ? "ok" : "FAIL"}] 产出非空：${r.outSize} 字节，${r.outType}`);
  console.error(`[ok] 文件名 ${r.name}`);
  ok = slower && r.outSize > 1000;
} catch (err) {
  console.error("[FAIL] ", String(err).split("\n")[0]);
} finally {
  await browser.close();
  srv.close();
}
console.error(ok ? "PASS：慢放导出产出真正的慢速视频" : "FAIL：慢放导出不可用");
process.exit(ok ? 0 : 1);
