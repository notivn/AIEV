import { spawn, type ChildProcess } from "node:child_process";
/**
 * Bỏ mã màu ANSI trước khi lưu/đẩy log.
 *
 * Python và ffmpeg tô màu traceback khi thấy stderr, và chuỗi điều khiển đó lọt
 * nguyên vào log của job rồi hiện lên UI thành rác kiểu `[1;31m...[0m` (đã gặp
 * thật với traceback của faster-whisper). Lọc ở ĐÂY - một chỗ duy nhất mọi job
 * đều đi qua - thay vì bắt từng trang web tự dọn.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Trần độ dài `step` - nó hiện cạnh thanh tiến trình, không phải chỗ để in cả traceback */
const MAX_STEP_CHARS = 160;

import * as db from "./db.js";
import { broadcast } from "./events.js";
import { childEnv } from "./config.js";
import { killTree, nowIso } from "./util.js";
import { queueConcurrency } from "./renderSettings.js";
import { runSceneRender } from "./jobs/sceneRender.js";
import { runAssemble } from "./jobs/assemble.js";
import { runImageGen } from "./jobs/imageGen.js";
import { runAutoCut } from "./jobs/autoCut.js";
import { runAutoTrim } from "./jobs/autoTrim.js";
import { runTextToVideo } from "./jobs/textToVideo.js";
import { runTranslateVideo } from "./jobs/translateVideo.js";

/**
 * Hàng đợi render trong process - chạy SONG SONG tối đa `queueConcurrency` job
 * (chỉnh trong tab "Tăng tốc"; đọc mỗi tick nên đổi là hiệu lực ngay).
 * Ràng buộc an toàn: hai job của CÙNG một project không bao giờ chạy đồng thời.
 */
function maxConcurrent(): number {
  const env = Number(process.env.QUEUE_CONCURRENCY);
  if (Number.isFinite(env) && env >= 1) return Math.min(4, env); // env thắng nếu đặt
  return queueConcurrency();
}

export interface JobCtx {
  job: db.JobRow;
  /** Ghi một dòng log: lưu DB + đẩy SSE `joblog` */
  log(line: string): void;
  /** Cập nhật progress/step: lưu DB + đẩy SSE `job` khi có thay đổi */
  progress(progress: number | null, step: string): void;
  /**
   * Spawn CLI bằng argv array - KHÔNG qua shell (đường dẫn/tham số chứa ký tự
   * đặc biệt không thể thoát thành lệnh khác); reject nếu exit != 0.
   */
  exec(
    file: string,
    args: string[],
    cwd: string,
    onLine?: (line: string) => void,
  ): Promise<void>;
  isCanceled(): boolean;
}

interface Current {
  jobId: string;
  /** Khóa "bận" - namespace theo loại job để job ảnh và job video cùng projectId không đụng nhau */
  busyKey: string;
  child: ChildProcess | null;
  canceled: boolean;
  /** Flush buffer log xuống DB - makeCtx gán; runJob gọi trước broadcast cuối */
  flushLog?: () => void;
}

/**
 * Khóa "bận" của một job. Mỗi loại nguồn có namespace riêng để job ảnh, job cắt
 * và job video trùng id vẫn chạy song song được; nhưng hai job CÙNG namespace và
 * CÙNG id thì không bao giờ chạy đồng thời (tránh giẫm renders/meta).
 *
 * "auto-trim" CỐ Ý rơi vào nhánh mặc định "vid:" cùng scene/assemble: nó ghi đè
 * asset của chính video project đó, chạy song song với một job render đang đọc
 * asset ấy là hỏng cả hai.
 */
function busyKeyOf(j: db.JobRow): string {
  const ns =
    j.type === "image-gen"
      ? "img:"
      : j.type === "auto-cut"
        ? "cut:"
        : j.type === "text-to-video"
          ? "t2v:"
          : j.type === "translate-video"
            ? "tvd:"
            : "vid:";
  return ns + j.projectId;
}

function broadcastJob(jobId: string): void {
  const row = db.getJob(jobId);
  if (row) broadcast("job", db.jobToApi(row));
}

class RenderQueue {
  private pending: string[] = [];
  private running = new Map<string, Current>();
  /**
   * jobId → các job phải XONG ("done") trước khi job này được chạy. Dùng cho một
   * lượt render của trình chỉnh sửa: scene-final của scene vừa sửa mà failed thì
   * assemble-final xếp sau KHÔNG được chạy tiếp - nó sẽ lặng lẽ lắp bằng bản
   * render cũ (hoặc bản draft) và người dùng nhận một video "final" sai nội dung.
   * Nằm trong RAM như chính hàng đợi: restart server là mọi job đang chờ đã bị
   * đánh failed (failStaleRunningJobs), nên mất map này cũng không sao.
   */
  private deps = new Map<string, string[]>();

  enqueue(jobId: string, dependsOn: string[] = []): void {
    if (dependsOn.length) this.deps.set(jobId, [...dependsOn]);
    this.pending.push(jobId);
    this.tick();
  }

  /**
   * Job phụ thuộc chưa xong hẳn (failed/canceled/mất khỏi DB) → lý do từ chối
   * chạy; null = chạy được. Hàng đợi chạy job CÙNG project tuần tự theo thứ tự
   * xếp, nên tới lượt job này thì các job nó phụ thuộc (xếp trước, cùng project)
   * đều đã kết thúc - không cần chờ, chỉ cần soi kết quả.
   */
  private unmetDependency(jobId: string): string | null {
    const deps = this.deps.get(jobId);
    this.deps.delete(jobId);
    for (const depId of deps ?? []) {
      const dep = db.getJob(depId);
      if (dep?.status === "done") continue;
      const what = dep
        ? `${dep.type}${dep.sceneId ? ` của scene "${dep.sceneId}"` : ""} (${depId})`
        : `job ${depId}`;
      return (
        `${what} xếp cùng lượt render đã ${dep?.status ?? "biến mất"} - không chạy tiếp để khỏi ` +
        "lắp bằng bản render cũ/bản draft. Xem log job đó, sửa lỗi rồi render lại."
      );
    }
    return null;
  }

  /**
   * Hủy job: đang chờ → gỡ khỏi hàng đợi; đang chạy → kill process tree.
   * Trả về true nếu có gì đó để hủy.
   */
  cancel(jobId: string): boolean {
    const idx = this.pending.indexOf(jobId);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
      this.deps.delete(jobId);
      db.updateJob(jobId, { status: "canceled", step: "Đã hủy", finishedAt: nowIso() });
      db.appendJobLog(jobId, "[queue] Job bị hủy khi đang chờ.");
      broadcastJob(jobId);
      return true;
    }
    const cur = this.running.get(jobId);
    if (cur) {
      cur.canceled = true;
      db.updateJob(jobId, { status: "canceled", step: "Đã hủy", finishedAt: nowIso() });
      db.appendJobLog(jobId, "[queue] Job bị hủy - kill process tree.");
      if (cur.child) killTree(cur.child);
      broadcastJob(jobId);
      return true;
    }
    return false;
  }

  /** Nạp job mới vào các slot trống - bỏ qua job có busyKey (loại job + project) đang bận */
  private tick(): void {
    while (this.running.size < maxConcurrent()) {
      const busyKeys = new Set([...this.running.values()].map((c) => c.busyKey));
      const idx = this.pending.findIndex((id) => {
        const j = db.getJob(id);
        if (!j || j.status !== "queued") return true; // job hỏng/đã hủy - lấy ra để loại bỏ
        return !busyKeys.has(busyKeyOf(j));
      });
      if (idx < 0) break;
      const jobId = this.pending.splice(idx, 1)[0];
      const job = db.getJob(jobId);
      if (!job || job.status !== "queued") {
        this.deps.delete(jobId); // đã bị hủy trước khi tới lượt
        continue;
      }
      void this.runJob(jobId, busyKeyOf(job));
    }
  }

  private async runJob(jobId: string, busyKey: string): Promise<void> {
    const current: Current = { jobId, busyKey, child: null, canceled: false };
    this.running.set(jobId, current);

    db.updateJob(jobId, { status: "running", startedAt: nowIso(), step: "Bắt đầu", progress: 0 });
    broadcastJob(jobId);

    const ctx = this.makeCtx(jobId, current);
    try {
      const fresh = db.getJob(jobId)!;
      ctx.job = fresh;
      const unmet = this.unmetDependency(jobId);
      if (unmet) throw new Error(unmet);
      if (fresh.type === "scene-draft" || fresh.type === "scene-final") {
        await runSceneRender(ctx);
      } else if (fresh.type === "image-gen") {
        await runImageGen(ctx);
      } else if (fresh.type === "text-to-video") {
        await runTextToVideo(ctx);
      } else if (fresh.type === "translate-video") {
        await runTranslateVideo(ctx);
      } else if (fresh.type === "auto-cut") {
        await runAutoCut(ctx);
      } else if (fresh.type === "auto-trim") {
        await runAutoTrim(ctx);
      } else {
        await runAssemble(ctx);
      }
      if (!current.canceled) {
        db.updateJob(jobId, {
          status: "done",
          progress: 100,
          step: "Hoàn thành",
          finishedAt: nowIso(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      current.flushLog?.(); // giữ đúng thứ tự log trước dòng [error]
      db.appendJobLog(jobId, `[error] ${message}`);
      if (!current.canceled) {
        db.updateJob(jobId, {
          status: "failed",
          step: message.slice(0, 200),
          finishedAt: nowIso(),
        });
      }
    } finally {
      current.flushLog?.();
      broadcastJob(jobId);
      this.running.delete(jobId);
      this.tick();
    }
  }

  private makeCtx(jobId: string, current: Current): JobCtx {
    let lastProgress = -1;
    let lastStep = "";

    // Batch log: mỗi dòng là một UPDATE `log = log || ?` (O(n²) khi log dài) -
    // gom buffer, flush MỘT lần khi đủ 50 dòng hoặc sau 1s. SSE vẫn đẩy từng dòng ngay.
    let pendingLines: string[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pendingLines.length) return;
      const lines = pendingLines;
      pendingLines = [];
      db.appendJobLog(jobId, lines.join("\n"));
    };
    current.flushLog = flush;
    const addLogLine = (line: string): void => {
      pendingLines.push(line);
      if (pendingLines.length >= 50) {
        flush();
      } else if (!flushTimer) {
        flushTimer = setTimeout(flush, 1_000);
        flushTimer.unref?.();
      }
    };

    return {
      job: db.getJob(jobId)!,
      log: (line: string) => {
        const clean = stripAnsi(line);
        addLogLine(clean);
        broadcast("joblog", { jobId, line: clean });
      },
      progress: (progress: number | null, step: string) => {
        if (current.canceled) return;
        const p = progress === null ? null : Math.max(0, Math.min(100, Math.round(progress)));
        // step hiện cạnh thanh tiến trình trên UI - cắt ngắn ở đây chứ không để
        // UI gánh: một dòng traceback dài từng lọt vào đây và đẩy toác cả cột.
        const cleanStep = stripAnsi(step).slice(0, MAX_STEP_CHARS);
        const changed = (p !== null && p !== lastProgress) || cleanStep !== lastStep;
        if (!changed) return;
        if (p !== null) lastProgress = p;
        lastStep = cleanStep;
        db.updateJob(jobId, { ...(p !== null ? { progress: p } : {}), step: cleanStep });
        broadcastJob(jobId);
      },
      exec: (file: string, args: string[], cwd: string, onLine?: (line: string) => void) =>
        new Promise<void>((resolve, reject) => {
          if (current.canceled) {
            reject(new Error("Job đã bị hủy"));
            return;
          }
          const command = `${file} ${args.join(" ")}`;
          addLogLine(`[cmd] ${command}`);
          broadcast("joblog", { jobId, line: `[cmd] ${command}` });

          // KHÔNG shell - argv array; CLI node chạy bằng process.execPath (xem util.cliJsPath)
          // env: childEnv() chứ KHÔNG phải process.env - đây là đường chạy
          // hyperframes/remotion, nơi bundle webpack ~1,7GB + thư mục asset
          // ~190MB của mỗi lần lắp ráp rơi vào TEMP (xem childEnv ở config.ts).
          const child = spawn(file, args, {
            cwd,
            windowsHide: true,
            env: childEnv(),
          });
          current.child = child;

          const buffers: Record<"out" | "err", string> = { out: "", err: "" };
          const handleChunk = (which: "out" | "err", chunk: Buffer) => {
            buffers[which] += chunk.toString("utf8");
            // Remotion dùng \r để vẽ lại dòng tiến độ - tách cả \r lẫn \n
            const parts = buffers[which].split(/\r\n|\n|\r/);
            buffers[which] = parts.pop() ?? "";
            for (const raw of parts) {
              const line = raw.trimEnd();
              if (!line) continue;
              addLogLine(line);
              broadcast("joblog", { jobId, line });
              onLine?.(line);
            }
          };
          child.stdout?.on("data", (c: Buffer) => handleChunk("out", c));
          child.stderr?.on("data", (c: Buffer) => handleChunk("err", c));

          child.on("error", (err) => {
            current.child = null;
            reject(err);
          });
          child.on("close", (code) => {
            current.child = null;
            for (const which of ["out", "err"] as const) {
              const rest = buffers[which].trim();
              if (rest) {
                addLogLine(rest);
                broadcast("joblog", { jobId, line: rest });
                onLine?.(rest);
              }
            }
            if (current.canceled) reject(new Error("Job đã bị hủy"));
            else if (code === 0) resolve();
            else reject(new Error(`Lệnh thoát với mã ${code ?? "?"}`));
          });
        }),
      isCanceled: () => current.canceled,
    };
  }
}

export const queue = new RenderQueue();
