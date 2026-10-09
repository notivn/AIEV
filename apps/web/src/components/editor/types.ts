/**
 * Kiểu dữ liệu của trình chỉnh sửa video - BÍ DANH của họ `Timeline*` trong
 * `@/lib/api` (khớp response `GET /api/projects/:id/timeline`, docs/EDITOR-PLAN.md
 * mục 2.2).
 *
 * Chỉ có MỘT bộ kiểu: store của editor giữ đúng thứ `getTimeline` trả về và đưa
 * thẳng vào <PreviewPlayer> - không ép kiểu, không chuyển đổi qua lại. Trước đây
 * file này dựng bộ thứ hai từ `z.input` của zod bên engine; hai bộ lệch nhau ở
 * vài chỗ (srcImage, subtitleStyle null) là đủ để mỗi lần truyền dữ liệu phải
 * cast. Hình dạng thật vẫn bám schema ở engines/remotion/src/manifest.ts - và
 * PreviewPlayer luôn chạy `manifestSchema.safeParse` trước khi phát, nên chỗ
 * nào lệch thì hiện thành lỗi chứ không lọt qua.
 *
 * Mọi object đều mở `[key: string]: unknown`: field lạ do agent ghi thêm vẫn
 * nằm trong kiểu, nên editor sửa trên bản sao là giữ nguyên được chúng.
 *
 * Mọi đường dẫn media trong timeline là TƯƠNG ĐỐI THƯ MỤC PROJECT
 * (`assets/x.mp4`, `renders/s1.mp4`) - không phải `staging/...` như
 * props.resolved.json của render.
 */

import type {
  Timeline,
  TimelineAudio,
  TimelineCaptionCue,
  TimelineCaptionWord,
  TimelineHighlightCue,
  TimelineHighlightPart,
  TimelineMediaInfo,
  TimelineMusic,
  TimelinePreview,
  TimelineProject,
  TimelineScene,
  TimelineSfx,
  TimelineSubtitleCue,
  TimelineSubtitleStyle,
  TimelineZoom,
} from "@/lib/api";

export type EditorScene = TimelineScene;
export type EditorZoom = TimelineZoom;
export type EditorSfx = TimelineSfx;
export type EditorMusic = TimelineMusic;
export type EditorCaptionWord = TimelineCaptionWord;
export type EditorCaptionCue = TimelineCaptionCue;
export type EditorSubtitleCue = TimelineSubtitleCue;
export type EditorSubtitleStyle = TimelineSubtitleStyle;
export type EditorHighlightPart = TimelineHighlightPart;
export type EditorHighlightCue = TimelineHighlightCue;
export type EditorAudio = TimelineAudio;
/** Các khóa top-level của meta.json mà editor được ghi (plan mục 1). */
export type EditorTimeline = Timeline;
/** `project` trong response GET /timeline. */
export type EditorProjectInfo = TimelineProject;
/** Thời lượng/kích thước thật của một file media (ffprobe, cache theo mtime). */
export type EditorMediaInfo = TimelineMediaInfo;
/** `preview` trong response GET /timeline - dữ liệu chỉ dùng để XEM TRƯỚC. */
export type EditorPreview = TimelinePreview;
