# AI Edit Video by: noti.vn

> Edit video tự động bằng AI — Claude điều khiển **HyperFrames** (dựng scene motion-graphics) và **Remotion** (lắp ráp timeline), giám sát qua **web dashboard** chạy ở port **6868**.

## 1. Tổng quan kiến trúc

Hệ thống gồm 3 tầng, phân vai rõ ràng — **không trộn lẫn vai trò**:

```
┌─────────────────────────────────────────────────────┐
│  Web UI (Next.js, port 6868)                        │
│  Hiển thị, quản lý + trình chỉnh sửa (xem trước/sửa │
│  timeline) — KHÔNG mã hóa/xử lý video               │
│  Dashboard · Videos Project · Images Project ·      │
│  Style Design · Render Queue · Assets ·             │
│  Sound Effects · Prompts · Skills · Cấu hình ·      │
│  Kết nối                                            │
└──────────────────────┬──────────────────────────────┘
                       │ REST + SSE/WebSocket
┌──────────────────────┴──────────────────────────────┐
│  Backend (Node.js)                                  │
│  · Claude Agent SDK — chạy Claude Code headless,    │
│    tự nhận skills trong .claude/skills/             │
│  · Render queue — job tuần tự, progress, log        │
│  · SQLite — projects, jobs, assets metadata         │
└──────┬──────────────────────────────┬───────────────┘
       │                              │
┌──────┴───────────┐        ┌─────────┴────────────┐
│ HyperFrames      │        │ Remotion             │
│ SCENE ENGINE     │        │ ASSEMBLER            │
│ HTML + GSAP →    │───────▶│ Lắp scene + footage  │
│ render từng      │  MP4/  │ + audio + transition │
│ scene MP4        │ frames │ → video hoàn chỉnh   │
└──────────────────┘        └──────────────────────┘
```

**Nguyên tắc vàng:** HyperFrames làm gì giỏi thì để nó làm (kinetic typography, caption karaoke, motion graphics, shader). Remotion làm gì giỏi thì để nó làm (ghép sequence, transition giữa scene, mix audio/sound effect, xuất bản cuối). Claude là đạo diễn điều phối cả hai qua CLI + file — mọi thao tác đều là code chạy bên dưới.

**Trình chỉnh sửa** (`/projects/[id]/editor`, chi tiết ở `docs/EDITOR-PLAN.md`): người dùng xem trước bằng Remotion Player chạy đúng composition `Assemble` trong trình duyệt và sửa timeline (scene, karaoke, phụ đề, highlight, sfx, nhạc) bằng tay hoặc qua chat AI. Mọi thao tác ghi vào `meta.json` qua API có phiên bản (`/api/projects/:id/timeline`) - `meta.json` vẫn là nguồn sự thật duy nhất. Trình duyệt chỉ XEM TRƯỚC, không bao giờ mã hóa video: xuất bản vẫn đi qua render queue. Vì người dùng có thể sửa `meta.json` bất kỳ lúc nào, agent phải **đọc lại meta.json ngay trước khi sửa**, sửa đúng chỗ, giữ nguyên field lạ.

## 2. Cấu trúc thư mục

```
Edit-Video-AI/
├── CLAUDE.md                  ← file này
├── .claude/
│   ├── settings.json          ← permissions cho pipeline
│   └── skills/                ← 17+ skill — xem trang Skills trên web UI
├── apps/
│   ├── web/                   ← Next.js dashboard (port 6868)
│   └── server/                ← Backend: Agent SDK + render queue + SQLite
├── engines/
│   └── remotion/              ← Remotion project (composition lắp ráp)
├── video-projects/            ← mỗi video một folder (chuẩn HyperFrames)
│   └── <ten-video>/
│       ├── index.html         ← composition gốc HyperFrames
│       ├── compositions/      ← sub-scene
│       ├── assets/            ← footage, audio, transcript của video này
│       ├── renders/           ← scene render + draft (gitignore)
│       ├── hyperframes.json
│       ├── props.resolved.json← props đã stage cho Remotion (gitignore)
│       └── meta.json          ← id, tên, kích thước, fps, trạng thái
├── image-projects/            ← project tạo ảnh Gemini (gitignore)
├── assets/
│   ├── brand/                 ← logo, favicon, brand-tokens.css
│   ├── styles/                ← Style Design (styles.json + font files)
│   ├── video-styles/          ← Phong cách dựng (video-styles.json) — sửa được trên web UI
│   ├── prompts/               ← thư viện prompt mẫu
│   ├── sound-effects/         ← thư viện sound effect dùng chung (library.json)
│   ├── music/                 ← thư viện nhạc nền dùng chung (library.json, tag theo mood)
│   ├── brand-logos/           ← 116+ logo brand (Simple Icons, CC0) + library.json — tự lớn dần
│   └── voices/                ← giọng đã nhân bản (gitignore - là giọng thật của người dùng)
├── docs/                      ← tài liệu (API.md — contract backend)
├── start/                     ← script khởi động (start.ps1)
├── imports/                   ← file người dùng đưa vào (footage gốc…)
└── outputs/                   ← video final đã render, đặt tên <project>-<ver>.mp4
```

## 3. Ports & môi trường

| Thành phần | Port | Ghi chú |
|---|---|---|
| Web UI (Next.js) | **6868** | `http://localhost:6868` — cổng duy nhất người dùng cần nhớ |
| Backend API (Express) | 6869 | Nội bộ — web rewrites `/api/*`, `/media/*` sang đây. Contract: `docs/API.md` |
| HyperFrames Studio preview | 3002 | Nội bộ, mở khi cần soi scene |
| Remotion Studio | 3000 | Nội bộ, chỉ dùng khi debug composition lắp ráp |

- **Node 22+** (hyperframes yêu cầu `node >= 22`), **FFmpeg trên PATH**, **Chrome mới nhất** (HyperFrames và Remotion đều render qua headless Chromium).
- Xác thực Claude cho Chat/AI: tự dùng **subscription OAuth** của Claude Code đã đăng nhập trên máy (`~/.claude/.credentials.json`); hoặc `ANTHROPIC_API_KEY` trong `.env` nếu muốn dùng API key.
- Giọng đọc có **hai engine chạy song song**, người dùng chọn từng phiên:
  - **Gemini TTS** (mặc định) - cần `GEMINI_API_KEY`, 30 giọng dựng sẵn, tốn tiền theo lượt.
  - **VieNeu-TTS** (`pip install vieneu`, Apache 2.0) - chạy thẳng trên máy, miễn phí, không cần mạng, 14 giọng tiếng Việt có phân vùng miền, và là engine **duy nhất nhân bản được giọng**. Nhân bản cần thêm `pip install torch torchaudio`. Đọc chậm hơn, khoảng bằng thời gian thật.
- Máy Windows: mọi script phải chạy được trên PowerShell; đường dẫn trong code luôn dùng `path.join`, không hardcode `/` hay `\`.

## 4. Lệnh thường dùng

```bash
npm run dev          # chạy web UI + backend (port 6868)
npm run build        # build production

# HyperFrames (chạy trong video-projects/<ten-video>/)
npx hyperframes lint
npx hyperframes preview                                        # Studio :3002
npx hyperframes render --quality draft --output renders/draft.mp4
npx hyperframes render --quality standard --output renders/final.mp4

# Remotion (chạy trong engines/remotion/)
npx remotion render <composition-id> --props="<project>/props.resolved.json" --output ../../outputs/<ten>.mp4
```

## 5. Quy trình sản xuất video (tóm tắt — chi tiết ở skill `video-pipeline`)

```
nhận yêu cầu → tạo project folder → viết scene HyperFrames
→ lint → draft render từng scene → verify frame (ffmpeg trích ảnh, soi lỗi)
→ Remotion lắp scene + footage + sound effect → draft toàn bài
→ duyệt → final render → outputs/
```

Quy tắc bắt buộc:
1. **Không bao giờ final render khi chưa qua draft + verify frame.** Draft (CRF 28) nhanh, rẻ; final chậm — lỗi phát hiện ở final là lãng phí nhất.
2. **Mọi render đều đi qua render queue của backend** (kể cả khi Claude tự chạy) để web UI luôn thấy được trạng thái.
3. Video tiếng Việt: áp dụng các fix đã kiểm chứng trong skills (chữ gradient mất dấu, transcription tiếng Việt, PATH ffmpeg).
4. Xong final render thì cập nhật `meta.json` của project (trạng thái, đường dẫn output, thời lượng).
5. **Logo không bao giờ được sinh ra, chỉ được chèn từ file:**
   - Style Design có logo → hệ thống **tự đóng logo góc trên trái** cho cả video ở bước lắp ráp Remotion (`jobs/assemble.ts` → `manifest.watermark`). AI không phải làm gì, và **không được** tự thêm logo góc nữa (thành hai logo chồng nhau). Không muốn đóng logo thì dùng Style Design không có logo.
   - Logo brand khác (Meta, TikTok, Claude…): kịch bản nhắc brand nào thì lấy file trong `assets/brand-logos/`, chép vào `assets/` của project rồi mới tham chiếu (Remotion chỉ stage file nằm trong project).
   - **Chưa có trong thư viện thì TỰ TẢI**: `POST /api/brand-logos {"name":"OpenAI"}` — server tìm ở Simple Icons rồi Wikidata (thuộc tính P154 "logo image"), tải về `assets/brand-logos/` và trả `relPath`. Thư viện tự lớn dần theo từng video.
   - Chỉ khi trả `404 BRAND_LOGO_NOT_FOUND` mới được bỏ logo: viết tên brand bằng chữ và ghi vào báo cáo. **Không bao giờ tự vẽ/tự chế logo.**
   - Bổ sung hàng loạt: `node scripts/fetch-brand-logos.mjs <slug>…`, hoặc bỏ thẳng file SVG vào thư mục.
6. **Hai lớp "style" chồng lên nhau, đừng gộp:**
   - **Style Design** (`brief.styleId`, `assets/styles/`) = nhận diện thương hiệu: MÀU, FONT, logo. Luôn cưỡng chế 100%.
   - **Phong cách dựng** (công tắc `brief.videoStyleEnabled` + `brief.videoStyleId`, dữ liệu ở `assets/video-styles/video-styles.json`, quản lý ở tab **Phong cách dựng**) = ngôn ngữ thị giác của riêng video: CHẤT LIỆU và CHUYỂN ĐỘNG (giấy gấp, mực tàu, người que…). 20 phong cách dựng sẵn, thêm/sửa/xóa được. **Công tắc TẮT (mặc định) = dựng theo đúng cấu hình đã chọn (skill + Style Design), `videoStyleId` bị bỏ qua hoàn toàn** — code phải đọc qua `activeVideoStyleId(brief)`, không đọc thẳng `brief.videoStyleId`. Mảng trong `apps/server/src/videoStyles.ts` chỉ còn là HẠT GIỐNG để seed lần đầu và để `POST /:id/reset` khôi phục bản gốc, không còn là nguồn sự thật.
   - Phong cách dựng **thay thế** chỉ đạo mỹ thuật mặc định trong prompt ảnh, không cộng thêm — cộng vào là ra thứ nửa nọ nửa kia. Vài phong cách có `palette: "loose"` (mực tàu, Đông Hồ, ảnh thật): ảnh theo bảng màu ruột của phong cách, màu brand tụt xuống làm điểm nhấn, còn chữ/đồ họa vẫn theo Style Design.
   - **Thứ tự ưu tiên khi có phong cách dựng** (đã từng sai và làm tính năng vô tác dụng): phong cách quyết định CHẤT LIỆU + CHUYỂN ĐỘNG và **thắng skill** ở phần hình ảnh; skill chỉ còn giữ QUY TRÌNH (thứ tự bước, cắt, key/phụ đề, draft→final, QC); Style Design vẫn giữ MÀU + FONT, nhưng phần Tone/Guidelines nào tả một ngôn ngữ hình ảnh khác thì bỏ. Bất kỳ câu nào trong prompt trao "animation/layout/nhịp" cho skill một cách vô điều kiện đều phá tính năng này.
7. **Công tắc trong brief là công tắc THẬT — tắt phải nói ra, và phải chặn ở server:**
   - Prompt edit phải in **cả hai chiều BẬT/TẮT** của mọi công tắc. Im lặng khi tắt không phải là "trung lập": agent đi đọc skill và làm theo skill, tức là làm đúng cái vừa bị tắt. Đã gặp thật với "Ảnh minh họa AI": prompt không nhắc gì khi tắt → video vẫn đầy ảnh Gemini.
   - Prompt chỉ là lời khuyên, một SKILL.md dài hàng nghìn chữ vẫn lấn át được. Công tắc nào có endpoint tương ứng thì endpoint đó phải **từ chối** khi công tắc tắt: `POST /api/illustrations` trả `409 ILLUSTRATIONS_DISABLED` khi `brief.autoIllustrations = false`.
   - Ghi chú do job tự sinh (vd `briefNotesOf` của Text to video) **không được mâu thuẫn với brief nó đang bàn giao** — brief tắt ảnh mà ghi chú bảo "lấy hình từ /api/illustrations" là tự phá công tắc của chính mình.

## 6. Web UI — quy tắc thiết kế (chi tiết ở skill `webui-design`)

Web UI là **dashboard giám sát**; ngoại lệ duy nhất là **trình chỉnh sửa video** ở `/projects/[id]/editor` (xem mục 1). Tối giản kiểu Shopify Admin: đầy đủ tính năng, gọn gàng, không màu mè - kể cả trong trình chỉnh sửa.

**Thang chữ - ba bậc, không có bậc thứ tư** (luật quan trọng nhất, cưỡng chế bằng `node apps/web/scripts/check-design-system.mjs`):

| Class | Cỡ | Dùng cho |
|---|---|---|
| `text-sm` | 14px | **Nội dung** - mặc định. Mô tả, giá trị, nhãn ô nhập, tên mục, câu thông báo. |
| `text-meta` | 13px | **Phụ chú** - mốc thời gian, id, số đếm, gợi ý dưới ô nhập, đường dẫn. |
| `text-xs` | 12px | **Chi tiết khung** - chỉ trong badge/chip, `<th>`, nhãn cột in hoa. |

Cấm `text-[10px]`, `text-[11px]`, `text-[13px]`, `text-[15px]`, `text-base`, `text-lg`. Cần 13px thì dùng `text-meta`. Mọi thành phần lặp lại (nút icon, hộp lồng, nhãn+ô nhập, badge, banner, trạng thái chờ, toolbar danh sách) đều đã có primitive trong `apps/web/src/components/` - **không được dựng lại bằng Tailwind thô**, danh sách đầy đủ ở skill `webui-design`.

- Font: **Inter** qua gói `@fontsource/inter` (import trong `layout.tsx`, đóng gói lúc build nên vẫn self-host, tuyệt đối không gọi CDN lúc chạy).
- Icon: **100% SVG inline** (khuyến nghị bộ Lucide, stroke 1.5–2px). Tuyệt đối không icon font, không PNG icon, không emoji làm icon.
- Sáng/tối chuyển được, **mặc định sáng**. Mọi màu khai báo bằng CSS custom properties — không hardcode hex trong component.
- Metadata: title `AI Edit Video by: noti.vn`, description `Edit video tự động bằng AI`.

### Design tokens (nguồn sự thật duy nhất)

| Token | Light | Vai trò |
|---|---|---|
| `--primary` | `#ed3c47` | Màu chính, nút primary |
| `--primary-hover` | `#d62e3a` | Hover/active của primary |
| `--primary-soft` | `#fdedef` | Nền nhạt màu chính (badge, highlight) |
| `--secondary` | `#ff7849` | Màu phụ, accent |
| `--bg` | `#ffffff` | Nền trang |
| `--bg-subtle` | `#f6f6f7` | Nền phụ (sidebar, khu vực lồng nhau) |
| `--surface` | `#ffffff` | Card / bề mặt |
| `--text` | `#101113` | Chữ chính |
| `--text-muted` | `#5f6470` | Chữ mờ, phụ đề, label |
| `--border` | `#e7e7ea` | Viền, divider |
| `--success` | `#16a34a` | Thành công |
| `--success-bg` | `#e7f6ec` | Nền thành công |
| `--danger` | `#e8590c` | Cảnh báo / lỗi |
| `--danger-bg` | `#fbeee5` | Nền cảnh báo |

Bảng dark tương ứng nằm trong skill `webui-design` — chỉ đổi giá trị token, không đổi tên token.

### Brand assets

| Asset | URL nguồn | Dùng khi |
|---|---|---|
| Logo dương bản | https://noti.vn/image/new/logo-duong-ban.png | Nền sáng (theme light) |
| Logo âm bản | https://noti.vn/image/new/logo-am-ban.png | Nền tối (theme dark) |
| Favicon | https://noti.vn/image/new/favicon.png | `<link rel="icon">` |

Tải về `apps/web/public/brand/` khi scaffold web UI — không hotlink lúc runtime.

## 7. Quản lý skills

- Skill = một folder trong `.claude/skills/<ten-skill>/` chứa `SKILL.md` (frontmatter `name` + `description`, thân là hướng dẫn). Không cần build hay restart — Claude nhận ở phiên kế tiếp.
- Web UI có trang Skills: liệt kê / xem / sửa / tạo mới / nhân bản — bản chất là CRUD file markdown qua backend.
- **Tạo skill mới đúng chuẩn: đọc skill `skill-authoring` trước.**
- Mỗi lần fix được một lỗi sản xuất (font, render, audio…), ghi bài học vào skill liên quan ngay — skills là nơi tích lũy know-how, không để kinh nghiệm chết trong chat.

## 8. Quy ước code

- TypeScript cho toàn bộ `apps/`; JavaScript thuần + GSAP cho composition HyperFrames (đúng chuẩn framework — không React trong scene).
- Tên project video: kebab-case (`tiktok-paper-gpt5`, `promo-noti-t8`).
- Backend là nguồn sự thật về trạng thái job; web UI không tự suy diễn trạng thái.
- Ngôn ngữ: commit message **tiếng Anh**, ngắn gọn. Toàn bộ `.claude/skills/` viết **tiếng Anh** (chuỗi ví dụ đặc thù tiếng Việt như chữ có dấu minh họa lỗi font, filler "ừm/à/kiểu" thì giữ nguyên tiếng Việt vì dịch đi là mất ý nghĩa minh họa). Nội dung video, web UI và tài liệu cho người dùng vẫn **tiếng Việt**.
- Không commit: `renders/`, `outputs/`, `imports/`, `image-projects/`, `props.resolved.json`, `node_modules/`, `.env`.

## 9. Phát hành (Release)

Người dùng cài từ GitHub, và tính năng cập nhật trong app mặc định chạy ở kênh `stable` — tức là **chỉ nhận bản đã được tag thành Release** (`v*`). Không tạo release thì người dùng không bao giờ thấy code mới.

Quy trình:

1. Chỉ tag commit đã **kiểm chứng thật**: `npm run typecheck` + `npm run build` sạch, CI trên GitHub xanh, và nếu đụng vào pipeline thì đã dựng thử một video draft và xem bằng mắt.
2. Tạo release ghim đúng commit đó. Truyền **SHA đầy đủ** cho `--target`, hash rút gọn bị GitHub trả `422 target_commitish is invalid`.
3. Nội dung tiếng Việt phải đi qua `--notes-file`, đừng gõ thẳng vào dòng lệnh — Git Bash trên Windows làm mất dấu (xem skill `video-pipeline`).
4. **BẮT BUỘC: mọi release đều phải kèm hướng dẫn chạy.** Nối nguyên văn `.github/release-notes-footer.md` vào cuối phần notes. Đó là nguồn sự thật duy nhất về các file khởi động cho từng hệ điều hành (Windows `.bat`, macOS `.command`, Linux `.sh`) — sửa cách chạy thì sửa file đó, đừng chép tay mỗi nơi một kiểu.

```bash
cat notes.md .github/release-notes-footer.md > /tmp/full-notes.md
gh release create v1.0.2 --title "v1.0.2" --target <sha-đầy-đủ> --notes-file /tmp/full-notes.md
```

Đánh số theo `MAJOR.MINOR.PATCH`. Lỡ tag nhầm commit thì đừng dời tag cũ (người khác có thể đã kéo về), phát hành bản vá mới.
