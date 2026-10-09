/**
 * Kiểu dữ liệu của trình chỉnh sửa video - khớp response
 * `GET /api/projects/:id/timeline` (docs/EDITOR-PLAN.md mục 2.2).
 *
 * Phần tử con (scene, cue, sfx…) lấy thẳng KIỂU ĐẦU VÀO (`z.input`) của schema
 * zod bên engine (engines/remotion/src/manifest.ts): đó là hình dạng của
 * meta.json TRƯỚC khi parse - field có default (srcImage, sfx, music…) được
 * phép thiếu, và field lạ do agent ghi thêm vẫn nằm trong kiểu (looseObject),
 * nên editor sửa trên bản sao là giữ nguyên được chúng (mục 1 của plan).
 *
 * Mọi đường dẫn media trong timeline là TƯƠNG ĐỐI THƯ MỤC PROJECT
 * (`assets/x.mp4`, `renders/s1.mp4`) - không phải `staging/...` như
 * props.resolved.json của render.
 */

import type { z } from "zod";
import type {
  captionCueSchema,
  captionWordSchema,
  highlightCueSchema,
  highlightPartSchema,
  musicSchema,
  sceneSchema,
  sfxSchema,
  subtitleCueSchema,
  subtitleStyleSchema,
  zoomSchema,
} from "@engine/manifest";

export type EditorScene = z.input<typeof sceneSchema>;
export type EditorZoom = z.input<typeof zoomSchema>;
export type EditorSfx = z.input<typeof sfxSchema>;
export type EditorMusic = z.input<typeof musicSchema>;
export type EditorCaptionWord = z.input<typeof captionWordSchema>;
export type EditorCaptionCue = z.input<typeof captionCueSchema>;
export type EditorSubtitleCue = z.input<typeof subtitleCueSchema>;
export type EditorSubtitleStyle = z.input<typeof subtitleStyleSchema>;
export type EditorHighlightPart = z.input<typeof highlightPartSchema>;
export type EditorHighlightCue = z.input<typeof highlightCueSchema>;

/** `audio` của meta.json - server điền mặc định `{ voice: null, sfx: [], music: null }` */
export interface EditorAudio {
  voice: string | null;
  sfx: EditorSfx[];
  music: EditorMusic | null;
  /** field lạ trong audio - giữ nguyên khi ghi lại */
  [key: string]: unknown;
}

/** Các khóa top-level của meta.json mà editor được ghi (plan mục 1). */
export interface EditorTimeline {
  /** Thứ tự = thứ tự phát; `from`/`to` là GIÂY trong file nguồn */
  scenes: EditorScene[];
  audio: EditorAudio;
  /** FRAME tuyệt đối (cả `words[].start/end`) */
  captions: EditorCaptionCue[];
  /** FRAME tuyệt đối */
  subtitles: EditorSubtitleCue[];
  /** Tùy chọn - thiếu (hoặc null) = kiểu mặc định giống CaptionTrack */
  subtitleStyle?: EditorSubtitleStyle | null;
  /** Thẻ highlight - FRAME tuyệt đối */
  overlays: EditorHighlightCue[];
}

/** `project` trong response GET /timeline. */
export interface EditorProjectInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  status: string;
  /** ISO; null khi meta.json chưa từng ghi mốc này */
  updatedAt: string | null;
}

/** Thời lượng/kích thước thật của một file media (ffprobe, cache theo mtime). */
export interface EditorMediaInfo {
  durationSec: number | null;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

/** `preview` trong response GET /timeline - dữ liệu chỉ dùng để XEM TRƯỚC. */
export interface EditorPreview {
  /**
   * File MP4 xem trước (tương đối project) cho scene HyperFrames, theo id
   * scene: ưu tiên renders/<id>.mp4 (final) rồi .draft.mp4; null = chưa render.
   */
  sceneRenders: Record<string, string | null>;
  /** Logo đóng góc của Style Design - giống jobs/assemble.ts (syncBrandLogo) */
  watermark: null | { file: string; position: "top-left" };
  /** Theo relPath của mọi file media mà timeline tham chiếu */
  media: Record<string, EditorMediaInfo>;
}
