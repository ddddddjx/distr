// 上传视频分析的确定性回归（E2E，需要浏览器，不进 test:unit）
//   node tests/deterministic-analysis.mjs
//
// 守的是线上事故：同一段上传视频，两次分析给出不同分数。
// 旧实现"边播边抽帧"——视频实时播放，rAF 拿到哪一帧取决于当时手机有多忙
// （推理同步阻塞，一帧几十到几百毫秒）；评分又是逐帧取最大偏差，抽到的帧不同
// 分数就不同。实测两遍抽到的帧重合度只有 6%。
//
// 这里断言三件事：
//   1. 分析期间视频【不播放】（一播放就又回到"抽到哪帧看运气"）；
//   2. 两次分析走过的帧时刻【完全一致】；
//   3. 步长固定（跟 frameGrid 的采样率一致）。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCAN_PARAMS } from "../js/scanWindows.js";

const SCAN_COARSE_FPS = SCAN_PARAMS.coarseFps;

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
const page = await (await browser.newContext({ viewport: { width: 393, height: 852 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.error(`[${pass ? "ok" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
};
try {
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  console.error("等模型加载…（无头环境较慢）");
  await page.waitForSelector("#chooser:not(.hidden)", { timeout: 240000 });

  // 造一段 2 秒的合成视频当素材（检不到人也没关系：这条测试验的是
  // “走过哪些帧”，不是评分内容本身）
  const webm = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 160; c.height = 120;
    const cx = c.getContext("2d");
    const rec = new MediaRecorder(c.captureStream(30)); const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const done = new Promise((r) => (rec.onstop = () => r()));
    rec.start();
    let i = 0;
    await new Promise((r) => { const t = setInterval(() => {
      cx.fillStyle = `hsl(${(i * 6) % 360} 70% 50%)`; cx.fillRect(0, 0, 160, 120);
      if (++i > 60) { clearInterval(t); r(); } }, 33); });
    rec.stop(); await done;
    return Array.from(new Uint8Array(await new Blob(parts, { type: rec.mimeType }).arrayBuffer()));
  });

  // 记录每次 seek 落点：给 video.currentTime 的 setter 装探针
  await page.evaluate(() => {
    window.__seeks = [];
    const proto = HTMLMediaElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, "currentTime");
    Object.defineProperty(proto, "currentTime", {
      get() { return d.get.call(this); },
      set(v) { if (this.id === "video") window.__seeks.push(+v.toFixed(4)); d.set.call(this, v); },
      configurable: true,
    });
  });

  // 不点「上传视频分析」：那个按钮会拉起原生文件选择器，Playwright 会卡住。
  // 直接喂 input，change 事件同样会走进 enterFileMode
  await page.evaluate(() => document.getElementById("chooser").classList.add("hidden"));
  await page.setInputFiles("#videoInput", {
    name: "swing.webm", mimeType: "video/webm", buffer: Buffer.from(webm),
  });
  await page.waitForFunction(
    () => document.getElementById("stage").classList.contains("file-mode") &&
          document.getElementById("video").readyState >= 1,
    null, { timeout: 30000 } // waitForFunction 的第三个参数才是 options
  );

  const runOnce = async () => {
    await page.evaluate(() => { window.__seeks = []; window.__playedDuring = false; });
    await page.click("#startBtn");
    // 分析期间反复确认视频没有在播
    const watcher = page.evaluate(() => new Promise((res) => {
      const v = document.getElementById("video");
      // 逐帧分析期间画面不能是黑的。iOS 上"暂停 + seek"的 video 元素不往屏幕
      // 合成，必须我们自己把帧画进 overlay——用户实测过：改完之后一片全黑。
      window.__sawPixels = false;
      const ov = document.getElementById("overlay");
      const probe = setInterval(() => {
        try {
          const g = ov.getContext("2d");
          const d = g.getImageData(Math.floor(ov.width / 2), Math.floor(ov.height / 2), 1, 1).data;
          if (d[0] + d[1] + d[2] > 24) window.__sawPixels = true;
        } catch (e) { /* 画布还没尺寸 */ }
      }, 60);
      const t = setInterval(() => { if (!v.paused) window.__playedDuring = true; }, 30);
      const stop = setInterval(() => {
        if (document.getElementById("startBtn").textContent.includes("开始")) {
          clearInterval(t); clearInterval(stop); clearInterval(probe); res(window.__playedDuring);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(t); clearInterval(stop); clearInterval(probe); res(window.__playedDuring);
      }, 120000);
    }));
    const played = await watcher;
    const seeks = await page.evaluate(() => window.__seeks.slice());
    const sawPixels = await page.evaluate(() => window.__sawPixels === true);
    // 关掉可能弹出的报告，回到可再次分析的状态
    await page.evaluate(() => {
      const m = document.getElementById("summaryModal");
      if (!m.classList.contains("hidden")) document.getElementById("closeSummary").click();
    });
    return { played, seeks, sawPixels };
  };

  const a = await runOnce();
  const b = await runOnce();

  check("分析期间视频不播放（一播放就又回到「抽到哪帧看运气」）", !a.played && !b.played);
  check("分析期间画面不是黑的（iOS 上暂停+seek 的 video 不合成，帧要自己画）",
    a.sawPixels && b.sawPixels, `第一遍 ${a.sawPixels} / 第二遍 ${b.sawPixels}`);
  check("两次走过的帧时刻完全一致",
    a.seeks.length > 5 && a.seeks.length === b.seeks.length &&
    a.seeks.every((x, i) => x === b.seeks[i]),
    `第一遍 ${a.seeks.length} 帧 / 第二遍 ${b.seeks.length} 帧，前 5 个：${a.seeks.slice(0, 5).join(" ")} vs ${b.seeks.slice(0, 5).join(" ")}`);
  // seek 分两段：先是 1/6s 的帧差粗扫（定位"有动作且击到球"的区间），
  // 再是 1/12s 的逐帧推理。步长要分别看，混在一起断言必然打架
  const gaps = a.seeks.slice(1).map((x, i) => +(x - a.seeks[i]).toFixed(4));
  check("先跑廉价粗扫定位（1/6s 步长，不做任何推理）",
    gaps.length > 3 && Math.abs(gaps[1] - 1 / SCAN_COARSE_FPS) < 1e-3,
    `${gaps[1]}s ≈ 1/${SCAN_COARSE_FPS}s`);
  const tail = gaps.slice(-6, -1); // 末一格会被片尾截短，不参与
  check("推理阶段采样步长固定（与 frameGrid 的 FILE_SAMPLE_FPS 一致）",
    tail.length > 0 && tail.every((g) => Math.abs(g - 1 / 12) < 1e-3),
    `${tail.join(" ")} ≈ 1/12s`);
  check("页面零报错", errors.length === 0, errors.join(" | "));
} catch (err) {
  console.error("[FAIL] ", String(err).split("\n")[0]);
  results.push(false);
} finally {
  await browser.close();
  srv.close();
}
const ok = results.length > 0 && results.every(Boolean);
console.error(ok ? "PASS：同一段视频两次分析走过完全相同的帧" : "FAIL：分析仍不确定");
process.exit(ok ? 0 : 1);
