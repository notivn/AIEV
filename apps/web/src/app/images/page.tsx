"use client";

import {
  Copy,
  Filter,
  Image as ImageIcon,
  Images,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cleanImageJunk,
  cloneImageProject,
  createImageProject,
  deleteImageProject,
  getImageJunk,
  getImageProjects,
  getJobs,
  renameImageProject,
  type FileInfo,
  type ImageProject,
} from "@/lib/api";
import { useEvents, useJobEvents } from "@/lib/useEvents";
import { Card } from "@/components/Card";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { CloneProjectModal } from "@/components/CloneProjectModal";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { TableSkeleton } from "@/components/Skeleton";
import { Toolbar } from "@/components/Toolbar";
import {
  AspectChip,
  DEFAULT_IMAGE_DRAFT,
  ImageProjectFields,
  ImageStatusBadge,
  type ImageDraft,
} from "@/components/ImageProjectForm";
import {
  MediaPreviewModal,
  ZoomableThumb,
  imageFileInfo,
} from "@/components/MediaPreviewModal";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { RenameProjectModal } from "@/components/RenameProjectModal";
import { ProgressBar } from "@/components/ProgressBar";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";

// ============ Danh sách dự án ảnh ============

function ImageProjectList({ onCreate }: { onCreate: () => void }) {
  const { t, tf } = useT();
  const router = useRouter();
  const [list, setList] = useState<ImageProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tìm theo tên / id - cùng khuôn với trang Videos Project
  const [query, setQuery] = useState("");
  // Xem chi tiết ảnh ngay từ danh sách, không phải vào trang con
  const [preview, setPreview] = useState<FileInfo | null>(null);
  // Tiến trình thật của job image-gen theo projectId - cho ProgressBar mini trong bảng
  const [genProgress, setGenProgress] = useState<
    Record<string, { progress: number; step: string }>
  >({});

  // Chọn nhiều dự án ảnh
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);

  // Đổi tên / nhân bản một dự án ảnh
  const [renameTarget, setRenameTarget] = useState<ImageProject | null>(null);
  const [cloneSource, setCloneSource] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [cloneNotice, setCloneNotice] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // Bulk "Xóa file rác" trên các dự án đã chọn
  const [junkBusy, setJunkBusy] = useState(false);
  const [bulkActionNotice, setBulkActionNotice] = useState<string | null>(null);
  const [bulkActionErrors, setBulkActionErrors] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const [projects, jobs] = await Promise.all([
        getImageProjects(),
        // tìm job image-gen còn queued/running khi mới mở trang → seed progress
        getJobs(50).catch(() => []),
      ]);
      setList(projects);
      const map: Record<string, { progress: number; step: string }> = {};
      for (const j of jobs) {
        if (
          j.type === "image-gen" &&
          (j.status === "queued" || j.status === "running")
        ) {
          map[j.projectId] = { progress: j.progress, step: j.step };
        }
      }
      setGenProgress(map);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // resyncTick: SSE vừa nối lại - job có thể đã xong trong lúc đứt, refetch
  // để thanh tiến trình không kẹt
  const { resyncTick } = useEvents();
  useEffect(() => {
    load();
  }, [load, resyncTick]);

  // Job "image-gen" đổi trạng thái → cập nhật sống danh sách + progress
  useJobEvents((job) => {
    if (job.type !== "image-gen") return;
    if (["done", "failed", "canceled"].includes(job.status)) {
      setGenProgress((m) => {
        if (!(job.projectId in m)) return m;
        const next = { ...m };
        delete next[job.projectId];
        return next;
      });
      load();
    } else {
      setGenProgress((m) => ({
        ...m,
        [job.projectId]: { progress: job.progress, step: job.step },
      }));
      // job vừa chạy → đánh dấu generating ngay, không chờ refetch
      setList(
        (cur) =>
          cur?.map((p) =>
            p.id === job.projectId && p.status !== "generating"
              ? { ...p, status: "generating" as const }
              : p
          ) ?? cur
      );
    }
  });

  const filtered = useMemo(() => {
    if (!list) return null;
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    );
  }, [list, query]);

  // Đổi từ khóa tìm kiếm thì BỬe những mục đã tick mà giờ không còn hiện.
  // Không dọn thì: lọc "a" → chọn 5 → đổi sang "b" → thanh công cụ vẫn báo
  // "5 đã chọn" trong khi màn hình toàn hàng khác, và "Xóa đã chọn" xóa luôn
  // 5 mục người dùng không nhìn thấy.
  useEffect(() => {
    if (!filtered) return;
    const visible = new Set(filtered.map((p) => p.id));
    setSelected((cur) => {
      const next = new Set([...cur].filter((id) => visible.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [filtered]);

  // ---- Chọn / bỏ chọn ----
  // Tick "chọn tất cả" chỉ áp lên các hàng ĐANG HIỆN, không lén chọn cả những
  // dự án bị ô tìm kiếm lọc ra ngoài.

  const allSelected =
    !!filtered && filtered.length > 0 && filtered.every((p) => selected.has(p.id));
  const someSelected =
    !!filtered && !allSelected && filtered.some((p) => selected.has(p.id));

  function toggleOne(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!filtered) return;
    setSelected((cur) => {
      const next = new Set(cur);
      if (allSelected) {
        for (const p of filtered) next.delete(p.id);
      } else {
        for (const p of filtered) next.add(p.id);
      }
      return next;
    });
  }

  const selectedProjects = useMemo(
    () => (list ?? []).filter((p) => selected.has(p.id)),
    [list, selected]
  );

  // ---- Xóa nhiều dự án ảnh ----

  async function onDeleteSelected() {
    if (bulkDeleting || junkBusy || selectedProjects.length === 0) return;
    const targets = selectedProjects;
    setBulkDeleting(true);
    setBulkErrors([]);
    // Xóa TUẦN TỰ - lỗi nào gom lại hiện sau
    const errors: string[] = [];
    for (const p of targets) {
      try {
        await deleteImageProject(p.id);
      } catch (e) {
        errors.push(
          `${p.name} (${p.id}): ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    setBulkDeleting(false);
    setBulkDeleteOpen(false);
    setSelected(new Set());
    setBulkErrors(errors);
    await load();
  }

  // ---- Xóa file rác hàng loạt ----

  async function onBulkCleanJunk() {
    if (bulkDeleting || junkBusy || selectedProjects.length === 0) return;
    setJunkBusy(true);
    setBulkActionNotice(null);
    setBulkActionErrors([]);
    const targets = selectedProjects;
    const errors: string[] = [];
    try {
      // Quét file rác từng dự án để confirm MỘT lần với tổng dung lượng
      const junks: { id: string; name: string; items: number; bytes: number }[] =
        [];
      for (const p of targets) {
        try {
          const junk = await getImageJunk(p.id);
          if (junk.items.length > 0) {
            junks.push({
              id: p.id,
              name: p.name,
              items: junk.items.length,
              bytes: junk.totalBytes,
            });
          }
        } catch (e) {
          errors.push(
            `${p.name} (${p.id}): ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
      if (junks.length === 0) {
        if (errors.length > 0) setBulkActionErrors(errors);
        else setBulkActionNotice(t("junk.none"));
        return;
      }
      const totalItems = junks.reduce((sum, j) => sum + j.items, 0);
      const totalBytes = junks.reduce((sum, j) => sum + j.bytes, 0);
      if (
        !window.confirm(
          tf("imagesPage.junk-confirm", {
            items: totalItems,
            projects: junks.length,
            size: formatBytes(totalBytes),
          })
        )
      )
        return;
      // Xóa tuần tự - dự án đang có job server trả 409, gom lỗi và đi tiếp
      let freed = 0;
      let deleted = 0;
      let cleaned = 0;
      for (const j of junks) {
        try {
          const result = await cleanImageJunk(j.id);
          freed += result.freedBytes;
          deleted += result.deleted;
          cleaned++;
        } catch (e) {
          errors.push(
            `${j.name} (${j.id}): ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
      if (cleaned > 0) {
        setBulkActionNotice(
          tf("imagesPage.junk-freed", {
            size: formatBytes(freed),
            items: deleted,
            projects: cleaned,
          })
        );
      }
      if (errors.length > 0) setBulkActionErrors(errors);
      await load();
    } finally {
      setJunkBusy(false);
    }
  }

  return (
    <>
      {error && (
        <ErrorBanner message={t("imagesPage.load-error")} detail={error} />
      )}
      {bulkErrors.length > 0 && (
        <ErrorBanner
          message={tf("imagesPage.bulk-delete-errors", { n: bulkErrors.length })}
          detail={bulkErrors.join("\n")}
        />
      )}
      {bulkActionNotice && <Banner tone="success" message={bulkActionNotice} />}
      {bulkActionErrors.length > 0 && (
        <ErrorBanner
          message={tf("imagesPage.bulk-action-errors", { n: bulkActionErrors.length })}
          detail={bulkActionErrors.join("\n")}
        />
      )}

      {/* Nhân bản xong thì Ở LẠI danh sách kèm link mở bản sao - khác trang chi
          tiết (nhảy thẳng sang bản sao): ở đây người ta thường nhân bản vài cái
          liền tay, bị đá sang trang khác là mất mạch */}
      {cloneNotice && (
        <Banner
          tone="success"
          message={
            <>
              {t("projects.cloned-to")}{" "}
              <span className="font-medium">{cloneNotice.name}</span> -{" "}
              <Link
                href={`/images/${cloneNotice.id}`}
                className="font-medium underline underline-offset-2"
              >
                {t("projects.open-new")}
              </Link>
            </>
          }
        />
      )}

      <Card>
        <Toolbar
          search={{
            value: query,
            onChange: setQuery,
            placeholder: t("imagesPage.search-placeholder"),
          }}
          selectedCount={selected.size}
          onClearSelection={() => setSelected(new Set())}
          bulkActions={
            <>
              <Button
                variant="secondary"
                small
                disabled={bulkDeleting || junkBusy}
                onClick={onBulkCleanJunk}
              >
                <Trash2 size={14} strokeWidth={2} />
                {junkBusy ? t("junk.cleaning") : t("junk.clean")}
              </Button>
              <Button
                variant="destructive"
                small
                disabled={bulkDeleting || junkBusy}
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 size={14} strokeWidth={2} />
                {bulkDeleting
                  ? t("common.deleting")
                  : t("common.delete-selected")}
              </Button>
            </>
          }
        />

        {/* Khung chờ CHỈ hiện khi đang tải thật. Tải hỏng thì chỉ còn banner đỏ
            ở trên: để khung chờ chạy tiếp là vừa báo "đang tải" vừa báo "tải lỗi"
            cùng lúc, mà cho danh sách về rỗng thì lại nói dối là "chưa có gì". */}
        {!list ? (
          !error && <TableSkeleton />
        ) : filtered && filtered.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th className="w-8">
                  <input
                    type="checkbox"
                    className="checkbox align-middle"
                    aria-label={t("imagesPage.select-all")}
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                  />
                </th>
                <th className="w-12">
                  <span className="sr-only">{t("imagesPage.col-image")}</span>
                </th>
                <th>{t("common.name")}</th>
                <th>{t("common.status")}</th>
                <th>{t("imagesPage.col-aspect")}</th>
                <th>Model</th>
                <th>{t("common.created")}</th>
                <th>{t("common.updated")}</th>
                <th className="w-20">
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const thumb = p.final ?? p.background;
                return (
                  <tr
                    key={p.id}
                    className="row-click"
                    onClick={() => router.push(`/images/${p.id}`)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="checkbox align-middle"
                        aria-label={tf("common.select-aria", { name: p.name })}
                        checked={selected.has(p.id)}
                        disabled={bulkDeleting}
                        onChange={() => toggleOne(p.id)}
                      />
                    </td>
                    {/* stopPropagation: bấm ảnh là XEM ẢNH, không phải mở project
                        (cả hàng vốn click được để vào trang chi tiết) */}
                    <td onClick={(e) => e.stopPropagation()}>
                      {thumb ? (
                        <ZoomableThumb
                          file={imageFileInfo(
                            `image-projects/${p.id}/${thumb}`,
                            { name: p.name, version: p.updatedAt },
                          )}
                          alt={p.name}
                          onOpen={setPreview}
                          className="h-10 w-10 rounded-[var(--radius)] bg-[var(--bg-subtle)]"
                          imgClassName="h-full w-full object-cover"
                          iconSize={14}
                        />
                      ) : (
                        <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-[var(--radius)] bg-[var(--bg-subtle)]">
                          <ImageIcon
                            size={18}
                            strokeWidth={1.5}
                            className="text-[var(--text-muted)] opacity-60"
                          />
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="font-medium">{p.name}</span>
                      <span className="ml-2 text-meta text-[var(--text-muted)]">
                        {p.id}
                      </span>
                    </td>
                    <td>
                      <ImageStatusBadge status={p.status} />
                      {/* Job QUEUED để meta ở "draft" - cứ có genProgress là
                          hiện bar, đừng chỉ dựa vào status "generating" */}
                      {(p.status === "generating" ||
                        genProgress[p.id] != null) && (
                        <div className="mt-1 max-w-48">
                          <ProgressBar
                            progress={genProgress[p.id]?.progress ?? 0}
                            step={genProgress[p.id]?.step || t("imagesPage.generating")}
                          />
                        </div>
                      )}
                    </td>
                    <td>
                      <AspectChip aspect={p.aspect} />
                    </td>
                    <td className="text-[var(--text-muted)]">
                      {p.model ?? t("styles.default")}
                    </td>
                    <td className="text-[var(--text-muted)]">
                      {formatDateTime(p.createdAt)}
                    </td>
                    <td className="text-[var(--text-muted)]">
                      {formatDateTime(p.updatedAt)}
                    </td>
                    {/* stopPropagation: cả hàng click được để mở project, nút ở
                        đây phải làm việc của nó chứ không mở trang chi tiết */}
                    <td onClick={(e) => e.stopPropagation()}>
                      <span className="flex items-center gap-1">
                        <IconButton
                          size="sm"
                          label={tf("projects.rename-aria", { name: p.name })}
                          onClick={() => setRenameTarget(p)}
                        >
                          <Pencil size={14} strokeWidth={2} />
                        </IconButton>
                        <IconButton
                          size="sm"
                          label={tf("projects.clone-aria", { name: p.name })}
                          onClick={() => setCloneSource({ id: p.id, name: p.name })}
                        >
                          <Copy size={14} strokeWidth={2} />
                        </IconButton>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : list.length > 0 ? (
          <EmptyState icon={Filter} description={t("common.no-match")} />
        ) : (
          <EmptyState
            icon={Images}
            description={t("imagesPage.empty")}
            action={
              <Button onClick={onCreate}>
                <Plus size={16} strokeWidth={2} />
                {t("imagesPage.create")}
              </Button>
            }
          />
        )}
      </Card>

      {/* Modal xác nhận xóa nhiều dự án ảnh - bắt gõ DELETE */}
      <ConfirmDeleteModal
        open={bulkDeleteOpen}
        title={t("imagesPage.delete-selected-title")}
        description={
          <p>{tf("imagesPage.delete-desc", { n: selectedProjects.length })}</p>
        }
        items={selectedProjects.map((p) => p.name)}
        busy={bulkDeleting}
        confirmLabel={tf("imagesPage.delete-n", { n: selectedProjects.length })}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={onDeleteSelected}
      />

      {/* Đổi tên - chỉ đổi tên hiển thị, id (tên thư mục) giữ nguyên */}
      <RenameProjectModal
        target={renameTarget}
        rename={renameImageProject}
        hintKey="imagesPage.rename-hint"
        onClose={() => setRenameTarget(null)}
        onRenamed={load}
      />

      <CloneProjectModal
        source={cloneSource}
        clone={cloneImageProject}
        descriptionKey="clone.image-description"
        onClose={() => setCloneSource(null)}
        onCloned={async (p) => {
          setCloneSource(null);
          setCloneNotice({ id: p.id, name: p.name });
          await load();
        }}
      />

      {/* Xem chi tiết ảnh ngay từ bảng - modal dùng chung toàn app */}
      <MediaPreviewModal file={preview} onClose={() => setPreview(null)} />
    </>
  );
}

// ============ Trang ============

export default function ImagesPage() {
  const { t } = useT();
  const router = useRouter();

  // Modal "Tạo ảnh mới" - id sinh tự động từ tên phía server (auto-ID ẩn)
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<ImageDraft>(DEFAULT_IMAGE_DRAFT);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function openCreate() {
    setName("");
    setDraft(DEFAULT_IMAGE_DRAFT);
    setCreateError(null);
    setCreateOpen(true);
  }

  const canCreate = name.trim().length > 0 && draft.prompt.trim().length > 0;

  async function onCreate() {
    if (!canCreate || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const p = await createImageProject({
        name: name.trim(),
        prompt: draft.prompt.trim(),
        kind: draft.kind,
        aspect: draft.aspect,
        overlay: draft.overlay,
        styleId: draft.styleId,
        ...(draft.model ? { model: draft.model } : {}),
      });
      setCreateOpen(false);
      router.push(`/images/${p.id}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("nav.images")}
        hint={{ titleKey: "help.images.title", bodyKey: "help.images.body" }}
        subtitle={
          <>
            {t("imagesPage.subtitle")} · {t("imagesPage.style-note")}{" "}
            <Link
              href="/styles"
              className="font-medium text-[var(--primary)] transition-colors duration-150 hover:text-[var(--primary-hover)]"
            >
              Style Design
            </Link>
            .
          </>
        }
        actions={
          <Button onClick={openCreate}>
            <Plus size={16} strokeWidth={2} />
            {t("imagesPage.create")}
          </Button>
        }
      />

      <ImageProjectList onCreate={openCreate} />

      {/* Modal tạo dự án ảnh mới */}
      <Modal
        title={t("imagesPage.create")}
        open={createOpen}
        onClose={() => {
          if (!creating) setCreateOpen(false);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={onCreate} disabled={!canCreate || creating}>
              <Plus size={15} strokeWidth={2} />
              {creating ? t("common.creating") : t("imagesPage.create-short")}
            </Button>
          </>
        }
      >
        {createError && <ErrorBanner message={createError} />}
        <Field label={t("common.name")} htmlFor="image-name">
          <input
            id="image-name"
            className="input"
            autoFocus
            value={name}
            disabled={creating}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("imagesPage.name-placeholder")}
          />
        </Field>
        <ImageProjectFields
          value={draft}
          onChange={(p) => setDraft((d) => ({ ...d, ...p }))}
          disabled={creating}
          idPrefix="image-new"
        />
      </Modal>
    </div>
  );
}
