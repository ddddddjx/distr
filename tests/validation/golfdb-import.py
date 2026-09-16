#!/usr/bin/env python3
"""GolfDB → 验证集导入工具。

GolfDB（McNally 等，CVPR-W 2019，https://github.com/wmcnally/golfdb）只提供标注，不提供视频：
每杆一行，含 YouTube ID、球员、机位、是否慢动作、8 个关键事件的帧号与球手裁剪框。
本脚本把它变成我们验证集里可直接跑的职业阴性对照素材 + 带相位真值的 manifest 条目。

四步，均可单独重跑（幂等，已完成的项自动跳过）：
  select    按机位/慢动作/球员筛出子集，写 selection.json
  download  用 yt-dlp 下载所选视频的原片（720p/30fps，与标注时的帧率一致）
  cut       按裁剪框裁出球手、按事件帧裁出单杆、转 WebM，落到 pro/<view>/
  manifest  把 events（顶点/击球等视频秒数）、source 等写进 tests/validation/manifest.json
  all       依次执行以上四步

用法示例：
  python3 tests/validation/golfdb-import.py select --view side --slow 0 --limit 30
  python3 tests/validation/golfdb-import.py all --view both --limit 40 --dry-run
  python3 tests/validation/golfdb-import.py cut

依赖：scipy（读 .mat）、yt-dlp、ffmpeg/ffprobe（PATH 里）。视频与 YouTube 版权归上传者，只做内部测试。
标注文件默认从 GitHub 拉取到 tests/assets/validation/golfdb/golfDB.mat，也可 --mat 指定本地路径。
"""
import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
import urllib.request
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "tests" / "assets" / "validation"
WORK = ASSETS / "golfdb"
RAW = WORK / "raw"
MANIFEST = ROOT / "tests" / "validation" / "manifest.json"
MAT_URL = "https://raw.githubusercontent.com/wmcnally/golfdb/master/data/golfDB.mat"

VIEW_MAP = {"down-the-line": "side", "face-on": "front"}
# GolfDB events 数组共 10 个帧号：[片段起点, 准备, 杆头离地, 上杆中段, 顶点, 下杆中段, 击球, 送杆中段, 收杆, 片段终点]
EV = {"clip_start": 0, "address": 1, "toe_up": 2, "mid_backswing": 3, "top": 4, "mid_downswing": 5, "impact": 6, "mid_follow": 7, "finish": 8, "clip_end": 9}
PRE_ADDRESS_MARGIN = 45  # 准备姿势前至少留 1.5s（30fps）静止，基准锁定需要 ≥600ms
POST_FINISH_MARGIN = 15

# yt-dlp 格式：720p 且 ≤30fps。标注帧号是在 30fps 原片上标的，拿到 60fps 流帧号会整体错位一倍
YTDLP_FORMAT = "bv*[height<=720][fps<=30][ext=mp4]+ba[ext=m4a]/bv*[height<=720][fps<=30]+ba/b[height<=720]/b"


def log(*a):
    print(*a, file=sys.stderr)


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


# ---------------- 标注读取 ----------------
def load_annotations(mat_path):
    try:
        from scipy.io import loadmat
    except ImportError:
        sys.exit("需要 scipy 读取 golfDB.mat：pip install scipy")
    x = loadmat(str(mat_path))
    recs = []
    for r in x["golfDB"][0]:
        recs.append({
            "id": int(r[0][0][0]),
            "yt": str(r[1][0]),
            "player": str(r[2][0]),
            "sex": str(r[3][0]),
            "club": str(r[4][0]),
            "view": str(r[5][0]),
            "slow": int(r[6][0][0]),
            "events": [int(v) for v in r[7][0]],
            "bbox": [float(v) for v in r[8][0]],
        })
    return recs


def ensure_mat(path):
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    log(f"下载标注文件 {MAT_URL} → {path}")
    urllib.request.urlretrieve(MAT_URL, path)
    return path


# ---------------- select ----------------
def cmd_select(args):
    recs = load_annotations(ensure_mat(Path(args.mat)))
    want_views = {"side": ["down-the-line"], "front": ["face-on"], "both": ["down-the-line", "face-on"]}[args.view]
    pool = [r for r in recs if r["view"] in want_views]
    if args.slow in ("0", "1"):
        pool = [r for r in pool if r["slow"] == int(args.slow)]
    if args.sex:
        pool = [r for r in pool if r["sex"] == args.sex]
    if args.club:
        pool = [r for r in pool if r["club"] == args.club]
    if args.player:
        names = {p.strip().upper() for p in args.player.split(",")}
        pool = [r for r in pool if r["player"].upper() in names]
    # 准备前静止余量不足的直接剔除，避免基准锁不上
    pool = [r for r in pool if r["events"][EV["address"]] - r["events"][EV["clip_start"]] >= args.min_pre]

    rnd = random.Random(args.seed)
    rnd.shuffle(pool)
    per_player, per_video, chosen = {}, {}, []
    for r in pool:
        if per_player.get(r["player"], 0) >= args.per_player or per_video.get(r["yt"], 0) >= args.per_video:
            continue
        per_player[r["player"]] = per_player.get(r["player"], 0) + 1
        per_video[r["yt"]] = per_video.get(r["yt"], 0) + 1
        chosen.append(r)
        if len(chosen) >= args.limit:
            break
    chosen.sort(key=lambda r: r["id"])

    WORK.mkdir(parents=True, exist_ok=True)
    sel_path = WORK / "selection.json"
    existing = {}
    if sel_path.exists() and not args.reset:
        existing = {r["id"]: r for r in json.loads(sel_path.read_text())["clips"]}
    for r in chosen:
        existing.setdefault(r["id"], r)
    clips = sorted(existing.values(), key=lambda r: r["id"])
    sel_path.write_text(json.dumps({"clips": clips}, ensure_ascii=False, indent=1))
    views = {}
    for r in clips:
        views[r["view"]] = views.get(r["view"], 0) + 1
    log(f"本次筛出 {len(chosen)} 杆，selection.json 现有 {len(clips)} 杆（{views}），涉及 {len({r['yt'] for r in clips})} 段视频、{len({r['player'] for r in clips})} 位球员")
    for r in clips:
        log(f"  #{r['id']:4d} {VIEW_MAP[r['view']]:5s} {'slomo' if r['slow'] else 'real ':5s} {r['player']:<22s} {r['club']:<8s} yt={r['yt']}")


def load_selection():
    p = WORK / "selection.json"
    if not p.exists():
        sys.exit("还没有 selection.json，先运行 select")
    return json.loads(p.read_text())["clips"]


def run(cmd, dry):
    log("  $ " + " ".join(cmd))
    if dry:
        return 0
    return subprocess.call(cmd)


# ---------------- download ----------------
def cmd_download(args):
    if not args.dry_run and not shutil.which("yt-dlp"):
        sys.exit("找不到 yt-dlp：pip install yt-dlp")
    RAW.mkdir(parents=True, exist_ok=True)
    ids = sorted({r["yt"] for r in load_selection()})
    status = {}
    for yt in ids:
        if list(RAW.glob(f"{yt}.*")):
            status[yt] = "exists"
            continue
        code = run(["yt-dlp", "-f", YTDLP_FORMAT, "--merge-output-format", "mp4", "-o", str(RAW / "%(id)s.%(ext)s"),
                    f"https://www.youtube.com/watch?v={yt}"], args.dry_run)
        status[yt] = "ok" if code == 0 else f"failed({code})"
    failed = [k for k, v in status.items() if v.startswith("failed")]
    log(f"下载：{len(ids)} 段，已存在 {sum(v == 'exists' for v in status.values())}，失败 {len(failed)}")
    if failed:
        log("失败（视频可能已下架/私有，cut 会跳过）：" + ", ".join(failed))


# ---------------- cut ----------------
def probe(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=avg_frame_rate,r_frame_rate,width,height", "-of", "json", str(path)])
    s = json.loads(out)["streams"][0]
    fps = Fraction(s.get("avg_frame_rate") or s["r_frame_rate"])
    if fps == 0:
        fps = Fraction(s["r_frame_rate"])
    return float(fps), int(s["width"]), int(s["height"])


def raw_file(yt):
    files = list(RAW.glob(f"{yt}.*"))
    return files[0] if files else None


def out_name(r):
    return f"golfdb-{r['id']:04d}-{slug(r['player'])}{'-slomo' if r['slow'] else ''}.webm"


def cut_plan(r, fps, w, h):
    """返回 (起始秒, 时长秒, crop 表达式, 事件相对秒)。帧号按 GolfDB 预处理脚本的 1 起始计数。"""
    ev = r["events"]
    start_f = max(1, min(ev[EV["clip_start"]], ev[EV["address"]] - PRE_ADDRESS_MARGIN))
    end_f = ev[EV["clip_end"]] + POST_FINISH_MARGIN
    t = lambda f: (f - 1) / fps
    start_s, dur_s = t(start_f), t(end_f) - t(start_f)
    x, y, bw, bh = r["bbox"]
    cw, ch = int(bw * w) // 2 * 2, int(bh * h) // 2 * 2
    cx, cy = int(x * w), int(y * h)
    crop = f"crop={cw}:{ch}:{cx}:{cy}"
    events = {k: round(t(ev[i]) - start_s, 3) for k, i in EV.items() if k not in ("clip_start", "clip_end")}
    return start_s, dur_s, crop, events


def cmd_cut(args):
    if not args.dry_run and not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        sys.exit("找不到 ffmpeg/ffprobe")
    clips = load_selection()
    plan_path = WORK / "cuts.json"
    plans = json.loads(plan_path.read_text()) if plan_path.exists() else {}
    done = skipped = failed = 0
    for r in clips:
        view = VIEW_MAP[r["view"]]
        dst = ASSETS / "pro" / view / out_name(r)
        rel = f"pro/{view}/{out_name(r)}"
        if dst.exists() and rel in plans:
            skipped += 1
            continue
        src = raw_file(r["yt"])
        if not src:
            log(f"  跳过 #{r['id']}：原片 {r['yt']} 未下载")
            failed += 1
            continue
        if args.dry_run:
            fps, w, h = 30.0, 1280, 720
        else:
            fps, w, h = probe(src)
        start_s, dur_s, crop, events = cut_plan(r, fps, w, h)
        dst.parent.mkdir(parents=True, exist_ok=True)
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
               "-ss", f"{start_s:.3f}", "-t", f"{dur_s:.3f}", "-i", str(src),
               "-vf", f"{crop},scale=-2:'min(720,ih)'",
               "-map", "0:v:0", "-map", "0:a?",
               "-c:v", "libvpx", "-b:v", "1.5M", "-c:a", "libvorbis", "-b:a", "64k", str(dst)]
        code = run(cmd, args.dry_run)
        if code != 0:
            failed += 1
            continue
        plans[rel] = {
            "id": r["id"], "yt": r["yt"], "player": r["player"], "sex": r["sex"], "club": r["club"],
            "view": view, "slow": r["slow"], "fps": fps, "start_s": round(start_s, 3), "events": events,
        }
        done += 1
        if not args.dry_run:
            plan_path.write_text(json.dumps(plans, ensure_ascii=False, indent=1))
    log(f"裁剪：新完成 {done}，已存在 {skipped}，失败/缺原片 {failed}；计划写入 {plan_path.relative_to(ROOT)}")


# ---------------- manifest ----------------
def cmd_manifest(args):
    plan_path = WORK / "cuts.json"
    if not plan_path.exists():
        sys.exit("还没有 cuts.json，先运行 cut")
    plans = json.loads(plan_path.read_text())
    m = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    m.setdefault("defaults", {"playbackRate": 0.5})
    m.setdefault("clips", {})
    added = 0
    for rel, p in plans.items():
        if rel in m["clips"] and not args.force:
            continue
        entry = {
            "source": f"https://www.youtube.com/watch?v={p['yt']}",
            "swings": 1,
            "events": {"top": p["events"]["top"], "impact": p["events"]["impact"],
                       "address": p["events"]["address"], "finish": p["events"]["finish"]},
            "note": f"GolfDB #{p['id']} · {p['player']} · {p['club']} · {'慢动作' if p['slow'] else '正常速度'}",
        }
        # 慢动作素材帧多，无头 3fps 下可用 1 倍速；正常速度沿用默认 0.5
        if p["slow"]:
            entry["playbackRate"] = 1
        # 人工加过的 allow 等字段保留
        old = m["clips"].get(rel, {})
        for k in ("allow", "codes"):
            if k in old:
                entry[k] = old[k]
        m["clips"][rel] = entry
        added += 1
    if not args.dry_run:
        MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n")
    log(f"manifest：写入/更新 {added} 条，现共 {len(m['clips'])} 条 → {MANIFEST.relative_to(ROOT)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["select", "download", "cut", "manifest", "all"])
    ap.add_argument("--mat", default=str(WORK / "golfDB.mat"), help="golfDB.mat 路径，不存在则自动下载")
    ap.add_argument("--view", choices=["side", "front", "both"], default="both")
    ap.add_argument("--slow", choices=["0", "1", "any"], default="any", help="0 正常速度 / 1 慢动作")
    ap.add_argument("--sex", choices=["m", "f"], default=None)
    ap.add_argument("--club", default=None, help="driver / iron / fairway / hybrid / wedge")
    ap.add_argument("--player", default=None, help="逗号分隔的球员名（不区分大小写）")
    ap.add_argument("--per-player", type=int, default=2)
    ap.add_argument("--per-video", type=int, default=1, help="每段 YouTube 视频最多取几杆，1 = 最大化多样性并减少下载量")
    ap.add_argument("--min-pre", type=int, default=20, help="准备姿势前最少静止帧数")
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--reset", action="store_true", help="select 时清空已有 selection.json")
    ap.add_argument("--force", action="store_true", help="manifest 时覆盖已有条目")
    ap.add_argument("--dry-run", action="store_true", help="只打印命令不执行")
    args = ap.parse_args()
    steps = {"select": cmd_select, "download": cmd_download, "cut": cmd_cut, "manifest": cmd_manifest}
    order = ["select", "download", "cut", "manifest"] if args.step == "all" else [args.step]
    for s in order:
        log(f"== {s} ==")
        steps[s](args)


if __name__ == "__main__":
    main()
