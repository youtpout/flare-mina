#!/usr/bin/env python3
"""Render the narration to one MP3 per card, via Microsoft Edge's TTS.

    python3 say.py narration.json out/mp3

Each file is named `<NN>-<id>.mp3` so build.sh can pair it with the card of the
same number. Trailing silence comes from the segment's `hold`, which is what
lets a viewer finish reading a table before the cut.
"""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import edge_tts


async def render(seg: dict, voice: str, rate: str, index: int, out: Path) -> Path:
    raw = out / f"{index:02d}-{seg['id']}.raw.mp3"
    final = out / f"{index:02d}-{seg['id']}.mp3"

    await edge_tts.Communicate(seg["text"], voice, rate=rate).save(str(raw))

    hold = float(seg.get("hold", 0))
    if hold <= 0:
        raw.replace(final)
        return final

    # Pad rather than stretch: changing the speech rate to fill time is audible,
    # and the pause is the point.
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw),
         "-af", f"apad=pad_dur={hold}", str(final)],
        check=True,
    )
    raw.unlink()
    return final


async def main() -> None:
    spec = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)

    voice = spec.get("voice", "en-US-AndrewMultilingualNeural")
    rate = spec.get("rate", "+0%")

    for i, seg in enumerate(spec["segments"], start=1):
        path = await render(seg, voice, rate, i, out)
        secs = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        print(f"    {path.name}  {float(secs):.1f}s")


if __name__ == "__main__":
    asyncio.run(main())
