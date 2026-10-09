# Trình chỉnh sửa video trong dashboard - kế hoạch & hợp đồng kỹ thuật

> Tài liệu này là HỢP ĐỒNG giữa các phần (server, engine Remotion, web). Ai sửa
> một phần phải giữ đúng các kiểu dữ liệu / endpoint dưới đây; muốn đổi thì sửa
> tài liệu này trước.

## 0. Mục tiêu (kiểu ChatCut)

Mở một project video → thấy **trình phát xem trước** (chạy thẳng composition
Remotion `Assemble` trong trình duyệt bằng `@remotion/player`, KHÔNG phải render),
**timeline** nhiều track bên dưới, **inspector** sửa thuộc tính phần tử đang chọn,
**chat AI** bên phải. Mọi thao tác (tay hoặc AI) ghi vào `meta.json` của project
→ xem trước cập nhật ngay → bấm Render là đi qua render queue như cũ.

Nguyên tắc giữ nguyên:
- Trình duyệt KHÔNG mã hóa / xử lý video. Xem trước = Remotion Player; xuất bản =
  render queue của backend (CLAUDE.md quy tắc 2).
- `meta.json` vẫn là nguồn sự thật duy nhất của timeline. Không tạo file timeline
  song song.
- Backend là nguồn sự thật về trạng thái job / khóa.

## 1. Dữ liệu được sửa

Các khóa TOP-LEVEL của `meta.json` mà editor được ghi (gọi chung là **timeline**):

| Khóa | Kiểu (zod ở `engines/remotion/src/manifest.ts`) | Ghi chú |
|---|---|---|
| `scenes` | `Scene[]` (≥1 khi render) | thứ tự = thứ tự phát; `from`/`to` là GIÂY trong file nguồn |
| `audio` | `{ voice, sfx[], music }` | `sfx[].atFrame` FRAME tuyệt đối; `music.speech` GIÂY |
| `captions` | `CaptionCue[]` | `from`/`durationInFrames` + `words[].start/end` FRAME tuyệt đối |
| `subtitles` | `SubtitleCue[]` | FRAME tuyệt đối |
| `subtitleStyle` | `SubtitleStyle` | tùy chọn |
| `overlays` | `HighlightCue[]` | FRAME tuyệt đối |

Mọi khóa khác (`brief`, `status`, `output`, `tags`, field lạ do agent thêm) editor
KHÔNG đụng. Các object con là `looseObject` → field lạ trong scene/cue phải được
GIỮ NGUYÊN khi editor ghi lại (editor sửa trên bản sao, không dựng lại object từ
đầu).

Đường dẫn trong meta luôn **tương đối thư mục project** (`assets/x.mp4`,
`renders/s1.mp4`, `assets/sfx/boom.mp3`).

## 2. Server - API mới (luồng A)

Tất cả nằm dưới `/api/projects/:id/...`, file route mới
`apps/server/src/routes/timeline.ts`, logic thuần ở `apps/server/src/timeline.ts`.

### 2.1 Phiên bản & khóa

- `timelineVersion` = sha1 (hex, 16 ký tự đầu) của `JSON.stringify` các khóa ở
  mục 1 theo thứ tự cố định (khóa thiếu = `null`). Đổi brief/tên KHÔNG đổi version.
- **Khóa AI**: project có phiên AI đang chạy hoặc đang chờ auto-resume
  (`isAgentBusy` cho bất kỳ session nào của project) → mọi lệnh GHI timeline trả
  `409 AGENT_BUSY`. Đọc vẫn được.
- Job render đang chạy KHÔNG khóa (assemble chụp meta lúc bắt đầu) - GET trả
  `renderActive: true` để UI báo "bản đang render sẽ không có thay đổi mới".

### 2.2 Endpoint

```
GET  /api/projects/:id/timeline
  → 200 {
      version: string,                 // timelineVersion
      timeline: Timeline,              // các khóa mục 1 (thiếu thì mặc định: [] / {voice:null,sfx:[],music:null})
      project: { id, name, width, height, fps, status, updatedAt },
      preview: {
        // đường dẫn (tương đối project) file MP4 xem trước cho scene HyperFrames:
        // ưu tiên renders/<id>.mp4 (final) rồi .draft.mp4; null = chưa render
        sceneRenders: Record<sceneId, string | null>,
        watermark: null | { file: string, position: "top-left" },   // giống assemble.ts (syncBrandLogo)
        // thời lượng thật (giây) của mọi file media được timeline tham chiếu, đo ffprobe, cache theo mtime
        media: Record<relPath, { durationSec: number | null, width?: number, height?: number, hasAudio?: boolean }>
      },
      lock: { agentBusy: boolean, renderActive: boolean, sessionId: string | null }
    }

PUT  /api/projects/:id/timeline
  body { baseVersion: string, timeline: Partial<Timeline>, label?: string }
  → 200 { version, timeline }                 // đã lưu
  → 409 VERSION_CONFLICT { current: { version, timeline } }   // ai đó (AI/tab khác) đã đổi
  → 409 AGENT_BUSY
  → 400 INVALID_TIMELINE { issues: [{ path, message }] }      // validate như mục 2.3
  Khóa nào có trong body thì THAY nguyên khóa đó; khóa không gửi giữ nguyên.
  Trước khi ghi: lưu snapshot bản CŨ vào lịch sử (2.4) với label.

GET  /api/projects/:id/timeline/revisions
  → 200 [{ rev, createdAt, label, source: "editor"|"ai-before"|"ai-after"|"restore", version }]  (mới nhất trước)
POST /api/projects/:id/timeline/revisions/:rev/restore   body { baseVersion }
  → 200 { version, timeline }  (cũng 409 như PUT)

GET  /api/projects/:id/media-info?path=assets/x.mp4
  → 200 { durationSec, width, height, hasAudio }   (ffprobe, cache theo mtime; path phải nằm trong project)

GET  /api/library/sfx        → [{ file, durationMs, description, tags, available }]   (chỉ file có trên đĩa)
GET  /api/library/music      → tương tự từ assets/music/library.json
POST /api/projects/:id/library-import  body { kind: "sfx"|"music", file }
  → 201 { relPath: "assets/sfx/<file>" | "assets/music/<file>", durationSec }
  (chép vào project nếu chưa có - Remotion chỉ stage file trong project)

POST /api/projects/:id/editor/render  body { quality: "draft"|"final", force?: boolean }
  → 202 { jobs: Job[] }
  Xếp `scene-draft`/`scene-final` cho scene HyperFrames thiếu file render rồi
  `assemble-draft`/`assemble-final`. Giữ nguyên luật: final cần draft thành công
  + cổng QC (409 DRAFT_REQUIRED / QC_REQUIRED / QC_FAILED như /api/jobs).

POST /api/projects/:id/editor/chat  body { message, sessionId?, model?, effort? }
  → 202 { sessionId }
  Phiên chat goal=NULL (KHÔNG phải 'final' → không auto-resume ép render). Lượt
  đầu kèm khối ngữ cảnh "đang ở trình chỉnh sửa" (2.5). 409 SESSION_BUSY nếu
  phiên AI khác của project đang chạy.

GET  /api/projects/:id/timeline/export.xml
  → FCP7 XML (xmeml v5) - mở được bằng Premiere Pro và DaVinci Resolve. Track
  video: scene (srcVideo có in/out, render HyperFrames, ảnh tĩnh); track audio:
  voice, sfx, music. Đường dẫn file:// tuyệt đối trên máy chạy server.
  Header Content-Disposition attachment `<id>.xml`.
```

### 2.3 Validate (server)

Server KHÔNG import zod của engine (khác package). Viết validator tay trong
`timeline.ts`, bám đúng ràng buộc của `manifest.ts`:
- `scenes[]`: `id` chuỗi không rỗng, KHÔNG trùng; `from`/`to` số ≥0 và `to > from`
  khi có cả hai; `durationInFrames` nguyên dương; `transitionOverlap` nguyên ≥0;
  mỗi scene phải có ít nhất một nguồn (`src`|`srcVideo`|`srcImage`|`render`) HOẶC
  `durationInFrames`.
- `audio.sfx[]`: `file` chuỗi, `atFrame` nguyên ≥0, `volume` 0..1, `mediaStart` ≥0.
- `audio.music`: `file`, `volume` 0..1, `duckVolume` 0..1, `speech` cặp số.
- cue (captions/subtitles/overlays): `from` nguyên ≥0, `durationInFrames` nguyên
  dương; captions `words` ≥1, `text` không rỗng; overlays `parts` ≥1, `t` không rỗng,
  `tier`∈{main,sub}, `accent`∈{hot,cool}; subtitles `text` không rỗng.
- Mọi đường dẫn media: tương đối, không `..`, không tuyệt đối, phải nằm trong
  thư mục project (cùng hàng rào traversal như assemble.ts `stage()`).
- Ghi file nguyên tử (tmp + rename), giữ nguyên các khóa khác của meta.

### 2.4 Lịch sử phiên bản

`video-projects/<id>/.history/<rev>.json` = `{ rev, createdAt, label, source, version, timeline }`
(`rev` = ISO thời gian + 4 ký tự ngẫu nhiên). Giữ 100 bản mới nhất. Snapshot khi:
PUT/restore (bản trước khi ghi, source "editor"/"restore"), và khi một phiên AI của
project BẮT ĐẦU (source "ai-before") / KẾT THÚC mà version đổi (source "ai-after")
→ người dùng luôn quay lại được trạng thái trước khi AI sửa. `.history/` vào
`.gitignore`.

### 2.5 Agent biết có trình chỉnh sửa

- `editPrompt.ts` + skill `video-pipeline`, `remotion-assemble`: người dùng có thể
  đã sửa tay `meta.json` qua trình chỉnh sửa → LUÔN đọc lại meta.json ngay trước khi
  sửa, sửa đúng chỗ (Edit), không ghi đè cả file từ trí nhớ, giữ field lạ.
- Prompt của `/editor/chat`: người dùng đang xem trước trực tiếp → chỉ sửa
  `meta.json` theo yêu cầu, KHÔNG tự render draft/final trừ khi được yêu cầu (scene
  HyperFrames mới/sửa thì xếp `scene-draft` qua `/api/jobs` để xem trước được),
  báo lại ngắn gọn đã đổi gì.

## 3. Engine Remotion dùng được trong trình duyệt (luồng B)

Yêu cầu tuyệt đối: **render qua CLI cho ra kết quả y hệt trước** (kiểm bằng render
thật + so khung hình).

- `engines/remotion/src/media.tsx`: `MediaResolverContext` (mặc định `staticFile`),
  `MediaResolverProvider`, `useMediaSrc()`. Mọi `staticFile(...)` trong Assemble và
  các track (SceneClip, SfxTrack, MusicTrack, voice, watermark, font overlay) đổi sang
  resolver. Poster/Thumbnail giữ nguyên.
- Font overlay: `vietnameseFontFaceCss` đang tính ở module scope bằng
  `staticFile` → đổi thành hàm `vietnameseFontFaceCss(resolve)` gọi lúc render.
  `useVietnameseFont`: lỗi nạp font khi ĐANG RENDER vẫn `cancelRender`; trong Player
  (`getRemotionEnvironment().isPlayer`) chỉ cảnh báo + `continueRender`, không làm
  sập trang.
- Server phục vụ font: thêm `remotion-fonts` vào whitelist `/media`
  (→ `engines/remotion/public/fonts`).
- Web: `apps/web/package.json` thêm `remotion` + `@remotion/player` đúng
  **4.0.500** (khớp `@remotion/cli`; lệch phiên bản là Remotion cảnh báo/lỗi).
  Import engine qua alias tsconfig `@engine/*` → `../../engines/remotion/src/*`
  (đã thử: Next 16 build được).
- `apps/web/src/components/editor/PreviewPlayer.tsx` ("use client"): nhận
  `{ projectId, timeline, project, preview }` → dựng manifest (thay `scene.render`
  bằng `preview.sceneRenders`, gắn `preview.watermark`, validate bằng
  `manifestSchema.safeParse`; lỗi → hiện danh sách lỗi thay vì sập), bọc
  `Assemble` trong `MediaResolverProvider` với resolver:
  `fonts/…` → `/media/remotion-fonts/…`; còn lại → `/media/video-projects/<id>/<rel>`
  (encode từng đoạn). Expose `PlayerRef` (seek/play/pause, sự kiện frameupdate)
  cho timeline. Scene HyperFrames chưa render → placeholder sẵn có của SceneClip.

## 4. Web - trình chỉnh sửa (luồng C)

Trang mới `apps/web/src/app/projects/[id]/editor/page.tsx`, nút "Mở trình chỉnh
sửa" ở trang project. Code trong `apps/web/src/components/editor/`.

Bố cục (desktop ≥1100px; nhỏ hơn: xếp dọc, timeline cuộn ngang):
```
┌ Thanh trên: ← project · tên · trạng thái lưu · Hoàn tác/Làm lại · Lịch sử · Xuất XML · Render draft/final ┐
├ Thư viện (trái, gập được) │      Trình phát (giữa)        │ Inspector (phải)        │
│ asset project / SFX / nhạc │  + điều khiển phát, mốc giờ   │ thuộc tính phần tử chọn │
├──────────────────────────────── Timeline (dưới, kéo cao được) ─────────────────────┤
│ thước giờ · playhead · track: Video · Highlight · Karaoke · Phụ đề · SFX · Voice · Nhạc │
└──────────────────────────────────────────────────────────────────────────────────────┘
Chat AI: ShellRightPanel sẵn có (gửi qua /editor/chat).
```

Trạng thái: một store (useReducer) giữ `timeline` + `history` (undo/redo, gộp các
thao tác kéo liên tục thành một bước) + `selection` + `playheadFrame`. Tự lưu
(debounce ~700ms, PUT với baseVersion). Xung đột → banner: "Tải bản mới" / "Ghi đè
bằng bản của tôi". AI đang chạy → editor chỉ đọc + banner; SSE agent Write/Edit →
tải lại timeline (throttle) để thấy AI sửa ngay trong trình phát.

**Giai đoạn 1** - trình phát + đọc timeline + chat AI + render; điều khiển phát
(Space, ←/→ 1 frame, Shift ±1s), playhead đồng bộ hai chiều với Player.

**Giai đoạn 2** - sửa tay:
- Chọn (click), xóa (Delete), nhân bản (Ctrl+D), tách tại playhead (S: scene
  srcVideo/ảnh, cue phụ đề), hoàn tác/làm lại (Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y).
- Kéo: đổi thứ tự scene; dời cue/sfx theo thời gian; kéo mép: trim scene
  (srcVideo đổi from/to, giới hạn trong độ dài file; ảnh đổi durationInFrames;
  HyperFrames không kéo dài quá bản render), đổi độ dài cue. Hít (snap) vào
  playhead/mép phần tử khác (Alt tắt hít). Zoom timeline (Ctrl+lăn chuột, thanh zoom).
- Inspector: scene (nguồn, in/out, độ dài, tắt tiếng, chuyển cảnh mờ chồng
  transitionOverlap, punch-in zoom đơn giản bắt đầu/kết thúc); caption (sửa từng
  từ, đánh dấu từ nhấn `hi`, mốc thời gian); phụ đề (chữ, kiểu); highlight (kicker,
  phần chữ + nhấn, tier, accent); sfx (file, thời điểm, âm lượng); nhạc (file, âm
  lượng, mức duck); voice (file).

**Giai đoạn 3** - hoàn thiện:
- Thư viện kéo-thả: asset video/ảnh của project → thêm scene; SFX/nhạc thư viện
  chung → `library-import` rồi thêm vào track; thêm highlight/phụ đề mới tại playhead.
- Lịch sử phiên bản (xem & khôi phục, kể cả "trước khi AI sửa").
- Xuất XML Premiere/DaVinci; phím tắt (bảng `?`).

Quy tắc UI: theo skill `webui-design` (thang chữ 3 bậc, token màu - thêm token
track timeline cho cả sáng/tối, primitive có sẵn, icon Lucide, mọi chuỗi qua
`t()` có đủ vi/en). Chạy `check-design-system.mjs` + `check-i18n.mjs`.

## 5. Kiểm chứng

- typecheck + build + 2 cổng web.
- Render thật qua CLI trước/sau luồng B: cùng manifest → so khung hình (giống hệt).
- E2E bằng Playwright (Chromium có sẵn) trên một project mẫu: mở editor, phát,
  kéo/trim/tách/xóa/hoàn tác, sửa inspector, lưu, tải lại trang thấy giữ nguyên,
  xung đột version, khóa khi AI chạy, render draft qua queue và kiểm file ra.
- Review đối kháng từng luồng trước khi gộp.
