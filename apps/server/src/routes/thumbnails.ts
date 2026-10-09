import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { paths, repoRoot } from "../config.js";
import { geminiApiKey, generateBackground } from "../gemini.js";
import {
  briefOf,
  listProjectAssets,
  normOutput,
  projectDirOf,
  projectExists,
  readMeta,
  writeMeta,
} from "../meta.js";
import { remotionGlArgs } from "../renderSettings.js";
import { getStyle, styleExists } from "../styles.js";
import { HttpError, ensureDir, execFileCapture, remotionCli } from "../util.js";
import type { ImageAspect } from "../imageMeta.js";

/**
 * Tạo THUMBNAIL cho video project - chạy ĐỒNG BỘ (~1 phút), pipeline:
 * 1) ffmpeg cắt một frame từ video (mặc định output final của meta,
 *    fallback video asset đầu tiên) tại giây `frameAt`
 * 2) Gemini vẽ nền theo Style Design (lỗi/thiếu key → bỏ qua, composition
 *    tự dựng nền gradient từ style - như Poster)
 * 3) stage nền + frame + logo + font bằng hardlink → props.json →
 *    `npx remotion still Thumbnail` → video-projects/<id>/thumbnail.png
 * Style resolve: body.styleId → brief.styleId → default (như /api/illustrations).
 * Đăng ký trong index.ts dưới prefix /api/projects (sau projectsRouter).
 */

const router = Router();

// POST /api/projects/:id/thumbnail
// { title, frameAt?: number (giây, default 1), sourceRel?, bgPrompt?, styleId? }
// → 201 { file: "thumbnail.png", relPath }
router.post("/:id/thumbnail", async (req, res) => {
  const id = req.params.id;
  if (!projectExists(id)) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `Không tìm thấy video project "${id}"`);
  }
  const body = (req.body ?? {}) as Record<string, unknown>;

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    throw new HttpError(400, "TITLE_REQUIRED", "Thiếu title cho thumbnail");
  }
  const frameAt =
    typeof body.frameAt === "number" && Number.isFinite(body.frameAt) && body.frameAt >= 0
      ? body.frameAt
      : 1;
  const bgPrompt = typeof body.bgPrompt === "string" ? body.bgPrompt.trim() : "";
  if ("styleId" in body && body.styleId !== null && typeof body.styleId !== "string") {
    throw new HttpError(400, "INVALID_STYLE_ID", "styleId phải là string hoặc null");
  }
  const styleId = typeof body.styleId === "string" ? body.styleId.trim() : "";
  if (styleId && !styleExists(styleId)) {
    throw new HttpError(404, "STYLE_NOT_FOUND", `Không tìm thấy style "${styleId}"`);
  }

  const meta = readMeta(id);
  const projectDir = projectDirOf(id);

  // Đường dẫn do người dùng/agent cung cấp - chặn thoát khỏi repo
  const resolveInRepo = (rel: string, what: string): string => {
    const abs = path.resolve(repoRoot, rel);
    if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) {
      throw new HttpError(400, "PATH_OUTSIDE_REPO", `${what} "${rel}" nằm ngoài repo`);
    }
    return abs;
  };

  // ---- Video nguồn để cắt frame: sourceRel → output final → video asset đầu
  let videoAbs: string | null = null;
  const sourceRel = typeof body.sourceRel === "string" ? body.sourceRel.trim() : "";
  if (sourceRel) {
    const abs = resolveInRepo(sourceRel, "sourceRel");
    if (!fs.existsSync(abs)) {
      throw new HttpError(404, "SOURCE_NOT_FOUND", `Không thấy video nguồn "${sourceRel}"`);
    }
    videoAbs = abs;
  } else {
    const output = normOutput(meta.output);
    if (output) {
      const abs = resolveInRepo(output, "output");
      if (fs.existsSync(abs)) videoAbs = abs;
    }
    if (!videoAbs) {
      const firstVideo = listProjectAssets(id).find((f) => f.kind === "video");
      if (firstVideo) videoAbs = path.join(repoRoot, firstVideo.relPath);
    }
  }
  if (!videoAbs) {
    throw new HttpError(
      400,
      "NO_SOURCE_VIDEO",
      "Project chưa có video để cắt frame (chưa có output final lẫn video asset) - truyền sourceRel hoặc render final trước",
    );
  }

  // ---- 1) ffmpeg cắt frame ------------------------------------------------
  const rendersDir = path.join(projectDir, "renders");
  ensureDir(rendersDir);
  const frameAbs = path.join(rendersDir, "thumb-frame.png");
  // Xóa frame lần trước: -ss vượt thời lượng thì ffmpeg vẫn thoát 0 mà không ghi
  // gì, và existsSync bên dưới sẽ đọc trúng frame CŨ thay vì báo lỗi
  fs.rmSync(frameAbs, { force: true });
  try {
    await execFileCapture(
      "ffmpeg",
      ["-y", "-ss", String(frameAt), "-i", videoAbs, "-frames:v", "1", "-q:v", "2", frameAbs],
      { timeoutMs: 60_000 },
    );
  } catch (err) {
    throw new HttpError(
      500,
      "FRAME_FAILED",
      `ffmpeg không cắt được frame tại giây ${frameAt}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!fs.existsSync(frameAbs)) {
    throw new HttpError(
      500,
      "FRAME_FAILED",
      `ffmpeg chạy xong nhưng không có frame - frameAt=${frameAt}s có thể vượt quá thời lượng video`,
    );
  }

  // ---- 2) Gemini vẽ nền theo Style Design (fail-soft: không nền vẫn tiếp tục)
  const design = getStyle(styleId || briefOf(meta).styleId || null);
  const aspect: ImageAspect = meta.height >= meta.width ? "9:16" : "16:9";
  const bgAbs = path.join(rendersDir, "thumb-bg.png");
  let hasBg = false;
  if (geminiApiKey()) {
    try {
      await generateBackground({
        prompt: bgPrompt || `background for a video thumbnail about: ${title}`,
        kind: "concept",
        aspect,
        design,
        allowText: false,
        outFile: bgAbs,
        usageProjectId: id,
      });
      hasBg = true;
    } catch (err) {
      console.warn(
        `[thumbnail] Gemini lỗi - dùng nền gradient từ style: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---- 3) Stage bằng hardlink (như imageGen) + props + remotion still ------
  const stagingId = `thumb-${id}`;
  const stagingAbs = path.join(paths.stagingDir, stagingId);
  fs.rmSync(stagingAbs, { recursive: true, force: true });
  ensureDir(stagingAbs);

  // prefix theo vai trò để file trùng basename không đè nhau
  const stage = (srcAbs: string, prefix: string): string => {
    const resolved = path.resolve(srcAbs);
    if (!resolved.startsWith(path.resolve(repoRoot) + path.sep)) {
      throw new HttpError(400, "PATH_OUTSIDE_REPO", `Đường dẫn "${srcAbs}" nằm ngoài repo - từ chối stage`);
    }
    const name = prefix + path.basename(srcAbs);
    const dstAbs = path.join(stagingAbs, name);
    try {
      fs.linkSync(resolved, dstAbs); // hardlink - không tốn dung lượng
    } catch {
      fs.copyFileSync(resolved, dstAbs); // fallback (khác ổ đĩa / FS không hỗ trợ)
    }
    return `staging/${stagingId}/${name}`;
  };

  const stageOptional = (rel: string | null, prefix: string): string | null => {
    if (!rel) return null;
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) return null;
    return stage(abs, prefix);
  };

  const props = {
    aspect,
    background: hasBg ? stage(bgAbs, "bg-") : null,
    frame: stage(frameAbs, "frame-"),
    title,
    design: {
      colors: design.colors,
      fonts: design.fonts,
      fontFiles: {
        heading: stageOptional(design.fontFiles.heading, "font-h-"),
        body: stageOptional(design.fontFiles.body, "font-b-"),
      },
      effects: design.effects,
      logoFile: stageOptional(design.logoPath, "logo-"),
      brandName: design.name,
    },
  };
  const propsAbs = path.join(rendersDir, "thumb-props.json");
  fs.writeFileSync(propsAbs, JSON.stringify(props, null, 2) + "\n", "utf8");

  const outAbs = path.join(projectDir, "thumbnail.png");
  try {
    await execFileCapture(
      process.execPath,
      [
        remotionCli(),
        "still",
        "Thumbnail",
        `--props=${propsAbs}`,
        `--output=${outAbs}`,
        ...remotionGlArgs(),
      ],
      { cwd: paths.remotionDir, timeoutMs: 300_000 },
    );
  } catch (err) {
    throw new HttpError(
      500,
      "STILL_FAILED",
      `Remotion still Thumbnail thất bại: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Staging chỉ cần trong lúc still - dọn luôn (kể cả khi lỗi), không tích rác
    fs.rmSync(stagingAbs, { recursive: true, force: true });
  }
  if (!fs.existsSync(outAbs)) {
    throw new HttpError(500, "STILL_FAILED", "Remotion still xong nhưng không thấy thumbnail.png");
  }

  // Chạm updatedAt (writeMeta tự set) để web bust cache thumbnail ?v=updatedAt -
  // không chạm là browser giữ ảnh cũ. Đọc lại meta vì job khác có thể đã ghi trong lúc render.
  writeMeta(id, readMeta(id));

  res.status(201).json({
    file: "thumbnail.png",
    relPath: `video-projects/${id}/thumbnail.png`,
  });
});

export default router;
