import React from "react";
import {
  Audio,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Music } from "../manifest";
import { useMediaSrc } from "../media";

/** Thời gian chuyển mượt quanh mỗi biên speech range (giây). */
const DUCK_RAMP_SEC = 0.4;
/** Fade-in nhạc đầu video (giây). */
const FADE_IN_SEC = 0.5;
/** Fade-out nhạc cuối video (giây). */
const FADE_OUT_SEC = 1;

/**
 * Nhạc nền toàn bài với auto-ducking TẤT ĐỊNH (không Math.random/Date):
 * - Trong speech range → duckVolume, ngoài → volume; chuyển mượt bằng
 *   interpolate trong 0.4s quanh mỗi biên.
 * - Fade-in 0.5s đầu video, fade-out 1s cuối (theo durationInFrames + fps).
 * - `loop` để bài ngắn hơn video tự lặp.
 */
export const MusicTrack: React.FC<{ music: Music }> = ({ music }) => {
  const { fps, durationInFrames } = useVideoConfig();
  // Frame TUYỆT ĐỐI trên timeline — không dùng tham số của volume callback vì
  // với `loop` Remotion đếm lại frame theo từng vòng lặp, ducking sẽ lệch từ
  // vòng thứ hai. MusicTrack nằm ngoài Loop nên useCurrentFrame() luôn tuyệt đối.
  const frame = useCurrentFrame();
  const mediaSrc = useMediaSrc();

  const rampFrames = Math.max(1, DUCK_RAMP_SEC * fps);
  const half = rampFrames / 2;

  const volumeAt = (f: number): number => {
    // duckAmount = 0 (ngoài thoại) .. 1 (trong thoại) — lấy max qua mọi range
    let duckAmount = 0;
    for (const [startSec, endSec] of music.speech) {
      const startF = startSec * fps;
      const endF = endSec * fps;
      if (endF <= startF) continue;
      const rampIn = interpolate(f, [startF - half, startF + half], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const rampOut = interpolate(f, [endF - half, endF + half], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      duckAmount = Math.max(duckAmount, Math.min(rampIn, rampOut));
    }
    const level = music.volume + (music.duckVolume - music.volume) * duckAmount;

    // Envelope fade-in đầu / fade-out cuối video
    const fadeIn = interpolate(f, [0, FADE_IN_SEC * fps], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const fadeOut = interpolate(
      f,
      [durationInFrames - 1 - FADE_OUT_SEC * fps, durationInFrames - 1],
      [1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
    return Math.max(0, level * Math.min(fadeIn, fadeOut));
  };

  return (
    <Audio src={mediaSrc(music.file)} loop volume={() => volumeAt(frame)} />
  );
};
