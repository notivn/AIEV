import fs from "node:fs";
import path from "node:path";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { hasClaudeAuth, paths, repoRoot } from "./config.js";
import * as db from "./db.js";
import { broadcast } from "./events.js";
import { normOutput, readMeta } from "./meta.js";
import { readRenderSettings } from "./renderSettings.js";

/**
 * Chạy Claude Code headless qua Claude Agent SDK (0.3.x).
 * Event đẩy qua SSE kênh `agent`:
 *   { sessionId, kind: "text"|"tool"|"result"|"error"|"done", text?, tool?, error? }
 */

/** Query đang chạy theo sessionId - phục vụ interrupt */
const running = new Map<string, Query>();

/** Shape structural tối thiểu của message SDK - tránh gãy build khi type SDK đổi giữa các bản 0.3.x */
interface AgentMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  message?: {
    content?: Array<{ type?: string; name?: string; input?: unknown; text?: string }>;
  };
  result?: string;
  /** Usage trên message result - tên field theo SDK 0.3.x, đọc phòng thủ */
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  input_tokens?: number;
  output_tokens?: number;
  [key: string]: unknown;
}

type AgentEventPayload = {
  sessionId: string;
  kind: "text" | "tool" | "result" | "error" | "done";
  text?: string;
  tool?: { name: string; input: unknown };
  error?: string;
  /** Kèm theo kind "done": trạng thái cuối của phiên (done | error | interrupted) */
  status?: db.ChatSessionStatus;
};

function emit(payload: AgentEventPayload): void {
  broadcast("agent", payload);
}

export function isAgentRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

/** Các phiên bị người dùng chủ động dừng - để finally đánh status "interrupted" thay vì "error" */
const interruptedSessions = new Set<string>();

/** Timer auto-resume đang chờ theo sessionId - để hủy được (interrupt / tắt autoResume) */
const pendingResumes = new Map<string, NodeJS.Timeout>();

/**
 * Đang chạy HOẶC đang hẹn giờ tự chạy lại (auto-resume / thử lại sau lỗi): cả
 * hai đều sẽ còn sửa project, nên mở phiên mới lúc này là hai agent chồng nhau.
 */
export function isAgentBusy(sessionId: string): boolean {
  return running.has(sessionId) || pendingResumes.has(sessionId);
}

/**
 * Hủy lượt auto-resume đang chờ (nếu có): clear timer + đóng mốc thời gian lượt chạy.
 * Trả về true nếu có timer để hủy.
 */
export function cancelPendingResume(sessionId: string): boolean {
  const timer = pendingResumes.get(sessionId);
  if (!timer) return false;
  clearTimeout(timer);
  pendingResumes.delete(sessionId);
  db.finishChatRun(sessionId);
  // Gate goal='final' giữ status "running" trong lúc chờ resume - hủy chờ mà không có
  // query nào chạy thì không được để phiên kẹt "running" mãi
  const s = db.getChatSession(sessionId);
  if (s?.status === "running" && !running.has(sessionId)) {
    db.setChatSessionStatus(sessionId, "interrupted");
    emit({ sessionId, kind: "done", status: "interrupted" });
  }
  return true;
}

export async function interruptAgent(sessionId: string): Promise<boolean> {
  const q = running.get(sessionId);
  if (!q) {
    // Không có query đang chạy nhưng có auto-resume đang chờ → hủy, coi như đã interrupt
    if (cancelPendingResume(sessionId)) {
      // cancelPendingResume có thể đã tự đánh interrupted (gate goal='final') - không emit lặp
      const s = db.getChatSession(sessionId);
      if (s && s.status !== "interrupted") {
        db.setChatSessionStatus(sessionId, "interrupted");
        emit({ sessionId, kind: "done", status: "interrupted" });
      }
      return true;
    }
    return false;
  }
  interruptedSessions.add(sessionId);
  try {
    await q.interrupt();
  } catch {
    /* query có thể đã kết thúc */
  }
  return true;
}

/**
 * Tool agent được tự chạy KHÔNG cần hỏi. Pipeline video chạy hoàn toàn cục bộ
 * (ffmpeg/HyperFrames/Remotion) nên KHÔNG có WebFetch/WebSearch: prompt luôn
 * chứa nội dung do người dùng/asset cung cấp (brief, mô tả file, transcript) -
 * để cả Bash lẫn kênh ra mạng là mở đường rò rỉ .env/credentials nếu bị chèn
 * chỉ thị độc (prompt injection). Cần tra cứu web thì làm ở phiên riêng.
 */
const ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "TodoWrite",
  "Skill",
];

/** Message gửi agent khi tự chạy tiếp một phiên bị gián đoạn (auto-resume) */
const RESUME_MESSAGE =
  "Tiếp tục công việc đang dở dang. Kiểm tra trạng thái hiện tại của project (meta.json, renders/, log job) rồi làm tiếp từ chỗ dừng - KHÔNG làm lại từ đầu.";

/**
 * Tối đa số lần auto-resume liên tiếp KHÔNG CÓ TIẾN BỘ (reset khi user gửi message mới
 * hoặc khi refreshResumeProgress phát hiện project có tiến bộ giữa hai lượt).
 */
const MAX_RESUME_ATTEMPTS = 3;
const RESUME_DELAY_MS = 10_000;

/**
 * Cap resume theo loại phiên - goal='final' được nhiều lượt hơn hẳn vì pipeline
 * dài (transcribe → scene → draft → verify → final) và mỗi lượt agent có thể
 * kết thúc sớm trong khi render nền còn chạy.
 *
 * Con số của phiên 'final' KHÔNG còn là hằng số: đọc từ Cấu hình mỗi lần gọi,
 * nên người dùng đổi là có hiệu lực ngay ở phiên kế tiếp, không cần khởi động
 * lại server. Trước đây nó cứng ở 12, và đo trên dữ liệu thật thì 4 phiên có
 * chạy lại đã nuốt 34% tổng chi phí - đủ đắt để đáng cho người dùng tự chỉnh.
 * Phiên chat thường vẫn giữ MAX_RESUME_ATTEMPTS, không liên quan tới tiền dựng
 * video nên không mở ra làm gì.
 */
function maxResumeAttemptsFor(session: Pick<db.ChatSessionRow, "goal">): number {
  return session.goal === "final"
    ? readRenderSettings().aiMaxAttempts
    : MAX_RESUME_ATTEMPTS;
}

/**
 * Bằng chứng tiến bộ của project tại thời điểm gọi: số job done + trạng thái renders/
 * (số file, tổng size, mtime mới nhất) + file output + meta.status. Chuỗi đổi giữa hai
 * lượt = pipeline CÓ tiến bộ (kể cả render đang chạy dở - file trong renders/ đang lớn dần).
 */
function computeProgressMark(projectId: string): string {
  const parts: string[] = [];
  try {
    parts.push(`jobsDone=${db.countDoneJobsForProject(projectId)}`);
  } catch {
    parts.push("jobsDone=?");
  }
  try {
    const rendersDir = path.join(paths.videoProjectsDir, projectId, "renders");
    let count = 0;
    let size = 0;
    let maxMtime = 0;
    for (const name of fs.readdirSync(rendersDir)) {
      const st = fs.statSync(path.join(rendersDir, name));
      if (!st.isFile()) continue;
      count += 1;
      size += st.size;
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
    }
    parts.push(`renders=${count}:${size}:${Math.round(maxMtime)}`);
  } catch {
    parts.push("renders=none");
  }
  try {
    const meta = readMeta(projectId);
    const out = normOutput(meta.output);
    const outAbs = out ? (path.isAbsolute(out) ? out : path.join(repoRoot, out)) : null;
    parts.push(
      outAbs && fs.existsSync(outAbs) ? `output=${fs.statSync(outAbs).size}` : "output=none",
    );
    parts.push(`metaStatus=${meta.status ?? ""}`);
  } catch {
    parts.push("output=?");
  }
  return parts.join("|");
}

/**
 * So bằng chứng tiến bộ với lần trước TRƯỚC KHI bump resumeAttempts:
 * có tiến bộ → reset đếm về 0 + lưu mark mới; không → giữ nguyên đếm.
 * Trả về số attempts hiện hành sau khi xét (đem so với cap).
 * Phiên không gắn project (chat tự do) không có bằng chứng - giữ nguyên đếm.
 */
function refreshResumeProgress(session: db.ChatSessionRow): number {
  if (!session.projectId) return session.resumeAttempts;
  let mark: string;
  try {
    mark = computeProgressMark(session.projectId);
  } catch {
    return session.resumeAttempts;
  }
  if (mark !== session.progressMark) {
    db.setProgressMark(session.sessionId, mark);
    db.resetResumeAttempts(session.sessionId);
    return 0;
  }
  return session.resumeAttempts;
}

/**
 * Gate hoàn thành phiên edit (goal='final'): video final phải TỒN TẠI THẬT mới coi là xong.
 * Trả về message resume nếu CHƯA đạt (output null / file không có trên đĩa / meta.status != done);
 * null = đạt hoặc không áp dụng (chat thường, project đã xóa, meta hỏng - không kẹt phiên).
 */
function finalGateResumeMessage(sessionId: string): string | null {
  const session = db.getChatSession(sessionId);
  if (!session || session.goal !== "final" || !session.projectId) return null;
  try {
    const meta = readMeta(session.projectId);
    const out = normOutput(meta.output);
    const outAbs = out ? (path.isAbsolute(out) ? out : path.join(repoRoot, out)) : null;
    if (out && outAbs && fs.existsSync(outAbs) && meta.status === "done") return null;
  } catch {
    // Project đã bị xóa / meta.json hỏng - không gate được, coi như xong để không kẹt phiên
    return null;
  }
  return (
    `Video final CHƯA tồn tại (outputs/${session.projectId}-vN.mp4). ` +
    "Nhiệm vụ chỉ hoàn thành khi render final xong và meta.json status=done + output trỏ file thật. " +
    "Kiểm tra trạng thái hiện tại rồi làm tiếp: render scene standard còn thiếu, assemble-final, " +
    "verify, cập nhật meta. " +
    "Nếu job render failed - đọc log job tìm nguyên nhân, sửa rồi chạy lại job, KHÔNG bỏ qua. " +
    "Nếu render đang chạy dở (job status running hoặc tiến trình render còn sống) - CHỜ nó chạy xong " +
    "rồi verify tiếp, KHÔNG chạy lại từ đầu."
  );
}

/**
 * Chạy agent async cho một message - caller (route POST /api/chat) đã trả 202 trước đó.
 * Không bao giờ throw; mọi lỗi đẩy qua SSE kind "error".
 * opts.continueRun = lượt auto-resume: GIỮ NGUYÊN runStartedAt + đếm resumeAttempts.
 */
export async function runAgent(
  sessionId: string,
  message: string,
  opts: { continueRun?: boolean } = {},
): Promise<void> {
  if (!hasClaudeAuth()) {
    emit({
      sessionId,
      kind: "error",
      error:
        "Chưa có xác thực Claude. Cách 1 (khuyên dùng): đăng nhập Claude Code trên máy này (VSCode extension hoặc chạy `claude` trong terminal rồi /login) - hệ thống tự dùng gói subscription. Cách 2: điền ANTHROPIC_API_KEY vào file .env rồi khởi động lại server.",
    });
    // "done" phải kèm status rõ ràng: thiếu status thì web mặc định coi là
    // thành công, trong khi lượt này thất bại ngay từ guard
    emit({ sessionId, kind: "done", status: "error" });
    return;
  }

  if (running.has(sessionId)) {
    emit({
      sessionId,
      kind: "error",
      error: "Agent đang chạy trong phiên này - chờ xong hoặc bấm dừng (interrupt) trước.",
    });
    // Kèm status "error": done không status bị web mặc định thành thành công
    emit({ sessionId, kind: "done", status: "error" });
    return;
  }

  // Chỉ ghi message vào lịch sử khi lượt chạy THẬT SỰ bắt đầu (đã qua các guard trên)
  db.addChatMessage(sessionId, "user", "text", message);
  db.touchChatSession(sessionId);

  const session = db.getChatSession(sessionId);
  const sdkSessionId = session?.sdkSessionId ?? null;

  // Message mới của user = lượt chạy mới: runStartedAt=now, runFinishedAt=null, resumeAttempts=0.
  // Lượt auto-resume (continueRun) GIỮ NGUYÊN mốc bắt đầu - UI đo elapsed liền mạch.
  if (!opts.continueRun) db.startChatRun(sessionId);

  // Message đầu của session mới: prepend CLAUDE.md (SDK không tự nạp CLAUDE.md)
  let prompt = message;
  if (!sdkSessionId) {
    try {
      const claudeMd = fs.readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8");
      prompt = `<project-instructions source="CLAUDE.md">\n${claudeMd}\n</project-instructions>\n\n${message}`;
    } catch {
      /* không có CLAUDE.md thì thôi */
    }
  }

  // Options theo API bản 0.3.x - cast qua Parameters<> để không gãy khi type Options thay đổi nhẹ
  const options: Record<string, unknown> = {
    cwd: repoRoot,
    permissionMode: "acceptEdits",
    allowedTools: ALLOWED_TOOLS,
    includePartialMessages: true,
    // Phiên edit goal='final' chạy pipeline dài (transcribe → scene → draft → verify → final)
    // - 100 turn không đủ, lượt kết thúc với subtype != success giữa chừng
    // Trần lượt của phiên dựng video lấy từ Cấu hình (đọc mỗi lần chạy nên đổi
    // là ăn ngay). Phiên chat thường giữ 100 - nó ngắn, không phải chỗ tốn tiền.
    maxTurns: session?.goal === "final" ? readRenderSettings().aiMaxTurns : 100,
    settingSources: ["project", "user"],
    systemPrompt: { type: "preset", preset: "claude_code" },
  };
  if (sdkSessionId) options.resume = sdkSessionId;
  // Model/effort người dùng đã chọn cho phiên (docs/API.md mục AI Providers) - chỉ set khi có
  if (session?.model) options.model = session.model;
  if (session?.effort) options.effort = session.effort;

  let q: Query;
  try {
    q = query({
      prompt,
      options: options as Parameters<typeof query>[0]["options"],
    });
  } catch (err) {
    db.finishChatRun(sessionId);
    emit({
      sessionId,
      kind: "error",
      error: `Không khởi động được agent: ${err instanceof Error ? err.message : String(err)}`,
    });
    // Kèm status "error": done không status bị web mặc định thành thành công
    emit({ sessionId, kind: "done", status: "error" });
    return;
  }

  running.set(sessionId, q);
  interruptedSessions.delete(sessionId);
  db.setChatSessionStatus(sessionId, "running");
  let textBuffer = "";
  let resultSaved = false;
  let hadError = false;

  try {
    for await (const raw of q) {
      const msg = raw as unknown as AgentMessage;

      if (msg.type === "system" && msg.subtype === "init") {
        // Lưu sdkSessionId để lần sau resume đúng phiên Claude Code
        if (typeof msg.session_id === "string" && msg.session_id) {
          db.setSdkSessionId(sessionId, msg.session_id);
        }
        continue;
      }

      if (msg.type === "stream_event") {
        const ev = msg.event;
        if (
          ev?.type === "content_block_delta" &&
          ev.delta?.type === "text_delta" &&
          typeof ev.delta.text === "string"
        ) {
          textBuffer += ev.delta.text;
          emit({ sessionId, kind: "text", text: ev.delta.text });
        }
        continue;
      }

      if (msg.type === "assistant") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "tool_use") {
              const tool = { name: String(block.name ?? "unknown"), input: block.input ?? {} };
              emit({ sessionId, kind: "tool", tool });
              db.addChatMessage(sessionId, "assistant", "tool", JSON.stringify(tool));
            }
          }
        }
        continue;
      }

      if (msg.type === "result") {
        // Ghi nhận token đã dùng cho lượt chạy này (gắn theo project của session)
        try {
          const inTok =
            (msg.usage?.input_tokens ?? msg.input_tokens ?? 0) +
            (msg.usage?.cache_creation_input_tokens ?? 0) +
            (msg.usage?.cache_read_input_tokens ?? 0);
          const outTok = msg.usage?.output_tokens ?? msg.output_tokens ?? 0;
          const cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
          if (inTok > 0 || outTok > 0 || cost > 0) {
            db.addTokenUsage(sessionId, session?.projectId ?? null, inTok, outTok, cost);
          }
        } catch {
          /* usage là phụ - không để hỏng luồng chính */
        }
        const finalText =
          typeof msg.result === "string" && msg.result.length > 0 ? msg.result : textBuffer;
        if (msg.subtype && msg.subtype !== "success") {
          hadError = true;
          emit({
            sessionId,
            kind: "error",
            error: `Agent kết thúc bất thường (${msg.subtype})`,
          });
        }
        if (finalText) {
          db.addChatMessage(sessionId, "assistant", "text", finalText);
          resultSaved = true;
        }
        emit({ sessionId, kind: "result", text: finalText });
      }
    }
  } catch (err) {
    hadError = true;
    // Lỗi giữa chừng: giữ lại phần text đã stream để không mất lịch sử
    if (textBuffer && !resultSaved) {
      db.addChatMessage(sessionId, "assistant", "text", textBuffer);
    }
    emit({
      sessionId,
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    running.delete(sessionId);
    // Trạng thái cuối bền vững - UI tắt/mở lại vẫn đọc được qua GET sessions
    const userInterrupted = interruptedSessions.has(sessionId);
    let status: db.ChatSessionStatus = userInterrupted
      ? "interrupted"
      : hadError
        ? "error"
        : "done";
    interruptedSessions.delete(sessionId);

    // Gate phiên edit (goal='final'): agent báo "done" nhưng video final CHƯA tồn tại → CHƯA xong.
    // Dùng đúng hạ tầng auto-resume: chờ 10s rồi tự chạy tiếp (tôn trọng autoResume + interrupt
    // + giới hạn resumeAttempts). Trong lúc chờ GIỮ status "running" - đúng ngữ nghĩa "chưa xong".
    const gateMessage = status === "done" ? finalGateResumeMessage(sessionId) : null;
    if (gateMessage) {
      const s = db.getChatSession(sessionId);
      // Có tiến bộ từ lượt trước (job done tăng / renders đổi / output xuất hiện) → reset đếm
      const attempts = s ? refreshResumeProgress(s) : 0;
      const cap = s ? maxResumeAttemptsFor(s) : MAX_RESUME_ATTEMPTS;
      const canRetry = s !== undefined && s.autoResume !== 0 && attempts < cap && hasClaudeAuth();
      if (canRetry) {
        db.setChatSessionStatus(sessionId, "running");
        db.bumpResumeAttempts(sessionId);
        // KHÔNG finishChatRun, KHÔNG emit "done" - phiên vẫn đang chạy với UI
        const timer = setTimeout(() => {
          pendingResumes.delete(sessionId);
          // Đọc tươi - user có thể đã interrupt / tắt autoResume trong lúc chờ
          const cur = db.getChatSession(sessionId);
          if (!cur || cur.status !== "running" || cur.autoResume === 0 || isAgentRunning(sessionId)) {
            return;
          }
          void runAgent(sessionId, gateMessage, { continueRun: true });
        }, RESUME_DELAY_MS);
        pendingResumes.set(sessionId, timer);
        return;
      }
      // Hết lượt thử liên tiếp KHÔNG tiến bộ / autoResume tắt / mất auth - kết thúc với "error"
      status = "error";
      db.addChatMessage(
        sessionId,
        "assistant",
        "text",
        `Đã dừng sau ${cap} lượt tự chạy liên tiếp mà KHÔNG có tiến bộ - video final vẫn chưa render xong. ` +
          'Xem log job/render tìm nguyên nhân rồi bấm gửi "tiếp tục" để chạy tiếp.',
      );
      emit({ sessionId, kind: "error", error: "Video final chưa tồn tại - phiên edit chưa hoàn thành" });
    }

    db.setChatSessionStatus(sessionId, status);

    // Auto-resume: chỉ khi lỗi KHÔNG do user bấm dừng, autoResume còn bật (đọc tươi -
    // user có thể vừa toggle), chưa quá số lượt, và còn xác thực Claude.
    const fresh = db.getChatSession(sessionId);
    // Tiến bộ giữa hai lượt (job done tăng / renders đổi / output xuất hiện) → reset đếm về 0
    const freshAttempts = fresh ? refreshResumeProgress(fresh) : 0;
    const shouldResume =
      status === "error" &&
      !userInterrupted &&
      fresh !== undefined &&
      fresh.autoResume !== 0 &&
      freshAttempts < maxResumeAttemptsFor(fresh) &&
      hasClaudeAuth();

    if (shouldResume) {
      db.bumpResumeAttempts(sessionId);
      // KHÔNG finishChatRun - lượt chạy chưa kết thúc hẳn, resume giữ nguyên runStartedAt
      const timer = setTimeout(() => {
        pendingResumes.delete(sessionId);
        // Đọc tươi - user có thể đã interrupt / tắt autoResume trong lúc chờ
        const s = db.getChatSession(sessionId);
        if (!s || s.status !== "error" || s.autoResume === 0 || isAgentRunning(sessionId)) return;
        void runAgent(sessionId, RESUME_MESSAGE, { continueRun: true });
      }, RESUME_DELAY_MS);
      pendingResumes.set(sessionId, timer);
    } else {
      // Kết thúc hẳn: done / user interrupt / error đã hết lượt resume
      db.finishChatRun(sessionId);
    }

    emit({ sessionId, kind: "done", status });
  }
}

/**
 * Tự chạy tiếp các phiên bị 'interrupted' do server restart (autoResume bật) -
 * index.ts gọi ~15s sau khi server listen. Tuần tự cách nhau 2s để không dồn cùng lúc.
 */
export async function autoResumeStartup(): Promise<void> {
  if (!hasClaudeAuth()) return;
  for (const id of db.startupInterruptedSessions) {
    const session = db.getChatSession(id);
    if (!session || session.status !== "interrupted" || session.autoResume === 0) continue;
    if (isAgentRunning(id)) continue;
    // KHÔNG truyền continueRun - lượt mới sau restart, mốc thời gian mới
    void runAgent(id, RESUME_MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
