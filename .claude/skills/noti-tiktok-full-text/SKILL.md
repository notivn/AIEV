---
name: noti-tiktok-full-text
description: Build a Vietnamese vertical TikTok explainer in the "MỔ XẺ PAPER AI" (AI paper dissection) format with HyperFrames (HTML/CSS/GSAP → MP4), Noti.vn style. N text scenes + PDF paper-page scenes, every piece of text a real HTML element (reveal/count-up/red highlight), animated captions, stat callouts, comparison tables, pull-quotes. Picks sound effects itself by content + timestamp from the `assets/sound-effects/` library (tag `hay-dung`) and wires them into the video. The fix for Vietnamese text losing diacritics is built in. Use when the user brings a transcript + paper page images + figures and wants a paper dissection/explainer video.
---

# TikTok Full-Text - the "MỔ XẺ PAPER AI" explainer (Noti.vn)

## ⚖️ STYLE DESIGN - PRIORITY RULE (read this first)

If the edit prompt contains a **"STYLE DESIGN (BẮT BUỘC TUÂN THỦ 100%)"** section: the palette, fonts and tone
in that section **COMPLETELY REPLACE** every color/font/branding rule in this skill
(including "dark fintech blue", the GĐT hex values, the default gradient...). Keep only: animation technique,
layout, cutting rhythm, render workflow, the bug fixes. Illustrations generated through /api/illustrations
must pass the correct styleId in the prompt. NO Style Design section → use the skill's default branding.

If the edit prompt ALSO contains a **"PHONG CÁCH DỰNG"** (video style) section: that section **WINS over this
skill** for ALL visual and motion language - materials, transitions, camera moves, effects. This skill then
keeps only PROCESS: step order, cutting, captions/keys, draft→final, QC. Do not mix the skill's default
visuals into the video style - half-and-half is exactly the failure this rule exists to prevent.

Build a Vietnamese vertical explainer with HyperFrames (HTML/CSS/JS + GSAP → MP4).
All text is a **real HTML element** so it can be animated and stays razor sharp. There are text scenes and PDF paper-page scenes.

> ⚡ Read this whole file before building. Every ⚠️ section is a bug already hit & already fixed - do NOT repeat it.
> Project structure: scaffold with `npx hyperframes init`, then follow the layout in the `video-pipeline` skill (`index.html` + `compositions/` + `assets/` + `renders/` + `hyperframes.json` + `meta.json`). (`video-projects/sapo/` is an example project on the author's machine, NOT shipped with the repo - `video-projects/` is gitignored.)

---

## ROLE
HyperFrames video editor. Compose HTML/CSS/JS, animate with GSAP, render a vertical MP4. Genre: "MỔ XẺ PAPER AI" - a vertical explainer, Noti.vn style.

## OUTPUT SPEC
- 9:16 - **1080×1920**, **30fps**.
- N scenes (12 by default). Each scene = its own HTML sub-composition (`<template>` + `data-composition-src`), declaring `data-start`/`data-duration`/`data-track-index`.
- Safe zone: important text + captions inside the central 1080×1400 area, leaving **15% at the bottom (~288px)** + the right corner (~130px). Put captions at `bottom: ~372px`.

## ⚠️ VIETNAMESE FONT - NO MISTAKES ALLOWED (tofu / missing diacritics)
1. Font "Be Vietnam Pro" or "Inter" vietnamese subset, `display=block`. Embed via Google Fonts - the HyperFrames renderer **fetches + caches it and injects a deterministic @font-face on its own**:
   ```html
   <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800;900&display=block&subset=vietnamese" rel="stylesheet">
   ```
2. `<meta charset="UTF-8">`, `<html lang="vi">`, `font-display: block`.
3. End the fallback chain with a font that has diacritics: `font-family: "Be Vietnam Pro","Inter",sans-serif;` - do NOT end on a bare `sans-serif`.
4. This test string must render 100% correctly: `Vấn đề: càng siết càng tệ - ƯỢ Ễ Ỹ ặ ậ ề thiết kế ngữ cảnh`. If you see boxes or missing marks, fix the font before anything else.

### ⚠️⚠️ MANDATORY FIX - GRADIENT TEXT GETTING ITS DIACRITICS CLIPPED
Text using `background-clip:text; color:transparent` (blue gradient headings) **CLIPS TALL STACKED DIACRITICS** (Ẫ Ể Ấ Ữ Ổ Ợ…) because the marks stick out above the fill box. `padding-top: 0.14em` IS NOT ENOUGH - it must be **0.5em**. Apply it to EVERY gradient text line:
```css
.heading-grad {
  background: linear-gradient(100deg,#0061ff,#00c2ff);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  line-height: 1.0; padding-top: 0.5em; padding-bottom: 0.14em;
}
```
Plain white/solid-color text (no background-clip) does NOT have this bug - only gradient text needs fixing. When verifying: zoom 3× into the glyphs with stacked marks to check.

### ⚠️ Captions / multiple lines at the same spot - must NOT OVERLAP
Captions (and any text placed at the same spot) when the video is spoken **continuously with no pauses**: the previous line has not finished fading out when the next one fades in → they stack, the text turns to mush. Fix: `PRE_ROLL = 0`, the previous line goes fully off exactly when the next appears:
```js
const inAts = SEGMENTS.map(s => Math.max(s.words[0].start, 0));
// fadeInAt = inAts[i];
// fadeOutAt = (i<n-1) ? Math.max(segEnd+0.02, inAts[i+1] - FADE_OUT) : segEnd + POST_HOLD;
```
Pull an extra frame right at the BOUNDARY between two caption lines.

## ⚠️ TEXT MUST BE A REAL HTML ELEMENT
- ALL Vietnamese text (headings, figures, captions, labels, quotes) is an `<h1>/<p>/<span>` - do NOT bake text into images, no PNGs with text already in them.
- Images are only used as background: **the original PDF paper page** (with no Vietnamese text pre-overlaid).
- Why: you need to animate it (reveal, count-up, per-word color change) and the glyph edges stay sharp when rendered.

### ⚠️ Sub-compositions render IN ISOLATION
Every sub-comp (`data-composition-src`) renders in its own context, inheriting NOTHING from the master:
- Every sub-comp has its own `<script src=".../gsap@3.14.2/dist/gsap.min.js">`.
- Every sub-comp with text embeds its own Google font `<link>` (inside the `<template>`).
- Do NOT use the master's `:root` CSS vars inside a sub-comp - use literal values (hex/gradient written out).

---

## DESIGN SYSTEM (Noti.vn / GĐT)
**Backgrounds:**
- Text scenes: dark `#0A0E1A → #0F1629` (radial/linear gradient), 1–2 blue blobs (`#0061ff`,`#00c2ff`) at blur 120px drifting slowly in parallax, grain noise at opacity ~0.04, vignette.
- Paper scenes: the PDF page on a light background, 16px radius + soft shadow; the edge drawn by box-shadow (NOT a hard border).

**Color:**
- Primary text white `#F5F7FA`. Secondary/already-read text grey `#6E7787`.
- Brand accent (heading keywords): gradient `#0061ff → #00c2ff` via `background-clip:text` (remember the 0.5em padding fix).
- ACCENT: orange-red `#FF4D2E` for bad numbers, hot keywords in captions, arrows.
- HIGHLIGHT: light red background `rgba(255,77,46,0.18)` with a 6px radius (replacing the yellow highlighter), animated as a left→right sweep over 0.6s with `clip-path`.
- Glass card: `rgba(255,255,255,0.06)`, `backdrop-filter: blur(20px)`, 16–20px radius, edge drawn by box-shadow:
  `inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 0 1px rgba(255,255,255,0.05), 0 18px 50px rgba(0,0,0,0.45)`.

**Type:** headings 800–900 (keywords in blue gradient/white); figures 900, 140–200px (bad numbers in orange-red); captions 700 + a light black text-shadow.

## COMPONENTS (reusable)
1. **Page counter** top left "01 / 12", grey, wide letter-spacing.
2. **Never add your own corner logo/watermark** - the Remotion assembly layer stamps the Style Design logo automatically when the style has one (adding your own means two logos stacked). No "@noti.vn" text, no TikTok text; leave the bottom right corner empty.
3. **Animated caption** bottom center, chunks of 3–6 words on their timestamps, one keyword in orange-red, fade+slide-up 0.25s (obeying the no-overlapping-lines rule above).
4. **Stat callout** "95.8% → 58.3%": big figures at 900, the bad number in orange-red, the → arrow in orange-red, count-up as it appears.
5. **List item**: a huge "01" + title + grey sub-label, with a vertical blue gradient bar on the left.
6. **Comparison table**: glass rows at 14px radius, grey label on the left + big white value on the right, the key row highlighted on a light red background; stagger 0.1s.
7. **Pull-quote**: a big faded " mark on top, the quote bold and centered, fading in line by line, the payoff words highlighted light red.
8. **Pill badge**: "ARXIV xxxx.xxxxx" on a rounded glass background, small white uppercase text.
9. **Outro**: a question + a "Drop ý kiến vào comment" button (glass pill + SVG icon), a few floating emoji.

## PAPER SCENE
- Show the real PDF page (the user supplies an image per page), slow Ken Burns zoom/pan over 6–8s. ⚠️ Wrap the `<img>` in a `<div>` and animate the WRAPPER (never animate width/top/left directly on an img/video).
- Vietnamese heading overlay + the ARXIV pill - both real HTML elements.
- Light red highlight over 1–2 payoff sentences: an HTML highlight box laid on top, animated with a horizontal `clip-path` sweep.

## EFFECTS (GSAP)
- Text reveal: y 40→0 + opacity 0→1, stagger 0.06s, ease `power3.out`.
- Figures: count-up (tween 1 object + onUpdate) + scale-pop 0.9→1.03→1.
- Light red highlight: `clip-path: inset(0 100% 0 0)` → `inset(0 0% 0 0)`.
- Scene change (blur-dissolve - verified, see the ⚠️ TRANSITION section below); paper scenes zoom-fade.
- ⚠️ NEVER use `setTimeout`/`Date.now()`/`Math.random()` - GSAP timeline only (deterministic). Every animation locked to the FPS.

## ⚠️ SCENE TRANSITION (blur-dissolve - the pattern that works)
Standard layout: the background (`ambient-bg`) is one sub-comp **running continuously end to end** on its own track behind everything; each text scene is a **transparent layer** (no background of its own). Because the background is continuous, the transition **only animates the text**, no background crossfade needed.
1. **Every scene handles its own entrance + exit inside its own timeline.** Do NOT overlap clips, do NOT switch tracks, do NOT animate wrapper opacity at the master level → this keeps the caption/SFX sync intact.
2. **The exit (end of each scene, ~0.3s before the cut)** = fade + slide up + **blur** in a single tween, ease `power2.in`:
   ```js
   // applies to the scene's content wrapper + page counter (EXCEPT the final outro scene - no exit there)
   tl.to([sel(".sX-wrap"), sel(".counter")],
     { opacity: 0, y: -16, filter: "blur(10px)", duration: 0.32, ease: "power2.in" }, EXIT_AT);
   ```
   Set `EXIT_AT` so that `EXIT_AT + 0.32 ≈ data-duration` of the scene. Still pad with `tl.set({}, {}, DUR)` at the end (Law 11).
3. **The entrance (start of the next scene)** = fade + staggered line-by-line reveal (already part of the standard reveal) → the eye reads it as "the old text blurs away → the new text arrives".
4. ⚠️ This is a **dissolve over a shared background**, NOT a crossfade of two overlapping scenes. A true overlapping crossfade (the new scene's text appearing while the old text is still dissolving) requires alternating tracks (e.g. 2↔14) + a ~0.35s time overlap - heavier, only do it if the user asks.
5. Captions live on **their own track** → they never pick up the scene blur → the subtitles stay sharp right through the transition (that is intentional, do not "fix" it).
6. Strength: `blur(8–12px)`. Verify: extract a frame **mid exit move** with an accurate seek, `ffmpeg -i in.mp4 -ss <t> -frames:v 1` (put `-ss` AFTER `-i`; `-ss` before `-i` fast-seeks to a keyframe → you miss the move and wrongly conclude the blur is not running).

---

## SOUND EFFECT (SFX) - pick them yourself & wire them to timestamps
Add SFX to punctuate the video (figures, reveals, scene changes, punchlines). Take them from the **pre-curated** library:
`assets/sound-effects/` - from inside a project: `../../assets/sound-effects/`. The recommended set = the entries tagged `hay-dung` in `assets/sound-effects/library.json`. Skip any entry whose file is not on disk - library.json still lists a few files that are not shipped with the repo.
The exact `<audio id="sfx-*">` wiring is in "Wiring technique (HyperFrames)" below.

### Picking SFX yourself (by content + timestamp)
1. Read the transcript + caption timestamps + storyboard → find the "accent points" that need sound: figures/stat count-ups, keyword reveals, a paper scene opening, the red highlight on a payoff line, hard scene changes, the outro CTA, a punchline/shock line.
2. Map each accent point → 1 semantically fitting SFX (table below). **`data-start` = the exact EVENT beat** (the number starting its count-up / the text starting its reveal / the scene cut frame), NOT the vague start of the scene.
3. ⚠️ Restraint: about 1 SFX every 3–6s, not one hit per line of text (it dilutes them and tires the ear). A ~60s video wants ~6–12 SFX. Vary the files, avoid repeating a single sound too densely.
4. **Present the SFX table to the user for approval** (timecode | event | file | volume) together with the storyboard before wiring anything in.

### Semantic map → file (in `assets/sound-effects/`)
| Content context | File |
|---|---|
| good numbers / score / positive reveal / correct tick | `ding.mp3`, `ting.wav` |
| money / profit / cost / "tỷ", "doanh thu", "$" | `ka-ching.mp3`, `money.mp3`, `buy.mp3` |
| text/element popping in, light transition | `pop.mp3` |
| snapshot/image/screenshot / a PDF paper scene appearing | `camera-snap.wav`, `camera-flash-1.wav` |
| bad numbers / wrong / warning / "tệ", "giảm", "lỗi" | `error.mp3` |
| shock reveal / wow / surprise | `anime-wow-1.mp3` |
| typing / code / data entry | `mechanical-keyboard.mp3`, `iphone-typing.mp3` |
| UI click / selection / button press | `click-button.mp3`, `mouse-click.mp3` |
| comedic punchline / sarcasm / light fail | `dry-fart.mp3`, `fart-echo.mp3`, `duck-toy.mp3`, `jontron-what.mp3` |
| "ăn" / swallowing / merging / consuming | `chomp.mp3` |

(.wav and .mp3 both work - the right meaning matters more than the format.)

### Wiring technique (HyperFrames)
1. **Copy** the chosen file into the project's `assets/sfx/` (keeps the project portable - do NOT let `src` point outside the project folder).
2. Each SFX = its own `<audio>` in the root composition, next to the narration `<audio>`. ⚠️ NO `class="clip"` on `<audio>` (Render Contract - it breaks audio):
   ```html
   <audio id="sfx-stat1" data-start="12.46" data-duration="2.0" data-track-index="6" data-volume="0.5" src="assets/sfx/ka-ching.mp3"></audio>
   ```
3. ⚠️ Every SFX gets its OWN `data-track-index` (e.g. 4,5,6,…) - clips on the same track must NOT overlap in time. Narration is on track 0; SFX use tracks **4 and up** (so they never collide with the visual scene tracks).
4. ⚠️ Volume: SFX `data-volume` **0.4–0.6** (under the narration at 1.0) so they never bury the voice. Comedic/punch SFX can go 0.55–0.65.
5. `data-duration` long enough for the SFX to finish ringing (1–3s); too short and it gets cut off. It does not need to match the scene length.

---

## ⚠️ ENVIRONMENT (Windows) + TRANSCRIPTION
- Install FFmpeg with `winget install Gyan.FFmpeg`. The PATH change only applies to NEW shells → when calling `npx hyperframes` you must prepend the bin to `$env:Path` inline.
- `npm install` at the repo root; `npx hyperframes browser ensure`.
- ⚠️ `npx hyperframes transcribe` needs an external `whisper-cpp` + an `.en` English-only model → do NOT use it for Vietnamese.
- Vietnamese transcription: **faster-whisper** `large-v3`, `language="vi"`, `word_timestamps=True` (in Python: `sys.stdout.reconfigure(encoding="utf-8")`). Prefer `device="cuda", compute_type="float16"` (on a GTX 1660: twice as fast, and it frees the CPU), with a try/except fallback to `device="cpu", compute_type="int8"`. Extract the audio: `ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 audio.wav`. Fix Whisper's misheard proper nouns (e.g. Anthopix→Anthropic, Cloudy→Claude).

## TRIMMING TO HIGHLIGHTS (if the source video is long)
ffmpeg `filter_complex` trim+concat several stretches into a re-encoded face.mp4; remap the word timestamps (new = orig - accumulated shift); generate captions grouped by punctuation / speech pause (gap > ~0.38s) / max 7 words.

## RENDER CONTRACT (must)
- Root: `id`, `data-composition-id`, `data-start="0"`, `data-width`, `data-height`.
- Any timed element needs `class="clip"` (EXCEPT `<video>`/`<audio>`), plus `data-start`/`data-duration`/`data-track-index`. Clips on the same track must NOT overlap in time (watch out for float rounding - leave a ~0.04s margin).
- `<video>` must be `muted`; audio goes in its own `<audio>`. Do NOT animate width/height/top/left on a `<video>`/`<img>` - wrap it in a div and animate the wrapper (scale transforms are fine).
- Every composition registers exactly 1 `paused` timeline on `window.__timelines["<data-composition-id>"]` (the key must match exactly). Comp duration = `tl.duration()`. **Pad the full slot**: `tl.set({}, {}, DUR)` at the end of every timeline (Law 11 - shorter than data-duration → black frames).

## WORKFLOW
1. The user supplies: the Vietnamese transcript + timestamps + images of the paper pages + the figures to emphasize.
2. Split into N scenes, map the components, set data-start/data-duration. **Present the storyboard to the user for approval** (table: scene | duration | component | content).
3. **Pick the SFX**: scan the accent points by timestamp → map files from `assets/sound-effects/` (prefer the `hay-dung` tag in `library.json`) → copy into `assets/sfx/` → **present the SFX table to the user for approval** (timecode | event | file | volume).
4. Verify the font (test string, 1080×1920 screenshot) + confirm ALL text is a real HTML element.
5. `npx hyperframes lint` (0 errors; the self-selector/google-fonts/font-face warnings are benign).
6. Test-render 1 text scene + 1 paper scene (draft) → extract frames + **zoom 3× to check the diacritics** + check the caption boundaries + timing → **listen back and check the SFX lands on its beat and never buries the voice** → fix → render the full draft.
7. User approves → render final with `--quality standard`.

## COMMANDS (inside `video-projects/<project>/`)
```powershell
$bin="...\ffmpeg-...\bin"; $env:Path="$bin;$env:Path"
npx hyperframes lint
npx hyperframes compositions
npx hyperframes render --quality draft    --output renders/draft.mp4
npx hyperframes render --quality standard --output renders/final.mp4
# verify diacritics: ffmpeg -ss <t> -i renders/draft.mp4 -frames:v 1 -vf "crop=700:340:60:260,scale=1400:680:flags=neighbor" out.png → Read out.png
# copy an SFX into the project: cp ../../assets/sound-effects/<file> assets/sfx/
# verify SFX: ffmpeg -ss <t> -i renders/draft.mp4 -t 4 -vn out.wav → listen that the SFX lands on its beat and never buries the narration
```

## OUTPUT - hand off to the pipeline
`renders/final.mp4` is NOT the finished product. Continue with the `video-pipeline` skill: automated QC on the draft → assemble final via the render queue (Remotion) → `outputs/<id>-v<N>.mp4` → update `meta.json` (status + output) → thumbnail/publish. Report to the user: a timeline table: scene | duration | component | content + an **SFX table: timecode | event | file | volume**. Clean up the temporary draft/test files when you are done.
