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

// AI 锐评：自嘲/夸赞式一句话，社交平台传播的核心文案。
// 优先用最严重问题的专属锐评，没有问题时按分数段夸。
const FAULT_ROASTS = {
  LOSS_OF_POSTURE: "一挥杆就起身，比闹钟响了起床还积极",
  EARLY_EXTENSION: "胯比手先到球位，有点抢戏了",
  HIP_SWAY: "上杆摇得很投入，广场舞冠军预定",
  OVER_THE_TOP: "这一杆从外面砍下来，球表示很委屈",
  REVERSE_SPINE: "上杆顶点身体写了个反 C，腰替你喊疼",
  CHICKEN_WING: "收杆左臂一弯，鸡翅膀这就熟了",
  HANGING_BACK: "重心太恋家，死活不肯搬去前脚",
  HIP_SLIDE: "髋部一路平移，忘了自己其实会转",
  HEAD_SWAY: "头跟着球杆到处旅游，该定定心了",
  HEAD_DROP: "打个球头点得像在赶稿，稳住",
  FLAT_SHOULDER_PLANE: "转肩平得能端住一盘水饺",
  C_POSTURE: "这站姿像加班第八个小时的你",
  SPINE_TOO_UPRIGHT: "站得比保安还标准，放松一点",
  SPINE_TOO_BENT: "鞠躬尽瘁型站位，上身抬一点",
};

const SCORE_PRAISES = [
  [95, "这挥杆可以直接进集锦，建议装裱"],
  [90, "教练看了都想主动递名片"],
  [85, "稳得像开了防抖，离单差点不远了"],
  [80, "有点东西，球友群里可以横着走了"],
  [70, "底子不错，就差最后几脚打磨"],
  [60, "标准潜力股，练一个月回来吓自己一跳"],
  [0, "先别急着换球杆，问题真不在装备"],
];

export function roastOf(summary) {
  const top = summary.faults?.[0];
  if (top && FAULT_ROASTS[top.key]) return FAULT_ROASTS[top.key];
  return SCORE_PRAISES.find(([min]) => summary.score >= min)[1];
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

/** 将图片完整收纳（contain）进圆角矩形：竖拍素材不裁头脚 */
function drawContain(ctx, img, x, y, w, h, r) {
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.fillStyle = "#0d130f";
  ctx.fillRect(x, y, w, h);
  const s = Math.min(w / img.width, h / img.height);
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
  ctx.fillText("扫码来一杆，敢跟我比比吗？", 100, fy + 82);
  ctx.fillStyle = "rgba(235,245,237,0.5)";
  ctx.font = `400 26px ${FONT}`;
  ctx.fillText("免费 AI 挥杆分析 · 视频不上传 · 无需安装", 100, fy + 132);
}

/** 单次挥杆成绩卡 */
export async function buildSwingCard(summary, keyframes) {
  const [c, ctx] = newCanvas();
  drawHeader(ctx, "AI 挥杆教练");

  // 大分数 + 段位（实心徽章）
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.font = `800 280px ${FONT}`;
  ctx.fillText(String(summary.score), W / 2, 460);
  ctx.font = `500 42px ${FONT}`;
  ctx.fillStyle = "rgba(235,245,237,0.6)";
  ctx.fillText("AI 挥杆评分", W / 2, 528);

  const tier = tierOf(summary.score);
  ctx.font = `700 46px ${FONT}`;
  const tw = ctx.measureText(tier).width + 96;
  ctx.fillStyle = GREEN;
  roundRect(ctx, (W - tw) / 2, 566, tw, 86, 43);
  ctx.fill();
  ctx.fillStyle = "#04220e";
  ctx.fillText(tier, W / 2, 626);

  ctx.fillStyle = "#fff";
  ctx.font = `500 38px ${FONT}`;
  ctx.fillText(`预估击败 ${percentileOf(summary.score)}% 的球友`, W / 2, 712);

  // AI 锐评：社交传播的记忆点
  ctx.fillStyle = "rgba(235,245,237,0.85)";
  ctx.font = `600 40px ${FONT}`;
  ctx.fillText(`「 ${roastOf(summary)} 」`, W / 2, 786);

  // 关键位置四宫格：竖拍素材完整收纳（不裁头脚），横拍居中裁切
  const order = [["address", "准备"], ["top", "顶点"], ["impact", "击球"], ["finish", "收杆"]];
  const shots = order.filter(([k]) => keyframes.has(k));
  if (shots.length) {
    const imgs = await Promise.all(shots.map(([k]) => loadImage(keyframes.get(k))));
    const first = imgs.find(Boolean);
    const gap = 18;
    const portrait = first && first.height > first.width;
    if (portrait) {
      // 竖版：格子按素材比例加高，整个人完整可见，条带整体居中
      const ch = 316, y0 = 812;
      const idealW = ch * (first.width / first.height);
      const cw = Math.min(idealW, (W - 120 - gap * (shots.length - 1)) / shots.length);
      const total = shots.length * cw + (shots.length - 1) * gap;
      const x0 = (W - total) / 2;
      for (let i = 0; i < shots.length; i++) {
        const x = x0 + i * (cw + gap);
        if (imgs[i]) drawContain(ctx, imgs[i], x, y0, cw, ch, 16);
        ctx.fillStyle = "rgba(235,245,237,0.55)";
        ctx.font = `400 26px ${FONT}`;
        ctx.textAlign = "center";
        ctx.fillText(shots[i][1], x + cw / 2, y0 + ch + 36);
      }
    } else {
      const cw = (W - 120 - gap * (shots.length - 1)) / shots.length;
      const ch = Math.min(cw * 1.25, 280), y0 = 836;
      for (let i = 0; i < shots.length; i++) {
        const x = 60 + i * (cw + gap);
        if (imgs[i]) drawCover(ctx, imgs[i], x, y0, cw, ch, 16);
        ctx.fillStyle = "rgba(235,245,237,0.55)";
        ctx.font = `400 26px ${FONT}`;
        ctx.textAlign = "center";
        ctx.fillText(shots[i][1], x + cw / 2, y0 + ch + 38);
      }
    }
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
