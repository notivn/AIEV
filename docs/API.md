# API Contract — Web UI ↔ Backend

> **Nguồn sự thật duy nhất** cho giao tiếp giữa `apps/web` (Next.js, port 6868) và `apps/server` (Express, port 6869). Web rewrites `/api/*` và `/media/*` sang `http://localhost:6869`. Mọi thay đổi contract phải sửa file này trước.

## Quy ước chung

- JSON, UTF-8. Lỗi trả `{ "error": { "code": string, "message": string } }` + HTTP status đúng nghĩa.
- Thời gian: ISO 8601 string. ID job: `job_<nanoid>`. ID chat session: `sess_<nanoid>`.
- Project ID = tên folder trong `video-projects/` (kebab-case). `meta.json` trên đĩa là nguồn sự thật về project; DB (SQLite) chỉ lưu jobs + chat.

## Health & Dashboard

```
GET /api/health
→ { ok: true, checks: { ffmpeg: bool, node: string, claudeAuth: bool, hyperframes: bool },
    apiToken?: string }

GET /api/overview
→ { runningJob: Job|null, runningJobs: Job[], queuedCount: number, recentJobs: Job[≤5],
    recentProjects: ProjectSummary[≤6], health: <như /api/health> }
```

`/api/health` là endpoint public duy nhất; `apiToken` CHỈ trả khi request đến trực tiếp từ máy chủ
(loopback, không qua proxy) - web dashboard chạy trên chính máy đó dùng nó cho mọi request sau.
`runningJob` = job đang chạy ĐẦU TIÊN (field cũ, giữ cho tương thích); `runningJobs` = TẤT CẢ job
đang chạy (queue song song). `recentProjects` mỗi phần tử kèm `tokensUsed, costUsd`.

## Kiểm tra môi trường (card "Kiểm tra hệ thống" trang /config)

```
GET /api/doctor[?refresh=1]
→ { platform: string, ok: bool, missingRequired: string[],
    checks: [ { id, label, level: "required"|"optional"|"info",
                status: "ok"|"missing", detail: string, note: string|null,
                fix: { auto: bool, size?, command?, manual?, link?, url? } | null } ] }

POST /api/doctor/fix   { id }
→ { ok: bool, installed: bool, timedOut: bool, log: string[≤40], report: <như GET> }
   (kể cả nhánh trả sớm khi lệnh cài chạy quá lâu vẫn kèm đủ installed/timedOut)
```

Danh sách kiểm tra nằm ở **`start/doctor.mjs`** — dùng chung với `start.ps1` / `start.sh`, nên
terminal lúc khởi động và card trên web luôn khớp nhau. Backend **spawn** file đó (`--json` /
`--fix-one <id>`) chứ không import: mọi phép dò bên trong là `spawnSync` (phải chạy được trước
cả `npm install`), chạy trong tiến trình server sẽ chặn event loop ~6s.

- `detail` là dữ liệu máy dò được (version, đường dẫn) — KHÔNG dịch. `note` là mã để web tự dịch
  (`doctor.note.<note>`), `label` dịch qua `doctor.label.<id>` nếu có.
- Kết quả cache 20s; server tự dò sẵn một lần lúc khởi động để lần mở trang đầu không phải chờ.
- `POST /fix` chỉ chấp nhận mục có `fix.auto = true` (400 `MANUAL_ONLY` nếu không), mỗi lần một
  mục (409 `FIX_BUSY`). `installed` là kết quả DÒ LẠI sau khi cài — lệnh chạy xong chưa chắc đã
  thấy (winget ghi PATH ở nơi khác), nên đừng tin mỗi `ok` của lệnh.

## `.runtime/` — dữ liệu tạm lúc chạy (nằm TRONG repo, không rải ra ổ hệ thống)

```
<repoRoot>/.runtime/
  tmp/         thư mục tạm của mọi tiến trình con (TEMP/TMP/TMPDIR)
  models/      HF_HOME + HUGGINGFACE_HUB_CACHE — model whisper/VieNeu
  venv/        virtualenv Python (faster-whisper, vieneu) — do start/doctor.mjs dựng
  bin/         binary tải riêng (ffmpeg, cloudflared)
  pip-cache/   PIP_CACHE_DIR
```

**Vì sao gom về đây** (số đo thật trên máy Windows có repo ở ổ F:, ổ C: còn 17,7GB trống): mỗi
lần Remotion lắp ráp ghi ~1,7GB bundle webpack + ~190MB thư mục asset vào thư mục tạm của
Windows trên C:; model whisper trong `C:\Users\<user>\.cache\huggingface` đã lên 13,3GB; cache
pip trong AppData 3,2GB. Tất cả giờ nằm cùng ổ với repo.

- Đường dẫn khai báo MỘT chỗ: `paths.runtime.*` trong `apps/server/src/config.ts`; `start/doctor.mjs`
  dùng đúng bộ đường dẫn đó. Server tạo sẵn `tmp/`, `models/`, `bin/`, `pip-cache/` lúc khởi động
  (`ensureBaseDirs`); riêng `venv/` để `python -m venv` tự dựng.
- Mọi tiến trình con nhận môi trường từ `childEnv()` (cùng file) — nó copy `process.env` rồi đè
  `TEMP`/`TMP`/`TMPDIR`, `HF_HOME`, `HUGGINGFACE_HUB_CACHE`, `PIP_CACHE_DIR`. **Không bao giờ sửa
  `process.env` của server**, chỉ dựng bản copy cho con.
- Dò Python (`transcribe.ts`, `ttsLocal.ts`) theo thứ tự: `PYTHON_BIN` (cửa thoát, luôn thắng) →
  `.runtime/venv` → `PYTHON` → `python`/`py`/`python3`.
- **Xóa được bất cứ lúc nào** (khi không có job nào chạy) — hệ thống tự tạo lại, chỉ mất thời gian
  tải model / cài lại venv.
- **LOẠI TRỪ khỏi backup.** Cả điểm của việc gom một chỗ là chỉ cần một dòng loại trừ `.runtime/`
  là đủ. Trong `.gitignore` đã có `/.runtime/`.

## Kết nối điện thoại (upload từ điện thoại cùng WiFi)

```
GET /api/lan-info
→ { ips: string[], webPort: number, tunnelDomain: string|null }   // IPv4 non-internal của máy chạy server, ưu tiên 192.168/10.; webPort = 6868
```

`tunnelDomain`: hostname Quick Tunnel đang chạy (ưu tiên) hoặc `TUNNEL_DOMAIN` trong .env — QR "Kết nối điện thoại" tự dùng.

Trang web `/m/<projectId>` (Next.js, không phải API) là trang upload tối giản cho điện thoại — mở qua QR
trong modal "Kết nối điện thoại" ở card Nguồn & Asset (`http://<ip>:6868/m/<projectId>`).
Upload từ điện thoại gọi THẲNG backend `http://<ip>:6869/api/assets` (không qua proxy Next — request dài qua proxy dễ kẹt). Server tắt `requestTimeout` cho upload dài và tự hủy request nếu 45s không nhận thêm dữ liệu (stall → SSE `upload` báo `error`).
CORS của backend chấp nhận origin web UI trên LAN: `http://<ip-private>:6868` (localhost/127.0.0.1/192.168.x.x/10.x.x.x/172.16–31.x.x); start.ps1 mở firewall rule "AIEV API 6869".

### Upload session (bảo mật link QR)

```
POST   /api/upload-session          { projectId } → 201 { token: "ut_…", expiresAt }   // mở modal QR — token TTL 60 phút, lưu RAM
DELETE /api/upload-session/:token   → 204                                              // đóng modal QR — thu hồi ngay, idempotent
```

URL/QR mang token qua query `?k=`; trang `/m` gửi lại qua field `token` (append TRƯỚC `file`). POST `/api/assets` từ máy KHÁC máy chủ (điện thoại LAN/tunnel - không phải loopback, hoặc có `x-forwarded-for`) bắt buộc token phiên upload hợp lệ, đúng project khi scope là `project` - sai/thiếu → `403 UPLOAD_TOKEN_INVALID` ("Link upload đã hết hạn — mở lại mã QR trên máy tính.").

Ngoại lệ: request mang `AIEV_API_TOKEN` (header `x-aiev-token`, cookie `aiev_token` hoặc query `?t=`) được miễn token phiên QR. Đó là dashboard của chính chủ máy mở qua tunnel; token này vốn đã mở được cả chạy agent lẫn xóa project nên đòi thêm mã QR không thêm an toàn, chỉ chặn nhầm.

**Đóng modal QR = đóng hết.** Thu hồi token, và nếu đường Internet được bật TỪ CHÍNH modal đó thì
tắt luôn tunnel (xem [Cloudflare Tunnel](#cloudflare-tunnel-card-trên-trang-connections)). Tab bị
đóng đột ngột thì client dùng `fetch(..., { keepalive: true })` trong `pagehide` để gửi nốt hai lời
gọi này; hỏng nốt đường đó thì token hết hạn theo TTL 60 phút và tunnel bị vòng canh của server tắt.

## Projects

```
ProjectSummary = { id, name, width, height, fps, status: "draft"|"rendering"|"done",
                   output: string|null, tags: string[], textToVideoId: string|null,
                   createdAt: string|null, updatedAt }
                   (textToVideoId = id phiên Text to video đã sinh ra project - null nếu tạo thường)

GET    /api/projects            → ProjectSummary[]   (quét video-projects/*/meta.json;
                                  mỗi phần tử kèm tokensUsed, costUsd)
POST   /api/projects            { id?, name, width, height, fps, tags? } → ProjectSummary (201)
                                  — scaffold folder + meta.json + compositions/ + assets/ + renders/;
                                  không gửi id → tự sinh từ name (kebab-case, trùng thì thêm -2, -3…)
GET    /api/projects/:id        → meta.json đầy đủ + { files: { renders: FileInfo[], assets: FileInfo[] } }
DELETE /api/projects/:id?force=true → 204 (không có force → 400)
POST   /api/projects/:id/clone  { name? } → ProjectSummary (201) — nhân bản project:
                                  copy compositions/assets/brief/tags/scenes (bỏ renders/cache),
                                  reset status draft + output null, id mới sinh từ name

PUT    /api/projects/:id/name   { name } → ProjectSummary - đổi TÊN HIỂN THỊ (400 INVALID_NAME khi
                                  rỗng hoặc quá 120 ký tự). CHỈ đổi `meta.name`, KHÔNG đổi `id`:
                                  id là tên thư mục và bị tham chiếu ở đường dẫn asset, tên file
                                  trong outputs/, thư mục staging Remotion, cột projectId của job và
                                  phiên chat, project con của Auto cut - đổi id là một cuộc di trú
                                  chứ không phải sửa một trường
PUT    /api/projects/:id/tags   { tags: string[] } → 200 { tags } - thay toàn bộ tags của project

GET    /api/projects/:id/junk        → { items: [{ relPath, size }], totalBytes } — file rác (file trung gian):
                                       renders/ verify/ cache/, props.resolved.json, outputs/<id>-draft.mp4,
                                       staging Remotion vid-<id>/ img-<id>/ (thư mục có "/" cuối, size là tổng)
POST   /api/projects/:id/junk/clean  → { freedBytes, deleted } — xóa các mục trên (file nguồn + final giữ nguyên);
                                       project đang có job running/queued → 409 JOB_RUNNING

FileInfo = { name, relPath, size, mtime, kind: "video"|"audio"|"image"|"other" }
```

## Project Brief — kịch bản edit (AI đọc phần này khi edit)

`meta.json` của project có thêm field `brief`:

```
Brief = {
  sourceDescription: string,               // mô tả nội dung video gốc (bối cảnh cho AI)
  autoCut: boolean,                        // có tự động cắt ngắn đoạn thừa không (công tắc bật/tắt)
  autoCutLevel: "natural"|"default"|"tight", // mạnh tay tới đâu khi cắt (mặc định "default") -
                                           //   ánh xạ 1-1 sang TrimAggressiveness của autoTrim.ts;
                                           //   chỉ có nghĩa khi autoCut = true. Xem mục Auto-trim
  subtitles: boolean,                      // có tạo phụ đề (karaoke) không
  highlightEnabled: boolean,               // BẬT = AI tự phân tích source, chọn keyword và highlight
  highlightKeywords: string[],             // (nâng cao, tùy chọn) chỉ định thêm keyword thủ công
  keyLayoutEnabled: boolean,               // BẬT (mặc định) = bố cục Key: KEY CHÍNH ở vùng TRÊN video,
                                           //   các KEY LIÊN QUAN ở vùng DƯỚI (trên caption) — spec ở skill `key-layout`
  mainKey: string,                         // key chính do user chỉ định — "" = AI tự phân tích chọn
  relatedKeys: string[],                   // key liên quan user chỉ định (bắt buộc dùng đủ) — [] = AI tự chọn 3–6 key
  skill: string|null,                      // tên skill dùng để edit (null = AI tự chọn)
  sfxMode: "recommended"|"library"|"none", // sfx: chỉ dùng bộ đề xuất / tự tìm cả thư viện / không dùng
  musicMode: "auto"|"none",                // nhạc nền: AI tự chọn bài theo mood trong assets/music/ (mặc định) / không dùng
  autoIllustrations: boolean,              // BẬT = AI tự tạo ảnh minh họa (Gemini) khi edit.
                                           //   TẮT (mặc định) = cấm hẳn: prompt edit nói rõ "CẤM sinh ảnh"
                                           //   và POST /api/illustrations trả 409 ILLUSTRATIONS_DISABLED
  illustrationModel: string|null,          // model Gemini tạo ảnh (null = mặc định)
  illustrationText: boolean,               // BẬT = Gemini được vẽ chữ tiếng Việt vào ảnh minh họa (mặc định TẮT — chữ do Remotion/HyperFrames đặt)
  illustrationPosition: "auto"|"top-left"|"top-center"|"top-right"|"middle-left"|"middle-center"|"middle-right"|"bottom-left"|"bottom-right"|"bottom-center",
                                           // vị trí CHỦ THỂ trong ảnh minh họa (lưới 3x3, cùng bộ giá trị với overlay.position của image project);
                                           //   "auto" = giữa khung, chừa band key trên + caption dưới (an toàn nhất cho video)
  illustrationsPerMinute: number|null,     // mật độ ảnh minh họa: số ảnh Gemini mỗi phút video (số nguyên 1-20);
                                           //   null = AI tự quyết theo nội dung. Đặt số để video dài đổi nền liên tục
  styleId: string|null,                    // Style Design áp cho project (null = style default)
  videoStyleEnabled: boolean,              // công tắc phong cách dựng. TẮT (mặc định) = dựng theo đúng cấu hình
                                           //   đã chọn (skill + Style Design), videoStyleId bị bỏ qua hoàn toàn.
                                           //   Brief cũ THIẾU field này: có videoStyleId hợp lệ → coi như BẬT
  videoStyleId: string|null,               // Phong cách dựng (GET /api/video-styles) - chỉ có hiệu lực khi
                                           //   videoStyleEnabled = true; id không còn trong danh sách → server lùi về null.
                                           //   PATCH gửi videoStyleId mà KHÔNG gửi videoStyleEnabled → server tự bật (hợp đồng cũ)
  notes: string                            // Yêu cầu edit (prompt) — nội dung chính gửi AI, đổ được từ prompt mẫu
}

GET /api/projects/:id        → response thêm brief (trả default nếu meta chưa có) 
                               và files.assets có thêm description?: string
PUT /api/projects/:id/brief  Brief (partial được — merge) → 200 Brief
```

## Mô tả asset của project

File `video-projects/<id>/assets/assets.json` = `{ "<fileName>": { "description": string, colorGrade?, colorAdjust? } }`
(`colorGrade` = preset màu đã áp, `colorAdjust` = chỉnh tay — xem mục Color Grading).

```
PUT /api/projects/:id/assets/:file/description  { description } → 200 FileInfo
DELETE /api/projects/:id/assets/:file           → 204 — xóa file asset (kể cả trong thư mục con)
                                                  + entry trong assets.json (cấm xóa assets.json → 400)
GET /api/assets?scope=project&projectId=<id>    → FileInfo[] (thêm description?: string)
```

## Color Grading (chỉnh màu footage — chi tiết ở skill `color-grading`)

```
GET  /api/grade-presets                                → danh sách preset màu (id, label, mô tả)
POST /api/projects/:id/assets/:file/grade-preview      { preset?, adjust?, t? } → ảnh frame đã áp màu (preview trên UI)
POST /api/projects/:id/assets/:file/grade-frame        { t? } → ảnh frame gốc tại giây t (để so sánh)
PUT  /api/projects/:id/assets/:file/grade              { preset?, adjust? } → 200 — lưu colorGrade/colorAdjust vào assets.json
```

## Bắt đầu edit bằng AI từ project

```
POST /api/projects/:id/edit  { extraNotes?: string, model?: string, effort?: string } → 202 { sessionId }
                             → 409 SESSION_BUSY khi project đã có phiên AI đang chạy
```

`model`/`effort` (400 nếu giá trị không hợp lệ) lưu vào chat session - mọi lượt chạy sau của phiên dùng lựa chọn đó.

Server tự soạn prompt đầy đủ từ: meta.json (scenes + brief), assets.json (mô tả từng video/ảnh),
danh sách sound effect (chỉ bộ đề xuất nếu `sfxMode: "recommended"`, cả thư viện nếu `"library"`,
bỏ qua nếu `"none"`), và chỉ định skill trong brief — rồi chạy agent (cùng pipeline với /api/chat,
event đẩy qua SSE kênh `agent`). Web UI mở trang Chat với sessionId này.

## AI Providers & chọn model

```
GET /api/providers → { providers: Provider[] }
Provider = { id: "claude"|"gemini", label, connected: boolean,
             source: "oauth"|"api-key"|null, note?: string,
             roles: ("edit"|"chat"|"image")[], models: [{ id, label }] }
```
- claude: connected khi có OAuth Claude Code (~/.claude/.credentials.json) hoặc ANTHROPIC_API_KEY.
  models = các model Claude khả dụng cho agent edit/chat. Chọn model gửi qua:
  `POST /api/chat { ..., model? }` và `POST /api/projects/:id/edit { ..., model? }` —
  lưu vào chat_sessions.model, mọi lượt chạy sau của session dùng model đó.
- gemini: connected khi có GEMINI_API_KEY/GOOGLE_API_KEY trong .env (GOOGLE_API_KEY thắng nếu có cả hai; vì vậy PUT key gemini xóa luôn GOOGLE_API_KEY để key vừa dán có hiệu lực).
  Antigravity/gemini-cli chỉ được ghi nhận ở note (auth nội bộ IDE, không gọi API ảnh được). roles = ["image"].
- `GET /api/providers/gemini/image-models` → [{ id, label }] — danh sách model tạo ảnh Gemini khả dụng.
- `GET /api/providers/claude/models` → { source: "anthropic"|"static", models: [{ id, label }] } — danh sách model Claude live từ Anthropic Models API (cần ANTHROPIC_API_KEY, cache 10'); OAuth-only/lỗi → danh sách tĩnh đầy đủ.

## Kết nối (Connections — trang /connections)

```
GET  /api/connections                    → trạng thái kết nối từng provider (connected, source, note)
PUT  /api/connections/:provider/key      { apiKey } → 200 — lưu API key vào .env
POST /api/connections/:provider/test     → { ok, message? } — gọi thử API để kiểm tra key
```
provider ∈ `claude` | `gemini` | `openai` | `soniox`.

- **soniox** (`SONIOX_API_KEY`, lấy tại console.soniox.com) - bóc lời async $0.10/giờ, 60+ ngôn ngữ,
  **phân vai người nói** (thứ faster-whisper trên máy không làm được). `roles: ["stt"]`.
  `/test` gọi `GET https://api.soniox.com/v1/models` (rẻ nhất, không tính tiền, vẫn qua tầng Bearer).
  Không có key thì hệ thống vẫn bóc lời được bằng faster-whisper trên máy - chỉ là không có nhãn người nói.

## Cloudflare Tunnel (card trên trang /connections)

```
GET  /api/tunnel          → { installed, running, auto, mode: "named"|"quick"|null, url, domain, lastLog: string[] }
PUT  /api/tunnel/domain   { domain } → 200 — validate hostname, ghi TUNNEL_DOMAIN vào .env (rỗng/null = xóa)
POST /api/tunnel/start    { auto? } → 202 { mode, auto } — có domain: named tunnel; không: Quick Tunnel (*.trycloudflare.com). 409 NOT_INSTALLED / đang chạy
POST /api/tunnel/stop     { onlyAuto? } → 204 — kill cả cây process cloudflared
```

Quick Tunnel đang chạy → `/api/lan-info.tunnelDomain` trả hostname URL đó (ưu tiên hơn env) để QR điện thoại tự dùng.

**Tunnel `auto` — bật từ modal QR "Kết nối điện thoại".** Link tunnel là public, để nó sống sau khi
người dùng đã xong việc là phơi dashboard ra Internet mà không ai để ý. Nên:

- `POST /start { auto: true }` đánh dấu tunnel này thuộc về phiên QR.
- Đóng modal → client gọi `POST /stop { onlyAuto: true }`. Cờ `onlyAuto` để KHÔNG tắt nhầm tunnel
  người dùng tự bật ở trang Kết nối (cái đó thường dùng để vào dashboard từ xa).
- Tab bị đóng đột ngột thì lời gọi trên không tới nơi. Server có vòng canh 30s: tunnel `auto` mà
  **không còn phiên upload nào sống** liên tục quá 2 phút thì tự tắt. Đo thật: tắt ở giây 121.
- Còn phiên upload sống thì không bao giờ tắt (đã đo: chạy tiếp qua mốc 150s).

## Ảnh minh họa AI (POST /api/illustrations)

```
POST /api/illustrations
  { projectId, prompt, name?, aspect?, model?, styleId?, description?, allowText?, position? }
  → 201 { file, relPath, promptUsed }
  → 409 ILLUSTRATIONS_DISABLED khi project TẮT "Ảnh minh họa AI" (brief.autoIllustrations = false)
```
Tạo ảnh minh họa bằng Gemini và lưu thẳng vào `video-projects/<projectId>/assets/`.
**Công tắc `brief.autoIllustrations` chặn ngay tại endpoint** (trước khi tạo thư mục hay gọi Gemini):
tắt thì không có đường nào sinh được ảnh cho video đó. Prompt edit cũng nói rõ "Ảnh minh họa AI: TẮT -
CẤM sinh ảnh", nhưng prompt chỉ là lời khuyên - skill dài hàng nghìn chữ vẫn lấn át được, nên chốt
chặn thật nằm ở server.
Thiếu `styleId` → server tự lấy `brief.styleId` của project (rồi mới tới style default) —
ảnh luôn đồng bộ Style Design. `promptUsed` = prompt cuối đã trộn style.
`allowText: true` = cho phép Gemini vẽ chữ vào ảnh (ghi nguyên văn cụm chữ trong prompt);
thiếu field → server lấy `brief.illustrationText` của project (mặc định false — cấm chữ).
`position` (lưới 3x3 hoặc "auto") = vị trí CHỦ THỂ trong ảnh; thiếu field → server lấy
`brief.illustrationPosition` (mặc định "auto" = chủ thể giữa khung, hai mép trên/dưới là
atmosphere thoáng cho thẻ key/phụ đề đè lên). Server tự chèn quy tắc bố cục vào prompt —
agent KHÔNG tự tả vị trí chủ thể trong prompt.

Chi tiết kỹ thuật (đã verify 2026-07-29):
- Claude models cho edit/chat (options.model của Agent SDK): "claude-sonnet-5-5" (mặc định),
  "claude-fable-5-1", "claude-opus-5-5", "claude-haiku-5-5" và các thế hệ trước.
  GET /api/providers/claude/models: có ANTHROPIC_API_KEY thì lấy live từ Models API
  (source "anthropic"); đăng nhập gói Claude thì hỏi Agent SDK `supportedModels()` theo
  tài khoản đang dùng (source "claude-code", cache 6h); không được nữa thì danh sách tĩnh
  (source "static"). Model mới chỉ hiện qua SDK khi đã nâng @anthropic-ai/claude-agent-sdk.
  SDK cũng nhận options.effort
  ("low"|"medium"|"high"|"xhigh") — expose thành "mode" trên UI: Nhanh(low)/Chuẩn(medium)/Sâu(high).
  chat_sessions thêm cột model TEXT, effort TEXT.
- Gemini tạo ảnh: POST https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent
  header x-goog-api-key; body { contents:[{parts:[{text: prompt}]}], generationConfig:
  { responseModalities:["TEXT","IMAGE"], imageConfig:{ aspectRatio:"9:16"|..., imageSize:"1K"|"2K" } } };
  ảnh trả về candidates[0].content.parts[].inlineData.data (base64). Không có free tier ảnh (~$0.05-0.07/ảnh 1K).

## Thumbnail video project (POST /api/projects/:id/thumbnail)

```
POST /api/projects/:id/thumbnail  { title, frameAt?, sourceRel?, bgPrompt?, styleId? } → 201 { file: "thumbnail.png", relPath }
```
Chạy ĐỒNG BỘ (~1 phút): ffmpeg cắt frame tại giây `frameAt` (mặc định 1) từ video (`sourceRel`,
mặc định output final trong meta, fallback video asset đầu) → Gemini vẽ nền theo Style Design
(lỗi/thiếu key → composition tự dựng nền gradient từ style) → `remotion still Thumbnail`
(nền + frame card + title + logo, 100% theo style) → `video-projects/<id>/thumbnail.png`.
Style resolve: `body.styleId` → `brief.styleId` → default. `GET /api/projects/:id` trả thêm
`thumbnail: "thumbnail.png"|null` (check file tồn tại).

## Auto cut videos (tab riêng) - auto-cut/<id>/

Cắt một video dài thành nhiều video ngắn; **mỗi đoạn tự động trở thành một Videos Project
dựng sẵn** (có asset, transcript đã rebase về gốc 0, brief) nên không phải import lại.

```
AutoCutMeta = { id, name, status: "draft"|"planning"|"planned"|"cutting"|"done"|"failed",
  source: { relPath, width, height, fps, durationSec, rotation },
  mode: "time"|"ai"|"prompt",
  params: { minutes?, overlapSec?, count?, minSec?, maxSec?, request? },
  output: { aspect: "keep"|"9:16"|"16:9"|"1:1"|"4:5", layout: "auto"|"crop"|"fit",
            background: "gemini"|"blur"|"style", styleId, fps },
  brief: Brief,          // cấu hình edit áp cho MỌI project con (đúng bộ field
                         // Kịch bản edit của Videos Project)
  transcribe, autoEdit, transcriptRel?,
  segments: [{ index, start, end, title, hook?, reason?, score?, selected,
               projectId?, appliedLayout? }],
  error?, createdAt, updatedAt }

GET    /api/auto-cut/sources   -> { files: FileInfo[] }   // video trong imports/
GET    /api/auto-cut           -> { sessions: AutoCutMeta[] }
GET    /api/auto-cut/:id       -> { session }
POST   /api/auto-cut           { name?, sourceRel, mode, params?, output?, brief?, transcribe?, autoEdit? } -> 201
PATCH  /api/auto-cut/:id       { name?, params?, output?, brief?, transcribe?, autoEdit?, segments? } -> 200
POST   /api/auto-cut/:id/plan  -> 202 { job }   // job auto-cut step "plan"
POST   /api/auto-cut/:id/cut   -> 202 { job }   // job auto-cut step "cut" - nhận từ status "planned",
                                                //   hoặc "failed" khi đã có segments (cắt lại sau lỗi)
DELETE /api/auto-cut/:id?force=true -> 204      // KHÔNG xóa các project con đã tạo
```

Upload nguồn dùng lại `POST /api/assets` với `scope=imports` (có sẵn thanh tiến độ + QR điện thoại).

**Cấu hình edit của phiên (`brief`)**: validate bằng đúng `applyBriefPatch` của
`PUT /api/projects/:id/brief` (hàm dùng chung trong `meta.ts`) nên hai nơi không lệch luật.
Sửa `brief` KHÔNG reset danh sách đoạn (chỉ ảnh hưởng khâu dựng project con). Khi cắt, job
áp `brief` cho mọi project con, chỉ ghi đè 4 field phụ thuộc từng đoạn: `styleId` (lấy từ
`output.styleId` - một nguồn sự thật), `sourceDescription`, `mainKey` (dùng tiêu đề đoạn khi
user để trống) và `notes` (hướng dẫn bắt buộc về file đã cắt sẵn đứng TRƯỚC, ghi chú của user nối sau).

**Job `auto-cut`**: `projectId` là id phiên cắt, `sceneId` mang step. Hai bước tách rời để người
dùng DUYỆT danh sách đoạn trước khi tốn thời gian encode.
- `plan`: transcribe (faster-whisper large-v3, `language="vi"`, word timestamp, cuda float16 fallback cpu int8) rồi chọn đoạn.
  **Thời gian đo thật** (GTX 1660, CUDA float16): video 55 giây mất 56 giây, trong đó ~20 giây là nạp
  model lần đầu. Tức khoảng **0.65x thời lượng video** sau khi model đã nạp - video 1 tiếng mất
  khoảng 40 phút. Job có progress theo từng segment nên UI phải nói rõ điều này, đừng để người dùng
  tưởng treo.
- `cut`: cắt + đổi khung + tạo project con + (tùy chọn) chạy edit AI tối đa 3 project.

### Đổi khung hình (reframe)

| layout | cách làm | được / mất |
|---|---|---|
| `crop` | dò tâm nhân vật rồi cắt cúp bám theo | chủ thể to, đầy khung / mất phần rìa |
| `fit` | thu nhỏ giữ trọn khung, lấp nền (Gemini / mờ / màu style) | không mất thông tin / chủ thể nhỏ |
| `auto` | hỏi Gemini khung là người hay màn hình rồi tự chọn | mặc định |

**Dò chủ thể** dùng Gemini vision (`gemini-2.5-flash`, ảnh + yêu cầu trả `{found, box:[ymin,xmin,ymax,xmax]}`
chuẩn hoá 0-1000), lấy trung vị 3 mốc trong đoạn. Đã đo thật: sai số khoảng 1% so với vị trí đúng.
Không có key hoặc lỗi -> rơi về tâm khung, không bao giờ làm hỏng job.

⚠️ **Cờ xoay video**: `ffprobe` trả width/height của luồng THÔ. File `20260731-164133.mp4` trong repo
báo 3840x2160 nhưng có `stream_side_data=rotation=-90`, khung giải mã thật là 2160x3840. Mọi phép
tính tỉ lệ PHẢI hoán đổi width/height khi |rotation| là 90/270, nếu không video quay bằng điện thoại
sẽ bị hiểu nhầm là video ngang.

## Text to video (biến bài viết/đoạn văn thành video) - text-to-video/<id>/

Ba hành động nặng tách riêng CÓ CHỦ Ý - mỗi bước cần người duyệt trước khi tốn tiền cho bước sau:
`/extract` (bóc bài, miễn phí) -> `/script` (AI viết kịch bản, tốn token) -> `/build` (TTS + dựng video, vào queue).

```
TextToVideoMeta = { id, name, autoNamed: boolean,
  source: { kind: "text"|"url", url, text }, article: ExtractedArticle|null,
  script: [{ text, durationSec: number|null }],
  voice: { engine: "gemini"|"vieneu", model: string|null, name, style, language, speed },
  scriptModel: string|null, output: { width, height, fps, styleId: string|null },
  brief: Brief,                       // CÙNG kiểu Brief của Videos Project (applyBriefPatch dùng chung)
  voiceFile: string|null, voiceDurationSec: number|null, transcriptFile: string|null,
  projectId: string|null,             // Videos Project đã sinh ra - null = chưa dựng
  status: "draft"|"extracting"|"scripting"|"ready"|"voicing"|"building"|"editing"|"done"|"failed",
  error: string|null, createdAt, updatedAt }

GET    /api/text-to-video          -> TextToVideoMeta[] (mới nhất trước)
POST   /api/text-to-video          { name?, source? } -> 201 - name bỏ trống được: server tự đặt tên
                                     tạm (autoNamed=true) rồi thay bằng tiêu đề bài khi bóc xong
GET    /api/text-to-video/:id      -> TextToVideoMeta (tự đối chiếu status "editing" với project con)
PATCH  /api/text-to-video/:id      { name?, source?, voice?, output?, scriptModel?, brief?, script? } -> 200
                                     - sửa script bằng tay reset voiceFile/voiceDurationSec
DELETE /api/text-to-video/:id      -> 204 (KHÔNG xóa Videos Project đã sinh ra)

POST   /api/text-to-video/:id/extract -> 200 - bóc bài từ source.url (400 NO_URL nếu không có link)
POST   /api/text-to-video/:id/script  { targetSeconds?, model? } -> 200 - AI viết kịch bản đọc;
                                     targetSeconds 15-600 (400 INVALID_TARGET_SECONDS nếu ngoài khoảng,
                                     mặc định 60); model lưu vào scriptModel cho lần sau
POST   /api/text-to-video/:id/build   -> 202 { jobId } - job type "text-to-video" (TTS + tạo project con
                                     + chạy edit AI); 409 ALREADY_BUILT / JOB_RUNNING
```

## Dịch video (bóc lời -> dịch -> ghép phụ đề HOẶC lồng tiếng) - translate-video/<id>/

Bốn hành động tách riêng CÓ CHỦ Ý - mỗi bước cần người duyệt trước khi tốn thời gian/tiền cho bước sau:
`/source` (upload + ffprobe) -> `/transcribe` (whisper, vào queue) -> `/translate` (AI dịch, ĐỒNG BỘ,
tốn token) -> `/render` (Remotion, vào queue). Thư mục phiên chứa `meta.json`, `source.<ext>`,
`transcript.json`, `props.resolved.json`, `output.mp4`, và `dub/` khi lồng tiếng.

Hai chế độ dùng CHUNG bước bóc lời và bước dịch, chỉ khác ở `/render`:
- `mode: "subtitle"` - giữ tiếng gốc, đốt chữ dịch lên hình.
- `mode: "dub"` - đọc bản dịch thành tiếng, TẮT tiếng gốc của clip, không đốt chữ.

```
TranslateVideoMeta = { id, name, autoNamed: boolean,
  source: { relPath: string|null, durationSec, width, height, fps },   // đo bằng ffprobe, đã áp cờ xoay
  sourceLang: string,                 // "auto" hoặc mã whisper ("vi","en"...)
  targetLang: string,                 // "vi" | "en" | ...
  mode: "subtitle"|"dub",             // quyết định /render làm gì (xem trên)
  sttProvider: "local"|"gemini"|"soniox",   // AI bóc lời cho lần chạy TIẾP THEO (mặc định "local")
  transcriptFile: string|null,        // transcript GỐC (relPath repo)
  transcriptInfo: {                   // provider ĐÃ chạy ra transcript đang nằm trên đĩa; null = chưa bóc
    provider, language, diarized: boolean, speakers: string[], wordTimestamps: boolean } | null,
  cues: [{ start, end, text, dubText?, original?, speaker? }],  // dubText = chữ ĐỌC LÊN
                                      // (dubLang), chỉ có khi khác ngôn ngữ phụ đề; thiếu thì đọc `text`  // GIÂY trong video nguồn; text đã xuống dòng "\n"
                                      // speaker: có khi provider phân vai được (gán theo segment
                                      // CHỒNG LẤN NHIỀU NHẤT, không theo mốc bắt đầu)
  subtitleStyle: { fontFamily, fontSizePx, color, backdrop: "blur"|"solid"|"none",
                   backdropColor, blurPx, bottomPx },
                                      // fontFamily: "vietnamese"|"sans"|"serif"|"mono" (GET /fonts)
                                      // px đo theo đơn vị của SubtitleTrack: video DỌC chuẩn hóa
                                      // theo cao 1920, video NGANG theo cao 1080 - nên bottomPx mặc
                                      // định là 320 (dọc) / 130 (ngang), tự chọn lúc upload nguồn
  dub: {                              // LỰA CHỌN lồng tiếng cho lần chạy tiếp theo (mode="dub")
    engine: "gemini"|"vieneu",        // mặc định "gemini"
    model: string|null,               // model TTS (chỉ Gemini); null = mặc định hệ thống
    language: string|null,            // vd "vi-VN"; null = tự suy từ targetLang
    voices: { [speaker: string]: string },  // khóa "" = một giọng cho CẢ video (transcript
                                      // không phân vai). Bỏ trống -> /render tự gán rồi ghi ngược
                                      // vào đây; người dùng PATCH đè thì lần sau giữ nguyên
    keepOriginal: boolean,            // giữ tiếng gốc chạy nhỏ dưới giọng lồng (mặc định false)
    originalVolume: number },         // 0..0.12 (trần chống rè, xem dub.ts)
  dubInfo: {                          // KẾT QUẢ lần lồng tiếng gần nhất; null = chưa chạy
    file, durationSec, cues,          // track đã ghép (relPath repo), dài đúng bằng video nguồn
    stretched, overflowed, clipped,   // số câu phải co / tràn sang câu sau / kẹp ở trần co
    minTempo, maxTempo,               // dải hệ số co đã dùng thật (1.0 = không co)
    assignments: [{ speaker, voice, engine }],
    speakerF0: { [speaker]: number }, // cao độ ĐO ĐƯỢC của giọng gốc (Hz) - căn cứ gán giọng
    signature, createdAt } | null,    // signature khớp -> /render dùng lại track cũ, KHÔNG đọc lại
  outputFile: string|null,
  status: "draft"|"transcribing"|"transcribed"|"translating"|"translated"|"rendering"|"done"|"failed",
  error: string|null, createdAt, updatedAt }

GET    /api/translate-video/fonts  -> [{ id, label, cssStack }] - DANH SÁCH CHO PHÉP của
                                      subtitleStyle.fontFamily (đặt trước /:id)
GET    /api/translate-video/stt-providers -> SttCapabilities[] (đặt trước /:id)
                                      [{ id: "local"|"gemini"|"soniox", label, diarization: boolean,
                                         available: boolean, why?: string }]
                                      available=false -> `why` là câu tiếng Việt hiện thẳng lên UI
GET    /api/translate-video        -> TranslateVideoMeta[] (mới cập nhật trước)
POST   /api/translate-video        { name?, sourceLang?, targetLang?, mode?, sttProvider? } -> 201
                                      name bỏ trống được: đặt tên tạm (autoNamed=true) rồi thay
                                      bằng tên file khi upload nguồn
                                      Field KHÔNG gửi thì lấy LỰA CHỌN GẦN NHẤT của người dùng
                                      (data/prefs.json - xem apps/server/src/prefs.ts), không phải
                                      hằng số mặc định. KHÔNG nhớ `dub.voices`: người nói "1" của
                                      video này không liên quan gì tới video sau.
GET    /api/translate-video/:id    -> TranslateVideoMeta
PATCH  /api/translate-video/:id    { name?, sourceLang?, targetLang?, dubLang?, mode?, sttProvider?,
                                      subtitleStyle?, cues?, dub? }
                                      - đổi sourceLang -> xóa transcript + cues, về "draft"
                                      - đổi targetLang -> trả text về `original`, bỏ `dubText`,
                                        về "transcribed"
                                      - đổi dubLang -> CHỈ bỏ `dubText` (chữ phụ đề còn nguyên);
                                        về "transcribed" khi ngôn ngữ đọc khác ngôn ngữ phụ đề
                                      - đổi sttProvider -> KHÔNG xóa gì (transcript cũ chỉ CŨ chứ
                                        không SAI; bấm /transcribe lại nếu muốn bản của provider mới)
                                      - sttProvider lạ -> 400 INVALID_STT_PROVIDER
                                      - sửa `dub` KHÔNG xóa track lồng tiếng đã dựng: `signature` tự
                                        biết cái gì làm bản đọc hết giá trị (giọng/engine/model/ngôn
                                        ngữ) và cái gì không (keepOriginal, originalVolume)
                                      - sửa cues/đổi ngôn ngữ/đổi provider/sửa dub khi đang chạy job -> 409 BUSY
DELETE /api/translate-video/:id    -> 204 (xóa cả thư mục phiên + staging)

POST   /api/translate-video/:id/source     multipart: file -> TranslateVideoMeta
                                      chỉ nhận mp4/mov/webm/mkv/avi/m4v; đo ffprobe ngay
                                      (400 INVALID_SOURCE / PROBE_FAILED); nguồn mới xóa
                                      transcript + cues + output cũ
POST   /api/translate-video/:id/transcribe { sttProvider? } -> 202 { jobId }
                                      job "translate-video" step "transcribe"; sttProvider truyền ở
                                      đây thì ghi đè lựa chọn của phiên rồi mới chạy
                                      (400 INVALID_STT_PROVIDER; 503 STT_PROVIDER_UNAVAILABLE khi
                                      thiếu key - kiểm TRƯỚC khi vào hàng đợi, không để job chết giữa chừng)
POST   /api/translate-video/:id/translate  { model? } -> TranslateVideoMeta (ĐỒNG BỘ)
                                      đầu vào lấy từ transcript GỐC, không dịch chồng lên bản dịch cũ
                                      (400 NO_TRANSCRIPT, 502 TRANSLATE_EMPTY)
POST   /api/translate-video/:id/dub-preview { index?, voice? } -> audio/wav (ĐỒNG BỘ)
                                      Nghe thử ĐÚNG MỘT câu trước khi trả tiền đọc cả video.
                                      index = vị trí cue (mặc định 0); voice = ép giọng cần thử,
                                      bỏ trống thì lấy giọng đã chốt / gán tự động cho người nói đó.
                                      Câu nghe thử đi qua ĐÚNG phép co giãn của bước dựng thật, nên
                                      nghe ra ngay là bản dịch có dài quá không.
                                      Header: x-dub-voice (encodeURIComponent), x-dub-natural (giây TTS đọc ra),
                                      x-dub-final (sau khi co), x-dub-source (độ dài câu gốc),
                                      x-dub-tempo, x-dub-clipped, x-dub-overflowed
                                      (400 NO_CUES / INVALID_CUE_INDEX / INVALID_VOICE;
                                       503 NO_GEMINI_KEY / LOCAL_TTS_UNAVAILABLE)
POST   /api/translate-video/:id/render     -> 202 { jobId } - job step "render"
                                      Một cửa cho cả hai chế độ; `meta.mode` quyết định job làm gì.
                                      (400 NO_CUES / INVALID_SOURCE; mode="dub" còn kiểm engine đọc
                                       TRƯỚC khi vào hàng đợi -> 503 NO_GEMINI_KEY /
                                       LOCAL_TTS_UNAVAILABLE)
```

### Lồng tiếng: isochrony (`apps/server/src/dub.ts`)

Câu dịch không bao giờ dài đúng bằng câu gốc. Ba đòn bẩy của nghề lồng tiếng, hệ này dùng hai:

1. **Dịch có khống chế độ dài** - `translate.ts` mode `"dub"` gửi kèm thời lượng từng câu, model
   được dặn chọn cách diễn đạt ngắn hơn, nhắm +-10%.
2. **Co giãn thời gian một lượng nhỏ** - `atempo` (giữ nguyên cao độ), **kẹp trong [1.00, 1.25]**.
   Không bao giờ đọc chậm lại: chỗ dư là khoảng lặng, mà im lặng đúng chỗ nghe tự nhiên hơn hẳn
   giọng bị kéo giãn. Trần 1.25 vì từ ~1.3x trở lên tai nghe rõ là "bị tua".
3. Khớp khẩu hình (lip-sync) - **CỐ Ý KHÔNG LÀM**.

Câu dịch được phép "mượn" tối đa **1 giây** đầu khoảng nghỉ phía sau mà không phải co - co giãn tồn
tại để bảo vệ CÂU KẾ TIẾP, không phải để bảo vệ sự im lặng.

Lắp ráp: mỗi câu đặt ở **mốc tuyệt đối** của nó trên một track lặng dài đúng bằng video nguồn
(`adelay` + `amix normalize=0`), y hệt cách `sfx[].atFrame` làm bên Remotion. TUYỆT ĐỐI không nối
đuôi các câu - nối đuôi thì sai số cộng dồn. Đo thật: 200 câu đặt ở mốc tuyệt đối lệch **0,0 ms**.

Gán giọng: một giọng cho mỗi người nói, cố định cả video, không bao giờ trùng nhau. Cao độ (F0) của
từng người nói được **đo trên chính audio gốc** rồi đối chiếu `VOICE_CATALOG` để chọn giọng cùng
giới tính, gần cao độ nhất. Transcript không phân vai -> một giọng cho cả video.

### Bóc lời: chọn provider (`apps/server/src/stt.ts`)

Bóc lời đi qua đúng một cổng `transcribeWith({ provider, videoAbs, outJsonAbs, language, diarize })`.
Cả ba provider đều tách audio bằng CÙNG một hàm (`extractAudioWav` - WAV 16 kHz mono, 32 kB/giây)
nên chúng nghe cùng một thứ.

| provider | tiền | mạng | phân vai người nói | mốc từng TỪ |
|---|---|---|---|---|
| `local` (faster-whisper large-v3) | miễn phí | không cần | **không** | có |
| `gemini` (gemini-2.5-flash, key sẵn có) | theo token | cần | best effort (LLM đoán) | **không** |
| `soniox` (`stt-async-v5`) | $0.10/giờ | cần | có (mô hình thật) | có |

- **`sourceLang: "auto"`** giờ tự dò thật ở cả ba provider (whisper `language=None`, Gemini tự nghe,
  Soniox `enable_language_identification`). Ngôn ngữ nhận ra được ghi lại vào `sourceLang` và
  `transcriptInfo.language` sau khi bóc xong.
- **`gemini` KHÔNG có mốc thời gian từng từ**: mốc mức TỪ do một LLM đoán ra lệch tới hàng trăm ms
  mà caption karaoke lệch 100 ms là thấy ngay - nên transcript ghi `"words": []` và job log nói rõ,
  thay vì bịa số. `segmentsToCues` tự lùi về chia câu theo dấu câu, phụ đề vẫn đúng nhưng thô hơn.
- **Gemini chia audio thành khúc 4 phút** (`GEMINI_CHUNK_SEC = 240`), cắt ở mốc cố định không chồng
  lấn, cộng offset của khúc vào timestamp. Ràng buộc quyết định con số này là **trần token ĐẦU RA**
  (JSON bị cắt giữa chừng là mất trắng cả khúc), sau đó mới tới trần request ~20 MB
  (240 s ≈ 10,2 MB base64 ≈ nửa trần) và độ trôi mốc thời gian.
- **Soniox**: `POST /v1/files` → `POST /v1/transcriptions` → poll `GET /v1/transcriptions/{id}` tới
  `status="completed"` → `GET /v1/transcriptions/{id}/transcript`. Mốc của họ là **milli giây**
  (`start_ms`/`end_ms`), token là **dưới-từ** ("Hel"+"lo") nhưng có khoảng trắng đầu từ nên
  `joinWords` ghép đúng. Trần **300 phút/file** (cố định) - chặn trước khi upload. File **không tự
  xóa**: xong là `DELETE` cả file lẫn transcription.

⚠ **Hình dạng transcript.json KHÔNG ĐỔI**: `{ language, duration, segments: [{ start, end, text,
words: [{word,start,end}] }] }`. `speaker` chỉ là field **phụ thêm** trên segment/word.
`parseTranscriptJson` dựng object mới và bỏ field lạ, nên mọi consumer (`subtitles.ts`, `autoTrim.ts`,
QC, đường caption Remotion) chạy nguyên không sửa một dòng. Muốn đọc `speaker` thì đọc thẳng JSON thô
(xem `readSpeakerRanges` ở `jobs/translateVideo.ts`) - đừng nới hợp đồng của parser chung.

⚠ **font phụ đề là ID trong danh sách cho phép**, không phải tên family tự do: family lạ thì DOM render
im lặng rơi về font mặc định và thứ hỏng đầu tiên là DẤU TIẾNG VIỆT - mà chỉ lộ ra sau khi render xong.
Bảng id ở server (`translateVideoMeta.ts`) phải TRÙNG bảng của `SubtitleTrack.tsx`, nếu không lựa chọn
của người dùng bị bên render nuốt mất mà không ai báo.

Bước render sinh `props.resolved.json` cho composition `Assemble`: đúng một scene `srcVideo` (nguồn đã
stage vào `public/staging/tvd-<id>/`, `muted: false` để giữ tiếng gốc), `audio`/`captions`/`overlays`
rỗng, `watermark: null`, cộng hai field mới `subtitles` + `subtitleStyle`. Mốc trong `subtitles` là
FRAME TUYỆT ĐỐI (`round(sec * fps)`) - cùng hệ quy chiếu với `audio.sfx[].atFrame`.

## TTS (giọng đọc - màn chọn giọng của Text to video)

```
GET  /api/tts/models    -> TtsModel[] (live từ Google, cache 1h)
GET  /api/tts/engines   -> [{ engine: "gemini"|"vieneu", available: bool, canClone: bool,
                              reason: string|null, detail: string }]
                           - engine nào dùng được TRÊN MÁY NÀY; chỉ vieneu nhân bản được giọng
GET  /api/tts/voices[?engine=] -> TtsVoice[] - không truyền engine = giọng của CẢ HAI engine;
                           engine chưa dùng được thì phần của nó rỗng, KHÔNG ném lỗi
GET  /api/tts/languages -> [{ code, label }] - danh sách mã ngôn ngữ (tĩnh)
POST /api/tts/preview   { voice, engine?, model?, style?, language?, speed?, uiLang?, text? }
                        -> bytes audio/wav (headers x-tts-model, x-tts-duration; cache-control no-store)
```

`/preview` với engine gemini TỐN TIỀN nên bị chặn: text/style tối đa 300 ký tự, cách nhau >= 2s,
tối đa 30 lần/10 phút (429 PREVIEW_TOO_FAST / PREVIEW_QUOTA). Engine vieneu không rate limit
(chạy trên máy, hàng đợi tuần tự trong ttsLocal.ts). Preview áp ĐÚNG speed đang chọn.

## Voices (kho giọng nhân bản - VieNeu, trang /voices)

```
GET    /api/voices             -> ClonedVoice[]
POST   /api/voices             multipart: file (audio/video có tiếng nói) + name/gender/note
                               -> 201 ClonedVoice (503 nếu VieNeu chưa cài đủ để nhân bản - kèm reason/detail)
PATCH  /api/voices/:id         { name?, gender?, note? } -> ClonedVoice
DELETE /api/voices/:id         -> { id } - xóa cả bản ghi lẫn file mẫu
POST   /api/voices/:id/preview { uiLang? } -> bytes audio/wav - câu đọc thử CỐ ĐỊNH (không nhận text
                               tự do), không rate limit (chỉ tốn CPU máy chủ)
```

## Video styles (phong cách dựng - trang /video-styles)

```
GET    /api/video-styles          -> [{ id, name, palette: "brand"|"loose", motion }]  (ô chọn của brief)
GET    /api/video-styles?full=1   -> ManagedVideoStyle[]                               (trang quản lý)
GET    /api/video-styles/:id      -> ManagedVideoStyle & { usage: VideoStyleUsage[] }
POST   /api/video-styles          { name, art, avoid, palette, motion, id?, cloneFrom? } -> 201 ManagedVideoStyle
PUT    /api/video-styles/:id      partial { name?, art?, avoid?, palette?, motion? } -> ManagedVideoStyle
DELETE /api/video-styles/:id[?force=1] -> 204 | 409 VIDEO_STYLE_IN_USE
POST   /api/video-styles/:id/reset     -> ManagedVideoStyle (chỉ phong cách mặc định)

ManagedVideoStyle = { id, name, art, avoid, palette, motion, builtin, usageCount, createdAt, updatedAt }
VideoStyleUsage   = { kind: "video-project"|"text-to-video"|"auto-cut"|"translate-video", id, name }
```

`usage`/`usageCount` chỉ đếm project có `brief.videoStyleEnabled` BẬT - project đã tắt công tắc thì
`videoStyleId` còn nằm trong meta nhưng không có hiệu lực, đếm vào là chặn xóa oan.

Nguồn sự thật: `assets/video-styles/video-styles.json` = `{ styles: [], removedBuiltins: [] }`.
20 phong cách mặc định nằm trong `BUILTIN_VIDEO_STYLES` (apps/server/src/videoStyles.ts) và được
GIEO vào file JSON ở lần đọc đầu tiên - repo mới clone vẫn có đủ. Bản cập nhật repo sau này thêm
phong cách mặc định mới thì lần đọc kế tiếp tự chèn, trừ id đã nằm trong `removedBuiltins`.

- `GET /` (không có `full`) giữ ĐÚNG shape cũ cho ô chọn của brief (`Brief.videoStyleId`) và KHÔNG
  trả `art`/`avoid` - đó là prompt chỉ đạo mỹ thuật gửi Gemini, người đi CHỌN không cần đọc. Các
  endpoint quản lý thì trả đủ, vì người đi SỬA bắt buộc phải sửa được hai field đó.
- `palette`: `"brand"` = ảnh Gemini bám bảng màu Style Design; `"loose"` = phong cách có bảng màu
  ruột của nó (mực tàu, Đông Hồ, ảnh thật), màu thương hiệu tụt xuống làm điểm nhấn - chữ/đồ họa
  do HyperFrames/Remotion vẽ thì vẫn theo Style Design.
- `id` KHÔNG sửa được (400 VIDEO_STYLE_ID_IMMUTABLE): brief của project cũ trỏ vào đúng id đó.
- Bốn field `name`/`art`/`avoid`/`motion` bắt buộc không rỗng (400 INVALID_VIDEO_STYLE) - rỗng là
  prompt gửi Gemini/agent bị cụt.
- XÓA khi còn project dùng: mặc định TỪ CHỐI `409 VIDEO_STYLE_IN_USE` kèm tên các project (quét
  `video-projects/`, `text-to-video/`, `auto-cut/`, `translate-video/`). Gọi lại với `?force=1` thì
  xóa thật - các project đó lặng lẽ về "AI tự quyết" (briefOf hạ id lạ về null), video đã render
  không đổi.
- Phong cách MẶC ĐỊNH vẫn sửa/xóa được thoải mái vì luôn có đường về: `POST /:id/reset` dựng lại
  đúng bản ship kèm repo (kể cả khi đã xóa hẳn). Phong cách tự tạo thì reset trả 400
  NOT_BUILTIN_VIDEO_STYLE.

## Brand logos (thư viện logo brand - AI gọi khi kịch bản nhắc tới brand)

```
GET  /api/brand-logos          -> BrandLogo[] (đọc assets/brand-logos/library.json)
POST /api/brand-logos { name } -> 200 (đã có) | 201 (vừa tải)
                                  { slug, title, color, file, relPath, source, added }
```

Chưa có trong thư viện thì server TỰ TẢI: tìm ở Simple Icons rồi Wikidata (P154 "logo image"),
khử trùng SVG, lưu vào `assets/brand-logos/` và cập nhật library.json. Không tìm thấy ->
`404 BRAND_LOGO_NOT_FOUND` (chỉ khi đó AI mới được viết tên brand bằng chữ). `relPath` tương đối
repo - CHÉP file vào `assets/` của project rồi mới tham chiếu (Remotion chỉ stage file trong project).

## Metrics (mức dùng CPU/GPU - thanh header web UI)

```
GET /api/metrics -> { cpu: { percent, threads, model },
                      gpu: { available: bool, name, percent, vramUsedMb, vramTotalMb } }
```

Poll chứ không SSE (đo tốn - spawn nvidia-smi - chỉ chạy khi có người nhìn); cache 1,5s để nhiều
tab không nhân số lần đo. Máy không có nvidia-smi -> `gpu.available: false` (nhớ 5 phút mới dò lại).

## Transcript của project (nguồn dùng chung)

`apps/server/src/transcript.ts` dò transcript theo thứ tự ưu tiên "bản đã chốt trước, bản thô sau":
`assets/transcript.final.json` -> `assets/transcript.cut.json` -> `assets/transcript.json` ->
các bản trong `assets/audio/` -> quét thêm mọi `assets/**/[*]transcript*.json`. Nhận cả 3 dạng:
`{ segments: [...] }` (faster-whisper), mảng segment trần, hoặc `{ words: [...] }` (tự gom câu theo
khoảng lặng > 0.6s). Chuẩn hóa về `{ relPath, segments: [{ start, end, text, words }], durationSec }`.
Phụ đề, gợi ý cắt short và gói xuất bản đều đọc qua module này - project cũ không phải sửa gì.

## Gói xuất bản: phụ đề + metadata đăng bài

```
GET  /api/projects/:id/subtitles?format=srt|vtt  -> text/plain (attachment <id>.srt|.vtt)
POST /api/projects/:id/subtitles                 -> 201 { srt, vtt, cues }
                                 ghi video-projects/<id>/publish/<id>.srt + .vtt
GET  /api/projects/:id/publish                   -> { pack: PublishPack|null }
POST /api/projects/:id/publish  { platforms?: ("tiktok"|"youtube"|"facebook")[] } -> 201 { pack }

PublishPack = { generatedAt, transcriptRel,
                items: [{ platform, title, description, hashtags: string[] }],
                subtitles: { srt, vtt }, thumbnail: string|null, output: string|null }
```
Chia cue phụ đề: mỗi segment 1 cue; segment > 7s hoặc > 84 ký tự thì chia theo word timestamp
(tối đa 42 ký tự/dòng, 2 dòng/cue, cue tối thiểu 0.8s, không chồng cue kế tiếp).
Metadata do Claude soạn một lượt (không tool) theo transcript + tone của Style Design, ràng buộc
độ dài title theo từng nền tảng. Chưa có transcript -> 404 `NO_TRANSCRIPT`.

## Auto-trim: cắt khoảng lặng + mỡ thừa của MỘT video project

Khác hẳn mục "Auto cut videos" ở trên (mục đó cắt một video dài thành nhiều video ngắn).
Đây là bước tiền xử lý của chính một project: bỏ khoảng lặng và mỡ thừa TRƯỚC khi dựng scene.
Quy trình đầy đủ ở skill `auto-cut`.

```
POST /api/projects/:id/auto-trim/analyze  { source?, level? } -> 200 TrimAnalyzeResult
POST /api/projects/:id/auto-trim/apply    { source?, level?, cutCandidates? } -> 202 { job, level, profile, source, approvedCandidates }

level  = "natural"|"default"|"tight"  - thiếu thì lấy brief.autoCutLevel
source = đường dẫn video nguồn, tính từ thư mục project ("assets/face.mp4") hoặc từ repo root;
         nằm ngoài project -> 400 PATH_OUTSIDE_PROJECT, không có file -> 404 TRIM_SOURCE_NOT_FOUND.
         Thiếu thì server tự chọn: assets/face.* -> file video LỚN NHẤT trong assets/ (bỏ qua *.cut.*)
apply  -> 409 AUTO_CUT_DISABLED khi project TẮT "Tự động cắt ngắn video" (brief.autoCut = false);
         analyze vẫn chạy vì chỉ đọc

TrimAnalyzeResult = {
  source: relPath, transcript: relPath|null, guarded: boolean, note: string,
  silence: { durationSec, noiseFloorDb, thresholdDb, profile, silences[], keepRanges[],
             removedSec, thresholdNote, sweep[], wordGuard? },
  deadWeight: { candidates: [{ kind: "filler"|"stutter"|"repeat-take"|"hesitation",
                               start, end, text, confidence, reason, context }],
                totalSec, byKind }
}
```

**`analyze` KHÔNG encode gì** (chỉ bóc một WAV tạm 16kHz rồi tự dọn) nên gọi lại bao nhiêu lần cũng
được, kể cả giữa phiên edit - file 217s phân tích hết khoảng 1 giây.

**Hàng rào transcript là lý do tính năng này tồn tại.** Server đọc `assets/transcript.raw.json` rồi
`assets/transcript.json` (CỐ Ý không dùng `transcript.final/cut.json` - những bản đó đã dời mốc sang
hệ thời gian của file ĐÃ CẮT), dàn phẳng thành mốc chữ và chỉ cho cắt vào khoảng TRỐNG GIỮA CHỮ. Đo
thật trên `demo1/assets/thanhtoan80.mov`: ffmpeg gọi 70,3s là "lặng", transcript chỉ cho phép cắt
23,3s - 47s còn lại là tiếng nói nhỏ nằm bên trong chữ. Không có transcript thì vẫn chạy nhưng trả
`guarded: false`, `deadWeight` rỗng, và con số không đáng tin theo cả hai chiều.

**Ngưỡng dB do server dò theo từng file**, không phải hằng số: cùng một video, -40dB ra 0 khoảng lặng
còn -25dB ra 21. `thresholdNote` luôn nói rõ vì sao ngưỡng đó thắng.

**`apply` đi qua render queue** (luật CLAUDE.md: mọi render đều hiện trong queue) - job type
`auto-trim`, `sceneId` mang mức mạnh tay. `cutCandidates` là các khoảng `{start, end}` mà người/AI
**đã duyệt** từ `deadWeight` (server không tự duyệt hộ: từ đệm tiếng Việt trùng mặt chữ với từ có
nghĩa, chỉ ngữ nghĩa mới phân biệt được). Job chạy:
đo lại (có hàng rào) → gộp khoảng lặng + khoảng đã duyệt (khử chồng lấn) → bỏ khoảng nào đè lên
TRUNG ĐIỂM của một chữ (lưới an toàn cuối, có ghi log từng khoảng bị loại) → cắt MỘT lượt ffmpeg ra
`assets/<stem>.cut.mp4` → dời mốc transcript ra `assets/transcript.cut.json` → nghiệm thu bản ĐÃ CẮT
bằng chính mốc đã dời → ghi `assets/auto-trim-report.json`.

```
AutoTrimReport = {
  createdAt, jobId, level, profile, source, output: relPath|null,
  transcript: { source, cut, guarded },
  duration: { beforeSec, afterSec, removedSec },
  removed: { silenceSec, approvedSec, ranges },        // approvedSec = phần CỘNG THÊM nhờ ứng viên
                                                       //   đã duyệt (đã trừ chỗ chồng khoảng lặng)
  threshold: { db, noiseFloorDb, note },
  candidates: { approved, rejected: [{start, end}] },  // rejected = bị lưới trung điểm chặn
  verification: TrimVerification & { measuredOn, guarded },
  verdict: "pass"|"fail", note
}
```

Không có gì đáng cắt thì job CỐ Ý không sinh file mới (`output: null`) - encode lại một bản y hệt chỉ
làm giảm chất. Nghiệm thu TRƯỢT thì job vẫn `done` và vẫn ghi báo cáo, nhưng log nói thẳng là chưa
đạt profile; `verdict` trong báo cáo là nguồn sự thật, không được lờ đi.

409 `BUSY` khi project đang có job chạy/chờ (cắt là ghi đè asset, không được chạy chồng).

## QC tự động (đo bằng ffmpeg, chặn final nếu FAIL)

```
POST /api/projects/:id/qc  { file?: relPath, platform?: "tiktok"|"youtube"|"reels" } -> { report }
GET  /api/projects/:id/qc  -> { report: QcReport|null, stale?: true }

QcReport = { checkedAt, file, fileMtime, platform, status: "pass"|"warn"|"fail",
             checks: [{ id, label, status, detail, value, frames?: string[] }] }
```
File mặc định: `outputs/<id>-draft.mp4` -> file .mp4 mới nhất trong `renders/` -> `meta.output`.
Kết quả ghi `video-projects/<id>/qc.json`. `stale: true` khi file đã đổi sau lần QC gần nhất.

Các phép đo: `resolution` (so meta), `loudness` (loudnorm, mục tiêu -14 LUFS), `truepeak` (clipping),
`blackframes` (bỏ qua fade đầu/cuối, `pix_th=0.03` để nền tối `#0A0E1A` không bị báo nhầm là đen),
`freeze`, `tail-silence`, `dead-air`, `av-duration`, `duration`, và `safe-area`.

**`dead-air`** đo chỗ chết trên CẢ BÀI (khác `tail-silence` chỉ soi 4s cuối), dùng chính bộ đo của
auto-trim và có đối chiếu transcript của project (`readProjectTranscript`, tức bản `final/cut` nếu có).
Ngưỡng lấy từ profile của `brief.autoCutLevel`, không phát minh ngưỡng thứ hai. Thiếu transcript,
thiếu audio hay ffmpeg lỗi đều xuống `warn` ("không đo được"), không bao giờ ném lỗi: đo bằng mức âm
thanh một mình là đoán mò (đã đo được ca báo trượt oan 4,56s trong khi có transcript đo ra 0,00s).

> **Check này KHÔNG chặn final render** (tối đa là `warn`, kể cả khi `brief.autoCut` bật). QC đo trên
> video ĐÃ LẮP RÁP còn transcript theo dòng thời gian của footage ĐÃ CẮT; bản lắp ráp chèn thêm scene
> intro/cutaway là hai mốc lệch nhau và hàng rào chữ soi nhầm chỗ, khi đó một phép đo sai sẽ khoá cửa
> final của người dùng. Chỉ nâng lên `fail` sau khi chứng minh được transcript luôn cùng hệ thời gian
> với file đang đo, hoặc sau khi check tự dò được độ lệch trước khi chấm.

**`safe-area` không tự kết luận.** Đã đo và xác nhận: mật độ biên (edgedetect + signalstats) của chữ
và của cảnh quay là như nhau (dải trên 2.99 tại giây 3 hóa ra là lá cây, không phải chữ), nên mọi
ngưỡng pass/fail đều báo sai. Thay vào đó check này luôn `pass` và trả `frames` - ảnh TOÀN KHUNG có
khoanh đỏ dải trên 10% + dải dưới 16%, ghi vào `video-projects/<id>/renders/qc-safe-area-<n>.png`.
Người dùng xem trên UI, agent bắt buộc `Read` từng ảnh để tự phán. Việc phân biệt chữ với cảnh quay
là việc của thị giác, không phải của ffmpeg.

**Cổng chặn**: `POST /api/jobs` với `type: "assemble-final"` bị 409 `QC_REQUIRED` (chưa QC hoặc QC
đã cũ) hoặc 409 `QC_FAILED` (có check fail). Bỏ qua bằng `force: true` trong body, hoặc tắt
`qcGate` trong render settings (tab Tăng tốc). Các job khác không bị ảnh hưởng.

## Cắt short từ video dài + Tái chế tỉ lệ khung

```
POST /api/projects/:id/clips/suggest { count?=5, minSec?=20, maxSec?=60 } -> 201 { clips, suggestedAt }
GET  /api/projects/:id/clips        -> { clips, suggestedAt }
POST /api/projects/:id/clips/create { indexes: number[], width?=1080, height?=1920, autoEdit? }
                                    -> 201 { created: [{ id, name, sessionId }] }
POST /api/projects/:id/repurpose    { aspect: "9:16"|"16:9"|"1:1"|"4:5", name?, autoEdit? }
                                    -> 201 { project, sessionId }

Clip = { start, end, title, hook, reason, score }   // lưu video-projects/<id>/clips.json
```
AI đọc transcript, chọn các đoạn đứng riêng được (mở bằng hook, kết thúc trọn ý, không chồng lấn).
Project con tạo bằng `childProject.ts`: asset mang sang bằng **hardlink** (không nhân đôi dung lượng),
kèm transcript của cha; scene của clip là một `srcVideo` với `from`/`to` tuyệt đối trong file nguồn.
Tái chế tỉ lệ copy cả `compositions/` + scenes, đổi width/height, brief kèm hướng dẫn dựng lại bố cục.
`autoEdit` chạy phiên edit AI luôn (tối đa 3 project mỗi lần để không quá tải).

## Duyệt bản draft (ghi chú theo mốc thời gian)

```
GET    /api/projects/:id/review              -> { notes }        // sắp theo atSec
POST   /api/projects/:id/review              { atSec, text }     -> 201 { note }
PATCH  /api/projects/:id/review/:noteId      { text?, status? }  -> 200 { note }
DELETE /api/projects/:id/review/:noteId      -> 204
POST   /api/projects/:id/review/send         { extraNotes? }     -> 202 { sessionId, sentCount }

Note = { id, atSec, text, status: "open"|"sent"|"resolved", createdAt, sentAt? }
```
Lưu ở `video-projects/<id>/review.json`. `send` gom các note `open`, soạn message tiếng Việt
dạng `- [mm:ss] (12.4s) nội dung`, bọc trong `<ghi-chu-nguoi-dung>` kèm luật chống prompt injection,
rồi tiếp tục ĐÚNG phiên edit gần nhất của project (AI còn ngữ cảnh đã dựng) hoặc tạo phiên mới nếu
chưa có. Phiên đang chạy -> 409 `SESSION_BUSY`.

## Style Design (nhiều bộ nhận diện, tab riêng — THAY THẾ Design System cũ) — assets/styles/styles.json

```
StyleDesign = { id, name, tags: string[],
                colors: { primary, secondary, background, text, accent },
                fonts: { heading, body }, fontFiles: { heading: string|null, body: string|null },
                effects: { gradient: boolean, liquidGlass: boolean },
                logoPath: string|null, tone, guidelines, createdAt, updatedAt }

GET    /api/styles                → { defaultId: string|null, styles: StyleDesign[] }
POST   /api/styles                { name, tags?, cloneFrom? } → 201 (id từ name; cloneFrom copy toàn bộ)
PUT    /api/styles/:id            partial (name/tags/colors/fonts/effects/tone/guidelines) → StyleDesign
DELETE /api/styles/:id            → 204 (default bị xóa → chuyển default sang style còn lại; cấm xóa style cuối)
POST   /api/styles/:id/default    → { defaultId }
POST   /api/styles/:id/logo       multipart → StyleDesign (file lưu assets/styles/files/)
POST   /api/styles/:id/font?slot=heading|body  multipart → StyleDesign
POST   /api/styles/:id/font-google { slot: "heading"|"body", family } → StyleDesign
                                  — tải font Google (subset vietnamese) về assets/styles/files/
DELETE /api/styles/:id/font/:slot → StyleDesign
```

- **Migration tự động**: lần chạy đầu, `assets/brand/design-system.json` (nếu có) chuyển thành style
  đầu tiên (id "noti-vn", tag ["brand"]) và làm default. `/api/design-system` BỎ HẲN.
- **Chọn style**: `ImageProject.styleId: string|null` và `Brief.styleId: string|null` (null = dùng default).
  `POST /api/illustrations` nhận thêm `styleId?` — thiếu thì server tự resolve `brief.styleId`
  của video project (rồi mới tới default), nên ảnh minh họa KHÔNG BAO GIỜ thoát style đã chọn.
- **CƯỠNG CHẾ 100%**: mọi sản phẩm (nền Gemini, Poster Remotion, ảnh minh họa, video edit) BẮT BUỘC
  theo style đã chọn. Trong prompt gửi agent, khối "STYLE DESIGN (BẮT BUỘC)" có luật ưu tiên:
  Style Design > prompt mẫu > skill — skill/prompt quy định màu/font khác cũng KHÔNG được theo.

## Image Projects (tạo ảnh AI — Gemini nền + Remotion hoàn thiện) — image-projects/<id>/

```
ImageProject = { id, name, prompt, kind: "background"|"3d"|"character"|"texture"|"product"|"concept",
                 aspect: "9:16"|"16:9"|"1:1"|"4:5", status: "draft"|"generating"|"done"|"error",
                 overlay: { title, subtitle, stats: [{label,value}], cta, showLogo: boolean,
                            position: "auto"|"top-left"|"top-center"|"top-right"|"middle-left"|
                                      "middle-center"|"middle-right"|"bottom-left"|"bottom-center"|"bottom-right" },
                 model: string|null, styleId: string|null,
                 background: string|null, final: string|null, error: string|null,
                 createdAt, updatedAt }

GET    /api/images                → ImageProject[]
POST   /api/images                { name, prompt, kind, aspect, overlay? } → 201 (id sinh từ name)
GET    /api/images/:id            → ImageProject
PUT    /api/images/:id            partial (name/prompt/kind/aspect/overlay) → ImageProject
                                  `name` đổi TÊN HIỂN THỊ, KHÔNG đổi `id` (id là tên thư mục, bị
                                  tham chiếu ở đường dẫn ảnh và projectId của job). 400 INVALID_NAME
                                  khi rỗng hoặc quá 120 ký tự - cùng luật với video project.
POST   /api/images/:id/clone      { name? } → ImageProject (201) — nhân bản project ảnh:
                                  copy ẢNH NỀN + prompt/kind/aspect/model/styleId/overlay,
                                  KHÔNG copy ảnh hoàn thiện (final = null, status = draft).
                                  Nền là nguyên liệu (Gemini sinh hoặc người dùng tải lên), final
                                  là sản phẩm - giữ nền để bản sao compose lại được ngay mà không
                                  phải gọi Gemini lần nữa. Chỉ chép đúng file nền đang dùng, không
                                  chép bản final cũ hay props còn đọng trong thư mục.
                                  Tên bỏ trống → "<tên gốc> (bản sao)"; id mới sinh từ tên.
DELETE /api/images/:id            → 204
POST   /api/images/:id/background multipart → ImageProject (tự upload nền, không cần Gemini)
POST   /api/images/:id/generate   { step?: "all"|"background"|"compose" } → 202 Job (queue type "image-gen")
GET    /api/images/:id/junk       → { items: [{ relPath, size }], totalBytes } — file rác: props.json,
                                    staging Remotion img-<id>/ (background/final/meta giữ nguyên)
POST   /api/images/:id/junk/clean → { freedBytes, deleted } — xóa các mục trên; job running/queued → 409 JOB_RUNNING
```

Pipeline generate: (1) `background` — gọi Gemini tạo ảnh nền theo prompt + kind + aspect,
prompt được TRỘN với Design System (màu brand, tone) để đồng bộ; không có GEMINI_API_KEY → job fail
với hướng dẫn (hoặc dùng bước upload nền thủ công rồi chạy `compose`). (2) `compose` — Remotion
render still composition `Poster`: nền + tiêu đề tiếng Việt + logo + số liệu + CTA theo đúng
màu/typography của Design System → `final.png`. Job.projectId = id image project; UI phân biệt
qua job.type = "image-gen". /media phục vụ thêm thư mục `image-projects/`.

Hợp đồng composition Remotion `Poster` (render bằng `npx remotion still Poster --props=<file> --output=<png>`;
kích thước qua calculateMetadata từ props):
```
PosterProps = {
  aspect: "9:16"|"16:9"|"1:1"|"4:5",          // 9:16=1080x1920, 16:9=1920x1080, 1:1=1080x1080, 4:5=1080x1350
  background: string|null,                     // staticFile path trong public/staging (null = nền gradient từ design)
  design: { colors: {primary, secondary, background, text, accent},
            fonts: {heading, body},
            fontFiles: { heading: string|null, body: string|null },  // staticFile path font đã stage
            effects: { gradient: boolean, liquidGlass: boolean },
            logoFile: string|null, brandName: string },
  overlay: { title, subtitle, stats: [{label, value}], cta, showLogo, position }
}
```
Server stage nền + logo bằng hardlink vào engines/remotion/public/staging/img-<id>/ trước khi still
(cùng cơ chế với assemble).

**`overlay.position` — vị trí khối chữ (lưới 3x3).** `"auto"` (mặc định) = bố cục theo tỉ lệ khung,
đúng như trước khi có tùy chọn này: ngang → `middle-left`, vuông → `bottom-center`, dọc →
`bottom-left`. Ảnh cũ render lại ra byte y hệt (đã đối chiếu hash cả 3 tỉ lệ).

Chọn vị trí khác thì Poster tự dời theo, không chỉ mỗi khối chữ:

- **Scrim và glow** đổi tâm bám khối chữ — nếu không, chữ dời lên trên mà vùng tối vẫn ở dưới,
  chữ nằm trên vùng ảnh sáng sẽ không đọc được.
- **Brand tint** đổi hướng gradient theo phía chứa chữ.
- **Logo** lùi về góc đối diện (chữ ở trên → logo xuống dưới) để hai khối không chồng nhau.
- **Hạt trang trí** tắt hẳn: tọa độ của chúng gắn cứng với rìa khối chữ mặc định, giữ lại là hạt
  rơi đè lên chữ.
- **Kẻ gradient dưới tiêu đề** đảo chiều khi căn phải; căn giữa thì tan hai đầu.
- 16:9 căn giữa được nới khối chữ từ 47% lên 72% khung — 47% tồn tại để chừa nửa khung cho chủ thể
  ảnh, căn giữa thì không còn nửa nào để chừa, giữ hẹp chỉ làm chữ xuống dòng vụn.

## Prompt mẫu (quản lý prompt tái sử dụng — lưu tại assets/prompts/prompts.json)

```
PromptTemplate = { id, name, content, createdAt, updatedAt }

GET    /api/prompts        → PromptTemplate[]
POST   /api/prompts        { name, content } → PromptTemplate (201; id sinh từ name kebab, trùng thêm -2)
PUT    /api/prompts/:id    { name?, content? } → PromptTemplate
DELETE /api/prompts/:id    → 204
```

UI: trong form Brief có dropdown "Dùng prompt mẫu" — chọn thì đổ `content` vào ô "Yêu cầu edit"
(notes) rồi tùy chỉnh tiếp; trang quản lý riêng ở /prompts.

## Render Jobs (queue SONG SONG — tối đa `queueConcurrency` job cùng lúc)

Queue chạy song song tối đa `queueConcurrency` job (1–4, mặc định 2 — chỉnh ở tab Cấu hình
hoặc env `QUEUE_CONCURRENCY`). Ràng buộc: **2 job của cùng một project không bao giờ chạy
đồng thời**. `runningJob` trong /api/overview = job đang chạy đầu tiên (có thể có nhiều job
đang chạy song song).

```
Job = { id, projectId, type: "scene-draft"|"scene-final"|"assemble-draft"|"assemble-final"
              |"image-gen"|"auto-cut"|"auto-trim"|"text-to-video",
        sceneId: string|null, status: "queued"|"running"|"done"|"failed"|"canceled",
        progress: 0..100, step: string, outputPath: string|null,
        createdAt, startedAt: string|null, finishedAt: string|null }

8 loại job. Tạo được qua POST /api/jobs: scene-draft, scene-final, assemble-draft, assemble-final,
image-gen (projectId = image project, sceneId = step all|background|compose),
auto-cut (projectId = id phiên cắt, sceneId = step plan|cut),
auto-trim (projectId = video project, sceneId = mức natural|default|tight).
"text-to-video" KHÔNG tạo tay được - chỉ sinh qua POST /api/text-to-video/:id/build.
`auto-trim` tạo thẳng qua POST /api/jobs thì chạy với mức trong brief và KHÔNG có ứng viên mỡ thừa
nào được duyệt - muốn truyền `cutCandidates` thì phải đi qua POST /api/projects/:id/auto-trim/apply.
Cả hai đường đều trả 409 AUTO_CUT_DISABLED khi brief của project TẮT "Tự động cắt" (`brief.autoCut = false`).

GET  /api/jobs?limit=50&projectId=  → Job[] (mới nhất trước; projectId lọc theo project - tùy chọn)
GET  /api/jobs/:id              → Job & { log: string }
POST /api/jobs                  { projectId, type, sceneId?, force? } → Job (201)
POST /api/jobs/:id/cancel       → Job (kill process nếu đang chạy)

GET  /api/render-settings       → { settings, defaults, hardware, recommended: { workers, concurrency, maxWorkers } }
                                  (cấu hình render — tab Cấu hình; recommended theo máy thật: min(luồng CPU, 8), trần max(luồng CPU, 4))
PUT  /api/render-settings       partial → 200 (queueConcurrency clamp 1–4; workers/remotionConcurrency clamp 0–max(luồng CPU, 4))
```

Thực thi (cwd trong ngoặc):
- `scene-draft|scene-final`: với mỗi scene có `src` trong meta.json (hoặc chỉ `sceneId` nếu truyền):
  `npx hyperframes render --quality draft|standard --output renders/<sceneId>[.draft].mp4` (cwd `video-projects/<id>`)
- `assemble-draft|assemble-final`: stage asset bằng **hardlink** vào `engines/remotion/public/staging/<projectId>/`,
  sinh `props.resolved.json` (đường dẫn đổi thành `staging/<projectId>/...`), rồi
  `npx remotion render Assemble --props=<props.resolved.json> --output=<abs outputs/...>` (cwd `engines/remotion`)
  Draft thêm `--crf 28`. Final ghi `outputs/<projectId>-v<N>.mp4` (N tự tăng), xong cập nhật meta.json (`status`, `output`).
- `auto-trim`: đo → gộp khoảng cắt → một lượt ffmpeg `trim/atrim + concat` ra `assets/<stem>.cut.mp4`
  → dời mốc transcript → nghiệm thu → `assets/auto-trim-report.json` (xem mục Auto-trim).
  Dùng chung khóa "bận" `vid:` với scene/assemble vì nó ghi đè asset của chính project đó.
- Progress: parse stdout hai CLI (dòng tiến độ frame) → `progress` + `step`, đẩy SSE. Log đầy đủ lưu DB.
- Server từ chối (409) job `*-final` nếu chưa có job `assemble-draft` thành công cho project đó.

## SSE — GET /api/events

Một stream chung, `text/event-stream`, heartbeat comment mỗi 15s. Event types:

```
event: job      data: Job                                  (mỗi lần job đổi status/progress)
event: joblog   data: { jobId, line }                      (từng dòng log job đang chạy)
event: agent    data: { sessionId, kind: "text"|"tool"|"result"|"error"|"done",
                        text?, tool?: { name, input }, error?,
                        status? }                          (status đi kèm kind "done" — trạng thái kết thúc của phiên)
event: upload   data: { id, projectId?, received, total, done, error?, file? }  (tiến trình nhận file POST /api/assets, throttle ~400ms — event done thành công kèm `file` = tên đã lưu)
```

## Skills

```
GET    /api/skills              → [{ name, description, updatedAt, sizeBytes }]  (đọc .claude/skills/*/SKILL.md)
GET    /api/skills/:name        → { name, content }
POST   /api/skills              { name, content } → 201 (409 nếu trùng; validate frontmatter có name+description)
PUT    /api/skills/:name        { content } → 200
DELETE /api/skills/:name        → 204

POST   /api/skills/generate     — tạo draft SKILL.md bằng Claude (Agent SDK, một lượt, không tool).
  Body (mọi field trừ goal đều optional):
  { goal: string,                 // mục đích & loại video — BẮT BUỘC
    name?: string,                // tên kebab-case gợi ý; rỗng = AI tự đặt
    platform?: string,            // "TikTok" | "YouTube" | "Facebook" | "Instagram" | tự do
    aspect?: "9:16"|"16:9"|"1:1"|"4:5",
    fps?: 30|60,
    duration?: string,            // vd "30–60s"
    style?: string,               // phong cách & nhịp điệu
    captions?: "karaoke"|"sentence"|"none",
    highlights?: boolean,         // keyword highlight
    sfx?: boolean,                // sound effect đồng bộ timestamp
    baseSkill?: string,           // tên skill có sẵn làm mẫu — server nhúng nội dung vào prompt
    notes?: string }
  → 200 { name, content, tokens: { input, output } }
  — server nhúng skill-authoring + baseSkill (nếu có) vào prompt; kết quả parse từ code fence
    hoặc toàn văn, validate frontmatter (name ép kebab-case, tránh trùng bằng hậu tố -2).
    KHÔNG ghi file — UI hiển thị draft, user sửa rồi POST /api/skills để lưu.
  Lỗi: 503 NO_CLAUDE_AUTH (chưa đăng nhập Claude), 422 BAD_SKILL_OUTPUT (AI trả sai định dạng —
    body kèm { raw } để user tự sửa), 500 GENERATION_FAILED.
  Token ghi vào token_usage (sessionId "skillgen_<nanoid>", provider claude, projectId null).
  Có thể chạy 1–3 phút — web gọi thẳng server origin (bỏ qua Next proxy).
```

## Sound Effects

```
SfxEntry = { file, tags: string[], durationMs: number|null, description, source?, license? }

GET    /api/sfx                 → SfxEntry[]  (đọc assets/sound-effects/library.json, chỉ trả entry có file tồn tại)
POST   /api/sfx                 multipart: file (audio) + fields tags (csv), description, source, license
                                → SfxEntry (lưu file kebab-case ASCII, đo durationMs bằng ffprobe, cập nhật library.json)
PATCH  /api/sfx/:file           { description?, tags?, recommended?, source?, license? } → SfxEntry
                                — recommended=true thêm tag "hay-dung", false gỡ tag đó
                                — source/license: chuỗi rỗng = XÓA field (không ghi "" vào file)
DELETE /api/sfx/:file           → 204

Quy ước "đề xuất": entry có tag `hay-dung` là sound effect được đề xuất — UI hiển thị khu riêng,
AI ưu tiên dùng khi brief đặt sfxMode "recommended".

`source` (URL nơi lấy file) và `license` (mã giấy phép) là tùy chọn nhưng nên có: repo ship thư mục
sound-effects RỖNG vì file audio không rõ nguồn thì không phát tán lại được. Xem
assets/sound-effects/README.md.
```

## Music (nhạc nền)

```
MusicEntry = { file, tags: string[], durationMs: number|null, description }
             — tags = MOOD của bài (nang-luong, chill, cam-hung, cang-thang, vui-ve...)

GET    /api/music               → MusicEntry[]  (đọc assets/music/library.json, chỉ trả entry có file tồn tại)
POST   /api/music               multipart: file (audio) + fields tags (csv), description
                                → MusicEntry (lưu file kebab-case ASCII, đo durationMs bằng ffprobe, cập nhật library.json)
PATCH  /api/music/:file         { description?, tags? } → MusicEntry
DELETE /api/music/:file         → 204
```

Brief đặt `musicMode: "auto"` → server soạn danh sách thư viện vào edit prompt, AI chọn MỘT bài
hợp mood và cấu hình auto-ducking theo skill `background-music` (khai `meta.json` → `audio.music`).
Thư viện trống → AI bỏ qua nhạc nền, KHÔNG tự tải nhạc từ mạng (bản quyền). CHỈ dùng nhạc không lời.

## Assets / Imports

```
GET  /api/assets?scope=imports|outputs            → FileInfo[]
GET  /api/assets?scope=project&projectId=<id>     → FileInfo[] (assets/ của project)
POST /api/assets  multipart: file + scope (+projectId) → FileInfo (tên file ép về ASCII kebab-case)
```

## Media (phát file trong trình duyệt)

```
GET  /media/<relPath>          — static có hỗ trợ Range (video/audio seek được).
POST /api/reveal { relPath }   → 204 — mở đúng file trong Explorer/Finder trên máy chạy server.
```
Chỉ phục vụ dưới các thư mục whitelist: `video-projects/`, `image-projects/`, `translate-video/`, `assets/`, `outputs/`, `imports/`, `remotion-fonts/` (= `engines/remotion/public/fonts`, font overlay cho trình phát xem trước Remotion trong trình chỉnh sửa). Chặn `..`.
`relPath` tính từ repo root, vd `/media/outputs/demo-v1.mp4`. Reveal: file không tồn tại → 404, ngoài whitelist → 403.

## Chat (Claude Agent)

```
ChatSession = { sessionId, title, projectId, status, model, effort,
                runStartedAt: string|null,   // ISO — lúc lượt chạy hiện tại BẮT ĐẦU (không reset khi auto-resume)
                runFinishedAt: string|null,  // ISO — lúc lượt chạy kết thúc hẳn; null khi đang chạy
                autoResume: boolean,         // tự chạy tiếp khi gián đoạn (mặc định true)
                goal: "final"|null,          // "final" = phiên edit project, gate hoàn thành theo video final
                createdAt, updatedAt }

GET  /api/chat/sessions[?projectId=]  → ChatSession[]
GET  /api/chat/:sessionId/messages    → [{ role: "user"|"assistant", kind: "text"|"tool", content, createdAt }]
POST /api/chat                        { message, sessionId?, projectId?, model?, effort? } → { sessionId } (202)
                                       — chạy agent async, event đẩy qua SSE kênh `agent`;
                                       projectId chỉ dùng khi TẠO session mới; model/effort lưu vào session
                                       (gửi kèm sessionId = đổi model/effort giữa chừng)
POST /api/chat/:sessionId/interrupt   → 204
PUT  /api/chat/:sessionId/auto-resume { enabled: boolean } → 204
```

**Thời gian chạy bền vững:** UI KHÔNG tự đếm từ lúc mount — elapsed = now − Date.parse(runStartedAt),
nên F5/tắt mở tab không reset. Khi xong, thời lượng = runFinishedAt − runStartedAt.
Semantics phía server: POST /api/chat (message mới) đặt runStartedAt=now, runFinishedAt=null,
resumeAttempts=0; lượt auto-resume GIỮ NGUYÊN runStartedAt; runFinishedAt chỉ ghi khi kết thúc hẳn.

**Auto-resume:** phiên kết thúc với status "error" (KHÔNG phải user bấm dừng) và autoResume bật
→ server tự chạy tiếp sau 10s với message "Tiếp tục công việc đang dở..." (tối đa 3 lần LIÊN TIẾP
KHÔNG CÓ TIẾN BỘ — goal 'final': 12 lần; đếm reset khi user gửi message mới HOẶC khi project có
tiến bộ giữa hai lượt). Tiến bộ đo bằng `progressMark` lưu trong chat_sessions: số job done của
project + số file/tổng size/mtime mới nhất trong renders/ + file output + meta.status — mark đổi
so với lượt trước → resumeAttempts reset về 0 trước khi bump. Server khởi động lại khi phiên đang
running → phiên bị đánh "interrupted"; những phiên đó nếu autoResume bật sẽ được tự chạy tiếp ~15s
sau khi server lên (cần Claude auth). User chủ động interrupt thì KHÔNG BAO GIỜ auto-resume.

**Goal 'final' (phiên edit project):** POST /api/projects/:id/edit tạo session với `goal: "final"`
(chat thường: goal null; phiên edit cũ tạo trước khi có cột goal được migration backfill về
'final' theo dấu hiệu title "Edit: " + projectId). Khi agent kết thúc "done" mà video final CHƯA
tồn tại thật (`normOutput(meta.output)` null, file không có trên đĩa, hoặc meta.status ≠ "done")
→ server KHÔNG coi là xong: giữ status "running" và tự chạy tiếp sau 10s qua hạ tầng auto-resume
(tôn trọng autoResume + interrupt, tối đa 12 lần liên tiếp không tiến bộ — có tiến bộ thì đếm lại
từ 0); hết lượt mà vẫn thiếu final → status "error" + message giải thích. Phiên goal 'final' chạy
với maxTurns 300 (phiên thường 100).

Agent chạy với cwd = repo root, nạp CLAUDE.md + `.claude/skills` của workspace, được phép Edit/Write file và chạy các lệnh whitelist trong `.claude/settings.json` không cần hỏi. Nếu thiếu API key: event `agent` kind `error` với message hướng dẫn đặt `ANTHROPIC_API_KEY` trong `.env`.

## Token Usage (biểu đồ Dashboard + cột token project)

```
GET /api/usage/summary
→ { byProject: { <projectId>: { tokens, costUsd } },
    total: { tokens, costUsd, tokensIn, tokensOut } }

GET /api/usage/timeline?days=30&scope=all|video|image
→ [{ date: "yyyy-mm-dd", tokens, tokensIn, tokensOut, costUsd,
     byProvider: { claude?: number, gemini?: number, openai?: number } }]
```

- `scope` phân loại theo projectId của dòng token_usage: tồn tại trong `image-projects/` → image,
  trong `video-projects/` → video; còn lại (chat tự do, projectId null) chỉ tính vào `all`.
  Phân loại resolve mỗi request (project có thể bị xóa — dòng token của nó rơi về nhóm "còn lại").
- `days` clamp 1–365. UI Dashboard có bộ lọc 7/30/90 ngày + loại project (Tất cả/Video/Ảnh)
  và hiển thị chi tiết token in / token out.

## Update (cập nhật hệ thống từ GitHub — badge cuối sidebar)

```
GET  /api/update/check[?force=1]
→ { current: "<short-hash>", currentVersion: "v1.0.0"|null, latestVersion: "v1.0.1"|null,
    channel: "stable"|"latest", behind, upToDate, latestMessage,
    commits: [{hash, message}], checkedAt, fetchOk, fellBackToMain?, error? }
POST /api/update/apply  → 202 { ok: true, logHint, target } | 409 JOB_RUNNING (đang có job render)
```

- **Kênh cập nhật** = `settings.updateChannel` (mặc định `"stable"`):
  - `"stable"`: mốc so sánh là **tag release mới nhất** khớp `v*` (sắp bằng `--sort=-v:refname`
    nên `v1.0.10` đứng trên `v1.0.9`). Người dùng chỉ nhận bản đã được publish thành Release.
  - `"latest"`: mốc là `origin/main` như hành vi cũ — mọi commit push lên đều thành "có bản mới".
    Kênh này trả `latestVersion: null` vì thứ chào mời là commit chứ không phải bản phát hành.
- `currentVersion` = tag `v*` gần nhất tính ngược từ HEAD (`git describe --abbrev=0`), `null` khi
  chưa tag nào là tổ tiên của HEAD. `fellBackToMain: true` khi kênh `stable` mà repo **chưa có tag
  nào** — khi đó tự lùi về so với main để người dùng không kẹt vĩnh viễn.
- Check chạy `git fetch origin --tags --force` (thiếu `--tags` thì máy không bao giờ thấy release
  mới), cache 3 phút **theo kênh** (đổi kênh là thấy kết quả mới ngay, `force=1` bỏ cache);
  lỗi (offline, không có git) trả `upToDate: true` + `error` ngắn — không bao giờ 500.
- Apply ghi mốc đích ra `start/update-target.txt` rồi spawn `update/update.bat` (win32) /
  `update/update.sh` detached. Script đọc file đó và `git merge --ff-only <target>` (KHÔNG
  `checkout` tag — checkout làm repo rơi vào detached HEAD, lần cập nhật sau sẽ rối), rồi
  `npm install` và khởi động lại; UI poll `/api/health` chờ server chết → sống lại rồi tự reload.
  Bản cài cũ chưa có file target thì script mặc định `origin/main`, giữ nguyên hành vi cũ.

## Ghi chú cho render Remotion

- Composition lắp ráp video là `Assemble`, data-driven từ props (schema = meta.json, xem skill `remotion-assemble`); Root.tsx còn đăng ký 2 composition still: `Poster` (image project) và `Thumbnail` (thumbnail video).
- `calculateMetadata` đọc width/height/fps/tổng durationInFrames từ props.
- Asset không đọc trực tiếp từ đường dẫn tuyệt đối — server stage bằng hardlink (`fs.linkSync`, fallback copy) vào `engines/remotion/public/staging/<projectId>/` rồi props dùng `staticFile("staging/<projectId>/<file>")`.
- Nhạc nền: `audio.music = { file, volume=0.35, duckVolume=0.12, speech: [[startSec,endSec],...] } | null`
  (file copy vào `assets/` của project, server stage như sfx). Component `MusicTrack` loop cả bài,
  fade-in 0.5s đầu / fade-out 1s cuối, và duck TẤT ĐỊNH: trong speech range (đoạn CÓ thoại, giây trên
  timeline composition) volume = duckVolume, ngoài = volume, chuyển mượt bằng interpolate trong 0.4s
  quanh mỗi biên. Speech ranges do AI sinh từ transcript (merge gap < 0.6s) — xem skill `background-music`.
