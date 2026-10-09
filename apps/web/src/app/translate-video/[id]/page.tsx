"use client";

/**
 * Chi tiết một phiên "Dịch video" - lắp bằng bộ khối workspace 3 cột dùng chung
 * (`components/Workspace.tsx`), chia theo NHỊP LÀM VIỆC chứ không theo số bước:
 *
 * - Cột `source`: video gốc (tải lên, xem trước), ngôn ngữ nguồn, và NGAY DƯỚI
 *   VIDEO là khối bóc lời thoại - thao tác trên nguồn thì phải nằm cạnh nguồn.
 *   Trước đây khối này ở cột kết quả: người dùng phải nhìn sang đầu kia màn hình
 *   để bấm một nút làm việc trên chính cái video đang xem ở đây.
 * - Cột `setup`: ngôn ngữ đích, chế độ, model dịch, danh sách câu thoại sửa tay
 *   được - phần "mình muốn ra cái gì". Hai cụm cấu hình NẶNG (kiểu phụ đề kèm ô
 *   xem trước, và bảng gán giọng cho từng người nói ~430 dòng) nằm trong MODAL,
 *   mở ra ngay lúc chọn chế độ. Đã thử đưa chúng thành khối thật trong cột như
 *   ba trang anh em (projects, text-to-video, auto cut) và bị người dùng bác:
 *   riêng trang này phần cấu hình dài tới mức chọn xong chế độ ở trên phải cuộn
 *   rất xa mới tới chỗ chỉnh. Modal đưa thẳng cấu hình ra trước mặt. Cột giữa
 *   giữ một Panel tóm tắt cho mỗi phần đang bật, kèm nút mở lại modal.
 * - Cột `output`: khối video thành phẩm ĐỨNG ĐẦU (chạy thì nhấp nháy chờ, xong
 *   thì hiện thẳng video), rồi mới tới tiến trình dịch.
 *
 * Bề rộng cột do container query trong globals.css quyết định - trang KHÔNG tự
 * tính pixel, vì bề rộng thật còn phụ thuộc rail trái và panel phải đang gấp hay mở.
 *
 * Thanh bước dùng chung StepperBar với Videos Project - không tự vẽ thanh thứ hai.
 *
 * Phiên render xong (status "done") thì các khối khác tự gấp lại còn một dòng tóm
 * tắt, riêng khối video thành phẩm vẫn mở. Gấp/mở vẫn bấm tay được và ý người dùng
 * luôn thắng mặc định - xem `useCollapseGroup`.
 */

import {
  AlertTriangle,
  ArrowLeft,
  Cloud,
  Cpu,
  FileVideo,
  Film,
  Languages,
  Layers,
  Loader2,
  Mic,
  Play,
  ScrollText,
  Square,
  Subtitles,
  Trash2,
  Type,
  Upload,
  Wand2,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteTranslateVideo,
  dubPreviewTranslateVideo,
  DEFAULT_TRANSLATE_MODEL,
  DUB_ALL_SPEAKERS,
  DUB_ORIGINAL_VOLUME_MAX,
  getJob,
  getJobs,
  getSttProviders,
  getTranslateVideo,
  getTtsEngines,
  getTtsVoices,
  isTranslateVideoJob,
  mediaUrl,
  renderTranslateVideo,
  SUBTITLE_BLUR_MAX,
  SUBTITLE_BOTTOM_MAX,
  SUBTITLE_FONT_SIZE_MAX,
  SUBTITLE_FONT_SIZE_MIN,
  SUBTITLE_FONTS,
  TRANSLATE_DEFAULT_DUB,
  TRANSLATE_DEFAULT_SUBTITLE_STYLE,
  TRANSLATE_MODE_LABEL,
  TRANSLATE_MODELS,
  TRANSLATE_PROVIDER,
  TRANSLATE_SOURCE_LANGS,
  TRANSLATE_TARGET_LANGS,
  TRANSLATE_VIDEO_STATUS_LABEL,
  TRANSLATE_VIDEO_STATUS_TONE,
  TTS_ENGINES,
  transcribeTranslateVideo,
  translateTranslateVideo,
  updateTranslateVideo,
  uploadTranslateVideoSource,
  type DubInfo,
  type DubPreviewResult,
  type DubSettings,
  type Job,
  type SttCapability,
  type SttProvider,
  type SubtitleBackdrop,
  type SubtitleFontId,
  type SubtitleStyle,
  type TranslatedCue,
  type TranslateMode,
  type TranslateVideoMeta,
  type TtsEngine,
  type TtsEngineStatus,
  type TtsGender,
  type TtsVoice,
} from "@/lib/api";
import { useEvents, useJobEvents, useJobLogEvents } from "@/lib/useEvents";
import { Badge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { CheckboxField, Field } from "@/components/Field";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { InfoHint } from "@/components/InfoHint";
import { Modal } from "@/components/Modal";
import { OptionCard, OptionCardGroup } from "@/components/OptionCard";
import { Panel } from "@/components/Panel";
import { PageHeader } from "@/components/PageHeader";
import { Segmented } from "@/components/Segmented";
import { StepperBar } from "@/components/PipelineTimeline";
import { ProgressBar } from "@/components/ProgressBar";
import { ShellRightPanel } from "@/components/Shell";
import {
  OutputBlock,
  useCollapseGroup,
  Workspace,
  WorkspaceBlock,
  WorkspaceColumn,
  type WorkspaceStatus,
} from "@/components/Workspace";
// clock() (giây → mm:ss) đã có sẵn ở đây, lib/format.ts chưa có helper tương đương
import { clock } from "@/components/AutoCutCommon";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";

/** Gộp nhiều lần gõ phím thành một PATCH - không bắn request mỗi ký tự. */
const PATCH_DEBOUNCE_MS = 700;

/** Trạng thái nào là "đang có việc chạy" - lúc đó mọi ô nhập bị khóa. */
const RUNNING_STATUS = ["transcribing", "translating", "rendering"];

/**
 * Font stack thật của từng id trong allowlist - CHỈ dùng cho ô xem trước ở web.
 * Bản render cuối do server quyết định font file; chỗ này chỉ cần cho người dùng
 * thấy đúng dáng chữ trước khi tốn thời gian render.
 */
const FONT_STACK: Record<SubtitleFontId, string> = {
  vietnamese: "'Be Vietnam Pro', 'Inter', 'Segoe UI', system-ui, sans-serif",
  sans: "'Inter', 'Segoe UI', Arial, system-ui, sans-serif",
  serif: "'Noto Serif', Georgia, 'Times New Roman', serif",
  mono: "'JetBrains Mono', 'Consolas', ui-monospace, monospace",
};

/**
 * Các khối GẤP/MỞ của phiên - key vừa là id state gấp/mở vừa là id vùng nội dung.
 *
 * KHÔNG có "subtitle" và "dub" ở đây: hai cụm cấu hình ấy sống trong modal chứ
 * không phải khối gấp/mở trong cột (xem ghi chú ở `chooseMode`).
 */
const TV_BLOCKS = ["source", "transcript", "translation", "result"] as const;
type BlockKey = (typeof TV_BLOCKS)[number];

/**
 * Khối vẫn MỞ khi phiên xong: video thành phẩm. Xong việc thì người dùng vào
 * trang là để xem thành phẩm, không phải để sửa ô nhập nữa.
 */
const TV_KEEP_EXPANDED: readonly BlockKey[] = ["result"];

// Giá trị là KEY dictionary - StepperBar tự dịch bằng t() lúc render.
const STAGE_LABELS = [
  "tv.stage.source",
  "tv.stage.transcript",
  "tv.stage.translation",
  "tv.stage.subtitle",
  "tv.stage.result",
] as const;

/**
 * Mốc lấy khung hình làm nền cho ô xem trước phụ đề (giây).
 *
 * Không lấy giây 0: rất nhiều video mở màn bằng một khung đen hoặc một khung
 * mờ, mà nền đen phẳng chính là thứ làm "Độ mờ" nhìn như không có tác dụng.
 */
const PREVIEW_FRAME_SEC = 2;

/** Độ dài tối đa của lỗi hiện trong khối kết quả - xem `shortError`. */
const ERROR_PREVIEW_MAX = 240;

/**
 * Rút gọn lỗi cho khối kết quả. Lỗi thật (traceback faster-whisper, log ffmpeg)
 * dài hàng chục dòng, đổ nguyên vào khung video là đẩy mọi thứ khác xuống dưới
 * màn hình - bản đầy đủ vẫn nằm ở banner lỗi phía trên trang.
 */
function shortError(e: string | null | undefined): string | null {
  if (!e) return null;
  const s = e.replace(/\s+/g, " ").trim();
  return s.length > ERROR_PREVIEW_MAX ? `${s.slice(0, ERROR_PREVIEW_MAX)}…` : s;
}

/** Thay đổi đang chờ gửi - luôn gửi trọn từng khối con để server khỏi phải merge. */
interface Patch {
  name?: string;
  sourceLang?: string;
  targetLang?: string;
  /** null = đọc đúng ngôn ngữ phụ đề */
  dubLang?: string | null;
  mode?: TranslateMode;
  sttProvider?: SttProvider;
  cues?: TranslatedCue[];
  subtitleStyle?: SubtitleStyle;
  dub?: DubSettings;
}

/**
 * Bước hiện tại suy từ dữ liệu phiên - backend vẫn là nguồn sự thật, chỗ này chỉ
 * đọc. `active` = đang có việc chạy (chấm nhấp nháy), `complete` = xong hết.
 */
function deriveTvStage(m: TranslateVideoMeta): {
  stage: number;
  active: boolean;
  complete: boolean;
} {
  if (m.status === "transcribing") return { stage: 2, active: true, complete: false };
  if (m.status === "translating") return { stage: 3, active: true, complete: false };
  if (m.status === "rendering") return { stage: 5, active: true, complete: false };
  if (m.status === "done") return { stage: 5, active: false, complete: true };
  // Các trạng thái đứng yên (draft/transcribed/translated/failed) suy từ DỮ LIỆU
  // đang có, không suy từ tên trạng thái - phiên lỗi giữa chừng vẫn chỉ đúng chỗ.
  if (m.cues.length > 0) {
    const translated = m.cues.some((c) => c.text.trim() !== "");
    return { stage: translated ? 4 : 3, active: false, complete: false };
  }
  if (m.transcriptFile) return { stage: 3, active: false, complete: false };
  return { stage: m.source.relPath ? 2 : 1, active: false, complete: false };
}

/**
 * Log của job - đúng nội dung trang Render Queue hiển thị: tiến trình + từng
 * dòng log chảy về qua SSE `joblog`.
 *
 * Sống trong PANEL PHẢI của shell, không nằm trong cột giữa nữa. Trước đây log
 * bị nhét vào hai khối khác nhau (bóc lời một chỗ, đóng phụ đề một chỗ) nên
 * đang chạy bước nào thì phải cuộn đi tìm đúng khối đó, mà mở khối kia ra thì
 * chẳng thấy gì. Panel phải luôn ở đó, gấp lại được, và giống hệt Videos
 * Project với Text to video - ba trang cùng một chỗ để nhìn log.
 */
function JobLogBlock({ job, stepLabel }: { job: Job; stepLabel: string }) {
  const { t } = useT();
  const jobId = job.id;
  // SSE nối lại sau khi đứt → refetch log để lấp các dòng đã lỡ
  const { resyncTick } = useEvents();
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    setLog("");
    setError(null);
    getJob(jobId)
      .then((j) => {
        if (!alive) return;
        const fetched = j.log ?? "";
        // Trong lúc chờ fetch, SSE có thể đã đổ thêm dòng vào state - GHÉP chứ
        // không ghi đè, kẻo mất đúng những dòng mới nhất người dùng đang nhìn.
        setLog((prev) => {
          if (!prev) return fetched;
          if (!fetched) return prev;
          // Bản fetch thường đã chứa các dòng SSE vừa tới (fetch trả sau)
          if (fetched === prev || fetched.endsWith(prev)) return fetched;
          return `${fetched}\n${prev}`;
        });
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [jobId, resyncTick]);

  // Dòng log mới qua SSE
  useJobLogEvents((e) => {
    if (e.jobId !== jobId) return;
    setLog((prev) => (prev ? `${prev}\n${e.line}` : e.line));
  });

  // Auto-scroll xuống cuối
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    // min-h-0 + flex-1 để <pre> CAO BẰNG panel rồi tự cuộn bên trong. Thiếu
    // min-h-0 thì flex item không co dưới nội dung, log dài sẽ đẩy dài cả panel.
    <Panel
      className="min-h-0 flex-1"
      title={stepLabel}
      actions={
        <span className="shrink-0 text-meta text-[var(--text-muted)]">
          {job.status}
        </span>
      }
    >
      <ProgressBar progress={job.progress} step={job.step} />
      {error && <ErrorBanner message={t("tv.job-log-error")} detail={error} />}
      {/* break-anywhere BẮT BUỘC: traceback của Python có những chuỗi dài không
          một khoảng trắng (kiểu ^^^^^^^^^^), mà `pre-wrap` chỉ ngắt ở khoảng
          trắng nên chúng đẩy toác cả cột. */}
      <pre
        ref={preRef}
        className="min-h-32 min-w-0 flex-1 overflow-auto rounded-[var(--radius)] bg-[var(--surface)] p-2 font-mono text-meta whitespace-pre-wrap [overflow-wrap:anywhere]"
      >
        {log || t("tv.job-no-log")}
      </pre>
    </Panel>
  );
}

/**
 * Ô chọn màu: swatch + ô gõ giá trị. Giữ cả hai vì `<input type="color">` chỉ
 * hiểu #rrggbb - phiên nào lưu rgba()/tên màu mà chỉ có swatch là bấm nhẹ một
 * cái đã ghi đè mất giá trị cũ.
 */
function ColorField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={hex}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 shrink-0 cursor-pointer rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-50"
        />
        <input
          className="input"
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </Field>
  );
}

/**
 * ĐỘ ĐẶC (alpha) của màu nền chữ, tách thành thanh kéo riêng.
 *
 * Lỗi đã sửa: alpha vốn chỉ sửa được bằng cách GÕ TAY nguyên chuỗi
 * "rgba(10,16,32,0.52)" vào ô màu. Ô chọn màu bên cạnh là `input type="color"`,
 * mà thẻ đó chỉ hiểu #rrggbb - bấm nó một cái là alpha bị ghi đè mất, nên mọi
 * cách chỉnh bằng chuột đều KHÔNG đổi được độ mờ. Người dùng kéo/bấm kiểu gì
 * cũng thấy nền y hệt và tưởng tính năng hỏng.
 */

/** Alpha 0..1 của một màu CSS; màu không mang alpha thì coi như đặc hoàn toàn */
function alphaOf(color: string): number {
  const rgba = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(",").map((x) => Number(x.trim()));
    return parts.length >= 4 && Number.isFinite(parts[3])
      ? Math.min(1, Math.max(0, parts[3]))
      : 1;
  }
  // #rrggbbaa - hai ký tự cuối là alpha
  const hex8 = color.match(/^#([0-9a-f]{6})([0-9a-f]{2})$/i);
  if (hex8) return parseInt(hex8[2], 16) / 255;
  return 1;
}

/** Ghi alpha mới, GIỮ NGUYÊN phần màu. Luôn trả rgba() - dạng server nhận. */
function withAlpha(color: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 100) / 100;
  const rgba = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const [r, g, b] = rgba[1].split(",").map((x) => Number(x.trim()));
    return `rgba(${r || 0},${g || 0},${b || 0},${a})`;
  }
  const hex = color.match(/^#([0-9a-f]{6})/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  // Màu lạ (tên màu CSS…) - không đoán mò, trả nguyên để không phá giá trị cũ
  return color;
}

/** Thanh kéo độ đặc, kèm số phần trăm để biết mình đang ở đâu */
function OpacityField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  /** Màu ĐẦY ĐỦ (kèm alpha) - thanh kéo chỉ sửa phần alpha */
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const pct = Math.round(alphaOf(value) * 100);
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex h-9 items-center gap-2">
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          disabled={disabled}
          className="slider min-w-0"
          onChange={(e) => onChange(withAlpha(value, Number(e.target.value) / 100))}
        />
        {/* tabular-nums: số không nhảy ngang khi kéo qua 9 -> 10 -> 100 */}
        <span className="w-10 shrink-0 text-right text-meta tabular-nums text-[var(--text-muted)]">
          {pct}%
        </span>
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------- Lồng tiếng

/** Nhóm giọng trong <select> - dùng lại đúng nhãn của trang Text to video. */
const DUB_GENDERS: TtsGender[] = ["nam", "nu", "trung-tinh"];

const DUB_GENDER_LABEL_KEY: Record<TtsGender, string> = {
  nam: "ttv.voice.gender.male",
  nu: "ttv.voice.gender.female",
  "trung-tinh": "ttv.voice.gender.neutral",
};

const DUB_ENGINE_LABEL_KEY: Record<TtsEngine, string> = {
  gemini: "ttv.voice.engine.gemini",
  vieneu: "ttv.voice.engine.vieneu",
};

/** Đám mây vs con chip - nói ngay "chạy ở đâu" trước khi đọc chữ. */
const DUB_ENGINE_ICON: Record<TtsEngine, typeof Cloud> = {
  gemini: Cloud,
  vieneu: Cpu,
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Cấu hình lồng tiếng: engine đọc + MỘT GIỌNG CHO MỖI NGƯỜI NÓI + nghe thử từng
 * giọng, và tiếng gốc có chạy nhỏ bên dưới không.
 *
 * Vì sao KHÔNG dùng lại `VoicePicker`: component đó chọn ĐÚNG MỘT giọng cho cả
 * phiên và cột chặt vào `TextToVideoVoice` (kèm tốc độ đọc, "cách đọc", ngôn ngữ
 * - những thứ lồng tiếng không có). Ở đây cần N giọng trên cùng một màn hình, mỗi
 * giọng nghe thử bằng ĐÚNG CÂU của người nói ấy qua /dub-preview (đi qua đúng
 * phép co giãn của bước dựng thật) chứ không phải câu mẫu của /tts/preview. Nhét
 * VoicePicker vào đây là hoặc bày ra ba lựa chọn vô nghĩa, hoặc nghe thử nói dối.
 *
 * Danh sách giọng vẫn lấy từ CHÍNH endpoint /api/tts/voices mà VoicePicker dùng -
 * hai chỗ không được có hai kho giọng khác nhau.
 */
function DubSettingsCard({
  sessionId,
  dub,
  speakers,
  diarized,
  cueIndexOf,
  speakerF0,
  disabled,
  onChange,
}: {
  sessionId: string;
  dub: DubSettings;
  /** Nhãn người nói tìm thấy; rỗng = một giọng đọc cho cả video */
  speakers: string[];
  /** Transcript có phân vai người nói không - quyết định câu giải thích */
  diarized: boolean;
  /** Câu ĐẦU TIÊN của người nói này - nghe thử phải nghe đúng lời của họ */
  cueIndexOf: (speaker: string) => number;
  /** Cao độ đo được ở lần lồng tiếng trước (Hz) - căn cứ hệ thống gán giọng */
  speakerF0: Record<string, number>;
  disabled: boolean;
  /**
   * Chỉ gửi phần vừa đổi - cha tự merge để không nuốt thay đổi song song.
   * `immediate = false` cho thứ đổi liên tục (thanh trượt) để gom lại một lần gửi.
   */
  onChange: (patch: Partial<DubSettings>, immediate?: boolean) => void;
}) {
  const { t, tf } = useT();
  const engine = dub.engine === "vieneu" ? "vieneu" : "gemini";

  const [engines, setEngines] = useState<TtsEngineStatus[] | null>(null);
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Nghe thử: một audio dùng chung - mỗi lúc chỉ một câu được phát
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  /** false sau khi unmount - nghe thử về muộn thì không phát nữa */
  const mountedRef = useRef(true);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, DubPreviewResult>>({});
  const [previewError, setPreviewError] = useState<string | null>(null);

  /** Giọng đã tải theo engine - đổi engine qua lại là chuyện thường. */
  const voiceCache = useRef<Partial<Record<TtsEngine, TtsVoice[]>>>({});

  useEffect(() => {
    let alive = true;
    getTtsEngines()
      .then((list) => alive && setEngines(list))
      .catch((e) => {
        if (!alive) return;
        // Không hỏi được thì coi như chưa engine nào chạy được - dòng cảnh báo
        // phía dưới sẽ nói ra, đừng để người dùng bấm vào thứ chắc chắn hỏng
        setEngines([]);
        setLoadError(errText(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const hit = voiceCache.current[engine];
    if (hit) {
      setVoices(hit);
      return;
    }
    setVoices(null);
    getTtsVoices(engine)
      .then((list) => {
        if (!alive) return;
        voiceCache.current[engine] = list;
        setVoices(list);
        setLoadError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setVoices([]);
        setLoadError(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [engine]);

  // Rời trang giữa lúc đang nghe → tắt tiếng, không để audio chạy mồ côi
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      audioRef.current?.pause();
      audioRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  function stop() {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setPlaying(null);
  }

  async function preview(speaker: string) {
    if (disabled) return;
    if (playing === speaker) {
      stop();
      return;
    }
    stop();
    if (loadingKey) return; // đang chờ một bản nghe thử khác
    setLoadingKey(speaker);
    setPreviewError(null);
    try {
      const index = cueIndexOf(speaker);
      const voice = (dub.voices[speaker] ?? "").trim();
      const res = await dubPreviewTranslateVideo(sessionId, {
        index: index >= 0 ? index : 0,
        // Chưa chốt giọng thì ĐỪNG gửi: server tự gán rồi trả về giọng nó chọn
        // trong header, và đó chính là giọng bản dựng thật sẽ dùng
        ...(voice ? { voice } : {}),
      });
      // Đọc thử mất vài giây: rời trang/đóng khung trong lúc chờ thì không phát
      // nữa - dọn dẹp lúc unmount đã chạy, tiếng phát lúc này không tắt được
      if (!mountedRef.current) return;
      setResults((prev) => ({ ...prev, [speaker]: res }));
      const url = URL.createObjectURL(res.audio);
      const audio = new Audio(url);
      audio.onended = () => stop();
      audio.onerror = () => {
        stop();
        setPreviewError(t("tv.dub.preview-failed"));
      };
      audioRef.current = audio;
      urlRef.current = url;
      setPlaying(speaker);
      await audio.play().catch(() => stop());
    } catch (e) {
      setPreviewError(errText(e));
    } finally {
      setLoadingKey(null);
    }
  }

  const list = voices ?? [];
  const rows = speakers.length > 0 ? speakers : [DUB_ALL_SPEAKERS];
  const noEngine = engines !== null && !engines.some((s) => s.available);

  return (
    <div className="flex flex-col gap-4">
      {loadError && (
        <ErrorBanner message={t("tv.dub.voices-error")} detail={loadError} />
      )}

      {/* 1. Engine đọc - quyết định kho giọng phía dưới nên đứng trên cùng.
          Lưới thẻ engine dùng auto-fit chứ KHÔNG `sm:grid-cols-2`: `sm:` đo bề
          rộng CỬA SỔ, còn nhóm thẻ này nằm trong cột workspace rộng ~340-390px
          nên ở mọi màn desktop nó đều bị chia đôi trong cột hẹp và chữ vỡ. Bề
          rộng thật do container query của workspace quyết định - lưới phải co
          theo chỗ thật. */}
      <Field label={t("tv.dub.engine")}>
        {engines === null ? (
          <p className="flex items-center gap-2 py-2 text-meta text-[var(--text-muted)]">
            <Loader2 size={13} strokeWidth={2} className="animate-spin" />
            {t("ttv.voice.engine.checking")}
          </p>
        ) : (
          <OptionCardGroup
            label={t("tv.dub.engine")}
            className="grid-cols-[repeat(auto-fit,minmax(180px,1fr))]"
          >
            {TTS_ENGINES.map((e) => {
              const st = engines.find((s) => s.engine === e) ?? null;
              const ok = st?.available === true;
              return (
                <OptionCard
                  key={e}
                  icon={DUB_ENGINE_ICON[e]}
                  selected={engine === e}
                  // Engine máy chưa chạy được thì KHÓA: /render kiểm lại và trả
                  // 503 ngay, cho bấm chỉ để nhận lỗi là bẫy người dùng
                  disabled={disabled || !ok}
                  onSelect={() => onChange({ engine: e, voices: {} })}
                  title={t(DUB_ENGINE_LABEL_KEY[e])}
                  description={t(`ttv.voice.engine.${e}-desc`)}
                  badge={
                    <Badge
                      dot={false}
                      tone={ok ? "success" : "danger"}
                      label={
                        ok
                          ? t("ttv.voice.engine.ready")
                          : t("ttv.voice.engine.unavailable")
                      }
                    />
                  }
                />
              );
            })}
          </OptionCardGroup>
        )}
      </Field>

      {/* Chi tiết kỹ thuật của server (đường dẫn Python, thiếu key) - KHÔNG
          dịch, hiện nguyên văn để còn sửa được. Nằm NGOÀI thẻ chọn: nhét một
          đường dẫn dài vào trong nút là nút cao gấp đôi và chữ nhỏ tới mức
          không đọc nổi - mà đây đúng là dòng cần đọc để sửa được lỗi. */}
      {(engines ?? [])
        .filter((st) => !st.available && st.detail)
        .map((st) => (
          <Banner
            key={st.engine}
            tone="danger"
            message={`${t(DUB_ENGINE_LABEL_KEY[st.engine])} · ${t(
              "ttv.voice.engine.unavailable"
            )}`}
            detail={st.detail}
          />
        ))}

      {noEngine && (
        <Banner tone="danger" message={t("ttv.voice.engine.none")} />
      )}

      {/* 2. Giọng cho từng người nói. Transcript không phân vai thì nói THẲNG
          ra là chỉ có một giọng cho cả video, đừng để người dùng tự đoán vì sao
          chỉ thấy một dòng */}
      <Panel
        title={
          <span className="inline-flex items-center gap-1">
            {t("tv.dub.voices")}
            <InfoHint
              titleKey="help.tv-dub-voices.title"
              bodyKey="help.tv-dub-voices.body"
            />
          </span>
        }
      >
        {!diarized && (
          <p className="text-meta text-[var(--text-muted)]">
            {t("tv.dub.not-diarized")}
          </p>
        )}

        {previewError && (
          <ErrorBanner message={t("tv.dub.preview-failed")} detail={previewError} />
        )}

        {/* <li> KHÔNG có viền riêng: cha đã là Panel, thêm một khung nữa là ba
            lớp viền lồng nhau. Các hàng tách nhau bằng một đường kẻ mảnh. */}
        <ul className="flex flex-col">
          {rows.map((speaker) => {
            const chosen = dub.voices[speaker] ?? "";
            const missing =
              chosen !== "" && list.length > 0 && !list.some((v) => v.name === chosen);
            const res = results[speaker];
            const isLoading = loadingKey === speaker;
            const isPlaying = playing === speaker;
            const f0 = speakerF0[speaker] ?? 0;
            return (
              <li
                key={speaker || "__all__"}
                className="flex flex-col gap-2 border-t border-[var(--border)] pt-3 first:border-t-0 first:pt-0"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">
                    {speaker
                      ? tf("tv.dub.speaker", { name: speaker })
                      : t("tv.dub.all-speakers")}
                  </span>
                  {f0 > 0 && (
                    <span className="chip" title={t("tv.dub.f0-title")}>
                      {tf("tv.dub.f0", { f0: Math.round(f0) })}
                    </span>
                  )}
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <select
                    className="input"
                    value={chosen}
                    disabled={disabled}
                    aria-label={
                      speaker
                        ? tf("tv.dub.voice-aria", { name: speaker })
                        : t("tv.dub.all-speakers")
                    }
                    onChange={(ev) =>
                      onChange({
                        voices: { ...dub.voices, [speaker]: ev.target.value },
                      })
                    }
                  >
                    {/* "" = để hệ thống tự gán theo cao độ giọng gốc - đó là
                        mặc định TỐT, không phải một ô trống chưa điền */}
                    <option value="">{t("tv.dub.voice-auto")}</option>
                    {/* Giọng đã lưu mà kho hiện tại không có (đổi engine, gỡ
                        giọng nhân bản) vẫn hiện - đừng âm thầm đổi lựa chọn */}
                    {missing && <option value={chosen}>{chosen}</option>}
                    {DUB_GENDERS.map((g) => {
                      const items = list
                        .filter((v) => v.gender === g)
                        .sort((a, b) => a.title.localeCompare(b.title));
                      if (items.length === 0) return null;
                      return (
                        <optgroup key={g} label={t(DUB_GENDER_LABEL_KEY[g])}>
                          {items.map((v) => (
                            <option key={v.name} value={v.name}>
                              {v.title}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                  <Button
                    variant="secondary"
                    small
                    disabled={disabled || (loadingKey !== null && !isLoading)}
                    onClick={() => preview(speaker)}
                  >
                    {isLoading ? (
                      <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                    ) : isPlaying ? (
                      <Square size={14} strokeWidth={2} />
                    ) : (
                      <Play size={14} strokeWidth={2} />
                    )}
                    {isPlaying ? t("tv.dub.stop") : t("tv.dub.preview")}
                  </Button>
                </div>

                {/* Số đo của ĐÚNG câu vừa nghe: co bao nhiêu, có tràn không.
                    Đây là thứ cho biết bản dịch dài quá TRƯỚC KHI render cả bài */}
                {res && (
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-meta text-[var(--text-muted)]">
                    <span className="chip">
                      {tf("tv.dub.tempo", { tempo: res.tempo.toFixed(2) })}
                    </span>
                    <span className="chip">
                      {tf("tv.dub.fit", {
                        final: res.finalSec.toFixed(2),
                        source: res.sourceSec.toFixed(2),
                      })}
                    </span>
                    {res.voice && <span className="chip">{res.voice}</span>}
                    {res.clipped && (
                      <span className="flex items-center gap-1 text-[var(--danger)]">
                        <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
                        {t("tv.dub.clipped")}
                      </span>
                    )}
                    {res.overflowed && (
                      <span className="flex items-center gap-1 text-[var(--danger)]">
                        <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
                        {t("tv.dub.overflowed")}
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-meta text-[var(--text-muted)]">
          {t("tv.dub.preview-hint")}
        </p>
      </Panel>

      {/* 3. Tiếng gốc chạy nhỏ bên dưới - mặc định TẮT: lồng tiếng là để THAY
          tiếng gốc, bật sẵn thì video nào cũng nghe lùng bùng hai lớp tiếng */}
      <div className="flex flex-col gap-3">
        <CheckboxField
          id="tv-dub-keep-original"
          label={t("tv.dub.keep-original")}
          checked={dub.keepOriginal}
          disabled={disabled}
          onChange={(next) => onChange({ keepOriginal: next })}
        />
        {dub.keepOriginal && (
          <Field
            label={tf("tv.dub.original-volume", {
              percent: Math.round(dub.originalVolume * 100),
            })}
            htmlFor="tv-dub-original-volume"
            hint={t("tv.dub.original-volume-hint")}
          >
            <input
              id="tv-dub-original-volume"
              type="range"
              className="slider"
              min={0}
              max={DUB_ORIGINAL_VOLUME_MAX}
              step={0.01}
              value={dub.originalVolume}
              disabled={disabled}
              onChange={(e) =>
                onChange({ originalVolume: Number(e.target.value) }, false)
              }
            />
          </Field>
        )}
      </div>
    </div>
  );
}

/** Số liệu chất lượng của lần lồng tiếng gần nhất - xem `DubInfo` ở api.ts. */
function DubReport({ info }: { info: DubInfo }) {
  const { t, tf } = useT();
  return (
    <Panel title={t("tv.dub.report")}>
      <div className="flex flex-wrap items-center gap-2 text-meta text-[var(--text-muted)]">
        <span className="chip">{tf("tv.cue-count", { n: info.cues })}</span>
        <span className="chip">{tf("tv.dub.stretched", { n: info.stretched })}</span>
        <span className="chip">
          {tf("tv.dub.tempo-range", {
            min: info.minTempo.toFixed(2),
            max: info.maxTempo.toFixed(2),
          })}
        </span>
        <span className={info.clipped > 0 ? "chip text-[var(--danger)]" : "chip"}>
          {tf("tv.dub.clipped-count", { n: info.clipped })}
        </span>
        <span className={info.overflowed > 0 ? "chip text-[var(--danger)]" : "chip"}>
          {tf("tv.dub.overflowed-count", { n: info.overflowed })}
        </span>
      </div>
      {/* Câu tràn là lỗi NỘI DUNG (bản dịch dài quá), không phải lỗi máy - nói rõ
          cách sửa chứ đừng chỉ ném ra một con số */}
      <p className="text-meta text-[var(--text-muted)]">
        {info.overflowed > 0 ? t("tv.dub.report-overflow") : t("tv.dub.report-ok")}
      </p>
    </Panel>
  );
}

/**
 * Dòng tóm tắt của một cụm cấu hình đang bật + nút mở lại modal.
 *
 * Đây là ĐƯỜNG QUAY LẠI sau khi đóng modal, và cũng là chỗ duy nhất trong cột
 * nói ra "đang đặt gì" - nên nó phải hiện giá trị thật (ngôn ngữ, giọng, font)
 * chứ không chỉ là một cái nút. Cố ý KHÔNG dựng lại biểu mẫu ở đây: dựng hai
 * lần thì hai bản sẽ lệch nhau.
 */
function ConfigSummary({
  icon: Icon,
  label,
  value,
  onEdit,
}: {
  icon: typeof Type;
  label: string;
  value: string;
  onEdit: () => void;
}) {
  const { t } = useT();
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Icon size={14} strokeWidth={2} aria-hidden="true" />
          {label}
        </span>
      }
      actions={
        <Button variant="secondary" small onClick={onEdit}>
          {t("tv.configure")}
        </Button>
      }
    >
      <p className="min-w-0 text-meta text-[var(--text-muted)]">{value}</p>
    </Panel>
  );
}

export default function TranslateVideoDetailPage() {
  const { t, tf } = useT();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  // SSE đứt rồi nối lại → refetch dữ liệu seed để status không kẹt "đang chạy"
  const { resyncTick } = useEvents();

  const [session, setSession] = useState<TranslateVideoMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Bước đang chạy đồng bộ (chờ response) - khóa nút để không bấm hai lần. */
  const [busy, setBusy] = useState<"transcribe" | "translate" | "render" | null>(
    null
  );

  // Bản nháp phía client: gõ là thấy ngay, PATCH đi sau (debounce). Chỉ đồng bộ
  // lại từ server khi KHÔNG còn thay đổi chờ gửi - để không nuốt chữ vừa gõ.
  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("vi");
  const [mode, setMode] = useState<TranslateMode>("subtitle");
  /** null = đọc đúng ngôn ngữ phụ đề (xem dubLang bên server) */
  const [dubLang, setDubLang] = useState<string | null>(null);
  const [sttProvider, setSttProvider] = useState<SttProvider>("local");
  const [cues, setCues] = useState<TranslatedCue[]>([]);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle | null>(null);
  const [dub, setDub] = useState<DubSettings | null>(null);

  /**
   * Model dịch. CHỈ sống trong phiên làm việc này: hợp đồng
   * POST /:id/translate nhận `model` cho từng lần gọi, còn meta.json KHÔNG có
   * chỗ lưu - nên chọn xong tải lại trang là về mặc định. Ghi ra đây để không ai
   * tưởng là quên lưu.
   */
  const [translateModel, setTranslateModel] = useState(DEFAULT_TRANSLATE_MODEL);

  /** AI bóc lời nào chạy được trên máy này - hỏi server, không đoán. */
  const [sttProviders, setSttProviders] = useState<SttCapability[] | null>(null);

  const pending = useRef<Patch>({});
  /** PATCH đang bay - flush sau phải chờ nó, kẻo bước kế tiếp chạy trước khi lưu xong */
  const inflight = useRef<Promise<string | null> | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Upload video nguồn
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Job mới nhất của phiên - nguồn hiển thị % và tên bước.
  // `jobPhase` cho biết log này thuộc khối nào: bóc lời hay đóng phụ đề. Hai
  // bước dùng CHUNG type job "translate-video" nên không suy ra được từ job.
  const [job, setJob] = useState<Job | null>(null);
  const [jobPhase, setJobPhase] = useState<"transcribe" | "render" | null>(null);
  const currentJobId = useRef<string | null>(null);

  // Gấp/mở từng khối. Mặc định suy từ "phiên đã xong chưa" NGAY TRONG LÚC RENDER,
  // cố tình KHÔNG có useEffect nào đồng bộ trạng thái gấp theo status: trang này
  // bám SSE job, mỗi dòng log hay mỗi lần job đổi tiến trình là một lần render
  // mới. Effect kiểu đó sẽ đóng sập đúng cái khối người dùng vừa mở ra, mà lỗi
  // ấy trông như trang tự nhiên "nhảy" chứ không ai đoán ra là do SSE.
  //
  // Gọi trước mọi lối thoát sớm (loading/lỗi) - thứ tự hook phải giống nhau ở
  // mọi lần render.
  const group = useCollapseGroup({
    keys: TV_BLOCKS,
    finished: session?.status === "done",
    keepExpanded: TV_KEEP_EXPANDED,
  });

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Hai cụm cấu hình nặng sống trong modal - xem `chooseMode`. `chainToDub` là
  // hàng đợi một bậc cho chế độ "cả hai": đóng modal phụ đề thì mở tiếp modal
  // lồng tiếng. Mở chồng hai modal cùng lúc thì cái sau che mất cái trước.
  const [subtitleModalOpen, setSubtitleModalOpen] = useState(false);
  const [dubModalOpen, setDubModalOpen] = useState(false);
  const [chainToDub, setChainToDub] = useState(false);

  /** Đổ dữ liệu server vào các bản nháp chưa bị sửa dở. */
  const adopt = useCallback((s: TranslateVideoMeta) => {
    setSession(s);
    const p = pending.current;
    if (!p.sourceLang) setSourceLang(s.sourceLang || "auto");
    if (!p.targetLang) setTargetLang(s.targetLang || "vi");
    if (!p.mode) setMode(s.mode ?? "subtitle");
    if (!p.dubLang) setDubLang(s.dubLang ?? null);
    if (!p.sttProvider) setSttProvider(s.sttProvider ?? "local");
    if (!p.cues) setCues(s.cues ?? []);
    // Phiên tạo trước khi backend có đủ field → lấp bằng mặc định
    if (!p.subtitleStyle) {
      setSubtitleStyle({
        ...TRANSLATE_DEFAULT_SUBTITLE_STYLE,
        ...(s.subtitleStyle ?? {}),
      });
    }
    if (!p.dub) {
      setDub({ ...TRANSLATE_DEFAULT_DUB, ...(s.dub ?? {}) });
    }
  }, []);

  const load = useCallback(async () => {
    try {
      adopt(await getTranslateVideo(sessionId));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId, adopt]);

  useEffect(() => {
    load();
  }, [load, resyncTick]);

  // Danh sách AI bóc lời - tĩnh theo cấu hình máy, hỏi một lần là đủ. Hỏng thì
  // để null: ô chọn vẫn hiện lựa chọn đang lưu, chỉ không khóa được cái thiếu key.
  useEffect(() => {
    let alive = true;
    getSttProviders()
      .then((list) => alive && setSttProviders(list))
      .catch(() => alive && setSttProviders(null));
    return () => {
      alive = false;
    };
  }, []);

  // Seed job đang chạy (mở trang giữa chừng vẫn thấy tiến trình).
  // resyncTick: refetch sau khi SSE nối lại để bắt kịp job đã đổi trạng thái.
  useEffect(() => {
    let alive = true;
    getJobs(50)
      .then((list) => {
        const mine = list.filter((j) => isTranslateVideoJob(j, sessionId));
        if (!alive || mine.length === 0) return;
        // Job seed KHÔNG đặt jobPhase: bước nào tạo ra nó thì lúc đó mới biết
        // chắc. Mở trang giữa chừng thì `phase` phía dưới suy từ trạng thái phiên.
        setJob(mine[0]);
        currentJobId.current = mine[0].id;
      })
      .catch(() => {
        // không lấy được jobs cũng không chặn trang - SSE vẫn cập nhật tiếp
      });
    return () => {
      alive = false;
    };
  }, [sessionId, resyncTick]);

  useJobEvents((j) => {
    // Hợp đồng /transcribe và /render chỉ trả jobId nên nhận cả theo id vừa tạo
    if (!isTranslateVideoJob(j, sessionId) && j.id !== currentJobId.current) return;
    setJob(j);
    if (["done", "failed", "canceled"].includes(j.status)) load();
  });

  // ---- Lưu thay đổi: gộp lại rồi PATCH một lần ----

  /**
   * Gửi thay đổi đang chờ. Trả về thông báo lỗi (null = đã lưu / không có gì).
   * Lưu hỏng thì TRẢ patch về hàng chờ (thay đổi gõ sau thắng) và người gọi
   * phải dừng - dịch/render tiếp là làm trên bản cũ ở server.
   */
  const flush = useCallback(async (): Promise<string | null> => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (inflight.current) {
      const prevErr = await inflight.current;
      if (Object.keys(pending.current).length === 0) return prevErr;
    }
    if (Object.keys(pending.current).length === 0) return null;
    const patch = pending.current;
    pending.current = {};
    const run = (async (): Promise<string | null> => {
      try {
        const s = await updateTranslateVideo(sessionId, patch);
        setSession(s);
        setSaveError(null);
        return null;
      } catch (e) {
        pending.current = { ...patch, ...pending.current };
        const msg = e instanceof Error ? e.message : String(e);
        setSaveError(msg);
        return msg;
      }
    })();
    inflight.current = run;
    try {
      return await run;
    } finally {
      if (inflight.current === run) inflight.current = null;
    }
  }, [sessionId]);

  // Rời trang khi còn thay đổi chưa gửi → gửi nốt
  useEffect(() => {
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      if (Object.keys(pending.current).length > 0) {
        const patch = pending.current;
        pending.current = {};
        updateTranslateVideo(sessionId, patch).catch(() => {
          // trang đã đóng - không còn chỗ hiện lỗi
        });
      }
    };
  }, [sessionId]);

  const queue = useCallback(
    (patch: Patch, immediate = false) => {
      pending.current = { ...pending.current, ...patch };
      if (flushTimer.current) clearTimeout(flushTimer.current);
      if (immediate) {
        flush();
      } else {
        flushTimer.current = setTimeout(flush, PATCH_DEBOUNCE_MS);
      }
    },
    [flush]
  );

  // Các hàm patch dùng THẲNG giá trị của lần render này chứ không dùng updater
  // dạng hàm: updater có thể bị React gọi lại (StrictMode) và queue() là side
  // effect - gọi hai lần sẽ đặt hai lịch gửi cho cùng một thay đổi.
  function patchSourceLang(v: string) {
    setSourceLang(v);
    queue({ sourceLang: v }, true);
  }

  function patchTargetLang(v: string) {
    setTargetLang(v);
    queue({ targetLang: v }, true);
  }

  function patchMode(v: TranslateMode) {
    setMode(v);
    queue({ mode: v }, true);
  }

  function patchDubLang(v: string | null) {
    setDubLang(v);
    queue({ dubLang: v }, true);
  }

  /**
   * Chọn chế độ VÀ mở luôn modal cấu hình của chế độ đó. Chọn "cả hai" thì mở
   * modal phụ đề trước (chữ trên hình là thứ nhìn thấy trước), đóng nó xong mới
   * tới modal lồng tiếng - NỐI TIẾP, không mở chồng.
   *
   * Vì sao là modal chứ không phải khối trong cột: cấu hình lồng tiếng gồm cả
   * bảng gán giọng cho từng người nói, để trong cột thì chọn xong chế độ ở trên
   * phải cuộn rất xa xuống mới tới chỗ chỉnh.
   *
   * Bấm LẠI đúng chế độ đang chọn cũng mở modal - người dùng hay bấm lại để
   * chỉnh, và `Segmented` gọi onChange ở mọi cú bấm nên chỗ này chỉ cần không
   * tự chặn.
   */
  function chooseMode(v: TranslateMode) {
    patchMode(v);
    setChainToDub(v === "both");
    if (v === "dub") {
      setSubtitleModalOpen(false);
      setDubModalOpen(true);
    } else {
      setDubModalOpen(false);
      setSubtitleModalOpen(true);
    }
  }

  /** Đóng modal phụ đề; chế độ "cả hai" thì mở tiếp modal lồng tiếng. */
  function closeSubtitleModal() {
    setSubtitleModalOpen(false);
    if (chainToDub) {
      setChainToDub(false);
      setDubModalOpen(true);
    }
  }

  function patchSttProvider(v: SttProvider) {
    setSttProvider(v);
    queue({ sttProvider: v }, true);
  }

  /**
   * Sửa cấu hình lồng tiếng - gửi TRỌN khối để server khỏi phải merge.
   * `immediate = false` cho thanh trượt âm lượng: kéo một cái là hàng chục sự
   * kiện, gửi ngay từng cái là hàng chục PATCH đua nhau trên cùng một file.
   */
  function patchDub(p: Partial<DubSettings>, immediate = true) {
    if (!dub) return;
    const next = { ...dub, ...p };
    setDub(next);
    queue({ dub: next }, immediate);
  }

  function patchStyle(p: Partial<SubtitleStyle>, immediate = false) {
    if (!subtitleStyle) return;
    const next = { ...subtitleStyle, ...p };
    setSubtitleStyle(next);
    queue({ subtitleStyle: next }, immediate);
  }

  /** Sửa lời dịch một câu - gõ thì debounce, không bắn request mỗi ký tự. */
  function patchCueText(index: number, text: string) {
    const next = cues.map((c, i) => (i === index ? { ...c, text } : c));
    setCues(next);
    queue({ cues: next });
  }

  /**
   * Sửa câu ĐỌC LÊN (bản dịch sang ngôn ngữ lồng tiếng) - chỉ có nghĩa khi hai
   * bên khác ngôn ngữ. Tách riêng khỏi `patchCueText` vì đây là hai bản dịch
   * khác nhau của cùng một câu, sửa cái này không được đụng cái kia.
   */
  function patchCueDubText(index: number, dubText: string) {
    const next = cues.map((c, i) => (i === index ? { ...c, dubText } : c));
    setCues(next);
    queue({ cues: next });
  }

  // ---- Chạy bước ----

  async function upload(files: FileList | null) {
    if (!files || files.length === 0 || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      adopt(await uploadTranslateVideoSource(sessionId, files[0]));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function run(step: "transcribe" | "translate" | "render") {
    if (busy) return;
    setBusy(step);
    setActionError(null);
    try {
      // Gửi nốt sửa đổi đang chờ trước - server phải làm việc trên bản mới nhất
      const saveErr = await flush();
      if (saveErr) {
        setActionError(saveErr);
        return;
      }
      if (step === "translate") {
        adopt(await translateTranslateVideo(sessionId, { model: translateModel }));
      } else {
        const { jobId } =
          step === "transcribe"
            ? // Gửi kèm provider của lần chạy NÀY: PATCH vừa bay đi có thể chưa
              // tới đĩa, mà server đọc meta để biết dùng AI nào
              await transcribeTranslateVideo(sessionId, { sttProvider })
            : await renderTranslateVideo(sessionId);
        currentJobId.current = jobId;
        setJobPhase(step === "transcribe" ? "transcribe" : "render");
        await load();
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      // Lỗi có thể do server đã đổi trạng thái phiên - đọc lại cho khớp
      load();
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTranslateVideo(sessionId);
      router.push("/translate-video");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  function langLabel(code: string): string {
    const key = `tv.lang.${code}`;
    const label = t(key);
    // Mã lạ (server đổi danh sách trước web) → hiện luôn mã, đừng hiện key thô
    return label === key ? code : label;
  }

  /**
   * Tên AI bóc lời. Provider server có mà web chưa dịch (server mới hơn web)
   * thì lấy nhãn tiếng Việt của server - thà hiện tiếng Việt còn hơn phun ra
   * chuỗi "tv.stt.foo".
   */
  function sttName(id: string): string {
    const key = `tv.stt.${id}`;
    const label = t(key);
    if (label !== key) return label;
    return (sttProviders ?? []).find((p) => p.id === id)?.label ?? id;
  }

  /** Nhãn model dịch - id lạ (server đổi trước web) hiện thẳng id. */
  /**
   * Nhãn model = TÊN THẬT + mô tả ngắn, vd "gemini-2.5-flash - Flash (khuyên
   * dùng, nhanh + rẻ)".
   *
   * Vì sao phải có tên thật: "Flash (khuyên dùng)" không nói được đây là bản
   * 2.5 hay 3.0, mà đó chính là thứ người ta cần biết để chọn. Các ô chọn model
   * khác trong hệ thống (ModelPicker) đều hiện tên model, ô này phải giống.
   */
  function modelLabel(id: string): string {
    const hit = TRANSLATE_MODELS.find((m) => m.id === id);
    if (!hit) return id;
    const label = t(hit.labelKey);
    return label === hit.labelKey ? hit.id : `${hit.id} - ${label}`;
  }

  if (!session || !subtitleStyle || !dub) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t("nav.translate-video")} />
        {loadError ? (
          <ErrorBanner message={t("tv.not-found")} detail={loadError} />
        ) : (
          <p className="py-8 text-center text-sm text-[var(--text-muted)]">
            {t("common.loading")}
          </p>
        )}
      </div>
    );
  }

  const running = RUNNING_STATUS.includes(session.status);
  // Ô nhập chỉ khóa khi có việc đang chạy - xong rồi vẫn sửa & chạy lại được
  const locked = running;
  const stage = deriveTvStage(session);
  const src = session.source;
  const hasSource = src.relPath !== null;
  const translatedCount = cues.filter((c) => c.text.trim() !== "").length;
  const canTranscribe = hasSource && !running;
  const canTranslate = cues.length > 0 && !running;
  const canRender = translatedCount > 0 && !running;
  const statusLabel = TRANSLATE_VIDEO_STATUS_LABEL[session.status]
    ? t(TRANSLATE_VIDEO_STATUS_LABEL[session.status])
    : String(session.status);
  const sourceUrl = src.relPath
    ? `${mediaUrl(src.relPath)}?v=${encodeURIComponent(session.updatedAt)}`
    : null;
  const outputUrl = session.outputFile
    ? `${mediaUrl(session.outputFile)}?v=${encodeURIComponent(session.updatedAt)}`
    : null;

  // "Chế độ này có đốt chữ / có đọc tiếng không" - gương của wantsSubtitle và
  // wantsDub bên server (translateVideoMeta.ts). `isDub` giữ nguyên nghĩa cũ
  // "có lồng tiếng" để mọi chỗ đang dùng nó vẫn đúng với cả mode "both".
  const wantsSubtitleMode = mode === "subtitle" || mode === "both";
  const wantsDubMode = mode === "dub" || mode === "both";
  const isDub = wantsDubMode;
  /** Ngôn ngữ THỰC SỰ đọc lên - null nghĩa là giống phụ đề, không phải "chưa có" */
  const effectiveDubLang = dubLang ?? targetLang;
  /** Chữ trên hình và tiếng đọc lên đang là HAI ngôn ngữ khác nhau */
  const twoLangs = wantsDubMode && effectiveDubLang !== targetLang;
  /**
   * Đã chọn hai ngôn ngữ nhưng CHƯA dịch bản để đọc. Server chặn render trong
   * trường hợp này (400 NO_DUB_TRANSLATION), nên UI phải nói trước - chứ không
   * để người dùng bấm render rồi mới nhận lỗi.
   */
  const dubTranslationMissing =
    twoLangs && cues.length > 0 && !cues.some((c) => c.dubText);
  const sttCap = (sttProviders ?? []).find((p) => p.id === sttProvider) ?? null;

  /**
   * Người nói để gán giọng. Lấy nhãn từ transcript NHƯNG chỉ giữ nhãn nào thật
   * sự có câu trong bản dịch - đúng luật của /dub-preview phía server. Gán giọng
   * cho một nhãn không câu nào mang là bày ra một ô chọn không đổi được gì.
   */
  const speakers = (
    session.transcriptInfo?.diarized ? session.transcriptInfo.speakers : []
  ).filter((s) => cues.some((c) => (c.speaker ?? "") === s));

  /** Câu ĐẦU TIÊN của một người nói - nghe thử phải nghe đúng lời của họ. */
  const cueIndexOf = (speaker: string): number =>
    speaker ? cues.findIndex((c) => (c.speaker ?? "") === speaker) : 0;

  // Log của bước nào thì hiện ở khối ấy. Chưa biết (mở trang giữa chừng) thì suy
  // từ trạng thái phiên - đó là thông tin đáng tin nhất đang có.
  const phase =
    jobPhase ??
    (session.status === "rendering" || session.status === "done"
      ? "render"
      : "transcribe");

  // ---- Khối video thành phẩm ----

  const done = session.status === "done";

  /** Job của bước ĐÓNG PHỤ ĐỀ - nguồn % và tên bước cho khối video thành phẩm. */
  const renderJob = job && phase === "render" ? job : null;

  // Hỏng ở bước bóc lời thoại KHÔNG phải là "dựng video thất bại": khối kết quả
  // giữ nguyên trạng thái "chưa có video", còn lỗi đã có banner riêng phía trên.
  const renderFailed = session.status === "failed" && phase === "render";

  const outputStatus: WorkspaceStatus =
    session.status === "rendering"
      ? "running"
      : renderFailed
        ? "failed"
        : session.outputFile
          ? "done"
          : "idle";

  // Tỉ lệ khung hình lấy từ chính video nguồn (phụ đề đóng lên video gốc nên hai
  // bên luôn cùng khung hình); chưa có nguồn thì tạm dùng ngang 16/9.
  const aspect =
    src.width && src.height ? `${src.width} / ${src.height}` : "16 / 9";

  // ---- Một dòng tóm tắt cho từng khối lúc gấp ----

  const sourceSummary = hasSource
    ? [
        src.relPath?.split(/[\\/]/).pop(),
        src.width && src.height ? `${src.width}x${src.height}` : null,
        src.durationSec ? clock(src.durationSec) : null,
        src.fps ? `${src.fps}fps` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : t("tv.no-source-yet");
  const transcriptSummary = [
    sttName(session.transcriptInfo?.provider ?? sttProvider),
    cues.length > 0 ? tf("tv.cue-count", { n: cues.length }) : t("tv.no-transcript"),
    session.transcriptInfo?.diarized
      ? tf("tv.transcript-speakers", { n: session.transcriptInfo.speakers.length })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Model đi kèm ngay trong dòng tóm tắt: gấp khối lại vẫn phải biết bản dịch
  // này do AI nào làm - đó là câu hỏi đầu tiên khi thấy một câu dịch lạ.
  const translationSummary = `${langLabel(sourceLang)} → ${langLabel(targetLang)} · ${
    translatedCount > 0
      ? tf("tv.translated-count", { n: translatedCount })
      : t("tv.no-translation")
  } · ${TRANSLATE_PROVIDER} ${translateModel}`;
  const subtitleSummary = `${t(`tv.font.${subtitleStyle.fontFamily}`)} · ${
    subtitleStyle.fontSizePx
  }px · ${t(`tv.backdrop.${subtitleStyle.backdrop}`)}`;
  const resultSummary = session.outputFile ?? statusLabel;
  const dubSummary = [
    t(DUB_ENGINE_LABEL_KEY[dub.engine === "vieneu" ? "vieneu" : "gemini"]),
    speakers.length > 0
      ? tf("tv.dub.speaker-count", { n: speakers.length })
      : t("tv.dub.all-speakers"),
    dub.keepOriginal ? t("tv.dub.keep-original-short") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={session.name}
        subtitle={
          src.width && src.height
            ? `${src.width}x${src.height}${src.fps ? ` · ${src.fps}fps` : ""}`
            : undefined
        }
        center={
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <StepperBar
                steps={STAGE_LABELS}
                stage={stage.stage}
                active={stage.active}
                done={stage.complete}
                ariaLabel={tf("tv.stage-aria", {
                  stage: stage.stage,
                  label: t(STAGE_LABELS[stage.stage - 1]),
                })}
              />
            </div>
            <InfoHint titleKey="help.tv.title" bodyKey="help.tv.body" className="mt-px" />
          </div>
        }
        actions={
          /* Nút xóa đứng CUỐI, ngoài cụm nút thường, ngăn bằng vạch dọc - quy
             ước chung của 7 trang chi tiết, lý do viết đầy đủ ở
             `src/app/images/[id]/page.tsx`. */
          <>
            <span className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => router.push("/translate-video")}>
                <ArrowLeft size={15} strokeWidth={2} />
                {t("tv.back")}
              </Button>
            </span>
            <span className="flex items-center border-l border-[var(--border)] pl-2">
              <Button
                variant="destructive"
                disabled={running}
                onClick={() => {
                  setDeleteError(null);
                  setDeleteOpen(true);
                }}
              >
                <Trash2 size={15} strokeWidth={2} />
                {t("common.delete")}
              </Button>
            </span>
          </>
        }
      />

      {/* Tóm tắt phiên - nhìn một dòng biết phiên này đang ra sao */}
      <Card>
        <div className="flex flex-wrap items-center gap-2 text-meta text-[var(--text-muted)]">
          <Badge
            tone={TRANSLATE_VIDEO_STATUS_TONE[session.status] ?? "muted"}
            label={statusLabel}
          />
          <span className="chip">
            {langLabel(sourceLang)} → {langLabel(targetLang)}
          </span>
          <span className="chip">
            {TRANSLATE_MODE_LABEL[mode] ? t(TRANSLATE_MODE_LABEL[mode]) : mode}
          </span>
          {src.durationSec ? (
            <span className="chip">{clock(src.durationSec)}</span>
          ) : null}
          {cues.length > 0 && (
            <span className="chip">{tf("tv.cue-count", { n: cues.length })}</span>
          )}
          {done && group.anyCollapsed && (
            <span className="min-w-0">{t("tv.section.done-collapsed")}</span>
          )}
          <span className="ml-auto">
            {t("common.updated")}: {formatDateTime(session.updatedAt)}
          </span>
        </div>
      </Card>

      {loadError && <ErrorBanner message={t("tv.load-error")} detail={loadError} />}
      {actionError && <ErrorBanner message={t("tv.action-error")} detail={actionError} />}
      {saveError && <ErrorBanner message={t("tv.save-error")} detail={saveError} />}
      {session.status === "failed" && (
        <ErrorBanner message={t("tv.failed")} detail={session.error ?? undefined} />
      )}

      {/* Ba cột theo nhịp làm việc: nguồn → yêu cầu & thiết lập → tiến trình &
          kết quả. Số cột do container query trong globals.css lo, trang không tự
          tính pixel. */}
      <Workspace>
        {/* ================= Cột 1: nguồn ================= */}
        <WorkspaceColumn role="source" title={t("workspace.col.source")}>
          <WorkspaceBlock
            id="tv-block-source"
            icon={FileVideo}
            collapsed={group.isCollapsed("source")}
            onToggle={() => group.toggle("source")}
            summary={sourceSummary}
            title={t("tv.card-source")}
            hint={{
              titleKey: "help.tv-source.title",
              bodyKey: "help.tv-source.body",
            }}
            actions={
              <Button
                variant="secondary"
                small
                disabled={locked || uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? (
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Upload size={14} strokeWidth={2} />
                )}
                {hasSource ? t("tv.replace-video") : t("tv.upload-video")}
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              <input
                ref={fileRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  upload(e.target.files);
                  e.target.value = "";
                }}
              />

              {uploadError && (
                <ErrorBanner message={t("tv.upload-error")} detail={uploadError} />
              )}

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!locked && !uploading) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (!locked && !uploading) upload(e.dataTransfer.files);
                }}
                className={`rounded-[var(--radius)] border border-dashed p-4 text-center transition-colors duration-150 ${
                  dragOver
                    ? "border-[var(--primary)] bg-[var(--primary-soft)]"
                    : "border-[var(--border)] bg-[var(--bg-subtle)]"
                }`}
              >
                {uploading ? (
                  <p className="flex items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
                    <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                    {t("tv.uploading")}
                  </p>
                ) : (
                  <p className="text-sm text-[var(--text-muted)]">{t("tv.drop-hint")}</p>
                )}
              </div>

              {sourceUrl ? (
                <>
                  <video
                    controls
                    src={sourceUrl}
                    className="max-h-[360px] w-full rounded-[var(--radius)] bg-[var(--bg-subtle)]"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {src.width && src.height && (
                      <span className="chip">
                        {src.width}x{src.height}
                      </span>
                    )}
                    {src.durationSec !== null && (
                      <span className="chip">{clock(src.durationSec)}</span>
                    )}
                    {src.fps !== null && <span className="chip">{src.fps} fps</span>}
                    <span className="min-w-0 truncate text-meta text-[var(--text-muted)]">
                      {src.relPath}
                    </span>
                  </div>
                </>
              ) : (
                <EmptyState icon={FileVideo} description={t("tv.no-source-yet")} />
              )}

              <Field
                label={t("tv.source-lang")}
                htmlFor="tv-source-lang"
                hintKeys={{
                  titleKey: "help.tv-lang.title",
                  bodyKey: "help.tv-lang.body",
                }}
              >
                <select
                  id="tv-source-lang"
                  className="input"
                  value={sourceLang}
                  disabled={locked}
                  onChange={(e) => patchSourceLang(e.target.value)}
                >
                  {!TRANSLATE_SOURCE_LANGS.includes(
                    sourceLang as (typeof TRANSLATE_SOURCE_LANGS)[number]
                  ) && <option value={sourceLang}>{sourceLang}</option>}
                  {TRANSLATE_SOURCE_LANGS.map((code) => (
                    <option key={code} value={code}>
                      {langLabel(code)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </WorkspaceBlock>

          {/* Bóc lời thoại NẰM NGAY DƯỚI VIDEO: nó là thao tác trên chính cái
              video vừa xem ở trên (nghe hết video, ghi lại từng câu). Đặt ở cột
              kết quả như trước là bắt người dùng nhìn sang đầu kia màn hình để
              bấm một nút làm việc trên nguồn. */}
          <WorkspaceBlock
            id="tv-block-transcript"
            icon={Subtitles}
            collapsed={group.isCollapsed("transcript")}
            onToggle={() => group.toggle("transcript")}
            summary={transcriptSummary}
            title={t("tv.card-transcript")}
            hint={{
              titleKey: "help.tv-transcript.title",
              bodyKey: "help.tv-transcript.body",
            }}
            actions={
              <Button
                small
                disabled={!canTranscribe || busy !== null}
                onClick={() => run("transcribe")}
              >
                {busy === "transcribe" ? (
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Subtitles size={14} strokeWidth={2} />
                )}
                {cues.length > 0 ? t("tv.re-transcribe") : t("tv.transcribe")}
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              {/* AI nào bóc lời: chỉ Gemini và Soniox gắn được nhãn người nói,
                  mà không có nhãn thì lồng tiếng chỉ đọc được một giọng cho cả
                  video - nên lựa chọn này phải nằm ngay tại đây, không giấu đi */}
              <Field
                label={t("tv.stt-provider")}
                htmlFor="tv-stt-provider"
                hintKeys={{
                  titleKey: "help.tv-stt.title",
                  bodyKey: "help.tv-stt.body",
                }}
                // Lý do "chưa dùng được" ĐẨY dòng gợi ý đi chứ không nằm dưới
                // nó: xếp chồng hai câu xám/đỏ thì đọc thành một câu lẫn lộn.
                error={
                  sttCap && !sttCap.available && sttCap.why ? sttCap.why : null
                }
                hint={
                  sttCap?.diarization
                    ? t("tv.stt.diarization-hint")
                    : t("tv.stt.no-diarization-hint")
                }
              >
                <select
                  id="tv-stt-provider"
                  className="input"
                  value={sttProvider}
                  disabled={locked}
                  onChange={(e) => patchSttProvider(e.target.value as SttProvider)}
                >
                  {/* Không hỏi được danh sách (server cũ/mạng lỗi) thì vẫn phải
                      hiện lựa chọn đang lưu, đừng để ô rỗng */}
                  {sttProviders === null && (
                    <option value={sttProvider}>{sttName(sttProvider)}</option>
                  )}
                  {(sttProviders ?? []).map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available}>
                      {sttName(p.id)}
                      {p.diarization ? ` · ${t("tv.stt.diarization")}` : ""}
                      {p.available ? "" : ` · ${t("tv.stt.unavailable")}`}
                    </option>
                  ))}
                </select>
              </Field>

              {session.status === "transcribing" && (
                <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                  {t("tv.transcribing-hint")}
                </p>
              )}

              {/* Log của bước bóc lời đã chuyển sang panel AI bên phải - ở đây
                  chỉ còn dòng chờ phía trên. */}
              {cues.length === 0 ? (
                <EmptyState
                  icon={Subtitles}
                  description={hasSource ? t("tv.no-transcript") : t("tv.no-source-yet")}
                />
              ) : null}

              {/* Transcript ĐANG CÓ là của ai, tiếng gì, có nhãn người nói
                  không - khác hẳn ô chọn phía trên (đó là cho lần chạy SAU) */}
              {session.transcriptInfo && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip">
                    {sttName(session.transcriptInfo.provider)}
                  </span>
                  <span className="chip">{session.transcriptInfo.language}</span>
                  <span className="chip">
                    {session.transcriptInfo.diarized
                      ? tf("tv.transcript-speakers", {
                          n: session.transcriptInfo.speakers.length,
                        })
                      : t("tv.transcript-no-speakers")}
                  </span>
                </div>
              )}

              {session.transcriptFile && (
                <span className="chip w-fit">
                  {t("tv.transcript-file")}: {session.transcriptFile}
                </span>
              )}
            </div>
          </WorkspaceBlock>
        </WorkspaceColumn>

        {/* ============ Cột 2: yêu cầu & thiết lập ============ */}
        <WorkspaceColumn role="setup" title={t("workspace.col.setup")}>
          {/* Ngôn ngữ đích + chế độ + sửa tay từng câu thoại - đây mới là chỗ
              người dùng nói "tôi muốn ra cái gì" */}
          <WorkspaceBlock
            id="tv-block-translation"
            icon={Languages}
            collapsed={group.isCollapsed("translation")}
            onToggle={() => group.toggle("translation")}
            summary={translationSummary}
            title={t("tv.card-translation")}
            hint={{
              titleKey: "help.tv-translation.title",
              bodyKey: "help.tv-translation.body",
            }}
            actions={
              <Button
                small
                disabled={!canTranslate || busy !== null}
                onClick={() => run("translate")}
              >
                {busy === "translate" ? (
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Wand2 size={14} strokeWidth={2} />
                )}
                {translatedCount > 0 ? t("tv.re-translate") : t("tv.translate")}
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              <Panel>
                {/* Chọn chế độ là MỞ LUÔN modal cấu hình của chế độ đó: chọn
                    xong mà không thấy gì xảy ra thì người dùng phải tự đi tìm
                    chỗ chỉnh. Chọn "cả hai" thì mở modal phụ đề trước - đó là
                    thứ nhìn thấy ngay trên hình - đóng nó xong mới tới lồng
                    tiếng. Bấm lại đúng chế độ đang chọn cũng mở lại modal. */}
                <Field
                  label={t("tv.mode")}
                  hintKeys={{
                    titleKey: "help.tv-mode.title",
                    bodyKey: "help.tv-mode.body",
                  }}
                >
                  <Segmented
                    label={t("tv.mode")}
                    value={mode}
                    disabled={locked}
                    onChange={chooseMode}
                    options={(
                      [
                        ["subtitle", Subtitles],
                        ["dub", Mic],
                        ["both", Layers],
                      ] as const
                    ).map(([m, Icon]) => ({
                      value: m as TranslateMode,
                      label: (
                        <>
                          <Icon size={14} strokeWidth={2} aria-hidden="true" />
                          {t(TRANSLATE_MODE_LABEL[m as TranslateMode])}
                        </>
                      ),
                    }))}
                  />
                </Field>

                {/* AI nào dịch và model gì - câu hỏi đầu tiên khi đọc phải một
                    câu dịch lạ, nên nó phải nằm ngay cạnh nút Dịch chứ không
                    nằm trong tài liệu. Danh sách model là gương của
                    apps/server/src/translate.ts (xem TRANSLATE_MODELS).
                    Dòng "đang dùng gì" là GỢI Ý của chính ô này, không phải một
                    câu rời phía dưới - trước đây nó lặp lại y hệt giá trị vừa
                    chọn ở cách đó hai dòng. */}
                <Field
                  label={t("tv.model")}
                  htmlFor="tv-model"
                  hintKeys={{
                    titleKey: "help.tv-model.title",
                    bodyKey: "help.tv-model.body",
                  }}
                  hint={tf("tv.model-current", {
                    provider: TRANSLATE_PROVIDER,
                    model: translateModel,
                  })}
                >
                  <select
                    id="tv-model"
                    className="input"
                    value={translateModel}
                    disabled={locked}
                    onChange={(e) => setTranslateModel(e.target.value)}
                  >
                    {!TRANSLATE_MODELS.some((m) => m.id === translateModel) && (
                      <option value={translateModel}>{translateModel}</option>
                    )}
                    {TRANSLATE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {modelLabel(m.id)}
                      </option>
                    ))}
                  </select>
                </Field>
              </Panel>

              {/* Đường quay lại sau khi đóng modal. Chỉ hiện phần chế độ đang
                  bật: chọn thuần lồng tiếng mà vẫn bày dòng phụ đề là nhắc tới
                  một thứ video sẽ không có. */}
              {wantsSubtitleMode && (
                <ConfigSummary
                  icon={Type}
                  label={t("tv.card-subtitle")}
                  value={`${langLabel(targetLang)} · ${subtitleSummary}`}
                  onEdit={() => setSubtitleModalOpen(true)}
                />
              )}
              {wantsDubMode && (
                <ConfigSummary
                  icon={Mic}
                  label={t("tv.card-dub")}
                  value={`${langLabel(effectiveDubLang)} · ${dubSummary}`}
                  onEdit={() => setDubModalOpen(true)}
                />
              )}

              {session.status === "translating" ? (
                <p className="flex items-center gap-2 py-4 text-sm text-[var(--text-muted)]">
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                  {t("tv.translating-hint")}
                </p>
              ) : cues.length === 0 ? (
                <EmptyState icon={Languages} description={t("tv.no-transcript")} />
              ) : (
                <>
                  {/* Nói TRƯỚC khi bấm render: server sẽ chặn (400) chứ không
                      đọc liều bản phụ đề bằng sai ngôn ngữ */}
                  {dubTranslationMissing && (
                    <Banner
                      tone="danger"
                      message={tf("tv.dub-needs-retranslate", {
                        lang: langLabel(effectiveDubLang),
                      })}
                    />
                  )}
                  {/* Cả danh sách nằm trong MỘT Panel, từng câu chỉ cách nhau
                      bằng một đường kẻ mảnh. Trước đây mỗi câu là một thẻ có
                      viền riêng bên trong một khối có viền - 200 câu thành 200
                      cái khung lồng trong khung, không đọc ra được cái nào
                      chứa cái nào. */}
                  <Panel>
                    <ul className="flex flex-col">
                      {cues.map((c, i) => {
                        // Ô phụ đề dựng một lần: hai ngôn ngữ thì nó có nhãn,
                        // một ngôn ngữ thì nhãn ấy chỉ là chữ thừa
                        const subtitleBox = (
                          <textarea
                            id={`tv-cue-${i}`}
                            className="input"
                            rows={2}
                            value={c.text}
                            disabled={locked}
                            aria-label={tf("tv.cue-aria", { n: i + 1 })}
                            onChange={(e) => patchCueText(i, e.target.value)}
                            onBlur={() => flush()}
                          />
                        );
                        return (
                          <li
                            key={i}
                            className="flex flex-col gap-2 border-t border-[var(--border)] py-3 first:border-t-0 first:pt-0 last:pb-0"
                          >
                            {/* Mốc thời gian + người nói gộp một dòng phụ chú:
                                đây là thứ để ĐỊNH VỊ câu, không phải để đọc */}
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-[var(--text-muted)]">
                              <span className="font-mono">
                                {clock(c.start)} - {clock(c.end)}
                              </span>
                              {c.speaker && <span className="chip">{c.speaker}</span>}
                            </div>
                            {/* Câu gốc là thứ PHẢI đọc để đối chiếu bản dịch -
                                đủ 14px như mọi nội dung khác */}
                            {c.original && (
                              <p className="text-sm text-[var(--text-muted)] italic">
                                {c.original}
                              </p>
                            )}
                            {/* Hai ngôn ngữ thì phải THẤY cả hai. Trước đây chỗ
                                này chỉ hiện chữ phụ đề, nên chọn lồng tiếng bằng
                                tiếng khác xong vẫn nhìn thấy toàn tiếng của phụ
                                đề và tưởng bản đọc không đổi theo ngôn ngữ đã
                                chọn. */}
                            {twoLangs ? (
                              <Field
                                label={tf("tv.cue-subtitle-of", {
                                  lang: langLabel(targetLang),
                                })}
                                htmlFor={`tv-cue-${i}`}
                              >
                                {subtitleBox}
                              </Field>
                            ) : (
                              subtitleBox
                            )}
                            {twoLangs && (
                              <Field
                                label={
                                  <span className="inline-flex items-center gap-1">
                                    <Mic size={13} strokeWidth={2} aria-hidden="true" />
                                    {tf("tv.cue-dub-of", {
                                      lang: langLabel(effectiveDubLang),
                                    })}
                                  </span>
                                }
                                htmlFor={`tv-cue-dub-${i}`}
                              >
                                <textarea
                                  id={`tv-cue-dub-${i}`}
                                  className="input"
                                  rows={2}
                                  value={c.dubText ?? ""}
                                  disabled={locked}
                                  placeholder={t("tv.cue-dub-missing")}
                                  aria-label={tf("tv.cue-dub-aria", { n: i + 1 })}
                                  onChange={(e) => patchCueDubText(i, e.target.value)}
                                  onBlur={() => flush()}
                                />
                              </Field>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </Panel>
                  <p className="text-meta text-[var(--text-muted)]">
                    {tf("tv.translated-count", { n: translatedCount })} /{" "}
                    {tf("tv.cue-count", { n: cues.length })} · {t("tv.cue-hint")}
                  </p>
                </>
              )}
            </div>
          </WorkspaceBlock>
        </WorkspaceColumn>

        {/* ============ Cột 3: tiến trình & kết quả ============ */}
        <WorkspaceColumn role="output" title={t("workspace.col.output")}>
          {/* Khối ĐẦU TIÊN của cột: đang đóng phụ đề thì nhấp nháy chờ, xong thì
              hiện thẳng video. Liếc một chỗ là biết phiên đang ở đâu. */}
          <OutputBlock
            id="tv-block-result"
            status={outputStatus}
            videoUrl={outputUrl}
            progress={renderJob ? renderJob.progress : null}
            step={renderJob?.step}
            aspect={aspect}
            error={renderFailed ? shortError(session.error) : null}
            collapsed={group.isCollapsed("result")}
            onToggle={() => group.toggle("result")}
            summary={resultSummary}
            title={t("tv.card-result")}
            hint={{
              titleKey: "help.tv-result.title",
              bodyKey: "help.tv-result.body",
            }}
            actions={
              <Button
                disabled={!canRender || busy !== null}
                onClick={() => run("render")}
              >
                {busy === "render" ? (
                  <Loader2 size={15} strokeWidth={2} className="animate-spin" />
                ) : isDub ? (
                  <Mic size={15} strokeWidth={2} />
                ) : (
                  <Film size={15} strokeWidth={2} />
                )}
                {isDub
                  ? session.outputFile
                    ? t("tv.dub-re-render")
                    : t("tv.dub-render")
                  : session.outputFile
                    ? t("tv.re-render")
                    : t("tv.render")}
              </Button>
            }
          >
            {session.status === "rendering" && (
              <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                {isDub ? t("tv.dub-rendering-hint") : t("tv.rendering-hint")}
              </p>
            )}

            {/* Log của bước đóng phụ đề nằm ở panel AI bên phải; khối này đã có
                thanh tiến trình của OutputBlock nên không lặp lại lần nữa. */}
            {/* Số liệu của lần lồng tiếng gần nhất: bao nhiêu câu phải co, bao
                nhiêu câu tràn, dải tempo. Đây là cách DUY NHẤT để biết bản lồng
                tiếng có ổn không mà không phải ngồi xem hết video. */}
            {session.dubInfo && <DubReport info={session.dubInfo} />}

            {outputUrl ? (
              <span className="min-w-0 truncate text-meta text-[var(--text-muted)]">
                {session.outputFile}
              </span>
            ) : (
              <p className="text-sm text-[var(--text-muted)]">
                {canRender
                  ? isDub
                    ? t("tv.dub-render-hint")
                    : t("tv.render-hint")
                  : cues.length === 0
                    ? t("tv.render-need-transcript")
                    : t("tv.render-need-translation")}
              </p>
            )}
          </OutputBlock>

          {/* KHÔNG còn khối "Tiến độ dịch" ở đây: nó chỉ nói lại đúng thứ cột 2
              đã nói. Tóm tắt của nó là `translationSummary` - cùng chuỗi khối
              "Bản dịch" đang dùng - còn dòng đếm câu-đã-dịch/tổng-số thì nằm
              ngay dưới danh sách câu, tức là cạnh chính chỗ người dùng sửa. Đếm
              một việc ở hai nơi thì đến lúc lệch nhau không ai biết tin chỗ nào. */}
        </WorkspaceColumn>
      </Workspace>

      {/* Panel AI - shell lo bề rộng, nút gấp và chế độ drawer; trang chỉ nói
          "tôi có panel, nội dung đây". Job mới nhất của phiên luôn ở đây, kể cả
          khi đã chạy xong: chạy hỏng thì log là thứ DUY NHẤT nói vì sao, gấp nó
          đi ngay khi job kết thúc là cất mất đúng lúc cần đọc nhất. */}
      <ShellRightPanel title={t("tv.ai-panel")}>
        {job ? (
          <JobLogBlock
            job={job}
            stepLabel={
              phase === "transcribe"
                ? t("tv.ai-panel.step-transcribe")
                : isDub
                  ? t("tv.ai-panel.step-dub")
                  : t("tv.ai-panel.step-subtitle")
            }
          />
        ) : (
          <Panel className="min-h-0 flex-1 items-center justify-center">
            <EmptyState icon={ScrollText} description={t("tv.ai-panel-empty")} />
          </Panel>
        )}
      </ShellRightPanel>

      {/* ---- Modal: cấu hình PHỤ ĐỀ ----
          Nằm NGOÀI <Workspace>: `.workspace` có `container-type: inline-size`,
          tức là nó chứa luôn cả con `position: fixed` - modal đặt bên trong sẽ
          căn theo khung workspace chứ không theo màn hình.
          `wide` vì có ô xem trước phụ đề đứng cạnh lưới thiết lập. */}
      <Modal
        wide
        title={t("tv.card-subtitle")}
        open={subtitleModalOpen}
        onClose={closeSubtitleModal}
        footer={
          <Button onClick={closeSubtitleModal}>{t("common.done")}</Button>
        }
      >
        <div className="flex flex-col gap-4">
          {/* Ngôn ngữ của CHỮ TRÊN MÀN HÌNH - đặt ngay trong modal phụ đề để
              không phải nhớ nó nằm ở đâu khác */}
          <Field label={t("tv.subtitle-lang")} htmlFor="tv-subtitle-lang">
            <select
              id="tv-subtitle-lang"
              className="input"
              value={targetLang}
              disabled={locked}
              onChange={(e) => patchTargetLang(e.target.value)}
            >
              {!TRANSLATE_TARGET_LANGS.includes(
                targetLang as (typeof TRANSLATE_TARGET_LANGS)[number]
              ) && <option value={targetLang}>{targetLang}</option>}
              {TRANSLATE_TARGET_LANGS.map((code) => (
                <option key={code} value={code}>
                  {langLabel(code)}
                </option>
              ))}
            </select>
          </Field>

          {/* Lồng tiếng KHÔNG đốt chữ lên hình - nói thẳng thay vì để người
              dùng chỉnh cả bảng kiểu chữ rồi không thấy chữ đâu trong video */}
          {isDub && (
            <Banner tone="muted" message={t("tv.subtitle-unused-in-dub")} />
          )}

          {/* Xem trước NGAY: đổi cỡ chữ hay màu nền mà phải render mới biết
              đẹp xấu thì mỗi lần thử mất hàng chục phút. */}
          <Field
            label={t("tv.preview")}
            hint={sourceUrl ? t("tv.preview-hint") : t("tv.preview-hint-no-source")}
          >
            {/* NGOẠI LỆ DUY NHẤT của bảng token trong file này: khung dưới
                đây MÔ PHỎNG khung hình video, không phải một bề mặt của
                dashboard. Nền phải tối và CỐ ĐỊNH tối - lấy --bg-subtle thì
                ở theme sáng nó thành trắng, và xem trước phụ đề chữ trắng
                trên nền trắng là xem trước nói dối. Hai giá trị hex ở đây
                (#1c1c20 cho nền, cặp #3a3f4b/#191c22 cho sọc chéo) cố ý
                không có token tương ứng vì chúng không bao giờ đổi theo
                theme. */}
            <div className="relative flex h-40 items-end justify-center overflow-hidden rounded-[var(--radius)] bg-[#1c1c20]">
              {/*
                PHÍA SAU CHỮ PHẢI CÓ HÌNH THẬT.

                Lỗi đã sửa: `backdrop-filter: blur()` chỉ làm mờ NHỮNG GÌ NẰM
                PHÍA SAU nó. Trước đây ô xem trước là một khối màu phẳng, mà
                làm mờ một màu phẳng thì ra đúng màu phẳng đó - kéo "Độ mờ"
                từ 0 lên 40 không đổi lấy một pixel, người dùng tưởng tính
                năng hỏng.
                Nên: một khung hình của CHÍNH video người dùng vừa tải lên
                (mốc PREVIEW_FRAME_SEC, tránh giây đầu thường là màn đen),
                chưa có nguồn thì dùng nền kẻ sọc tương phản - cả hai đều có
                chi tiết để làm mờ, nên 0 / 20 / 40 nhìn ra ngay là ba mức.
                Video ở đây câm và không có controls: nó là HÌNH NỀN, người
                dùng đã có trình phát thật ở khối Video nguồn.
              */}
              {sourceUrl ? (
                <video
                  key={sourceUrl}
                  src={`${sourceUrl}#t=${PREVIEW_FRAME_SEC}`}
                  muted
                  playsInline
                  preload="metadata"
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                  // Sọc chéo hai tông xám: đủ chi tiết để thấy độ mờ, và cố
                  // ý KHÔNG dùng token màu (xem ghi chú khung giả lập trên).
                  style={{
                    background:
                      "repeating-linear-gradient(135deg, #3a3f4b 0 14px, #191c22 14px 28px)",
                  }}
                />
              )}
              <div
                className="relative max-w-[86%] rounded-[var(--radius)] px-3 py-1 text-center leading-snug"
                style={{
                  marginBottom: `${Math.min(
                    // bottomPx tính trên khung hình thật (vd 1080px cao), ô
                    // xem trước chỉ cao 160px → thu tỉ lệ cho khỏi đẩy chữ ra ngoài
                    Math.round(subtitleStyle.bottomPx / 8),
                    96
                  )}px`,
                  fontFamily:
                    FONT_STACK[subtitleStyle.fontFamily as SubtitleFontId] ??
                    FONT_STACK.sans,
                  fontSize: `${Math.max(
                    11,
                    Math.round(subtitleStyle.fontSizePx / 3)
                  )}px`,
                  color: subtitleStyle.color,
                  background:
                    subtitleStyle.backdrop === "none"
                      ? "transparent"
                      : subtitleStyle.backdropColor,
                  // Bán kính mờ thu theo ĐÚNG tỉ lệ của cỡ chữ (÷3): ô xem
                  // trước nhỏ hơn khung hình thật chừng ấy lần, để nguyên
                  // 40px là cả ô nhòe thành một mảng - lại nói dối kiểu khác.
                  backdropFilter:
                    subtitleStyle.backdrop === "blur"
                      ? `blur(${(subtitleStyle.blurPx / 3).toFixed(1)}px)`
                      : undefined,
                  opacity: subtitleStyle.backdrop === "blur" ? 0.92 : 1,
                }}
              >
                {t("tv.preview-text")}
              </div>
            </div>
          </Field>

          {/* auto-fit, không `sm:grid-cols-2` - xem lý do ở nhóm engine
              đọc trong DubbingPicker */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
            <Field
              label={t("tv.font")}
              htmlFor="tv-font"
              hintKeys={{
                titleKey: "help.tv-font.title",
                bodyKey: "help.tv-font.body",
              }}
            >
              <select
                id="tv-font"
                className="input"
                value={subtitleStyle.fontFamily}
                disabled={locked}
                onChange={(e) => patchStyle({ fontFamily: e.target.value }, true)}
              >
                {/* Font ngoài allowlist (server cũ/mới lệch nhau) vẫn hiện để
                    không âm thầm đổi lựa chọn đã lưu của người dùng */}
                {!SUBTITLE_FONTS.includes(
                  subtitleStyle.fontFamily as SubtitleFontId
                ) && (
                  <option value={subtitleStyle.fontFamily}>
                    {subtitleStyle.fontFamily}
                  </option>
                )}
                {SUBTITLE_FONTS.map((f) => (
                  <option key={f} value={f}>
                    {t(`tv.font.${f}`)}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t("tv.font-size")} htmlFor="tv-font-size">
              <input
                id="tv-font-size"
                className="input"
                type="number"
                min={SUBTITLE_FONT_SIZE_MIN}
                max={SUBTITLE_FONT_SIZE_MAX}
                value={subtitleStyle.fontSizePx}
                disabled={locked}
                onChange={(e) =>
                  patchStyle({ fontSizePx: Number(e.target.value) }, true)
                }
              />
            </Field>

            <ColorField
              id="tv-color"
              label={t("tv.color")}
              value={subtitleStyle.color}
              disabled={locked}
              onChange={(v) => patchStyle({ color: v }, true)}
            />

            <Field label={t("tv.bottom")} htmlFor="tv-bottom">
              <input
                id="tv-bottom"
                className="input"
                type="number"
                min={0}
                max={SUBTITLE_BOTTOM_MAX}
                value={subtitleStyle.bottomPx}
                disabled={locked}
                onChange={(e) =>
                  patchStyle({ bottomPx: Number(e.target.value) }, true)
                }
              />
            </Field>
          </div>

          <Field label={t("tv.backdrop")}>
            <Segmented
              label={t("tv.backdrop")}
              value={subtitleStyle.backdrop as SubtitleBackdrop}
              disabled={locked}
              onChange={(b) => patchStyle({ backdrop: b }, true)}
              options={(["blur", "solid", "none"] as const).map((b) => ({
                value: b,
                label: t(`tv.backdrop.${b}`),
              }))}
            />
          </Field>

          {subtitleStyle.backdrop !== "none" && (
            /* auto-fit, không `sm:grid-cols-2` - xem lý do ở nhóm engine
               đọc trong DubbingPicker */
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
              <ColorField
                id="tv-backdrop-color"
                label={t("tv.backdrop-color")}
                value={subtitleStyle.backdropColor}
                disabled={locked}
                // Giữ nguyên độ đặc đang đặt khi đổi MÀU: ô chọn màu trả về
                // #rrggbb (không mang alpha), nhận thẳng là mỗi lần đổi màu
                // lại đá nền về đặc 100%
                onChange={(v) =>
                  patchStyle(
                    {
                      backdropColor: withAlpha(
                        v,
                        alphaOf(subtitleStyle.backdropColor)
                      ),
                    },
                    true
                  )
                }
              />
              <OpacityField
                id="tv-backdrop-opacity"
                label={t("tv.backdrop-opacity")}
                value={subtitleStyle.backdropColor}
                disabled={locked}
                onChange={(v) => patchStyle({ backdropColor: v }, true)}
              />
              {subtitleStyle.backdrop === "blur" && (
                <Field label={t("tv.blur")} htmlFor="tv-blur">
                  <input
                    id="tv-blur"
                    className="input"
                    type="number"
                    min={0}
                    max={SUBTITLE_BLUR_MAX}
                    value={subtitleStyle.blurPx}
                    disabled={locked}
                    onChange={(e) =>
                      patchStyle({ blurPx: Number(e.target.value) }, true)
                    }
                  />
                </Field>
              )}
            </div>
          )}

          <p className="text-meta text-[var(--text-muted)]">
            {locked ? t("tv.style-locked") : t("tv.style-autosave")}
          </p>
        </div>
      </Modal>

      {/* ---- Modal: cấu hình LỒNG TIẾNG ----
          `wide` vì bên trong có bảng gán giọng theo từng người nói (tên người
          nói + ô chọn giọng + nút nghe thử + số đo trên cùng một hàng). */}
      <Modal
        wide
        title={t("tv.card-dub")}
        open={dubModalOpen}
        onClose={() => setDubModalOpen(false)}
        footer={
          <Button onClick={() => setDubModalOpen(false)}>{t("common.done")}</Button>
        }
      >
        <div className="flex flex-col gap-4">
          {/* Ngôn ngữ ĐỌC LÊN - chọn riêng với ngôn ngữ phụ đề. "Giống phụ đề"
              là một lựa chọn thật trong danh sách chứ không phải ô để trống:
              đó là điều đa số người dùng muốn, phải nhìn thấy được. */}
          <Field
            label={t("tv.dub-lang")}
            htmlFor="tv-dub-lang"
            hint={
              dubLang && dubLang !== targetLang ? t("tv.dub-lang-cost") : undefined
            }
          >
            <select
              id="tv-dub-lang"
              className="input"
              value={dubLang ?? ""}
              disabled={locked}
              onChange={(e) => patchDubLang(e.target.value || null)}
            >
              <option value="">
                {tf("tv.dub-lang-same", { lang: langLabel(targetLang) })}
              </option>
              {TRANSLATE_TARGET_LANGS.map((code) => (
                <option key={code} value={code}>
                  {langLabel(code)}
                </option>
              ))}
            </select>
          </Field>

          {cues.length === 0 ? (
            <EmptyState icon={Mic} description={t("tv.dub.need-cues")} />
          ) : (
            <DubSettingsCard
              sessionId={sessionId}
              dub={dub}
              speakers={speakers}
              diarized={session.transcriptInfo?.diarized === true}
              cueIndexOf={cueIndexOf}
              speakerF0={session.dubInfo?.speakerF0 ?? {}}
              disabled={locked}
              onChange={patchDub}
            />
          )}
        </div>
      </Modal>

      <ConfirmDeleteModal
        open={deleteOpen}
        title={t("tv.delete-title")}
        description={<p>{t("tv.delete-desc")}</p>}
        items={[session.name]}
        busy={deleting}
        error={deleteError}
        onClose={() => setDeleteOpen(false)}
        onConfirm={onDelete}
      />
    </div>
  );
}
