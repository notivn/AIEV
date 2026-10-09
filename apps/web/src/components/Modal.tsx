"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { IconButton } from "@/components/IconButton";
import { useT } from "@/lib/i18n";

/**
 * LUẬT CHUNG CHO MỌI MODAL (trước đợt đại tu có 8 modal dùng file này theo 8
 * kiểu khác nhau - giờ chốt lại):
 *
 * 1. Nút trong `footer` LUÔN là <Button> cỡ mặc định 36px. Không `small`, và
 *    không <button> đeo class .btn-* chép tay (UpdateModal từng có 8 nút kiểu đó).
 * 2. Thứ tự nút: [phụ] … [chính] - hành động chính ở ngoài cùng bên phải, và
 *    LUÔN có một đường thoát (Hủy/Đóng) chứ không chỉ mỗi dấu X.
 * 3. Lỗi đặt ở ĐẦU thân modal bằng <ErrorBanner>/<Banner tone="danger">, không
 *    nhét xuống footer và không viết chữ đỏ trần.
 * 4. `wide` chỉ dành cho nội dung THẬT SỰ nhiều cột (stepper + log + danh sách,
 *    lưới preview). Biểu mẫu một cột để hẹp cho dễ đọc.
 * 5. Nút Hủy và dấu X đi CÙNG một đường: modal đang bận thì cả hai cùng bị chặn.
 *
 * Focus (a11y, mẫu dialog của WAI-ARIA) - modal tự lo, nơi dùng không phải làm gì:
 * - mở ra: focus vào trong modal - giữ nguyên nếu một ô `autoFocus` đã nhận
 *   focus, không thì phần tử bấm được đầu tiên của THÂN/footer (bỏ qua nút X:
 *   Enter ngay sau khi mở không được là "đóng"), không có thì chính hộp thoại;
 * - Tab / Shift+Tab xoay vòng TRONG modal, không lọt ra trang phía sau;
 * - đóng: trả focus về phần tử đã mở modal (nếu nó còn trên trang).
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusablesIn(root: HTMLElement): HTMLElement[] {
  // getClientRects rỗng = đang ẩn (display:none, hidden) - Tab không tới được
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

export function Modal({
  title,
  open,
  onClose,
  children,
  footer,
  wide = false,
  dismissible = true,
}: {
  title: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** true = modal rộng (lưới preview nhiều cột) - max-w 960px thay vì 640px. */
  wide?: boolean;
  /**
   * false = KHÔNG cho đóng: ẩn nút X, chặn Escape và click nền.
   * Dùng cho thao tác không được bỏ dở giữa chừng (đang cập nhật hệ thống).
   * Để nút X hiện mà bấm không tác dụng còn khó hiểu hơn là không có nút.
   */
  dismissible?: boolean;
}) {
  const { t } = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Phần tử đang có focus NGAY LÚC modal chuyển sang mở. Chụp trong lúc render
  // chứ không trong effect: `autoFocus` của ô trong modal chạy TRƯỚC mọi effect,
  // tới effect thì activeElement đã là ô đó. Chỉ đọc DOM, không ghi gì.
  const restoreRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current && typeof document !== "undefined") {
    const active = document.activeElement;
    restoreRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  wasOpenRef.current = open;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const first = focusablesIn(dialog).find((el) => !el.closest("[data-modal-header]"));
      (first ?? dialog).focus();
    }
    return () => {
      const back = restoreRef.current;
      restoreRef.current = null;
      if (back && back.isConnected) back.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, dismissible]);

  /** Giữ Tab trong modal: tới mép thì vòng về đầu/cuối. */
  const onDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const list = focusablesIn(dialog);
    if (list.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--text)]/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissible) onClose();
      }}
    >
      {/* Form đơn lẻ giữ giới hạn chiều rộng cho dễ đọc (quy tắc full-width chỉ áp cho trang) */}
      <div
        ref={dialogRef}
        className={`card max-h-[90vh] w-full overflow-y-auto outline-none ${
          wide ? "max-w-[960px]" : "max-w-[640px]"
        }`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <div className="mb-4 flex items-center justify-between" data-modal-header="">
          <h2 className="text-sm font-semibold">{title}</h2>
          {dismissible && (
            <IconButton label={t("common.close")} size="sm" onClick={onClose}>
              <X size={15} strokeWidth={2} />
            </IconButton>
          )}
        </div>
        <div className="flex flex-col gap-3">{children}</div>
        {footer && (
          <div className="mt-5 flex justify-end gap-2">{footer}</div>
        )}
      </div>
    </div>
  );
}
