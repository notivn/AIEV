import { interpolate } from "remotion";

/**
 * Độ mờ vào `fadeIn` frame / ra `fadeOut` frame cho một cue dài `last + 1` frame.
 *
 * interpolate() NÉM LỖI khi inputRange không tăng dần, nên viết thẳng
 * `[0, 4, Math.max(5, last - 4), last]` là cue ngắn (<= 6 frame - vd câu dịch bị
 * kẹp sát cuối video) làm chết CẢ bài render. Cue không đủ chỗ cho cả hai nhịp
 * thì mờ vào-ra hình tam giác; ngắn tới mức đó nữa thì hiện thẳng.
 */
export function fadeInOut(frame: number, last: number, fadeIn: number, fadeOut: number): number {
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  if (last >= fadeIn + fadeOut + 1) {
    return interpolate(frame, [0, fadeIn, last - fadeOut, last], [0, 1, 1, 0], clamp);
  }
  if (last >= 2) {
    return interpolate(frame, [0, Math.floor(last / 2), last], [0, 1, 0], clamp);
  }
  return 1;
}
