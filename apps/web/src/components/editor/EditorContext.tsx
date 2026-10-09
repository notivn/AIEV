"use client";

/**
 * Ngữ cảnh dùng chung của trình chỉnh sửa: timeline/inspector/thanh phát đọc
 * cùng một bộ hành động thay vì truyền prop qua ba tầng.
 *
 * `edit` là cửa DUY NHẤT để sửa timeline - nhận một hàm thuần của ops.ts. Chế độ
 * chỉ đọc (AI đang sửa project) chặn ở đây, nên không chỗ gọi nào phải tự nhớ kiểm.
 */

import { createContext, useContext } from "react";
import type { Timeline } from "@/lib/api";
import type { OpsContext, Selection } from "./ops";
import type { PlaybackStore } from "./playback";

export interface EditOptions {
  /** Gộp các lần sửa liên tiếp cùng key thành MỘT bước hoàn tác */
  coalesce?: string;
  /** Cửa sổ gộp (ms). null = gộp suốt (kéo chuột - kết thúc bằng endCoalesce) */
  windowMs?: number | null;
  /** Đổi selection cùng lúc. Bỏ trống = giữ */
  selection?: Selection | null;
}

export interface EditorApi {
  fps: number;
  /** Khung dọc (cao > rộng) - vài mặc định của engine phụ thuộc hướng khung */
  vertical: boolean;
  ops: OpsContext;
  readOnly: boolean;
  selection: Selection | null;
  edit: (apply: (timeline: Timeline) => Timeline, options?: EditOptions) => void;
  select: (selection: Selection | null) => void;
  /** Kết thúc lượt kéo/gõ - thao tác sau là một bước hoàn tác mới */
  endCoalesce: () => void;
  /** Tua tới frame (kẹp trong composition) */
  seek: (frame: number) => void;
  playback: PlaybackStore;
}

export const EditorContext = createContext<EditorApi | null>(null);

export function useEditor(): EditorApi {
  const api = useContext(EditorContext);
  if (!api) throw new Error("useEditor phải nằm trong <EditorContext.Provider>");
  return api;
}
