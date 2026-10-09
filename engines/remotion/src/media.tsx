import React, { createContext, useContext } from "react";
import { staticFile } from "remotion";

/**
 * Đổi một đường dẫn media trong manifest thành URL mà trình duyệt nạp được.
 *
 * - Render qua CLI (mặc định): `staticFile()` - đường dẫn là `staging/...`
 *   (server đã stage vào public/) hoặc `fonts/...` (public/fonts). Mặc định
 *   CHÍNH LÀ staticFile nên cây Assemble không bọc Provider vẫn ra y hệt trước.
 * - Xem trước trong dashboard (`@remotion/player`): không có public/ của
 *   Remotion, đường dẫn trong manifest là đường dẫn TƯƠNG ĐỐI PROJECT
 *   (`assets/x.mp4`, `renders/s1.mp4`) → trang web bọc Provider với resolver
 *   trỏ sang `/media/...` của backend (xem apps/web/.../PreviewPlayer.tsx).
 *
 * Mọi chỗ trong cây Assemble cần URL media PHẢI đi qua `useMediaSrc()`, không
 * gọi `staticFile()` trực tiếp - gọi thẳng là trình phát trong dashboard 404.
 * Poster/Thumbnail/brandFonts chỉ chạy qua CLI nên vẫn dùng staticFile.
 */
export type MediaResolver = (path: string) => string;

export const MediaResolverContext = createContext<MediaResolver>(staticFile);

export const MediaResolverProvider: React.FC<{
  resolve: MediaResolver;
  children: React.ReactNode;
}> = ({ resolve, children }) => (
  <MediaResolverContext.Provider value={resolve}>{children}</MediaResolverContext.Provider>
);

/** Resolver đang có hiệu lực (staticFile khi không có Provider). */
export const useMediaSrc = (): MediaResolver => useContext(MediaResolverContext);
