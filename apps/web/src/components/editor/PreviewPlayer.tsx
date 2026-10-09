"use client";

/**
 * Trình phát XEM TRƯỚC của trình chỉnh sửa: chạy thẳng composition `Assemble`
 * của engine Remotion trong trình duyệt bằng `@remotion/player` - không render,
 * không mã hóa gì ở trình duyệt (docs/EDITOR-PLAN.md mục 3).
 *
 * Khác bản render qua CLI ở đúng một chỗ: đường dẫn media. Render dùng
 * props.resolved.json (đường dẫn `staging/...`, nạp bằng staticFile), còn ở đây
 * timeline giữ đường dẫn TƯƠNG ĐỐI PROJECT và resolver đổi chúng sang
 * `/media/video-projects/<id>/...` của backend; font overlay `fonts/...` đi qua
 * `/media/remotion-fonts/...`.
 *
 * Cách dùng (cha phải cho khung một kích thước xác định khi fit="contain"):
 *
 *   const playerRef = useRef<PlayerRef>(null);
 *   <div className="min-h-0 flex-1">
 *     <PreviewPlayer ref={playerRef} projectId={id} timeline={timeline}
 *       project={project} preview={preview} />
 *   </div>
 *   playerRef.current?.seekTo(frame); playerRef.current?.play();
 *   playerRef.current?.addEventListener("frameupdate", (e) => e.detail.frame);
 *
 * `ref` là null khi timeline không hợp lệ (đang hiện danh sách lỗi thay vì
 * Player) và ở nhịp render đầu tiên (Player chỉ gắn vào sau khi đo xong khung)
 * - muốn đăng ký sự kiện ngay khi Player có mặt thì dùng callback ref (React 19
 * cho callback ref trả về hàm dọn dẹp).
 */

import { Player, type ErrorFallback, type PlayerRef } from "@remotion/player";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import { Assemble } from "@engine/Assemble";
import {
  manifestSchema,
  resolveSceneDurationInFrames,
  totalDurationInFrames,
  type Manifest,
} from "@engine/manifest";
import { MediaResolverProvider, type MediaResolver } from "@engine/media";
import { Banner } from "@/components/Banner";
import { mediaUrl } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type {
  EditorPreview,
  EditorProjectInfo,
  EditorScene,
  EditorTimeline,
} from "./types";

export type { PlayerRef } from "@remotion/player";

// ---------------------------------------------------------------- resolver

/** Mã hóa TỪNG đoạn đường dẫn (tên file có dấu cách, `#`, `?`, chữ có dấu…). */
const encodeSegments = (rel: string): string =>
  rel
    .split(/[\\/]+/)
    .filter((seg) => seg !== "" && seg !== ".")
    .map(encodeURIComponent)
    .join("/");

const FONT_PREFIX = "fonts/";

/**
 * Resolver media cho trình phát: `fonts/…` → font overlay của engine, còn lại
 * là đường dẫn tương đối thư mục project.
 *
 * `mediaVersions` (relPath → mtimeMs, từ `preview.mediaVersions`) thêm `?v=` vào
 * URL: scene render lại GHI ĐÈ đúng đường dẫn cũ (renders/<id>.mp4), không có
 * phiên bản thì trình duyệt phát mãi bản trong cache. Thiếu version = không `?v`.
 * Font không bao giờ gắn version (file tĩnh của engine).
 */
export function projectMediaResolver(
  projectId: string,
  mediaVersions?: Record<string, number> | null,
): MediaResolver {
  const projectBase = `video-projects/${encodeURIComponent(projectId)}`;
  return (rel: string) => {
    if (rel.startsWith(FONT_PREFIX)) {
      return mediaUrl(`remotion-fonts/${encodeSegments(rel.slice(FONT_PREFIX.length))}`);
    }
    const version = mediaVersions?.[rel];
    const query =
      typeof version === "number" && Number.isFinite(version)
        ? `?v=${encodeURIComponent(String(Math.round(version)))}`
        : "";
    return mediaUrl(`${projectBase}/${encodeSegments(rel)}${query}`);
  };
}

// ---------------------------------------------------------------- manifest

export interface PreviewIssue {
  /** Đường dẫn trong manifest, vd "scenes.2.durationInFrames" ("" = gốc) */
  path: string;
  /** Thông điệp gốc (zod - tiếng Anh) */
  message: string;
  /** Lỗi do trình phát tự kiểm - giao diện dịch theo mã này thay cho `message` */
  code?: "scene-duration";
  sceneId?: string;
}

export type PreviewBuild =
  | { ok: true; manifest: Manifest; durationInFrames: number }
  | { ok: false; issues: PreviewIssue[] };

/** Thời lượng frame như jobs/assemble.ts `frameOf` - null = chưa suy ra được. */
const sceneFrames = (scene: EditorScene, fps: number): number | null => {
  if (typeof scene.durationInFrames === "number") return scene.durationInFrames;
  if (
    typeof scene.srcVideo === "string" &&
    scene.srcVideo &&
    typeof scene.from === "number" &&
    typeof scene.to === "number"
  ) {
    return Math.max(1, Math.round(scene.to * fps) - Math.round(scene.from * fps));
  }
  return null;
};

/**
 * Dựng manifest cho Assemble từ dữ liệu GET /timeline, theo đúng các bước
 * jobs/assemble.ts làm trước khi render (trừ phần stage file):
 * - scene HyperFrames (`src`): `render` := preview.sceneRenders[id]; chưa
 *   render thì bỏ `render` → SceneClip hiện placeholder sẵn có;
 * - scene footage/ảnh còn sót `render` cũ: bỏ (footage thắng);
 * - kẹp `transitionOverlap` về min(scene này, scene kế);
 * - watermark := preview.watermark.
 * Không bao giờ ném lỗi: sai schema → `{ ok: false, issues }`.
 * Khóa top-level `null` (captions/subtitles/overlays/subtitleStyle/audio - meta
 * do agent ghi tay có thể có) coi như VẮNG MẶT → mặc định, đúng như server
 * chuẩn hóa trước khi render.
 *
 * Không đụng vào object đầu vào (scene được sao nông trước khi sửa).
 */
export function buildPreviewManifest({
  timeline,
  project,
  preview,
}: {
  timeline: EditorTimeline;
  project: EditorProjectInfo;
  preview: EditorPreview;
}): PreviewBuild {
  const scenes: EditorScene[] = (timeline.scenes ?? []).map((original) => {
    const scene: EditorScene = { ...original };
    if (typeof scene.src === "string" && scene.src) {
      const render = preview.sceneRenders?.[scene.id];
      if (typeof render === "string" && render) scene.render = render;
      else delete scene.render;
    } else if (
      (typeof scene.srcVideo === "string" && scene.srcVideo) ||
      (typeof scene.srcImage === "string" && scene.srcImage)
    ) {
      delete scene.render;
    }
    return scene;
  });

  for (let i = 0; i < scenes.length - 1; i += 1) {
    const overlap = scenes[i].transitionOverlap;
    if (typeof overlap !== "number" || overlap <= 0) continue;
    const cur = sceneFrames(scenes[i], project.fps);
    const next = sceneFrames(scenes[i + 1], project.fps);
    if (cur === null || next === null) continue;
    const limit = Math.max(0, Math.min(cur, next));
    if (overlap > limit) scenes[i].transitionOverlap = limit;
  }

  const audio = timeline.audio ?? { voice: null, sfx: [], music: null };
  const raw = {
    id: project.id,
    name: project.name,
    width: project.width,
    height: project.height,
    fps: project.fps,
    status: project.status ?? "draft",
    scenes,
    audio: {
      ...audio,
      voice: audio.voice ?? null,
      sfx: audio.sfx ?? [],
      music: audio.music ?? null,
    },
    captions: timeline.captions ?? [],
    subtitles: timeline.subtitles ?? [],
    // schema chỉ nhận object hoặc thiếu hẳn - null nghĩa là "mặc định"
    ...(timeline.subtitleStyle ? { subtitleStyle: timeline.subtitleStyle } : {}),
    overlays: timeline.overlays ?? [],
    watermark: preview.watermark ?? null,
  };

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    };
  }

  // Schema không bắt được scene thiếu thời lượng (Assemble ném lỗi lúc dựng
  // timeline) - kiểm trước để hiện thành lỗi thay vì làm sập trình phát.
  const issues: PreviewIssue[] = [];
  parsed.data.scenes.forEach((scene, index) => {
    try {
      resolveSceneDurationInFrames(scene, parsed.data.fps);
    } catch (err) {
      issues.push({
        path: `scenes.${index}`,
        message: err instanceof Error ? err.message : String(err),
        code: "scene-duration",
        sceneId: scene.id,
      });
    }
  });
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    manifest: parsed.data,
    durationInFrames: Math.max(1, totalDurationInFrames(parsed.data)),
  };
}

// ---------------------------------------------------------------- player

type PreviewInputProps = {
  manifest: Manifest;
  projectId: string;
  /** relPath → mtimeMs; identity giữ ổn định theo NỘI DUNG (xem PreviewPlayer) */
  mediaVersions: Record<string, number> | null;
};

/** Composition chạy trong Player: Assemble bọc resolver media của project. */
const PreviewComposition = ({ manifest, projectId, mediaVersions }: PreviewInputProps) => {
  const resolve = useMemo(
    () => projectMediaResolver(projectId, mediaVersions),
    [projectId, mediaVersions],
  );
  return (
    <MediaResolverProvider resolve={resolve}>
      <Assemble {...manifest} />
    </MediaResolverProvider>
  );
};

export interface PreviewPlayerProps {
  projectId: string;
  timeline: EditorTimeline;
  project: EditorProjectInfo;
  preview: EditorPreview;
  /** Điều khiển PlayerRef (seekTo/play/pause/getCurrentFrame, sự kiện frameupdate…) */
  ref?: Ref<PlayerRef>;
  /** Thanh điều khiển có sẵn của Remotion. Mặc định bật. */
  controls?: boolean;
  /**
   * "contain" (mặc định): lấp khung cha theo cả hai chiều, giữ tỉ lệ khung hình
   * - cha PHẢI có chiều cao xác định. "width": rộng 100%, cao theo tỉ lệ.
   */
  fit?: "contain" | "width";
  className?: string;
}

export function PreviewPlayer({
  projectId,
  timeline,
  project,
  preview,
  ref,
  controls = true,
  fit = "contain",
  className,
}: PreviewPlayerProps) {
  const { t, tf } = useT();

  const build = useMemo(
    () => buildPreviewManifest({ timeline, project, preview }),
    [timeline, project, preview],
  );

  // Version media giữ identity theo NỘI DUNG: GET /timeline trả object mới mỗi
  // lần tải lại dù không file nào đổi - đổi identity là resolver đổi, mọi thẻ
  // media nạp lại từ đầu.
  const versionsKey = JSON.stringify(preview.mediaVersions ?? null);
  const mediaVersions = useMemo<Record<string, number> | null>(
    () => {
      const parsed: unknown = JSON.parse(versionsKey);
      if (!parsed || typeof parsed !== "object") return null;
      const out: Record<string, number> = {};
      for (const [rel, v] of Object.entries(parsed)) {
        if (typeof v === "number") out[rel] = v;
      }
      return out;
    },
    [versionsKey],
  );

  // inputProps đổi identity là Player render lại cả cây - chỉ đổi khi dữ liệu đổi
  const inputProps = useMemo<PreviewInputProps | null>(
    () => (build.ok ? { manifest: build.manifest, projectId, mediaVersions } : null),
    [build, projectId, mediaVersions],
  );

  const errorFallback: ErrorFallback = useCallback(
    ({ error }) => (
      <div className="p-4">
        <Banner tone="danger" message={t("editor.player.crashed")} detail={error.message} />
      </div>
    ),
    [t],
  );

  // ---- khung: đo kích thước cha, Player lấp vừa theo tỉ lệ composition ----
  // Callback ref (state) chứ không useRef: khung chỉ xuất hiện khi timeline
  // hợp lệ, effect phải chạy lại đúng lúc nó gắn vào DOM.
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = boxEl;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setBox((prev) => {
        // Khung tạm co về 0 (gập panel, đổi bố cục) thì giữ cỡ cũ: bỏ Player
        // ra khỏi cây là mất vị trí phát và phải nạp lại toàn bộ media.
        if (width <= 0 || height <= 0) return prev;
        return prev && prev.w === width && prev.h === height ? prev : { w: width, h: height };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [boxEl]);

  if (!build.ok || !inputProps) {
    const issues = build.ok ? [] : build.issues;
    return (
      <div className={className}>
        <Banner tone="danger" message={t("editor.player.invalid")}>
          <ul className="mt-2 flex flex-col gap-1 text-meta">
            {issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                <span className="font-mono">{issue.path || t("editor.player.issue-root")}</span>
                {": "}
                {issue.code === "scene-duration"
                  ? tf("editor.player.scene-no-duration", { id: issue.sceneId ?? "" })
                  : issue.message}
              </li>
            ))}
          </ul>
        </Banner>
      </div>
    );
  }

  const { width, height, fps } = build.manifest;
  const aspect = width / height;

  const player = (style: CSSProperties) => (
    <Player
      ref={ref}
      component={PreviewComposition}
      inputProps={inputProps}
      durationInFrames={build.durationInFrames}
      compositionWidth={width}
      compositionHeight={height}
      fps={fps}
      controls={controls}
      // Số thẻ <audio> dùng chung KHÔNG được đổi sau khi mount (Remotion ném
      // lỗi), mà mỗi sfx là một <Audio> còn gắn tới hết video - giới hạn mặc
      // định 5 sẽ sập ngay ở project có vài sfx. 0 = mỗi <Audio> tự có thẻ riêng;
      // play() luôn đi từ thao tác của người dùng nên không vướng chặn autoplay.
      numberOfSharedAudioTags={0}
      errorFallback={errorFallback}
      style={style}
    />
  );

  if (fit === "width") {
    return <div className={className}>{player({ width: "100%" })}</div>;
  }

  let size: { width: number; height: number } | null = null;
  if (box && box.w > 0 && box.h > 0) {
    const w = Math.floor(Math.min(box.w, box.h * aspect));
    size = { width: w, height: Math.floor(w / aspect) };
  }

  return (
    <div ref={setBoxEl} className={`relative h-full w-full min-h-0 min-w-0 ${className ?? ""}`}>
      {size && (
        <div className="absolute inset-0 flex items-center justify-center">
          {player(size)}
        </div>
      )}
    </div>
  );
}
