import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { childEnv, paths, venvPython } from "./config.js";
import type { ClonedVoice, TtsRegion, TtsVoice } from "./ttsTypes.js";
import { clonedRefAbs, getClonedVoice, listClonedVoices } from "./voiceStore.js";
import { HttpError, ensureDir, execFileCaptureAll, killTree } from "./util.js";

/**
 * VieNeu-TTS chạy THẲNG TRÊN MÁY - phía Node của cây cầu sang Python.
 *
 * Toàn bộ phần nặng nằm trong `apps/server/python/vieneu_worker.py`; file này
 * chỉ lo ba việc: dò xem máy có chạy được engine không, nuôi ĐÚNG MỘT tiến
 * trình worker, và xếp hàng các yêu cầu gửi vào đó.
 *
 * Những con số ĐO ĐƯỢC trên máy Windows này (đừng "tối ưu" mất):
 * - Nạp model: 15,5s khi đã có cache, ~31s lần đầu (phải tải ~1GB từ HuggingFace).
 *   Vì thế worker sống lâu, không spawn lại mỗi câu.
 * - Tổng hợp: RTF ~1,0 - đọc 3,44s tiếng mất 4,4s. Máy yếu đọc chậm ngang thời
 *   gian thật, nên mọi timeout ở đây phải co giãn theo độ dài chữ.
 * - Đầu ra sẵn là 48kHz mono 16-bit, đúng bằng OUT_SAMPLE_RATE của pipeline nên
 *   KHÔNG cần resample.
 * - Đăng ký một giọng nhân bản: 3,3s, và MẤT khi worker khởi động lại.
 */

// ---------------------------------------------------------------------------
// Hằng số thời gian
// ---------------------------------------------------------------------------

/** Kết quả dò được dùng lại trong 20s - trang chọn giọng gọi liên tục khi mở */
const PROBE_CACHE_MS = 20_000;

/** Dò chỉ import module, nhưng máy lạnh đọc torch từ đĩa có thể mất chục giây */
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Tắt worker sau 10 phút không ai dùng. Model chiếm ~1GB RAM - giữ mãi thì máy
 * dựng video (Chromium + ffmpeg) hết chỗ thở. Đổi lại lần dùng kế tiếp mất thêm
 * ~15s nạp lại, chấp nhận được vì đó là thao tác người dùng chủ động bấm.
 */
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

/**
 * Phần thời gian CỘNG THÊM cho yêu cầu đầu tiên của một worker: lần chạy đầu
 * tiên trên máy mới phải tải ~1GB. Mạng chậm thì 10 phút không phải là thừa.
 */
const MODEL_LOAD_BUDGET_MS = 10 * 60 * 1000;

/** Trần cho một lần tổng hợp: nền + theo độ dài chữ (RTF ~1,0, nhân 3 cho máy yếu) */
const SYNTH_BASE_MS = 60_000;
const SYNTH_MS_PER_CHAR = 400;
const SYNTH_MAX_MS = 20 * 60 * 1000;

/** Đăng ký giọng nhân bản: đo được 3,3s; cho rộng vì mẫu dài + denoise chậm hơn */
const REGISTER_TIMEOUT_MS = 180_000;

/** Nhãn model trả cho UI - không phải id gọi API, chỉ để hiện dưới nút nghe thử */
export const LOCAL_TTS_MODEL = "vieneu-v3turbo";

const WORKER_SCRIPT = path.join(paths.serverDir, "python", "vieneu_worker.py");

// ---------------------------------------------------------------------------
// Dò môi trường
// ---------------------------------------------------------------------------

export interface LocalEngineStatus {
  /** Đọc được chữ thành tiếng không (giọng dựng sẵn) */
  available: boolean;
  /** Nhân bản giọng được không - cần thêm torch, nặng 2-3GB */
  canClone: boolean;
  /**
   * Lý do KHÔNG dùng được, hoặc null khi mọi thứ đủ. Web có sẵn câu dịch theo
   * đúng bốn chuỗi này nên KHÔNG được đổi tên hay thêm giá trị mới ở đây mà
   * không sửa web.
   *
   * NO_TORCH là ca đặc biệt: đọc vẫn chạy (available=true), chỉ riêng nhân bản
   * là không - vì nhánh v3turbo trên CPU chạy bằng ONNX, không dính torch.
   */
  reason: "NO_PYTHON" | "NO_VIENEU" | "NO_TORCH" | "LOAD_FAILED" | null;
  /** Chi tiết cho người dùng đọc - luôn nói rõ phải cài gì */
  detail: string;
}

/**
 * Chương trình dò. CỐ Ý KHÔNG khởi động worker: `import vieneu` chỉ mất 0,00s
 * (gói dùng factory nạp lười), còn dựng model mất 15-31s - dò kiểu đó thì mỗi
 * lần mở trang chọn giọng lại treo nửa phút.
 *
 * Import cả torch + torchaudio + soundfile (đo được ~2,1s) chứ không chỉ
 * find_spec: đó ĐÚNG BẰNG bộ ba mà đường nhân bản cần sau khi vá torchaudio,
 * và torch cài hỏng (thiếu DLL trên Windows) chỉ lộ ra khi import thật.
 */
const PROBE_PY = [
  "import json,sys",
  'out={"vieneu":False,"clone":False,"version":"","err":"","cloneErr":""}',
  "try:",
  "    import vieneu",
  '    out["vieneu"]=True',
  "    import importlib.metadata as m",
  '    out["version"]=m.version("vieneu")',
  "except Exception as e:",
  '    out["err"]=str(e)[:300]',
  "try:",
  "    import torch, torchaudio, soundfile",
  '    out["clone"]=True',
  "except Exception as e:",
  '    out["cloneErr"]=str(e)[:300]',
  // Có tiền tố để nhặt đúng dòng của mình - thư viện hay in cảnh báo lẫn vào.
  // json.dumps mặc định ensure_ascii nên dòng này luôn thuần ASCII, không sợ
  // console cp1252 của Windows làm hỏng.
  'sys.stdout.write("VIENEU_PROBE "+json.dumps(out))',
].join("\n");

interface ProbeData {
  vieneu: boolean;
  clone: boolean;
  version: string;
  err: string;
  cloneErr: string;
}

let cachedPython: string | null = null;
let probeCache: { at: number; status: LocalEngineStatus } | null = null;
/**
 * Lỗi nạp model gần nhất. Dính lại cho tới khi có ai đó dò lại với force -
 * người dùng bấm "Kiểm tra lại" trên web là hết. Nếu không dính, UI sẽ báo
 * "sẵn sàng" ngay sau một lần nạp hỏng vì phép dò chỉ kiểm import.
 */
let loadFailure: string | null = null;

/** Vài dòng cuối stderr - đủ hiểu lỗi mà không nhấn chìm log */
function tail(text: string, lines = 8): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .join("\n");
}

/** Chạy chương trình dò bằng một interpreter. null = không có exe này trên PATH. */
async function runProbe(exe: string): Promise<ProbeData | null> {
  let r: Awaited<ReturnType<typeof execFileCaptureAll>>;
  try {
    r = await execFileCaptureAll(exe, ["-c", PROBE_PY], { timeoutMs: PROBE_TIMEOUT_MS });
  } catch {
    return null; // không spawn được -> tên khác
  }
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("VIENEU_PROBE "));
  if (!line) {
    // Python chạy được nhưng chương trình dò không ra kết quả (hiếm: bị giết,
    // hoặc bản Python quá cũ không parse nổi). Coi như thiếu gói.
    return {
      vieneu: false,
      clone: false,
      version: "",
      err: r.timedOut ? "quá thời gian khi dò" : tail(r.stderr, 4) || `thoát mã ${r.code}`,
      cloneErr: "",
    };
  }
  try {
    const raw = JSON.parse(line.slice("VIENEU_PROBE ".length)) as Partial<ProbeData>;
    return {
      vieneu: raw.vieneu === true,
      clone: raw.clone === true,
      version: typeof raw.version === "string" ? raw.version : "",
      err: typeof raw.err === "string" ? raw.err : "",
      cloneErr: typeof raw.cloneErr === "string" ? raw.cloneErr : "",
    };
  } catch {
    return { vieneu: false, clone: false, version: "", err: "kết quả dò không phải JSON", cloneErr: "" };
  }
}

const INSTALL_HINT =
  "Cài Python 3.10+ rồi chạy `pip install vieneu` (giọng đọc offline, khoảng 30MB). " +
  "Muốn nhân bản giọng thì cài thêm `pip install torch torchaudio` (2-3GB). " +
  "Máy có nhiều bản Python thì trỏ biến môi trường PYTHON_BIN vào bản đã cài.";

/**
 * Máy này chạy được VieNeu chưa.
 *
 * Dò theo đúng lối của transcribe.ts: thử PYTHON_BIN/PYTHON rồi python/py/python3,
 * lấy interpreter ĐÃ CÀI module (máy có 2 bản Python mà chỉ 1 bản có gói là
 * chuyện thường). Chỉ cache interpreter khi nó thật sự có `vieneu` - người dùng
 * pip install xong là lần dò sau thấy ngay, không phải khởi động lại server.
 */
export async function probeLocalEngine(force = false): Promise<LocalEngineStatus> {
  if (force) {
    probeCache = null;
    cachedPython = null;
    loadFailure = null;
  }
  if (probeCache && Date.now() - probeCache.at < PROBE_CACHE_MS) return probeCache.status;

  // Thứ tự: PYTHON_BIN người dùng chỉ định (cửa thoát, luôn thắng) → venv trong
  // repo (.runtime/venv - nơi doctor cài sẵn gói, và model tải về nằm cùng ổ với
  // repo) → PYTHON → các tên trên PATH.
  const candidates = [
    process.env.PYTHON_BIN,
    venvPython(),
    process.env.PYTHON,
    "python",
    "py",
    "python3",
  ].filter((c): c is string => typeof c === "string" && c.trim().length > 0);

  let anyPython = false;
  let best: { exe: string; data: ProbeData } | null = null;
  let firstErr = "";
  for (const exe of candidates) {
    const data = await runProbe(exe);
    if (!data) continue;
    anyPython = true;
    if (!firstErr) firstErr = data.err;
    if (data.vieneu) {
      best = { exe, data };
      break;
    }
  }

  let status: LocalEngineStatus;
  if (!anyPython) {
    status = {
      available: false,
      canClone: false,
      reason: "NO_PYTHON",
      detail: `Không tìm thấy Python trên máy. ${INSTALL_HINT}`,
    };
  } else if (!best) {
    status = {
      available: false,
      canClone: false,
      reason: "NO_VIENEU",
      detail: `Python có nhưng chưa cài gói vieneu. ${INSTALL_HINT}${firstErr ? `\nChi tiết: ${firstErr}` : ""}`,
    };
  } else {
    cachedPython = best.exe;
    const v = best.data.version ? ` ${best.data.version}` : "";
    status = best.data.clone
      ? {
          available: true,
          canClone: true,
          reason: null,
          detail: `VieNeu-TTS${v} sẵn sàng (${best.exe}) - đọc offline và nhân bản giọng đều dùng được.`,
        }
      : {
          available: true,
          canClone: false,
          reason: "NO_TORCH",
          detail:
            `VieNeu-TTS${v} đọc được offline nhưng CHƯA nhân bản được giọng: thiếu torch. ` +
            "Chạy `pip install torch torchaudio` (2-3GB) rồi kiểm tra lại." +
            (best.data.cloneErr ? `\nChi tiết: ${best.data.cloneErr}` : ""),
        };
  }

  // Nạp hỏng thì đè lên mọi kết luận lạc quan phía trên: import được không có
  // nghĩa là dựng được model (thiếu chỗ trống, tải dở file trong cache HuggingFace...).
  if (status.available && loadFailure) {
    status = {
      available: false,
      canClone: false,
      reason: "LOAD_FAILED",
      detail: `Không nạp được model VieNeu: ${loadFailure}`,
    };
  }

  probeCache = { at: Date.now(), status };
  return status;
}

/** Interpreter đã chọn - gọi sau khi probe nói available */
async function requirePython(): Promise<string> {
  const status = await probeLocalEngine();
  if (!status.available || !cachedPython) {
    throw new HttpError(503, status.reason ?? "NO_VIENEU", status.detail);
  }
  return cachedPython;
}

// ---------------------------------------------------------------------------
// Tiến trình worker
// ---------------------------------------------------------------------------

interface WorkerRes {
  id: number;
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

interface PendingReq {
  resolve: (r: WorkerRes) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  cancelTimer: NodeJS.Timeout | null;
}

let worker: ChildProcess | null = null;
let stdoutBuf = "";
let stderrTail: string[] = [];
let nextReqId = 1;
const pending = new Map<number, PendingReq>();
/**
 * Giọng nhân bản đang có TRONG TIẾN TRÌNH ĐANG SỐNG. Không phải danh sách kho:
 * add_voice(save=False) chỉ nằm trong RAM, worker chết là mất sạch. Xóa set này
 * mỗi lần worker thoát, nếu không thì lần sau sẽ bỏ qua bước đăng ký và tổng
 * hợp báo "voice not found".
 */
const registeredInWorker = new Set<string>();
/** Worker này đã nạp xong model chưa - dùng để bớt phần thời gian chờ tải model */
let workerHasModel = false;
let idleTimer: NodeJS.Timeout | null = null;
/**
 * Nơi đổ log stderr của worker khi đang có yêu cầu chạy. Các yêu cầu đã được
 * xếp hàng nên tại một thời điểm chỉ có tối đa một người nhận.
 */
let activeLog: ((line: string) => void) | null = null;

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size > 0) return; // đang bận - hàng đợi sẽ hẹn lại
    stopWorker("hết 10 phút không dùng");
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

function stopWorker(why: string): void {
  const child = worker;
  worker = null;
  workerHasModel = false;
  registeredInWorker.clear();
  stdoutBuf = "";
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (child) {
    console.log(`[vieneu] tắt worker (${why})`);
    killTree(child);
  }
}

/** Worker chết giữa chừng: mọi yêu cầu đang bay phải hỏng NGAY, đừng để treo tới timeout */
function failPending(err: Error): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    if (p.cancelTimer) clearInterval(p.cancelTimer);
    pending.delete(id);
    p.reject(err);
  }
}

function handleLine(line: string): void {
  const text = line.trim();
  if (!text) return;
  let msg: WorkerRes;
  try {
    msg = JSON.parse(text) as WorkerRes;
  } catch {
    // Không thể xảy ra nếu worker giữ đúng giao thức (nó đã đổi fd 1 sang stderr
    // để thư viện C không chen được vào). Ghi lại để còn lần ra nếu vẫn xảy ra.
    console.warn(`[vieneu] bỏ qua dòng stdout không phải JSON: ${text.slice(0, 200)}`);
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return; // trả lời cho một yêu cầu đã bị hủy/quá hạn
  clearTimeout(p.timer);
  if (p.cancelTimer) clearInterval(p.cancelTimer);
  pending.delete(msg.id);
  p.resolve(msg);
}

function startWorker(python: string): ChildProcess {
  if (!fs.existsSync(WORKER_SCRIPT)) {
    throw new HttpError(
      500,
      "VIENEU_WORKER_MISSING",
      `Thiếu file worker ${WORKER_SCRIPT} - bản cài đặt bị lỗi, tải lại repo.`,
    );
  }
  // env: HF_HOME trỏ vào .runtime/models - model ~1GB của VieNeu tải từ
  // HuggingFace về nằm cùng ổ với repo, không rơi vào ~/.cache trên ổ hệ thống
  // (thư mục đó trên máy này đã phình 13,3GB). Xem childEnv() ở config.ts.
  const child = spawn(python, [WORKER_SCRIPT], { windowsHide: true, env: childEnv() });
  worker = child;
  stdoutBuf = "";
  stderrTail = [];
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    // Worker cũ đang chết dở vẫn có thể xả nốt stdout - không được trộn vào
    // buffer/pending của worker mới
    if (worker !== child) return;
    stdoutBuf += chunk;
    // Tách theo dòng: một phản hồi có thể tới làm nhiều mảnh, và nhiều phản hồi
    // có thể dính trong một mảnh.
    let nl = stdoutBuf.indexOf("\n");
    while (nl >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      handleLine(line);
      nl = stdoutBuf.indexOf("\n");
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      stderrTail.push(t);
      if (stderrTail.length > 40) stderrTail.shift();
      activeLog?.(t);
    }
  });
  // Chỉ worker HIỆN TẠI được đánh hỏng các yêu cầu đang chờ. Sau timeout/hủy,
  // stopWorker giết worker cũ (bất đồng bộ - trên Windows qua taskkill) và yêu
  // cầu kế tiếp đã spawn worker mới; "close" của worker cũ tới muộn mà vẫn
  // failPending là giết oan yêu cầu của worker mới.
  child.on("error", (err) => {
    if (worker !== child) return;
    stopWorker(`không chạy được: ${err.message}`);
    failPending(new Error(`Không chạy được worker VieNeu: ${err.message}`));
  });
  child.on("close", (code) => {
    if (worker !== child) return;
    const why = tail(stderrTail.join("\n"), 6);
    stopWorker(`tiến trình thoát mã ${code}`);
    failPending(
      new Error(
        `Worker VieNeu đã thoát (mã ${code}) khi đang xử lý yêu cầu.` + (why ? `\n${why}` : ""),
      ),
    );
  });
  return child;
}

function ensureWorker(python: string): ChildProcess {
  if (worker && !worker.killed && worker.exitCode === null) return worker;
  return startWorker(python);
}

interface SendOpts {
  timeoutMs: number;
  onLog?: (line: string) => void;
  isCanceled?: () => boolean;
}

/** Gửi MỘT lệnh và chờ phản hồi cùng id. Không tự xếp hàng - dùng qua enqueue(). */
function sendCommand(payload: Record<string, unknown>, opts: SendOpts, python: string): Promise<WorkerRes> {
  return new Promise<WorkerRes>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = ensureWorker(python);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const id = nextReqId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      // Không có cách nào cắt ngang một lần infer đang chạy - phải giết tiến
      // trình. Lần sau sẽ nạp lại model (~15s), đắt nhưng còn hơn treo mãi.
      stopWorker("yêu cầu quá thời gian");
      reject(
        new Error(
          `VieNeu không trả lời sau ${Math.round(opts.timeoutMs / 1000)}s - đã tắt tiến trình. ` +
            "Máy quá yếu hoặc lần đầu đang tải model, thử lại sau.",
        ),
      );
    }, opts.timeoutMs);
    const cancelTimer = opts.isCanceled
      ? setInterval(() => {
          if (!opts.isCanceled?.() || !pending.has(id)) return;
          pending.delete(id);
          clearTimeout(timer);
          clearInterval(cancelTimer as NodeJS.Timeout);
          stopWorker("job bị hủy");
          reject(new Error("Job đã bị hủy"));
        }, 1_000)
      : null;
    cancelTimer?.unref?.();
    pending.set(id, { resolve, reject, timer, cancelTimer });
    child.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`, (err) => {
      if (!err) return;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
      reject(new Error(`Không gửi được lệnh cho worker VieNeu: ${err.message}`));
    });
  });
}

/**
 * Hàng đợi tuần tự.
 *
 * BẮT BUỘC: model KHÔNG dùng lại được song song - hai lần infer chồng nhau trong
 * cùng một tiến trình vừa tranh CPU vừa có nguy cơ hỏng trạng thái. Xếp hàng
 * cũng là thứ giữ cho stderr chỉ có một người nhận (activeLog).
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Đổi phản hồi ok:false thành lỗi có mã cho tầng route */
function toError(res: WorkerRes): Error {
  const code = typeof res.code === "string" ? res.code : "VIENEU_FAILED";
  const message = typeof res.message === "string" ? res.message : "không rõ nguyên nhân";
  if (code === "NO_TORCH") {
    return new HttpError(
      503,
      "NO_TORCH",
      "Máy chưa cài torch nên không nhân bản được giọng. Chạy `pip install torch torchaudio` (2-3GB) rồi thử lại.",
    );
  }
  if (code === "VOICE_NOT_FOUND") {
    return new HttpError(400, "VOICE_NOT_FOUND", `VieNeu không có giọng này: ${message}`);
  }
  if (code === "REF_NOT_FOUND") {
    return new HttpError(404, "CLONE_REF_MISSING", `Không đọc được file mẫu của giọng: ${message}`);
  }
  if (code === "NO_VIENEU" || code === "LOAD_FAILED") {
    loadFailure = message;
    probeCache = null;
    return new HttpError(503, "LOAD_FAILED", `Không nạp được model VieNeu: ${message}`);
  }
  return new Error(`VieNeu lỗi (${code}): ${message}`);
}

/** Một lệnh trọn vẹn: xếp hàng, bảo đảm có worker, dịch lỗi */
async function call(payload: Record<string, unknown>, opts: SendOpts): Promise<WorkerRes> {
  const python = await requirePython();
  return enqueue(async () => {
    activeLog = opts.onLog ?? null;
    try {
      const res = await sendCommand(payload, opts, python);
      if (!res.ok) throw toError(res);
      workerHasModel = true;
      loadFailure = null;
      return res;
    } finally {
      activeLog = null;
      resetIdleTimer();
    }
  });
}

/** Phần thời gian cộng thêm khi worker chưa nạp model (lần đầu còn phải tải ~1GB) */
function loadBudget(): number {
  return workerHasModel ? 0 : MODEL_LOAD_BUDGET_MS;
}

function synthTimeout(text: string): number {
  return loadBudget() + Math.min(SYNTH_MAX_MS, SYNTH_BASE_MS + text.length * SYNTH_MS_PER_CHAR);
}

// ---------------------------------------------------------------------------
// Danh sách giọng
// ---------------------------------------------------------------------------

interface PresetRow {
  name: string;
  gender: string;
  region: string;
  style: string;
}

/**
 * Danh sách giọng dựng sẵn - giữ cho tới khi tắt server.
 *
 * Hỏi worker là phải NẠP MODEL (15-31s). Danh sách này chỉ đổi khi người dùng
 * nâng cấp gói vieneu, mà nâng cấp thì phải khởi động lại server - nên cache
 * suốt vòng đời tiến trình là đúng, và nhờ vậy mở lại trang chọn giọng sau khi
 * worker đã tự tắt vì rảnh cũng không phải nạp model lần nữa.
 */
let presetCache: TtsVoice[] | null = null;

const GENDER_WORD: Record<string, string> = { nam: "nam", nu: "nữ" };
const REGION_WORD: Record<string, string> = { bac: "miền Bắc", trung: "miền Trung", nam: "miền Nam" };
const STYLE_WORD: Record<string, string> = {
  "tin-tuc": "phong cách tin tức",
  "tu-nhien": "phong cách tự nhiên",
  "ke-chuyen": "phong cách kể chuyện",
};

function presetToVoice(row: PresetRow): TtsVoice {
  const gender = row.gender === "nu" ? "nu" : "nam";
  const region = (["bac", "trung", "nam"].includes(row.region) ? row.region : null) as TtsRegion | null;
  const parts = [GENDER_WORD[gender], region ? REGION_WORD[region] : "", STYLE_WORD[row.style] ?? ""].filter(
    Boolean,
  );
  return {
    engine: "vieneu",
    // Giọng dựng sẵn: chính tên tiếng Việt là định danh gửi lên khi tổng hợp
    name: row.name,
    title: row.name,
    label: `${row.name} - ${parts.join(", ")}`,
    gender,
    // Chưa đo F0 cho giọng VieNeu - để 0 chứ không đoán (xem ghi chú ở ttsTypes.ts)
    f0: 0,
    kind: "preset",
    region,
    timbreKey: row.style,
    note: "",
  };
}

async function fetchPresets(): Promise<TtsVoice[]> {
  const res = await call({ cmd: "voices" }, { timeoutMs: loadBudget() + 120_000 });
  const raw = Array.isArray(res.voices) ? (res.voices as unknown[]) : [];
  const rows: PresetRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name) continue;
    rows.push({
      name: r.name,
      gender: typeof r.gender === "string" ? r.gender : "",
      region: typeof r.region === "string" ? r.region : "",
      style: typeof r.style === "string" ? r.style : "",
    });
  }
  return rows.map(presetToVoice);
}

function clonedToVoice(v: ClonedVoice): TtsVoice {
  return {
    engine: "vieneu",
    // Định danh là ID kho, KHÔNG phải tên hiển thị: người dùng đổi tên lúc nào
    // cũng được, mà đổi xong thì phiên cũ vẫn phải đọc ra đúng giọng ấy.
    name: v.id,
    title: v.name,
    label: `${v.name} - giọng nhân bản`,
    gender: v.gender,
    f0: 0,
    kind: "cloned",
    region: null,
    timbreKey: "cloned",
    note: v.note,
  };
}

/**
 * Giọng dựng sẵn + giọng đã nhân bản.
 *
 * KHÔNG BAO GIỜ ném lỗi: ô chọn giọng vẫn phải vẽ ra được kể cả khi máy chưa
 * cài Python - lúc đó danh sách rỗng và web hiện hướng dẫn cài (lấy từ
 * probeLocalEngine).
 */
export async function listLocalVoices(): Promise<TtsVoice[]> {
  const status = await probeLocalEngine();
  if (!status.available) return [];

  if (!presetCache) {
    try {
      presetCache = await fetchPresets();
    } catch (err) {
      // Vẫn trả về giọng nhân bản: hỏng lúc nạp model thì người dùng ít nhất
      // còn thấy kho giọng của mình, thay vì tưởng là mất hết.
      console.warn(
        `[vieneu] không lấy được danh sách giọng dựng sẵn: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const cloned = listClonedVoices().map(clonedToVoice);
  const clonedIds = new Set(cloned.map((v) => v.name));
  // Lọc trùng: nếu ai đó lỡ gọi save_voices() thì giọng nhân bản bị ghi luôn
  // vào file của gói trong site-packages và từ đó hiện ra như giọng dựng sẵn.
  // Đã gặp thật trên máy này (một giọng thử tên "cloned-test" còn nằm lại trong
  // site-packages). Worker đã lọc phần lớn, đây là lưới thứ hai.
  const presets = (presetCache ?? []).filter((p) => !clonedIds.has(p.name));
  return [...presets, ...cloned];
}

// ---------------------------------------------------------------------------
// Tổng hợp
// ---------------------------------------------------------------------------

/**
 * Bảo đảm giọng nhân bản đã có trong TIẾN TRÌNH ĐANG SỐNG.
 *
 * Đăng ký chỉ nằm trong RAM của worker (add_voice save=False), nên mỗi lần
 * worker khởi động lại - vì rảnh quá 10 phút, vì bị hủy, vì crash - là phải
 * nạp lại từ kho. Tên giọng không có trong kho thì đó là giọng dựng sẵn, không
 * cần làm gì.
 */
async function ensureRegistered(voice: string, opts: { onLog?: (l: string) => void }): Promise<boolean> {
  const rec = getClonedVoice(voice);
  if (!rec) return false; // giọng dựng sẵn
  if (registeredInWorker.has(rec.id)) return true;

  const status = await probeLocalEngine();
  if (!status.canClone) {
    throw new HttpError(503, "NO_TORCH", status.detail);
  }
  const refAbs = clonedRefAbs(rec);
  if (!fs.existsSync(refAbs)) {
    throw new HttpError(
      404,
      "CLONE_REF_MISSING",
      `Mất file mẫu của giọng "${rec.name}" (${refAbs}). Xóa giọng này rồi nhân bản lại.`,
    );
  }
  opts.onLog?.(`[vieneu] nạp giọng nhân bản "${rec.name}" vào tiến trình (~3s)`);
  await call(
    { cmd: "register", voice: rec.id, ref: refAbs },
    { timeoutMs: loadBudget() + REGISTER_TIMEOUT_MS, onLog: opts.onLog },
  );
  registeredInWorker.add(rec.id);
  return true;
}

async function synthToFile(input: {
  text: string;
  voice: string;
  outWavAbs: string;
  onLog?: (line: string) => void;
  isCanceled?: () => boolean;
}): Promise<number> {
  const text = input.text.trim();
  if (!text) throw new HttpError(400, "TTS_EMPTY_TEXT", "Không có chữ nào để đọc");
  const voice = input.voice.trim();
  if (!voice) throw new HttpError(400, "VOICE_REQUIRED", "Thiếu tên giọng");

  ensureDir(path.dirname(input.outWavAbs));
  const isCloned = await ensureRegistered(voice, { onLog: input.onLog });
  const send = (): Promise<WorkerRes> =>
    call(
      { cmd: "synth", text, voice, out: input.outWavAbs },
      { timeoutMs: synthTimeout(text), onLog: input.onLog, isCanceled: input.isCanceled },
    );

  let res: WorkerRes;
  try {
    res = await send();
  } catch (err) {
    // Worker có thể đã chết và khởi động lại GIỮA lúc đăng ký và lúc tổng hợp -
    // tiến trình mới không còn giọng nhân bản nào. Nạp lại đúng một lần rồi thử
    // lại; hỏng tiếp thì mới là lỗi thật.
    const lost = err instanceof HttpError && err.code === "VOICE_NOT_FOUND";
    if (!isCloned || !lost) throw err;
    registeredInWorker.delete(voice);
    await ensureRegistered(voice, { onLog: input.onLog });
    res = await send();
  }

  const duration = typeof res.durationSec === "number" ? res.durationSec : 0;
  if (!fs.existsSync(input.outWavAbs) || duration <= 0) {
    throw new Error(`VieNeu báo xong nhưng không có file đọc được: ${input.outWavAbs}`);
  }
  return duration;
}

/** Đọc thử một câu ngắn -> WAV trong bộ nhớ. File tạm bị xóa ngay sau khi đọc. */
export async function synthLocalPreviewWav(input: {
  text: string;
  voice: string;
}): Promise<{ wav: Buffer; durationSec: number; model: string }> {
  const dir = path.join(paths.dataDir, "tts-preview");
  ensureDir(dir);
  const outAbs = path.join(dir, `preview-${process.pid}-${Date.now()}.wav`);
  try {
    const durationSec = await synthToFile({ ...input, outWavAbs: outAbs });
    return { wav: fs.readFileSync(outAbs), durationSec, model: LOCAL_TTS_MODEL };
  } finally {
    try {
      fs.rmSync(outAbs, { force: true });
    } catch {
      /* file tạm - kệ nếu đang bị giữ */
    }
  }
}

/**
 * Một đoạn kịch bản -> file WAV 48kHz mono.
 *
 * durationSec là số ĐO ĐƯỢC (worker đọc header WAV vừa ghi), không suy ra từ số
 * ký tự. Phía gọi vẫn nên đo lại bằng ffprobe sau khi cắt lặng/ghép - giống hệt
 * đường Gemini.
 */
export async function synthLocalChunkWav(input: {
  text: string;
  voice: string;
  outWavAbs: string;
  onLog?: (l: string) => void;
  isCanceled?: () => boolean;
}): Promise<{ wavAbs: string; durationSec: number }> {
  const durationSec = await synthToFile(input);
  return { wavAbs: input.outWavAbs, durationSec };
}

/** Tắt worker - gọi khi server đóng để không để lại tiến trình Python mồ côi */
export function shutdownLocalTts(): void {
  failPending(new Error("Server đang tắt - đã dừng VieNeu"));
  stopWorker("server tắt");
}
