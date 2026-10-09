import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { isAgentRunning, runAgent } from "../agent.js";
import {
  prepareEditSession,
  scaffoldProjectFiles,
  uniqueProjectId,
} from "../childProject.js";
import {
  GRADE_PRESETS,
  generateGradePreviews,
  isDefaultAdjust,
  normAdjust,
  renderGradeFrame,
} from "../color.js";
import { paths, repoRoot } from "../config.js";
import * as db from "../db.js";
import {
  applyBriefPatch,
  briefOf,
  defaultBrief,
  listProjectAssets,
  normOutput,
  normTags,
  projectAssetsDirOf,
  projectDirOf,
  projectExists,
  projectSummaryOf,
  readMeta,
  removeAssetEntry,
  scanProjects,
  writeAssetEntry,
  writeMeta,
  type Brief,
  type ProjectMeta,
} from "../meta.js";
import { parseModelEffort } from "./providers.js";
import { styleExists } from "../styles.js";
import {
  HttpError,
  ensureDir,
  isKebabCase,
  listFilesRecursive,
  nowIso,
  toKebabAscii,
} from "../util.js";

const router = Router();

// GET /api/projects - quét video-projects/*/meta.json + tổng token AI đã dùng mỗi project
router.get("/", (_req, res) => {
  const usage = db.tokensByProject();
  res.json(
    scanProjects().map((s) => ({
      ...s,
      tokensUsed: usage[s.id]?.tokens ?? 0,
      costUsd: usage[s.id]?.costUsd ?? 0,
    })),
  );
});

// POST /api/projects - scaffold project mới
router.post("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  let id = typeof body.id === "string" ? body.id.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const width = Number(body.width);
  const height = Number(body.height);
  const fps = Number(body.fps);
  const tags = normTags(body.tags);

  if (!name) throw new HttpError(400, "INVALID_NAME", "Thiếu name");
  if (!id) {
    // Không gửi id → tự sinh từ tên (bỏ dấu tiếng Việt, kebab-case), trùng thì thêm -2, -3…
    id = uniqueProjectId(name);
  }
  if (!isKebabCase(id)) {
    throw new HttpError(400, "INVALID_ID", "id phải là kebab-case (vd: tiktok-paper-gpt5)");
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new HttpError(400, "INVALID_SIZE", "width/height phải là số nguyên dương");
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new HttpError(400, "INVALID_FPS", "fps phải là số dương");
  }

  const dir = projectDirOf(id);
  if (fs.existsSync(dir)) {
    throw new HttpError(409, "PROJECT_EXISTS", `Project "${id}" đã tồn tại`);
  }

  // Scaffold: index.html tối thiểu + compositions/ + assets/ + renders/ + hyperframes.json + meta.json
  // (dùng chung với "cắt short"/"tái chế tỉ lệ" - xem childProject.ts)
  scaffoldProjectFiles(id, name, width, height);

  const meta: ProjectMeta = {
    id,
    name,
    width,
    height,
    fps,
    status: "draft",
    brief: defaultBrief(),
    scenes: [],
    audio: { voice: null, sfx: [] },
    output: null,
    tags,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeMeta(id, meta);

  res.status(201).json(projectSummaryOf(id));
});

// GET /api/projects/:id - meta.json đầy đủ + brief (merge default) + danh sách file
router.get("/:id", (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id); // ném 404 nếu không có
  const dir = projectDirOf(id);
  // Chuẩn hóa + enrich GIỐNG route danh sách (projectSummaryOf) - nếu không, status
  // AI ghi lệch (vd "completed") lọt qua detail và các check === "done" âm thầm sai
  const summary = projectSummaryOf(id);
  const usage = db.tokensByProject();
  res.json({
    ...meta,
    // AI có thể ghi meta lệch hợp đồng (vd output là object) - chuẩn hóa trước khi trả
    status: summary?.status ?? "draft",
    output: normOutput(meta.output),
    tags: normTags(meta.tags),
    tokensUsed: usage[id]?.tokens ?? 0,
    costUsd: usage[id]?.costUsd ?? 0,
    brief: briefOf(meta),
    // Thumbnail đã tạo (POST /api/projects/:id/thumbnail) - null = chưa có
    thumbnail: fs.existsSync(path.join(dir, "thumbnail.png")) ? "thumbnail.png" : null,
    files: {
      renders: listFilesRecursive(path.join(dir, "renders")),
      assets: listProjectAssets(id), // FileInfo + description? từ assets.json
    },
  });
});

// Các thư mục/file KHÔNG copy khi nhân bản (sản phẩm render cũ, cache)
const CLONE_SKIP = new Set([
  "renders",
  "cache",
  "verify",
  "node_modules",
  "props.resolved.json", // sản phẩm trung gian của lần assemble cũ
]);

function copyDirFiltered(src: string, dst: string): void {
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (CLONE_SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirFiltered(s, d);
    else fs.copyFileSync(s, d);
  }
}

// POST /api/projects/:id/clone - { name? } → nhân bản project thành sản phẩm mới (201)
router.post("/:id/clone", (req, res) => {
  const srcId = req.params.id;
  const srcMeta = readMeta(srcId); // ném 404 nếu không có
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : `${srcMeta.name} (bản sao)`;

  // Sinh id mới từ tên, dedupe
  const newId = uniqueProjectId(toKebabAscii(name) || `${srcId}-copy`);

  // Copy toàn bộ trừ renders/cache/verify - giữ compositions, assets (kèm mô tả), hyperframes.json
  copyDirFiltered(projectDirOf(srcId), projectDirOf(newId));
  ensureDir(path.join(projectDirOf(newId), "renders"));

  // Meta mới: reset trạng thái sản xuất, giữ brief/tags/scenes/audio
  const meta: ProjectMeta = {
    ...srcMeta,
    id: newId,
    name,
    status: "draft",
    output: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  delete (meta as Record<string, unknown>).outputInfo;
  writeMeta(newId, meta);

  res.status(201).json(projectSummaryOf(newId));
});

// ---------------------------------------------------------------- File rác
// File trung gian sau khi xuất final - xóa được an toàn, KHÔNG đụng file nguồn
// (index.html, compositions/, assets/, meta.json, hyperframes.json, outputs/<id>-v*.mp4).

interface JunkItem {
  /** relPath từ repo root, dấu /; thư mục kết thúc bằng "/" */
  relPath: string;
  size: number;
}

function dirSizeOf(absDir: string): number {
  return listFilesRecursive(absDir).reduce((sum, f) => sum + f.size, 0);
}

function collectJunk(id: string): { items: JunkItem[]; totalBytes: number } {
  const dir = projectDirOf(id);
  const items: JunkItem[] = [];

  // Thư mục trung gian trong project: scene render, frame verify, cache preview màu
  for (const name of ["renders", "verify", "cache"]) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs) && listFilesRecursive(abs).length > 0) {
      items.push({ relPath: `video-projects/${id}/${name}/`, size: dirSizeOf(abs) });
    }
  }

  // props đã stage cho Remotion (sản phẩm của lần assemble)
  const propsFile = path.join(dir, "props.resolved.json");
  if (fs.existsSync(propsFile)) {
    items.push({
      relPath: `video-projects/${id}/props.resolved.json`,
      size: fs.statSync(propsFile).size,
    });
  }

  // Bản draft lắp ráp toàn bài (final <id>-v*.mp4 giữ nguyên)
  const draft = path.join(paths.outputsDir, `${id}-draft.mp4`);
  if (fs.existsSync(draft)) {
    items.push({ relPath: `outputs/${id}-draft.mp4`, size: fs.statSync(draft).size });
  }

  // Staging hardlink cho Remotion - vid-<id> (video project), img-<id> (image project trùng id)
  for (const prefix of ["vid", "img"]) {
    const abs = path.join(paths.stagingDir, `${prefix}-${id}`);
    if (fs.existsSync(abs)) {
      items.push({
        relPath: `engines/remotion/public/staging/${prefix}-${id}/`,
        size: dirSizeOf(abs),
      });
    }
  }

  return { items, totalBytes: items.reduce((sum, i) => sum + i.size, 0) };
}

// GET /api/projects/:id/junk - liệt kê file rác (file trung gian) + tổng dung lượng
router.get("/:id/junk", (req, res) => {
  const id = req.params.id;
  readMeta(id); // ném 404 nếu project không có
  res.json(collectJunk(id));
});

// POST /api/projects/:id/junk/clean - xóa file rác; job running/queued của project → 409
router.post("/:id/junk/clean", (req, res) => {
  const id = req.params.id;
  readMeta(id); // ném 404 nếu project không có
  if (db.hasActiveJobForProject(id)) {
    throw new HttpError(
      409,
      "JOB_RUNNING",
      "Project đang có job chạy/chờ trong hàng đợi - đợi xong rồi mới dọn file rác",
    );
  }
  const { items, totalBytes } = collectJunk(id);
  for (const item of items) {
    // relPath dạng repo-relative dấu / (thư mục có "/" cuối) - path.join tự chuẩn hóa
    fs.rmSync(path.join(repoRoot, item.relPath), { recursive: true, force: true });
  }
  // renders/ là thư mục scaffold chuẩn của project - tạo lại rỗng
  ensureDir(path.join(projectDirOf(id), "renders"));
  res.json({ freedBytes: totalBytes, deleted: items.length });
});

// PUT /api/projects/:id/tags - thay toàn bộ tags
router.put("/:id/tags", (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id); // ném 404 nếu không có
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(body.tags)) {
    throw new HttpError(400, "INVALID_TAGS", "tags phải là mảng string");
  }
  meta.tags = normTags(body.tags);
  writeMeta(id, meta);
  res.json({ tags: meta.tags });
});

/**
 * PUT /api/projects/:id/name - đổi TÊN HIỂN THỊ của project.
 *
 * CHỈ đổi `meta.name`, KHÔNG đụng tới `id`. Id là tên thư mục và bị tham chiếu
 * khắp nơi (đường dẫn asset, tên file trong outputs/, thư mục staging của
 * Remotion, cột projectId của job và phiên chat, project con của Auto cut) -
 * đổi id là một cuộc di trú chứ không phải một phép sửa tên, nên để riêng.
 */
router.put("/:id/name", (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id); // ném 404 nếu không có
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    throw new HttpError(400, "INVALID_NAME", "Tên project không được để trống");
  }
  if (name.length > 120) {
    throw new HttpError(400, "INVALID_NAME", "Tên project tối đa 120 ký tự");
  }
  meta.name = name;
  writeMeta(id, meta);
  res.json(projectSummaryOf(id));
});

// PUT /api/projects/:id/brief - partial Brief, validate từng field, merge vào meta.json
router.put("/:id/brief", (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id); // ném 404 nếu không có
  const body = (req.body ?? {}) as Record<string, unknown>;
  const brief: Brief = applyBriefPatch(briefOf(meta), body, styleExists);
  meta.brief = brief;
  writeMeta(id, meta);
  res.json(brief);
});

// PUT /api/projects/:id/assets/:file/description - ghi assets.json, trả FileInfo + description
router.put("/:id/assets/:file/description", (req, res) => {
  const id = req.params.id;
  readMeta(id); // ném 404 nếu project không có
  const file = path.basename(req.params.file); // chặn traversal
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.description !== "string") {
    throw new HttpError(400, "INVALID_DESCRIPTION", "description phải là string");
  }

  const found = listFilesRecursive(projectAssetsDirOf(id)).find(
    (f) => f.name === file && f.name !== "assets.json",
  );
  if (!found) {
    throw new HttpError(404, "ASSET_NOT_FOUND", `Không tìm thấy asset "${file}" trong project "${id}"`);
  }

  // writeAssetEntry merge từng field - KHÔNG rebuild cả file (giữ colorGrade/colorAdjust)
  writeAssetEntry(id, file, { description: body.description });
  res.json({ ...found, description: body.description });
});

// DELETE /api/projects/:id/assets/:file - xóa file asset (kể cả trong thư mục con) + entry assets.json
router.delete("/:id/assets/:file", (req, res) => {
  const id = req.params.id;
  readMeta(id); // ném 404 nếu project không có
  const file = path.basename(req.params.file); // chặn traversal
  if (file === "assets.json") {
    throw new HttpError(400, "PROTECTED_FILE", "Không thể xóa assets.json");
  }

  // File có thể nằm trong thư mục con (vd assets/audio/x.wav) - tìm bằng relPath thật
  const found = listFilesRecursive(projectAssetsDirOf(id)).find((f) => f.name === file);
  if (!found) {
    throw new HttpError(404, "ASSET_NOT_FOUND", `Không tìm thấy asset "${file}" trong project "${id}"`);
  }

  fs.rmSync(path.join(repoRoot, found.relPath), { force: true });
  removeAssetEntry(id, file); // dọn description/colorGrade/colorAdjust đi kèm
  res.status(204).end();
});

// POST /api/projects/:id/assets/:file/grade-preview - sinh ảnh preview các preset màu
router.post("/:id/assets/:file/grade-preview", async (req, res) => {
  const id = req.params.id;
  readMeta(id); // 404 nếu project không có
  const file = path.basename(req.params.file);
  const found = listFilesRecursive(projectAssetsDirOf(id)).find(
    (f) => f.name === file && f.kind === "video",
  );
  if (!found) {
    throw new HttpError(404, "ASSET_NOT_FOUND", `Không tìm thấy asset video "${file}"`);
  }
  const result = await generateGradePreviews(
    projectDirOf(id),
    `video-projects/${id}`,
    path.join(repoRoot, found.relPath),
    file,
  );
  if (result.previews.length === 0) {
    throw new HttpError(500, "PREVIEW_FAILED", "Không sinh được preview - kiểm tra ffmpeg");
  }
  res.json(result);
});

// POST /api/projects/:id/assets/:file/grade-frame - render 1 frame theo preset + chỉnh tay
router.post("/:id/assets/:file/grade-frame", async (req, res) => {
  const id = req.params.id;
  readMeta(id);
  const file = path.basename(req.params.file);
  const found = listFilesRecursive(projectAssetsDirOf(id)).find(
    (f) => f.name === file && f.kind === "video",
  );
  if (!found) {
    throw new HttpError(404, "ASSET_NOT_FOUND", `Không tìm thấy asset video "${file}"`);
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const preset = typeof body.preset === "string" ? body.preset : null;
  if (preset && !GRADE_PRESETS.some((p) => p.id === preset)) {
    throw new HttpError(400, "INVALID_PRESET", "preset không hợp lệ");
  }
  const adjust = normAdjust(body.adjust);
  const result = await renderGradeFrame(
    projectDirOf(id),
    `video-projects/${id}`,
    path.join(repoRoot, found.relPath),
    file,
    preset,
    adjust,
  );
  res.json(result);
});

// PUT /api/projects/:id/assets/:file/grade - { preset: string|null, adjust? } lưu lựa chọn đã duyệt
router.put("/:id/assets/:file/grade", (req, res) => {
  const id = req.params.id;
  readMeta(id);
  const file = path.basename(req.params.file);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const preset = body.preset;
  if (preset !== null && typeof preset !== "string") {
    throw new HttpError(400, "INVALID_PRESET", "preset phải là string hoặc null");
  }
  if (typeof preset === "string" && !GRADE_PRESETS.some((p) => p.id === preset)) {
    throw new HttpError(
      400,
      "INVALID_PRESET",
      `preset phải là một trong: ${GRADE_PRESETS.map((p) => p.id).join(", ")}`,
    );
  }
  const adjust = normAdjust(body.adjust);
  // Chỉ lưu adjust khi khác mặc định - entry gọn, prompt AI không thừa thãi
  writeAssetEntry(id, file, {
    colorGrade: preset,
    colorAdjust: isDefaultAdjust(adjust) ? null : (adjust as unknown as Record<string, number>),
  });
  res.json({ file, colorGrade: preset, colorAdjust: isDefaultAdjust(adjust) ? null : adjust });
});

// POST /api/projects/:id/edit - { extraNotes?, model?, effort? } → 202 { sessionId }, agent chạy nền
router.post("/:id/edit", (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id); // ném 404 nếu không có
  const body = (req.body ?? {}) as Record<string, unknown>;
  if ("extraNotes" in body && typeof body.extraNotes !== "string") {
    throw new HttpError(400, "INVALID_EXTRA_NOTES", "extraNotes phải là string");
  }
  const extraNotes = typeof body.extraNotes === "string" ? body.extraNotes.trim() : "";
  const { model, effort } = parseModelEffort(body); // 400 nếu không hợp lệ

  // Bấm "Edit bằng AI" hai lần = hai agent cùng sửa + render một project. Chặn
  // như review/send đã chặn.
  if (db.listChatSessions(id).some((s) => isAgentRunning(s.sessionId))) {
    throw new HttpError(
      409,
      "SESSION_BUSY",
      "Phiên AI của project đang chạy - đợi xong (hoặc dừng nó) rồi mới mở phiên mới",
    );
  }

  // Soạn prompt (brief + assets + sfx/nhạc + Style Design) và mở phiên goal='final'
  // - dùng chung với "cắt short"/"tái chế tỉ lệ" (xem childProject.ts)
  const { sessionId, prompt } = prepareEditSession({ id, meta, extraNotes, model, effort });

  // Trả 202 NGAY, agent chạy nền - cùng pipeline với /api/chat (SSE kênh `agent`,
  // message đầu session được agent.ts tự prepend CLAUDE.md)
  res.status(202).json({ sessionId });
  void runAgent(sessionId, prompt);
});

// DELETE /api/projects/:id?force=true
router.delete("/:id", (req, res) => {
  const id = req.params.id;
  if (!isKebabCase(id)) {
    throw new HttpError(400, "INVALID_ID", `Project id không hợp lệ: ${id}`);
  }
  if (req.query.force !== "true") {
    throw new HttpError(400, "FORCE_REQUIRED", "Xóa project cần ?force=true");
  }
  if (!projectExists(id) && !fs.existsSync(projectDirOf(id))) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `Không tìm thấy project "${id}"`);
  }
  // Job đang chạy/chờ vẫn đọc-ghi file trong project - xóa lúc này là rút thảm dưới chân job
  if (db.hasActiveJobForProject(id)) {
    throw new HttpError(
      409,
      "JOB_RUNNING",
      "Project đang có job chạy/chờ trong hàng đợi - đợi xong hoặc hủy job rồi mới xóa",
    );
  }
  fs.rmSync(projectDirOf(id), { recursive: true, force: true });
  res.status(204).end();
});

// Scaffold index.html + hyperframes.json đã chuyển sang childProject.ts
// (scaffoldProjectFiles) để dùng chung với "cắt short" và "tái chế tỉ lệ khung"
// - nội dung file sinh ra KHÔNG đổi.

export default router;
