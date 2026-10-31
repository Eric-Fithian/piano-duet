import assert from "node:assert/strict";
import test from "node:test";
import { checkYoutubeUrl, missingAudioMessage, tabCaptureUnavailable, MISSING_TAB_AUDIO, UNSUPPORTED_TAB_AUDIO } from "../../site/app/src/youtube-link.ts";

test("YouTube links use the same allowed schemes and hosts as the Mac app", () => {
  for (const url of ["https://youtube.com/watch?v=example", "https://www.youtube.com/watch?v=example", "http://youtu.be/example", "https://m.youtube.com/watch?v=example", "https://music.youtube.com/watch?v=example"]) {
    assert.equal(checkYoutubeUrl(url), url);
  }
  for (const url of ["https://youtube.com.evil.test/watch", "https://evil.test/youtube.com", "file://youtube.com/watch", "not a url"]) {
    assert.throws(() => checkYoutubeUrl(url), { message: "Paste a link to a YouTube video." });
  }
});

test("tab audio support messages distinguish unsupported browsers from an unchecked audio option", () => {
  assert.equal(tabCaptureUnavailable(false, "Chrome", 0), true);
  assert.equal(tabCaptureUnavailable(true, "Mozilla iPhone", 5), true);
  assert.equal(tabCaptureUnavailable(true, "Mozilla Macintosh", 5), true);
  assert.equal(tabCaptureUnavailable(true, "Mozilla Windows Chrome/130", 0), false);
  assert.equal(missingAudioMessage("Mozilla Chrome/130"), MISSING_TAB_AUDIO);
  assert.equal(missingAudioMessage("Mozilla Firefox/130"), UNSUPPORTED_TAB_AUDIO);
  assert.equal(missingAudioMessage("Mozilla Safari/605"), UNSUPPORTED_TAB_AUDIO);
});
