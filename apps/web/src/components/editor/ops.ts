/**
 * Mọi thao tác sửa timeline - HÀM THUẦN trên `Timeline` (không React, không
 * fetch, không Date.now). Store chỉ việc gọi chúng; kéo/thả, phím tắt và
 * inspector đều đi qua đây nên luật (kẹp độ dài, giữ field lạ…) nằm ở MỘT chỗ.
 *
 * Ba luật cho mọi hàm:
 * 1. Không bao giờ sửa object đầu vào - sao nông đúng nhánh bị đổi, phần còn
 *    lại giữ nguyên identity (trình phát và React so identity để biết cái gì đổi).
 * 2. Giữ NGUYÊN field lạ (meta.json là looseObject - agent hay ghi thêm field):
 *    sửa bằng spread trên bản cũ, không dựng object mới từ đầu. Tách đôi thì cả
 *    hai nửa đều mang đủ field lạ (structuredClone).
 * 3. Thao tác vô nghĩa (tách đúng mép, kéo 0 frame, chỉ số sai…) trả về CHÍNH
 *    timeline đầu vào - store dựa vào đó để không đẻ bước hoàn tác rỗng.
 *
 * Đơn vị theo hợp đồng (docs/EDITOR-PLAN.md mục 1): scene `from`/`to` là GIÂY
 * trong file nguồn; cue, `sfx.atFrame`, `words[].start/end` là FRAME TUYỆT ĐỐI.
 */

import type {
  Timeline,
  TimelineCaptionCue,
  TimelineHighlightCue,
  TimelineHighlightPart,
  TimelineMusic,
  TimelinePreview,
  TimelineScene,
  TimelineSfx,
  TimelineSubtitleCue,
  TimelineSubtitleStyle,
  TimelineZoom,
  TimelineZoomKey,
  TimelineCaptionWord,
} from "@/lib/api";
import { sceneDurationFrames } from "./timing";

// ================================================================ kiểu chung

export type CueKind = "captions" | "subtitles" | "overlays";
export type CueSelKind = "caption" | "subtitle" | "overlay";

/** Phần tử đang chọn. Scene theo `id` (đổi thứ tự không lạc), phần còn lại theo chỉ số. */
export type Selection =
  | { kind: "scene"; id: string }
  | { kind: CueSelKind; index: number }
  | { kind: "sfx"; index: number }
  | { kind: "music" }
  | { kind: "voice" };

export const CUE_KIND: Record<CueSelKind, CueKind> = {
  caption: "captions",
  subtitle: "subtitles",
  overlay: "overlays",
};

export const isCueSel = (kind: Selection["kind"]): kind is CueSelKind =>
  kind === "caption" || kind === "subtitle" || kind === "overlay";

export const sameSelection = (a: Selection | null, b: Selection | null): boolean => {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "scene" && b.kind === "scene") return a.id === b.id;
  if ("index" in a && "index" in b) return a.index === b.index;
  return true;
};

/** Thông tin ngoài timeline mà vài thao tác cần (fps, độ dài file media thật). */
export interface OpsContext {
  fps: number;
  /** durationSec của file media (đường dẫn tương đối project); null = chưa biết */
  mediaDurationSec: (relPath: string) => number | null;
  /** File xem trước (render HyperFrames) của scene; null = chưa render */
  sceneRender: (scene: TimelineScene) => string | null;
}

export function contextFromPreview(preview: TimelinePreview, fps: number): OpsContext {
  return {
    fps,
    mediaDurationSec: (rel) => {
      const d = preview.media[rel]?.durationSec;
      return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : null;
    },
    sceneRender: (scene) => {
      if (isNonEmpty(scene.src)) return preview.sceneRenders[scene.id] ?? null;
      return isNonEmpty(scene.render) ? scene.render : null;
    },
  };
}

const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Giây ghi vào meta: căn đúng lưới frame, đủ 6 chữ số để round(x*fps) ra lại đúng frame. */
const frameToSec = (frame: number, fps: number): number =>
  Math.round((frame / fps) * 1e6) / 1e6;

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.round(Math.min(hi, Math.max(lo, v)));

/**
 * Áp patch NÔNG lên một object, giữ mọi field khác (kể cả field lạ). Giá trị
 * `undefined` trong patch = XÓA khóa đó (người dùng xóa trắng một ô tùy chọn).
 * Không có gì đổi thì trả lại chính object cũ.
 */
export function applyPatch<T extends object>(obj: T, patch: Partial<T>): T {
  let changed = false;
  const next = { ...obj };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      if (Reflect.has(next, key)) {
        Reflect.deleteProperty(next, key);
        changed = true;
      }
    } else if (Reflect.get(next, key) !== value) {
      Reflect.set(next, key, value);
      changed = true;
    }
  }
  return changed ? next : obj;
}

function replaceAt<T>(list: T[], index: number, item: T): T[] {
  if (list[index] === item) return list;
  const next = list.slice();
  next[index] = item;
  return next;
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// ================================================================ scene

export type SceneKind = "footage" | "image" | "hyperframes" | "render" | "empty";

/**
 * Scene phát cái gì - đúng thứ tự ưu tiên của SceneClip sau khi
 * buildPreviewManifest đã gắn `render` cho scene HyperFrames.
 */
export function sceneKind(scene: TimelineScene): SceneKind {
  if (isNonEmpty(scene.src)) return "hyperframes";
  if (isNonEmpty(scene.srcVideo)) return "footage";
  if (isNonEmpty(scene.srcImage)) return "image";
  if (isNonEmpty(scene.render)) return "render";
  return "empty";
}

/** Đường dẫn file mà scene hiển thị (để làm nhãn) - null nếu không có. */
export function sceneSourcePath(scene: TimelineScene): string | null {
  switch (sceneKind(scene)) {
    case "hyperframes":
      return scene.src ?? null;
    case "footage":
      return scene.srcVideo ?? null;
    case "image":
      return scene.srcImage ?? null;
    case "render":
      return scene.render ?? null;
    default:
      return null;
  }
}

/**
 * Độ dài TỐI ĐA (frame) của scene theo file thật: HyperFrames không dài hơn bản
 * render (SceneClip phát render từ frame 0, dài hơn là khung đen). null = không giới hạn.
 */
export function sceneMaxFrames(scene: TimelineScene, ctx: OpsContext): number | null {
  const kind = sceneKind(scene);
  if (kind !== "hyperframes" && kind !== "render") return null;
  const render = ctx.sceneRender(scene);
  const sec = render ? ctx.mediaDurationSec(render) : null;
  return sec === null ? null : Math.max(1, Math.floor(sec * ctx.fps + 1e-6));
}

/** Khung [inFrame, outFrame) trong file footage - null nếu chưa đủ dữ liệu. */
export function footageWindow(
  scene: TimelineScene,
  fps: number,
): { inFrame: number; outFrame: number } | null {
  if (sceneKind(scene) !== "footage") return null;
  const inFrame = Math.round((scene.from ?? 0) * fps);
  if (typeof scene.to === "number") return { inFrame, outFrame: Math.round(scene.to * fps) };
  if (typeof scene.durationInFrames === "number") {
    return { inFrame, outFrame: inFrame + scene.durationInFrames };
  }
  return null;
}

export const sceneIndexById = (tl: Timeline, id: string): number =>
  tl.scenes.findIndex((s) => s.id === id);

/** Id chưa dùng: "a1" → "a1-2", "a1-3"… (bỏ hậu tố số cũ trước khi đếm). */
export function uniqueSceneId(scenes: TimelineScene[], base: string): string {
  const taken = new Set(scenes.map((s) => s.id));
  const stem = base.replace(/-\d+$/, "") || "scene";
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function reorderScene(tl: Timeline, from: number, to: number): Timeline {
  const n = tl.scenes.length;
  if (from < 0 || from >= n) return tl;
  const target = clampInt(to, 0, n - 1);
  if (target === from) return tl;
  return { ...tl, scenes: moveItem(tl.scenes, from, target) };
}

/**
 * Kéo mép scene `delta` frame. Scene nối tuần tự nên đây là trim "ripple":
 * mọi scene phía sau tự dời theo.
 * - footage: mép đầu đổi `from`, mép cuối đổi `to` (giây, căn lưới frame), kẹp
 *   trong [0, độ dài file]; scene có cả `durationInFrames` thì cập nhật luôn cho
 *   khớp (engine ưu tiên durationInFrames).
 * - ảnh / scene chỉ có durationInFrames: đổi độ dài (mép nào cũng vậy).
 * - HyperFrames: chỉ mép cuối, không dài hơn bản render.
 * Luôn còn ít nhất 1 frame.
 */
export function trimScene(
  tl: Timeline,
  index: number,
  edge: "start" | "end",
  delta: number,
  ctx: OpsContext,
): Timeline {
  const scene = tl.scenes[index];
  if (!scene || !Number.isFinite(delta)) return tl;
  const d = Math.round(delta);
  if (d === 0) return tl;
  const { fps } = ctx;
  const kind = sceneKind(scene);

  if (kind === "footage") {
    const win = footageWindow(scene, fps);
    if (!win) return tl;
    const mediaSec = scene.srcVideo ? ctx.mediaDurationSec(scene.srcVideo) : null;
    const mediaFrames =
      mediaSec === null ? Number.POSITIVE_INFINITY : Math.floor(mediaSec * fps + 1e-6);
    let { inFrame, outFrame } = win;
    const patch: Partial<TimelineScene> = {};
    if (edge === "start") {
      inFrame = clampInt(inFrame + d, 0, outFrame - 1);
      if (inFrame === win.inFrame) return tl;
      patch.from = frameToSec(inFrame, fps);
      // Chưa có `to` (độ dài lấy từ durationInFrames) thì ghi `to` cũ để mép cuối đứng yên
      if (typeof scene.to !== "number") patch.to = frameToSec(outFrame, fps);
    } else {
      // Đã dài quá file sẵn (dữ liệu cũ) thì không cho dài thêm, nhưng vẫn cho co lại
      const upper = Math.max(outFrame, mediaFrames);
      outFrame = clampInt(outFrame + d, inFrame + 1, upper);
      if (outFrame === win.outFrame) return tl;
      patch.to = frameToSec(outFrame, fps);
      if (typeof scene.from !== "number") patch.from = 0;
    }
    if (typeof scene.durationInFrames === "number") patch.durationInFrames = outFrame - inFrame;
    return { ...tl, scenes: replaceAt(tl.scenes, index, applyPatch(scene, patch)) };
  }

  if (typeof scene.durationInFrames !== "number") return tl;
  if ((kind === "hyperframes" || kind === "render") && edge === "start") return tl;
  const cur = scene.durationInFrames;
  const max = sceneMaxFrames(scene, ctx);
  const upper = max === null ? Number.POSITIVE_INFINITY : Math.max(max, cur);
  const next = clampInt(edge === "end" ? cur + d : cur - d, 1, upper);
  if (next === cur) return tl;
  return {
    ...tl,
    scenes: replaceAt(tl.scenes, index, applyPatch(scene, { durationInFrames: next })),
  };
}

// ---- zoom (camera move) - mirror của scaleAtFrame trong SceneClip

const EASE: Record<string, (t: number) => number> = {
  linear: (t) => t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

const sortKeys = (keys: TimelineZoomKey[]): TimelineZoomKey[] =>
  [...keys].sort((a, b) => a.frame - b.frame);

/** Scale tại `frame` (tính từ đầu scene) - đúng công thức SceneClip. */
export function zoomScaleAt(zoom: TimelineZoom, frame: number): number {
  const keys = sortKeys(zoom.keys);
  if (keys.length === 0) return 1;
  if (frame <= keys[0].frame) return keys[0].scale;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (frame <= b.frame) {
      const span = b.frame - a.frame;
      if (span <= 0) return b.scale;
      const ease = EASE[a.ease ?? "inOut"] ?? EASE.inOut;
      return a.scale + (b.scale - a.scale) * ease((frame - a.frame) / span);
    }
  }
  return keys[keys.length - 1].scale;
}

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** Cắt zoom tại `cut` frame thành hai nửa, mỗi nửa ≥ 2 mốc (schema đòi). */
function splitZoom(
  zoom: TimelineZoom,
  cut: number,
  secondDuration: number,
): [TimelineZoom, TimelineZoom] {
  const keys = sortKeys(zoom.keys);
  const scale = round4(zoomScaleAt(zoom, cut));
  const segment = [...keys].reverse().find((k) => k.frame <= cut);
  const firstKeys: TimelineZoomKey[] = [
    ...keys.filter((k) => k.frame < cut),
    { frame: cut, scale },
  ];
  if (firstKeys.length < 2) firstKeys.unshift({ frame: 0, scale });
  const secondKeys: TimelineZoomKey[] = [
    { frame: 0, scale, ...(segment?.ease ? { ease: segment.ease } : {}) },
    ...keys.filter((k) => k.frame > cut).map((k) => ({ ...k, frame: k.frame - cut })),
  ];
  if (secondKeys.length < 2) secondKeys.push({ frame: Math.max(1, secondDuration), scale });
  return [
    { ...zoom, keys: firstKeys },
    { ...structuredClone(zoom), keys: secondKeys },
  ];
}

/** Có tách được scene này không (footage / ảnh / scene chỉ có durationInFrames). */
export function canSplitScene(scene: TimelineScene, fps: number): boolean {
  const kind = sceneKind(scene);
  if (kind === "footage") return footageWindow(scene, fps) !== null;
  if (kind === "image" || kind === "empty") return typeof scene.durationInFrames === "number";
  // HyperFrames/render phát nguyên file từ frame 0 - nửa sau sẽ phát lại từ đầu
  return false;
}

/**
 * Tách scene tại `offset` frame tính từ đầu scene. Nửa đầu giữ id cũ, nửa sau
 * nhận `newId`. Cả hai mang đủ field lạ; zoom được cắt liền mạch tại điểm tách;
 * nửa đầu cắt thẳng (overlap 0), nửa sau giữ chuyển cảnh cũ sang scene kế.
 */
export function splitSceneAt(
  tl: Timeline,
  index: number,
  offset: number,
  newId: string,
  ctx: OpsContext,
): Timeline {
  const scene = tl.scenes[index];
  if (!scene || !canSplitScene(scene, ctx.fps)) return tl;
  if (!newId || tl.scenes.some((s) => s.id === newId)) return tl;
  const duration = sceneDurationFrames(scene, ctx.fps);
  const cut = Math.round(offset);
  if (duration === null || cut <= 0 || cut >= duration) return tl;

  const first: TimelineScene = { ...scene };
  const second: TimelineScene = { ...structuredClone(scene), id: newId };

  if (sceneKind(scene) === "footage") {
    const win = footageWindow(scene, ctx.fps);
    if (!win) return tl;
    const cutFrame = win.inFrame + cut;
    first.from = frameToSec(win.inFrame, ctx.fps);
    first.to = frameToSec(cutFrame, ctx.fps);
    second.from = first.to;
    second.to = frameToSec(win.outFrame, ctx.fps);
    // Giữ nguyên giá trị gốc của mép không bị cắt (có thể không nằm đúng lưới frame)
    if (typeof scene.from === "number") first.from = scene.from;
    if (typeof scene.to === "number") second.to = scene.to;
    if (typeof scene.durationInFrames === "number") {
      first.durationInFrames = cut;
      second.durationInFrames = duration - cut;
    }
  } else {
    first.durationInFrames = cut;
    second.durationInFrames = duration - cut;
  }

  if (scene.zoom && Array.isArray(scene.zoom.keys) && scene.zoom.keys.length > 0) {
    const [z1, z2] = splitZoom(scene.zoom, cut, duration - cut);
    first.zoom = z1;
    second.zoom = z2;
  }
  if (typeof scene.transitionOverlap === "number") first.transitionOverlap = 0;

  const scenes = tl.scenes.slice();
  scenes.splice(index, 1, first, second);
  return { ...tl, scenes };
}

export function patchScene(tl: Timeline, index: number, patch: Partial<TimelineScene>): Timeline {
  const scene = tl.scenes[index];
  if (!scene) return tl;
  const next = applyPatch(scene, patch);
  return next === scene ? tl : { ...tl, scenes: replaceAt(tl.scenes, index, next) };
}

/** Đặt in/out (frame trong file) cho scene footage - kẹp như trimScene. */
export function setFootageWindow(
  tl: Timeline,
  index: number,
  inFrame: number,
  outFrame: number,
  ctx: OpsContext,
): Timeline {
  const scene = tl.scenes[index];
  if (!scene || sceneKind(scene) !== "footage") return tl;
  const mediaSec = scene.srcVideo ? ctx.mediaDurationSec(scene.srcVideo) : null;
  const max = mediaSec === null ? Number.POSITIVE_INFINITY : Math.floor(mediaSec * ctx.fps + 1e-6);
  const a = clampInt(inFrame, 0, Math.max(0, max - 1));
  const b = clampInt(outFrame, a + 1, Math.max(a + 1, max));
  const patch: Partial<TimelineScene> = {
    from: frameToSec(a, ctx.fps),
    to: frameToSec(b, ctx.fps),
  };
  if (typeof scene.durationInFrames === "number") patch.durationInFrames = b - a;
  return patchScene(tl, index, patch);
}

/** Đổi độ dài (frame) của scene ảnh/HyperFrames - kẹp [1, bản render]. */
export function setSceneDuration(
  tl: Timeline,
  index: number,
  frames: number,
  ctx: OpsContext,
): Timeline {
  const scene = tl.scenes[index];
  if (!scene || sceneKind(scene) === "footage") return tl;
  const max = sceneMaxFrames(scene, ctx);
  const cur = typeof scene.durationInFrames === "number" ? scene.durationInFrames : 1;
  const upper = max === null ? Number.POSITIVE_INFINITY : Math.max(max, cur);
  return patchScene(tl, index, { durationInFrames: clampInt(frames, 1, upper) });
}

/** transitionOverlap sang scene kế (frame) - 0 = cắt thẳng thì xóa khóa. */
export function setTransitionOverlap(tl: Timeline, index: number, frames: number): Timeline {
  if (index < 0 || index >= tl.scenes.length) return tl;
  const v = Math.max(0, Math.round(frames));
  return patchScene(tl, index, { transitionOverlap: v > 0 ? v : undefined });
}

export interface PunchIn {
  startScale: number;
  endScale: number;
  ease: "linear" | "out" | "inOut";
}

/**
 * Punch-in đơn giản: hai mốc (đầu scene → cuối scene). Ghi đè `zoom.keys` nhưng
 * giữ `origin` và field lạ của zoom. null = bỏ zoom.
 */
export function setScenePunchIn(
  tl: Timeline,
  index: number,
  punch: PunchIn | null,
  ctx: OpsContext,
): Timeline {
  const scene = tl.scenes[index];
  if (!scene) return tl;
  if (punch === null) return patchScene(tl, index, { zoom: undefined });
  const duration = sceneDurationFrames(scene, ctx.fps) ?? 1;
  const keys: TimelineZoomKey[] = [
    { frame: 0, scale: punch.startScale, ease: punch.ease },
    { frame: Math.max(1, duration), scale: punch.endScale },
  ];
  return patchScene(tl, index, { zoom: { ...(scene.zoom ?? {}), keys } });
}

/** Đọc punch-in từ zoom hiện có: null = không zoom; `custom` = nhiều hơn 2 mốc. */
export function readPunchIn(
  scene: TimelineScene,
): { punch: PunchIn; custom: boolean } | null {
  const keys = scene.zoom?.keys;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const sorted = sortKeys(keys);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    punch: { startScale: first.scale, endScale: last.scale, ease: first.ease ?? "inOut" },
    custom: sorted.length > 2 || first.frame !== 0,
  };
}

// ================================================================ cue

type BaseCue = { from: number; durationInFrames: number };

const cueEnd = (cue: BaseCue): number => cue.from + cue.durationInFrames;

function shiftWords(cue: TimelineCaptionCue, delta: number): TimelineCaptionCue {
  if (delta === 0) return cue;
  return {
    ...cue,
    words: cue.words.map((w) => ({
      ...w,
      start: Math.max(0, w.start + delta),
      end: Math.max(0, w.end + delta),
    })),
  };
}

/** Kẹp mọi từ vào [from, end] của cue (mép cue vừa đổi). */
function clampWords(cue: TimelineCaptionCue): TimelineCaptionCue {
  const lo = cue.from;
  const hi = cueEnd(cue);
  let changed = false;
  const words = cue.words.map((w) => {
    const start = Math.min(hi, Math.max(lo, w.start));
    const end = Math.min(hi, Math.max(start, w.end));
    if (start === w.start && end === w.end) return w;
    changed = true;
    return { ...w, start, end };
  });
  return changed ? { ...cue, words } : cue;
}

/**
 * Sửa một cue theo loại - mỗi nhánh giữ đúng kiểu của mảng mình. `fn` trả về
 * chính cue cũ = không đổi; `captionFix` chạy thêm cho karaoke (từ đi theo cue).
 */
function editCue(
  tl: Timeline,
  kind: CueKind,
  index: number,
  fn: <C extends BaseCue>(cue: C) => C,
  captionFix?: (before: TimelineCaptionCue, after: TimelineCaptionCue) => TimelineCaptionCue,
): Timeline {
  switch (kind) {
    case "captions": {
      const cue = tl.captions[index];
      if (!cue) return tl;
      let next = fn(cue);
      if (next !== cue && captionFix) next = captionFix(cue, next);
      return next === cue ? tl : { ...tl, captions: replaceAt(tl.captions, index, next) };
    }
    case "subtitles": {
      const cue = tl.subtitles[index];
      if (!cue) return tl;
      const next = fn(cue);
      return next === cue ? tl : { ...tl, subtitles: replaceAt(tl.subtitles, index, next) };
    }
    case "overlays": {
      const cue = tl.overlays[index];
      if (!cue) return tl;
      const next = fn(cue);
      return next === cue ? tl : { ...tl, overlays: replaceAt(tl.overlays, index, next) };
    }
  }
}

export function cueList(tl: Timeline, kind: CueKind): BaseCue[] {
  return tl[kind];
}

/** Dời cue `delta` frame (không trước frame 0). Karaoke: từ đi theo cue. */
export function moveCue(tl: Timeline, kind: CueKind, index: number, delta: number): Timeline {
  const d = Math.round(delta);
  if (!Number.isFinite(d) || d === 0) return tl;
  return editCue(
    tl,
    kind,
    index,
    (cue) => {
      const from = Math.max(0, cue.from + d);
      return from === cue.from ? cue : { ...cue, from };
    },
    (before, after) => shiftWords(after, after.from - before.from),
  );
}

/** Đặt mốc bắt đầu tuyệt đối (frame) - như moveCue. */
export function setCueStart(tl: Timeline, kind: CueKind, index: number, frame: number): Timeline {
  const cue = cueList(tl, kind)[index];
  if (!cue) return tl;
  return moveCue(tl, kind, index, Math.max(0, Math.round(frame)) - cue.from);
}

/**
 * Kéo mép cue. Mép đầu: đổi `from`, giữ mép cuối; mép cuối: đổi độ dài. Luôn
 * còn ≥ 1 frame. Karaoke: từ bị kẹp vào trong cue mới (không có từ nào lọt ra ngoài).
 */
export function resizeCue(
  tl: Timeline,
  kind: CueKind,
  index: number,
  edge: "start" | "end",
  delta: number,
): Timeline {
  const d = Math.round(delta);
  if (!Number.isFinite(d) || d === 0) return tl;
  return editCue(
    tl,
    kind,
    index,
    (cue) => {
      const end = cueEnd(cue);
      if (edge === "start") {
        const from = clampInt(cue.from + d, 0, end - 1);
        return from === cue.from ? cue : { ...cue, from, durationInFrames: end - from };
      }
      const durationInFrames = Math.max(1, cue.durationInFrames + d);
      return durationInFrames === cue.durationInFrames ? cue : { ...cue, durationInFrames };
    },
    (_before, after) => clampWords(after),
  );
}

/** Đặt độ dài tuyệt đối (frame). */
export function setCueDuration(tl: Timeline, kind: CueKind, index: number, frames: number): Timeline {
  const cue = cueList(tl, kind)[index];
  if (!cue) return tl;
  return resizeCue(tl, kind, index, "end", Math.max(1, Math.round(frames)) - cue.durationInFrames);
}

/**
 * Tách cue tại frame tuyệt đối `frame`. Phụ đề/highlight: hai nửa cùng nội
 * dung (người dùng sửa sau). Karaoke: từ bắt đầu trước điểm tách thuộc nửa đầu
 * (từ vắt qua bị cắt đuôi), phần còn lại sang nửa sau - nửa nào không còn từ
 * nào thì không tách.
 */
export function splitCueAt(tl: Timeline, kind: CueKind, index: number, frame: number): Timeline {
  const list = cueList(tl, kind);
  const cue = list[index];
  if (!cue) return tl;
  const at = Math.round(frame);
  if (at <= cue.from || at >= cueEnd(cue)) return tl;
  const local = at - cue.from;

  const halves = <C extends BaseCue>(c: C): [C, C] => [
    { ...c, durationInFrames: local },
    { ...structuredClone(c), from: at, durationInFrames: c.durationInFrames - local },
  ];

  switch (kind) {
    case "captions": {
      const [a, b] = halves(tl.captions[index]);
      const wordsA = a.words.filter((w) => w.start < at).map((w) => (w.end > at ? { ...w, end: at } : w));
      const wordsB = b.words.filter((w) => w.start >= at);
      if (wordsA.length === 0 || wordsB.length === 0) return tl;
      const captions = tl.captions.slice();
      captions.splice(index, 1, { ...a, words: wordsA }, { ...b, words: wordsB });
      return { ...tl, captions };
    }
    case "subtitles": {
      const subtitles = tl.subtitles.slice();
      subtitles.splice(index, 1, ...halves(tl.subtitles[index]));
      return { ...tl, subtitles };
    }
    case "overlays": {
      const overlays = tl.overlays.slice();
      overlays.splice(index, 1, ...halves(tl.overlays[index]));
      return { ...tl, overlays };
    }
  }
}

export function patchSubtitle(
  tl: Timeline,
  index: number,
  patch: Partial<TimelineSubtitleCue>,
): Timeline {
  const cue = tl.subtitles[index];
  if (!cue) return tl;
  const next = applyPatch(cue, patch);
  return next === cue ? tl : { ...tl, subtitles: replaceAt(tl.subtitles, index, next) };
}

export function patchOverlay(
  tl: Timeline,
  index: number,
  patch: Partial<TimelineHighlightCue>,
): Timeline {
  const cue = tl.overlays[index];
  if (!cue) return tl;
  const next = applyPatch(cue, patch);
  return next === cue ? tl : { ...tl, overlays: replaceAt(tl.overlays, index, next) };
}

export function patchHighlightPart(
  tl: Timeline,
  cueIndex: number,
  partIndex: number,
  patch: Partial<TimelineHighlightPart>,
): Timeline {
  const cue = tl.overlays[cueIndex];
  const part = cue?.parts[partIndex];
  if (!cue || !part) return tl;
  return patchOverlay(tl, cueIndex, {
    parts: replaceAt(cue.parts, partIndex, applyPatch(part, patch)),
  });
}

export function insertHighlightPart(
  tl: Timeline,
  cueIndex: number,
  afterIndex: number,
  text: string,
): Timeline {
  const cue = tl.overlays[cueIndex];
  if (!cue || !text) return tl;
  const parts = cue.parts.slice();
  parts.splice(Math.min(parts.length, Math.max(0, afterIndex + 1)), 0, { t: text });
  return patchOverlay(tl, cueIndex, { parts });
}

/** Bỏ một phần chữ - luôn còn ít nhất một phần (schema đòi parts ≥ 1). */
export function removeHighlightPart(tl: Timeline, cueIndex: number, partIndex: number): Timeline {
  const cue = tl.overlays[cueIndex];
  if (!cue || cue.parts.length <= 1 || !cue.parts[partIndex]) return tl;
  return patchOverlay(tl, cueIndex, { parts: cue.parts.filter((_, i) => i !== partIndex) });
}

export function patchCaptionWord(
  tl: Timeline,
  cueIndex: number,
  wordIndex: number,
  patch: Partial<TimelineCaptionWord>,
): Timeline {
  const cue = tl.captions[cueIndex];
  const word = cue?.words[wordIndex];
  if (!cue || !word) return tl;
  const next = applyPatch(word, patch);
  if (next === word) return tl;
  return {
    ...tl,
    captions: replaceAt(tl.captions, cueIndex, { ...cue, words: replaceAt(cue.words, wordIndex, next) }),
  };
}

/**
 * Chèn từ mới sau `afterIndex`: chiếm nửa sau khoảng thời gian của từ đứng
 * trước (từ đó co lại), nên karaoke không chồng chéo.
 */
export function insertCaptionWord(
  tl: Timeline,
  cueIndex: number,
  afterIndex: number,
  text: string,
): Timeline {
  const cue = tl.captions[cueIndex];
  if (!cue || !text) return tl;
  const words = cue.words.slice();
  const at = Math.min(words.length, Math.max(0, afterIndex + 1));
  const prev = words[at - 1];
  let start: number;
  let end: number;
  if (prev) {
    const mid = Math.round((prev.start + prev.end) / 2);
    start = mid;
    end = prev.end;
    words[at - 1] = { ...prev, end: mid };
  } else {
    start = cue.from;
    end = words[0] ? words[0].start : cueEnd(cue);
  }
  words.splice(at, 0, { text, start, end: Math.max(start, end) });
  return { ...tl, captions: replaceAt(tl.captions, cueIndex, { ...cue, words }) };
}

/** Bỏ một từ - luôn còn ít nhất một từ (schema đòi words ≥ 1). */
export function removeCaptionWord(tl: Timeline, cueIndex: number, wordIndex: number): Timeline {
  const cue = tl.captions[cueIndex];
  if (!cue || cue.words.length <= 1 || !cue.words[wordIndex]) return tl;
  return {
    ...tl,
    captions: replaceAt(tl.captions, cueIndex, {
      ...cue,
      words: cue.words.filter((_, i) => i !== wordIndex),
    }),
  };
}

export function setSubtitleStyle(
  tl: Timeline,
  patch: Partial<TimelineSubtitleStyle> | null,
): Timeline {
  if (patch === null) {
    if (tl.subtitleStyle === undefined) return tl;
    const next = { ...tl };
    delete next.subtitleStyle;
    return next;
  }
  const next = applyPatch(tl.subtitleStyle ?? {}, patch);
  return next === tl.subtitleStyle ? tl : { ...tl, subtitleStyle: next };
}

// ================================================================ chuẩn hóa

/**
 * Bản server trả về đã điền mặc định, nhưng meta.json do agent ghi tay có thể
 * còn khóa `null` (captions/subtitles/overlays/audio/subtitleStyle) hoặc audio
 * thiếu nhánh. Coi `null` là VẮNG MẶT - giống server chuẩn hóa trước khi render -
 * để mọi thao tác phía sau khỏi phải phòng thủ. Đã chuẩn thì trả lại chính nó.
 */
export function normalizeTimeline(tl: Timeline): Timeline {
  const raw: Partial<Record<keyof Timeline, unknown>> = tl;
  const audioRaw: unknown = raw.audio;
  const audio = audioRaw !== null && typeof audioRaw === "object" ? tl.audio : null;
  const ok =
    Array.isArray(raw.scenes) &&
    Array.isArray(raw.captions) &&
    Array.isArray(raw.subtitles) &&
    Array.isArray(raw.overlays) &&
    audio !== null &&
    Array.isArray(audio.sfx) &&
    audio.voice !== undefined &&
    audio.music !== undefined &&
    raw.subtitleStyle !== null;
  if (ok) return tl;
  const next: Timeline = {
    ...tl,
    scenes: Array.isArray(raw.scenes) ? tl.scenes : [],
    captions: Array.isArray(raw.captions) ? tl.captions : [],
    subtitles: Array.isArray(raw.subtitles) ? tl.subtitles : [],
    overlays: Array.isArray(raw.overlays) ? tl.overlays : [],
    audio: {
      ...(audio ?? {}),
      voice: audio?.voice ?? null,
      sfx: audio && Array.isArray(audio.sfx) ? audio.sfx : [],
      music: audio?.music ?? null,
    },
  };
  if (raw.subtitleStyle === null) delete next.subtitleStyle;
  return next;
}

// ================================================================ audio

export function moveSfx(tl: Timeline, index: number, delta: number): Timeline {
  const sfx = tl.audio.sfx[index];
  const d = Math.round(delta);
  if (!sfx || !Number.isFinite(d) || d === 0) return tl;
  const atFrame = Math.max(0, sfx.atFrame + d);
  if (atFrame === sfx.atFrame) return tl;
  return patchSfx(tl, index, { atFrame });
}

export function patchSfx(tl: Timeline, index: number, patch: Partial<TimelineSfx>): Timeline {
  const sfx = tl.audio.sfx[index];
  if (!sfx) return tl;
  const next = applyPatch(sfx, patch);
  if (next === sfx) return tl;
  return { ...tl, audio: { ...tl.audio, sfx: replaceAt(tl.audio.sfx, index, next) } };
}

export function patchMusic(tl: Timeline, patch: Partial<TimelineMusic>): Timeline {
  const music = tl.audio.music;
  if (!music) return tl;
  const next = applyPatch(music, patch);
  return next === music ? tl : { ...tl, audio: { ...tl.audio, music: next } };
}

// ================================================================ theo selection

/** Phần tử còn tồn tại trong timeline không (sau undo / AI sửa / xóa). */
export function selectionExists(tl: Timeline, sel: Selection | null): boolean {
  if (!sel) return false;
  switch (sel.kind) {
    case "scene":
      return sceneIndexById(tl, sel.id) >= 0;
    case "caption":
    case "subtitle":
    case "overlay":
      return sel.index >= 0 && sel.index < cueList(tl, CUE_KIND[sel.kind]).length;
    case "sfx":
      return sel.index >= 0 && sel.index < tl.audio.sfx.length;
    case "music":
      return tl.audio.music !== null;
    case "voice":
      return tl.audio.voice !== null;
  }
}

/** Xóa được không - scene cuối cùng và giọng đọc thì không (xem deleteSelection). */
export function canDelete(tl: Timeline, sel: Selection | null): boolean {
  if (!sel || !selectionExists(tl, sel)) return false;
  if (sel.kind === "scene") return tl.scenes.length > 1;
  return sel.kind !== "voice";
}

/**
 * Xóa phần tử đang chọn. Không xóa scene CUỐI CÙNG (composition cần ≥ 1 scene,
 * trình phát sẽ hỏng) và không xóa giọng đọc (xương sống đồng bộ - đổi giọng là
 * việc của AI/luồng TTS, không phải một phím Delete).
 */
export function deleteSelection(tl: Timeline, sel: Selection | null): Timeline {
  if (!sel || !canDelete(tl, sel)) return tl;
  switch (sel.kind) {
    case "scene":
      return { ...tl, scenes: tl.scenes.filter((s) => s.id !== sel.id) };
    case "caption":
      return { ...tl, captions: tl.captions.filter((_, i) => i !== sel.index) };
    case "subtitle":
      return { ...tl, subtitles: tl.subtitles.filter((_, i) => i !== sel.index) };
    case "overlay":
      return { ...tl, overlays: tl.overlays.filter((_, i) => i !== sel.index) };
    case "sfx":
      return { ...tl, audio: { ...tl.audio, sfx: tl.audio.sfx.filter((_, i) => i !== sel.index) } };
    case "music":
      return { ...tl, audio: { ...tl.audio, music: null } };
    case "voice":
      return tl;
  }
}

export function canDuplicate(tl: Timeline, sel: Selection | null): boolean {
  if (!sel || !selectionExists(tl, sel)) return false;
  return sel.kind !== "music" && sel.kind !== "voice";
}

/**
 * Nhân bản phần tử đang chọn, trả về timeline mới + selection trỏ vào bản sao.
 * Scene: chèn ngay sau, id mới. Cue: đặt nối ngay sau cue gốc (karaoke dời từ
 * theo). Sfx: lùi 1 giây.
 */
export function duplicateSelection(
  tl: Timeline,
  sel: Selection | null,
  fps: number,
): { timeline: Timeline; selection: Selection | null } {
  if (!sel || !canDuplicate(tl, sel)) return { timeline: tl, selection: sel };
  switch (sel.kind) {
    case "scene": {
      const index = sceneIndexById(tl, sel.id);
      const copy: TimelineScene = {
        ...structuredClone(tl.scenes[index]),
        id: uniqueSceneId(tl.scenes, sel.id),
      };
      const scenes = tl.scenes.slice();
      scenes.splice(index + 1, 0, copy);
      return { timeline: { ...tl, scenes }, selection: { kind: "scene", id: copy.id } };
    }
    case "caption": {
      const cue = tl.captions[sel.index];
      const copy = shiftWords(
        { ...structuredClone(cue), from: cueEnd(cue) },
        cue.durationInFrames,
      );
      const captions = tl.captions.slice();
      captions.splice(sel.index + 1, 0, copy);
      return { timeline: { ...tl, captions }, selection: { kind: "caption", index: sel.index + 1 } };
    }
    case "subtitle": {
      const cue = tl.subtitles[sel.index];
      const subtitles = tl.subtitles.slice();
      subtitles.splice(sel.index + 1, 0, { ...structuredClone(cue), from: cueEnd(cue) });
      return {
        timeline: { ...tl, subtitles },
        selection: { kind: "subtitle", index: sel.index + 1 },
      };
    }
    case "overlay": {
      const cue = tl.overlays[sel.index];
      const overlays = tl.overlays.slice();
      overlays.splice(sel.index + 1, 0, { ...structuredClone(cue), from: cueEnd(cue) });
      return { timeline: { ...tl, overlays }, selection: { kind: "overlay", index: sel.index + 1 } };
    }
    case "sfx": {
      const sfx = tl.audio.sfx[sel.index];
      const list = tl.audio.sfx.slice();
      list.splice(sel.index + 1, 0, {
        ...structuredClone(sfx),
        atFrame: sfx.atFrame + Math.max(1, Math.round(fps)),
      });
      return {
        timeline: { ...tl, audio: { ...tl.audio, sfx: list } },
        selection: { kind: "sfx", index: sel.index + 1 },
      };
    }
    default:
      return { timeline: tl, selection: sel };
  }
}

/**
 * Tách tại playhead: phần tử đang chọn nếu nó nằm dưới playhead, không thì
 * scene đang phát. Trả `null` khi không có gì tách được.
 */
export function splitAtPlayhead(
  tl: Timeline,
  sel: Selection | null,
  frame: number,
  spans: { id: string; start: number; end: number }[],
  ctx: OpsContext,
): { timeline: Timeline; selection: Selection | null } | null {
  if (sel && isCueSel(sel.kind) && "index" in sel) {
    const next = splitCueAt(tl, CUE_KIND[sel.kind], sel.index, frame);
    if (next !== tl) return { timeline: next, selection: sel };
  }
  // Scene: ưu tiên scene đang chọn nếu playhead nằm trong nó, không thì scene
  // trên cùng tại playhead (chỗ chồng lấn thì scene sau nằm trên)
  const under = spans.filter((s) => frame > s.start && frame < s.end);
  const chosen =
    (sel?.kind === "scene" ? under.find((s) => s.id === sel.id) : undefined) ??
    under[under.length - 1];
  if (!chosen) return null;
  const index = sceneIndexById(tl, chosen.id);
  const newId = uniqueSceneId(tl.scenes, chosen.id);
  const next = splitSceneAt(tl, index, frame - chosen.start, newId, ctx);
  if (next === tl) return null;
  return { timeline: next, selection: { kind: "scene", id: chosen.id } };
}
