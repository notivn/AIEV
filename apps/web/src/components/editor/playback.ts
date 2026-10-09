"use client";

/**
 * Playhead + trạng thái phát, NGOÀI React state.
 *
 * Lúc phát, Player bắn `frameupdate` mỗi frame (30-60 lần/giây). Nếu frame hiện
 * tại nằm trong state của trang thì cả timeline (hàng trăm khối) render lại theo
 * từng frame. Ở đây nó là một store nhỏ, chỉ vài thứ thật sự cần (vạch playhead,
 * ô thời gian, tự cuộn) đăng ký qua useSyncExternalStore.
 */

import { useSyncExternalStore } from "react";

export interface PlaybackStore {
  getFrame: () => number;
  isPlaying: () => boolean;
  setFrame: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPlaybackStore(): PlaybackStore {
  let frame = 0;
  let playing = false;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    getFrame: () => frame,
    isPlaying: () => playing,
    setFrame: (next) => {
      const f = Math.max(0, Math.round(next));
      if (f === frame) return;
      frame = f;
      emit();
    },
    setPlaying: (next) => {
      if (next === playing) return;
      playing = next;
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function usePlayheadFrame(store: PlaybackStore): number {
  return useSyncExternalStore(store.subscribe, store.getFrame, () => 0);
}

export function useIsPlaying(store: PlaybackStore): boolean {
  return useSyncExternalStore(store.subscribe, store.isPlaying, () => false);
}
