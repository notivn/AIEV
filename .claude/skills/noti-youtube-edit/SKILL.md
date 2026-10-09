---
name: noti-youtube-edit
description: Build a Vietnamese landscape 16:9 YouTube video (1920×1080) with HyperFrames (HTML/CSS/GSAP → MP4), keeping the Noti.vn/GĐT branding inherited from noti-tiktok-vn. Supports 2 modes - A) talking-head + motion graphics (full-frame face, camera move to PiP, karaoke captions) and B) full-text explainer (text scenes + slides/charts, no face on screen). Includes the "camera move" technique (animate the wrapper, never the video), the fix for Vietnamese text losing diacritics, and picking sound effects itself by content + timestamp from the `assets/sound-effects/` library (tag `hay-dung`) and wiring them into the video (mandatory on every video). Use when the user brings a Vietnamese clip/transcript and wants a landscape YouTube video that keeps the dark fintech blue branding.
---

# YouTube Edit 16:9 - the Noti.vn / GĐT standard

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

This skill builds **landscape 16:9** YouTube videos with HyperFrames (HTML/CSS/JS + GSAP → MP4).
Architecture: face cam + overlay beats + camera move/PiP; the **branding** is inherited from `noti-tiktok-vn` (Noti.vn dark fintech blue). It differs from `noti-tiktok-vn` only in the **landscape 16:9 frame** instead of vertical 9:16.

**Project structure:** scaffold with `npx hyperframes init`, then follow the layout in the `video-pipeline` skill (`index.html` + `compositions/` + `assets/` + `renders/` + `hyperframes.json` + `meta.json`). The Noti.vn branding (colors/fonts/glass) is written out in the STYLE section below, and the SFX timestamp wiring in the SOUND EFFECT section - you do not need an example project for either.
(`video-projects/sapo/` and `video-projects/mcp-tiktok-2/` are example projects on the author's machine, NOT shipped with the repo - `video-projects/` is gitignored.)

> ⚡ Read this whole file before building. Every ⚠️ section is a bug already hit & already fixed - do NOT repeat it.

---

## ROLE
Video editor working in HyperFrames. Compose HTML/CSS/JS, animate with GSAP, render a **landscape 1920×1080** MP4. Noti.vn branding.

## TWO MODES (pick by the user's input)
- **Mode A - Talking-head + motion graphics** (the default when the user brings a single clip of someone speaking): the face video runs full-frame in the background, animated text + karaoke captions overlay on top, and a **camera move** shrinks the face into a PiP whenever the graphics take the stage. (`noti-tiktok-vn` style, landscape frame.)
- **Mode B - Full-text explainer** (when the user brings a transcript + slides/images/figures and there is NO face on screen): N text scenes + slide/chart scenes, every piece of text a real HTML element. (≈ the `noti-tiktok-full-text` logic but in a landscape layout.)

Ask the user if it is unclear. Both modes SHARE: branding, font fixes, transcription, **SFX (mandatory)**, render contract, environment.

---

## OUTPUT SPEC (16:9)
- **1920×1080**, **30fps** (60fps if there is a lot of kinetic typography / fast camera moves).
- ⚠️ YouTube safe zone (DIFFERENT from TikTok - there is no button column on the right):
  - **Title-safe**: important text inside the central **1728×972** area (leave ~5% on each edge).
  - **Bottom ~90px**: the scrubber (progress bar) + timestamp appear on hover → do NOT put important text/captions below `y > 990`. Put captions at `bottom: ~110–150px` (lower third), NOT flush with the bottom.
  - **Top right corner**: the YouTube "cards" icon → leave ~120×120px clear if it is used.
  - **End screen (last 20s)**: if you plan to use YouTube's end screen (subscribe/suggested video), leave those slots clear (~right corner + center-right) for the last 20s. If you are NOT using the native end screen, ignore this.
- Exploit the width: **lower third**, **side panel**, **split screen**, **corner PiP dock** - landscape is wide, so prefer horizontal layouts over vertical stacks.
- Each scene = its own HTML sub-composition (`<template>` + `data-composition-src`), timed via `data-start`/`data-duration`/`data-track-index`.

---

## ⚙️ ARCHITECTURE (master + beats)
A master `index.html` (1920×1080) + N sub-compositions ("beats"), all layered **on top of a single background layer** (Mode A: the face video on track 0; Mode B: a dark gradient background). The overlay beats use **their own track index** (e.g. 4) and follow one another in time.

Master skeleton:
```html
<div id="root" data-composition-id="yt-edit" data-start="0"
     data-duration="<TOTAL>" data-width="1920" data-height="1080">
  <!-- Mode A: face video background -->
  <div id="face-wrapper">
    <video id="face-video" data-start="0" data-duration="<TOTAL>" data-track-index="0"
           src="assets/face.mp4" muted playsinline></video>
  </div>
  <audio id="face-audio" data-start="0" data-duration="<TOTAL>" data-track-index="2"
         data-volume="1" src="assets/face.mp4"></audio>

  <!-- beats: one file per scene, same track 4, back to back -->
  <div id="beat-1" class="scene-layer" data-composition-id="b1"
       data-composition-src="compositions/01-hook.html"
       data-start="0" data-duration="4.0" data-track-index="4"
       data-width="1920" data-height="1080"></div>
  <!-- ... -->
</div>
```

---

## 🎥 CAMERA MOVE - the core technique (Mode A)
A "camera move" is NOT a real camera - it is **GSAP animating the `<div>` that wraps the video** (`#face-wrapper`).

```js
const FULL = { x: 0, y: 0, width: 1920, height: 1080 };       // full-frame
const PIP  = { x: 1380, y: 750, width: 480, height: 270 };    // 16:9 dock, bottom right
// or a side panel: const SIDE = { x: 1180, y: 0, width: 740, height: 1080 };

gsap.set("#face-wrapper", FULL);
mainTl.to("#face-wrapper",
  { ...PIP, duration: 0.6, ease: "power3.inOut",
    onStart: () => document.getElementById("face-wrapper").classList.add("pip") },
  12.54);   // start ~0.3s EARLY relative to the spoken cue → the shrink is mid-flight at the right moment
```

⚠️ **3 mandatory rules:**
1. **Animate the wrapper `<div>`, NEVER the `<video>`.** Animating width/height/top/left directly on a `<video>` → **frozen frame** (Render Contract). The wrapper is an ordinary div, so it is free to touch; a scale transform on the video is fine.
2. CSS: the wrapper gets `overflow:hidden; transform-origin:0 0`; the video inside gets `height:100%; width:auto; left:50%; transform:translateX(-50%)`. A 16:9 source into a 16:9 frame scales cleanly with no distortion. (If the source is vertical/square, `overflow:hidden` crops it back to 16:9.)
3. The `.pip` class only turns on while shrunk, adding **rounded corners + drop shadow + Noti blue glow** (with NO effect on the full-frame state):
```css
#face-wrapper { position:absolute; top:0; left:0; width:1920px; height:1080px;
  overflow:hidden; transform-origin:0 0; z-index:0; background:#000; }
#face-video  { position:absolute; top:0; left:50%; height:100%; width:auto;
  transform:translateX(-50%); display:block; filter:contrast(1.05) saturate(1.08); }
#face-wrapper.pip { z-index:10; border-radius:24px;
  box-shadow: 0 30px 80px rgba(0,0,0,0.55),
              0 0 0 1px rgba(255,255,255,0.06) inset,
              0 0 50px rgba(0,140,255,0.30); }   /* Noti BLUE glow, not orange */
```
- **z-index toggle**: beats 1..n overlay on top of the face (face z-index = 0); only when it goes into PiP do you raise it to `z-index:10` so the face window floats above the scene.
- **A light push-in** (to build energy) = scaling the wrapper 1.0→1.03 extremely slowly; still safe because it is a transform on a div.

---

## 🔀 SCENE TRANSITIONS (GSAP, from noti-tiktok-vn)
> When the edit prompt has a PHONG CÁCH DỰNG (video style) section, its motion spec overrides these transition/effect rules.

No hard cuts. Every beat has **its own GSAP timeline** (`paused`, registered on `window.__timelines["<id>"]`). Text enters and leaves via tweens:
- **Entrance**: `y:40→0, opacity:0→1, scale:0.92→1, filter:blur(12px)→0`, stagger 0.06–0.12, ease `power3.out`.
- **Exit + hard kill** (stops stagger from leaking back in): `to(..., {opacity:0, y:-30, blur(14px)})` then `tl.set(..., {opacity:0, visibility:"hidden"})`.
- **Background crossfade**: `tl.from(.bg, {opacity:0, duration:0.5})`.
- **Whip / scale-zoom** on hard beats; **blur+fade** on soft beats. You can use the shader registry blocks (`whip-pan`, `cinematic-zoom`) if needed.
- **Sync to the speech**: every `data-start` is anchored to the Whisper timestamp of its keyword → the text "lands" exactly on the word being spoken.
- ⚠️ NEVER use `setTimeout`/`Date.now()`/`Math.random()` - GSAP timeline only. Get deterministic randomness from a `sin/cos` hash of the index.

---

## 🎨 STYLE (Noti.vn / GĐT) - KEEP the branding from noti-tiktok-vn
- Dark background `#0A0E1A → #0F1629` (gradient) + light grain + 1–2 blue blobs (`#0061ff`,`#00c2ff`) at blur 120px drifting slowly in parallax + vignette.
- Accent gradient on heading text: `linear-gradient(100deg, #0061ff, #00c2ff)` via `background-clip:text`.
- Glassmorphism (edge drawn by box-shadow, NOT a hard 1px border):
  `background: rgba(255,255,255,0.06); backdrop-filter: blur(20px); border-radius: 20px;`
  `box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 0 1px rgba(255,255,255,0.05), 0 18px 50px rgba(0,0,0,0.45);`
- Type: headings weight 800, subheads 600, body 400. Letter-spacing `-0.03em` on large headings.
- Glow on emphasized text: `filter: drop-shadow(0 0 26px rgba(0,140,255,0.4))` (drop-shadow for gradient text - NOT text-shadow, because the glyphs are transparent).
- Karaoke caption (Mode A): chunks of 4–7 words, the word being spoken highlighted `#19c8ff` + scale 1.13. Place it in the lower third (`bottom: ~120px`), NOT flush with the bottom.
- ⚠️ Glow/accents use **Noti BLUE** (`#0061ff`/`#00c2ff`/`#19c8ff`), NOT the Claude orange - this is the thing to fix whenever you borrow overlay code from another project.
- Never add your own corner logo/watermark - the Remotion assembly layer stamps the Style Design logo automatically when the style has one (adding your own means two logos stacked). Brand logos mentioned in the script come from `assets/brand-logos/` (see CLAUDE.md §5.5).

---

## ⚠️ VIETNAMESE FONT - MANDATORY (same as noti-tiktok-vn)
1. A font with full VN glyph coverage: **"Be Vietnam Pro"** (preferred) or "Inter" vietnamese subset. NEVER let it fall back to a headless Chromium system font (missing diacritics → tofu).
2. Embed via Google Fonts vietnamese subset, `display=block` (the HyperFrames renderer fetches + caches it and injects a deterministic @font-face on its own):
   ```html
   <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;600;700;800&display=block&subset=vietnamese" rel="stylesheet">
   ```
3. `<meta charset="UTF-8">` + `<html lang="vi">` + `font-display: block`.
4. End the fallback chain with a font that has diacritics: `font-family: "Be Vietnam Pro", "Inter", sans-serif;`
5. This test string must render with 100% of its diacritics: `Ưu đãi độc quyền - giảm giá sốc! Đừng để vụt mất. ƯỢ Ễ Ỹ ặ ậ ề`

### ⚠️⚠️ CRITICAL FIX - GRADIENT TEXT DROPPING DIACRITICS
Text using `background-clip:text; color:transparent` **CLIPS TALL STACKED DIACRITICS** (Ẫ Ể Ấ Ữ Ổ Ợ…) because the marks stick out above the gradient fill box. `padding-top: 0.14em` IS NOT ENOUGH - it must be **0.5em**. Apply it to EVERY gradient heading line:
```css
.heading-grad {
  background: linear-gradient(100deg,#0061ff,#00c2ff);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  line-height: 1.0; padding-top: 0.5em; padding-bottom: 0.14em;
}
```
Plain white/solid-color text (no background-clip) does NOT have this bug - only gradient text needs fixing. When verifying: zoom 3× into the glyphs with stacked marks to check.

### ⚠️ Captions / multiple lines at the same spot - must NOT OVERLAP
When the speech runs on with no pause: the previous line has not finished fading out when the next one fades in → they stack. Fix with `PRE_ROLL = 0`, the previous line going fully off exactly when the next appears:
```js
const inAts = SEGMENTS.map(s => Math.max(s.words[0].start, 0));
// fadeInAt  = inAts[i];
// fadeOutAt = (i<n-1) ? Math.max(segEnd+0.02, inAts[i+1] - FADE_OUT) : segEnd + POST_HOLD;
```
Pull an extra frame right at the BOUNDARY between two caption lines.

### ⚠️ Sub-compositions render IN ISOLATION
Every sub-comp (`data-composition-src`) renders in its own context, inheriting NOTHING from the master:
- Every sub-comp has its own `<script src=".../gsap@3.14.2/dist/gsap.min.js">`.
- Every sub-comp with text embeds its own Google font `<link>` (inside the `<template>`).
- Do NOT use the master's `:root` CSS vars inside a sub-comp - use literal values (hex/gradient written out).

---

## 🧩 LANDSCAPE LAYOUT (suggested components for 16:9)
Landscape is wide → prefer horizontal layouts (unlike TikTok's vertical stack):
- **Hook** (0–~15s): a large heading in the upper middle + logo/pill; this is what holds the viewer.
- **Lower third**: name/title/source on a glass strip at the bottom left, with a blue arrow/bar.
- **Side panel**: the face docked to one side (Mode A), the other half carrying text/charts.
- **Split screen**: UI/agent activity on the left, chart on the right.
- **Stat callout**: a big number at weight 900 (bad numbers can go orange-red `#FF4D2E`), count-up + scale-pop.
- **Comparison table / list item / pull-quote / pill badge**: use glass cards.
- **Outro**: a "Đăng ký kênh" (Subscribe) CTA + a question to drive comments, hold 4–6s (leave the end screen area clear if you use one).

## ✍️ MODE B - Full-text explainer (when there is no face on screen)
- N text scenes + slide/image/chart scenes. **ALL text is a real HTML element** (`<h1>/<p>/<span>`) - do NOT bake text into images. Images are background only (slide/screenshot/chart).
- Slow Ken Burns zoom/pan on images: **wrap the `<img>` in a `<div>` and animate the WRAPPER** (never animate width/top/left directly on the img).
- Count-up on figures (tween 1 object + onUpdate), background highlight sweeps (using `clip-path: inset(0 100% 0 0)→inset(0 0 0 0)`).
- A page counter "01 / N" in the top left corner, grey, wide letter-spacing.

---

## 🔊 SOUND EFFECT (MANDATORY - from noti-tiktok-full-text)
Every video gets SFX punctuating the beats (figures, reveals, scene changes/camera moves, punchlines, CTA). Shared library: `assets/sound-effects/` (from inside a project: `../../assets/sound-effects/`). The recommended set = the entries tagged `hay-dung` in `assets/sound-effects/library.json`. Skip any entry whose file is not on disk - library.json still lists a few files that are not shipped with the repo.

### Picking SFX yourself (by content + timestamp)
1. Read the transcript + caption timestamps + storyboard → find the "accent points" that need sound: figures/count-ups, keyword reveals, **the FULL→PIP camera move beat**, a slide/chart scene opening, the highlight on a payoff line, hard scene changes, the "Đăng ký kênh" (Subscribe) outro CTA, punchlines.
2. Map each accent point → 1 semantically fitting SFX (table below). `data-start` = the exact EVENT beat (the number starting its count-up / the text starting its reveal / the scene cut frame / the PiP shrink beat), NOT the vague start of the scene.
3. ⚠️ Restraint: about 1 SFX every 3–6s, not one hit per line of text. Landscape YouTube videos usually run longer → spread them out, vary the files, avoid repeating a single sound too densely.
4. **Present the SFX table to the user for approval** (timecode | event | file | volume) together with the storyboard before wiring anything in.
- Semantic map → file: good numbers → `ding.mp3`/`ting.wav`; money → `ka-ching.mp3`; element pop → `pop.mp3`; image/slide → `camera-snap.wav`; bad numbers → `error.mp3`; wow → `anime-wow-1.mp3`; typing → `mechanical-keyboard.mp3`; click → `click-button.mp3`.
- **Copy** the chosen file into `assets/sfx/` (keeps the project portable). Each SFX = its own `<audio>`, **NO** `class="clip"`, its own track index **4 and up** (narration is on tracks 0/2):
  ```html
  <audio id="sfx-1" data-start="12.46" data-duration="2.0" data-track-index="6" data-volume="0.5" src="assets/sfx/ka-ching.mp3"></audio>
  ```
- Restraint: about 1 SFX every 3–6s. Volume **0.4–0.6** (under the narration at 1.0). `data-start` = the exact EVENT beat. `data-duration` long enough for the SFX to finish ringing (1–3s).

---

## ⚠️ ENVIRONMENT (Windows) + TRANSCRIPTION
- **FFmpeg**: `winget install Gyan.FFmpeg`. The PATH change only applies to NEW shells → when calling `npx hyperframes`, prepend the bin to `$env:Path` inline:
  `$bin="C:\Users\<user>\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*-full_build\bin"; $env:Path="$bin;$env:Path"`
- `npm install` at the repo root; `npx hyperframes browser ensure` (downloads its own Chromium).
- ⚠️ `npx hyperframes transcribe` needs an external `whisper-cpp` + an `.en` English-only model → **do NOT use it for Vietnamese**.

**Vietnamese transcription** - use **faster-whisper** (`pip install faster-whisper`):
```python
import sys; sys.stdout.reconfigure(encoding="utf-8")   # the Windows console cannot print diacritics
from faster_whisper import WhisperModel
# GPU first (GTX 1660: twice as fast + frees the CPU) - fall back to CPU on error
try:
    m = WhisperModel("large-v3", device="cuda", compute_type="float16")
except Exception:
    m = WhisperModel("large-v3", device="cpu", compute_type="int8")
segs, info = m.transcribe("audio.wav", language="vi", word_timestamps=True, vad_filter=True, beam_size=5)
# export JSON {segments:[{start,end,text,words:[{word,start,end}]}]}
```
Extract the audio: `ffmpeg -i input.mp4 -vn -ac 1 -ar 16000 audio.wav`. Reread the transcript and fix the proper nouns Whisper misheard.

## TRIMMING TO HIGHLIGHTS / LONG VIDEO
YouTube allows more length than TikTok, but still cut the fillers. If you need to stitch several stretches: ffmpeg `filter_complex` (trim+atrim+setpts/asetpts → concat) into a cleanly re-encoded `face.mp4`; **remap the timestamps** (new = orig - accumulated shift); generate captions grouped by punctuation / speech pause (gap > ~0.38s) / max 7 words. A long video can be split into **chapters** (timecode + title) for the YouTube description.

---

## RENDER CONTRACT (must)
- Root: `id`, `data-composition-id`, `data-start="0"`, `data-width="1920"`, `data-height="1080"`.
- Any timed element needs `class="clip"` (EXCEPT `<video>`/`<audio>`) + `data-start`/`data-duration`/`data-track-index`. Clips on the same track must NOT overlap in time (watch out for float rounding - leave a ~0.04s margin).
- `<video>` must be `muted`; audio goes in its own `<audio>`. Do NOT animate width/height/top/left on a `<video>`/`<img>` - wrap it in a div and animate the wrapper (scale transforms are fine).
- Every composition registers exactly 1 `paused` timeline on `window.__timelines["<data-composition-id>"]` (the key must match exactly). Comp duration = `tl.duration()`. **Pad the full slot**: `tl.set({}, {}, DUR)` at the end of every timeline (Law 11 - shorter than data-duration → black frames).

## WORKFLOW (verified)
1. **Probe + extract frames** from the input (`ffprobe`, `ffmpeg -ss <t> -frames:v 1`) → decide Mode A/B, the duration, whether there is a face on screen.
2. **Transcribe** (faster-whisper large-v3, vi) → word-level timestamps.
3. **Storyboard**: cut the fillers, split into beats (1 idea per beat), set data-start/duration, mark the camera move beats (FULL→PIP) if Mode A. **Present the storyboard to the user for approval** before writing code.
4. **Pick the SFX** (mandatory): scan the accent points by timestamp → map files from `assets/sound-effects/` (prefer the `hay-dung` tag in `library.json`) → copy into `assets/sfx/` → **present the SFX table to the user for approval**.
5. **Verify the font** with the test string (1920×1080 screenshot) BEFORE building a lot.
6. **Build**: follow the master + beats skeleton in the ARCHITECTURE section, apply the Noti.vn branding. One file per scene, one `paused` GSAP timeline each, padded to the full slot.
7. `npx hyperframes lint` → 0 errors (the self-selector/google-fonts/font-face/video_nested warnings are benign, ignore them).
8. **Render a draft** → extract a frame per scene + **zoom 3× to check the Vietnamese diacritics** + check the camera move/PiP lands on its beat + the caption boundaries + the YouTube safe zone. `Read` every PNG. Listen back that the SFX lands right and never buries the voice. Fix → render again.
9. User approves → **render final** with `--quality standard`.

## COMMANDS (run inside `video-projects/<project>/`)
```powershell
$bin="...\ffmpeg-...\bin"; $env:Path="$bin;$env:Path"
npx hyperframes lint
npx hyperframes compositions
npx hyperframes render --quality draft    --output renders/draft.mp4
npx hyperframes render --quality standard --output renders/final.mp4
# verify diacritics: ffmpeg -ss <t> -i renders/draft.mp4 -frames:v 1 -vf "crop=700:340:60:260,scale=1400:680:flags=neighbor" out.png → Read out.png
# verify the camera move: extract a frame right at the FULL→PIP edge (e.g. 12.5–13.2s) and check the face shrinks smoothly, no distortion/freeze
# copy SFX: cp ../../assets/sound-effects/<file> assets/sfx/
```

## OUTPUT - hand off to the pipeline
`renders/final.mp4` is NOT the finished product. Continue with the `video-pipeline` skill: automated QC on the draft → assemble final via the render queue (Remotion) → `outputs/<id>-v<N>.mp4` → update `meta.json` (status + output) → thumbnail/publish. Report to the user: a timeline table: scene | duration | component | content + an **SFX table: timecode | event | file | volume**. Clean up the temporary draft/test files when you are done.
