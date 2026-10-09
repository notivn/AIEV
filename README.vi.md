# AIEV - AI Edit Video by [noti.vn](https://noti.vn)

[![CI](https://github.com/notivn/AIEV/actions/workflows/ci.yml/badge.svg)](https://github.com/notivn/AIEV/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)

[🇬🇧 English](README.md) · 🇻🇳 Tiếng Việt

> **Edit video tự động bằng AI.** Claude đóng vai đạo diễn - điều khiển **HyperFrames** (dựng scene motion-graphics bằng HTML + GSAP) và **Remotion** (lắp ráp timeline) - bạn giám sát mọi thứ qua web dashboard tại `http://localhost:6868`.

Đưa clip vào, mô tả ngắn gọn bạn muốn gì, bấm **"Bắt đầu edit bằng AI"** - hệ thống tự transcribe, viết kịch bản dựng, tạo scene chữ động, phụ đề karaoke, zoom nhấn nhịp, sound effect theo timestamp, lắp ráp và xuất MP4.

## Tính năng

| | |
|---|---|
| 🎬 **Edit video bằng AI** | Claude tự phân tích source → dựng scene HyperFrames → lắp ráp Remotion → MP4. Draft trước, final sau, verify từng frame. |
| 🎞️ **Trình chỉnh sửa video** | Xem trước bản dựng ngay trong trình duyệt (chạy đúng composition Remotion, không cần render) và sửa trên timeline: đổi thứ tự/cắt/tách scene, sửa chữ karaoke, phụ đề, thẻ highlight, sound effect, nhạc nền - hoặc nhờ AI trong khung chat bên cạnh. Mọi thay đổi được lưu vào project và vào lần render kế tiếp; lịch sử phiên bản cho phép quay lại, kể cả trước lần AI sửa gần nhất. |
| 🎨 **Style Design** | Nhiều bộ nhận diện (màu, font, logo, tone, hiệu ứng gradient/liquid glass) - sản phẩm tuân thủ 100% style đã chọn. Font chỉ cần gõ tên, tự tải từ Google Fonts (đủ dấu tiếng Việt). |
| 🖼️ **Tạo ảnh AI** | Gemini vẽ nền (không chữ) → Remotion đặt tiêu đề/logo/số liệu theo Style Design - chữ tiếng Việt không bao giờ sai chính tả. |
| ✨ **Ảnh minh họa trong video** | Claude chọn ý chính, Gemini vẽ minh họa đồng bộ style rồi ghép đúng thời điểm (~$0.05/ảnh). |
| 🔑 **Bố cục Key** | Key chính hiện vùng trên video, key liên quan hiện vùng dưới theo nội dung đang nói - AI tự đề xuất hoặc bạn chỉ định. |
| 📝 **Phụ đề karaoke tiếng Việt** | faster-whisper (ưu tiên GPU) word-timestamp, highlight keyword, các fix mất dấu đã kiểm chứng. |
| 🎨 **Chỉnh màu có preview** | 14 preset + chỉnh tay, xem trước từng frame; footage log/HDR tự tonemap. |
| 🔊 **Sound effects** | Thư viện 100+ file kèm bộ đề xuất - AI chèn theo nhịp nội dung, khớp mốc zoom. |
| 🧠 **Skills** | Know-how sản xuất tích lũy dạng markdown, quản lý trên web UI; có cả **tạo skill mới bằng AI** từ form câu hỏi. |
| 🩺 **Kiểm tra & tự cài môi trường** | Một lệnh dò đủ FFmpeg, Chrome, xác thực Claude, faster-whisper, khóa Gemini; thiếu gì cài giúp nấy. Chạy sẵn lúc khởi động, và có nút cài một chạm ngay trong tab Cấu hình. Xem [Kiểm tra môi trường](#kiểm-tra-môi-trường). |
| ⚡ **Tăng tốc phần cứng** | Tự phát hiện GPU (NVENC trên NVIDIA, VideoToolbox trên macOS), render song song, `--gl angle`. Xem [Khi nào dùng CPU, khi nào dùng GPU](#khi-nào-dùng-cpu-khi-nào-dùng-gpu). |
| 📊 **Dashboard** | Tiến trình realtime (SSE), render queue, token AI theo ngày/loại project (in/out), phiên AI tự chạy tiếp khi gián đoạn. |

## Kiến trúc

```
┌─────────────────────────────────────────────────────┐
│  Web UI (Next.js, port 6868)                        │
│  Dashboard · Videos/Images Project · Style Design   │
│  Render Queue · Sound Effects · Skills · Cấu hình   │
└──────────────────────┬──────────────────────────────┘
                       │ REST + SSE
┌──────────────────────┴──────────────────────────────┐
│  Backend (Express, port 6869)                       │
│  Claude Agent SDK · Render queue · SQLite           │
└──────┬──────────────────────────────┬───────────────┘
┌──────┴───────────┐        ┌─────────┴────────────┐
│ HyperFrames      │  MP4   │ Remotion             │
│ SCENE ENGINE     │───────▶│ ASSEMBLER            │
│ HTML + GSAP      │        │ scene + audio + sub  │
└──────────────────┘        └──────────────────────┘
```

Hợp đồng API đầy đủ: [`docs/API.md`](docs/API.md). Quy trình sản xuất + know-how: [`.claude/skills/`](.claude/skills/).

## Khi nào dùng CPU, khi nào dùng GPU

Làm xong một video phải đi qua nhiều bước, mỗi bước chọn bộ xử lý khác nhau. Mặc định
được chọn theo nguyên tắc **bản draft ưu tiên nhanh, bản final ưu tiên chất lượng**, và
mọi công tắc đều đổi được trong tab **Cấu hình**.

| Bước | Chạy bằng | Công tắc |
|---|---|---|
| Dựng hình scene HyperFrames (Chrome ẩn) | **GPU** mặc định, tắt đi thì CPU | `GPU cho capture (browser)` -> `--browser-gpu` |
| Encode scene bản **draft** | **GPU** mặc định (NVENC / VideoToolbox) | `Encode GPU cho bản draft` -> `--gpu` |
| Encode scene bản **final** | **CPU** mặc định (libx264) | `Encode GPU cho bản FINAL`, mặc định TẮT |
| Dựng hình timeline Remotion | **GPU** mặc định, tắt đi thì CPU | `GPU cho capture (browser)` -> `--gl angle` (Linux: `angle-egl`) |
| Encode video lắp ráp (cả draft lẫn final) | **Luôn CPU** (libx264) | không chỉnh được; draft thêm `--crf 28 --x264-preset veryfast` |
| Auto cut: cắt + đổi khung từng đoạn | **GPU** chỉ khi bật `Encode GPU cho bản FINAL` **và** máy có NVENC, còn lại CPU | `Encode GPU cho bản FINAL` |
| Tạo lời thoại (faster-whisper large-v3) | **GPU** (CUDA, float16), lỗi thì rơi về **CPU** (int8) | tự động, không có công tắc |
| QC tự động | **CPU** (ffmpeg chỉ đo, không encode) | - |
| Thumbnail (`remotion still`) | **GPU** mặc định, chung công tắc với capture | `GPU cho capture (browser)` |
| Ảnh Gemini, dò chủ thể, Claude edit | **Không dùng máy** - chạy trên server nhà cung cấp | - |

Ba điều đáng lưu ý:

- **Encode bản final cố ý để CPU.** NVENC nhanh hơn nhiều nhưng cùng dung lượng file thì
  libx264 cho hình nhỉnh hơn. Bản draft không cần chất lượng nên mặc định encode bằng
  GPU, bản final mặc định bằng CPU. Muốn đổi nhanh lấy chất lượng thì bật
  `Encode GPU cho bản FINAL`.
- **Phần encode của Remotion không bao giờ dùng GPU ở đây**, chỉ khâu dựng hình mới dùng.
  Không truyền `--gl angle` thì Remotion rơi về SwANGLE - dựng hình bằng phần mềm trên
  CPU thuần, chậm thấy rõ.
- **NVENC nhận diện qua `nvidia-smi`.** Nếu lỗi, hoặc GPU hết session encode, hoặc từ chối
  kích thước khung, job tự chạy lại bằng libx264 chứ không fail. Trên macOS thì khâu đổi
  khung của Auto cut hiện luôn dùng libx264, vì phép dò đó chỉ tìm NVIDIA; HyperFrames
  trên máy đó vẫn dùng VideoToolbox bình thường.

Chạy song song là chuyện riêng: `Job render đồng thời (queue)` (mặc định 2) quyết định mấy job
chạy cùng lúc, `Worker Chrome (HyperFrames)` là số luồng của HyperFrames, `Remotion concurrency` là số
frame Remotion dựng song song. Hai job của **cùng một project** không bao giờ chạy đồng thời.

## Yêu cầu

- **Node.js 22+** (HyperFrames yêu cầu `>=22`)
- **FFmpeg** trên PATH (macOS: `brew install ffmpeg`)
- **Google Chrome** (HyperFrames và Remotion render qua headless Chromium)
- **Claude**: đăng nhập [Claude Code](https://claude.com/claude-code) trên máy (dùng subscription OAuth - khuyên dùng) *hoặc* điền `ANTHROPIC_API_KEY` vào `.env`
- **Gemini** (chỉ cần cho tạo ảnh): `GEMINI_API_KEY` trong `.env` - lấy tại [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- Tùy chọn: GPU NVIDIA (NVENC) hoặc Mac Apple Silicon (VideoToolbox) để render nhanh hơn; Python + `faster-whisper` cho phụ đề

Không phải tự cài tay từng thứ. Script khởi động kiểm tra hết danh sách trên và cài giúp những thứ
cài được - xem [Kiểm tra môi trường](#kiểm-tra-môi-trường) bên dưới.

## Chạy

```bash
git clone https://github.com/notivn/AIEV.git
cd AIEV
```

**Windows** - nhấp đúp `start\start.bat` (hoặc chạy `start\start.ps1`).

**macOS** - nhấp đúp `start/start.command` trong Finder. File `.sh` KHÔNG nhấp đúp được trên macOS, nó chỉ mở bằng trình soạn thảo. Lần đầu macOS chặn "unidentified developer" thì chuột phải vào file → **Open** → **Open**.

**Linux** - chạy `./start/start.sh`.

Tải bản ZIP (thay vì `git clone`) thì lần đầu cấp quyền chạy cho script:

```bash
chmod +x start/*.sh start/*.command update/*.sh update/*.command
```

| Việc | Windows | macOS | Linux |
|---|---|---|---|
| Chạy hệ thống | `start\start.bat` | `start/start.command` | `./start/start.sh` |
| Dừng hệ thống | `start\stop.bat` | `start/stop.command` | `./start/stop.sh` |
| Cập nhật thủ công | `update\update.bat` | `update/update.command` | `bash update/update.sh` |
| Mở tunnel (upload từ điện thoại) | `start\tunnel.bat` | `start/tunnel.command` | `./start/tunnel.sh` |

Script tự lo mọi thứ: kiểm tra môi trường → `npm install` (lần đầu) → build → tạo `.env` → chạy server + web → mở `http://localhost:6868`. Bình thường không cần chạy script cập nhật bằng tay, bấm nút cập nhật trên dashboard là xong.

Chạy dev thủ công: `npm install` rồi `npm run dev`.

## Hướng dẫn sử dụng

### Video đầu tiên (Videos Project)

1. **Tạo project** - vào **Videos Project** → **Tạo project**: đặt tên, chọn khung hình (9:16 dọc cho TikTok/Reels, 16:9 ngang cho YouTube) và fps.
2. **Đưa nguồn vào** - trong card **Nguồn & Asset** upload clip, hoặc bấm **Kết nối điện thoại** rồi quét QR để gửi file thẳng từ điện thoại.
3. **Điền Kịch bản edit** - card này là tờ chỉ đạo cho AI:
   - **Mô tả nguồn** - một hai câu clip nói về gì.
   - **Tự động cắt ngắn** - cắt khoảng lặng, từ đệm, đoạn quay lại trước khi dựng.
   - **Phụ đề karaoke** kèm **highlight keyword**.
   - **Bố cục Key** - key chính nằm band trên video, key liên quan nằm band dưới, chạy theo nội dung đang nói.
   - **Ảnh minh họa AI (Gemini)** - ảnh đồng bộ style ghép vào video. Chọn model vẽ, **mật độ ảnh** (bao nhiêu ảnh mỗi phút video; bỏ trống thì AI tự quyết), **vị trí chủ thể** (lưới 3x3 như bộ chọn vị trí logo) và có cho Gemini vẽ chữ vào ảnh hay không.
   - **Sound effects** và **nhạc nền** - dùng bộ đề xuất hoặc cả thư viện; nhạc tự nhỏ xuống khi có thoại.
   - **Style Design** - bộ nhận diện thương hiệu (màu, font, logo) cưỡng chế 100% lên mọi sản phẩm; **Phong cách dựng** - ngôn ngữ thị giác của riêng video này (giấy gấp, mực tàu, người que...), bỏ trống thì AI tự quyết.
   - **Skill** - format dựng muốn theo (TikTok kiểu Noti, YouTube ngang...).
   - **Ghi chú** - yêu cầu tự do; có thể đổ từ prompt mẫu ở trang **Prompts**.
4. **Bắt đầu edit bằng AI** - Claude transcribe clip, lên kế hoạch dựng, tạo scene HyperFrames, sinh ảnh minh họa, đi sound effect rồi lắp thành bản **draft**. Tiến trình chạy realtime ngay trên trang project; mọi render đều qua **Render queue**.
5. **Duyệt và hoàn thiện** - xem draft ngay trên trang project, góp ý qua khung chat duyệt ("phóng to hook lên", "cắt bớt intro"...), rồi chạy **QC** và **render final**. File MP4 nằm trong `outputs/`, kèm thumbnail tự tạo và bộ publish (tiêu đề, mô tả, hashtag).

### Trình chỉnh sửa video

Mở một project rồi bấm **Mở trình chỉnh sửa** (có khi project đã có scene).

- **Xem trước** - trình phát chạy đúng composition mà bước render dùng, nên thấy gì thì render ra nấy (footage phát bằng video của trình duyệt nên không chính xác từng frame; bản render mới là chuẩn). Scene HyperFrames hiện bản render draft/final mới nhất.
- **Timeline** - các track video, thẻ highlight, karaoke, phụ đề, sound effect, giọng đọc, nhạc nền. Kéo để dời, kéo mép để cắt, `S` tách tại playhead, `Delete` xóa, `Ctrl/Cmd+Z` hoàn tác. Bấm `?` để xem mọi phím tắt.
- **Inspector** - sửa phần tử đang chọn: điểm vào/ra, chuyển cảnh, zoom nhấn, từng chữ karaoke và từ nhấn, chữ phụ đề, nội dung/cấp/màu nhấn của highlight, âm lượng.
- **Thư viện** - kéo footage/ảnh của project vào track video, sound effect và nhạc từ thư viện chung vào track tương ứng.
- **Chat AI** - khung bên phải sửa cùng timeline đó ("dời phụ đề thứ hai sớm 0,5 giây"); trình phát cập nhật ngay khi AI ghi. Trình chỉnh sửa khóa ở chế độ chỉ xem trong lúc AI làm.
- **Lưu & render** - mọi thay đổi tự lưu; nếu trong lúc đó project bị sửa ở nơi khác (hoặc bởi AI), bạn chọn giữ bản nào. **Render draft / final** đi qua render queue như thường. **Lịch sử** khôi phục phiên bản cũ; **Xuất XML** mở timeline trong Premiere Pro hoặc DaVinci Resolve.

### Text to video (bài viết → video)

**Text to video** → **Tạo phiên**: dán URL hoặc văn bản (tên phiên bỏ trống cũng được - hệ thống lấy theo tiêu đề bài). Pipeline chạy theo từng bước, bước nào cũng duyệt lại được: **Trích bài** → **Kịch bản** - AI viết lại thành văn nói chia đoạn (đặt thời lượng mục tiêu theo giây, sửa tay từng đoạn) → **Giọng đọc** - chọn engine (**Gemini TTS** online hoặc **VieNeu-TTS** chạy trên máy, gồm cả giọng nhân bản của bạn), giọng và tốc độ đọc, nghe thử từng đoạn → **Build** - hệ thống dựng giọng đọc, tạo video project rồi AI tự edit theo Kịch bản edit đã cấu hình. Video bài viết dài nên đặt mật độ ảnh minh họa để đổi nền liên tục cho đỡ nhàm.

### Auto cut (video dài → nhiều video ngắn)

**Auto cut** → chọn video nói chuyện dài → chọn chế độ: theo **thời gian**, theo **AI** (tự tìm highlight) hoặc theo **prompt**. **Lên kế hoạch** đề xuất các đoạn kèm tiêu đề - tick chọn và sửa thoải mái - rồi **Cắt** tạo mỗi đoạn một project con, tất cả dùng chung Kịch bản edit cấu hình một lần (khung hình, layout, nền, style). Từng project con sau đó edit bằng AI như project thường.

### Images Project (poster & thumbnail)

**Images Project** → tạo ảnh mới: mô tả cảnh, chọn loại, tỉ lệ khung, model. Gemini chỉ vẽ nền (tuyệt đối không chữ), Remotion đặt tiêu đề, mô tả, số liệu, CTA và logo lên trên theo Style Design - nên chữ tiếng Việt không bao giờ sai chính tả. Chọn vị trí khối chữ bằng lưới 3x3, sửa và render lại tùy thích.

### Style Design & Phong cách dựng

**Style Design** chứa các bộ nhận diện thương hiệu: màu, font (gõ tên font Google Fonts là tự tải về, đủ dấu tiếng Việt), logo, tone và hiệu ứng. Style đã chọn cưỡng chế lên mọi sản phẩm; style có logo thì khâu lắp ráp tự đóng logo góc trên trái mọi video - đừng tự thêm logo nữa. **Phong cách dựng** (chọn trong Kịch bản edit) là ngôn ngữ thị giác của riêng một video: chất liệu và chuyển động.

### Giọng đọc (Voices)

Trang **Voices** quản lý giọng thuyết minh: 30 giọng Gemini dựng sẵn (online, tính tiền theo lượt) và **VieNeu-TTS** (chạy trên máy, miễn phí, tiếng Việt có phân vùng miền) - engine duy nhất **nhân bản được giọng của bạn** từ một đoạn ghi âm hoặc video điện thoại. Nghe thử giọng và tốc độ đọc trước khi dùng trong Text to video.

### Sound effects & nhạc nền

**Sound Effects** là thư viện: 100+ file có tag kèm bộ "đề xuất" AI ưu tiên dùng; upload và gắn tag thêm thoải mái. Nhạc nền nằm trong `assets/music/` và **repo cố ý không kèm sẵn bài nào** - bạn tự thêm nhạc của mình (trang Sound Effects → tab Nhạc nền → tải lên), AI sẽ chọn bài theo mood và tự hạ âm lượng khi có thoại. Xem [`assets/music/README.md`](assets/music/README.md).

### Render queue & Cấu hình

Mọi render đều qua queue: draft phải xong trước final, và **QC** tự động (vùng an toàn, âm lượng, frame đen, dấu tiếng Việt) chặn cửa final - bật tắt được trong **Cấu hình**. Tab Cấu hình cũng chứa các công tắc GPU, số worker và số job đồng thời; tab **Kết nối** quản lý xác thực Claude / Gemini / OpenAI.

### Skills & Prompts

**Skills** là know-how sản xuất AI làm theo - xem, sửa, nhân bản hoặc tạo mới (kể cả tạo skill bằng AI từ form câu hỏi) ngay trên web UI. **Prompts** chứa các prompt mẫu tái sử dụng cho ô Ghi chú của Kịch bản edit.

## Kiểm tra môi trường

`start/doctor.mjs` dò đủ những thứ pipeline cần - Node.js, FFmpeg, Google Chrome, xác thực Claude,
faster-whisper, khóa Gemini, cloudflared, GPU - và cài giúp phần cài được:

| | |
|---|---|
| **Cài giúp bạn** (hỏi `[Y/n]` trước) | FFmpeg, Google Chrome, Claude Code, faster-whisper, cloudflared - qua `winget` trên Windows, `brew` trên macOS, `npm`/`pip` cho phần còn lại |
| **Bạn tự làm, hệ thống chỉ đúng việc cần làm** | cài Node.js, đăng nhập Claude (`claude` → `/login`), dán khóa Gemini |

Nó chạy sẵn trong `start.bat` / `start.command`, và đúng danh sách đó hiện thành card
**Kiểm tra hệ thống** trong tab **Cấu hình** - mỗi mục thiếu có nút cài một chạm (hoặc lệnh chép
một phát nếu không tự cài được). Thiếu đồ **không chặn khởi động**: dashboard vẫn lên để bạn sửa
ngay trên giao diện.

```bash
node start/doctor.mjs              # chỉ xem
node start/doctor.mjs --fix        # thiếu gì hỏi cài nấy
node start/doctor.mjs --fix --yes  # cài luôn, không hỏi
node start/doctor.mjs --lang en    # in tiếng Anh
```

Một file duy nhất phục vụ cả terminal, hai script khởi động lẫn web UI - thêm mục kiểm tra mới thì
sửa đúng một chỗ.

## Upload từ điện thoại

Trong trang project, ở card **Nguồn & Asset** bấm **Kết nối điện thoại** - quét mã QR bằng camera điện thoại (cùng WiFi với máy chạy hệ thống) để mở trang upload `http://<ip-máy>:6868/m/<project>`. Video/ảnh chọn trên điện thoại sẽ tải thẳng vào asset của project. Lần đầu Windows hỏi firewall thì chọn **Allow** (script start đã tự thêm rule nếu có quyền admin).

**Dùng từ xa qua 4G/5G** (không cùng WiFi):
- **Cloudflare Tunnel** - điền `TUNNEL_DOMAIN=<domain-của-bạn>` (vd `aiev.noti.vn`) vào `.env`, QR trong modal Kết nối điện thoại sẽ tự dùng `https://<domain>/m/<project>` - chạy được qua 4G/5G.
- Bật tunnel bằng `start\tunnel.bat` (Windows) / `./start/tunnel.sh` (macOS) - chưa điền `TUNNEL_DOMAIN` thì script tự chạy quick tunnel với URL ngẫu nhiên `trycloudflare.com`.
- ⚠️ **Cảnh báo**: dashboard chưa có đăng nhập - chỉ mở public khi đã bọc Cloudflare Access, hoặc tuyệt đối không chia sẻ link.

## Cấu trúc thư mục

```
├── apps/web/          # Next.js dashboard (port 6868)
├── apps/server/       # Express backend: Agent SDK + render queue + SQLite (port 6869)
├── engines/remotion/  # Remotion: composition Assemble (video) + Poster (ảnh)
├── .claude/skills/    # Skills - know-how sản xuất, quản lý được từ web UI
├── assets/
│   ├── sound-effects/ # Thư viện sound effect + library.json
│   ├── styles/        # Style Design (styles.json + font/logo)
│   └── prompts/       # Prompt mẫu
├── video-projects/    # Mỗi video một folder (không commit)
├── image-projects/    # Project tạo ảnh (không commit)
├── outputs/           # Video final (không commit)
├── start/             # Script khởi động Win (.bat/.ps1) + macOS/Linux (.sh)
└── docs/API.md        # Hợp đồng API - nguồn sự thật duy nhất
```

## Tech stack

Next.js 16 · React 19 · Tailwind 4 · Express 5 · better-sqlite3 · [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk) · [HyperFrames](https://www.npmjs.com/package/hyperframes) · [Remotion](https://remotion.dev) · Gemini API · faster-whisper · FFmpeg

## Đóng góp

Rất hoan nghênh báo lỗi, bản vá và skill mới. Đọc [CONTRIBUTING.vi.md](CONTRIBUTING.vi.md) trước - trong đó có cách chạy dự án, hai lệnh CI chạy trên mọi PR (`npm run typecheck` và `npm run build`), và các quy ước của codebase này. Việc lớn hơn một sửa nhỏ thì mở issue trước khi bắt tay làm.

Phát hiện lỗ hổng bảo mật? Đừng mở issue công khai, làm theo [SECURITY.md](SECURITY.md).

## Giấy phép

[MIT](LICENSE) - tự do dùng, sửa và phân phối, kể cả cho mục đích thương mại.

> Lưu ý về phụ thuộc: dự án này cấp phép MIT, nhưng các công cụ đi kèm giữ giấy phép riêng.
> Remotion miễn phí cho cá nhân và công ty tối đa 3 người; vượt mức đó cần
> [Company License](https://remotion.pro) - và trình chỉnh sửa video có nhúng Remotion Player, phần mà
> Remotion cấp phép theo gói "Automators" cho các công ty đó. Chi phí Claude và Gemini tính vào tài khoản của bạn.
>
### Asset: repo ship code, không ship media

Giấy phép MIT ở trên áp cho **code**. Media thì mỗi thứ một giấy phép, nên repo cố ý không kèm sẵn:

| Thư mục | Repo có kèm? | Giấy phép |
|---|---|---|
| [`assets/sound-effects/`](assets/sound-effects/README.md) | Có, 86 file | **Sưu tầm nhiều nguồn, không rõ giấy phép - đừng dùng cho video thương mại** |
| [`assets/music/`](assets/music/README.md) | Không - ship rỗng | Của nguồn bạn lấy |
| [`assets/styles/`](assets/styles/README.md) | Không - ship rỗng | Style, font và logo là của bạn |
| [`assets/brand-logos/`](assets/brand-logos/README.md) | Có, 123 logo | **Nhãn hiệu của chủ thương hiệu**, KHÔNG thuộc MIT |
| Tên và logo **noti.vn** trên dashboard | Có | **Nhãn hiệu của noti.vn**, KHÔNG thuộc MIT |

**Sound effect đi kèm nhưng có điều kiện.** Bộ 86 file này là đồ sưu tầm nhiều năm từ nhiều nguồn, không ghi lại giấy phép của từng file. Nó có mặt để cài xong là dùng được ngay, nhưng **không dùng cho video thương mại** - không ai chứng minh được quyền với chúng. Làm thương mại thì thay dần bằng nguồn CC0 hoặc đã mua giấy phép, và ghi `source` + `license` cho từng file. Một số trích đoạn nhận ra ngay là của ai (jingle Netflix, nhạc Nintendo, SpongeBob…) thì không đi kèm repo, dù danh mục vẫn còn tên.

Nhạc nền thì ship rỗng hẳn: một bài nhạc dài vài phút rủi ro hơn một tiếng whoosh nửa giây rất nhiều.

Font cũng vậy, nhưng có sẵn lối đi: gõ tên font trong **Style Design** là hệ thống tự tải từ Google Fonts về máy bạn, không cần repo kèm file nào.

Style Design ship rỗng vì lý do khác: đó là nhận diện thương hiệu của riêng bạn. Repo mang sẵn style của người khác thì ai clone về cũng dựng video bằng màu của họ, và nếu style đó có logo thì video bị đóng dấu logo người khác. Lần đầu vào trang Style Design, tạo style của bạn - nó tự thành mặc định.

Fork dự án này thì nhớ thay logo và tên noti.vn bằng của bạn: thay PNG trong `apps/web/public/brand/` rồi chạy `node apps/web/scripts/build-brand.mjs`.

---

Made with ❤️ by **noti.vn** - Claude điều khiển, con người duyệt.
