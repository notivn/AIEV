import path from "node:path";
import express, { Router } from "express";
import { paths } from "../config.js";

/**
 * GET /media/<relPath> - phát file tĩnh (video/audio seek được nhờ Range).
 * Chỉ phục vụ dưới whitelist: video-projects/, image-projects/, translate-video/,
 * assets/, outputs/, imports/, remotion-fonts/.
 * express.static (serve-static) tự chặn `..`/path traversal và hỗ trợ Range.
 */
const router = Router();

const whitelist: Record<string, string> = {
  "video-projects": paths.videoProjectsDir,
  "image-projects": paths.imageProjectsDir,
  // Dịch video: web UI xem trước và tải video đã ghép phụ đề từ
  // translate-video/<id>/output.mp4. Thiếu dòng này thì render xong nhưng
  // người dùng không xem được - đúng nghĩa tính năng chạy mà vô dụng.
  "translate-video": paths.translateVideoDir,
  assets: paths.assetsDir,
  outputs: paths.outputsDir,
  imports: paths.importsDir,
  // Font overlay (Inter VN) của composition Assemble - trình phát xem trước
  // trong trình chỉnh sửa nạp @font-face từ đây thay cho staticFile("fonts/...")
  // (engines/remotion/src/media.tsx). Thiếu thì phụ đề/highlight rơi về font
  // dự phòng và mất dấu tiếng Việt ngay trong bản xem trước.
  "remotion-fonts": paths.remotionFontsDir,
};

/** Đuôi file KHÔNG bao giờ được trình duyệt render như tài liệu same-origin */
const FORCE_DOWNLOAD_EXT = new Set([".html", ".htm", ".xhtml", ".xml", ".svgz"]);

for (const [prefix, dir] of Object.entries(whitelist)) {
  router.use(
    `/${prefix}`,
    express.static(dir, {
      dotfiles: "deny",
      index: false,
      fallthrough: true,
      setHeaders: (res, filePath) => {
        // Không cho trình duyệt tự đoán kiểu file (MIME sniffing → XSS)
        res.setHeader("X-Content-Type-Options", "nosniff");
        const ext = path.extname(filePath).toLowerCase();
        if (FORCE_DOWNLOAD_EXT.has(ext)) {
          // index.html của composition, XML… - tải về, không chạy như trang web
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Disposition", "attachment");
        } else if (ext === ".svg") {
          // SVG vẫn phải hiển thị được trong <img> (logo Style Design) nên giữ
          // đúng MIME, nhưng khóa mọi script/nhúng khi bị mở trực tiếp.
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          );
        }
      },
    }),
  );
}

// Ngoài whitelist hoặc file không tồn tại → 404 chuẩn { error }
router.use((_req, res) => {
  res.status(404).json({ error: { code: "MEDIA_NOT_FOUND", message: "Không tìm thấy file" } });
});

export default router;
