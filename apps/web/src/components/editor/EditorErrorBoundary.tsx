"use client";

/**
 * Hàng rào lỗi CỤC BỘ cho Timeline và Inspector của trình chỉnh sửa.
 *
 * meta.json do AI ghi tay có thể sai kiểu ở chỗ editor chưa lường trước. Không
 * có hàng rào này, một lỗi render trong timeline/inspector leo thẳng lên trang
 * lỗi chung của app: mất luôn trình phát, chat AI và mọi thay đổi chưa lưu.
 * Bọc riêng từng khu → chỉ khu đó thành một banner, phần còn lại vẫn chạy
 * (chat nhờ AI sửa, hoàn tác, xóa phần tử lỗi, render).
 *
 * `resetKeys` = [timeline, selection…]: một giá trị đổi (hoàn tác, AI sửa xong,
 * xóa phần tử lỗi, chọn phần tử khác) là tự thử vẽ lại; nút "Tải lại khu này"
 * để thử ngay. So từng phần tử (identity), không so cả mảng - mảng mới mỗi lần
 * render.
 */

import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { useT } from "@/lib/i18n";

interface BoundaryProps {
  resetKeys: readonly unknown[];
  fallback: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
  keys: readonly unknown[];
}

const sameKeys = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, keys: this.props.resetKeys };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    if (sameKeys(props.resetKeys, state.keys)) return null;
    // Dữ liệu/selection đổi → thử vẽ lại (lỗi có thể đã được sửa)
    return { keys: props.resetKeys, error: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[editor] lỗi hiển thị, đã chặn trong khu vực:", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}

export function EditorErrorBoundary({
  area,
  resetKeys,
  className,
  style,
  children,
}: {
  area: "timeline" | "inspector";
  resetKeys: readonly unknown[];
  /** Class/kích thước của khung thay thế - giữ đúng chỗ của khu bị lỗi trong bố cục */
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const { t } = useT();
  return (
    <Boundary
      resetKeys={resetKeys}
      fallback={(error, reset) => (
        <section className={className} style={style} data-crashed={area}>
          <Banner
            tone="danger"
            message={area === "timeline" ? t("editor.crash.timeline") : t("editor.crash.inspector")}
            detail={error.message || String(error)}
            actions={
              <Button variant="secondary" small onClick={reset}>
                {t("editor.crash.reload")}
              </Button>
            }
          />
        </section>
      )}
    >
      {children}
    </Boundary>
  );
}
