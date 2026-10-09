/**
 * Typed fetch wrapper theo hợp đồng docs/API.md.
 * Web (6868) rewrites /api/* và /media/* sang backend (6869).
 */

// ============ Types ============

export interface HealthChecks {
  ffmpeg: boolean;
  node: string;
  /** Có xác thực Claude (subscription OAuth của Claude Code hoặc API key) */
  claudeAuth: boolean;
  hyperframes: boolean;
}

export interface Health {
  ok: boolean;
  checks: HealthChecks;
}

export type ProjectStatus = "draft" | "rendering" | "done";

export interface ProjectSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  status: ProjectStatus;
  output: string | null;
  tags: string[];
  /**
   * Phiên Text to video đã sinh ra project này - null = tạo tay.
   * Danh sách project dùng nó để chỉ rõ nguồn gốc: không có thì người dùng thấy
   * một project lạ mọc ra mà không biết từ đâu.
   */
  textToVideoId: string | null;
  /** Project cũ tạo trước khi có field này → null. */
  createdAt: string | null;
  updatedAt: string;
  /** Tổng token AI đã dùng cho project. */
  tokensUsed: number;
  /** Chi phí ước tính (USD) tương ứng. */
  costUsd: number;
}

/** Token + chi phí gộp - /api/usage/summary. */
export interface UsageSummary {
  byProject: Record<string, { tokens: number; costUsd: number }>;
  total: {
    tokens: number;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
  };
}

/** Loại project để lọc timeline token: all = mọi dòng, video/image theo projectId. */
export type UsageScope = "all" | "video" | "image";

/** Một ngày trong timeline token - /api/usage/timeline. */
export interface UsageTimelinePoint {
  /** yyyy-mm-dd */
  date: string;
  tokens: number;
  /** Token input (prompt) trong ngày. */
  tokensIn: number;
  /** Token output (completion) trong ngày. */
  tokensOut: number;
  costUsd: number;
  /** Token phân theo AI ("claude" | "gemini" | "openai") - vẽ đường theo provider. */
  byProvider: Record<string, number>;
}

/**
 * Một dòng bảng "Chi phí AI theo model" - /api/usage/by-model.
 *
 * `costUsd` là tiền THẬT nhà cung cấp tính. `costInUsd`/`costOutUsd` là quy đổi
 * theo đơn giá niêm yết, nên tổng của chúng thường KHÔNG bằng `costUsd` (prompt
 * cache đọc lại chỉ tính ~10% giá token vào). Không biết đơn giá thì cả ba
 * trường `price`/`costInUsd`/`costOutUsd` đều null - UI để trống ô, không đoán.
 */
export interface UsageByModel {
  /** "claude" | "gemini" | "openai" */
  provider: string;
  /** null = dòng usage không gắn phiên chat nào (bóc lời, dịch, tạo ảnh…). */
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Đơn giá USD trên 1 triệu token; null = không có trong bảng giá. */
  price: { inPerM: number; outPerM: number } | null;
  costInUsd: number | null;
  costOutUsd: number | null;
}

export interface FileInfo {
  name: string;
  relPath: string;
  size: number;
  mtime: string;
  kind: "video" | "audio" | "image" | "other";
  /** Mô tả asset (assets.json của project) - cho AI biết dùng file vào lúc nào. */
  description?: string;
  /** Preset chỉnh màu đã lưu cho video (id preset - nhãn lấy từ getGradePresets). */
  colorGrade?: string;
  /** Thông số chỉnh tay cộng chồng lên preset - chỉ có khi khác mặc định. */
  colorAdjust?: Record<string, number>;
}

/**
 * Nhãn fallback của vài preset cũ - CHỈ dùng khi chưa fetch được danh sách.
 * Nguồn nhãn chính thức: GET /api/grade-presets (getGradePresets).
 */
export const GRADE_LABELS: Record<string, string> = {
  "tu-nhien": "Tự nhiên",
  cinematic: "Cinematic",
  "tuoi-sang": "Tươi sáng",
  am: "Ấm",
  lanh: "Lạnh",
};

/** Một preset màu server hỗ trợ - nguồn nhãn duy nhất cho UI. */
export interface GradePresetInfo {
  id: string;
  label: string;
}

// Cache module-level - danh sách preset tĩnh trong một phiên chạy server.
let gradePresetsCache: GradePresetInfo[] | null = null;

/** Danh sách preset màu (id + nhãn tiếng Việt) - cache sau lần gọi đầu. */
export async function getGradePresets(): Promise<GradePresetInfo[]> {
  if (gradePresetsCache) return gradePresetsCache;
  const list = await request<GradePresetInfo[]>("/api/grade-presets");
  gradePresetsCache = list;
  return list;
}

/** Thông số chỉnh màu tay - cộng CHỒNG lên preset (khớp GradeAdjust của server). */
export interface GradeAdjust {
  /** -0.3..0.3, mặc định 0 */
  brightness: number;
  /** 0.7..1.4, mặc định 1 */
  contrast: number;
  /** 0..2, mặc định 1 */
  saturation: number;
  /** 0.7..1.4, mặc định 1 */
  gamma: number;
  /** 4000..9500 (K), mặc định 6500 = không đổi */
  temperature: number;
  /** -0.5..0.5, mặc định 0 */
  vibrance: number;
}

export const DEFAULT_ADJUST: GradeAdjust = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  gamma: 1,
  temperature: 6500,
  vibrance: 0,
};

/** Điền default cho object adjust thiếu field (vd colorAdjust đọc từ meta). */
export function toGradeAdjust(raw?: Record<string, number> | null): GradeAdjust {
  const a = { ...DEFAULT_ADJUST };
  if (!raw || typeof raw !== "object") return a;
  for (const k of Object.keys(a) as (keyof GradeAdjust)[]) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) a[k] = v;
  }
  return a;
}

/** true = mọi thông số đều ở mặc định (không chỉnh tay gì). */
export function isDefaultAdjust(raw?: GradeAdjust | Record<string, number> | null): boolean {
  const a = toGradeAdjust(raw as Record<string, number> | null | undefined);
  return (Object.keys(DEFAULT_ADJUST) as (keyof GradeAdjust)[]).every(
    (k) => a[k] === DEFAULT_ADJUST[k]
  );
}

/** Thông tin màu của footage - kèm kết quả grade-preview. */
export interface GradePreviewInfo {
  transfer: string;
  primaries: string;
  /** true = footage HDR/log, hệ thống sẽ delog trước khi áp màu. */
  needsTonemap: boolean;
  durationSec: number;
}

export interface GradePreviewItem {
  /** null = ảnh "Gốc" (không áp preset). */
  preset: string | null;
  label: string;
  relPath: string;
}

export interface GradePreviewResult {
  info: GradePreviewInfo;
  previews: GradePreviewItem[];
}

export type SfxMode = "recommended" | "library" | "none";

/** Nhạc nền: AI tự chọn bài theo mood trong thư viện / không dùng. */
export type MusicMode = "auto" | "none";

/**
 * Mức mạnh tay khi cắt tự động - PHẢI khớp AUTO_CUT_LEVELS của server
 * (meta.ts) và TRIM_PROFILES (autoTrim.ts). Thứ tự = từ nhẹ tay tới sát nhất.
 */
export const AUTO_CUT_LEVELS = ["natural", "default", "tight"] as const;

export type TrimAggressiveness = (typeof AUTO_CUT_LEVELS)[number];

/** Kịch bản edit của project - AI đọc phần này khi bắt đầu edit. */
export interface Brief {
  sourceDescription: string;
  autoCut: boolean;
  /**
   * Mạnh tay tới đâu khi cắt - chỉ có nghĩa khi autoCut = true (autoCut vẫn là
   * công tắc bật/tắt duy nhất, field này KHÔNG bật thay nó).
   */
  autoCutLevel: TrimAggressiveness;
  subtitles: boolean;
  /** BẬT = AI tự phân tích source, chọn keyword và highlight. */
  highlightEnabled: boolean;
  /** (Nâng cao, tùy chọn) chỉ định thêm keyword thủ công. */
  highlightKeywords: string[];
  /** BẬT (mặc định) = bố cục Key: KEY CHÍNH ở vùng TRÊN video, KEY LIÊN QUAN ở vùng DƯỚI. */
  keyLayoutEnabled: boolean;
  /** Key chính do user chỉ định - "" = AI tự phân tích chọn. */
  mainKey: string;
  /** Key liên quan user chỉ định (AI bắt buộc dùng đủ) - [] = AI tự chọn 3–6 key. */
  relatedKeys: string[];
  skill: string | null;
  sfxMode: SfxMode;
  /** "auto" (mặc định) = AI tự chọn nhạc nền theo mood, "none" = không dùng. */
  musicMode: MusicMode;
  notes: string;
  /** BẬT = Claude chọn ý chính, Gemini vẽ ảnh minh họa rồi ghép vào video. */
  autoIllustrations: boolean;
  /** Model Gemini vẽ minh họa - null = mặc định của server (Nano Banana 2). */
  illustrationModel: string | null;
  /** BẬT = Gemini được vẽ chữ vào ảnh minh họa (mặc định TẮT - chữ do hệ thống đặt). */
  illustrationText: boolean;
  /**
   * Vị trí chủ thể trong ảnh minh họa - lưới 3x3 dùng chung giá trị với vị trí
   * chữ của image project. "auto" = giữa khung, chừa band key trên + caption dưới.
   */
  illustrationPosition: ImageTextPosition;
  /** Số ảnh Gemini mỗi phút video (1-20) - null = AI tự quyết theo nội dung. */
  illustrationsPerMinute: number | null;
  /** Style Design sản phẩm phải tuân theo - null = style mặc định. */
  styleId: string | null;
  /**
   * Công tắc phong cách dựng. TẮT (mặc định) = dựng theo đúng cấu hình đã chọn
   * (skill + Style Design), không áp phong cách nào.
   */
  videoStyleEnabled: boolean;
  /**
   * Phong cách dựng video - CHỈ có hiệu lực khi videoStyleEnabled bật.
   *
   * KHÁC styleId: styleId là nhận diện thương hiệu (màu/font/logo) và luôn được
   * cưỡng chế; cái này là ngôn ngữ thị giác của riêng video (giấy gấp, mực tàu,
   * người que...). Hai thứ chồng lên nhau chứ không thay nhau.
   */
  videoStyleId: string | null;
}

/** Bảng màu của phong cách - xem ghi chú ở `VideoStyle.palette`. */
export type VideoStylePalette = "brand" | "loose";

/** Một phong cách dựng - GET /api/video-styles. */
export interface VideoStyle {
  id: string;
  /** Tên tiếng Việt từ server - chỉ là lưới an toàn, web ưu tiên key `vstyle.<id>`. */
  name: string;
  /**
   * "brand" = ảnh vẫn bám bảng màu thương hiệu.
   * "loose" = phong cách có bảng màu ruột của nó (mực tàu, Đông Hồ, ảnh chụp
   * thật), màu thương hiệu tụt xuống thành điểm nhấn. UI PHẢI nói rõ để người
   * dùng không tưởng hệ thống làm sai style.
   */
  palette: VideoStylePalette;
  /** Cách dựng cảnh và chuyển động - hiện cho người dùng biết video sẽ động ra sao. */
  motion: string;
}

/** Prompt mẫu tái sử dụng - đổ vào ô "Yêu cầu edit" của brief. */
export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface SceneMeta {
  id: string;
  src?: string;
  srcVideo?: string;
  durationInFrames?: number;
  [key: string]: unknown;
}

/**
 * GET /api/projects/:id - kế thừa ProjectSummary nên có cả tokensUsed/costUsd
 * và status đã chuẩn hóa (backend trả các field này từ bản align API).
 */
export interface ProjectDetail extends ProjectSummary {
  scenes?: SceneMeta[];
  brief?: Brief;
  /** "thumbnail.png" nếu video-projects/<id>/thumbnail.png tồn tại - null = chưa tạo. */
  thumbnail?: string | null;
  files: { renders: FileInfo[]; assets: FileInfo[] };
  [key: string]: unknown;
}

export type JobType =
  | "scene-draft"
  | "scene-final"
  | "assemble-draft"
  | "assemble-final"
  | "image-gen"
  /** Phiên cắt tự động - `projectId` = id phiên, `sceneId` = bước (plan/cut). */
  | "auto-cut"
  /** Cắt khoảng lặng + mỡ thừa ĐÃ DUYỆT của một video project - `sceneId` = mức mạnh tay. */
  | "auto-trim"
  /** Phiên dựng video từ bài viết - `projectId` = id phiên. */
  | "text-to-video"
  /** Phiên dịch video (bóc lời + đóng phụ đề) - `projectId` = id phiên. */
  | "translate-video";

export type JobStatus = "queued" | "running" | "done" | "failed" | "canceled";

export interface Job {
  id: string;
  projectId: string;
  type: JobType;
  sceneId: string | null;
  status: JobStatus;
  progress: number;
  step: string;
  outputPath: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type JobWithLog = Job & { log: string };

export interface Overview {
  /** Job đang chạy đầu tiên - giữ để tương thích, ưu tiên dùng `runningJobs`. */
  runningJob: Job | null;
  /**
   * TẤT CẢ job đang chạy (queue chạy tối đa 4 job song song). Optional vì
   * server cũ chưa trả field này - UI phải fallback về `runningJob`.
   */
  runningJobs?: Job[];
  queuedCount: number;
  recentJobs: Job[];
  recentProjects: ProjectSummary[];
  health: Health;
}

export interface SkillMeta {
  name: string;
  description: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface SkillDetail {
  name: string;
  content: string;
}

export interface SfxEntry {
  file: string;
  tags: string[];
  durationMs: number | null;
  description: string;
}

/** Một bài nhạc nền trong thư viện assets/music/ - tags = mood. */
export interface MusicEntry {
  file: string;
  tags: string[];
  durationMs: number | null;
  description: string;
}

/** Trạng thái phiên AI - bền vững trong DB, đọc lại được sau khi tắt UI. */
export type ChatSessionStatus =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "interrupted";

export interface ChatSession {
  sessionId: string;
  title: string;
  /** Project mà phiên chat gắn vào (null = chat tự do). */
  projectId: string | null;
  status: ChatSessionStatus;
  /** ISO - lúc lượt chạy hiện tại BẮT ĐẦU (không reset khi auto-resume). */
  runStartedAt: string | null;
  /** ISO - lúc lượt chạy kết thúc hẳn; null khi đang chạy. */
  runFinishedAt: string | null;
  /** Tự chạy tiếp khi phiên bị lỗi/gián đoạn (mặc định true). */
  autoResume: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  kind: "text" | "tool";
  content: string;
  createdAt: string;
}

export interface AgentEvent {
  sessionId: string;
  kind: "text" | "tool" | "result" | "error" | "done";
  text?: string;
  tool?: { name: string; input: unknown };
  error?: string;
  /** Kèm theo event kind "done" - kết cục của phiên. */
  status?: "done" | "error" | "interrupted";
}

export interface JobLogEvent {
  jobId: string;
  line: string;
}

/** Event SSE kênh "upload" - tiến trình server nhận file qua POST /api/assets. */
export interface UploadEvent {
  id: string;
  /** Có khi scope=project - dùng để lọc theo trang project đang mở. */
  projectId?: string;
  received?: number;
  /** 0 = không biết tổng (thiếu content-length) → hiện progress vô định. */
  total?: number;
  done: boolean;
  error?: boolean;
  /** Tên file đã lưu - đi kèm event done thành công. */
  file?: string;
}

// ============ AI Providers ============

/** Mode trên UI map sang effort của Agent SDK: Nhanh=low, Chuẩn=medium, Sâu=high. */
export type AgentEffort = "low" | "medium" | "high";

export type ProviderRole = "edit" | "chat" | "image";

export interface ProviderModel {
  id: string;
  label: string;
}

export interface Provider {
  id: "claude" | "gemini";
  label: string;
  connected: boolean;
  /** oauth = subscription Claude Code; api-key = key trong .env. */
  source: "oauth" | "api-key" | null;
  note?: string;
  roles: ProviderRole[];
  models: ProviderModel[];
}

// ============ Kết nối (API key providers) ============

/** Trạng thái API key của một provider - key đọc từ .env, đổi được qua UI. */
export interface ConnectionKeyInfo {
  /** Tên biến môi trường chứa key (vd ANTHROPIC_API_KEY). */
  envVar: string;
  present: boolean;
  /** Key đã che bớt (vd sk-ant-…abcd) - null khi chưa có key. */
  masked: string | null;
}

/** Một provider trên trang Kết nối - GET /api/connections. */
export interface ConnectionInfo {
  id: "claude" | "gemini" | "openai";
  label: string;
  roles: string[];
  connected: boolean;
  /** oauth = subscription Claude Code; api-key = key trong .env. */
  source: "oauth" | "api-key" | null;
  /** Ghi chú giải thích trạng thái (server soạn, tiếng Việt). */
  note: string | null;
  key: ConnectionKeyInfo;
  /** Trang lấy API key của provider. */
  keyHelpUrl: string;
}

// ============ Cấu hình (render settings) ============

/**
 * Cài đặt tăng tốc render - server đọc mỗi lần job chạy / queue tick,
 * nên PUT là có hiệu lực ngay, không cần restart.
 */
export interface RenderSettings {
  /** Số worker Chrome của HyperFrames (0 = auto, 0-12). */
  workers: number;
  /** Chrome dùng GPU khi capture (browser rendering). */
  browserGpu: boolean;
  /** Encode GPU (NVENC/VideoToolbox) cho bản draft. */
  gpuEncodeDraft: boolean;
  /** Encode GPU cho bản FINAL - nhanh nhưng chất lượng nhỉnh kém libx264. */
  gpuEncodeFinal: boolean;
  /** Fast capture - chỉ thực sự hoạt động trên macOS + GPU, nơi khác fallback vô hại. */
  fastCapture: boolean;
  /** Concurrency render của Remotion (0 = auto; trần = số luồng CPU của máy). */
  remotionConcurrency: number;
  /** Số job render chạy đồng thời trong queue (1-4). */
  queueConcurrency: number;
  /** FPS cho bản draft - null = giữ nguyên fps project; 15 = draft nhanh. */
  draftFps: number | null;
  /** Kênh cập nhật hệ thống (mặc định "stable" - chỉ nhận bản đã phát hành). */
  updateChannel: UpdateChannel;
  /**
   * Số lần phiên dựng video được TỰ CHẠY LẠI khi lượt trước kết thúc mà video
   * final chưa có (mặc định 4, server kẹp 1..12).
   */
  aiMaxAttempts: number;
  /**
   * Trần số lượt agent gọi công cụ trong MỘT lần chạy của phiên dựng video
   * (mặc định 300, server kẹp 20..300).
   */
  aiMaxTurns: number;
}

/** Phần cứng máy backend phát hiện được - GET /api/render-settings. */
export interface HardwareInfo {
  /** process.platform của server: win32 | darwin | linux… */
  platform: string;
  cores: number;
  ramGb: number;
  /** Tên GPU - null khi không phát hiện được. */
  gpuName: string | null;
  /** Có encoder NVENC (GPU NVIDIA). */
  nvenc: boolean;
  /** Có encoder VideoToolbox (macOS). */
  videotoolbox: boolean;
  /** Tên đầy đủ CPU, vd "Intel Core i5-9400F CPU @ 2.90GHz". */
  cpuModel: string;
  /** Số core vật lý - null nếu không tra được (hiển thị rơi về threads). */
  cpuCores: number | null;
  /** Số luồng logic. */
  cpuThreads: number;
  /** Xung tối đa (GHz) - null nếu không tra được. */
  cpuMaxGhz: number | null;
  /** Loại RAM: DDR4 | DDR5 | Unified Memory… - null nếu không tra được. */
  ramType: string | null;
  /** Bus RAM (MHz). */
  ramSpeedMhz: number | null;
  /** VRAM (GB) - hiện chỉ có với GPU NVIDIA. */
  gpuVramGb: number | null;
}

/** Khuyến nghị theo máy thật - UI dựng option worker/concurrency từ đây. */
export interface RenderRecommended {
  /** Số worker Chrome khuyên dùng (= min(số luồng CPU, 8)). */
  workers: number;
  /** Remotion concurrency khuyên dùng. */
  concurrency: number;
  /** Trần chọn được (= max(số luồng CPU, 4)). */
  maxWorkers: number;
}

export interface RenderSettingsResponse {
  settings: RenderSettings;
  defaults: RenderSettings;
  hardware: HardwareInfo;
  recommended: RenderRecommended;
}

export const getRenderSettings = () =>
  request<RenderSettingsResponse>("/api/render-settings");

/** PUT partial - hiệu lực NGAY (job đọc mỗi lần chạy), không cần restart. */
export const updateRenderSettings = (patch: Partial<RenderSettings>) =>
  jsonBody<{ settings: RenderSettings }>("/api/render-settings", "PUT", patch);

// ============ Style Design (bộ nhận diện thương hiệu - nhiều style) ============

/** Màu BRAND trong một style (DATA của user) - không phải token màu UI. */
export interface StyleColors {
  primary: string;
  secondary: string;
  background: string;
  text: string;
  accent: string;
}

/** Slot font của style - heading (tiêu đề) | body (nội dung). */
export type StyleFontSlot = "heading" | "body";

/** Hiệu ứng thị giác của style - bật/tắt được từng cái (default true/true). */
export interface StyleEffects {
  /** Chữ highlight + bề mặt dùng chuyển màu primary→secondary. */
  gradient: boolean;
  /** Chất liệu kính mờ: chip số liệu, phần tử 3D trong ảnh nền. */
  liquidGlass: boolean;
}

/** Một bộ nhận diện (Style Design) - lưu tại assets/styles/styles.json. */
export interface StyleDesign {
  id: string;
  name: string;
  tags: string[];
  colors: StyleColors;
  fonts: { heading: string; body: string };
  /** File font đã upload (relPath, phát qua /media) - null = font hệ thống. */
  fontFiles: { heading: string | null; body: string | null };
  /** relPath logo - phát qua /media. */
  logoPath: string | null;
  /** Hiệu ứng thị giác (gradient / liquid glass) - style cũ có thể thiếu. */
  effects?: StyleEffects;
  tone: string;
  guidelines: string;
  createdAt: string;
  updatedAt: string;
}

/** Kết quả GET /api/styles - danh sách style + style mặc định. */
export interface StylesResponse {
  defaultId: string | null;
  styles: StyleDesign[];
}

// ============ Image Projects ============

export type ImageKind =
  | "background"
  | "3d"
  | "character"
  | "texture"
  | "product"
  | "concept";

export type ImageAspect = "9:16" | "16:9" | "1:1" | "4:5";

export type ImageProjectStatus = "draft" | "generating" | "done" | "error";

export interface ImageStat {
  label: string;
  value: string;
}

/** Chữ trên ảnh - Remotion đặt theo Design System, KHÔNG nằm trong ảnh Gemini. */
/** Vị trí khối chữ trong ảnh - lưới 3x3; "auto" = Poster tự chọn theo tỉ lệ khung */
export const IMAGE_TEXT_POSITIONS = [
  "auto",
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export type ImageTextPosition = (typeof IMAGE_TEXT_POSITIONS)[number];

export interface ImageOverlay {
  title: string;
  subtitle: string;
  stats: ImageStat[];
  cta: string;
  showLogo: boolean;
  position: ImageTextPosition;
}

export interface ImageProject {
  id: string;
  name: string;
  prompt: string;
  kind: ImageKind;
  aspect: ImageAspect;
  status: ImageProjectStatus;
  overlay: ImageOverlay;
  /** Model Gemini tạo ảnh nền - null = model mặc định của server. */
  model: string | null;
  /** Style Design ảnh phải tuân theo - null = style mặc định. */
  styleId: string | null;
  /** relPath ảnh nền (Gemini tạo hoặc upload tay) - phát qua /media. */
  background: string | null;
  /** relPath ảnh hoàn thiện (Remotion compose) - phát qua /media. */
  final: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ImageGenStep = "all" | "background" | "compose";

// ============ Error & core ============

/**
 * Truy cập đang ở cùng mạng với máy chủ hay không - quyết định có gọi thẳng
 * cổng backend được không. Tunnel/domain công cộng chỉ mở duy nhất cổng web.
 */
function isLocalNetworkHost(host: string): boolean {
  return (
    host === "localhost" ||
    /^127\./.test(host) ||
    /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
      host
    )
  );
}

/**
 * Origin của backend - dùng cho upload file lớn: gọi THẲNG server (CORS đã mở),
 * không qua rewrite proxy của Next (proxy có timeout ~30s, file video lớn sẽ chết).
 *
 * Qua domain công cộng (Cloudflare Tunnel chỉ đưa ra cổng web) thì cổng backend
 * KHÔNG tồn tại trên domain đó, và trang https gọi http còn bị chặn mixed
 * content - nên đi same-origin qua proxy /api của Next (proxyTimeout 10 phút).
 */
export function serverOrigin(): string {
  if (typeof window === "undefined") return "http://localhost:6869";
  if (!isLocalNetworkHost(window.location.hostname)) return window.location.origin;
  const port = process.env.NEXT_PUBLIC_SERVER_PORT || "6869";
  return `http://${window.location.hostname}:${port}`;
}

/**
 * Origin để UPLOAD file từ trang mobile /m. Giữ tên riêng cho rõ ý ở nơi gọi;
 * cách chọn LAN hay tunnel nay nằm hết trong serverOrigin().
 */
export function uploadOrigin(): string {
  return serverOrigin();
}

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

// ============ Token truy cập backend ============

/**
 * Backend (6869) mở cho cả LAN để điện thoại upload được, nên nó đòi token cho
 * MỌI request không đến trực tiếp từ chính máy chủ. Dashboard lấy token thế này:
 *
 * 1. `?t=<token>` trên URL (mở dashboard từ xa qua Cloudflare Tunnel) → lưu lại.
 * 2. localStorage (đã lấy được ở lần trước).
 * 3. Gọi THẲNG `${serverOrigin()}/api/health` - request loopback trực tiếp
 *    (không qua proxy Next) nên backend trả kèm `apiToken`. Chỉ trình duyệt
 *    chạy trên chính máy chủ mới lấy được.
 *
 * Token được gắn vào: header `x-aiev-token` (mọi fetch) VÀ cookie `aiev_token`
 * (để <img>/<video>/EventSource - thứ không set được header - vẫn qua được).
 *
 * Trang /m trên điện thoại KHÔNG dùng token này: nó đi bằng token phiên QR
 * (`?k=`) mà backend chỉ cho xem project + upload asset.
 */
const TOKEN_KEY = "aiev_api_token";
/** Tên cookie PHẢI khớp với middleware xác thực của backend (index.ts) */
const TOKEN_COOKIE = "aiev_token";

let apiToken: string | null = null;
let tokenPromise: Promise<string | null> | null = null;

/** Token phiên upload QR trên URL (trang /m) - "" nếu không có. */
function uploadTokenFromUrl(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("k") ?? "";
}

function persistToken(token: string): void {
  apiToken = token;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Safari private mode… - vẫn dùng được token trong phiên này
  }
  // Cookie để img/video/EventSource (không set header được) qua được middleware
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

async function ensureToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (apiToken) return apiToken;
  // Trang mobile /m: dùng ?k=, không có quyền lấy token chung
  if (uploadTokenFromUrl()) return null;
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("t");
    if (fromUrl) {
      persistToken(fromUrl);
      // Bỏ token khỏi thanh địa chỉ sau khi đã lưu (tránh lộ qua ảnh chụp/referrer)
      params.delete("t");
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash
      );
      return fromUrl;
    }
    try {
      const stored = window.localStorage.getItem(TOKEN_KEY);
      if (stored) {
        persistToken(stored); // set lại cookie (có thể đã hết hạn/bị xóa)
        return stored;
      }
    } catch {
      /* bỏ qua */
    }
    try {
      const res = await fetch(`${serverOrigin()}/api/health`, { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { apiToken?: string };
        if (body?.apiToken) {
          persistToken(body.apiToken);
          return body.apiToken;
        }
      }
    } catch {
      // Không gọi thẳng backend được (mở dashboard qua tunnel) - cần ?t=
    }
    tokenPromise = null; // cho phép thử lại ở request sau
    return null;
  })();

  return tokenPromise;
}

/** Thêm `k=<token QR>` vào URL khi đang ở trang /m (mọi request phải mang token). */
function withUploadToken(path: string): string {
  const k = uploadTokenFromUrl();
  if (!k) return path;
  return path + (path.includes("?") ? "&" : "?") + `k=${encodeURIComponent(k)}`;
}

/**
 * Token đã lưu không còn khớp server (cài lại có .env mới, .env không ghi được
 * nên mỗi lần chạy sinh token khác…): bỏ nó đi để ensureToken() hỏi lại
 * /api/health. Không bỏ thì localStorage giữ token chết mãi và mọi request,
 * ảnh, SSE đều 401 cho tới khi người dùng tự xóa dữ liệu trang.
 */
function dropToken(): void {
  apiToken = null;
  tokenPromise = null;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* bỏ qua */
  }
}

async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const token = await ensureToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("x-aiev-token", token);

  let res: Response;
  try {
    res = await fetch(withUploadToken(path), { ...init, headers });
  } catch {
    throw new ApiError(
      "network",
      "Không kết nối được backend (port 6869). Kiểm tra server đã chạy chưa.",
      0
    );
  }
  if (res.status === 401 && token && !retried && !uploadTokenFromUrl()) {
    dropToken();
    return request<T>(path, init, true);
  }
  if (!res.ok) {
    let code = String(res.status);
    let message = `Lỗi HTTP ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { code: string; message: string };
      };
      if (body?.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // body không phải JSON - giữ message mặc định
    }
    throw new ApiError(code, message, res.status);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function jsonBody<T>(
  path: string,
  method: "PUT" | "PATCH",
  body: unknown
): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ============ Health & Dashboard ============

export const getHealth = () => request<Health>("/api/health");
export const getOverview = () => request<Overview>("/api/overview");

// ============ Update (cập nhật hệ thống từ GitHub) ============

/** Một commit sắp được kéo về - hiện trong danh sách "Có gì mới" của popup. */
export interface UpdateCommit {
  hash: string;
  message: string;
}

/**
 * Kênh cập nhật:
 * - "stable" = chỉ nhận bản đã phát hành (release tag), khuyên dùng.
 * - "latest" = mọi commit đẩy lên main, có fix sớm nhưng có thể chưa ổn định.
 */
export type UpdateChannel = "stable" | "latest";

export interface UpdateStatus {
  /** Short hash HEAD hiện tại ("" nếu server check lỗi). */
  current: string;
  /** Tag release gần nhất tính từ HEAD, vd "v1.0.0" - null khi chưa có tag nào. */
  currentVersion: string | null;
  /** Tag release mới nhất trên remote - null khi kho chưa phát hành bản nào. */
  latestVersion: string | null;
  /** Kênh mà lần check này đã dùng. */
  channel: UpdateChannel;
  /** Số commit đang thua bản đích (release mới nhất hoặc origin/main). */
  behind: number;
  upToDate: boolean;
  latestMessage: string | null;
  /** Commit sắp về, mới nhất trước (tối đa 10) - rỗng khi đã mới nhất. */
  commits?: UpdateCommit[];
  checkedAt: string;
  /** false khi `git fetch origin` thất bại - behind tính theo refs cũ. */
  fetchOk?: boolean;
  /** true khi kênh là "stable" nhưng kho chưa có tag nào nên phải so với main. */
  fellBackToMain?: boolean;
  /** Lỗi ngắn khi check thất bại (offline…) - server không bao giờ 500. */
  error?: string;
}

/** Bước script update đang chạy - server đọc từ mốc `[STEP] <tên>` trong log. */
export type UpdateStep = "pull" | "stop" | "install" | "restart";

/** Đuôi start/update.log của LẦN CHẠY GẦN NHẤT - /api/update/log. */
export interface UpdateLog {
  exists: boolean;
  lines: string[];
  step: UpdateStep | null;
  /** Dòng mốc mở đầu lần chạy (server trả nguyên văn, không phải ISO). */
  startedAt: string | null;
  error?: string;
}

export const checkUpdate = (force = false) =>
  request<UpdateStatus>(`/api/update/check${force ? "?force=1" : ""}`);

/**
 * Đuôi log cập nhật. VÌ SAO cần: script update chạy detached và tự kill server
 * này nên không thể đẩy tiến trình qua SSE - UI poll log lúc server còn sống
 * (bước pull) và gọi lại một lần khi server hồi sinh để lấy kết quả thật.
 */
export const getUpdateLog = (tail = 200) =>
  request<UpdateLog>(`/api/update/log?tail=${tail}`);

/** 202 khi đã spawn script update; 409 JOB_RUNNING khi đang có job render. */
export const applyUpdate = () =>
  post<{ ok: true; logHint: string }>("/api/update/apply");

// ============ Usage (token AI) ============

export const getUsageSummary = () =>
  request<UsageSummary>("/api/usage/summary");

/** Timeline token theo ngày - scope lọc theo loại project (bỏ qua = all). */
export const getUsageTimeline = (days = 30, scope?: UsageScope) =>
  request<UsageTimelinePoint[]>(
    `/api/usage/timeline?days=${days}${scope && scope !== "all" ? `&scope=${scope}` : ""}`
  );

/** Token + chi phí gộp theo model - bảng "Chi phí AI theo model" trên Dashboard. */
export const getUsageByModel = (days = 30) =>
  request<UsageByModel[]>(`/api/usage/by-model?days=${days}`);

// ============ Projects ============

export const getProjects = () => request<ProjectSummary[]>("/api/projects");

export const createProject = (input: {
  /** Bỏ trống → server tự sinh từ name (bỏ dấu tiếng Việt, kebab-case). */
  id?: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  tags?: string[];
}) => post<ProjectSummary>("/api/projects", input);

export const getProject = (id: string) =>
  request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`);

/**
 * POST nhân bản project - server copy compositions/assets (kèm mô tả)/brief/tags/scenes,
 * BỎ renders + output; project mới ở trạng thái draft, id tự sinh từ name.
 * name bỏ trống → server dùng "<tên cũ> (bản sao)".
 */
export const cloneProject = (id: string, name?: string) =>
  post<ProjectSummary>(
    `/api/projects/${encodeURIComponent(id)}/clone`,
    name && name.trim() ? { name: name.trim() } : {}
  );

export const deleteProject = (id: string) =>
  request<void>(`/api/projects/${encodeURIComponent(id)}?force=true`, {
    method: "DELETE",
  });

/** PUT brief (partial được - server merge). */
export const updateBrief = (id: string, brief: Partial<Brief>) =>
  jsonBody<Brief>(
    `/api/projects/${encodeURIComponent(id)}/brief`,
    "PUT",
    brief
  );

/** PUT thay toàn bộ tags của project. */
export const updateProjectTags = (id: string, tags: string[]) =>
  jsonBody<{ tags: string[] }>(
    `/api/projects/${encodeURIComponent(id)}/tags`,
    "PUT",
    { tags }
  );

/**
 * PUT đổi TÊN HIỂN THỊ của project (meta.name). `id` là tên thư mục nên KHÔNG
 * đổi theo - đường dẫn video-projects/<id> giữ nguyên.
 * 400 INVALID_NAME khi tên rỗng sau khi trim hoặc dài quá 120 ký tự.
 */
export const renameProject = (id: string, name: string) =>
  jsonBody<ProjectSummary>(
    `/api/projects/${encodeURIComponent(id)}/name`,
    "PUT",
    { name }
  );

/** PUT mô tả một asset của project. */
export const updateAssetDescription = (
  projectId: string,
  file: string,
  description: string
) =>
  jsonBody<FileInfo>(
    `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(file)}/description`,
    "PUT",
    { description }
  );

/**
 * POST tạo thumbnail cho video project - chạy ĐỒNG BỘ (~1 phút: ffmpeg cắt
 * frame + Gemini vẽ nền theo Style Design + Remotion still). Trả 201 khi
 * video-projects/<id>/thumbnail.png đã ghi xong.
 */
export const createThumbnail = (
  id: string,
  input: { title: string; frameAt?: number; bgPrompt?: string }
) =>
  post<{ file: string; relPath: string }>(
    `/api/projects/${encodeURIComponent(id)}/thumbnail`,
    input
  );

/** Một mục file rác - relPath từ repo root, thư mục kết thúc bằng "/". */
export interface JunkItem {
  relPath: string;
  size: number;
}

export interface ProjectJunk {
  items: JunkItem[];
  totalBytes: number;
}

/** GET danh sách file rác (file trung gian sau khi xuất final) của project. */
export const getProjectJunk = (id: string) =>
  request<ProjectJunk>(`/api/projects/${encodeURIComponent(id)}/junk`);

/**
 * POST xóa file rác của project - renders/verify/cache, props.resolved.json,
 * draft lắp ráp và staging Remotion. File nguồn + video final giữ nguyên.
 * Project đang có job chạy/chờ → lỗi 409 JOB_RUNNING.
 */
export const cleanProjectJunk = (id: string) =>
  post<{ freedBytes: number; deleted: number }>(
    `/api/projects/${encodeURIComponent(id)}/junk/clean`
  );

/** DELETE một asset của project - xóa file + entry mô tả/màu trong assets.json. */
export const deleteProjectAsset = (projectId: string, file: string) =>
  request<void>(
    `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(file)}`,
    { method: "DELETE" }
  );

/**
 * Sinh ảnh preview các preset màu cho một video của project.
 * POST (dù là "get") vì server phải render 6 ảnh - mất vài giây.
 */
export const getGradePreviews = (projectId: string, file: string) =>
  post<GradePreviewResult>(
    `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(file)}/grade-preview`
  );

/**
 * Render MỘT frame chính xác theo preset + thông số chỉnh tay - phục vụ preview
 * lớn khi kéo slider. Server cache theo tham số nên gọi lại nhanh.
 */
export const renderGradeFrame = (
  projectId: string,
  file: string,
  preset: string | null,
  adjust: GradeAdjust
) =>
  post<{ relPath: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(file)}/grade-frame`,
    { preset, adjust }
  );

/**
 * PUT preset chỉnh màu cho asset video - preset null = bỏ chỉnh màu.
 * adjust mặc định thì server tự bỏ (không lưu colorAdjust).
 */
export const setAssetGrade = (
  projectId: string,
  file: string,
  preset: string | null,
  adjust?: GradeAdjust
) =>
  jsonBody<{
    file: string;
    colorGrade: string | null;
    colorAdjust: GradeAdjust | null;
  }>(
    `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(file)}/grade`,
    "PUT",
    adjust ? { preset, adjust } : { preset }
  );

/**
 * Bắt đầu edit bằng AI - server tự soạn prompt từ brief + assets, trả sessionId chat.
 * model/effort (tùy chọn) lưu vào session - mọi lượt chạy sau dùng đúng model đó.
 */
export const startProjectEdit = (
  id: string,
  extraNotes?: string,
  opts?: { model?: string; effort?: AgentEffort }
) =>
  post<{ sessionId: string }>(`/api/projects/${encodeURIComponent(id)}/edit`, {
    ...(extraNotes && extraNotes.trim()
      ? { extraNotes: extraNotes.trim() }
      : {}),
    ...(opts?.model ? { model: opts.model } : {}),
    ...(opts?.effort ? { effort: opts.effort } : {}),
  });

// ============ Jobs ============

/** Danh sách job - `projectId` lọc phía server qua `?projectId=` (tùy chọn). */
export const getJobs = (limit = 50, projectId?: string) =>
  request<Job[]>(
    `/api/jobs?limit=${limit}${
      projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""
    }`
  );

export const getJob = (id: string) =>
  request<JobWithLog>(`/api/jobs/${encodeURIComponent(id)}`);

export const createJob = (input: {
  projectId: string;
  type: JobType;
  sceneId?: string;
}) => post<Job>("/api/jobs", input);

export const cancelJob = (id: string) =>
  post<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`);

// ============ Skills ============

export const getSkills = () => request<SkillMeta[]>("/api/skills");

export const getSkill = (name: string) =>
  request<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`);

export const createSkill = (input: { name: string; content: string }) =>
  post<SkillDetail>("/api/skills", input);

export const updateSkill = (name: string, content: string) =>
  request<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

export const deleteSkill = (name: string) =>
  request<void>(`/api/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });

// ============ Tạo skill bằng AI ============

/** Body POST /api/skills/generate - mọi field trừ goal đều optional. */
export interface SkillGenerateInput {
  /** Mục đích & loại video - BẮT BUỘC. */
  goal: string;
  /** Tên kebab-case gợi ý; rỗng = AI tự đặt. */
  name?: string;
  /** "TikTok" | "YouTube" | "Facebook" | "Instagram" | tự do. */
  platform?: string;
  aspect?: "9:16" | "16:9" | "1:1" | "4:5";
  fps?: 30 | 60;
  /** vd "30–60s". */
  duration?: string;
  /** Phong cách & nhịp điệu. */
  style?: string;
  captions?: "karaoke" | "sentence" | "none";
  /** Keyword highlight. */
  highlights?: boolean;
  /** Sound effect đồng bộ timestamp. */
  sfx?: boolean;
  /** Tên skill có sẵn làm mẫu - server nhúng nội dung vào prompt. */
  baseSkill?: string;
  notes?: string;
}

export interface SkillGenerateResult {
  name: string;
  content: string;
  tokens: { input: number; output: number };
}

/**
 * Lỗi tạo skill bằng AI. 422 BAD_SKILL_OUTPUT kèm `raw` = văn bản gốc AI
 * trả về - UI đưa cho user tự sửa tay rồi lưu.
 */
export class SkillGenerateError extends ApiError {
  raw: string | null;

  constructor(code: string, message: string, status: number, raw: string | null) {
    super(code, message, status);
    this.name = "SkillGenerateError";
    this.raw = raw;
  }
}

/**
 * POST /api/skills/generate - Claude soạn draft SKILL.md (KHÔNG ghi file).
 * Gọi THẲNG server origin (như upload) vì có thể chạy 1–3 phút - proxy Next
 * có timeout sẽ cắt ngang. Lỗi ném SkillGenerateError (422 kèm raw).
 */
export async function generateSkill(
  input: SkillGenerateInput
): Promise<SkillGenerateResult> {
  let res: Response;
  const token = await ensureToken();
  try {
    res = await fetch(`${serverOrigin()}/api/skills/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-aiev-token": token } : {}),
      },
      body: JSON.stringify(input),
    });
  } catch {
    throw new SkillGenerateError(
      "network",
      "Không kết nối được backend (port 6869). Kiểm tra server đã chạy chưa.",
      0,
      null
    );
  }
  if (!res.ok) {
    let code = String(res.status);
    let message = `Lỗi HTTP ${res.status}`;
    let raw: string | null = null;
    try {
      const body = (await res.json()) as {
        error?: { code: string; message: string; raw?: string };
        raw?: string;
      };
      if (body?.error) {
        code = body.error.code;
        message = body.error.message;
      }
      const r = body?.raw ?? body?.error?.raw;
      if (typeof r === "string" && r) raw = r;
    } catch {
      // body không phải JSON - giữ message mặc định
    }
    throw new SkillGenerateError(code, message, res.status, raw);
  }
  return (await res.json()) as SkillGenerateResult;
}

// ============ Prompt mẫu ============

export const getPrompts = () => request<PromptTemplate[]>("/api/prompts");

export const createPrompt = (input: { name: string; content: string }) =>
  post<PromptTemplate>("/api/prompts", input);

export const updatePrompt = (
  id: string,
  patch: { name?: string; content?: string }
) =>
  jsonBody<PromptTemplate>(
    `/api/prompts/${encodeURIComponent(id)}`,
    "PUT",
    patch
  );

export const deletePrompt = (id: string) =>
  request<void>(`/api/prompts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

// ============ Sound Effects ============

export const getSfx = () => request<SfxEntry[]>("/api/sfx");

export const uploadSfx = (file: File, tags: string, description: string) => {
  const form = new FormData();
  form.append("file", file);
  form.append("tags", tags);
  form.append("description", description);
  return request<SfxEntry>(`${serverOrigin()}/api/sfx`, { method: "POST", body: form });
};

/** PATCH sound effect - recommended=true/false thêm/gỡ tag "hay-dung". */
export const patchSfx = (
  file: string,
  patch: { description?: string; tags?: string[]; recommended?: boolean }
) => jsonBody<SfxEntry>(`/api/sfx/${encodeURIComponent(file)}`, "PATCH", patch);

export const deleteSfx = (file: string) =>
  request<void>(`/api/sfx/${encodeURIComponent(file)}`, { method: "DELETE" });

// ============ Nhạc nền (Music) ============

export const getMusic = () => request<MusicEntry[]>("/api/music");

export const uploadMusic = (file: File, tags: string, description: string) => {
  const form = new FormData();
  form.append("file", file);
  form.append("tags", tags);
  form.append("description", description);
  return request<MusicEntry>(`${serverOrigin()}/api/music`, { method: "POST", body: form });
};

export const patchMusic = (
  file: string,
  patch: { description?: string; tags?: string[] }
) => jsonBody<MusicEntry>(`/api/music/${encodeURIComponent(file)}`, "PATCH", patch);

export const deleteMusic = (file: string) =>
  request<void>(`/api/music/${encodeURIComponent(file)}`, { method: "DELETE" });

// ============ Assets ============

export type AssetScope = "imports" | "outputs" | "project";

export const getAssets = (scope: AssetScope, projectId?: string) => {
  const qs = new URLSearchParams({ scope });
  if (projectId) qs.set("projectId", projectId);
  return request<FileInfo[]>(`/api/assets?${qs.toString()}`);
};

export const uploadAsset = (
  file: File,
  scope: AssetScope,
  projectId?: string
) => {
  const form = new FormData();
  // scope/projectId TRƯỚC file - server đọc projectId từ đầu stream để phát
  // SSE `upload` progress lọc được theo project
  form.append("scope", scope);
  if (projectId) form.append("projectId", projectId);
  form.append("file", file);
  return request<FileInfo>(`${serverOrigin()}/api/assets`, { method: "POST", body: form });
};

// ============ Chat ============

/** Danh sách phiên chat - truyền projectId để chỉ lấy phiên của project đó. */
export const getChatSessions = (projectId?: string) =>
  request<ChatSession[]>(
    projectId
      ? `/api/chat/sessions?projectId=${encodeURIComponent(projectId)}`
      : "/api/chat/sessions"
  );

export const getChatMessages = (sessionId: string) =>
  request<ChatMessage[]>(
    `/api/chat/${encodeURIComponent(sessionId)}/messages`
  );

/**
 * Gửi tin nhắn - projectId chỉ dùng khi tạo session mới (gắn session vào project).
 * model/effort cũng chỉ có tác dụng lúc tạo session mới - lưu vào session.
 */
export const sendChat = (
  message: string,
  sessionId?: string,
  projectId?: string,
  opts?: { model?: string; effort?: AgentEffort }
) =>
  post<{ sessionId: string }>("/api/chat", {
    message,
    sessionId,
    projectId,
    ...(opts?.model ? { model: opts.model } : {}),
    ...(opts?.effort ? { effort: opts.effort } : {}),
  });

export const interruptChat = (sessionId: string) =>
  post<void>(`/api/chat/${encodeURIComponent(sessionId)}/interrupt`);

/** Bật/tắt tự chạy tiếp khi phiên bị lỗi/gián đoạn. */
export const setChatAutoResume = (sessionId: string, enabled: boolean) =>
  jsonBody<void>(
    `/api/chat/${encodeURIComponent(sessionId)}/auto-resume`,
    "PUT",
    { enabled }
  );

// ============ AI Providers ============

export const getProviders = () =>
  request<{ providers: Provider[] }>("/api/providers");

/** Kết quả GET /api/providers/gemini/image-models. */
export interface GeminiImageModels {
  /** google = danh sách live mới nhất; static = fallback khi chưa có key / lỗi mạng. */
  source: "google" | "static";
  models: ProviderModel[];
}

/**
 * Danh sách model ảnh Gemini MỚI NHẤT - KHÔNG cache phía client (server đã cache 1h)
 * để mỗi lần mở select đều nhận được model mới Google vừa phát hành.
 */
export const getGeminiImageModels = () =>
  request<GeminiImageModels>("/api/providers/gemini/image-models");

/** Kết quả GET /api/providers/claude/models. */
export interface ClaudeModels {
  /** anthropic = danh sách live từ Models API; static = fallback (chỉ OAuth / lỗi mạng). */
  source: "anthropic" | "static";
  models: ProviderModel[];
}

/**
 * Danh sách model Claude MỚI NHẤT - server cache 10 phút; chưa fetch xong
 * thì UI dùng danh sách tĩnh từ /api/providers.
 */
export const getClaudeModels = () =>
  request<ClaudeModels>("/api/providers/claude/models");

// ============ Kết nối (API key providers) ============

export const getConnections = () =>
  request<{ connections: ConnectionInfo[] }>("/api/connections");

/** PUT key mới (apiKey null = xóa key). Hiệu lực ngay, không cần restart. */
export const setConnectionKey = (provider: string, apiKey: string | null) =>
  jsonBody<{ connections: ConnectionInfo[] }>(
    `/api/connections/${encodeURIComponent(provider)}/key`,
    "PUT",
    { apiKey }
  );

/** Gọi thử API thật của provider - kiểm tra kết nối. */
export const testConnection = (provider: string) =>
  post<{ ok: boolean; message: string }>(
    `/api/connections/${encodeURIComponent(provider)}/test`
  );

// ============ Style Design ============

export const getStyles = () => request<StylesResponse>("/api/styles");

/** Tạo style mới - cloneFrom = id style muốn sao chép toàn bộ (bỏ qua = trống). */
export const createStyle = (input: {
  name: string;
  tags?: string[];
  cloneFrom?: string;
}) => post<StyleDesign>("/api/styles", input);

/** PUT partial (name/tags/colors/fonts/effects/tone/guidelines) - server merge. */
export const updateStyle = (
  id: string,
  patch: Partial<
    Pick<
      StyleDesign,
      "name" | "tags" | "colors" | "fonts" | "effects" | "tone" | "guidelines"
    >
  >
) =>
  jsonBody<StyleDesign>(`/api/styles/${encodeURIComponent(id)}`, "PUT", patch);

/** Xóa style - server cấm xóa style cuối cùng (400). */
export const deleteStyle = (id: string) =>
  request<void>(`/api/styles/${encodeURIComponent(id)}`, { method: "DELETE" });

export const setDefaultStyle = (id: string) =>
  post<{ defaultId: string }>(
    `/api/styles/${encodeURIComponent(id)}/default`
  );

/** Upload logo cho style (multipart) - gọi thẳng server như uploadAsset. */
export const uploadStyleLogo = (id: string, file: File) => {
  const form = new FormData();
  form.append("file", file);
  return request<StyleDesign>(
    `${serverOrigin()}/api/styles/${encodeURIComponent(id)}/logo`,
    { method: "POST", body: form }
  );
};

/** Upload font (.ttf/.otf/.woff/.woff2) cho một slot của style. */
export const uploadStyleFont = (id: string, slot: StyleFontSlot, file: File) => {
  const form = new FormData();
  form.append("file", file);
  return request<StyleDesign>(
    `${serverOrigin()}/api/styles/${encodeURIComponent(id)}/font?slot=${slot}`,
    { method: "POST", body: form }
  );
};

/**
 * Tải font từ Google Fonts theo TÊN (server tải file TTF trọn bộ glyph tiếng
 * Việt, set luôn fonts[slot] + fontFiles[slot]). Lỗi: 404 FONT_NOT_FOUND
 * (sai tên), 502 (mạng).
 */
export const styleFontGoogle = (id: string, slot: StyleFontSlot, family: string) =>
  post<StyleDesign>(`/api/styles/${encodeURIComponent(id)}/font-google`, {
    slot,
    family,
  });

/** Gỡ font một slot của style - quay về font hệ thống. */
export const deleteStyleFont = (id: string, slot: StyleFontSlot) =>
  request<StyleDesign>(
    `/api/styles/${encodeURIComponent(id)}/font/${slot}`,
    { method: "DELETE" }
  );

// ============ Image Projects (tạo ảnh AI) ============

export const getImageProjects = () =>
  request<ImageProject[]>("/api/images");

export const createImageProject = (input: {
  name: string;
  prompt: string;
  kind: ImageKind;
  aspect: ImageAspect;
  overlay?: Partial<ImageOverlay>;
  /** Model Gemini tạo nền - bỏ qua = server dùng mặc định. */
  model?: string | null;
  /** Style Design áp cho ảnh - bỏ qua/null = style mặc định. */
  styleId?: string | null;
}) => post<ImageProject>("/api/images", input);

export const getImageProject = (id: string) =>
  request<ImageProject>(`/api/images/${encodeURIComponent(id)}`);

export const updateImageProject = (
  id: string,
  patch: Partial<
    Pick<
      ImageProject,
      "name" | "prompt" | "kind" | "aspect" | "overlay" | "model" | "styleId"
    >
  >
) =>
  jsonBody<ImageProject>(`/api/images/${encodeURIComponent(id)}`, "PUT", patch);

/**
 * Đổi TÊN project ảnh, KHÔNG đụng id (id là tên thư mục, bị tham chiếu trong
 * đường dẫn ảnh và projectId của job) - đúng nguyên tắc của renameProject.
 */
export const renameImageProject = (id: string, name: string) =>
  updateImageProject(id, { name });

/** Nhân bản project ảnh - giữ nền và mọi cài đặt, bỏ ảnh hoàn thiện. */
export const cloneImageProject = (id: string, name?: string) =>
  post<ImageProject>(
    `/api/images/${encodeURIComponent(id)}/clone`,
    name && name.trim() ? { name: name.trim() } : {}
  );

export const deleteImageProject = (id: string) =>
  request<void>(`/api/images/${encodeURIComponent(id)}`, { method: "DELETE" });

/** GET danh sách file rác của image project (props.json + staging Remotion). */
export const getImageJunk = (id: string) =>
  request<ProjectJunk>(`/api/images/${encodeURIComponent(id)}/junk`);

/**
 * POST xóa file rác của image project - props.json và staging Remotion img-<id>.
 * Ảnh nền, final.png và meta giữ nguyên. Project đang có job chạy/chờ → 409 JOB_RUNNING.
 */
export const cleanImageJunk = (id: string) =>
  post<{ freedBytes: number; deleted: number }>(
    `/api/images/${encodeURIComponent(id)}/junk/clean`
  );

/** Upload ảnh nền thủ công (multipart) - thay cho bước Gemini. */
export const uploadImageBackground = (id: string, file: File) => {
  const form = new FormData();
  form.append("file", file);
  return request<ImageProject>(
    `${serverOrigin()}/api/images/${encodeURIComponent(id)}/background`,
    { method: "POST", body: form }
  );
};

/** Chạy pipeline tạo ảnh - trả Job (queue type "image-gen", projectId = id ảnh). */
export const generateImage = (id: string, step?: ImageGenStep) =>
  post<Job>(
    `/api/images/${encodeURIComponent(id)}/generate`,
    step ? { step } : {}
  );

// ============ Kết nối điện thoại (LAN) ============

/** GET /api/lan-info - IP LAN của máy chạy server + port web, cho QR "Kết nối điện thoại". */
export interface LanInfo {
  /** IPv4 non-internal, đã ưu tiên dải 192.168/10. lên đầu. */
  ips: string[];
  webPort: number;
  /** Domain Cloudflare Tunnel (TUNNEL_DOMAIN trong .env, đã bỏ protocol) - null nếu chưa cấu hình. */
  tunnelDomain: string | null;
}

export const getLanInfo = () => request<LanInfo>("/api/lan-info");

/**
 * Phiên upload cho QR "Kết nối điện thoại" - token gắn vào URL (?k=) và
 * field `token` của FormData upload. Đóng modal → revoke → link hết hiệu lực.
 */
export interface UploadSession {
  /** Token dạng ut_<nanoid> - server giữ trong RAM, TTL 60 phút. */
  token: string;
  /** ISO - hạn của token (server tự dọn khi quá hạn). */
  expiresAt: string;
}

/** POST /api/upload-session - tạo token upload cho project (mở modal QR). */
export const createUploadSession = (projectId: string) =>
  post<UploadSession>("/api/upload-session", { projectId });

/** DELETE /api/upload-session/:token - thu hồi ngay (đóng modal QR). Idempotent. */
export const revokeUploadSession = (token: string) =>
  request<void>(`/api/upload-session/${encodeURIComponent(token)}`, {
    method: "DELETE",
  });

// ============ Cloudflare Tunnel (trang Kết nối) ============

/** GET /api/tunnel - trạng thái cloudflared + tunnel đang chạy. */
export interface TunnelStatus {
  /** cloudflared có trên PATH của máy chạy server không. */
  installed: boolean;
  running: boolean;
  /** true = tunnel do modal QR bật lên, sẽ tự tắt khi đóng modal / hết phiên upload. */
  auto: boolean;
  /** named = có TUNNEL_DOMAIN; quick = URL ngẫu nhiên trycloudflare.com. Null khi không chạy. */
  mode: "named" | "quick" | null;
  /** URL public đang hoạt động (https://…) - null khi không chạy / quick chưa parse được. */
  url: string | null;
  /** TUNNEL_DOMAIN trong .env (đã chuẩn hóa) - null nếu chưa cấu hình. */
  domain: string | null;
  /** ≤20 dòng log cloudflared cuối cùng. */
  lastLog: string[];
}

export const getTunnelStatus = () => request<TunnelStatus>("/api/tunnel");

/** PUT domain (rỗng/null = xóa TUNNEL_DOMAIN). Ghi .env, hiệu lực ngay. */
export const setTunnelDomain = (domain: string | null) =>
  jsonBody<TunnelStatus>("/api/tunnel/domain", "PUT", { domain });

/**
 * Bật tunnel - 409 NOT_INSTALLED nếu chưa cài cloudflared, 409 nếu đang chạy.
 * `auto` = bật từ modal QR: server đánh dấu để tự tắt khi đóng modal / hết phiên upload.
 */
export const startTunnel = (auto = false) =>
  post<{ mode: "named" | "quick"; auto: boolean }>("/api/tunnel/start", { auto });

/**
 * Tắt tunnel (kill cả cây cloudflared) → 204.
 * `onlyAuto` = chỉ tắt nếu tunnel do modal QR bật - tránh tắt nhầm tunnel người
 * dùng tự bật ở trang Kết nối để vào dashboard từ xa.
 */
export const stopTunnel = (onlyAuto = false) =>
  post<void>("/api/tunnel/stop", { onlyAuto });

/**
 * Dọn dẹp lúc TAB BỊ ĐÓNG ĐỘT NGỘT: thu hồi token upload + tắt tunnel của modal.
 *
 * Không dùng được hàm request() ở đây - fetch thường bị hủy ngay khi trang chết.
 * `keepalive` bảo trình duyệt cứ gửi nốt. sendBeacon không dùng được vì cần
 * method DELETE và header token.
 */
export function closePhoneSessionOnUnload(uploadToken: string | null, stopAuto: boolean): void {
  // Token đã nạp sẵn từ trước (modal chỉ mở được khi dashboard đã xác thực) -
  // lúc trang đang chết thì không kịp await ensureToken()
  const token = apiToken;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["x-aiev-token"] = token;
  if (uploadToken) {
    void fetch(`/api/upload-session/${encodeURIComponent(uploadToken)}`, {
      method: "DELETE",
      headers,
      keepalive: true,
    }).catch(() => {});
  }
  if (stopAuto) {
    void fetch("/api/tunnel/stop", {
      method: "POST",
      headers,
      body: JSON.stringify({ onlyAuto: true }),
      keepalive: true,
    }).catch(() => {});
  }
}

// ============ Media helper ============

/**
 * Mở file trong Explorer/Finder trên máy chạy server (chọn đúng file).
 * relPath tính từ repo root - whitelist thư mục như /media, 404 nếu không tồn tại.
 */
export const revealFile = (relPath: string) =>
  post<void>("/api/reveal", { relPath });

/**
 * Đường dẫn phát file qua backend, relPath tính từ repo root. Phòng thủ với dữ
 * liệu lệch kiểu (AI ghi meta sai hợp đồng).
 * Xác thực: dashboard đi bằng cookie `aiev_token` (ensureToken đã set trước khi
 * dữ liệu về); trang /m trên điện thoại gắn thêm `?k=` của phiên QR.
 */
export const mediaUrl = (relPath: string) =>
  withUploadToken(
    `/media/${String(relPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "")}`
  );

/**
 * URL ảnh của image project - meta lưu TÊN FILE trần (background.png/final.png),
 * phải ghép image-projects/<id>/ vào trước khi qua /media.
 * `version` (updatedAt) để cache-bust: file trùng tên khi tạo lại, không có ?v
 * trình duyệt sẽ hiện ảnh CŨ trong cache.
 */
export const imageFileUrl = (projectId: string, file: string, version?: string | number) =>
  mediaUrl(`image-projects/${projectId}/${file}`) +
  (version !== undefined ? `?v=${encodeURIComponent(String(version))}` : "");

// ================= QC tự động + Gói xuất bản =================

/**
 * Cổng QC trong render settings. Khai báo bằng declaration merging (TypeScript
 * gộp interface trùng tên trong cùng module) để phần QC tự gói gọn ở đây, không
 * phải sửa khối RenderSettings phía trên.
 */
export interface RenderSettings {
  /** true (mặc định) = job assemble-final bị chặn khi report QC còn "fail". */
  qcGate: boolean;
}

/** Kết cục một phép đo QC: đạt / cảnh báo / không đạt. */
export type QcStatus = "pass" | "warn" | "fail";

/** Nền tảng dùng để chọn vùng an toàn (chữ không bị UI app che). */
export type QcPlatform = "tiktok" | "youtube" | "reels";

export interface QcCheck {
  id: string;
  label: string;
  status: QcStatus;
  detail: string;
  /** Số đo chính của check (LUFS, số frame đen…) - null khi không đo được. */
  value?: number | null;
  /**
   * Ảnh bằng chứng (relPath repo, xem qua mediaUrl). Check `safe-area` dùng:
   * máy không phân biệt được chữ với cảnh quay nên trả ảnh khoanh đỏ vùng bị
   * UI che để người dùng tự soi.
   */
  frames?: string[];
}

export interface QcReport {
  checkedAt: string;
  /** relPath từ repo root của file đã đo. */
  file: string;
  /** mtime file lúc đo - server so với mtime hiện tại để biết report cũ. */
  fileMtime: string;
  platform: string;
  status: QcStatus;
  checks: QcCheck[];
}

/** GET /api/projects/:id/qc - stale=true khi file đã render lại sau lần đo. */
export interface QcReportResponse {
  report: QcReport | null;
  stale?: boolean;
}

export const getQcReport = (projectId: string) =>
  request<QcReportResponse>(`/api/projects/${encodeURIComponent(projectId)}/qc`);

/**
 * POST chạy QC - ĐỒNG BỘ, ffmpeg đo cả video nên có thể mất vài chục giây tới
 * ~2 phút (server tự cắt ở 10 phút). Đi qua rewrite /api của Next vì
 * next.config đã nâng proxyTimeout lên 10 phút - đủ cho lượt đo dài nhất.
 * Lỗi: 400 NO_VIDEO, 404 FILE_NOT_FOUND, 504 QC_TIMEOUT.
 */
export const runProjectQc = (
  projectId: string,
  input?: { file?: string; platform?: QcPlatform }
) =>
  post<{ report: QcReport }>(
    `/api/projects/${encodeURIComponent(projectId)}/qc`,
    input ?? {}
  );

/** Nền tảng có metadata đăng bài trong gói xuất bản. */
export type PublishPlatform = "tiktok" | "youtube" | "facebook";

export interface PublishItem {
  platform: PublishPlatform;
  title: string;
  /** Có thể nhiều dòng (mô tả YouTube kèm danh sách chương) - giữ nguyên xuống dòng. */
  description: string;
  hashtags: string[];
}

export interface PublishPack {
  generatedAt: string;
  /** File transcript đã dùng làm nguồn (relPath repo). */
  transcriptRel: string;
  items: PublishItem[];
  /** relPath repo của file phụ đề đã ghi vào video-projects/<id>/publish/. */
  subtitles: { srt: string; vtt: string };
  thumbnail: string | null;
  output: string | null;
}

export const getPublishPack = (projectId: string) =>
  request<{ pack: PublishPack | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/publish`
  );

/**
 * POST soạn gói xuất bản - AI đọc transcript + Style Design, chạy tới ~3 phút.
 * platforms bỏ trống = cả 3 nền tảng. Lỗi: 404 NO_TRANSCRIPT, 502 PUBLISH_PARSE_FAILED.
 */
export const createPublishPack = (
  projectId: string,
  platforms?: PublishPlatform[]
) =>
  post<{ pack: PublishPack }>(
    `/api/projects/${encodeURIComponent(projectId)}/publish`,
    platforms && platforms.length ? { platforms } : {}
  );

/** POST ghi lại .srt/.vtt vào publish/ - trả số cue để UI hiển thị. */
export const createSubtitles = (projectId: string) =>
  post<{ srt: string; vtt: string; cues: number }>(
    `/api/projects/${encodeURIComponent(projectId)}/subtitles`
  );

/**
 * Link TẢI phụ đề - dùng cho <a download>, không qua fetch nên không set được
 * header token: dashboard đi bằng cookie `aiev_token` (ensureToken đã set),
 * trang /m gắn thêm `?k=` giống mediaUrl.
 * `version` để trình duyệt không trả file .srt cũ trong cache sau khi soạn lại.
 */
export const subtitleDownloadUrl = (
  projectId: string,
  format: "srt" | "vtt",
  version?: string
) =>
  withUploadToken(
    `/api/projects/${encodeURIComponent(projectId)}/subtitles?format=${format}` +
      (version ? `&v=${encodeURIComponent(version)}` : "")
  );

// ================= Cắt tự động (auto-trim) =================

/** Một khoảng lặng đo được, tính bằng giây - khớp SilenceRange của server. */
export interface TrimSilenceRange {
  start: number;
  end: number;
  duration: number;
}

/** Bộ số của một mức mạnh tay - khớp TrimProfile (TRIM_PROFILES) của server. */
export interface TrimProfile {
  /** Khoảng lặng ngắn hơn mức này thì để yên (nhịp thở tự nhiên). */
  minSilenceSec: number;
  /** Chừa lại mỗi mép bao nhiêu giây khi cắt. */
  padSec: number;
  /** Sau khi cắt, không khoảng lặng nào được dài hơn mức này. */
  maxResidualSec: number;
  /** Tổng thời gian lặng còn lại tối đa, tính theo tỉ lệ thời lượng. */
  maxResidualRatio: number;
}

/** Kết quả ĐO khoảng lặng của một file - khớp TrimAnalysis của server. */
export interface TrimAnalysis {
  durationSec: number;
  /** Nền nhiễu đo được, không phải hằng số. */
  noiseFloorDb: number;
  thresholdDb: number;
  profile: TrimProfile;
  silences: TrimSilenceRange[];
  keepRanges: Array<[number, number]>;
  removedSec: number;
  /** Vì sao ngưỡng này được chọn (kể cả khi phải chọn bừa). */
  thresholdNote?: string;
  sweep?: Array<{ db: number; count: number; ratio: number; midpointRate: number }>;
  /** Transcript đã phủ quyết bao nhiêu - chỉ có khi project đã bóc băng. */
  wordGuard?: { droppedSec: number; droppedRanges: number };
}

/** Loại mỡ thừa server dò được từ transcript. */
export type DeadWeightKind = "filler" | "stutter" | "repeat-take" | "hesitation";

/** Một ứng viên mỡ thừa - việc DUYỆT là của người/AI, server không tự cắt. */
export interface DeadWeightCandidate {
  kind: DeadWeightKind;
  start: number;
  end: number;
  text: string;
  /** 0..1 - càng cao càng chắc là mỡ thừa. */
  confidence: number;
  /** Tiếng Việt, giải thích vì sao đề xuất cắt. */
  reason: string;
  context: string;
}

export interface DeadWeightReport {
  candidates: DeadWeightCandidate[];
  totalSec: number;
  byKind: Record<DeadWeightKind, { count: number; sec: number }>;
}

/** Nghiệm thu bản đã cắt - khớp TrimVerification của server. */
export interface TrimVerification {
  residual: TrimSilenceRange[];
  totalSilenceSec: number;
  ratio: number;
  longest: number;
  pass: boolean;
  /** Vì sao trượt, tiếng Việt - server soạn sẵn, UI hiện nguyên văn. */
  reason?: string;
}

/** Kết quả POST /api/projects/:id/auto-trim/analyze. */
export interface TrimAnalyzeResult {
  /** Video đã đo, relPath từ repo root. */
  source: string;
  /** Transcript đã dùng làm hàng rào - null = không có, kết quả kém tin cậy hẳn. */
  transcript: string | null;
  guarded: boolean;
  silence: TrimAnalysis;
  deadWeight: DeadWeightReport;
  note: string;
}

/**
 * POST đo khoảng lặng + dò mỡ thừa - ĐỒNG BỘ và KHÔNG encode gì (chỉ bóc một
 * WAV tạm rồi tự dọn), nên gọi lại bao nhiêu lần cũng được. Server tự cắt ở 10
 * phút: 504 TRIM_ANALYZE_TIMEOUT. Lỗi khác: 404 TRIM_SOURCE_NOT_FOUND,
 * 400 PATH_OUTSIDE_PROJECT / INVALID_LEVEL.
 * `level` bỏ trống = lấy theo brief của project.
 */
export const analyzeAutoTrim = (
  projectId: string,
  input?: { source?: string; level?: TrimAggressiveness }
) =>
  post<TrimAnalyzeResult>(
    `/api/projects/${encodeURIComponent(projectId)}/auto-trim/analyze`,
    input ?? {}
  );

/** Kết quả 202 của POST /api/projects/:id/auto-trim/apply. */
export interface AutoTrimApplyResult {
  job: Job;
  level: TrimAggressiveness;
  profile: TrimProfile;
  source: string;
  /** Số ứng viên mỡ thừa đã duyệt mà job sẽ cắt thêm ngoài khoảng lặng. */
  approvedCandidates: number;
}

/**
 * POST cắt thật - đẩy vào render queue (202), KHÔNG chạy đồng bộ.
 * `cutCandidates` là các ứng viên mỡ thừa NGƯỜI/AI ĐÃ DUYỆT; bỏ trống thì job
 * chỉ cắt khoảng lặng đo được. 409 BUSY khi project đang có job chạy/chờ.
 */
export const applyAutoTrim = (
  projectId: string,
  input?: {
    source?: string;
    level?: TrimAggressiveness;
    cutCandidates?: Array<{ start: number; end: number }>;
  }
) =>
  post<AutoTrimApplyResult>(
    `/api/projects/${encodeURIComponent(projectId)}/auto-trim/apply`,
    input ?? {}
  );

/** Báo cáo job auto-trim để lại - khớp AutoTrimReport của server (jobs/autoTrim.ts). */
export interface AutoTrimReport {
  createdAt: string;
  jobId: string;
  level: TrimAggressiveness;
  profile: TrimProfile;
  /** relPath từ repo root. */
  source: string;
  /** null = không cắt được gì nên KHÔNG sinh file mới, các bước sau dùng lại source. */
  output: string | null;
  transcript: { source: string | null; cut: string | null; guarded: boolean };
  duration: { beforeSec: number; afterSec: number | null; removedSec: number };
  /**
   * Bóc tách số giây đã bỏ: `silenceSec` do máy đo, `approvedSec` là phần CỘNG
   * THÊM nhờ ứng viên đã duyệt (đã trừ chỗ chồng lấn nên hai số cộng lại đúng
   * bằng tổng, không đếm hai lần).
   */
  removed: { silenceSec: number; approvedSec: number; ranges: number };
  threshold: { db: number; noiseFloorDb: number; note: string };
  candidates: {
    approved: number;
    /** Ứng viên bị lưới trung điểm chặn - duyệt nhầm chỗ có tiếng nói. */
    rejected: Array<{ start: number; end: number }>;
  };
  verification: TrimVerification & { measuredOn: string; guarded: boolean };
  verdict: "pass" | "fail";
  note: string;
}

/**
 * Báo cáo cắt tự động của project. Job ghi thẳng file vào
 * `video-projects/<id>/assets/auto-trim-report.json` và KHÔNG có endpoint đọc
 * riêng - lấy qua /media như mọi file khác của project (whitelist đã có sẵn
 * prefix video-projects/).
 *
 * Trả null khi chưa chạy cắt tự động lần nào (404) hoặc file hỏng: phần lớn
 * project không có file này nên đó là trạng thái BÌNH THƯỜNG, không phải lỗi.
 * `version` (updatedAt của project) để trình duyệt không trả bản cũ trong cache.
 */
export async function getAutoTrimReport(
  projectId: string,
  version?: string
): Promise<AutoTrimReport | null> {
  const base = mediaUrl(
    `video-projects/${encodeURIComponent(projectId)}/assets/auto-trim-report.json`
  );
  // mediaUrl có thể đã gắn `?k=` (trang /m) - nối tiếp bằng & chứ không phải ?
  const url = version
    ? `${base}${base.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`
    : base;
  try {
    const report = await request<AutoTrimReport>(url);
    return report ?? null;
  } catch {
    return null;
  }
}

// ================= Duyệt draft + Cắt short + Tái chế tỉ lệ =================

/** open = chưa gửi, sent = đã gửi cho AI, resolved = người duyệt đã xác nhận xong. */
export type ReviewNoteStatus = "open" | "sent" | "resolved";

/** Một ghi chú duyệt draft - ghim vào đúng giây trong video. */
export interface ReviewNote {
  id: string;
  /** Mốc thời gian trong video (giây, server làm tròn 2 chữ số). */
  atSec: number;
  text: string;
  status: ReviewNoteStatus;
  createdAt: string;
  /** Chỉ có khi ghi chú đã được gửi cho AI. */
  sentAt?: string;
}

/** Tối đa 500 ký tự - PHẢI khớp MAX_TEXT_LEN của server (routes/review.ts). */
export const REVIEW_TEXT_MAX = 500;

/** Danh sách ghi chú - server đã sắp theo atSec tăng dần. */
export const getReviewNotes = (projectId: string) =>
  request<{ notes: ReviewNote[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/review`
  );

export const addReviewNote = (projectId: string, atSec: number, text: string) =>
  post<{ note: ReviewNote }>(
    `/api/projects/${encodeURIComponent(projectId)}/review`,
    { atSec, text }
  );

/** PATCH partial - field không gửi thì server giữ nguyên. */
export const updateReviewNote = (
  projectId: string,
  noteId: string,
  patch: { text?: string; status?: ReviewNoteStatus }
) =>
  jsonBody<{ note: ReviewNote }>(
    `/api/projects/${encodeURIComponent(projectId)}/review/${encodeURIComponent(noteId)}`,
    "PATCH",
    patch
  );

export const deleteReviewNote = (projectId: string, noteId: string) =>
  request<void>(
    `/api/projects/${encodeURIComponent(projectId)}/review/${encodeURIComponent(noteId)}`,
    { method: "DELETE" }
  );

/**
 * Gửi mọi ghi chú đang "open" cho AI sửa (202 + sessionId của phiên đang dùng lại).
 * Lỗi: 400 NO_OPEN_NOTES, 409 SESSION_BUSY (phiên AI của project đang chạy).
 */
export const sendReviewNotes = (projectId: string, extraNotes?: string) =>
  post<{ sessionId: string; sentCount: number }>(
    `/api/projects/${encodeURIComponent(projectId)}/review/send`,
    extraNotes && extraNotes.trim() ? { extraNotes: extraNotes.trim() } : {}
  );

/** Một đoạn AI gợi ý cắt thành short - start/end là giây tuyệt đối trong video nguồn. */
export interface Clip {
  start: number;
  end: number;
  title: string;
  /** Câu mở đầu, AI copy nguyên văn từ transcript. */
  hook: string;
  reason: string;
  /** 1-10, càng cao càng đáng cắt. */
  score: number;
}

export interface ClipsResponse {
  clips: Clip[];
  /** null = chưa gợi ý lần nào. */
  suggestedAt: string | null;
  sourceDurationSec?: number;
}

export const getClips = (projectId: string) =>
  request<ClipsResponse>(`/api/projects/${encodeURIComponent(projectId)}/clips`);

/**
 * AI đọc transcript rồi chọn đoạn hay - chạy 1-3 phút (proxy Next đã nới
 * timeout 10 phút nên đi đường /api bình thường là đủ).
 * Lỗi: 404 NO_TRANSCRIPT, 502 CLIPS_PARSE_FAILED.
 */
export const suggestClips = (
  projectId: string,
  input?: { count?: number; minSec?: number; maxSec?: number }
) =>
  post<{ clips: Clip[]; suggestedAt: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/clips/suggest`,
    input ?? {}
  );

/** Project con vừa tạo - sessionId null = chưa mở phiên edit AI. */
export interface CreatedClipProject {
  id: string;
  name: string;
  sessionId: string | null;
}

/**
 * Tạo project con từ các clip đã chọn (indexes tính theo mảng clips).
 * autoEdit chỉ chạy edit ngay cho tối đa 3 project - phần còn lại server ghi vào `note`.
 */
export const createClipProjects = (
  projectId: string,
  input: {
    indexes: number[];
    width?: number;
    height?: number;
    autoEdit?: boolean;
  }
) =>
  post<{ created: CreatedClipProject[]; note?: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/clips/create`,
    input
  );

/** Tỉ lệ khung hỗ trợ khi tái chế - khớp bảng ASPECTS của server. */
export type RepurposeAspect = "9:16" | "16:9" | "1:1" | "4:5";

/** Kích thước tương ứng từng tỉ lệ - PHẢI khớp server (routes/clips.ts). */
export const REPURPOSE_SIZES: Record<
  RepurposeAspect,
  { width: number; height: number }
> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

/**
 * Tạo bản tái chế sang tỉ lệ khác - project con mang toàn bộ scene + asset của cha.
 * Lỗi: 400 SAME_ASPECT ("Project đã ở tỉ lệ này").
 */
export const repurposeProject = (
  projectId: string,
  input: { aspect: RepurposeAspect; name?: string; autoEdit?: boolean }
) =>
  post<{ project: ProjectSummary; sessionId: string | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/repurpose`,
    input
  );

// ============ Auto cut videos ============
// Cắt một video dài thành nhiều video ngắn - mỗi đoạn tự thành một Videos
// Project dựng sẵn. Hợp đồng: mục "Auto cut videos" trong docs/API.md.

export type AutoCutStatus =
  | "draft"
  | "planning"
  | "planned"
  | "cutting"
  | "done"
  | "failed";

/** time = chia đều theo phút; ai = AI chọn đoạn hay; prompt = cắt theo yêu cầu. */
export type AutoCutMode = "time" | "ai" | "prompt";

export type AutoCutAspect = "keep" | "9:16" | "16:9" | "1:1" | "4:5";

/** auto = hệ thống tự nhìn khung để chọn crop hay fit. */
export type AutoCutLayout = "auto" | "crop" | "fit";

export type AutoCutBackground = "gemini" | "blur" | "style";

export interface AutoCutSource {
  relPath: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  /** Metadata xoay của file gốc (điện thoại quay dọc) - 0/90/180/270. */
  rotation: number;
}

export interface AutoCutParams {
  /** mode "time": số phút mỗi đoạn. */
  minutes?: number;
  /** mode "time": số giây chồng lấn giữa hai đoạn liền nhau. */
  overlapSec?: number;
  /** mode "ai" | "prompt": số đoạn mong muốn + khoảng độ dài. */
  count?: number;
  minSec?: number;
  maxSec?: number;
  /** mode "prompt": yêu cầu bằng lời của người dùng. */
  request?: string;
}

export interface AutoCutOutput {
  aspect: AutoCutAspect;
  layout: AutoCutLayout;
  background: AutoCutBackground;
  /** null = dùng style mặc định. */
  styleId: string | null;
  /** null = giữ fps nguồn. */
  fps: number | null;
}

export interface AutoCutSegment {
  index: number;
  /** Giây tuyệt đối trong video nguồn. */
  start: number;
  end: number;
  title: string;
  hook?: string;
  reason?: string;
  /** 1-10 - chỉ có ở mode ai/prompt. */
  score?: number;
  selected: boolean;
  /** Có sau bước cut - id Videos Project con đã tạo. */
  projectId?: string;
  /** Layout thực tế đã áp khi đổi khung (mode auto quyết định lúc chạy). */
  appliedLayout?: "crop" | "fit";
}

export interface AutoCutMeta {
  id: string;
  name: string;
  status: AutoCutStatus;
  source: AutoCutSource;
  mode: AutoCutMode;
  params: AutoCutParams;
  output: AutoCutOutput;
  transcribe: boolean;
  autoEdit: boolean;
  /** Kịch bản edit áp cho MỌI project con cắt ra - cấu hình một lần cho cả phiên. */
  brief: Brief;
  transcriptRel?: string | null;
  segments: AutoCutSegment[];
  error?: string | null;
  /**
   * Bước vừa lỗi khi status = "failed". Chỉ "cut" mới cho cắt lại ngay:
   * re-plan lỗi vẫn còn segments CŨ, cắt theo đó là cắt kế hoạch đã lỗi thời.
   */
  failedStep?: "plan" | "cut" | null;
  createdAt: string;
  updatedAt: string;
}

/** Patch một đoạn - chỉ gửi field người dùng vừa sửa. */
export interface AutoCutSegmentPatch {
  index: number;
  start?: number;
  end?: number;
  title?: string;
  selected?: boolean;
}

/** Kích thước tương ứng từng tỉ lệ ("keep" giữ nguyên khung nguồn nên không có). */
export const AUTO_CUT_SIZES: Record<
  Exclude<AutoCutAspect, "keep">,
  { width: number; height: number }
> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

/** Giá trị mặc định của form tạo phiên - khớp mặc định server. */
export const AUTO_CUT_DEFAULT_PARAMS = {
  minutes: 5,
  overlapSec: 0,
  count: 5,
  minSec: 20,
  maxSec: 60,
} as const;

/** Job của phiên cắt: `type` = "auto-cut", `projectId` = id phiên, `sceneId` = bước. */
export type AutoCutStep = "plan" | "cut";

export function isAutoCutJob(job: Job, sessionId?: string): boolean {
  if (job.type !== "auto-cut") return false;
  return sessionId === undefined || job.projectId === sessionId;
}

/** Video trong imports/ - nguồn cho phiên cắt. */
export const getAutoCutSources = () =>
  request<{ files: FileInfo[] }>("/api/auto-cut/sources").then(
    (r) => r.files ?? []
  );

export const getAutoCutSessions = () =>
  request<{ sessions: AutoCutMeta[] }>("/api/auto-cut").then(
    (r) => r.sessions ?? []
  );

export const getAutoCutSession = (id: string) =>
  request<{ session: AutoCutMeta }>(
    `/api/auto-cut/${encodeURIComponent(id)}`
  ).then((r) => r.session);

export const createAutoCut = (input: {
  /** Bỏ trống → server đặt theo tên file nguồn. */
  name?: string;
  sourceRel: string;
  mode: AutoCutMode;
  params?: AutoCutParams;
  output?: Partial<AutoCutOutput>;
  transcribe?: boolean;
  autoEdit?: boolean;
  /** styleId trong brief bị server bỏ qua - style của phiên lấy từ output.styleId. */
  brief?: Partial<Brief>;
}) => post<{ session: AutoCutMeta }>("/api/auto-cut", input).then((r) => r.session);

/** PATCH partial - field không gửi thì server giữ nguyên. */
export const updateAutoCut = (
  id: string,
  patch: {
    name?: string;
    params?: AutoCutParams;
    output?: Partial<AutoCutOutput>;
    transcribe?: boolean;
    autoEdit?: boolean;
    /** Sửa brief KHÔNG reset danh sách đoạn - gửi được cả khi phiên đã planned. */
    brief?: Partial<Brief>;
    segments?: AutoCutSegmentPatch[];
  }
) =>
  jsonBody<{ session: AutoCutMeta }>(
    `/api/auto-cut/${encodeURIComponent(id)}`,
    "PATCH",
    patch
  ).then((r) => r.session);

/** 202 - transcribe + chọn đoạn. Lỗi: 409 BUSY, 400 REQUEST_REQUIRED. */
export const planAutoCut = (id: string) =>
  post<{ job: Job }>(`/api/auto-cut/${encodeURIComponent(id)}/plan`).then(
    (r) => r.job
  );

/** 202 - cắt + đổi khung + đẻ project con. Lỗi: 409 NOT_PLANNED, 400 NO_SEGMENT_SELECTED. */
export const cutAutoCut = (id: string) =>
  post<{ job: Job }>(`/api/auto-cut/${encodeURIComponent(id)}/cut`).then(
    (r) => r.job
  );

/** Xóa phiên cắt - KHÔNG động tới các Videos Project đã tạo ra từ phiên. */
export const deleteAutoCut = (id: string, force = true) =>
  request<void>(
    `/api/auto-cut/${encodeURIComponent(id)}${force ? "?force=true" : ""}`,
    { method: "DELETE" }
  );

// ================= Đồng hồ CPU/GPU realtime trên header =================
export interface Metrics {
  cpu: { percent: number; threads: number; model: string };
  gpu: {
    available: boolean;
    name: string | null;
    percent: number | null;
    vramUsedMb: number | null;
    vramTotalMb: number | null;
  };
}

/** Mức dùng CPU/GPU hiện tại - server tự cache 1,5s nên poll 2s là an toàn. */
export const getMetrics = () => request<Metrics>("/api/metrics");

// ================= Kiểm tra môi trường (start/doctor.mjs) =================

export type DoctorLevel = "required" | "optional" | "info";

export interface DoctorFix {
  /** true = bấm nút là cài được, không cần gõ lệnh */
  auto: boolean;
  size?: string;
  manual?: string;
  /**
   * Lệnh chép-dán-chạy được. Chỉ có ở mục mà cách sửa THỰC SỰ là một dòng lệnh -
   * mục kiểu "dán API key ở trang Kết nối" thì không, để khỏi hiện nút chép vô nghĩa.
   */
  command?: string;
  /** Trang trong dashboard làm được việc này (vd /connections) */
  link?: string;
  url?: string;
}

export interface DoctorCheck {
  id: string;
  /** Tên riêng (FFmpeg, Google Chrome...) - KHÔNG dịch */
  label: string;
  level: DoctorLevel;
  status: "ok" | "missing";
  /** Version/đường dẫn máy dò được - KHÔNG dịch */
  detail: string;
  /** Mã ghi chú, dịch bằng key "doctor.note.<note>" */
  note?: string | null;
  fix: DoctorFix | null;
}

export interface DoctorReport {
  platform: string;
  ok: boolean;
  missingRequired: string[];
  checks: DoctorCheck[];
}

export interface DoctorFixResult {
  ok: boolean;
  installed: boolean;
  timedOut: boolean;
  log: string[];
  report: DoctorReport;
}

/** Dò môi trường - server cache 20s; refresh=true để ép dò lại. */
export const getDoctor = (refresh = false) =>
  request<DoctorReport>(`/api/doctor${refresh ? "?refresh=1" : ""}`);

/** Cài một mục còn thiếu. Chỉ chạy được với mục có fix.auto = true. */
export const fixDoctor = (id: string) =>
  post<DoctorFixResult>("/api/doctor/fix", { id });

// ============ Text to video ============
// Từ một bài viết (URL hoặc văn bản dán vào) → AI viết kịch bản đọc → TTS đọc
// thành giọng → tạo một Videos Project dựng sẵn. Hợp đồng: mục "Text to video"
// trong docs/API.md.

/** "url" = tự đọc bài từ link; "text" = người dùng dán thẳng nội dung. */
export type TextSourceKind = "url" | "text";

export type TextToVideoStatus =
  | "draft"
  | "extracting"
  | "scripting"
  | "ready"
  | "voicing"
  | "building"
  | "editing"
  | "done"
  | "failed";

/** Một đoạn của kịch bản đọc - durationSec chỉ có sau khi TTS đọc xong. */
export interface ScriptChunk {
  text: string;
  durationSec: number | null;
}

/** Bài viết server bóc được từ URL (hoặc từ văn bản dán vào). */
export interface ExtractedArticle {
  title: string;
  blocks: string[];
  byline: string | null;
  siteName: string | null;
  publishedTime: string | null;
  canonicalUrl: string | null;
  leadImage: string | null;
  lang: string | null;
  chars: number;
}

export interface TextToVideoSource {
  kind: TextSourceKind;
  url: string;
  text: string;
}

/**
 * Engine đọc. Hai engine chạy song song, cố ý không hợp nhất:
 * - "gemini": API Google, chất lượng cao, tốn tiền, cần mạng + API key.
 * - "vieneu": VieNeu-TTS chạy TRÊN MÁY (Apache 2.0), miễn phí, không cần mạng,
 *   và là engine duy nhất nhân bản được giọng. Đổi lại phải cài Python + gói.
 */
export type TtsEngine = "gemini" | "vieneu";

export const TTS_ENGINES: TtsEngine[] = ["gemini", "vieneu"];

export interface TextToVideoVoice {
  /** Engine đọc - phiên cũ không có field này, server đọc lên thành "gemini". */
  engine: TtsEngine;
  /** null = model TTS mặc định của server. Engine "vieneu" bỏ qua field này. */
  model: string | null;
  name: string;
  /** "Cách đọc" bằng lời - đổi cái này là toàn bộ thời lượng đọc đổi theo. */
  style: string;
  /**
   * Mã ngôn ngữ gửi kèm khi tổng hợp (speechConfig.languageCode), vd "vi-VN".
   * KHÔNG phải bộ lọc giọng: cả 30 giọng đều đọc được mọi ngôn ngữ và giữ
   * nguyên chất giọng. Đo thực tế còn cho thấy đổi giá trị này không tạo khác
   * biệt nghe được - model đọc theo ngôn ngữ của chính kịch bản. Giữ lại vì đây
   * là field hợp lệ của API và để ghi rõ ý định của phiên.
   */
  language: string;
  /**
   * Tốc độ đọc, 1 = giữ nguyên. Áp bằng ffmpeg atempo SAU khi tổng hợp nên giữ
   * nguyên cao độ giọng - không phải bảo model "đọc nhanh lên".
   */
  speed: number;
}

/** Dải tốc độ đọc hợp lệ - ngoài khoảng này atempo bắt đầu méo tiếng. */
export const TTS_SPEED_MIN = 0.8;
export const TTS_SPEED_MAX = 1.6;

export interface TextToVideoOutput {
  width: number;
  height: number;
  fps: number;
  /** null = dùng style mặc định. */
  styleId: string | null;
}

export interface TextToVideoMeta {
  id: string;
  name: string;
  source: TextToVideoSource;
  /** null = chưa trích xuất được nội dung. */
  article: ExtractedArticle | null;
  script: ScriptChunk[];
  /**
   * Model Claude dùng để VIẾT kịch bản - null = mặc định của Claude Code.
   * Server lưu lại lựa chọn mỗi lần /script chạy, nên lần viết sau giữ nguyên
   * model thay vì lặng lẽ quay về mặc định.
   */
  scriptModel: string | null;
  voice: TextToVideoVoice;
  output: TextToVideoOutput;
  /** Kịch bản edit - CÙNG kiểu Brief với Videos Project. */
  brief: Brief;
  /** File giọng đọc đã tổng hợp (đường dẫn tương đối) - null = chưa đọc. */
  voiceFile: string | null;
  /** Thời lượng THẬT của giọng đọc - chỉ có sau khi tổng hợp xong. */
  voiceDurationSec: number | null;
  transcriptFile: string | null;
  /** Videos Project đã tạo ra từ phiên này - null = chưa dựng. */
  projectId: string | null;
  status: TextToVideoStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Nhãn + tông màu badge cho từng trạng thái phiên. Để ở đây (không phải trong
 * một component) vì cả trang danh sách lẫn trang chi tiết đều cần, mà hai trang
 * lệch nhau một chữ là người dùng tưởng hai thứ khác nhau.
 * Giá trị nhãn là KEY dictionary - dịch bằng t() lúc render.
 */
export const TEXT_TO_VIDEO_STATUS_LABEL: Record<TextToVideoStatus, string> = {
  draft: "ttv.status.draft",
  extracting: "ttv.status.extracting",
  scripting: "ttv.status.scripting",
  ready: "ttv.status.ready",
  voicing: "ttv.status.voicing",
  building: "ttv.status.building",
  editing: "ttv.status.editing",
  done: "ttv.status.done",
  failed: "ttv.status.failed",
};

export const TEXT_TO_VIDEO_STATUS_TONE: Record<
  TextToVideoStatus,
  "success" | "running" | "danger" | "muted"
> = {
  draft: "muted",
  extracting: "running",
  scripting: "running",
  ready: "muted",
  voicing: "running",
  building: "running",
  editing: "running",
  done: "success",
  failed: "danger",
};

/** Model TTS server hỗ trợ - GET /api/tts/models. */
export interface TtsModel {
  id: string;
  label: string;
}

/**
 * Giới tính nghe được của một giọng. "trung-tinh" = lưỡng tính thật: đo âm học
 * ra nam nhưng người nghe lại thấy nữ, và các lần tổng hợp khác nhau đảo qua
 * lại - UI phải nói rõ chỗ này thay vì xếp bừa vào nam hay nữ.
 */
export type TtsGender = "nam" | "nu" | "trung-tinh";

/** Vùng miền giọng - chỉ engine "vieneu" có; Gemini không phân vùng miền. */
export type TtsRegion = "bac" | "trung" | "nam";

/** Giọng dựng sẵn hay giọng người dùng tự nhân bản. */
export type TtsVoiceKind = "preset" | "cloned";

/** Một giọng đọc - GET /api/tts/voices. */
export interface TtsVoice {
  /** Engine sở hữu giọng này - hai engine có thể trùng tên nên luôn đi cặp. */
  engine: TtsEngine;
  /**
   * Định danh gửi lên khi tổng hợp. Với giọng nhân bản đây là id trong kho
   * (kebab-case), KHÔNG phải tên hiển thị - đổi tên không được làm hỏng phiên cũ.
   * Đây cũng là giá trị lưu vào `TextToVideoVoice.name`.
   */
  name: string;
  /** Tên hiện lên màn hình - dùng cái này để render, không dùng `name`. */
  title: string;
  /**
   * Nhãn do SERVER sinh (tiếng Việt). CHỈ dùng làm lưới an toàn: web ưu tiên
   * bản dịch theo `timbreKey`, nếu không có mới hiện nhãn này - nhờ vậy đổi
   * giao diện sang tiếng Anh thì mô tả giọng cũng sang tiếng Anh.
   */
  label: string;
  gender: TtsGender;
  /** Tần số cơ bản (median f0, Hz) ĐO ĐƯỢC từ audio thật; 0 = chưa đo. */
  f0: number;
  kind: TtsVoiceKind;
  region: TtsRegion | null;
  /** Key mô tả chất giọng để web dịch, vd "kore", "tin-tuc". null = không có. */
  timbreKey: string | null;
  /** Ghi chú người dùng nhập khi nhân bản - rỗng với giọng dựng sẵn. */
  note: string;
}

/**
 * Tình trạng một engine - GET /api/tts/engines.
 *
 * Có endpoint riêng vì "chọn được engine nào" phụ thuộc vào MÁY người dùng
 * (có API key chưa, cài Python chưa, có torch chưa). Đoán mò ở web là chắc
 * chắn sai; hỏi server là cách duy nhất đúng.
 */
export interface TtsEngineStatus {
  engine: TtsEngine;
  /** Đọc được chữ thành tiếng hay không. */
  available: boolean;
  /** Nhân bản giọng được hay không (vieneu cần thêm torch; gemini luôn false). */
  canClone: boolean;
  /** Mã lý do khi không dùng được, vd "NO_GEMINI_KEY" | "NO_VIENEU" | "NO_TORCH". */
  reason: string | null;
  /** Chi tiết kỹ thuật (đường dẫn Python, phiên bản gói...) - KHÔNG dịch. */
  detail: string;
}

/** Một giọng đã nhân bản - GET /api/voices. */
export interface ClonedVoice {
  id: string;
  name: string;
  gender: TtsGender;
  note: string;
  /** Đường dẫn tương đối tới file mẫu đã chuẩn hóa - phát qua /media/. */
  refFile: string;
  /** Thời lượng ĐO ĐƯỢC của mẫu (ffprobe). */
  refDurationSec: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Mẫu tham chiếu nên dài bao nhiêu. VieNeu khuyên 3-8 giây: ngắn hơn thì
 * embedding không đủ đặc trưng, dài hơn KHÔNG tốt hơn (model chỉ lấy phần đầu).
 */
export const CLONE_REF_MIN_SEC = 3;
export const CLONE_REF_IDEAL_MAX_SEC = 8;
export const CLONE_REF_MAX_SEC = 30;

/** Một ngôn ngữ chọn được - GET /api/tts/languages. */
export interface TtsLanguage {
  code: string;
  label: string;
}

/** Tỉ lệ khung hình chọn được cho video đọc bài. */
export type TextToVideoAspect = "9:16" | "16:9" | "1:1" | "4:5";

export const TEXT_TO_VIDEO_SIZES: Record<
  TextToVideoAspect,
  { width: number; height: number }
> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

/** fps chọn được - khớp danh sách render của backend. */
export const TEXT_TO_VIDEO_FPS = [24, 25, 30, 60] as const;

/** Mặc định của form tạo phiên - khớp mặc định server. */
export const TEXT_TO_VIDEO_DEFAULT_OUTPUT: TextToVideoOutput = {
  width: 1080,
  height: 1920,
  fps: 30,
  styleId: null,
};

/**
 * Số ký tự đọc được trong 1 giây - dùng ƯỚC LƯỢNG thời lượng kịch bản khi chưa
 * tổng hợp giọng. Chỉ là con số tham khảo: cùng một câu, TTS đọc lệch nhau tới
 * 28%, chưa kể đổi "cách đọc" còn làm thời lượng chênh tới 2,6 lần.
 */
export const TTS_CHARS_PER_SEC = 15;

/** Ước lượng thời lượng một đoạn kịch bản (giây) - ưu tiên thời lượng thật. */
export function estimateChunkSeconds(chunk: ScriptChunk): number {
  if (typeof chunk.durationSec === "number" && chunk.durationSec > 0) {
    return chunk.durationSec;
  }
  return chunk.text.trim().length / TTS_CHARS_PER_SEC;
}

/** Ước lượng thời lượng cả kịch bản (giây). */
export function estimateScriptSeconds(chunks: ScriptChunk[]): number {
  return chunks.reduce((sum, c) => sum + estimateChunkSeconds(c), 0);
}

/** Tổng số ký tự của kịch bản - cơ sở tính ước lượng ở trên. */
export function scriptChars(chunks: ScriptChunk[]): number {
  return chunks.reduce((sum, c) => sum + c.text.trim().length, 0);
}

/** Job dựng video từ bài viết: `type` = "text-to-video", `projectId` = id phiên. */
export function isTextToVideoJob(job: Job, sessionId?: string): boolean {
  if (job.type !== "text-to-video") return false;
  return sessionId === undefined || job.projectId === sessionId;
}

export const getTextToVideoSessions = () =>
  request<TextToVideoMeta[]>("/api/text-to-video");

export const getTextToVideoSession = (id: string) =>
  request<TextToVideoMeta>(`/api/text-to-video/${encodeURIComponent(id)}`);

export const createTextToVideo = (input: {
  /**
   * Tùy chọn - server ĐÃ có fallback thật: bỏ trống thì đặt tên theo tiêu đề
   * bài viết, không có tiêu đề thì lấy mấy chữ đầu của nội dung.
   */
  name?: string;
  source: TextToVideoSource;
}) => post<TextToVideoMeta>("/api/text-to-video", input);

/** PATCH partial - field không gửi thì server giữ nguyên. */
export const updateTextToVideo = (
  id: string,
  patch: {
    name?: string;
    source?: TextToVideoSource;
    voice?: TextToVideoVoice;
    output?: TextToVideoOutput;
    brief?: Partial<Brief>;
    script?: ScriptChunk[];
    /** null = quay về model mặc định của Claude Code. */
    scriptModel?: string | null;
  }
) =>
  jsonBody<TextToVideoMeta>(
    `/api/text-to-video/${encodeURIComponent(id)}`,
    "PATCH",
    patch
  );

export const deleteTextToVideo = (id: string) =>
  request<void>(`/api/text-to-video/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

/**
 * Bóc nội dung bài viết. Chờ ~1-5s rồi trả meta mới. Trang chặn nào không đọc
 * được thì server trả 400 kèm lời nhắn bảo người dùng dán thẳng văn bản.
 */
export const extractTextToVideo = (id: string) =>
  post<TextToVideoMeta>(`/api/text-to-video/${encodeURIComponent(id)}/extract`);

/**
 * AI viết kịch bản đọc - chờ ~10-40s.
 * - targetSeconds: độ dài mong muốn (bỏ trống = AI tự quyết).
 * - model: model Claude viết kịch bản. Gửi kèm thì server DÙNG và LƯU lại vào
 *   `scriptModel`; bỏ trống thì server dùng model đã lưu của phiên.
 */
export const scriptTextToVideo = (
  id: string,
  input?: { targetSeconds?: number; model?: string }
) =>
  post<TextToVideoMeta>(
    `/api/text-to-video/${encodeURIComponent(id)}/script`,
    input && (input.targetSeconds !== undefined || input.model !== undefined)
      ? input
      : undefined
  );

/** 202 - job dài: TTS → transcript → tạo Videos Project → chạy AI edit. */
export const buildTextToVideo = (id: string) =>
  post<{ jobId: string }>(`/api/text-to-video/${encodeURIComponent(id)}/build`);

export const getTtsModels = () => request<TtsModel[]>("/api/tts/models");

/**
 * Danh sách giọng. Không truyền engine = trả về giọng của MỌI engine dùng được
 * (kể cả giọng đã nhân bản), để người dùng thấy hết lựa chọn trong một lần gọi.
 */
export const getTtsVoices = (engine?: TtsEngine) =>
  request<TtsVoice[]>(
    engine ? `/api/tts/voices?engine=${encodeURIComponent(engine)}` : "/api/tts/voices"
  );

/** Engine nào dùng được trên MÁY NÀY - đừng đoán ở phía web, hỏi server. */
export const getTtsEngines = () => request<TtsEngineStatus[]>("/api/tts/engines");

/**
 * Danh sách phong cách dựng cho Ô CHỌN của brief - shape gọn (không có
 * `art`/`avoid`). Trang quản lý dùng `getManagedVideoStyles()` bên dưới.
 */
export const getVideoStyles = () => request<VideoStyle[]>("/api/video-styles");

// ------------------------------------------------- Quản lý phong cách dựng

/**
 * Phong cách dựng ở dạng ĐẦY ĐỦ - chỉ trang /video-styles dùng.
 *
 * `art`/`avoid` là prompt chỉ đạo mỹ thuật gửi Gemini (viết tiếng Anh vì model
 * bám sát hơn hẳn). Ô chọn trong brief cố tình không hiện hai field này; người
 * đi SỬA phong cách thì bắt buộc phải thấy, không thì phong cách tự tạo không
 * có chỉ đạo mỹ thuật nào.
 */
export interface ManagedVideoStyle {
  id: string;
  name: string;
  art: string;
  avoid: string;
  palette: VideoStylePalette;
  motion: string;
  /** Bản mặc định ship kèm repo - sửa/xóa được, nhưng khôi phục lại được. */
  builtin: boolean;
  /** Số project/phiên đang trỏ tới phong cách này. */
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Một project/phiên đang dùng phong cách - hiện ở trang chi tiết trước khi xóa. */
export interface VideoStyleUsage {
  kind: "video-project" | "text-to-video" | "auto-cut" | "translate-video";
  id: string;
  name: string;
}

export type ManagedVideoStyleDetail = ManagedVideoStyle & {
  usage: VideoStyleUsage[];
};

/** Nội dung sửa được của một phong cách - dùng chung cho tạo mới và cập nhật. */
export interface VideoStyleInput {
  name: string;
  art: string;
  avoid: string;
  palette: VideoStylePalette;
  motion: string;
}

export const getManagedVideoStyles = () =>
  request<ManagedVideoStyle[]>("/api/video-styles?full=1");

export const getVideoStyleDetail = (id: string) =>
  request<ManagedVideoStyleDetail>(
    `/api/video-styles/${encodeURIComponent(id)}`
  );

/** Tạo phong cách - `cloneFrom` lấy nội dung một phong cách có sẵn làm nền. */
export const createVideoStyle = (
  input: Partial<VideoStyleInput> & { id?: string; cloneFrom?: string }
) => post<ManagedVideoStyle>("/api/video-styles", input);

/** PUT partial - id KHÔNG đổi được (project cũ trỏ vào id này). */
export const updateVideoStyle = (id: string, patch: Partial<VideoStyleInput>) =>
  jsonBody<ManagedVideoStyle>(
    `/api/video-styles/${encodeURIComponent(id)}`,
    "PUT",
    patch
  );

/**
 * Xóa phong cách. Đang có project dùng mà không `force` thì server trả
 * 409 VIDEO_STYLE_IN_USE kèm tên các project - UI phải hỏi lại rồi mới force.
 */
export const deleteVideoStyle = (id: string, force = false) =>
  request<void>(
    `/api/video-styles/${encodeURIComponent(id)}${force ? "?force=1" : ""}`,
    { method: "DELETE" }
  );

/** Khôi phục một phong cách MẶC ĐỊNH về đúng nội dung ship kèm repo. */
export const resetVideoStyle = (id: string) =>
  post<ManagedVideoStyle>(`/api/video-styles/${encodeURIComponent(id)}/reset`);

// --------------------------------------------------------------- Giọng nhân bản

/** Toàn bộ giọng đã nhân bản - GET /api/voices. */
export const getClonedVoices = () => request<ClonedVoice[]>("/api/voices");

/**
 * Nhân bản một giọng từ file mẫu (multipart, gọi thẳng server như uploadAsset).
 * Server tự chuẩn hóa mẫu về 48kHz mono và ĐO thời lượng bằng ffprobe.
 */
export const createClonedVoice = (input: {
  name: string;
  gender: TtsGender;
  note?: string;
  file: File;
}) => {
  const form = new FormData();
  form.append("file", input.file);
  form.append("name", input.name);
  form.append("gender", input.gender);
  if (input.note) form.append("note", input.note);
  return request<ClonedVoice>(`${serverOrigin()}/api/voices`, {
    method: "POST",
    body: form,
  });
};

/** Sửa tên/giới tính/ghi chú - KHÔNG đổi file mẫu (đổi mẫu là tạo giọng khác). */
export const updateClonedVoice = (
  id: string,
  patch: { name?: string; gender?: TtsGender; note?: string }
) => jsonBody<ClonedVoice>(`/api/voices/${encodeURIComponent(id)}`, "PATCH", patch);

export const deleteClonedVoice = (id: string) =>
  request<{ id: string }>(`/api/voices/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

/**
 * Danh sách mã ngôn ngữ. Tĩnh và miễn phí (server trả từ discovery document),
 * KHÔNG dùng để lọc giọng - giọng và ngôn ngữ là hai lựa chọn độc lập.
 */
export const getTtsLanguages = () =>
  request<TtsLanguage[]>("/api/tts/languages");

/**
 * Nghe thử một giọng - trả về BYTES audio/wav nên không đi qua request<T>
 * (helper đó luôn parse JSON). Mỗi lần gọi là một lần tổng hợp thật, tốn tiền:
 * chỉ gọi khi người dùng bấm nút, không tự phát khi rê chuột hay lúc mở trang.
 */
export async function previewTtsVoice(input: {
  voice: string;
  /** Engine đọc - bỏ trống thì server dùng "gemini". */
  engine?: TtsEngine;
  model?: string | null;
  style?: string;
  /** Mã ngôn ngữ - gửi kèm để bản nghe thử khớp cấu hình đang chọn. */
  language?: string;
  /**
   * Tốc độ đọc. Server áp ĐÚNG bộ lọc mà lúc dựng thật dùng, nên nghe thử ra
   * đúng thứ sắp nhận được - không phải nghe tốc độ gốc rồi tự hình dung.
   */
  speed?: number;
  /**
   * Ngôn ngữ ĐANG HIỆN của giao diện ("vi" | "en"). Server chọn câu mẫu theo
   * đúng ngôn ngữ đó - người dùng đang xem bản tiếng Anh mà nghe thử ra một câu
   * tiếng Việt thì không đánh giá được giọng.
   */
  uiLang?: "vi" | "en";
  /** Bỏ trống → server đọc câu mẫu ngắn cố định (~5s). Đừng gửi cả kịch bản. */
  text?: string;
}): Promise<Blob> {
  const token = await ensureToken();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("x-aiev-token", token);

  let res: Response;
  try {
    res = await fetch(withUploadToken("/api/tts/preview"), {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
  } catch {
    throw new ApiError(
      "network",
      "Không kết nối được backend (port 6869). Kiểm tra server đã chạy chưa.",
      0
    );
  }
  if (!res.ok) {
    let code = String(res.status);
    let message = `Lỗi HTTP ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { code: string; message: string };
      };
      if (body?.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // body không phải JSON - giữ message mặc định
    }
    throw new ApiError(code, message, res.status);
  }
  return res.blob();
}

/**
 * Đọc thử một giọng ĐÃ NHÂN BẢN - POST /api/voices/:id/preview.
 *
 * Tách khỏi previewTtsVoice() vì giọng nhân bản định danh bằng id trong kho chứ
 * không phải tên giọng của engine, và endpoint tự tra file mẫu. Cũng trả về
 * BYTES audio/wav nên không dùng được helper request<T> (helper đó luôn parse
 * JSON) - đi fetch thẳng và mang theo đúng token như mọi lời gọi khác, thay vì
 * trông chờ vào cookie.
 */
export async function previewClonedVoice(input: {
  id: string;
  /** Ngôn ngữ giao diện đang hiện - server chọn câu mẫu tương ứng. */
  uiLang?: "vi" | "en";
}): Promise<Blob> {
  const token = await ensureToken();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("x-aiev-token", token);

  let res: Response;
  try {
    res = await fetch(
      withUploadToken(`/api/voices/${encodeURIComponent(input.id)}/preview`),
      {
        method: "POST",
        headers,
        body: JSON.stringify({ uiLang: input.uiLang }),
      }
    );
  } catch {
    throw new ApiError(
      "network",
      "Không kết nối được backend (port 6869). Kiểm tra server đã chạy chưa.",
      0
    );
  }
  if (!res.ok) {
    let code = String(res.status);
    let message = `Lỗi HTTP ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { code: string; message: string };
      };
      if (body?.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // body không phải JSON - giữ message mặc định
    }
    throw new ApiError(code, message, res.status);
  }
  return res.blob();
}

// ============ Dịch video ============
// Đưa một video vào → bóc lời thoại → AI dịch sang ngôn ngữ khác → đóng phụ đề
// đã dịch lên video. Hợp đồng: mục "Dịch video" trong docs/API.md.

/**
 * Cách trả kết quả:
 * - "subtitle": đóng phụ đề đã dịch lên chính video gốc.
 * - "dub": lồng tiếng - đọc bản dịch bằng TTS rồi thay tiếng gốc (server:
 *   dub.ts + jobs/translateVideo.ts, cùng một cửa POST /:id/render).
 * - "both": vừa lồng tiếng vừa đốt phụ đề, mỗi bên một ngôn ngữ riêng
 *   (`targetLang` cho chữ, `dubLang` cho tiếng).
 */
export type TranslateMode = "subtitle" | "dub" | "both";

export type TranslateStatus =
  | "draft"
  | "transcribing"
  | "transcribed"
  | "translating"
  | "translated"
  | "rendering"
  | "done"
  | "failed";

/**
 * Font chọn được cho phụ đề - ALLOWLIST, không phải ô gõ tự do. Font lạ thì
 * trình duyệt render lặng lẽ bằng font thay thế, và chữ tiếng Việt là thứ vỡ
 * đầu tiên (mất dấu, dấu chồng lên nhau) mà chỉ phát hiện ra lúc đã render xong.
 */
export const SUBTITLE_FONTS = ["vietnamese", "sans", "serif", "mono"] as const;

export type SubtitleFontId = (typeof SUBTITLE_FONTS)[number];

/** Nền sau chữ phụ đề - "blur" làm mờ hình phía sau, "solid" là màu đặc. */
export type SubtitleBackdrop = "blur" | "solid" | "none";

export interface SubtitleStyle {
  /** id trong allowlist SUBTITLE_FONTS - server từ chối giá trị ngoài danh sách. */
  fontFamily: string;
  fontSizePx: number;
  color: string;
  backdrop: SubtitleBackdrop;
  backdropColor: string;
  blurPx: number;
  /** Khoảng cách từ đáy khung hình tới đáy dòng phụ đề. */
  bottomPx: number;
}

/** Một câu phụ đề đã dịch - `text` đã xuống dòng sẵn bằng "\n". */
export interface TranslatedCue {
  /** giây */
  start: number;
  /** giây */
  end: number;
  /** Bản dịch sang `targetLang` - chữ HIỆN LÊN MÀN HÌNH. */
  text: string;
  /**
   * Bản dịch sang `dubLang` - chữ ĐỌC THÀNH TIẾNG, chỉ có khi ngôn ngữ lồng
   * tiếng khác ngôn ngữ phụ đề. Thiếu thì bước đọc dùng `text`.
   */
  dubText?: string;
  /** Lời gốc trước khi dịch - để đối chiếu lúc sửa tay. */
  original?: string;
  speaker?: string;
}

/**
 * AI nào bóc lời thoại. Chỉ "gemini" và "soniox" gắn được nhãn người nói, mà
 * không có nhãn người nói thì lồng tiếng chỉ đọc được bằng MỘT giọng cho cả
 * video - nên lựa chọn này quyết định luôn phần gán giọng phía dưới.
 */
export type SttProvider = "local" | "gemini" | "soniox";

/** GET /api/translate-video/stt-providers - provider nào chạy được TRÊN MÁY NÀY. */
export interface SttCapability {
  id: SttProvider;
  /** Nhãn do server sinh (tiếng Việt) - chỉ dùng khi web chưa có bản dịch. */
  label: string;
  diarization: boolean;
  available: boolean;
  /** Lý do không dùng được (tiếng Việt, hiện thẳng lên UI); thiếu = dùng được. */
  why?: string;
}

/**
 * Kết quả bóc lời của LẦN CHẠY GẦN NHẤT - khác `sttProvider` (là lựa chọn cho
 * lần chạy TIẾP THEO). null = chưa bóc lời lần nào.
 */
export interface TranscriptInfo {
  provider: SttProvider;
  language: string;
  /** Có nhãn người nói không - quyết định lồng tiếng gán được mấy giọng. */
  diarized: boolean;
  speakers: string[];
  wordTimestamps: boolean;
}

/** Một người nói -> một giọng đọc, cố định suốt cả video. */
export interface DubVoiceAssignment {
  /** Nhãn người nói; "" = mọi câu (transcript không phân vai). */
  speaker: string;
  voice: string;
  engine: TtsEngine;
}

/** Cấu hình lồng tiếng của phiên (chỉ có nghĩa khi mode = "dub"). */
export interface DubSettings {
  engine: TtsEngine;
  /** Model TTS (chỉ Gemini) - null = model mặc định của hệ thống. */
  model: string | null;
  /** Mã ngôn ngữ đọc, vd "vi-VN". null = server tự suy từ `targetLang`. */
  language: string | null;
  /** Người nói -> tên giọng. Khóa "" nghĩa là "một giọng cho cả video". */
  voices: Record<string, string>;
  keepOriginal: boolean;
  /** Âm lượng tiếng gốc chạy nền - trần DUB_ORIGINAL_VOLUME_MAX. */
  originalVolume: number;
}

/**
 * Kết quả lồng tiếng của LẦN CHẠY GẦN NHẤT. `stretched`/`clipped`/`overflowed`
 * là thứ người dùng nhìn vào để biết bản lồng tiếng ổn không mà không phải ngồi
 * xem hết video: nhiều câu tràn = bản dịch dài quá so với lời gốc, phải rút chữ.
 */
export interface DubInfo {
  file: string;
  durationSec: number;
  cues: number;
  stretched: number;
  overflowed: number;
  clipped: number;
  minTempo: number;
  maxTempo: number;
  assignments: DubVoiceAssignment[];
  /** Cao độ đo được của từng người nói trong video gốc (Hz). */
  speakerF0: Record<string, number>;
  signature: string;
  createdAt: string;
}

export interface TranslateVideoSource {
  /** Đường dẫn tương đối tới video nguồn - null = chưa tải lên. */
  relPath: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
}

export interface TranslateVideoMeta {
  id: string;
  name: string;
  /** true = tên do server tự đặt theo file nguồn, người dùng chưa đặt tên. */
  autoNamed: boolean;
  source: TranslateVideoSource;
  /** "auto" = để máy tự nhận ngôn ngữ của video. */
  sourceLang: string;
  /** Ngôn ngữ của PHỤ ĐỀ (chữ trên hình). */
  targetLang: string;
  /** Ngôn ngữ LỒNG TIẾNG khi khác phụ đề; null = đọc đúng ngôn ngữ phụ đề. */
  dubLang: string | null;
  mode: TranslateMode;
  /** AI bóc lời cho lần chạy TIẾP THEO - phiên cũ đọc lên thành "local". */
  sttProvider: SttProvider;
  transcriptFile: string | null;
  /** Provider nào ĐÃ thực sự bóc transcript đang có + có nhãn người nói không. */
  transcriptInfo: TranscriptInfo | null;
  cues: TranslatedCue[];
  subtitleStyle: SubtitleStyle;
  /** Lựa chọn lồng tiếng cho lần chạy tiếp theo (chỉ dùng khi mode = "dub"). */
  dub: DubSettings;
  /** Track lồng tiếng ĐÃ dựng + số liệu chất lượng; null = chưa lồng tiếng. */
  dubInfo: DubInfo | null;
  /** Video đã đóng phụ đề / đã lồng tiếng - null = chưa render. */
  outputFile: string | null;
  status: TranslateStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Nhãn + tông màu badge cho từng trạng thái phiên dịch. Để ở đây (không phải
 * trong component) vì cả trang danh sách lẫn trang chi tiết đều cần, mà hai
 * trang lệch nhau một chữ là người dùng tưởng hai thứ khác nhau.
 * Giá trị nhãn là KEY dictionary - dịch bằng t() lúc render.
 */
export const TRANSLATE_VIDEO_STATUS_LABEL: Record<TranslateStatus, string> = {
  draft: "tv.status.draft",
  transcribing: "tv.status.transcribing",
  transcribed: "tv.status.transcribed",
  translating: "tv.status.translating",
  translated: "tv.status.translated",
  rendering: "tv.status.rendering",
  done: "tv.status.done",
  failed: "tv.status.failed",
};

export const TRANSLATE_VIDEO_STATUS_TONE: Record<
  TranslateStatus,
  "success" | "running" | "danger" | "muted"
> = {
  draft: "muted",
  transcribing: "running",
  transcribed: "muted",
  translating: "running",
  translated: "muted",
  rendering: "running",
  done: "success",
  failed: "danger",
};

/** Nhãn chế độ trả kết quả - giá trị là KEY dictionary. */
export const TRANSLATE_MODE_LABEL: Record<TranslateMode, string> = {
  subtitle: "tv.mode.subtitle",
  dub: "tv.mode.dub",
  both: "tv.mode.both",
};

/**
 * Ngôn ngữ nguồn chọn được. "auto" đứng đầu: để máy tự nhận là lựa chọn đúng
 * trong hầu hết trường hợp, chỉ đặt tay khi video pha nhiều thứ tiếng.
 * Nhãn dịch bằng key "tv.lang.<code>".
 */
export const TRANSLATE_SOURCE_LANGS = [
  "auto",
  "vi",
  "en",
  "zh",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "pt",
  "ru",
  "th",
  "id",
  "hi",
  "ar",
  "it",
] as const;

/** Ngôn ngữ đích - y hệt danh sách nguồn nhưng bỏ "auto" (dịch sang đâu phải nói rõ). */
export const TRANSLATE_TARGET_LANGS = TRANSLATE_SOURCE_LANGS.filter(
  (code) => code !== "auto"
);

/** Mặc định của phụ đề - khớp mặc định server, dùng để lấp field còn thiếu. */
export const TRANSLATE_DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: "vietnamese",
  fontSizePx: 48,
  color: "#ffffff",
  backdrop: "blur",
  backdropColor: "#000000",
  blurPx: 12,
  bottomPx: 120,
};

/** Giới hạn các ô số của phụ đề - chặn sớm ở web thay vì để server trả 400. */
export const SUBTITLE_FONT_SIZE_MIN = 16;
export const SUBTITLE_FONT_SIZE_MAX = 160;
export const SUBTITLE_BLUR_MAX = 40;
export const SUBTITLE_BOTTOM_MAX = 600;

/**
 * AI đứng sau bước dịch. Chỉ một nhà cung cấp: `apps/server/src/translate.ts`
 * gọi thẳng generativelanguage.googleapis.com. Để hằng số ở đây để trang không
 * viết chữ "Gemini" rải rác trong JSX - đổi nhà cung cấp thì sửa đúng một chỗ.
 */
export const TRANSLATE_PROVIDER = "Gemini";

/**
 * Model dịch. GƯƠNG của `DEFAULT_TRANSLATE_MODEL` + `TRANSLATE_MODELS` trong
 * apps/server/src/translate.ts - server CHƯA có endpoint liệt kê model dịch
 * (khác /api/tts/models), nên đây là bản chép tay và phải sửa cùng lúc với
 * server. Id nào cũng đi qua `resolveModel` phía server; id lạ vẫn được nhận
 * miễn sạch, nên danh sách lệch một nhịp cũng không làm hỏng luồng chính.
 *
 * Nhãn để dạng KEY dictionary ("tv.model.<id>") thay vì chép chuỗi tiếng Việt
 * của server - giao diện tiếng Anh phải đọc ra tiếng Anh.
 */
export const DEFAULT_TRANSLATE_MODEL = "gemini-2.5-flash";

export interface TranslateModelOption {
  id: string;
  labelKey: string;
}

export const TRANSLATE_MODELS: TranslateModelOption[] = [
  { id: "gemini-2.5-flash", labelKey: "tv.model.gemini-2.5-flash" },
  { id: "gemini-2.5-pro", labelKey: "tv.model.gemini-2.5-pro" },
  { id: "gemini-2.5-flash-lite", labelKey: "tv.model.gemini-2.5-flash-lite" },
];

/**
 * Khóa "một giọng cho cả video" - dùng khi transcript không phân vai người nói.
 * Khớp DUB_ALL_SPEAKERS của server (dub.ts): chuỗi rỗng là khóa HỢP LỆ có chủ ý.
 */
export const DUB_ALL_SPEAKERS = "";

/**
 * Trần âm lượng tiếng gốc chạy nền và trần co giãn giọng - gương của dub.ts
 * (DUB_ORIGINAL_VOLUME_MAX, DUB_TEMPO_MAX). Web chỉ dùng để vẽ thanh trượt và
 * để giải thích số đo trả về, server vẫn tự kẹp lại lần nữa.
 */
export const DUB_ORIGINAL_VOLUME_MAX = 0.12;
export const DUB_TEMPO_MAX = 1.25;

/** Mặc định lồng tiếng - khớp defaultDubSettings() của server. */
export const TRANSLATE_DEFAULT_DUB: DubSettings = {
  engine: "gemini",
  model: null,
  language: null,
  voices: {},
  keepOriginal: false,
  originalVolume: 0.1,
};

/** Job của phiên dịch: `type` = "translate-video", `projectId` = id phiên. */
export function isTranslateVideoJob(job: Job, sessionId?: string): boolean {
  if (job.type !== "translate-video") return false;
  return sessionId === undefined || job.projectId === sessionId;
}

export const getTranslateVideos = () =>
  request<TranslateVideoMeta[]>("/api/translate-video");

export const getTranslateVideo = (id: string) =>
  request<TranslateVideoMeta>(`/api/translate-video/${encodeURIComponent(id)}`);

/** 201 - bỏ trống `name` thì server tự đặt (autoNamed = true) theo file nguồn. */
export const createTranslateVideo = (input?: { name?: string }) =>
  post<TranslateVideoMeta>("/api/translate-video", input);

/** PATCH partial - field không gửi thì server giữ nguyên. */
export const updateTranslateVideo = (
  id: string,
  patch: {
    name?: string;
    sourceLang?: string;
    targetLang?: string;
    mode?: TranslateMode;
    sttProvider?: SttProvider;
    cues?: TranslatedCue[];
    subtitleStyle?: SubtitleStyle;
    /** Gửi TRỌN khối - server merge theo field nhưng gửi trọn thì khỏi đoán. */
    dub?: DubSettings;
  }
) =>
  jsonBody<TranslateVideoMeta>(
    `/api/translate-video/${encodeURIComponent(id)}`,
    "PATCH",
    patch
  );

export const deleteTranslateVideo = (id: string) =>
  request<void>(`/api/translate-video/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

/**
 * Tải video nguồn lên (multipart). Gọi THẲNG backend như uploadAsset: file video
 * lớn đi qua rewrite proxy của Next là dính timeout.
 */
export const uploadTranslateVideoSource = (id: string, file: File) => {
  const form = new FormData();
  form.append("file", file);
  return request<TranslateVideoMeta>(
    `${serverOrigin()}/api/translate-video/${encodeURIComponent(id)}/source`,
    { method: "POST", body: form }
  );
};

/** AI bóc lời nào dùng được trên máy này - hỏi server, đừng đoán ở web. */
export const getSttProviders = () =>
  request<SttCapability[]>("/api/translate-video/stt-providers");

/**
 * 202 - job dài: bóc lời thoại từ video nguồn. Truyền `sttProvider` để chọn
 * luôn provider cho lần chạy này (server ghi vào meta trước khi đẩy job).
 */
export const transcribeTranslateVideo = (
  id: string,
  input?: { sttProvider?: SttProvider }
) =>
  post<{ jobId: string }>(
    `/api/translate-video/${encodeURIComponent(id)}/transcribe`,
    input && input.sttProvider !== undefined ? input : undefined
  );

/** Đồng bộ - AI dịch toàn bộ lời thoại, chờ vài chục giây rồi trả meta mới. */
export const translateTranslateVideo = (id: string, input?: { model?: string }) =>
  post<TranslateVideoMeta>(
    `/api/translate-video/${encodeURIComponent(id)}/translate`,
    input && input.model !== undefined ? input : undefined
  );

/** 202 - job dài: đóng phụ đề đã dịch lên video, hoặc lồng tiếng (theo `mode`). */
export const renderTranslateVideo = (id: string) =>
  post<{ jobId: string }>(
    `/api/translate-video/${encodeURIComponent(id)}/render`
  );

/**
 * Nghe thử MỘT câu lồng tiếng trước khi trả tiền đọc cả video.
 *
 * Trả về BYTES audio/wav nên không đi qua request<T> (helper đó luôn parse
 * JSON). Số đo đi kèm trong header `x-dub-*`: câu nghe thử đã đi qua ĐÚNG phép
 * co giãn của bước dựng thật, nên `tempo`/`clipped` ở đây nói đúng thứ sắp
 * nhận được - nghe ra câu bị co là biết bản dịch đang dài quá và sửa chữ ngay.
 *
 * Header đọc được vì request đi same-origin qua rewrite /api của Next (không
 * qua CORS nên không cần Access-Control-Expose-Headers).
 */
export interface DubPreviewResult {
  audio: Blob;
  /** Giọng server đã thực sự dùng (khi không truyền `voice` thì nó tự gán). */
  voice: string;
  /** Thời lượng TTS đọc ra, TRƯỚC khi co giãn. */
  naturalSec: number;
  /** Thời lượng sau khi co - đo lại bằng ffprobe, không phải phép chia. */
  finalSec: number;
  /** Độ dài câu GỐC trong video. */
  sourceSec: number;
  tempo: number;
  /** Đã đụng trần co (DUB_TEMPO_MAX) mà vẫn chưa vừa chỗ. */
  clipped: boolean;
  /** Vẫn lấn sang mốc câu kế tiếp dù đã co hết mức - ca xấu thật sự. */
  overflowed: boolean;
}

export async function dubPreviewTranslateVideo(
  id: string,
  input?: { index?: number; voice?: string }
): Promise<DubPreviewResult> {
  const token = await ensureToken();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("x-aiev-token", token);

  let res: Response;
  try {
    res = await fetch(
      withUploadToken(
        `/api/translate-video/${encodeURIComponent(id)}/dub-preview`
      ),
      { method: "POST", headers, body: JSON.stringify(input ?? {}) }
    );
  } catch {
    throw new ApiError(
      "network",
      "Không kết nối được backend (port 6869). Kiểm tra server đã chạy chưa.",
      0
    );
  }
  if (!res.ok) {
    let code = String(res.status);
    let message = `Lỗi HTTP ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { code: string; message: string };
      };
      if (body?.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // body không phải JSON - giữ message mặc định
    }
    throw new ApiError(code, message, res.status);
  }
  const num = (name: string): number => {
    const v = Number(res.headers.get(name));
    return Number.isFinite(v) ? v : 0;
  };
  return {
    audio: await res.blob(),
    voice: decodeURIComponent(res.headers.get("x-dub-voice") ?? ""),
    naturalSec: num("x-dub-natural"),
    finalSec: num("x-dub-final"),
    sourceSec: num("x-dub-source"),
    // Thiếu header (proxy lạ cắt mất) -> coi như không co, KHÔNG coi là 0:
    // tempo 0 hiện ra màn hình là một con số vô nghĩa.
    tempo: num("x-dub-tempo") || 1,
    clipped: res.headers.get("x-dub-clipped") === "1",
    overflowed: res.headers.get("x-dub-overflowed") === "1",
  };
}
