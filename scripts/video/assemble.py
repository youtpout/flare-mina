#!/usr/bin/env python3
"""Cut the raw takes, narrate them, and splice the whole film together.

    python3 assemble.py edit.json out/demo.mp4

Every piece is normalised to 1920x1080 / 30fps / 48kHz stereo before the
concat, because ffmpeg's concat demuxer will silently produce a broken file if
the streams disagree — and the three takes disagree on frame rate.

A cut is held for whichever is longer, the footage or its narration: the
picture freezes on its last frame rather than the voice being cut off.
"""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import edge_tts

W, H, FPS = 1920, 1080, 30

# The takes are full-screen grabs at 1670x1080: macOS menu bar on top, Dock at
# the bottom, and Screenity's "your screen is being shared" banner sitting over
# the page. Cropping to the browser window removes all three and fills the frame
# instead of pillarboxing a 1670-wide image into 1920.
CROP = "crop=1670:915:0:30"
BG = "0x0b0e14"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

CAPTION_HTML = """<!doctype html><meta charset=utf-8><style>
  html,body{{margin:0;height:100%;background:transparent}}
  body{{display:flex;align-items:flex-end;justify-content:flex-start;
        font:400 20px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif}}
  .pill{{margin:0 0 58px 58px;padding:18px 28px;border-radius:14px;
         background:rgba(11,14,20,.92);border:1px solid #1f2635;
         box-shadow:0 12px 40px rgba(0,0,0,.5);max-width:1200px}}
  .t{{color:#e8ecf3;font-size:32px;font-weight:600;letter-spacing:-.01em}}
  .s{{color:#8b96a8;font-size:22px;margin-top:6px}}
  .bar{{height:3px;width:50px;border-radius:2px;margin-bottom:14px;
        background:linear-gradient(90deg,#ff9a3c,#e6357a)}}
</style><div class=pill><div class=bar></div>
<div class=t>{text}</div>{sub}</div>"""


def run(args: list[str]) -> None:
    subprocess.run(args, check=True, capture_output=True)


def probe(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


async def say(text: str, dest: Path, voice: str, rate: str) -> float:
    await edge_tts.Communicate(text, voice, rate=rate).save(str(dest))
    return probe(dest)


def caption_png(cap: dict, dest: Path) -> None:
    sub = f'<div class="s">{cap["sub"]}</div>' if cap.get("sub") else ""
    page = dest.with_suffix(".html")
    page.write_text(CAPTION_HTML.format(text=cap["text"], sub=sub))
    run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
         f"--window-size={W},{H}", "--force-device-scale-factor=1",
         "--default-background-color=00000000", "--virtual-time-budget=600",
         f"--screenshot={dest}", f"file://{page}"])
    page.unlink()


async def build_cut(item: dict, sources: dict, work: Path, i: int,
                    voice: str, rate: str) -> Path:
    src = Path(sources[item["cut"]])
    start, end = float(item["in"]), float(item["out"])
    dest = work / f"{i:02d}-cut.mp4"

    # Narration first: it decides how long the picture is held.
    audio, spoken = None, 0.0
    if item.get("say"):
        audio = work / f"{i:02d}.mp3"
        spoken = await say(item["say"], audio, voice, rate)

    # A beat of air on each side, so a line never starts on the cut frame.
    dur = max(end - start, spoken + 0.7)

    vf = [
        CROP,
        f"scale={W}:{H}:force_original_aspect_ratio=decrease",
        f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color={BG}",
        f"fps={FPS}",
        # Hold the last frame if the narration outlasts the footage.
        f"tpad=stop_mode=clone:stop_duration={max(0.0, dur - (end - start)):.2f}",
    ]

    inputs = ["-ss", f"{start}", "-t", f"{end - start}", "-i", str(src)]
    filters = f"[0:v]{','.join(vf)}[base]"
    last = "[base]"

    if item.get("caption"):
        png = work / f"{i:02d}-cap.png"
        caption_png(item["caption"], png)
        inputs += ["-i", str(png)]
        filters += f";{last}[1:v]overlay=0:0:enable='between(t,0.4,{dur - 0.3:.2f})'[capped]"
        last = "[capped]"

    if audio is None:
        inputs += ["-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo"]
        amap = f"{len(inputs) // 2 - 1}:a"
    else:
        inputs += ["-i", str(audio)]
        amap = f"{2 if item.get('caption') else 1}:a"

    run(["ffmpeg", "-y", "-loglevel", "error", *inputs,
         "-filter_complex", filters, "-map", last, "-map", amap,
         "-t", f"{dur:.2f}",
         "-c:v", "libx264", "-crf", "19", "-preset", "medium",
         "-pix_fmt", "yuv420p", "-r", str(FPS),
         "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
         str(dest)])
    return dest


def normalise_slide(src: Path, dest: Path) -> Path:
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-vf", f"scale={W}:{H},fps={FPS}",
         "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", str(dest)])
    return dest


async def main() -> None:
    spec = json.loads(Path(sys.argv[1]).read_text())
    dest = Path(sys.argv[2])
    here = Path(__file__).parent
    out = here / "out"
    work = out / "film"
    work.mkdir(parents=True, exist_ok=True)

    voice = spec.get("voice", "en-US-AndrewMultilingualNeural")
    rate = spec.get("rate", "+6%")

    pieces = []
    for i, item in enumerate(spec["timeline"]):
        if "slide" in item:
            src = out / f"{item['slide']}.mp4"
            if not src.exists():
                raise SystemExit(f"missing {src} — run build.sh first")
            p = normalise_slide(src, work / f"{i:02d}-slide.mp4")
            print(f"  {i:02d} slide {item['slide']:<12} {probe(p):5.1f}s")
        else:
            p = await build_cut(item, spec["sources"], work, i, voice, rate)
            print(f"  {i:02d} cut   {item['cut']} {item['in']:>6.1f}-{item['out']:<6.1f} {probe(p):5.1f}s")
        pieces.append(p)

    # The concat *filter*, not the demuxer. The demuxer re-encodes each piece's
    # audio separately, and AAC's encoder priming eats a few dozen milliseconds
    # at every join — across sixteen joins that clips the leading consonant of a
    # line often enough to hear. Decoding everything and concatenating inside the
    # graph gives one continuous stream and one encode.
    inputs: list[str] = []
    for p in pieces:
        inputs += ["-i", str(p)]
    chain = "".join(f"[{i}:v][{i}:a]" for i in range(len(pieces)))
    run(["ffmpeg", "-y", "-loglevel", "error", *inputs,
         "-filter_complex", f"{chain}concat=n={len(pieces)}:v=1:a=1[v][a]",
         "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-crf", "19", "-preset", "slow", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", str(dest)])

    total = probe(dest)
    print(f"\n{dest}  {int(total // 60)}:{total % 60:04.1f}")


if __name__ == "__main__":
    asyncio.run(main())
