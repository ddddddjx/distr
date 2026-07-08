// SwingCoach 端到端回归测试：
// 用 Playwright 驱动真实应用（无头 Chromium），程序化上传挥杆视频，
// 监听阶段流转并提取最终报告，输出 JSON 结果。
//
// 用法：
//   node tests/run-video-test.mjs                              # 冒烟测试
//   node tests/run-video-test.mjs tests/assets/a.webm [front|side] [playbackRate]
//
// 注意：Playwright 的 Chromium 不含 H.264 解码器，iPhone 拍摄的 mov/mp4
// 需先转成 WebM：ffmpeg -i in.mov -vf scale=720:-2 -c:v libvpx -b:v 1.5M -an out.webm
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const videoPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const view = process.argv[3] === "side" ? "side" : "front";
const playbackRate = Number(process.argv[4] || 2);

const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".wasm": "application/wasm",
  ".task": "application/octet-stream", ".webm": "video/webm", ".mp4": "video/mp4",
};

function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let fp = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

const result = {
  ok: false, mode: videoPath ? "video" : "smoke",
  phases: [], swings: null, score: null, tier: null, note: null,
  faults: [], consoleErrors: [],
};

const server = await serve();
const base = `http://localhost:${server.address().port}`;
// 优先用环境预装的 Chromium（版本可能与 npm playwright 期望的不一致）
const PREINSTALLED = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({
  executablePath: fs.existsSync(PREINSTALLED) ? PREINSTALLED : undefined,
  args: ["--use-gl=swiftshader", "--disable-web-security"],
});
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") result.consoleErrors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => result.consoleErrors.push("PAGEERROR: " + String(e).slice(0, 300)));

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  // 等模型加载完成、进入模式选择页（首次要读 25MB 本地模型，放宽到 3 分钟）
  await page.waitForSelector("#chooser:not(.hidden)", { timeout: 180000 });
  console.error("[ok] 应用启动完成，模型已加载");

  if (videoPath) {
    // 记录阶段流转
    await page.evaluate(() => {
      window.__phases = [];
      const pill = document.getElementById("phasePill");
      new MutationObserver(() => {
        const t = pill.textContent;
        const last = window.__phases[window.__phases.length - 1];
        if (!last || last.p !== t) window.__phases.push({ t: Date.now(), p: t });
      }).observe(pill, { childList: true, characterData: true, subtree: true });
    });

    const [fc] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.click("#chooseUpload"),
    ]);
    await fc.setFiles(videoPath);
    await page.waitForFunction(
      () => document.getElementById("phasePill").textContent.includes("就绪"),
      { timeout: 30000 }
    );
    const duration = await page.evaluate(() => document.getElementById("video").duration);
    console.error(`[ok] 视频已装载，时长 ${duration.toFixed(1)}s，机位=${view}，${playbackRate}x 速分析`);

    if (view === "side") await page.click('#viewSeg button[data-view="side"]');
    await page.click("#startBtn");
    await page.evaluate((r) => {
      document.getElementById("video").playbackRate = r;
    }, playbackRate);

    // 诊断轮询：观察推理帧率与阶段流转（DEBUG=1 时打印）
    const poller = setInterval(async () => {
      const s = await page.evaluate(() => ({
        pill: document.getElementById("phasePill").textContent,
        fps: document.getElementById("fpsLabel").textContent,
        t: +document.getElementById("video").currentTime.toFixed(1),
        ended: document.getElementById("video").ended,
      })).catch(() => null);
      if (s && process.env.DEBUG) console.error(`[poll] t=${s.t}s ${s.pill} ${s.fps} ended=${s.ended}`);
    }, 2000);

    try {
      // 等报告弹出（播完或中途自然收束）
      await page.waitForSelector("#summaryModal:not(.hidden)", {
        timeout: (duration / playbackRate) * 1000 * 1.5 + 60000,
      });
    } finally {
      clearInterval(poller);
      result.phases = await page
        .evaluate(() => window.__phases.map((x) => x.p))
        .catch(() => []);
    }
    await page.waitForTimeout(1000); // 等分数滚动动画结束再取值
    result.note = await page.textContent("#summaryNote").catch(() => null);
    result.score = (await page.textContent("#summaryScore")).trim();
    result.roast = (await page.textContent("#summaryRoast").catch(() => "")).trim();
    result.tempo = (await page.textContent("#summaryTempo").catch(() => "")).trim();
    result.tier = (await page.textContent("#summaryTier")).trim();
    result.faults = await page.$$eval(".summary-item .si-title", (els) =>
      els.map((e) => e.textContent.trim())
    );
    // 导出报告中的标注截图，便于人工核对可视化效果
    const outDir = path.join(ROOT, "tests", "output");
    fs.mkdirSync(outDir, { recursive: true });
    const shots = await page.$$eval(".summary-item .si-shot", (els) => els.map((e) => e.src));
    shots.forEach((src, i) => {
      const b64 = src.split(",")[1];
      if (b64) fs.writeFileSync(path.join(outDir, `fault-${i}.jpg`), Buffer.from(b64, "base64"));
    });
    result.shotFiles = shots.length;
    const m = (result.note || "").match(/(\d+)\s*次/);
    result.swings = m ? Number(m[1]) : 1;
  }
  result.ok = true;
} catch (err) {
  result.error = String(err).slice(0, 500);
} finally {
  await browser.close();
  server.close();
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
