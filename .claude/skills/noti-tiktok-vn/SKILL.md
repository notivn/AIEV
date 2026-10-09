---
name: noti-tiktok-vn
description: Edit a Vietnamese vertical TikTok video (9:16) with HyperFrames following the Noti.vn/GĐT standard - talking-head + kinetic typography + karaoke captions + zoom/punch-in camera + timestamp-synced sound effects, rendered to MP4. Ships with the verified fixes (gradient text dropping diacritics, Vietnamese transcription, ffmpeg PATH). Use when the user hands over a Vietnamese clip and wants it built into a TikTok video with animated text + subtitles + beat-synced zoom in the dark fintech blue style.
---

# TikTok VN Edit - the Noti.vn / GĐT standard

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

This skill builds Vietnamese vertical TikTok videos with HyperFrames (HTML/CSS/JS + GSAP → MP4).
**Project structure:** scaffold with `npx hyperframes init`, then follow the layout documented in the `video-pipeline` skill: `index.html` + `compositions/*.html` + `assets/` + `renders/` + `hyperframes.json` + `meta.json`.
(`video-projects/sapo/` is an example project on the author's machine and is NOT shipped with the repo - `video-projects/` is gitignored. If that folder is absent, everything you need is written out inline below.)

> ⚡ Read this whole file before building. Every ⚠️ section is a bug already hit & already fixed - do NOT repeat it.

---

## ROLE
Video editor working in HyperFrames. Compose HTML/CSS/JS, animate with GSAP, render a vertical MP4.

## OUTPUT SPEC
- 9:16 - **1080×1920**, **30fps** (60fps if there is a lot of kinetic typography).
- TikTok safe zone: leave **15% at the bottom (~288px)** + **12% on the right (~130px)**. Important text + CTA go in the safe upper-middle area. Put captions at `bottom: ~372px` (above the app button column).
- Each scene = its own HTML sub-composition (`<template>` + `data-composition-src`), timed via `data-start`/`data-duration`/`data-track-index`.

## STYLE (Noti.vn / GĐT)
- Dark background `#0A0E1A → #0F1629` (gradient) + light grain.
- Accent gradient text: `linear-gradient(100deg, #0061ff, #00c2ff)` via `background-clip:text` for headings.
- Glassmorphism: `background: rgba(255,255,255,0.06); backdrop-filter: blur(20px); border-radius: 20px;` with the edge drawn by box-shadow (do NOT use a hard 1px border):
  `box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 0 1px rgba(255,255,255,0.05), 0 18px 50px rgba(0,0,0,0.45);`
- Type: headings weight 800, subheads 600, body 400. Tight letter-spacing (`-0.03em`) on large headings.
- Glow on emphasized text: `filter: drop-shadow(0 0 26px rgba(0,140,255,0.4))` (drop-shadow for gradient text, NOT text-shadow, because the glyphs are transparent).

## EFFECTS (GSAP)
- Text reveal: y 40→0, opacity 0→1, stagger 0.06–0.09, ease `power3.out`.
- Kinetic keyword: scale-pop 0.8→1.05→1 + glow flash (tween the `filter` drop-shadow).
- Karaoke caption: locked to timestamps, chunks of 4–7 words, the word being spoken highlighted `#19c8ff` + scale 1.13.
- Scene changes: blur+fade crossfade 0.4s by default; slide-push (`power4.inOut`) on fast beats; scale-zoom on accent scenes (see the 🔍 ZOOM section).
- Background: slow drifting blue gradient blobs (parallax) + deterministic CSS grain.
- ⚠️ NEVER use `setTimeout`/`Date.now()`/`Math.random()` - GSAP timeline only (HyperFrames captures frames by timeline time). Every animation must be deterministic.

---

## 🔍 ZOOM / PUNCH-IN (kills static, boring footage)
A talking head sitting still for 30–60s is deadly dull. Add camera motion (zoom) **locked to timestamps + matched to SFX + fitting the content** to hold the eye. This is the main retention driver → it is MANDATORY in every video, unless the video style's (PHONG CÁCH DỰNG) motion spec says otherwise.

### ⚠️⚠️ TECHNIQUE (MANDATORY - getting this wrong freezes the frame)
- NEVER animate `width/height/top/left` on a `<video>` → the frame freezes (already noted in RENDER CONTRACT). **Zoom = animate `scale` (transform) on the DIV wrapping the video** (`#face-wrapper`), never directly on the `<video>`.
  ```css
  #face-wrapper { position:absolute; inset:0; overflow:hidden; will-change:transform; }
  #face-video { width:100%; height:100%; object-fit:cover; }
  ```
  ```js
  // aim transform-origin at the PERSON'S FACE (not the frame center) so the zoom lands on the face, not the forehead/chin
  gsap.set("#face-wrapper", { transformOrigin: "50% 38%" });
  // accent punch-in: snap in, hold, release
  tl.to("#face-wrapper", { scale: 1.12, duration: 0.30, ease: "power4.out" }, AT)
    .to("#face-wrapper", { scale: 1.0,  duration: 0.45, ease: "power2.inOut" }, AT + HOLD);
  ```
- ⚠️ Zoom the **face layer only** (the video wrapper). Do NOT put captions/kinetic text/SFX inside the zoomed wrapper - captions must stay put inside the safe zone, otherwise they drift or get clipped during the zoom.
- ⚠️ Keep `transform-origin` fixed for the whole zoom move (do not change it mid-move → visible jerk). Every tween deterministic (GSAP timeline, no setTimeout/random).
- ⚠️ Scaling up exposes the frame edges → the wrapper must be `overflow:hidden` and the video `object-fit:cover` with enough overscan; keep the punch amplitude small (see below) so the edge never reveals the background.

### 3 zoom types (pick by content)
| Type | When to use | Amplitude & ease |
|---|---|---|
| **Accent punch-in** (snap in, then release) | The payoff line/punchline, a shocking number, an expensive keyword, when the voice rises/tightens | `1.0→1.10–1.14`, snap in `power4.out` 0.25–0.4s, hold ~0.6–1s then release `power2.inOut` |
| **Ken Burns drift** (very slow, continuous zoom) | Bed for ordinary long stretches of speech so the shot never goes static | `1.0→1.05` (or 1.05→1.0) stretched across the whole beat, ease `none`/`sine.inOut` - barely visible but kills the static feel |
| **Zoom-out reveal** (start close → pull back) | Opening a new scene, dropping the tempo, changing idea, "step back and see the whole picture" | `1.12→1.0`, ease `power3.out` ~0.5s |

### Sync rules (timestamp ↔ content ↔ SFX)
1. **Zoom beat = content beat**: the punch-in must land exactly on the frame where the keyword/number **starts** appearing (taken from the caption word timestamps), never placed at random.
2. **Zoom matches the SFX**: the punch-in scale-up must **coincide exactly with the onset of the accent SFX** (e.g. `pop.mp3`/`ding.mp3`/`anime-wow-1.mp3`) → the SFX `data-start` = the moment the scale tween begins. Eye sees the zoom and ear hears the hit on the same frame → the accent is doubled (see the 🔊 SOUND EFFECT section).
3. **Fit the content & the emotion**: zoom IN on emphasis/tension/numbers/punchlines; zoom OUT on scene openings/reveals/tempo drops; leave the rest on a light Ken Burns or hold still. Never zoom against the emotion (e.g. zooming out during a hard payoff line).
4. **Restraint**: roughly 1 accent zoom every **4–8s**, do NOT zoom on every sentence (dizzying, and the accent stops meaning anything). Between accents let the Ken Burns run underneath.

### Verify the zoom (mandatory on the draft render)
Extract frames **right at the edges of the zoom move** (start, peak, end) - e.g. for a punch at 14.2s pull 14.1 / 14.4 / 15.0s - and check: the face scales smoothly with no distortion/freeze, **no background edge exposed**, the caption still sits still in place, and the zoom landing matches the SFX onset (listen back to that stretch).

---

## 🔊 SOUND EFFECT (synced with the zoom & the content)
Shared library: `assets/sound-effects/` (from inside a project: `../../assets/sound-effects/`). The recommended set = the entries tagged `hay-dung` in `assets/sound-effects/library.json`. Skip any entry whose file is not on disk - library.json still lists a few files that are not shipped with the repo. The exact `<audio id="sfx-*">` wiring is in "Wiring it in" below.

### Picking SFX yourself (by content + timestamp + zoom)
1. Read the transcript + caption timestamps + storyboard → find the "accent points" that need sound: numbers/count-ups, keyword reveals, **punch-in zoom beats**, hard scene changes, punchlines, the closing CTA.
2. Map each accent point → 1 semantically fitting SFX. `data-start` = the exact EVENT beat (= the zoom beat if that accent has a zoom), NOT the vague start of the scene.
3. ⚠️ Restraint: about 1 SFX every 3–6s, not one hit per sentence. Vary the files, avoid repeating a single sound too densely.
4. **Present the SFX table + the ZOOM table to the user for approval** (timecode | event | zoom | SFX file | volume) together with the storyboard before wiring anything in.

Semantic map → file: good numbers → `ding.mp3`/`ting.wav`; money → `ka-ching.mp3`/`money.mp3`; element/keyword pop → `pop.mp3`; image/snapshot → `camera-snap.wav`/`camera-flash-1.wav`; bad/wrong numbers → `error.mp3`; wow/punch → `anime-wow-1.mp3`; typing → `mechanical-keyboard.mp3`/`iphone-typing.mp3`; click → `click-button.mp3`/`mouse-click.mp3`.

Wiring it in:
1. **Copy** the chosen file into `assets/sfx/` (keeps the project portable - do NOT let `src` point outside the project).
2. Each SFX = its own `<audio>` in the root composition, next to the narration `<audio>`. ⚠️ NO `class="clip"` on `<audio>` (Render Contract - it breaks audio):
   ```html
   <audio id="sfx-1" data-start="14.20" data-duration="2.0" data-track-index="6" data-volume="0.5" src="assets/sfx/pop.mp3"></audio>
   ```
3. ⚠️ Every SFX gets its OWN `data-track-index` (4,5,6,…) - clips on the same track must NOT overlap in time. Narration is on track 0; SFX use tracks **4 and up**.
4. ⚠️ Volume `data-volume` **0.4–0.6** (under the narration at 1.0) so it never buries the voice; a comedic punch can go 0.55–0.65.
5. `data-duration` long enough for the SFX to finish ringing (1–3s); too short and it gets cut off.

### SFX loudness and lead silence (verified)
Four production-verified lessons - skipping any of them produced audible bugs:
1. **Trim lead silence via `data-media-start`, not by re-encoding.** Many library files carry 0.1–1.0s of silence before the actual sound, so the SFX lands late even with a correct `data-start`. Probe each file with `ffmpeg -af silencedetect=noise=-45dB:d=0.05` and set `data-media-start` (HyperFrames) / `mediaStart` (Remotion manifest) to skip it.
2. **Set the volume with an ffmpeg mix test, not by guessing.** Mix voice + SFX, then measure a NARROW window around the SFX onset (roughly the SFX ring time, e.g. `-ss <onset> -t 1.5` + `volumedetect`/`ebur128`) - a whole-file mean tells you nothing about whether the hit buries the voice at that moment.
3. **When picking SFX, reject by the file's own PEAK, not just its mean loudness.** A file with a modest mean can still have a peak that spikes over the voice.
4. **Give the voice headroom BEFORE layering SFX.** A voice source peaking at -0.0 dB has no room for anything on top - scale it first (measured: peak -0.0 dB → `volume=0.71`), then mix the SFX and re-check true peak.

---

## ⚠️ VIETNAMESE FONT - MANDATORY

1. A font with full VN glyph coverage: **"Be Vietnam Pro"** (preferred) or "Inter" vietnamese subset. NEVER let it fall back to a headless Chromium system font (missing diacritics → tofu).
2. Embed via Google Fonts vietnamese subset, `display=block` - **the HyperFrames renderer fetches & caches it and injects a deterministic @font-face** (verified: log "Fetched ... font face(s) ... Injected deterministic @font-face"):
   ```html
   <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;600;700;800&display=block&subset=vietnamese" rel="stylesheet">
   ```
3. `<meta charset="UTF-8">` + `<html lang="vi">`.
4. `font-display: block` (NOT swap).
5. End the fallback chain with a font that has diacritics: `font-family: "Be Vietnam Pro", "Inter", sans-serif;`
6. This test string must render with 100% of its diacritics: `Ưu đãi độc quyền - giảm giá sốc! Đừng để vụt mất cơ hội này. ƯỢ Ễ Ỹ ặ ậ ề`

### ⚠️⚠️ CRITICAL FIX - GRADIENT TEXT DROPPING DIACRITICS
Heading text using `background-clip:text; color:transparent` will **CLIP TALL STACKED DIACRITICS** (the tilde on Ẫ, the hook on Ể, the circumflex on Ấ…) because the mark sticks out above the gradient fill box → that part never gets painted → it reads as a missing diacritic.
**`padding-top: 0.14em` IS NOT ENOUGH. It must be `0.5em`.** Apply this to EVERY gradient heading line:
```css
.heading-gradient {
  background: linear-gradient(100deg, #0061ff 0%, #00c2ff 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  line-height: 1.0;
  padding-top: 0.5em;     /* stops the tall stacked marks above from being clipped (Ẫ Ể Ấ Ữ Ổ…) */
  padding-bottom: 0.14em; /* stops the dot-below marks from being clipped (Ụ Ộ Ạ Ợ…) */
}
```
Plain WHITE text (no background-clip) does NOT have this bug - overflowing marks still render. Only gradient text needs the fix.

### ⚠️ Captions must NOT OVERLAP each other (continuous speech)
Karaoke captions all sit at the same spot (bottom). If the video is spoken **continuously with no pauses**, the previous line has not finished fading out when the next one fades in → **two lines stacked on top of each other, unreadable**. (This bug stays hidden on clips with plenty of silence.)
**Fix:** the previous line must be FULLY off before/exactly when the next one appears - its fade-out completes at the fade-in time of the next line. Use `PRE_ROLL = 0`, and:
```js
const inAts = SEGMENTS.map(s => Math.max(s.words[0].start, 0));
// per line: fadeInAt = inAts[i];
// fadeOutAt = (i < n-1) ? Math.max(segEnd+0.02, inAts[i+1] - FADE_OUT) : segEnd + POST_HOLD;
```
When verifying, you MUST pull a few extra frames right at the BOUNDARY between two caption lines (not just mid-sentence) to be sure they never overlap.

### ⚠️ Sub-compositions render IN ISOLATION
Every sub-comp (`data-composition-src`) renders in its own context → it inherits NOTHING from the master:
- Every sub-comp must have its **own** `<script src=".../gsap.min.js">`.
- Every sub-comp with text must embed its **own** Google font `<link>` (right inside the `<template>`).
- Do NOT use CSS vars (`var(--accent-grad)`) from the master's `:root` inside a sub-comp - **use literal values** (hex/gradient written out). The var resolves to empty when rendered in isolation.

---

## ⚠️ ENVIRONMENT (Windows)
- **FFmpeg**: install with `winget install Gyan.FFmpeg`. The PATH change only applies to NEW shells → when calling `npx hyperframes`, prepend the bin to `$env:Path` inline:
  `$bin="C:\Users\<user>\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*-full_build\bin"; $env:Path="$bin;$env:Path"`
- `npm install` at the repo root; `npx hyperframes browser ensure` (downloads its own Chromium).
- ⚠️ `npx hyperframes transcribe` needs an external `whisper-cpp` binary (NOT bundled) and an `.en` English-only model → **do not use it for Vietnamese**.

## Vietnamese TRANSCRIPTION
Use **faster-whisper** (`pip install faster-whisper` - a wheel exists for Python 3.14):
```python
import sys; sys.stdout.reconfigure(encoding="utf-8")   # the Windows cp1252 console cannot print diacritics
from faster_whisper import WhisperModel
# GPU first (verified on a GTX 1660: TWICE as fast + frees the CPU for rendering) - fall back to CPU on error
try:
    m = WhisperModel("large-v3", device="cuda", compute_type="float16")
except Exception:
    m = WhisperModel("large-v3", device="cpu", compute_type="int8")
segs, info = m.transcribe("audio.wav", language="vi", word_timestamps=True, vad_filter=True, beam_size=5)
# export JSON {segments:[{start,end,text,words:[{word,start,end}]}]}
```
Extract the audio: `ffmpeg -i input.mp4 -vn -ac 1 -ar 16000 audio.wav`.
Whisper mishears in places (e.g. "bằng bài công nghệ" → actually "về công nghệ") - reread the transcript and clean the captions up so they are correct and tight.

---

## TRIMMING TO HIGHLIGHTS (source clip longer than ~90s)
TikTok suits short video. If the source clip is long, propose trimming to ~30–60s by stitching the strongest stretches:
- Cut and stitch several stretches in one ffmpeg `filter_complex` (trim+atrim+setpts/asetpts → concat) into a cleanly re-encoded `face.mp4`.
- **Remap the timestamps:** for each kept stretch track `(start, end, shift)` (new = orig - shift, where shift accumulates over everything cut before it); filter the words that fall inside kept stretches and convert them to the new timeline → generate the captions.
- Generate captions automatically: group words into lines by **punctuation / speech pause (gap > ~0.38s) / max 7 words** (do not cut hard on word count - it breaks phrases). Fix Whisper's misheard proper nouns in this step.

## WORKFLOW (verified)
1. **Probe + extract frames** from the source video (`ffprobe`, `ffmpeg -ss <t> -frames:v 1`) → determine talking-head or not, duration, fps.
2. **Transcribe** (faster-whisper large-v3, vi) → word-level timestamps.
3. **Storyboard**: cut fillers, split into 4–6 beats (1 idea per beat), set data-start/duration. Mark the **zoom beats** (type + amplitude) against keywords/punchlines/numbers. **Present the storyboard to the user for approval** before writing code.
4. **Pick the ZOOM + SFX** (mandatory): scan the accent points by timestamp → assign each beat a zoom type (punch-in/Ken Burns/zoom-out) + an SFX matched to the onset → copy the SFX into `assets/sfx/` → **present the table to the user for approval (timecode | event | zoom | SFX | volume)**.
5. **Verify the font** with the test string (Playwright screenshot 1080×1920) BEFORE building a lot.
6. **Build**: `index.html` (zoomable face wrapper + narration audio + SFX + scrim + ambient + scenes + captions) + `compositions/*.html`. One file per scene, one `paused` GSAP timeline each, **pad the full slot** with `tl.set({}, {}, DUR)` (Law 11 - a timeline shorter than data-duration → black frames). Zoom = animate `scale` on `#face-wrapper` (NOT on the `<video>`).
7. `npx hyperframes lint` → 0 errors (the `composition_self_attribute_selector`/`google_fonts_import`/`font_family_without_font_face` warnings are benign, ignore them).
8. **Render a draft** → **extract a frame per scene + zoom 3× into the heading area** to check the Vietnamese diacritics (`crop=...,scale=...:flags=neighbor`) + timing + safe zone + **a frame right at each zoom edge** (face smooth, no edge exposed, caption sitting still) + **listen back that the SFX lands on the zoom beat and never buries the voice**. `Read` every PNG. Fix the bugs → render again.
9. User approves → **render final** with `--quality standard`.

## RENDER CONTRACT (must)
- Root: `id`, `data-composition-id`, `data-start="0"`, `data-width`, `data-height`.
- Any timed element needs `class="clip"` (EXCEPT `<video>`/`<audio>`). It needs `data-start`/`data-duration`/`data-track-index`. Clips on the same track must NOT overlap in time (watch out for float rounding: 6.86+1.84=8.7000…1 → overlap; leave a margin).
- `<video>` must be `muted`; audio goes in its own `<audio>` (narration + one `<audio>` per SFX with track-index ≥4, NO `class="clip"`). Do NOT animate width/height/top/left on a `<video>` (freezes the frame) - wrap it in a `#face-wrapper` div and animate `scale` on the wrapper (that is the ZOOM mechanism); scale transforms are fine.
- Every composition registers exactly 1 paused timeline on `window.__timelines["<data-composition-id>"]` (the key must match exactly).
- Comp duration = `tl.duration()`.

## COMMANDS (run inside `video-projects/<project>/`)
```powershell
$bin="...\ffmpeg-...\bin"; $env:Path="$bin;$env:Path"
npx hyperframes lint
npx hyperframes compositions
npx hyperframes render --quality draft    --output renders/draft.mp4
npx hyperframes render --quality standard --output renders/final.mp4
# verify diacritics: ffmpeg -ss <t> -i renders/draft.mp4 -frames:v 1 -vf "crop=700:340:60:260,scale=1400:680:flags=neighbor" out.png  → Read out.png
# verify zoom: extract frames right at the zoom edges (start/peak/end), check the face is smooth, no edge exposed, caption still
# copy SFX: cp ../../assets/sound-effects/<file> assets/sfx/
# verify SFX: ffmpeg -ss <t> -i renders/draft.mp4 -t 4 -vn out.wav  → listen that the SFX lands on the zoom beat and never buries the narration
```

## OUTPUT - hand off to the pipeline
`renders/final.mp4` is NOT the finished product. Continue with the `video-pipeline` skill: automated QC on the draft → assemble final via the render queue (Remotion) → `outputs/<id>-v<N>.mp4` → update `meta.json` (status + output) → thumbnail/publish. Report to the user: the scene timeline table + a **ZOOM & SFX table: timecode | event | zoom type | SFX file | volume**. Clean up the temporary draft/test files when you are done.
