import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
from imageio_ffmpeg import get_ffmpeg_exe
from yt_dlp import YoutubeDL

from piano_duet.recording_transcription import SAMPLE_RATE
from piano_duet.score_import import ScoreError

CACHE = Path(".cache/youtube")
MAX_SECONDS = 15 * 60
HOSTS = ("youtube.com", "youtu.be")


def main():
    print(f"Downloads YouTube audio into {CACHE} only for as long as transcription needs it.")


def check_url(url):
    host = (urlparse(url).hostname or "").removeprefix("www.").removeprefix("m.").removeprefix("music.")
    if urlparse(url).scheme not in ("http", "https") or host not in HOSTS:
        raise ScoreError("Paste a link to a single YouTube video")


def decode(path):
    pcm = subprocess.run(
        # The bundled ffmpeg keeps decoding independent of Homebrew library upgrades.
        [get_ffmpeg_exe(), "-nostdin", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(pcm, dtype="<f4").copy()


def fetch_audio(url, on_progress, cancel):
    """Returns mono 44.1 kHz audio and the video's details; the downloaded file is deleted on return."""
    check_url(url)
    CACHE.mkdir(parents=True, exist_ok=True)

    def hook(status):
        if cancel.is_set():
            raise ScoreError("The import was cancelled")
        total = status.get("total_bytes") or status.get("total_bytes_estimate")
        if status["status"] == "downloading" and total:
            on_progress(status.get("downloaded_bytes", 0) / total)

    with tempfile.TemporaryDirectory(dir=CACHE) as folder:
        options = {"format": "bestaudio/best", "outtmpl": f"{folder}/%(id)s.%(ext)s", "noplaylist": True,
                   "quiet": True, "no_warnings": True, "progress_hooks": [hook],
                   "ffmpeg_location": get_ffmpeg_exe()}
        with YoutubeDL(options) as client:
            info = client.extract_info(url, download=False)
            if info.get("_type") == "playlist":
                raise ScoreError("Paste a link to a single video, not a playlist")
            if not info.get("duration") or info["duration"] > MAX_SECONDS:
                raise ScoreError(f"Videos up to {MAX_SECONDS // 60} minutes can be transcribed")
            info = client.process_ie_result(info, download=True)
        audio = decode(info["requested_downloads"][0]["filepath"])
    return audio, {"id": info["id"], "title": info["title"], "channel": info.get("channel") or info.get("uploader"),
                   "url": info.get("webpage_url", url)}


if __name__ == "__main__":
    main()
