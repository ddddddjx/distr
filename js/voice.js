// 语音教练：用 Web Speech API 在拍摄/分析的同时口头提示问题。
// 同一条提示有冷却时间，且不打断正在播报的内容，避免变成"碎嘴"。
export class VoiceCoach {
  constructor() {
    this.enabled = true;
    this.lastSpoken = new Map(); // key -> 上次播报时间
    this.supported = "speechSynthesis" in window;
  }

  /** iOS/部分浏览器要求语音必须由用户手势触发解锁，在点击"开始分析"时调用 */
  unlock() {
    if (!this.supported) return;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 播报一句话。
   * @param {string} text 要说的内容
   * @param {string} key 去重键（同一问题用同一个 key）
   * @param {number} cooldownMs 同一 key 的最小间隔
   */
  say(text, key = text, cooldownMs = 6000) {
    if (!this.enabled || !this.supported || !text) return;
    const now = Date.now();
    if (now - (this.lastSpoken.get(key) || 0) < cooldownMs) return;
    // 正在说话时不插话，等下一次触发（实时反馈宁可少说，不要重叠）
    if (speechSynthesis.speaking || speechSynthesis.pending) return;
    this.lastSpoken.set(key, now);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = 1.15;
    u.pitch = 1.0;
    speechSynthesis.speak(u);
  }

  stop() {
    if (this.supported) speechSynthesis.cancel();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.stop();
  }
}
