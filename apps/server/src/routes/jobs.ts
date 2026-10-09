import { Router } from "express";
import * as db from "../db.js";
import { broadcast } from "../events.js";
import { autoCutExists } from "../autoCutMeta.js";
import { IMAGE_GEN_STEPS, imageProjectExists, type ImageGenStep } from "../imageMeta.js";
import { assertVideoJobAllowed, enqueueJob } from "../jobRules.js";
import { projectExists } from "../meta.js";
import { queue } from "../queue.js";
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

    // AUTO_CUT_DISABLED / DRAFT_REQUIRED / QC_REQUIRED / QC_FAILED - luật dùng
    // chung với POST /api/projects/:id/editor/render (xem jobRules.ts)
    assertVideoJobAllowed(projectId, type as db.JobType, { force });
  }

  res.status(201).json(enqueueJob({ projectId, type: type as db.JobType, sceneId }));
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
