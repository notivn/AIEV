---
name: video-pipeline
description: End-to-end video production workflow for the AI Edit Video system - from the user request to the MP4 in outputs/, coordinating HyperFrames (scenes) and Remotion (assembly). Read this when starting any video or when building the backend render queue.
---

# Video Pipeline - from request to MP4

## Engine roles (never swap them)

| Task | Engine | Why |
|---|---|---|
| Scene motion graphics: kinetic typography, karaoke captions, count-ups, data tables, callouts, shaders | **HyperFrames** | HTML + GSAP is its strength, and the Vietnamese skills already ship the fixes |
| Stitching scenes + source footage, transitions between scenes, mixing audio + sound effects, full-video caption overlay, final export | **Remotion** | Programmatic assembly, `<Sequence>`/`<Audio>`/`<OffthreadVideo>` |

How the two engines talk to each other: **intermediate MP4 files** in `video-projects/<name>/renders/`. HyperFrames does not know Remotion exists and vice versa - the only shared thing is the manifest.

## Project lifecycle

### 1. Initialize
- Create `video-projects/<kebab-case-name>/` with `index.html`, `compositions/`, `assets/`, `renders/`, `hyperframes.json`, `meta.json`.
- `meta.json` is the central manifest:

```json
{
  "id": "tiktok-paper-gpt5",
  "name": "Mổ xẻ paper GPT-5",
  "width": 1080, "height": 1920, "fps": 30,
  "status": "draft",
  "scenes": [
    { "id": "s01-hook",   "src": "compositions/s01-hook.html",   "durationInFrames": 90,  "render": "renders/s01-hook.mp4" },
    { "id": "s02-talking","srcVideo": "assets/talking-head.mp4", "from": 2.5, "to": 14.0 }
  ],
  "audio": {
    "voice": "assets/voice.mp3",
    "sfx": [ { "file": "assets/sound-effects/whoosh-01.mp3", "atFrame": 88 } ]
  },
  "output": null
}
```

- `scenes[]` is the contract between the two engines: a scene with `src` is rendered by HyperFrames; a scene with `srcVideo` is footage used as-is. Remotion reads this file to assemble - **never hardcode the scene list in the Remotion code**.
- **The user edits `meta.json` too.** The dashboard has a video editor (timeline + live Remotion preview) that writes `scenes`, `audio`, `captions`, `subtitles`, `subtitleStyle` and `overlays` straight into this file - between your turns, or before your session even started. So, every single time:
  1. **Read `meta.json` again right before you change it** - never trust the copy you read earlier in the session.
  2. **Edit in place** (the `Edit` tool on the exact keys you are changing). **Never `Write` the whole file back from memory**: that silently throws away whatever the user just dragged, trimmed or retyped.
  3. **Keep every field you do not recognise**, at any depth (extra keys on a scene, a cue, `audio`...). They belong to the user, the editor or the system.
  The server snapshots the timeline when your session starts and ends (`video-projects/<id>/.history/`), so the user can always roll back - but a clobbered edit is still lost work for them.

### 2. Build the scenes (HyperFrames)
- Copy `assets/brand/brand-tokens.css` into the project, write compositions following the `window.__timelines` convention.
- Vietnamese videos: apply the verified fixes (gradient text losing diacritics -> render text as real elements + use `background-clip` correctly; check that every diacritic is present on the first/last frame of each reveal).
- Lint clean before rendering: `npx hyperframes lint`.
- Render a draft of each scene: `npx hyperframes render --quality draft --output renders/<scene>.draft.mp4`.

### 3. Frame verification (MANDATORY, before assembly)
```bash
ffmpeg -ss <hero-moment-seconds> -i renders/<scene>.draft.mp4 -frames:v 1 verify/<scene>.png
```
Inspect every image: does the Vietnamese text keep all its diacritics? Is any text overflowing the edges? Any unexpected white/black frames? Is a face cropped? If anything is wrong, fix the scene - do not move on.

### 4. Assembly (Remotion) - see the `remotion-assemble` skill for details
- The Remotion composition reads `meta.json`, builds `<Sequence>` entries from `scenes[]`, and inserts sfx at `atFrame`.
- Render a full draft -> review it in the web UI -> approve.

### 5. Automated QC (MANDATORY, blocks final)
```bash
curl -s -X POST http://localhost:6869/api/projects/<id>/qc -H "content-type: application/json" -d "{}"
```
The server measures the latest draft with ffmpeg and returns `{ report: { status, checks[] } }`:

| check | meaning | what to do on fail |
|---|---|---|
| `resolution` | dimensions/fps do not match `meta.json` | re-render with the correct settings |
| `loudness` | far off -14 LUFS | adjust the mix volume, do not fix it by pulling the peak |
| `truepeak` | clipping (> -0.5 dBTP) | lower the source gain, see "SFX loudness and lead silence" in the `noti-tiktok-vn` skill (voice headroom before layering SFX) |
| `blackframes` | black frames in the MIDDLE of the video (leading/trailing fades are ignored) | a gap at a scene change - fix `transitionOverlap`/`durationInFrames` |
| `freeze` | frozen picture >= 2s | the scene is missing animation, or the footage is broken |
| `tail-silence` | silent tail > 1.2s | trim the tail |
| `av-duration` | picture and sound differ by > 0.5s | wrong total `durationInFrames` |
| `safe-area` | ALWAYS passes, returns `frames` = images with the obstructed bands outlined in red | **you MUST Read every image** and judge for yourself; if any text sits in the red zone, pull it inward, see the `key-layout` skill |

- `status: "fail"` -> the server rejects the `assemble-final` job with **409 QC_REQUIRED / QC_FAILED**. Fix the root cause, re-render the draft, run QC again. Do not use `force: true` to dodge it unless the user explicitly asks.
- `status: "warn"` -> consider fixing, not blocking.
- The final report must state the QC results and how each fail/warn check was handled.

### 6. Final
- Re-render the HyperFrames scenes at `--quality standard`.
- Remotion final render -> `outputs/<project>-v<N>.mp4`.
- Update `meta.json`: `status: "done"`, `output: "outputs/..."`. The web UI reads status from here.

### 7. Thumbnail + publish package
```bash
curl -s -X POST http://localhost:6869/api/projects/<id>/thumbnail -H "content-type: application/json" -d "{\"title\":\"...\",\"frameAt\":12}"
curl -s -X POST http://localhost:6869/api/projects/<id>/publish   -H "content-type: application/json" -d "{}"
```
`publish` generates `.srt`/`.vtt` from the transcript and has the AI write the title/description/hashtags for TikTok, YouTube and Facebook following the Style Design. **Precondition**: the transcript must be the FINAL one. If it was cut/remapped, write the final version to `assets/transcript.final.json` (the transcript loader prefers this file) - otherwise the subtitles will drift out of sync with the cut video.

## Render queue rules (backend)

1. **Every render goes through the queue** - including the ones Claude runs by hand. Jobs are written to SQLite: `id, projectId, type (scene-draft|scene-final|assemble-draft|assemble-final|image-gen), status, progress, log, startedAt, finishedAt`.
2. Jobs run **in parallel up to `QUEUE_CONCURRENCY`** (default 2, configurable via env; set 1 on weak machines). Safety constraint: two jobs **from the same project never run at the same time** (to avoid trampling renders/meta) - parallelism only happens across different projects.
3. Progress: parse the CLI stdout (both engines print frame progress) -> update the DB -> push SSE to the web UI.
4. Failed jobs: keep the complete log in the DB, show it in the UI, and **do not auto-retry more than once**.
5. Draft always comes before final. The backend rejects a final job if the project has no successful draft for the current version of the scenes.

## Sound effects

- Shared library: `assets/sound-effects/`, every file has an entry in `assets/sound-effects/library.json` (`file`, `tags`, `durationMs`, and a `description` written in Vietnamese).
- When using one in a video: copy it into `video-projects/<name>/assets/sound-effects/` then declare it in `meta.json` - a project must contain all of its own assets (re-rendering must not depend on a library that may change).
- The Sound Effects page in the web UI reads `library.json`, plays previews inline, and allows uploading new files (the backend updates the json).

## Speeding up renders (this machine has a GTX 1660 - verified 2026-07)

The number one reason the pipeline burns an entire hour: **re-rendering a draft of the WHOLE video after every small edit**. The rules:

1. **Verify layout/text with `npx hyperframes snapshot` or `inspect`** (a few seconds) instead of rendering
   a full draft (tens of minutes). Render a full draft only ONCE, when every snapshot is good, and final ONCE.
2. **Small edit -> re-render only what changed**: if you edited one scene, re-render that scene (`render -c <scene>`),
   do not re-render the whole composition. The split-scene + Remotion-assemble pipeline is built exactly for this.
3. **HyperFrames speed flags** (the backend queue adds them automatically; when running by hand you MUST remember them):
   `-w 8 --browser-gpu` for every render; add `--gpu` (NVENC) for drafts. Final keeps CPU encoding
   (libx264) for maximum quality. Measured in practice: ~30% faster on short scenes, more on long ones.
4. **Transcription runs only ONCE** - if `transcript.json` already exists, reuse it, NEVER transcribe again.
5. **Remotion speed flags** (when running `npx remotion render/still` by hand you MUST add):
   `--concurrency 8 --gl angle`. WITHOUT `--gl angle`, Remotion's Chrome renders with the
   software renderer (SwANGLE) - the CPU carries 100% while the GPU idles (symptom: Task Manager CPU ~95%,
   GPU ~5%). On Linux use `--gl angle-egl` instead of `angle`.

## Known issues (verified in production 2026-07)

- **`meta.json` must respect the data-type contract** (the web UI reads it directly - a wrong type crashes the page):
  `output` is a path **STRING** (e.g. `"outputs/<id>-v1.mp4"`), NOT an object. Extra metadata
  (duration, quality, renderedAt, ...) goes into a separate `outputInfo` field if needed. `scenes[].durationInFrames`
  is a number; sfx are placed with `atFrame` (a frame number) as in the schema at the top of this file.

- **Rendering a single scene**: use the `-c` flag, not a positional argument: `npx hyperframes render -c compositions/s01.html --quality draft --output renders/s01.draft.mp4`. A `<template>` sub-composition must be referenced by index.html through `data-composition-src` for `-c` to be able to render it.
- **Words running together on per-word reveals**: the HyperFrames pipeline swallows the whitespace between inline-block `<span>`s - separate words with `margin: 0 0.14em` on `.word`, do not rely on whitespace in the HTML.
- **The `sub_timeline_readiness_timeout` warning** when rendering a template file with `-c`: the render still comes out correct (best-effort) but wastes another 45s waiting - acceptable for drafts; if you want it gone entirely, render through index.html.
- **A TS comment containing the glob path `*/`** (e.g. `video-projects/*/meta.json`) closes the block comment early -> a baffling compile error. Write `video-projects/<id>/meta.json` instead.
- **Vietnamese JSON sent with curl -d from Git Bash on Windows loses its diacritics** (verified 2026-08: the
  thumbnail title arrived at the server as "B?n th? kh?ch..." and rendered broken). The console codepage mangles
  UTF-8 before curl sends it. For any API body containing Vietnamese, POST from Node instead:
  `node -e "fetch(url, { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({...}) })"`
  (or write the JSON to a file and use `curl --data-binary @file`).

## Checklist before reporting completion

- [ ] If the brief enables autoCut: the cut was done per the `auto-cut` skill, a second silencedetect pass verified the cut version, and the report states the seconds/segments removed
- [ ] Every scene passed frame verification, Vietnamese text keeps all its diacritics
- [ ] Audio is in sync at the start/middle/end (check 3 random points)
- [ ] Sound effects land on the right frames, and their volume does not bury the voice (sfx ~10dB below voice)
- [ ] The output matches the dimensions/fps in `meta.json`
- [ ] Automated QC ran on the draft with no remaining `fail` checks (the report spells out any leftover warn checks)
- [ ] `meta.json` has updated `status` + `output`
- [ ] The thumbnail was generated and Read to verify the diacritics are complete
- [ ] The publish package was generated (`.srt`/`.vtt` + metadata), using the FINAL post-cut transcript
- [ ] Any new lesson learned was written into the relevant skill
