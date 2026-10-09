import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { paths, repoRoot } from "../config.js";
import * as db from "../db.js";
import {
  applyTempoToCue,
  autoAssignVoices,
  fitCue,
  gapAfter,
  synthDubCue,
  ttsLanguageFor,
  voiceForCue,
} from "../dub.js";
import { broadcast } from "../events.js";
import { geminiApiKey } from "../gemini.js";
import { cuesFromTranscript } from "../jobs/translateVideo.js";
import { queue } from "../queue.js";
import {
  getPrefs,
  prefBool,
  prefObject,
  prefString,
  rememberPrefs,
} from "../prefs.js";
import { probeVideo } from "../reframe.js";
import { STT_PROVIDERS, assertSttAvailable, isSttProvider, sttCapabilities } from "../stt.js";
import { translateCues } from "../translate.js";
import {
  SUBTITLE_FONTS,
  TRANSLATE_MODES,
  defaultBottomPx,
  defaultTranslateVideoMeta,
  dubDirOf,
  dubLangDiffers,
  effectiveDubLang,
  isDefaultBottomPx,
  isDubVoiceName,
  normCues,
  normDubSettings,
  normLang,
  normSubtitleStyle,
  patchTranslateVideo,
  readTranslateVideo,
  scanTranslateVideos,
  sourceAbsOf,
  transcriptPathOf,
  translateVideoDirOf,
  translateVideoExists,
  wantsDub,
  writeTranslateVideo,
  type TranslateMode,
  type TranslateVideoMeta,
  type TranslatedCue,
} from "../translateVideoMeta.js";
import { DEFAULT_TTS_VOICE, listVoices } from "../tts.js";
import { listLocalVoices, probeLocalEngine } from "../ttsLocal.js";
import type { TtsVoice } from "../ttsTypes.js";
import {
  HttpError,
  ensureDir,
  fileKind,
  isKebabCase,
  moveFile,
  toKebabAscii,
  toRepoRel,
} from "../util.js";

/**
 * Dịch video - mount tại /api/translate-video (xem index.ts).
 *
 * Bốn hành động tách riêng CÓ CHỦ Ý, vì mỗi bước đều cần người duyệt lại trước
 * khi tốn thời gian/tiền cho bước sau:
 *   POST /:id/source     - upload + đo video bằng ffprobe (vài giây)
 *   POST /:id/transcribe - whisper bóc lời          (rất lâu)  -> vào queue
 *   POST /:id/translate  - AI dịch từng câu         (~chục giây, tốn token) - ĐỒNG BỘ
 *   POST /:id/render     - Remotion ghép phụ đề     (lâu)      -> vào queue
 *
 * Route CHỈ validate + ghi meta + đẩy job. Mọi chuyển trạng thái nặng
 * (transcribing/rendering/done/failed) do job runner ghi - backend là nguồn sự
 * thật duy nhất về trạng thái job, route không đoán trước.
 */

const router = Router();

/** Video nguồn có thể rất nặng - cùng mức trần với upload asset thường */
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir(paths.uploadTmpDir);
      cb(null, paths.uploadTmpDir);
    },
    filename: (_req, _file, cb) =>
      cb(null, `tvd-${Date.now()}-${Math.round(Math.random() * 1e9)}`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

/** Đuôi video nhận được - đúng bộ mà fileKind() coi là "video" */
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"]);

// ------------------------------------------------------------------ Tiện ích

function mustRead(id: string): TranslateVideoMeta {
  if (!isKebabCase(id)) throw new HttpError(400, "INVALID_ID", "id không hợp lệ");
  if (!translateVideoExists(id)) {
    throw new HttpError(404, "NOT_FOUND", `Không tìm thấy phiên dịch "${id}"`);
  }
  return healStale(readTranslateVideo(id));
}

/** Phiên đang chạy /translate (đồng bộ, không có job) trong process NÀY */
const translatingNow = new Set<string>();

/**
 * Trạng thái "đang chạy" chỉ được ghi lại bởi job/handler đang sống. Server chết
 * giữa chừng (restart, tắt máy) thì không ai lùi nó về - phiên kẹt 409 BUSY mãi
 * mãi, kể cả không xóa được. Nên mỗi lần đọc đều đối chiếu: không còn job nào
 * chạy/chờ (và không phải /translate đang chạy) thì lùi về trạng thái CHẠY LẠI ĐƯỢC.
 */
function healStale(meta: TranslateVideoMeta): TranslateVideoMeta {
  const stale =
    ((meta.status === "transcribing" || meta.status === "rendering") &&
      !db.hasActiveJobForProject(meta.id)) ||
    (meta.status === "translating" && !translatingNow.has(meta.id));
  if (!stale) return meta;
  const status =
    meta.status === "rendering" && meta.cues.length > 0
      ? "translated"
      : meta.transcriptFile
        ? "transcribed"
        : "draft";
  return patchTranslateVideo(meta.id, {
    status,
    error: `Bước "${meta.status}" bị dừng giữa chừng (server khởi động lại) - chạy lại bước đó.`,
  });
}

function uniqueId(name: string): string {
  const base = toKebabAscii(name) || "translate-video";
  let id = base;
  for (let n = 2; fs.existsSync(translateVideoDirOf(id)); n++) id = `${base}-${n}`;
  return id;
}

/** Chặn chạy chồng job trên cùng một phiên (queue chạy song song nhiều job) */
function assertNotBusy(meta: TranslateVideoMeta): void {
  if (db.hasActiveJobForProject(meta.id)) {
    throw new HttpError(
      409,
      "BUSY",
      `Phiên dịch "${meta.id}" đang có job chạy/chờ trong hàng đợi`,
    );
  }
  if (meta.status === "transcribing" || meta.status === "rendering" || meta.status === "translating") {
    throw new HttpError(409, "BUSY", `Phiên dịch "${meta.id}" đang ${meta.status}`);
  }
}

/**
 * Provider bóc lời từ client - giá trị lạ thì 400 CÓ MÃ, không im lặng lùi về
 * mặc định (im lặng thì người dùng chọn Soniox, hệ thống chạy whisper, và không
 * ai hiểu vì sao không có nhãn người nói). Đúng cách `mode` đang validate.
 *
 * KHÔNG kiểm tra key ở đây: lưu lựa chọn là việc rẻ và làm được cả khi chưa nhập
 * key (người dùng chọn trước, nhập key sau). Chốt chặn "có key chưa" nằm ở
 * /transcribe, ngay trước khi thật sự tốn thời gian.
 */
function mustSttProvider(raw: unknown): (typeof STT_PROVIDERS)[number] {
  if (!isSttProvider(raw)) {
    throw new HttpError(
      400,
      "INVALID_STT_PROVIDER",
      `sttProvider phải là một trong: ${STT_PROVIDERS.join(", ")}`,
    );
  }
  return raw;
}

/** Tạo + enqueue job. sceneId mang step (xem db.ts JobType "translate-video") */
function enqueueJob(sessionId: string, step: "transcribe" | "render"): db.JobApi {
  const job = db.createJob({
    id: `job_${nanoid()}`,
    // Queue dùng projectId làm khóa bận; namespace "tvd:" tách khỏi job video
    projectId: sessionId,
    type: "translate-video",
    sceneId: step,
  });
  const api = db.jobToApi(job);
  broadcast("job", api);
  queue.enqueue(job.id);
  return api;
}

// ------------------------------------------------------------------ CRUD

/**
 * GET /api/translate-video/fonts -> SubtitleFontOption[]
 * Danh sách font hợp lệ cho subtitleStyle.fontFamily - UI đọc để dựng dropdown
 * thay vì hardcode. ĐẶT TRƯỚC GET /:id, nếu không "fonts" bị bắt như một id.
 */
router.get("/fonts", (_req, res) => {
  res.json(SUBTITLE_FONTS);
});

/**
 * GET /api/translate-video/stt-providers -> SttCapabilities[]
 *
 * AI nào bóc lời được TRÊN MÁY NÀY, kèm `diarization` (có phân vai người nói
 * không) và `why` khi không dùng được. UI đọc để dựng dropdown và khóa lựa chọn
 * thiếu key - thay vì để người dùng chọn rồi job chết ở phút thứ hai.
 * ĐẶT TRƯỚC GET /:id, nếu không "stt-providers" bị bắt như một id.
 */
router.get("/stt-providers", (_req, res) => {
  res.json(sttCapabilities());
});

// GET /api/translate-video -> TranslateVideoMeta[] (mới cập nhật trước)
router.get("/", (_req, res) => {
  res.json(scanTranslateVideos().map(healStale));
});

// POST /api/translate-video { name? } -> 201 TranslateVideoMeta
router.post("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Ô tên là tùy chọn: bỏ trống thì đặt tên tạm rồi lấy tên file nguồn khi upload
  let name = typeof body.name === "string" ? body.name.trim() : "";
  let autoNamed = false;
  if (!name) {
    name = "Video dịch";
    autoNamed = true;
  }

  const meta = defaultTranslateVideoMeta(uniqueId(name), name);
  meta.autoNamed = autoNamed;

  /*
   * Mặc định = LẦN TRƯỚC NGƯỜI DÙNG CHỌN GÌ, không phải hằng số trong mã nguồn.
   * Body vẫn thắng (client gửi rõ thì nghe client), nhưng khi không gửi thì
   * người làm video thứ mười không phải chọn lại đúng bộ đã chọn chín lần.
   * Chỉ nhận giá trị đã qua normalize - prefs.json là file trên đĩa, sửa tay được.
   */
  const pref = getPrefs("translate-video");
  meta.sourceLang = normLang(prefString(pref, "sourceLang"), meta.sourceLang);
  meta.targetLang = normLang(prefString(pref, "targetLang"), meta.targetLang);
  const prefDubLang = prefString(pref, "dubLang");
  meta.dubLang = prefDubLang ? normLang(prefDubLang, meta.targetLang) : null;
  if (TRANSLATE_MODES.includes(pref.mode as TranslateMode)) {
    meta.mode = pref.mode as TranslateMode;
  }
  if (isSttProvider(pref.sttProvider)) meta.sttProvider = pref.sttProvider;
  meta.subtitleStyle = normSubtitleStyle(prefObject(pref, "subtitleStyle"), meta.subtitleStyle);
  // Giọng theo người nói KHÔNG nhớ: "người nói 1" của video này không liên quan
  // gì tới "người nói 1" của video sau - xem ghi chú trong prefs.ts
  meta.dub = {
    ...normDubSettings(prefObject(pref, "dub"), meta.dub),
    voices: {},
  };

  if ("sourceLang" in body) meta.sourceLang = normLang(body.sourceLang, meta.sourceLang);
  if ("targetLang" in body) meta.targetLang = normLang(body.targetLang, meta.targetLang);
  if (TRANSLATE_MODES.includes(body.mode as TranslateMode)) meta.mode = body.mode as TranslateMode;
  if ("sttProvider" in body) meta.sttProvider = mustSttProvider(body.sttProvider);

  writeTranslateVideo(meta);
  res.status(201).json(readTranslateVideo(meta.id));
});

// GET /api/translate-video/:id -> TranslateVideoMeta
router.get("/:id", (req, res) => {
  res.json(mustRead(req.params.id));
});

/**
 * PATCH /api/translate-video/:id -> TranslateVideoMeta
 * Body: { name?, sourceLang?, targetLang?, mode?, subtitleStyle?, cues? }
 *
 * Hai quy tắc "làm hết đúng" ở đây, cố ý ồn ào thay vì im lặng:
 *  - đổi sourceLang -> transcript cũ bóc bằng ngôn ngữ khác nên hết giá trị:
 *    xóa transcript + cues, phiên về draft, phải bóc lời lại.
 *  - đổi targetLang -> chỉ BẢN DỊCH hết giá trị: giữ transcript, trả `text` về
 *    câu gốc (`original`) và lùi về "transcribed" để dịch lại.
 */
router.patch("/:id", (req, res) => {
  const cur = mustRead(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Đang chạy job thì cue/ngôn ngữ/kiểu chữ đang được job đọc - chỉ cho sửa tên
  const touchesRun =
    "sourceLang" in body ||
    "targetLang" in body ||
    "dubLang" in body ||
    "mode" in body ||
    "sttProvider" in body ||
    "cues" in body ||
    "subtitleStyle" in body ||
    "dub" in body;
  if (touchesRun) assertNotBusy(cur);

  const patch: Partial<TranslateVideoMeta> = {};

  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new HttpError(400, "INVALID_NAME", "name phải là string không rỗng");
    }
    patch.name = body.name.trim();
    // User tự đặt tên - hạ cờ để bước upload không ghi đè bằng tên file
    patch.autoNamed = false;
  }

  if ("mode" in body) {
    if (!TRANSLATE_MODES.includes(body.mode as TranslateMode)) {
      throw new HttpError(
        400,
        "INVALID_MODE",
        `mode phải là một trong: ${TRANSLATE_MODES.join(", ")}`,
      );
    }
    patch.mode = body.mode as TranslateMode;
  }

  /**
   * Đổi provider bóc lời KHÔNG xóa transcript đang có - khác hẳn đổi `sourceLang`.
   *
   * Lý do phân biệt: đổi ngôn ngữ nguồn làm transcript cũ SAI (bóc bằng ngôn ngữ
   * khác), nên phải xóa. Đổi provider chỉ làm nó CŨ chứ không sai - chữ vẫn đúng,
   * bản dịch dựa trên nó vẫn dùng được. Xóa ở đây là bắt người dùng chạy lại một
   * bước rất đắt chỉ vì họ bấm thử một lựa chọn. Muốn có transcript của provider
   * mới thì bấm "bóc lời" lại; `transcriptInfo` luôn nói rõ transcript ĐANG CÓ là
   * của provider nào nên không có chuyện nhầm.
   */
  if ("sttProvider" in body) {
    patch.sttProvider = mustSttProvider(body.sttProvider);
  }

  if ("sourceLang" in body) {
    const next = normLang(body.sourceLang, cur.sourceLang);
    patch.sourceLang = next;
    if (next !== cur.sourceLang && cur.transcriptFile) {
      patch.transcriptFile = null;
      patch.cues = [];
      patch.outputFile = null;
      patch.status = "draft";
      patch.error = null;
    }
  }

  if ("targetLang" in body) {
    const next = normLang(body.targetLang, cur.targetLang);
    patch.targetLang = next;
    if (next !== cur.targetLang && cur.cues.length > 0) {
      // Trả chữ về câu gốc VÀ bỏ luôn bản đọc: `dubText` chỉ có nghĩa khi nó là
      // bản dịch song hành của đúng lượt dịch này. Giữ lại là câu đọc thuộc về
      // một bản dịch đã bị vứt đi.
      patch.cues = cur.cues.map(({ dubText: _drop, ...c }) => ({
        ...c,
        text: c.original ?? c.text,
      }));
      patch.outputFile = null;
      patch.status = cur.transcriptFile ? "transcribed" : "draft";
      patch.error = null;
    }
  }

  /**
   * Ngôn ngữ LỒNG TIẾNG. null hoặc "" = đọc đúng ngôn ngữ phụ đề.
   *
   * Đổi nó chỉ làm hỏng BẢN ĐỌC, không đụng bản phụ đề - nên khác `targetLang`:
   * ở đây chỉ bỏ `dubText` rồi lùi trạng thái để người dùng dịch lại, chữ trên
   * màn hình vẫn còn nguyên chứ không bắt dịch lại từ đầu.
   */
  if ("dubLang" in body) {
    const raw = body.dubLang;
    const next =
      raw === null || raw === "" ? null : normLang(raw, cur.dubLang ?? cur.targetLang);
    patch.dubLang = next;
    const nextEffective = next ?? (patch.targetLang ?? cur.targetLang);
    if (nextEffective !== effectiveDubLang(cur) && cur.cues.length > 0) {
      const base = patch.cues ?? cur.cues;
      patch.cues = base.map(({ dubText: _drop, ...c }) => c);
      patch.outputFile = null;
      // Cần đọc bằng tiếng khác thì phải có bản dịch tiếng ấy - lùi về bước dịch
      if (nextEffective !== (patch.targetLang ?? cur.targetLang)) {
        patch.status = cur.transcriptFile ? "transcribed" : "draft";
      }
      patch.error = null;
    }
  }

  if ("subtitleStyle" in body) {
    patch.subtitleStyle = normSubtitleStyle(body.subtitleStyle, cur.subtitleStyle);
  }

  /**
   * Sửa cấu hình lồng tiếng. KHÔNG xóa track đã dựng ở đây: `dubSignature` tự
   * biết cái gì làm bản đọc hết giá trị (đổi giọng/engine/model/ngôn ngữ) và cái
   * gì không (bật/tắt giữ tiếng gốc, chỉnh âm lượng nền). Xóa thẳng tay là bắt
   * người dùng trả tiền đọc lại cả bài chỉ vì họ gạt thử một công tắc trộn.
   */
  if ("dub" in body) {
    patch.dub = normDubSettings(body.dub, cur.dub);
    // Video cũ dựng bằng cấu hình cũ - không còn khớp lựa chọn hiện tại
    patch.outputFile = null;
  }

  // Sửa bản dịch bằng tay: đọc thấy sai thì sửa chứ không phải dịch lại cả bài
  if ("cues" in body) {
    if (!Array.isArray(body.cues)) {
      throw new HttpError(400, "INVALID_CUES", "cues phải là mảng");
    }
    const cues = normCues(body.cues);
    if (cues.length === 0 && (body.cues as unknown[]).length > 0) {
      throw new HttpError(
        400,
        "INVALID_CUES",
        "Không cue nào hợp lệ - mỗi cue cần start < end (giây) và text không rỗng",
      );
    }
    patch.cues = cues;
    // Chữ đổi thì video đã ghép trước đó không còn khớp
    patch.outputFile = null;
  }

  const saved = patchTranslateVideo(cur.id, patch);

  // Nhớ "gu làm việc" cho phiên sau. Đặt SAU khi ghi thành công: lựa chọn bị
  // 400 vì không hợp lệ thì không đáng được nhớ.
  rememberPrefs("translate-video", {
    sourceLang: "sourceLang" in body ? saved.sourceLang : undefined,
    targetLang: "targetLang" in body ? saved.targetLang : undefined,
    dubLang: "dubLang" in body ? (saved.dubLang ?? "") : undefined,
    mode: "mode" in body ? saved.mode : undefined,
    sttProvider: "sttProvider" in body ? saved.sttProvider : undefined,
    subtitleStyle: "subtitleStyle" in body ? saved.subtitleStyle : undefined,
    // Bỏ `voices` - đó là chuyện riêng của từng video
    dub: "dub" in body ? { ...saved.dub, voices: {} } : undefined,
  });

  res.json(saved);
});

/**
 * DELETE /api/translate-video/:id -> 204
 * Xóa cả thư mục phiên (meta + nguồn + transcript + output). Không có gì đứng
 * độc lập bên ngoài như Videos Project của Auto cut, nên xóa là xóa sạch.
 */
router.delete("/:id", (req, res) => {
  const meta = mustRead(req.params.id);
  // Job đang chạy sẽ ghi tiếp vào thư mục vừa xóa -> chặn trước cho sạch
  assertNotBusy(meta);
  fs.rmSync(translateVideoDirOf(meta.id), { recursive: true, force: true });
  // Bản stage trong Remotion public/ chỉ là hardlink - dọn luôn cho khỏi rác
  fs.rmSync(path.join(paths.stagingDir, `tvd-${meta.id}`), { recursive: true, force: true });
  res.status(204).end();
});

// ------------------------------------------------------------------ Nguồn

/**
 * POST /api/translate-video/:id/source - multipart: file -> TranslateVideoMeta
 *
 * Đo bằng ffprobe NGAY khi nhận: kích thước/fps/thời lượng là đầu vào của mọi
 * phép đổi giây -> frame ở bước render, đo sau thì render mới biết là hỏng.
 * Dùng `probeVideo` chung với Auto cut nên cờ xoay của video quay bằng điện
 * thoại được xử lý y hệt (rotation 90/270 -> hoán đổi W/H).
 */
router.post("/:id/source", upload.single("file"), async (req, res) => {
  const uploaded = req.file;
  if (!uploaded) throw new HttpError(400, "FILE_REQUIRED", "Thiếu file (field `file`)");

  try {
    // multer đổi generic của handler → req.params.id bị suy ra string|string[], ép về string
    const meta = mustRead(String(req.params.id));
    assertNotBusy(meta);

    const ext = path.extname(uploaded.originalname).toLowerCase();
    if (!VIDEO_EXT.has(ext)) {
      throw new HttpError(
        400,
        "INVALID_SOURCE",
        `"${uploaded.originalname}" không phải video (mp4/mov/webm/mkv/avi/m4v)`,
      );
    }

    const dir = translateVideoDirOf(meta.id);
    ensureDir(dir);
    // Đổi nguồn = xóa nguồn cũ: tên file luôn là "source.<ext>" nên đuôi khác
    // sẽ để lại file mồ côi nặng hàng GB nếu không dọn.
    for (const name of fs.readdirSync(dir)) {
      if (/^source\./i.test(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
    const destAbs = path.join(dir, `source${ext}`);
    moveFile(uploaded.path, destAbs);

    const probe = await probeVideo(destAbs);
    if (!(probe.durationSec > 0)) {
      throw new HttpError(400, "PROBE_FAILED", "ffprobe không đọc được thời lượng video");
    }

    const patch: Partial<TranslateVideoMeta> = {
      source: {
        relPath: toRepoRel(destAbs),
        durationSec: Math.round(probe.durationSec * 100) / 100,
        width: probe.width,
        height: probe.height,
        fps: Math.round(probe.fps * 1000) / 1000,
      },
      // Nguồn mới thì mọi thứ dẫn xuất từ nguồn cũ đều hết giá trị
      transcriptFile: null,
      cues: [],
      outputFile: null,
      status: "draft",
      error: null,
    };
    // Giờ mới biết khung dọc hay ngang: nếu bottomPx vẫn đang là một trong hai
    // giá trị MẶC ĐỊNH thì snap về đúng mặc định của hướng khung này (xem
    // DEFAULT_BOTTOM_PX). Người dùng đã tự đặt số khác thì không đụng tới.
    if (isDefaultBottomPx(meta.subtitleStyle.bottomPx)) {
      patch.subtitleStyle = {
        ...meta.subtitleStyle,
        bottomPx: defaultBottomPx(probe.height >= probe.width),
      };
    }
    // Phiên đặt tên tạm (user bỏ trống ô tên) - lấy tên file thật thay vào
    if (meta.autoNamed) {
      const stem = path.basename(uploaded.originalname, path.extname(uploaded.originalname)).trim();
      if (stem) {
        patch.name = stem.slice(0, 120);
        patch.autoNamed = false;
      }
    }
    // Transcript cũ trỏ tới video khác - xóa để không bị dùng nhầm
    fs.rmSync(transcriptPathOf(meta.id), { force: true });

    res.json(patchTranslateVideo(meta.id, patch));
  } catch (err) {
    if (uploaded.path && fs.existsSync(uploaded.path)) {
      try {
        fs.unlinkSync(uploaded.path);
      } catch {
        /* file tạm đang bị giữ - bỏ qua */
      }
    }
    throw err;
  }
});

// ------------------------------------------------------------------ Bóc lời

/**
 * POST /api/translate-video/:id/transcribe -> 202 { jobId } - job step "transcribe"
 * Body (tùy chọn): { sttProvider } - chọn luôn provider cho lần chạy này.
 *
 * Kiểm tra provider có dùng được TRƯỚC KHI đẩy vào hàng đợi: thiếu
 * SONIOX_API_KEY thì trả 503 STT_PROVIDER_UNAVAILABLE kèm câu tiếng Việt ngay
 * tại đây, thay vì để người dùng thấy job "đang chạy" rồi failed vài giây sau.
 */
router.post("/:id/transcribe", (req, res) => {
  const meta = mustRead(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  sourceAbsOf(meta); // ném 400 NO_SOURCE / 404 SOURCE_NOT_FOUND nếu thiếu file
  assertNotBusy(meta);

  const provider = "sttProvider" in body ? mustSttProvider(body.sttProvider) : meta.sttProvider;
  assertSttAvailable(provider);
  // Job runner đọc meta từ đĩa - lựa chọn phải nằm trên đĩa TRƯỚC khi enqueue
  if (provider !== meta.sttProvider) patchTranslateVideo(meta.id, { sttProvider: provider });

  res.status(202).json({ jobId: enqueueJob(meta.id, "transcribe").id });
});

// ------------------------------------------------------------------ Dịch

/**
 * POST /api/translate-video/:id/translate { model? } -> TranslateVideoMeta
 *
 * ĐỒNG BỘ (giống /script của Text to video): dịch vài chục câu mất khoảng chục
 * giây, đưa vào queue chỉ thêm một tầng trạng thái mà không nhanh hơn.
 *
 * Đầu vào lấy từ TRANSCRIPT GỐC chứ không phải `cues` hiện tại - `cues` có thể
 * đã là bản dịch của lần trước (dịch chồng lên bản dịch là ra thứ càng lúc càng
 * lệch). Không còn transcript thì mới lùi về dùng `original` của cue.
 */
router.post("/:id/translate", async (req, res) => {
  const meta = mustRead(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  assertNotBusy(meta);

  const model =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;

  const input = sourceCuesOf(meta);
  if (input.length === 0) {
    throw new HttpError(
      400,
      "NO_TRANSCRIPT",
      "Chưa có lời gốc để dịch - chạy bước bóc lời trước.",
    );
  }

  patchTranslateVideo(meta.id, { status: "translating", error: null });
  translatingNow.add(meta.id);
  try {
    const plain = input.map((c) => ({ start: c.start, end: c.end, text: c.text }));
    const twoLangs = wantsDub(meta.mode) && dubLangDiffers(meta);

    /*
     * MỘT lượt dịch hay HAI, và bằng lối dịch nào:
     *
     * - Cùng một ngôn ngữ cho cả chữ lẫn tiếng (mọi phiên "subtitle"/"dub", và
     *   "both" khi hai bên chọn giống nhau): ĐÚNG MỘT lượt. Nếu có lồng tiếng
     *   thì dịch theo lối "dub" - lối này ràng buộc độ dài câu để đọc lên vừa
     *   khớp thời gian, mà câu ngắn gọn thì làm phụ đề cũng dễ đọc hơn. Ngược
     *   lại (chỉ phụ đề) thì dịch theo lối "subtitle", bám sát nguyên văn.
     *
     * - Hai ngôn ngữ khác nhau: BUỘC phải hai lượt, không có cách nào rẻ hơn -
     *   một lượt cho chữ trên màn hình, một lượt cho chữ đọc lên. Tốn gấp đôi
     *   tiền Gemini, nên UI phải nói trước điều đó chứ đừng để người dùng tự
     *   phát hiện qua hóa đơn.
     */
    const result = await translateCues({
      cues: plain,
      sourceLang: meta.sourceLang,
      targetLang: meta.targetLang,
      mode: twoLangs || meta.mode === "subtitle" ? "subtitle" : "dub",
      model,
      usageTag: "translate-video",
      projectId: meta.id,
    });
    const cues = normCues(result.cues);
    if (cues.length === 0) {
      throw new HttpError(
        502,
        "TRANSLATE_EMPTY",
        "AI không trả về câu dịch nào đọc được - thử lại, hoặc đổi model.",
      );
    }

    if (twoLangs) {
      const dubbed = normCues(
        (
          await translateCues({
            cues: plain,
            sourceLang: meta.sourceLang,
            targetLang: effectiveDubLang(meta),
            mode: "dub",
            model,
            usageTag: "translate-video",
            projectId: meta.id,
          })
        ).cues,
      );
      /*
       * Ghép theo MỐC THỜI GIAN chứ không theo thứ tự mảng: hai lượt gọi là hai
       * lần model tự chia câu, số câu trả về có thể lệch nhau. Ghép theo chỉ số
       * khi lệch một câu là toàn bộ phần sau bị gán nhầm chữ - lỗi đó chỉ lộ ra
       * khi đã render xong và ngồi nghe.
       *
       * Câu nào không tìm được bạn thì để trống `dubText`, bước lồng tiếng sẽ
       * đọc chữ phụ đề: sai ngôn ngữ một câu vẫn hơn là câm mất một câu.
       */
      const byStart = new Map(dubbed.map((c) => [Math.round(c.start * 1000), c.text]));
      let matched = 0;
      for (const c of cues) {
        const hit = byStart.get(Math.round(c.start * 1000));
        if (hit) {
          c.dubText = hit;
          matched++;
        }
      }
      if (matched < cues.length) {
        // Không ném lỗi - bản dịch phụ đề vẫn dùng được, chỉ nói ra chỗ hụt
        console.warn(
          `[translate-video] ${meta.id}: ${cues.length - matched}/${cues.length} câu ` +
            `không khớp được bản dịch lồng tiếng theo mốc thời gian`,
        );
      }
    }
    res.json(
      patchTranslateVideo(meta.id, {
        cues,
        status: "translated",
        // Bản dịch mới thì video đã ghép trước đó không còn khớp
        outputFile: null,
        error: null,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Lùi về đúng trạng thái CHẠY LẠI ĐƯỢC, không để kẹt ở "translating"
    patchTranslateVideo(meta.id, {
      status: meta.transcriptFile ? "transcribed" : "draft",
      error: message,
    });
    throw err;
  } finally {
    translatingNow.delete(meta.id);
  }
});

/**
 * Câu GỐC để đưa đi dịch: ưu tiên transcript trên đĩa (nguồn sự thật, chia câu
 * bằng đúng segmentsToCues của hệ thống), thiếu thì lùi về `original` của cue.
 */
function sourceCuesOf(meta: TranslateVideoMeta): TranslatedCue[] {
  if (meta.transcriptFile) {
    const abs = path.join(repoRoot, meta.transcriptFile);
    const cues = cuesFromTranscript(abs);
    if (cues.length > 0) return cues;
  }
  return meta.cues.map((c) => ({ ...c, text: c.original ?? c.text }));
}

// ------------------------------------------------------------------ Lồng tiếng

/**
 * Engine đọc có dùng được TRÊN MÁY NÀY không - kiểm TRƯỚC khi vào hàng đợi, đúng
 * cách /transcribe kiểm provider bóc lời. Không kiểm thì người dùng thấy job
 * "đang chạy", chờ, rồi nhận một lỗi Python ở phút thứ hai.
 */
async function assertDubEngineReady(meta: TranslateVideoMeta): Promise<void> {
  if (meta.dub.engine === "gemini") {
    if (!geminiApiKey()) {
      throw new HttpError(
        503,
        "NO_GEMINI_KEY",
        "Chưa có GEMINI_API_KEY nên không lồng tiếng được. Thêm GEMINI_API_KEY vào .env " +
          '(lấy key tại aistudio.google.com/apikey), hoặc đổi engine lồng tiếng sang "vieneu" (chạy trên máy).',
      );
    }
    return;
  }
  const status = await probeLocalEngine();
  if (!status.available) {
    throw new HttpError(503, "LOCAL_TTS_UNAVAILABLE", status.detail);
  }
}

/** Kho giọng của engine đang chọn - dùng chung cho nghe thử và cho việc gán */
async function voiceCatalogOf(meta: TranslateVideoMeta): Promise<TtsVoice[]> {
  try {
    return meta.dub.engine === "vieneu" ? await listLocalVoices() : await listVoices();
  } catch {
    return [];
  }
}

/**
 * POST /api/translate-video/:id/dub-preview { index?, voice? } -> audio/wav
 *
 * Nghe thử ĐÚNG MỘT CÂU trước khi trả tiền đọc cả video.
 *
 * Quan trọng: câu nghe thử đi qua ĐÚNG phép co giãn của bước dựng thật (fitCue
 * -> atempo), nên nếu câu đó phải co x1,25 thì người dùng nghe ngay ra là bản
 * dịch đang dài quá và sửa chữ, thay vì phát hiện sau khi đã render xong video.
 * Header x-dub-* mang số đo để UI hiện thẳng bên nút.
 */
router.post("/:id/dub-preview", async (req, res) => {
  const meta = mustRead(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (meta.cues.length === 0) {
    throw new HttpError(400, "NO_CUES", "Chưa có câu nào để nghe thử - dịch trước đã.");
  }
  await assertDubEngineReady(meta);

  const rawIndex = typeof body.index === "number" ? Math.trunc(body.index) : 0;
  if (rawIndex < 0 || rawIndex >= meta.cues.length) {
    throw new HttpError(
      400,
      "INVALID_CUE_INDEX",
      `index phải trong khoảng 0..${meta.cues.length - 1}`,
    );
  }
  const cue = meta.cues[rawIndex];

  // Giọng: ưu tiên giọng truyền thẳng (người dùng đang bấm thử từng giọng), sau
  // đó tới giọng đã chốt cho người nói này, cuối cùng mới là gán tự động
  let voice = "";
  if ("voice" in body) {
    if (!isDubVoiceName(body.voice)) {
      throw new HttpError(400, "INVALID_VOICE", "voice không hợp lệ");
    }
    voice = (body.voice as string).trim();
  } else {
    const speakers = (meta.transcriptInfo?.diarized ? meta.transcriptInfo.speakers : []).filter(
      (s) => meta.cues.some((c) => (c.speaker ?? "") === s),
    );
    const assignments = autoAssignVoices(speakers, {
      engine: meta.dub.engine,
      voices: await voiceCatalogOf(meta),
      speakerF0: meta.dubInfo?.speakerF0 ?? {},
      locked: meta.dub.voices,
      defaultVoice: DEFAULT_TTS_VOICE,
    });
    voice = voiceForCue(assignments, cue.speaker).voice;
  }

  // Nghe thử phải đi đúng con đường của bản thật: chữ đọc là dubText khi có,
  // ngôn ngữ đọc là effectiveDubLang. Nghe thử một đằng render một nẻo thì việc
  // nghe thử chẳng chứng minh được gì.
  const language = meta.dub.language ?? ttsLanguageFor(effectiveDubLang(meta));
  const dubDir = dubDirOf(meta.id);
  const workDir = path.join(dubDir, "preview");
  const outAbs = path.join(dubDir, "preview.wav");
  ensureDir(dubDir);
  // Dọn lần trước: nghe thử lại mà đọc trúng file cũ là thứ không ai debug nổi
  fs.rmSync(workDir, { recursive: true, force: true });

  try {
    const { naturalSec } = await synthDubCue({
      text: cue.dubText ?? cue.text,
      voice,
      engine: meta.dub.engine,
      model: meta.dub.model,
      language,
      workDir,
      outWavAbs: outAbs,
    });
    const durationSec = meta.source.durationSec ?? 0;
    const fit = fitCue(naturalSec, cue.end - cue.start, gapAfter(meta.cues, rawIndex, durationSec));
    const finalSec = await applyTempoToCue(outAbs, fit.tempo);
    const wav = fs.readFileSync(outAbs);

    res.setHeader("content-type", "audio/wav");
    res.setHeader("content-length", String(wav.length));
    // Mỗi lần đọc ra một file khác (thời lượng lệch tới 28%) - cấm cache
    res.setHeader("cache-control", "no-store");
    // Tên giọng VieNeu có dấu ("Minh Đức") - header HTTP chỉ nhận Latin-1, đặt
    // thẳng là Node ném ERR_INVALID_CHAR và trả 500 sau khi đã đọc TTS xong
    res.setHeader("x-dub-voice", encodeURIComponent(voice));
    res.setHeader("x-dub-natural", naturalSec.toFixed(2));
    res.setHeader("x-dub-final", finalSec.toFixed(2));
    res.setHeader("x-dub-source", (cue.end - cue.start).toFixed(2));
    res.setHeader("x-dub-tempo", fit.tempo.toFixed(3));
    res.setHeader("x-dub-clipped", fit.clipped ? "1" : "0");
    res.setHeader("x-dub-overflowed", fit.overflowed ? "1" : "0");
    res.send(wav);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ Ghép phụ đề / lồng tiếng

/**
 * POST /api/translate-video/:id/render -> 202 { jobId } - job step "render"
 * Một cửa cho cả hai chế độ; `meta.mode` quyết định job làm gì (xem stepRender).
 */
router.post("/:id/render", async (req, res) => {
  const meta = mustRead(req.params.id);
  sourceAbsOf(meta);
  assertNotBusy(meta);
  if (meta.cues.length === 0) {
    throw new HttpError(
      400,
      "NO_CUES",
      meta.mode === "dub"
        ? "Chưa có câu nào để lồng tiếng - chạy bước bóc lời và dịch trước."
        : "Chưa có câu phụ đề nào - chạy bước bóc lời và dịch trước.",
    );
  }
  if (fileKind(meta.source.relPath ?? "") !== "video") {
    throw new HttpError(400, "INVALID_SOURCE", "Nguồn của phiên không phải file video");
  }
  /*
   * Đọc tiếng khác phụ đề thì PHẢI có bản dịch của tiếng ấy. Thiếu thì chặn ở
   * đây chứ đừng để bước lồng tiếng lặng lẽ đọc chữ phụ đề: người dùng trả tiền
   * đọc cả bài rồi mới nghe ra video nói sai ngôn ngữ mình chọn.
   */
  if (wantsDub(meta.mode) && dubLangDiffers(meta) && !meta.cues.some((c) => c.dubText)) {
    throw new HttpError(
      400,
      "NO_DUB_TRANSLATION",
      `Chưa có bản dịch tiếng "${effectiveDubLang(meta)}" để đọc - bấm Dịch lại ` +
        "để AI dịch thêm bản cho phần lồng tiếng.",
    );
  }
  if (wantsDub(meta.mode)) {
    await assertDubEngineReady(meta);
    // Dò engine mất vài giây: hai cú bấm nhanh cùng lọt qua assertNotBusy phía
    // trên và xếp HAI job render (tính tiền TTS hai lần) - kiểm lại ngay trước khi xếp
    assertNotBusy(mustRead(meta.id));
  }
  res.status(202).json({ jobId: enqueueJob(meta.id, "render").id });
});

export default router;
