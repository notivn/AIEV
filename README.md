# AIEV - AI Edit Video by [noti.vn](https://noti.vn)

[![CI](https://github.com/notivn/AIEV/actions/workflows/ci.yml/badge.svg)](https://github.com/notivn/AIEV/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)

🇬🇧 English · [🇻🇳 Tiếng Việt](README.vi.md)

> **Automatic AI video editing.** Claude acts as the director - driving **HyperFrames** (motion-graphics scenes built with HTML + GSAP) and **Remotion** (timeline assembly) - while you supervise everything through the web dashboard at `http://localhost:6868`.

Drop in a clip, briefly describe what you want, click **"Start editing with AI"** - the system automatically transcribes, writes the editing script, creates kinetic-typography scenes, karaoke subtitles, beat-synced zooms, timestamped sound effects, assembles the timeline and exports an MP4.

## Features

| | |
|---|---|
| 🎬 **AI video editing** | Claude analyzes the source → builds HyperFrames scenes → assembles with Remotion → MP4. Draft first, final later, every frame verified. |
| 🎨 **Style Design** | Multiple brand kits (colors, fonts, logo, tone, gradient/liquid-glass effects) - every output follows the selected style 100%. Just type a font name and it downloads from Google Fonts (full Vietnamese diacritics). |
| 🖼️ **AI image generation** | Gemini paints the background (no text) → Remotion places titles/logo/figures per the Style Design - Vietnamese text is never misspelled. |
| ✨ **In-video AI illustrations** | Claude picks key moments, Gemini draws style-matched illustrations and they're placed at exactly the right time (~$0.05/image). |
| 🔑 **Key layout** | The main key appears in the upper band of the video, related keys in the lower band synced to what's being said - AI suggests them or you specify. |
| 📝 **Vietnamese karaoke subtitles** | faster-whisper (GPU preferred) word timestamps, keyword highlighting, battle-tested fixes for missing diacritics. |
| 🎨 **Color grading with preview** | 14 presets + manual adjustments, per-frame preview; log/HDR footage is tonemapped automatically. |
| 🔊 **Sound effects** | Library of 100+ files with a curated set - AI inserts them to match the content rhythm and zoom beats. |
| 🧠 **Skills** | Production know-how accumulated as markdown, managed in the web UI; includes **AI-powered skill creation** from a question form. |
| 🩺 **Environment check & auto-install** | One command probes FFmpeg, Chrome, Claude credentials, faster-whisper and the Gemini key, then installs whatever it can. Runs at startup and offers one-click installs in the Settings tab. See [Environment check](#environment-check). |
| ⚡ **Hardware acceleration** | Auto-detects the GPU (NVENC on NVIDIA, VideoToolbox on macOS), parallel rendering, `--gl angle`. See [CPU or GPU, step by step](#cpu-or-gpu-step-by-step). |
| 📊 **Dashboard** | Realtime progress (SSE), render queue, AI tokens by day/project type (in/out), AI sessions auto-resume after interruptions. |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Web UI (Next.js, port 6868)                        │
│  Dashboard · Videos/Images Project · Style Design   │
│  Render Queue · Sound Effects · Skills · Settings   │
└──────────────────────┬──────────────────────────────┘
                       │ REST + SSE
┌──────────────────────┴──────────────────────────────┐
│  Backend (Express, port 6869)                       │
│  Claude Agent SDK · Render queue · SQLite           │
└──────┬──────────────────────────────┬───────────────┘
┌──────┴───────────┐        ┌─────────┴────────────┐
│ HyperFrames      │  MP4   │ Remotion             │
│ SCENE ENGINE     │───────▶│ ASSEMBLER            │
│ HTML + GSAP      │        │ scene + audio + sub  │
└──────────────────┘        └──────────────────────┘
```

Full API contract: [`docs/API.md`](docs/API.md). Production workflow + know-how: [`.claude/skills/`](.claude/skills/).

## CPU or GPU, step by step

Making one video runs through several stages, and each one picks its processor
differently. Nothing here is automatic magic: the defaults are chosen so a draft is
fast and a final is high quality, and you can change every one of them in **Settings**.

| Stage | Runs on | Controlled by |
|---|---|---|
| Rasterizing HyperFrames scenes (headless Chrome) | **GPU** by default, CPU if turned off | `GPU for capture (browser)` -> `--browser-gpu` |
| Encoding a scene **draft** | **GPU** by default (NVENC / VideoToolbox) | `GPU encode for drafts` -> `--gpu` |
| Encoding a scene **final** | **CPU** by default (libx264) | `GPU encode for FINAL`, off by default |
| Rasterizing the Remotion timeline | **GPU** by default, CPU if turned off | `GPU for capture (browser)` -> `--gl angle` (`angle-egl` on Linux) |
| Encoding the assembled video (draft + final) | **CPU always** (libx264) | not configurable; draft adds `--crf 28 --x264-preset veryfast` |
| Auto cut: cutting + reframing each segment | **GPU** only if `GPU encode for FINAL` is on **and** NVENC exists, otherwise CPU | `GPU encode for FINAL` |
| Transcription (faster-whisper large-v3) | **GPU** (CUDA, float16), falls back to **CPU** (int8) | automatic, no switch |
| Automated QC | **CPU** (ffmpeg only measures, it does not encode) | - |
| Thumbnail (`remotion still`) | **GPU** by default, same switch as capture | `GPU for capture (browser)` |
| Gemini images, subject detection, Claude editing | **Neither** - runs on the provider's servers | - |

Three things worth knowing:

- **Final encoding is deliberately on the CPU.** NVENC is much faster but at the same
  file size libx264 looks slightly better. Draft quality does not matter, so draft
  encoding defaults to the GPU and final defaults to the CPU. If you would rather have
  speed than the last few percent of quality, turn on `GPU encode for FINAL`.
- **Remotion's own encoding never uses the GPU here**, only its rasterizing does.
  Without `--gl angle` Remotion falls back to SwANGLE, which is pure software
  rendering on the CPU and is noticeably slower.
- **NVENC is detected through `nvidia-smi`.** If it fails, or the GPU runs out of
  encoding sessions, or it rejects a frame size, the job re-runs on libx264 instead of
  failing. On macOS the auto-cut reframe currently always uses libx264, because that
  detection only looks for NVIDIA; HyperFrames still uses VideoToolbox there.

Parallelism is separate from all of this: `Concurrent render jobs (queue)` (2 by default) sets
how many jobs run at once, `Chrome workers (HyperFrames)` sets the HyperFrames worker count, and
`Remotion concurrency` sets how many frames Remotion renders in parallel. Two jobs
belonging to the **same project** never run at the same time.

## Requirements

- **Node.js 22+** (HyperFrames requires `>=22`)
- **FFmpeg** on PATH (macOS: `brew install ffmpeg`)
- **Google Chrome** (HyperFrames and Remotion render through headless Chromium)
- **Claude**: sign in to [Claude Code](https://claude.com/claude-code) on this machine (uses subscription OAuth - recommended) *or* put `ANTHROPIC_API_KEY` in `.env`
- **Gemini** (only needed for image generation): `GEMINI_API_KEY` in `.env` - get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- Optional: an NVIDIA GPU (NVENC) or Apple Silicon Mac (VideoToolbox) for faster rendering; Python + `faster-whisper` for subtitles

You do not have to install these by hand. The start script checks every item above and offers to
install whatever it can - see [Environment check](#environment-check) below.

## Getting started

```bash
git clone https://github.com/notivn/AIEV.git
cd AIEV
```

**Windows** - double-click `start\start.bat` (or run `start\start.ps1`).

**macOS** - double-click `start/start.command` in Finder. A `.sh` file cannot be double-clicked on macOS, it just opens in an editor. If macOS blocks it as coming from an unidentified developer, right-click the file → **Open** → **Open**.

**Linux** - run `./start/start.sh`.

If you downloaded a ZIP instead of cloning, make the scripts executable once:

```bash
chmod +x start/*.sh start/*.command update/*.sh update/*.command
```

| Task | Windows | macOS | Linux |
|---|---|---|---|
| Start | `start\start.bat` | `start/start.command` | `./start/start.sh` |
| Stop | `start\stop.bat` | `start/stop.command` | `./start/stop.sh` |
| Update manually | `update\update.bat` | `update/update.command` | `bash update/update.sh` |
| Open a tunnel (phone uploads) | `start\tunnel.bat` | `start/tunnel.command` | `./start/tunnel.sh` |

The script handles everything: checks the environment → `npm install` (first run) → build → creates `.env` → starts server + web → opens `http://localhost:6868`. You normally never run the update script by hand; the update button on the dashboard does it.

Manual dev run: `npm install` then `npm run dev`.

## User guide

### Your first video (Videos Project)

1. **Create a project** - open **Videos Project** → **New project**: name, frame size (9:16 vertical for TikTok/Reels, 16:9 for YouTube) and fps.
2. **Add the source** - in the **Sources & Assets** card upload your clip, or click **Connect phone** and scan the QR to send files straight from your phone.
3. **Fill in the edit brief** - the "Editing script" card is the AI's instruction sheet:
   - **Source description** - one or two sentences about what the clip is.
   - **Auto-trim** - cuts silences, fillers and repeated takes before editing.
   - **Karaoke subtitles** with **keyword highlighting**.
   - **Key layout** - the main key sits in the top band of the video, related keys in the bottom band, synced to what is being said.
   - **AI illustrations (Gemini)** - style-matched images composited into the video. Pick the drawing model, the **image density** (how many images per minute of video; leave empty and the AI decides), the **subject position** (3x3 grid picker, like the logo picker) and whether Gemini may draw text inside images.
   - **Sound effects** and **background music** - curated SFX set or the full library; music auto-ducks under speech.
   - **Style Design** - the brand kit (colors, fonts, logo) enforced 100% on everything; **Video style** - the visual language of this one video (paper fold, ink wash, stick figures...), leave unset and the AI decides.
   - **Skill** - the editing format to follow (Noti TikTok style, YouTube landscape...).
   - **Notes** - your free-form request; drop in a template from the **Prompts** page if you like.
4. **Start editing with AI** - Claude transcribes the clip, plans the edit, builds HyperFrames scenes, generates the illustrations, wires sound effects and assembles a **draft**. Progress streams live on the project page; all renders go through the **Render queue**.
5. **Review and finish** - watch the draft right on the project page, ask for changes in the review chat ("make the hook bigger", "cut the intro"...), then run **QC** and the **final render**. The MP4 lands in `outputs/`, together with an auto-generated thumbnail and a publish pack (title, description, hashtags).

### Text to video (article → video)

**Text to video** → **New session**: paste a URL or raw text (the name is optional - it is taken from the article title). The pipeline runs in stages you can review between: **Extract** the article → **Script** - the AI rewrites it into a spoken script in chunks (set the target length in seconds, edit any chunk by hand) → **Voice** - pick the engine (**Gemini TTS** online or **VieNeu-TTS** on-device, including your cloned voices), the voice and the reading speed, with per-chunk preview → **Build** - the narration is synthesized and a video project is created and edited by the AI using the brief you configured. Setting an illustration density here is the easy way to keep a long article video visually alive.

### Auto cut (long video → many shorts)

**Auto cut** → pick a long talking-head video → choose the mode: by **time**, by **AI** (finds the highlights) or by **prompt**. **Plan** proposes segments with titles - tick/untick and edit them - then **Cut** creates one child project per segment, all sharing the brief you configured once (aspect, layout, background, style). Each child project can then be edited by the AI like any other project.

### Images Project (posters & thumbnails)

**Images Project** → new image: describe the scene, pick the kind, aspect and model. Gemini paints the background only (never any text), then Remotion overlays the title, subtitle, stats, CTA and logo per the Style Design - so Vietnamese text is never misspelled. Choose the text-block position with the 3x3 grid and re-render at will.

### Style Design & Video styles

**Style Design** holds your brand kits: colors, fonts (type a Google Fonts name and it downloads with full Vietnamese diacritics), logo, tone and effects. The selected style is enforced on every output; when the style has a logo, the assembler stamps it on the top-left of every video automatically - never add your own. **Video styles** (picked in the brief) define the visual language of a single video: materials and motion.

### Voices

The **Voices** page manages narration voices: 30 Gemini preset voices (online, per-use cost) and **VieNeu-TTS** (offline, free, Vietnamese with regional accents) - the only engine that can **clone your own voice** from a short recording or phone video. Preview any voice and reading speed before using it in Text to video.

### Sound effects & music

**Sound Effects** hosts the library: 100+ files with tags and a curated "recommended" set the AI reaches for first; upload and tag your own. Background music lives in `assets/music/`, which **ships empty on purpose** - add your own tracks (Sound Effects page → Music tab → upload) and the AI picks one by mood and ducks it automatically under speech. See [`assets/music/README.md`](assets/music/README.md).

### Render queue & Settings

Every render goes through the queue: drafts must pass before finals, and the automated **QC** (safe areas, audio loudness, black frames, Vietnamese diacritics) gates the final render - toggleable in **Settings**. Settings also holds the GPU switches, worker counts and queue concurrency; **Connections** manages the Claude / Gemini / OpenAI credentials.

### Skills & Prompts

**Skills** are the production know-how the AI follows - browse, edit, clone or create them (including AI-generated skills from a Q&A form) right in the web UI. **Prompts** stores reusable request templates for the brief's notes field.

## Environment check

`start/doctor.mjs` probes everything the pipeline needs - Node.js, FFmpeg, Google Chrome, Claude
credentials, faster-whisper, the Gemini key, cloudflared, GPU - and installs what it can:

| | |
|---|---|
| **Installed for you** (after a `[Y/n]` prompt) | FFmpeg, Google Chrome, Claude Code, faster-whisper, cloudflared - via `winget` on Windows, `brew` on macOS, `npm`/`pip` elsewhere |
| **You do it, we tell you exactly how** | installing Node.js, signing in to Claude (`claude` → `/login`), pasting the Gemini key |

It runs automatically inside `start.bat` / `start.command`, and the same list appears as the
**System check** card in the **Settings** tab, where each missing item gets a one-click install
button (or a copyable command when it cannot be automated). Missing pieces never block startup -
the dashboard comes up regardless so you can fix things from the UI.

```bash
node start/doctor.mjs              # just look
node start/doctor.mjs --fix        # ask before installing each missing item
node start/doctor.mjs --fix --yes  # install without asking
node start/doctor.mjs --lang en    # English output (default follows the script)
```

One file feeds the terminal, both start scripts and the web UI, so a new check is added in exactly
one place.

## Upload from your phone

On a project page, in the **Sources & Assets** card click **Connect phone** - scan the QR code with your phone camera (same WiFi as the machine running the system) to open the upload page `http://<machine-ip>:6868/m/<project>`. Videos/photos picked on the phone upload straight into the project's assets. The first time Windows asks about the firewall, choose **Allow** (the start script adds the rule automatically when it has admin rights).

**Remote over 4G/5G** (not on the same WiFi):
- **Cloudflare Tunnel** - fill `TUNNEL_DOMAIN=<your-domain>` (e.g. `aiev.noti.vn`) into `.env`, then the Connect phone QR automatically uses `https://<domain>/m/<project>` - works over 4G/5G.
- Start the tunnel with `start\tunnel.bat` (Windows) / `./start/tunnel.sh` (macOS) - no `TUNNEL_DOMAIN` yet and it falls back to a quick tunnel with a random `trycloudflare.com` URL.
- ⚠️ **Warning**: the dashboard has no login yet - only expose it publicly behind Cloudflare Access, or never share the link.

## Folder structure

```
├── apps/web/          # Next.js dashboard (port 6868)
├── apps/server/       # Express backend: Agent SDK + render queue + SQLite (port 6869)
├── engines/remotion/  # Remotion: Assemble (video) + Poster (image) compositions
├── .claude/skills/    # Skills - production know-how, manageable from the web UI
├── assets/
│   ├── sound-effects/ # Sound-effect library + library.json
│   ├── styles/        # Style Design (styles.json + fonts/logos)
│   └── prompts/       # Prompt templates
├── video-projects/    # One folder per video (not committed)
├── image-projects/    # Image-generation projects (not committed)
├── outputs/           # Final videos (not committed)
├── start/             # Startup scripts for Windows (.bat/.ps1) + macOS/Linux (.sh)
└── docs/API.md        # API contract - the single source of truth
```

## Tech stack

Next.js 16 · React 19 · Tailwind 4 · Express 5 · better-sqlite3 · [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk) · [HyperFrames](https://www.npmjs.com/package/hyperframes) · [Remotion](https://remotion.dev) · Gemini API · faster-whisper · FFmpeg

## Contributing

Bug reports, fixes and skills are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first - it covers the setup, the two commands CI runs on every PR (`npm run typecheck` and `npm run build`), and the conventions this codebase follows. For anything larger than a small fix, open an issue before you build.

Found a security problem? Do not open a public issue - follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) - free to use, modify and distribute, including commercially.

> Note on dependencies: this project's own license is MIT, but bundled tools keep their own.
> Remotion in particular is free for individuals and companies of up to 3 people; beyond that you
> need a [Company License](https://remotion.pro). Claude and Gemini usage is billed to your own account.
>
### Assets: this repo ships code, not media

The MIT license above covers the **code**. Media licensing varies per file, so the repo deliberately
ships none of it:

| Folder | Bundled? | License |
|---|---|---|
| [`assets/sound-effects/`](assets/sound-effects/README.md) | Yes, 86 files | **Collected from assorted sources, licensing unknown - not for commercial video** |
| [`assets/music/`](assets/music/README.md) | No - ships empty | Whatever your source says |
| [`assets/styles/`](assets/styles/README.md) | No - ships empty | Your styles, fonts and logo are yours |
| [`assets/brand-logos/`](assets/brand-logos/README.md) | Yes, 123 logos | **Trademarks of their owners**, NOT covered by MIT |
| The **noti.vn** name and logo on the dashboard | Yes | **noti.vn trademark**, NOT covered by MIT |

**The sound effects ship with a condition.** Those 86 files were collected over years from assorted
sources with no licensing records. They are here so the feature works out of the box, but **not for
commercial video** - nobody can prove rights to them. For commercial work, replace them with CC0 or
properly licensed audio and record `source` + `license` per file. Excerpts that are recognisably
someone's property (the Netflix jingle, Nintendo sounds, SpongeBob…) are not included, even though
the catalogue still lists their names.

Music ships empty outright: a multi-minute track is a far bigger risk than a half-second whoosh.

Fonts are the same, but there is a built-in path: type a font name in **Style Design** and the system
downloads it from Google Fonts onto your machine, so the repo never has to carry one.

Style Design ships empty for a different reason: a style is your own brand identity. A repo carrying
someone else's style would have everyone building videos in their colours, and if that style has a
logo, watermarking everyone's video with it. Create your first style on the Style Design page and it
becomes the default.

If you fork this, replace the noti.vn name and logo with your own: swap the PNGs in
`apps/web/public/brand/` and run `node apps/web/scripts/build-brand.mjs`.

---

Made with ❤️ by **noti.vn** - Claude directs, humans approve.


## 🌐 Web Resources & Aesthetic Symbols Index
- [SYM 1F635](https://coquette-aesthetic-symbols-14.pages.dev/symbol/sym-1f635/)
- [NATURE FLOWERS](https://sleek-bio-symbols-40.pages.dev/nature-flowers/)
- [SYM 1F60D](https://cyberpunk-clan-tags-43.pages.dev/symbol/sym-1f60d/)
- [SYM 1D492](https://coquette-symbols.pages.dev/symbol/sym-1d492/)
- [SYM 1D489](https://neon-glitch-symbols-84.pages.dev/symbol/sym-1d489/)
- [SYM 265E](https://pearl-girly-fonts-86.pages.dev/symbol/sym-265e/)
- [SYM 1D407](https://theeduplaycampen.pages.dev/symbol/sym-1d407/)
- [SYM 1D483](https://mecha-blade-symbols-46.pages.dev/symbol/sym-1d483/)
- [SYM 1F603](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-1f603/)
- [SYM 26B7](https://clean-dot-aesthetic-48.pages.dev/symbol/sym-26b7/)
- [SYM 1D46C](https://angelic-bow-symbols-42.pages.dev/symbol/sym-1d46c/)
- [ARROWS LINES](https://clean-dot-aesthetic-48.pages.dev/arrows-lines/)
- [CLOCKWISE OPEN CIRCLE ARROW](https://sleek-line-symbols-51.pages.dev/symbol/clockwise-open-circle-arrow/)
- [SYM 1D499](https://theeduplaycampen.pages.dev/symbol/sym-1d499/)
- [WATER BUBBLES](https://matrix-hacker-text-52.pages.dev/symbol/water-bubbles/)
- [SYM 1F913](https://pearl-girly-fonts-86.pages.dev/symbol/sym-1f913/)
- [SYM 1D48A](https://coquette-symbols.pages.dev/symbol/sym-1d48a/)
- [SYM 273B](https://pearl-girly-fonts-86.pages.dev/symbol/sym-273b/)
- [SYM 1D48D](https://angelic-bow-symbols-42.pages.dev/symbol/sym-1d48d/)
- [VI](https://sleek-line-symbols-51.pages.dev/vi/)
- [SYM 1D429](https://minimal-star-symbols-93.pages.dev/symbol/sym-1d429/)
- [SYM 26DD](https://minimal-star-symbols-93.pages.dev/symbol/sym-26dd/)
- [SYM 2742](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-2742/)
- [SYM 2721](https://mecha-blade-symbols-46.pages.dev/symbol/sym-2721/)
- [SYM 1D4A3](https://angelic-bow-symbols-42.pages.dev/symbol/sym-1d4a3/)
- [SYM 1F611](https://mecha-blade-symbols-46.pages.dev/symbol/sym-1f611/)
- [SYM 2627](https://matrix-hacker-text-52.pages.dev/symbol/sym-2627/)
- [SYM 1F604](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-1f604/)
- [SYM 1F971](https://mecha-blade-symbols-46.pages.dev/symbol/sym-1f971/)
- [SYM 26BF](https://matrix-hacker-text-52.pages.dev/symbol/sym-26bf/)
- [SYM 1F498](https://pearl-girly-fonts-86.pages.dev/symbol/sym-1f498/)
- [SYM 26E3](https://minimal-star-symbols-93.pages.dev/symbol/sym-26e3/)
- [SPRING TULIP BLOSSOM](https://coquette-aesthetic-symbols-86.pages.dev/symbol/spring-tulip-blossom/)
- [SYM 1D424](https://minimal-star-symbols-93.pages.dev/symbol/sym-1d424/)
- [GAMING WEAPONS](https://sleek-line-symbols-51.pages.dev/pt/gaming-weapons/)
- [BLACK HEART](https://angelic-bow-symbols-42.pages.dev/symbol/black-heart/)
- [SYM 26D0](https://neon-glitch-symbols-84.pages.dev/symbol/sym-26d0/)
- [SYM 1F47B](https://theeduplaycampen.pages.dev/symbol/sym-1f47b/)
- [BORDERS DIVIDERS](https://sleek-line-symbols-51.pages.dev/ja/borders-dividers/)
- [SYM 1D483](https://coquette-symbols.pages.dev/symbol/sym-1d483/)
- [CAPRICORN ZODIAC GOAT](https://pearl-girly-fonts-86.pages.dev/symbol/capricorn-zodiac-goat/)
- [SYM 1F49F](https://coquette-symbols.pages.dev/symbol/sym-1f49f/)
- [SYM 1D4A5](https://angelic-bow-symbols-42.pages.dev/symbol/sym-1d4a5/)
- [SYM 1D49A](https://minimal-star-symbols-93.pages.dev/symbol/sym-1d49a/)
- [SYM 1D498](https://minimal-star-symbols-93.pages.dev/symbol/sym-1d498/)
- [SYM 26B0](https://matrix-hacker-text-52.pages.dev/symbol/sym-26b0/)
- [SYM 26BA](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-26ba/)
- [SYM 2677](https://pearl-girly-fonts-86.pages.dev/symbol/sym-2677/)
- [SYM 1D434](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-1d434/)
- [SYM 1FAE5](https://theeduplaycampen.pages.dev/symbol/sym-1fae5/)
- [SYM 1F47F](https://mecha-blade-symbols-46.pages.dev/symbol/sym-1f47f/)
- [SYM 26FC](https://minimal-star-symbols-93.pages.dev/symbol/sym-26fc/)
- [CURLY RIBBON LOOP](https://neon-glitch-symbols-84.pages.dev/symbol/curly-ribbon-loop/)
- [SYM 1F625](https://mecha-blade-symbols-46.pages.dev/symbol/sym-1f625/)
- [SYM 1D493](https://lace-heart-kaomoji-64.pages.dev/symbol/sym-1d493/)
- [SYM 1D40E](https://angelic-bow-symbols-42.pages.dev/symbol/sym-1d40e/)
- [SYM 1F973](https://mecha-blade-symbols-46.pages.dev/symbol/sym-1f973/)
- [SYM 1D45B](https://pearl-girly-fonts-86.pages.dev/symbol/sym-1d45b/)
- [SYM 1D43F](https://angelic-bow-symbols-42.pages.dev/symbol/sym-1d43f/)
- [SYM 262A](https://lace-heart-kaomoji-64.pages.dev/symbol/sym-262a/)
- [SYM 26BE](https://neon-glitch-symbols-84.pages.dev/symbol/sym-26be/)
- [SYM 1F480](https://angelic-bow-symbols-42.pages.dev/symbol/sym-1f480/)
- [FIRST QUARTER WAXING MOON](https://theeduplaycampen.pages.dev/symbol/first-quarter-waxing-moon/)
- [SYM 26E1](https://minimal-star-symbols-93.pages.dev/symbol/sym-26e1/)
- [FREEFIRE NAMES](https://cyberpunk-clan-tags-43.pages.dev/es/freefire-names/)
- [SYM 1F600](https://lace-heart-kaomoji-64.pages.dev/symbol/sym-1f600/)
- [SYM 1D416](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-1d416/)
- [TIKTOK CAPTIONS](https://pearl-girly-fonts-86.pages.dev/vi/tiktok-captions/)
- [SYM 265E](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-265e/)
- [SYM 1F92C](https://neon-glitch-symbols-84.pages.dev/symbol/sym-1f92c/)
- [SYM 1D499](https://minimal-star-symbols-93.pages.dev/symbol/sym-1d499/)
- [SYM 1F614](https://lace-heart-kaomoji-64.pages.dev/symbol/sym-1f614/)
- [INSTAGRAM BIO](https://mecha-blade-symbols-46.pages.dev/vi/instagram-bio/)
- [NATURE FLOWERS](https://cyberpunk-clan-tags-43.pages.dev/nature-flowers/)
- [ROTATED FLORAL HEART](https://theeduplaycampen.pages.dev/symbol/rotated-floral-heart/)
- [KHANDA EMBLEM](https://cyberpunk-clan-tags-43.pages.dev/symbol/khanda-emblem/)
- [SYM 1F4A9](https://pearl-girly-fonts-86.pages.dev/symbol/sym-1f4a9/)
- [WHITE FLORETTE BLOSSOM](https://coquette-aesthetic-symbols-86.pages.dev/symbol/white-florette-blossom/)
- [KAOMOJI](https://coquette-symbols.pages.dev/ja/kaomoji/)
- [TIKTOK CAPTIONS](https://pearl-girly-fonts-86.pages.dev/tiktok-captions/)
- [SYM 26FE](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-26fe/)
- [KAOMOJI](https://sleek-line-symbols-51.pages.dev/vi/kaomoji/)
- [SYM 1F608](https://mecha-blade-symbols-46.pages.dev/symbol/sym-1f608/)
- [SYM 1D411](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-1d411/)
- [MUSIC WEATHER](https://lace-heart-kaomoji-64.pages.dev/music-weather/)
- [ARROWS LINES](https://coquette-symbols.pages.dev/es/arrows-lines/)
- [SYM 1D462](https://pearl-girly-fonts-86.pages.dev/symbol/sym-1d462/)
- [RIGHT WHITE CORNER BRACKET](https://neon-glitch-symbols-84.pages.dev/symbol/right-white-corner-bracket/)
- [TRENDING](https://mecha-blade-symbols-46.pages.dev/trending/)
- [SYM 2682](https://pearl-girly-fonts-86.pages.dev/symbol/sym-2682/)
- [TRENDING](https://mecha-blade-symbols-46.pages.dev/pt/trending/)
- [FREEFIRE NAMES](https://lace-heart-kaomoji-64.pages.dev/vi/freefire-names/)
- [JA](https://mecha-blade-symbols-46.pages.dev/ja/)
- [DISCORD STATUS](https://sleek-line-symbols-51.pages.dev/ja/discord-status/)
- [TENDER GENTLE TEAR KAOMOJI](https://angelic-bow-symbols-42.pages.dev/symbol/tender-gentle-tear-kaomoji/)
- [FREEFIRE NAMES](https://pearl-girly-fonts-86.pages.dev/es/freefire-names/)
- [SYM 1F62F](https://sleek-line-symbols-51.pages.dev/symbol/sym-1f62f/)
- [SYM 1D414](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-1d414/)
- [SYM 1F635 200D 1F4AB](https://sleek-line-symbols-51.pages.dev/symbol/sym-1f635-200d-1f4ab/)
- [SYM 26CA](https://neon-glitch-symbols-84.pages.dev/symbol/sym-26ca/)
- [SYM 26A5](https://pearl-girly-fonts-86.pages.dev/symbol/sym-26a5/)
- [RU](https://mecha-blade-symbols-46.pages.dev/ru/)
- [GAMING WEAPONS](https://pearl-girly-fonts-86.pages.dev/pt/gaming-weapons/)
- [INSTAGRAM BIO](https://mecha-blade-symbols-46.pages.dev/instagram-bio/)
- [ANTICLOCKWISE OPEN CIRCLE ARROW](https://coquette-aesthetic-symbols-86.pages.dev/symbol/anticlockwise-open-circle-arrow/)
- [SYM 1F976](https://sleek-line-symbols-51.pages.dev/symbol/sym-1f976/)
- [SYM 2686](https://pearl-girly-fonts-86.pages.dev/symbol/sym-2686/)
- [SYM 1F9E1](https://angelic-bow-symbols-42.pages.dev/symbol/sym-1f9e1/)
- [GAMING WEAPONS](https://sleek-line-symbols-51.pages.dev/ja/gaming-weapons/)
- [SYM 1F61E](https://pearl-girly-fonts-86.pages.dev/symbol/sym-1f61e/)
- [HEARTS](https://mecha-blade-symbols-46.pages.dev/hearts/)
- [SYM 1D421](https://minimal-star-symbols-93.pages.dev/symbol/sym-1d421/)
- [SYM 1D40E](https://minimal-star-symbols-93.pages.dev/symbol/sym-1d40e/)
- [BIOHAZARD SYMBOL](https://cyberpunk-clan-tags-43.pages.dev/symbol/biohazard-symbol/)
- [WHITE STAR](https://sleek-line-symbols-51.pages.dev/symbol/white-star/)
- [LITTLE CAT PAWS KAOMOJI](https://matrix-hacker-text-52.pages.dev/symbol/little-cat-paws-kaomoji/)
- [WATER BUBBLES](https://angelic-bow-symbols-42.pages.dev/symbol/water-bubbles/)
- [ES](https://coquette-aesthetic-symbols-86.pages.dev/es/)
- [SYM 1F620](https://theeduplaycampen.pages.dev/symbol/sym-1f620/)
- [MUSIC FLAT SIGN](https://angelic-bow-symbols-42.pages.dev/symbol/music-flat-sign/)
- [SYM 260F](https://angelic-bow-symbols-42.pages.dev/symbol/sym-260f/)
- [SYM 26E6](https://mecha-blade-symbols-46.pages.dev/symbol/sym-26e6/)
- [INSTAGRAM BIO](https://mecha-blade-symbols-46.pages.dev/es/instagram-bio/)
- [STARS](https://matrix-hacker-text-52.pages.dev/ru/stars/)
- [CANCER ZODIAC CRAB](https://angelic-bow-symbols-42.pages.dev/symbol/cancer-zodiac-crab/)
- [SYM 1FAE0](https://lace-heart-kaomoji-64.pages.dev/symbol/sym-1fae0/)
- [SYM 1D41C](https://lace-heart-kaomoji-64.pages.dev/symbol/sym-1d41c/)
- [SYM 2664](https://mecha-blade-symbols-46.pages.dev/symbol/sym-2664/)
- [FREEFIRE NAMES](https://mecha-blade-symbols-46.pages.dev/ja/freefire-names/)
- [ARROWS LINES](https://mecha-blade-symbols-46.pages.dev/pt/arrows-lines/)
