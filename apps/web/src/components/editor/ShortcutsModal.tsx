"use client";

/** Bảng phím tắt của trình chỉnh sửa - mở bằng `?` hoặc menu "Thêm". */

import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { useT } from "@/lib/i18n";

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const mod =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  const rows: { keys: string[][]; label: string }[] = [
    { keys: [["Space"]], label: t("editor.keys.play") },
    { keys: [["←"], ["→"]], label: t("editor.keys.frame") },
    { keys: [["Shift", "←"], ["Shift", "→"]], label: t("editor.keys.second") },
    { keys: [["Home"], ["End"]], label: t("editor.keys.home-end") },
    { keys: [["S"]], label: t("editor.keys.split") },
    { keys: [["Delete"], ["Backspace"]], label: t("editor.keys.delete") },
    { keys: [[mod, "D"]], label: t("editor.keys.duplicate") },
    { keys: [[mod, "Z"]], label: t("editor.keys.undo") },
    { keys: [[mod, "Shift", "Z"], ["Ctrl", "Y"]], label: t("editor.keys.redo") },
    { keys: [["Esc"]], label: t("editor.keys.deselect") },
    { keys: [[mod, t("editor.keys.wheel")]], label: t("editor.keys.zoom") },
    { keys: [["Alt"]], label: t("editor.keys.no-snap") },
    { keys: [["?"]], label: t("editor.keys.help") },
  ];
  return (
    <Modal
      title={t("editor.keys.title")}
      open={open}
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      <p className="text-meta text-[var(--text-muted)]">{t("editor.keys.note")}</p>
      <table className="table">
        <thead>
          <tr>
            <th>{t("editor.keys.col-keys")}</th>
            <th>{t("editor.keys.col-action")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="whitespace-nowrap">
                <span className="flex flex-wrap items-center gap-2">
                  {row.keys.map((combo, i) => (
                    <span key={i} className="flex items-center gap-1">
                      {i > 0 && <span className="text-meta text-[var(--text-muted)]">/</span>}
                      {combo.map((k) => (
                        <kbd key={k} className="kbd">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  ))}
                </span>
              </td>
              <td>{row.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
