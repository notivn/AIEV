import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { paths } from "../config.js";
import {
  HttpError,
  ensureDir,
  ffprobeDurationMs,
  fileKind,
  moveFile,
  sanitizeFileName,
} from "../util.js";

const router = Router();

export interface SfxEntry {
  file: string;
  tags: string[];
  durationMs: number | null;
  description: string;
  /**
   * URL nơi lấy file. Không bắt buộc, nhưng thiếu nó thì file coi như không rõ
   * nguồn gốc - và file không rõ nguồn gốc là file không được phát tán lại.
   * Repo từng kèm 104 file không ghi nguồn và phải gỡ sạch khi mở mã nguồn;
   * hai field này có mặt để chuyện đó không lặp lại. Xem README của thư mục.
   */
  source?: string;
  /** Mã giấy phép: "CC0-1.0", "CC-BY-4.0", "Pixabay", "mua-license", "tu-thu-am"… */
  license?: string;
}

/** Chuỗi không rỗng thì giữ, còn lại bỏ hẳn field (đừng ghi "" vào file). */
function optionalText(v: unknown, max = 500): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** Tag quy ước "đề xuất" - AI ưu tiên dùng khi brief đặt sfxMode "recommended" */
export const RECOMMENDED_TAG = "hay-dung";

const libraryPath = () => path.join(paths.sfxDir, "library.json");

export function readLibrary(): SfxEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(libraryPath(), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => {
        const source = optionalText(e.source);
        const license = optionalText(e.license, 60);
        return {
          file: typeof e.file === "string" ? e.file : "",
          tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
          durationMs: typeof e.durationMs === "number" ? e.durationMs : null,
          description: typeof e.description === "string" ? e.description : "",
          // Phải mang qua ở ĐÂY: readLibrary là đường duy nhất để đọc, và
          // writeLibrary ghi đè bằng đúng thứ nó trả về. Quên một field ở đây
          // là mỗi lần sửa mô tả trên UI lại xóa mất nguồn của file, không báo
          // gì cả - đúng kiểu hỏng im lặng khó thấy nhất.
          ...(source ? { source } : {}),
          ...(license ? { license } : {}),
        };
      })
      .filter((e) => e.file);
  } catch {
    return []; // chưa có library.json → coi như rỗng
  }
}

function writeLibrary(entries: SfxEntry[]): void {
  ensureDir(paths.sfxDir);
  fs.writeFileSync(libraryPath(), JSON.stringify(entries, null, 2) + "\n", "utf8");
}

// multer ghi vào thư mục tạm cùng ổ đĩa rồi move về đích
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir(paths.uploadTmpDir);
      cb(null, paths.uploadTmpDir);
    },
    filename: (_req, _file, cb) => cb(null, `up-${Date.now()}-${Math.round(Math.random() * 1e9)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// GET /api/sfx - chỉ trả entry có file tồn tại trên đĩa
router.get("/", (_req, res) => {
  const entries = readLibrary().filter((e) => fs.existsSync(path.join(paths.sfxDir, e.file)));
  res.json(entries);
});

// POST /api/sfx - multipart: file (audio) + tags (csv) + description
router.post("/", upload.single("file"), async (req, res) => {
  const uploaded = req.file;
  if (!uploaded) throw new HttpError(400, "FILE_REQUIRED", "Thiếu file audio (field `file`)");

  try {
    const safeName = sanitizeFileName(uploaded.originalname);
    if (fileKind(safeName) !== "audio") {
      throw new HttpError(400, "INVALID_AUDIO", "File phải là audio (mp3/wav/ogg/m4a/aac/flac)");
    }

    // Tránh ghi đè: thêm hậu tố -2, -3... nếu trùng tên
    ensureDir(paths.sfxDir);
    let finalName = safeName;
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    for (let n = 2; fs.existsSync(path.join(paths.sfxDir, finalName)); n++) {
      finalName = `${base}-${n}${ext}`;
    }

    const destAbs = path.join(paths.sfxDir, finalName);
    moveFile(uploaded.path, destAbs);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const tags =
      typeof body.tags === "string"
        ? body.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
    const description = typeof body.description === "string" ? body.description : "";
    const durationMs = await ffprobeDurationMs(destAbs); // null nếu ffprobe fail

    const source = optionalText(body.source);
    const license = optionalText(body.license, 60);
    const entry: SfxEntry = {
      file: finalName,
      tags,
      durationMs,
      description,
      ...(source ? { source } : {}),
      ...(license ? { license } : {}),
    };
    const entries = readLibrary().filter((e) => e.file !== finalName);
    entries.push(entry);
    writeLibrary(entries);

    res.status(201).json(entry);
  } catch (err) {
    // Dọn file tạm nếu xử lý thất bại
    if (uploaded?.path && fs.existsSync(uploaded.path)) {
      try {
        fs.unlinkSync(uploaded.path);
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
});

// PATCH /api/sfx/:file - { description?, tags?, recommended?, source?, license? } → SfxEntry sau cập nhật
router.patch("/:file", (req, res) => {
  const file = path.basename(req.params.file); // chặn traversal
  const entries = readLibrary();
  const entry = entries.find((e) => e.file === file);
  if (!entry) throw new HttpError(404, "SFX_NOT_FOUND", `Không tìm thấy sound effect "${file}"`);

  const body = (req.body ?? {}) as Record<string, unknown>;

  if ("description" in body) {
    if (typeof body.description !== "string") {
      throw new HttpError(400, "INVALID_DESCRIPTION", "description phải là string");
    }
    entry.description = body.description.trim().slice(0, 2000);
  }

  if ("tags" in body) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== "string")) {
      throw new HttpError(400, "INVALID_TAGS", "tags phải là mảng string");
    }
    // Thay toàn bộ tags
    entry.tags = (body.tags as string[]).map((t) => t.trim()).filter(Boolean);
  }

  if ("recommended" in body) {
    if (typeof body.recommended !== "boolean") {
      throw new HttpError(400, "INVALID_RECOMMENDED", "recommended phải là boolean");
    }
    if (body.recommended) {
      if (!entry.tags.includes(RECOMMENDED_TAG)) entry.tags.push(RECOMMENDED_TAG);
    } else {
      entry.tags = entry.tags.filter((t) => t !== RECOMMENDED_TAG);
    }
  }

  // Chuỗi rỗng = xóa field, chứ không phải ghi "" - để file JSON sạch và để
  // "chưa ghi nguồn" phân biệt được với "đã ghi rồi xóa đi".
  for (const key of ["source", "license"] as const) {
    if (!(key in body)) continue;
    if (typeof body[key] !== "string") {
      throw new HttpError(400, "INVALID_SETTING", `${key} phải là string`);
    }
    const v = optionalText(body[key], key === "license" ? 60 : 500);
    if (v) entry[key] = v;
    else delete entry[key];
  }

  entry.tags = [...new Set(entry.tags)]; // không trùng lặp
  writeLibrary(entries);
  res.json(entry);
});

// DELETE /api/sfx/:file
router.delete("/:file", (req, res) => {
  const file = path.basename(req.params.file); // chặn traversal
  const abs = path.join(paths.sfxDir, file);
  const entries = readLibrary();
  const exists = entries.some((e) => e.file === file) || fs.existsSync(abs);
  if (!exists) throw new HttpError(404, "SFX_NOT_FOUND", `Không tìm thấy sound effect "${file}"`);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
  writeLibrary(entries.filter((e) => e.file !== file));
  res.status(204).end();
});

export default router;
