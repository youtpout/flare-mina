#!/usr/bin/env python3
"""Burn lower-third captions onto a screen recording.

    python3 caption.py captions.json demo raw/demo.mov out/demo-captioned.mp4

Captions are rendered as transparent PNGs by the same headless Chrome that
shoots the title cards, so they carry the deck's typography instead of
ffmpeg's `drawtext`, which cannot do the font, the pill, or the fade.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# 1920x1080 with a transparent background; only the pill is opaque, so the
# overlay sits on the footage without a letterbox.
HTML = """<!doctype html><meta charset=utf-8><style>
  html,body{{margin:0;height:100%;background:transparent}}
  body{{display:flex;align-items:flex-end;justify-content:flex-start;
        font:400 20px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif}}
  .pill{{margin:0 0 68px 68px;padding:20px 30px;border-radius:14px;
         background:rgba(11,14,20,.90);border:1px solid #1f2635;
         box-shadow:0 12px 40px rgba(0,0,0,.45);max-width:1180px}}
  .t{{color:#e8ecf3;font-size:34px;font-weight:600;letter-spacing:-.01em}}
  .s{{color:#8b96a8;font-size:24px;margin-top:8px}}
  .bar{{height:3px;width:54px;border-radius:2px;margin-bottom:16px;
        background:linear-gradient(90deg,#ff9a3c,#e6357a)}}
</style><div class=pill><div class=bar></div>
<div class=t>{text}</div>{sub}</div>
"""


def render(text: str, sub: str, out: Path) -> None:
    sub_html = f'<div class="s">{sub}</div>' if sub else ""
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as fh:
        fh.write(HTML.format(text=text, sub=sub_html))
        page = fh.name
    subprocess.run(
        [CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
         "--window-size=1920,1080", "--force-device-scale-factor=1",
         "--default-background-color=00000000",  # keeps the PNG transparent
         "--virtual-time-budget=600",
         f"--screenshot={out}", f"file://{page}"],
        check=True, capture_output=True,
    )
    Path(page).unlink()


def main() -> None:
    spec = json.loads(Path(sys.argv[1]).read_text())
    clip_name, src, dst = sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4])
    caps = spec["clips"][clip_name]

    work = dst.parent / "cap"
    work.mkdir(parents=True, exist_ok=True)

    inputs, filters, last = ["-i", str(src)], [], "[0:v]"
    for i, c in enumerate(caps):
        png = work / f"{clip_name}-{i:02d}.png"
        render(c["text"], c.get("sub", ""), png)
        inputs += ["-i", str(png)]
        nxt = f"[v{i}]"
        # Chained overlays, each gated to its own window. One pass, one encode.
        filters.append(
            f"{last}[{i+1}:v]overlay=0:0:enable='between(t,{c['at']},{c['until']})'{nxt}"
        )
        last = nxt

    if not filters:
        print("no captions for this clip")
        return

    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", *inputs,
         "-filter_complex", ";".join(filters), "-map", last,
         "-map", "0:a?", "-c:v", "libx264", "-crf", "18", "-preset", "slow",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", str(dst)],
        check=True,
    )
    print(f"{dst}  ({len(caps)} captions)")


if __name__ == "__main__":
    main()
