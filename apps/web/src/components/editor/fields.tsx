"use client";

/**
 * Ô nhập của inspector - bọc <Field> (nhãn + gợi ý + lỗi đúng chỗ).
 *
 * - Ô CHỮ "sửa sống": mỗi lần gõ ra một chuỗi hợp lệ là ghi ngay (trình phát
 *   thấy liền) - mọi tiền tố của một câu đều là một câu hợp lệ.
 * - Ô SỐ chỉ ghi khi CHỐT (Enter / rời ô / ↑↓): gõ "99" vào "Điểm ra" thì "9"
 *   là một tiền tố hợp lệ - ghi sống là đã lưu `to=9` trước khi "99" bị từ
 *   chối. Lúc gõ vẫn báo lỗi ngay dưới ô; chốt một giá trị sai thì không ghi.
 * - Esc: trả ô về giá trị đang lưu và rời ô.
 * Lượt sửa khép lại thành một bước hoàn tác (store gộp các lần gõ cùng ô).
 */

import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Field } from "@/components/Field";
import { useT } from "@/lib/i18n";
import { useEditor } from "./EditorContext";

/** Số hiển thị gọn: tối đa `digits` chữ số thập phân, bỏ số 0 thừa. */
export function fmtNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "";
  const p = 10 ** digits;
  return String(Math.round(value * p) / p);
}

function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "" || trimmed === "-" || trimmed === ".") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function NumberField({
  id,
  label,
  value,
  onCommit,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  step = 0.01,
  digits = 2,
  unit,
  hint,
  disabled = false,
  validate,
}: {
  id: string;
  label: ReactNode;
  value: number;
  /** Giá trị hợp lệ mới (đã nằm trong [min, max]) */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  /** Đơn vị hiện sau ô ("s", "%", "×") */
  unit?: string;
  hint?: ReactNode;
  disabled?: boolean;
  /** Luật riêng ngoài khoảng [min, max] - trả về câu lỗi hoặc null */
  validate?: (value: number) => string | null;
}) {
  const { t, tf } = useT();
  const { endCoalesce } = useEditor();
  const [text, setText] = useState(() => fmtNumber(value, digits));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Esc vừa bấm: lần blur ngay sau đó KHÔNG ghi */
  const revertRef = useRef(false);

  // Giá trị đổi từ nơi khác (kéo trên timeline, hoàn tác) - chỉ đồng bộ khi
  // người dùng KHÔNG đang gõ ở ô này, không thì chữ nhảy dưới tay họ. Đồng bộ
  // NGAY trong lượt render (không đợi useEffect): đợi effect thì có một khung
  // hình ô còn hiện số cũ, gõ đúng lúc đó là chữ mới bị nối vào chữ cũ.
  const shown = fmtNumber(value, digits);
  const [synced, setSynced] = useState(shown);
  if (!focused && shown !== synced) {
    setSynced(shown);
    setText(shown);
  }

  const check = (n: number | null): string | null => {
    if (n === null) return t("editor.field.number");
    if (n < min || n > max) {
      return Number.isFinite(max)
        ? tf("editor.field.between", { min: fmtNumber(min, digits), max: fmtNumber(max, digits) })
        : tf("editor.field.min", { min: fmtNumber(min, digits) });
    }
    return validate ? validate(n) : null;
  };

  return (
    <Field label={label} htmlFor={id} hint={hint} error={error}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          className="input"
          inputMode="decimal"
          type="text"
          value={text}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          onFocus={() => setFocused(true)}
          onChange={(e) => {
            setText(e.target.value);
            // Chỉ kiểm, KHÔNG ghi - ghi lúc chốt (xem đầu file)
            setError(check(parseNumber(e.target.value)));
          }}
          onBlur={() => {
            const revert = revertRef.current;
            revertRef.current = false;
            const n = parseNumber(text);
            if (!revert && n !== null && !check(n) && fmtNumber(n, digits) !== fmtNumber(value, digits)) {
              onCommit(n);
            }
            setFocused(false);
            setError(null);
            // Ghi xong thì `value` mới về ở lượt render sau và đồng bộ lại chữ
            setText(fmtNumber(value, digits));
            endCoalesce();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              revertRef.current = true;
              e.currentTarget.blur();
            }
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const base = parseNumber(text) ?? value;
              const next = Math.round((base + (e.key === "ArrowUp" ? step : -step)) * 1e6) / 1e6;
              const clamped = Math.min(max, Math.max(min, next));
              if (!check(clamped)) {
                setText(fmtNumber(clamped, digits));
                setError(null);
                onCommit(clamped);
              }
            }
          }}
        />
        {unit && <span className="shrink-0 text-meta text-[var(--text-muted)]">{unit}</span>}
      </div>
    </Field>
  );
}

export function TextField({
  id,
  label,
  value,
  onCommit,
  required = true,
  multiline = false,
  hint,
  disabled = false,
  placeholder,
}: {
  id: string;
  label: ReactNode;
  value: string;
  /** Chuỗi mới; với `required=false` chuỗi rỗng nghĩa là xóa trường */
  onCommit: (value: string) => void;
  required?: boolean;
  multiline?: boolean;
  hint?: ReactNode;
  disabled?: boolean;
  placeholder?: string;
}) {
  const { t } = useT();
  const { endCoalesce } = useEditor();
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [synced, setSynced] = useState(value);
  if (!focused && value !== synced) {
    setSynced(value);
    setText(value);
  }

  const onChange = (next: string) => {
    setText(next);
    if (required && next.trim() === "") {
      setError(t("editor.field.required"));
      return;
    }
    setError(null);
    onCommit(next);
  };
  const common = {
    id,
    className: "input",
    value: text,
    disabled,
    placeholder,
    "aria-invalid": error ? true : undefined,
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      setError(null);
      setText(value);
      endCoalesce();
    },
    // Esc rời ô (chữ đã ghi sống thì giữ; hoàn tác bằng Ctrl+Z như mọi thao tác)
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.blur();
    },
  };

  return (
    <Field label={label} htmlFor={id} hint={hint} error={error}>
      {multiline ? (
        <textarea {...common} rows={3} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} type="text" onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

/** Thanh trượt 0..1 hiện thành phần trăm - âm lượng sfx/nhạc. */
export function VolumeField({
  id,
  label,
  value,
  onCommit,
  hint,
  disabled = false,
}: {
  id: string;
  label: ReactNode;
  value: number;
  onCommit: (value: number) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const { endCoalesce } = useEditor();
  const pct = Math.round(value * 100);
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          className="slider"
          min={0}
          max={100}
          step={1}
          value={pct}
          disabled={disabled}
          onChange={(e) => onCommit(Number(e.target.value) / 100)}
          onPointerUp={endCoalesce}
          onKeyUp={endCoalesce}
          onBlur={endCoalesce}
        />
        <span className="w-10 shrink-0 text-right text-meta tabular-nums">{pct}%</span>
      </div>
    </Field>
  );
}

/** Dòng "nhãn: giá trị" chỉ đọc (nguồn file, thời lượng đo được…). */
export function ReadOnlyRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="label mb-0">{label}</span>
      <span className="min-w-0 text-sm [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}
