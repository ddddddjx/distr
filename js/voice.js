// 语音教练：用 Web Speech API 在拍摄/分析的同时口头提示问题。
// 音色来自手机系统语音库，默认优先选择台湾口音温柔女声（如 iOS 的"美佳"），
// 用户可在语音设置面板中试听切换，选择会记住。
// 同一条提示有冷却时间，且不打断正在播报的内容，避免变成"碎嘴"。

// 默认音色优先级：台湾腔女声 > 大陆女声 > 任意中文
const PREFER_PATTERNS = [
  /mei-?jia|美佳/i,            // iOS zh-TW 女声，最接近台湾腔温柔风格
  /yating|雅婷/i,              // 部分系统的 zh-TW 女声
  /ting-?ting|婷婷|xiaoxiao|晓晓|huihui|慧慧/i, // 常见 zh-CN 女声
];

export class VoiceCoach {
  constructor() {
    this.enabled = true;
    this.lastSpoken = new Map(); // key -> 上次播报时间
    this.supported = "speechSynthesis" in window;
    this.voice = null;
    this.preferredName = localStorage.getItem("coachVoice") || "";
    if (this.supported) {
      this._pickVoice();
      speechSynthesis.addEventListener?.("voiceschanged", () => this._pickVoice());
    }
  }

  /** 当前可用的中文音色列表 */
  listVoices() {
    if (!this.supported) return [];
    return speechSynthesis.getVoices().filter((v) => /^zh/i.test(v.lang));
  }

  _pickVoice() {
    const voices = this.listVoices();
    if (voices.length === 0) return;
    // 1. 用户手选过的优先
    if (this.preferredName) {
      const v = voices.find((x) => x.name === this.preferredName);
      if (v) { this.voice = v; return; }
    }
    // 2. 按温柔女声优先级匹配
    for (const pat of PREFER_PATTERNS) {
      const v = voices.find((x) => pat.test(x.name));
      if (v) { this.voice = v; return; }
    }
    // 3. zh-TW 任意 > zh-CN 任意 > 第一个中文
    this.voice =
      voices.find((x) => /^zh-TW/i.test(x.lang)) ||
      voices.find((x) => /^zh-CN/i.test(x.lang)) ||
      voices[0];
  }

  /** 用户在设置面板中选择音色（持久化并播一句试听） */
  setVoiceByName(name) {
    const v = this.listVoices().find((x) => x.name === name);
    if (!v) return;
    this.voice = v;
    this.preferredName = name;
    localStorage.setItem("coachVoice", name);
    this.stop();
    this._speak("你好，我是你的挥杆教练，今天也要加油哦");
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
    this._speak(text);
  }

  _speak(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.voice?.lang || "zh-CN";
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    u.pitch = 1.1; // 略微调高音调，听感更柔和
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
