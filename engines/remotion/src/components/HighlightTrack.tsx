import React from "react";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { HighlightCue } from "../manifest";
import { fadeInOut } from "./fade";
import { useVietnameseFont, VIETNAMESE_FONT_FAMILY, vietnameseFontFaceCss } from "./vietnameseFont";

/**
 * Overlay "làm nổi bật key chính" chạy TRÊN footage gốc (skill noti-tiktok-vn).
 *
 * Khác `CaptionTrack`: đây KHÔNG phải phụ đề — không đọc theo từng từ, không
 * bám mọi câu. Mỗi cue là một key (chính hoặc phụ) do AI chọn từ transcript,
 * hiện 2–4s đúng lúc câu đó được nói, dạng thẻ Liquid Glass. Dùng cho brief
 * "phụ đề: không" nhưng vẫn muốn key nổi bật lúc video chạy.
 *
 * Vị trí (skill key-layout, khớp QC safe-area trong apps/server/src/qc.ts):
 * - tier "main" (KEY CHÍNH) → band TRÊN: paddingTop = 10% chiều cao (dải UI
 *   TikTok/Reels, SAFE_TOP_RATIO) + DRIFT_MAX + 8px lề - tính bằng px theo
 *   chiều cao thật nên đúng cho cả dọc lẫn ngang, kể cả khi thẻ trôi lên hết
 *   drift ở cuối cue (dọc 1920: 192+14+8=214; ngang 1080: 108+14+8=130).
 * - tier "sub" (key liên quan) → neo ĐÁY: dọc paddingBottom 330 (mép dưới
 *   pill y=1590, nằm trọn trên dải UI 16% dưới bắt đầu y=1613), ngang 240.
 *   Khi composition CÓ phụ đề (`raised`) thì đẩy lên (dọc 700 / ngang 470)
 *   để không đè lên thẻ caption.
 * Mọi px thiết kế cho canvas dọc 1080×1920 - nhân đơn vị tỉ lệ `u`.
 */

// Thẻ trôi lên tối đa chừng này px trong suốt cue (translateY 0 → -DRIFT_MAX).
// Dùng chung cho animation drift VÀ phép tính paddingTop để hai chỗ không lệch nhau.
const DRIFT_MAX = 14;

const ACCENTS = {
  hot: { text: "#ff7849", glow: "rgba(237,60,71,0.45)", bar: "linear-gradient(90deg,#ed3c47,#ff7849)" },
  cool: { text: "#37bdf8", glow: "rgba(55,189,248,0.45)", bar: "linear-gradient(90deg,#37bdf8,#8fd9ff)" },
} as const;

const Cue: React.FC<{ cue: HighlightCue; raised: boolean }> = ({
  cue,
  raised,
}) => {
  const frame = useCurrentFrame(); // 0 tại cue.from (đang trong <Sequence>)
  const { width, height } = useVideoConfig();
  const last = cue.durationInFrames - 1;
  const accent = ACCENTS[cue.accent ?? "cool"];
  const main = (cue.tier ?? "main") === "main";

  // Đơn vị tỉ lệ: dọc chuẩn hóa theo cao 1920 (9:16 gốc giữ nguyên px, u = 1),
  // ngang theo cao 1080 — cùng quy ước với CaptionTrack.
  const vertical = height >= width;
  const u = vertical ? height / 1920 : height / 1080;
  // Band dưới cho tier "sub": có caption thì đẩy lên trên vùng caption.
  // ⚠️ raised = 560 vẫn bị thẻ caption 3 dòng (cao tới y≈626 tính từ đáy) đè lên
  // — pill phải nằm TRÊN mép trên của caption dài nhất, nên 700.
  // ⚠️ không caption: 300 làm mép dưới pill chạm dải UI TikTok 16% (y=1613) — QC
  // safe-area khoanh đỏ đúng mép pill. 330 giữ pill nằm trọn trên dải đỏ.
  const bottomBase = raised ? (vertical ? 700 : 470) : (vertical ? 330 : 240);

  // Vào 5 frame / ra 6 frame — bật tắt cứng trông rẻ trên footage thật.
  const opacity = fadeInOut(frame, last, 5, 6);
  // Pop nhẹ khi vào (scale-pop 0.94 → 1.02 → 1) + trôi lên rất chậm suốt cue:
  // giữ cảm giác "sống" mà không giành sự chú ý với lời nói.
  const pop = interpolate(frame, [0, 5, 9], [0.94, 1.02, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // last = 0 (cue 1 frame) thì [0, 0] không tăng dần - interpolate ném lỗi
  const drift =
    last > 0
      ? interpolate(frame, [0, last], [0, -DRIFT_MAX], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0;
  // Thanh accent quét ra theo chiều ngang — nhịp "gạch chân" cho key chính.
  const barScale = interpolate(frame, [2, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        // KEY CHÍNH neo band TRÊN (skill key-layout); key liên quan neo đáy.
        justifyContent: main ? "flex-start" : "flex-end",
        alignItems: "center",
        // ⚠️ 7% từng làm kicker của thẻ main lọt vào dải UI TikTok/Reels 10% phía
        // trên (QC safe-area khoanh đỏ, SAFE_TOP_RATIO trong qc.ts). Tính bằng px:
        // 10% chiều cao (đáy dải đỏ) + DRIFT_MAX (thẻ trôi lên tối đa chừng này
        // ở cuối cue) + 8px lề an toàn - mép trên thẻ luôn nằm dưới dải đỏ ở mọi
        // frame, đúng cho cả dọc lẫn ngang (không phụ thuộc một tỉ lệ duy nhất).
        paddingTop: main ? Math.round(height * 0.1) + DRIFT_MAX + 8 : 0,
        paddingBottom: main ? 0 : Math.round(bottomBase * u),
        paddingLeft: Math.round(72 * u),
        paddingRight: Math.round(72 * u),
        opacity,
      }}
    >
      <div
        style={{
          transform: `translateY(${drift}px) scale(${pop})`,
          // Pop từ mép neo: thẻ trên (main) nở từ trên, thẻ đáy nở từ dưới.
          transformOrigin: main ? "center top" : "center bottom",
          // Liquid Glass: blur + viền trắng mờ bằng box-shadow inset (KHÔNG
          // border 1px cứng) + glow xanh nhẹ — Style Design "noti.vn".
          background: "rgba(16,17,19,0.46)",
          backdropFilter: "blur(26px)",
          WebkitBackdropFilter: "blur(26px)",
          borderRadius: Math.round((main ? 32 : 50) * u),
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.22), inset 0 0 0 1px rgba(255,255,255,0.08), 0 22px 60px rgba(0,0,0,0.5), 0 0 60px rgba(55,189,248,0.10)",
          padding: main
            ? `${Math.round(34 * u)}px ${Math.round(46 * u)}px ${Math.round(38 * u)}px`
            : `${Math.round(22 * u)}px ${Math.round(40 * u)}px ${Math.round(26 * u)}px`,
          maxWidth: "100%",
          textAlign: "center",
          fontFamily: `'${VIETNAMESE_FONT_FAMILY}', 'Segoe UI', sans-serif`,
        }}
      >
        {cue.kicker ? (
          <div
            style={{
              fontSize: Math.round(28 * u),
              fontWeight: 700,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "rgba(200,224,245,0.72)",
              marginBottom: Math.round(14 * u),
            }}
          >
            {cue.kicker}
          </div>
        ) : null}

        <div
          style={{
            // Chữ ĐẶC (không background-clip) → dấu tiếng Việt không bao giờ
            // bị cắt cụt; nhấn bằng màu accent thay vì gradient text.
            fontSize: Math.round((main ? 76 : 50) * u),
            fontWeight: 800,
            lineHeight: 1.14,
            letterSpacing: "-0.03em",
            color: "#ffffff",
            // Tách từ bằng margin đối xứng — text node khoảng trắng không đáng
            // tin (bài học CaptionTrack: "dữ liệuđơn hàng").
            display: "block",
          }}
        >
          {cue.parts.map((part, index) => (
            <span
              key={`${part.t}-${index}`}
              style={{
                display: "inline-block",
                margin: "0 0.13em",
                color: part.hi ? accent.text : "#ffffff",
                filter: part.hi ? `drop-shadow(0 0 24px ${accent.glow})` : "none",
              }}
            >
              {part.t}
            </span>
          ))}
        </div>

        {main ? (
          <div
            style={{
              width: Math.round(168 * u),
              height: Math.max(2, Math.round(6 * u)),
              borderRadius: 50,
              margin: `${Math.round(22 * u)}px auto 0`,
              background: accent.bar,
              transform: `scaleX(${barScale})`,
              transformOrigin: "center",
              boxShadow: `0 0 22px ${accent.glow}`,
            }}
          />
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

export const HighlightTrack: React.FC<{
  overlays: HighlightCue[];
  /** true khi composition CÓ phụ đề — đẩy band tier "sub" lên trên vùng caption */
  raised?: boolean;
}> = ({ overlays, raised = false }) => {
  useVietnameseFont();

  return (
    <>
      {/* @font-face phải nằm trong DOM render, không import CSS ngoài */}
      <style>{vietnameseFontFaceCss}</style>
      {overlays.map((cue, index) => (
        <Sequence
          key={`hl-${cue.from}-${index}`}
          from={cue.from}
          durationInFrames={cue.durationInFrames}
        >
          <Cue cue={cue} raised={raised} />
        </Sequence>
      ))}
    </>
  );
};
