"use client";

/**
 * Chi tiết một Videos Project - lắp bằng bộ khối workspace 3 cột dùng chung
 * (`components/Workspace.tsx`), chia theo NHỊP LÀM VIỆC chứ không theo số bước:
 *
 * - Cột `source`: video gốc và toàn bộ asset (tải lên, quét QR từ điện thoại,
 *   chỉnh màu từng file) - thứ mình BẮT ĐẦU TỪ ĐÓ.
 * - Cột `setup`: kịch bản edit (Brief: màu/font, phong cách dựng, phụ đề, key…),
 *   hàng nút bắt đầu edit bằng AI, duyệt bản draft và cắt short - "mình muốn ra
 *   cái gì".
 * - Cột `output`: khối video thành phẩm ĐỨNG ĐẦU (đang chạy thì gấp lại còn một
 *   dòng thanh tiến trình, xong thì tự mở ra hiện thẳng video), rồi mới tới
 *   những thứ SINH RA trong lúc chạy: scene, file render, QC, báo cáo cắt tự
 *   động, thumbnail, gói xuất bản.
 *
 * Panel AI là SLOT CỦA SHELL: trang chỉ khai báo <ShellRightPanel> và shell lo bề
 * rộng, chỗ chừa, nút gấp, chế độ drawer. Trước đây trang tự dựng một <aside>
 * `fixed` rồi chừa chỗ bằng `xl:pr-[452px]` - con số đó sai ngay khi người dùng
 * gấp panel lại, và mỗi trang lại phải nhớ tự chừa.
 *
 * Project xong (status "done") thì các khối khác tự gấp lại còn một dòng tóm tắt:
 * lúc đó người dùng vào trang là để XEM video vừa ra, không phải để sửa brief
 * nữa. Riêng khối video thành phẩm theo luật của nó - đang chạy thì gấp (mở ra
 * cũng chỉ có một ô trống), có video thì mở. Gấp/mở vẫn bấm tay được và ý người
 * dùng luôn thắng mặc định - xem `useCollapseGroup` và `outputCollapsed`.
 *
 * Vài card lớn (Nguồn & Asset, QC, Gói xuất bản, Duyệt draft, Cắt short, Cắt tự
 * động) tự nó ĐÃ LÀ một <Card> hoàn chỉnh nên đứng thẳng trong cột chứ không lồng
 * thêm một lớp WorkspaceBlock - lồng vào là card trong card, tiêu đề hiện hai lần.
 */

import {
  ArrowLeft,
  Check,
  Clapperboard,
  Copy,
  ExternalLink,
  Film,
  Maximize2,
  FileQuestion,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Music,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  cleanProjectJunk,
  createJob,
  createThumbnail,
  deleteProject,
  getChatSessions,
  getJobs,
  getProject,
  getProjectJunk,
  mediaUrl,
  renameProject,
  startProjectEdit,
  updateBrief,
  updateProjectTags,
  type AgentEffort,
  type Brief,
  type ChatSession,
  type FileInfo,
  type Job,
  type JobType,
  type ProjectDetail,
  type SceneMeta,
} from "@/lib/api";
import { useAgentEvents, useEvents, useJobEvents } from "@/lib/useEvents";
import { Card } from "@/components/Card";
import { Badge, ProjectBadge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { Panel } from "@/components/Panel";
import { Skeleton } from "@/components/Skeleton";
import { ChatThread } from "@/components/ChatThread";
import { CloneProjectModal } from "@/components/CloneProjectModal";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import {
  AiModelBlock,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
} from "@/components/ModelPicker";
import { EditableTitle } from "@/components/EditableTitle";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { InfoHint } from "@/components/InfoHint";
import {
  MediaPreviewModal,
  RevealButton,
  canPreview,
} from "@/components/MediaPreviewModal";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { deriveStage, PipelineTimeline } from "@/components/PipelineTimeline";
import { ShellRightPanel } from "@/components/Shell";
import {
  BriefFields,
  DEFAULT_BRIEF,
  SFX_MODE_LABEL,
} from "@/components/BriefFields";
import { ProjectAssetsCard } from "@/components/ProjectAssetsCard";
import { ProjectAutoTrimCard } from "@/components/ProjectAutoTrimCard";
import { ProjectClipsCard } from "@/components/ProjectClipsCard";
import { ProjectReviewCard } from "@/components/ProjectReviewCard";
import { ProjectPublishCard } from "@/components/ProjectPublishCard";
import { ProjectQcCard } from "@/components/ProjectQcCard";
import { styleDisplayName, useStyles } from "@/components/StyleSelect";
import {
  OutputBlock,
  useCollapseGroup,
  Workspace,
  WorkspaceBlock,
  WorkspaceColumn,
  type WorkspaceStatus,
} from "@/components/Workspace";
import { formatBytes, formatRelative, isRecentFile } from "@/lib/format";
import {
  SessionStatusBadge,
  sessionStatusLabel,
} from "@/components/SessionStatusBadge";
import { useT } from "@/lib/i18n";

/** Gộp nhiều lần gõ phím thành một PUT brief - không bắn request mỗi ký tự. */
const BRIEF_DEBOUNCE_MS = 700;

/**
 * Các khối của project - key vừa là id state gấp/mở vừa là id vùng nội dung.
 *
 * KHÔNG có "output" ở đây: khối video thành phẩm gấp/mở theo luật riêng ("đã có
 * video chưa" chứ không phải "project xong chưa") nên giữ state riêng - xem
 * `outputCollapsed` trong component.
 */
const PROJECT_BLOCKS = [
  "brief",
  "action",
  "scenes",
  "renders",
  "thumbnail",
] as const;

/**
 * Một mục trong menu "Xem thêm". Ba mục trước đây chép tay ba lần cùng một chuỗi
 * class, và cỡ chữ thì gõ tay 13px thay vì gọi bậc `text-meta`.
 */
const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-left text-meta transition-colors duration-150 hover:bg-[var(--bg-subtle)] disabled:opacity-50";

function KindIcon({ kind }: { kind: FileInfo["kind"] }) {
  const cls = "shrink-0 text-[var(--text-muted)]";
  switch (kind) {
    case "video":
      return <Film size={15} strokeWidth={1.75} className={cls} />;
    case "audio":
      return <Music size={15} strokeWidth={1.75} className={cls} />;
    case "image":
      return <ImageIcon size={15} strokeWidth={1.75} className={cls} />;
    default:
      return <FileText size={15} strokeWidth={1.75} className={cls} />;
  }
}

/** File render của một scene - ưu tiên bản final trước draft. */
function sceneRenderFile(scene: SceneMeta, renders: FileInfo[]): FileInfo | null {
  return (
    renders.find((f) => f.name === `${scene.id}.mp4`) ??
    renders.find((f) => f.name === `${scene.id}.draft.mp4`) ??
    null
  );
}

/** Bảng file render - click hàng mở modal preview lớn, nút Mở file reveal trong Explorer */
function FileTable({ files }: { files: FileInfo[] }) {
  const { t } = useT();
  const [preview, setPreview] = useState<FileInfo | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  if (files.length === 0) {
    return (
      <EmptyState icon={FileQuestion} description={t("project.no-files")} />
    );
  }
  return (
    <>
      {revealError && (
        <div className="mb-3">
          <Banner
            tone="danger"
            message={
              <span className="[overflow-wrap:anywhere]">{revealError}</span>
            }
          />
        </div>
      )}
      {/* Bảng rộng hơn cột workspace → cuộn ngang TRONG khối, không đẩy cả trang */}
      <div className="overflow-x-auto">
      <table className="table min-w-[420px]">
        <thead>
          <tr>
            <th>File</th>
            <th>{t("common.size")}</th>
            <th>{t("common.modified")}</th>
            <th aria-label={t("project.actions-aria")} />
          </tr>
        </thead>
        <tbody>
          {files.map((f) => {
            const previewable = canPreview(f.kind);
            return (
              <tr
                key={f.relPath}
                className={previewable ? "row-click" : undefined}
                onClick={previewable ? () => setPreview(f) : undefined}
              >
                <td>
                  <span className="flex items-center gap-2">
                    <KindIcon kind={f.kind} />
                    {f.name}
                    {/* "mới" là nhãn PHÂN LOẠI, không phải trạng thái → không chấm */}
                    {isRecentFile(f.mtime) && (
                      <Badge tone="running" label={t("common.new")} dot={false} />
                    )}
                  </span>
                </td>
                <td className="text-[var(--text-muted)]">{formatBytes(f.size)}</td>
                <td className="text-[var(--text-muted)]">{formatRelative(f.mtime)}</td>
                <td className="text-right">
                  <RevealButton
                    relPath={f.relPath}
                    onError={setRevealError}
                    className="ml-auto"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      <MediaPreviewModal file={preview} onClose={() => setPreview(null)} />
    </>
  );
}

/**
 * Thân khối Thumbnail: ảnh bìa đã tạo + nút "Tạo thumbnail" (POST đồng bộ ~1 phút).
 * Tách khỏi khối video thành phẩm để cột kết quả gấp/mở được từng thứ một.
 */
function ThumbnailBody({
  projectId,
  projectName,
  thumbnail,
  version,
  onChanged,
}: {
  projectId: string;
  projectName?: string;
  /** "thumbnail.png" nếu đã có - null/undefined = chưa tạo */
  thumbnail?: string | null;
  /** updatedAt của project - cache-bust vì file ghi đè cùng tên */
  version?: string;
  onChanged: () => void;
}) {
  const { t, tf } = useT();
  const thumbRel = `video-projects/${projectId}/${thumbnail ?? "thumbnail.png"}`;
  const thumbUrl =
    mediaUrl(thumbRel) + (version ? `?v=${encodeURIComponent(version)}` : "");
  // FileInfo tối thiểu cho MediaPreviewModal (mtime chỉ dùng cache-bust)
  const thumbFile: FileInfo = {
    name: "thumbnail.png",
    relPath: thumbRel,
    size: 0,
    mtime: version ?? "",
    kind: "image",
  };
  const [thumbPreview, setThumbPreview] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  // Modal "Tạo thumbnail"
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [frameAt, setFrameAt] = useState("1");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openModal() {
    setTitle(projectName ?? projectId);
    setFrameAt("1");
    setPrompt("");
    setError(null);
    setOpen(true);
  }

  async function onCreate() {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const at = Number(frameAt);
      await createThumbnail(projectId, {
        title: name,
        ...(Number.isFinite(at) && at >= 0 ? { frameAt: at } : {}),
        ...(prompt.trim() ? { bgPrompt: prompt.trim() } : {}),
      });
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-meta text-[var(--text-muted)]">
          {thumbnail ? thumbnail : t("project.no-thumb")}
        </span>
        <Button variant="secondary" small onClick={openModal}>
          <ImageIcon size={13} strokeWidth={2} />
          {t("project.create-thumb")}
        </Button>
      </div>

      {revealError && (
        <Banner
          tone="danger"
          message={
            <span className="[overflow-wrap:anywhere]">{revealError}</span>
          }
        />
      )}

      {thumbnail ? (
        <div className="flex items-center gap-3">
          {/* Ảnh bìa CHÍNH NÓ là nút mở xem lớn - không bọc vào <IconButton>
              (30px cố định) vì như thế là bóp ảnh preview thành một cái icon. */}
          <button
            type="button"
            onClick={() => setThumbPreview(true)}
            title={t("project.view-thumb")}
            aria-label={t("project.view-thumb")}
            className="min-w-0 shrink"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbUrl}
              alt={t("project.thumb-alt")}
              className="h-24 w-auto max-w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] object-contain transition-opacity duration-150 hover:opacity-85"
            />
          </button>
          <RevealButton relPath={thumbRel} onError={setRevealError} />
        </div>
      ) : (
        <EmptyState icon={ImageIcon} description={t("project.no-thumb")} />
      )}

      {/* Preview thumbnail lớn */}
      <MediaPreviewModal
        file={thumbPreview ? thumbFile : null}
        onClose={() => setThumbPreview(false)}
      />

      {/* Modal "Tạo thumbnail" - chạy đồng bộ ~1 phút */}
      <Modal
        title={t("project.create-thumb")}
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={onCreate} disabled={busy || !title.trim()}>
              {busy ? (
                <>
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                  {t("project.thumb-creating")}
                </>
              ) : (
                <>
                  <ImageIcon size={14} strokeWidth={2} />
                  {t("project.create-thumb")}
                </>
              )}
            </Button>
          </>
        }
      >
        <Field label={t("project.thumb-title")} htmlFor="thumb-title" required>
          <input
            id="thumb-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("project.thumb-title-placeholder")}
          />
        </Field>
        <Field label={t("project.thumb-frame")} htmlFor="thumb-frame">
          <input
            id="thumb-frame"
            className="input"
            type="number"
            min={0}
            step={0.5}
            value={frameAt}
            onChange={(e) => setFrameAt(e.target.value)}
          />
        </Field>
        {/* Câu mô tả cách chạy làm gợi ý của chính ô prompt nền - nó nói về việc
            Gemini vẽ nền, đứng rời ra thì đọc như chú thích của cả modal. */}
        <Field
          label={t("project.thumb-bg-prompt")}
          htmlFor="thumb-bg-prompt"
          hint={t("project.thumb-desc")}
        >
          <input
            id="thumb-bg-prompt"
            className="input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("project.thumb-bg-placeholder")}
          />
        </Field>
        {error && (
          <Banner tone="danger" message={tf("project.thumb-error", { error })} />
        )}
      </Modal>
    </div>
  );
}

/**
 * Một hàng "nhãn - giá trị" trong tóm tắt kịch bản edit.
 *
 * Nhãn là PHỤ CHÚ (13px muted, chỉ đường), giá trị là NỘI DUNG (14px) - thứ
 * người dùng thật sự đọc để quyết định có bấm chạy hay không. Cùng hình dạng
 * với `ConfigRow` bên trang Auto cut.
 */
function BriefSummaryRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <span className="w-32 shrink-0 text-meta text-[var(--text-muted)]">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-sm">{children}</span>
    </div>
  );
}

function YesNo({ value }: { value: boolean }) {
  const { t } = useT();
  return value ? (
    <span className="inline-flex items-center gap-1 text-[var(--success)]">
      <Check size={14} strokeWidth={2} /> {t("common.yes")}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
      <Minus size={14} strokeWidth={2} /> {t("common.no")}
    </span>
  );
}

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();
  const { t, tf } = useT();
  // SSE đứt rồi nối lại → refetch dữ liệu seed để không kẹt trạng thái cũ
  const { resyncTick } = useEvents();

  const [project, setProject] = useState<ProjectDetail | null>(null);
  // Jobs của project - nguồn suy giai đoạn cho PipelineTimeline; seed từ
  // /api/jobs rồi cập nhật sống qua SSE (backend là nguồn sự thật)
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobNotice, setJobNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Tags của project - sửa optimistic, lỗi thì revert
  const [addingTag, setAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);

  // Đổi TÊN HIỂN THỊ ngay trên tiêu đề - null = không sửa, chuỗi = đang gõ.
  // ID (tên thư mục video-projects/<id>) không đổi theo.
  const [renameError, setRenameError] = useState<string | null>(null);

  // Modal "Nhân bản project"
  const [cloneOpen, setCloneOpen] = useState(false);

  // Preview file render của scene + lỗi "Mở file" trong khối Scenes
  const [scenePreview, setScenePreview] = useState<FileInfo | null>(null);
  const [sceneRevealError, setSceneRevealError] = useState<string | null>(null);

  // Xem video thành phẩm ở khung lớn (cùng modal với mọi chỗ khác trong app)
  const [zoomed, setZoomed] = useState(false);

  // Modal "Bắt đầu edit bằng AI"
  const [editOpen, setEditOpen] = useState(false);
  const [extraNotes, setExtraNotes] = useState("");
  // Model + mode cho phiên edit - giữ lựa chọn giữa các lần mở modal
  const [editModel, setEditModel] = useState(DEFAULT_MODEL);
  const [editEffort, setEditEffort] = useState<AgentEffort>(DEFAULT_EFFORT);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Kịch bản edit: bản nháp phía client, gõ là thấy ngay, PUT đi sau (debounce).
  // Chỉ nạp từ server MỘT LẦN - các lần load() sau (SSE agent ghi file, job xong)
  // không được ghi đè chữ người dùng đang gõ.
  const [brief, setBrief] = useState<Brief | null>(null);
  const briefRef = useRef<Brief | null>(null);
  briefRef.current = brief;
  const briefInitialized = useRef(false);
  const briefDirty = useRef(false);
  const briefTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** PUT brief đang bay - flush sau phải chờ nó, kẻo bước kế tiếp chạy trước khi lưu xong */
  const briefInflight = useRef<Promise<string | null> | null>(null);
  const [briefSaveError, setBriefSaveError] = useState<string | null>(null);
  const [briefSaved, setBriefSaved] = useState(false);

  // Style Design - tên style hiển thị trong tóm tắt modal "Bắt đầu edit"
  const { data: stylesData } = useStyles();

  // Panel AI của project (chat đi theo project) - panel là SLOT của shell nên
  // trang không giữ state gấp/mở, không chừa chỗ, không tự dựng drawer.
  const [chatSessions, setChatSessions] = useState<ChatSession[] | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Vừa bấm "Bắt đầu edit" thành công → coi là đã started ngay, không chờ reload
  const [startedOverride, setStartedOverride] = useState(false);

  // Dropdown "Xem thêm" trong hàng nút thao tác
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  const loadSessions = useCallback(async () => {
    try {
      const list = await getChatSessions(projectId);
      list.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      setChatSessions(list);
      // Chưa chọn phiên nào → tự chọn phiên mới nhất
      setActiveSessionId((cur) => cur ?? list[0]?.sessionId ?? null);
    } catch {
      // panel vẫn hoạt động được (empty state) - không chặn trang
      setChatSessions((s) => s ?? []);
    }
  }, [projectId]);

  // resyncTick: SSE vừa nối lại sau khi đứt - trong lúc đứt phiên có thể đã
  // done/error mà không ai nhận event, refetch để không hiện "đang chạy" mãi
  useEffect(() => {
    loadSessions();
  }, [loadSessions, resyncTick]);

  const load = useCallback(async () => {
    try {
      const p = await getProject(projectId);
      setProject(p);
      // Nạp brief MỘT LẦN: các lần load() sau chạy liên tục theo SSE, ghi đè là
      // nuốt đúng những chữ người dùng vừa gõ vào form.
      if (!briefInitialized.current) {
        briefInitialized.current = true;
        setBrief({ ...DEFAULT_BRIEF, ...(p.brief ?? {}) });
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load, resyncTick]);

  // Tập sessionId thuộc project này - để lọc event agent
  const sessionIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    sessionIdsRef.current = new Set(
      (chatSessions ?? []).map((s) => s.sessionId)
    );
  }, [chatSessions]);

  // AI đang edit → asset/render/scene cập nhật sống: refresh khi AI ghi file
  // (Write/Edit/Bash), throttle 3s để không dội API; refresh lần cuối khi done.
  const lastAutoRefreshRef = useRef(0);
  useAgentEvents((e) => {
    const belongs =
      sessionIdsRef.current.has(e.sessionId) ||
      e.sessionId === activeSessionId;
    if (e.kind === "done") {
      // cập nhật status/title trong danh sách phiên + dữ liệu project
      loadSessions();
      if (belongs) load();
      return;
    }
    if (!belongs || e.kind !== "tool") return;
    const name = e.tool?.name;
    if (name === "Write" || name === "Edit" || name === "Bash") {
      const now = Date.now();
      if (now - lastAutoRefreshRef.current >= 3000) {
        lastAutoRefreshRef.current = now;
        load();
      }
    }
  });

  // Seed danh sách job của project (timeline giai đoạn cần cả job đã done).
  // Lọc projectId phía server - queue bận rộn không đẩy job của project này
  // ra khỏi cửa sổ 50 job. resyncTick: refetch sau khi SSE nối lại.
  useEffect(() => {
    let alive = true;
    getJobs(50, projectId)
      .then((list) => {
        if (alive) setJobs(list);
      })
      .catch(() => {
        // không có jobs cũng không chặn trang - timeline tự ẩn/suy từ file
      });
    return () => {
      alive = false;
    };
  }, [projectId, resyncTick]);

  // Refetch khi có job của project này đổi trạng thái kết thúc
  // + upsert vào state jobs để timeline giai đoạn cập nhật sống
  useJobEvents((job) => {
    if (job.projectId !== projectId) return;
    setJobs((prev) => {
      const i = prev.findIndex((j) => j.id === job.id);
      if (i === -1) return [job, ...prev];
      const next = prev.slice();
      next[i] = job;
      return next;
    });
    if (["done", "failed", "canceled"].includes(job.status)) load();
  });

  // ---- Kịch bản edit: gộp nhiều lần gõ rồi PUT một lần ----

  /**
   * Gửi brief đang chờ. Trả về thông báo lỗi (null = đã lưu / không có gì để lưu).
   * Lưu hỏng thì ĐÁNH DẤU BẨN LẠI để lần sau gửi lại, và người gọi (Bắt đầu
   * edit) phải dừng: chạy tiếp là agent dựng theo brief CŨ trên server trong khi
   * UI hiện brief mới - vd vừa tắt "Ảnh minh họa AI" mà video vẫn đầy ảnh.
   */
  const flushBrief = useCallback(async (): Promise<string | null> => {
    if (briefTimer.current) {
      clearTimeout(briefTimer.current);
      briefTimer.current = null;
    }
    if (briefInflight.current) {
      const prevErr = await briefInflight.current;
      if (!briefDirty.current) return prevErr;
    }
    if (!briefDirty.current || !briefRef.current) return null;
    briefDirty.current = false;
    const snapshot = briefRef.current;
    const run = (async (): Promise<string | null> => {
      try {
        const saved = await updateBrief(projectId, snapshot);
        setProject((p) => (p ? { ...p, brief: saved } : p));
        setBriefSaveError(null);
        setBriefSaved(true);
        return null;
      } catch (e) {
        briefDirty.current = true;
        const msg = e instanceof Error ? e.message : String(e);
        setBriefSaveError(msg);
        return msg;
      }
    })();
    briefInflight.current = run;
    try {
      return await run;
    } finally {
      if (briefInflight.current === run) briefInflight.current = null;
    }
  }, [projectId]);

  // Rời trang khi còn thay đổi chưa gửi → gửi nốt
  useEffect(() => {
    return () => {
      if (briefTimer.current) clearTimeout(briefTimer.current);
      if (briefDirty.current && briefRef.current) {
        briefDirty.current = false;
        updateBrief(projectId, briefRef.current).catch(() => {
          // trang đã đóng - không còn chỗ hiện lỗi
        });
      }
    };
  }, [projectId]);

  function patchBrief(p: Partial<Brief>) {
    setBrief((b) => (b ? { ...b, ...p } : b));
    briefDirty.current = true;
    setBriefSaved(false);
    if (briefTimer.current) clearTimeout(briefTimer.current);
    briefTimer.current = setTimeout(flushBrief, BRIEF_DEBOUNCE_MS);
  }

  async function submitJob(type: JobType, sceneId?: string) {
    setSubmitting(true);
    setJobError(null);
    setJobNotice(null);
    try {
      const job = await createJob({ projectId, type, sceneId });
      setJobNotice(tf("project.job-queued", { id: job.id, type }));
    } catch (e) {
      setJobError(
        tf("project.job-error", {
          error: e instanceof Error ? e.message : String(e),
        })
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Xóa file rác - file trung gian sau khi xuất final (renders/verify/cache,
  // props.resolved.json, draft lắp ráp, staging Remotion); file nguồn giữ nguyên
  const [cleaning, setCleaning] = useState(false);
  async function onCleanJunk() {
    if (cleaning) return;
    setCleaning(true);
    setJobError(null);
    setJobNotice(null);
    try {
      const junk = await getProjectJunk(projectId);
      if (junk.items.length === 0) {
        setJobNotice(t("junk.none"));
        return;
      }
      if (
        !window.confirm(
          tf("project.junk-confirm", {
            items: junk.items.length,
            size: formatBytes(junk.totalBytes),
          })
        )
      )
        return;
      const result = await cleanProjectJunk(projectId);
      setJobNotice(
        tf("project.junk-freed", {
          size: formatBytes(result.freedBytes),
          items: result.deleted,
        })
      );
      load();
    } catch (e) {
      setJobError(
        tf("project.junk-error", {
          error: e instanceof Error ? e.message : String(e),
        })
      );
    } finally {
      setCleaning(false);
    }
  }

  /** Thay toàn bộ tags - optimistic: cập nhật UI trước, lỗi thì revert. */
  async function saveTags(next: string[]) {
    if (!project) return;
    const prev = project.tags ?? [];
    setTagError(null);
    setProject((p) => (p ? { ...p, tags: next } : p));
    try {
      const { tags } = await updateProjectTags(projectId, next);
      setProject((p) => (p ? { ...p, tags } : p));
    } catch (e) {
      setProject((p) => (p ? { ...p, tags: prev } : p));
      setTagError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Lưu tên mới - server là nguồn sự thật, lấy tên nó trả về. */
  async function saveName(next: string) {
    const saved = await renameProject(projectId, next);
    setProject((p) => (p ? { ...p, name: saved.name } : p));
  }

  function addTag() {
    const tag = tagInput.trim();
    setTagInput("");
    setAddingTag(false);
    if (!tag || !project) return;
    const cur = project.tags ?? [];
    if (cur.includes(tag)) return;
    saveTags([...cur, tag]);
  }

  // Modal xác nhận xóa project - bắt gõ DELETE (thay window.confirm)
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function onDelete() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject(projectId);
      router.push("/projects");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  async function onStartEdit() {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    try {
      // Tự lưu brief đang gõ trước khi bắt đầu - người dùng không phải nhớ chờ
      // debounce. CHỈ lưu khi brief thật đã nạp về (flushBrief tự bỏ qua nếu chưa).
      const saveErr = await flushBrief();
      if (saveErr) {
        setStartError(saveErr);
        return;
      }
      const { sessionId } = await startProjectEdit(projectId, extraNotes, {
        model: editModel,
        effort: editEffort,
      });
      // Không rời trang - phiên vừa tạo hiện ngay ở panel AI, log stream tại chỗ
      setEditOpen(false);
      setActiveSessionId(sessionId);
      setStartedOverride(true);
      loadSessions();
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  const scenes = project?.scenes ?? [];
  const renders = project?.files?.renders ?? [];
  const assets = project?.files?.assets ?? [];
  /** Brief dùng cho tóm tắt modal - chưa nạp xong thì tạm dùng mặc định. */
  const briefView: Brief = brief ?? DEFAULT_BRIEF;

  const activeSession =
    chatSessions?.find((s) => s.sessionId === activeSessionId) ?? null;

  // Đã bắt đầu edit lần nào chưa - quyết định nhãn/kích cỡ nút CTA trong khối
  // thao tác (chưa bắt đầu thì nút to, đã có phiên thì là "mở phiên mới").
  const started =
    startedOverride ||
    (chatSessions?.length ?? 0) > 0 ||
    project?.output != null ||
    renders.length > 0;

  // Phiên AI của project đang chạy → khối video thành phẩm hiện trạng thái sống
  const aiRunning = (chatSessions ?? []).some((s) => s.status === "running");
  const runningJob = jobs.find((j) => j.status === "running") ?? null;
  const busyNow = aiRunning || runningJob !== null || project?.status === "rendering";

  // Gấp/mở từng khối. Mặc định suy từ "project đã xong chưa" NGAY TRONG LÚC
  // RENDER, cố tình KHÔNG có useEffect nào đồng bộ trạng thái gấp theo status:
  // trang này bám SSE job + agent, mỗi dòng log hay mỗi lần job đổi tiến trình là
  // một lần render mới. Effect kiểu đó sẽ đóng sập đúng cái khối người dùng vừa
  // mở ra, mà lỗi ấy trông như trang tự nhiên "nhảy" chứ không ai đoán ra là do SSE.
  const group = useCollapseGroup({
    keys: PROJECT_BLOCKS,
    finished: project?.status === "done",
    /*
     * Khối cấu hình ĐÃ ĐIỀN thì gấp sẵn - dòng tóm tắt đã nói đang đặt gì, mở
     * cả bảng ra chỉ để nhìn lại thứ mình vừa chọn là tốn nửa màn hình.
     *
     * "Đã điền" đo bằng thứ NGƯỜI DÙNG gõ vào (ghi chú / mô tả nguồn), không
     * phải bằng việc brief đã tải xong: brief rỗng vẫn là một object hợp lệ, mà
     * gấp sẵn khối rỗng là giấu mất đúng việc cần làm tiếp.
     *
     * Khối "action" luôn mở: nó là NÚT BẤM, không phải cấu hình.
     */
    configured: (key) =>
      key === "brief"
        ? briefView.notes.trim().length > 0 ||
          briefView.sourceDescription.trim().length > 0
        : key === "thumbnail"
          ? Boolean(project?.thumbnail)
          : false,
  });

  // Timeline tự ẩn khi chưa có gì để hiện (deriveStage trả null). Tính trước ở
  // đây để nút (i) đi kèm cũng ẩn theo - không để icon lơ lửng một mình.
  const pipelineInput = project
    ? {
        metaStatus: project.status,
        hasOutput: project.output != null,
        scenes,
        renders,
        jobs,
        sessionRunning: aiRunning,
      }
    : null;
  const showPipeline =
    pipelineInput !== null && deriveStage(pipelineInput) !== null;

  // ---- Khối video thành phẩm ----

  const output = project?.output ?? null;
  const version = project?.updatedAt;
  const outputUrl = output
    ? mediaUrl(output) + (version ? `?v=${encodeURIComponent(version)}` : "")
    : null;
  const outputName = output ? output.split(/[\\/]/).pop() : null;
  /** FileInfo tối thiểu cho modal xem video - mtime chỉ dùng cache-bust */
  const outputFile: FileInfo | null = output
    ? {
        name: outputName ?? output,
        relPath: output,
        size: 0,
        mtime: version ?? "",
        kind: "video",
      }
    : null;
  // Đã có video thì LUÔN hiện video, kể cả khi đang chạy lượt mới: tiến trình
  // lượt mới nằm ở dòng chữ ngay dưới, không cần che mất bản đang xem được.
  const outputStatus: WorkspaceStatus = outputUrl
    ? "done"
    : busyNow
      ? "running"
      : "idle";
  const aspect = project ? `${project.width} / ${project.height}` : "16 / 9";

  // Gấp/mở khối video thành phẩm - luật riêng, KHÔNG đi chung `group`:
  //   đang chạy mà chưa có video → GẤP, chỉ còn một dòng thanh tiến trình (mở ra
  //     cũng chỉ thấy một ô trống nhấp nháy, chiếm nửa cột để nói "chưa có gì");
  //   đã có video               → MỞ, vào trang là để xem cái video đó.
  // Vẫn đúng luật cũ của cả trang: mặc định SUY RA NGAY TRONG LÚC RENDER, tuyệt
  // đối không useEffect đồng bộ theo status - trang bám SSE job + agent, mỗi
  // dòng log là một lần render, effect kiểu đó sẽ đóng sập đúng cái khối người
  // dùng vừa mở. Bấm tay một lần là ý người dùng thắng vĩnh viễn.
  const [outputOverride, setOutputOverride] = useState<boolean | null>(null);
  const outputCollapsed = outputOverride ?? (outputUrl === null && busyNow);

  // ---- Một dòng tóm tắt cho từng khối lúc gấp ----

  const briefSummary =
    briefView.notes.trim().slice(0, 120) ||
    briefView.sourceDescription.trim().slice(0, 120) ||
    t("brief.none");
  const actionSummary = started
    ? tf("project.session-count", { n: chatSessions?.length ?? 0 })
    : t("project.start-edit");
  /**
   * Dòng tóm tắt của khối video thành phẩm. Lúc đang chạy đây là NƠI DUY NHẤT
   * còn hiện % + tên bước của job (khối "Tiến trình dựng" đã bỏ - 6 giai đoạn
   * của nó trùng hệt thanh bước ở đầu trang, chỉ % và tên bước là của riêng nó
   * nên dọn về đây, ngay cạnh thanh tiến trình).
   *
   * Toàn <span>: WorkspaceBlock bọc summary trong <p>, nhét <div> vào là HTML
   * không hợp lệ.
   */
  const jobPct = runningJob
    ? Math.max(0, Math.min(100, Math.round(runningJob.progress)))
    : null;
  const progressText = runningJob
    ? [`${runningJob.type} · ${jobPct}%`, runningJob.step]
        .filter(Boolean)
        .join(" · ")
    : aiRunning
      ? t("project.ai-making-ellipsis")
      : t("workspace.output.running");
  const outputSummary: ReactNode = busyNow ? (
    <span className="summary-progress">
      <span className="summary-progress-track">
        {jobPct === null ? (
          <span className="summary-progress-fill is-indeterminate" />
        ) : (
          <span
            className="summary-progress-fill"
            style={{ width: `${jobPct}%` }}
          />
        )}
      </span>
      <span className="summary-progress-text" title={progressText}>
        {progressText}
      </span>
    </span>
  ) : (
    (outputName ?? t("project.no-output"))
  );
  const sceneSummary =
    scenes.length > 0
      ? tf("project.scene-count", { n: scenes.length })
      : t("project.no-scenes-short");
  const renderSummary =
    renders.length > 0
      ? tf("project.render-count", { n: renders.length })
      : t("project.no-files");
  const thumbSummary = project?.thumbnail ?? t("project.no-thumb");

  return (
    <div className="flex flex-col gap-4">
      {/* Không còn `xl:pr-[452px]`: chỗ chừa cho panel AI là việc của shell, và
          con số tay kiểu đó sai ngay khi người dùng gấp panel lại. */}
      <PageHeader
        title={
          <EditableTitle
            value={project?.name ?? null}
            fallback={projectId}
            onSave={saveName}
            onError={setRenameError}
            editLabel={t("project.rename")}
            emptyError={t("project.name-required")}
            saveLabel={t("common.save")}
            cancelLabel={t("common.cancel")}
          />
        }
        subtitle={
          project
            ? `${project.width}×${project.height} · ${project.fps}fps · ${tf("project.updated", { time: formatRelative(project.updatedAt) })}`
            : undefined
        }
        center={
          pipelineInput && showPipeline ? (
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <PipelineTimeline {...pipelineInput} />
              </div>
              <InfoHint
                titleKey="help.pipeline.title"
                bodyKey="help.pipeline.body"
                className="mt-px"
              />
            </div>
          ) : undefined
        }
        actions={
          /* Nút xóa đứng CUỐI, ngoài cụm nút thường, ngăn bằng vạch dọc - quy
             ước chung của 7 trang chi tiết, lý do viết đầy đủ ở
             `src/app/images/[id]/page.tsx`. */
          <>
            <span className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => router.push("/projects")}>
                <ArrowLeft size={15} strokeWidth={2} />
                {t("project.back")}
              </Button>
            </span>
            <span className="flex items-center border-l border-[var(--border)] pl-2">
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 size={15} strokeWidth={2} />
                {t("common.delete")}
              </Button>
            </span>
          </>
        }
      />

      {/* Dải tóm tắt project - HAI HÀNG, không phải một hàng wrap.
          Trước đây trạng thái + id + gạch + N tag + ô nhập tag + hai dòng lỗi +
          câu gợi ý gấp + nút Nhân bản + nút (i) nhồi chung một hàng `flex-wrap`:
          thêm vài tag là mọi thứ tự xếp lại chỗ khác, không đọc ra được đâu là
          trạng thái đâu là thao tác. Giờ hàng 1 = project này là gì + làm gì với
          nó, hàng 2 = tag; lỗi tách hẳn ra <Banner> chứ không nhét vào dải. */}
      {project && (
        <Card>
          <div className="flex flex-col gap-3">
            {/* Hàng 1: trạng thái · id · thao tác */}
            <div className="flex flex-wrap items-center gap-3">
              <ProjectBadge status={project.status} />
              <span className="min-w-0 text-meta text-[var(--text-muted)] [overflow-wrap:anywhere]">
                ID: {project.id}
              </span>
              {project.status === "done" && group.anyCollapsed && (
                <span className="min-w-0 text-meta text-[var(--text-muted)]">
                  {t("workspace.done-collapsed")}
                </span>
              )}
              {/* (i) luôn nằm NGOÀI nút - lồng button trong button là HTML không hợp lệ */}
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  small
                  onClick={() => setCloneOpen(true)}
                >
                  <Copy size={14} strokeWidth={2} />
                  {t("clone.action")}
                </Button>
                <InfoHint titleKey="help.clone.title" bodyKey="help.clone.body" />
              </span>
            </div>

            {/* Hàng 2: tag - hàng riêng nên thêm bao nhiêu tag cũng không đẩy
                trạng thái và nút Nhân bản đi chỗ khác */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-meta text-[var(--text-muted)]">Tag</span>
              {(project.tags ?? []).map((tag) => (
                <span key={tag} className="chip">
                  {tag}
                  <IconButton
                    size="sm"
                    tone="danger"
                    label={tf("taginput.remove-aria", { tag })}
                    className="-mr-2"
                    onClick={() =>
                      saveTags((project.tags ?? []).filter((x) => x !== tag))
                    }
                  >
                    <X size={12} strokeWidth={2} />
                  </IconButton>
                </span>
              ))}
              {addingTag ? (
                <input
                  className="input w-40 rounded-full"
                  autoFocus
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    } else if (e.key === "Escape") {
                      setTagInput("");
                      setAddingTag(false);
                    }
                  }}
                  onBlur={addTag}
                  placeholder={t("project.new-tag-placeholder")}
                  aria-label={t("project.add-tag-aria")}
                />
              ) : (
                <IconButton
                  size="sm"
                  label={t("project.add-tag-aria")}
                  onClick={() => setAddingTag(true)}
                >
                  <Plus size={14} strokeWidth={2} />
                </IconButton>
              )}
            </div>

            {tagError && (
              <Banner
                tone="danger"
                message={tf("project.tags-error", { error: tagError })}
              />
            )}
          </div>
        </Card>
      )}

      {renameError && (
        <ErrorBanner message={t("project.rename-error")} detail={renameError} />
      )}

      {error && <ErrorBanner message={t("project.load-error")} detail={error} />}

      {briefSaveError && (
        <ErrorBanner
          message={t("project.brief-save-error")}
          detail={briefSaveError}
        />
      )}

      {/* Ba cột theo nhịp làm việc: nguồn → yêu cầu & thiết lập → tiến trình &
          kết quả. Số cột do container query trong globals.css lo, trang không tự
          tính pixel. */}
      <Workspace>
        {/* ================= Cột 1: nguồn ================= */}
        <WorkspaceColumn role="source" title={t("workspace.col.source")}>
          {/* Các card này TỰ NÓ là một <Card> đầy đủ (tiêu đề + nút riêng) nên
              đứng thẳng trong cột, không bọc thêm WorkspaceBlock. */}
          <ProjectAssetsCard
            compact={started}
            projectId={projectId}
            assets={assets.filter((f) => f.kind === "video" || f.kind === "image")}
            onChanged={load}
          />
          {assets.some((f) => f.kind === "audio") && (
            <ProjectAssetsCard
              compact
              title={t("project.sfx-title")}
              showUpload={false}
              projectId={projectId}
              assets={assets.filter((f) => f.kind === "audio")}
              onChanged={load}
            />
          )}
          {assets.some((f) => f.kind === "other") && (
            <ProjectAssetsCard
              compact
              title={t("project.other-title")}
              showUpload={false}
              projectId={projectId}
              assets={assets.filter((f) => f.kind === "other")}
              onChanged={load}
            />
          )}
        </WorkspaceColumn>

        {/* ============ Cột 2: yêu cầu & thiết lập ============ */}
        <WorkspaceColumn role="setup" title={t("workspace.col.setup")}>
          {/* Kịch bản edit: màu/font (Style Design), phong cách dựng, phụ đề,
              key, sound effect, nhạc nền… - "mình muốn ra cái gì" */}
          <WorkspaceBlock
            id="project-block-brief"
            icon={FileText}
            collapsed={group.isCollapsed("brief")}
            onToggle={() => group.toggle("brief")}
            summary={briefSummary}
            title={
              <span className="inline-flex items-center gap-2">
                {t("brief.title")}
                <InfoHint
                  titleKey="help.brief.title"
                  bodyKey="help.brief.body"
                  size={14}
                />
              </span>
            }
          >
            {brief ? (
              <div className="flex flex-col gap-4">
                <p className="text-meta text-[var(--text-muted)]">
                  {briefSaved ? t("common.saved") : t("project.brief-autosave")}
                </p>
                <BriefFields value={brief} onChange={patchBrief} />
              </div>
            ) : (
              // Khung xám giữ đúng chỗ của biểu mẫu - câu "Đang tải…" biến mất
              // là cả cột nhảy lên một nhịp đúng lúc dữ liệu về.
              <div className="flex flex-col gap-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}
          </WorkspaceBlock>

          {/* Hàng nút: giao việc cho AI + các job chạy tay (render final, draft,
              dọn file rác). Trước đây nằm trong panel AI tự dựng - panel giờ là
              slot của shell và chỉ để chat. */}
          <WorkspaceBlock
            id="project-block-action"
            icon={Sparkles}
            collapsed={group.isCollapsed("action")}
            onToggle={() => group.toggle("action")}
            summary={actionSummary}
            title={t("project.card-action")}
          >
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                {/* Một cỡ nút duy nhất. Bản cũ phóng nút này lên h-12/15px khi
                    chưa bắt đầu - nút to nhất toàn app, và là bậc chữ thứ tư.
                    Nó đã là nút primary duy nhất trong khối, thế là đủ nổi. */}
                <Button
                  className="flex-1"
                  onClick={() => {
                    setStartError(null);
                    setExtraNotes("");
                    setEditOpen(true);
                  }}
                >
                  <Sparkles size={15} strokeWidth={2} />
                  {started
                    ? t("project.start-edit-new-session")
                    : t("project.start-edit")}
                </Button>
                <InfoHint
                  titleKey="help.start-edit.title"
                  bodyKey="help.start-edit.body"
                  size={15}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  small
                  disabled={submitting}
                  onClick={() => submitJob("assemble-final")}
                >
                  <Play size={14} strokeWidth={2} />
                  {t("project.render-final")}
                </Button>
                <InfoHint
                  titleKey="help.render-final.title"
                  bodyKey="help.render-final.body"
                />
                <div ref={moreRef} className="relative">
                  <Button
                    variant="secondary"
                    small
                    onClick={() => setMoreOpen((o) => !o)}
                    aria-expanded={moreOpen}
                    aria-haspopup="menu"
                  >
                    <MoreHorizontal size={14} strokeWidth={2} />
                    {t("project.more")}
                  </Button>
                  {/* Menu thả xuống giữ nguyên <div>/<button> thô: mục menu
                      không phải nút bấm rời (<Button> có viền, có nền, và cao
                      36px - xếp bốn cái là ra một cột nút chứ không phải menu),
                      cũng không phải hộp nội dung nên không dùng <Panel>. Cái
                      cần thống nhất là bậc chữ và padding - cả ba mục dưới đây
                      dùng chung một chuỗi class. */}
                  {moreOpen && (
                    <div
                      role="menu"
                      className="absolute right-0 top-full z-50 mt-1 flex w-52 flex-col gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2 shadow-[var(--shadow-card)]"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        disabled={submitting}
                        className={MENU_ITEM_CLASS}
                        onClick={() => {
                          setMoreOpen(false);
                          submitJob("scene-draft");
                        }}
                      >
                        <Clapperboard
                          size={14}
                          strokeWidth={2}
                          className="shrink-0 text-[var(--text-muted)]"
                        />
                        {t("project.menu-scene-draft")}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={submitting}
                        className={MENU_ITEM_CLASS}
                        onClick={() => {
                          setMoreOpen(false);
                          submitJob("assemble-draft");
                        }}
                      >
                        <Film
                          size={14}
                          strokeWidth={2}
                          className="shrink-0 text-[var(--text-muted)]"
                        />
                        {t("project.menu-assemble-draft")}
                      </button>
                      {/* (i) là item riêng cạnh menu item - không lồng vào button */}
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          role="menuitem"
                          disabled={cleaning}
                          className={`${MENU_ITEM_CLASS} min-w-0 flex-1`}
                          onClick={() => {
                            setMoreOpen(false);
                            onCleanJunk();
                          }}
                        >
                          <Trash2
                            size={14}
                            strokeWidth={2}
                            className="shrink-0 text-[var(--text-muted)]"
                          />
                          {cleaning ? t("junk.cleaning") : t("junk.clean")}
                        </button>
                        <InfoHint
                          titleKey="help.clean-junk.title"
                          bodyKey="help.clean-junk.body"
                          className="mr-1"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Thông báo/lỗi job là chuỗi tự do (có cả đường dẫn dài không dấu
                  cách) - phải cho ngắt ở giữa từ, không thì đẩy toác cả cột. */}
              {jobNotice && (
                <Banner
                  tone="success"
                  message={
                    <span className="[overflow-wrap:anywhere]">{jobNotice}</span>
                  }
                />
              )}
              {jobError && (
                <Banner
                  tone="danger"
                  message={
                    <span className="[overflow-wrap:anywhere]">{jobError}</span>
                  }
                />
              )}
            </div>
          </WorkspaceBlock>

          {/* Duyệt draft ghim ghi chú theo giây - ghi chú là ĐẦU VÀO cho lượt
              edit sau, nên thuộc cột yêu cầu chứ không phải cột kết quả */}
          <ProjectReviewCard
            projectId={projectId}
            output={project?.output}
            version={project?.updatedAt}
            aiRunning={aiRunning}
          />
          {/* Cắt short + tái chế tỉ lệ: cũng là một yêu cầu "làm cho tôi cái này" */}
          <ProjectClipsCard
            projectId={projectId}
            width={project?.width}
            height={project?.height}
            onCreated={load}
          />
        </WorkspaceColumn>

        {/* ============ Cột 3: tiến trình & kết quả ============ */}
        <WorkspaceColumn role="output" title={t("workspace.col.output")}>
          {/* Khối ĐẦU TIÊN của cột. Đang dựng thì GẤP lại còn một dòng thanh
              tiến trình (% + tên bước của job), xong thì tự mở ra và hiện thẳng
              video. Liếc một chỗ là biết project đang ở đâu. */}
          <OutputBlock
            id="project-block-output"
            status={outputStatus}
            videoUrl={outputUrl}
            progress={runningJob ? runningJob.progress : null}
            step={runningJob?.step}
            aspect={aspect}
            collapsed={outputCollapsed}
            onToggle={setOutputOverride}
            summary={outputSummary}
            title={
              <span className="inline-flex items-center gap-2">
                {t("project.video-output")}
                <InfoHint
                  titleKey="help.video-output.title"
                  bodyKey="help.video-output.body"
                  size={14}
                />
              </span>
            }
          >
            {aiRunning && (
              <Panel>
                <div
                  className="progress-indeterminate"
                  aria-label={t("project.ai-making")}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-[var(--text-muted)]">
                    {t("project.ai-making-ellipsis")}
                  </span>
                  <SessionStatusBadge status="running" />
                </div>
              </Panel>
            )}

            {outputUrl ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-meta text-[var(--text-muted)]">
                  {outputName}
                </span>
                {/* Hai thao tác trên đúng một file - cùng hình dạng nút icon.
                    "Mở file" phải là <a target="_blank"> (mở tab mới) nên mượn
                    class `.icon-btn` thay vì <IconButton>, cái đó là <button>. */}
                <span className="flex shrink-0 items-center gap-1">
                  <IconButton
                    label={t("common.zoom")}
                    onClick={() => setZoomed(true)}
                  >
                    <Maximize2 size={15} strokeWidth={2} />
                  </IconButton>
                  <a
                    href={outputUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="icon-btn"
                    title={t("common.open-file")}
                    aria-label={t("common.open-file")}
                  >
                    <ExternalLink size={15} strokeWidth={2} />
                  </a>
                </span>
              </div>
            ) : !busyNow ? (
              <p className="text-sm text-[var(--text-muted)]">
                {t("project.no-output")}
              </p>
            ) : null}
          </OutputBlock>

          {/* KHÔNG có khối "Tiến trình dựng" ở đây nữa: 6 giai đoạn của nó là
              đúng cái thanh bước đã nằm ở đầu trang, để hai chỗ là bắt người
              dùng đọc cùng một thứ hai lần. Phần RIÊNG của nó (% + tên bước của
              job đang chạy) đã dọn lên dòng tóm tắt của khối video thành phẩm,
              nơi giờ có thanh tiến trình. */}

          {/* Scene do AI dựng - sản phẩm của lượt edit, không phải ô nhập */}
          <WorkspaceBlock
            id="project-block-scenes"
            icon={Clapperboard}
            collapsed={group.isCollapsed("scenes")}
            onToggle={() => group.toggle("scenes")}
            summary={sceneSummary}
            title="Scenes"
          >
            {sceneRevealError && (
              <div className="mb-3">
                <Banner
                  tone="danger"
                  message={
                    <span className="[overflow-wrap:anywhere]">
                      {sceneRevealError}
                    </span>
                  }
                />
              </div>
            )}
            {scenes.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="table min-w-[560px]">
                  <thead>
                    <tr>
                      <th>Scene</th>
                      <th>{t("project.col-source")}</th>
                      <th>Duration (frames)</th>
                      <th>{t("project.col-rendered")}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {scenes.map((s) => {
                      const renderFile = sceneRenderFile(s, renders);
                      const rendered = renderFile !== null;
                      return (
                        <tr key={s.id}>
                          <td className="font-medium">
                            {renderFile ? (
                              <button
                                type="button"
                                onClick={() => setScenePreview(renderFile)}
                                title={tf("common.preview-aria", {
                                  name: renderFile.name,
                                })}
                                className="font-medium underline-offset-2 transition-colors duration-150 hover:text-[var(--primary)] hover:underline"
                              >
                                {s.id}
                              </button>
                            ) : (
                              s.id
                            )}
                          </td>
                          <td className="text-[var(--text-muted)]">
                            {s.src ? (
                              <span className="chip">HyperFrames · {s.src}</span>
                            ) : s.srcVideo ? (
                              <span className="chip">Video · {s.srcVideo}</span>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td className="text-[var(--text-muted)]">
                            {s.durationInFrames ?? "-"}
                          </td>
                          <td>
                            {rendered ? (
                              <Check
                                size={16}
                                strokeWidth={2}
                                className="text-[var(--success)]"
                              />
                            ) : (
                              <Minus
                                size={16}
                                strokeWidth={2}
                                className="text-[var(--text-muted)]"
                              />
                            )}
                          </td>
                          <td>
                            <span className="flex items-center justify-end gap-2">
                              {renderFile && (
                                <RevealButton
                                  relPath={renderFile.relPath}
                                  onError={setSceneRevealError}
                                />
                              )}
                              {s.src && (
                                <Button
                                  variant="secondary"
                                  small
                                  disabled={submitting}
                                  onClick={() => submitJob("scene-draft", s.id)}
                                >
                                  {t("project.draft-this-scene")}
                                </Button>
                              )}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                icon={Clapperboard}
                description={t("project.no-scenes")}
              />
            )}
          </WorkspaceBlock>

          {/* File render sinh ra trong lúc chạy */}
          <WorkspaceBlock
            id="project-block-renders"
            icon={Film}
            collapsed={group.isCollapsed("renders")}
            onToggle={() => group.toggle("renders")}
            summary={renderSummary}
            title="Renders"
          >
            <FileTable files={renders} />
          </WorkspaceBlock>

          {/* QC đo bản draft/final hiện có - card tự đủ, đứng thẳng trong cột */}
          <ProjectQcCard projectId={projectId} onChanged={load} />

          {/* Báo cáo cắt tự động - tự ẩn khi project chưa chạy cắt lần nào */}
          <ProjectAutoTrimCard
            projectId={projectId}
            version={project?.updatedAt}
          />

          {/* Ảnh bìa của video - cũng là thứ sinh ra sau khi có thành phẩm */}
          <WorkspaceBlock
            id="project-block-thumbnail"
            icon={ImageIcon}
            collapsed={group.isCollapsed("thumbnail")}
            onToggle={() => group.toggle("thumbnail")}
            summary={thumbSummary}
            title={
              <span className="inline-flex items-center gap-2">
                Thumbnail
                <InfoHint
                  titleKey="help.thumbnail.title"
                  bodyKey="help.thumbnail.body"
                  size={14}
                />
              </span>
            }
          >
            <ThumbnailBody
              projectId={projectId}
              projectName={project?.name}
              thumbnail={project?.thumbnail}
              version={project?.updatedAt}
              onChanged={load}
            />
          </WorkspaceBlock>

          {/* Gói xuất bản soạn từ transcript - card tự đủ */}
          <ProjectPublishCard
            projectId={projectId}
            version={project?.updatedAt}
          />
        </WorkspaceColumn>
      </Workspace>

      {/* Panel AI: chỉ KHAI BÁO nội dung, shell lo bề rộng/gấp/drawer. Cây React
          vẫn nằm ở trang này nên state và SSE của ChatThread giữ nguyên. */}
      <ShellRightPanel title={t("project.ai-panel")}>
        {activeSession && (
          <div className="flex shrink-0 justify-end">
            <SessionStatusBadge status={activeSession.status} />
          </div>
        )}

        {chatSessions && chatSessions.length > 0 && (
          <select
            className="input shrink-0"
            value={activeSessionId ?? ""}
            onChange={(e) => setActiveSessionId(e.target.value || null)}
            aria-label={t("project.select-session")}
          >
            {chatSessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.title} · {sessionStatusLabel(s.status, t)} ·{" "}
                {formatRelative(s.updatedAt)}
              </option>
            ))}
          </select>
        )}

        {chatSessions !== null &&
        chatSessions.length === 0 &&
        !activeSessionId ? (
          <div className="card flex min-h-0 flex-1 flex-col items-center justify-center">
            <EmptyState
              icon={MessageSquare}
              description={t("project.no-sessions")}
              action={
                <Button
                  small
                  onClick={() => {
                    setStartError(null);
                    setExtraNotes("");
                    setEditOpen(true);
                  }}
                >
                  <Sparkles size={14} strokeWidth={2} />
                  {t("project.start-edit")}
                </Button>
              }
            />
          </div>
        ) : (
          <ChatThread
            compact
            providersEnabled
            sessionId={activeSessionId}
            projectId={projectId}
            initialStatus={activeSession?.status}
            session={activeSession}
            onSessionCreated={(id) => {
              setActiveSessionId(id);
              loadSessions();
            }}
          />
        )}
      </ShellRightPanel>

      {/* Xem video thành phẩm ở khung lớn */}
      <MediaPreviewModal
        file={zoomed ? outputFile : null}
        onClose={() => setZoomed(false)}
      />

      {/* Preview file render của scene (khối Scenes) */}
      <MediaPreviewModal
        file={scenePreview}
        onClose={() => setScenePreview(null)}
      />

      {/* Modal xác nhận xóa project - bắt gõ DELETE */}
      <ConfirmDeleteModal
        open={deleteOpen}
        title={t("project.delete-title")}
        description={
          <>
            {t("project.delete-desc-1")}{" "}
            <span className="font-medium">{project?.name ?? projectId}</span>?
            {t("project.delete-desc-2")}{" "}
            <code className="rounded bg-[var(--bg-subtle)] px-1 text-meta">
              video-projects/{projectId}
            </code>{" "}
            {t("project.delete-desc-3")}
          </>
        }
        busy={deleting}
        error={deleteError}
        onClose={() => setDeleteOpen(false)}
        onConfirm={onDelete}
      />

      {/* Modal nhân bản project - thành công thì chuyển thẳng sang project mới */}
      <CloneProjectModal
        source={
          cloneOpen ? { id: projectId, name: project?.name ?? projectId } : null
        }
        onClose={() => setCloneOpen(false)}
        onCloned={(p) => {
          setCloneOpen(false);
          router.push(`/projects/${p.id}`);
        }}
      />

      <Modal
        title={t("project.start-edit")}
        open={editOpen}
        onClose={() => {
          if (!starting) setEditOpen(false);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={starting}
              onClick={() => setEditOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button disabled={starting} onClick={onStartEdit}>
              <Sparkles size={15} strokeWidth={2} />
              {starting ? t("project.starting") : t("project.start-edit-short")}
            </Button>
          </>
        }
      >
        {startError && (
          <ErrorBanner message={t("project.start-error")} detail={startError} />
        )}
        <p className="text-sm text-[var(--text-muted)]">
          {t("project.edit-modal-desc")}
        </p>
        <Panel>
          <BriefSummaryRow label={t("project.sum-source")}>
            {briefView.sourceDescription.trim() || (
              <span className="text-[var(--text-muted)]">
                {t("brief.not-described")}
              </span>
            )}
          </BriefSummaryRow>
          <BriefSummaryRow label={t("brief.edit-request")}>
            {briefView.notes.trim() ? (
              <span className="line-clamp-3 whitespace-pre-line">
                {briefView.notes}
              </span>
            ) : (
              <span className="text-[var(--text-muted)]">{t("brief.none")}</span>
            )}
          </BriefSummaryRow>
          <BriefSummaryRow label={t("project.sum-autocut")}>
            <YesNo value={briefView.autoCut} />
          </BriefSummaryRow>
          <BriefSummaryRow label={t("brief.subtitles")}>
            <YesNo value={briefView.subtitles} />
          </BriefSummaryRow>
          <BriefSummaryRow label={t("brief.highlight")}>
            <YesNo value={briefView.highlightEnabled} />
            {briefView.highlightEnabled &&
              briefView.highlightKeywords.length > 0 && (
                <span className="ml-1 text-[var(--text-muted)]">
                  · {t("project.sum-keywords")}{" "}
                  {briefView.highlightKeywords.join(", ")}
                </span>
              )}
          </BriefSummaryRow>
          <BriefSummaryRow label={t("brief.key-layout")}>
            {briefView.keyLayoutEnabled ? (
              <>
                {t("project.sum-main-key")}{" "}
                {briefView.mainKey.trim() || (
                  <span className="text-[var(--text-muted)]">
                    {t("brief.ai-choose")}
                  </span>
                )}
                {briefView.relatedKeys.length > 0 && (
                  <span className="ml-1 text-[var(--text-muted)]">
                    · {t("project.sum-related-keys")}{" "}
                    {briefView.relatedKeys.join(", ")}
                  </span>
                )}
              </>
            ) : (
              <span className="text-[var(--text-muted)]">{t("common.off")}</span>
            )}
          </BriefSummaryRow>
          <BriefSummaryRow label={t("brief.illustrations")}>
            <YesNo value={briefView.autoIllustrations} />
            {briefView.autoIllustrations && briefView.illustrationModel && (
              <span className="ml-1 text-[var(--text-muted)]">
                · model: {briefView.illustrationModel}
              </span>
            )}
          </BriefSummaryRow>
          <BriefSummaryRow label="Style Design">
            {styleDisplayName(stylesData, briefView.styleId, t)}
          </BriefSummaryRow>
          <BriefSummaryRow label="Skill">
            {briefView.skill ?? t("brief.ai-pick-skill")}
          </BriefSummaryRow>
          <BriefSummaryRow label="Sound effect">
            {t(SFX_MODE_LABEL[briefView.sfxMode])}
          </BriefSummaryRow>
        </Panel>
        <AiModelBlock
          model={editModel}
          effort={editEffort}
          onModelChange={setEditModel}
          onEffortChange={setEditEffort}
          disabled={starting}
        />
        <Field label={t("project.extra-notes")} htmlFor="edit-extra-notes">
          <textarea
            id="edit-extra-notes"
            className="input"
            rows={2}
            value={extraNotes}
            onChange={(e) => setExtraNotes(e.target.value)}
            placeholder={t("projects.notes-placeholder")}
          />
        </Field>
      </Modal>
    </div>
  );
}
