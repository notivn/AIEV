import React from "react";
import { Audio, Sequence, useVideoConfig } from "remotion";
import type { Sfx } from "../manifest";
import { useMediaErrorProps, useMediaSrc } from "../media";

/** Volume sfx mặc định — thấp hơn voice ~10dB (skill remotion-assemble). */
const DEFAULT_SFX_VOLUME = 0.3;

/**
 * Track sound effect: mỗi entry một <Sequence from={atFrame}> chứa <Audio>.
 * File đã được server stage vào public/staging → load qua staticFile()
 * (qua useMediaSrc - xem media.tsx).
 */
export const SfxTrack: React.FC<{ sfx: Sfx[] }> = ({ sfx }) => {
  const { fps } = useVideoConfig();
  const mediaSrc = useMediaSrc();
  const errorProps = useMediaErrorProps();

  return (
    <>
      {sfx.map((entry, index) => (
        <Sequence
          key={`${entry.file}-${entry.atFrame}-${index}`}
          from={entry.atFrame}
        >
          <Audio
            src={mediaSrc(entry.file)}
            // Bỏ khoảng lặng dẫn của file sfx → tiếng thật rơi đúng atFrame
            startFrom={Math.round((entry.mediaStart ?? 0) * fps)}
            volume={entry.volume ?? DEFAULT_SFX_VOLUME}
            {...errorProps(entry.file)}
          />
        </Sequence>
      ))}
    </>
  );
};
