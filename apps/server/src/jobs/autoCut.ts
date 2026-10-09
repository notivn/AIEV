import fs from "node:fs";
import path from "node:path";
import { runAgent } from "../agent.js";
import {
  autoCutDirOf,
  briefOfAutoCut,
  patchAutoCut,
  readAutoCut,
  targetSizeOf,
  writeAutoCut,
  type AutoCutLayout,
  type AutoCutMeta,
  type AutoCutSegment,
} from "../autoCutMeta.js";
import { planAutoCutSegments } from "../autoCutPlan.js";
import { createChildProject, prepareEditSession, sceneAssetPath } from "../childProject.js";
import { repoRoot } from "../config.js";
import { geminiApiKey, generateBackground } from "../gemini.js";
import type { ImageAspect } from "../imageMeta.js";
import { projectAssetsDirOf, readMeta } from "../meta.js";
import type { JobCtx } from "../queue.js";
import {
  chooseEncoder,
  classifyFrame,
  detectSubjectOverRange,
  probeVideo,
  runCutReframe,
  sameAspect,
  type ReframeLayout,
} from "../reframe.js";
import { getStyle } from "../styles.js";
import { parseTranscriptJson, type TranscriptSegment } from "../transcript.js";
import { transcribeVideo } from "../transcribe.js";
import { ensureDir, toKebabAscii, toRepoRel } from "../util.js";

/**
 * Job "auto-cut" - cắt video dài thành nhiều video ngắn rồi tự tạo Videos Project.
 * `job.projectId` là id phiên cắt (auto-cut/<id>), `job.sceneId` là step:
 *  - "plan": transcribe (nếu cần) + chọn đoạn -> ghi segments vào meta
 *  - "cut" : cắt + đổi khung + tạo project con cho từng đoạn đã chọn
 *
 * VÌ SAO tách hai bước: bước plan rẻ (đọc chữ), bước cut đắt (encode từng đoạn +
 * gọi vision). Người dùng phải DUYỆT danh sách đoạn trước khi tốn thời gian cắt.
 */
export async function runAutoCut(ctx: JobCtx): Promise<void> {
  const id = ctx.job.projectId;
  const step = ctx.job.sceneId === "cut" ? "cut" : "plan";
  try {
    if (step === "cut") await stepCut(ctx, id);
    else await stepPlan(ctx, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      // Người dùng tự bấm hủy KHÔNG phải lỗi: đưa phiên về trạng thái chạy lại
      // được (chưa có đoạn -> draft, có rồi -> planned) và không hiện banner đỏ.
      if (ctx.isCanceled()) {
        const cur = readAutoCut(id);
        patchAutoCut(id, {
          status: cur.segments.length > 0 ? "planned" : "draft",
          error: null,
          failedStep: null,
        });
      } else {
        // Ghi rõ BƯỚC hỏng: route /cut chỉ cho cắt lại phiên failed khi lỗi
        // xảy ra ở bước cut (kế hoạch còn nguyên giá trị) - re-plan hỏng thì
        // segments trong meta là kế hoạch CŨ, không được cắt theo nó.
        patchAutoCut(id, { status: "failed", error: message, failedStep: step });
      }
    } catch {
      /* phiên cắt có thể đã bị xóa giữa chừng - vẫn phải ném lỗi gốc ra queue */
    }
    throw err;
  }
}

// ================================================================== Step "plan"

async function stepPlan(ctx: JobCtx, id: string): Promise<void> {
  // Bắt đầu lượt chạy mới là xóa dấu vết lỗi cũ (failedStep chỉ có nghĩa khi
  // status = failed; giữ nó lại sẽ làm route /cut hiểu nhầm ở lần lỗi sau)
  let meta = patchAutoCut(id, { status: "planning", error: null, failedStep: null });
  const dir = autoCutDirOf(id);
  ensureDir(dir);

  const videoAbs = sourceVideoAbs(meta);
  ctx.log(`[plan] Nguồn: ${meta.source.relPath} (${meta.source.width}x${meta.source.height})`);

  // ---- 1. Transcript (mode ai/prompt bắt buộc, mode time tùy chọn) ----
  let transcriptAbs: string | null = null;
  if (meta.transcribe) {
    const outJson = path.join(dir, "transcript.json");
    if (fs.existsSync(outJson) && fs.statSync(outJson).size > 0) {
      // Chạy lại bước plan (đổi mode/params) không nên transcribe lại - rất tốn thời gian
      ctx.log("[plan] Đã có transcript.json từ lần chạy trước - dùng lại.");
      transcriptAbs = outJson;
      ctx.progress(60, "Dùng lại transcript có sẵn");
    } else {
      ctx.progress(5, "Transcribe video nguồn");
      const res = await transcribeVideo({
        videoAbs,
        outJsonAbs: outJson,
        language: "vi",
        onLog: (line) => ctx.log(line),
        // Không truyền thì hủy job xong whisper vẫn chạy tiếp và ăn GPU
        isCanceled: () => ctx.isCanceled(),
      });
      transcriptAbs = outJson;
      ctx.log(
        `[plan] Transcript: ${res.segments} đoạn, ${res.durationSec.toFixed(1)}s, ngôn ngữ ${res.language}`,
      );
      ctx.progress(60, "Đã có transcript");
    }
    meta = patchAutoCut(id, { transcriptRel: toRepoRel(outJson) });
  } else if (meta.transcriptRel) {
    // Không bật transcribe nhưng phiên đã có transcript cũ - vẫn dùng để chọn đoạn
    const abs = path.join(repoRoot, meta.transcriptRel);
    if (fs.existsSync(abs)) transcriptAbs = abs;
    ctx.progress(60, "Dùng transcript có sẵn");
  } else {
    ctx.progress(60, "Bỏ qua transcribe");
  }

  // ---- 2. Chọn đoạn ----
  ctx.progress(65, "Chọn đoạn cắt");
  const segments = await planAutoCutSegments({
    meta,
    transcriptAbs,
    onLog: (line) => ctx.log(line),
  });
  ctx.progress(95, "Ghi danh sách đoạn");

  const clean = segments.map((s, i) => ({ ...s, index: Number.isInteger(s.index) ? s.index : i }));
  if (clean.length === 0) {
    // Vẫn coi là "planned": người dùng thấy danh sách rỗng và tự đổi mode/params rồi chạy lại
    ctx.log(
      "[plan] Không chọn được đoạn nào (video quá ngắn, transcript rỗng hoặc yêu cầu quá hẹp). " +
        "Đổi chế độ/tham số rồi chạy lại bước chọn đoạn.",
    );
  } else {
    for (const s of clean) {
      ctx.log(`[plan] #${s.index} ${fmt(s.start)}-${fmt(s.end)} "${s.title}"`);
    }
  }

  patchAutoCut(id, { segments: clean, status: "planned", error: null, failedStep: null });
  ctx.progress(100, `Đã chọn ${clean.length} đoạn`);
}

// ================================================================== Step "cut"

async function stepCut(ctx: JobCtx, id: string): Promise<void> {
  // Xóa dấu vết lỗi cũ khi bắt đầu cắt - lượt này thành/bại sẽ tự ghi lại
  let meta = patchAutoCut(id, { status: "cutting", error: null, failedStep: null });
  const dir = autoCutDirOf(id);
  const segDir = path.join(dir, "segments");
  ensureDir(segDir);

  const videoAbs = sourceVideoAbs(meta);
  const target = targetSizeOf(meta.output.aspect, meta.source);
  const outFps = pickFps(meta);
  // Cấu hình edit chung của phiên - phiên cũ chưa có field này thì về default
  const sessionBrief = briefOfAutoCut(meta);

  // Chỉ cắt đoạn được tích chọn và CHƯA có project con (chạy lại là cắt tiếp phần dở)
  const todo = meta.segments.filter((s) => s.selected !== false && !s.projectId);
  const already = meta.segments.filter((s) => s.projectId).length;
  if (todo.length === 0) {
    ctx.log(
      already > 0
        ? `[cut] Mọi đoạn đã chọn đều có project con rồi (${already} đoạn) - không có gì để cắt.`
        : "[cut] Không có đoạn nào được chọn - hãy tích chọn đoạn rồi chạy lại.",
    );
    patchAutoCut(id, { status: "done", error: null, failedStep: null });
    return;
  }

  // Kích thước thật của nguồn (đã áp cờ xoay) - meta.source có thể ghi từ lúc tạo phiên,
  // nhưng probe lại cho chắc: mọi phép tính crop/fit phụ thuộc con số này.
  const probe = await probeVideo(videoAbs);
  const source = { width: probe.width, height: probe.height };
  ctx.log(
    `[cut] Nguồn ${source.width}x${source.height} @${probe.fps.toFixed(2)}fps` +
      `${probe.rotation ? ` (rotation ${probe.rotation}°, đã hoán đổi W/H)` : ""} -> ` +
      `${target.width}x${target.height} @${outFps.toFixed(2)}fps`,
  );

  const noReframe = sameAspect(source, target);
  if (noReframe) {
    ctx.log("[cut] Tỉ lệ nguồn trùng tỉ lệ đích - chỉ cắt, không đổi khung (bỏ qua vision).");
  }

  const apiKey = geminiApiKey();
  const encoder = await chooseEncoder();
  ctx.log(`[cut] Encoder: ${encoder === "nvenc" ? "h264_nvenc (GPU)" : "libx264 (CPU)"}`);

  // ---- Nền dùng chung cho layout fit ----
  const backgroundAbs = await prepareBackground(ctx, meta, target, noReframe);

  // ---- Cắt từng đoạn (tuần tự - encode song song chỉ làm chậm nhau) ----
  const createdIds: string[] = [];
  for (let i = 0; i < todo.length; i++) {
    if (ctx.isCanceled()) {
      ctx.log(`[cut] Job bị hủy - giữ nguyên ${createdIds.length} đoạn đã xong.`);
      patchAutoCut(id, { status: "planned", error: null, failedStep: null });
      return;
    }
    const seg = todo[i];
    const base = 10 + (85 * i) / todo.length;
    ctx.progress(base, `Đoạn ${i + 1}/${todo.length}: ${seg.title}`);

    // a. Layout thật cho đoạn này
    const layout = await resolveLayout(ctx, {
      configured: meta.output.layout,
      noReframe,
      videoAbs,
      atSec: (seg.start + seg.end) / 2,
      apiKey,
    });

    // b. Tâm chủ thể - chỉ crop mới cần (fit không cắt gì nên không cần biết tâm)
    let center: { x: number; y: number } | null = null;
    if (layout === "crop" && !noReframe) {
      const found = await detectSubjectOverRange({
        videoAbs,
        start: seg.start,
        end: seg.end,
        apiKey,
        onLog: (line) => ctx.log(line),
      });
      center = { x: found.centerX, y: found.centerY };
      ctx.log(
        `[cut] #${seg.index} tâm chủ thể ${found.found ? "" : "(mặc định) "}` +
          `x=${center.x.toFixed(3)} y=${center.y.toFixed(3)}`,
      );
    }

    // c. Cắt + reframe ra file tạm
    const fileName = segmentFileName(seg);
    const cutAbs = path.join(segDir, fileName);
    ctx.progress(base + 20 / todo.length, `Cắt đoạn ${i + 1}/${todo.length}`);
    const usedEncoder = await runCutReframe(
      {
        srcAbs: videoAbs,
        outAbs: cutAbs,
        start: seg.start,
        end: seg.end,
        source,
        target,
        layout,
        center,
        backgroundKind: meta.output.background,
        backgroundAbs,
        backgroundColor: getStyle(meta.output.styleId).colors.background,
        encoder,
        fps: outFps,
      },
      {
        exec: (file, args) => ctx.exec(file, args, repoRoot),
        log: (line) => ctx.log(line),
      },
    );
    if (!fs.existsSync(cutAbs)) {
      throw new Error(`ffmpeg chạy xong nhưng không thấy file cắt "${fileName}"`);
    }
    ctx.log(
      `[cut] #${seg.index} ${fmt(seg.start)}-${fmt(seg.end)} layout=${layout} ` +
        `encoder=${usedEncoder} -> ${fileName}`,
    );

    // d. Tạo project con mang sẵn file đã cắt
    ctx.progress(base + 50 / todo.length, `Tạo project cho đoạn ${i + 1}/${todo.length}`);
    const child = createChildProject({
      // parentId null: nguồn là FILE RỜI (imports/), không phải project nào cả
      parentId: null,
      name: `${meta.name} - ${seg.title}`.slice(0, 120),
      width: target.width,
      height: target.height,
      fps: Math.max(1, Math.round(outFps)),
      copyFiles: [{ srcAbs: cutAbs, destRel: fileName }],
      // KHÔNG đặt from/to: file đã cắt sẵn đúng khoảng, đặt thêm sẽ cắt chồng lần hai
      scenes: [{ id: "src", srcVideo: sceneAssetPath(fileName) }],
      brief: {
        // Cấu hình edit người dùng đặt cho cả phiên (phụ đề, highlight, bố cục key,
        // sound effect, nhạc nền, ảnh minh họa, skill...) - nhờ vậy project con
        // edit được ngay, không phải vào từng cái chỉnh lại.
        ...sessionBrief,
        // Ba field dưới đây phụ thuộc TỪNG ĐOẠN nên luôn ghi đè cấu hình chung
        styleId: meta.output.styleId,
        sourceDescription:
          `Đoạn ${fmt(seg.start)}-${fmt(seg.end)} giây cắt ra từ video nguồn ` +
          `"${meta.source.relPath}" (phiên Auto cut "${meta.name}"). ` +
          `File trong assets/ ĐÃ được cắt sẵn đúng khoảng này và đã đổi khung về ` +
          `${target.width}x${target.height} (${layout === "crop" ? "cúp bám chủ thể" : "thu nhỏ + nền"}).` +
          (seg.reason ? ` Lý do chọn: ${seg.reason}` : ""),
        // User đặt key chung cho cả loạt thì tôn trọng, để trống thì lấy tiêu đề đoạn
        mainKey: sessionBrief.mainKey.trim() || seg.title,
        // Hướng dẫn bắt buộc về file đã cắt sẵn phải đứng TRƯỚC, ghi chú của user nối sau
        notes: [childNotes(seg, fileName, target, layout, sessionBrief.autoCut), sessionBrief.notes.trim()]
          .filter(Boolean)
          .join("\n\n"),
      },
    });
    createdIds.push(child.id);

    // e. Transcript riêng của đoạn (mốc giây đã quy về 0) - điều kiện để project con
    //    dùng được ngay phụ đề/QC/gói xuất bản mà không phải transcribe lại
    writeChildTranscript(ctx, meta, child.id, seg);

    // f. Ghi kết quả NGAY sau mỗi đoạn - job bị hủy giữa chừng vẫn giữ được phần đã xong
    const fresh = readAutoCut(id);
    const row = fresh.segments.find((s) => s.index === seg.index);
    if (row) {
      row.projectId = child.id;
      row.appliedLayout = layout;
    }
    writeAutoCut(fresh);
    meta = fresh;

    // g. File cắt đã nằm trong project con - bản trong segments/ chỉ còn là rác
    try {
      fs.rmSync(cutAbs, { force: true });
    } catch {
      /* xóa không được thì thôi - không đáng làm hỏng job */
    }
    ctx.log(`[cut] #${seg.index} -> project "${child.id}"`);
  }

  // ---- Phiên edit AI (tùy chọn) ----
  if (meta.autoEdit && createdIds.length > 0) {
    startAutoEdits(ctx, createdIds);
  }

  ctx.progress(100, `Đã tạo ${createdIds.length} project`);
  patchAutoCut(id, { status: "done", error: null, failedStep: null });
}

// ================================================================== Trợ giúp

/** Đường dẫn tuyệt đối video nguồn, ném lỗi rõ nếu file đã bị xóa/di chuyển */
function sourceVideoAbs(meta: AutoCutMeta): string {
  const abs = path.join(repoRoot, meta.source.relPath);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `Không thấy video nguồn "${meta.source.relPath}" - file đã bị xóa hoặc di chuyển khỏi repo.`,
    );
  }
  return abs;
}

/** fps đầu ra: người dùng chọn, không thì giữ theo nguồn (chặn số vô lý) */
function pickFps(meta: AutoCutMeta): number {
  const wanted = meta.output.fps ?? meta.source.fps;
  return Number.isFinite(wanted) && wanted > 0 ? Math.min(120, wanted) : 30;
}

/**
 * Layout thật cho một đoạn.
 * - Tỉ lệ đã trùng nhau -> "crop" (khung cắt bằng đúng khung nguồn, chỉ scale).
 * - Người dùng chọn cứng crop/fit -> theo đúng lựa chọn, không hỏi Gemini (đỡ tốn gọi API).
 * - "auto" -> hỏi Gemini: người thì crop (mặt to), màn hình/chữ thì fit (không mất chữ).
 */
async function resolveLayout(
  ctx: JobCtx,
  input: {
    configured: AutoCutLayout;
    noReframe: boolean;
    videoAbs: string;
    atSec: number;
    apiKey: string | null;
  },
): Promise<ReframeLayout> {
  if (input.noReframe) return "crop";
  if (input.configured !== "auto") return input.configured;
  const kind = await classifyFrame({
    videoAbs: input.videoAbs,
    atSec: input.atSec,
    apiKey: input.apiKey,
  });
  const layout: ReframeLayout = kind === "person" ? "crop" : "fit";
  ctx.log(`[cut] Gemini phân loại khung: ${kind} -> layout ${layout}`);
  return layout;
}

/**
 * Nền dùng chung cho cả phiên (chỉ layout fit mới dùng).
 * VÌ SAO một ảnh cho cả phiên: các đoạn cùng ra từ một video, nền khác nhau
 * từng đoạn sẽ làm bộ short mất tính nhận diện - lại tốn thêm tiền API.
 * Lỗi Gemini KHÔNG được dừng job: rơi về nền mờ từ chính video.
 */
async function prepareBackground(
  ctx: JobCtx,
  meta: AutoCutMeta,
  target: { width: number; height: number },
  noReframe: boolean,
): Promise<string | null> {
  if (noReframe) return null;
  if (meta.output.background !== "gemini") return null;
  // Người dùng ép "crop" thì không đoạn nào dùng nền - khỏi tốn một lần gọi Gemini
  if (meta.output.layout === "crop") {
    ctx.log("[cut] Layout crop nên không cần nền - bỏ qua tạo nền Gemini.");
    return null;
  }
  if (!geminiApiKey()) {
    ctx.log("[warn] Chưa có GEMINI_API_KEY - dùng nền mờ từ chính video thay cho nền Gemini.");
    return null;
  }

  const outFile = path.join(autoCutDirOf(meta.id), "background.png");
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
    ctx.log("[cut] Dùng lại background.png đã tạo ở lần chạy trước.");
    return outFile;
  }

  ctx.progress(5, "Gemini tạo ảnh nền");
  try {
    await generateBackground({
      prompt:
        "A calm, non-distracting backdrop for a talking-head video clip that will be placed in the middle of the frame. " +
        "Keep the central band simple and low contrast so the video on top stays the focus.",
      kind: "background",
      aspect: imageAspectOf(target),
      design: getStyle(meta.output.styleId),
      outFile,
      usageProjectId: meta.id,
      allowText: false, // nền tuyệt đối không có chữ - chữ do project con đặt sau
    });
    ctx.log(`[cut] Đã tạo nền Gemini: ${toRepoRel(outFile)}`);
    return outFile;
  } catch (err) {
    ctx.log(
      `[warn] Tạo nền Gemini thất bại (${err instanceof Error ? err.message : String(err)}) - ` +
        "rơi về nền mờ từ chính video.",
    );
    return null;
  }
}

/** Tỉ lệ ảnh Gemini gần nhất với khung đích (Gemini chỉ nhận 4 tỉ lệ này) */
function imageAspectOf(target: { width: number; height: number }): ImageAspect {
  const ratio = target.width / target.height;
  const options: Array<[ImageAspect, number]> = [
    ["9:16", 9 / 16],
    ["4:5", 4 / 5],
    ["1:1", 1],
    ["16:9", 16 / 9],
  ];
  let best = options[0];
  for (const opt of options) {
    if (Math.abs(opt[1] - ratio) < Math.abs(best[1] - ratio)) best = opt;
  }
  return best[0];
}

/** Tên file đoạn: "<index 2 chữ số>-<slug tiêu đề>.mp4" (ASCII, an toàn mọi FS) */
function segmentFileName(seg: AutoCutSegment): string {
  const slug = toKebabAscii(seg.title).slice(0, 40).replace(/-+$/, "");
  return `${String(seg.index).padStart(2, "0")}-${slug || "doan"}.mp4`;
}

/** Ghi chú brief cho project con - nói rõ file đã cắt sẵn để AI không cắt lần hai */
function childNotes(
  seg: AutoCutSegment,
  fileName: string,
  target: { width: number; height: number },
  layout: ReframeLayout,
  autoCut: boolean,
): string {
  const lines = [
    "## Đoạn cắt tự động (Auto cut videos)",
    `- File \`${sceneAssetPath(fileName)}\` ĐÃ được cắt đúng khoảng ${fmt(seg.start)}-${fmt(seg.end)} giây ` +
      "của video gốc và ĐÃ đổi về khung " +
      `${target.width}x${target.height}. Dùng TRỌN file này, TUYỆT ĐỐI không đặt thêm \`from\`/\`to\` ` +
      "để cắt lần nữa (sẽ mất phần đầu/cuối).",
    `- Khung đã xử lý theo kiểu \`${layout}\` (${
      layout === "crop" ? "cúp bám chủ thể, chủ thể đã ở giữa khung" : "thu nhỏ giữ trọn hình + nền lấp"
    }) - không cần crop/scale lại.`,
    "- `assets/transcript.json` là transcript RIÊNG của đoạn này, mốc giây đã quy về 0 " +
      "(0 = đầu video ngắn)" +
      // Brief con thừa hưởng công tắc autoCut của phiên: BẬT thì bước cắt khoảng
      // lặng dời mốc thời gian, nói "dùng thẳng" là mâu thuẫn với chính brief đó
      (autoCut
        ? " - đây là bản GỐC trước bước tự động cắt; cắt xong thì phụ đề/karaoke phải theo " +
          "`assets/transcript.cut.json` như mục Tự động cắt hướng dẫn."
        : " - dùng thẳng cho phụ đề/karaoke, không phải trừ gì thêm."),
    `- Đây là video NGẮN (${target.width}x${target.height}): nhịp nhanh, chữ to, mọi thông tin nằm trong vùng an toàn.`,
  ];
  if (seg.hook) lines.push(`- Mở đầu video là hook: "${seg.hook}".`);
  if (seg.reason) lines.push(`- Lý do đoạn này được chọn: ${seg.reason}`);
  return lines.join("\n");
}

/**
 * Cắt transcript của phiên theo khoảng của đoạn rồi ghi vào assets/transcript.json
 * của project con, TRỪ ĐI `start` để mốc thời gian về gốc 0 (kể cả `words` bên trong).
 * Không có transcript thì bỏ qua - project con vẫn dựng được, chỉ là phải tự transcribe.
 */
function writeChildTranscript(
  ctx: JobCtx,
  meta: AutoCutMeta,
  childId: string,
  seg: AutoCutSegment,
): void {
  const rel = meta.transcriptRel;
  if (!rel) return;
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return;

  let all: TranscriptSegment[] | null = null;
  try {
    all = parseTranscriptJson(JSON.parse(fs.readFileSync(abs, "utf8")));
  } catch {
    all = null;
  }
  if (!all || all.length === 0) {
    ctx.log(`[warn] Transcript phiên không đọc được - project "${childId}" chưa có phụ đề.`);
    return;
  }

  const span = seg.end - seg.start;
  const shifted: TranscriptSegment[] = all
    .filter((s) => s.end > seg.start && s.start < seg.end)
    .map((s) => ({
      start: round3(clampRange(s.start - seg.start, 0, span)),
      end: round3(clampRange(s.end - seg.start, 0, span)),
      text: s.text,
      words: (s.words ?? [])
        .filter((w) => w.end > seg.start && w.start < seg.end)
        .map((w) => ({
          word: w.word,
          start: round3(clampRange(w.start - seg.start, 0, span)),
          end: round3(clampRange(w.end - seg.start, 0, span)),
        })),
    }));

  const dest = path.join(projectAssetsDirOf(childId), "transcript.json");
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, JSON.stringify({ segments: shifted }, null, 2) + "\n", "utf8");
  ctx.log(`[cut] Transcript đoạn: ${shifted.length} câu -> ${toRepoRel(dest)}`);
}

/** Tối đa 3 project con được tự edit mỗi lần - mỗi phiên agent rất nặng máy */
const MAX_AUTO_EDIT = 3;

/**
 * Mở phiên edit AI cho project con, chạy TUẦN TỰ ở nền (không await): một phiên
 * edit kéo dài hàng chục phút, giữ slot của render queue suốt thời gian đó sẽ
 * chặn mọi job khác. Đúng cách routes/clips.ts đang làm cho "cắt short".
 */
function startAutoEdits(ctx: JobCtx, childIds: string[]): void {
  const picked = childIds.slice(0, MAX_AUTO_EDIT);
  const tasks = picked.map((childId) =>
    prepareEditSession({ id: childId, meta: readMeta(childId) }),
  );
  const rest = childIds.length - picked.length;
  ctx.log(
    `[cut] Mở ${tasks.length} phiên edit AI (chạy nền, tuần tự).` +
      (rest > 0
        ? ` ${rest} project còn lại không tự edit (tối đa ${MAX_AUTO_EDIT} mỗi lần vì mỗi phiên rất nặng máy) - ` +
          'hãy bấm "Edit bằng AI" khi cần.'
        : ""),
  );
  void (async () => {
    for (const t of tasks) {
      try {
        await runAgent(t.sessionId, t.prompt);
      } catch {
        /* lỗi phiên này không được chặn phiên kế tiếp - agent.ts đã ghi log/SSE */
      }
    }
  })();
}

function clampRange(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function fmt(sec: number): string {
  return (Math.round(sec * 100) / 100).toString();
}
