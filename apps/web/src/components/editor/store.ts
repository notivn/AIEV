/**
 * Store của trình chỉnh sửa - một reducer THUẦN (dùng với useReducer).
 *
 * Giữ: timeline đang sửa, phần tử chọn, lịch sử hoàn tác (gộp thao tác liên
 * tục), và trạng thái đồng bộ với server (version, đang lưu, lỗi, xung đột).
 *
 * Không giữ playhead: frame hiện tại đổi 30-60 lần/giây lúc phát, đưa vào đây
 * là cả editor render lại theo từng frame (xem playback.ts).
 *
 * "Bẩn" = `revision !== savedRevision`: mỗi thay đổi cục bộ tăng `revision`,
 * lưu xong thì `savedRevision` bắt kịp đúng revision đã gửi. Người dùng sửa
 * tiếp trong lúc đang lưu thì vẫn bẩn và lượt lưu kế dùng version mới.
 */

import type { Timeline, TimelineIssue, TimelineSaved } from "@/lib/api";
import { sameSelection, selectionExists, type Selection } from "./ops";

/** Gộp các lần gõ liên tiếp cùng một ô trong khoảng này thành MỘT bước hoàn tác. */
export const TYPING_COALESCE_MS = 1000;
const HISTORY_LIMIT = 200;

interface HistoryEntry {
  timeline: Timeline;
  selection: Selection | null;
}

export type SaveProblem =
  | { kind: "error"; message: string }
  | { kind: "conflict"; current: TimelineSaved }
  | { kind: "invalid"; issues: TimelineIssue[]; message: string }
  | { kind: "locked"; message: string };

export interface EditorState {
  timeline: Timeline | null;
  /** Version server của bản đã lưu gần nhất = baseVersion của lượt lưu kế */
  version: string | null;
  selection: Selection | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Thao tác đang được gộp (kéo liên tục / gõ cùng ô) */
  coalesce: { key: string; at: number; windowMs: number | null } | null;
  revision: number;
  savedRevision: number;
  /** Revision đang được gửi lên; null = không lưu */
  savingRevision: number | null;
  /** Lỗi của lượt lưu gần nhất, kèm revision gặp lỗi (sửa tiếp thì thử lại) */
  problem: (SaveProblem & { revision: number }) | null;
}

export type EditorAction =
  | { type: "loaded"; version: string; timeline: Timeline }
  | {
      type: "edit";
      apply: (timeline: Timeline) => Timeline;
      /** Gộp vào bước trước nếu cùng key (kéo: windowMs null = gộp suốt lượt kéo) */
      coalesce?: { key: string; windowMs: number | null };
      /** Đổi selection cùng lúc (vd chọn bản nhân bản). undefined = giữ */
      selection?: Selection | null;
      now: number;
    }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; selection: Selection | null }
  /** Kết thúc một lượt kéo/gõ: thao tác sau sẽ thành bước hoàn tác mới */
  | { type: "endCoalesce" }
  | { type: "saveStart"; revision: number }
  | { type: "saveOk"; revision: number; version: string }
  | { type: "saveFailed"; revision: number; problem: SaveProblem }
  /** Xung đột phát hiện khi tải lại (AI sửa trong lúc mình còn bản chưa lưu) */
  | { type: "conflict"; current: TimelineSaved }
  | { type: "keepMine" }
  | { type: "clearProblem" };

export const initialEditorState: EditorState = {
  timeline: null,
  version: null,
  selection: null,
  past: [],
  future: [],
  coalesce: null,
  revision: 0,
  savedRevision: 0,
  savingRevision: null,
  problem: null,
};

export const isDirty = (s: EditorState): boolean => s.revision !== s.savedRevision;

const keepSelection = (timeline: Timeline, sel: Selection | null): Selection | null =>
  sel && selectionExists(timeline, sel) ? sel : null;

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "loaded": {
      // Bản từ server (tải trang, AI sửa xong, "Tải bản mới"): mốc mới, lịch sử
      // cũ không còn áp được lên nó nên bỏ.
      return {
        ...state,
        timeline: action.timeline,
        version: action.version,
        selection: keepSelection(action.timeline, state.selection),
        past: [],
        future: [],
        coalesce: null,
        savedRevision: state.revision,
        problem: null,
      };
    }

    case "edit": {
      const current = state.timeline;
      if (!current) return state;
      const next = action.apply(current);
      const selection =
        action.selection === undefined
          ? keepSelection(next, state.selection)
          : action.selection;
      if (next === current) {
        return sameSelection(selection, state.selection) ? state : { ...state, selection };
      }
      const c = action.coalesce;
      const merge =
        c !== undefined &&
        state.coalesce !== null &&
        state.coalesce.key === c.key &&
        (c.windowMs === null || action.now - state.coalesce.at <= c.windowMs);
      const past = merge
        ? state.past
        : [...state.past, { timeline: current, selection: state.selection }].slice(-HISTORY_LIMIT);
      return {
        ...state,
        timeline: next,
        selection,
        past,
        future: [],
        coalesce: c ? { key: c.key, at: action.now, windowMs: c.windowMs } : null,
        revision: state.revision + 1,
      };
    }

    case "undo": {
      const prev = state.past[state.past.length - 1];
      if (!prev || !state.timeline) return state;
      return {
        ...state,
        timeline: prev.timeline,
        selection: keepSelection(prev.timeline, prev.selection),
        past: state.past.slice(0, -1),
        future: [{ timeline: state.timeline, selection: state.selection }, ...state.future],
        coalesce: null,
        revision: state.revision + 1,
      };
    }

    case "redo": {
      const next = state.future[0];
      if (!next || !state.timeline) return state;
      return {
        ...state,
        timeline: next.timeline,
        selection: keepSelection(next.timeline, next.selection),
        past: [...state.past, { timeline: state.timeline, selection: state.selection }],
        future: state.future.slice(1),
        coalesce: null,
        revision: state.revision + 1,
      };
    }

    case "select":
      return sameSelection(action.selection, state.selection)
        ? state
        : { ...state, selection: action.selection, coalesce: null };

    case "endCoalesce":
      return state.coalesce ? { ...state, coalesce: null } : state;

    case "saveStart":
      return { ...state, savingRevision: action.revision };

    case "saveOk":
      return {
        ...state,
        version: action.version,
        savedRevision: Math.max(state.savedRevision, action.revision),
        savingRevision: null,
        problem: null,
      };

    case "saveFailed":
      return {
        ...state,
        savingRevision: null,
        problem: { ...action.problem, revision: action.revision },
      };

    case "conflict":
      return {
        ...state,
        savingRevision: null,
        problem: { kind: "conflict", current: action.current, revision: state.revision },
      };

    case "keepMine": {
      // Giữ bản của mình: lấy version hiện tại của server làm gốc, lượt lưu kế
      // ghi đè lên đó. Lượt lưu đó tạo snapshot lịch sử (server) nên bản của
      // người kia vẫn khôi phục được.
      if (state.problem?.kind !== "conflict") return state;
      return {
        ...state,
        version: state.problem.current.version,
        problem: null,
        // Bản cục bộ có thể TRÙNG revision đã lưu (vd xung đột phát hiện lúc tải lại
        // ngay sau khi lưu) - tăng revision để tự lưu chắc chắn chạy
        revision: state.revision + 1,
      };
    }

    case "clearProblem":
      return state.problem ? { ...state, problem: null } : state;
  }
}
