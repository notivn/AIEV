import { nanoid } from "nanoid";
import * as db from "./db.js";
import { broadcast } from "./events.js";
import { briefOf, readMeta } from "./meta.js";
import { isQcReportStale, readQcReport } from "./qc.js";
import { queue } from "./queue.js";
import { readRenderSettings } from "./renderSettings.js";
import { HttpError } from "./util.js";

/**
 * Luật xếp job render của VIDEO project - dùng chung cho POST /api/jobs và
 * POST /api/projects/:id/editor/render. Tách ra một chỗ vì đây là luật cứng của
 * pipeline (CLAUDE.md quy tắc 1-2): hai cửa vào mà viết hai bản là sớm muộn có
 * một cửa quên cổng QC, và trình chỉnh sửa thành lối vòng render final khi
 * chưa duyệt draft.
 *
 * Caller tự kiểm project tồn tại trước (404 PROJECT_NOT_FOUND).
 */
export function assertVideoJobAllowed(
  projectId: string,
  type: db.JobType,
  opts: { force?: boolean } = {},
): void {
  // Cùng cửa khóa với POST /:id/auto-trim/apply - không thì đây là lối vòng
  // cắt footage của project đang TẮT "Tự động cắt" (CLAUDE.md 5.7)
  if (type === "auto-trim" && !briefOf(readMeta(projectId)).autoCut) {
    throw new HttpError(
      409,
      "AUTO_CUT_DISABLED",
      `Project "${projectId}" đang TẮT "Tự động cắt ngắn video" - không cắt footage của video này.`,
    );
  }

  // Quy tắc queue: từ chối job *-final nếu chưa có assemble-draft thành công cho project
  if (type.endsWith("-final") && !db.hasDoneAssembleDraft(projectId)) {
    throw new HttpError(
      409,
      "DRAFT_REQUIRED",
      `Project "${projectId}" chưa có assemble-draft thành công - draft luôn trước final.`,
    );
  }

  // Cổng QC tự động: chỉ chặn assemble-final (bản nộp cuối). scene-final,
  // scene-draft, assemble-draft, image-gen KHÔNG bị ảnh hưởng - QC đo trên
  // bản draft toàn bài nên chỉ có nghĩa ngay trước khi lắp final.
  if (type === "assemble-final" && opts.force !== true && readRenderSettings().qcGate) {
    const howTo =
      `Chạy POST /api/projects/${projectId}/qc để đo lại, ` +
      `hoặc gửi { "force": true } để bỏ qua, ` +
      `hoặc tắt cổng QC trong tab Tăng tốc.`;
    const report = readQcReport(projectId);
    if (!report) {
      throw new HttpError(
        409,
        "QC_REQUIRED",
        `Project "${projectId}" chưa qua QC tự động. ${howTo}`,
      );
    }
    if (isQcReportStale(report)) {
      throw new HttpError(
        409,
        "QC_REQUIRED",
        `Kết quả QC của project "${projectId}" đã cũ - file "${report.file}" thay đổi sau lần đo. ${howTo}`,
      );
    }
    if (report.status === "fail") {
      const failed = report.checks.filter((c) => c.status === "fail").map((c) => c.id);
      throw new HttpError(
        409,
        "QC_FAILED",
        `QC tự động của project "${projectId}" FAIL ở: ${failed.join(", ") || "(không rõ check)"}. ` +
          `Sửa lỗi rồi ${howTo}`,
      );
    }
  }
}

/**
 * Tạo job trong DB + đẩy SSE + xếp vào hàng đợi - trả shape Job của API.
 * `dependsOn`: id các job (cùng project, xếp TRƯỚC) phải "done" thì job này mới
 * chạy - không thì nó failed ngay với lý do chỉ đích danh job hỏng (queue.ts).
 * Đăng ký cùng lúc với enqueue: hàng đợi có thể bốc job chạy ngay trong lệnh này.
 */
export function enqueueJob(input: {
  projectId: string;
  type: db.JobType;
  sceneId?: string | null;
  dependsOn?: string[];
}): db.JobApi {
  const job = db.createJob({
    id: `job_${nanoid()}`,
    projectId: input.projectId,
    type: input.type,
    sceneId: input.sceneId ?? null,
  });
  const api = db.jobToApi(job);
  broadcast("job", api);
  queue.enqueue(job.id, input.dependsOn);
  return api;
}
