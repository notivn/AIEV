---
name: auto-cut
description: Cut silences and dead weight (fillers, repeated takes, false starts) out of a talking-head video BEFORE building the edit - call the measured /auto-trim API instead of hand-rolling ffmpeg, review the dead-weight candidates it returns, and do the one job only a human/AI can do (spotting repeated POINTS). Read this when the brief enables "Tự động cắt ngắn video" (autoCut) or the user complains that the video still has dead weight/silences.
---

# Auto-Cut - measured silence & dead-weight trimming

## Principles

1. **Cut BEFORE building scenes/captions.** Cutting afterwards throws off every timestamp
   (captions, zooms, SFX). Output of this step: `assets/<source>.cut.mp4` + `assets/transcript.cut.json` -
   every later step uses the cut version.
2. **Cutting is MANDATORY when the brief enables autoCut** - it is not a suggestion. If nothing
   can be cut, you must state a concrete reason (the video was already tight) in the report.
3. **The thresholds live in the server, not in your head.** Do NOT run `silencedetect` yourself
   and do NOT pick a dB threshold by feel. Two measured facts killed that workflow:
   - The right threshold is a property of the FILE, not a constant. On one real file, -40dB found
     0 silences, -30dB found 13, -25dB found 21. A hardcoded number is either useless or eats speech.
   - Loudness alone cannot tell "pausing" from "speaking quietly". On the source file measured,
     `silencedetect` at -30dB reported 48.6s of "silence" but only 18.2s of it sat in a real gap
     between words; the other 30.4s was inside words (syllable breaks, unvoiced Vietnamese finals
     c/t/p/ch). Cutting on sound level alone swallows speech.
   The server does the measuring (`autoTrim.ts`) and the candidate generation (`deadWeight.ts`).
   **You do the reviewing.** That split is the whole point.
4. Two kinds of dead weight get cut: **silences** (machine-measured, guarded by the transcript)
   and **content dead weight** (fillers, stutters, restated takes - proposed by the server, approved
   by you; plus repeated POINTS, which only you can find - see Step 3).

## Step 0 - Prerequisite: a transcript with word timestamps

The whole guard depends on it. The server looks for `assets/transcript.raw.json`, then
`assets/transcript.json`. Without one, analysis still runs but comes back `guarded: false`, the
dead-weight list is empty, and the numbers are guesswork in **both** directions (it can pass a bad
cut and fail a good one). Transcribe first - never trim a Vietnamese talking head unguarded.

## Step 1 - Analyze (free, repeatable, no encoding)

```
POST http://localhost:6869/api/projects/<id>/auto-trim/analyze
body: {}                                   # or { "source": "assets/face.mp4", "level": "tight" }
```

`level` is `natural | default | tight` and defaults to `brief.autoCutLevel`. Response:

- `silence` - `durationSec`, the chosen `thresholdDb` + `thresholdNote` (why that threshold won),
  measured `noiseFloorDb`, the `silences` that will be cut, `keepRanges`, `removedSec`, the full
  `sweep` table, and `wordGuard` (how many seconds the transcript vetoed).
- `deadWeight` - `candidates[]` with `kind` (`filler | stutter | repeat-take | hesitation`),
  `start`/`end`, `text`, `confidence`, `reason`, `context`; plus `totalSec` and `byKind`.
- `guarded` - `true` only when a transcript was found. If `false`, fix that before cutting.

Nothing is encoded, so call it as often as you like (a 217s source analyzes in about a second).

## Step 2 - REVIEW every candidate (your job, not the machine's)

The list is deterministic: same transcript, same candidates, same confidence. What it cannot do is
understand meaning. Go through them one by one and keep only the ones you would defend:

- **Low confidence means "read the context first", not "probably fine".** Vietnamese fillers almost
  always collide with real words. `đó`, `ấy`, `thế`, `mà`, `là` are both filler particles and real
  demonstratives/conjunctions.
- **Connector phrases (`hoặc là`, `tức là`, `bởi vì là`, `với lại là`) are the trap.** Measured on a
  real transcript: "…có thể là ok ứng dụng nó / **Hoặc là** / Tham khảo để tìm cách…" is a genuine
  alternative - cutting it destroys one branch of the sentence. But "Còn trường hợp mà mọi người có
  thể nghe / **Hoặc là** / Còn trường hợp mà người AI không ứng dụng được…" is an abandoned sentence
  and should go. The surface form is identical; only the meaning separates them. That is exactly why
  these come back with a low base confidence and a reason that says READ THE CONTEXT.
- `repeat-take` candidates: check that the later take really is the fuller one before approving.
- `hesitation` candidates are pure silence between words - usually safe, but check you are not
  removing a deliberate beat before a punchline.

Reject freely. A filler left in costs 0.4s; a real word cut makes the sentence nonsense and the
viewer hears it immediately.

## Step 3 - REPEATED POINTS (only you can find these - mandatory)

No detector catches this, and it is the dead weight users complain about most. Read the transcript
as a piece of speech and analyze it semantically:

1. **Group sentences that make the SAME POINT** - the words need not match, only the content. A
   speaker often restates one point 2-3 times: short/stumbling first, more complete later. Consider
   NON-adjacent sentences too (makes point A, rambles, comes back to point A in more detail).
2. **Keep exactly ONE version per group - the MOST COMPLETE one**:
   - Earlier short version, later fuller restatement -> keep the later, cut the earlier.
   - Later sentence is only a short echo ("đúng vậy, như tôi nói…") -> keep the earlier, cut the echo.
   - Two equivalent versions -> keep the smoother delivery (fewer stumbles, no fillers).
3. **Check the flow after cutting**: re-read the kept text end to end. If a kept sentence refers back
   ("như vừa nói") to one you cut, either keep both or pick the version without the back-reference.
4. Turn each decision into a `{start, end}` range and send it with the approved candidates in Step 4.
5. **Build a table before cutting** (put it in the report): `timestamp | sentence cut | reason |
   sentence kept` - so the user can review every decision.

## Step 4 - Apply (goes through the render queue)

```
POST http://localhost:6869/api/projects/<id>/auto-trim/apply
body: { "cutCandidates": [{ "start": 51.81, "end": 52.25 }, …] }   # ONLY what you approved
-> 202 { job }
```

`409 AUTO_CUT_DISABLED` means the project's brief has "Tự động cắt" switched OFF. That is the
user's decision, not an error to work around: do not cut, and do not hand-roll ffmpeg instead. Say
in the report that the switch is off; the user turns it on in the edit brief if they want the cut.

Send an empty list if you approved nothing - the measured silences still get cut. Then poll
`GET /api/jobs/<jobId>` until it finishes. The job:

1. Re-analyzes with the transcript guard, merges the silence ranges with your approved ranges
   (overlaps merged, so nothing is double counted).
2. Drops any approved range that would swallow a word midpoint - a last safety net over your review,
   and it logs every range it rejects. Rejected ranges in the log mean you approved something that
   sits on real speech; go back and re-read that spot.
3. Cuts in ONE ffmpeg pass (`trim/atrim + setpts/asetpts + concat`), writing `assets/<stem>.cut.mp4`.
4. Remaps every timestamp into the cut timeline -> `assets/transcript.cut.json`.
5. Verifies the OUTPUT with the remapped words and writes `assets/auto-trim-report.json`.

If nothing is worth cutting, the job deliberately does NOT produce a `.cut.mp4` (a re-encoded
identical copy only loses quality) - `output` in the report is `null` and you keep using the source.

## Step 5 - Read the report (the job is not done until you do)

`assets/auto-trim-report.json` holds: before/after duration, `removed.silenceSec` vs
`removed.approvedSec`, the chosen threshold and why, rejected candidates, and `verification`.

- **`verdict: "pass"`** - the result meets the profile for that level.
- **`verdict: "fail"`** - the job still finished and the file is usable, but it did NOT meet the
  profile. The log says so explicitly. Approve more dead weight (Step 2/3) and run apply again, or
  state in the final report why you are accepting it. Never report the cut as done while ignoring a
  fail.

The pass criteria are not the old "no silence > 0.8s" rule - measurement showed that rule is far too
lax. A real file passed it while carrying 13 residual silences of 0.45-0.67s totalling 6.7s (4.2% of
the runtime), which sounds obviously draggy. The profiles now cap BOTH the longest single silence and
the total ratio (`default`: 0.5s / 3%).

## Step 6 - Use the cut version everywhere

From here on, captions, key layout, SFX timing and zooms read `assets/transcript.cut.json` and the
`.cut.mp4`. The QC check `dead-air` re-measures the assembled video against the transcript and FAILS
when `brief.autoCut` is on and dead air is still over the profile - that is the backstop, not the
plan.

Final report must include: the cut table from Step 3, seconds removed split into silence vs approved
dead weight, and the verification verdict. Take the numbers from `auto-trim-report.json`.

## Known issues

- Using the OLD transcript after cutting -> captions drift further out of sync toward the end.
  Always switch to `transcript.cut.json`.
- Cutting only silences and ignoring repeated points - what users call "dead weight" is mostly Step 3.
- Cutting the rendered draft instead of the source -> quality drops from a second encode. Always cut
  from the source (the server refuses to overwrite the source, and skips files already named `*.cut.*`
  when picking a default).
- Analyzing a `.cut.mp4` while the only transcript is the raw one -> the guard is aligned to the wrong
  timeline. Match the source file to the transcript that describes it.
- SFX/narration files with their own lead silence -> use `data-media-start` to trim inside HyperFrames
  (see "SFX loudness and lead silence" in the noti-tiktok-vn skill), do not re-encode an audio file
  just for 0.3s of leading silence.
- Joining cut segments without a fade -> a click at every join. Fixed in `autoTrim.ts`; the rule is
  below, and it applies to any new code that cuts or concatenates audio.

## Audio: fade 30ms at every cut edge (hard rule)

A cut lands mid-waveform. The last sample of one segment and the first sample of the next are
unrelated, so the join is a vertical step, and a step is a click. The cause is not the encoder and not
the source - it is the join itself, so it survives any re-encode downstream.

**How much it matters depends on WHERE the cut lands, and the difference is large.** Measured
losslessly on a real 278s talking-head, comparing the same cut with and without the fade (largest
sample-to-sample step at the join; anything above ~0.02 is audible):

| Kind of join | Before | After |
|---|---|---|
| Silence trim, 40 joins (`balanced`) | median 0.0040, worst 0.0113 - **none audible** | median 0.0000 |
| Mid-speech, 4 joins (dead weight / repeated points) | 0.1195, 0.0744, 0.0232, 0.0064 - **3 of 4 audible** | all ≤ 0.0008 |

For scale, the loudest step anywhere in normal speech in those files was 0.06-0.13. So a mid-speech
join without the fade can be a bigger jump than anything the content itself produces, while a silence
join is nowhere near audible.

Do not skip the fade on the strength of that first row. Plain silence trimming is the case where it
happens not to matter; Step 3 (repeated points) and clip extraction cut straight through speech, and
those are the joins that click.

Fix: fade both edges of every segment over 30ms. Long enough to kill the step, far too short to hear
as a fade. Use `audioCutFade()` in `apps/server/src/util.ts`; do not hand-roll the filter.

```
[0:a]atrim=start=S:end=E,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.030,afade=t=out:st=D-0.030:d=0.030[aN]
```

Three things that make it silently do nothing:

- **Order.** `afade` must come AFTER `asetpts=PTS-STARTPTS`. `afade` reads `st` off the stream's own
  clock; on original timestamps `st=0` is in the past and the fade-in never fires.
- **Length.** `D` is the segment duration, so the fade-out start is `D - 0.030`. Clamp the fade to
  `D/2` or the two fades overlap on a short segment and swallow it.
- **Extracting a clip, not just joining.** A clip cut out of a longer video has the same two raw edges
  even though nothing is being joined - `reframe.ts` fades them via `-af`.

One note on measuring this yourself: do not compare two AAC encodes. Re-encoding perturbs samples
everywhere, which buried the 40 real joins among 294 spurious difference regions and put a 54ms
offset between the two files. Render both variants straight to `pcm_s16le` instead - then the two are
sample-aligned and the joins sit exactly at the cumulative segment lengths.
