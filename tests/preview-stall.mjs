// 实时模式预览卡死恢复回归（E2E，需要浏览器，不进 test:unit）
//   node tests/preview-stall.mjs
//
// 复现过的线上事故：实时拍摄打完第一杆出了报告，点「继续练习」之后无论怎么
// 挥都再也识别不到挥杆。根因不在状态机——iOS 播完报告里的慢放回放会把摄像头
// 预览的 <video> 暂停（严重时直接中断采集轨道），video.currentTime 不再前进，
// PoseDetector.detect() 于是每一帧都返回 undefined，一帧都不再推理。页面看起来
// 一切正常（rAF 照转、FPS 还显示 60），就是永远等不到第二杆。
//
// 这里用假摄像头启动分析，然后把预览元素按 iOS 的方式暂停，验证看门狗能把
// 画面救回来、推理继续跑。
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
  args: [
    "--use-gl=swiftshader",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 },
  permissions: ["camera"],
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

/** 预览是否还在出新帧：连续两次采样 currentTime 必须前进 */
const framesFlowing = async (ms = 700) =>
  page.evaluate(async (ms) => {
    const v = document.getElementById("video");
    const t0 = v.currentTime;
    await new Promise((r) => setTimeout(r, ms));
    return v.currentTime > t0;
  }, ms);

let ok = false;
try {
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  // 模型加载 + 预热（无头环境首帧推理很慢）
  await page.waitForSelector("#chooser:not(.hidden)", { timeout: 180000 });
  console.error("[ok] 模型加载完成");
  await page.click("#chooseLive");
  await page.waitForFunction(() => document.getElementById("video").videoWidth > 0, { timeout: 30000 });
  await page.click("#closeOnboard").catch(() => {});
  await page.click("#startBtn");
  await page.waitForFunction(() => document.getElementById("startBtn").textContent.includes("停止"), { timeout: 10000 });
  const flowing0 = await framesFlowing();
  console.error(`[${flowing0 ? "ok" : "FAIL"}] 分析中预览正常出帧`);

  // ——— 复现 iOS 的表现：报告回放播完后预览元素被系统暂停 ———
  await page.evaluate(() => document.getElementById("video").pause());
  const stalled = !(await framesFlowing(400));
  console.error(`[${stalled ? "ok" : "skip"}] 预览已被暂停（currentTime 停住）`);

  // 看门狗 STALL_MS=1500ms 后介入，留足余量
  await page.waitForTimeout(3500);
  const recovered = await framesFlowing();
  console.error(`[${recovered ? "ok" : "FAIL"}] 看门狗把预览救了回来，推理继续`);

  // 恢复后 FPS 面板必须重新有读数（FPS 只统计真正推理的帧）
  await page.waitForTimeout(1200);
  const fps = parseInt(await page.textContent("#fpsLabel"), 10);
  console.error(`[${fps > 0 ? "ok" : "FAIL"}] 恢复后 FPS = ${fps}`);

  // ——— 更严重的一档：采集轨道被系统回收（iOS 把相机整个抢走） ———
  await page.evaluate(() =>
    document.getElementById("video").srcObject.getVideoTracks().forEach((t) => t.stop())
  );
  await page.waitForTimeout(4000); // 看门狗判定 → 重新 getUserMedia
  const reopened = await framesFlowing();
  console.error(`[${reopened ? "ok" : "FAIL"}] 轨道被回收后自动重开摄像头，画面恢复`);

  ok = flowing0 && recovered && fps > 0 && reopened && errors.length === 0;
  if (errors.length) console.error("[FAIL] 页面报错：", errors.join(" | "));
} catch (err) {
  console.error("[FAIL] ", String(err).split("\n")[0]);
} finally {
  await browser.close();
  srv.close();
}
console.error(ok ? "PASS：预览卡死可自动恢复" : "FAIL：预览卡死后无法恢复");
process.exit(ok ? 0 : 1);
