"use client";

/**
 * Điều khiển phát dưới trình phát: về đầu, lùi 1 frame, phát/dừng, tiến 1
 * frame, về cuối + mốc giờ mm:ss.ff / tổng. Chỉ phần này đăng ký frame hiện
 * tại (qua playback store) - nó render lại theo từng frame, phần còn lại của
 * trang thì không.
 */

import { Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import { IconButton } from "@/components/IconButton";
import { useT } from "@/lib/i18n";
import { useEditor } from "./EditorContext";
import { useIsPlaying, usePlayheadFrame } from "./playback";
import { formatTimecode } from "./timing";

export function Transport({
  totalFrames,
  onToggle,
  onStep,
  disabled = false,
}: {
  totalFrames: number;
  onToggle: () => void;
  onStep: (delta: number) => void;
  disabled?: boolean;
}) {
  const { t, tf } = useT();
  const { playback, fps, seek } = useEditor();
  const frame = usePlayheadFrame(playback);
  const playing = useIsPlaying(playback);

  return (
    <div className="editor-transport flex shrink-0 flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1" role="group" aria-label={t("editor.transport")}>
        <IconButton
          label={t("editor.transport.start")}
          disabled={disabled}
          onClick={() => seek(0)}
          data-optional=""
        >
          <SkipBack size={16} strokeWidth={1.75} />
        </IconButton>
        <IconButton label={t("editor.transport.prev-frame")} disabled={disabled} onClick={() => onStep(-1)}>
          <StepBack size={16} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label={playing ? t("editor.transport.pause") : t("editor.transport.play")}
          disabled={disabled}
          onClick={onToggle}
          className="text-[var(--text)]"
        >
          {playing ? <Pause size={18} strokeWidth={2} /> : <Play size={18} strokeWidth={2} />}
        </IconButton>
        <IconButton label={t("editor.transport.next-frame")} disabled={disabled} onClick={() => onStep(1)}>
          <StepForward size={16} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label={t("editor.transport.end")}
          disabled={disabled}
          onClick={() => seek(Math.max(0, totalFrames - 1))}
          data-optional=""
        >
          <SkipForward size={16} strokeWidth={1.75} />
        </IconButton>
      </div>
      {/* Không bao giờ xuống dòng (khung hẹp: nhóm nút tự ẩn bớt, mốc giờ giữ
          nguyên); mm:ss.ff kiểu NLE - ff là KHUNG HÌNH, không phải phần trăm giây,
          nên có chú thích khi rê chuột */}
      <p
        className="shrink-0 whitespace-nowrap text-sm tabular-nums"
        aria-live="off"
        title={tf("editor.transport.time-hint", { fps: Math.round(fps) })}
      >
        <span className="font-medium">{formatTimecode(frame, fps)}</span>
        <span className="text-[var(--text-muted)]"> / {formatTimecode(totalFrames, fps)}</span>
      </p>
    </div>
  );
}
