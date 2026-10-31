import base64
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from yt_dlp import YoutubeDL
from yt_dlp.networking.exceptions import RequestError
from yt_dlp.utils import DownloadError

MAX_SECONDS = 900
MAX_BYTES = 128_000_000


def main():
    print("YouTube audio is streamed only in response to an import request.")


def video_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("Paste a link to a single YouTube video")
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if host.startswith(("www.", "m.", "music.")):
        host = host.split(".", 1)[1]
    query = parse_qs(parsed.query, keep_blank_values=True)
    if parsed.scheme not in ("http", "https") or host not in ("youtube.com", "youtu.be") or parsed.username or parsed.password or parsed.port:
        raise ValueError("Paste a link to a single YouTube video")
    if "list" in query:
        raise ValueError("Paste a link to a single video, not a playlist")
    parts = parsed.path.strip("/").split("/")
    if host == "youtu.be" and len(parts) == 1:
        video = parts[0]
    elif host == "youtube.com" and parts == ["watch"] and len(query.get("v", [])) == 1:
        video = query["v"][0]
    elif host == "youtube.com" and len(parts) == 2 and parts[0] in ("shorts", "embed", "live"):
        video = parts[1]
    else:
        raise ValueError("Paste a link to a single YouTube video")
    if len(video) != 11 or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for c in video):
        raise ValueError("Paste a link to a single YouTube video")
    return f"https://www.youtube.com/watch?v={video}"


def error_message(error):
    message = str(error).lower()
    if "age" in message and ("restrict" in message or "sign in" in message):
        return "YouTube requires age verification for this video."
    if "sign in to confirm" in message or "bot" in message:
        return "YouTube blocked this server as a bot."
    if "live" in message:
        return "Live streams cannot be imported."
    if "country" in message or "region" in message or "not available in your" in message:
        return "This video is not available in the server's region."
    if "403" in message or "forbidden" in message:
        return "YouTube refused the audio download (403)."
    return "YouTube could not provide this video's audio."


class PrivateLogger:
    # yt-dlp raises failures to the caller, but its default logger also prints video identifiers and URLs.
    def debug(self, message):
        pass

    def warning(self, message):
        pass

    def error(self, message):
        pass


class handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def fail(self, status, detail):
        body = json.dumps({"detail": detail}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.headers.get("X-Duet-Client") != "1":
            self.fail(403, "This request must come from the app.")
            return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 4096:
            self.fail(400, "Paste a link to a single YouTube video")
            return
        try:
            payload = json.loads(self.rfile.read(length))
            url = video_url(payload["url"])
        except (ValueError, KeyError, TypeError):
            self.fail(400, "Paste a link to a single YouTube video, not a playlist.")
            return
        options = {"format": "bestaudio[protocol=https][vcodec=none]", "noplaylist": True, "quiet": True,
                   "no_warnings": True, "cachedir": False, "retries": 0, "extractor_retries": 0,
                   "socket_timeout": 15, "skip_download": True, "logger": PrivateLogger()}
        started = False
        try:
            with YoutubeDL(options) as client:
                info = client.extract_info(url, download=False)
                if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
                    self.fail(400, "Live streams cannot be imported.")
                    return
                if info.get("_type") == "playlist" or not info.get("duration") or info["duration"] > MAX_SECONDS:
                    self.fail(400, "Choose a single video up to 15 minutes long.")
                    return
                stream = client.urlopen(info["url"])
                try:
                    first = stream.read(65536)
                    if not first:
                        raise ValueError("Empty audio stream")
                    size = stream.headers.get("Content-Length")
                    if size and int(size) > MAX_BYTES:
                        self.fail(400, "This audio is too large to import.")
                        return
                    metadata = {"title": info["title"], "channel": info.get("channel") or info.get("uploader") or "",
                                "url": url}
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Cache-Control", "no-store, private")
                    self.send_header("X-Duet-Video", base64.b64encode(json.dumps(metadata, ensure_ascii=False).encode()).decode())
                    if size:
                        self.send_header("Content-Length", size)
                    self.end_headers()
                    started = True
                    total = len(first)
                    self.wfile.write(first)
                    while chunk := stream.read(65536):
                        total += len(chunk)
                        if total > MAX_BYTES:
                            raise ValueError("Audio exceeded the size limit")
                        self.wfile.write(chunk)
                finally:
                    stream.close()
        except (DownloadError, RequestError, OSError, ValueError) as error:
            if not started:
                self.fail(502, error_message(error))
            else:
                raise RuntimeError("YouTube audio stream failed") from None


if __name__ == "__main__":
    main()
