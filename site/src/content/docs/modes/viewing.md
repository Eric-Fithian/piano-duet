---
title: Viewing the music
description: Zoom, layout, following and look-ahead, shared by every score in the app.
---

Every score in the app uses the same viewer, with a small control at its bottom right:

- **− / +** zooms from 50% to 200%. Wrapped lines reflow, so zooming out fits more bars on each line, drawn smaller. A pinch on the trackpad zooms too.
- **☰** opens the view options. **Layout** is **Lines**, which wrap down the page, or **One line**, an endless line that scrolls sideways with the clef and key pinned at the left. **Follow along** can **Glide**, which moves smoothly and starts toward the next line before you reach it, **Turn**, which leaves the music still until the next line needs to come into view, or be **Off**. **Look ahead** sets how much of what is coming stays in view, from **Less** (more of what you just played stays visible) to **More**.
- Scrolling by hand pauses following; **Resume following** picks it up again, as does moving on to the next line.

Each part of the app (Reading, Drills, the Library and its editor) remembers its own settings on this Mac. In code, each part chooses its staff size and which layers it draws over the music: the reading cursor, green and red note feedback, the wrong notes you are holding, the tempo guide, and the highlight of notes sounding during playback. Each line is drawn as its own image sized to what it contains, so low beams or ledger-line notes never spill into the next line.
