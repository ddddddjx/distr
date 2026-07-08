// 分享卡生成：把挥杆报告 / 周报战报绘制成适合发小红书、朋友圈的成绩图。
// 纯 Canvas 本地生成，1080×1440 竖版；底部带扫码入口构成传播闭环。
const W = 1080, H = 1440;
const FONT = `-apple-system, 'PingFang SC', 'Noto Sans SC', sans-serif`;
const GREEN = "#30d158";

// 段位体系：给分享一个可炫耀的身份钩子
const TIERS = [
  [90, "巡回赛胚子"],
  [80, "单差点苗子"],
  [70, "稳健铁杆"],
  [60, "球道学徒"],
  [0, "果岭新芽"],
];

export function tierOf(score) {
  return TIERS.find(([min]) => score >= min)[1];
}

/** 按分数估算超越比例（本地估算值，用于社交传播语） */
export function percentileOf(score) {
  return Math.max(1, Math.min(99, Math.round((score - 52) * 2.1)));
}

const loadImage = (src) =>
  new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 将图片按 cover 方式裁剪绘制进圆角矩形 */
function drawCover(ctx, img, x, y, w, h, r) {
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

function newCanvas() {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  // 背景：深色渐变 + 顶部隐约绿光
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0c1510");
  g.addColorStop(1, "#080b09");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, -100, 50, W / 2, -100, 700);
  glow.addColorStop(0, "rgba(48,209,88,0.22)");
  glow.addColorStop(1, "rgba(48,209,88,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 700);
  return [c, ctx];
}

function drawHeader(ctx, subtitle) {
  ctx.fillStyle = GREEN;
  ctx.beginPath();
  ctx.arc(84, 96, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `700 44px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("SwingCoach", 116, 112);
  ctx.fillStyle = "rgba(235,245,237,0.55)";
  ctx.font = `400 30px ${FONT}`;
  ctx.fillText(subtitle, 116, 158);
  const d = new Date();
  ctx.textAlign = "right";
  ctx.fillText(`${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`, W - 84, 112);
}

async function drawFooter(ctx) {
  // 白色圆角容器放二维码，左侧传播文案
  const qr = await loadImage("assets/qr.png");
  const fy = H - 260;
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  roundRect(ctx, 60, fy, W - 120, 200, 24);
  ctx.fill();
  if (qr) {
    ctx.fillStyle = "#fff";
    roundRect(ctx, W - 260, fy + 20, 160, 160, 16);
    ctx.fill();
    ctx.drawImage(qr, W - 250, fy + 30, 140, 140);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "#fff";
  ctx.font = `600 36px ${FONT}`;
  ctx.fillText("扫码测测你的挥杆能打几分", 100, fy + 82);
  ctx.fillStyle = "rgba(235,245,237,0.5)";
  ctx.font = `400 26px ${FONT}`;
  ctx.fillText("免费 AI 挥杆分析 · 视频不上传 · 无需安装", 100, fy + 132);
}

/** 单次挥杆成绩卡 */
export async function buildSwingCard(summary, keyframes) {
  const [c, ctx] = newCanvas();
  drawHeader(ctx, "AI 挥杆教练");

  // 大分数 + 段位
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.font = `800 300px ${FONT}`;
  ctx.fillText(String(summary.score), W / 2, 480);
  ctx.font = `500 44px ${FONT}`;
  ctx.fillStyle = "rgba(235,245,237,0.6)";
  ctx.fillText("AI 挥杆评分", W / 2, 550);

  const tier = tierOf(summary.score);
  ctx.font = `700 46px ${FONT}`;
  const tw = ctx.measureText(tier).width + 88;
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 3;
  roundRect(ctx, (W - tw) / 2, 590, tw, 84, 42);
  ctx.stroke();
  ctx.fillStyle = GREEN;
  ctx.fillText(tier, W / 2, 648);

  ctx.fillStyle = "#fff";
  ctx.font = `500 40px ${FONT}`;
  ctx.fillText(`预估击败 ${percentileOf(summary.score)}% 的球友`, W / 2, 740);

  // 关键位置四宫格
  const order = [["address", "准备"], ["top", "顶点"], ["impact", "击球"], ["finish", "收杆"]];
  const shots = order.filter(([k]) => keyframes.has(k));
  if (shots.length) {
    const gap = 18, cw = (W - 120 - gap * (shots.length - 1)) / shots.length;
    const ch = cw * 1.25, y0 = 800;
    for (let i = 0; i < shots.length; i++) {
      const img = await loadImage(keyframes.get(shots[i][0]));
      const x = 60 + i * (cw + gap);
      if (img) drawCover(ctx, img, x, y0, cw, ch, 16);
      ctx.fillStyle = "rgba(235,245,237,0.55)";
      ctx.font = `400 26px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(shots[i][1], x + cw / 2, y0 + ch + 40);
    }
  }

  // 节奏 + 主要问题
  let y = 1120;
  ctx.textAlign = "center";
  if (summary.tempo) {
    ctx.fillStyle = "rgba(235,245,237,0.75)";
    ctx.font = `400 32px ${FONT}`;
    ctx.fillText(`挥杆节奏 ${summary.tempo.ratio.toFixed(1)} : 1（职业参考 3:1）`, W / 2, y);
    y += 54;
  }
  if (summary.faults.length) {
    ctx.fillStyle = "rgba(235,245,237,0.55)";
    ctx.font = `400 30px ${FONT}`;
    const names = summary.faults.slice(0, 2).map((f) => f.rule.title).join(" · ");
    ctx.fillText(`AI 建议改进：${names}`, W / 2, y);
  } else {
    ctx.fillStyle = GREEN;
    ctx.font = `500 32px ${FONT}`;
    ctx.fillText("本次挥杆没有检测到明显问题", W / 2, y);
  }

  await drawFooter(ctx);
  return c.toDataURL("image/jpeg", 0.9);
}

/** 本周战报卡 */
export async function buildWeeklyCard(st) {
  const [c, ctx] = newCanvas();
  drawHeader(ctx, "本周挥杆战报");

  // 三个核心数字
  const cells = [
    [String(st.week.count), "本周挥杆"],
    [String(st.week.score || "—"), "平均分"],
    [st.week.tempo ? `${st.week.tempo}:1` : "—", "平均节奏"],
  ];
  const cw = (W - 120 - 36) / 3;
  cells.forEach(([num, label], i) => {
    const x = 60 + i * (cw + 18);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    roundRect(ctx, x, 240, cw, 190, 20);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.font = `800 76px ${FONT}`;
    ctx.fillText(num, x + cw / 2, 350);
    ctx.fillStyle = "rgba(235,245,237,0.55)";
    ctx.font = `400 28px ${FONT}`;
    ctx.fillText(label, x + cw / 2, 402);
  });

  // 周环比
  let y = 510;
  if (st.week.prevScore !== null) {
    const diff = st.week.score - st.week.prevScore;
    ctx.textAlign = "center";
    ctx.fillStyle = diff >= 0 ? GREEN : "#ff453a";
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText(`${diff >= 0 ? "↑ 比上周进步" : "↓ 比上周"} ${Math.abs(diff)} 分`, W / 2, y);
    y += 60;
  }

  // 14 天柱状图
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  roundRect(ctx, 60, y, W - 120, 300, 20);
  ctx.fill();
  ctx.fillStyle = "rgba(235,245,237,0.45)";
  ctx.font = `400 26px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("最近 14 天平均分", 90, y + 52);
  const bars = st.days;
  const bw = (W - 120 - 60) / bars.length - 10;
  bars.forEach((d, i) => {
    if (d.score === null) return;
    const h = Math.max(12, ((d.score - 40) / 60) * 180);
    const x = 90 + i * (bw + 10);
    ctx.fillStyle = GREEN;
    roundRect(ctx, x, y + 270 - h, bw, h, 6);
    ctx.fill();
  });
  y += 340;

  // 主攻问题
  if (st.focus) {
    ctx.fillStyle = "rgba(48,209,88,0.12)";
    roundRect(ctx, 60, y, W - 120, 170, 20);
    ctx.fill();
    ctx.strokeStyle = "rgba(48,209,88,0.4)";
    ctx.lineWidth = 2;
    roundRect(ctx, 60, y, W - 120, 170, 20);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = GREEN;
    ctx.font = `600 26px ${FONT}`;
    ctx.fillText("本周主攻", 100, y + 56);
    ctx.fillStyle = "#fff";
    ctx.font = `700 44px ${FONT}`;
    ctx.fillText(st.focus.rule.title, 100, y + 118);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(235,245,237,0.6)";
    ctx.font = `400 32px ${FONT}`;
    ctx.fillText(`触发率 ${Math.round(st.focus.now * 100)}%`, W - 100, y + 118);
  }

  await drawFooter(ctx);
  return c.toDataURL("image/jpeg", 0.9);
}
