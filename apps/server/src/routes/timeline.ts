import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { nanoid } from "nanoid";
import { isAgentBusy, runAgent } from "../agent.js";
import { briefPromptContextOf, syncBrandLogo } from "../childProject.js";
import { paths, repoRoot } from "../config.js";
import * as db from "../db.js";
import { EDITOR_CONTEXT_MARKER, buildEditorChatPrompt } from "../editPrompt.js";
import { assertVideoJobAllowed, enqueueJob } from "../jobRules.js";
import {
  briefOf,
  projectAssetsDirOf,
  projectDirOf,
  projectSummaryOf,
  readMeta,
  type ProjectMeta,
} from "../meta.js";
import { getStyle } from "../styles.js";
import {
  TIMELINE_KEYS,
  buildFcp7Xml,
  isValidRev,
  listRevisions,
  isRenderStale,
  mediaInfoMap,
  mediaVersionsOf,
  probeMediaInfo,
  readRevision,
  referencedMediaPaths,
  resolveProjectPath,
  sceneRenderState,
  sceneRendersOf,
  snapshotTimeline,
  timelineForClient,
  timelineVersion,
  validateTimelineForRender,
  validateTimelinePatch,
  writeTimelineKeys,
  type TimelineKey,
} from "../timeline.js";
import { parseModelEffort } from "./providers.js";
import { readMusicLibrary } from "./music.js";
import { readLibrary } from "./sfx.js";
import { HttpError, ensureDir, fileKind } from "../util.js";

/**
 * Trình chỉnh sửa video trong dashboard - luồng A của docs/EDITOR-PLAN.md.
 * Mount dưới /api/projects (đường dẫn con riêng, không đụng projectsRouter);
 * `libraryRouter` mount riêng ở /api/library.
 *
 * meta.json vẫn là nguồn sự thật DUY NHẤT của timeline - không có file timeline
 * song song. Logic thuần (version, validate, lịch sử, FCP7 XML) ở ../timeline.ts.
 */
const router = Router();
export const libraryRouter = Router();

const MAX_LABEL_LEN = 120;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

// ------------------------------------------------------------------ Helper

/**
 * Phiên AI của project đang chạy HOẶC đang chờ tự chạy lại (auto-resume) -
 * cả hai đều sẽ còn ghi meta.json, nên editor ghi lúc này là giẫm chân nhau.
 */
function busySessionOf(id: string): string | null {
  return db.listChatSessions(id).find((s) => isAgentBusy(s.sessionId))?.sessionId ?? null;
}

function assertNotAgentBusy(id: string): void {
  const busy = busySessionOf(id);
  if (busy) {
    throw new HttpError(
      409,
      "AGENT_BUSY",
      "AI đang sửa project này - trình chỉnh sửa chỉ đọc cho tới khi phiên AI xong (hoặc bị dừng).",
      { sessionId: busy },
    );
  }
}

/** So baseVersion với bản trên đĩa - lệch thì 409 kèm bản hiện tại để UI hiện "Tải bản mới" */
function assertBaseVersion(meta: ProjectMeta, baseVersion: string): void {
  const version = timelineVersion(meta);
  if (baseVersion !== version) {
    throw new HttpError(
      409,
      "VERSION_CONFLICT",
      "Timeline đã bị thay đổi ở nơi khác (AI hoặc tab khác) kể từ lần tải gần nhất.",
      { current: { version, timeline: timelineForClient(meta) } },
    );
  }
}

function parseBaseVersion(body: Obj): string {
  if (typeof body.baseVersion !== "string" || !body.baseVersion.trim()) {
    throw new HttpError(400, "INVALID_BASE_VERSION", "Thiếu baseVersion (version lấy từ GET timeline)");
  }
  return body.baseVersion.trim();
}

/**
 * Logo đóng góc cho TRÌNH PHÁT - cùng nguồn với jobs/assemble.ts (logo của
 * Style Design, chép vào assets/ qua syncBrandLogo) để bản xem trước giống bản
 * render. Đã có bản chép cùng kích thước thì dùng luôn: syncBrandLogo ghi lại
 * assets.json mỗi lần gọi, GET timeline bị gọi liên tục khi AI đang sửa.
 */
function previewWatermark(id: string, meta: ProjectMeta): { file: string; position: "top-left" } | null {
  const style = getStyle(briefOf(meta).styleId);
  const srcRel = style?.logoPath ?? null;
  if (!srcRel) return null;
  const srcAbs = path.join(repoRoot, srcRel);
  let srcSize: number;
  try {
    srcSize = fs.statSync(srcAbs).size;
  } catch {
    return null;
  }
  const fileName = `brand-logo${path.extname(srcRel).toLowerCase() || ".png"}`;
  let fresh = false;
  try {
    fresh = fs.statSync(path.join(projectAssetsDirOf(id), fileName)).size === srcSize;
  } catch {
    /* chưa chép */
  }
  let file: string | null = fresh ? fileName : null;
  if (!file) {
    try {
      file = syncBrandLogo(id, style);
    } catch {
      file = null; // không chép được thì trình phát bỏ logo, đừng làm sập GET
    }
  }
  return file ? { file: path.posix.join("assets", file), position: "top-left" } : null;
}

// ------------------------------------------------------------------ Timeline

// GET /api/projects/:id/timeline → { version, timeline, project, preview, lock }
router.get("/:id/timeline", async (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id); // 400 id sai / 404 không có
  const dir = projectDirOf(id);
  const sceneRenders = sceneRendersOf(dir, meta);
  const watermark = previewWatermark(id, meta);
  const referenced = referencedMediaPaths(meta, sceneRenders);
  const media = await mediaInfoMap(dir, referenced);
  // Gồm cả logo đóng góc: đổi logo trong Style Design là chép đè assets/brand-logo.*
  // cùng tên - trình phát cũng cần số phiên bản để không giữ logo cũ trong cache
  const mediaVersions = mediaVersionsOf(dir, watermark ? [...referenced, watermark.file] : referenced);
  const summary = projectSummaryOf(id);
  const busy = busySessionOf(id);
  res.json({
    version: timelineVersion(meta),
    timeline: timelineForClient(meta),
    project: {
      id,
      name: summary?.name ?? id,
      width: summary?.width ?? 0,
      height: summary?.height ?? 0,
      fps: summary?.fps ?? 0,
      status: summary?.status ?? "draft",
      updatedAt: summary?.updatedAt ?? null,
    },
    preview: { sceneRenders, watermark, media, mediaVersions },
    lock: {
      agentBusy: busy !== null,
      renderActive: db.hasActiveRenderJobForProject(id),
      sessionId: busy,
    },
  });
});

// PUT /api/projects/:id/timeline - { baseVersion, timeline: Partial<Timeline>, label? } → { version, timeline }
router.put("/:id/timeline", (req, res) => {
  const id = req.params.id;
  const body = (req.body ?? {}) as Obj;
  const baseVersion = parseBaseVersion(body);
  if (!isObj(body.timeline)) {
    throw new HttpError(400, "INVALID_TIMELINE", "timeline phải là object chứa các khóa cần thay", {
      issues: [{ path: "timeline", message: "phải là object" }],
    });
  }
  const patch = body.timeline;
  if (body.label !== undefined && body.label !== null && typeof body.label !== "string") {
    throw new HttpError(400, "INVALID_LABEL", "label phải là chuỗi");
  }
  const label = typeof body.label === "string" ? body.label.trim().slice(0, MAX_LABEL_LEN) || null : null;

  // Thứ tự: 404 → khóa AI → xung đột version → validate. Trạng thái trước nội
  // dung: base đã cũ thì client phải tải lại đằng nào cũng vậy.
  const meta = readMeta(id);
  assertNotAgentBusy(id);
  assertBaseVersion(meta, baseVersion);
  const issues = validateTimelinePatch(patch, projectDirOf(id));
  if (issues.length) {
    throw new HttpError(
      400,
      "INVALID_TIMELINE",
      `Timeline không hợp lệ (${issues.length} lỗi) - xem issues`,
      { issues },
    );
  }
  // Không gửi khóa nào = không có gì để ghi; trả bản hiện tại, không đẻ bản lịch sử rỗng
  const keys = TIMELINE_KEYS.filter((k) => k in patch);
  if (!keys.length) {
    res.json({ version: timelineVersion(meta), timeline: timelineForClient(meta) });
    return;
  }

  // Lịch sử là lưới an toàn phụ: chụp hỏng (đĩa đầy...) thì vẫn lưu, chỉ ghi log -
  // chặn lưu vì lịch sử là khóa người dùng ngoài đúng lúc họ cần lưu nhất
  try {
    snapshotTimeline(id, "editor", label, meta);
  } catch (err) {
    console.warn(`[timeline] Không chụp được lịch sử trước khi lưu ${id}:`, err);
  }
  const values: Partial<Record<TimelineKey, unknown>> = {};
  for (const k of keys) values[k] = patch[k];
  const next = writeTimelineKeys(id, values);
  res.json({ version: timelineVersion(next), timeline: timelineForClient(next) });
});

// GET /api/projects/:id/timeline/revisions → RevisionSummary[] (mới nhất trước)
router.get("/:id/timeline/revisions", (req, res) => {
  const id = req.params.id;
  readMeta(id);
  res.json(listRevisions(id));
});

// POST /api/projects/:id/timeline/revisions/:rev/restore - { baseVersion } → { version, timeline }
router.post("/:id/timeline/revisions/:rev/restore", (req, res) => {
  const id = req.params.id;
  const rev = req.params.rev;
  const body = (req.body ?? {}) as Obj;
  const baseVersion = parseBaseVersion(body);
  const meta = readMeta(id);
  if (!isValidRev(rev)) throw new HttpError(400, "INVALID_REV", `rev không hợp lệ: ${rev}`);
  const revision = readRevision(id, rev);
  if (!revision) throw new HttpError(404, "REVISION_NOT_FOUND", `Không tìm thấy bản lịch sử "${rev}"`);
  assertNotAgentBusy(id);
  assertBaseVersion(meta, baseVersion);

  // Chụp trạng thái hiện tại trước (source "restore") - khôi phục nhầm thì vẫn
  // quay lại được. Label = rev được khôi phục: dữ liệu, UI tự dịch theo source.
  try {
    snapshotTimeline(id, "restore", rev, meta);
  } catch (err) {
    console.warn(`[timeline] Không chụp được lịch sử trước khi khôi phục ${id}:`, err);
  }
  // Thay CẢ 6 khóa: khóa null trong bản lịch sử = lúc đó chưa có → xóa khỏi meta.
  // Khôi phục đúng nguyên trạng, không validate lại: bản đó từng là trạng thái
  // thật của project, và đây là lối thoát khi bản hiện tại hỏng.
  const next = writeTimelineKeys(id, revision.timeline);
  res.json({ version: timelineVersion(next), timeline: timelineForClient(next) });
});

// GET /api/projects/:id/timeline/export.xml → FCP7 XML (xmeml v5), tải về <id>.xml
router.get("/:id/timeline/export.xml", async (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id);
  const dir = projectDirOf(id);
  const fps = Number(meta.fps);
  const width = Number(meta.width);
  const height = Number(meta.height);
  if (!(fps > 0) || !(width > 0) || !(height > 0)) {
    throw new HttpError(409, "META_INVALID", "meta.json thiếu width/height/fps hợp lệ - không xuất được XML");
  }
  const sceneRenders = sceneRendersOf(dir, meta);
  const media = await mediaInfoMap(dir, referencedMediaPaths(meta, sceneRenders));
  const xml = buildFcp7Xml({
    id,
    name: typeof meta.name === "string" ? meta.name : id,
    fps,
    width: Math.round(width),
    height: Math.round(height),
    meta,
    projectDir: dir,
    sceneRenders,
    media,
  });
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  // id đã qua isKebabCase (readMeta) nên ghép thẳng vào header được
  res.setHeader("Content-Disposition", `attachment; filename="${id}.xml"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(xml);
});

// ------------------------------------------------------------------ Media info

// GET /api/projects/:id/media-info?path=assets/x.mp4 → { durationSec, width?, height?, hasAudio? }
router.get("/:id/media-info", async (req, res) => {
  const id = req.params.id;
  readMeta(id);
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  if (!rel) throw new HttpError(400, "PATH_REQUIRED", "Thiếu query path (tương đối thư mục project)");
  const r = resolveProjectPath(projectDirOf(id), rel);
  if ("error" in r) throw new HttpError(400, "INVALID_PATH", `path "${rel}": ${r.error}`);
  const info = await probeMediaInfo(r.abs);
  if (!info) throw new HttpError(404, "MEDIA_NOT_FOUND", `Không tìm thấy file "${rel}" trong project`);
  res.json(info);
});

// ------------------------------------------------------------------ Thư viện SFX / nhạc

// GET /api/library/sfx → [{ file, durationMs, description, tags, available }] - chỉ file có trên đĩa
libraryRouter.get("/sfx", (_req, res) => {
  res.json(
    readLibrary()
      .filter((e) => fs.existsSync(path.join(paths.sfxDir, e.file)))
      .map((e) => ({
        file: e.file,
        durationMs: e.durationMs,
        description: e.description,
        tags: e.tags,
        available: true,
      })),
  );
});

// GET /api/library/music → cùng shape, từ assets/music/library.json
libraryRouter.get("/music", (_req, res) => {
  res.json(
    readMusicLibrary()
      .filter((e) => fs.existsSync(path.join(paths.musicDir, e.file)))
      .map((e) => ({
        file: e.file,
        durationMs: e.durationMs,
        description: e.description,
        tags: e.tags,
        available: true,
      })),
  );
});

/** Hai file giống hệt nhau? (so kích thước trước - rẻ - rồi mới so nội dung) */
function sameFile(a: string, b: string): boolean {
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * POST /api/projects/:id/library-import - { kind: "sfx"|"music", file } → 201 { relPath, durationSec, copied }
 *
 * Remotion chỉ stage file nằm TRONG project (jobs/assemble.ts), nên sfx/nhạc của
 * thư viện chung phải chép vào assets/sfx/ hoặc assets/music/ trước khi timeline
 * tham chiếu được - và để render lại về sau không phụ thuộc thư viện đã đổi.
 */
router.post("/:id/library-import", async (req, res) => {
  const id = req.params.id;
  readMeta(id);
  const body = (req.body ?? {}) as Obj;
  const kind = body.kind;
  if (kind !== "sfx" && kind !== "music") {
    throw new HttpError(400, "INVALID_KIND", 'kind phải là "sfx" hoặc "music"');
  }
  const file = typeof body.file === "string" ? body.file : "";
  // Tên file trần trong thư viện - không thư mục con, không ẩn, không traversal
  if (!file || file !== path.basename(file) || /[\\/]/.test(file) || file.startsWith(".")) {
    throw new HttpError(400, "INVALID_FILE", "file phải là tên file trong thư viện (không kèm thư mục)");
  }
  if (fileKind(file) !== "audio") {
    throw new HttpError(400, "INVALID_FILE", "file phải là audio (mp3/wav/ogg/m4a/aac/flac)");
  }
  const libDir = kind === "sfx" ? paths.sfxDir : paths.musicDir;
  const listed = (kind === "sfx" ? readLibrary() : readMusicLibrary()).some((e) => e.file === file);
  const srcAbs = path.join(libDir, file);
  if (!listed || !fs.existsSync(srcAbs)) {
    throw new HttpError(
      404,
      "LIBRARY_FILE_NOT_FOUND",
      `Không có "${file}" trong thư viện ${kind === "sfx" ? "sound effect" : "nhạc nền"}`,
    );
  }

  const destDir = path.join(projectAssetsDirOf(id), kind);
  ensureDir(destDir);
  // Trùng tên mà KHÁC nội dung (bản cũ của file thư viện, hay file người dùng tự
  // upload) thì KHÔNG ghi đè - timeline đang dùng file đó sẽ đổi tiếng mà không
  // ai biết. Thêm hậu tố -2, -3... như upload của /api/sfx.
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  let name = file;
  let copied = false;
  for (let n = 2; ; n++) {
    const destAbs = path.join(destDir, name);
    if (!fs.existsSync(destAbs)) {
      fs.copyFileSync(srcAbs, destAbs);
      copied = true;
      break;
    }
    if (sameFile(srcAbs, destAbs)) break;
    name = `${base}-${n}${ext}`;
  }
  const relPath = path.posix.join("assets", kind, name);
  const info = await probeMediaInfo(path.join(destDir, name));
  res.status(201).json({ relPath, durationSec: info?.durationSec ?? null, copied });
});

// ------------------------------------------------------------------ Render từ editor

/**
 * POST /api/projects/:id/editor/render - { quality: "draft"|"final", force? } → 202 { jobs }
 *
 * Xếp scene-draft/scene-final cho scene HyperFrames còn THIẾU file render hoặc
 * có bản render CŨ HƠN composition rồi assemble-*. Luật y hệt POST /api/jobs
 * (dùng chung jobRules.ts): final cần assemble-draft thành công + cổng QC;
 * `force: true` chỉ bỏ qua cổng QC. Hàng đợi chạy job của cùng một project TUẦN
 * TỰ theo thứ tự xếp, nên assemble luôn chạy sau các scene của nó - và phụ
 * thuộc chúng (`dependsOn`): scene nào failed thì assemble failed theo.
 */
router.post("/:id/editor/render", (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id);
  const body = (req.body ?? {}) as Obj;
  const quality = body.quality;
  if (quality !== "draft" && quality !== "final") {
    throw new HttpError(400, "INVALID_QUALITY", 'quality phải là "draft" hoặc "final"');
  }
  if (body.force !== undefined && typeof body.force !== "boolean") {
    throw new HttpError(400, "INVALID_FORCE", "force phải là boolean");
  }
  const draft = quality === "draft";
  const dir = projectDirOf(id);

  // Soi timeline TRƯỚC khi xếp job: lỗi kiểu thiếu durationInFrames mà để tới
  // lúc Remotion chạy là đã tốn công render xong mọi scene rồi mới chết
  const issues = validateTimelineForRender(meta, dir);
  if (issues.length) {
    throw new HttpError(
      400,
      "INVALID_TIMELINE",
      `Timeline chưa render được (${issues.length} lỗi) - xem issues`,
      { issues },
    );
  }
  assertVideoJobAllowed(id, draft ? "assemble-draft" : "assemble-final", {
    force: body.force === true,
  });

  // Scene nào phải render (lại). "Có file" KHÔNG đủ: bản render cũ hơn file
  // composition (`src`) là dựng từ composition trước khi sửa - bỏ qua nó là
  // người dùng sửa scene, bấm render rồi nhận đúng video cũ.
  //  - Draft: assemble-draft tự dùng bản final khi thiếu/cũ draft → chỉ render
  //    khi KHÔNG có bản nào (draft hay final) còn mới hơn composition.
  //  - Final: cần đúng bản final (bản draft chất lượng thấp), và bản đó phải mới
  //    hơn cả composition lẫn .draft.mp4 - draft mới hơn final nghĩa là scene đã
  //    được sửa + xem lại sau lần render final cuối (cùng luật xem trước:
  //    sceneRenderFor lấy bản mới hơn, final cũ hơn là thứ người dùng chưa xem).
  const stale = (meta.scenes ?? []).filter((s) => {
    if (typeof s.src !== "string" || !s.src) return false;
    const st = sceneRenderState(dir, s as unknown as Record<string, unknown>);
    const fresh = (m: number | null): boolean => m !== null && !isRenderStale(m, st);
    if (draft) return !fresh(st.draftMtime) && !fresh(st.finalMtime);
    if (!fresh(st.finalMtime)) return true;
    return st.draftRel !== st.finalRel && st.draftMtime !== null && st.finalMtime! < st.draftMtime;
  });

  const jobs = stale.map((s) =>
    enqueueJob({ projectId: id, type: draft ? "scene-draft" : "scene-final", sceneId: s.id }),
  );
  // assemble phụ thuộc các scene job của CHÍNH lượt này: một scene render hỏng
  // thì assemble failed luôn (queue.ts) thay vì lặng lẽ lắp bằng bản cũ/bản draft
  jobs.push(
    enqueueJob({
      projectId: id,
      type: draft ? "assemble-draft" : "assemble-final",
      dependsOn: jobs.map((j) => j.id),
    }),
  );
  res.status(202).json({ jobs });
});

// ------------------------------------------------------------------ Chat AI từ editor

/**
 * POST /api/projects/:id/editor/chat - { message, sessionId?, model?, effort? } → 202 { sessionId }
 *
 * Phiên goal NULL (KHÔNG phải 'final'): agent.ts không gate "phải có video
 * final" nên không auto-resume ép render - đúng ý một lượt sửa nhỏ trong editor.
 */
router.post("/:id/editor/chat", (req, res) => {
  const id = req.params.id;
  const meta = readMeta(id);
  const body = (req.body ?? {}) as Obj;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) throw new HttpError(400, "MESSAGE_REQUIRED", "Thiếu message");
  const { model, effort } = parseModelEffort(body); // 400 nếu không hợp lệ

  let existing: db.ChatSessionRow | undefined;
  if (body.sessionId !== undefined && body.sessionId !== null && body.sessionId !== "") {
    if (typeof body.sessionId !== "string") {
      throw new HttpError(400, "INVALID_SESSION_ID", "sessionId phải là chuỗi");
    }
    existing = db.getChatSession(body.sessionId.trim());
    if (!existing) {
      throw new HttpError(404, "SESSION_NOT_FOUND", `Không tìm thấy phiên chat "${body.sessionId}"`);
    }
    if (existing.projectId !== id) {
      throw new HttpError(400, "SESSION_PROJECT_MISMATCH", "Phiên chat này không thuộc project đang mở");
    }
    // Phiên dựng video (goal 'final') bị gate "phải ra video final" - tiếp tục nó
    // từ editor là kéo theo auto-resume ép render, trái với lời hứa của editor
    if (existing.goal) {
      throw new HttpError(
        400,
        "SESSION_NOT_EDITOR",
        "Phiên này là phiên dựng video (goal final) - trình chỉnh sửa chỉ tiếp tục phiên chat thường của project",
      );
    }
  }

  // Một project một agent: hai phiên cùng sửa meta.json là ghi đè lẫn nhau
  if (db.listChatSessions(id).some((s) => isAgentBusy(s.sessionId))) {
    throw new HttpError(
      409,
      "SESSION_BUSY",
      "Phiên AI của project đang chạy - đợi xong (hoặc dừng nó) rồi mới gửi tiếp",
    );
  }

  let sessionId: string;
  if (existing) {
    sessionId = existing.sessionId;
    db.setChatSessionModelEffort(sessionId, model, effort);
  } else {
    sessionId = `sess_${nanoid()}`;
    // Title KHÔNG được bắt đầu bằng "Edit: " - db.ts backfill mọi phiên có title
    // đó thành goal 'final' mỗi lần server khởi động
    db.createChatSession(
      sessionId,
      `Trình chỉnh sửa: ${message.slice(0, 60)}`,
      id,
      model ?? null,
      effort ?? null,
      null,
    );
  }
  // Khối ngữ cảnh đầy đủ cho MỌI phiên chưa từng nhận nó - không chỉ phiên mới
  // tạo: phiên /api/chat cũ của project (goal null) tiếp tục từ editor cũng chưa
  // biết đơn vị timeline, luật "không tự render", hay brief/Style Design. Soi
  // tin nhắn đã lưu (agent.ts lưu nguyên văn prompt) thay vì cờ riêng: lượt bị
  // guard của runAgent chặn trước khi chạy thì không lưu → lượt sau gửi lại khối.
  const needsContext =
    !existing || !db.chatSessionHasUserMessageContaining(sessionId, EDITOR_CONTEXT_MARKER);
  const prompt = buildEditorChatPrompt({
    id,
    meta,
    message,
    context: needsContext ? briefPromptContextOf(id, meta) : null,
  });

  // Trả 202 NGAY rồi chạy agent nền - cùng thứ tự với /api/chat (SSE kênh `agent`)
  res.status(202).json({ sessionId });
  void runAgent(sessionId, prompt);
});

export default router;
