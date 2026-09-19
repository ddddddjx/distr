// 报告里的慢放回放导出为视频文件。
//
// 关键事实：录下来的片段是【原速】的，报告里的"慢动作"只是播放时设了
// playbackRate=0.4。所以直接把 blob 存下来，用户拿到的是原速短片，与他在
// 报告里看到的东西对不上。这里在本地做一次真正的重编码：让回放以 0.4x 播放，
// 逐帧画进 canvas，用 canvas.captureStream() + MediaRecorder 按墙钟时间录下来
// ——产出的文件本身就是慢速的。全程在浏览器内完成，视频不离开手机。
//
// 代价：耗时 = 片段时长 ÷ 倍速（2 秒的挥杆约 5 秒）。拿不到能力时由调用方
// 降级为保存原速片段，并如实告诉用户。

/** 录制容器优先级：mp4 排第一，iOS 存进相册只认它；webm 只能存到「文件」 */
const MIME_CANDIDATES = ["video/mp4", "video/webm;codecs=vp9", "video/webm"];

/**
 * 当前环境能做到哪一步。纯函数，便于单测。
 * @param {object} env
 * @param {boolean} env.hasCaptureStream canvas.captureStream 是否可用
 * @param {boolean} env.hasRecorder MediaRecorder 是否可用
 * @param {boolean} env.hasSource 是否有可导出的回放源
 * @param {boolean} env.hasRawBlob 是否握有原速片段（相机模式录下来的 blob）
 * @returns {"slowmo"|"raw"|"none"} slowmo=本地重编码；raw=只能存原速；none=没得存
 */
export function exportCapability(env) {
  if (!env.hasSource) return "none";
  if (env.hasCaptureStream && env.hasRecorder) return "slowmo";
  return env.hasRawBlob ? "raw" : "none";
}

/** 挑一个浏览器支持的录制容器；都不支持返回 ""（交给浏览器默认） */
export function pickMime(isSupported) {
  return MIME_CANDIDATES.find((t) => isSupported(t)) || "";
}

/** 文件名：带日期与分数，存进相册后自己能认出来 */
export function exportFileName(score, mime, now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const ext = String(mime || "").includes("mp4") ? "mp4" : "webm";
  const tag = Number.isFinite(score) ? `-${Math.round(score)}分` : "";
  return `jaykay-golf-${stamp}${tag}.${ext}`;
}

/** 预估重编码耗时（秒），用于给用户一个像样的等待提示 */
export function estimateSeconds(start, end, rate) {
  const span = Math.max(0, (end || 0) - (start || 0));
  return span > 0 && rate > 0 ? span / rate : 0;
}

/**
 * 把 video 元素的 [start,end] 区间以 rate 倍速重录成一段慢放视频。
 * 只读取传入的 video 元素，不改动它的最终状态（调用方负责恢复 src/循环等）。
 * @returns {Promise<Blob>}
 */
export async function renderSlowMotion(video, opts = {}) {
  const { rate = 0.4, start = 0, end = 0, maxW = 720, timeoutMs = 60000 } = opts;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) throw new Error("回放还没准备好");
  const scale = Math.min(1, maxW / vw);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const ctx = canvas.getContext("2d");

  const stream = canvas.captureStream(30);
  const mime = pickMime((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  const stopAt = end > start ? end : Infinity; // end 缺省 = 放到片尾
  let rafId = 0, timer = 0;
  const done = new Promise((resolve, reject) => {
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || mime || "video/webm" });
      blob.size ? resolve(blob) : reject(new Error("重编码没有产出数据"));
    };
    rec.onerror = () => reject(new Error("重编码失败"));
    timer = setTimeout(() => finish(), timeoutMs); // 卡住也要收尾，不能永远转圈
  });

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(rafId);
    clearTimeout(timer);
    video.removeEventListener("ended", finish);
    video.pause();
    stream.getTracks().forEach((t) => t.stop());
    try { rec.stop(); } catch { /* 已经停了 */ }
  };

  // 逐帧搬运：源以 rate 倍速播放，这里按墙钟时间画，录出来的就是慢速文件
  const pump = () => {
    if (finished) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (video.currentTime >= stopAt || video.ended) return void finish();
    rafId = requestAnimationFrame(pump);
  };

  video.addEventListener("ended", finish);
  video.pause();
  video.currentTime = start;
  // 等 seek 落定再开录，否则开头会录进上一帧
  if (Math.abs(video.currentTime - start) > 0.05) {
    await new Promise((res) => {
      video.addEventListener("seeked", res, { once: true });
      setTimeout(res, 1000);
    });
  }
  video.playbackRate = rate;
  rec.start();
  try {
    await video.play();
  } catch (err) {
    // iOS 上 await import() 之后用户手势可能已经失效，play() 会被拒。
    // 必须就地收尾：否则录制器和 rAF 会一直挂到 timeoutMs，done 也没人接，
    // 变成一条未捕获的 Promise 拒绝。
    finish();
    done.catch(() => {});
    throw new Error("浏览器拒绝播放回放，无法生成慢放视频");
  }
  pump();
  return done;
}

/**
 * 把视频 blob 交给用户保存。iOS 上优先系统分享（能存相册/文件），
 * 否则退回 <a download>。
 * @returns {Promise<"shared"|"downloaded">}
 */
export async function saveVideoBlob(blob, filename, title = "JAYKAY Golf 慢放回放") {
  const file = new File([blob], filename, { type: blob.type || "video/mp4" });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title });
    return "shared";
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000); // 给浏览器留足下载时间
  return "downloaded";
}
