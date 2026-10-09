/**
 * Toán frame của trình chỉnh sửa - THUẦN, không React.
 *
 * Vị trí scene trên timeline composition phải khớp TỪNG FRAME với cái trình
 * phát đang chạy, nên mọi phép tính ở đây đi đúng đường của
 * engines/remotion/src/Assemble.tsx + PreviewPlayer.buildPreviewManifest:
 *
 *   - độ dài scene = `resolveSceneDurationInFrames` của engine (làm tròn từng
 *     đầu from/to, không làm tròn hiệu);
 *   - scene nối TUẦN TỰ: scene i+1 bắt đầu ở start(i) + dur(i) - overlap(i);
 *   - `transitionOverlap` của scene i bị kẹp về min(dur(i), dur(i+1)) như
 *     jobs/assemble.ts (scene cuối không kẹp - không ảnh hưởng tổng);
 *   - tổng = max(start + dur) - đúng `totalDurationInFrames`.
 *
 * Scene chưa suy ra được độ dài (thiếu durationInFrames và from/to) thì trình
 * phát hiện lỗi thay vì phát; ở đây nó được vẽ 1 frame và đánh dấu `invalid`
 * để timeline vẫn hiện được, người dùng bấm vào sửa.
 */

import { resolveSceneDurationInFrames } from "@engine/manifest";
import type { Timeline, TimelineScene } from "@/lib/api";

/** Độ dài frame của scene như engine tính; null = chưa suy ra được. */
export function sceneDurationFrames(scene: TimelineScene, fps: number): number | null {
  try {
    const frames = resolveSceneDurationInFrames(
      { ...scene, srcImage: scene.srcImage ?? null },
      fps,
    );
    return Number.isFinite(frames) && frames > 0 ? frames : null;
  } catch {
    return null;
  }
}

export interface SceneSpan {
  index: number;
  id: string;
  /** Frame bắt đầu trên composition (gồm cả chỗ chồng với scene trước) */
  start: number;
  /** Frame KẾT THÚC (không gồm) = start + duration */
  end: number;
  duration: number;
  /** Số frame chồng sang scene kế - đã kẹp như trình phát */
  overlapOut: number;
  /** true = scene thiếu độ dài, đang vẽ tạm 1 frame */
  invalid: boolean;
}

/** Overlap hiệu lực của scene `i` - kẹp đúng như buildPreviewManifest. */
export function effectiveOverlap(scenes: TimelineScene[], i: number, fps: number): number {
  const raw = scenes[i]?.transitionOverlap;
  if (typeof raw !== "number" || !(raw > 0)) return 0;
  if (i >= scenes.length - 1) return raw;
  const cur = sceneDurationFrames(scenes[i], fps);
  const next = sceneDurationFrames(scenes[i + 1], fps);
  if (cur === null || next === null) return raw;
  return Math.min(raw, Math.max(0, Math.min(cur, next)));
}

/** Vị trí [start, end) của mọi scene trên composition - khớp Assemble. */
export function computeSceneSpans(scenes: TimelineScene[], fps: number): SceneSpan[] {
  const spans: SceneSpan[] = [];
  let from = 0;
  scenes.forEach((scene, index) => {
    const resolved = sceneDurationFrames(scene, fps);
    const duration = resolved ?? 1;
    const overlapOut = effectiveOverlap(scenes, index, fps);
    spans.push({
      index,
      id: scene.id,
      start: from,
      end: from + duration,
      duration,
      overlapOut: index < scenes.length - 1 ? overlapOut : 0,
      invalid: resolved === null,
    });
    from += duration - overlapOut;
  });
  return spans;
}

/** Tổng frame của composition (≥ 1) - đúng `totalDurationInFrames`. */
export function totalFramesOf(spans: SceneSpan[]): number {
  let total = 0;
  for (const span of spans) total = Math.max(total, span.end);
  return Math.max(1, total);
}

/**
 * Frame cuối cùng có nội dung trên timeline - lấy max của scene, cue, sfx.
 * Dùng để vẽ timeline đủ dài khi cue thò ra ngoài video (vẫn phải thấy để kéo về).
 */
export function contentEndFrame(timeline: Timeline, spans: SceneSpan[]): number {
  let end = totalFramesOf(spans);
  // Bỏ qua phần tử sai kiểu (AI ghi tay meta.json): một NaN ở đây làm cả
  // timeline rộng NaN px và biến mất
  const add = (v: number) => {
    if (Number.isFinite(v)) end = Math.max(end, v);
  };
  for (const list of [timeline.captions, timeline.subtitles, timeline.overlays]) {
    for (const cue of list) add(cue?.from + cue?.durationInFrames);
  }
  for (const sfx of timeline.audio.sfx) add(sfx?.atFrame + 1);
  return end;
}

// ---------------------------------------------------------------- frame ↔ px

/** Thang zoom: px cho MỘT GIÂY timeline. */
export const ZOOM_MIN_PPS = 8;
export const ZOOM_MAX_PPS = 600;

export const clampPps = (pps: number): number =>
  Math.min(ZOOM_MAX_PPS, Math.max(ZOOM_MIN_PPS, pps));

export const frameToPx = (frame: number, pps: number, fps: number): number =>
  (frame * pps) / fps;

export const pxToFrame = (px: number, pps: number, fps: number): number =>
  (px * fps) / pps;

/**
 * Bước vạch thước giờ (giây) sao cho hai nhãn cách nhau ≥ `minGapPx`.
 * Trả cả bước vạch phụ (không nhãn).
 */
export function rulerStep(pps: number, minGapPx = 72): { major: number; minor: number } {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((s) => s * pps >= minGapPx) ?? 600;
  const minor = major >= 10 ? major / 5 : major / 2;
  return { major, minor };
}

// ---------------------------------------------------------------- hiển thị

/** mm:ss.ff - ff là số frame trong giây (00..fps-1), như timecode NLE. */
export function formatTimecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const whole = Math.max(1, Math.round(fps));
  const totalSec = Math.floor(f / fps);
  const ff = Math.min(whole - 1, Math.floor(f - totalSec * fps));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ff).padStart(2, "0")}`;
}

/**
 * Giây thập phân cho người dùng - CÙNG cách viết với inspector (ô số "s"):
 * "2.67s", từ 1 phút trở lên "1:02.67". Khối/tiêu đề timeline dùng cái này;
 * chỉ thanh phát giữ mm:ss.ff (khung hình) như NLE.
 */
export function formatSeconds(frames: number, fps: number): string {
  const sec = Math.max(0, Math.round((frames / fps) * 100) / 100);
  if (sec < 60) return `${sec.toFixed(2).replace(/\.?0+$/, "") || "0"}s`;
  const mm = Math.floor(sec / 60);
  const rest = (sec - mm * 60).toFixed(2).padStart(5, "0");
  return `${mm}:${rest}`;
}

/** Nhãn thước giờ: 0:05, 1:30… */
export function formatRulerLabel(sec: number): string {
  const s = Math.round(sec * 10) / 10;
  const mm = Math.floor(s / 60);
  const rest = s - mm * 60;
  const ss = Number.isInteger(rest) ? String(rest).padStart(2, "0") : rest.toFixed(1).padStart(4, "0");
  return `${mm}:${ss}`;
}

/** Giây hiển thị cho người dùng (2 chữ số thập phân, bỏ số 0 thừa). */
export const framesToSec = (frames: number, fps: number): number =>
  Math.round((frames / fps) * 100) / 100;

export const secToFrames = (sec: number, fps: number): number => Math.round(sec * fps);
