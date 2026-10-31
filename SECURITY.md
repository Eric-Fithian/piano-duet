# Security policy

Piano Duet runs a server on your own Mac, bound to `127.0.0.1`. It accepts only requests addressed to `127.0.0.1` or `localhost`, and refuses state-changing requests from other origins. It makes no network requests while you play.

The web app's YouTube download endpoint needs a Vercel WAF rate-limit rule before public use: match path exactly `/api/youtube-audio`, count by IP, allow 10 requests per 10 minutes, then deny excess requests. Vercel's declarative route mitigation supports deny and challenge but not rate limiting, so this rule must be reviewed and published in the project's firewall configuration. The `X-Duet-Client` header is a cross-origin request barrier, not a secret or a substitute for rate limiting.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/Eric-Fithian/piano-duet/security/advisories/new), not in a public issue. Include the version or commit, the steps to reproduce, and what an attacker could do. You should hear back within a week.

Issues of particular interest:

- A web page in the browser reading or changing the local server's data, for example through DNS rebinding or cross-origin requests
- Imported files (MIDI, MusicXML, YouTube audio) that execute code or read files outside the app
- The installer or `piano-duet setup` fetching something other than the pinned, verified assets

Only the latest release is supported.
