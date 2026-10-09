"use client";

/**
 * Timeline nhiều track: thước giờ, playhead, khối scene/cue/sfx, kéo-thả.
 *
 * Mọi tương tác con trỏ đi qua MỘT bộ xử lý trên khung cuộn (ủy quyền theo
 * `data-*`), có pointer capture trên chính khung đó - khung không bao giờ
 * unmount giữa lượt kéo, còn khối thì có thể render lại theo từng frame.
 *
 * Kéo luôn tính từ timeline LÚC BẤM CHUỘT (origin) + tổng độ dời, không cộng
 * dồn từng bước: kẹp và làm tròn không tích lũy sai số, và cả lượt kéo gộp
 * thành MỘT bước hoàn tác (coalesce key riêng cho từng lượt). Cập nhật đẩy vào
 * store tối đa một lần mỗi khung hình (requestAnimationFrame) để trình phát
 * không phải dựng lại composition nhiều hơn số khung màn hình vẽ được.
 */

import {
  AudioLines,
  Captions,
  Film,
  Highlighter,
  Image as ImageIcon,
  Maximize2,
  Mic,
  Music,
  Plus,
  Sparkles,
  Subtitles,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { IconButton } from "@/components/IconButton";
import type { Timeline, TimelinePreview } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useEditor } from "./EditorContext";
import {
  acceptedTracks,
  readDragData,
  type DropTarget,
  type DropTrack,
  type LibraryItem,
} from "./library";
import {
  CUE_KIND,
  isCueSel,
  moveCue,
  moveSfx,
  reorderScene,
  resizeCue,
  sceneInsertIndexAt,
  sceneKind,
  sceneSourcePath,
  trimScene,
  type Selection,
} from "./ops";
import { usePlayheadFrame } from "./playback";
import {
  clampPps,
  contentEndFrame,
  formatRulerLabel,
  formatTimecode,
  frameToPx,
  pxToFrame,
  rulerStep,
  ZOOM_MAX_PPS,
  ZOOM_MIN_PPS,
  type SceneSpan,
} from "./timing";

const LABEL_W = 136;
/** Đi được bao xa (px) thì mới coi là kéo - nhỏ hơn là một cú bấm chọn */
const DRAG_THRESHOLD = 3;
/** Khoảng hít (px trên màn hình, không phải frame - zoom nào cũng như nhau) */
const SNAP_PX = 8;
/** Vùng sát mép khung cuộn tự cuộn theo khi kéo */
const EDGE_SCROLL_PX = 32;

type TrackKey = "scene" | "overlay" | "caption" | "subtitle" | "sfx" | "voice" | "music";

/** Track có nút "+" thêm cue tại playhead. */
export type AddCueKind = "overlay" | "caption" | "subtitle";

type DragMode = "move" | "trim-start" | "trim-end" | "reorder" | "scrub";

interface DragState {
  pointerId: number;
  mode: DragMode;
  target: Selection | null;
  startX: number;
  startScroll: number;
  origin: Timeline;
  started: boolean;
  key: string;
  /** Mép của phần tử lúc bấm (frame) - dùng để hít */
  edges: number[];
  candidates: number[];
  sceneIndex: number;
}

interface DragView {
  target: Selection | null;
  mode: DragMode;
  snapAt: number | null;
  dropIndex: number | null;
  offsetPx: number;
}

const baseName = (path: string | null | undefined): string =>
  path ? (path.split(/[\\/]/).pop() ?? path) : "";

/** pps (px/giây) ↔ vị trí thanh trượt 0..100 theo thang log - zoom đều tay. */
const ppsToSlider = (pps: number): number =>
  Math.round(
    (Math.log(pps / ZOOM_MIN_PPS) / Math.log(ZOOM_MAX_PPS / ZOOM_MIN_PPS)) * 100,
  );
const sliderToPps = (v: number): number =>
  ZOOM_MIN_PPS * Math.pow(ZOOM_MAX_PPS / ZOOM_MIN_PPS, v / 100);

function encodeSel(sel: Selection): Record<string, string> {
  if (sel.kind === "scene") return { "data-kind": "scene", "data-id": sel.id };
  if ("index" in sel) return { "data-kind": sel.kind, "data-index": String(sel.index) };
  return { "data-kind": sel.kind };
}

function decodeSel(el: Element): Selection | null {
  const kind = el.getAttribute("data-kind");
  const index = Number(el.getAttribute("data-index"));
  switch (kind) {
    case "scene": {
      const id = el.getAttribute("data-id");
      return id ? { kind: "scene", id } : null;
    }
    case "caption":
    case "subtitle":
    case "overlay":
    case "sfx":
      return Number.isInteger(index) ? { kind, index } : null;
    case "music":
    case "voice":
      return { kind };
    default:
      return null;
  }
}

const selKey = (sel: Selection | null): string =>
  !sel ? "" : sel.kind === "scene" ? `scene:${sel.id}` : "index" in sel ? `${sel.kind}:${sel.index}` : sel.kind;

export function TimelinePanel({
  timeline,
  spans,
  totalFrames,
  preview,
  height,
  onLibraryDrop,
  onAddCue,
}: {
  timeline: Timeline;
  spans: SceneSpan[];
  totalFrames: number;
  preview: TimelinePreview;
  /** Chiều cao khung (px) - do tay nắm kéo của trang quyết định */
  height: number;
  /** Thả một món từ cột Thư viện lên timeline (trang lo chép file + sửa) */
  onLibraryDrop: (item: LibraryItem, target: DropTarget) => void;
  /** Nút "+" ở nhãn track: thêm cue tại playhead */
  onAddCue: (kind: AddCueKind) => void;
}) {
  const { t, tf } = useT();
  const editor = useEditor();
  const { fps, readOnly, selection, playback } = editor;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pps, setPps] = useState(60);
  /** true tới khi người dùng tự zoom - trước đó timeline luôn vừa khít bề ngang */
  const autoFitRef = useRef(true);
  const [viewport, setViewport] = useState({ left: 0, width: 800 });
  const [dragView, setDragView] = useState<DragView | null>(null);
  /** Món thư viện đang được kéo ngang timeline - track sẽ nhận + vị trí */
  const [libDrop, setLibDrop] = useState<DropTarget | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);
  const dragCounter = useRef(0);
  /** Giữ khung nhìn sau khi zoom: frame dưới con trỏ đứng yên */
  const zoomAnchorRef = useRef<{ frame: number; offset: number } | null>(null);

  const endFrame = Math.max(totalFrames, contentEndFrame(timeline, spans));
  const laneWidth = frameToPx(endFrame, pps, fps) + 160;
  const contentWidth = LABEL_W + laneWidth;
  const x = useCallback((frame: number) => frameToPx(frame, pps, fps), [pps, fps]);

  // ---- vừa khít lần đầu: cả video lọt vào bề ngang khung
  // Độ dài đọc qua ref: `fit` giữ identity ổn định, nên trim làm video dài/ngắn
  // đi KHÔNG kéo theo zoom lại giữa lúc đang kéo chuột
  const totalRef = useRef(totalFrames);
  totalRef.current = totalFrames;
  const fit = useCallback(() => {
    const el = scrollRef.current;
    if (!el || el.clientWidth <= 0) return;
    const usable = el.clientWidth - LABEL_W - 32;
    setPps(clampPps(usable / Math.max(1 / fps, totalRef.current / fps)));
    el.scrollLeft = 0;
  }, [fps]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setViewport({ left: el.scrollLeft, width: el.clientWidth });
      // Còn "tự vừa khung" (người dùng chưa tự zoom) thì khung đổi cỡ - panel
      // chat mở ra, kéo cửa sổ - là vừa lại theo bề ngang mới
      if (autoFitRef.current && el.clientWidth > 0) fit();
    };
    update();
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [fit]);

  // ---- Ctrl/Cmd + lăn chuột: zoom quanh con trỏ (listener thật, không passive -
  // React gắn wheel ở chế độ passive nên preventDefault ở đó vô tác dụng)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const offset = e.clientX - rect.left;
      autoFitRef.current = false;
      setPps((cur) => {
        const frame = pxToFrame(el.scrollLeft + offset - LABEL_W, cur, fps);
        zoomAnchorRef.current = { frame: Math.max(0, frame), offset };
        return clampPps(cur * Math.exp(-e.deltaY * 0.0025));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fps]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = zoomAnchorRef.current;
    if (!el || !anchor) return;
    zoomAnchorRef.current = null;
    el.scrollLeft = Math.max(0, LABEL_W + frameToPx(anchor.frame, pps, fps) - anchor.offset);
  }, [pps, fps]);

  const zoomBy = (factor: number) => {
    autoFitRef.current = false;
    const el = scrollRef.current;
    if (el) {
      // Nút zoom: neo quanh playhead nếu nó đang trong khung, không thì giữa khung
      const playX = LABEL_W + frameToPx(playback.getFrame(), pps, fps) - el.scrollLeft;
      const offset =
        playX > LABEL_W && playX < el.clientWidth ? playX : LABEL_W + (el.clientWidth - LABEL_W) / 2;
      zoomAnchorRef.current = {
        frame: Math.max(0, pxToFrame(el.scrollLeft + offset - LABEL_W, pps, fps)),
        offset,
      };
    }
    setPps((cur) => clampPps(cur * factor));
  };

  // ---- playhead luôn trong tầm nhìn (lúc phát và lúc tua bằng phím)
  useEffect(() => {
    return playback.subscribe(() => {
      const el = scrollRef.current;
      if (!el || dragRef.current) return;
      const px = LABEL_W + frameToPx(playback.getFrame(), pps, fps);
      const left = el.scrollLeft + LABEL_W;
      const right = el.scrollLeft + el.clientWidth - 24;
      if (px < left || px > right) {
        // Lật trang như NLE: playhead về gần mép trái, không bám giữa giật liên tục
        el.scrollLeft = Math.max(0, px - LABEL_W - 48);
      }
    });
  }, [playback, pps, fps]);

  // ---------------------------------------------------------------- kéo

  const flush = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    pending?.();
  }, []);

  const schedule = useCallback(
    (fn: () => void) => {
      pendingRef.current = fn;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        pending?.();
      });
    },
    [],
  );

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  /** Frame dưới con trỏ (trục timeline, không âm). */
  const frameAtClient = (clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, pxToFrame(clientX - rect.left + el.scrollLeft - LABEL_W, pps, fps));
  };

  /** Mọi mép có thể hít vào, trừ chính phần tử đang kéo. */
  const snapCandidates = (sel: Selection | null, mode: DragMode, sceneIndex: number): number[] => {
    const out = new Set<number>([0, playback.getFrame(), totalFrames]);
    spans.forEach((s) => {
      // Trim scene là "ripple": scene từ chỗ đó trở về sau dời theo nên không làm mốc
      if (sel?.kind === "scene" && mode !== "move" && s.index >= sceneIndex) return;
      out.add(s.start);
      out.add(s.end);
    });
    const addCues = (kind: "caption" | "subtitle" | "overlay") => {
      timeline[CUE_KIND[kind]].forEach((c, i) => {
        if (sel?.kind === kind && "index" in sel && sel.index === i) return;
        out.add(c.from);
        out.add(c.from + c.durationInFrames);
      });
    };
    addCues("caption");
    addCues("subtitle");
    addCues("overlay");
    timeline.audio.sfx.forEach((s, i) => {
      if (sel?.kind === "sfx" && sel.index === i) return;
      out.add(s.atFrame);
    });
    return [...out];
  };

  const snapDelta = (
    delta: number,
    edges: number[],
    candidates: number[],
    disabled: boolean,
  ): { delta: number; at: number | null } => {
    if (disabled || edges.length === 0) return { delta, at: null };
    const threshold = pxToFrame(SNAP_PX, pps, fps);
    let best: { d: number; at: number } | null = null;
    for (const edge of edges) {
      for (const c of candidates) {
        const d = c - (edge + delta);
        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: c };
      }
    }
    return best ? { delta: delta + best.d, at: best.at } : { delta, at: null };
  };

  /** Thao tác (thuần) ứng với chế độ kéo + độ dời. */
  const applyDrag = (drag: DragState, delta: number): ((tl: Timeline) => Timeline) | null => {
    const sel = drag.target;
    const origin = drag.origin;
    if (!sel) return null;
    if (sel.kind === "scene") {
      if (drag.mode === "trim-start" || drag.mode === "trim-end") {
        const edge = drag.mode === "trim-start" ? "start" : "end";
        return () => trimScene(origin, drag.sceneIndex, edge, delta, editor.ops);
      }
      return null;
    }
    if (isCueSel(sel.kind) && "index" in sel) {
      const kind = CUE_KIND[sel.kind];
      if (drag.mode === "move") return () => moveCue(origin, kind, sel.index, delta);
      if (drag.mode === "trim-start") return () => resizeCue(origin, kind, sel.index, "start", delta);
      if (drag.mode === "trim-end") return () => resizeCue(origin, kind, sel.index, "end", delta);
    }
    if (sel.kind === "sfx" && drag.mode === "move") return () => moveSfx(origin, sel.index, delta);
    return null;
  };

  const dropIndexAt = (frame: number): number => sceneInsertIndexAt(spans, frame);

  // ---------------------------------------------------------------- thả từ thư viện

  /**
   * Đích thả của một món thư viện tại con trỏ. Món chỉ vào được MỘT track (video,
   * ảnh, sfx thư viện, nhạc) thì thả đâu trên timeline cũng về đúng track đó;
   * audio của project (sfx hoặc nhạc) thì theo làn dưới con trỏ, mặc định sfx.
   */
  const libraryTargetAt = (e: ReactDragEvent<HTMLDivElement>): DropTarget | null => {
    if (readOnly) return null;
    const accepted = acceptedTracks([...e.dataTransfer.types]);
    if (accepted.length === 0) return null;
    const row = e.target instanceof Element ? e.target.closest(".tl-row[data-track]") : null;
    const under = row?.getAttribute("data-track") as DropTrack | null | undefined;
    const track = under && accepted.includes(under) ? under : accepted[0];
    let frame = Math.round(frameAtClient(e.clientX));
    // Sfx hít vào playhead / mép phần tử khác như khi kéo khối (Alt tắt hít)
    if (track === "sfx") frame += snapDelta(0, [frame], snapCandidates(null, "move", -1), e.altKey).delta;
    return { track, frame, sceneIndex: dropIndexAt(frame) };
  };

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    const target = libraryTargetAt(e);
    if (!target) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setLibDrop((cur) =>
      cur && cur.track === target.track && cur.frame === target.frame && cur.sceneIndex === target.sceneIndex
        ? cur
        : target,
    );
  };

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    // Rời hẳn khung timeline (không phải chỉ đi qua một khối con)
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    setLibDrop(null);
  };

  // Lượt kéo bị hủy (Esc, thả ngoài cửa sổ) không phải lúc nào cũng bắn dragleave
  // lên khung timeline - dọn chỉ báo ở dragend của cả trang cho chắc
  useEffect(() => {
    const clear = () => setLibDrop(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    const target = libraryTargetAt(e);
    setLibDrop(null);
    if (!target) return;
    e.preventDefault();
    const item = readDragData(e.dataTransfer);
    if (item) onLibraryDrop(item, target);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = e.target;
    const blockEl = target.closest("[data-block]");
    const edgeEl = target.closest("[data-edge]");
    const onRuler = target.closest("[data-ruler]") !== null;
    const onLane = target.closest("[data-lane]") !== null;

    let mode: DragMode | null = null;
    let sel: Selection | null = null;
    if (blockEl) {
      sel = decodeSel(blockEl);
      editor.select(sel);
      // preventDefault bên dưới (chặn bôi đen chữ lúc kéo) cũng chặn luôn việc
      // khối nhận focus - tự đưa focus vào để Enter/Delete/viền focus đúng khối
      if (blockEl instanceof HTMLElement) blockEl.focus({ preventScroll: true });
      if (readOnly || blockEl.getAttribute("data-static") === "true") return;
      const edge = edgeEl?.getAttribute("data-edge");
      if (edge === "start") mode = "trim-start";
      else if (edge === "end") mode = "trim-end";
      else mode = sel?.kind === "scene" ? "reorder" : "move";
    } else if (onRuler || onLane) {
      if (onLane) editor.select(null);
      mode = "scrub";
      editor.seek(Math.round(frameAtClient(e.clientX)));
    } else {
      return;
    }
    if (!mode) return;
    e.preventDefault();

    // Mép + mốc hít tính MỘT lần lúc bấm (từ origin)
    let edges: number[] = [];
    let sceneIndex = -1;
    if (sel?.kind === "scene") {
      sceneIndex = spans.findIndex((s) => s.id === sel.id);
      const span = spans[sceneIndex];
      if (span && mode === "trim-end") edges = [span.end];
    } else if (sel && isCueSel(sel.kind) && "index" in sel) {
      const cue = timeline[CUE_KIND[sel.kind]][sel.index];
      if (cue) {
        const end = cue.from + cue.durationInFrames;
        edges = mode === "move" ? [cue.from, end] : mode === "trim-start" ? [cue.from] : [end];
      }
    } else if (sel?.kind === "sfx") {
      const sfx = timeline.audio.sfx[sel.index];
      if (sfx) edges = [sfx.atFrame];
    }

    dragCounter.current += 1;
    dragRef.current = {
      pointerId: e.pointerId,
      mode,
      target: sel,
      startX: e.clientX,
      startScroll: el.scrollLeft,
      origin: timeline,
      started: mode === "scrub",
      key: `drag:${dragCounter.current}`,
      edges,
      candidates: snapCandidates(sel, mode, sceneIndex),
      sceneIndex,
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // con trỏ đã nhả trước khi kịp bắt - lượt kéo kết thúc ở pointerup
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = scrollRef.current;
    if (!drag || !el || e.pointerId !== drag.pointerId) return;

    if (drag.mode === "scrub") {
      editor.seek(Math.round(frameAtClient(e.clientX)));
      return;
    }

    // Tự cuộn khi con trỏ sát mép khung
    const rect = el.getBoundingClientRect();
    if (e.clientX < rect.left + LABEL_W + EDGE_SCROLL_PX) el.scrollLeft -= 12;
    else if (e.clientX > rect.right - EDGE_SCROLL_PX) el.scrollLeft += 12;

    const dx = e.clientX - drag.startX + (el.scrollLeft - drag.startScroll);
    if (!drag.started) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      drag.started = true;
    }
    const raw = Math.round(pxToFrame(dx, pps, fps));

    if (drag.mode === "reorder") {
      const frame = frameAtClient(e.clientX);
      setDragView({
        target: drag.target,
        mode: drag.mode,
        snapAt: null,
        dropIndex: dropIndexAt(frame),
        offsetPx: dx,
      });
      return;
    }

    const snapped = snapDelta(raw, drag.edges, drag.candidates, e.altKey);
    const op = applyDrag(drag, snapped.delta);
    setDragView({
      target: drag.target,
      mode: drag.mode,
      snapAt: snapped.at,
      dropIndex: null,
      offsetPx: 0,
    });
    if (op) schedule(() => editor.edit(op, { coalesce: drag.key, windowMs: null }));
  };

  const finishDrag = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    const el = scrollRef.current;
    try {
      el?.releasePointerCapture(e.pointerId);
    } catch {
      // đã nhả
    }
    flush();
    if (!cancelled && drag.started && drag.mode === "reorder" && drag.target?.kind === "scene") {
      const from = drag.sceneIndex;
      const drop = dropIndexAt(frameAtClient(e.clientX));
      const to = drop > from ? drop - 1 : drop;
      if (from >= 0 && to !== from) {
        const origin = drag.origin;
        editor.edit(() => reorderScene(origin, from, to));
      }
    }
    if (cancelled && drag.started && drag.mode !== "reorder" && drag.mode !== "scrub") {
      // pointercancel (mất con trỏ): trả về đúng trạng thái lúc bấm
      const origin = drag.origin;
      editor.edit(() => origin, { coalesce: drag.key, windowMs: null });
    }
    editor.endCoalesce();
    setDragView(null);
  };

  // ---------------------------------------------------------------- vẽ

  const selectedKey = selKey(selection);
  const draggingKey = dragView ? selKey(dragView.target) : "";

  const block = ({
    sel,
    start,
    end,
    label,
    title,
    icon: Icon,
    resizable,
    staticBlock = false,
    invalid = false,
    offsetPx = 0,
  }: {
    sel: Selection;
    start: number;
    end: number;
    label: string;
    title: string;
    icon?: LucideIcon;
    resizable: { start: boolean; end: boolean };
    staticBlock?: boolean;
    invalid?: boolean;
    offsetPx?: number;
  }): ReactNode => {
    const key = selKey(sel);
    const left = x(start);
    const width = Math.max(2, x(end) - left);
    const selected = key === selectedKey;
    const dragging = key === draggingKey;
    const classes = [
      "tl-block",
      staticBlock ? "is-static" : "",
      readOnly ? "is-readonly" : "",
      dragging ? "is-dragging" : "",
      invalid ? "is-invalid" : "",
    ].join(" ");
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={title}
        title={title}
        data-block=""
        data-static={staticBlock ? "true" : undefined}
        data-selected={selected ? "true" : undefined}
        {...encodeSel(sel)}
        className={classes}
        style={{
          left,
          width,
          transform: offsetPx ? `translateX(${offsetPx}px)` : undefined,
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            editor.select(sel);
          }
        }}
      >
        {Icon && width > 36 && <Icon size={13} strokeWidth={2} aria-hidden="true" />}
        {width > 24 && <span className="tl-block-text">{label}</span>}
        {!readOnly && resizable.start && width > 12 && (
          <span className="tl-handle is-start" data-edge="start" aria-hidden="true" />
        )}
        {!readOnly && resizable.end && width > 12 && (
          <span className="tl-handle is-end" data-edge="end" aria-hidden="true" />
        )}
      </div>
    );
  };

  const secLabel = (frames: number) => formatTimecode(frames, fps);

  const sceneBlocks = spans.map((span) => {
    const scene = timeline.scenes[span.index];
    const kind = sceneKind(scene);
    const icon = kind === "image" ? ImageIcon : kind === "hyperframes" ? Sparkles : Film;
    const name = kind === "hyperframes" ? scene.id : baseName(sceneSourcePath(scene)) || scene.id;
    const offset =
      dragView?.mode === "reorder" && dragView.target?.kind === "scene" && dragView.target.id === scene.id
        ? dragView.offsetPx
        : 0;
    return block({
      sel: { kind: "scene", id: scene.id },
      start: span.start,
      end: span.end,
      label: name,
      title: tf("editor.timeline.block-scene", {
        name,
        start: secLabel(span.start),
        end: secLabel(span.end),
      }),
      icon,
      resizable: {
        start: kind === "footage" || kind === "image" || kind === "empty",
        end: true,
      },
      invalid: span.invalid,
      offsetPx: offset,
    });
  });

  const overlaps = spans
    .filter((s) => s.overlapOut > 0)
    .map((s) => (
      <div
        key={`ov-${s.id}`}
        className="tl-overlap"
        style={{ left: x(s.end - s.overlapOut), width: Math.max(2, x(s.overlapOut)) }}
        title={tf("editor.timeline.transition", { sec: (s.overlapOut / fps).toFixed(2) })}
      />
    ));

  const cueBlocks = (kind: "caption" | "subtitle" | "overlay") =>
    timeline[CUE_KIND[kind]].map((cue, index) => {
      let label: string;
      if (kind === "caption") label = timeline.captions[index].words.map((w) => w.text).join(" ");
      else if (kind === "subtitle") label = timeline.subtitles[index].text.replace(/\n+/g, " / ");
      else {
        const o = timeline.overlays[index];
        label = `${o.kicker ? `${o.kicker} · ` : ""}${o.parts.map((p) => p.t).join("")}`;
      }
      const end = cue.from + cue.durationInFrames;
      return block({
        sel: { kind, index },
        start: cue.from,
        end,
        label,
        title: `${label} (${secLabel(cue.from)} - ${secLabel(end)})`,
        resizable: { start: true, end: true },
      });
    });

  const sfxBlocks = timeline.audio.sfx.map((sfx, index) => {
    const media = preview.media[sfx.file]?.durationSec;
    const lenSec =
      typeof media === "number" && media > 0 ? Math.max(0.1, media - (sfx.mediaStart ?? 0)) : 1;
    const name = baseName(sfx.file);
    return block({
      sel: { kind: "sfx", index },
      start: sfx.atFrame,
      end: sfx.atFrame + Math.max(1, Math.round(lenSec * fps)),
      label: name,
      title: `${name} (${secLabel(sfx.atFrame)})`,
      icon: AudioLines,
      resizable: { start: false, end: false },
    });
  });

  const voice = timeline.audio.voice;
  const voiceSec = voice ? preview.media[voice]?.durationSec : null;
  const voiceEnd =
    typeof voiceSec === "number" && voiceSec > 0 ? Math.round(voiceSec * fps) : totalFrames;
  const music = timeline.audio.music;

  const tracks: {
    key: TrackKey;
    label: string;
    icon: LucideIcon;
    items: ReactNode[];
    extra?: ReactNode;
  }[] = [
    { key: "scene", label: t("editor.track.video"), icon: Film, items: sceneBlocks, extra: overlaps },
    { key: "overlay", label: t("editor.track.highlight"), icon: Highlighter, items: cueBlocks("overlay") },
    { key: "caption", label: t("editor.track.karaoke"), icon: Captions, items: cueBlocks("caption") },
    { key: "subtitle", label: t("editor.track.subtitle"), icon: Subtitles, items: cueBlocks("subtitle") },
    { key: "sfx", label: t("editor.track.sfx"), icon: AudioLines, items: sfxBlocks },
    {
      key: "voice",
      label: t("editor.track.voice"),
      icon: Mic,
      items: voice
        ? [
            block({
              sel: { kind: "voice" },
              start: 0,
              end: Math.max(1, voiceEnd),
              label: baseName(voice),
              title: baseName(voice),
              icon: Mic,
              resizable: { start: false, end: false },
              staticBlock: true,
            }),
          ]
        : [],
    },
    {
      key: "music",
      label: t("editor.track.music"),
      icon: Music,
      items: music
        ? [
            block({
              sel: { kind: "music" },
              start: 0,
              end: totalFrames,
              label: baseName(music.file),
              title: baseName(music.file),
              icon: Music,
              resizable: { start: false, end: false },
              staticBlock: true,
            }),
          ]
        : [],
    },
  ];

  // Vạch thước giờ - chỉ vẽ phần đang nhìn thấy (video dài × zoom sâu là hàng chục nghìn vạch)
  const ticks = useMemo(() => {
    const { major, minor } = rulerStep(pps);
    const fromSec = Math.max(0, pxToFrame(viewport.left - LABEL_W, pps, fps) / fps - major);
    const toSec = pxToFrame(viewport.left + viewport.width, pps, fps) / fps + major;
    const out: { sec: number; major: boolean }[] = [];
    const start = Math.floor(fromSec / minor) * minor;
    for (let s = start; s <= toSec; s += minor) {
      const sec = Math.round(s * 1000) / 1000;
      const isMajor = Math.abs(sec / major - Math.round(sec / major)) < 1e-6;
      out.push({ sec, major: isMajor });
    }
    return out;
  }, [pps, fps, viewport.left, viewport.width]);

  const sceneBoundaryX = (index: number): number =>
    x(index < spans.length ? spans[index].start : (spans[spans.length - 1]?.end ?? 0));
  const dropX =
    dragView?.dropIndex !== null && dragView?.dropIndex !== undefined
      ? sceneBoundaryX(dragView.dropIndex)
      : libDrop?.track === "scene"
        ? sceneBoundaryX(libDrop.sceneIndex)
        : null;
  const addCueLabel: Record<AddCueKind, string> = {
    overlay: t("editor.add.highlight"),
    caption: t("editor.add.karaoke"),
    subtitle: t("editor.add.subtitle"),
  };

  return (
    <section className="tl" style={{ height }} aria-label={t("editor.timeline.title")}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="text-sm font-semibold">{t("editor.timeline.title")}</h2>
          <span className="text-meta text-[var(--text-muted)] tabular-nums">
            {tf("editor.timeline.length", { time: formatTimecode(totalFrames, fps) })}
          </span>
          <span className="hidden text-meta text-[var(--text-muted)] lg:inline">
            {t("editor.timeline.snap-hint")}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label={t("editor.zoom-out")} onClick={() => zoomBy(1 / 1.5)} disabled={pps <= ZOOM_MIN_PPS}>
            <ZoomOut size={16} strokeWidth={1.75} />
          </IconButton>
          <input
            type="range"
            className="slider w-28 flex-none"
            min={0}
            max={100}
            step={1}
            value={ppsToSlider(pps)}
            aria-label={t("editor.zoom")}
            onChange={(e) => {
              autoFitRef.current = false;
              setPps(clampPps(sliderToPps(Number(e.target.value))));
            }}
          />
          <IconButton label={t("editor.zoom-in")} onClick={() => zoomBy(1.5)} disabled={pps >= ZOOM_MAX_PPS}>
            <ZoomIn size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label={t("editor.zoom-fit")}
            onClick={() => {
              autoFitRef.current = true;
              fit();
            }}
          >
            <Maximize2 size={16} strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="tl-scroll"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finishDrag(e, false)}
        onPointerCancel={(e) => finishDrag(e, true)}
        onLostPointerCapture={(e) => finishDrag(e, false)}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="tl-content" style={{ width: contentWidth }}>
          <div className="tl-ruler">
            <div className="tl-label" style={{ width: LABEL_W }} aria-hidden="true" />
            <div className="tl-ruler-lane" data-ruler="" title={t("editor.timeline.ruler-hint")}>
              {ticks.map((tick) => (
                <span key={tick.sec}>
                  <span
                    className={`tl-tick ${tick.major ? "is-major" : ""}`}
                    style={{ left: frameToPx(tick.sec * fps, pps, fps) }}
                  />
                  {tick.major && (
                    <span className="tl-tick-label" style={{ left: frameToPx(tick.sec * fps, pps, fps) }}>
                      {formatRulerLabel(tick.sec)}
                    </span>
                  )}
                </span>
              ))}
              <PlayheadKnob pps={pps} />
            </div>
          </div>

          {tracks.map((track) => (
            <div
              key={track.key}
              className="tl-row"
              data-track={track.key}
              data-drop={libDrop?.track === track.key ? "true" : undefined}
            >
              <div className="tl-label text-meta font-medium" style={{ width: LABEL_W }}>
                <span className="tl-label-swatch" aria-hidden="true" />
                <track.icon size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{track.label}</span>
                {(track.key === "overlay" || track.key === "caption" || track.key === "subtitle") && (
                  <IconButton
                    label={addCueLabel[track.key]}
                    size="sm"
                    disabled={readOnly}
                    onClick={() => onAddCue(track.key as AddCueKind)}
                    data-add-cue={track.key}
                  >
                    <Plus size={13} strokeWidth={2} />
                  </IconButton>
                )}
              </div>
              <div className="tl-lane" data-lane="">
                {track.extra}
                {track.items}
                {track.items.length === 0 && (
                  <span className="tl-empty" style={{ left: viewport.left + 8 }}>
                    {t("editor.track.empty")}
                  </span>
                )}
                {track.key === "scene" && dropX !== null && (
                  <span className="tl-drop" style={{ left: dropX }} aria-hidden="true" />
                )}
              </div>
            </div>
          ))}

          {libDrop?.track === "sfx" && (
            <span className="tl-snap" style={{ left: LABEL_W + x(libDrop.frame) }} aria-hidden="true" />
          )}
          {dragView?.snapAt !== null && dragView?.snapAt !== undefined && (
            <span
              className="tl-snap"
              style={{ left: LABEL_W + x(dragView.snapAt) }}
              aria-hidden="true"
            />
          )}
          <PlayheadLine pps={pps} />
        </div>
      </div>
    </section>
  );
}

function PlayheadLine({ pps }: { pps: number }) {
  const { playback, fps } = useEditor();
  const frame = usePlayheadFrame(playback);
  return (
    <span
      className="tl-playhead"
      style={{ transform: `translateX(${LABEL_W + frameToPx(frame, pps, fps)}px)` }}
      aria-hidden="true"
    />
  );
}

function PlayheadKnob({ pps }: { pps: number }) {
  const { playback, fps } = useEditor();
  const frame = usePlayheadFrame(playback);
  return (
    <span
      className="tl-playhead-knob"
      style={{ transform: `translateX(${frameToPx(frame, pps, fps)}px)` }}
      aria-hidden="true"
    />
  );
}
