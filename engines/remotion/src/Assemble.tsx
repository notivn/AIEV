import React from "react";
import { AbsoluteFill, Audio, Img, Sequence, useVideoConfig } from "remotion";
import {
  resolveSceneDurationInFrames,
  type Manifest,
} from "./manifest";
import { CaptionTrack } from "./components/CaptionTrack";
import { HighlightTrack } from "./components/HighlightTrack";
import { MusicTrack } from "./components/MusicTrack";
import { SceneClip } from "./components/SceneClip";
import { SfxTrack } from "./components/SfxTrack";
import { SubtitleTrack } from "./components/SubtitleTrack";
import { Transition } from "./components/Transition";
import { useMediaErrorProps, useMediaSrc } from "./media";

/**
 * Composition "Assemble" duy nhất — data-driven hoàn toàn từ manifest
 * (meta.json đã resolve đường dẫn staging, xem src/manifest.ts).
 *
 * Timeline: cộng dồn `from` theo durationInFrames từng scene, TRỪ
 * transitionOverlap khi chuyển scene (quên trừ là hở khoảng đen — skill
 * remotion-assemble). Scene sau nằm đè scene trước trong khoảng overlap,
 * crossfade do <Transition> xử lý bằng opacity.
 */
export const Assemble: React.FC<Manifest> = (manifest) => {
  const { scenes, audio, fps, captions, overlays, watermark, subtitles, subtitleStyle } =
    manifest;
  const mediaSrc = useMediaSrc();
  const errorProps = useMediaErrorProps();

  let from = 0;
  const sequences = scenes.map((scene, index) => {
    const duration = resolveSceneDurationInFrames(scene, fps);
    // Crossfade của scene này do transitionOverlap của scene LIỀN TRƯỚC quyết định.
    const fadeInFrames = index > 0 ? (scenes[index - 1].transitionOverlap ?? 0) : 0;

    const sequence = (
      <Sequence key={scene.id} from={from} durationInFrames={duration}>
        <Transition fadeInFrames={fadeInFrames}>
          <SceneClip scene={scene} fps={fps} />
        </Transition>
      </Sequence>
    );

    from += duration - (scene.transitionOverlap ?? 0);
    return sequence;
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#101113" }}>
      {sequences}

      {/* Thẻ làm nổi bật key — trên footage, dưới phụ đề (nếu có cả hai thì
          phụ đề là lớp trên cùng vì nó đọc liên tục). Có phụ đề → `raised`
          đẩy band tier "sub" lên trên vùng caption để hai lớp không đè nhau.
          Phụ đề dịch cũng chiếm đúng band đáy đó nên tính vào `raised` luôn. */}
      {overlays.length > 0 ? (
        <HighlightTrack
          overlays={overlays}
          raised={captions.length > 0 || subtitles.length > 0}
        />
      ) : null}

      {/* Phụ đề dịch ("Dịch video"). Cùng neo đáy với phụ đề karaoke nên PHẢI
          tránh nhau: chọn cách đã có sẵn trong file này (HighlightTrack) - có
          karaoke thì `raised` đẩy khối phụ đề dịch lên TRÊN khối caption
          (700 dọc / 470 ngang, đúng con số đo trên thẻ caption 3 dòng), không
          karaoke thì nó ngồi đúng band đáy quen thuộc. Không sửa CaptionTrack:
          karaoke luôn là lớp dưới cùng, bản dịch xếp chồng lên trên. */}
      {subtitles.length > 0 ? (
        <SubtitleTrack
          subtitles={subtitles}
          style={subtitleStyle}
          raised={captions.length > 0}
        />
      ) : null}

      {/* Phụ đề karaoke nằm TRÊN mọi scene, dưới không có gì — overlay cuối cùng */}
      {captions.length > 0 ? <CaptionTrack captions={captions} /> : null}

      {/* Voice: xương sống sync — một track chạy suốt từ frame 0 */}
      {audio.voice ? <Audio src={mediaSrc(audio.voice)} {...errorProps(audio.voice)} /> : null}

      {/* Sound effects theo atFrame */}
      <SfxTrack sfx={audio.sfx} />

      {/* Nhạc nền loop + auto-ducking theo speech ranges */}
      {audio.music ? <MusicTrack music={audio.music} /> : null}

      {/* Logo thương hiệu - LỚP TRÊN CÙNG, sau cả phụ đề: logo đóng góc mà bị
          một overlay nào đó đè lên thì coi như không có. */}
      {watermark ? <WatermarkMark watermark={watermark} /> : null}
    </AbsoluteFill>
  );
};

/**
 * Logo đóng góc. Chỉ đổi KÍCH THƯỚC và VỊ TRÍ - không bóp méo, không tô lại,
 * không bo góc, không đổ bóng lên chính logo (nhận diện thương hiệu là bất khả
 * xâm phạm; xem khối LOGO trong editPrompt.ts).
 *
 * Kích thước và lề tính theo % để một manifest chạy đúng ở mọi khung hình:
 * chiều cao theo % chiều cao video, còn lề lấy theo % CHIỀU RỘNG cho cả hai
 * trục - lấy theo mỗi trục thì ở khung dọc 9:16 lề trên trông xa gấp đôi lề trái.
 */
const WatermarkMark: React.FC<{ watermark: NonNullable<Manifest["watermark"]> }> = ({
  watermark,
}) => {
  const { width, height } = useVideoConfig();
  const mediaSrc = useMediaSrc();
  const margin = Math.round((watermark.marginPercent / 100) * width);
  const logoHeight = Math.round((watermark.heightPercent / 100) * height);
  const vertical = watermark.position.startsWith("top")
    ? { top: margin }
    : { bottom: margin };
  const horizontal = watermark.position.endsWith("left")
    ? { left: margin }
    : { right: margin };

  return (
    <Img
      src={mediaSrc(watermark.file)}
      style={{
        position: "absolute",
        ...vertical,
        ...horizontal,
        height: logoHeight,
        // width:auto giữ nguyên tỉ lệ khung ảnh gốc của logo
        width: "auto",
        opacity: watermark.opacity,
      }}
    />
  );
};
