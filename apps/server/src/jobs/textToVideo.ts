import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../config.js";
import { createChildProject, prepareEditSession } from "../childProject.js";
import { normOutput, readMeta, writeMeta } from "../meta.js";
import { runAgent } from "../agent.js";
import { transcribeVideo } from "../transcribe.js";
import { synthScript } from "../tts.js";
import {
  patchTextToVideo,
  readTextToVideo,
  scriptTextOf,
  textToVideoDirOf,
  type TextToVideoMeta,
} from "../textToVideoMeta.js";
import { ensureDir, toRepoRel } from "../util.js";
import type { JobCtx } from "../queue.js";

/**
 * Job "text-to-video": kịch bản đọc → giọng nói → transcript → Videos Project.
 *
 * NGUYÊN TẮC: job này KHÔNG dựng video. Nó chỉ lo phần nguyên liệu, rồi bàn
 * giao cho đúng pipeline của Videos Project (createChildProject →
 * prepareEditSession → runAgent). Mọi thứ sau bước bàn giao - HyperFrames,
 * Remotion, Style Design, ảnh minh họa, phụ đề - là code cũ, không đụng tới.
 *
 * Đây cũng là lý do không có job render riêng cho text-to-video: thêm một
 * đường dựng video thứ hai là chắc chắn hai đường trôi lệch nhau theo thời gian.
 */

/** Số job con tối đa - chặn vòng lặp nếu kịch bản rỗng lọt qua kiểm tra */
const MIN_SCRIPT_CHARS = 80;

export async function runTextToVideo(ctx: JobCtx): Promise<void> {
  // Queue nhét id phiên vào projectId (giống auto-cut) - xem busyKeyOf
  const id = ctx.job.projectId;
  const meta = readTextToVideo(id);

  try {
    await build(ctx, meta);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Hủy job không phải lỗi: trả về trạng thái sửa được thay vì "failed"
    if (ctx.isCanceled()) {
      patchTextToVideo(id, { status: "ready", error: null });
    } else {
      patchTextToVideo(id, { status: "failed", error: message });
    }
    throw err;
  }
}

async function build(ctx: JobCtx, meta: TextToVideoMeta): Promise<void> {
  const id = meta.id;
  const dir = textToVideoDirOf(id);
  const script = scriptTextOf(meta).trim();

  if (script.length < MIN_SCRIPT_CHARS) {
    throw new Error(
      `Kịch bản đọc quá ngắn (${script.length} ký tự) - viết kịch bản trước khi dựng video.`,
    );
  }
  if (meta.projectId) {
    throw new Error(
      `Phiên này đã tạo project "${meta.projectId}" rồi - xóa project đó hoặc tạo phiên mới.`,
    );
  }

  // ---- 1. Tổng hợp giọng đọc -----------------------------------------------
  patchTextToVideo(id, { status: "voicing", error: null });
  ctx.progress(2, "Tổng hợp giọng đọc");

  const voiceDir = path.join(dir, "voice");
  ensureDir(voiceDir);
  const wavAbs = path.join(dir, "voice.wav");

  const chunks = meta.script.map((c) => c.text.trim()).filter(Boolean);
  const synth = await synthScript({
    chunks,
    engine: meta.voice.engine,
    speed: meta.voice.speed,
    voice: meta.voice.name,
    model: meta.voice.model,
    style: meta.voice.style,
    language: meta.voice.language,
    workDir: voiceDir,
    outWavAbs: wavAbs,
    onProgress: (done, total) => {
      // Đọc giọng chiếm ~45% job; phần còn lại là whisper + bàn giao
      ctx.progress(2 + Math.round((done / Math.max(1, total)) * 43), `Đọc đoạn ${done}/${total}`);
    },
    onLog: (line) => ctx.log(line),
    isCanceled: () => ctx.isCanceled(),
  });
  if (ctx.isCanceled()) throw new Error("Job đã bị hủy");

  // Thời lượng ĐO ĐƯỢC, không phải ước lượng: cùng một câu, API trả về audio
  // lệch nhau tới 28% giữa các lần gọi
  ctx.log(`[tts] giọng đọc dài ${synth.durationSec.toFixed(2)}s`);
  const scriptWithDurations = meta.script.map((c, i) => ({
    ...c,
    durationSec: synth.chunkDurations[i] ?? null,
  }));
  patchTextToVideo(id, {
    voiceFile: toRepoRel(wavAbs),
    voiceDurationSec: synth.durationSec,
    script: scriptWithDurations,
  });

  // ---- 2. Transcript có word timestamp -------------------------------------
  // Chạy whisper trên chính file giọng vừa tổng hợp thay vì tự suy mốc thời gian
  // từ độ dài từng đoạn: phụ đề karaoke, zoom theo nhịp và sound effect đều bám
  // vào mốc TỪNG TỪ, mà TTS không trả về mốc nào.
  ctx.progress(48, "Lấy mốc thời gian từng từ");
  const transcriptAbs = path.join(dir, "transcript.json");
  await transcribeVideo({
    videoAbs: wavAbs,
    outJsonAbs: transcriptAbs,
    language: "vi",
    onLog: (line) => ctx.log(line),
    isCanceled: () => ctx.isCanceled(),
  });
  if (ctx.isCanceled()) throw new Error("Job đã bị hủy");
  patchTextToVideo(id, { transcriptFile: toRepoRel(transcriptAbs) });

  // ---- 3. Bàn giao cho pipeline Videos Project ------------------------------
  ctx.progress(72, "Tạo Videos Project");
  patchTextToVideo(id, { status: "building" });

  const fresh = readTextToVideo(id);
  const summary = createChildProject({
    parentId: null,
    name: fresh.name,
    width: fresh.output.width,
    height: fresh.output.height,
    fps: fresh.output.fps,
    brief: {
      ...fresh.brief,
      styleId: fresh.output.styleId,
      // autoCut cắt khoảng lặng và từ đệm của NGƯỜI NÓI THẬT. Giọng tổng hợp
      // không có mấy thứ đó - bật lên là AI đi cắt vào bản đọc vốn đã sạch.
      autoCut: false,
      sourceDescription: sourceDescriptionOf(fresh),
      notes: [briefNotesOf(fresh), fresh.brief.notes.trim()].filter(Boolean).join("\n\n"),
    },
    copyFiles: [
      { srcAbs: wavAbs, destRel: "voice.wav" },
      { srcAbs: transcriptAbs, destRel: "transcript.json" },
    ],
  });

  // Gắn sẵn giọng đọc vào khối audio - Remotion phát nó từ frame 0. Không gắn
  // thì agent phải tự đoán file nào là giọng chính.
  const projectMeta = readMeta(summary.id);
  projectMeta.audio = {
    ...(projectMeta.audio ?? { voice: null, sfx: [] }),
    // Tính từ thư mục PROJECT (assemble.ts stage() nối với projectDir) - viết
    // từ repo root là thành video-projects/<id>/video-projects/<id>/... và mọi
    // job lắp ráp chết vì "Thiếu asset"
    voice: "assets/voice.wav",
  };
  // Liên kết NGƯỢC về phiên Text to video. Không có nó thì nhìn danh sách
  // Videos Project chỉ thấy một project lạ mọc ra, không biết từ đâu.
  projectMeta.textToVideoId = id;
  writeMeta(summary.id, projectMeta);

  // "editing" chứ KHÔNG phải "done": tới đây mới chỉ xong phần nguyên liệu,
  // việc dựng video thật sự bắt đầu ở dòng dưới và còn chạy hàng chục phút.
  patchTextToVideo(id, { projectId: summary.id, status: "editing", error: null });
  ctx.log(`[text-to-video] đã tạo project "${summary.id}"`);

  // ---- 4. Khởi động phiên edit AI ------------------------------------------
  ctx.progress(88, "Bắt đầu edit bằng AI");
  const session = prepareEditSession({ id: summary.id, meta: readMeta(summary.id) });
  // KHÔNG await: phiên agent chạy hàng chục phút, giữ job trong queue suốt thời
  // gian đó sẽ chặn mọi job khác. Tiến trình theo dõi qua SSE kênh `agent`.
  void runAgent(session.sessionId, session.prompt)
    .then(() => {
      // Phiên agent kết thúc KHÔNG đồng nghĩa có video: agent.ts chỉ gate
      // goal='final', mà nó vẫn có thể dừng giữa chừng. Nguồn sự thật duy nhất
      // là file output trong meta của project con.
      const done = Boolean(normOutput(readMeta(summary.id).output));
      patchTextToVideo(id, {
        status: done ? "done" : "editing",
        error: done ? null : null,
      });
      ctx.log(`[text-to-video] phiên edit kết thúc - có video final: ${done ? "có" : "chưa"}`);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      patchTextToVideo(id, { status: "failed", error: `Phiên edit lỗi: ${message}` });
      ctx.log(`[text-to-video] phiên edit lỗi: ${message}`);
    });
  // Job của HÀNG ĐỢI xong ở đây; phần dựng video chạy tiếp ở phiên agent nền.
  ctx.progress(100, "Đã bàn giao cho AI dựng video");
}

/** Mô tả nguồn cho AI: nó cần biết đây là giọng tổng hợp, không phải người quay */
function sourceDescriptionOf(meta: TextToVideoMeta): string {
  const from =
    meta.source.kind === "url" && meta.article
      ? `bài viết "${meta.article.title}"${meta.article.siteName ? ` (${meta.article.siteName})` : ""}`
      : "đoạn văn người dùng cung cấp";
  return (
    `Video dựng từ ${from}. Không có footage quay sẵn: nguồn duy nhất là file ` +
    `assets/voice.wav - giọng đọc tổng hợp bằng AI, kèm assets/transcript.json ` +
    `có mốc thời gian từng từ.`
  );
}

/**
 * Ghi chú bổ sung vào brief. Nói rõ hai ràng buộc mà pipeline sẽ gãy nếu agent
 * làm sai - đây là kiến thức nằm trong code Remotion chứ không có trong skill nào.
 */
function briefNotesOf(meta: TextToVideoMeta): string {
  const secs = meta.voiceDurationSec ? meta.voiceDurationSec.toFixed(1) : "?";
  return [
    `Giọng đọc dài ${secs} giây (đã đo bằng ffprobe) và đã được gắn sẵn vào meta.audio.voice.`,
    "Tổng thời lượng video phải bám theo giọng đọc này.",
    "",
    "BẮT BUỘC vì không có scene video nguồn:",
    "- Mọi scene phải khai durationInFrames. Remotion chỉ tự suy thời lượng cho",
    "  scene srcVideo có from/to; scene ảnh hoặc HyperFrames mà thiếu là render ném lỗi.",
    // Câu này TỪNG viết cứng "lấy từ ảnh minh họa AI" bất kể công tắc: phiên Text
    // to video tắt ảnh minh họa vẫn nhận được một ghi chú bảo đi sinh ảnh Gemini.
    // Ghi chú của job KHÔNG được mâu thuẫn với brief mà chính nó đang bàn giao.
    meta.brief.autoIllustrations
      ? "- Hình ảnh lấy từ ảnh minh họa AI (POST /api/illustrations) hoặc scene\n" +
        "  HyperFrames tự dựng - không có footage để cắt."
      : "- Ảnh minh họa AI đang TẮT và không có footage: MỌI hình ảnh phải do scene\n" +
        "  HyperFrames tự dựng (typography, đồ họa, hình khối, chuyển động).\n" +
        "  KHÔNG gọi /api/illustrations - server sẽ từ chối.",
  ].join("\n");
}
