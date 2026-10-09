"use client";

/**
 * Chi tiết một phiên "Text to video" - lắp bằng bộ khối workspace 3 cột dùng chung
 * (`components/Workspace.tsx`), chia theo NHỊP LÀM VIỆC chứ không theo số bước:
 *
 * - Cột `source`: bài viết/văn bản nguồn - thứ mình BẮT ĐẦU TỪ ĐÓ.
 * - Cột `setup`: kịch bản đọc, giọng đọc, cấu hình video - "mình muốn ra cái gì".
 * - Cột `output`: khối video thành phẩm ĐỨNG ĐẦU (chạy thì nhấp nháy chờ, xong
 *   thì hiện thẳng video), rồi tiến trình của project con.
 *
 * Panel AI là SLOT CỦA SHELL: trang chỉ khai báo <ShellRightPanel> và shell lo bề
 * rộng, chỗ chừa, nút gấp, chế độ drawer. Trước đây trang tự dựng một <aside>
 * `fixed` rồi chừa chỗ bằng `xl:pr-[452px]` - con số đó sai ngay khi người dùng
 * gấp panel lại, và mỗi trang lại phải nhớ tự chừa. Nhật ký job dựng nằm TRONG
 * panel đó, không nhân bản thêm một khối nữa ở cột kết quả.
 *
 * Thanh bước dùng chung StepperBar với Videos Project - không tự vẽ thanh thứ hai.
 *
 * Phiên dựng xong (status "done") thì các khối khác tự gấp lại còn một dòng tóm
 * tắt, riêng khối video thành phẩm vẫn mở: lúc đó người dùng vào trang là để XEM
 * video vừa ra, không phải để sửa nguồn hay kịch bản nữa. Gấp/mở vẫn bấm tay được
 * và ý người dùng luôn thắng mặc định - xem `useCollapseGroup`.
 */

import {
  ArrowLeft,
  ExternalLink,
  FileText,
  Link2,
  ListVideo,
  Loader2,
  MessageSquare,
  Mic,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Type,
  Wand2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildTextToVideo,
  deleteTextToVideo,
  estimateChunkSeconds,
  estimateScriptSeconds,
  extractTextToVideo,
  getChatSessions,
  getJob,
  getJobs,
  getProject,
  getTextToVideoSession,
  isTextToVideoJob,
  mediaUrl,
  scriptChars,
  scriptTextToVideo,
  updateTextToVideo,
  TEXT_TO_VIDEO_DEFAULT_OUTPUT,
  TEXT_TO_VIDEO_FPS,
  TEXT_TO_VIDEO_SIZES,
  TEXT_TO_VIDEO_STATUS_LABEL,
  TEXT_TO_VIDEO_STATUS_TONE,
  type Brief,
  type ChatSession,
  type Job,
  type ProjectDetail,
  type ScriptChunk,
  type TextSourceKind,
  type TextToVideoAspect,
  type TextToVideoMeta,
  type TextToVideoOutput,
  type TextToVideoSource,
  type TextToVideoVoice,
} from "@/lib/api";
import {
  useAgentEvents,
  useEvents,
  useJobEvents,
  useJobLogEvents,
} from "@/lib/useEvents";
import { Badge, JobBadge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ChatThread } from "@/components/ChatThread";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { useClaudeModels, useProviders } from "@/components/ModelPicker";
import { OptionCard, OptionCardGroup } from "@/components/OptionCard";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { Segmented } from "@/components/Segmented";
import { deriveStage, PipelineTimeline, StepperBar } from "@/components/PipelineTimeline";
import { ProgressBar } from "@/components/ProgressBar";
import { SessionStatusBadge } from "@/components/SessionStatusBadge";
import { ShellRightPanel } from "@/components/Shell";
import { StyleSelect, styleDisplayName, useStyles } from "@/components/StyleSelect";
import {
  OutputBlock,
  useCollapseGroup,
  Workspace,
  WorkspaceBlock,
  WorkspaceColumn,
  type WorkspaceStatus,
} from "@/components/Workspace";
import { VoicePicker } from "@/components/VoicePicker";
import { BriefFields, DEFAULT_BRIEF } from "@/components/BriefFields";
// clock() (giây → mm:ss) đã có sẵn ở đây, lib/format.ts chưa có helper tương đương
import { clock } from "@/components/AutoCutCommon";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";

/** Gộp nhiều lần gõ phím thành một PATCH - không bắn request mỗi ký tự. */
const PATCH_DEBOUNCE_MS = 700;

const ASPECTS: TextToVideoAspect[] = ["9:16", "16:9", "1:1", "4:5"];

/** Trạng thái nào là "đang có việc chạy" - lúc đó mọi ô nhập bị khóa. */
const RUNNING_STATUS = ["extracting", "scripting", "voicing", "building"];

/** Giới hạn "Độ dài (giây)" - khớp server (ngoài khoảng là 400 INVALID_TARGET_SECONDS). */
const TARGET_SECONDS_MIN = 15;
const TARGET_SECONDS_MAX = 600;

/** Độ dài tối đa của lỗi hiện trong khối kết quả - xem `shortError`. */
const ERROR_PREVIEW_MAX = 240;

/**
 * Rút gọn lỗi cho khối kết quả. Lỗi thật (log render, traceback python) dài hàng
 * chục dòng, đổ nguyên vào khung video là đẩy mọi thứ khác xuống dưới màn hình -
 * bản đầy đủ vẫn nằm ở banner lỗi phía trên trang.
 */
function shortError(e: string | null | undefined): string | null {
  if (!e) return null;
  const s = e.replace(/\s+/g, " ").trim();
  return s.length > ERROR_PREVIEW_MAX ? `${s.slice(0, ERROR_PREVIEW_MAX)}…` : s;
}

/** Thay đổi đang chờ gửi - luôn gửi trọn từng khối con để server khỏi phải merge. */
interface Patch {
  name?: string;
  source?: TextToVideoSource;
  voice?: TextToVideoVoice;
  output?: TextToVideoOutput;
  brief?: Partial<Brief>;
  script?: ScriptChunk[];
  scriptModel?: string | null;
}

/** Các khối của phiên - key vừa là id state gấp/mở vừa là id vùng nội dung. */
const TTV_BLOCKS = [
  "source",
  "script",
  "voice",
  "config",
  "build",
  "child",
] as const;
type BlockKey = (typeof TTV_BLOCKS)[number];

/**
 * Khối vẫn MỞ khi phiên xong: video thành phẩm. Xong việc thì người dùng vào
 * trang là để xem thành phẩm, không phải để sửa ô nhập nữa.
 */
const TTV_KEEP_EXPANDED: readonly BlockKey[] = ["build"];

// Giá trị là KEY dictionary - StepperBar tự dịch bằng t() lúc render.
const STAGE_LABELS = [
  "ttv.stage.source",
  "ttv.stage.script",
  "ttv.stage.voice",
  "ttv.stage.config",
  "ttv.stage.build",
] as const;

/**
 * Bước hiện tại suy từ dữ liệu phiên - backend vẫn là nguồn sự thật, chỗ này
 * chỉ đọc. `active` = đang có việc chạy (chấm nhấp nháy), `complete` = xong hết.
 */
function deriveTtvStage(m: TextToVideoMeta): {
  stage: number;
  active: boolean;
  complete: boolean;
} {
  if (m.status === "extracting") return { stage: 1, active: true, complete: false };
  if (m.status === "scripting") return { stage: 2, active: true, complete: false };
  // "editing" nằm CÙNG bước 5 và vẫn active: tạo xong project con mới là bắt đầu
  // dựng video, không phải xong. Trước đây bước này tick xanh ngay lúc bàn giao
  // nên người dùng thấy "xong" rồi ngồi đợi mãi không có video.
  if (m.status === "voicing" || m.status === "building" || m.status === "editing") {
    return { stage: 5, active: true, complete: false };
  }
  if (m.projectId) {
    return { stage: 5, active: false, complete: m.status === "done" };
  }
  if (m.script.length > 0) {
    return { stage: m.voice.name ? 4 : 3, active: false, complete: false };
  }
  const hasSource =
    m.article !== null || m.source.text.trim() !== "" || m.source.url.trim() !== "";
  return { stage: hasSource ? 2 : 1, active: false, complete: false };
}

/** Những gì trang biết về project con mà phiên đẻ ra - xem `useChildProject`. */
interface ChildProject {
  /** Video thành phẩm của project con (đã kèm ?v= để không dính cache cũ) */
  url: string | null;
  /** Đường dẫn tương đối của file output - hiện dưới video */
  output: string | null;
  /** Job đang chạy của project con - tiến trình THẬT của việc dựng */
  runningJob: Job | null;
  /** Đầu vào cho PipelineTimeline; null khi chưa đọc được project */
  pipelineInput: Parameters<typeof PipelineTimeline>[0] | null;
  error: string | null;
}

/**
 * Theo dõi project con mà phiên đẻ ra: meta, job, phiên chat AI.
 *
 * Là HOOK chứ không phải component vì kết quả bị tách ra hai khối nằm ở hai chỗ
 * khác nhau của cột kết quả (video thành phẩm đứng đầu, tiến trình dựng ở dưới) -
 * component thì không chia đôi state của mình ra hai chỗ được.
 *
 * `projectId` null (chưa dựng) thì hook nằm im, không gọi API nào - nhưng vẫn
 * phải được gọi ở mọi lần render, nên trang gọi nó vô điều kiện.
 */
function useChildProject(projectId: string | null): ChildProject {
  // SSE đứt rồi nối lại → refetch dữ liệu seed để không kẹt trạng thái cũ
  const { resyncTick } = useEvents();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Phiên chat AI của project con có đang chạy không - hỏi thẳng API sessions
  // (như trang Videos Project) thay vì suy từ job render: job xong không có
  // nghĩa là phiên AI xong, và ngược lại.
  const [aiRunning, setAiRunning] = useState(false);

  const reload = useCallback(() => {
    if (!projectId) {
      setProject(null);
      return;
    }
    getProject(projectId)
      .then((p) => {
        setProject(p);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [projectId]);

  useEffect(reload, [reload, resyncTick]);

  const loadSessions = useCallback(() => {
    if (!projectId) return;
    getChatSessions(projectId)
      .then((list) => setAiRunning(list.some((s) => s.status === "running")))
      .catch(() => {
        // không tra được - giữ giá trị cũ, không chặn khối kết quả
      });
  }, [projectId]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions, resyncTick]);

  // Job của project con - đây mới là TIẾN TRÌNH THẬT của việc dựng video.
  // Không có nó thì trang này chỉ biết "đã bàn giao" rồi im lặng hàng chục phút.
  // Lọc projectId phía server - queue bận không đẩy job của project ra khỏi cửa sổ.
  useEffect(() => {
    if (!projectId) {
      setJobs([]);
      return;
    }
    let alive = true;
    getJobs(50, projectId)
      .then((list) => {
        if (alive) setJobs(list);
      })
      .catch(() => {
        // thiếu job cũng không chặn: timeline tự suy từ file đã render
      });
    return () => {
      alive = false;
    };
  }, [projectId, resyncTick]);

  // AI dựng xong thì meta.output mới có - bám cả job lẫn phiên agent để video
  // tự hiện ra, không bắt người dùng F5 đoán lúc nào xong
  useJobEvents((e) => {
    if (!projectId || e.projectId !== projectId) return;
    setJobs((prev) => {
      const i = prev.findIndex((j) => j.id === e.id);
      if (i < 0) return [...prev, e];
      const next = prev.slice();
      next[i] = e;
      return next;
    });
    reload();
  });
  useAgentEvents((e) => {
    if (!projectId) return;
    if (e.kind === "done" || e.kind === "result") {
      reload();
      loadSessions();
    }
  });

  const output = project?.output ?? null;

  return {
    output,
    url: output
      ? `${mediaUrl(output)}?v=${encodeURIComponent(project?.updatedAt ?? "")}`
      : null,
    runningJob: jobs.find((j) => j.status === "running") ?? null,
    pipelineInput: project
      ? {
          metaStatus: project.status,
          hasOutput: project.output != null,
          scenes: project.scenes ?? [],
          renders: project.files?.renders ?? [],
          jobs,
          // Trạng thái THẬT của phiên chat AI - lấy từ API sessions, không suy từ job
          sessionRunning: aiRunning,
        }
      : null,
    error: err,
  };
}

/**
 * Chọn model Claude viết kịch bản. Danh sách model lấy từ ModelPicker (chung
 * cache /api/providers + /api/claude/models với modal "Bắt đầu edit") - không
 * dựng nguồn dữ liệu thứ hai để hai nơi lệch nhau.
 *
 * Không dùng thẳng AiModelBlock/AiModelInlineRow vì hai khối đó kèm ô "chế độ"
 * (effort), mà endpoint /script chỉ nhận `model` - bày một ô bấm vào không có
 * tác dụng gì còn tệ hơn là không bày.
 */
function ScriptModelSelect({
  value,
  disabled,
  onChange,
}: {
  /** "" = mặc định của Claude Code. */
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const { t } = useT();
  const { providers } = useProviders();
  const claude = providers?.find((p) => p.id === "claude");
  const { models: liveModels, load } = useClaudeModels();
  // Chưa fetch live → tạm dùng danh sách tĩnh từ /api/providers
  const models = liveModels ?? claude?.models ?? [];
  // Model đã lưu không (chưa) nằm trong danh sách → vẫn hiện bằng id thô
  const missing = value !== "" && !models.some((m) => m.id === value);

  return (
    <Field
      label={t("ttv.script-model")}
      htmlFor="ttv-script-model"
      hintKeys={{
        titleKey: "help.ttv-script-model.title",
        bodyKey: "help.ttv-script-model.body",
      }}
    >
      <select
        id="ttv-script-model"
        className="input"
        value={value}
        disabled={disabled}
        onFocus={load}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t("ttv.script-model-default")}</option>
        {missing && <option value={value}>{value}</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Một dòng cho biết Claude đang xác thực bằng gì - subscription hay API key. */
function ClaudeAuthLine() {
  const { t } = useT();
  const { providers } = useProviders();
  const claude = providers?.find((p) => p.id === "claude");
  if (!claude) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-[var(--text-muted)]">
      <Badge
        tone={claude.connected ? "success" : "danger"}
        label={
          claude.connected
            ? claude.source === "api-key"
              ? t("model.connected-api-key")
              : t("model.connected-subscription")
            : t("model.not-connected")
        }
      />
      <span className="min-w-0">
        {claude.connected ? t("ttv.script-model-hint") : t("model.claude-warning")}
      </span>
    </p>
  );
}

/**
 * Khối log của job dựng video trong panel AI - đúng nội dung trang Render Queue
 * hiển thị: tiến trình + từng dòng log chảy về qua SSE `joblog`.
 */
function JobLogBlock({ job }: { job: Job }) {
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
    <Panel
      className="shrink-0"
      title={t("ttv.panel-job")}
      actions={<JobBadge status={job.status} />}
    >
      <ProgressBar progress={job.progress} step={job.step} />
      {error && <ErrorBanner message={t("ttv.panel-log-error")} detail={error} />}
      {/* Nền --surface chứ không --bg-subtle: Panel đã là --bg-subtle rồi, cùng
          màu thì khối log tan vào hộp chứa nó. */}
      <pre
        ref={preRef}
        className="max-h-48 min-h-16 overflow-auto rounded-[var(--radius)] bg-[var(--surface)] p-2 font-mono text-meta whitespace-pre-wrap"
      >
        {log || t("ttv.panel-no-log")}
      </pre>
    </Panel>
  );
}

export default function TextToVideoDetailPage() {
  const { t, tf } = useT();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  // SSE đứt rồi nối lại → refetch dữ liệu seed để status không kẹt "đang chạy"
  const { resyncTick } = useEvents();

  const [session, setSession] = useState<TextToVideoMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Bước đang chạy đồng bộ (chờ response) - khóa nút để không bấm hai lần. */
  const [busy, setBusy] = useState<"extract" | "script" | "build" | null>(null);

  // Bản nháp phía client: gõ là thấy ngay, PATCH đi sau (debounce). Chỉ đồng bộ
  // lại từ server khi KHÔNG còn thay đổi chờ gửi - để không nuốt chữ vừa gõ.
  const [source, setSource] = useState<TextToVideoSource | null>(null);
  const [script, setScript] = useState<ScriptChunk[]>([]);
  const [voice, setVoice] = useState<TextToVideoVoice | null>(null);
  const [output, setOutput] = useState<TextToVideoOutput | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  /** "" = để Claude Code dùng model mặc định. */
  const [scriptModel, setScriptModel] = useState("");

  const pending = useRef<Patch>({});
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** PATCH đang bay - flush sau phải chờ nó, kẻo bước kế tiếp chạy trước khi lưu xong */
  const inflight = useRef<Promise<string | null> | null>(null);

  /** Độ dài mong muốn của kịch bản (giây) - "" = để AI tự quyết. */
  const [targetSeconds, setTargetSeconds] = useState("");

  // Job dựng video mới nhất của phiên - nguồn hiển thị % và tên bước
  const [job, setJob] = useState<Job | null>(null);
  const buildJobId = useRef<string | null>(null);

  // Gấp/mở từng khối. Mặc định suy từ "phiên đã xong chưa" NGAY TRONG LÚC RENDER,
  // cố tình KHÔNG có useEffect nào đồng bộ trạng thái gấp theo status: trang này
  // bám SSE job + agent, mỗi dòng log hay mỗi lần job đổi tiến trình là một lần
  // render mới. Effect kiểu đó sẽ đóng sập đúng cái khối người dùng vừa mở ra,
  // mà lỗi ấy trông như trang tự nhiên "nhảy" chứ không ai đoán ra là do SSE.
  //
  // Gọi trước mọi lối thoát sớm (loading/lỗi) - thứ tự hook phải giống nhau ở
  // mọi lần render.
  const group = useCollapseGroup({
    keys: TTV_BLOCKS,
    finished: session?.status === "done",
    keepExpanded: TTV_KEEP_EXPANDED,
  });

  // Tên Style Design cho dòng tóm tắt của khối Cấu hình. Dùng chung cache
  // module-level với StyleSelect ngay trong khối đó - không thêm request nào.
  const { data: stylesData } = useStyles();

  // Panel AI là slot của shell (ShellRightPanel) - trang KHÔNG giữ state gấp/mở,
  // không chừa chỗ, không tự dựng drawer. Shell lo hết.
  const [chatSessions, setChatSessions] = useState<ChatSession[] | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** Đổ dữ liệu server vào các bản nháp chưa bị sửa dở. */
  const adopt = useCallback((s: TextToVideoMeta) => {
    setSession(s);
    const p = pending.current;
    if (!p.source) setSource(s.source);
    if (!p.script) setScript(s.script);
    if (!p.voice) setVoice(s.voice);
    if (!p.output) setOutput({ ...TEXT_TO_VIDEO_DEFAULT_OUTPUT, ...(s.output ?? {}) });
    // null là giá trị hợp lệ (= mặc định) nên phải hỏi "có key không", không hỏi truthy
    if (!("scriptModel" in p)) setScriptModel(s.scriptModel ?? "");
    // Phiên tạo trước khi backend có brief → thiếu field, lấp bằng default
    if (!p.brief) setBrief({ ...DEFAULT_BRIEF, ...(s.brief ?? {}) });
  }, []);

  const load = useCallback(async () => {
    try {
      adopt(await getTextToVideoSession(sessionId));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId, adopt]);

  useEffect(() => {
    load();
  }, [load, resyncTick]);

  // Seed job đang chạy (mở trang giữa chừng vẫn thấy tiến trình).
  // resyncTick: refetch sau khi SSE nối lại để bắt kịp job đã đổi trạng thái.
  useEffect(() => {
    let alive = true;
    getJobs(50)
      .then((list) => {
        const mine = list.filter((j) => isTextToVideoJob(j, sessionId));
        if (alive && mine.length > 0) setJob(mine[0]);
      })
      .catch(() => {
        // không lấy được jobs cũng không chặn trang - SSE vẫn cập nhật tiếp
      });
    return () => {
      alive = false;
    };
  }, [sessionId, resyncTick]);

  useJobEvents((j) => {
    // Hợp đồng /build chỉ trả jobId nên nhận cả theo id job vừa tạo
    if (!isTextToVideoJob(j, sessionId) && j.id !== buildJobId.current) return;
    setJob(j);
    if (["done", "failed", "canceled"].includes(j.status)) load();
  });

  // ---- Phiên chat AI của project được dựng ra ----
  // Tìm y như trang Videos Project: /api/chat/sessions lọc theo projectId, lấy
  // phiên mới nhất. Chưa dựng xong thì projectId còn null → chưa có gì để tìm.
  const projectId = session?.projectId ?? null;

  // Project con: video thành phẩm + job + timeline. Gọi vô điều kiện (hook), tự
  // nằm im khi phiên chưa dựng ra project nào.
  const child = useChildProject(projectId);

  const loadChatSessions = useCallback(async () => {
    if (!projectId) return;
    try {
      const list = await getChatSessions(projectId);
      list.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      setChatSessions(list);
      setActiveSessionId((cur) => cur ?? list[0]?.sessionId ?? null);
    } catch {
      // panel vẫn dùng được (empty state) - không chặn trang
      setChatSessions((s) => s ?? []);
    }
  }, [projectId]);

  useEffect(() => {
    loadChatSessions();
  }, [loadChatSessions, resyncTick]);

  // Phiên AI chạy xong → nạp lại CẢ phiên TTV lẫn danh sách chat: status
  // "editing" của phiên chỉ rời đi khi đọc lại meta, không tự đổi theo SSE.
  useAgentEvents((e) => {
    if (e.kind !== "done") return;
    load();
    if (projectId) loadChatSessions();
  });

  // ---- Lưu thay đổi: gộp lại rồi PATCH một lần ----

  /**
   * Gửi thay đổi đang chờ. Trả về thông báo lỗi (null = đã lưu / không có gì).
   * Lưu hỏng thì TRẢ patch về hàng chờ (thay đổi gõ sau thắng) để lần sau gửi
   * lại, và người gọi phải dừng: chạy "Dựng video" tiếp là dựng kịch bản CŨ trên
   * server trong khi UI hiện bản đã sửa.
   */
  const flush = useCallback(async (): Promise<string | null> => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    // Chờ tới khi KHÔNG còn lượt nào bay (vòng lặp, không phải if): hai người
    // cùng chờ một lượt thì người dậy trước có thể vừa gửi lượt mới
    let prevErr: string | null = null;
    while (inflight.current) prevErr = await inflight.current;
    if (Object.keys(pending.current).length === 0) return prevErr;
    const patch = pending.current;
    pending.current = {};
    const run = (async (): Promise<string | null> => {
      try {
        const s = await updateTextToVideo(sessionId, patch);
        setSession(s);
        setSaveError(null);
        return null;
      } catch (e) {
        const later = pending.current;
        pending.current = {
          ...patch,
          ...later,
          ...(patch.brief || later.brief
            ? { brief: { ...(patch.brief ?? {}), ...(later.brief ?? {}) } }
            : {}),
        };
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
        updateTextToVideo(sessionId, patch).catch(() => {
          // trang đã đóng - không còn chỗ hiện lỗi
        });
      }
    };
  }, [sessionId]);

  const queue = useCallback(
    (patch: Patch, immediate = false) => {
      pending.current = {
        ...pending.current,
        ...patch,
        ...(patch.brief
          ? { brief: { ...(pending.current.brief ?? {}), ...patch.brief } }
          : {}),
      };
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
  function patchSource(p: Partial<TextToVideoSource>, immediate = false) {
    if (!source) return;
    const next = { ...source, ...p };
    setSource(next);
    queue({ source: next }, immediate);
  }

  function patchVoice(p: Partial<TextToVideoVoice>) {
    if (!voice) return;
    const next = { ...voice, ...p };
    setVoice(next);
    queue({ voice: next });
  }

  function patchOutput(p: Partial<TextToVideoOutput>) {
    if (!output) return;
    const next = { ...output, ...p };
    setOutput(next);
    queue({ output: next }, true);
  }

  function patchBrief(p: Partial<Brief>) {
    setBrief((b) => (b ? { ...b, ...p } : b));
    queue({ brief: p });
  }

  function patchScriptModel(id: string) {
    setScriptModel(id);
    queue({ scriptModel: id === "" ? null : id }, true);
  }

  function setChunks(next: ScriptChunk[], immediate = false) {
    setScript(next);
    queue({ script: next }, immediate);
  }

  /**
   * Sửa lời một đoạn. Server nhận PATCH script là xóa durationSec của TẤT CẢ
   * các đoạn (và voiceFile) vì giọng phải đọc lại từ đầu - client xóa y hệt,
   * không thì các đoạn chưa sửa vẫn treo chip "thời lượng thật" ma.
   */
  function setChunkText(index: number, text: string) {
    setChunks(
      script.map((c, i) => ({
        ...c,
        text: i === index ? text : c.text,
        durationSec: null,
      })),
      false
    );
  }

  // ---- Chạy bước ----

  async function run(step: "extract" | "script" | "build") {
    if (busy) return;
    // Chặn sớm "Độ dài" ngoài khoảng server chấp nhận - báo lỗi tại chỗ thay vì
    // gửi đi rồi nhận 400 INVALID_TARGET_SECONDS
    if (step === "script" && targetSeconds.trim() !== "") {
      const target = Number(targetSeconds);
      if (
        !Number.isFinite(target) ||
        target < TARGET_SECONDS_MIN ||
        target > TARGET_SECONDS_MAX
      ) {
        setActionError(
          tf("ttv.target-invalid", {
            min: TARGET_SECONDS_MIN,
            max: TARGET_SECONDS_MAX,
          })
        );
        return;
      }
    }
    setBusy(step);
    setActionError(null);
    try {
      // Gửi nốt sửa đổi đang chờ trước - server phải làm việc trên bản mới nhất
      const saveErr = await flush();
      if (saveErr) {
        setActionError(saveErr);
        return;
      }
      if (step === "extract") {
        adopt(await extractTextToVideo(sessionId));
      } else if (step === "script") {
        const target = Number(targetSeconds);
        adopt(
          await scriptTextToVideo(sessionId, {
            ...(targetSeconds.trim() !== "" ? { targetSeconds: target } : {}),
            ...(scriptModel ? { model: scriptModel } : {}),
          })
        );
      } else {
        const { jobId } = await buildTextToVideo(sessionId);
        buildJobId.current = jobId;
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
      await deleteTextToVideo(sessionId);
      router.push("/text-to-video");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  if (!session || !source || !voice || !output || !brief) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t("nav.text-to-video")} />
        {loadError ? (
          <ErrorBanner message={t("ttv.not-found")} detail={loadError} />
        ) : (
          <p className="py-8 text-center text-sm text-[var(--text-muted)]">
            {t("common.loading")}
          </p>
        )}
      </div>
    );
  }

  const running = RUNNING_STATUS.includes(session.status);
  const stage = deriveTtvStage(session);
  const article = session.article;
  const chars = scriptChars(script);
  const estSeconds = estimateScriptSeconds(script);
  const hasSourceText = source.text.trim() !== "" || article !== null;
  const canScript = hasSourceText && !running;
  const canBuild =
    script.length > 0 && voice.name.trim() !== "" && !running && !session.projectId;
  // Ô nhập chỉ khóa khi có việc đang chạy - xong rồi vẫn sửa & chạy lại được
  const locked = running;
  // Kích thước hiện tại khớp preset nào (null = người dùng/server đặt số khác)
  const currentAspect =
    ASPECTS.find(
      (a) =>
        TEXT_TO_VIDEO_SIZES[a].width === output.width &&
        TEXT_TO_VIDEO_SIZES[a].height === output.height
    ) ?? null;
  const activeSession =
    chatSessions?.find((s) => s.sessionId === activeSessionId) ?? null;
  const statusLabel = TEXT_TO_VIDEO_STATUS_LABEL[session.status]
    ? t(TEXT_TO_VIDEO_STATUS_LABEL[session.status])
    : String(session.status);

  // ---- Khối video thành phẩm ----

  const done = session.status === "done";

  /**
   * Job để đo tiến trình: ƯU TIÊN job của project con - job "text-to-video" chỉ
   * chạy tới lúc bàn giao cho AI, còn việc dựng thật nằm ở project con.
   */
  const activeJob =
    child.runningJob ?? (job && job.status === "running" ? job : null);

  const outputStatus: WorkspaceStatus =
    session.status === "failed"
      ? "failed"
      : child.url
        ? "done"
        : running || session.projectId
          ? "running"
          : "idle";

  const aspect = `${output.width} / ${output.height}`;

  // ---- Một dòng tóm tắt cho từng khối lúc gấp ----

  const sourceSummary =
    (source.kind === "url" ? source.url.trim() : "") ||
    article?.title ||
    source.text.trim().slice(0, 140) ||
    t("ttv.no-source-yet");
  const scriptSummary =
    script.length > 0
      ? `${tf("ttv.chunk-count", { n: script.length })} · ${tf("ttv.char-count", {
          n: chars,
        })} · ${tf("ttv.est-duration", { time: clock(estSeconds) })}`
      : hasSourceText
        ? t("ttv.no-script")
        : t("ttv.no-source-yet");
  const voiceSummary = voice.name.trim() || t("ttv.voice-not-chosen");
  const configSummary = `${output.width}x${output.height} · ${output.fps}fps · ${styleDisplayName(
    stylesData,
    output.styleId,
    t
  )}`;
  const buildSummary =
    session.voiceDurationSec !== null
      ? `${statusLabel} · ${tf("ttv.real-duration", {
          time: clock(session.voiceDurationSec),
        })}`
      : statusLabel;

  return (
    <div className="flex flex-col gap-4">
      {/* Không còn `xl:pr-[452px]`: chỗ chừa cho panel AI là việc của shell, và
          con số tay kiểu đó sai ngay khi người dùng gấp panel lại. */}
      <PageHeader
        title={session.name}
        hint={{ titleKey: "help.ttv.title", bodyKey: "help.ttv.body" }}
        subtitle={`${output.width}x${output.height} · ${output.fps}fps`}
        center={
          <StepperBar
            steps={STAGE_LABELS}
            stage={stage.stage}
            active={stage.active}
            done={stage.complete}
            ariaLabel={tf("ttv.stage-aria", {
              stage: stage.stage,
              label: t(STAGE_LABELS[stage.stage - 1]),
            })}
          />
        }
        actions={
          /* Nút xóa đứng CUỐI, ngoài cụm nút thường, ngăn bằng vạch dọc - quy
             ước chung của 7 trang chi tiết, lý do viết đầy đủ ở
             `src/app/images/[id]/page.tsx`. */
          <>
            <span className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => router.push("/text-to-video")}>
                <ArrowLeft size={15} strokeWidth={2} />
                {t("ttv.back")}
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
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)]">
          <Badge
            tone={TEXT_TO_VIDEO_STATUS_TONE[session.status] ?? "muted"}
            label={statusLabel}
          />
          <span className="chip">
            {source.kind === "url" ? t("ttv.source.url") : t("ttv.source.text")}
          </span>
          {script.length > 0 && (
            <span className="chip">{tf("ttv.chunk-count", { n: script.length })}</span>
          )}
          {voice.name && <span className="chip">{voice.name}</span>}
          {session.voiceDurationSec !== null && (
            <span className="chip">
              {tf("ttv.real-duration", { time: clock(session.voiceDurationSec) })}
            </span>
          )}
          {done && group.anyCollapsed && (
            <span className="min-w-0">{t("ttv.section.done-collapsed")}</span>
          )}
          <span className="ml-auto text-meta">
            {t("common.updated")}: {formatDateTime(session.updatedAt)}
          </span>
        </div>
      </Card>

      {loadError && <ErrorBanner message={t("ttv.load-error")} detail={loadError} />}
      {actionError && (
        <ErrorBanner message={t("ttv.action-error")} detail={actionError} />
      )}
      {saveError && <ErrorBanner message={t("ttv.save-error")} detail={saveError} />}

      {session.status === "failed" && (
        <ErrorBanner message={t("ttv.failed")} detail={session.error ?? undefined} />
      )}

      {/* Ba cột theo nhịp làm việc: nguồn → yêu cầu & thiết lập → tiến trình &
          kết quả. Số cột do container query trong globals.css lo, trang không
          tự tính pixel. */}
      <Workspace>
        {/* ================= Cột 1: nguồn ================= */}
        <WorkspaceColumn role="source" title={t("workspace.col.source")}>
          <WorkspaceBlock
            id="ttv-block-source"
            icon={FileText}
            collapsed={group.isCollapsed("source")}
            onToggle={() => group.toggle("source")}
            summary={sourceSummary}
            title={t("ttv.card-source")}
            hint={{
              titleKey: "help.ttv-source.title",
              bodyKey: "help.ttv-source.body",
            }}
            actions={
              // Chỉ hiện với nguồn LINK: dán thẳng văn bản thì không có gì để
              // bóc, mà server trả 400 NO_URL. Nút bấm được rồi báo lỗi còn
              // khó hiểu hơn là không có nút.
              source.kind === "url" ? (
                <Button
                  variant="secondary"
                  small
                  disabled={locked || busy !== null || !source.url.trim()}
                  onClick={() => run("extract")}
                >
                  {busy === "extract" ? (
                    <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                  ) : (
                    <RefreshCw size={14} strokeWidth={2} />
                  )}
                  {article ? t("ttv.re-extract") : t("ttv.extract")}
                </Button>
              ) : undefined
            }
          >
            <div className="flex flex-col gap-3">
              <Segmented
                label={t("ttv.source")}
                value={source.kind}
                disabled={locked}
                onChange={(kind: TextSourceKind) => patchSource({ kind }, true)}
                options={[
                  {
                    value: "url",
                    label: (
                      <>
                        <Link2 size={13} strokeWidth={2} aria-hidden="true" />
                        {t("ttv.source.url")}
                      </>
                    ),
                  },
                  {
                    value: "text",
                    label: (
                      <>
                        <Type size={13} strokeWidth={2} aria-hidden="true" />
                        {t("ttv.source.text")}
                      </>
                    ),
                  },
                ]}
              />

              {source.kind === "url" && (
                <Field label={t("ttv.url")} htmlFor="ttv-detail-url">
                  <input
                    id="ttv-detail-url"
                    className="input"
                    value={source.url}
                    disabled={locked}
                    placeholder={t("ttv.url-placeholder")}
                    onChange={(e) => patchSource({ url: e.target.value })}
                    onBlur={() => flush()}
                  />
                </Field>
              )}

              {session.status === "extracting" && (
                <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                  {t("ttv.extracting-hint")}
                </p>
              )}

              {article && (
                <Panel title={article.title}>
                  <div className="flex flex-wrap items-center gap-2">
                    {article.siteName && <span className="chip">{article.siteName}</span>}
                    {article.byline && <span className="chip">{article.byline}</span>}
                    {article.publishedTime && (
                      <span className="chip">{formatDateTime(article.publishedTime)}</span>
                    )}
                    {article.lang && <span className="chip">{article.lang}</span>}
                    <span className="chip">
                      {tf("ttv.block-count", { n: article.blocks.length })}
                    </span>
                    <span className="chip">
                      {tf("ttv.char-count", { n: article.chars })}
                    </span>
                  </div>
                  {article.canonicalUrl && (
                    <a
                      href={article.canonicalUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex max-w-full items-center gap-1 text-meta font-medium text-[var(--primary)] transition-colors duration-150 hover:text-[var(--primary-hover)]"
                    >
                      <ExternalLink size={13} strokeWidth={2} className="shrink-0" />
                      <span className="truncate">{article.canonicalUrl}</span>
                    </a>
                  )}
                </Panel>
              )}

              {/* Ô người dùng GÕ VÀO - `.input` chuẩn 14px, không thu nhỏ chữ */}
              <Field
                label={t("ttv.content")}
                htmlFor="ttv-detail-text"
                hint={`${t("ttv.content-hint")} · ${tf("ttv.char-count", {
                  n: source.text.trim().length,
                })}`}
              >
                <textarea
                  id="ttv-detail-text"
                  className="input"
                  rows={10}
                  value={source.text}
                  disabled={locked}
                  placeholder={
                    source.kind === "url"
                      ? t("ttv.content-placeholder-url")
                      : t("ttv.text-placeholder")
                  }
                  onChange={(e) => patchSource({ text: e.target.value })}
                  onBlur={() => flush()}
                />
              </Field>
            </div>
          </WorkspaceBlock>
        </WorkspaceColumn>

        {/* ============ Cột 2: yêu cầu & thiết lập ============ */}
        <WorkspaceColumn role="setup" title={t("workspace.col.setup")}>
          {/* Kịch bản đọc đứng đầu cột: nó sinh ra TỪ nguồn ở cột bên trái, để
              cạnh nhau thì đối chiếu được mà không phải cuộn qua lại */}
          <WorkspaceBlock
            id="ttv-block-script"
            icon={Sparkles}
            collapsed={group.isCollapsed("script")}
            onToggle={() => group.toggle("script")}
            summary={scriptSummary}
            title={t("ttv.card-script")}
            hint={{
              titleKey: "help.ttv-script.title",
              bodyKey: "help.ttv-script.body",
            }}
            actions={
              <Button
                small
                disabled={!canScript || busy !== null}
                onClick={() => run("script")}
              >
                {busy === "script" ? (
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Wand2 size={14} strokeWidth={2} />
                )}
                {script.length > 0 ? t("ttv.rewrite-script") : t("ttv.write-script")}
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              {/* Ai viết + viết dài bao nhiêu - hai tham số của nút bên trên */}
              <Panel>
                {/* auto-fit chứ KHÔNG `sm:grid-cols-2`: `sm:` đo bề rộng CỬA SỔ,
                    còn cặp ô này nằm trong cột workspace rộng ~340-390px, nên ở
                    mọi màn desktop nó đều bị chia đôi trong cột hẹp và chữ vỡ.
                    Bề rộng thật do container query của workspace quyết định -
                    lưới phải co theo chỗ thật, không theo bề rộng cửa sổ. */}
                <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
                  <ScriptModelSelect
                    value={scriptModel}
                    disabled={locked}
                    onChange={patchScriptModel}
                  />
                  <Field label={t("ttv.target-seconds")} htmlFor="ttv-target-seconds">
                    <input
                      id="ttv-target-seconds"
                      className="input"
                      type="number"
                      min={TARGET_SECONDS_MIN}
                      max={TARGET_SECONDS_MAX}
                      value={targetSeconds}
                      disabled={locked}
                      placeholder={t("ttv.target-auto")}
                      onChange={(e) => setTargetSeconds(e.target.value)}
                    />
                  </Field>
                </div>
                <ClaudeAuthLine />
              </Panel>

              {session.status === "scripting" ? (
                <p className="flex items-center gap-2 py-4 text-sm text-[var(--text-muted)]">
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                  {t("ttv.scripting-hint")}
                </p>
              ) : script.length === 0 ? (
                <EmptyState
                  icon={Sparkles}
                  description={hasSourceText ? t("ttv.no-script") : t("ttv.no-source-yet")}
                />
              ) : (
                <div className="flex flex-col gap-3">
                  {/* Mỗi đoạn KHÔNG có viền riêng: chính `.input` của textarea đã
                      là một cái viền rồi, bọc thêm một viền nữa (trong card) là ba
                      lớp lồng nhau mà chẳng nói thêm được gì. */}
                  <ul className="flex flex-col gap-2">
                    {script.map((c, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="mt-2 w-5 shrink-0 text-center font-mono text-meta text-[var(--text-muted)]">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <textarea
                            className="input"
                            rows={2}
                            value={c.text}
                            disabled={locked}
                            aria-label={tf("ttv.chunk-aria", { n: i + 1 })}
                            onChange={(e) => setChunkText(i, e.target.value)}
                            onBlur={() => flush()}
                          />
                          <p className="mt-1 text-meta text-[var(--text-muted)]">
                            {tf("ttv.char-count", { n: c.text.trim().length })} ·{" "}
                            {c.durationSec !== null
                              ? tf("ttv.chunk-real", { time: clock(c.durationSec) })
                              : tf("ttv.chunk-est", {
                                  time: clock(estimateChunkSeconds(c)),
                                })}
                          </p>
                        </div>
                        <IconButton
                          size="sm"
                          tone="danger"
                          className="mt-2"
                          label={tf("ttv.remove-chunk-aria", { n: i + 1 })}
                          disabled={locked}
                          onClick={() =>
                            setChunks(
                              script.filter((_, idx) => idx !== i),
                              true
                            )
                          }
                        >
                          <X size={14} strokeWidth={2} />
                        </IconButton>
                      </li>
                    ))}
                  </ul>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button
                      variant="secondary"
                      small
                      disabled={locked}
                      onClick={() =>
                        setChunks([...script, { text: "", durationSec: null }], true)
                      }
                    >
                      <Plus size={14} strokeWidth={2} />
                      {t("ttv.add-chunk")}
                    </Button>
                    <span className="text-meta text-[var(--text-muted)]">
                      {tf("ttv.chunk-count", { n: script.length })} ·{" "}
                      {tf("ttv.char-count", { n: chars })} ·{" "}
                      {tf("ttv.est-duration", { time: clock(estSeconds) })}
                      {session.voiceDurationSec !== null
                        ? ` · ${tf("ttv.real-duration", { time: clock(session.voiceDurationSec) })}`
                        : ""}
                    </span>
                  </div>

                  <p className="text-sm text-[var(--text-muted)]">
                    {t("ttv.estimate-warning")}
                  </p>
                </div>
              )}
            </div>
          </WorkspaceBlock>

          {/* ---- Giọng đọc ---- */}
          <WorkspaceBlock
            id="ttv-block-voice"
            icon={Mic}
            collapsed={group.isCollapsed("voice")}
            onToggle={() => group.toggle("voice")}
            summary={voiceSummary}
            hint={{
              titleKey: "help.ttv-voice.title",
              bodyKey: "help.ttv-voice.body",
            }}
            title={
              <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
                {t("ttv.card-voice")}
                {/* Nhãn PHÂN LOẠI (đang chọn giọng nào), không phải trạng thái
                    chạy - nên bỏ chấm tròn */}
                <Badge
                  tone={voice.name ? "running" : "muted"}
                  dot={false}
                  label={voice.name || t("ttv.voice-not-chosen")}
                  // truncate chứ không chỉ min-w-0: .badge là inline-flex +
                  // white-space:nowrap và KHÔNG có overflow:hidden, nên min-w-0
                  // cho pill co lại còn chữ thì vẽ đè ra ngoài nền. Tên giọng
                  // nhân bản do người dùng tự đặt nên dài bao nhiêu cũng có.
                  className="min-w-0 [&>span]:truncate truncate"
                />
              </span>
            }
          >
            <VoicePicker value={voice} onChange={patchVoice} disabled={locked} />
          </WorkspaceBlock>

          {/* ---- Cấu hình video ---- */}
          <WorkspaceBlock
            id="ttv-block-config"
            icon={Settings2}
            collapsed={group.isCollapsed("config")}
            onToggle={() => group.toggle("config")}
            summary={configSummary}
            title={t("ttv.card-config")}
            hint={{
              titleKey: "help.ttv-config.title",
              bodyKey: "help.ttv-config.body",
            }}
          >
            <div className="flex flex-col gap-4">
              <Field
                label={t("ttv.aspect")}
                hint={
                  currentAspect === null
                    ? tf("ttv.custom-size", {
                        size: `${output.width}x${output.height}`,
                      })
                    : undefined
                }
              >
                <OptionCardGroup
                  label={t("ttv.aspect")}
                  className="grid-cols-[repeat(auto-fit,minmax(120px,1fr))]"
                >
                  {ASPECTS.map((a) => {
                    const size = TEXT_TO_VIDEO_SIZES[a];
                    return (
                      <OptionCard
                        key={a}
                        selected={currentAspect === a}
                        disabled={locked}
                        onSelect={() =>
                          patchOutput({ width: size.width, height: size.height })
                        }
                        title={a}
                        description={`${size.width}x${size.height}`}
                      />
                    );
                  })}
                </OptionCardGroup>
              </Field>

              {/* auto-fit, không `sm:grid-cols-2` - xem lý do ở lưới trong khối
                  Kịch bản đọc phía trên */}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
                <Field label={t("ttv.fps")} htmlFor="ttv-fps">
                  <select
                    id="ttv-fps"
                    className="input"
                    value={output.fps}
                    disabled={locked}
                    onChange={(e) => patchOutput({ fps: Number(e.target.value) })}
                  >
                    {!TEXT_TO_VIDEO_FPS.includes(
                      output.fps as (typeof TEXT_TO_VIDEO_FPS)[number]
                    ) && <option value={output.fps}>{output.fps}</option>}
                    {TEXT_TO_VIDEO_FPS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Style Design" htmlFor="ttv-style">
                  <StyleSelect
                    id="ttv-style"
                    value={output.styleId}
                    disabled={locked}
                    onChange={(styleId) => patchOutput({ styleId })}
                  />
                </Field>
              </div>

              <div className="border-t border-[var(--border)] pt-4">
                <div className="mb-3 flex flex-col gap-1 text-sm text-[var(--text-muted)]">
                  <p>{locked ? t("ttv.brief-locked") : t("ttv.brief-hint")}</p>
                  {!locked && <p>{t("ttv.brief-autosave")}</p>}
                </div>
                <BriefFields
                  value={brief}
                  onChange={patchBrief}
                  // Style Design đã có ô riêng phía trên; không có video gốc để mô tả
                  show={{ styleId: false, sourceDescription: false }}
                  disabled={locked}
                />
              </div>
            </div>
          </WorkspaceBlock>
        </WorkspaceColumn>

        {/* ============ Cột 3: tiến trình & kết quả ============ */}
        <WorkspaceColumn role="output" title={t("workspace.col.output")}>
          {/* Khối ĐẦU TIÊN của cột: đang dựng thì nhấp nháy chờ, xong thì hiện
              thẳng video. Liếc một chỗ là biết phiên đang ở đâu. */}
          <OutputBlock
            id="ttv-block-build"
            status={outputStatus}
            videoUrl={child.url}
            progress={activeJob ? activeJob.progress : null}
            step={activeJob?.step}
            aspect={aspect}
            error={shortError(session.error)}
            collapsed={group.isCollapsed("build")}
            onToggle={() => group.toggle("build")}
            summary={buildSummary}
            title={t("ttv.card-build")}
            hint={{
              titleKey: "help.ttv-build.title",
              bodyKey: "help.ttv-build.body",
            }}
            actions={
              !session.projectId && (
                <Button disabled={!canBuild || busy !== null} onClick={() => run("build")}>
                  {busy === "build" ? (
                    <Loader2 size={15} strokeWidth={2} className="animate-spin" />
                  ) : (
                    <FileText size={15} strokeWidth={2} />
                  )}
                  {t("ttv.build")}
                </Button>
              )
            }
          >
            {child.error && <ErrorBanner message={child.error} />}

            {running ? (
              <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                {session.status === "voicing"
                  ? t("ttv.voicing-hint")
                  : t("ttv.building-hint")}
              </p>
            ) : session.projectId ? (
              !child.url && (
                <p className="text-sm text-[var(--text-muted)]">
                  {t("ttv.result-waiting")}
                </p>
              )
            ) : (
              <p className="text-sm text-[var(--text-muted)]">
                {canBuild
                  ? t("ttv.build-hint")
                  : script.length === 0
                    ? t("ttv.build-need-script")
                    : t("ttv.build-need-voice")}
              </p>
            )}

            {child.output && (
              <span className="min-w-0 truncate text-meta text-[var(--text-muted)]">
                {child.output}
              </span>
            )}

            {(session.voiceFile || session.transcriptFile) && (
              <div className="flex flex-wrap items-center gap-2">
                {session.voiceFile && (
                  <span className="chip">
                    {t("ttv.voice-file")}: {session.voiceFile}
                  </span>
                )}
                {session.transcriptFile && (
                  <span className="chip">
                    {t("ttv.transcript-file")}: {session.transcriptFile}
                  </span>
                )}
              </div>
            )}

            {/* Link sang project con cho các thao tác nâng cao (render lại, QC,
                cắt short) - vẫn là đường phụ, không phải chỗ xem thành phẩm */}
            {session.projectId && (
              <Link
                href={`/projects/${session.projectId}`}
                className="inline-flex w-fit items-center gap-2 text-sm font-medium text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--primary)]"
              >
                <ExternalLink size={14} strokeWidth={2} />
                {t("ttv.open-project-advanced")}
              </Link>
            )}
          </OutputBlock>

          {/* Tiến trình THẬT của project con - thứ mà trước đây không nhìn thấy được.
              Nhật ký job dựng KHÔNG nằm ở đây nữa: nó chỉ có một chỗ, trong panel
              AI bên phải, chứ không hiện hai bản cạnh nhau. */}
          <WorkspaceBlock
            id="ttv-block-child"
            icon={ListVideo}
            collapsed={group.isCollapsed("child")}
            onToggle={() => group.toggle("child")}
            summary={session.projectId ?? t("ttv.build.no-project")}
            title={t("ttv.build.child-title")}
          >
            {!session.projectId ? (
              <p className="text-sm text-[var(--text-muted)]">
                {t("ttv.build.no-project")}
              </p>
            ) : child.pipelineInput && deriveStage(child.pipelineInput) !== null ? (
              <div className="flex flex-col gap-2">
                <PipelineTimeline {...child.pipelineInput} />
                {child.runningJob ? (
                  <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                    <Loader2
                      size={14}
                      strokeWidth={2}
                      className="animate-spin shrink-0"
                    />
                    {tf("ttv.build.running-job", { label: child.runningJob.type })}
                    {child.runningJob.progress > 0
                      ? ` · ${child.runningJob.progress}%`
                      : ""}
                  </p>
                ) : (
                  !child.url && (
                    <p className="text-sm text-[var(--text-muted)]">
                      {t("ttv.build.long-warning")}
                    </p>
                  )
                )}
                <Link
                  href={`/projects/${session.projectId}`}
                  className="inline-flex w-fit items-center gap-1 text-sm font-medium text-[var(--primary)] hover:underline"
                >
                  <ExternalLink size={14} strokeWidth={2} />
                  {t("ttv.build.open-project")}
                </Link>
              </div>
            ) : (
              <p className="text-sm text-[var(--text-muted)]">
                {t("ttv.build.waiting")}
              </p>
            )}
          </WorkspaceBlock>
        </WorkspaceColumn>
      </Workspace>

      {/* Panel AI: chỉ KHAI BÁO nội dung, shell lo bề rộng/gấp/drawer. Cây React
          vẫn nằm ở trang này nên state và SSE của ChatThread giữ nguyên. */}
      <ShellRightPanel title={t("ttv.ai-panel")}>
        {activeSession && (
          <div className="flex shrink-0 justify-end">
            <SessionStatusBadge status={activeSession.status} />
          </div>
        )}

        {/* Nhật ký job dựng - ĐÚNG MỘT CHỖ trên trang. Trước đây nó vừa nằm đây
            vừa có một khối riêng ở cột kết quả, hai bản cùng chảy log một lúc. */}
        {job && <JobLogBlock job={job} />}

        {session.projectId ? (
          activeSessionId || (chatSessions !== null && chatSessions.length > 0) ? (
            <ChatThread
              compact
              sessionId={activeSessionId}
              projectId={session.projectId}
              initialStatus={activeSession?.status}
              session={activeSession}
              onSessionCreated={(id) => {
                setActiveSessionId(id);
                loadChatSessions();
              }}
            />
          ) : (
            <div className="card flex min-h-0 flex-1 flex-col items-center justify-center">
              <EmptyState
                icon={Sparkles}
                description={
                  chatSessions === null
                    ? t("ttv.panel-chat-loading")
                    : t("ttv.panel-no-session")
                }
              />
            </div>
          )
        ) : (
          // Chưa dựng thì chưa có phiên AI nào - chỉ còn một lời giải thích để
          // panel không trống trơn.
          <div className="card flex min-h-0 flex-1 flex-col items-center justify-center">
            <EmptyState icon={MessageSquare} description={t("ttv.panel-empty")} />
          </div>
        )}
      </ShellRightPanel>

      <ConfirmDeleteModal
        open={deleteOpen}
        title={t("ttv.delete-title")}
        description={<p>{t("ttv.delete-desc")}</p>}
        items={[session.name]}
        busy={deleting}
        error={deleteError}
        onClose={() => setDeleteOpen(false)}
        onConfirm={onDelete}
      />
    </div>
  );
}
