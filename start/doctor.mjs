#!/usr/bin/env node
/**
 * Kiểm tra môi trường AIEV - NGUỒN SỰ THẬT DUY NHẤT.
 *
 * Dùng chung cho ba nơi, để danh sách kiểm tra không bao giờ lệch nhau nữa:
 *   1. start.ps1  (Windows)   -> node start/doctor.mjs --fix
 *   2. start.sh   (macOS/Linux) -> node start/doctor.mjs --fix
 *   3. Web UI     -> GET /api/doctor  (backend spawn `--json`, xem routes/doctor.ts)
 * Trước đây mỗi script tự kiểm tra bằng ngôn ngữ của nó nên đã trôi mất đồng bộ:
 * start.sh bắt buộc có ffmpeg còn start.ps1 không kiểm tra ffmpeg dòng nào.
 *
 * RÀNG BUỘC: file này chạy TRƯỚC `npm install` (start script gọi nó ở bước đầu)
 * nên KHÔNG được import bất cứ dependency nào - chỉ module built-in của Node.
 *
 * RÀNG BUỘC 2: mọi thứ file này TẢI VỀ đều phải nằm trong <repo>/.runtime -
 * xem khối RUNTIME_DIRS bên dưới. Không dùng `pip install` toàn cục, không để
 * huggingface tải model vào thư mục người dùng, không cài ffmpeg vào ổ hệ thống
 * nếu tránh được.
 *
 * Cách chạy tay:
 *   node start/doctor.mjs            # in bảng kiểm tra
 *   node start/doctor.mjs --fix      # thiếu gì hỏi cài nấy
 *   node start/doctor.mjs --fix --yes # cài luôn, không hỏi
 *   node start/doctor.mjs --json     # cho máy đọc
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
/** npm/claude trên Windows là file .cmd - spawn không shell thì phải gọi đúng tên */
const NPM = IS_WIN ? "npm.cmd" : "npm";

/** Node tối thiểu - phải khớp README và package.json */
export const MIN_NODE_MAJOR = 22;

/**
 * MỌI THỨ NẶNG DO DỰ ÁN TỰ TẢI VỀ ĐỀU NẰM TRONG .runtime/ CỦA CHÍNH DỰ ÁN.
 *
 * Trước đây chúng rơi hết vào ổ hệ thống dù repo nằm ở ổ khác: model whisper
 * 13,3 GB ở C:\Users\<user>\.cache\huggingface, gói pip trong site-packages của
 * Python hệ thống, cache pip 3,2 GB trong AppData, ffmpeg cài bằng winget vào
 * C:\Program Files. Máy chạy repo này để dự án ở F: mà C: chỉ còn 17,7 GB.
 *
 * Đây là danh sách đường dẫn DÙNG CHUNG với backend (apps/server) - đổi tên ở
 * đây là phải đổi cả bên đó, nếu không mỗi bên tìm model một nơi.
 */
const RUNTIME = path.join(ROOT, ".runtime");
export const RUNTIME_DIRS = {
  root: RUNTIME,
  tmp: path.join(RUNTIME, "tmp"),
  models: path.join(RUNTIME, "models"),
  venv: path.join(RUNTIME, "venv"),
  bin: path.join(RUNTIME, "bin"),
  pipCache: path.join(RUNTIME, "pip-cache"),
};

/** Thư mục chứa lệnh của venv: Windows là Scripts\, còn lại là bin/ */
const VENV_BIN = path.join(RUNTIME_DIRS.venv, IS_WIN ? "Scripts" : "bin");
const VENV_PY = path.join(VENV_BIN, IS_WIN ? "python.exe" : "python");
const VENV_PIP = path.join(VENV_BIN, IS_WIN ? "pip.exe" : "pip");

function ensureRuntimeDirs() {
  for (const dir of Object.values(RUNTIME_DIRS)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Env cho MỌI tiến trình pip/python mà file này sinh ra. Không đặt mấy biến này
 * thì pip vẫn cache vào AppData và huggingface vẫn tải model về ổ C: - đúng thứ
 * đang muốn tránh. TMP/TEMP cũng phải đổi: pip giải nén wheel torch 2-3 GB
 * trong thư mục tạm trước khi cài.
 */
function runtimeEnv() {
  return {
    ...process.env,
    PIP_CACHE_DIR: RUNTIME_DIRS.pipCache,
    HF_HOME: RUNTIME_DIRS.models,
    HUGGINGFACE_HUB_CACHE: RUNTIME_DIRS.models,
    TMPDIR: RUNTIME_DIRS.tmp,
    TMP: RUNTIME_DIRS.tmp,
    TEMP: RUNTIME_DIRS.tmp,
  };
}

// ===================== tiện ích =====================

/**
 * Windows + Node >= 20.12 (vá CVE-2024-27980): spawn file .cmd/.bat KHÔNG qua
 * shell là lỗi EINVAL ngay - claude.cmd luôn bị báo "chưa cài" và cài bằng
 * npm.cmd luôn hỏng. Các lệnh .cmd ở đây chỉ nhận tham số hằng không có dấu
 * cách, nên bật shell cho riêng chúng là an toàn.
 */
function needsShell(file) {
  return IS_WIN && /\.(cmd|bat)$/i.test(file);
}

/** Chạy lệnh, KHÔNG bao giờ ném - thiếu lệnh trả về { ok: false } */
function run(file, args, timeout = 10_000, env = null) {
  try {
    const opts = { encoding: "utf8", timeout, windowsHide: true, shell: needsShell(file) };
    if (env) opts.env = env;
    const r = spawnSync(file, args, opts);
    if (r.error) return { ok: false, out: "" };
    return {
      ok: r.status === 0,
      out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
      status: r.status,
    };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Dòng đầu của output - phần lớn lệnh --version in version ở dòng này */
function firstLine(s) {
  return (s || "").split(/\r?\n/)[0].trim();
}

/** Byte -> chuỗi người đọc được. Dùng cho cả bảng terminal lẫn JSON của web UI */
function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/**
 * Đếm file + tổng byte của một thư mục (đệ quy). Dùng lstat chứ không stat:
 * cache huggingface trên macOS/Linux đầy symlink từ snapshots/ sang blobs/, đi
 * theo symlink là đếm đúp dung lượng và so sánh trước/sau lúc chuyển sẽ lệch.
 *
 * Có nhớ đệm vì một lần chạy doctor hỏi tới cùng thư mục nhiều lần (bảng kiểm
 * tra + bước sửa) mà cây model thì tới 13 GB.
 */
const dirStatsCache = new Map();
function dirStats(dir, { fresh = false } = {}) {
  if (!fresh && dirStatsCache.has(dir)) return dirStatsCache.get(dir);
  const out = { exists: fs.existsSync(dir), files: 0, bytes: 0 };
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      try {
        out.files += 1;
        out.bytes += fs.lstatSync(p).size;
      } catch {
        /* file biến mất giữa chừng - bỏ qua */
      }
    }
  };
  if (out.exists) walk(dir);
  dirStatsCache.set(dir, out);
  return out;
}

function forgetDirStats() {
  dirStatsCache.clear();
}

let envCache = null;
/** Đọc .env thủ công (dotenv chưa cài được ở lần chạy đầu) */
function envFileVars() {
  if (envCache) return envCache;
  const out = {};
  const file = path.join(ROOT, ".env");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      out[s.slice(0, eq).trim()] = s
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
  envCache = out;
  return out;
}

function envVar(name) {
  return (process.env[name] || envFileVars()[name] || "").trim();
}

function hasBrew() {
  return run("brew", ["--version"], 5000).ok;
}

/**
 * Windows: winget vừa cài xong thì PATH của tiến trình HIỆN TẠI vẫn là bản cũ,
 * nên kiểm tra lại ngay sau khi cài sẽ báo "vẫn thiếu". Đọc lại PATH từ registry
 * để lệnh mới cài thấy được luôn, khỏi bắt người dùng mở lại cửa sổ.
 *
 * Lưu ý: giá trị REG_EXPAND_SZ có thể còn %SystemRoot% chưa nở - chấp nhận được
 * vì ta chỉ NỐI THÊM vào PATH sẵn có, các mục cũ vẫn nguyên.
 */
function refreshWindowsPath() {
  if (!IS_WIN) return;
  const readPath = (root) => {
    const r = run("reg", ["query", root, "/v", "Path"], 5000);
    if (!r.ok) return "";
    const m = r.out.match(/Path\s+REG(?:_EXPAND)?_SZ\s+(.*)/i);
    return m ? m[1].trim() : "";
  };
  const machine = readPath(
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  );
  const user = readPath("HKCU\\Environment");
  const merged = [process.env.PATH || "", machine, user].filter(Boolean).join(";");
  process.env.PATH = merged;
  process.env.Path = merged;
}

// ===================== các phép dò =====================

/** Chrome/Chromium - HyperFrames và Remotion đều render qua headless Chrome */
function findChrome() {
  const fromEnv = (
    process.env.CHROME_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    ""
  ).trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates = [];
  if (IS_WIN) {
    const bases = [
      process.env["ProgramFiles"],
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    for (const b of bases) {
      candidates.push(path.join(b, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(b, "Chromium", "Application", "chrome.exe"));
    }
  } else if (IS_MAC) {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.push(
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    );
    candidates.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      const r = run("which", [name], 4000);
      if (r.ok && r.out) candidates.push(firstLine(r.out));
    }
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Python có sẵn module faster_whisper (phụ đề). Thứ tự dò khớp transcribe.ts:
 * Windows hay chỉ có `py` (launcher), macOS/Linux là `python3`.
 */
const PY_CANDIDATES = IS_WIN ? ["py", "python", "python3"] : ["python3", "python"];

function findPython() {
  for (const exe of PY_CANDIDATES) {
    const r = run(exe, ["-c", "import sys; print(sys.version.split()[0])"], 8000);
    if (r.ok && r.out) return { exe, version: firstLine(r.out) };
  }
  return null;
}

/**
 * Python RIÊNG CỦA DỰ ÁN (.runtime/venv). Đây mới là nơi mọi gói được cài -
 * `pip install` toàn cục ném gói vào site-packages của Python hệ thống, tức là
 * vào ổ C:, và trộn lẫn với gói của dự án khác.
 */
function findVenvPython() {
  if (!fs.existsSync(VENV_PY)) return null;
  const r = run(VENV_PY, ["-c", "import sys; print(sys.version.split()[0])"], 8000, runtimeEnv());
  if (!r.ok || !r.out) return null;
  return { exe: VENV_PY, version: firstLine(r.out) };
}

/** Hỏi ĐÚNG trình thông dịch được truyền vào xem có module chưa */
function pyHasModule(exe, mod, timeout) {
  return run(exe, ["-c", `import ${mod}`], timeout, runtimeEnv()).ok;
}

/**
 * Cache model huggingface CŨ nằm ngoài dự án (mặc định ~/.cache/huggingface).
 * Trả về thư mục ĐÁNG chuyển, hoặc null nếu không có gì.
 *
 * Ưu tiên thư mục con hub/ vì HUGGINGFACE_HUB_CACHE của ta trỏ thẳng vào
 * .runtime/models: model phải nằm ngay đó (models--Systran--faster-whisper...),
 * chứ chuyển cả cây thành .runtime/models/hub/... là huggingface không thấy và
 * tải lại 13 GB - đúng thứ đang muốn tránh.
 */
function legacyModelCache() {
  const fromEnv = envVar("HF_HOME") || envVar("HUGGINGFACE_HUB_CACHE");
  const base =
    fromEnv && path.resolve(fromEnv) !== path.resolve(RUNTIME_DIRS.models)
      ? fromEnv
      : path.join(os.homedir(), ".cache", "huggingface");
  for (const dir of [path.join(base, "hub"), base]) {
    const st = dirStats(dir);
    if (st.exists && st.files > 0) return dir;
  }
  return null;
}

/** Đăng nhập Claude - phải khớp hasClaudeAuth() trong apps/server/src/config.ts */
function claudeAuthed() {
  if (envVar("ANTHROPIC_API_KEY") || envVar("CLAUDE_CODE_OAUTH_TOKEN") || envVar("ANTHROPIC_AUTH_TOKEN")) {
    return true;
  }
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude");
  if (fs.existsSync(path.join(configDir, ".credentials.json"))) return true;
  // macOS: Claude Code cất OAuth trong Keychain, không có file .credentials.json
  if (IS_MAC) {
    return run("security", ["find-generic-password", "-s", "Claude Code-credentials"], 4000).ok;
  }
  return false;
}

/**
 * Binary tải riêng giờ về .runtime/bin (cùng chỗ với model và venv, một thư mục
 * duy nhất để dọn). start/bin là chỗ CŨ - vẫn phải tìm ở đó, nếu không thì mọi
 * máy đã tải cloudflared trước thay đổi này sẽ tải lại lần nữa.
 */
const LEGACY_BIN = path.join(ROOT, "start", "bin");

function findLocalBinary(name) {
  const file = IS_WIN ? `${name}.exe` : name;
  for (const dir of [RUNTIME_DIRS.bin, LEGACY_BIN]) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Nhãn ngắn cho biết binary lấy từ đâu - người dùng cần thấy nó nằm trong dự án */
function binaryOrigin(p) {
  if (!p) return "";
  if (p.startsWith(RUNTIME_DIRS.bin)) return ".runtime/bin/";
  if (p.startsWith(LEGACY_BIN)) return "start/bin/";
  return "PATH";
}

function findCloudflared() {
  const local = findLocalBinary("cloudflared");
  if (local) return local;
  return run("cloudflared", ["--version"], 5000).ok ? "cloudflared" : null;
}

/**
 * ffmpeg + ffprobe. PATH TRƯỚC: ai đã có sẵn ffmpeg thì tuyệt đối không bắt tải
 * thêm 150 MB nữa. Không có mới xét bản tải riêng trong .runtime/bin.
 */
function findFfmpeg() {
  const onPath = run("ffmpeg", ["-version"], 8000);
  const probeOnPath = run("ffprobe", ["-version"], 8000);
  if (onPath.ok && probeOnPath.ok) return { where: "PATH", version: firstLine(onPath.out) };

  const localFf = findLocalBinary("ffmpeg");
  const localFp = findLocalBinary("ffprobe");
  if (localFf && localFp) {
    const r = run(localFf, ["-version"], 8000);
    if (r.ok) return { where: binaryOrigin(localFf), version: firstLine(r.out) };
  }
  // Có ffmpeg nhưng thiếu ffprobe là ca riêng - báo đúng bệnh
  return { where: null, version: onPath.ok ? firstLine(onPath.out) : "", ffmpegOnly: onPath.ok };
}

// ===================== danh sách kiểm tra =====================

/**
 * level:
 *   required - thiếu là pipeline render KHÔNG chạy được
 *   optional - thiếu thì mất một tính năng, phần còn lại vẫn chạy
 *   info     - chỉ để biết (GPU), không bao giờ là lỗi
 *
 * fix.auto = true nghĩa là cài được không cần người gõ gì thêm; web UI chỉ cho
 * bấm nút "Cài tự động" với đúng những mục này.
 */
export function runDoctor() {
  const checks = [];

  // --- Node.js ---
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    id: "node",
    label: "Node.js",
    level: "required",
    status: nodeMajor >= MIN_NODE_MAJOR ? "ok" : "missing",
    detail: `v${process.versions.node}`,
    // Không tự cài Node được: chính script này đang chạy bằng Node, và trên
    // Windows thì PATH mới chỉ có hiệu lực ở cửa sổ sau.
    fix: { auto: false, manual: `https://nodejs.org (v${MIN_NODE_MAJOR}+)`, url: "https://nodejs.org" },
  });

  // --- FFmpeg (kèm ffprobe) ---
  const ffmpeg = findFfmpeg();
  const ffOk = Boolean(ffmpeg.where);
  checks.push({
    id: "ffmpeg",
    label: "FFmpeg",
    level: "required",
    status: ffOk ? "ok" : "missing",
    detail: ffOk
      ? `${ffmpeg.version.split(" ").slice(0, 3).join(" ")}${
          ffmpeg.where === "PATH" ? "" : ` - ${ffmpeg.where}`
        }`
      : "",
    note: ffmpeg.ffmpegOnly ? "ffprobe-missing" : null,
    // Windows: tải bản static thẳng vào .runtime/bin thay vì winget cài vào
    // C:\Program Files. winget vẫn còn - là đường lui khi tải hỏng, và là lệnh
    // hiện ra cho ai muốn cài kiểu hệ thống.
    fix: IS_WIN
      ? {
          auto: true,
          kind: "ffmpeg-win-local",
          size: "~150 MB",
          target: RUNTIME_DIRS.bin,
          cmd: ["winget", ["install", "--id", "Gyan.FFmpeg", "-e", "--silent",
            "--accept-source-agreements", "--accept-package-agreements"]],
          manual: "winget install --id Gyan.FFmpeg -e",
          command: "winget install --id Gyan.FFmpeg -e",
        }
      : IS_MAC
        ? hasBrew()
          ? { auto: true, size: "~120 MB", cmd: ["brew", ["install", "ffmpeg"]], manual: "brew install ffmpeg", command: "brew install ffmpeg" }
          : { auto: false, manual: "brew install ffmpeg (cài Homebrew trước: brew.sh)", command: "brew install ffmpeg", url: "https://brew.sh" }
        : { auto: false, manual: "sudo apt install ffmpeg", command: "sudo apt install ffmpeg" },
  });

  // --- Google Chrome ---
  const chrome = findChrome();
  checks.push({
    id: "chrome",
    label: "Google Chrome",
    level: "required",
    status: chrome ? "ok" : "missing",
    detail: chrome ?? "",
    fix: IS_WIN
      ? {
          auto: true,
          size: "~120 MB",
          cmd: ["winget", ["install", "--id", "Google.Chrome", "-e", "--silent",
            "--accept-source-agreements", "--accept-package-agreements"]],
          manual: "winget install --id Google.Chrome -e",
          command: "winget install --id Google.Chrome -e",
        }
      : IS_MAC
        ? hasBrew()
          ? {
              auto: true,
              size: "~250 MB",
              cmd: ["brew", ["install", "--cask", "google-chrome"]],
              manual: "brew install --cask google-chrome",
              command: "brew install --cask google-chrome",
            }
          : { auto: false, manual: "https://google.com/chrome", url: "https://www.google.com/chrome/" }
        : { auto: false, manual: "https://google.com/chrome", url: "https://www.google.com/chrome/" },
  });

  // --- Claude Code CLI ---
  // KHÔNG bắt buộc: backend gọi Claude qua @anthropic-ai/claude-agent-sdk trong
  // node_modules (SDK tự mang CLI riêng). CLI toàn cục chỉ là MỘT trong hai cách
  // lấy được xác thực (`claude` -> /login), cách kia là ANTHROPIC_API_KEY.
  // Đã đăng nhập rồi thì nó thành thừa -> hạ xuống "info" để không báo động giả.
  const authed = claudeAuthed();
  const claudeCli = run(IS_WIN ? "claude.cmd" : "claude", ["--version"], 15_000);
  checks.push({
    id: "claude-cli",
    label: "Claude Code",
    level: authed ? "info" : "optional",
    status: claudeCli.ok ? "ok" : "missing",
    detail: claudeCli.ok ? firstLine(claudeCli.out) : "",
    note: !claudeCli.ok && authed ? "not-needed" : null,
    fix: {
      auto: true,
      size: "~40 MB",
      cmd: [NPM, ["install", "-g", "@anthropic-ai/claude-code", "--no-audit", "--no-fund"]],
      manual: "npm install -g @anthropic-ai/claude-code",
      command: "npm install -g @anthropic-ai/claude-code",
    },
  });

  // --- Đăng nhập Claude ---
  checks.push({
    id: "claude-auth",
    label: "Claude login",
    level: "required",
    status: authed ? "ok" : "missing",
    detail: authed ? (envVar("ANTHROPIC_API_KEY") ? "API key" : "subscription") : "",
    // Đăng nhập là việc tương tác (mở trình duyệt, nhập mã) - không tự làm thay được
    fix: { auto: false, manual: "claude -> /login", link: "/connections" },
  });

  // --- Python: venv của dự án + faster-whisper + VieNeu ---
  // Gói cài vào .runtime/venv, KHÔNG cài toàn cục. Nên phép dò cũng phải hỏi
  // trình thông dịch của venv: hỏi Python hệ thống thì thấy gói cũ nằm ở ổ C:
  // và báo "ok" trong khi venv rỗng, lúc chạy thật là hỏng.
  const venvPy = findVenvPython();
  /** Python hệ thống chỉ cần để TẠO venv - dò một lần rồi nhớ, mỗi lần là một spawn */
  let sysPyMemo;
  const systemPy = () => (sysPyMemo === undefined ? (sysPyMemo = findPython()) : sysPyMemo);
  const py = venvPy ?? systemPy();
  const pyLabel = venvPy ? `Python ${venvPy.version} - .runtime/venv` : py ? `Python ${py.version}` : "";
  /** Có thể tạo venv (đã có Python bất kỳ) hay chưa có Python nào cả */
  const canVenv = Boolean(venvPy || systemPy());

  /**
   * Trả về trạng thái một gói: dò trong venv trước; venv chưa có gói thì mới
   * hỏi Python hệ thống, chỉ để nói cho đúng bệnh ("đã cài nhưng nằm ngoài dự
   * án") chứ vẫn coi là THIẾU - đích đến là .runtime/venv.
   */
  const probe = (mod, timeout) => {
    if (venvPy && pyHasModule(venvPy.exe, mod, timeout)) return { ok: true, note: null };
    const sys = systemPy();
    if (!sys) return { ok: false, note: "python-missing" };
    if (pyHasModule(sys.exe, mod, timeout)) return { ok: false, note: "system-only" };
    return { ok: false, note: venvPy ? "module-missing" : "venv-missing" };
  };

  /** Fix chung cho mọi gói pip: tạo venv nếu thiếu rồi cài vào đó */
  const pipFix = (pkgs, size) =>
    canVenv
      ? {
          auto: true,
          kind: "pip",
          pkgs,
          size,
          target: RUNTIME_DIRS.venv,
          cmd: [VENV_PIP, ["install", ...pkgs]],
          manual: `${VENV_PIP} install ${pkgs.join(" ")}`,
          command: `${VENV_PIP} install ${pkgs.join(" ")}`,
        }
      : {
          auto: false,
          manual: `pip install ${pkgs.join(" ")} (cài Python 3.10+ trước)`,
          url: "https://www.python.org/downloads/",
        };

  const whisper = probe("faster_whisper", 30_000);
  checks.push({
    id: "whisper",
    label: "faster-whisper",
    level: "optional",
    status: whisper.ok ? "ok" : "missing",
    detail: whisper.ok ? pyLabel : py ? `Python ${py.version}` : "",
    note: whisper.note,
    fix: pipFix(["faster-whisper"], "~300 MB"),
  });

  // --- VieNeu-TTS (giọng đọc chạy trên máy + nhân bản giọng) ---
  // Hai mức, cố ý tách rời: gói `vieneu` là đủ để ĐỌC (chạy bằng ONNX, không
  // cần torch); muốn NHÂN BẢN giọng mới cần thêm torch. Gộp làm một thì người
  // chỉ muốn đọc offline bị bắt tải 2-3 GB torch một cách vô ích.
  const vieneu = probe("vieneu", 60_000);
  checks.push({
    id: "vieneu",
    label: "VieNeu-TTS",
    level: "optional",
    status: vieneu.ok ? "ok" : "missing",
    detail: vieneu.ok ? pyLabel : py ? `Python ${py.version}` : "",
    note: vieneu.note,
    fix: pipFix(["vieneu"], "~30 MB (model ~1 GB tải ở lần đọc đầu)"),
  });

  // Chỉ hỏi tới torch KHI ĐÃ có vieneu - máy không dùng giọng offline thì báo
  // thiếu torch chỉ là tiếng ồn.
  if (vieneu.ok) {
    const torch = probe("torch, torchaudio", 90_000);
    checks.push({
      id: "vieneu-clone",
      // Nhãn để nguyên tên gói như mọi mục khác - phần giải thích nằm ở `why`,
      // chỗ duy nhất có bản dịch
      label: "PyTorch",
      level: "optional",
      status: torch.ok ? "ok" : "missing",
      detail: torch.ok ? pyLabel : py ? `Python ${py.version}` : "",
      note: torch.note,
      fix: pipFix(["torch", "torchaudio"], "~2-3 GB"),
    });
  }

  // --- Cache model (whisper tải về ~13 GB) ---
  // Mục này tồn tại vì một lý do rất cụ thể: model cũ nằm ở
  // ~/.cache/huggingface trên ổ hệ thống. Chuyển được thì CHUYỂN, không tải lại.
  const modelsHere = dirStats(RUNTIME_DIRS.models);
  const legacyModels = modelsHere.files > 0 ? null : legacyModelCache();
  const legacyStats = legacyModels ? dirStats(legacyModels) : null;
  checks.push({
    id: "models-dir",
    label: "Model cache",
    level: "optional",
    status: legacyModels ? "missing" : "ok",
    detail: legacyModels
      ? `${fmtSize(legacyStats.bytes)} @ ${legacyModels}`
      : `${fmtSize(modelsHere.bytes)} - .runtime/models`,
    note: legacyModels ? "models-elsewhere" : modelsHere.files === 0 ? "models-empty" : null,
    fix: legacyModels
      ? {
          auto: true,
          kind: "move-models",
          size: fmtSize(legacyStats.bytes),
          from: legacyModels,
          to: RUNTIME_DIRS.models,
          // Chuyển 13 GB là việc phải hỏi trước - xem cờ confirm ở vòng lặp --fix
          confirm: true,
          manual: `move "${legacyModels}" -> "${RUNTIME_DIRS.models}"`,
        }
      : null,
  });

  // --- Gemini API key (tạo ảnh) ---
  const gemini = !!envVar("GEMINI_API_KEY");
  checks.push({
    id: "gemini",
    label: "Gemini API key",
    level: "optional",
    status: gemini ? "ok" : "missing",
    detail: "",
    // Dán key ngay trong trang Kết nối - không cần mở file .env
    fix: {
      auto: false,
      manual: "GEMINI_API_KEY (aistudio.google.com/apikey)",
      link: "/connections",
      url: "https://aistudio.google.com/apikey",
    },
  });

  // --- cloudflared (tunnel) ---
  const cf = findCloudflared();
  checks.push({
    id: "cloudflared",
    label: "cloudflared",
    level: "optional",
    status: cf ? "ok" : "missing",
    detail: binaryOrigin(cf),
    fix: IS_WIN
      ? {
          auto: true,
          size: "~20 MB",
          cmd: ["winget", ["install", "--id", "Cloudflare.cloudflared", "--silent",
            "--accept-source-agreements", "--accept-package-agreements"]],
          manual: "winget install --id Cloudflare.cloudflared",
          command: "winget install --id Cloudflare.cloudflared",
        }
      : IS_MAC
        ? { auto: true, size: "~20 MB", kind: "cloudflared-mac", manual: "brew install cloudflared", command: "brew install cloudflared" }
        : { auto: false, manual: "https://github.com/cloudflare/cloudflared/releases" },
  });

  // --- Dung lượng .runtime (chỉ để biết) ---
  // Một dòng trả lời câu "dự án đang ngốn bao nhiêu ổ đĩa, và bỏ thư mục nào ra
  // khỏi backup thì đủ".
  const runtimeSize = dirStats(RUNTIME_DIRS.root);
  const parts = [
    ["models", dirStats(RUNTIME_DIRS.models)],
    ["venv", dirStats(RUNTIME_DIRS.venv)],
    ["pip-cache", dirStats(RUNTIME_DIRS.pipCache)],
    ["bin", dirStats(RUNTIME_DIRS.bin)],
  ]
    .filter(([, st]) => st.bytes > 0)
    .map(([name, st]) => `${name} ${fmtSize(st.bytes)}`);
  checks.push({
    id: "runtime",
    label: ".runtime/",
    level: "info",
    status: "ok",
    detail: `${fmtSize(runtimeSize.bytes)}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`,
    note: null,
    fix: null,
  });

  // --- GPU (chỉ để biết, không phải lỗi) ---
  const nv = run("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], 8000);
  const gpuName = nv.ok ? firstLine(nv.out) : null;
  checks.push({
    id: "gpu",
    label: "GPU",
    level: "info",
    status: "ok",
    detail: gpuName ? `${gpuName} (NVENC)` : IS_MAC ? "VideoToolbox (macOS)" : "",
    note: gpuName || IS_MAC ? null : "cpu-only",
    fix: null,
  });

  const missingRequired = checks.filter((c) => c.level === "required" && c.status === "missing");
  return {
    platform: process.platform,
    ok: missingRequired.length === 0,
    missingRequired: missingRequired.map((c) => c.id),
    checks,
  };
}

// ===================== cài phần còn thiếu =====================

function spawnLogged(file, args, log, env = null) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: ROOT,
      windowsHide: true,
      shell: needsShell(file),
      ...(env ? { env } : {}),
    });
    const onData = (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) log(line.trim());
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      log(err.message);
      resolve(false);
    });
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Nháy đơn trong chuỗi PowerShell phải nhân đôi - đường dẫn có dấu ' là hỏng lệnh */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Chạy một lệnh PowerShell (chỉ Windows) - Node không có sẵn giải nén zip */
function powershell(script, log) {
  return spawnLogged(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    log,
  );
}

/**
 * Tải một file. curl có sẵn trên macOS/Linux và cả Windows 10 1803+; Windows
 * bản cũ hơn thì lui về Invoke-WebRequest.
 */
async function downloadFile(url, dest, log) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log(`Tải ${path.basename(dest)}...`);
  if (await spawnLogged("curl", ["-fsSL", "-o", dest, url], log)) return true;
  if (!IS_WIN) return false;
  log("Không dùng được curl - thử Invoke-WebRequest.");
  return powershell(
    `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri ${psQuote(url)} -OutFile ${psQuote(dest)}`,
    log,
  );
}

/** macOS không có brew: tải thẳng binary chính thức về .runtime/bin */
async function installCloudflaredMac(log) {
  if (hasBrew()) return spawnLogged("brew", ["install", "cloudflared"], log);
  const pkg = os.arch() === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
  ensureRuntimeDirs();
  const binDir = RUNTIME_DIRS.bin;
  const tgz = path.join(RUNTIME_DIRS.tmp, pkg);
  const okDl = await downloadFile(
    `https://github.com/cloudflare/cloudflared/releases/latest/download/${pkg}`,
    tgz,
    log,
  );
  if (!okDl) return false;
  const okTar = await spawnLogged("tar", ["-xzf", tgz, "-C", binDir], log);
  fs.rmSync(tgz, { force: true });
  if (!okTar) return false;
  fs.chmodSync(path.join(binDir, "cloudflared"), 0o755);
  log(`cloudflared -> ${binDir}`);
  return true;
}

/**
 * FFmpeg bản static vào .runtime/bin (Windows).
 *
 * winget cài vào ổ hệ thống nên chỉ còn là ĐƯỜNG LUI khi tải hỏng. Node không
 * có giải nén zip nên phần bung file nhờ Expand-Archive của PowerShell.
 */
async function installFfmpegWindowsLocal(log) {
  const url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
  ensureRuntimeDirs();
  const zip = path.join(RUNTIME_DIRS.tmp, "ffmpeg-release-essentials.zip");
  const work = path.join(RUNTIME_DIRS.tmp, "ffmpeg-unzip");
  fs.rmSync(work, { recursive: true, force: true });

  const cleanup = () => {
    fs.rmSync(zip, { force: true });
    fs.rmSync(work, { recursive: true, force: true });
  };

  try {
    if (!(await downloadFile(url, zip, log))) return false;
    log("Giải nén...");
    if (!(await powershell(`Expand-Archive -Path ${psQuote(zip)} -DestinationPath ${psQuote(work)} -Force`, log))) {
      return false;
    }
    // Zip của gyan.dev bung ra ffmpeg-<ver>-essentials_build/bin/*.exe
    let src = null;
    for (const entry of fs.readdirSync(work)) {
      const candidate = path.join(work, entry, "bin");
      if (fs.existsSync(path.join(candidate, "ffmpeg.exe"))) {
        src = candidate;
        break;
      }
    }
    if (!src) {
      log("Không tìm thấy ffmpeg.exe trong file tải về.");
      return false;
    }
    for (const exe of ["ffmpeg.exe", "ffprobe.exe"]) {
      fs.copyFileSync(path.join(src, exe), path.join(RUNTIME_DIRS.bin, exe));
    }
    log(`ffmpeg.exe + ffprobe.exe -> ${RUNTIME_DIRS.bin}`);
    return true;
  } catch (err) {
    log(err?.message ?? String(err));
    return false;
  } finally {
    cleanup();
  }
}

/** Tạo .runtime/venv nếu chưa có. Không có Python thì chịu - doctor không cài Python. */
async function ensureVenv(log) {
  ensureRuntimeDirs();
  if (fs.existsSync(VENV_PY)) return true;
  const py = findPython();
  if (!py) {
    log("Chưa có Python trên máy - cài Python 3.10+ (python.org) rồi chạy lại.");
    return false;
  }
  log(`Tạo môi trường Python riêng của dự án: ${RUNTIME_DIRS.venv}`);
  const ok = await spawnLogged(py.exe, ["-m", "venv", RUNTIME_DIRS.venv], log, runtimeEnv());
  if (!ok || !fs.existsSync(VENV_PY)) {
    log("Không tạo được venv (thiếu module venv? thử: python -m pip install virtualenv).");
    return false;
  }
  return true;
}

/** Cài gói pip VÀO VENV CỦA DỰ ÁN, cache pip cũng nằm trong .runtime */
async function pipInstall(pkgs, log) {
  if (!(await ensureVenv(log))) return false;
  log(`Cài ${pkgs.join(", ")} vào ${RUNTIME_DIRS.venv} (cache: ${RUNTIME_DIRS.pipCache})`);
  const ok = await spawnLogged(VENV_PIP, ["install", ...pkgs], log, runtimeEnv());
  forgetDirStats();
  return ok;
}

/**
 * Chuyển cache model cũ (ổ hệ thống) sang .runtime/models. 13 GB nên:
 *   - rename trước: cùng ổ thì tức thì, không chép một byte nào;
 *   - khác ổ (C: -> F:, ca thường gặp) thì CHÉP rồi mới xóa;
 *   - chỉ xóa bản gốc khi bản đích đã khớp cả SỐ FILE lẫn TỔNG BYTE;
 *   - hỏng ở bất kỳ bước nào thì bản gốc còn nguyên, bản chép dở bị dọn đi để
 *     lần sau không nhầm là đã chuyển xong.
 */
async function moveModelCache(log) {
  const src = legacyModelCache();
  const dst = RUNTIME_DIRS.models;
  if (!src) {
    log("Không có cache model cũ nào để chuyển.");
    return false;
  }
  ensureRuntimeDirs();
  const before = dirStats(src, { fresh: true });
  const dstBefore = dirStats(dst, { fresh: true });
  if (dstBefore.files > 0) {
    log(`${dst} đã có dữ liệu - không trộn hai cache vào nhau. Chuyển tay nếu cần.`);
    return false;
  }
  log(`Nguồn: ${src} (${before.files} file, ${fmtSize(before.bytes)})`);
  log(`Đích:  ${dst}`);

  // 1) Cùng ổ đĩa: đổi tên là xong
  try {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(src, dst);
    forgetDirStats();
    log("Đã chuyển bằng rename (cùng ổ đĩa) - không tốn thời gian chép.");
    return true;
  } catch (err) {
    fs.mkdirSync(dst, { recursive: true });
    log(`Rename không được (${err?.code ?? err?.message}) - khác ổ đĩa, chuyển sang chép rồi xóa.`);
  }

  // 2) Khác ổ: chép (giữ nguyên symlink theo đúng chữ - cache huggingface trên
  //    macOS/Linux trỏ snapshots -> blobs bằng đường dẫn tương đối)
  try {
    await fs.promises.cp(src, dst, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  } catch (err) {
    log(`Chép lỗi: ${err?.message ?? err}`);
    fs.rmSync(dst, { recursive: true, force: true });
    forgetDirStats();
    log("Bản gốc GIỮ NGUYÊN, không xóa gì cả.");
    return false;
  }

  const after = dirStats(dst, { fresh: true });
  if (after.files !== before.files || after.bytes !== before.bytes) {
    log(
      `Bản chép không khớp: ${after.files}/${before.files} file, ` +
        `${fmtSize(after.bytes)}/${fmtSize(before.bytes)}.`,
    );
    fs.rmSync(dst, { recursive: true, force: true });
    forgetDirStats();
    log("Đã dọn bản chép dở. Bản gốc GIỮ NGUYÊN.");
    return false;
  }

  fs.rmSync(src, { recursive: true, force: true });
  forgetDirStats();
  log(`Đã chuyển đủ ${before.files} file (${fmtSize(before.bytes)}) và xóa bản cũ ở ${src}.`);
  return true;
}

/**
 * Cài một mục. Trả về true nếu lệnh cài chạy thành công (chưa chắc đã dò lại
 * thấy - gọi runDoctor() sau để xác nhận).
 */
export async function applyFix(id, { log = () => {} } = {}) {
  const check = runDoctor().checks.find((c) => c.id === id);
  if (!check) throw new Error(`Không có mục kiểm tra "${id}"`);
  if (check.status === "ok") return true;
  const fix = check.fix;
  if (!fix?.auto) throw new Error(`Mục "${id}" phải cài tay: ${fix?.manual ?? "-"}`);

  let ok;
  if (fix.kind === "cloudflared-mac") {
    ok = await installCloudflaredMac(log);
  } else if (fix.kind === "pip") {
    ok = await pipInstall(fix.pkgs, log);
  } else if (fix.kind === "move-models") {
    ok = await moveModelCache(log);
  } else if (fix.kind === "ffmpeg-win-local") {
    ok = await installFfmpegWindowsLocal(log);
    // Tải hỏng (mạng chặn, gyan.dev đổi link) thì vẫn còn đường winget - thà cài
    // vào ổ hệ thống còn hơn không render được
    if (!ok && fix.cmd) {
      log("Tải bản riêng cho dự án không xong - thử winget (cài vào ổ hệ thống).");
      ok = await spawnLogged(fix.cmd[0], fix.cmd[1], log);
    }
  } else {
    ok = await spawnLogged(fix.cmd[0], fix.cmd[1], log);
  }
  forgetDirStats();
  // winget ghi PATH vào registry chứ không vào tiến trình đang chạy
  if (ok) refreshWindowsPath();
  return ok;
}

// ===================== CLI =====================

const TEXT = {
  vi: {
    title: "Kiểm tra môi trường",
    ok: "OK",
    missing: "THIẾU",
    allGood: "Môi trường đầy đủ.",
    someMissing: "Thiếu {n} thứ bắt buộc - render sẽ lỗi nếu không cài.",
    optionalMissing: "{n} tính năng phụ chưa dùng được (không ảnh hưởng phần còn lại).",
    installing: "Đang cài {label}...",
    installed: "Đã cài {label}.",
    installFailed: "Không cài được {label} - cài tay: {manual}",
    askOne: "Cài {label} ({size}) ngay? [Y/n] ",
    askMove: "Chuyển {size} model từ {from} sang {to}? [Y/n] ",
    needConfirm: "Bỏ qua {label} - việc này phải xác nhận, chạy trong terminal hoặc thêm --yes.",
    manualHint: "Cài tay: {manual}",
    fixInUi: "Mở dashboard rồi vào Cấu hình để cài bằng một nút bấm.",
    runtimeHint:
      "Mọi thứ dự án tải về (model, venv, cache pip, binary) nằm trong .runtime/ - bỏ thư mục này ra khỏi backup.",
    why: {
      node: "nền tảng chạy toàn hệ thống",
      ffmpeg: "cắt, ghép, encode video",
      chrome: "HyperFrames và Remotion render qua Chrome ẩn",
      "claude-cli": "một cách đăng nhập subscription (cách kia là API key)",
      "claude-auth": "chưa đăng nhập thì không edit bằng AI được",
      whisper: "tạo phụ đề tự động",
      vieneu: "giọng đọc chạy trên máy, miễn phí và không cần mạng",
      "vieneu-clone": "nhân bản giọng từ một đoạn ghi âm ngắn",
      "models-dir": "model AI để trong ổ của dự án, không nằm nhờ ổ hệ thống",
      gemini: "tạo ảnh nền và ảnh minh họa",
      cloudflared: "mở dashboard qua 4G/5G",
      runtime: "chỗ dự án cất mọi thứ tải về",
      gpu: "render nhanh hơn",
    },
    note: {
      "ffprobe-missing": "có ffmpeg nhưng thiếu ffprobe",
      "not-needed": "không cần - đã có xác thực",
      "module-missing": "có Python nhưng thiếu module",
      "python-missing": "chưa có Python",
      "venv-missing": "chưa có .runtime/venv - sẽ tạo khi cài",
      "system-only": "đang nằm ở Python hệ thống (ổ C:) - cài lại vào .runtime/venv",
      "models-elsewhere": "model đang nằm ngoài dự án - chuyển được, không phải tải lại",
      "models-empty": "chưa có model nào - tải khi dùng lần đầu",
      "cpu-only": "không có GPU tăng tốc - render bằng CPU",
    },
  },
  en: {
    title: "Environment check",
    ok: "OK",
    missing: "MISSING",
    allGood: "Environment is complete.",
    someMissing: "{n} required item(s) missing - rendering will fail without them.",
    optionalMissing: "{n} optional feature(s) unavailable (everything else still works).",
    installing: "Installing {label}...",
    installed: "{label} installed.",
    installFailed: "Could not install {label} - do it manually: {manual}",
    askOne: "Install {label} ({size}) now? [Y/n] ",
    askMove: "Move {size} of models from {from} to {to}? [Y/n] ",
    needConfirm: "Skipping {label} - this one needs confirmation: run in a terminal or add --yes.",
    manualHint: "Manual: {manual}",
    fixInUi: "Open the dashboard and go to Settings to install with one click.",
    runtimeHint:
      "Everything the project downloads (models, venv, pip cache, binaries) lives in .runtime/ - exclude that folder from backups.",
    why: {
      node: "runtime for the whole system",
      ffmpeg: "cut, concat and encode video",
      chrome: "HyperFrames and Remotion render through headless Chrome",
      "claude-cli": "one way to sign in with a subscription (the other is an API key)",
      "claude-auth": "without a login, AI editing is unavailable",
      whisper: "automatic subtitles",
      vieneu: "on-device narration, free and offline",
      "vieneu-clone": "clone a voice from a short recording",
      "models-dir": "keeps the AI models on the project drive, not the system drive",
      gemini: "background and illustration images",
      cloudflared: "reach the dashboard over 4G/5G",
      runtime: "where the project keeps everything it downloads",
      gpu: "faster rendering",
    },
    note: {
      "ffprobe-missing": "ffmpeg found but ffprobe is missing",
      "not-needed": "not needed - already authenticated",
      "module-missing": "Python found but the module is missing",
      "python-missing": "Python not installed",
      "venv-missing": "no .runtime/venv yet - it is created on install",
      "system-only": "installed in the system Python (C: drive) - reinstall into .runtime/venv",
      "models-elsewhere": "models live outside the project - they can be moved, not re-downloaded",
      "models-empty": "no models yet - downloaded on first use",
      "cpu-only": "no hardware acceleration - rendering on CPU",
    },
  },
};

function fmt(s, vars) {
  let out = s;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** Hỏi Y/n trên terminal - không có stdin tương tác thì coi như "có" */
function askYesNo(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(true);
      return;
    }
    process.stdout.write(question);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      const a = String(data).trim().toLowerCase();
      resolve(a !== "n" && a !== "no");
    });
  });
}

/**
 * Chỉ tô màu khi thật sự in ra terminal. Output bị pipe (start script gom vào
 * file log, hoặc console Windows cũ chưa bật VT) mà vẫn chèn mã ANSI thì người
 * dùng đọc phải toàn ký tự rác kiểu "<-[32m".
 */
const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (USE_COLOR ? `\u001b[${code}m` : "");
const C = {
  reset: paint(0),
  dim: paint(90),
  green: paint(32),
  red: paint(31),
  yellow: paint(33),
  cyan: paint(36),
};

async function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes("--json");
  const wantFix = argv.includes("--fix");
  const assumeYes = argv.includes("--yes");
  const langArg = argv.indexOf("--lang");
  const lang =
    (langArg >= 0 ? argv[langArg + 1] : process.env.AIEV_LANG) === "en" ? "en" : "vi";
  const T = TEXT[lang];

  /**
   * --fix-one <id>: cài ĐÚNG một mục rồi thoát, log chảy thẳng ra stdout.
   * Backend dùng đường này (spawn tiến trình con) thay vì import file này: mọi
   * phép dò ở đây là spawnSync, chạy trong tiến trình server sẽ chặn event loop
   * ~6s - đủ để nghẽn SSE và cả vòng lặp hàng đợi render.
   */
  const fixOneAt = argv.indexOf("--fix-one");
  if (fixOneAt >= 0) {
    const id = argv[fixOneAt + 1];
    try {
      const ok = await applyFix(id, { log: (l) => process.stdout.write(`${l}\n`) });
      return ok ? 0 : 1;
    } catch (err) {
      process.stdout.write(`${err?.message ?? err}\n`);
      return 1;
    }
  }

  let report = runDoctor();

  if (wantJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  const print = (r) => {
    console.log("");
    console.log(`  ${T.title}`);
    console.log(`  ${"=".repeat(T.title.length + 2)}`);
    for (const c of r.checks) {
      const isInfo = c.level === "info";
      const good = c.status === "ok";
      const mark = isInfo ? `${C.dim}[..]` : good ? `${C.green}[OK]` : `${C.red}[!!]`;
      // detail = dữ liệu máy dò được (version, đường dẫn); note = lời giải thích đã dịch
      const tail = [c.detail, c.note ? T.note[c.note] : ""].filter(Boolean).join(" - ");
      console.log(`  ${mark}${C.reset} ${c.label.padEnd(16)}${tail ? `${C.dim} ${tail}${C.reset}` : ""}`);
      if (!good && !isInfo) {
        console.log(`       ${C.dim}${T.why[c.id] ?? ""}${C.reset}`);
      }
    }
    console.log("");
  };

  print(report);

  if (wantFix) {
    // Bỏ qua mục "info" - chúng không phải vấn đề, hỏi cài chỉ làm phiền
    const fixable = report.checks.filter(
      (c) => c.status === "missing" && c.level !== "info" && c.fix?.auto,
    );
    for (const c of fixable) {
      // Chuyển cache model là chuyện 13 GB và có xóa bản gốc - hỏi bằng câu nói
      // rõ dung lượng và CẢ HAI đường dẫn, và không bao giờ mặc định "có" khi
      // không có ai ngồi trước terminal (start script chạy nền, CI...)
      const ask =
        c.fix.kind === "move-models"
          ? fmt(T.askMove, { size: c.fix.size ?? "", from: c.fix.from, to: c.fix.to })
          : fmt(T.askOne, { label: c.label, size: c.fix.size ?? "" });
      if (!assumeYes) {
        if (c.fix.confirm && !process.stdin.isTTY) {
          console.log(`  ${C.dim}${fmt(T.needConfirm, { label: c.label })}${C.reset}`);
          continue;
        }
        if (!(await askYesNo(`  ${ask}`))) continue;
      }
      console.log(`  ${C.cyan}-> ${fmt(T.installing, { label: c.label })}${C.reset}`);
      let ok = false;
      try {
        ok = await applyFix(c.id, { log: (l) => console.log(`     ${C.dim}${l}${C.reset}`) });
      } catch {
        ok = false;
      }
      if (ok) console.log(`  ${C.green}[OK] ${fmt(T.installed, { label: c.label })}${C.reset}`);
      else {
        console.log(
          `  ${C.yellow}[!] ${fmt(T.installFailed, { label: c.label, manual: c.fix.manual })}${C.reset}`,
        );
      }
    }
    if (fixable.length > 0) report = runDoctor();
  }

  const missReq = report.checks.filter((c) => c.level === "required" && c.status === "missing");
  const missOpt = report.checks.filter((c) => c.level === "optional" && c.status === "missing");

  if (missReq.length === 0 && missOpt.length === 0) {
    console.log(`  ${C.green}${T.allGood}${C.reset}`);
  } else {
    if (missReq.length > 0) {
      console.log(`  ${C.red}${fmt(T.someMissing, { n: missReq.length })}${C.reset}`);
      for (const c of missReq) {
        console.log(`     ${C.dim}${c.label}: ${fmt(T.manualHint, { manual: c.fix?.manual ?? "-" })}${C.reset}`);
      }
    }
    if (missOpt.length > 0) {
      console.log(`  ${C.yellow}${fmt(T.optionalMissing, { n: missOpt.length })}${C.reset}`);
    }
    console.log(`  ${C.dim}${T.fixInUi}${C.reset}`);
  }
  console.log(`  ${C.dim}${T.runtimeHint}${C.reset}`);
  console.log("");
  return 0;
}

// Chỉ chạy CLI khi gọi trực tiếp (import từ nơi khác thì bỏ qua đoạn trên)
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(err?.message ?? err);
      // Lỗi của CHÍNH doctor không được chặn start script - trừ --fix-one, nơi
      // backend cần biết lệnh cài đã hỏng
      process.exit(process.argv.includes("--fix-one") ? 1 : 0);
    },
  );
}
