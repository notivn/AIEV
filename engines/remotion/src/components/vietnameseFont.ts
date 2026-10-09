import { useEffect, useState } from "react";
import {
  cancelRender,
  continueRender,
  delayRender,
  getRemotionEnvironment,
} from "remotion";
import type { MediaResolver } from "../media";

/**
 * Font tiếng Việt nạp OFFLINE từ public/fonts (Inter, subset latin +
 * vietnamese) — dùng chung cho MỌI overlay của tầng lắp ráp (CaptionTrack,
 * HighlightTrack).
 *
 * Phải khai @font-face thủ công vì cần `unicode-range`: hai subset cùng
 * family/weight sẽ đè nhau nếu thiếu range → mất dấu tiếng Việt.
 * `@remotion/fonts` (loadFont) không nhận unicode-range nên không dùng ở đây.
 */

const LATIN_RANGE =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const VIETNAMESE_RANGE =
  "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB";

export const VIETNAMESE_FONT_FAMILY = "CaptionInter";

const WEIGHTS = [600, 700, 800] as const;

/**
 * Khối @font-face cho các overlay. Là HÀM của resolver (gọi lúc render), không
 * phải hằng số tính ở module scope: `staticFile()` chạy ở module scope thì
 * trong trình phát của dashboard nó trỏ vào public/ của Remotion - không tồn
 * tại ở đó, font 404 rồi cancelRender làm sập cả trang. Resolver mặc định là
 * staticFile nên chuỗi CSS khi render qua CLI giữ nguyên từng ký tự.
 */
export const vietnameseFontFaceCss = (resolve: MediaResolver): string =>
  WEIGHTS.flatMap((weight) =>
    (
      [
        ["latin", LATIN_RANGE],
        ["vietnamese", VIETNAMESE_RANGE],
      ] as const
    ).map(
      ([subset, range]) => `@font-face{
  font-family:'${VIETNAMESE_FONT_FAMILY}';
  font-style:normal;
  font-weight:${weight};
  font-display:block;
  src:url('${resolve(`fonts/inter-${subset}-${weight}.woff2`)}') format('woff2');
  unicode-range:${range};
}`,
    ),
  ).join("\n");

/**
 * Chặn render tới khi font thật sẵn sàng — nếu không, frame đầu vẽ bằng font
 * fallback rồi mới đổi, chữ nhảy vị trí giữa các frame.
 *
 * An toàn khi gọi từ nhiều component trong cùng một render: mỗi handle
 * delayRender được continue riêng.
 *
 * Lỗi nạp font: khi RENDER thì cancelRender (thà chết còn hơn xuất video mất
 * dấu); trong trình phát xem trước (@remotion/player) chỉ cảnh báo rồi cho
 * chạy tiếp bằng font dự phòng - một file font lỗi không được làm sập trang.
 */
export const useVietnameseFont = (): void => {
  const [handle] = useState(() => delayRender("Nạp font overlay (Inter VN)"));

  useEffect(() => {
    Promise.all(
      WEIGHTS.map((weight) =>
        document.fonts.load(
          `${weight} 60px '${VIETNAMESE_FONT_FAMILY}'`,
          "tiếng Việt đủ dấu",
        ),
      ),
    )
      .then(() => document.fonts.ready)
      .then(() => continueRender(handle))
      .catch((err: unknown) => {
        const message = `Không nạp được font overlay: ${String(err)}`;
        if (getRemotionEnvironment().isPlayer) {
          console.warn(message);
          continueRender(handle);
          return;
        }
        cancelRender(new Error(message));
      });
  }, [handle]);
};
