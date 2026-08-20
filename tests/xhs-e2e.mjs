// 小红书小工具版功能级 E2E：视频装载、播放控制、逐帧、画线、
// 冻结帧对比、节奏计时、自查清单与本地持久化。
// 用法：node tests/xhs-e2e.mjs [videoPath]（默认 tests/assets/synthetic.webm）
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(REPO, "xhs-tool");
const videoPath = path.resolve(process.argv[2] || path.join(REPO, "tests/assets/synthetic.webm"));

const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png" };
const server = http.createServer((req, res) => {
  let fp = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (fp.endsWith(path.sep)) fp = path.join(fp, "index.html");
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(0, r));

const browser = await chromium.launch({
  executablePath: fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });

const results = {};
const ok = (name, cond) => { results[name] = !!cond; if (!cond) process.exitCode = 1; };

try {
  await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: "load" });

  // 1. 选择视频
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click("#pickBtn")]);
  await fc.setFiles(videoPath);
  await page.waitForFunction(() => {
    const v = document.getElementById("video");
    return v && v.duration > 0;
  }, { timeout: 15000 });
  ok("视频装载", true);
  ok("播放器显示", await page.isVisible("#playBtn"));

  // 2. 播放/暂停 + 倍速
  await page.click("#playBtn");
  await page.waitForTimeout(700);
  const playing = await page.evaluate(() => !document.getElementById("video").paused);
  await page.click("#playBtn");
  ok("播放暂停", playing && (await page.evaluate(() => document.getElementById("video").paused)));
  await page.click('[data-speed="0.25"]');
  ok("倍速切换", (await page.evaluate(() => document.getElementById("video").playbackRate)) === 0.25);

  // 3. 逐帧步进
  const t0 = await page.evaluate(() => document.getElementById("video").currentTime);
  await page.click("#stepFwd");
  await page.waitForTimeout(300);
  const t1 = await page.evaluate(() => document.getElementById("video").currentTime);
  ok("逐帧步进", t1 > t0);

  // 4. 画线：两次点击成一条线 → 画布出现非透明像素
  const box = await page.locator("#draw").boundingBox();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.7);
  const drawn = await page.evaluate(() => {
    const c = document.getElementById("draw");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 400) if (d[i] > 0) return true;
    return false;
  });
  ok("画线绘制", drawn);
  await page.click("#clearBtn");
  const cleared = await page.evaluate(() => {
    const c = document.getElementById("draw");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 400) if (d[i] > 0) return false;
    return true;
  });
  ok("清空画线", cleared);

  // 5. 量角器：三点显示角度
  await page.click('[data-tool="angle"]');
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.2);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.4);
  ok("量角器", await page.evaluate(() => {
    const c = document.getElementById("draw");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 40) if (d[i] > 0) return true;
    return false;
  }));
  await page.screenshot({ path: path.join(REPO, "tests/output/xhs-player.png") });

  // 6. 冻结帧对比
  await page.click('[data-tab="compare"]');
  await page.click("#capA");
  ok("冻结帧A", await page.isVisible("#ghost"));
  ok("透明度条", await page.isVisible("#ghostAlpha"));
  await page.click("#ghostOff");
  ok("关闭叠加", !(await page.isVisible("#ghost")));

  // 7. 节奏计时（按视频时间轴）
  await page.click('[data-tab="tempo"]');
  await page.evaluate(() => { document.getElementById("video").currentTime = 1.0; });
  await page.click("#tapStart");
  await page.evaluate(() => { document.getElementById("video").currentTime = 2.5; });
  await page.click("#tapTop");
  await page.evaluate(() => { document.getElementById("video").currentTime = 3.0; });
  await page.click("#tapImpact");
  const tempoText = await page.textContent("#tempoResult");
  ok("节奏计算", /3\.0\s*:\s*1/.test(tempoText.replace(/\s+/g, " ")));

  // 8. 自查清单：标记并持久化
  await page.click('[data-tab="check"]');
  const cards = await page.$$(".check-card");
  ok("清单12项", cards.length === 12);
  await cards[0].click();
  await page.reload({ waitUntil: "load" });
  const persisted = await page.evaluate(() => {
    try { return Object.values(JSON.parse(localStorage.getItem("swingChecks"))).some(Boolean); }
    catch (e) { return false; }
  });
  ok("标记持久化", persisted);
} catch (err) {
  errs.push("FATAL: " + String(err).slice(0, 300));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify({ results, errs }, null, 2));
