"use client";

/**
 * Thanh trên của trình chỉnh sửa: về project · tên · trạng thái lưu ·
 * hoàn tác/làm lại · tiến trình render + link bản ra · Render draft/final ·
 * menu "Thêm".
 *
 * Menu "Thêm" là KHE MỞ RỘNG: trang truyền mảng `menuItems`, thanh trên chỉ vẽ.
 * Giai đoạn 3 (lịch sử phiên bản, xuất XML Premiere/DaVinci…) thêm mục vào mảng
 * đó trong VideoEditor - không phải sửa file này.
 */

import {
  ArrowLeft,
  Film,
  MoreHorizontal,
  Play,
  Redo2,
  RefreshCw,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { IconButton } from "@/components/IconButton";
import { LinkButton } from "@/components/LinkButton";
import { ProgressBar } from "@/components/ProgressBar";
import { mediaUrl, type Job } from "@/lib/api";
import { useT } from "@/lib/i18n";

export type SaveState = "saved" | "saving" | "unsaved" | "error" | "conflict" | "invalid" | "readonly";

export interface EditorMenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  /** Dòng chú thích nhỏ dưới nhãn (vd giới hạn của tính năng) */
  hint?: string;
}

const SAVE_TONE: Record<SaveState, BadgeTone> = {
  saved: "success",
  saving: "running",
  unsaved: "muted",
  error: "danger",
  conflict: "danger",
  invalid: "danger",
  readonly: "muted",
};

export function EditorTopBar({
  projectId,
  name,
  subtitle,
  saveState,
  onRetrySave,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  activeJob,
  activeCount,
  lastOutput,
  renderBusy,
  renderDisabled,
  onRender,
  menuItems,
}: {
  projectId: string;
  name: string;
  subtitle: string;
  saveState: SaveState;
  onRetrySave: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Job render đang chạy (hoặc đầu hàng chờ) của project */
  activeJob: Job | null;
  /** Số job render còn chạy/chờ */
  activeCount: number;
  /** Job assemble gần nhất đã ra file */
  lastOutput: Job | null;
  renderBusy: boolean;
  renderDisabled: boolean;
  onRender: (quality: "draft" | "final") => void;
  menuItems: EditorMenuItem[];
}) {
  const { t, tf } = useT();
  const saveLabel: Record<SaveState, string> = {
    saved: t("editor.save.saved"),
    saving: t("editor.save.saving"),
    unsaved: t("editor.save.unsaved"),
    error: t("editor.save.error"),
    conflict: t("editor.save.conflict"),
    invalid: t("editor.save.invalid"),
    readonly: t("editor.save.readonly"),
  };

  const jobLabel = (job: Job): string => {
    switch (job.type) {
      case "scene-draft":
        return tf("editor.render.job-scene-draft", { id: job.sceneId ?? "" });
      case "scene-final":
        return tf("editor.render.job-scene-final", { id: job.sceneId ?? "" });
      case "assemble-final":
        return t("editor.render.job-assemble-final");
      default:
        return t("editor.render.job-assemble-draft");
    }
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <LinkButton
          href={`/projects/${encodeURIComponent(projectId)}`}
          small
          aria-label={t("editor.back")}
          title={t("editor.back")}
        >
          <ArrowLeft size={14} strokeWidth={2} />
          <span className="hidden sm:inline">{t("editor.back-short")}</span>
        </LinkButton>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold" title={name}>
            {name}
          </h1>
          <p className="truncate text-meta text-[var(--text-muted)]">{subtitle}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1" aria-live="polite">
          <Badge tone={SAVE_TONE[saveState]} label={saveLabel[saveState]} />
          {saveState === "error" && (
            <IconButton label={t("editor.save.retry")} size="sm" onClick={onRetrySave}>
              <RefreshCw size={13} strokeWidth={2} />
            </IconButton>
          )}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <IconButton label={t("editor.undo")} disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={16} strokeWidth={1.75} />
        </IconButton>
        <IconButton label={t("editor.redo")} disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={16} strokeWidth={1.75} />
        </IconButton>
      </div>

      {activeJob ? (
        <div className="flex w-56 min-w-0 flex-col gap-1">
          <span className="truncate text-meta text-[var(--text-muted)]">
            {activeCount > 1
              ? tf("editor.render.active-n", { label: jobLabel(activeJob), n: activeCount })
              : jobLabel(activeJob)}
          </span>
          {activeJob.status === "running" ? (
            <ProgressBar progress={activeJob.progress} />
          ) : (
            <div className="progress-indeterminate" aria-label={t("editor.render.queued")} />
          )}
        </div>
      ) : (
        lastOutput?.outputPath && (
          <LinkButton href={mediaUrl(lastOutput.outputPath)} external small>
            <Film size={14} strokeWidth={2} />
            {lastOutput.type === "assemble-final"
              ? t("editor.render.open-final")
              : t("editor.render.open-draft")}
          </LinkButton>
        )
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          small
          disabled={renderBusy || renderDisabled}
          onClick={() => onRender("draft")}
          title={t("editor.render.draft-hint")}
        >
          <Play size={14} strokeWidth={2} />
          {t("editor.render.draft")}
        </Button>
        <Button
          small
          disabled={renderBusy || renderDisabled}
          onClick={() => onRender("final")}
          title={t("editor.render.final-hint")}
        >
          <Play size={14} strokeWidth={2} />
          {t("editor.render.final")}
        </Button>
        <EditorMenu items={menuItems} />
      </div>
    </div>
  );
}

function EditorMenu({ items }: { items: EditorMenuItem[] }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <div ref={rootRef} className="relative">
      <IconButton
        label={t("editor.menu")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal size={16} strokeWidth={1.75} />
      </IconButton>
      {open && (
        <div role="menu" className="editor-menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="editor-menu-item"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <item.icon size={14} strokeWidth={2} className="mt-0.5 shrink-0 self-start text-[var(--text-muted)]" />
              <span className="min-w-0">
                <span className="block">{item.label}</span>
                {item.hint && <span className="block text-meta text-[var(--text-muted)]">{item.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
