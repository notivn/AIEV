import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Router } from "express";
import { hasClaudeAuth, repoRoot } from "../config.js";
import { geminiApiKey } from "../gemini.js";
import { HttpError } from "../util.js";

/**
 * GET /api/providers - trạng thái kết nối + model khả dụng của từng AI provider.
 * Xem docs/API.md mục "AI Providers & chọn model".
 */

/**
 * Danh sách tĩnh ĐẦY ĐỦ model Claude đang khả dụng (sắp mới → cũ) - lớp cuối
 * cùng khi không hỏi được ai khác: không có ANTHROPIC_API_KEY (Models API) VÀ
 * Agent SDK cũng không trả lời được. Các model 3.7/3.5 đã retired (404) nên
 * không liệt kê. Ra model mới thì thêm lên ĐẦU danh sách.
 */
export const CLAUDE_MODELS = [
  { id: "claude-fable-5-1", label: "Fable 5.1 (mạnh nhất)" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 (cân bằng)" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5 (nhanh)" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  { id: "claude-opus-4-5", label: "Opus 4.5" },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
  { id: "claude-opus-4-1", label: "Opus 4.1" },
  { id: "claude-opus-4-0", label: "Opus 4" },
  { id: "claude-sonnet-4-0", label: "Sonnet 4" },
  { id: "claude-3-haiku-20240307", label: "Haiku 3" },
];

export const CLAUDE_MODEL_IDS: string[] = CLAUDE_MODELS.map((m) => m.id);

/** Mức effort của Agent SDK - expose thành "mode" trên UI: Nhanh/Chuẩn/Sâu */
export const EFFORT_LEVELS = ["low", "medium", "high"];

// Danh sách model tạo ảnh - nguồn sự thật là IMAGE_MODELS trong gemini.ts
import { IMAGE_MODELS } from "../gemini.js";
export const GEMINI_MODELS: Array<{ id: string; label: string }> = IMAGE_MODELS.map((m) => ({
  id: m.id,
  label: m.label,
}));

// Cache danh sách model ảnh live từ Google - 1 giờ
let liveImageModelsCache: { at: number; list: Array<{ id: string; label: string }> } | null = null;

/**
 * Lấy danh sách model ảnh MỚI NHẤT trực tiếp từ Google (lọc model có "image" trong tên,
 * hỗ trợ generateContent). Không có key / lỗi → fallback danh sách tĩnh IMAGE_MODELS.
 */
async function fetchLiveImageModels(): Promise<{
  source: "google" | "static";
  models: Array<{ id: string; label: string }>;
}> {
  const key = geminiApiKey();
  if (!key) return { source: "static", models: GEMINI_MODELS };
  if (liveImageModelsCache && Date.now() - liveImageModelsCache.at < 60 * 60 * 1000) {
    return { source: "google", models: liveImageModelsCache.list };
  }
  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1/models?pageSize=1000",
      { headers: { "x-goog-api-key": key } },
    );
    if (!r.ok) return { source: "static", models: GEMINI_MODELS };
    const data = (await r.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const staticLabels = new Map<string, string>(IMAGE_MODELS.map((m) => [m.id, m.label]));
    const list = (data.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((id, i, arr) => id.includes("image") && arr.indexOf(id) === i)
      .filter((id) => {
        const raw = data.models?.find((m) => (m.name ?? "").endsWith(id));
        const methods = raw?.supportedGenerationMethods ?? [];
        return methods.length === 0 || methods.includes("generateContent");
      })
      .sort()
      // Model đã biết → nhãn tĩnh (đã kèm sẵn id gốc); model mới → id thô
      .map((id) => ({
        id,
        label: staticLabels.get(id) ?? id,
      }));
    if (list.length > 0) {
      liveImageModelsCache = { at: Date.now(), list };
      return { source: "google", models: list };
    }
    return { source: "static", models: GEMINI_MODELS };
  } catch {
    return { source: "static", models: GEMINI_MODELS };
  }
}

// Cache danh sách model Claude live từ Anthropic Models API - 10 phút
let liveClaudeModelsCache: { at: number; list: Array<{ id: string; label: string }> } | null =
  null;
const CLAUDE_MODELS_CACHE_MS = 10 * 60 * 1000;

/** Bỏ đuôi ngày ("claude-haiku-4-5-20251001" → "claude-haiku-4-5") để so với danh sách tĩnh */
function baseModelId(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

// Cache model do Agent SDK báo về - 6 giờ: chỉ đổi khi nâng SDK/đổi gói, mà mỗi
// lần hỏi phải khởi động cả tiến trình Claude Code (~15s)
let sdkClaudeModelsCache: { at: number; list: Array<{ id: string; label: string }> } | null =
  null;
let sdkClaudeModelsInflight: Promise<Array<{ id: string; label: string }> | null> | null = null;
const SDK_MODELS_CACHE_MS = 6 * 60 * 60 * 1000;
const SDK_MODELS_TIMEOUT_MS = 45_000;

/**
 * Hỏi Claude Code (qua Agent SDK) những model mà TÀI KHOẢN ĐANG ĐĂNG NHẬP dùng
 * được - đường duy nhất cho người dùng gói Claude (OAuth), vì Models API đòi
 * ANTHROPIC_API_KEY. Trước đây nhánh này rơi thẳng về danh sách tĩnh, nên mỗi
 * lần Anthropic ra model mới là ô "AI thực hiện" đứng yên ở thế hệ cũ cho tới
 * khi có người sửa tay code.
 *
 * SDK trả về alias (default/opus/sonnet/haiku/fable) kèm `resolvedModel` là id
 * thật; lấy id thật, gộp lên ĐẦU danh sách tĩnh (model mới nhất đứng trước),
 * bỏ trùng. Hỏng gì (chưa đăng nhập, timeout, SDK đổi API) → null, dùng tĩnh.
 */
async function fetchSdkClaudeModels(): Promise<Array<{ id: string; label: string }> | null> {
  if (sdkClaudeModelsCache && Date.now() - sdkClaudeModelsCache.at < SDK_MODELS_CACHE_MS) {
    return sdkClaudeModelsCache.list;
  }
  if (sdkClaudeModelsInflight) return sdkClaudeModelsInflight;
  sdkClaudeModelsInflight = (async () => {
    const abortController = new AbortController();
    // Prompt không gửi gì: chỉ cần tiến trình khởi động để hỏi danh sách. Kết thúc
    // khi abort để generator không treo lại trong bộ nhớ sau mỗi lần hỏi.
    async function* idle(): AsyncGenerator<never> {
      await new Promise<void>((resolve) =>
        abortController.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    let q: ReturnType<typeof query> | null = null;
    let timer: NodeJS.Timeout | null = null;
    try {
      q = query({
        prompt: idle(),
        options: { cwd: repoRoot, abortController } as Parameters<typeof query>[0]["options"],
      });
      const found = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), SDK_MODELS_TIMEOUT_MS);
        }),
      ]);
      const fresh: Array<{ id: string; label: string }> = [];
      for (const m of found) {
        const id = m.resolvedModel ? baseModelId(m.resolvedModel) : "";
        if (!/^claude-[a-z0-9][a-z0-9.-]*$/i.test(id) || fresh.some((f) => f.id === id)) continue;
        const known = CLAUDE_MODELS.find((s) => s.id === id);
        // Nhãn tĩnh nếu đã biết; model mới thì lấy tên trong mô tả ("Opus 5.5 · ...")
        fresh.push({ id, label: known?.label ?? (m.description.split("·")[0].trim() || id) });
      }
      if (fresh.length === 0) return null;
      const list = [...fresh, ...CLAUDE_MODELS.filter((s) => !fresh.some((f) => f.id === s.id))];
      sdkClaudeModelsCache = { at: Date.now(), list };
      return list;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      // Đóng hẳn tiến trình Claude Code vừa mở - không để nó chạy ngầm
      try {
        q?.close();
      } catch {
        /* đã đóng */
      }
      abortController.abort();
      sdkClaudeModelsInflight = null;
    }
  })();
  return sdkClaudeModelsInflight;
}

/**
 * Lấy danh sách model Claude MỚI NHẤT từ Anthropic Models API
 * (GET https://api.anthropic.com/v1/models, header x-api-key + anthropic-version: 2023-06-01,
 * phân trang after_id/has_more, mỗi model có id + display_name).
 * Chỉ gọi được với ANTHROPIC_API_KEY. Không có key (gói Claude/OAuth) → hỏi
 * Agent SDK; vẫn không được → danh sách tĩnh CLAUDE_MODELS.
 */
async function fetchLiveClaudeModels(): Promise<{
  source: "anthropic" | "claude-code" | "static";
  models: Array<{ id: string; label: string }>;
}> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const viaSdk = await fetchSdkClaudeModels();
    return viaSdk ? { source: "claude-code", models: viaSdk } : { source: "static", models: CLAUDE_MODELS };
  }
  if (liveClaudeModelsCache && Date.now() - liveClaudeModelsCache.at < CLAUDE_MODELS_CACHE_MS) {
    return { source: "anthropic", models: liveClaudeModelsCache.list };
  }
  try {
    const list: Array<{ id: string; label: string }> = [];
    let afterId: string | null = null;
    // API trả mới → cũ; lặp phân trang, chặn tối đa 10 trang để an toàn
    for (let page = 0; page < 10; page++) {
      const url = new URL("https://api.anthropic.com/v1/models");
      url.searchParams.set("limit", "100");
      if (afterId) url.searchParams.set("after_id", afterId);
      const r = await fetch(url, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!r.ok) return { source: "static", models: CLAUDE_MODELS };
      const data = (await r.json()) as {
        data?: Array<{ id?: string; display_name?: string }>;
        has_more?: boolean;
        last_id?: string | null;
      };
      for (const m of data.data ?? []) {
        if (m.id) list.push({ id: m.id, label: m.display_name || m.id });
      }
      if (!data.has_more || !data.last_id) break;
      afterId = data.last_id;
    }
    if (list.length > 0) {
      liveClaudeModelsCache = { at: Date.now(), list };
      return { source: "anthropic", models: list };
    }
    return { source: "static", models: CLAUDE_MODELS };
  } catch {
    return { source: "static", models: CLAUDE_MODELS };
  }
}

/**
 * Model Claude hợp lệ: trong danh sách tĩnh, trong cache live, hoặc id dạng
 * claude-* (model đã lưu từ danh sách live trước khi server restart).
 */
function isValidClaudeModel(id: string): boolean {
  if (CLAUDE_MODEL_IDS.includes(id)) return true;
  if (liveClaudeModelsCache?.list.some((m) => m.id === id)) return true;
  if (sdkClaudeModelsCache?.list.some((m) => m.id === id)) return true;
  return /^claude-[a-z0-9][a-z0-9.-]*$/i.test(id);
}

/**
 * Parse + validate `model`/`effort` từ body của POST /api/chat và POST /api/projects/:id/edit.
 * undefined = không gửi (giữ nguyên lựa chọn cũ của session / mặc định SDK).
 */
export function parseModelEffort(body: Record<string, unknown>): {
  model?: string;
  effort?: string;
} {
  const out: { model?: string; effort?: string } = {};
  if ("model" in body && body.model !== undefined && body.model !== null && body.model !== "") {
    if (typeof body.model !== "string" || !isValidClaudeModel(body.model)) {
      throw new HttpError(
        400,
        "INVALID_MODEL",
        `model phải là một trong: ${CLAUDE_MODEL_IDS.join(", ")}`,
      );
    }
    out.model = body.model;
  }
  if ("effort" in body && body.effort !== undefined && body.effort !== null && body.effort !== "") {
    if (typeof body.effort !== "string" || !EFFORT_LEVELS.includes(body.effort)) {
      throw new HttpError(
        400,
        "INVALID_EFFORT",
        `effort phải là một trong: ${EFFORT_LEVELS.join(", ")}`,
      );
    }
    out.effort = body.effort;
  }
  return out;
}

interface Provider {
  id: "claude" | "gemini";
  label: string;
  connected: boolean;
  source: "oauth" | "api-key" | null;
  note?: string;
  roles: Array<"edit" | "chat" | "image">;
  models: Array<{ id: string; label: string }>;
}

function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || "";
}

/** "oauth" nếu có ~/.claude/.credentials.json (subscription Claude Code), "api-key" nếu chỉ có key env */
function claudeSource(): "oauth" | "api-key" | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), ".claude");
  if (fs.existsSync(path.join(configDir, ".credentials.json"))) return "oauth";
  if (hasClaudeAuth()) return "api-key";
  return null;
}

/** Có cài Antigravity/gemini-cli trên máy không - auth IDE không dùng được cho API tạo ảnh */
function hasAntigravityInstall(): boolean {
  const home = homeDir();
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    home && path.join(home, ".gemini"),
    home && path.join(home, ".antigravity"),
    localAppData && path.join(localAppData, "Programs", "Antigravity"),
  ].filter((p): p is string => Boolean(p));
  return candidates.some((p) => fs.existsSync(p));
}

const router = Router();

// GET /api/providers → { providers: Provider[] }
router.get("/", (_req, res) => {
  const claude: Provider = {
    id: "claude",
    label: "Claude (Anthropic)",
    connected: hasClaudeAuth(),
    source: claudeSource(),
    roles: ["edit", "chat"],
    // Danh sách SDK đã hỏi được thì dùng luôn (mới hơn danh sách tĩnh)
    models: sdkClaudeModelsCache?.list ?? CLAUDE_MODELS,
  };

  const gKey = geminiApiKey();
  const gemini: Provider = {
    id: "gemini",
    label: "Gemini (Google)",
    connected: Boolean(gKey),
    source: gKey ? "api-key" : null,
    roles: ["image"],
    models: GEMINI_MODELS,
  };
  if (!gKey && hasAntigravityInstall()) {
    gemini.note =
      "Đã phát hiện Antigravity/gemini-cli - auth IDE không dùng được cho API tạo ảnh, cần GEMINI_API_KEY trong .env";
  }

  res.json({ providers: [claude, gemini] });
});

// GET /api/providers/gemini/image-models - danh sách model ảnh MỚI NHẤT (live từ Google, cache 1h)
router.get("/gemini/image-models", async (_req, res) => {
  res.json(await fetchLiveImageModels());
});

// GET /api/providers/claude/models - danh sách model Claude MỚI NHẤT
// (API key: live từ Anthropic, cache 10'; gói Claude: hỏi Agent SDK, cache 6h)
router.get("/claude/models", async (_req, res) => {
  res.json(await fetchLiveClaudeModels());
});

export default router;
