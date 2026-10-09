import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { paths } from "./config.js";
import { nowIso } from "./util.js";

// DB chỉ lưu jobs + chat; meta.json trên đĩa là nguồn sự thật về project.
fs.mkdirSync(paths.dataDir, { recursive: true });
const db = new Database(path.join(paths.dataDir, "app.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    projectId  TEXT NOT NULL,
    type       TEXT NOT NULL,
    sceneId    TEXT,
    status     TEXT NOT NULL DEFAULT 'queued',
    progress   INTEGER NOT NULL DEFAULT 0,
    step       TEXT NOT NULL DEFAULT '',
    outputPath TEXT,
    log        TEXT NOT NULL DEFAULT '',
    createdAt  TEXT NOT NULL,
    startedAt  TEXT,
    finishedAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs (projectId, type, status);

  CREATE TABLE IF NOT EXISTS chat_sessions (
    sessionId    TEXT PRIMARY KEY,
    sdkSessionId TEXT,
    title        TEXT NOT NULL DEFAULT '',
    projectId    TEXT,
    createdAt    TEXT NOT NULL,
    updatedAt    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId TEXT NOT NULL,
    role      TEXT NOT NULL,
    kind      TEXT NOT NULL,
    content   TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (sessionId, id);
`);

// Migration: DB tạo trước khi có cột projectId trong chat_sessions
try {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN projectId TEXT");
} catch {
  /* cột đã tồn tại */
}
// Migration: trạng thái phiên AI - bền vững qua restart/tắt UI (idle|running|done|error|interrupted)
try {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'");
} catch {
  /* cột đã tồn tại */
}
// Migration: chọn model Claude + effort (mode) cho phiên chat - xem docs/API.md mục AI Providers
try {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN model TEXT");
} catch {
  /* cột đã tồn tại */
}
try {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN effort TEXT");
} catch {
  /* cột đã tồn tại */
}
// Migration: thời gian chạy bền vững + auto-resume (docs/API.md mục Chat) -
// PHẢI chạy trước UPDATE 'running'→'interrupted' bên dưới (SELECT cần cột autoResume)
try {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN runStartedAt TEXT");
} catch {
  /* cột đã tồn tại */
}
try {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN runFinishedAt TEXT");
} catch {
  /* cột đã tồn tại */
}
try {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN autoResume INTEGER NOT NULL DEFAULT 1");
} catch {
  /* cột đã tồn tại */
}
try {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN resumeAttempts INTEGER NOT NULL DEFAULT 0");
} catch {
  /* cột đã tồn tại */
}
// Migration: mục tiêu của phiên - 'final' = phiên edit project, chỉ coi là hoàn thành khi
// video final tồn tại thật (gate trong agent.ts); null = chat thường, không gate
try {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN goal TEXT");
} catch {
  /* cột đã tồn tại */
}
// Migration: bằng chứng tiến bộ của lượt chạy gần nhất (jobs done + renders/ + output) -
// agent.ts so sánh trước khi bump resumeAttempts: có tiến bộ thì reset đếm về 0
try {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN progressMark TEXT");
} catch {
  /* cột đã tồn tại */
}
// Backfill: các phiên edit tạo TRƯỚC khi có cột goal bị goal=NULL → gate final không bao giờ
// chạy cho những phiên đó (kể cả khi user gửi tiếp message). Route /edit là nơi DUY NHẤT đặt
// title "Edit: ..." kèm projectId → đánh lại goal='final' cho đúng ngữ nghĩa.
db.prepare(
  "UPDATE chat_sessions SET goal = 'final' WHERE goal IS NULL AND projectId IS NOT NULL AND title LIKE 'Edit: %'",
).run();

/**
 * Phiên đang 'running' lúc server tắt (ngay dưới sẽ bị đánh 'interrupted') có autoResume bật -
 * đọc MỘT LẦN lúc boot; index.ts dùng danh sách này để tự chạy tiếp ~15s sau khi server lên.
 */
export const startupInterruptedSessions: string[] = (
  db
    .prepare(
      "SELECT sessionId FROM chat_sessions WHERE status = 'running' AND COALESCE(autoResume, 1) = 1",
    )
    .all() as Array<{ sessionId: string }>
).map((r) => r.sessionId);

// Server khởi động lại khi phiên còn 'running' = process agent đã chết theo → đánh interrupted
// + đóng mốc thời gian lượt chạy bị restart cắt ngang (nếu chưa đóng)
db.prepare(
  "UPDATE chat_sessions SET status = 'interrupted', runFinishedAt = COALESCE(runFinishedAt, ?) WHERE status = 'running'",
).run(nowIso());

// Theo dõi token AI đã dùng - mỗi lượt runAgent kết thúc ghi một dòng
db.exec(`
  CREATE TABLE IF NOT EXISTS token_usage (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId    TEXT NOT NULL,
    projectId    TEXT,
    inputTokens  INTEGER NOT NULL DEFAULT 0,
    outputTokens INTEGER NOT NULL DEFAULT 0,
    costUsd      REAL NOT NULL DEFAULT 0,
    createdAt    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_token_usage_project ON token_usage (projectId);
  CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage (createdAt);
`);
// Migration: phân loại token theo AI (claude | gemini | openai) cho biểu đồ Dashboard
try {
  db.exec("ALTER TABLE token_usage ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
} catch {
  /* cột đã tồn tại */
}

// ---------------------------------------------------------------- Jobs

export type JobType =
  | "scene-draft"
  | "scene-final"
  | "assemble-draft"
  | "assemble-final"
  | "image-gen"
  /** Auto cut videos: projectId là id phiên cắt, sceneId mang step (plan | cut) */
  | "auto-cut"
  /**
   * Cắt khoảng lặng + mỡ thừa của MỘT video project (khác hẳn "auto-cut" ở trên
   * - loại kia cắt video dài thành nhiều video ngắn). projectId là video project,
   * sceneId mang mức mạnh tay (natural | default | tight).
   */
  | "auto-trim"
  /** Text to video: projectId là id phiên, không dùng sceneId */
  | "text-to-video"
  /** Dịch video: projectId là id phiên dịch, sceneId mang step (transcribe | render) */
  | "translate-video";
export type JobStatus = "queued" | "running" | "done" | "failed" | "canceled";

/**
 * Các loại job tạo được qua POST /api/jobs. CỐ Ý thiếu "text-to-video" và
 * "translate-video" - hai loại đó chỉ được tạo qua route riêng của chúng.
 * Thêm vào đây là POST /api/jobs sẽ chạy projectExists() trên một id PHIÊN
 * (không phải video project) và trả 404.
 */
export const JOB_TYPES: JobType[] = [
  "scene-draft",
  "scene-final",
  "assemble-draft",
  "assemble-final",
  "image-gen",
  "auto-cut",
  "auto-trim",
];

export interface JobRow {
  id: string;
  projectId: string;
  type: JobType;
  sceneId: string | null;
  status: JobStatus;
  progress: number;
  step: string;
  outputPath: string | null;
  log: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Shape Job trả về qua API (không kèm log) */
export type JobApi = Omit<JobRow, "log">;

export function jobToApi(row: JobRow): JobApi {
  const { log: _log, ...rest } = row;
  return rest;
}

export function createJob(input: {
  id: string;
  projectId: string;
  type: JobType;
  sceneId?: string | null;
}): JobRow {
  db.prepare(
    `INSERT INTO jobs (id, projectId, type, sceneId, status, progress, step, createdAt)
     VALUES (?, ?, ?, ?, 'queued', 0, 'Đang chờ trong hàng đợi', ?)`,
  ).run(input.id, input.projectId, input.type, input.sceneId ?? null, nowIso());
  return getJob(input.id)!;
}

export function getJob(id: string): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

const JOB_PATCH_KEYS = [
  "status",
  "progress",
  "step",
  "outputPath",
  "startedAt",
  "finishedAt",
] as const;

export function updateJob(
  id: string,
  patch: Partial<Pick<JobRow, (typeof JOB_PATCH_KEYS)[number]>>,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of JOB_PATCH_KEYS) {
    if (key in patch) {
      sets.push(`${key} = ?`);
      values.push(patch[key] ?? null);
    }
  }
  if (!sets.length) return;
  values.push(id);
  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function appendJobLog(id: string, line: string): void {
  db.prepare("UPDATE jobs SET log = log || ? WHERE id = ?").run(line + "\n", id);
}

export function listJobs(limit = 50, projectId?: string): JobRow[] {
  const capped = Math.max(1, Math.min(500, limit));
  // Lọc theo project để web không phải kéo 50 job toàn cục rồi lọc client-side
  if (projectId) {
    return db
      .prepare(
        "SELECT * FROM jobs WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?",
      )
      .all(projectId, capped) as JobRow[];
  }
  return db
    .prepare("SELECT * FROM jobs ORDER BY createdAt DESC, rowid DESC LIMIT ?")
    .all(capped) as JobRow[];
}

export function getRunningJob(): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE status = 'running' LIMIT 1").get() as
    | JobRow
    | undefined;
}

/** Toàn bộ job đang chạy - queue chạy song song nên có thể nhiều hơn 1 */
export function getRunningJobs(): JobRow[] {
  return db
    .prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY startedAt")
    .all() as JobRow[];
}

/** Project đang có job running/queued? - chặn thao tác dọn file trung gian khi job cần chúng */
export function hasActiveJobForProject(projectId: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM jobs WHERE projectId = ? AND status IN ('running', 'queued') LIMIT 1",
    )
    .get(projectId);
  return row !== undefined;
}

/**
 * Project đang có job RENDER (scene-draft/final, assemble-draft/final) chạy hoặc chờ? - trình chỉnh
 * sửa báo "bản đang render sẽ không có thay đổi mới". Khác hasActiveJobForProject:
 * job auto-trim không render gì từ timeline nên không tính.
 */
export function hasActiveRenderJobForProject(projectId: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM jobs WHERE projectId = ? AND status IN ('running', 'queued') " +
        "AND type IN ('scene-draft', 'scene-final', 'assemble-draft', 'assemble-final') LIMIT 1",
    )
    .get(projectId);
  return row !== undefined;
}

export function countQueuedJobs(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get() as {
    n: number;
  };
  return row.n;
}

/** Đã có assemble-draft thành công cho project này chưa? (điều kiện chạy job final) */
export function hasDoneAssembleDraft(projectId: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM jobs WHERE projectId = ? AND type = 'assemble-draft' AND status = 'done' LIMIT 1",
    )
    .get(projectId);
  return row !== undefined;
}

/** Job đang treo status running/queued từ lần chạy trước (server crash) → đánh failed */
export function failStaleRunningJobs(): void {
  db.prepare(
    `UPDATE jobs SET status = 'failed', step = 'Server khởi động lại khi job đang chạy',
     finishedAt = ? WHERE status = 'running'`,
  ).run(nowIso());
  // Hàng đợi nằm trong RAM - restart là mất, không ai re-enqueue lại các dòng 'queued'.
  // Không dọn thì queuedCount phồng mãi và hasActiveJobForProject chặn 409 vĩnh viễn.
  db.prepare(
    `UPDATE jobs SET status = 'failed', step = 'Server khởi động lại khi job còn trong hàng đợi',
     finishedAt = ? WHERE status = 'queued'`,
  ).run(nowIso());
}

// ---------------------------------------------------------------- Chat

export type ChatSessionStatus = "idle" | "running" | "done" | "error" | "interrupted";

export interface ChatSessionRow {
  sessionId: string;
  sdkSessionId: string | null;
  title: string;
  /** Project mà phiên chat này thuộc về (phiên edit từ project) - null nếu chat tự do */
  projectId: string | null;
  /** Trạng thái làm việc của agent - bền vững, UI đọc lại được sau khi tắt/mở */
  status: ChatSessionStatus;
  /** Model Claude cho phiên (options.model của Agent SDK) - null = mặc định của SDK */
  model: string | null;
  /** Mức effort ("low"|"medium"|"high") - null = mặc định của SDK */
  effort: string | null;
  /** ISO - lúc lượt chạy hiện tại BẮT ĐẦU (không reset khi auto-resume) */
  runStartedAt: string | null;
  /** ISO - lúc lượt chạy kết thúc hẳn; null khi đang chạy */
  runFinishedAt: string | null;
  /** Tự chạy tiếp khi gián đoạn - SQLite lưu 0/1; route convert sang boolean khi trả JSON */
  autoResume: number;
  /** Số lần auto-resume liên tiếp của lượt hiện tại (reset khi user gửi message mới) */
  resumeAttempts: number;
  /** Mục tiêu phiên: "final" = phiên edit project, chỉ xong khi video final tồn tại; null = chat thường */
  goal: string | null;
  /** Bằng chứng tiến bộ của lượt chạy trước (agent.ts computeProgressMark) - so sánh để reset resumeAttempts */
  progressMark: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- Token usage

export function addTokenUsage(
  sessionId: string,
  projectId: string | null,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  provider: "claude" | "gemini" | "openai" = "claude",
): void {
  db.prepare(
    "INSERT INTO token_usage (sessionId, projectId, inputTokens, outputTokens, costUsd, provider, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(sessionId, projectId, inputTokens, outputTokens, costUsd, provider, nowIso());
}

/** Tổng token (input + output) theo projectId */
export function tokensByProject(): Record<string, { tokens: number; costUsd: number }> {
  const rows = db
    .prepare(
      "SELECT projectId, SUM(inputTokens + outputTokens) AS tokens, SUM(costUsd) AS costUsd FROM token_usage WHERE projectId IS NOT NULL GROUP BY projectId",
    )
    .all() as Array<{ projectId: string; tokens: number; costUsd: number }>;
  const out: Record<string, { tokens: number; costUsd: number }> = {};
  for (const r of rows) out[r.projectId] = { tokens: r.tokens ?? 0, costUsd: r.costUsd ?? 0 };
  return out;
}

export interface UsageTimelinePoint {
  date: string;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Phân loại theo AI - cột tổng + đường theo từng provider trên chart (tổng tokens) */
  byProvider: Record<string, number>;
}

/** Bộ lọc loại project cho timeline - xem docs/API.md mục Token Usage */
export type UsageScope = "all" | "video" | "image";

/**
 * Token theo ngày (UTC, yyyy-mm-dd) trong `days` ngày gần nhất - cho biểu đồ Dashboard.
 * scope: phân loại projectId theo folder tồn tại trên đĩa (resolve mỗi request -
 * project bị xóa thì dòng token của nó rơi về nhóm "còn lại", chỉ tính vào "all").
 */
export function usageTimeline(days: number, scope: UsageScope = "all"): UsageTimelinePoint[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      "SELECT substr(createdAt, 1, 10) AS date, COALESCE(provider, 'claude') AS provider, projectId, " +
        "SUM(inputTokens) AS tokensIn, SUM(outputTokens) AS tokensOut, " +
        "SUM(inputTokens + outputTokens) AS tokens, SUM(costUsd) AS costUsd " +
        "FROM token_usage WHERE createdAt >= ? GROUP BY date, provider, projectId ORDER BY date",
    )
    .all(since) as Array<{
    date: string;
    provider: string;
    projectId: string | null;
    tokensIn: number;
    tokensOut: number;
    tokens: number;
    costUsd: number;
  }>;

  // Cache phân loại theo request - tránh existsSync lặp lại cho cùng projectId
  const kindCache = new Map<string, "video" | "image" | "other">();
  const classify = (projectId: string | null): "video" | "image" | "other" => {
    if (!projectId) return "other";
    let kind = kindCache.get(projectId);
    if (!kind) {
      kind = fs.existsSync(path.join(paths.videoProjectsDir, projectId))
        ? "video"
        : fs.existsSync(path.join(paths.imageProjectsDir, projectId))
          ? "image"
          : "other";
      kindCache.set(projectId, kind);
    }
    return kind;
  };

  const byDate = new Map<string, UsageTimelinePoint>();
  for (const r of rows) {
    if (scope !== "all" && classify(r.projectId) !== scope) continue;
    let point = byDate.get(r.date);
    if (!point) {
      point = { date: r.date, tokens: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, byProvider: {} };
      byDate.set(r.date, point);
    }
    point.tokens += r.tokens ?? 0;
    point.tokensIn += r.tokensIn ?? 0;
    point.tokensOut += r.tokensOut ?? 0;
    point.costUsd += r.costUsd ?? 0;
    point.byProvider[r.provider] = (point.byProvider[r.provider] ?? 0) + (r.tokens ?? 0);
  }
  return [...byDate.values()];
}

/** Tổng toàn bảng token_usage (kể cả projectId null) - cho /api/usage/summary */
export function usageTotals(): {
  tokens: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
} {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(inputTokens), 0) AS tokensIn, COALESCE(SUM(outputTokens), 0) AS tokensOut, " +
        "COALESCE(SUM(inputTokens + outputTokens), 0) AS tokens, COALESCE(SUM(costUsd), 0) AS costUsd " +
        "FROM token_usage",
    )
    .get() as { tokensIn: number; tokensOut: number; tokens: number; costUsd: number };
  return {
    tokens: row.tokens,
    costUsd: row.costUsd,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
  };
}

/** Một dòng của bảng "Chi phí AI theo model" trên Dashboard. */
export interface UsageByModelRow {
  /** claude | gemini | openai */
  provider: string;
  /** null = dòng usage không gắn với phiên chat nào (bóc lời, dịch, tạo ảnh…) */
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  /** TIỀN THẬT nhà cung cấp trả về, cộng dồn - KHÔNG phải tính lại từ đơn giá. */
  costUsd: number;
}

/**
 * Token + chi phí gộp theo (nhà cung cấp, model).
 *
 * `token_usage` KHÔNG có cột model - model nằm ở `chat_sessions.model`, nên phải
 * LEFT JOIN qua sessionId. LEFT chứ không INNER: dòng usage chạy ngoài phiên chat
 * (STT, dịch, sinh ảnh) có sessionId null hoặc trỏ tới phiên đã xóa, INNER JOIN
 * sẽ nuốt mất chúng và bảng cộng ra ít tiền hơn thực tế.
 *
 * `days` bỏ trống = tính từ đầu.
 */
export function usageByModel(days?: number): UsageByModelRow[] {
  const where = days ? "WHERE u.createdAt >= ?" : "";
  const params = days ? [new Date(Date.now() - days * 86_400_000).toISOString()] : [];
  const rows = db
    .prepare(
      "SELECT COALESCE(u.provider, 'claude') AS provider, s.model AS model, " +
        "COALESCE(SUM(u.inputTokens), 0) AS tokensIn, COALESCE(SUM(u.outputTokens), 0) AS tokensOut, " +
        "COALESCE(SUM(u.costUsd), 0) AS costUsd " +
        "FROM token_usage u LEFT JOIN chat_sessions s ON s.sessionId = u.sessionId " +
        `${where} GROUP BY provider, model ` +
        "ORDER BY COALESCE(SUM(u.inputTokens + u.outputTokens), 0) DESC",
    )
    .all(...params) as UsageByModelRow[];
  return rows.map((r) => ({
    provider: r.provider,
    model: r.model ?? null,
    tokensIn: r.tokensIn ?? 0,
    tokensOut: r.tokensOut ?? 0,
    costUsd: r.costUsd ?? 0,
  }));
}

export function setChatSessionStatus(sessionId: string, status: ChatSessionStatus): void {
  db.prepare("UPDATE chat_sessions SET status = ?, updatedAt = ? WHERE sessionId = ?").run(
    status,
    nowIso(),
    sessionId,
  );
}

export interface ChatMessageRow {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  kind: "text" | "tool";
  content: string;
  createdAt: string;
}

export function createChatSession(
  sessionId: string,
  title: string,
  projectId?: string | null,
  model?: string | null,
  effort?: string | null,
  goal?: string | null,
): ChatSessionRow {
  const now = nowIso();
  db.prepare(
    "INSERT INTO chat_sessions (sessionId, title, projectId, model, effort, goal, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(sessionId, title, projectId ?? null, model ?? null, effort ?? null, goal ?? null, now, now);
  return getChatSession(sessionId)!;
}

/** Cập nhật model/effort cho phiên có sẵn - chỉ ghi field được truyền (undefined = giữ nguyên) */
export function setChatSessionModelEffort(
  sessionId: string,
  model?: string,
  effort?: string,
): void {
  if (model === undefined && effort === undefined) return;
  const sets: string[] = [];
  const values: unknown[] = [];
  if (model !== undefined) {
    sets.push("model = ?");
    values.push(model);
  }
  if (effort !== undefined) {
    sets.push("effort = ?");
    values.push(effort);
  }
  values.push(nowIso(), sessionId);
  db.prepare(
    `UPDATE chat_sessions SET ${sets.join(", ")}, updatedAt = ? WHERE sessionId = ?`,
  ).run(...values);
}

export function getChatSession(sessionId: string): ChatSessionRow | undefined {
  return db.prepare("SELECT * FROM chat_sessions WHERE sessionId = ?").get(sessionId) as
    | ChatSessionRow
    | undefined;
}

export function setSdkSessionId(sessionId: string, sdkSessionId: string): void {
  db.prepare("UPDATE chat_sessions SET sdkSessionId = ?, updatedAt = ? WHERE sessionId = ?").run(
    sdkSessionId,
    nowIso(),
    sessionId,
  );
}

export function touchChatSession(sessionId: string): void {
  db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE sessionId = ?").run(
    nowIso(),
    sessionId,
  );
}

/** Bắt đầu một lượt chạy MỚI (user gửi message) - reset mốc thời gian + đếm resume */
export function startChatRun(sessionId: string): void {
  const now = nowIso();
  db.prepare(
    "UPDATE chat_sessions SET runStartedAt = ?, runFinishedAt = NULL, resumeAttempts = 0, updatedAt = ? WHERE sessionId = ?",
  ).run(now, now, sessionId);
}

/** Lượt chạy kết thúc HẲN (done / interrupted / error hết lượt resume) */
export function finishChatRun(sessionId: string): void {
  const now = nowIso();
  db.prepare(
    "UPDATE chat_sessions SET runFinishedAt = ?, updatedAt = ? WHERE sessionId = ?",
  ).run(now, now, sessionId);
}

/** Reset đếm auto-resume về 0 - gọi khi phát hiện CÓ tiến bộ thật giữa hai lượt chạy */
export function resetResumeAttempts(sessionId: string): void {
  db.prepare(
    "UPDATE chat_sessions SET resumeAttempts = 0, updatedAt = ? WHERE sessionId = ?",
  ).run(nowIso(), sessionId);
}

/** Lưu bằng chứng tiến bộ mới nhất (agent.ts computeProgressMark) */
export function setProgressMark(sessionId: string, mark: string): void {
  db.prepare(
    "UPDATE chat_sessions SET progressMark = ?, updatedAt = ? WHERE sessionId = ?",
  ).run(mark, nowIso(), sessionId);
}

/** Số job done của project - một phần bằng chứng tiến bộ của phiên edit */
export function countDoneJobsForProject(projectId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE projectId = ? AND status = 'done'")
    .get(projectId) as { n: number };
  return row.n;
}

/** +1 số lần auto-resume liên tiếp, trả về giá trị mới */
export function bumpResumeAttempts(sessionId: string): number {
  db.prepare(
    "UPDATE chat_sessions SET resumeAttempts = resumeAttempts + 1, updatedAt = ? WHERE sessionId = ?",
  ).run(nowIso(), sessionId);
  const row = db
    .prepare("SELECT resumeAttempts FROM chat_sessions WHERE sessionId = ?")
    .get(sessionId) as { resumeAttempts: number } | undefined;
  return row?.resumeAttempts ?? 0;
}

export function setChatAutoResume(sessionId: string, enabled: boolean): void {
  db.prepare(
    "UPDATE chat_sessions SET autoResume = ?, updatedAt = ? WHERE sessionId = ?",
  ).run(enabled ? 1 : 0, nowIso(), sessionId);
}

export function listChatSessions(
  projectId?: string,
): Array<Omit<ChatSessionRow, "sdkSessionId">> {
  const base =
    "SELECT sessionId, title, projectId, status, model, effort, runStartedAt, runFinishedAt, " +
    "autoResume, resumeAttempts, goal, progressMark, createdAt, updatedAt FROM chat_sessions";
  if (projectId) {
    return db
      .prepare(`${base} WHERE projectId = ? ORDER BY updatedAt DESC`)
      .all(projectId) as Array<Omit<ChatSessionRow, "sdkSessionId">>;
  }
  return db.prepare(`${base} ORDER BY updatedAt DESC`).all() as Array<
    Omit<ChatSessionRow, "sdkSessionId">
  >;
}

export function addChatMessage(
  sessionId: string,
  role: ChatMessageRow["role"],
  kind: ChatMessageRow["kind"],
  content: string,
): void {
  db.prepare(
    "INSERT INTO chat_messages (sessionId, role, kind, content, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, role, kind, content, nowIso());
}

export function listChatMessages(
  sessionId: string,
): Array<Pick<ChatMessageRow, "role" | "kind" | "content" | "createdAt">> {
  return db
    .prepare(
      "SELECT role, kind, content, createdAt FROM chat_messages WHERE sessionId = ? ORDER BY id ASC",
    )
    .all(sessionId) as Array<Pick<ChatMessageRow, "role" | "kind" | "content" | "createdAt">>;
}
