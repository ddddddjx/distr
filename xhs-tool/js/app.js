// SwingCoach 挥杆回看训练器 —— 小红书小工具版
// 容器约束：纯本地运行、无网络、无 WASM/Worker、禁内联脚本与行内事件。
// 因此本版不含 AI 姿态估计，提供教练式人工回看工具：
// 慢放逐帧 / 画线自查 / 冻结帧对比 / 节奏计时 / TPI 自查清单。
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  var video = $("video");
  var canvas = $("draw");
  var ctx = canvas.getContext("2d");
  var FRAME = 1 / 30; // 逐帧步长（普通视频 30fps；慢动作素材同样适用）

  /* ================= 选择视频 ================= */
  var fileUrl = null;

  $("pickBtn").addEventListener("click", function () { $("fileInput").click(); });
  $("changeVideo").addEventListener("click", function () { $("fileInput").click(); });

  $("fileInput").addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(f);
    video.src = fileUrl;
    video.playbackRate = 0.5;
    $("picker").classList.add("hidden");
    $("player").classList.remove("hidden");
    resetDrawings();
    resetTempo();
    clearGhost();
  });

  video.addEventListener("loadedmetadata", function () {
    sizeCanvas();
    video.currentTime = 0;
  });
  window.addEventListener("resize", sizeCanvas);

  function sizeCanvas() {
    var r = video.getBoundingClientRect();
    canvas.width = Math.round(r.width * (window.devicePixelRatio || 1));
    canvas.height = Math.round(r.height * (window.devicePixelRatio || 1));
    canvas.style.width = r.width + "px";
    canvas.style.height = r.height + "px";
    render();
  }

  /* ================= 播放控制 ================= */
  $("playBtn").addEventListener("click", function () {
    if (video.paused) { video.play(); } else { video.pause(); }
  });
  video.addEventListener("play", function () { $("playBtn").textContent = "暂停"; tick(); });
  video.addEventListener("pause", function () { $("playBtn").textContent = "播放"; });

  $("stepBack").addEventListener("click", function () {
    video.pause();
    video.currentTime = Math.max(0, video.currentTime - FRAME);
  });
  $("stepFwd").addEventListener("click", function () {
    video.pause();
    video.currentTime = Math.min(video.duration || 0, video.currentTime + FRAME);
  });

  var speedBtns = document.querySelectorAll("[data-speed]");
  speedBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      speedBtns.forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      video.playbackRate = Number(b.dataset.speed);
    });
  });

  var seek = $("seek");
  var seeking = false;
  seek.addEventListener("input", function () {
    seeking = true;
    if (video.duration) video.currentTime = (seek.value / 1000) * video.duration;
  });
  seek.addEventListener("change", function () { seeking = false; });
  video.addEventListener("timeupdate", function () {
    if (!seeking && video.duration) seek.value = Math.round((video.currentTime / video.duration) * 1000);
  });

  function tick() {
    if (video.paused || video.ended) return;
    if (video.duration) seek.value = Math.round((video.currentTime / video.duration) * 1000);
    requestAnimationFrame(tick);
  }

  /* ================= 画线工具 ================= */
  // 图形以画布归一化坐标存储：{tool, color, pts:[{x,y}...]}
  var drawings = [];
  var pending = [];       // 当前工具已点的点
  var tool = "line";
  var color = "red";
  var NEED = { line: 2, angle: 3, circle: 2 };
  var COLORS = { red: "#ff453a", green: "#30d158" };

  document.querySelectorAll(".tool[data-tool]").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll(".tool[data-tool]").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      tool = b.dataset.tool;
      pending = [];
      render();
    });
  });

  $("colorBtn").addEventListener("click", function () {
    color = color === "red" ? "green" : "red";
    $("colorBtn").classList.toggle("red", color === "red");
    $("colorBtn").classList.toggle("green", color === "green");
  });

  $("undoBtn").addEventListener("click", function () {
    if (pending.length) pending = [];
    else drawings.pop();
    render();
  });
  $("clearBtn").addEventListener("click", function () { resetDrawings(); });

  function resetDrawings() { drawings = []; pending = []; render(); }

  canvas.addEventListener("pointerdown", function (e) {
    var r = canvas.getBoundingClientRect();
    var p = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    pending.push(p);
    if (pending.length >= NEED[tool]) {
      drawings.push({ tool: tool, color: color, pts: pending.slice() });
      pending = [];
    }
    render();
  });

  function render() {
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    var lw = Math.max(2.5, w * 0.006);
    drawings.forEach(function (d) { drawShape(d, lw); });
    if (pending.length) {
      ctx.fillStyle = COLORS[color];
      pending.forEach(function (p) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, lw * 1.6, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  function drawShape(d, lw) {
    var w = canvas.width, h = canvas.height;
    var P = d.pts.map(function (p) { return { x: p.x * w, y: p.y * h }; });
    ctx.strokeStyle = COLORS[d.color];
    ctx.fillStyle = COLORS[d.color];
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    if (d.tool === "line") {
      ctx.beginPath(); ctx.moveTo(P[0].x, P[0].y); ctx.lineTo(P[1].x, P[1].y); ctx.stroke();
    } else if (d.tool === "circle") {
      var rr = Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y);
      ctx.beginPath(); ctx.arc(P[0].x, P[0].y, rr, 0, Math.PI * 2); ctx.stroke();
    } else if (d.tool === "angle") {
      ctx.beginPath(); ctx.moveTo(P[0].x, P[0].y); ctx.lineTo(P[1].x, P[1].y); ctx.lineTo(P[2].x, P[2].y); ctx.stroke();
      var a1 = Math.atan2(P[0].y - P[1].y, P[0].x - P[1].x);
      var a2 = Math.atan2(P[2].y - P[1].y, P[2].x - P[1].x);
      var deg = Math.abs(a1 - a2) * 180 / Math.PI;
      if (deg > 180) deg = 360 - deg;
      var label = deg.toFixed(0) + "°";
      var fs = Math.max(13, canvas.width * 0.032);
      ctx.font = "600 " + fs + "px -apple-system, 'PingFang SC', sans-serif";
      var tw = ctx.measureText(label).width;
      var lx = P[1].x + fs * 0.6, ly = P[1].y - fs * 0.6;
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(lx - 4, ly - fs, tw + 8, fs * 1.4);
      ctx.fillStyle = COLORS[d.color];
      ctx.fillText(label, lx, ly);
    }
  }

  /* ================= 冻结帧对比 ================= */
  function snapFrame() {
    var c = document.createElement("canvas");
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    return c.toDataURL("image/jpeg", 0.85);
  }

  var ghost = $("ghost");
  $("capA").addEventListener("click", function () {
    ghost.src = snapFrame();
    ghost.classList.remove("hidden");
    $("ghostRow").classList.remove("hidden");
    applyGhostAlpha();
  });
  $("capB").addEventListener("click", function () {
    // B 通常是击球帧：把当前画面冻结为底、A 作为叠加继续可调
    if (!ghost.src) { ghost.src = snapFrame(); ghost.classList.remove("hidden"); }
    $("ghostRow").classList.remove("hidden");
    video.pause();
    applyGhostAlpha();
  });
  $("ghostAlpha").addEventListener("input", applyGhostAlpha);
  $("ghostOff").addEventListener("click", clearGhost);

  function applyGhostAlpha() {
    ghost.style.opacity = String($("ghostAlpha").value / 100);
  }
  function clearGhost() {
    ghost.classList.add("hidden");
    ghost.removeAttribute("src");
    $("ghostRow").classList.add("hidden");
  }

  /* ================= 节奏计时 ================= */
  // 用视频时间轴计时（慢速播放不影响结果）
  var tempo = { start: null, top: null, impact: null };

  $("tapStart").addEventListener("click", function () {
    tempo.start = video.currentTime;
    $("tapStart").classList.add("done");
    $("tapTop").disabled = false;
  });
  $("tapTop").addEventListener("click", function () {
    tempo.top = video.currentTime;
    $("tapTop").classList.add("done");
    $("tapImpact").disabled = false;
  });
  $("tapImpact").addEventListener("click", function () {
    tempo.impact = video.currentTime;
    $("tapImpact").classList.add("done");
    showTempo();
  });
  $("tempoReset").addEventListener("click", resetTempo);

  function showTempo() {
    var back = tempo.top - tempo.start;
    var down = tempo.impact - tempo.top;
    var el = $("tempoResult");
    if (back <= 0 || down <= 0) {
      el.textContent = "时间点顺序不对，请按 起杆 → 顶点 → 击球 依次标记";
    } else {
      var ratio = back / down;
      var verdict = ratio >= 2.4 && ratio <= 3.6
        ? "节奏很棒，接近职业区间"
        : ratio < 2.4 ? "下杆偏急：试试上杆更从容一点" : "上杆偏慢：下杆可以更果断";
      el.innerHTML = "节奏 <b>" + ratio.toFixed(1) + " : 1</b>（职业参考 3:1）<br /><span>" +
        "上杆 " + back.toFixed(2) + "s · 下杆 " + down.toFixed(2) + "s · " + verdict + "</span>";
      try { localStorage.setItem("lastTempo", ratio.toFixed(2)); } catch (e) {}
    }
    el.classList.remove("hidden");
    $("tempoReset").classList.remove("hidden");
  }

  function resetTempo() {
    tempo = { start: null, top: null, impact: null };
    ["tapStart", "tapTop", "tapImpact"].forEach(function (id) { $(id).classList.remove("done"); });
    $("tapTop").disabled = true;
    $("tapImpact").disabled = true;
    $("tempoResult").classList.add("hidden");
    $("tempoReset").classList.add("hidden");
  }

  /* ================= Tabs ================= */
  document.querySelectorAll(".tab").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      ["review", "compare", "tempo", "check"].forEach(function (name) {
        $("tab-" + name).classList.toggle("hidden", name !== b.dataset.tab);
      });
    });
  });

  /* ================= TPI 自查清单 ================= */
  var checked = {};
  try { checked = JSON.parse(localStorage.getItem("swingChecks")) || {}; } catch (e) {}

  function renderChecklist() {
    var box = $("checklist");
    box.innerHTML = "";
    window.SWING_CHECKS.forEach(function (c) {
      var card = document.createElement("div");
      card.className = "check-card" + (checked[c.id] ? " on" : "");
      card.innerHTML =
        '<div class="cc-head"><span class="cc-title">' + c.title + "</span>" +
        '<span class="cc-tpi">' + c.tpi + "</span>" +
        '<span class="cc-mark">' + (checked[c.id] ? "主攻中" : "标记") + "</span></div>" +
        '<div class="cc-block"><b>怎么查</b>' + c.how + "</div>" +
        '<div class="cc-block"><b>为什么重要</b>' + c.why + "</div>" +
        '<div class="cc-block"><b>怎么练</b>' + c.drill + "</div>";
      card.addEventListener("click", function () {
        checked[c.id] = !checked[c.id];
        try { localStorage.setItem("swingChecks", JSON.stringify(checked)); } catch (e) {}
        renderChecklist();
      });
      box.appendChild(card);
    });
  }
  renderChecklist();
})();
