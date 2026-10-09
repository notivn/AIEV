import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { paths } from "../config.js";
import {
  COLOR_KEYS,
  HEX_RE,
  defaultStyle,
  normStyleTags,
  readStyles,
  writeStyles,
  type StyleDesign,
  type StylesFile,
} from "../styles.js";
import { HttpError, ensureDir, moveFile, nowIso, sanitizeFileName, toKebabAscii } from "../util.js";

/**
 * Style Design - CRUD nhiều bộ nhận diện + default + upload logo/font từng style.
 * File lưu assets/styles/files/ (serve qua /media/assets/...). Xem docs/API.md mục "Style Design".
 */

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir(paths.uploadTmpDir);
      cb(null, paths.uploadTmpDir);
    },
    filename: (_req, _file, cb) => cb(null, `up-${Date.now()}-${Math.round(Math.random() * 1e9)}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const LOGO_EXTS = new Set([".png", ".jpg", ".jpeg", ".svg", ".webp"]);
const FONT_EXTS = new Set([".ttf", ".otf", ".woff", ".woff2"]);

function findStyle(data: StylesFile, id: string): StyleDesign {
  const style = data.styles.find((s) => s.id === id);
  if (!style) {
    throw new HttpError(404, "STYLE_NOT_FOUND", `Không tìm thấy style "${id}"`);
  }
  return style;
}

/** Lưu file upload vào assets/styles/files/ (dedupe tên) → đường dẫn rel từ repo root */
function saveStyleFile(tmpPath: string, originalName: string): string {
  const safeName = sanitizeFileName(originalName);
  const ext = path.extname(safeName).toLowerCase();
  const base = path.basename(safeName, ext);
  ensureDir(paths.stylesFilesDir);
  let finalName = safeName;
  for (let n = 2; fs.existsSync(path.join(paths.stylesFilesDir, finalName)); n++) {
    finalName = `${base}-${n}${ext}`;
  }
  moveFile(tmpPath, path.join(paths.stylesFilesDir, finalName));
  return `assets/styles/files/${finalName}`;
}

/** Xóa file tmp của multer khi handler ném lỗi */
function cleanupUpload(uploaded: Express.Multer.File | undefined): void {
  if (uploaded?.path && fs.existsSync(uploaded.path)) {
    try {
      fs.unlinkSync(uploaded.path);
    } catch {
      /* ignore */
    }
  }
}

const router = Router();

// GET /api/styles → { defaultId, styles } (migration từ design-system.json ở lần đọc đầu)
router.get("/", (_req, res) => {
  res.json(readStyles());
});

// POST /api/styles - { name, tags?, cloneFrom? } → 201 StyleDesign
router.post("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new HttpError(400, "INVALID_NAME", "Thiếu name");
  if ("tags" in body && (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== "string"))) {
    throw new HttpError(400, "INVALID_TAGS", "tags phải là mảng string");
  }
  if ("cloneFrom" in body && typeof body.cloneFrom !== "string") {
    throw new HttpError(400, "INVALID_CLONE_FROM", "cloneFrom phải là id style (string)");
  }

  const data = readStyles();
  // Template: clone toàn bộ từ style nguồn, hoặc palette mặc định noti.vn cho style mới
  const source =
    typeof body.cloneFrom === "string" ? findStyle(data, body.cloneFrom) : defaultStyle();

  const base = toKebabAscii(name) || "style";
  let id = base;
  for (let n = 2; data.styles.some((s) => s.id === id); n++) id = `${base}-${n}`;

  const now = nowIso();
  const style: StyleDesign = {
    ...source,
    colors: { ...source.colors },
    fonts: { ...source.fonts },
    fontFiles: { ...source.fontFiles },
    id,
    name,
    tags: "tags" in body ? normStyleTags(body.tags) : typeof body.cloneFrom === "string" ? [...source.tags] : [],
    createdAt: now,
    updatedAt: now,
  };
  data.styles.push(style);
  if (!data.defaultId) data.defaultId = style.id; // style đầu tiên tự thành default
  writeStyles(data);
  res.status(201).json(style);
});

// PUT /api/styles/:id - partial (name/tags/colors/fonts/logoPath/tone/guidelines) → StyleDesign
router.put("/:id", (req, res) => {
  const data = readStyles();
  const style = findStyle(data, req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new HttpError(400, "INVALID_NAME", "name phải là string không rỗng");
    }
    style.name = body.name.trim();
  }
  if ("tags" in body) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== "string")) {
      throw new HttpError(400, "INVALID_TAGS", "tags phải là mảng string");
    }
    style.tags = normStyleTags(body.tags);
  }
  if ("colors" in body) {
    if (!body.colors || typeof body.colors !== "object" || Array.isArray(body.colors)) {
      throw new HttpError(400, "INVALID_COLORS", "colors phải là object");
    }
    const c = body.colors as Record<string, unknown>;
    for (const key of COLOR_KEYS) {
      if (!(key in c)) continue;
      if (typeof c[key] !== "string" || !HEX_RE.test(c[key] as string)) {
        throw new HttpError(400, "INVALID_COLOR", `colors.${key} phải là mã màu hex (vd "#ed3c47")`);
      }
      style.colors[key] = (c[key] as string).toLowerCase();
    }
  }
  if ("fonts" in body) {
    if (!body.fonts || typeof body.fonts !== "object" || Array.isArray(body.fonts)) {
      throw new HttpError(400, "INVALID_FONTS", "fonts phải là object");
    }
    const f = body.fonts as Record<string, unknown>;
    for (const key of ["heading", "body"] as const) {
      if (!(key in f)) continue;
      if (typeof f[key] !== "string" || !(f[key] as string).trim()) {
        throw new HttpError(400, "INVALID_FONT", `fonts.${key} phải là string không rỗng`);
      }
      style.fonts[key] = (f[key] as string).trim();
    }
  }
  if ("logoPath" in body) {
    if (body.logoPath !== null && typeof body.logoPath !== "string") {
      throw new HttpError(400, "INVALID_LOGO_PATH", "logoPath phải là string hoặc null");
    }
    style.logoPath = typeof body.logoPath === "string" && body.logoPath ? body.logoPath : null;
  }
  if ("tone" in body) {
    if (typeof body.tone !== "string") {
      throw new HttpError(400, "INVALID_TONE", "tone phải là string");
    }
    style.tone = body.tone;
  }
  if ("guidelines" in body) {
    if (typeof body.guidelines !== "string") {
      throw new HttpError(400, "INVALID_GUIDELINES", "guidelines phải là string");
    }
    style.guidelines = body.guidelines;
  }
  if ("effects" in body) {
    if (!body.effects || typeof body.effects !== "object" || Array.isArray(body.effects)) {
      throw new HttpError(400, "INVALID_EFFECTS", "effects phải là object");
    }
    const e = body.effects as Record<string, unknown>;
    if ("gradient" in e) {
      if (typeof e.gradient !== "boolean") {
        throw new HttpError(400, "INVALID_EFFECTS", "effects.gradient phải là boolean");
      }
      style.effects.gradient = e.gradient;
    }
    if ("liquidGlass" in e) {
      if (typeof e.liquidGlass !== "boolean") {
        throw new HttpError(400, "INVALID_EFFECTS", "effects.liquidGlass phải là boolean");
      }
      style.effects.liquidGlass = e.liquidGlass;
    }
  }

  style.updatedAt = nowIso();
  writeStyles(data);
  res.json(style);
});

// DELETE /api/styles/:id → 204 (cấm xóa style cuối; xóa default → chuyển default sang style còn lại)
router.delete("/:id", (req, res) => {
  const data = readStyles();
  findStyle(data, req.params.id); // 404 nếu không có
  if (data.styles.length <= 1) {
    throw new HttpError(400, "LAST_STYLE", "Không thể xóa style cuối cùng - phải còn ít nhất một style");
  }
  data.styles = data.styles.filter((s) => s.id !== req.params.id);
  if (data.defaultId === req.params.id) data.defaultId = data.styles[0].id;
  writeStyles(data);
  res.status(204).end();
});

// POST /api/styles/:id/default → { defaultId }
router.post("/:id/default", (req, res) => {
  const data = readStyles();
  const style = findStyle(data, req.params.id);
  data.defaultId = style.id;
  writeStyles(data);
  res.json({ defaultId: data.defaultId });
});

// POST /api/styles/:id/logo - multipart file → StyleDesign (file lưu assets/styles/files/)
router.post("/:id/logo", upload.single("file"), (req, res) => {
  const uploaded = req.file;
  try {
    const data = readStyles();
    const style = findStyle(data, String(req.params.id));
    if (!uploaded) throw new HttpError(400, "FILE_REQUIRED", "Thiếu file (field `file`)");

    const ext = path.extname(sanitizeFileName(uploaded.originalname)).toLowerCase();
    if (!LOGO_EXTS.has(ext)) {
      throw new HttpError(400, "INVALID_LOGO", `Logo phải là ảnh (${[...LOGO_EXTS].join(", ")})`);
    }
    style.logoPath = saveStyleFile(uploaded.path, uploaded.originalname);
    style.updatedAt = nowIso();
    writeStyles(data);
    res.json(style);
  } catch (err) {
    cleanupUpload(uploaded);
    throw err;
  }
});

// POST /api/styles/:id/font?slot=heading|body - multipart file (.ttf/.otf/.woff/.woff2) → StyleDesign
router.post("/:id/font", upload.single("file"), (req, res) => {
  const uploaded = req.file;
  try {
    const data = readStyles();
    const style = findStyle(data, String(req.params.id));
    if (!uploaded) throw new HttpError(400, "FILE_REQUIRED", "Thiếu file (field `file`)");

    const slot = String(req.query.slot ?? req.body?.slot ?? "");
    if (slot !== "heading" && slot !== "body") {
      throw new HttpError(400, "INVALID_SLOT", "slot phải là heading hoặc body");
    }
    const ext = path.extname(sanitizeFileName(uploaded.originalname)).toLowerCase();
    if (!FONT_EXTS.has(ext)) {
      throw new HttpError(400, "INVALID_FONT", `Font phải là ${[...FONT_EXTS].join(", ")}`);
    }
    style.fontFiles[slot] = saveStyleFile(uploaded.path, uploaded.originalname);
    style.updatedAt = nowIso();
    writeStyles(data);
    res.json(style);
  } catch (err) {
    cleanupUpload(uploaded);
    throw err;
  }
});

// DELETE /api/styles/:id/font/:slot - gỡ font (file giữ lại trong assets/styles/files) → StyleDesign
router.delete("/:id/font/:slot", (req, res) => {
  const slot = req.params.slot;
  if (slot !== "heading" && slot !== "body") {
    throw new HttpError(400, "INVALID_SLOT", "slot phải là heading hoặc body");
  }
  const data = readStyles();
  const style = findStyle(data, req.params.id);
  style.fontFiles[slot] = null;
  style.updatedAt = nowIso();
  writeStyles(data);
  res.json(style);
});

/**
 * POST /api/styles/:id/font-google - { slot: "heading"|"body", family: string }
 * Tự tải font từ Google Fonts theo TÊN (user chỉ cần gõ tên, không phải upload):
 * dùng User-Agent cũ để css2 trả về MỘT file TTF trọn bộ (đủ glyph tiếng Việt),
 * tải về assets/styles/files/, set fontFiles[slot] + fonts[slot] = family.
 */
router.post("/:id/font-google", async (req, res) => {
  findStyle(readStyles(), req.params.id); // 404 sớm, trước khi gọi mạng
  const body = (req.body ?? {}) as Record<string, unknown>;
  const slot = body.slot;
  const family = typeof body.family === "string" ? body.family.trim() : "";
  if (slot !== "heading" && slot !== "body") {
    throw new HttpError(400, "INVALID_SLOT", "slot phải là heading hoặc body");
  }
  if (!family || family.length > 60 || !/^[a-zA-Z0-9 +-]+$/.test(family)) {
    throw new HttpError(400, "INVALID_FAMILY", "Tên font không hợp lệ (vd: Be Vietnam Pro)");
  }

  const weight = slot === "heading" ? 700 : 400;
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&display=swap`;
  let cssRes: Response;
  try {
    // UA cũ → Google trả TTF một file trọn bộ glyph (không chia subset) - cần cho tiếng Việt
    cssRes = await fetch(cssUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 6.1)" } });
  } catch (err) {
    throw new HttpError(
      502,
      "GOOGLE_FONTS_ERROR",
      `Không kết nối được Google Fonts: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!cssRes.ok) {
    throw new HttpError(
      404,
      "FONT_NOT_FOUND",
      `Google Fonts không có font "${family}" (kiểm tra chính tả - vd: Be Vietnam Pro, Montserrat, Roboto)`,
    );
  }
  const css = await cssRes.text();
  const m = css.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+\.ttf)\)/);
  if (!m) {
    throw new HttpError(502, "GOOGLE_FONTS_ERROR", "Không tìm thấy file font trong phản hồi Google Fonts");
  }
  let fontRes: Response;
  try {
    fontRes = await fetch(m[1]);
  } catch (err) {
    throw new HttpError(
      502,
      "GOOGLE_FONTS_ERROR",
      `Không tải được file font: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!fontRes.ok) {
    throw new HttpError(502, "GOOGLE_FONTS_ERROR", `Tải file font thất bại (HTTP ${fontRes.status})`);
  }
  const buf = Buffer.from(await fontRes.arrayBuffer());

  ensureDir(paths.stylesFilesDir);
  const fileName = `${toKebabAscii(family)}-${weight}.ttf`;
  fs.writeFileSync(path.join(paths.stylesFilesDir, fileName), buf);

  // Đọc lại SAU khi tải: hai lần fetch có thể mất vài giây, ghi bản đọc từ đầu
  // là xóa mất mọi chỉnh sửa style (màu, font slot kia...) trong lúc chờ
  const data = readStyles();
  const style = findStyle(data, req.params.id);
  style.fonts[slot] = family;
  style.fontFiles[slot] = `assets/styles/files/${fileName}`;
  style.updatedAt = nowIso();
  writeStyles(data);
  res.json(style);
});

export default router;
