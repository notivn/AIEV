import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { generateBackground } from "../gemini.js";
import { activeVideoStyleId, briefOf, projectExists, readMeta, writeAssetEntry } from "../meta.js";
import { getStyle, styleExists } from "../styles.js";
import { getVideoStyle } from "../videoStyles.js";
import { paths } from "../config.js";
import { HttpError, ensureDir, toKebabAscii } from "../util.js";
import { IMAGE_TEXT_POSITIONS, type ImageAspect, type ImageTextPosition } from "../imageMeta.js";

/**
 * Tạo ảnh minh họa cho VIDEO project - công cụ cho agent Claude gọi trong lúc edit
 * (curl http://localhost:6869/api/illustrations).
 *
 * CỬA KHÓA: project TẮT "Ảnh minh họa AI" (brief.autoIllustrations) thì endpoint
 * này trả 409 ILLUSTRATIONS_DISABLED - công tắc trên UI phải có hiệu lực thật,
 * không phụ thuộc vào việc agent có đọc kỹ prompt hay không.
 *
 * Ảnh sinh bằng Gemini, prompt tự trộn
 * Style Design nên đồng bộ thương hiệu; cấm chữ trong ảnh. Style Design là BẮT BUỘC:
 * thiếu body.styleId thì server tự lấy brief.styleId của project (rồi mới tới default) -
 * agent quên truyền cũng không thoát được style đã chọn cho video.
 * Ảnh lưu vào video-projects/<id>/assets/illustrations/ + mô tả ghi vào assets.json.
 */

const ASPECTS: ImageAspect[] = ["9:16", "16:9", "1:1", "4:5"];

const router = Router();

// POST /api/illustrations { projectId, prompt, name?, aspect?, model?, description?, styleId?, allowText?, position? }
// → { file, relPath, promptUsed }
router.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!projectId || !projectExists(projectId)) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `Không tìm thấy video project "${projectId}"`);
  }
  // Công tắc "Ảnh minh họa AI" của brief là công tắc THẬT, chặn ngay tại đây -
  // TRƯỚC mọi tác dụng phụ (tạo thư mục, gọi Gemini, tính tiền).
  //
  // ĐÃ GẶP THẬT: công tắc tắt mà video vẫn có ảnh Gemini chèn vào. Prompt edit
  // hồi đó không nói gì khi tắt, agent đọc skill rồi vẫn gọi endpoint này và
  // server vui vẻ vẽ. Prompt đã được vá, nhưng prompt là LỜI KHUYÊN - skill dài
  // hàng nghìn chữ vẫn lấn át được. Chốt chặn đúng chỗ là ở server.
  const brief = briefOf(readMeta(projectId));
  if (!brief.autoIllustrations) {
    throw new HttpError(
      409,
      "ILLUSTRATIONS_DISABLED",
      `Project "${projectId}" đang TẮT "Ảnh minh họa AI" - không sinh ảnh cho video này. ` +
        "Dựng hình bằng scene HyperFrames và asset có sẵn; muốn dùng ảnh AI thì bật công tắc " +
        "đó trong Kịch bản edit rồi chạy lại.",
    );
  }
  if (!prompt) {
    throw new HttpError(400, "PROMPT_REQUIRED", "Thiếu prompt mô tả nội dung ảnh minh họa");
  }
  const aspect = ASPECTS.includes(body.aspect as ImageAspect)
    ? (body.aspect as ImageAspect)
    : "9:16";
  const model = typeof body.model === "string" && body.model ? body.model : undefined;
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if ("styleId" in body && body.styleId !== null && typeof body.styleId !== "string") {
    throw new HttpError(400, "INVALID_STYLE_ID", "styleId phải là string hoặc null");
  }
  const styleId = typeof body.styleId === "string" ? body.styleId.trim() : "";
  if (styleId && !styleExists(styleId)) {
    throw new HttpError(404, "STYLE_NOT_FOUND", `Không tìm thấy style "${styleId}"`);
  }
  if ("allowText" in body && typeof body.allowText !== "boolean") {
    throw new HttpError(400, "INVALID_ALLOW_TEXT", "allowText phải là boolean");
  }
  if (
    "position" in body &&
    !IMAGE_TEXT_POSITIONS.includes(body.position as ImageTextPosition)
  ) {
    throw new HttpError(
      400,
      "INVALID_POSITION",
      `position phải là một trong: ${IMAGE_TEXT_POSITIONS.join(" | ")}`,
    );
  }

  // Tên file: từ name (kebab) hoặc từ prompt, dedupe
  const base =
    toKebabAscii(typeof body.name === "string" ? body.name : prompt.slice(0, 40)) || "minh-hoa";
  const dir = path.join(paths.videoProjectsDir, projectId, "assets", "illustrations");
  ensureDir(dir);
  // Giữ chỗ tên file NGAY (mở "wx" là nguyên tử): file thật chỉ xuất hiện sau
  // khi Gemini vẽ xong, nên chỉ kiểm existsSync thì hai lời gọi song song cùng
  // tên sẽ cùng nhận x.png và ảnh sau đè ảnh trước
  let fileName = "";
  for (let n = 1; ; n++) {
    fileName = n === 1 ? `${base}.png` : `${base}-${n}.png`;
    try {
      fs.closeSync(fs.openSync(path.join(dir, fileName), "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  const outFile = path.join(dir, fileName);

  // Cưỡng chế Style Design: body.styleId → brief.styleId của project → default
  const design = getStyle(styleId || brief.styleId || null);
  // Cho phép chữ trong ảnh: body.allowText → brief.illustrationText của project (mặc định false)
  const allowText = typeof body.allowText === "boolean" ? body.allowText : brief.illustrationText;
  // Phong cách dựng lấy từ brief của project, KHÔNG cho body ghi đè: cả video
  // phải cùng một ngôn ngữ thị giác, mà agent gọi endpoint này hàng chục lần -
  // chỉ cần một lần nó truyền khác là video có một tấm lạc phong cách.
  const videoStyle = getVideoStyle(activeVideoStyleId(brief));
  let promptUsed: string;
  try {
    ({ promptUsed } = await generateBackground({
      prompt,
      kind: "concept",
      aspect,
      design,
      outFile,
      usageProjectId: projectId,
      model,
      allowText,
      videoStyle,
      // Ảnh cho VIDEO: chủ thể giữa khung, chừa band trên (key chính) + band dưới
      // (caption/key liên quan) - dùng bảng Poster là chủ thể bị thẻ key che mất
      layout: "video",
      // Vị trí chủ thể: body.position (agent cần bố cục riêng cho một ảnh)
      // → brief.illustrationPosition (người dùng chọn trên UI) → "auto" (giữa khung)
      subjectPosition:
        (body.position as ImageTextPosition | undefined) ??
        brief.illustrationPosition ??
        "auto",
    }));
  } catch (err) {
    // Vẽ hỏng thì trả lại chỗ đã giữ, không để file rỗng 0 byte trong assets
    fs.rmSync(outFile, { force: true });
    throw err;
  }

  // Ghi mô tả vào assets.json để cả UI lẫn các phiên AI sau đều biết ảnh này là gì
  if (description) {
    writeAssetEntry(projectId, fileName, { description });
  }

  res.status(201).json({
    file: fileName,
    relPath: `video-projects/${projectId}/assets/illustrations/${fileName}`,
    promptUsed,
  });
});

export default router;
