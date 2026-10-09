import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { nanoid } from "nanoid";

/**
 * Tìm repo root bằng cách đi ngược lên đến khi gặp file CLAUDE.md.
 * Thử từ vị trí file này (chạy được cả src/ lẫn dist/) rồi tới cwd.
 */
function findRepoRoot(): string {
  const starts = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (;;) {
      if (fs.existsSync(path.join(dir, "CLAUDE.md"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    "Không tìm thấy repo root (file CLAUDE.md). Hãy chạy server bên trong repo Edit-Video-AI.",
  );
}

export const repoRoot = findRepoRoot();

// Nạp .env từ repo root (ANTHROPIC_API_KEY, SERVER_PORT, ...)
dotenv.config({ path: path.join(repoRoot, ".env"), quiet: true });

export const SERVER_PORT = Number(process.env.SERVER_PORT || 6869);

const ENV_FILE = path.join(repoRoot, ".env");

/**
 * Upsert/xóa một biến trong .env - giữ nguyên comment và các dòng khác.
 * Dùng chung cho connections.ts (API key), tunnel.ts (TUNNEL_DOMAIN) và
 * apiToken() bên dưới. Đặt ở config.ts (nơi đã có repoRoot) để không tạo
 * vòng import config → routes/connections → config.
 *
 * Bảo mật: value KHÔNG được chứa xuống dòng - nếu không, một chuỗi kiểu
 * "abc\nANTHROPIC_API_KEY=xxx" sẽ ghi đè biến khác trong .env (env injection).
 */
export function upsertEnvVar(name: string, value: string | null): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Tên biến .env không hợp lệ: ${name}`);
  }
  if (value !== null && /[\r\n]/.test(value)) {
    throw new Error("Giá trị .env không được chứa ký tự xuống dòng");
  }
  let lines: string[] = [];
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  }
  const re = new RegExp(`^\\s*#?\\s*${name}\\s*=`);
  const filtered = lines.filter((l) => !re.test(l));
  // Bỏ dòng trống cuối để nối gọn
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") filtered.pop();
  if (value !== null) filtered.push(`${name}=${value}`);
  fs.writeFileSync(ENV_FILE, filtered.join("\n") + "\n", "utf8");
}

let cachedApiToken: string | null = null;

/**
 * Token xác thực API dùng chung (AIEV_API_TOKEN trong .env).
 * Chưa có → tự sinh và ghi vào .env ngay lần gọi đầu, nên máy mới clone repo
 * không phải cấu hình gì. Mọi request KHÔNG phải loopback trực tiếp đều phải
 * kèm token này (header `x-aiev-token`, query `?t=`, hoặc cookie `aiev_token`),
 * trừ đường upload từ điện thoại dùng token phiên QR (`?k=`).
 */
export function apiToken(): string {
  if (cachedApiToken) return cachedApiToken;
  const fromEnv = (process.env.AIEV_API_TOKEN ?? "").trim();
  if (fromEnv) {
    cachedApiToken = fromEnv;
    return cachedApiToken;
  }
  const generated = nanoid(32);
  try {
    upsertEnvVar("AIEV_API_TOKEN", generated);
  } catch (err) {
    // Không ghi được .env (read-only) - vẫn chạy được trong phiên này
    console.warn(
      `[config] Không ghi được AIEV_API_TOKEN vào .env: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  process.env.AIEV_API_TOKEN = generated;
  cachedApiToken = generated;
  return generated;
}

/**
 * Có xác thực Claude cho Agent SDK không - theo thứ tự SDK tự nhận:
 * env key (API key / OAuth token / gateway token) hoặc đăng nhập subscription
 * của Claude Code trên máy (~/.claude/.credentials.json, hoặc CLAUDE_CONFIG_DIR).
 */
export function hasClaudeAuth(): boolean {
  if (
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.ANTHROPIC_AUTH_TOKEN
  ) {
    return true;
  }
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude");
  if (fs.existsSync(path.join(configDir, ".credentials.json"))) return true;
  // macOS: Claude Code lưu OAuth trong Keychain, KHÔNG có .credentials.json
  return darwinKeychainHasClaudeCreds();
}

// Cache kết quả tra Keychain 60s - health poll mỗi 30s, không spawn security liên tục
let keychainCache: { at: number; ok: boolean } | null = null;
function darwinKeychainHasClaudeCreds(): boolean {
  if (process.platform !== "darwin") return false;
  if (keychainCache && Date.now() - keychainCache.at < 60_000) return keychainCache.ok;
  let ok = false;
  try {
    execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
      stdio: "ignore",
      timeout: 3000,
    });
    ok = true;
  } catch {
    /* không có item trong Keychain */
  }
  keychainCache = { at: Date.now(), ok };
  return ok;
}

/** Origin của web UI được phép gọi trực tiếp (Next.js dev có thể bỏ rewrite) */
export const WEB_ORIGINS = [
  "http://localhost:6868",
  "http://127.0.0.1:6868",
];

/**
 * Web UI mở qua LAN (điện thoại/tablet vào http://<ip-máy-chủ>:6868) - upload
 * file lớn gọi THẲNG backend 6869 nên origin dạng IP private :6868 phải được
 * phép CORS. Chỉ chấp nhận dải IP private (RFC 1918), không mở cho IP công cộng.
 */
// Kèm dải CGNAT 100.64.0.0/10 - IP của Tailscale (điện thoại dùng 4G/5G vẫn upload được qua tailnet)
const LAN_WEB_ORIGIN_RE =
  /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+):6868$/;

/** Origin có được phép gọi trực tiếp backend không (localhost + LAN private) */
export function isAllowedWebOrigin(origin: string): boolean {
  return WEB_ORIGINS.includes(origin) || LAN_WEB_ORIGIN_RE.test(origin);
}

const serverDir = path.join(repoRoot, "apps", "server");

export const paths = {
  serverDir,
  dataDir: path.join(serverDir, "data"),
  /** Thư mục tạm cho multer trước khi move về đích (cùng ổ đĩa để rename được) */
  uploadTmpDir: path.join(serverDir, "data", "tmp-uploads"),
  videoProjectsDir: path.join(repoRoot, "video-projects"),
  /** Image projects (tạo ảnh AI - Gemini nền + Remotion hoàn thiện) */
  imageProjectsDir: path.join(repoRoot, "image-projects"),
  /** Auto cut videos - mỗi phiên cắt một thư mục (meta.json + transcript + nền) */
  autoCutDir: path.join(repoRoot, "auto-cut"),
  /** Text to video - mỗi phiên một thư mục (bài đã bóc + kịch bản + giọng đọc) */
  textToVideoDir: path.join(repoRoot, "text-to-video"),
  /** Dịch video - mỗi phiên một thư mục (video nguồn + transcript + bản dịch + output) */
  translateVideoDir: path.join(repoRoot, "translate-video"),
  assetsDir: path.join(repoRoot, "assets"),
  /** Brand assets: logo + design-system.json cũ (nguồn migration sang Style Design) */
  brandDir: path.join(repoRoot, "assets", "brand"),
  /** Style Design: styles.json (nhiều bộ nhận diện) */
  stylesDir: path.join(repoRoot, "assets", "styles"),
  /** File upload của style (logo, font) - serve qua /media/assets/styles/files/ */
  stylesFilesDir: path.join(repoRoot, "assets", "styles", "files"),
  sfxDir: path.join(repoRoot, "assets", "sound-effects"),
  /**
   * Giọng đã nhân bản: library.json + mỗi giọng một thư mục chứa file mẫu.
   * Nằm trong assets/ (không phải data/) để người dùng sao lưu / mang sang máy
   * khác được - mẫu ghi âm là thứ họ tự tạo ra, không phải cache sinh lại được.
   */
  voicesDir: path.join(repoRoot, "assets", "voices"),
  /** Thư viện nhạc nền dùng chung (library.json + file nhạc) */
  musicDir: path.join(repoRoot, "assets", "music"),
  outputsDir: path.join(repoRoot, "outputs"),
  importsDir: path.join(repoRoot, "imports"),
  skillsDir: path.join(repoRoot, ".claude", "skills"),
  remotionDir: path.join(repoRoot, "engines", "remotion"),
  /** Nơi stage asset bằng hardlink cho Remotion staticFile() */
  stagingDir: path.join(repoRoot, "engines", "remotion", "public", "staging"),
  /**
   * Font overlay của tầng lắp ráp (Inter subset latin + vietnamese). Render qua
   * CLI đọc bằng staticFile("fonts/..."); trình phát xem trước trong dashboard
   * đọc cùng các file này qua /media/remotion-fonts/ (routes/media.ts).
   */
  remotionFontsDir: path.join(repoRoot, "engines", "remotion", "public", "fonts"),
  /**
   * Dữ liệu tạm lúc chạy - TẤT CẢ nằm trong repo, KHÔNG rải ra ổ hệ thống.
   *
   * Đo được trên máy Windows này (repo ở ổ F:, ổ C: chỉ còn 17,7GB trống):
   * mỗi lần Remotion lắp ráp ghi ~1,7GB bundle webpack + ~190MB thư mục asset
   * vào thư mục tạm của Windows trên C:; model whisper nằm ở
   * C:\Users\<user>\.cache\huggingface (13,3GB); cache pip trong AppData (3,2GB).
   * Gom hết về đây thì mọi thứ ở cùng ổ với repo, và chỉ cần loại trừ MỘT thư
   * mục khi sao lưu.
   *
   * Cả thư mục XÓA ĐƯỢC bất cứ lúc nào - hệ thống tự tạo lại.
   */
  runtime: {
    root: path.join(repoRoot, ".runtime"),
    /** TEMP/TMP/TMPDIR của mọi tiến trình con (bundle Remotion, profile Chrome...) */
    tmp: path.join(repoRoot, ".runtime", "tmp"),
    /** HF_HOME - model whisper tải từ HuggingFace */
    models: path.join(repoRoot, ".runtime", "models"),
    /** Virtualenv Python (faster-whisper, vieneu) */
    venv: path.join(repoRoot, ".runtime", "venv"),
    /** Binary tải riêng (ffmpeg, cloudflared) */
    bin: path.join(repoRoot, ".runtime", "bin"),
    /** PIP_CACHE_DIR */
    pipCache: path.join(repoRoot, ".runtime", "pip-cache"),
  },
} as const;

/**
 * Interpreter Python của virtualenv trong repo, null nếu chưa tạo venv.
 *
 * Dùng làm ứng viên ĐẦU TIÊN khi dò Python (transcribe.ts, ttsLocal.ts): venv
 * này do `start/doctor.mjs` dựng, cài sẵn faster-whisper/vieneu và mọi thứ nó
 * tải về đều nằm trong repo. Người dùng đặt PYTHON_BIN thì bản đó vẫn thắng -
 * đó là cửa thoát khi muốn chỉ định tay.
 */
export function venvPython(): string | null {
  const exe =
    process.platform === "win32"
      ? path.join(paths.runtime.venv, "Scripts", "python.exe")
      : path.join(paths.runtime.venv, "bin", "python");
  return fs.existsSync(exe) ? exe : null;
}

/**
 * Môi trường cho TIẾN TRÌNH CON - copy của process.env đã ép mọi thứ "phình to"
 * về `.runtime/` trong repo. KHÔNG BAO GIỜ sửa process.env của chính server:
 * đổi TEMP của tiến trình đang chạy là đổi luôn os.tmpdir() của mọi thư viện
 * đã cache đường dẫn, và nếu .runtime/ bị xóa giữa chừng thì server chết theo.
 *
 * Vì sao từng biến (số liệu đo trên máy Windows này, ổ C: chỉ còn 17,7GB):
 * - TEMP/TMP/TMPDIR: os.tmpdir() của Node đọc TEMP/TMP trên Windows và TMPDIR
 *   trên POSIX. Đây là thứ kéo bundle webpack ~1,7GB của Remotion và thư mục
 *   profile/asset ~190MB của Chrome headless ra khỏi ổ hệ thống - mỗi lần lắp
 *   ráp lại sinh một bộ mới.
 * - HF_HOME + HUGGINGFACE_HUB_CACHE: model whisper. Trên máy này
 *   C:\Users\<user>\.cache\huggingface đã phình lên 13,3GB. Phải set CẢ HAI:
 *   bản huggingface_hub cũ chỉ đọc HUGGINGFACE_HUB_CACHE, bản mới đọc HF_HOME.
 * - PIP_CACHE_DIR: cache wheel của pip trong AppData đo được 3,2GB (torch +
 *   ctranslate2 là những gói nặng nhất).
 *
 * `extra` ghi đè sau cùng - chỗ gọi vẫn thêm/sửa biến riêng được.
 */
/**
 * Thư mục chứa DLL của CUDA do pip cài (nvidia-cublas-cu12, nvidia-cudnn-cu12,
 * nvidia-cuda-runtime-cu12, nvidia-cuda-nvrtc-cu12) trong venv của dự án.
 *
 * ĐÃ ĐO, đừng đổi cách khác:
 * - Không chèn vào PATH thì faster-whisper báo "cublas64_12.dll is not found"
 *   rồi rơi về CPU: video 55s mất 124s thay vì chạy GPU.
 * - `os.add_dll_directory` bên phía Python KHÔNG ăn, vì ctranslate2 là thư viện
 *   native gọi LoadLibrary tên trần - đường tìm kiếm đó không áp cho nó.
 * - Thiếu riêng gói cuda-runtime cũng ra ĐÚNG thông báo "not found" dù file
 *   cublas có mặt, vì cuBLAS phụ thuộc cudart. Cài đủ 4 gói mới chạy.
 *
 * Quét một lần rồi nhớ: childEnv() gọi ở mọi lần spawn, quét đĩa mỗi lần là phí.
 */
let cudaDirsCache: string[] | null = null;
function cudaDllDirs(): string[] {
  if (cudaDirsCache) return cudaDirsCache;
  const out: string[] = [];
  try {
    // Chỉ Windows mới cần: Linux/macOS nạp qua rpath của chính wheel
    if (process.platform === "win32") {
      const nvidiaDir = path.join(paths.runtime.venv, "Lib", "site-packages", "nvidia");
      for (const entry of fs.readdirSync(nvidiaDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const bin = path.join(nvidiaDir, entry.name, "bin");
        if (fs.existsSync(bin)) out.push(bin);
      }
    }
  } catch {
    /* chưa cài gói nvidia hoặc chưa có venv - chạy CPU, không phải lỗi */
  }
  cudaDirsCache = out;
  return out;
}

export function childEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // .runtime/bin đứng TRƯỚC PATH cũ: doctor.mjs tải ffmpeg/cloudflared về đó khi
  // máy chưa có sẵn, mà server thì gọi trần "ffmpeg" - không chèn vào PATH thì
  // tải về xong vẫn báo thiếu. Đứng trước chứ không đứng sau để bản của dự án
  // thắng bản hệ thống: đó mới là bản mình kiểm soát được phiên bản.
  // ĐÃ GẶP THẬT: Windows coi tên biến môi trường là không phân biệt hoa thường,
  // nhưng object JS thì CÓ. Server chạy dưới Git Bash thì `process.env` mang khoá
  // "PATH", còn cmd/PowerShell mang "Path". Ghi cứng một kiểu là tiến trình con
  // nhận CẢ HAI khoá và dùng cái cũ - PATH mới coi như không tồn tại, mà không
  // có lỗi nào báo ra (đúng ca này: chèn thư mục CUDA vào rồi whisper vẫn báo
  // thiếu DLL). Phải ghi ĐÈ lên đúng khoá đang tồn tại.
  const pathKey =
    Object.keys(process.env).find((k) => k.toLowerCase() === "path") ??
    (process.platform === "win32" ? "Path" : "PATH");
  const currentPath = process.env[pathKey] ?? "";
  const prefix = [paths.runtime.bin, ...cudaDllDirs()].join(path.delimiter);
  const mergedPath = currentPath ? `${prefix}${path.delimiter}${currentPath}` : prefix;
  return {
    ...process.env,
    [pathKey]: mergedPath,
    TEMP: paths.runtime.tmp,
    TMP: paths.runtime.tmp,
    TMPDIR: paths.runtime.tmp,
    HF_HOME: paths.runtime.models,
    HUGGINGFACE_HUB_CACHE: paths.runtime.models,
    PIP_CACHE_DIR: paths.runtime.pipCache,
    ...extra,
  };
}

/** Tạo trước các thư mục nền tảng để route không phải lo dir chưa tồn tại */
export function ensureBaseDirs(): void {
  const dirs = [
    paths.dataDir,
    paths.uploadTmpDir,
    paths.videoProjectsDir,
    paths.imageProjectsDir,
    paths.stylesDir,
    paths.stylesFilesDir,
    paths.sfxDir,
    paths.voicesDir,
    paths.musicDir,
    paths.outputsDir,
    paths.importsDir,
    paths.autoCutDir,
    paths.textToVideoDir,
    paths.translateVideoDir,
    // .runtime/: phải có TRƯỚC lần spawn đầu tiên - childEnv() trỏ TEMP vào đây,
    // mà tiến trình con gặp TEMP không tồn tại thì hỏng ngay (Chrome, pip).
    paths.runtime.tmp,
    paths.runtime.models,
    paths.runtime.bin,
    paths.runtime.pipCache,
    // CỐ Ý không tạo sẵn paths.runtime.venv: thư mục venv là do `python -m venv`
    // dựng ra, tạo trước một thư mục rỗng chỉ làm phần dò "đã có venv chưa"
    // tưởng nhầm là đã cài xong.
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}
