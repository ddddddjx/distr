// 移动端原生手感基线回归（E2E，需要浏览器，不进 test:unit）
//   node tests/mobile-polish.mjs
//
// 依据 emilkowalski/skills 的 mobile-native 与 review-animations 标准。
// 这些项一旦被后续改动悄悄回退，手机上就会重新变回"一个网页"：
//   - 缺 viewport-fit=cover：样式里所有 env(safe-area-inset-*) 恒为 0，等于白写；
//   - user-scalable=no：无障碍缺陷；
//   - 缺 touch-action：iOS 上 ~300ms 点击延迟；
//   - 缺 user-select：长按按钮选中文字、弹复制菜单；
//   - 缺 prefers-reduced-motion 降级：前庭敏感用户被位移动画和全屏彩带糊脸。
// 注意：安全区的实际数值只有真机能验，这里只能验"前提条件在不在"。
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
const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.error(`[${pass ? "ok" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
};
try {
  // —— 常规动效 ——
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => getComputedStyle(document.body).overscrollBehaviorY !== "auto",
    { timeout: 10000 }).catch(() => {});

  const meta = await page.getAttribute('meta[name="viewport"]', "content");
  check("viewport 带 viewport-fit=cover（env(safe-area-inset-*) 生效的前提）",
    /viewport-fit\s*=\s*cover/.test(meta), meta);
  check("未禁用缩放（user-scalable=no / maximum-scale 是无障碍缺陷）",
    !/user-scalable\s*=\s*no/.test(meta) && !/maximum-scale/.test(meta));

  const css = await page.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : null;
    };
    return {
      touch: cs("#startBtn", "touchAction"),
      select: cs("#startBtn", "userSelect") || cs("#startBtn", "webkitUserSelect"),
      sizeAdjust: getComputedStyle(document.documentElement).webkitTextSizeAdjust,
      overscroll: getComputedStyle(document.body).overscrollBehaviorY,
      tapHighlight: getComputedStyle(document.documentElement).webkitTapHighlightColor,
      allTransitions: [...document.styleSheets].flatMap((sh) => {
        try { return [...sh.cssRules]; } catch { return []; }
      }).filter((r) => r.style && /(^|[^-])all\b/.test(r.style.transition || "")).length,
      // 安全区变量能被解析（真机上才有非 0 值，这里只验语法与 padding 有被应用）
      topbarPadTop: cs("#topbar", "paddingTop"),
    };
  });
  check("按钮 touch-action: manipulation（消除 ~300ms 点击延迟）", css.touch === "manipulation", css.touch);
  check("按钮 user-select: none（长按不选中文字）", css.select === "none", css.select);
  check("-webkit-text-size-adjust: 100%（横屏不膨胀字体）", css.sizeAdjust === "100%", css.sizeAdjust);
  check("body overscroll-behavior: none（不被下拉刷新劫持）", css.overscroll === "none", css.overscroll);
  check("tap highlight 已清（无灰色闪块）", /rgba\(0, 0, 0, 0\)|transparent/.test(css.tapHighlight), css.tapHighlight);
  check("没有 transition: all（只动 transform/opacity/颜色）", css.allTransitions === 0, `${css.allTransitions} 处`);

  // 数的是"带 :active 的选择器"而不是规则：一条规则可以带多个选择器，
  // 且 @media 里的规则要递归进去才看得到
  const actives = await page.evaluate(() => {
    const out = [];
    const walk = (rules) => {
      for (const r of rules) {
        if (r.cssRules) walk(r.cssRules);
        if (!r.selectorText) continue;
        for (const sel of r.selectorText.split(",")) {
          if (sel.includes(":active")) out.push(sel.trim());
        }
      }
    };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch { /* 跨源 */ } }
    return [...new Set(out)];
  });
  check("按压反馈覆盖面（带 :active 的选择器 ≥ 8 个）", actives.length >= 8,
    `${actives.length} 个：${actives.join(" ")}`);

  const overflow = await page.evaluate(() => ({
    sw: document.scrollingElement.scrollWidth, iw: window.innerWidth,
  }));
  check("393px 无横向溢出", overflow.sw <= overflow.iw + 1, `${overflow.sw} ≤ ${overflow.iw}`);
  check("页面零报错", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // —— 减弱动态效果 ——
  const ctx2 = await browser.newContext({ viewport: { width: 393, height: 852 }, reducedMotion: "reduce" });
  const page2 = await ctx2.newPage();
  await page2.goto(base + "/", { waitUntil: "domcontentloaded" });
  const rm = await page2.evaluate(() => {
    const btn = document.getElementById("startBtn");
    const guide = document.querySelector(".guide-box");
    return {
      btnDur: getComputedStyle(btn).transitionDuration,
      guideAnim: guide ? getComputedStyle(guide).animationName : "none",
      confettiHidden: document.getElementById("confetti").classList.contains("hidden"),
    };
  });
  const durOk = rm.btnDur.split(",").every((d) => parseFloat(d) <= 0.13);
  check("减弱动态：过渡被压到 ≤0.12s（保留反馈，去掉观感位移）", durOk, rm.btnDur);
  check("减弱动态：引导框呼吸循环已停", rm.guideAnim === "none", rm.guideAnim);
  await ctx2.close();
} catch (err) {
  console.error("[FAIL] ", String(err).split("\n")[0]);
  results.push(false);
} finally {
  await browser.close();
  srv.close();
}
const ok = results.length > 0 && results.every(Boolean);
console.error(ok ? "PASS：移动端原生手感基线达标" : "FAIL：有项目不达标");
console.error("注意：安全区的实际数值（刘海/home indicator）只有真机能验，这里只验前提条件。");
process.exit(ok ? 0 : 1);
