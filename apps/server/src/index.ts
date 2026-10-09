import os from "node:os";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  SERVER_PORT,
  apiToken,
  ensureBaseDirs,
  isAllowedWebOrigin,
  repoRoot,
} from "./config.js";
import { autoResumeStartup } from "./agent.js";
import { scanAutoCuts, patchAutoCut } from "./autoCutMeta.js";
import { failStaleRunningJobs, hasActiveJobForProject } from "./db.js";
import { addSseClient } from "./events.js";
import { HttpError, cookieValue, isLocalRequest, secretEquals } from "./util.js";
import { isKnownUploadToken } from "./routes/uploadSession.js";

import healthRouter from "./routes/health.js";
import overviewRouter from "./routes/overview.js";
import metricsRouter from "./routes/metrics.js";
import doctorRouter, { warmDoctorCache } from "./routes/doctor.js";
import projectsRouter from "./routes/projects.js";
import jobsRouter from "./routes/jobs.js";
import skillsRouter from "./routes/skills.js";
import sfxRouter from "./routes/sfx.js";
import musicRouter from "./routes/music.js";
import assetsRouter from "./routes/assets.js";
import chatRouter from "./routes/chat.js";
import promptsRouter from "./routes/prompts.js";
import usageRouter from "./routes/usage.js";
import providersRouter from "./routes/providers.js";
import stylesRouter from "./routes/stylesRoute.js";
import imagesRouter from "./routes/images.js";
import connectionsRouter from "./routes/connections.js";
import renderSettingsRouter from "./routes/renderSettingsRoute.js";
import illustrationsRouter from "./routes/illustrations.js";
import thumbnailsRouter from "./routes/thumbnails.js";
import publishRouter from "./routes/publish.js";
import qcRouter from "./routes/qc.js";
import clipsRouter from "./routes/clips.js";
import reviewRouter from "./routes/review.js";
import autoCutRouter from "./routes/autoCut.js";
import autoTrimRouter from "./routes/autoTrim.js";
import textToVideoRouter from "./routes/textToVideo.js";
import translateVideoRouter from "./routes/translateVideo.js";
import ttsRouter from "./routes/tts.js";
import voicesRouter from "./routes/voices.js";
import videoStylesRouter from "./routes/videoStyles.js";
import brandLogosRouter from "./routes/brandLogos.js";
import updateRouter from "./routes/update.js";
import revealRouter from "./routes/reveal.js";
import tunnelRouter, { quickTunnelHostname } from "./routes/tunnel.js";
import uploadSessionRouter from "./routes/uploadSession.js";
import { GRADE_PRESETS } from "./color.js";
import mediaRouter from "./routes/media.js";

ensureBaseDirs();
// Job còn treo "running" từ lần chạy trước (server bị tắt giữa chừng) → failed
failStaleRunningJobs();
// Phiên cắt tự động kẹt "planning"/"cutting" vì job của nó vừa bị đánh failed ở
// trên: catch của job không bao giờ chạy, nên không ai lùi trạng thái - phiên
// trả 409 BUSY mãi mãi (kể cả không xóa được). Ghi failed như job tự ghi khi lỗi.
for (const m of scanAutoCuts()) {
  if ((m.status === "planning" || m.status === "cutting") && !hasActiveJobForProject(m.id)) {
    patchAutoCut(m.id, {
      status: "failed",
      error: "Server khởi động lại giữa chừng - chạy lại bước này.",
      failedStep: m.status === "planning" ? "plan" : "cut",
    });
  }
}

const app = express();
app.disable("x-powered-by");

// CORS cho web UI :6868 - localhost (dev/debug) + IP LAN private (trang /m
// trên điện thoại upload file lớn gọi thẳng backend, không qua proxy Next)
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && isAllowedWebOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-aiev-token");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// ============ Xác thực (đặt TRƯỚC mọi router) ============

function queryString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Đường được phép đi bằng TOKEN PHIÊN QR (`?k=`) - chỉ đủ cho trang /m trên
 * điện thoại: xem tên project, xem media, và upload file vào project.
 */
function allowedForUploadToken(req: Request): boolean {
  const p = req.path;
  if (req.method === "GET") {
    return (
      p.startsWith("/media/") ||
      p.startsWith("/api/projects/") ||
      p === "/api/lan-info"
    );
  }
  if (req.method === "POST") return p === "/api/assets";
  return false;
}

/**
 * Chặn mọi truy cập không xác thực. Trước đây backend 6869 mở cho cả LAN
 * (upload từ điện thoại) nên bất kỳ ai trong mạng cũng gọi được API - kể cả
 * chạy agent, đọc .env qua /media, xóa project.
 *
 * Cho qua khi:
 *  (a) preflight OPTIONS (đã trả 204 ở trên, để chắc chắn)
 *  (b) /api/health - endpoint public, trả token cho loopback
 *  (c) request TRỰC TIẾP từ máy chủ (loopback, không qua proxy) - dashboard
 *      trên máy này, agent Claude, curl, script start
 *  (d) header `x-aiev-token` khớp AIEV_API_TOKEN (fetch của web dashboard)
 *  (e) cookie `aiev_token` khớp (img/video/EventSource - không set được header)
 *  (f) query `?t=` khớp (mở dashboard qua tunnel bằng link có token)
 *  (g) query `?k=` là token phiên upload QR còn hiệu lực (trang /m)
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "OPTIONS") {
    next();
    return;
  }
  if (req.path === "/api/health" || req.path.startsWith("/api/health/")) {
    next();
    return;
  }
  if (isLocalRequest(req)) {
    next();
    return;
  }
  const token = apiToken();
  const header = req.headers["x-aiev-token"];
  if (typeof header === "string" && secretEquals(header, token)) {
    next();
    return;
  }
  if (secretEquals(cookieValue(req, "aiev_token"), token)) {
    next();
    return;
  }
  if (secretEquals(queryString(req.query.t), token)) {
    next();
    return;
  }
  const k = queryString(req.query.k);
  if (k && isKnownUploadToken(k) && allowedForUploadToken(req)) {
    next();
    return;
  }
  res.status(401).json({
    error: { code: "UNAUTHORIZED", message: "Thiếu hoặc sai token truy cập" },
  });
});

app.use(express.json({ limit: "20mb" }));

// SSE - một stream chung cho job/joblog/agent
app.get("/api/events", addSseClient);

app.use("/api/health", healthRouter);
app.use("/api/overview", overviewRouter);
app.use("/api/metrics", metricsRouter);
// Kiểm tra môi trường + cài phần còn thiếu (không đặt dưới /api/health vì
// nhánh đó public, còn đây là đường chạy lệnh cài)
app.use("/api/doctor", doctorRouter);
app.use("/api/projects", projectsRouter);
// POST /api/projects/:id/thumbnail - projectsRouter không match nên rơi xuống đây
app.use("/api/projects", thumbnailsRouter);
// Các router phụ của project (đường dẫn con riêng, không đụng projectsRouter)
app.use("/api/projects", publishRouter); // phụ đề .srt/.vtt + gói metadata đăng bài
app.use("/api/projects", qcRouter); // QC tự động trên bản draft
app.use("/api/projects", clipsRouter); // cắt short + tái chế tỉ lệ khung
app.use("/api/projects", reviewRouter); // ghi chú duyệt draft theo mốc thời gian
app.use("/api/projects", autoTrimRouter); // cắt khoảng lặng + mỡ thừa của một video project
app.use("/api/auto-cut", autoCutRouter);
// Text to video: phiên nguồn (bài viết/đoạn văn) → tự sinh Videos Project
app.use("/api/text-to-video", textToVideoRouter);
// Dịch video: phiên nguồn (video) -> bóc lời -> dịch -> ghép phụ đề
app.use("/api/translate-video", translateVideoRouter);
app.use("/api/tts", ttsRouter);
app.use("/api/voices", voicesRouter); // giọng nhân bản chạy trên máy (VieNeu)
app.use("/api/video-styles", videoStylesRouter); // phong cách dựng (giấy gấp, mực tàu...)
app.use("/api/brand-logos", brandLogosRouter); // logo brand: có sẵn hoặc tự tải về
app.use("/api/jobs", jobsRouter);
app.use("/api/skills", skillsRouter);
app.use("/api/sfx", sfxRouter);
app.use("/api/music", musicRouter);
app.use("/api/assets", assetsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/prompts", promptsRouter);
app.use("/api/usage", usageRouter);
app.use("/api/providers", providersRouter);
app.use("/api/styles", stylesRouter);
app.use("/api/images", imagesRouter);
app.use("/api/connections", connectionsRouter);
app.use("/api/render-settings", renderSettingsRouter);
app.use("/api/illustrations", illustrationsRouter);
app.use("/api/update", updateRouter);
app.use("/api/reveal", revealRouter);
app.use("/api/tunnel", tunnelRouter);
app.use("/api/upload-session", uploadSessionRouter);

// Danh sách preset màu - UI dùng làm nguồn nhãn duy nhất (đồng bộ với color.ts)
app.get("/api/grade-presets", (_req: Request, res: Response) => {
  res.json(GRADE_PRESETS.map((p) => ({ id: p.id, label: p.label })));
});

// Thông tin LAN cho tính năng "Kết nối điện thoại" - QR trỏ http://<ip>:6868/m/<id>.
// IPv4 non-internal, ưu tiên dải LAN quen thuộc (192.168 → 10. → 172.) lên đầu.
app.get("/api/lan-info", (_req: Request, res: Response) => {
  const ips: string[] = [];
  // Bỏ adapter ảo (WSL/Hyper-V/VMware/Docker) - điện thoại không bao giờ tới được các IP đó
  const VIRTUAL_IF_RE = /wsl|vethernet|hyper-v|virtual|vmware|docker|loopback/i;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IF_RE.test(name)) continue;
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) ips.push(ni.address);
    }
  }
  const rank = (ip: string) =>
    ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : ip.startsWith("172.") ? 2 : 3;
  ips.sort((a, b) => rank(a) - rank(b));
  // Domain Cloudflare Tunnel - Quick Tunnel đang chạy (URL sống) ưu tiên hơn
  // TUNNEL_DOMAIN trong .env; env thì bỏ protocol/path nếu user lỡ dán kèm
  const rawTunnel = (process.env.TUNNEL_DOMAIN ?? "").trim();
  const tunnelDomain =
    quickTunnelHostname() ??
    (rawTunnel.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "").trim() || null);
  res.json({ ips, webPort: Number(process.env.WEB_PORT || 6868), tunnelDomain });
});
app.use("/media", mediaRouter);

// 404 cho các route /api không khớp
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Không tìm thấy endpoint" } });
});

// Error handler chuẩn { error: { code, message } } - Express 5 tự forward lỗi async
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // Lỗi parse JSON body của express.json
  if (err instanceof SyntaxError && "status" in err && (err as { status?: number }).status === 400) {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Body JSON không hợp lệ" } });
    return;
  }
  // Lỗi upload của multer (file quá lớn, sai field...)
  if (err instanceof Error && err.name === "MulterError") {
    res.status(400).json({ error: { code: "UPLOAD_ERROR", message: err.message } });
    return;
  }
  // Lỗi không lường trước: chi tiết CHỈ vào log server (có thể chứa đường dẫn
  // tuyệt đối, tên biến env, stack) - client chỉ nhận thông báo chung.
  console.error("[server] Unhandled error:", err);
  res
    .status(500)
    .json({ error: { code: "INTERNAL", message: "Lỗi máy chủ nội bộ" } });
});

const server = app.listen(SERVER_PORT, () => {
  console.log(`[server] AI Edit Video backend chạy tại http://localhost:${SERVER_PORT}`);
  console.log(`[server] Repo root: ${repoRoot}`);
  // Dò môi trường sẵn (~6s, chạy trong tiến trình con) để trang Cấu hình mở là có ngay
  warmDoctorCache();
  // Phiên bị 'interrupted' do restart (autoResume bật) → tự chạy tiếp sau khi server ổn định
  setTimeout(() => {
    void autoResumeStartup();
  }, 15_000);
});

// Upload video lớn qua WiFi có thể kéo dài hơn requestTimeout mặc định ~300s
// của Node → request bị cắt giữa chừng. Bỏ giới hạn cho toàn server; stall
// thật sự đã có middleware uploadProgress (45s không nhận byte nào) xử lý.
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 61_000;
