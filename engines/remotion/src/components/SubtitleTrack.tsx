import React from "react";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { SubtitleCue, SubtitleStyle } from "../manifest";
import { fadeInOut } from "./fade";
import {
  useVietnameseFont,
  VIETNAMESE_FONT_FAMILY,
  vietnameseFontFaceCss,
} from "./vietnameseFont";

/**
 * Phụ đề THƯỜNG (tính năng "Dịch video") - anh em cấu hình được của
 * `CaptionTrack`, KHÔNG phải một thứ dựng mới:
 * - cùng khối bong bóng neo đáy có backdrop mờ, cùng nhịp vào/ra (mờ dần 4
 *   frame + trôi lên 18px), cùng đơn vị tỉ lệ `u`;
 * - khác ở chỗ chữ ĐẶC, không tô karaoke theo từ, và mọi hằng số cứng của
 *   CaptionTrack (màu, cỡ chữ, khoảng cách đáy, backdrop) đều lấy từ
 *   `manifest.subtitleStyle`, bỏ trống thì rơi về đúng giá trị đang dùng.
 *
 * Những cái bẫy chép nguyên từ CaptionTrack - đừng "dọn dẹp" lại:
 * - `display: "block"` cho khối chữ là CỐ Ý. Cha là flex thì text node chỉ có
 *   khoảng trắng bị bỏ, ra chữ dính nhau kiểu "dữ liệuđơn hàng".
 * - Mọi px bên dưới thiết kế cho canvas dọc 1080x1920 (u = 1) rồi nhân `u`.
 * - `cue.from` / `durationInFrames` là FRAME TUYỆT ĐỐI của composition, không
 *   phải giây và không phải offset trong cue.
 * - Font tiếng Việt phải khai @font-face NGAY TRONG DOM render (thẻ <style>
 *   dưới đây). Import CSS ngoài không ăn, và family chưa đăng ký thì trình
 *   duyệt lặng lẽ rơi về font khác - dấu tiếng Việt hỏng trước tiên.
 */

// ---------------------------------------------------------------- bảng font

/**
 * Danh sách font CHO PHÉP: id trong manifest -> stack CSS thật + đoạn @font-face
 * cần nhúng. Không nhận family tự do từ manifest: family chưa đăng ký sẽ rơi về
 * font hệ thống một cách im lặng, và cái mất đầu tiên luôn là dấu tiếng Việt.
 *
 * Mọi stack đều KẾT bằng '${VIETNAMESE_FONT_FAMILY}' (Inter đã subset latin +
 * vietnamese, nạp offline từ public/fonts): fallback font trong CSS là theo
 * TỪNG GLYPH, nên chữ Ề/Ợ mà font đứng trước thiếu vẫn được Inter vẽ đúng dấu.
 */
export const SUBTITLE_FONTS: Record<string, { stack: string; faceCss: string }> = {
  // Mặc định - đúng font của CaptionTrack/HighlightTrack
  vietnamese: {
    stack: `'${VIETNAMESE_FONT_FAMILY}', 'Segoe UI', sans-serif`,
    faceCss: vietnameseFontFaceCss,
  },
  // Ba họ "an toàn": chỉ dùng font có sẵn ở mọi máy render + generic family,
  // không tải thêm file nào (render chạy headless Chromium, không có mạng).
  sans: {
    stack: `Arial, Helvetica, '${VIETNAMESE_FONT_FAMILY}', sans-serif`,
    faceCss: vietnameseFontFaceCss,
  },
  serif: {
    stack: `Georgia, 'Times New Roman', '${VIETNAMESE_FONT_FAMILY}', serif`,
    faceCss: vietnameseFontFaceCss,
  },
  mono: {
    stack: `'Courier New', Consolas, '${VIETNAMESE_FONT_FAMILY}', monospace`,
    faceCss: vietnameseFontFaceCss,
  },
};

export const DEFAULT_SUBTITLE_FONT = "vietnamese";

/** Id lạ (hoặc bỏ trống) rơi về font tiếng Việt, KHÔNG rơi về không có gì */
export function resolveSubtitleFont(id?: string): { stack: string; faceCss: string } {
  const key = (id ?? "").trim().toLowerCase();
  return SUBTITLE_FONTS[key] ?? SUBTITLE_FONTS[DEFAULT_SUBTITLE_FONT];
}

// ---------------------------------------------------------------- mặc định

/** Y hệt các hằng số đang chạy trong CaptionTrack - đổi ở đây là đổi cả hai lớp */
const DEFAULTS = {
  /** IDLE của CaptionTrack (từ chưa được đọc tới) */
  color: "rgba(255,255,255,0.92)",
  fontSizePx: 62,
  /** Dọc: 320 nằm trên safe zone TikTok (~288). Ngang: 130 (skill noti-youtube-edit) */
  bottomVertical: 320,
  bottomHorizontal: 130,
  backdropColor: "rgba(10,16,32,0.52)",
  blurPx: 20,
} as const;

/**
 * Khi composition CÓ phụ đề karaoke, phụ đề dịch phải leo lên trên khối
 * caption. Hai con số này ĐO ĐƯỢC trên chính thẻ caption và đang dùng cho
 * HighlightTrack tier "sub" (xem chú thích ở đó): caption 3 dòng cao tới
 * y ~ 626 tính từ đáy, nên 700 (dọc) / 470 (ngang) là mép an toàn.
 */
const RAISED_BOTTOM_VERTICAL = 700;
const RAISED_BOTTOM_HORIZONTAL = 470;

const Cue: React.FC<{
  cue: SubtitleCue;
  style?: SubtitleStyle;
  raised: boolean;
}> = ({ cue, style, raised }) => {
  const frame = useCurrentFrame(); // 0 tại cue.from (đang trong <Sequence>)
  const { width, height } = useVideoConfig();
  const last = cue.durationInFrames - 1;

  // Đơn vị tỉ lệ: dọc chuẩn hóa theo cao 1920, ngang theo cao 1080 - cùng quy
  // ước với CaptionTrack/HighlightTrack (9:16 và 16:9 gốc đều ra u = 1).
  const vertical = height >= width;
  const u = vertical ? height / 1920 : height / 1080;

  const font = resolveSubtitleFont(style?.fontFamily);
  const fontSize = style?.fontSizePx ?? DEFAULTS.fontSizePx;
  const color = style?.color ?? DEFAULTS.color;
  const backdrop = style?.backdrop ?? "blur";
  const backdropColor = style?.backdropColor ?? DEFAULTS.backdropColor;
  const blurPx = style?.blurPx ?? DEFAULTS.blurPx;

  const baseBottom =
    style?.bottomPx ?? (vertical ? DEFAULTS.bottomVertical : DEFAULTS.bottomHorizontal);
  const raisedBottom = vertical ? RAISED_BOTTOM_VERTICAL : RAISED_BOTTOM_HORIZONTAL;
  // `raised` phải THẮNG cả bottomPx người dùng đặt: đặt tay một con số thấp mà
  // bài lại có phụ đề karaoke thì hai lớp chồng lên nhau, chữ chồng chữ không
  // đọc được lớp nào. Cho phép đặt CAO hơn, không cho phép đặt thấp xuống.
  const bottomBase = raised ? Math.max(baseBottom, raisedBottom) : baseBottom;

  // Vào 4 frame / ra 4 frame để không "bật tắt" cứng giữa hai câu.
  const opacity = fadeInOut(frame, last, 4, 4);
  const y = interpolate(frame, [0, 5], [18, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // "none" = KHÔNG có nền: chữ trần trên footage sáng (trời, tường trắng) là
  // mất chữ, nên bù bằng bóng đổ đặc - viền tối bám nét chữ + quầng tối rộng.
  const textShadow =
    backdrop === "none"
      ? [
          `0 ${Math.round(2 * u)}px ${Math.round(10 * u)}px rgba(0,0,0,0.92)`,
          `0 0 ${Math.round(26 * u)}px rgba(0,0,0,0.7)`,
          `0 0 ${Math.round(3 * u)}px rgba(0,0,0,0.95)`,
        ].join(", ")
      : "none";

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: Math.round(bottomBase * u),
        paddingLeft: Math.round(72 * u),
        paddingRight: Math.round(72 * u),
        opacity,
      }}
    >
      <div
        style={{
          transform: `translateY(${y}px)`,
          // Glass theo brand: viền bằng box-shadow inset, KHÔNG border 1px cứng.
          // backdrop "none" thì bỏ sạch nền/viền/bóng hộp, chỉ còn chữ + text-shadow.
          background: backdrop === "none" ? "transparent" : backdropColor,
          // Blur nhân theo `u` (CaptionTrack để cứng 20px vì chỉ chạy ở u = 1) -
          // lên 4K u = 2 thì blur 20px trông gần như không mờ.
          backdropFilter: backdrop === "blur" ? `blur(${Math.round(blurPx * u)}px)` : undefined,
          WebkitBackdropFilter:
            backdrop === "blur" ? `blur(${Math.round(blurPx * u)}px)` : undefined,
          borderRadius: Math.round(28 * u),
          boxShadow:
            backdrop === "none"
              ? "none"
              : "inset 0 1px 0 rgba(255,255,255,0.16), inset 0 0 0 1px rgba(120,200,255,0.14), 0 18px 50px rgba(0,0,0,0.45)",
          padding:
            backdrop === "none"
              ? 0
              : `${Math.round(30 * u)}px ${Math.round(44 * u)}px ${Math.round(34 * u)}px`,
          // Dòng chảy chữ bình thường (không flex) - flex bỏ text node khoảng
          // trắng, đã cho ra chữ dính nhau ("dữ liệuđơn hàng") ở CaptionTrack.
          display: "block",
          // Bản dịch đã xuống dòng sẵn bằng "\n" (tối đa 2 dòng, xem translate.ts).
          // pre-line: tôn trọng "\n", vẫn gộp khoảng trắng thừa và tự wrap khi tràn.
          whiteSpace: "pre-line",
          fontFamily: font.stack,
          fontSize: Math.round(fontSize * u),
          fontWeight: 700,
          lineHeight: 1.3,
          letterSpacing: "-0.02em",
          textAlign: "center",
          color,
          textShadow,
          maxWidth: "100%",
        }}
      >
        {cue.text}
      </div>
    </AbsoluteFill>
  );
};

export const SubtitleTrack: React.FC<{
  subtitles: SubtitleCue[];
  style?: SubtitleStyle;
  /** true khi composition CÓ phụ đề karaoke - leo lên trên khối caption */
  raised?: boolean;
}> = ({ subtitles, style, raised = false }) => {
  useVietnameseFont();

  const font = resolveSubtitleFont(style?.fontFamily);

  return (
    <>
      {/* @font-face phải nằm trong DOM render, không import CSS ngoài */}
      <style>{font.faceCss}</style>
      {subtitles.map((cue, index) => (
        <Sequence
          key={`sub-${cue.from}-${index}`}
          from={cue.from}
          durationInFrames={cue.durationInFrames}
        >
          <Cue cue={cue} style={style} raised={raised} />
        </Sequence>
      ))}
    </>
  );
};
