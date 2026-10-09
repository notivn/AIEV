import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { Request } from "express";
import { apiToken, childEnv, repoRoot } from "./config.js";

/**
 * Lỗi HTTP có mã - error handler ở index.ts sẽ trả { error: { code, message } }.
 *
 * `extra` = dữ liệu máy đọc được đi KÈM lỗi, nằm ngang hàng `error` trong body
 * (cùng kiểu `raw` của POST /api/skills/generate): vd 409 VERSION_CONFLICT kèm
 * `current` để editor hiện bản mới mà không phải gọi thêm một GET, 400
 * INVALID_TIMELINE kèm `issues` chỉ đích danh từng phần tử hỏng.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Request đến TRỰC TIẾP từ chính máy chủ (dashboard/agent/CLI trên localhost)?
 *
 * Điều kiện: socket là loopback VÀ không có bất kỳ header `x-forwarded-*` nào.
 * Next.js (proxy /api, /media của web 6868) LUÔN set x-forwarded-host /
 * x-forwarded-port / x-forwarded-for cho mọi request nó chuyển tiếp
 * (base-server.js: `req.headers['x-forwarded-host'] ??= ...`), và client không
 * gỡ được các header đó - nên mọi request đi qua proxy (kể cả từ LAN hay
 * Cloudflare Tunnel) đều KHÔNG được coi là local, dù socket là 127.0.0.1.
 */
export function isLocalRequest(req: Request): boolean {
  if (
    req.headers["x-forwarded-for"] ||
    req.headers["x-forwarded-host"] ||
    req.headers["x-forwarded-port"] ||
    req.headers["x-forwarded-proto"] ||
    req.headers["cf-connecting-ip"]
  ) {
    return false;
  }
  const addr = req.ip || req.socket.remoteAddress || "";
  return LOOPBACK.has(addr);
}

/** So sánh chuỗi bí mật theo thời gian hằng - tránh timing attack đoán token */
export function secretEquals(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Lấy cookie theo tên từ header Cookie (không kéo thêm dependency cookie-parser) */
export function cookieValue(req: Request, name: string): string {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

/**
 * Request có mang TOKEN CHÍNH của dashboard hay không - token này mở toàn bộ
 * API, nên chỗ nào đang lấy "đến từ chính máy chủ" làm bằng chứng tin cậy thì
 * cũng phải chấp nhận nó: dashboard mở qua tunnel là truy cập từ xa nhưng vẫn
 * là chủ máy. Token đi bằng header, cookie hoặc query `?t=` (giống middleware
 * xác thực chung ở index.ts).
 */
export function hasMasterToken(req: Request): boolean {
  const token = apiToken();
  if (!token) return false;
  const header = req.headers["x-aiev-token"];
  if (typeof header === "string" && secretEquals(header, token)) return true;
  if (secretEquals(cookieValue(req, "aiev_token"), token)) return true;
  const t = req.query?.t;
  return typeof t === "string" && secretEquals(t, token);
}

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isKebabCase(s: string): boolean {
  return KEBAB_RE.test(s);
}

/** Ép chuỗi (tên file, id) về ASCII kebab-case - bỏ dấu tiếng Việt, đ→d */
export function toKebabAscii(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // bỏ dấu (combining marks sau NFD)
    .replace(/đ/g, "d") // đ
    .replace(/Đ/g, "d") // Đ
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Ép tên file về ASCII kebab-case, giữ phần mở rộng */
export function sanitizeFileName(original: string): string {
  const ext = path.extname(original).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const base = toKebabAscii(path.basename(original, path.extname(original)));
  return `${base || "file"}${ext}`;
}

export type FileKind = "video" | "audio" | "image" | "other";

export interface FileInfo {
  name: string;
  relPath: string;
  size: number;
  mtime: string;
  kind: FileKind;
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);

export function fileKind(name: string): FileKind {
  const ext = path.extname(name).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (IMAGE_EXT.has(ext)) return "image";
  return "other";
}

/** relPath luôn tính từ repo root, dấu / - dùng thẳng cho /media/<relPath> */
export function toRepoRel(absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

export function fileInfoOf(absPath: string): FileInfo {
  const st = fs.statSync(absPath);
  return {
    name: path.basename(absPath),
    relPath: toRepoRel(absPath),
    size: st.size,
    mtime: st.mtime.toISOString(),
    kind: fileKind(absPath),
  };
}

/** Liệt kê file (đệ quy) trong một thư mục; thư mục không tồn tại → [] */
export function listFilesRecursive(absDir: string): FileInfo[] {
  if (!fs.existsSync(absDir)) return [];
  const out: FileInfo[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(fileInfoOf(abs));
    }
  };
  walk(absDir);
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Move file, fallback copy+unlink nếu rename qua ổ đĩa khác thất bại */
export function moveFile(src: string, dst: string): void {
  ensureDir(path.dirname(dst));
  try {
    fs.renameSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}

/** Kill cả cây process (Windows: taskkill /t - npx/shell spawn con như node/chromium/ffprobe) */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
    });
  } else {
    // Đã thoát rồi thì pid có thể đã bị tiến trình KHÁC dùng lại - đừng giết
    // nhầm; con cháu của nó cũng đã được hệ thống nhận nuôi, không còn tìm được
    if (child.exitCode !== null || child.signalCode !== null) return;
    // child.kill chỉ giết tiến trình trực tiếp (node của remotion/hyperframes);
    // Chromium + ffmpeg nó đẻ ra sẽ mồ côi và chạy tiếp tới hết render. Gom cả
    // cây con cháu qua `ps` rồi giết từ lá lên.
    const pids = [...descendantPids(child.pid), child.pid];
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* đã chết */
      }
    }
  }
}

/** Mọi pid con cháu của `root` (POSIX), con cháu sâu nhất đứng trước */
function descendantPids(root: number): number[] {
  let table: string;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const walk = (pid: number): void => {
    for (const c of children.get(pid) ?? []) {
      walk(c);
      out.push(c);
    }
  };
  walk(root);
  return out;
}

/**
 * Chạy một lệnh lấy stdout - KHÔNG qua shell (argv array), nên tên file/tham số
 * chứa ký tự đặc biệt (`&`, `|`, `"`, `$(...)`) không thể thoát ra thành lệnh khác.
 * reject nếu exit != 0 hoặc quá timeout.
 */
export function execFileCapture(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const command = `${file} ${args.join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd ?? repoRoot,
      windowsHide: true,
      // Ép TEMP/HF_HOME... về .runtime/ trong repo - xem childEnv() ở config.ts
      env: childEnv(),
    });
    let out = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Kill cả cây để không rò process con (chromium/ffprobe) mồ côi trên Windows
      killTree(child);
      reject(new Error(`Lệnh quá thời gian: ${command}`));
    }, opts.timeoutMs ?? 10_000);
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", () => {
      /* bỏ qua stderr */
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`Lệnh thoát mã ${code}: ${command}`));
    });
  });
}

/**
 * Đường dẫn file JS của một CLI trong node_modules (đọc field `bin` của package).
 *
 * Dùng thay cho `npx <cli>`: chạy `process.execPath <binJs> ...` bằng execFile
 * KHÔNG shell. Trên Windows không thể spawn `npx.cmd` khi shell:false (Node
 * chặn .cmd/.bat từ bản vá CVE-2024-27980), nên gọi thẳng file .js/.mjs là
 * cách duy nhất vừa không shell vừa chạy được - lại nhanh hơn vì bỏ qua npx.
 */
/**
 * Như execFileCapture nhưng GIỮ CẢ stderr và KHÔNG reject khi exit != 0.
 *
 * ffmpeg ghi toàn bộ kết quả đo (loudnorm, blackdetect, silencedetect,
 * signalstats…) ra stderr, và nhiều filter đo xong thì thoát mã khác 0 -
 * execFileCapture nuốt stderr nên không dùng cho việc đo được.
 */
export function execFileCaptureAll(
  file: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    /**
     * Hủy giữa chừng. BẮT BUỘC truyền khi gọi từ trong một job của hàng đợi:
     * queue chỉ giết được process nó tự spawn qua `ctx.exec`, còn process spawn
     * ở đây thì nó không biết. Đã gặp thật: hủy job auto-cut lúc đang transcribe
     * thì job báo "đã hủy" nhưng tiến trình whisper vẫn chạy tiếp, ăn GPU.
     */
    isCanceled?: () => boolean;
  } = {},
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  canceled: boolean;
}> {
  const command = `${file} ${args.join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd ?? repoRoot,
      windowsHide: true,
      // ffmpeg/whisper/CLI node đều đi qua đây - xem childEnv() ở config.ts
      env: childEnv(),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let canceled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs ?? 120_000);
    // Poll thay vì signal: JobCtx chỉ phơi ra hàm isCanceled(), không có AbortSignal
    const cancelTimer = opts.isCanceled
      ? setInterval(() => {
          if (settled || !opts.isCanceled?.()) return;
          canceled = true;
          killTree(child);
        }, 1_000)
      : null;
    cancelTimer?.unref?.();
    const clearAll = (): void => {
      clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
    };
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearAll();
      reject(new Error(`Không chạy được lệnh (${command}): ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearAll();
      resolve({ code, stdout, stderr, timedOut, canceled });
    });
  });
}

export function cliJsPath(pkg: string, binName: string): string {
  const pkgJson = path.join(repoRoot, "node_modules", ...pkg.split("/"), "package.json");
  if (!fs.existsSync(pkgJson)) {
    throw new Error(`Chưa cài package "${pkg}" - chạy npm install ở repo root`);
  }
  const raw = JSON.parse(fs.readFileSync(pkgJson, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const rel = typeof raw.bin === "string" ? raw.bin : raw.bin?.[binName];
  if (!rel) throw new Error(`Package "${pkg}" không khai báo bin "${binName}"`);
  return path.join(path.dirname(pkgJson), rel);
}

/** CLI HyperFrames (thay cho `npx hyperframes`) */
export function hyperframesCli(): string {
  return cliJsPath("hyperframes", "hyperframes");
}

/** CLI Remotion (thay cho `npx remotion`) */
export function remotionCli(): string {
  return cliJsPath("@remotion/cli", "remotion");
}

/**
 * Độ dài fade âm thanh ở mỗi mép cắt. 30ms - đủ dập bậc nhảy, quá ngắn để tai
 * nghe ra là tiếng vuốt.
 */
export const CUT_FADE_SEC = 0.03;

/**
 * Chuỗi filter fade cho HAI đầu một đoạn audio vừa cắt ra.
 *
 * VÌ SAO BẮT BUỘC: cắt giữa dòng âm thanh là cắt ngang một sóng đang ở biên độ
 * bất kỳ. Mẫu cuối của mảnh trước và mẫu đầu của mảnh sau chẳng liên quan gì
 * nhau, nên mối nối thành một bậc nhảy dựng đứng - tai nghe ra tiếng "tách".
 * Một video auto-cut có hàng trăm mối nối, nên nó thành tiếng lộp bộp suốt bài
 * chứ không phải một tiếng lẻ. Fade kéo hai đầu về 0 nên không còn bậc nào.
 *
 * PHẢI đặt SAU asetpts=PTS-STARTPTS: afade tính `st` theo mốc của chính luồng,
 * còn giữ timestamp gốc thì st=0 nằm ở quá khứ và fade vào không bao giờ chạy.
 *
 * Trả về chuỗi KHÔNG kèm dấu phẩy đầu; "" khi mảnh ngắn tới mức fade sẽ nuốt
 * gần hết tiếng (hai fade chồng lên nhau).
 */
export function audioCutFade(durationSec: number): string {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return "";
  // Trần dur/2 để fade vào và fade ra không giẫm lên nhau ở mảnh ngắn.
  const d = Math.min(CUT_FADE_SEC, durationSec / 2);
  // Dưới 5ms thì fade ngắn hơn một chu kỳ tiếng trầm - vô nghĩa, bỏ luôn.
  if (d < 0.005) return "";
  const outStart = durationSec - d;
  return `afade=t=in:st=0:d=${d.toFixed(3)},afade=t=out:st=${outStart.toFixed(3)}:d=${d.toFixed(3)}`;
}

/** Đo thời lượng file media bằng ffprobe → ms, null nếu ffprobe fail */
export async function ffprobeDurationMs(absFile: string): Promise<number | null> {
  try {
    const out = await execFileCapture(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", absFile],
      { timeoutMs: 15_000 },
    );
    const sec = parseFloat(out.trim());
    if (!Number.isFinite(sec)) return null;
    return Math.round(sec * 1000);
  } catch {
    return null;
  }
}
