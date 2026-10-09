---
name: remotion-assemble
description: How to use Remotion as the assembly layer - read the project's meta.json and stitch the rendered HyperFrames scenes + footage + voice + sound effects into the finished video. Read this when writing/editing code in engines/remotion or when assembling the timeline for a video.
---

# Remotion Assemble - building the timeline from meta.json

In this system Remotion **does exactly one thing**: assemble the pieces that already exist (scene MP4s rendered by HyperFrames, source footage, voice, sound effects) into the final video. Do not build motion graphics in Remotion - that is HyperFrames' job.

## Structure of engines/remotion

```
engines/remotion/
├── package.json          ← remotion, @remotion/cli, @remotion/renderer
├── remotion.config.ts
└── src/
    ├── Root.tsx               ← registers 3 compositions: "Assemble" + "Poster" + "Thumbnail"
    ├── Assemble.tsx           ← master composition: read manifest → build timeline
    ├── Poster.tsx             ← static poster composition (image projects)
    ├── Thumbnail.tsx          ← static video-thumbnail composition (frame card + title)
    ├── manifest.ts            ← load + validate video props (zod)
    ├── posterManifest.ts      ← load + validate poster props (zod)
    ├── thumbnailManifest.ts   ← load + validate thumbnail props (zod)
    ├── brandFonts.ts          ← load brand fonts via staticFile (offline)
    ├── media.tsx              ← media URL resolver (staticFile by default; the dashboard preview swaps it)
    ├── index.ts               ← entry point registering Root
    └── components/
        ├── SceneClip.tsx      ← <OffthreadVideo>/<Img> for one scene/footage clip
        ├── Transition.tsx     ← hard cut / crossfade (fade) - only these 2
        ├── SfxTrack.tsx       ← places <Audio> at sfx[].atFrame
        ├── MusicTrack.tsx     ← background music: loop + fade + deterministic ducking
        ├── CaptionTrack.tsx   ← karaoke captions from word timestamps
        ├── HighlightTrack.tsx ← main/related key bands (key-layout)
        └── vietnameseFont.ts  ← @font-face Inter vietnamese subset
```

Manifest fields beyond scenes/captions/overlays (see `manifest.ts`):
- `watermark` - the Style Design corner logo, stamped by the SERVER (`jobs/assemble.ts`), never by the AI; `null` = the style has no logo.
- `audio.music` - background music `{ file, volume, duckVolume, speech: [[startSec,endSec],...] }` with deterministic ducking over speech ranges (see the `background-music` skill); `null` = no music.
- `scenes[].zoom` - camera move on footage `{ origin?, keys: [{frame, scale, ease?}] }`; `frame` counts from the START OF THE SCENE, applied to the wrapper div (never the video element).
- `audio.sfx[].mediaStart` - seconds skipped at the head of the sfx file (lead silence trim, see noti-tiktok-vn "SFX loudness and lead silence").

## Core principles

1. **A single data-driven `Assemble` composition.** Everything comes from the project's `meta.json`, passed through `defaultProps`/`inputProps`. Adding a new video means no Remotion code changes, only a new manifest.

```bash
npx remotion render Assemble \
  --props="<abs>/video-projects/<name>/props.resolved.json" \
  --output="../../outputs/<name>-v1.mp4" \
  --concurrency 8 --gl angle
```

> ⚠️ Asset paths in the props must be `staging/...` - the backend stages assets into
> `engines/remotion/public/staging/` via hardlinks and then writes `props.resolved.json`.
> **NEVER render straight from `meta.json`** (its paths are relative to the project
> folder, and Remotion cannot resolve those through `staticFile`).
>
> `--gl angle` is MANDATORY on a machine with a GPU - without it Remotion renders with the software renderer,
> CPU at 100% and GPU at 5%. For drafts add `--crf 28 --x264-preset veryfast`. (The backend queue adds these flags automatically.)

2. **Dimensions/fps come from the manifest** - use `calculateMetadata` to set `width/height/fps/durationInFrames` dynamically from the props, never hardcode them in `Root.tsx`.

3. **Embedded video uses `<OffthreadVideo>`**, not `<Video>` - it is more stable server-side and lands on the right frame. Whatever fps a HyperFrames scene was rendered at, the manifest must declare that exact fps; an fps mismatch between scene and composition is the number one source of stuttering.

4. **Timeline = accumulating `durationInFrames`:**

```tsx
let from = 0;
scenes.map((s) => {
  const seq = (
    <Sequence key={s.id} from={from} durationInFrames={s.durationInFrames}>
      <SceneClip scene={s} />
    </Sequence>
  );
  from += s.durationInFrames - (s.transitionOverlap ?? 0);
  return seq;
});
```

When a transition has an overlap, subtract that overlap while accumulating - forgetting to subtract leaves a black gap between scenes.

5. **Audio:**
   - Voice: one `<Audio src={voice}>` running from frame 0 - the voice is the sync backbone, scenes follow the voice and never the other way round.
   - Sound effects: each `sfx[]` entry becomes one `<Sequence from={atFrame}><Audio volume={0.3}/></Sequence>`. Default sfx volume is 0.3 (~10dB below the voice); override it in the manifest with the `volume` field if needed.
   - Do not normalize/mix manually with FFmpeg after rendering - mix inside Remotion so the draft sounds like the final.

6. **Caption and overlay tracks live in `meta.json`, and their timestamps are in FRAMES.**

   `CaptionTrack` and `HighlightTrack` read `props.captions` / `props.overlays` **only**. They never
   open a transcript file. If you leave those arrays empty there are no captions, no matter how good
   the transcript is.

```jsonc
// meta.json
"captions": [
  { "from": 90, "durationInFrames": 75,
    "words": [ { "text": "Trí", "start": 90, "end": 96 },
               { "text": "tuệ", "start": 96, "end": 104, "hi": true } ] }
],
"overlays": [
  { "from": 0, "durationInFrames": 150, "tier": "main", "accent": "hot",
    "kicker": "AI", "parts": [ { "t": "Dựng video" }, { "t": "bằng AI", "hi": true } ] }
]
```

   > ⚠️ **The unit changes here.** A transcript stores `start`/`end` in **seconds**; `captions[].words[]`
   > stores them as **absolute composition frames** (`second * fps`, counted from the start of the whole
   > video, not from the start of the cue). Passing seconds through produces captions that all flash in
   > the first half-second — and nothing errors, so it is easy to ship by accident.
   >
   > `hi: true` marks a highlighted word. `tier: "main"` renders a top band, `"sub"` a bottom pill that
   > lifts itself when captions are present.

7. **Every scene needs `durationInFrames` unless it is a `srcVideo` scene with both `from` and `to`.**
   That is the only case Remotion infers a length for; an image or HyperFrames scene without an explicit
   `durationInFrames` **throws at render time**. This bites hardest on videos with no source footage
   (text-to-video, image-only explainers), where nothing has a natural duration to infer from.

8. **`meta.json` is shared with a human editor.** The dashboard's video editor previews the `Assemble`
   composition live in the browser (`@remotion/player`) and saves the timeline keys (`scenes`, `audio`,
   `captions`, `subtitles`, `subtitleStyle`, `overlays`) straight back into `meta.json`. When you assemble
   or adjust the timeline: **re-read `meta.json` right before each change, change it in place with `Edit`,
   never `Write` the whole file from memory, and keep every field you do not recognise** (the schema uses
   `z.looseObject` precisely so extra fields survive). Paths stay relative to the project folder with no
   `..` - the editor's server-side validator rejects anything else, and so does staging.

9. **Asset paths**: Remotion code only loads through `staticFile()` - the backend stages assets into `engines/remotion/public/staging/<project>/` (hardlink) and writes the `staging/...` path into `props.resolved.json`; Remotion never reads an absolute path. This runs on Windows - always use `path.join` on the backend, never string concatenation.

   Inside the `Assemble` tree, get that `staticFile` through **`useMediaSrc()`** (`src/media.tsx`), never by calling `staticFile()` directly. The dashboard editor runs the same `Assemble` in `@remotion/player`, where there is no Remotion `public/`: it wraps the tree in `MediaResolverProvider` and maps project-relative paths to `/media/video-projects/<id>/...` and `fonts/...` to `/media/remotion-fonts/...`. A direct `staticFile()` (or one evaluated at module scope, like the old `vietnameseFontFaceCss` constant) renders fine through the CLI but 404s in the preview. The default resolver IS `staticFile`, so CLI renders produce the same frames as before. Poster/Thumbnail/brandFonts only render through the CLI and keep `staticFile`.

## Draft vs Final

| | Draft | Final |
|---|---|---|
| Command | `--crf 28 --x264-preset veryfast` (+ `--concurrency 8 --gl angle`) | defaults (crf 18) |
| Scene input | `renders/*.draft.mp4` | `renders/*.mp4` (quality standard) |
| Purpose | review pacing, sync, transitions | publishing |

The backend picks the scene input set based on the job type - the Remotion code does not distinguish draft from final, it only takes the paths from the manifest.

## Known issues & how to avoid them

- **Stutter/freeze at a scene boundary**: the scene fps differs from the composition fps, or `durationInFrames` in the manifest does not match the real length of the MP4. Check with `ffprobe -show_streams <file>` before assembling.
- **Audio drifting out of sync toward the end**: a VBR voice mp3 -> convert it to CBR/WAV before putting it in the manifest (`ffmpeg -i voice.mp3 -ar 48000 voice.wav`).
- **Color mismatch between HyperFrames scenes and footage**: both engines render through Chromium so they usually match; if they do not, check whether the footage has an unusual color space tag (`bt709` is the standard) - transcode the footage to bt709 first.
- **Render hanging on Windows**: usually caused by Vietnamese characters/spaces in an asset file path - name asset files in ASCII kebab-case right from the import step.
- **One black frame at every footage cut**: a `srcVideo` scene sized `round((to-from)*fps)` while `OffthreadVideo` plays `round(to*fps) - round(from*fps)` frames - the two differ by one (from=1.02, to=3.98 @30fps: 89 vs 88). Always round EACH END, never the difference; `resolveSceneDurationInFrames` and `frameOf` in `jobs/assemble.ts` must stay in lockstep with `SceneClip`.
- **Whole render dies on one tiny cue** (`inputRange must be strictly monotonically increasing`): a fade written as `[0, 4, max(5, last-4), last]` is not increasing when a cue is 6 frames or less (a translated cue clamped near the end of the video is enough). Use `fadeInOut()` from `components/fade.ts` for any new track instead of hand-writing the range.
- **Rendering on a machine with no network**: Remotion tries to download Chrome from `remotion.media`. Pass `--browser-executable=<local chrome/headless_shell>` instead.

## Remotion license (keep in mind when scaling up)

Remotion is free for individuals and companies of <= 3 people; beyond that you need a Company License. This note is for planning growth - it does not affect the current stage.
