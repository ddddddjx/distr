// 击球区间定位回归（E2E，需要浏览器，不进 test:unit）
//   node tests/strike-window.mjs
//
// 守的是逐帧分析的成本：整段扫描每帧推理 380–450ms，20 秒素材要跑一分半，
// 而真正有用的只有击球前后那几秒。这里造一段【带击球声】的合成视频，
// 断言 app 只对击球区间做推理：
//   1. 除了起始归零，所有 seek 都落在击球窗口内（前面架机位、后面捡球不陪跑）；
//   2. 实际推理的帧数比整段网格少一大截；
//   3. 走音频路径时不再跑帧差粗扫（听得到击球就不用看画面）；
//   4. 报告照出——省帧不能省掉结果。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCAN_PARAMS } from "../js/scanWindows.js";
import { FILE_SAMPLE_FPS } from "../js/frameGrid.js";

const DUR = 9;      // 素材时长（秒）
const STRIKE = 5;   // 击球声位置（秒）

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

  // 造素材：画面持续变化（保证帧差粗扫也会有意见），音轨在 STRIKE 秒处
  // 放一段 30ms 白噪爆发——正是击球那种"几毫秒内能量跃升数倍"的瞬态
  console.error(`录制 ${DUR} 秒合成素材（含 ${STRIKE}s 处的击球声）…`);
  const webm = await page.evaluate(async ({ DUR, STRIKE }) => {
    const c = document.createElement("canvas"); c.width = 160; c.height = 120;
    const cx = c.getContext("2d");
    const ac = new AudioContext();
    const dst = ac.createMediaStreamDestination();
    // 白噪爆发
    const len = Math.round(ac.sampleRate * 0.03);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
    // 环境底噪：没有它 Chromium 录不出连续音轨（实测整段静音、音轨时长也对不上），
    // 而真实素材本来就有底噪——检测本来就是"相对本底跃升"
    const floor = ac.createOscillator(); const fg = ac.createGain();
    fg.gain.value = 0.002; floor.frequency.value = 220;
    floor.connect(fg); fg.connect(dst); floor.start();
    const stream = new MediaStream([
      ...c.captureStream(30).getVideoTracks(),
      ...dst.stream.getAudioTracks(),
    ]);
    const rec = new MediaRecorder(stream); const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const done = new Promise((r) => (rec.onstop = () => r()));
    rec.start();
    const t0 = performance.now();
    const src = ac.createBufferSource(); src.buffer = buf; src.connect(dst);
    src.start(ac.currentTime + STRIKE);
    let i = 0;
    await new Promise((r) => { const t = setInterval(() => {
      cx.fillStyle = `hsl(${(i++ * 6) % 360} 70% 50%)`; cx.fillRect(0, 0, 160, 120);
      if (performance.now() - t0 > DUR * 1000) { clearInterval(t); r(); } }, 33); });
    rec.stop(); await done; ac.close();
    const blob = new Blob(parts, { type: rec.mimeType });
    window.__material = blob; // app 的 change 处理会清空 input.files，留一份自己用
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, { DUR, STRIKE });

  // 记录每次 seek 落点
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
  // 不点「上传视频分析」：那个按钮会拉起原生文件选择器，Playwright 会卡住
  await page.evaluate(() => document.getElementById("chooser").classList.add("hidden"));
  await page.setInputFiles("#videoInput", {
    name: "swing.webm", mimeType: "video/webm", buffer: Buffer.from(webm),
  });
  try {
    await page.waitForFunction(
      () => document.getElementById("stage").classList.contains("file-mode") &&
            document.getElementById("video").readyState >= 1,
      null, { timeout: 30000 }
    );
  } catch (e) {
    console.error("[debug] " + JSON.stringify(await page.evaluate(() => ({
      cls: document.getElementById("stage").className,
      rs: document.getElementById("video").readyState,
      err: document.getElementById("video").error?.code ?? null,
      src: document.getElementById("video").src.slice(0, 40),
    }))));
    throw e;
  }
  const duration = await page.evaluate(() => document.getElementById("video").duration);
  // 用 app 同一套代码算出击球声的真实位置：合成素材的音轨起点与视频未必对齐
  // （实测录出来的 opus 轨比视频短），拿录制时的墙钟时刻当基准会对不上
  const audio = await page.evaluate(async () => {
    const mod = await import("/js/strikeAudio.js");
    const f = window.__material; // input.files 已被 app 清空（允许重选同一文件）
    const out = { size: f?.size ?? null, peaks: await mod.extractImpactTimes(f) };
    if (!out.peaks) {
      // extractImpactTimes 把失败一律吞成 null（产品里该降级），测试要看见原因
      try {
        const ac = new AudioContext();
        const buf = await ac.decodeAudioData(await f.arrayBuffer());
        out.adur = buf.duration;
        out.peaksRaw = mod.detectTransients(buf.getChannelData(0), buf.sampleRate);
        ac.close();
      } catch (e) { out.err = e.name + ": " + e.message; }
    }
    return out;
  });
  const peaks = audio.peaks;
  check("合成素材里的击球声检得到（检不到就退化成帧差粗扫，这条测试也就没意义了）",
    Array.isArray(peaks) && peaks.length > 0, JSON.stringify(audio));
  const strikeT = Array.isArray(peaks) && peaks.length ? peaks[0] : STRIKE;

  await page.evaluate(() => { window.__seeks = []; });
  await page.click("#startBtn");
  await page.waitForFunction(
    () => document.getElementById("startBtn").textContent.includes("开始") ||
          document.getElementById("startBtn").textContent.includes("重新"),
    null, { timeout: 300000 } // waitForFunction 的第三个参数才是 options
  );
  const seeks = await page.evaluate(() => window.__seeks.slice());
  const stepped = seeks.filter((t, i) => i > 0 || t !== 0); // 起始归零不算推理帧
  const pks = Array.isArray(peaks) && peaks.length ? peaks : [strikeT];
  const inSome = (t) => pks.some(
    (pk) => t >= pk - SCAN_PARAMS.preS - 0.1 && t <= pk + SCAN_PARAMS.postS + 0.1
  );
  const outside = stepped.filter((t) => !inSome(t));
  const fullGrid = Math.floor(duration * FILE_SAMPLE_FPS) + 1;

  check("只对击球区间做推理（区间外一帧都不碰）",
    stepped.length > 10 && outside.length === 0,
    `共 ${stepped.length} 帧，击球声 ${pks.map((x) => x.toFixed(2)).join("/")}s，`
    + `越界 ${outside.length} 帧：${outside.slice(0, 5).join(" ")}`);
  check("帧数比整段扫描少一大截",
    stepped.length < fullGrid * 0.75,
    `${stepped.length} 帧 vs 整段 ${fullGrid} 帧，省 ${Math.round((1 - stepped.length / fullGrid) * 100)}%`);
  const gaps = stepped.slice(1).map((x, i) => +(x - stepped[i]).toFixed(4));
  check("听到击球声就不必再跑帧差粗扫（没有 1/6s 的粗网格步长）",
    gaps.every((g) => Math.abs(g - 1 / SCAN_PARAMS.coarseFps) > 1e-3),
    `步长样本：${gaps.slice(0, 4).join(" ")}`);
  check("页面零报错", errors.length === 0, errors.join(" | "));
} catch (err) {
  console.error("[FAIL] ", String(err).split("\n")[0]);
  results.push(false);
} finally {
  await browser.close();
  srv.close();
}
const ok = results.length > 0 && results.every(Boolean);
console.error(ok ? "PASS：只对「有动作且击到球」的区间做了推理" : "FAIL：区间定位没生效");
process.exit(ok ? 0 : 1);
