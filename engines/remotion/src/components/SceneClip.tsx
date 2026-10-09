import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, useCurrentFrame } from "remotion";
import type { Scene, Zoom } from "../manifest";
import { useMediaErrorProps, useMediaSrc } from "../media";

const videoStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
};

const easeFns: Record<string, (t: number) => number> = {
  linear: (t) => t,
  // power3.out — vào nhanh rồi ghì lại, dùng cho punch-in nhấn
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

/**
 * Hệ số scale tại `frame` (tính từ đầu scene) theo các mốc zoom.
 * Ngoài mốc đầu/cuối thì giữ nguyên scale của mốc đó (clamp).
 */
const scaleAtFrame = (zoom: Zoom, frame: number): number => {
  const keys = [...zoom.keys].sort((a, b) => a.frame - b.frame);
  if (frame <= keys[0].frame) {
    return keys[0].scale;
  }
  for (let i = 0; i < keys.length - 1; i += 1) {
    const from = keys[i];
    const to = keys[i + 1];
    if (frame <= to.frame) {
      const span = to.frame - from.frame;
      if (span <= 0) {
        return to.scale;
      }
      const t = (frame - from.frame) / span;
      const ease = easeFns[from.ease ?? "inOut"] ?? easeFns.inOut;
      return from.scale + (to.scale - from.scale) * ease(t);
    }
  }
  return keys[keys.length - 1].scale;
};

/**
 * Lớp bọc camera-move: scale trên DIV, KHÔNG bao giờ animate width/height của
 * thẻ video (đóng băng frame — xem skill noti-tiktok-vn). `overflow: hidden` +
 * video `object-fit: cover` để scale ≥ 1 không lộ mép nền.
 */
const ZoomWrapper: React.FC<{ zoom?: Zoom; children: React.ReactNode }> = ({
  zoom,
  children,
}) => {
  const frame = useCurrentFrame(); // 0 tại đầu scene (đang trong <Sequence>)

  if (!zoom) {
    return <AbsoluteFill>{children}</AbsoluteFill>;
  }

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: `scale(${scaleAtFrame(zoom, frame)})`,
          transformOrigin: zoom.origin ?? "50% 38%",
        }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * Một scene trên timeline:
 * - scene có `render` (MP4 do HyperFrames render) → phát nguyên file.
 * - scene có `srcVideo` (footage) → phát đoạn [from, to] (giây → frame theo fps).
 * - scene có `srcImage` (ảnh tĩnh đã stage) → hiện full-bleed cover suốt scene.
 * - chưa có media nào (vd mở Studio với defaultProps demo) → placeholder tối
 *   hiện id scene, để Studio mở được mà không cần file trong staging.
 *
 * Mọi đường dẫn là đường dẫn tương đối trong public/ (staging) → staticFile()
 * (qua useMediaSrc - trình phát trong dashboard thay resolver, xem media.tsx).
 */
export const SceneClip: React.FC<{
  scene: Scene;
  fps: number;
}> = ({ scene, fps }) => {
  const mediaSrc = useMediaSrc();
  const errorProps = useMediaErrorProps();

  if (scene.render) {
    return (
      <ZoomWrapper zoom={scene.zoom}>
        <OffthreadVideo src={mediaSrc(scene.render)} style={videoStyle} {...errorProps(scene.render)} />
      </ZoomWrapper>
    );
  }

  if (scene.srcVideo) {
    const startFrom = Math.round((scene.from ?? 0) * fps);
    const endAt = scene.to != null ? Math.round(scene.to * fps) : undefined;
    return (
      <ZoomWrapper zoom={scene.zoom}>
        <OffthreadVideo
          src={mediaSrc(scene.srcVideo)}
          startFrom={startFrom}
          endAt={endAt}
          muted={scene.muted ?? false}
          style={videoStyle}
          {...errorProps(scene.srcVideo)}
        />
      </ZoomWrapper>
    );
  }

  if (scene.srcImage) {
    return (
      <ZoomWrapper zoom={scene.zoom}>
        <Img src={mediaSrc(scene.srcImage)} style={videoStyle} {...errorProps(scene.srcImage)} />
      </ZoomWrapper>
    );
  }

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#101113",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          color: "#ffffff",
          opacity: 0.5,
          fontFamily: "Inter, sans-serif",
          fontSize: 40,
          fontWeight: 600,
        }}
      >
        {scene.id} (chưa render)
      </div>
    </AbsoluteFill>
  );
};
