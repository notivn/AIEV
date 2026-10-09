import React from "react";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { CaptionCue, CaptionWord } from "../manifest";
import { fadeInOut } from "./fade";
import {
  useVietnameseFont,
  VIETNAMESE_FONT_FAMILY,
  vietnameseFontFaceCss,
} from "./vietnameseFont";

/**
 * Phụ đề karaoke overlay toàn bài — tầng lắp ráp (skill video-pipeline giao
 * "overlay caption toàn bài" cho Remotion, motion-graphics cho HyperFrames).
 *
 * Dữ liệu đến từ manifest.captions: mỗi cue là một cụm 4–7 từ, `words[].start/end`
 * là FRAME TUYỆT ĐỐI trên timeline composition. Từ đang được đọc tô #19c8ff +
 * scale 1.13 (style Noti.vn/GĐT); từ đánh dấu `hi` là keyword — giữ màu vàng
 * nhấn suốt cue để người xem bắt được ý chính dù không đọc kịp cả câu.
 */

const ACTIVE = "#19c8ff";
const KEYWORD = "#ffcf4d";
const IDLE = "rgba(255,255,255,0.92)";

/**
 * `frame` là frame TUYỆT ĐỐI của composition — bên trong <Sequence>,
 * useCurrentFrame() đã trừ đi `from`, nên Cue phải cộng lại rồi truyền xuống
 * (word.start/end khai theo hệ tuyệt đối, xem manifest.ts).
 */
const Word: React.FC<{ word: CaptionWord; frame: number }> = ({
  word,
  frame,
}) => {
  const spoken = frame >= word.start && frame <= word.end;

  // Pop nhẹ khi từ vừa được đọc tới, trong 3 frame rồi giữ.
  // ⚠️ Hệ số CỐ ĐỊNH (1.13) làm từ DÀI ("HyperFrames") nở ra rộng hơn hộp layout
  // nhiều hơn margin hai bên → dính vào từ kế ("dùngHyperFramesnày"). Chia biên độ
  // theo độ dài từ để phần nở ra tính bằng PIXEL gần như không đổi (~20px), luôn
  // nhỏ hơn margin 0.2em ở hai bên.
  const grow = 0.1 * Math.min(1, 6 / Math.max(1, word.text.length));
  const scale = spoken
    ? interpolate(frame, [word.start, word.start + 3], [1, 1 + grow], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;

  const color = spoken ? (word.hi ? KEYWORD : ACTIVE) : word.hi ? KEYWORD : IDLE;

  return (
    <span
      style={{
        display: "inline-block",
        // Tách từ bằng margin ĐỐI XỨNG, không trông cậy khoảng trắng hay
        // flex gap: text node chỉ-khoảng-trắng bị bỏ khi cha là flex, và gap
        // đã cho ra chữ dính nhau ("dữ liệuđơn hàng") ở draft đầu tiên.
        margin: "0 0.2em",
        transform: `scale(${scale})`,
        transformOrigin: "center bottom",
        color,
        fontWeight: word.hi ? 800 : 700,
        // Glow chỉ khi đang đọc tới — dùng drop-shadow trên chữ đặc (không
        // phải gradient text) nên text-shadow cũng được, nhưng drop-shadow
        // bám nét chữ đẹp hơn khi nằm trên footage nhiều chi tiết.
        filter: spoken
          ? `drop-shadow(0 0 22px ${word.hi ? "rgba(255,190,70,0.5)" : "rgba(25,200,255,0.55)"})`
          : "none",
      }}
    >
      {word.text}
    </span>
  );
};

const Cue: React.FC<{ cue: CaptionCue }> = ({ cue }) => {
  const frame = useCurrentFrame(); // 0 tại cue.from (đang trong <Sequence>)
  const { width, height } = useVideoConfig();
  const absFrame = frame + cue.from;
  const last = cue.durationInFrames - 1;

  // Đơn vị tỉ lệ: mọi px bên dưới thiết kế cho canvas dọc 1080×1920 (u = 1).
  // Dọc chuẩn hóa theo cao 1920, ngang theo cao 1080 — 9:16 giữ NGUYÊN pixel,
  // 16:9 (1920×1080) cũng u = 1 nhưng dùng base khác cho paddingBottom.
  const vertical = height >= width;
  const u = vertical ? height / 1920 : height / 1080;
  // Dọc: 320 nằm trên safe zone TikTok (~288). Ngang: caption cách đáy
  // ~110–150px (skill noti-youtube-edit) → base 130.
  const bottomBase = vertical ? 320 : 130;

  // Vào 4 frame / ra 4 frame để không "bật tắt" cứng giữa hai cụm.
  const opacity = fadeInOut(frame, last, 4, 4);
  const y = interpolate(frame, [0, 5], [18, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

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
          background: "rgba(10,16,32,0.52)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderRadius: Math.round(28 * u),
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.16), inset 0 0 0 1px rgba(120,200,255,0.14), 0 18px 50px rgba(0,0,0,0.45)",
          padding: `${Math.round(30 * u)}px ${Math.round(44 * u)}px ${Math.round(34 * u)}px`,
          // Dòng chảy chữ bình thường (không flex) — flex bỏ text node khoảng
          // trắng và gap không đáng tin; xuống dòng do line-height lo.
          display: "block",
          fontFamily: `'${VIETNAMESE_FONT_FAMILY}', 'Segoe UI', sans-serif`,
          fontSize: Math.round(62 * u),
          lineHeight: 1.3,
          letterSpacing: "-0.02em",
          textAlign: "center",
          maxWidth: "100%",
        }}
      >
        {cue.words.map((word, index) => (
          <Word key={`${word.text}-${index}`} word={word} frame={absFrame} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const CaptionTrack: React.FC<{ captions: CaptionCue[] }> = ({
  captions,
}) => {
  useVietnameseFont();

  return (
    <>
      {/* @font-face phải nằm trong DOM render, không import CSS ngoài */}
      <style>{vietnameseFontFaceCss}</style>
      {captions.map((cue, index) => (
        <Sequence
          key={`cue-${cue.from}-${index}`}
          from={cue.from}
          durationInFrames={cue.durationInFrames}
        >
          <Cue cue={cue} />
        </Sequence>
      ))}
    </>
  );
};
