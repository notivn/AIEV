"use client";

/**
 * Chat AI của trình chỉnh sửa - nằm trong panel phải của shell (ShellRightPanel),
 * dùng lại nguyên <ChatThread>, chỉ đổi đường gửi sang POST /editor/chat (phiên
 * chat thường goal null, lượt đầu kèm ngữ cảnh "đang ở trình chỉnh sửa").
 *
 * Mở lại editor thì tiếp tục phiên editor gần nhất của project (server đặt tiêu
 * đề "Trình chỉnh sửa: …" cho mọi phiên tạo từ đây); nút "Cuộc trò chuyện mới"
 * để bắt đầu lại từ đầu.
 */

import { MessageSquarePlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner";
import { ChatThread } from "@/components/ChatThread";
import { IconButton } from "@/components/IconButton";
import { LinkButton } from "@/components/LinkButton";
import { ShellRightPanel } from "@/components/Shell";
import {
  getChatSessions,
  getHealth,
  sendEditorChat,
  type AgentEffort,
  type ChatSession,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useEvents } from "@/lib/useEvents";

/** Tiền tố tiêu đề server đặt cho phiên tạo từ /editor/chat (routes/timeline.ts). */
const EDITOR_TITLE_PREFIX = "Trình chỉnh sửa:";

export function EditorChat({
  projectId,
  onSessionStarted,
  beforeSend,
}: {
  projectId: string;
  /**
   * Lưu nốt thay đổi chưa lưu TRƯỚC khi AI đọc meta.json - không thì AI sửa trên
   * bản cũ, còn bản của người dùng bị chặn AGENT_BUSY rồi thành xung đột.
   * Trả false = chưa lưu được, không gửi.
   */
  beforeSend: () => Promise<boolean>;
  /** Báo trang biết phiên này thuộc project - để khóa chỉ đọc ngay khi AI chạy */
  onSessionStarted: (sessionId: string) => void;
}) {
  const { t } = useT();
  const { resyncTick } = useEvents();
  const [session, setSession] = useState<ChatSession | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  const loadSessions = useCallback(
    async (pick: boolean) => {
      try {
        const list = await getChatSessions(projectId);
        if (pick) {
          const latest = list
            .filter((s) => s.title.startsWith(EDITOR_TITLE_PREFIX))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          setSessionId(latest?.sessionId ?? null);
          setSession(latest ?? null);
        } else {
          const cur = sessionIdRef.current;
          setSession(list.find((s) => s.sessionId === cur) ?? null);
        }
      } catch {
        // không tải được danh sách phiên - vẫn chat được, bắt đầu phiên mới
      } finally {
        setReady(true);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void loadSessions(true);
  }, [loadSessions]);

  // Mất SSE rồi nối lại: lấy lại trạng thái phiên (ChatThread tự đồng bộ theo prop)
  useEffect(() => {
    if (resyncTick > 0) void loadSessions(false);
  }, [resyncTick, loadSessions]);

  // Chưa kết nối Claude (không OAuth, không API key): gửi chỉ để nhận lỗi ở
  // lượt chạy - chặn nút Gửi và chỉ thẳng tới trang Kết nối
  const [claudeAuth, setClaudeAuth] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    getHealth()
      .then((h) => {
        if (alive) setClaudeAuth(h.checks?.claudeAuth !== false);
      })
      .catch(() => {
        if (alive) setClaudeAuth(null); // không biết - đừng chặn
      });
    return () => {
      alive = false;
    };
  }, [resyncTick]);

  const send = useCallback(
    async (message: string, current: string | undefined, opts?: { model?: string; effort?: AgentEffort }) => {
      if (!(await beforeSend())) throw new Error(t("editor.chat.save-first"));
      return sendEditorChat(projectId, message, current, opts);
    },
    [projectId, beforeSend, t],
  );

  return (
    <ShellRightPanel title={t("editor.chat.title")}>
      <div className="flex shrink-0 items-start justify-between gap-2">
        <p className="min-w-0 text-meta text-[var(--text-muted)]">{t("editor.chat.hint")}</p>
        <IconButton
          label={t("editor.chat.new")}
          disabled={sessionId === null}
          onClick={() => {
            setSessionId(null);
            setSession(null);
          }}
        >
          <MessageSquarePlus size={16} strokeWidth={1.75} />
        </IconButton>
      </div>
      {claudeAuth === false && (
        <Banner
          tone="info"
          message={t("editor.chat.no-auth")}
          actions={
            <LinkButton href="/connections" small>
              {t("editor.chat.no-auth-link")}
            </LinkButton>
          }
        />
      )}
      {ready && (
        <ChatThread
          sendDisabled={claudeAuth === false}
          compact
          providersEnabled
          sessionId={sessionId}
          projectId={projectId}
          initialStatus={session?.status}
          session={session}
          send={send}
          emptyText={t("editor.chat.empty")}
          onSessionCreated={(id) => {
            sessionIdRef.current = id;
            setSessionId(id);
            onSessionStarted(id);
            void loadSessions(false);
          }}
        />
      )}
    </ShellRightPanel>
  );
}
