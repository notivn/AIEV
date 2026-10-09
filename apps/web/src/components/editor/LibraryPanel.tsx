"use client";

/**
 * Cột Thư viện bên trái trình phát: file của project (video/ảnh/âm thanh), thư
 * viện hiệu ứng âm dùng chung và thư viện nhạc nền. Kéo một món thả lên
 * timeline, hoặc bấm "+" (bàn phím) để thêm tại playhead - cả hai đi chung
 * `onAdd`/`onDrop` của trang (VideoEditor), cột này không tự sửa timeline.
 *
 * Nghe thử: MỘT phần tử <audio> dùng chung cho cả cột - bấm món khác là món
 * đang phát dừng, gấp cột/rời trang là dừng hẳn. Không mỗi hàng một <audio>
 * (88 hiệu ứng = 88 phần tử media nạp metadata cùng lúc).
 */

import {
  AudioLines,
  FolderOpen,
  Image as ImageIcon,
  Library,
  Loader2,
  Music,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  SearchX,
  Video,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { IconButton } from "@/components/IconButton";
import { Segmented } from "@/components/Segmented";
import { Skeleton } from "@/components/Skeleton";
import { Toolbar } from "@/components/Toolbar";
import {
  getLibraryMusic,
  getLibrarySfx,
  getMediaInfo,
  getProject,
  mediaUrl,
  type FileInfo,
  type LibraryItem as ApiLibraryItem,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { projectRelPath, writeDragData, type LibraryItem } from "./library";

type Tab = "project" | "sfx" | "music";


export const libraryItemKey = (item: LibraryItem): string =>
  item.source === "project" ? `project:${item.relPath}` : `${item.source}:${item.file}`;

function fmtDuration(sec: number | null | undefined): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return null;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();

interface Row {
  item: LibraryItem;
  key: string;
  icon: LucideIcon;
  title: string;
  meta: string;
  /** URL nghe thử - chỉ món âm thanh */
  audioUrl: string | null;
}

export function LibraryPanel({
  projectId,
  collapsed,
  onCollapsedChange,
  readOnly,
  busyKey,
  refreshKey,
  onAdd,
}: {
  projectId: string;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  readOnly: boolean;
  /** Món đang được thêm (chép từ thư viện vào project…) */
  busyKey: string | null;
  /** Đổi giá trị = tải lại danh sách file của project (vừa chép file mới vào) */
  refreshKey: number;
  onAdd: (item: LibraryItem) => void;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>("project");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);

  // ---- dữ liệu (mỗi tab tải khi mở lần đầu)
  const [assets, setAssets] = useState<FileInfo[] | null>(null);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [durations, setDurations] = useState<Record<string, number | null>>({});
  const [sfx, setSfx] = useState<ApiLibraryItem[] | null>(null);
  const [music, setMusic] = useState<ApiLibraryItem[] | null>(null);
  const [libError, setLibError] = useState<{ tab: Tab; message: string } | null>(null);

  const loadAssets = useCallback(async () => {
    try {
      const detail = await getProject(projectId);
      setAssets(
        detail.files.assets.filter((f) => f.kind === "video" || f.kind === "image" || f.kind === "audio"),
      );
      setAssetsError(null);
    } catch (err) {
      setAssetsError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    if (collapsed) return;
    void loadAssets();
  }, [collapsed, loadAssets, refreshKey]);

  // Thời lượng video/âm thanh của project: đo bằng media-info (ffprobe, server cache)
  // Đo mỗi file MỘT lần (theo relPath + mtime: file bị thay cùng tên thì đo lại).
  const measured = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!assets) return;
    const todo = assets.filter(
      (f) => f.kind !== "image" && !measured.current.has(`${f.relPath}@${f.mtime}`),
    );
    if (todo.length === 0) return;
    todo.forEach((f) => measured.current.add(`${f.relPath}@${f.mtime}`));
    // Tối đa 4 lượt ffprobe song song - project nhiều file không dội server
    const queue = todo.slice();
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        let sec: number | null = null;
        try {
          sec = (await getMediaInfo(projectId, projectRelPath(f.relPath, projectId))).durationSec;
        } catch {
          sec = null;
        }
        if (!mounted.current) return;
        const rel = f.relPath;
        setDurations((d) => ({ ...d, [rel]: sec }));
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
  }, [assets, projectId]);

  const loadLibrary = useCallback(async (which: "sfx" | "music") => {
    try {
      if (which === "sfx") setSfx(await getLibrarySfx());
      else setMusic(await getLibraryMusic());
      setLibError((e) => (e?.tab === which ? null : e));
    } catch (err) {
      setLibError({ tab: which, message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    if (collapsed) return;
    if (tab === "sfx" && sfx === null) void loadLibrary("sfx");
    if (tab === "music" && music === null) void loadLibrary("music");
  }, [collapsed, tab, sfx, music, loadLibrary]);

  // ---- nghe thử: một <audio> dùng chung
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    setPlaying(null);
  }, []);

  const togglePlay = (row: Row) => {
    const el = audioRef.current;
    if (!el || !row.audioUrl) return;
    if (playing === row.key) {
      stop();
      return;
    }
    el.pause();
    el.src = row.audioUrl;
    setPlaying(row.key);
    el.play().catch(() => setPlaying((p) => (p === row.key ? null : p)));
  };

  // Gấp cột / rời trang → dừng (phần tử <audio> unmount thì trình duyệt cũng dừng,
  // nhưng gấp cột không unmount nó)
  useEffect(() => {
    if (collapsed) stop();
  }, [collapsed, stop]);
  useEffect(() => {
    const el = audioRef.current;
    return () => el?.pause();
  }, []);

  // ---- danh sách đang hiện
  const q = fold(query.trim());

  // Lọc theo tag bằng MỘT ô chọn, không phải chip: thư viện có ~70 tag, cột
  // rộng 260px - chip chiếm hết chỗ của chính danh sách cần lọc
  const sfxTags = useMemo(() => {
    const count = new Map<string, number>();
    for (const e of sfx ?? []) for (const tg of e.tags) count.set(tg, (count.get(tg) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [sfx]);

  // Đổi tab / bộ lọc → danh sách về đầu (không thì đang cuộn giữa danh sách dài,
  // lọc còn vài món là chúng nằm khuất phía trên)
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [tab, query, tag]);

  const rows: Row[] | null = useMemo(() => {
    const match = (...parts: string[]) => !q || parts.some((p) => fold(p).includes(q));
    if (tab === "project") {
      if (!assets) return null;
      return assets
        .filter((f) => match(f.name, f.description ?? ""))
        .map((f) => {
          const rel = projectRelPath(f.relPath, projectId);
          const kind = f.kind === "video" ? "video" : f.kind === "image" ? "image" : "audio";
          const item: LibraryItem = { source: "project", kind, relPath: rel, name: f.name };
          const dur = fmtDuration(durations[f.relPath]);
          const kindLabel =
            kind === "video"
              ? t("editor.library.kind-video")
              : kind === "image"
                ? t("editor.library.kind-image")
                : t("editor.library.kind-audio");
          const folder = rel.split("/").slice(1, -1).join("/");
          return {
            item,
            key: libraryItemKey(item),
            icon: kind === "video" ? Video : kind === "image" ? ImageIcon : AudioLines,
            title: f.name,
            meta: [kindLabel, dur, folder ? `${folder}/` : null, f.description || null]
              .filter(Boolean)
              .join(" · "),
            audioUrl: kind === "audio" ? mediaUrl(f.relPath) : null,
          };
        });
    }
    const list = tab === "sfx" ? sfx : music;
    if (!list) return null;
    return list
      .filter((e) => match(e.file, e.description, ...e.tags))
      .filter((e) => tab !== "sfx" || !tag || e.tags.includes(tag))
      .map((e) => {
        const item: LibraryItem = { source: tab, file: e.file, name: e.file };
        return {
          item,
          key: libraryItemKey(item),
          icon: tab === "sfx" ? AudioLines : Music,
          title: e.description || e.file,
          meta: [fmtDuration(e.durationMs === null ? null : e.durationMs / 1000), e.description ? e.file : null]
            .filter(Boolean)
            .join(" · "),
          audioUrl: mediaUrl(`assets/${tab === "sfx" ? "sound-effects" : "music"}/${e.file}`),
        };
      });
  }, [tab, assets, sfx, music, q, tag, durations, projectId, t]);

  // ---------------------------------------------------------------- vẽ

  const audio = <audio ref={audioRef} preload="none" onEnded={() => setPlaying(null)} onError={() => setPlaying(null)} hidden />;

  if (collapsed) {
    return (
      <aside className="editor-library is-collapsed" aria-label={t("editor.library.title")}>
        {audio}
        <IconButton
          label={t("editor.library.expand")}
          aria-expanded={false}
          aria-controls="editor-library"
          onClick={() => onCollapsedChange(false)}
        >
          <PanelLeftOpen size={16} strokeWidth={1.75} />
        </IconButton>
        <span className="editor-library-strip-label text-meta font-medium">{t("editor.library.title")}</span>
      </aside>
    );
  }

  const error = tab === "project" ? assetsError : libError?.tab === tab ? libError.message : null;
  const retry = () => (tab === "project" ? void loadAssets() : void loadLibrary(tab));

  let body;
  if (error && rows === null) {
    body = (
      <ErrorBanner
        message={t("editor.library.load-error")}
        detail={error}
        actions={
          <Button variant="secondary" small onClick={retry}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  } else if (rows === null) {
    body = (
      <div className="flex flex-col gap-2" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  } else if (rows.length === 0) {
    const searching = q !== "" || (tab === "sfx" && tag !== null);
    body = searching ? (
      <EmptyState icon={SearchX} description={t("editor.library.no-match")} />
    ) : tab === "project" ? (
      <EmptyState
        icon={FolderOpen}
        title={t("editor.library.project-empty-title")}
        description={t("editor.library.project-empty")}
      />
    ) : tab === "music" ? (
      <EmptyState
        icon={Music}
        title={t("editor.library.music-empty-title")}
        description={t("editor.library.music-empty")}
      />
    ) : (
      <EmptyState icon={AudioLines} description={t("editor.library.sfx-empty")} />
    );
  } else {
    body = (
      <ul className="flex flex-col gap-1" aria-label={t("editor.library.items")}>
        {rows.map((row) => {
          const busy = busyKey === row.key;
          const isPlaying = playing === row.key;
          return (
            <li
              key={row.key}
              className="lib-item"
              draggable={!readOnly}
              data-lib-key={row.key}
              title={readOnly ? undefined : t("editor.library.drag-hint")}
              onDragStart={(e) => writeDragData(e.dataTransfer, row.item)}
            >
              <row.icon size={16} strokeWidth={1.75} className="lib-item-icon" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={row.title}>
                  {row.title}
                </p>
                {row.meta && <p className="truncate text-meta text-[var(--text-muted)]">{row.meta}</p>}
              </div>
              {row.audioUrl && (
                <IconButton
                  label={isPlaying ? t("editor.library.stop") : t("editor.library.play")}
                  size="sm"
                  aria-pressed={isPlaying}
                  onClick={() => togglePlay(row)}
                >
                  {isPlaying ? <Pause size={13} strokeWidth={2} /> : <Play size={13} strokeWidth={2} />}
                </IconButton>
              )}
              <IconButton
                label={
                  row.item.source === "music" ? t("editor.library.add-music") : t("editor.library.add")
                }
                size="sm"
                disabled={readOnly || busyKey !== null}
                onClick={() => onAdd(row.item)}
              >
                {busy ? (
                  <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Plus size={13} strokeWidth={2} />
                )}
              </IconButton>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <aside id="editor-library" className="editor-library" aria-label={t("editor.library.title")}>
      {audio}
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Library size={16} strokeWidth={1.75} className="text-[var(--text-muted)]" aria-hidden="true" />
          {t("editor.library.title")}
        </h2>
        <IconButton
          label={t("editor.library.collapse")}
          aria-expanded={true}
          aria-controls="editor-library"
          onClick={() => onCollapsedChange(true)}
        >
          <PanelLeftClose size={16} strokeWidth={1.75} />
        </IconButton>
      </div>
      <Segmented
        label={t("editor.library.tabs")}
        value={tab}
        onChange={(next) => {
          setTab(next);
          setTag(null);
        }}
        options={[
          { value: "project", label: t("editor.library.tab-project") },
          { value: "sfx", label: t("editor.library.tab-sfx") },
          { value: "music", label: t("editor.library.tab-music") },
        ]}
        className="shrink-0"
      />
      {/* Toolbar tự có mb-3 (nó vốn đứng trên một bảng) - ở đây cột đã có gap */}
      <div className="shrink-0 [&>div]:mb-0">
        <Toolbar search={{ value: query, onChange: setQuery, placeholder: t("editor.library.search") }}>
          {tab === "sfx" && sfxTags.length > 0 && (
            <select
              className="input h-8 w-full"
              aria-label={t("editor.library.tag")}
              value={tag ?? ""}
              onChange={(e) => setTag(e.target.value || null)}
            >
              <option value="">{t("editor.library.tag-all")}</option>
              {sfxTags.map(([name, n]) => (
                <option key={name} value={name}>
                  {`${name} (${n})`}
                </option>
              ))}
            </select>
          )}
        </Toolbar>
      </div>
      <div ref={listRef} className="editor-library-list">
        {body}
      </div>
      <p className="shrink-0 text-meta text-[var(--text-muted)]">
        {readOnly ? t("editor.library.readonly") : t("editor.library.hint")}
      </p>
    </aside>
  );
}
