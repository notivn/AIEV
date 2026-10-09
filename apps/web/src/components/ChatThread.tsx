"use client";

/**
 * Khung hội thoại với Claude - dùng chung cho trang Chat và panel AI trong
 * trang project. Tự load lịch sử khi sessionId đổi, nghe SSE agent (lọc theo
 * session), stream text, chip công cụ, progress strip, input gửi tin và nút Dừng.
 *
 * - sessionId = null: phiên mới - tin nhắn đầu tiên sẽ tạo session
 *   (kèm projectId nếu có) rồi báo lên qua onSessionCreated.
 * - compact: kích thước gọn để nhúng trong panel hẹp.
 */

import { MessageSquare, Send, Square, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getChatMessages,
  getChatSessions,
  interruptChat,
  sendChat,
  setChatAutoResume,
  type AgentEffort,
  type ChatSession,
  type ChatSessionStatus,
} from "@/lib/api";
import { useAgentEvents } from "@/lib/useEvents";
import {
  AiModelInlineRow,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
} from "@/components/ModelPicker";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { SessionStatusBadge } from "@/components/SessionStatusBadge";
import { useT } from "@/lib/i18n";

interface UiMessage {
  role: "user" | "assistant";
  kind: "text" | "tool";
  content: string;
  toolName?: string;
}

function truncate(s: string, max = 100): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function ToolChip({ name, input }: { name: string; input?: string }) {
  return (
    <span className="chip">
      <Wrench size={12} strokeWidth={2} className="shrink-0" />
      <span className="font-medium text-[var(--text)]">{name}</span>
      {input && <span className="truncate">{truncate(input)}</span>}
    </span>
  );
}

/** Diễn giải tool đang chạy thành hành động dễ hiểu - theo ngôn ngữ UI. */
export function toolActionLabel(
  name: string,
  input: unknown,
  t: (key: string) => string
): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const file =
    typeof inp.file_path === "string"
      ? String(inp.file_path).split(/[\\/]/).pop()
      : undefined;
  const sub = (key: string, vars: Record<string, string>) => {
    let out = t(key);
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{${k}}`).join(v);
    }
    return out;
  };
  switch (name) {
    case "Bash":
      return typeof inp.description === "string" && inp.description
        ? sub("chat.tool.bash-desc", { desc: inp.description })
        : t("chat.tool.bash");
    case "Read":
      return file ? sub("chat.tool.read-file", { file }) : t("chat.tool.read");
    case "Write":
      return file ? sub("chat.tool.write-file", { file }) : t("chat.tool.write");
    case "Edit":
      return file ? sub("chat.tool.edit-file", { file }) : t("chat.tool.edit");
    case "Glob":
    case "Grep":
      return t("chat.tool.search");
    case "Skill":
      return typeof inp.skill === "string"
        ? sub("chat.tool.skill-name", { skill: inp.skill })
        : t("chat.tool.skill");
    case "TodoWrite":
      return t("chat.tool.todo");
    case "WebFetch":
    case "WebSearch":
      return t("chat.tool.web");
    default:
      return sub("chat.tool.generic", { name });
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Bubble({ msg, compact }: { msg: UiMessage; compact: boolean }) {
  if (msg.kind === "tool") {
    return (
      <div className="flex justify-start">
        <ToolChip name={msg.toolName ?? "tool"} input={msg.content} />
      </div>
    );
  }
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      {/* compact chỉ bóp KHOẢNG ĐỆM, không bóp chữ: nội dung hội thoại là thứ
          người dùng đọc kỹ nhất trong panel, thu nhỏ nó là sai chỗ nhất. */}
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-[var(--radius-lg)] text-sm ${
          compact ? "px-3 py-2" : "px-4 py-2.5"
        } ${
          isUser
            ? "bg-[var(--primary-soft)]"
            : "border border-[var(--border)] bg-[var(--surface)]"
        }`}
      >
        {msg.content}
      </div>
    </div>
  );
}

/**
 * Khối kết thúc phiên - hiển thị rõ kết cục thay vì chỉ tắt progress bar.
 * Ba tông của <Banner> thay ba hộp tự chế trước đây (mỗi hộp một nền, một icon,
 * một padding riêng).
 */
function SessionEndBlock({
  status,
  finalText,
}: {
  status: ChatSessionStatus;
  finalText: string | null;
}) {
  const { t } = useT();
  const text = finalText ? (
    <p className="mt-1.5 whitespace-pre-wrap text-sm">{finalText}</p>
  ) : null;

  if (status === "done") {
    return (
      <Banner tone="success" message={t("chat.done")}>
        {text}
      </Banner>
    );
  }
  if (status === "error") {
    return (
      <Banner tone="danger" message={t("chat.ended-error")}>
        {text}
      </Banner>
    );
  }
  if (status === "interrupted") {
    return <Banner tone="muted" message={t("chat.interrupted")} />;
  }
  return null;
}

export function ChatThread({
  sessionId,
  projectId,
  initialStatus,
  session = null,
  onSessionCreated,
  compact = false,
  providersEnabled = false,
  send,
  emptyText,
}: {
  sessionId: string | null;
  projectId?: string;
  /** Trạng thái đã lưu của phiên (từ GET /api/chat/sessions) - dùng làm trạng thái ban đầu khi mở lại phiên cũ. */
  initialStatus?: ChatSessionStatus;
  /**
   * Bản ghi session đầy đủ (nếu parent có) - nguồn runStartedAt/runFinishedAt/
   * autoResume để timer chạy bền qua F5 và toggle "Tự chạy tiếp".
   */
  session?: ChatSession | null;
  onSessionCreated?: (id: string) => void;
  compact?: boolean;
  /** Cho chọn model/mode khi tạo phiên MỚI (hàng select nhỏ phía trên input). */
  providersEnabled?: boolean;
  /**
   * Gửi tin qua endpoint KHÁC /api/chat (vd trình chỉnh sửa gửi qua
   * POST /projects/:id/editor/chat). Nhận sessionId hiện tại (undefined = phiên
   * mới) và model/effort khi tạo phiên mới; trả sessionId như sendChat. Bỏ trống
   * = sendChat mặc định (kèm projectId khi tạo phiên).
   */
  send?: (
    message: string,
    sessionId: string | undefined,
    opts?: { model?: string; effort?: AgentEffort }
  ) => Promise<{ sessionId: string }>;
  /** Câu gợi ý lúc chưa có tin nhắn nào - mặc định là câu chung của chat */
  emptyText?: string;
}) {
  const { t, tf } = useT();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [streamText, setStreamText] = useState("");
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  // Trạng thái phiên đang xem - khởi tạo từ DB, cập nhật sống theo SSE
  const [status, setStatus] = useState<ChatSessionStatus | null>(null);
  // Model/mode cho phiên MỚI (chỉ có tác dụng ở tin nhắn tạo session)
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState<AgentEffort>(DEFAULT_EFFORT);
  const initialStatusRef = useRef(initialStatus);
  initialStatusRef.current = initialStatus;
  const sessionPropRef = useRef(session);
  sessionPropRef.current = session;

  // Bản ghi session đầy đủ (runStartedAt/runFinishedAt/autoResume) - khởi tạo
  // từ prop, refetch sau khi phiên kết thúc để lấy runFinishedAt/status mới.
  const [sessionInfo, setSessionInfo] = useState<ChatSession | null>(null);

  // Tiến trình công việc AI: số bước tool đã chạy + hành động hiện tại + thời gian
  const [steps, setSteps] = useState(0);
  const [currentAction, setCurrentAction] = useState(t("chat.thinking"));
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Phiên VỪA lỗi ngay trước mắt (SSE) - chỉ khi đó server mới lên lịch tự chạy tiếp;
  // phiên lỗi cũ mở lại thì không (tránh hứa "sẽ tự chạy tiếp" suông).
  const [justFailed, setJustFailed] = useState(false);

  useEffect(() => {
    if (!running || startedAt === null) return;
    // clamp ≥ 0 - runStartedAt từ server có thể lệch giờ với máy client
    const t = setInterval(
      () => setElapsed(Math.max(0, Date.now() - startedAt)),
      1000
    );
    return () => clearInterval(t);
  }, [running, startedAt]);

  /** Đánh dấu agent đang chạy (cả khi mở lại session edit đang chạy dở) */
  const markRunning = useCallback(() => {
    setRunning((r) => {
      if (!r) {
        setStartedAt((s) => s ?? Date.now());
      }
      return true;
    });
  }, []);

  // Session đang hiển thị thực tế - có thể đi trước prop khi vừa tạo session mới.
  // Khởi tạo undefined (sentinel) để effect load lịch sử luôn chạy ở lần mount đầu.
  const activeIdRef = useRef<string | null | undefined>(undefined);
  const streamRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Chốt phần text đang stream thành một bong bóng assistant. */
  const flushStream = useCallback(() => {
    const text = streamRef.current;
    streamRef.current = "";
    setStreamText("");
    if (text) {
      setMessages((m) => [
        ...m,
        { role: "assistant", kind: "text", content: text },
      ]);
    }
  }, []);

  // sessionId prop đổi → reset và load lịch sử phiên đó
  useEffect(() => {
    if (sessionId === activeIdRef.current) return;
    activeIdRef.current = sessionId;
    streamRef.current = "";
    setStreamText("");
    setMessages([]);
    setAgentError(null);
    setLoadError(null);
    const savedSession =
      sessionId && sessionPropRef.current?.sessionId === sessionId
        ? sessionPropRef.current
        : null;
    setSessionInfo(savedSession);
    // Trạng thái ban đầu lấy từ DB (session.status) - phiên đang chạy thì hiện
    // progress ngay, không chờ event SSE đầu tiên.
    const saved = sessionId ? (initialStatusRef.current ?? null) : null;
    setStatus(saved);
    setJustFailed(false);
    if (saved === "running") {
      setRunning(true);
      // Timer bền qua F5: đếm từ runStartedAt của server (không phải lúc mount).
      const runStarted = savedSession?.runStartedAt
        ? Date.parse(savedSession.runStartedAt)
        : NaN;
      const started = Number.isFinite(runStarted) ? runStarted : Date.now();
      setStartedAt(started);
      setElapsed(Math.max(0, Date.now() - started));
      setSteps(0);
      setCurrentAction(t("chat.working"));
    } else {
      setRunning(false);
    }
    if (!sessionId) return;
    let stale = false;
    (async () => {
      try {
        const history = await getChatMessages(sessionId);
        if (stale) return;
        setMessages(
          history.map((m) => ({
            role: m.role,
            kind: m.kind,
            content: m.content,
          }))
        );
      } catch (e) {
        if (!stale) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [sessionId]);

  // Prop session đổi (parent reload danh sách phiên) → đồng bộ vào sessionInfo
  useEffect(() => {
    if (session && session.sessionId === activeIdRef.current) {
      setSessionInfo(session);
      // Phiên đang chạy mà timer khởi từ Date.now() (biết chạy qua SSE) →
      // chỉnh về mốc runStartedAt của server nếu SỚM hơn (không nhảy lùi).
      if (session.status === "running" && session.runStartedAt) {
        const t = Date.parse(session.runStartedAt);
        if (Number.isFinite(t)) {
          setStartedAt((s) => (s !== null && t < s ? t : s));
        }
      }
      // Trạng thái "running" về MUỘN hơn lúc mount (onStartEdit set session id
      // trước khi loadSessions xong) → bật progress, đừng để panel im lặng chờ SSE.
      if (session.status === "running" && !running) {
        setRunning(true);
        setStatus("running");
        const ts = session.runStartedAt
          ? Date.parse(session.runStartedAt)
          : NaN;
        setStartedAt(Number.isFinite(ts) ? ts : Date.now());
        setCurrentAction(t("chat.working"));
      }
      // Chiều ngược lại: SSE rớt (máy ngủ, backend restart) đúng lúc phiên kết
      // thúc nên `done` không bao giờ tới - panel kẹt progress + nút Dừng mãi
      // mãi. Server báo đã xong SAU mốc bắt đầu lượt này thì tin server. So mốc
      // runFinishedAt để danh sách phiên tải về trước khi lượt mới chạy không
      // tắt nhầm progress của lượt mới.
      const finished = session.runFinishedAt ? Date.parse(session.runFinishedAt) : NaN;
      if (
        running &&
        session.status !== "running" &&
        Number.isFinite(finished) &&
        startedAt !== null &&
        finished >= startedAt
      ) {
        flushStream();
        setStatus(session.status);
        setRunning(false);
        setStartedAt(null);
        setJustFailed(session.status === "error");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ phản ứng khi prop session đổi
  }, [session]);

  /**
   * Refetch bản ghi session đang mở (API sessions theo project) - gọi sau khi
   * phiên kết thúc để lấy runFinishedAt/status/autoResume mới nhất từ DB.
   */
  const refreshSession = useCallback(async () => {
    const current = activeIdRef.current;
    if (!current) return;
    try {
      const list = await getChatSessions(projectId);
      const found = list.find((s) => s.sessionId === current);
      if (found && activeIdRef.current === current) {
        setSessionInfo(found);
        // Đồng bộ cả badge trạng thái từ DB - đây là đường lùi khi event done
        // thiếu status, không đồng bộ thì badge kẹt "Đang chạy" vô hạn
        setStatus(found.status);
      }
    } catch {
      // không tra được - giữ thông tin cũ, không chặn UI
    }
  }, [projectId]);

  // Realtime agent events - chỉ nhận event của session đang mở
  useAgentEvents((e) => {
    if (!activeIdRef.current || e.sessionId !== activeIdRef.current) return;
    switch (e.kind) {
      case "text":
        markRunning();
        setStatus("running");
        setCurrentAction(t("dash.composing"));
        streamRef.current += e.text ?? "";
        setStreamText(streamRef.current);
        break;
      case "tool":
        markRunning();
        setStatus("running");
        setSteps((n) => n + 1);
        setCurrentAction(
          toolActionLabel(e.tool?.name ?? "tool", e.tool?.input, t)
        );
        // chốt phần text đang stream rồi chèn chip công cụ
        flushStream();
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            kind: "tool",
            toolName: e.tool?.name ?? "tool",
            content:
              e.tool?.input !== undefined ? JSON.stringify(e.tool.input) : "",
          },
        ]);
        break;
      case "result":
        // nếu không có text đã stream thì dùng text của result, tránh lặp đôi
        if (!streamRef.current && e.text) {
          setMessages((m) => [
            ...m,
            { role: "assistant", kind: "text", content: e.text ?? "" },
          ]);
        } else {
          flushStream();
        }
        break;
      case "error":
        flushStream();
        setAgentError(e.error ?? t("chat.unknown-error"));
        setStatus("error");
        setRunning(false);
        // Bỏ mốc của lượt vừa xong: lượt sau (kể cả bắt đầu qua SSE) phải có mốc
        // riêng, không thì so runFinishedAt của lượt cũ sẽ tắt nhầm lượt mới
        setStartedAt(null);
        setJustFailed(true);
        refreshSession();
        break;
      case "done":
        // done kèm kết cục của phiên → cập nhật badge + khối kết thúc,
        // không chỉ lặng lẽ tắt progress bar. Server luôn gửi kèm `status`
        // (kể cả khi lỗi: "error"); nếu vì lý do gì thiếu thì GIỮ status hiện
        // tại chứ không tự suy ra "done" - đổi một phiên lỗi thành thành công.
        flushStream();
        if (e.status) setStatus(e.status);
        setRunning(false);
        setStartedAt(null);
        setJustFailed(e.status === "error");
        // refetch session để lấy runFinishedAt/status mới → dòng thời lượng
        refreshSession();
        break;
    }
  });

  // Auto-scroll (cả khi khối kết thúc phiên xuất hiện)
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, status]);

  async function onSend() {
    const message = input.trim();
    if (!message || running) return;
    setInput("");
    setAgentError(null);
    setMessages((m) => [...m, { role: "user", kind: "text", content: message }]);
    setSteps(0);
    setCurrentAction(t("chat.thinking"));
    setStartedAt(Date.now());
    setElapsed(0);
    setRunning(true);
    setStatus("running");
    setJustFailed(false);
    try {
      const current = activeIdRef.current;
      // model/effort chỉ gửi khi TẠO session mới - session cũ giữ model đã lưu
      const opts = !current && providersEnabled ? { model, effort } : undefined;
      const res = send
        ? await send(message, current ?? undefined, opts)
        : await sendChat(
            message,
            current ?? undefined,
            current ? undefined : projectId,
            opts
          );
      if (res.sessionId !== current) {
        activeIdRef.current = res.sessionId;
        onSessionCreated?.(res.sessionId);
      }
    } catch (e) {
      // Gửi thất bại: gỡ bubble optimistic + trả lại nội dung vào ô nhập (không mất chữ đã gõ)
      setMessages((m) => m.slice(0, -1));
      setInput(message);
      setRunning(false);
      setStatus(null);
      setAgentError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onInterrupt() {
    const current = activeIdRef.current;
    if (!current) return;
    try {
      await interruptChat(current);
      setRunning(false);
      setStartedAt(null);
      setStatus("interrupted");
      refreshSession();
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Toggle "Tự chạy tiếp khi gián đoạn" - optimistic, revert nếu lỗi. */
  async function onToggleAutoResume() {
    const current = activeIdRef.current;
    if (!current || !sessionInfo) return;
    const next = !sessionInfo.autoResume;
    setSessionInfo((s) => (s ? { ...s, autoResume: next } : s));
    try {
      await setChatAutoResume(current, next);
    } catch (e) {
      setSessionInfo((s) => (s ? { ...s, autoResume: !next } : s));
      setAgentError(e instanceof Error ? e.message : String(e));
    }
  }

  // Khối kết thúc phiên: done hiện "✓ Hoàn thành" kèm message text cuối của
  // assistant (kết quả final) - tách khỏi danh sách bubble để không lặp đôi.
  const showEndBlock =
    !running &&
    (status === "done" || status === "error" || status === "interrupted");

  // Thời lượng lượt chạy vừa xong = runFinishedAt − runStartedAt (từ DB)
  let runDurationMs: number | null = null;
  if (
    showEndBlock &&
    sessionInfo?.runStartedAt &&
    sessionInfo?.runFinishedAt
  ) {
    const d =
      Date.parse(sessionInfo.runFinishedAt) -
      Date.parse(sessionInfo.runStartedAt);
    if (Number.isFinite(d)) runDurationMs = Math.max(0, d);
  }
  const runDurationLabel =
    runDurationMs !== null
      ? status === "done"
        ? tf("chat.done-in", { time: formatElapsed(runDurationMs) })
        : tf("chat.stopped-after", { time: formatElapsed(runDurationMs) })
      : null;

  // Chỉ phiên VỪA lỗi trước mắt mới được server lên lịch tự chạy tiếp
  // (user bấm dừng = interrupted → không bao giờ auto-resume)
  const willAutoResume =
    !running && justFailed && status === "error" && sessionInfo?.autoResume === true;
  let visibleMessages = messages;
  let finalText: string | null = null;
  if (showEndBlock) {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant" && last.kind === "text") {
      finalText = last.content;
      visibleMessages = messages.slice(0, -1);
    }
  }

  return (
    <div className="card flex min-h-0 flex-1 flex-col overflow-hidden p-0">
      {/* Header trạng thái phiên đang xem */}
      {sessionId && status && (
        // Tiêu đề ĐÚNG hình dạng tiêu đề của <Card> (14px/600): khung này là một
        // card tự dựng (cần vùng cuộn riêng), nên header của nó không được là
        // một kiểu chữ khác với mọi card còn lại của app.
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2">
          <h2 className="text-sm font-semibold">{t("chat.session")}</h2>
          <div className="flex min-w-0 items-center gap-3">
            {runDurationLabel && (
              <span className="truncate text-meta text-[var(--text-muted)]">
                {runDurationLabel}
              </span>
            )}
            {sessionInfo && (
              <span
                className="flex shrink-0 items-center gap-2"
                title={t("chat.auto-resume-title")}
              >
                <button
                  type="button"
                  className="cursor-pointer text-meta text-[var(--text-muted)]"
                  onClick={onToggleAutoResume}
                >
                  {t("chat.auto-resume")}
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={sessionInfo.autoResume}
                  aria-label={t("chat.auto-resume-aria")}
                  className="switch"
                  onClick={onToggleAutoResume}
                />
              </span>
            )}
            <SessionStatusBadge status={status} large />
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className={`flex min-h-0 flex-1 flex-col overflow-y-auto ${
          compact ? "gap-2 p-3" : "gap-3 p-4"
        }`}
      >
        {loadError && (
          <ErrorBanner message={t("chat.history-error")} detail={loadError} />
        )}
        {messages.length === 0 && !streamText && !loadError && !running && (
          <EmptyState
            icon={MessageSquare}
            description={emptyText ?? t("chat.empty")}
          />
        )}
        {visibleMessages.map((m, i) => (
          <Bubble key={i} msg={m} compact={compact} />
        ))}
        {streamText && (
          <Bubble
            msg={{ role: "assistant", kind: "text", content: streamText }}
            compact={compact}
          />
        )}
        {running && !streamText && (
          <p className="text-sm text-[var(--text-muted)]">
            {t("chat.claude-working")}
          </p>
        )}
        {agentError && (
          <ErrorBanner message={t("chat.agent-error")} detail={agentError} />
        )}
        {showEndBlock && status && (
          <SessionEndBlock status={status} finalText={finalText} />
        )}
        {willAutoResume && (
          <p className="text-sm text-[var(--text-muted)]">
            {t("chat.will-resume")}
          </p>
        )}
      </div>

      {running && (
        <div className="flex flex-col gap-2 border-t border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2">
          <div className="progress-indeterminate" aria-label={t("dash.ai-working")} />
          <div className="flex items-center justify-between text-meta text-[var(--text-muted)]">
            <span className="truncate">{currentAction}</span>
            <span className="shrink-0 pl-3">
              {steps > 0 && <>{tf("chat.step-n", { n: steps })} · </>}
              {formatElapsed(elapsed)}
            </span>
          </div>
        </div>
      )}

      {/* Phiên mới → chọn model/mode ngay tại chỗ (lưu vào session khi tạo) */}
      {providersEnabled && !sessionId && !running && (
        <div
          className={`border-t border-[var(--border)] bg-[var(--bg-subtle)] ${
            compact ? "px-2 py-1.5" : "px-3 py-2"
          }`}
        >
          <AiModelInlineRow
            model={model}
            effort={effort}
            onModelChange={setModel}
            onEffortChange={setEffort}
          />
        </div>
      )}

      <div
        className={`flex items-end gap-2 border-t border-[var(--border)] ${
          compact ? "p-2" : "p-3"
        }`}
      >
        <textarea
          // `.input` chuẩn kể cả ở chế độ compact - đây là chỗ người dùng GÕ,
          // thu nhỏ chữ ở đây là thứ sai nhất trong cả bố cục hẹp.
          className="input flex-1"
          rows={1}
          placeholder={
            compact ? t("chat.placeholder-compact") : t("chat.placeholder")
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        {running ? (
          <Button variant="destructive" small={compact} onClick={onInterrupt}>
            <Square size={14} strokeWidth={2} />
            {t("chat.stop")}
          </Button>
        ) : (
          <Button small={compact} onClick={onSend} disabled={!input.trim()}>
            <Send size={14} strokeWidth={2} />
            {t("chat.send")}
          </Button>
        )}
      </div>
    </div>
  );
}
