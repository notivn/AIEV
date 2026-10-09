/**
 * Store của trình chỉnh sửa - một reducer THUẦN (dùng với useReducer).
 *
 * Giữ: timeline đang sửa, phần tử chọn, lịch sử hoàn tác (gộp thao tác liên
 * tục), và trạng thái đồng bộ với server (version, đang lưu, lỗi, xung đột).
 *
 * Không giữ playhead: frame hiện tại đổi 30-60 lần/giây lúc phát, đưa vào đây
 * là cả editor render lại theo từng frame (xem playback.ts).
 *
 * "Bẩn" = `timeline !== savedTimeline` (so IDENTITY, không so nội dung):
 * `savedTimeline` là đúng object đang nằm trên server ở `version` - nạp từ
 * server hoặc vừa gửi lên thành công. Hoàn tác về đúng bản đã lưu thì lấy lại
 * CHÍNH object đó từ `past` → hết bẩn, không lưu thừa (trước đây đếm revision
 * nên hoàn tác về bản đã lưu vẫn "Chưa lưu", và nếu bản đó lỗi validate thì
 * chặn luôn chat/render). Người dùng sửa tiếp trong lúc đang lưu thì vẫn bẩn và
 * lượt lưu kế dùng version mới.
 *
 * `revision` vẫn tăng theo mọi thay đổi cục bộ - chỉ để biết "đã sửa gì kể từ
 * lúc X chưa" (lượt lưu lỗi thì đợi sửa tiếp mới thử lại, banner render cũ).
 */

import type { Timeline, TimelineIssue, TimelinePatch, TimelineSaved } from "@/lib/api";
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
  /**
   * Object timeline đang nằm trên server ở `version` (so identity để biết bẩn).
   * null = không có bản nào được coi là đã lưu - "Giữ bản của tôi" đặt null để
   * lượt lưu kế CHẮC CHẮN chạy và gửi đủ mọi khóa.
   */
  savedTimeline: Timeline | null;
  /**
   * Lượt lưu kế là lượt GHI ĐÈ sau "Giữ bản của tôi" - một lần rồi thôi. Lượt đó
   * mang nhãn lịch sử riêng để server không gộp nó vào snapshot tự lưu trước
   * (bản của tab/AI kia phải còn trong lịch sử).
   */
  overwrite: boolean;
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
  /** `timeline` = đúng object đã gửi lên (thành `savedTimeline`) */
  | { type: "saveOk"; revision: number; version: string; timeline: Timeline }
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
  savedTimeline: null,
  overwrite: false,
  savingRevision: null,
  problem: null,
};

export const isDirty = (s: EditorState): boolean =>
  s.timeline !== null && s.timeline !== s.savedTimeline;

/**
 * Sau hoàn tác/sửa mà timeline quay về ĐÚNG bản đã lưu: lỗi lưu cũ (dữ liệu
 * lỗi, lỗi mạng, bị khóa) không còn gì để nói - bản trên server vẫn nguyên. Giữ
 * lại thì nhãn kẹt "Dữ liệu lỗi" và banner trỏ vào thứ đã không còn. Xung đột
 * thì KHÔNG tự bỏ: người dùng phải chọn (lần tải lại kế sẽ tự nạp bản mới vì
 * hết bẩn).
 */
function settle(s: EditorState): EditorState {
  if (s.problem && s.problem.kind !== "conflict" && !isDirty(s)) return { ...s, problem: null };
  return s;
}

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
        savedTimeline: action.timeline,
        overwrite: false,
        problem: null,
      };
    }

    case "edit": {
      const current = state.timeline;
      if (!current) return state;
      let next: Timeline;
      try {
        next = action.apply(current);
      } catch (err) {
        // Lưới an toàn: một op gặp dữ liệu lạ (AI ghi meta.json sai kiểu) mà ném
        // lỗi thì reducer ném theo GIỮA LÚC RENDER → sập cả trang. Bỏ thao tác
        // đó, giữ nguyên trạng thái.
        console.error("[editor] thao tác sửa lỗi, bỏ qua:", err);
        return state;
      }
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
      return settle({
        ...state,
        timeline: next,
        selection,
        past,
        future: [],
        coalesce: c ? { key: c.key, at: action.now, windowMs: c.windowMs } : null,
        revision: state.revision + 1,
      });
    }

    case "undo": {
      const prev = state.past[state.past.length - 1];
      if (!prev || !state.timeline) return state;
      return settle({
        ...state,
        timeline: prev.timeline,
        selection: keepSelection(prev.timeline, prev.selection),
        past: state.past.slice(0, -1),
        future: [{ timeline: state.timeline, selection: state.selection }, ...state.future],
        coalesce: null,
        revision: state.revision + 1,
      });
    }

    case "redo": {
      const next = state.future[0];
      if (!next || !state.timeline) return state;
      return settle({
        ...state,
        timeline: next.timeline,
        selection: keepSelection(next.timeline, next.selection),
        past: [...state.past, { timeline: state.timeline, selection: state.selection }],
        future: state.future.slice(1),
        coalesce: null,
        revision: state.revision + 1,
      });
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
        savedTimeline: action.timeline,
        overwrite: false,
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
      // người kia vẫn khôi phục được - với điều kiện server KHÔNG gộp nó vào
      // snapshot tự lưu ngay trước, nên lượt này mang cờ `overwrite` (nhãn riêng).
      if (state.problem?.kind !== "conflict") return state;
      return {
        ...state,
        version: state.problem.current.version,
        problem: null,
        // Bản trên server giờ là của người kia: không object nào của mình là "đã
        // lưu" nữa → bẩn chắc chắn (kể cả khi bản cục bộ trùng bản mình vừa lưu,
        // vd xung đột phát hiện lúc tải lại ngay sau khi lưu) và gửi đủ mọi khóa
        savedTimeline: null,
        overwrite: true,
        revision: state.revision + 1,
      };
    }

    case "clearProblem":
      return state.problem ? { ...state, problem: null } : state;
  }
}

// ================================================================ lưu: khóa đã đổi

/**
 * Body `timeline` của PUT: CHỈ các khóa top-level đã đổi so với bản đã lưu (so
 * identity - ops.ts giữ nguyên object của nhánh không đổi). Server chỉ validate
 * khóa được gửi, nên một khóa lỗi do AI ghi (vd `captions` sai kiểu) mà người
 * dùng không đụng tới sẽ KHÔNG chặn mọi lần lưu sửa scene/sfx. `saved` null
 * (chưa biết bản trên server, hoặc "Giữ bản của tôi") = gửi đủ cả 6 khóa.
 * subtitleStyle vắng mặt phải gửi `null` (PUT giữ nguyên khóa không gửi).
 */
export function changedKeysPatch(tl: Timeline, saved: Timeline | null): TimelinePatch {
  const patch: TimelinePatch = {};
  if (!saved || tl.scenes !== saved.scenes) patch.scenes = tl.scenes;
  if (!saved || tl.audio !== saved.audio) patch.audio = tl.audio;
  if (!saved || tl.captions !== saved.captions) patch.captions = tl.captions;
  if (!saved || tl.subtitles !== saved.subtitles) patch.subtitles = tl.subtitles;
  if (!saved || tl.overlays !== saved.overlays) patch.overlays = tl.overlays;
  if (!saved || tl.subtitleStyle !== saved.subtitleStyle) patch.subtitleStyle = tl.subtitleStyle ?? null;
  return patch;
}

// ================================================================ kéo trên timeline

/**
 * Một lượt kéo khối: mỗi khung kéo tính lại từ `origin` (timeline lúc bấm
 * chuột) rồi THAY timeline hiện tại. Thay chỉ đúng khi timeline hiện tại vẫn là
 * `origin` hoặc một bản do chính lượt kéo đẩy vào (`produced` - là TẬP chứ không
 * chỉ bản cuối: render có thể trễ hơn khung kéo kế tiếp). Thứ khác chen vào giữa
 * lượt kéo (nút "+", AI ghi file → tải lại) thì thay là xóa mất nó.
 */
export interface DragSession {
  origin: Timeline;
  produced: WeakSet<Timeline>;
}

export const dragOwns = (drag: DragSession, tl: Timeline): boolean =>
  tl === drag.origin || drag.produced.has(tl);

/**
 * Hàm sửa cho một khung kéo: store còn giữ bản của lượt kéo thì thay bằng
 * `next`, không thì để nguyên (nơi gọi sẽ dừng lượt kéo ở khung sau). Thuần với
 * cùng đầu vào - reducer có chạy hai lần (StrictMode) cũng ra một kết quả.
 */
export function dragStep(drag: DragSession, next: Timeline): (tl: Timeline) => Timeline {
  drag.produced.add(next);
  return (tl) => (dragOwns(drag, tl) ? next : tl);
}
