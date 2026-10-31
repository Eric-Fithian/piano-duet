import importlib.util
import io
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("youtube_audio", Path("site/api/youtube-audio.py"))
youtube_audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(youtube_audio)


def main():
    pytest.main([__file__])


@pytest.mark.parametrize("url", [
    "https://youtube.com/watch?v=abcdefghijk", "https://www.youtube.com/watch?v=abcdefghijk&t=1",
    "https://m.youtube.com/shorts/abcdefghijk", "https://music.youtube.com/watch?v=abcdefghijk",
    "https://youtu.be/abcdefghijk", "http://youtube.com/embed/abcdefghijk",
])
def test_video_url_accepts_one_video(url):
    assert youtube_audio.video_url(url) == "https://www.youtube.com/watch?v=abcdefghijk"


@pytest.mark.parametrize("url", [
    "https://youtube.com/watch?v=abcdefghijk&list=PL123", "https://youtube.com/playlist?list=PL123",
    "https://youtube.com.evil.test/watch?v=abcdefghijk", "https://youtube.com@evil.test/watch?v=abcdefghijk",
    "https://evil.test/youtu.be/abcdefghijk", "https://youtu.be/abcdefghijk/extra",
    "file://youtube.com/watch?v=abcdefghijk", "https://youtube.com/watch?v=bad",
    "https://youtube.com/watch?v=abcdefghijk&v=12345678901", "https://youtube.com:443/watch?v=abcdefghijk",
    None, 123, "x" * 2049,
])
def test_video_url_rejects_non_video_or_playlist(url):
    with pytest.raises(ValueError):
        youtube_audio.video_url(url)


@pytest.mark.parametrize(("error", "expected"), [
    ("Sign in to confirm you're not a bot", "blocked this server as a bot"),
    ("HTTP Error 403: Forbidden", "refused the audio download (403)"),
    ("age-restricted video", "requires age verification"),
    ("Sign in to confirm your age", "requires age verification"),
    ("This live event is unavailable", "Live streams"),
    ("not available in your country", "server's region"),
    ("unexpected", "could not provide"),
])
def test_error_message_is_specific(error, expected):
    assert expected in youtube_audio.error_message(error)


def test_duration_is_checked_before_audio_is_opened(monkeypatch):
    class Client:
        def __init__(self, options):
            assert options["cachedir"] is False
            assert options["noplaylist"] is True

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def extract_info(self, url, download):
            assert download is False
            return {"duration": 901, "url": "https://example.test/audio"}

        def urlopen(self, url):
            raise AssertionError("An overlong video must not be downloaded")

    class Request:
        def __init__(self):
            body = b'{"url":"https://youtu.be/abcdefghijk"}'
            self.headers = {"X-Duet-Client": "1", "Content-Length": str(len(body))}
            self.rfile = io.BytesIO(body)
            self.result = None

        def fail(self, status, detail):
            self.result = status, detail

    monkeypatch.setattr(youtube_audio, "YoutubeDL", Client)
    request = Request()
    youtube_audio.handler.do_POST(request)
    assert request.result == (400, "Choose a single video up to 15 minutes long.")


if __name__ == "__main__":
    main()
