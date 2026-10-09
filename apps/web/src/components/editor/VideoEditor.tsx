"use client";

/**
 * Trình chỉnh sửa video (/projects/[id]/editor) - ráp các mảnh lại với nhau:
 *
 *   store.ts      reducer: timeline + selection + hoàn tác + trạng thái lưu
 *   ops.ts        mọi thao tác sửa (thuần)       timing.ts  toán frame ↔ px
 *   playback.ts   playhead ngoài React state     PreviewPlayer  Remotion Player
 *   TimelinePanel / Inspector / Transport / EditorTopBar / EditorChat
 *
 * Trang này lo phần "nối dây" với server:
 * - tải GET /timeline, tải lại (throttle 1.5s) khi AI ghi file, khi job render
 *   scene xong, khi SSE nối lại;
 * - tự lưu 700ms sau thay đổi cuối (PUT kèm baseVersion), xung đột → banner
 *   "Tải bản mới" / "Giữ bản của tôi", lỗi validate → banner trỏ thẳng phần tử;
 * - chỉ đọc khi AI đang chạy trên project (lock.agentBusy + SSE agent);
 * - render draft/final qua render queue (lưu nốt thay đổi trước khi xếp job);
 * - phím tắt (không bao giờ khi đang gõ trong ô nhập).
 */

import { Clapperboard, Keyboard, LayoutDashboard } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { LinkButton } from "@/components/LinkButton";
import { Skeleton } from "@/components/Skeleton";
import {
  ApiError,
  getChatSessions,
  getJobs,
  getTimeline,
  saveTimeline,
  startEditorRender,
  timelineConflictOf,
  timelineIssuesOf,
  type Job,
  type Timeline,
  type TimelineIssue,
  type TimelineLock,
  type TimelinePatch,
  type TimelinePreview,
  type TimelineProject,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useAgentEvents, useEvents, useJobEvents } from "@/lib/useEvents";
import { EditorChat } from "./EditorChat";
import { EditorContext, type EditorApi, type EditOptions } from "./EditorContext";
import { EditorTopBar, type EditorMenuItem, type SaveState } from "./EditorTopBar";
import { Inspector, type InspectorActions } from "./Inspector";
import {
  canDelete,
  canDuplicate,
  canSplitScene,
  contextFromPreview,
  deleteSelection,
  duplicateSelection,
  isCueSel,
  normalizeTimeline,
  sceneIndexById,
  splitAtPlayhead,
  type Selection,
} from "./ops";
import { createPlaybackStore } from "./playback";
import { PreviewPlayer, type PlayerRef } from "./PreviewPlayer";
import { ShortcutsModal } from "./ShortcutsModal";
import { editorReducer, initialEditorState, isDirty, type SaveProblem } from "./store";
import { TimelinePanel } from "./TimelinePanel";
import { Transport } from "./Transport";
import { computeSceneSpans, totalFramesOf } from "./timing";

/** Tự lưu sau khi người dùng ngừng sửa ngần này (ms) */
const AUTOSAVE_MS = 700;
/** Tải lại timeline tối đa một lần mỗi khoảng này khi AI đang ghi file */
const REFETCH_THROTTLE_MS = 1500;
const TIMELINE_H_KEY = "aiev-editor-timeline-h";
const TIMELINE_H_DEFAULT = 348;
const TIMELINE_H_MIN = 180;
/** Nhãn lịch sử phiên bản cho mọi lần tự lưu (server gộp các PUT cùng nhãn trong 10s) */
const SAVE_LABEL = "editor";
/** Tool của agent có thể đã ghi meta.json → tải lại timeline */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);

const isRenderJob = (job: Job): boolean =>
  job.type === "scene-draft" ||
  job.type === "scene-final" ||
  job.type === "assemble-draft" ||
  job.type === "assemble-final";

const isActive = (job: Job): boolean => job.status === "queued" || job.status === "running";

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Toàn bộ 6 khóa - subtitleStyle vắng mặt phải gửi `null` (PUT giữ khóa không gửi). */
const toPatch = (tl: Timeline): TimelinePatch => ({
  scenes: tl.scenes,
  audio: tl.audio,
  captions: tl.captions,
  subtitles: tl.subtitles,
  overlays: tl.overlays,
  subtitleStyle: tl.subtitleStyle ?? null,
});

/** `scenes[2].from` → phần tử tương ứng để chọn khi bấm vào lỗi. */
function selectionFromIssuePath(path: string, tl: Timeline): Selection | null {
  const scene = /^scenes\[(\d+)\]/.exec(path);
  if (scene) {
    const id = tl.scenes[Number(scene[1])]?.id;
    return id ? { kind: "scene", id } : null;
  }
  const cue = /^(captions|subtitles|overlays)\[(\d+)\]/.exec(path);
  if (cue) {
    const index = Number(cue[2]);
    if (cue[1] === "captions") return { kind: "caption", index };
    if (cue[1] === "subtitles") return { kind: "subtitle", index };
    return { kind: "overlay", index };
  }
  const sfx = /^audio\.sfx\[(\d+)\]/.exec(path);
  if (sfx) return { kind: "sfx", index: Number(sfx[1]) };
  if (path.startsWith("audio.music")) return { kind: "music" };
  if (path.startsWith("audio.voice")) return { kind: "voice" };
  return null;
}

/** Gõ trong ô nhập thì phím tắt không được chạy. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

interface LoadError {
  message: string;
  detail?: string;
  notFound: boolean;
}

interface RenderProblem {
  message: string;
  detail?: string;
  issues: TimelineIssue[];
  /** Cổng QC chặn bản final - cho "Vẫn render" (force) */
  force: "final" | null;
}

export function VideoEditor({ projectId }: { projectId: string }) {
  const { t } = useT();
  const router = useRouter();
  const { resyncTick } = useEvents();

  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [info, setInfo] = useState<{ project: TimelineProject; preview: TimelinePreview } | null>(null);
  const [lock, setLock] = useState<TimelineLock | null>(null);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [renderStarting, setRenderStarting] = useState(false);
  const [renderProblem, setRenderProblem] = useState<RenderProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [timelineHeight, setTimelineHeight] = useState(TIMELINE_H_DEFAULT);

  const playback = useMemo(() => createPlaybackStore(), []);
  const playerRef = useRef<PlayerRef | null>(null);

  // Nguồn sự thật ĐỒNG BỘ cho lượt lưu: state của reducer chỉ cập nhật ở lượt
  // render sau, còn hai lượt lưu nối nhau thì cần version mới NGAY.
  const versionRef = useRef<string | null>(null);
  const savedRevisionRef = useRef(0);
  const saveCountRef = useRef(0);
  const saveInFlight = useRef<Promise<boolean> | null>(null);

  const projectSessions = useRef(new Set<string>());
  const foreignSessions = useRef(new Set<string>());
  const classifying = useRef(new Set<string>());

  const fps = info?.project.fps ?? 30;
  const timeline = state.timeline;
  const readOnly = lock?.agentBusy === true;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  const spans = useMemo(() => (timeline ? computeSceneSpans(timeline.scenes, fps) : []), [timeline, fps]);
  const totalFrames = useMemo(() => totalFramesOf(spans), [spans]);
  const totalRef = useRef(totalFrames);
  totalRef.current = totalFrames;
  const opsCtx = useMemo(
    () => (info ? contextFromPreview(info.preview, fps) : contextFromPreview({ sceneRenders: {}, watermark: null, media: {} }, fps)),
    [info, fps],
  );

  // ================================================================ tải

  const loadRef = useRef<() => Promise<void>>(async () => {});
  const refetchTimer = useRef<number | null>(null);
  const lastFetchAt = useRef(0);

  const requestRefetch = useCallback(() => {
    if (refetchTimer.current !== null) return;
    const wait = Math.max(0, REFETCH_THROTTLE_MS - (Date.now() - lastFetchAt.current));
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      void loadRef.current();
    }, wait);
  }, []);

  useEffect(
    () => () => {
      if (refetchTimer.current !== null) window.clearTimeout(refetchTimer.current);
    },
    [],
  );

  const load = useCallback(async () => {
    lastFetchAt.current = Date.now();
    const savesBefore = saveCountRef.current;
    try {
      const res = await getTimeline(projectId);
      setLoadError(null);
      // Giữ identity khi không đổi: project/preview đổi là trình phát dựng lại
      setInfo((prev) => {
        if (prev && sameJson(prev.project, res.project) && sameJson(prev.preview, res.preview)) return prev;
        return {
          project: prev && sameJson(prev.project, res.project) ? prev.project : res.project,
          preview: prev && sameJson(prev.preview, res.preview) ? prev.preview : res.preview,
        };
      });
      setLock((prev) => (prev && sameJson(prev, res.lock) ? prev : res.lock));
      if (res.lock.sessionId) projectSessions.current.add(res.lock.sessionId);

      const s = stateRef.current;
      // Một lượt lưu đã chen vào giữa: bản vừa tải có thể CŨ hơn bản mình vừa ghi
      if (saveCountRef.current !== savesBefore || saveInFlight.current) {
        requestRefetch();
        return;
      }
      const incoming = normalizeTimeline(res.timeline);
      if (!s.timeline || (res.version !== versionRef.current && !isDirty(s))) {
        versionRef.current = res.version;
        savedRevisionRef.current = s.revision;
        dispatch({ type: "loaded", version: res.version, timeline: incoming });
        return;
      }
      if (res.version !== versionRef.current) {
        // Người khác (AI / tab khác) đã đổi trong lúc mình còn bản chưa lưu
        dispatch({ type: "conflict", current: { version: res.version, timeline: incoming } });
      }
    } catch (err) {
      if (stateRef.current.timeline) return; // đang sửa được - lần tải sau sẽ bắt kịp
      setLoadError({
        message: err instanceof ApiError && err.status === 404 ? t("editor.load.not-found") : t("editor.load.error"),
        detail: err instanceof Error ? err.message : String(err),
        notFound: err instanceof ApiError && err.status === 404,
      });
    }
  }, [projectId, requestRefetch, t]);
  loadRef.current = load;

  useEffect(() => {
    void load();
    // resyncTick: SSE vừa nối lại - có thể đã lỡ event AI/job, tải lại cho chắc
  }, [load, resyncTick]);

  // Phiên AI của project (để lọc SSE agent) + job render đang có
  useEffect(() => {
    let alive = true;
    getChatSessions(projectId)
      .then((list) => list.forEach((s) => projectSessions.current.add(s.sessionId)))
      .catch(() => {});
    getJobs(50, projectId)
      .then((list) => {
        if (alive) setJobs(list.filter((j) => j.projectId === projectId && isRenderJob(j)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId, resyncTick]);

  // ================================================================ AI đang chạy

  const onProjectAgentEvent = useCallback(
    (kind: string, sessionId: string, toolName: string | undefined) => {
      if (kind === "done" || kind === "error") {
        requestRefetch();
        return;
      }
      setLock((l) => (l && !l.agentBusy ? { ...l, agentBusy: true, sessionId } : l));
      if (kind === "tool" && toolName && WRITE_TOOLS.has(toolName)) requestRefetch();
    },
    [requestRefetch],
  );

  useAgentEvents((e) => {
    const id = e.sessionId;
    if (!id || foreignSessions.current.has(id)) return;
    if (projectSessions.current.has(id)) {
      onProjectAgentEvent(e.kind, id, e.tool?.name);
      return;
    }
    // Phiên lạ: hỏi server MỘT lần xem có phải của project này không
    if (classifying.current.has(id)) return;
    classifying.current.add(id);
    getChatSessions(projectId)
      .then((list) => {
        list.forEach((s) => projectSessions.current.add(s.sessionId));
        if (projectSessions.current.has(id)) requestRefetch();
        else foreignSessions.current.add(id);
      })
      .catch(() => {})
      .finally(() => classifying.current.delete(id));
  });

  // ================================================================ job render

  useJobEvents((job) => {
    if (job.projectId !== projectId || !isRenderJob(job)) return;
    setJobs((prev) => {
      const i = prev.findIndex((j) => j.id === job.id);
      if (i === -1) return [job, ...prev];
      const next = prev.slice();
      next[i] = job;
      return next;
    });
    // Scene HyperFrames vừa render xong → trình phát có file xem trước mới
    if (job.status === "done" && (job.type === "scene-draft" || job.type === "scene-final")) {
      requestRefetch();
    }
  });

  const activeJobs = useMemo(
    () =>
      jobs
        .filter(isActive)
        .sort((a, b) => (a.status === b.status ? a.createdAt.localeCompare(b.createdAt) : a.status === "running" ? -1 : 1)),
    [jobs],
  );
  const lastOutput = useMemo(
    () =>
      jobs
        .filter((j) => (j.type === "assemble-draft" || j.type === "assemble-final") && j.status === "done" && j.outputPath)
        .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0] ?? null,
    [jobs],
  );
  const renderActive = activeJobs.length > 0;
  // Job của lượt render bấm từ editor - để báo lại nếu nó hỏng (hàng đợi chạy
  // nền, không báo thì người dùng chỉ thấy thanh tiến trình biến mất)
  const [renderBatch, setRenderBatch] = useState<string[]>([]);
  const failedJob = useMemo(
    () => jobs.find((j) => renderBatch.includes(j.id) && j.status === "failed") ?? null,
    [jobs, renderBatch],
  );
  // Có sửa gì SAU khi render bắt đầu không - chỉ khi đó mới cần báo
  const [renderBaseline, setRenderBaseline] = useState<number | null>(null);
  useEffect(() => {
    if (renderActive && renderBaseline === null) setRenderBaseline(state.revision);
    if (!renderActive && renderBaseline !== null) setRenderBaseline(null);
  }, [renderActive, renderBaseline, state.revision]);

  // ================================================================ lưu

  const doSave = useCallback(async (): Promise<boolean> => {
    while (saveInFlight.current) await saveInFlight.current;
    const s = stateRef.current;
    const base = versionRef.current;
    if (!s.timeline || !base) return false;
    if (s.revision === savedRevisionRef.current) return true;
    if (s.problem?.kind === "conflict" || readOnlyRef.current) return false;
    const revision = s.revision;
    const payload = toPatch(s.timeline);
    dispatch({ type: "saveStart", revision });
    const run = (async () => {
      try {
        const res = await saveTimeline(projectId, base, payload, SAVE_LABEL);
        saveCountRef.current += 1;
        versionRef.current = res.version;
        savedRevisionRef.current = Math.max(savedRevisionRef.current, revision);
        dispatch({ type: "saveOk", revision, version: res.version });
        return true;
      } catch (err) {
        let problem: SaveProblem;
        const conflict = timelineConflictOf(err);
        const message = err instanceof Error ? err.message : String(err);
        if (conflict) {
          problem = { kind: "conflict", current: { version: conflict.version, timeline: normalizeTimeline(conflict.timeline) } };
        } else if (err instanceof ApiError && err.code === "INVALID_TIMELINE") {
          problem = { kind: "invalid", issues: timelineIssuesOf(err), message };
        } else if (err instanceof ApiError && err.code === "AGENT_BUSY") {
          problem = { kind: "locked", message };
          const sessionId = typeof err.data.sessionId === "string" ? err.data.sessionId : null;
          if (sessionId) projectSessions.current.add(sessionId);
          setLock((l) => (l ? { ...l, agentBusy: true, sessionId } : l));
        } else {
          problem = { kind: "error", message };
        }
        dispatch({ type: "saveFailed", revision, problem });
        return false;
      }
    })();
    saveInFlight.current = run;
    try {
      return await run;
    } finally {
      if (saveInFlight.current === run) saveInFlight.current = null;
    }
  }, [projectId]);

  const dirty = isDirty(state);
  const problem = state.problem;
  // Tự lưu: 700ms sau thay đổi cuối. Lượt lỗi thì chờ người dùng sửa tiếp
  // (revision đổi) hoặc bấm thử lại - không dội server bằng cùng một bản sai.
  useEffect(() => {
    if (!state.timeline || !dirty || state.savingRevision !== null || readOnly) return;
    if (problem && (problem.kind === "conflict" || problem.revision === state.revision)) return;
    const timer = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [state.timeline, state.revision, state.savingRevision, dirty, problem, readOnly, doSave]);

  // AI xong mà mình còn bản chưa lưu (bị chặn AGENT_BUSY) → thử lưu lại; xung
  // đột (nếu AI đã sửa) sẽ hiện banner như thường
  useEffect(() => {
    if (!readOnly && problem?.kind === "locked") dispatch({ type: "clearProblem" });
  }, [readOnly, problem]);

  useEffect(() => {
    if (!dirty && state.savingRevision === null) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, state.savingRevision]);

  const retrySave = useCallback(() => {
    dispatch({ type: "clearProblem" });
    void doSave();
  }, [doSave]);

  /** Lưu ngay nếu còn thay đổi chưa lưu (trước khi render / trước khi nhờ AI). */
  const flushSave = useCallback(async (): Promise<boolean> => {
    if (!isDirty(stateRef.current) && !saveInFlight.current) return true;
    return doSave();
  }, [doSave]);

  const loadLatest = useCallback(() => {
    const p = stateRef.current.problem;
    if (p?.kind !== "conflict") return;
    versionRef.current = p.current.version;
    savedRevisionRef.current = stateRef.current.revision;
    dispatch({ type: "loaded", version: p.current.version, timeline: p.current.timeline });
  }, []);

  const keepMine = useCallback(() => {
    const p = stateRef.current.problem;
    if (p?.kind !== "conflict") return;
    versionRef.current = p.current.version;
    dispatch({ type: "keepMine" });
  }, []);

  // ================================================================ phát

  const seek = useCallback(
    (frame: number) => {
      const f = Math.max(0, Math.min(totalRef.current - 1, Math.round(frame)));
      playback.setFrame(f);
      playerRef.current?.seekTo(f);
    },
    [playback],
  );

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying()) {
      p.pause();
      return;
    }
    if (playback.getFrame() >= totalRef.current - 1) seek(0);
    p.play();
  }, [playback, seek]);

  const step = useCallback(
    (delta: number) => {
      playerRef.current?.pause();
      seek(playback.getFrame() + delta);
    },
    [playback, seek],
  );

  // Callback ref: Player chỉ có mặt sau khi đo khung (và biến mất khi timeline lỗi)
  const attachPlayer = useCallback(
    (p: PlayerRef | null) => {
      playerRef.current = p;
      if (!p) return;
      const onFrame = (e: { detail: { frame: number } }) => playback.setFrame(e.detail.frame);
      const onPlay = () => playback.setPlaying(true);
      const onPause = () => playback.setPlaying(false);
      p.addEventListener("frameupdate", onFrame);
      p.addEventListener("seeked", onFrame);
      p.addEventListener("play", onPlay);
      p.addEventListener("pause", onPause);
      p.addEventListener("ended", onPause);
      const keep = playback.getFrame();
      if (keep > 0) p.seekTo(Math.min(keep, totalRef.current - 1));
      return () => {
        p.removeEventListener("frameupdate", onFrame);
        p.removeEventListener("seeked", onFrame);
        p.removeEventListener("play", onPlay);
        p.removeEventListener("pause", onPause);
        p.removeEventListener("ended", onPause);
        playback.setPlaying(false);
        if (playerRef.current === p) playerRef.current = null;
      };
    },
    [playback],
  );

  // Timeline ngắn lại (xóa/trim) mà playhead nằm quá cuối → kéo về
  useEffect(() => {
    if (playback.getFrame() > totalFrames - 1) seek(totalFrames - 1);
  }, [totalFrames, playback, seek]);

  // ================================================================ sửa

  const edit = useCallback((apply: (tl: Timeline) => Timeline, options?: EditOptions) => {
    if (readOnlyRef.current) return;
    dispatch({
      type: "edit",
      apply,
      coalesce: options?.coalesce ? { key: options.coalesce, windowMs: options.windowMs ?? null } : undefined,
      selection: options?.selection,
      now: Date.now(),
    });
  }, []);

  const select = useCallback((selection: Selection | null) => dispatch({ type: "select", selection }), []);
  const endCoalesce = useCallback(() => dispatch({ type: "endCoalesce" }), []);

  const flashNotice = useCallback((message: string) => setNotice(message), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const splitAction = useCallback(() => {
    const s = stateRef.current;
    if (!s.timeline || readOnlyRef.current) return;
    const result = splitAtPlayhead(
      s.timeline,
      s.selection,
      playback.getFrame(),
      computeSceneSpans(s.timeline.scenes, fps),
      opsCtx,
    );
    if (!result) {
      flashNotice(t("editor.notice.cannot-split"));
      return;
    }
    edit(() => result.timeline, { selection: result.selection });
  }, [edit, fps, opsCtx, playback, flashNotice, t]);

  const duplicateAction = useCallback(() => {
    const s = stateRef.current;
    if (!s.timeline || !canDuplicate(s.timeline, s.selection)) return;
    const result = duplicateSelection(s.timeline, s.selection, fps);
    edit(() => result.timeline, { selection: result.selection });
  }, [edit, fps]);

  const deleteAction = useCallback(() => {
    const s = stateRef.current;
    if (!s.timeline || !s.selection) return;
    if (!canDelete(s.timeline, s.selection)) {
      flashNotice(
        s.selection.kind === "scene" ? t("editor.notice.last-scene") : t("editor.notice.cannot-delete"),
      );
      return;
    }
    const sel = s.selection;
    edit((tl) => deleteSelection(tl, sel), { selection: null });
  }, [edit, flashNotice, t]);

  const undo = useCallback(() => {
    if (!readOnlyRef.current) dispatch({ type: "undo" });
  }, []);
  const redo = useCallback(() => {
    if (!readOnlyRef.current) dispatch({ type: "redo" });
  }, []);

  // ================================================================ phím tắt

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      // Modal đang mở: phím thuộc về modal (Esc đóng modal, không bỏ chọn)
      if (document.querySelector('[role="dialog"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      const onButton =
        e.target instanceof HTMLElement &&
        (e.target.tagName === "BUTTON" || e.target.tagName === "A") &&
        !e.target.hasAttribute("data-block");

      if (key === " " && !mod) {
        if (onButton) return; // Space trên nút = bấm nút đó (bàn phím/a11y)
        e.preventDefault();
        togglePlay();
      } else if ((key === "ArrowLeft" || key === "ArrowRight") && !mod && !e.altKey) {
        e.preventDefault();
        const unit = e.shiftKey ? Math.round(fps) : 1;
        step(key === "ArrowLeft" ? -unit : unit);
      } else if (key === "Home" && !mod) {
        e.preventDefault();
        seek(0);
      } else if (key === "End" && !mod) {
        e.preventDefault();
        seek(totalRef.current - 1);
      } else if ((key === "s" || key === "S") && !mod && !e.altKey) {
        e.preventDefault();
        splitAction();
      } else if ((key === "Delete" || key === "Backspace") && !mod) {
        if (!stateRef.current.selection) return;
        e.preventDefault();
        deleteAction();
      } else if (mod && (key === "d" || key === "D")) {
        e.preventDefault();
        duplicateAction();
      } else if (mod && (key === "z" || key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && (key === "y" || key === "Y")) {
        e.preventDefault();
        redo();
      } else if (key === "Escape") {
        if (stateRef.current.selection) dispatch({ type: "select", selection: null });
      } else if (key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fps, togglePlay, step, seek, splitAction, deleteAction, duplicateAction, undo, redo]);

  // ================================================================ render

  const startRender = useCallback(
    async (quality: "draft" | "final", force = false) => {
      setRenderProblem(null);
      setRenderBatch([]);
      setRenderStarting(true);
      try {
        if (!(await flushSave())) {
          setRenderProblem({ message: t("editor.render.save-first"), issues: [], force: null });
          return;
        }
        const res = await startEditorRender(projectId, quality, { force });
        setRenderBatch(res.jobs.map((j) => j.id));
        // SSE có thể đã báo job TRƯỚC khi response về - giữ bản mới hơn của nó
        setJobs((prev) => [
          ...res.jobs.filter((n) => !prev.some((j) => j.id === n.id)),
          ...prev,
        ]);
      } catch (err) {
        const code = err instanceof ApiError ? err.code : "";
        const detail = err instanceof Error ? err.message : String(err);
        if (code === "DRAFT_REQUIRED") {
          setRenderProblem({ message: t("editor.render.draft-required"), detail, issues: [], force: null });
        } else if (code === "QC_REQUIRED" || code === "QC_FAILED") {
          setRenderProblem({
            message: code === "QC_FAILED" ? t("editor.render.qc-failed") : t("editor.render.qc-required"),
            detail,
            issues: [],
            force: "final",
          });
        } else if (code === "INVALID_TIMELINE") {
          setRenderProblem({ message: t("editor.render.invalid"), detail, issues: timelineIssuesOf(err), force: null });
        } else {
          setRenderProblem({ message: t("editor.render.error"), detail, issues: [], force: null });
        }
      } finally {
        setRenderStarting(false);
      }
    },
    [flushSave, projectId, t],
  );

  // ================================================================ kéo cao timeline

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(TIMELINE_H_KEY));
      if (Number.isFinite(saved) && saved >= TIMELINE_H_MIN) setTimelineHeight(saved);
    } catch {
      // localStorage bị chặn - dùng mặc định
    }
  }, []);

  const maxTimelineHeight = () => Math.max(TIMELINE_H_MIN, Math.round(window.innerHeight * 0.65));
  const persistHeight = (h: number) => {
    try {
      window.localStorage.setItem(TIMELINE_H_KEY, String(Math.round(h)));
    } catch {
      // không nhớ được - vẫn đổi cho phiên này
    }
  };
  const resizeRef = useRef<{ startY: number; startH: number; pointerId: number } | null>(null);
  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { startY: e.clientY, startH: timelineHeight, pointerId: e.pointerId };
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    const h = Math.min(maxTimelineHeight(), Math.max(TIMELINE_H_MIN, r.startH - (e.clientY - r.startY)));
    setTimelineHeight(h);
  };
  const onResizeUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    resizeRef.current = null;
    persistHeight(timelineHeight);
  };

  // ================================================================ khung

  const api = useMemo<EditorApi>(
    () => ({
      fps,
      vertical: (info?.project.height ?? 0) > (info?.project.width ?? 0),
      ops: opsCtx,
      readOnly,
      selection: state.selection,
      edit,
      select,
      endCoalesce,
      seek,
      playback,
    }),
    [fps, info, opsCtx, readOnly, state.selection, edit, select, endCoalesce, seek, playback],
  );

  const menuItems = useMemo<EditorMenuItem[]>(
    () => [
      // GIAI ĐOẠN 3: thêm "Lịch sử phiên bản", "Xuất XML (Premiere/DaVinci)"… vào đây
      { id: "shortcuts", label: t("editor.menu.shortcuts"), icon: Keyboard, onSelect: () => setShortcutsOpen(true) },
      {
        id: "project",
        label: t("editor.menu.project"),
        icon: LayoutDashboard,
        onSelect: () => router.push(`/projects/${encodeURIComponent(projectId)}`),
      },
    ],
    [t, router, projectId],
  );

  const onSessionStarted = useCallback(
    (id: string) => {
      projectSessions.current.add(id);
      foreignSessions.current.delete(id);
      onProjectAgentEvent("start", id, undefined);
    },
    [onProjectAgentEvent],
  );

  const sel = state.selection;
  const inspectorActions: InspectorActions = {
    split: splitAction,
    duplicate: duplicateAction,
    remove: deleteAction,
    canSplit:
      !!timeline &&
      !!sel &&
      (isCueSel(sel.kind) ||
        (sel.kind === "scene" && sceneIndexById(timeline, sel.id) >= 0 && canSplitScene(timeline.scenes[sceneIndexById(timeline, sel.id)], fps))),
    canDuplicate: !!timeline && canDuplicate(timeline, sel),
    canDelete: !!timeline && canDelete(timeline, sel),
  };

  // ---------------------------------------------------------------- trạng thái lỗi/tải

  if (loadError && !timeline) {
    return (
      <div className="flex flex-col gap-4">
        <ErrorBanner
          message={loadError.message}
          detail={loadError.detail}
          actions={
            loadError.notFound ? (
              <LinkButton href="/projects" small>
                {t("editor.load.back-projects")}
              </LinkButton>
            ) : (
              <Button variant="secondary" small onClick={() => void load()}>
                {t("common.retry")}
              </Button>
            )
          }
        />
      </div>
    );
  }

  if (!timeline || !info) {
    return (
      <div className="editor-root" aria-busy="true" aria-label={t("editor.loading")}>
        <Skeleton className="h-9 w-full" />
        <div className="editor-main">
          <div className="editor-center">
            <Skeleton className="editor-stage w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
          <Skeleton className="editor-inspector h-64 w-full" />
        </div>
        <Skeleton className="w-full" height={TIMELINE_H_DEFAULT} />
      </div>
    );
  }

  let saveState: SaveState = "saved";
  if (readOnly) saveState = dirty ? "unsaved" : "readonly";
  else if (state.savingRevision !== null) saveState = "saving";
  else if (problem?.kind === "conflict") saveState = "conflict";
  else if (problem?.kind === "invalid") saveState = "invalid";
  else if (problem?.kind === "error") saveState = "error";
  else if (dirty) saveState = "unsaved";

  const project = info.project;
  const subtitle = `${project.width}×${project.height} · ${project.fps}fps`;
  const showRenderStale = renderActive && renderBaseline !== null && state.revision !== renderBaseline;

  return (
    <EditorContext.Provider value={api}>
      <div className="editor-root">
        <EditorTopBar
          projectId={projectId}
          name={project.name || project.id}
          subtitle={subtitle}
          saveState={saveState}
          onRetrySave={retrySave}
          canUndo={!readOnly && state.past.length > 0}
          canRedo={!readOnly && state.future.length > 0}
          onUndo={undo}
          onRedo={redo}
          activeJob={activeJobs[0] ?? null}
          activeCount={activeJobs.length}
          lastOutput={lastOutput}
          renderBusy={renderStarting}
          renderDisabled={problem?.kind === "conflict" || timeline.scenes.length === 0}
          onRender={(q) => void startRender(q)}
          menuItems={menuItems}
        />

        {readOnly && <Banner tone="info" message={t("editor.banner.agent-busy")} />}

        {problem?.kind === "conflict" && (
          <Banner
            tone="danger"
            message={t("editor.banner.conflict")}
            actions={
              <>
                <Button variant="secondary" small onClick={loadLatest}>
                  {t("editor.banner.load-latest")}
                </Button>
                <Button small onClick={keepMine}>
                  {t("editor.banner.keep-mine")}
                </Button>
              </>
            }
          />
        )}

        {problem?.kind === "invalid" && (
          <IssuesBanner
            message={t("editor.banner.invalid")}
            detail={problem.message}
            issues={problem.issues}
            onPick={(path) => {
              const target = selectionFromIssuePath(path, timeline);
              if (target) select(target);
            }}
          />
        )}

        {problem?.kind === "error" && (
          <ErrorBanner
            message={t("editor.banner.save-error")}
            detail={problem.message}
            actions={
              <Button variant="secondary" small onClick={retrySave}>
                {t("editor.save.retry")}
              </Button>
            }
          />
        )}

        {renderProblem &&
          (renderProblem.issues.length > 0 ? (
            <IssuesBanner
              message={renderProblem.message}
              detail={renderProblem.detail}
              issues={renderProblem.issues}
              onPick={(path) => {
                const target = selectionFromIssuePath(path, timeline);
                if (target) select(target);
              }}
              onDismiss={() => setRenderProblem(null)}
            />
          ) : (
            <Banner
              tone="danger"
              message={renderProblem.message}
              detail={renderProblem.detail}
              actions={
                <>
                  {renderProblem.force && (
                    <Button
                      variant="secondary"
                      small
                      disabled={renderStarting}
                      onClick={() => void startRender("final", true)}
                    >
                      {t("editor.render.force")}
                    </Button>
                  )}
                  <Button variant="secondary" small onClick={() => setRenderProblem(null)}>
                    {t("common.close")}
                  </Button>
                </>
              }
            />
          ))}

        {failedJob && (
          <Banner
            tone="danger"
            message={t("editor.render.failed")}
            detail={failedJob.step || null}
            actions={
              <>
                <LinkButton href="/queue" small>
                  {t("editor.render.open-queue")}
                </LinkButton>
                <Button variant="secondary" small onClick={() => setRenderBatch([])}>
                  {t("common.close")}
                </Button>
              </>
            }
          />
        )}

        {showRenderStale && <Banner tone="info" message={t("editor.banner.render-stale")} />}
        {notice && <Banner tone="muted" message={notice} />}

        <div className="editor-main">
          <div className="editor-center">
            <div className="editor-stage">
              {timeline.scenes.length > 0 ? (
                <PreviewPlayer
                  ref={attachPlayer}
                  projectId={projectId}
                  timeline={timeline}
                  project={info.project}
                  preview={info.preview}
                  controls={false}
                />
              ) : (
                // Project chưa có scene: composition cần ≥ 1 scene, hiện lỗi
                // schema "scenes: Invalid input" ở đây là đúng mà vô ích
                <div className="flex h-full items-center justify-center">
                  <EmptyState
                    icon={Clapperboard}
                    title={t("editor.empty.title")}
                    description={t("editor.empty.body")}
                  />
                </div>
              )}
            </div>
            <Transport
              totalFrames={totalFrames}
              onToggle={togglePlay}
              onStep={step}
              disabled={timeline.scenes.length === 0}
            />
          </div>
          <Inspector timeline={timeline} spans={spans} preview={info.preview} actions={inspectorActions} />
        </div>

        <div
          className="editor-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("editor.timeline.resize")}
          aria-valuenow={Math.round(timelineHeight)}
          aria-valuemin={TIMELINE_H_MIN}
          tabIndex={0}
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const h = Math.min(
              maxTimelineHeight(),
              Math.max(TIMELINE_H_MIN, timelineHeight + (e.key === "ArrowUp" ? 24 : -24)),
            );
            setTimelineHeight(h);
            persistHeight(h);
          }}
        />

        <TimelinePanel
          timeline={timeline}
          spans={spans}
          totalFrames={totalFrames}
          preview={info.preview}
          height={timelineHeight}
        />

        <EditorChat projectId={projectId} onSessionStarted={onSessionStarted} beforeSend={flushSave} />
        <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      </div>
    </EditorContext.Provider>
  );
}

function IssuesBanner({
  message,
  detail,
  issues,
  onPick,
  onDismiss,
}: {
  message: string;
  detail?: string;
  issues: TimelineIssue[];
  onPick: (path: string) => void;
  onDismiss?: () => void;
}) {
  const { t } = useT();
  return (
    <Banner
      tone="danger"
      message={message}
      detail={detail}
      actions={
        onDismiss ? (
          <Button variant="secondary" small onClick={onDismiss}>
            {t("common.close")}
          </Button>
        ) : undefined
      }
    >
      <ul className="mt-2 flex max-h-32 flex-col gap-1 overflow-y-auto text-meta">
        {issues.slice(0, 20).map((issue, i) => (
          <li key={`${issue.path}-${i}`}>
            <button
              type="button"
              className="text-left underline-offset-2 hover:underline"
              onClick={() => onPick(issue.path)}
              title={t("editor.banner.issue-select")}
            >
              <span className="font-mono">{issue.path}</span>: {issue.message}
            </button>
          </li>
        ))}
      </ul>
    </Banner>
  );
}
