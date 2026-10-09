"use client";

/**
 * Lịch sử phiên bản timeline (GET /timeline/revisions) + khôi phục.
 *
 * Mỗi bản là ẢNH CHỤP timeline: ngay trước một lần lưu từ editor / một lần khôi
 * phục, và trước / sau mỗi lượt AI sửa project (docs/EDITOR-PLAN.md 2.4). Khôi
 * phục cũng chụp bản hiện tại vào lịch sử trước khi ghi, nên luôn quay lại được.
 *
 * Xác nhận nằm ngay trong modal (đổi thân modal sang câu hỏi), không mở modal
 * thứ hai chồng lên - hai lớp nền tối và hai nút X là thứ không ai muốn thấy.
 * Việc khôi phục thật (lưu nốt thay đổi, gọi API, nạp bản mới) là của trang.
 */

import { History, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Modal } from "@/components/Modal";
import { TableSkeleton } from "@/components/Skeleton";
import {
  getTimelineRevisions,
  type TimelineRevision,
  type TimelineRevisionSource,
} from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";

/**
 * Nhãn lịch sử của lượt lưu "Giữ bản của tôi" (ghi đè bản tab khác/AI). Server
 * KHÔNG gộp snapshot mang nhãn này (apps/server/src/timeline.ts
 * EDITOR_OVERWRITE_LABEL) - hai nơi phải cùng một chuỗi.
 */
export const EDITOR_OVERWRITE_LABEL = "editor-overwrite";

export type RestoreOutcome =
  | { ok: true }
  | { ok: false; message: string; detail?: string; reload: boolean };

const SOURCE_TONE: Record<TimelineRevisionSource, BadgeTone> = {
  editor: "muted",
  "ai-before": "running",
  "ai-after": "success",
  restore: "muted",
};

export function HistoryModal({
  open,
  onClose,
  projectId,
  currentVersion,
  readOnly,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Version đang mở trong editor - bản trùng version thì không cần khôi phục */
  currentVersion: string | null;
  readOnly: boolean;
  onRestore: (rev: TimelineRevision) => Promise<RestoreOutcome>;
}) {
  const { t, tf } = useT();
  const [revisions, setRevisions] = useState<TimelineRevision[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TimelineRevision | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; detail?: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setRevisions(await getTimelineRevisions(projectId));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setRevisions(null);
    setConfirming(null);
    setProblem(null);
    void load();
  }, [open, load]);

  const sourceLabel: Record<TimelineRevisionSource, string> = {
    editor: t("editor.history.source-editor"),
    "ai-before": t("editor.history.source-ai-before"),
    "ai-after": t("editor.history.source-ai-after"),
    restore: t("editor.history.source-restore"),
  };

  const noteOf = (rev: TimelineRevision): string | null => {
    if (rev.source === "restore" && rev.label) {
      const from = revisions?.find((r) => r.rev === rev.label);
      return from
        ? tf("editor.history.restored-from", { time: formatDateTime(from.createdAt) })
        : null;
    }
    // "Giữ bản của tôi": bản này là của tab khác/AI ngay trước khi bị ghi đè -
    // nói rõ ra, đây chính là bản người dùng sẽ tìm khi ghi đè nhầm
    if (rev.source === "editor" && rev.label === EDITOR_OVERWRITE_LABEL) return t("editor.history.overwrite-note");
    // Lần lưu tự động của editor luôn mang nhãn kỹ thuật "editor" - không phải ghi chú
    if (rev.source === "editor" && (!rev.label || rev.label === "editor")) return null;
    return rev.label;
  };

  const close = () => {
    if (!busy) onClose();
  };

  const confirm = async () => {
    if (!confirming) return;
    setBusy(true);
    setProblem(null);
    const outcome = await onRestore(confirming);
    setBusy(false);
    if (outcome.ok) {
      onClose();
      return;
    }
    setProblem({ message: outcome.message, detail: outcome.detail });
    setConfirming(null);
    if (outcome.reload) void load();
  };

  let body;
  if (confirming) {
    body = (
      <>
        <p className="text-sm">
          {tf("editor.history.confirm-body", {
            time: formatDateTime(confirming.createdAt),
            source: sourceLabel[confirming.source],
          })}
        </p>
        <p className="text-meta text-[var(--text-muted)]">{t("editor.history.confirm-note")}</p>
      </>
    );
  } else if (loadError && !revisions) {
    body = (
      <ErrorBanner
        message={t("editor.history.load-error")}
        detail={loadError}
        actions={
          <Button variant="secondary" small onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  } else if (!revisions) {
    body = <TableSkeleton rows={4} />;
  } else if (revisions.length === 0) {
    body = (
      <EmptyState icon={History} title={t("editor.history.empty-title")} description={t("editor.history.empty")} />
    );
  } else {
    body = (
      <table className="table">
        <thead>
          <tr>
            <th>{t("editor.history.col-time")}</th>
            <th>{t("editor.history.col-source")}</th>
            <th className="text-right">{t("common.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {revisions.map((rev) => {
            const note = noteOf(rev);
            const current = rev.version === currentVersion;
            return (
              <tr key={rev.rev} data-rev={rev.rev}>
                <td className="whitespace-nowrap">
                  <p className="text-sm tabular-nums">{formatDateTime(rev.createdAt)}</p>
                  <p className="text-meta text-[var(--text-muted)]">{formatRelative(rev.createdAt)}</p>
                </td>
                <td className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge tone={SOURCE_TONE[rev.source]} label={sourceLabel[rev.source]} dot={false} />
                    {current && <Badge tone="success" label={t("editor.history.current")} dot={false} />}
                  </span>
                  {note && <p className="mt-1 line-clamp-2 text-meta text-[var(--text-muted)]">{note}</p>}
                </td>
                <td className="text-right">
                  <Button
                    variant="secondary"
                    small
                    disabled={readOnly || current}
                    title={current ? t("editor.history.current-hint") : undefined}
                    onClick={() => {
                      setProblem(null);
                      setConfirming(rev);
                    }}
                  >
                    <RotateCcw size={14} strokeWidth={2} />
                    {t("editor.history.restore")}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <Modal
      title={confirming ? t("editor.history.confirm-title") : t("editor.history.title")}
      open={open}
      onClose={close}
      dismissible={!busy}
      footer={
        confirming ? (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={busy || readOnly} onClick={() => void confirm()}>
              <RotateCcw size={14} strokeWidth={2} />
              {busy ? t("editor.history.restoring") : t("editor.history.restore")}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={close}>
            {t("common.close")}
          </Button>
        )
      }
    >
      {problem && <Banner tone="danger" message={problem.message} detail={problem.detail} />}
      {readOnly && <Banner tone="info" message={t("editor.history.readonly")} />}
      {!confirming && <p className="text-meta text-[var(--text-muted)]">{t("editor.history.intro")}</p>}
      {body}
    </Modal>
  );
}
