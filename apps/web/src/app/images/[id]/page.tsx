"use client";

/**
 * Chi tiết một Images Project - lắp bằng bộ khối workspace 3 cột dùng chung
 * (`components/Workspace.tsx`), đúng nhịp source → setup → output như mọi trang
 * chi tiết khác:
 *
 * - Cột `source`: thiết lập nội dung (Style Design, prompt, loại ảnh, tỉ lệ,
 *   chữ trên ảnh) - thứ mình BẮT ĐẦU TỪ ĐÓ.
 * - Cột `setup`: nút chạy, model tạo nền, tải nền lên thủ công.
 * - Cột `output`: ảnh thành phẩm ĐỨNG ĐẦU (đang chạy thì hiện tiến trình + log),
 *   rồi tới các bước trung gian.
 *
 * Trước đợt đại tu trang này tự dựng `xl:grid-cols-5` bằng media query nên KHÔNG
 * phản ứng khi người dùng gấp rail trái / panel phải - đúng cái lỗi mà container
 * query của `.workspace-grid` được viết ra để tránh. Tệ hơn: cột kết quả nằm bên
 * TRÁI, ngược với mọi trang chi tiết khác.
 */

import {
  ArrowLeft,
  Copy,
  Download,
  Image as ImageIcon,
  Layers,
  Maximize2,
  Save,
  ScrollText,
  Trash2,
  Upload,
  Wand2,
  Zap,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  cloneImageProject,
  deleteImageProject,
  generateImage,
  getImageProject,
  getJobs,
  imageFileUrl,
  renameImageProject,
  updateImageProject,
  uploadImageBackground,
  type FileInfo,
  type ImageGenStep,
  type ImageProject,
  type JobStatus,
} from "@/lib/api";
import {
  MediaPreviewModal,
  ZoomableThumb,
  imageFileInfo,
} from "@/components/MediaPreviewModal";
import { useEvents, useJobEvents, useJobLogEvents } from "@/lib/useEvents";
import { Card } from "@/components/Card";
import { JobBadge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { CloneProjectModal } from "@/components/CloneProjectModal";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { EditableTitle } from "@/components/EditableTitle";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import {
  AspectChip,
  ImageProjectFields,
  ImageStatusBadge,
  KIND_LABEL,
  useGeminiImageModels,
  type ImageDraft,
} from "@/components/ImageProjectForm";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { ProgressBar } from "@/components/ProgressBar";
import { ShellRightPanel } from "@/components/Shell";
import { Skeleton } from "@/components/Skeleton";
import {
  Workspace,
  WorkspaceBlock,
  WorkspaceColumn,
} from "@/components/Workspace";
import { useProviders } from "@/components/ModelPicker";
import { formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";

/** Job image-gen đang theo dõi trên trang - cập nhật realtime qua SSE. */
interface ActiveJob {
  id: string;
  progress: number;
  step: string;
  status: JobStatus;
}

/** Giữ card tiến trình thêm 3s sau khi job kết thúc rồi mới ẩn. */
const JOB_LINGER_MS = 3000;
/** Giới hạn số dòng log giữ trong bộ nhớ trang. */
const MAX_LOG_LINES = 300;

/**
 * Ô ảnh nhỏ trong khối "Các bước" - Background | Final.
 * Bấm vào mở modal xem chi tiết (trước đây ảnh trơ, không bấm được).
 */
function StepThumb({
  label,
  file,
  alt,
  onOpen,
}: {
  label: string;
  file: FileInfo | null;
  alt: string;
  onOpen: (file: FileInfo) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-meta text-[var(--text-muted)]" title={label}>
        {label}
      </span>
      {/* Cùng khung `.workspace-media` với ảnh thành phẩm - một hợp đồng CSS cho
          mọi ô media trong dashboard, không chép tay lại viền/nền/bo góc. */}
      <div
        className="workspace-media"
        style={{ "--workspace-aspect": "4 / 3" } as CSSProperties}
      >
        {file ? (
          <ZoomableThumb
            file={file}
            alt={alt}
            onOpen={onOpen}
            className="h-full w-full"
            imgClassName="h-full w-full object-contain"
            iconSize={20}
          />
        ) : (
          <ImageIcon
            size={22}
            strokeWidth={1.5}
            className="text-[var(--text-muted)] opacity-40"
          />
        )}
      </div>
    </div>
  );
}

export default function ImageProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const imageId = params.id;
  const router = useRouter();
  const { t, tf } = useT();

  const [proj, setProj] = useState<ImageProject | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form sửa (prompt/loại/tỉ lệ/overlay) - bản nháp tách khỏi dữ liệu server
  const [draft, setDraft] = useState<ImageDraft | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [genError, setGenError] = useState<string | null>(null);
  const [genSubmitting, setGenSubmitting] = useState(false);
  const [uploadingBg, setUploadingBg] = useState(false);
  const bgInputRef = useRef<HTMLInputElement>(null);

  // Select model ở cột thiết lập - danh sách live + auto-save khi chọn
  const {
    models: liveModels,
    loading: modelsLoading,
    load: loadModels,
  } = useGeminiImageModels();
  const [modelSaving, setModelSaving] = useState(false);

  // Ảnh đang xem chi tiết - dùng modal chung MediaPreviewModal (Esc, mở tab
  // mới, mở file trong Explorer) thay cho lightbox tự chế trước đây
  const [preview, setPreview] = useState<FileInfo | null>(null);
  /** relPath của một file trong thư mục project ảnh này, kèm cache-bust */
  const fileOf = useCallback(
    (fileName: string, label: string): FileInfo =>
      imageFileInfo(`image-projects/${imageId}/${fileName}`, {
        name: label,
        version: proj?.updatedAt,
      }),
    [imageId, proj?.updatedAt],
  );

  // Job image-gen đang chạy/vừa xong của dự án này - tiến trình thật qua SSE
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const activeJobIdRef = useRef<string | null>(null);
  const lingerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logBoxRef = useRef<HTMLPreElement>(null);

  const { providers } = useProviders();
  const gemini = providers?.find((p) => p.id === "gemini");
  const geminiConnected = gemini?.connected === true;

  const load = useCallback(async () => {
    try {
      const p = await getImageProject(imageId);
      setProj(p);
      setError(null);
      // chỉ khởi tạo draft lần đầu - không ghi đè khi user đang sửa form
      setDraft(
        (d) =>
          d ?? {
            prompt: p.prompt,
            kind: p.kind,
            aspect: p.aspect,
            overlay: p.overlay,
            model: p.model,
            styleId: p.styleId ?? null,
          }
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [imageId]);

  // resyncTick: SSE vừa nối lại sau khi đứt - job có thể đã xong trong lúc đứt
  // mà event "done" không tới, nút tạo/upload sẽ khóa mãi nếu không đối chiếu lại
  const { resyncTick } = useEvents();
  useEffect(() => {
    load();
  }, [load, resyncTick]);

  // Mới mở trang (hoặc SSE nối lại): tìm job image-gen của dự án này còn
  // queued/running → bám theo; không còn job nào mà card vẫn đang chờ → gỡ card
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const jobs = await getJobs(50);
        const j = jobs.find(
          (x) =>
            x.type === "image-gen" &&
            x.projectId === imageId &&
            (x.status === "queued" || x.status === "running")
        );
        if (alive && j) {
          activeJobIdRef.current = j.id;
          setActiveJob({
            id: j.id,
            progress: j.progress,
            step: j.step,
            status: j.status,
          });
        } else if (alive && !lingerTimerRef.current) {
          activeJobIdRef.current = null;
          setActiveJob(null);
        }
      } catch {
        // không tìm được job đang chạy - SSE sẽ bắt kịp khi có event mới
      }
    })();
    return () => {
      alive = false;
    };
  }, [imageId, resyncTick]);

  // Dọn timer giữ card tiến trình khi rời trang
  useEffect(
    () => () => {
      if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    },
    []
  );

  // Job "image-gen" của dự án ảnh này → cập nhật tiến trình sống
  useJobEvents((job) => {
    if (job.type !== "image-gen" || job.projectId !== imageId) return;
    if (activeJobIdRef.current !== job.id) {
      // job mới → reset log của job cũ
      activeJobIdRef.current = job.id;
      setLogLines([]);
    }
    if (lingerTimerRef.current) {
      clearTimeout(lingerTimerRef.current);
      lingerTimerRef.current = null;
    }
    setActiveJob({
      id: job.id,
      progress: job.progress,
      step: job.step,
      status: job.status,
    });
    if (["done", "failed", "canceled"].includes(job.status)) {
      load();
      // giữ kết quả 3 giây cho user kịp thấy rồi mới ẩn card tiến trình
      lingerTimerRef.current = setTimeout(() => {
        lingerTimerRef.current = null;
        activeJobIdRef.current = null;
        setActiveJob(null);
        setLogLines([]);
      }, JOB_LINGER_MS);
    } else {
      setProj((p) => (p ? { ...p, status: "generating" } : p));
    }
  });

  // Log từng dòng của job đang theo dõi → panel "Nhật ký AI" bên phải
  useJobLogEvents((e) => {
    if (e.jobId !== activeJobIdRef.current) return;
    setLogLines((cur) => [...cur.slice(-(MAX_LOG_LINES - 1)), e.line]);
  });

  // Auto-scroll xuống dòng log mới nhất
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLines]);

  const jobRunning =
    activeJob !== null &&
    (activeJob.status === "queued" || activeJob.status === "running");
  const generating = proj?.status === "generating" || jobRunning;

  /** Đổi tên ngay trên tiêu đề - server là nguồn sự thật, lấy tên nó trả về. */
  async function saveName(next: string) {
    setProj(await renameImageProject(imageId, next));
  }

  async function onSave() {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const p = await updateImageProject(imageId, {
        prompt: draft.prompt,
        kind: draft.kind,
        aspect: draft.aspect,
        overlay: draft.overlay,
        model: draft.model,
        styleId: draft.styleId,
      });
      setProj(p);
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function runGenerate(step: ImageGenStep) {
    if (genSubmitting || generating) return;
    setGenSubmitting(true);
    setGenError(null);
    try {
      // Form đang sửa dở → lưu trước để job dùng đúng prompt/overlay/model mới nhất
      if (draft) await onSaveSilent();
      const job = await generateImage(imageId, step);
      // Bám theo job ngay - không chờ event SSE đầu tiên
      activeJobIdRef.current = job.id;
      setLogLines([]);
      setActiveJob({
        id: job.id,
        progress: job.progress,
        step: job.step,
        status: job.status,
      });
      setProj((p) => (p ? { ...p, status: "generating" } : p));
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenSubmitting(false);
    }
  }

  /** Lưu form không hiện cờ "Đã lưu" - dùng trước khi chạy generate. */
  async function onSaveSilent() {
    if (!draft) return;
    const p = await updateImageProject(imageId, {
      prompt: draft.prompt,
      kind: draft.kind,
      aspect: draft.aspect,
      overlay: draft.overlay,
      model: draft.model,
      styleId: draft.styleId,
    });
    setProj(p);
  }

  /** Chọn model ở cột thiết lập → PUT ngay (auto-save, không cần bấm Lưu). */
  async function onModelChange(next: string | null) {
    setDraft((d) => (d ? { ...d, model: next } : d));
    setModelSaving(true);
    setGenError(null);
    try {
      setProj(await updateImageProject(imageId, { model: next }));
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setModelSaving(false);
    }
  }

  async function onUploadBackground(file: File) {
    setUploadingBg(true);
    setGenError(null);
    try {
      setProj(await uploadImageBackground(imageId, file));
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingBg(false);
    }
  }

  // Modal xác nhận xóa dự án ảnh - bắt gõ DELETE (thay window.confirm)
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function onDelete() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteImageProject(imageId);
      router.push("/images");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  const geminiTooltip = geminiConnected
    ? undefined
    : t("imageDetail.gemini-tooltip");

  // Select model gọn ở cột thiết lập - live list, fallback danh sách tĩnh
  const currentModel = draft?.model ?? proj?.model ?? null;
  const modelOptions = liveModels ?? gemini?.models ?? [];
  const modelMissing =
    currentModel !== null && !modelOptions.some((m) => m.id === currentModel);

  // Tỉ lệ khung của khung ảnh thành phẩm - "9:16" của meta đổi sang cú pháp CSS
  const aspectRatio = (proj?.aspect ?? "9:16").replace(":", " / ");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={
          <EditableTitle
            value={proj?.name ?? null}
            fallback={imageId}
            onSave={saveName}
            onError={setRenameError}
            editLabel={t("imageDetail.rename")}
            emptyError={t("imageDetail.name-required")}
            saveLabel={t("common.save")}
            cancelLabel={t("common.cancel")}
          />
        }
        subtitle={
          proj
            ? `${t(KIND_LABEL[proj.kind])} · ${tf("project.updated", { time: formatRelative(proj.updatedAt) })}`
            : undefined
        }
        actions={
          /* QUY ƯỚC NÚT PHÁ HỦY - áp giống hệt ở cả 7 trang chi tiết (Videos
             Project, Images Project, Auto cut, Text to video, Dịch video, Style
             Design, Phong cách dựng). Trang này từng là ví dụ tệ nhất: "Xóa
             project" đứng KẸP GIỮA "Nhân bản" và nút chính "Lưu thay đổi", cùng
             cỡ cùng gap-2 - trượt tay một nút là mất cả project, mà thao tác đó
             không hoàn tác được.
             Luật: mọi nút thường (kể cả nút chính) gom vào MỘT cụm; nút xóa
             đứng CUỐI, ngoài cụm, ngăn bằng một vạch dọc `border-l` + `pl-2`.
             Nó không bao giờ nằm giữa hai nút thường, và con trỏ phải đi qua
             một ranh giới nhìn thấy được mới tới nó.
             Vạch dọc chứ không phải `ml-auto`: hàng actions là flex item co
             theo nội dung trong `justify-between` của PageHeader, không có chỗ
             trống nào cho `auto` margin ăn - `ml-auto` ở đây không đẩy được gì. */
          <>
            <span className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => router.push("/images")}>
                <ArrowLeft size={15} strokeWidth={2} />
                {t("imageDetail.back")}
              </Button>
              {/* Nhân bản KHÔNG bị khóa khi đang generate: bản sao là project
                  khác, chép nền hiện có - không đụng gì tới job đang chạy */}
              <Button
                variant="secondary"
                disabled={!proj}
                title={t("imageDetail.clone-title")}
                onClick={() => setCloneOpen(true)}
              >
                <Copy size={15} strokeWidth={2} />
                {t("clone.action")}
              </Button>
              <Button onClick={onSave} disabled={saving || !draft}>
                <Save size={15} strokeWidth={2} />
                {saving ? t("common.saving") : t("imageDetail.save-changes")}
              </Button>
            </span>
            <span className="flex items-center border-l border-[var(--border)] pl-2">
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 size={15} strokeWidth={2} />
                {t("imageDetail.delete-project")}
              </Button>
            </span>
          </>
        }
      />

      {proj && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)]">
          <ImageStatusBadge status={proj.status} />
          <AspectChip aspect={proj.aspect} />
          <span className="text-meta">ID: {proj.id}</span>
        </div>
      )}

      {renameError && (
        <ErrorBanner message={t("imageDetail.rename-error")} detail={renameError} />
      )}
      {error && (
        <ErrorBanner message={t("imageDetail.load-error")} detail={error} />
      )}
      {saveError && (
        <ErrorBanner message={t("common.save-error")} detail={saveError} />
      )}
      {saved && <Banner tone="success" message={t("common.saved")} />}
      {proj?.status === "error" && proj.error && (
        <ErrorBanner message={t("imageDetail.last-gen-error")} detail={proj.error} />
      )}

      {/* Ba cột theo nhịp làm việc. Số cột do container query trong globals.css
          lo, trang không tự tính pixel và không dùng media query. */}
      <Workspace>
        {/* ================= Cột 1: nội dung ================= */}
        <WorkspaceColumn role="source" title={t("workspace.col.source")}>
          <Card title={t("imageDetail.settings")}>
            {draft ? (
              <div className="flex flex-col gap-3">
                <p className="t-eyebrow">{t("imageDetail.content")}</p>
                {/* Tên KHÔNG còn ở đây - sửa thẳng trên tiêu đề trang, lưu ngay,
                    không phải bấm Lưu chung với prompt/overlay đang sửa dở */}
                <ImageProjectFields
                  value={draft}
                  onChange={(p) => {
                    setDraft((d) => (d ? { ...d, ...p } : d));
                    setSaved(false);
                  }}
                  disabled={saving}
                  idPrefix="image-edit"
                  showModel={false}
                  sectioned
                />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            )}
          </Card>
        </WorkspaceColumn>

        {/* ============ Cột 2: yêu cầu & thiết lập ============ */}
        <WorkspaceColumn role="setup" title={t("workspace.col.setup")}>
          <Card title={t("imageDetail.generate-card")}>
            <div className="flex flex-col gap-3">
              {genError && (
                <Banner
                  tone="danger"
                  message={t("imageDetail.run-error")}
                  detail={genError}
                />
              )}

              {/* Hành động chính - full-width, một chạm */}
              <span title={geminiTooltip} className="block">
                <Button
                  className="w-full"
                  disabled={genSubmitting || generating || !geminiConnected}
                  onClick={() => runGenerate("all")}
                >
                  <Zap size={15} strokeWidth={2} />
                  {t("imageDetail.generate-all")}
                </Button>
              </span>

              {/* Model tạo nền - live list, auto-save khi chọn */}
              <Field
                label={t("imageDetail.bg-model")}
                htmlFor="image-quick-model"
                hint={
                  modelsLoading
                    ? t("images.loading-models")
                    : modelSaving
                      ? t("common.saving")
                      : undefined
                }
              >
                <select
                  id="image-quick-model"
                  className="input"
                  value={currentModel ?? ""}
                  disabled={modelSaving}
                  onFocus={loadModels}
                  onChange={(e) => onModelChange(e.target.value || null)}
                >
                  <option value="">{t("images.model-default")}</option>
                  {modelMissing && (
                    <option value={currentModel!}>{currentModel}</option>
                  )}
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>

              {/* Chạy từng bước riêng lẻ */}
              <div className="grid grid-cols-2 gap-2">
                <span title={geminiTooltip} className="min-w-0">
                  <Button
                    variant="secondary"
                    small
                    className="w-full"
                    disabled={genSubmitting || generating || !geminiConnected}
                    onClick={() => runGenerate("background")}
                  >
                    <Wand2 size={14} strokeWidth={2} />
                    {t("imageDetail.gen-bg")}
                  </Button>
                </span>
                <span
                  className="min-w-0"
                  title={proj?.background ? undefined : t("imageDetail.need-bg")}
                >
                  <Button
                    variant="secondary"
                    small
                    className="w-full"
                    disabled={genSubmitting || generating || !proj?.background}
                    onClick={() => runGenerate("compose")}
                  >
                    <Layers size={14} strokeWidth={2} />
                    {t("imageDetail.compose")}
                  </Button>
                </span>
              </div>
              {!geminiConnected && gemini && (
                <p className="text-meta text-[var(--text-muted)]">
                  {t("imageDetail.gemini-hint")}
                </p>
              )}

              {/* Đường vòng khi không có Gemini: tự tải ảnh nền lên. Xóa project
                  đã dọn lên PageHeader cùng chỗ với 5 trang chi tiết khác. */}
              <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
                <Button
                  variant="secondary"
                  small
                  disabled={uploadingBg || generating}
                  title={t("imageDetail.upload-bg-title")}
                  onClick={() => bgInputRef.current?.click()}
                >
                  <Upload size={14} strokeWidth={2} />
                  {uploadingBg
                    ? t("imageDetail.uploading-bg")
                    : t("imageDetail.upload-bg")}
                </Button>
              </div>

              <input
                ref={bgInputRef}
                type="file"
                accept=".png,.jpg,.jpeg"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUploadBackground(f);
                  e.target.value = "";
                }}
              />
            </div>
          </Card>
        </WorkspaceColumn>

        {/* ============ Cột 3: tiến trình & kết quả ============ */}
        <WorkspaceColumn role="output" title={t("workspace.col.output")}>
          {/* Khối ĐẦU TIÊN của cột: ảnh thành phẩm. Cùng vai trò với
              <OutputBlock> của trang video, chỉ khác nó dựng ảnh chứ không dựng
              thẻ <video> - vẫn dùng chung khung `.workspace-media`. */}
          <WorkspaceBlock
            id="image-block-output"
            icon={ImageIcon}
            title={t("imageDetail.final-card")}
            summary={proj?.final ?? t("imageDetail.no-final")}
            actions={
              proj?.final ? (
                <>
                  <IconButton
                    label={t("common.zoom")}
                    onClick={() => setPreview(fileOf(proj.final!, "Final"))}
                  >
                    <Maximize2 size={15} strokeWidth={2} />
                  </IconButton>
                  <a
                    href={imageFileUrl(imageId, proj.final, proj.updatedAt)}
                    download
                    title={t("imageDetail.download")}
                    aria-label={t("imageDetail.download")}
                    className="icon-btn"
                  >
                    <Download size={15} strokeWidth={2} />
                  </a>
                </>
              ) : undefined
            }
          >
            <div className="flex flex-col gap-3">
              {(activeJob || generating) && (
                <Panel
                  title={t("imageDetail.progress")}
                  actions={<JobBadge status={activeJob?.status ?? "running"} />}
                >
                  {activeJob ? (
                    <ProgressBar
                      progress={activeJob.progress}
                      step={activeJob.step || undefined}
                    />
                  ) : (
                    <div
                      className="progress-indeterminate"
                      aria-label={t("imageDetail.generating-aria")}
                    />
                  )}
                  {activeJob?.status === "failed" && (
                    <Banner
                      tone="danger"
                      message={t("imageDetail.gen-failed")}
                      detail={proj?.error ?? undefined}
                    />
                  )}
                </Panel>
              )}

              {/* Log KHÔNG còn ở đây - nó nằm trong panel phải của shell, cùng
                  chỗ với Videos Project / Text to video / Dịch video. Để hai
                  bản là cùng một dòng log hiện ở hai nơi. */}

              <div
                className="workspace-media"
                // Tỉ lệ đi qua biến CSS chứ không qua class Tailwind: giá trị
                // đến từ meta.json của project, không phải danh sách biết trước.
                style={{ "--workspace-aspect": aspectRatio } as CSSProperties}
              >
                {proj?.final ? (
                  // Ảnh chính cũng bấm được để xem full - không bắt người dùng
                  // phải tìm ra nút "Phóng to" ở góc khối
                  <ZoomableThumb
                    file={fileOf(proj.final, "Final")}
                    alt={tf("imageDetail.final-alt-name", { name: proj.name })}
                    onOpen={setPreview}
                    className="h-full w-full"
                    imgClassName="h-full w-full object-contain"
                    iconSize={24}
                  />
                ) : generating || activeJob ? (
                  <>
                    <span className="workspace-shimmer" aria-hidden="true" />
                    <div
                      className="relative px-4 text-center"
                      role="status"
                      aria-live="polite"
                    >
                      <p className="text-sm text-[var(--text-muted)]">
                        {t("imageDetail.generating-aria")}
                      </p>
                    </div>
                  </>
                ) : (
                  <EmptyState
                    icon={ImageIcon}
                    description={t("imageDetail.no-final")}
                  />
                )}
              </div>
            </div>
          </WorkspaceBlock>

          {/* CHỈ còn ảnh nền. Ảnh final ĐÃ hiện ngay trên đầu cột trong
              `workspace-media` của khối kết quả - để thêm một ô "Final" ở đây là
              cùng một ảnh render hai lần trên cùng màn hình, và nhãn của nó còn
              là chuỗi tiếng Anh gõ tay giữa giao diện tiếng Việt. */}
          <Card title={t("imageDetail.steps")}>
            <StepThumb
              label={t("imageDetail.step-bg")}
              file={
                proj?.background
                  ? fileOf(proj.background, t("imageDetail.step-bg"))
                  : null
              }
              alt={t("imageDetail.bg-alt")}
              onOpen={setPreview}
            />
          </Card>
        </WorkspaceColumn>
      </Workspace>

      {/* Nhật ký AI của job tạo ảnh - panel phải của shell, giống bốn trang chi
          tiết còn lại. Panel LUÔN khai báo (kể cả lúc chưa chạy job nào) để
          người dùng biết chỗ đó có gì; chưa có log thì hiện EmptyState chứ
          không để panel trống trơn. Cây React vẫn nằm ở trang này nên state
          logLines / SSE giữ nguyên, chỉ đổi chỗ vẽ ra màn hình. */}
      <ShellRightPanel title={t("imageDetail.ai-panel")}>
        {activeJob || logLines.length > 0 ? (
          // min-h-0 + flex-1 để <pre> cao bằng panel rồi tự cuộn bên trong
          <Panel
            className="min-h-0 flex-1"
            title={tf("imageDetail.view-log", { n: logLines.length })}
            actions={
              activeJob ? <JobBadge status={activeJob.status} /> : undefined
            }
          >
            {/* Thanh tiến trình KHÔNG lặp lại ở đây - nó đã nằm trong khối kết
                quả ở cột phải của workspace, panel này chỉ lo phần log. */}
            {/* break-anywhere BẮT BUỘC: log của Gemini/Remotion có đường dẫn và
                chuỗi base64 dài không một khoảng trắng, mà `pre-wrap` chỉ ngắt ở
                khoảng trắng nên chúng đẩy toác cả panel. */}
            <pre
              ref={logBoxRef}
              className="min-h-32 min-w-0 flex-1 overflow-auto rounded-[var(--radius)] bg-[var(--surface)] p-2 font-mono text-meta whitespace-pre-wrap [overflow-wrap:anywhere]"
            >
              {logLines.length > 0
                ? logLines.join("\n")
                : t("imageDetail.no-log")}
            </pre>
          </Panel>
        ) : (
          <Panel className="min-h-0 flex-1 items-center justify-center">
            <EmptyState
              icon={ScrollText}
              description={t("imageDetail.ai-panel-empty")}
            />
          </Panel>
        )}
      </ShellRightPanel>

      {/* Modal xác nhận xóa dự án ảnh - bắt gõ DELETE */}
      <ConfirmDeleteModal
        open={deleteOpen}
        title={t("imageDetail.delete-title")}
        description={
          <>
            {t("imageDetail.delete-desc-1")}{" "}
            <span className="font-medium">{proj?.name ?? imageId}</span>? {t("project.delete-desc-2")}{" "}
            <code className="rounded bg-[var(--bg-subtle)] px-1 text-meta">
              image-projects/{imageId}
            </code>{" "}
            {t("project.delete-desc-3")}
          </>
        }
        busy={deleting}
        error={deleteError}
        onClose={() => setDeleteOpen(false)}
        onConfirm={onDelete}
      />

      {/* Nhân bản → mở thẳng bản sao: người ta nhân bản để SỬA bản sao, ở lại
          bản gốc thì lần nào cũng phải tự đi tìm project mới */}
      <CloneProjectModal
        source={cloneOpen ? { id: imageId, name: proj?.name ?? imageId } : null}
        clone={cloneImageProject}
        descriptionKey="clone.image-description"
        onClose={() => setCloneOpen(false)}
        onCloned={(p) => {
          setCloneOpen(false);
          router.push(`/images/${p.id}`);
        }}
      />

      {/* Xem chi tiết ảnh - modal dùng chung toàn app (Esc, mở tab mới, mở file) */}
      <MediaPreviewModal file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
