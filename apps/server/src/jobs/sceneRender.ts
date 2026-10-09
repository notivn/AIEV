import fs from "node:fs";
import path from "node:path";
import { updateJob } from "../db.js";
import type { JobCtx } from "../queue.js";
import { projectDirOf, readMeta, type SceneMeta } from "../meta.js";
import { ensureDir, hyperframesCli } from "../util.js";
import { hyperframesSpeedArgs } from "../renderSettings.js";
import { parseProgressLine } from "./progress.js";

/**
 * Job scene-draft | scene-final - render scene HyperFrames.
 * cwd = video-projects/<projectId>.
 *   draft : npx hyperframes render <src> --quality draft    --output renders/<sceneId>.draft.mp4
 *   final : npx hyperframes render <src> --quality standard --output renders/<sceneId>.mp4
 * Chạy cho mọi scene có `src` trong meta.json, hoặc riêng scene nếu job có sceneId.
 *
 * Render vào file TẠM (renders/.tmp/) rồi mới thay file đích bằng rename khi
 * thành công. hyperframes xóa/ghi đè file `--output` ngay lúc bắt đầu, nên
 * render thẳng vào đích thì một lượt hỏng/bị hủy để lại scene KHÔNG còn bản
 * xem trước nào (trình chỉnh sửa hiện khung trống, assemble thiếu scene) - mất
 * luôn bản cũ đang dùng tốt.
 */
export async function runSceneRender(ctx: JobCtx): Promise<void> {
  const { projectId, type, sceneId } = ctx.job;
  const draft = type === "scene-draft";
  const projectDir = projectDirOf(projectId);
  const meta = readMeta(projectId);

  let scenes: SceneMeta[] = (meta.scenes ?? []).filter(
    (s): s is SceneMeta => typeof s.src === "string" && s.src.length > 0,
  );
  if (sceneId) {
    scenes = scenes.filter((s) => s.id === sceneId);
    if (!scenes.length) {
      throw new Error(`Không tìm thấy scene "${sceneId}" có \`src\` trong meta.json`);
    }
  }
  if (!scenes.length) {
    throw new Error("meta.json không có scene nào có `src` để render");
  }

  ensureDir(path.join(projectDir, "renders"));

  const total = scenes.length;
  let lastOutputRel = "";

  for (let i = 0; i < total; i++) {
    const scene = scenes[i];
    if (ctx.isCanceled()) return;

    // Đích ghi tôn trọng scene.render nếu meta khai - khớp logic assemble.ts đọc ưu tiên scene.render
    const finalRel =
      typeof scene.render === "string" && scene.render ? scene.render : `renders/${scene.id}.mp4`;
    const outRel = draft ? finalRel.replace(/\.mp4$/i, ".draft.mp4") : finalRel;
    ensureDir(path.dirname(path.join(projectDir, outRel)));
    // File tạm theo job + scene (đuôi .mp4 để hyperframes chọn đúng định dạng);
    // thư mục ẩn nên không lẫn vào danh sách render/asset nào
    const tmpRel = path.posix.join("renders", ".tmp", `${ctx.job.id}-${scene.id}.mp4`);
    const tmpAbs = path.join(projectDir, tmpRel);
    ensureDir(path.dirname(tmpAbs));
    const quality = draft ? "draft" : "standard";
    const label = `Scene ${scene.id} (${i + 1}/${total})`;
    ctx.progress(Math.floor((i / total) * 100), label);
    ctx.log(`[scene] ${label} - quality ${quality}`);

    // CLI thật (v0.7.x): render 1 composition bằng cờ -c, không phải positional.
    // Flags tăng tốc lấy từ tab "Tăng tốc" (data/render-settings.json) - đọc mỗi lần chạy.
    // Chạy CLI bằng node + file bin (không npx, không shell) - xem util.cliJsPath.
    const args = [
      hyperframesCli(),
      "render",
      "-c",
      String(scene.src),
      "--quality",
      quality,
      ...hyperframesSpeedArgs(draft),
      "--output",
      tmpRel,
    ];
    const outAbs = path.join(projectDir, outRel);
    try {
      await ctx.exec(process.execPath, args, projectDir, (line) => {
        const pct = parseProgressLine(line);
        if (pct !== null) {
          // Tiến độ tổng = scene đã xong + phần trăm scene hiện tại
          ctx.progress(Math.floor(((i + pct / 100) / total) * 100), label);
        }
      });
      if (ctx.isCanceled()) return; // bị hủy: giữ nguyên bản render cũ
      if (!fs.existsSync(tmpAbs) || fs.statSync(tmpAbs).size === 0) {
        throw new Error(`Render xong nhưng không thấy file ${outRel} - kiểm tra log hyperframes`);
      }
      // Thay nguyên tử (cùng ổ đĩa): bản cũ chỉ biến mất khi bản mới đã đủ.
      // Windows: rename đè file đang mở (trình chỉnh sửa đang phát bản cũ) có thể
      // EPERM/EBUSY - khi đó chép đè (vẫn chỉ sau khi bản mới đã render xong)
      try {
        fs.renameSync(tmpAbs, outAbs);
      } catch {
        fs.copyFileSync(tmpAbs, outAbs);
      }
    } finally {
      fs.rmSync(tmpAbs, { force: true });
    }
    lastOutputRel = `video-projects/${projectId}/${outRel}`;
  }

  // outputPath: file cuối (job 1 scene = chính file đó), đường dẫn tương đối repo root
  updateJob(ctx.job.id, { outputPath: lastOutputRel });
}
