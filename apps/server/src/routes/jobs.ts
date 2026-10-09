import { Router } from "express";
import { nanoid } from "nanoid";
import * as db from "../db.js";
import { broadcast } from "../events.js";
import { autoCutExists } from "../autoCutMeta.js";
import { IMAGE_GEN_STEPS, imageProjectExists, type ImageGenStep } from "../imageMeta.js";
import { briefOf, projectExists, readMeta } from "../meta.js";
import { isQcReportStale, readQcReport } from "../qc.js";
import { queue } from "../queue.js";
import { readRenderSettings } from "../renderSettings.js";
import { HttpError, nowIso } from "../util.js";

const router = Router();

// GET /api/jobs?limit=50&projectId=... - mới nhất trước, projectId lọc theo project (tùy chọn)
router.get("/", (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const projectId =
    typeof req.query.projectId === "string" && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
  res.json(db.listJobs(limit, projectId).map(db.jobToApi));
});

// GET /api/jobs/:id - Job + log đầy đủ
router.get("/:id", (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) throw new HttpError(404, "JOB_NOT_FOUND", `Không tìm thấy job "${req.params.id}"`);
  res.json({ ...db.jobToApi(job), log: job.log });
});

// POST /api/jobs - { projectId, type, sceneId? } → 201 Job
router.post("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const type = typeof body.type === "string" ? body.type : "";
  const sceneId =
    typeof body.sceneId === "string" && body.sceneId.trim() ? body.sceneId.trim() : null;
  /** Bỏ qua cổng QC tự động (người dùng/AI cố ý final dù QC chưa đạt) */
  const force = body.force === true;

  if (!projectId) throw new HttpError(400, "INVALID_PROJECT_ID", "Thiếu projectId");
  if (!db.JOB_TYPES.includes(type as db.JobType)) {
    throw new HttpError(
      400,
      "INVALID_TYPE",
      `type phải là một trong các loại tạo được qua POST /api/jobs: ${db.JOB_TYPES.join(", ")}`,
    );
  }
  if (type === "auto-cut") {
    // projectId là id PHIÊN CẮT (auto-cut/<id>), sceneId mang step
    if (!autoCutExists(projectId)) {
      throw new HttpError(404, "AUTOCUT_NOT_FOUND", `Không tìm thấy phiên cắt "${projectId}"`);
    }
    if (sceneId !== null && sceneId !== "plan" && sceneId !== "cut") {
      throw new HttpError(
        400,
        "INVALID_STEP",
        'sceneId (step) của job auto-cut phải là "plan" hoặc "cut"',
      );
    }
  } else if (type === "image-gen") {
    // Job tạo ảnh: projectId là image project (image-projects/<id>/meta.json),
    // sceneId mang step cần chạy (all | background | compose)
    if (!imageProjectExists(projectId)) {
      throw new HttpError(
        404,
        "IMAGE_NOT_FOUND",
        `Không tìm thấy image project "${projectId}"`,
      );
    }
    if (sceneId && !IMAGE_GEN_STEPS.includes(sceneId as ImageGenStep)) {
      throw new HttpError(
        400,
        "INVALID_STEP",
        `sceneId (step) của job image-gen phải là một trong: ${IMAGE_GEN_STEPS.join(", ")}`,
      );
    }
  } else {
    if (!projectExists(projectId)) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", `Không tìm thấy project "${projectId}"`);
    }

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
    if (type === "assemble-final" && force !== true && readRenderSettings().qcGate) {
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

  const job = db.createJob({
    id: `job_${nanoid()}`,
    projectId,
    type: type as db.JobType,
    sceneId,
  });
  broadcast("job", db.jobToApi(job));
  queue.enqueue(job.id);
  res.status(201).json(db.jobToApi(job));
});

// POST /api/jobs/:id/cancel - kill process nếu đang chạy
router.post("/:id/cancel", (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) throw new HttpError(404, "JOB_NOT_FOUND", `Không tìm thấy job "${req.params.id}"`);
  if (job.status === "queued" || job.status === "running") {
    const handled = queue.cancel(job.id);
    // Dòng 'queued' trong DB nhưng không còn trong hàng đợi in-memory (zombie sau
    // restart) - queue không biết gì, tự đánh canceled ở DB + broadcast như queue làm
    if (!handled && db.getJob(job.id)?.status === "queued") {
      db.updateJob(job.id, { status: "canceled", step: "Đã hủy", finishedAt: nowIso() });
      db.appendJobLog(job.id, "[queue] Job bị hủy khi đang chờ (không còn trong hàng đợi sau restart).");
      broadcast("job", db.jobToApi(db.getJob(job.id)!));
    }
  }
  res.json(db.jobToApi(db.getJob(job.id)!));
});

export default router;
