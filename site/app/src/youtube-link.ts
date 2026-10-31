export const UNSUPPORTED_TAB_AUDIO = "This browser can't share tab audio. Use Chrome or Edge, or play the video aloud and use Record.";
export const MISSING_TAB_AUDIO = "No tab audio was shared. Choose the YouTube tab and keep ‘Also share tab audio’ checked, or play the video aloud and use Record.";

export function checkYoutubeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Paste a link to a YouTube video."); }
  let host = url.hostname;
  for (const prefix of ["www.", "m.", "music."]) if (host.startsWith(prefix)) host = host.slice(prefix.length);
  if (!["http:", "https:"].includes(url.protocol) || !["youtube.com", "youtu.be"].includes(host)) throw new Error("Paste a link to a YouTube video.");
  if (value.length > 2048) throw new Error("The YouTube link is too long.");
  return url.href;
}

export function tabCaptureUnavailable(hasDisplayMedia: boolean, userAgent: string, touchPoints: number): boolean {
  const agent = userAgent.toLowerCase();
  return !hasDisplayMedia || ["iphone", "ipad", "ipod", "android", "mobile"].some((part) => agent.includes(part))
    || (agent.includes("macintosh") && touchPoints > 1);
}

export function missingAudioMessage(userAgent: string): string {
  const agent = userAgent.toLowerCase();
  return agent.includes("chrome/") || agent.includes("edg/") ? MISSING_TAB_AUDIO : UNSUPPORTED_TAB_AUDIO;
}
