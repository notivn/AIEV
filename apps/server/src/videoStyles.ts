import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { ensureDir, nowIso } from "./util.js";

/**
 * Phong cách dựng video - "video này TRÔNG như thế nào".
 *
 * KHÁC HẲN Style Design: Style Design là bộ NHẬN DIỆN THƯƠNG HIỆU (màu, font,
 * logo) và luôn được cưỡng chế. Phong cách dựng là NGÔN NGỮ THỊ GIÁC của riêng
 * video đó: giấy gấp, tranh mực tàu, người que... Hai thứ chồng lên nhau -
 * cùng một bộ màu thương hiệu vẫn dựng được video giấy gấp hay video pixel art.
 *
 * VÌ SAO PHẢI THAY THẾ CHỨ KHÔNG CỘNG THÊM: prompt ảnh mặc định trong
 * gemini.ts luôn kết bằng "professional advertising background, cinematic
 * depth" - tức là ngầm định ảnh quảng cáo bóng bẩy. Cộng thêm "origami giấy"
 * vào đó là ra một thứ nửa nọ nửa kia. Nên mỗi phong cách mang theo câu chỉ đạo
 * mỹ thuật RIÊNG (`art`) để đá hẳn câu mặc định ra, kèm `avoid` để chặn đúng
 * những thứ hay lẫn vào.
 *
 * ---------------------------------------------------------------------------
 * TỪ CODE SANG DỮ LIỆU (giống hệt styles.ts của Style Design)
 *
 * Trước đây 20 phong cách là một mảng hằng trong file này, sửa được thì phải
 * sửa code. Giờ nguồn sự thật là `assets/video-styles/video-styles.json`, còn
 * mảng `BUILTIN_VIDEO_STYLES` bên dưới chỉ còn là HẠT GIỐNG:
 *
 * - Lần đọc đầu tiên chưa có file JSON -> ghi ra từ mảng này (repo mới clone
 *   vẫn có đủ 20 phong cách, không cần bước cài đặt nào).
 * - Bản cập nhật repo sau này thêm phong cách dựng mới vào mảng -> lần đọc kế
 *   tiếp tự chèn phong cách đó vào file của người dùng, TRỪ KHI họ đã xóa nó
 *   (id nằm trong `removedBuiltins`). Không có danh sách đó thì phong cách vừa
 *   xóa sẽ mọc lại sau mỗi lần khởi động server.
 * - Người dùng sửa/xóa/thêm gì trên dashboard cũng chỉ ghi vào file JSON; mảng
 *   hạt giống giữ nguyên để nút "Khôi phục bản gốc" còn cái mà khôi phục.
 */

/** Bảng màu: đa số phong cách vẫn theo màu thương hiệu; vài phong cách thì không thể */
export type VideoStylePalette = "brand" | "loose";

export const VIDEO_STYLE_PALETTES: VideoStylePalette[] = ["brand", "loose"];

export interface VideoStyle {
  id: string;
  /**
   * Tên tiếng Việt. Web ưu tiên bản dịch theo key `vstyle.<id>`; tên này là
   * lưới an toàn và là thứ đưa vào prompt cho AI đọc.
   */
  name: string;
  /**
   * Chỉ đạo mỹ thuật cho Gemini - viết TIẾNG ANH vì model bám sát hơn hẳn so
   * với tiếng Việt ở phần mô tả chất liệu/kỹ thuật vẽ.
   */
  art: string;
  /** Thứ phải tránh - chặn đúng cái hay lẫn vào của riêng phong cách này */
  avoid: string;
  /**
   * "brand" = giữ nguyên bảng màu thương hiệu (mặc định).
   * "loose" = phong cách có bảng màu ruột của nó, ép màu brand vào là mất chất;
   * màu thương hiệu lúc đó chỉ dùng làm điểm nhấn. UI PHẢI nói rõ chỗ này.
   */
  palette: VideoStylePalette;
  /** Dựng cảnh và chuyển động cho HyperFrames/Remotion - tiếng Việt, cho agent đọc */
  motion: string;
  createdAt: string;
  updatedAt: string;
}

/** Hạt giống chưa có mốc thời gian - timestamp sinh lúc gieo vào file JSON */
export type VideoStyleSeed = Omit<VideoStyle, "createdAt" | "updatedAt">;

export interface VideoStylesFile {
  styles: VideoStyle[];
  /**
   * Id phong cách MẶC ĐỊNH đã bị người dùng xóa. Giữ lại để lần đọc sau không
   * gieo lại - xóa rồi mà cứ mọc lại thì tính năng xóa coi như không có.
   */
  removedBuiltins: string[];
}

/**
 * 20 phong cách mặc định. Tiêu chí chọn: (1) nhìn là phân biệt được ngay với 19
 * cái còn lại, (2) Gemini vẽ ra được ổn định, (3) HTML/CSS/GSAP dựng chuyển động
 * hợp với nó được - đẹp mà pipeline không dựng nổi thì chỉ là danh sách trang trí.
 */
export const BUILTIN_VIDEO_STYLES: VideoStyleSeed[] = [
  {
    id: "giay-gap-nhat",
    name: "Gấp giấy Nhật Bản",
    art: "Japanese paper craft scene: layered origami and kirigami cut-paper shapes, visible washi paper fibre texture, crisp folded creases, soft realistic drop shadows between paper layers, shallow paper-diorama depth, gentle even studio light.",
    avoid: "no photographic realism, no 3D glossy render, no digital gradients, no metallic surfaces",
    palette: "brand",
    motion:
      "Chuyển cảnh kiểu GẤP và LẬT giấy, không mờ chồng. Vật thể trượt vào theo lớp, mỗi lớp một bóng đổ nhẹ. Chữ đặt như dán trên mảnh giấy, hơi nghiêng vài độ. Nhịp thong thả, easing mềm.",
  },
  {
    id: "vox-explainer",
    name: "Giải thích kiểu VOX",
    art: "Editorial explainer illustration in the VOX/Vice News style: bold flat graphic shapes, halftone dot texture, cut-out archival photo collage elements, hand-drawn circles and arrows annotating the subject, high contrast, confident modern editorial layout.",
    avoid: "no soft airbrush, no photoreal 3D, no cute mascots, no pastel decoration",
    palette: "brand",
    motion:
      "Chữ tiêu đề CỰC ĐẬM, co hẹp, vào bằng cách trượt kèm khối màu quét ngang. Mũi tên và vòng khoanh vẽ tay chạy nét theo lời nói. Cắt cảnh dứt khoát đúng nhịp nhấn giọng, không dùng fade.",
  },
  {
    id: "tranh-ve-tay",
    name: "Tranh vẽ tay (màu nước)",
    art: "Hand-painted illustration: watercolour and gouache on textured cotton paper, visible brush strokes and pigment blooms, soft bleeding edges, subtle paper grain showing through, warm hand-made imperfection.",
    avoid: "no vector sharpness, no digital gradients, no 3D render, no photographic detail",
    palette: "brand",
    motion:
      "Hình hiện ra như mực loang, dùng mask quét dần chứ không phóng to. Chuyển động nhẹ, hơi trôi như giấy. Chữ viết tay hoặc serif mảnh. Tránh mọi chuyển động máy móc, giật cục.",
  },
  {
    id: "nguoi-que",
    name: "Người que bảng trắng",
    art: "Whiteboard marker drawing: simple black stick figures and quick schematic doodles on a clean white board, uneven hand-drawn marker line weight, minimal shading, a few colour accents only where meaning requires it.",
    avoid: "no realistic anatomy, no shading, no background scenery, no photographic elements",
    palette: "brand",
    motion:
      "Nét VẼ DẦN như đang được viết ra (stroke-dashoffset), không hiện sẵn. Mỗi ý một nét mới, ý cũ mờ bớt chứ không biến mất. Nhịp bám sát lời giảng, dừng lại đúng lúc người nói nhấn.",
  },
  {
    id: "flat-vector",
    name: "Vector phẳng",
    art: "Clean flat vector illustration: solid colour fills, no gradients, geometric simplified forms, generous negative space, consistent stroke weight, modern editorial infographic feel.",
    avoid: "no textures, no drop shadows, no 3D, no photographic elements, no gradients",
    palette: "brand",
    motion:
      "Hình khối trượt và xoay theo trục rõ ràng, easing dứt khoát. Chuyển cảnh bằng khối màu quét kín màn hình. Bố cục căn lưới nghiêm, chữ sans-serif đậm.",
  },
  {
    id: "isometric",
    name: "Đẳng cự 3D",
    art: "Isometric technical illustration: 30-degree axonometric projection, clean geometric buildings/objects/systems, flat shading with two light levels, precise edges, diagram-like clarity.",
    avoid: "no perspective vanishing points, no photographic texture, no hand-drawn wobble",
    palette: "brand",
    motion:
      "Camera trượt ngang chậm giữ đúng góc đẳng cự, KHÔNG xoay phối cảnh. Khối dựng lên từng tầng theo thứ tự giải thích. Đường nối giữa các khối chạy nét khi nhắc tới.",
  },
  {
    id: "dat-set",
    name: "Đất sét stop-motion",
    art: "Claymation scene: hand-moulded plasticine characters and props, visible fingerprints and tool marks in the clay, soft matte surface, tabletop miniature set, warm practical lighting with soft shadows.",
    avoid: "no smooth digital 3D, no glossy plastic, no vector flatness",
    palette: "brand",
    motion:
      "Chuyển động GIẬT nhẹ như stop-motion: giảm còn 12 hình/giây cho vật thể chính, nền vẫn mượt. Vật nảy nhẹ khi dừng. Tuyệt đối không easing quá mượt - mất chất thủ công.",
  },
  {
    id: "cat-dan-zine",
    name: "Cắt dán báo",
    art: "Cut-and-paste zine collage: torn newspaper and magazine scraps, ransom-note mixed typography, photocopied high-contrast textures, visible tape and staples, rough torn paper edges, punk DIY energy.",
    avoid: "no clean vector shapes, no smooth gradients, no polished corporate look",
    palette: "brand",
    motion:
      "Mảnh giấy DẬP xuống đúng nhịp trống, hơi lệch góc mỗi lần. Rung giật 1-2px giữ nhịp. Chữ nhảy cỡ và font liên tục. Cắt cảnh thô, không chuyển mượt.",
  },
  {
    id: "muc-tau",
    name: "Tranh mực tàu",
    art: "East Asian ink wash painting (sumi-e): black ink on rice paper, gradient washes from deep black to pale grey, confident single brush strokes, vast empty space as composition, subtle bleed into the paper fibre.",
    avoid: "no bright colours, no hard vector edges, no digital gradients, no busy detail",
    palette: "loose",
    motion:
      "Nét mực chạy theo hướng bút, đầu đậm cuối nhạt. Giữ RẤT NHIỀU khoảng trống, đừng lấp đầy khung. Chuyển cảnh bằng loang mực. Nhịp chậm, tĩnh, để hình thở.",
  },
  {
    id: "dong-ho",
    name: "Tranh Đông Hồ",
    art: "Vietnamese Dong Ho folk woodblock print: hand-carved block print look, bold black outlines, flat traditional mineral pigments, printed on textured diep paper with visible shimmering shell-powder ground, naive charming folk figures.",
    avoid: "no modern vector cleanliness, no photographic realism, no 3D shading, no anime styling",
    palette: "loose",
    motion:
      "Hình xuất hiện như ĐÓNG DẤU xuống giấy: hiện nhanh kèm rung nhẹ rồi đứng yên. Giữ nét viền dày đặc trưng. Bố cục cân đối kiểu tranh dân gian. Không dùng chuyển động bay lượn hiện đại.",
  },
  {
    id: "neon-cyber",
    name: "Neon cyberpunk",
    art: "Neon cyberpunk night scene: rain-slicked reflective surfaces, glowing neon signage, dense atmospheric haze, strong magenta-cyan rim lighting, deep black shadows, cinematic anamorphic flare.",
    avoid: "no daylight, no pastel, no flat vector, no clean minimal white space",
    palette: "brand",
    motion:
      "Chữ phát sáng kèm quầng nhẹ, nhấp nháy như đèn neon hỏng ở khung đầu. Nhiễu số và lệch kênh màu ở mỗi lần cắt cảnh. Camera trôi chậm liên tục, không đứng yên hẳn.",
  },
  {
    id: "in-retro-70",
    name: "In retro thập niên 70",
    art: "1970s offset print aesthetic: limited three-colour ink palette, visible misregistration between plates, heavy paper grain and print noise, halftone dots, warm faded inks, vintage poster composition.",
    avoid: "no crisp digital edges, no modern gradients, no 3D, no pure white brightness",
    palette: "brand",
    motion:
      "Mỗi lần cắt cảnh lệch bản in 2-3px rồi khớp lại. Hạt nhiễu chạy liên tục. Chữ dùng serif hoặc chữ cong kiểu poster cũ. Nhịp vừa phải, ấm áp.",
  },
  {
    id: "ban-ve-ky-thuat",
    name: "Bản vẽ kỹ thuật",
    art: "Technical blueprint schematic: precise white and pale cyan line work on deep blue ground, dimension lines and callout leaders, cross-section cutaways, drafting grid, engineering annotation marks.",
    avoid: "no photographic texture, no painterly shading, no decorative illustration",
    palette: "loose",
    motion:
      "Đường nét VẼ DẦN theo thứ tự lắp ráp, kèm đường kích thước bung ra. Lưới nền trôi rất chậm. Chữ dùng font đều nét kiểu bản vẽ. Cảm giác chính xác, không ngẫu hứng.",
  },
  {
    id: "pixel-art",
    name: "Pixel art",
    art: "16-bit pixel art: crisp aligned pixel grid, limited indexed palette, deliberate dithering for shading, chunky readable sprites, retro game scene composition.",
    avoid: "no anti-aliasing, no smooth curves, no gradients, no photographic detail",
    palette: "brand",
    motion:
      "Mọi thứ dịch chuyển theo BƯỚC pixel, không trượt mượt nửa pixel. Chuyển cảnh bằng ô vuông lấp dần. Chữ dùng font pixel. Giữ khung hình thấp cho đúng chất game cũ.",
  },
  {
    id: "anime-cel",
    name: "Anime cel-shading",
    art: "Anime cel-shaded illustration: clean confident line art, two-tone flat cel shading with hard shadow edges, expressive characters, dramatic speed lines, vivid saturated key light.",
    avoid: "no photorealism, no painterly blending, no 3D render, no western cartoon proportions",
    palette: "brand",
    motion:
      "Nhấn mạnh bằng đường tốc độ và rung khung hình ngắn. Cắt cảnh nhanh ở cao trào. Hiệu ứng loé sáng một khung khi nhấn. Chữ katakana-style hoặc sans đậm nghiêng.",
  },
  {
    id: "3d-studio",
    name: "3D studio bóng bẩy",
    art: "Polished 3D studio render: soft global illumination, seamless infinite backdrop, matte and glossy material contrast, subtle depth of field, product-visualisation quality, clean soft shadows.",
    avoid: "no hand-drawn texture, no flat vector, no grain, no visible brush strokes",
    palette: "brand",
    motion:
      "Camera trôi rất mượt kèm xoá phông nông. Vật thể xoay chậm liên tục. Chuyển cảnh bằng đẩy camera xuyên qua vật thể. Chữ mảnh, nhiều khoảng thở, sang trọng.",
  },
  {
    id: "anh-tai-lieu",
    name: "Ảnh thật tài liệu",
    art: "Documentary editorial photography: natural available light, authentic candid moments, realistic depth of field, true-to-life colour, photojournalistic framing, no staging.",
    avoid: "no illustration, no 3D render, no cartoon, no artificial studio gloss",
    palette: "loose",
    motion:
      "Ken Burns nhẹ: phóng và trôi rất chậm trên ảnh tĩnh. Chuyển cảnh cắt thẳng hoặc mờ chồng ngắn. Chữ đặt trên dải nền mờ để đọc được trên mọi ảnh.",
  },
  {
    id: "infographic",
    name: "Infographic số liệu",
    art: "Data-driven infographic: clean charts and diagrams, clear numeric hierarchy, generous white space, restrained iconography, precise alignment grid, editorial data-journalism clarity.",
    avoid: "no decorative clutter, no photographic background, no 3D chart effects, no drop shadows",
    palette: "brand",
    motion:
      "Cột và đường biểu đồ MỌC LÊN từ 0 đúng lúc đọc tới con số. Số đếm tăng dần thay vì hiện sẵn. Mỗi màn chỉ một ý số liệu. Căn lưới tuyệt đối.",
  },
  {
    id: "cat-out-puppet",
    name: "Rối giấy cắt",
    art: "Cut-out paper puppet animation: flat character parts with visible joint pivots, construction-paper texture, slightly crude hand-cut edges, simple layered stage-like backdrop.",
    avoid: "no smooth 3D, no realistic anatomy, no gradients, no photographic depth",
    palette: "brand",
    motion:
      "Nhân vật cử động bằng cách XOAY quanh khớp nối, chân tay là mảnh rời. Miệng đổi giữa vài hình cố định theo lời. Chuyển động thô, hài hước, hơi vụng về có chủ ý.",
  },
  {
    id: "giao-dien-app",
    name: "Giao diện app",
    art: "Modern app UI showcase: floating interface panels with frosted translucent glass, soft layered shadows, rounded corners, crisp iconography, subtle depth, clean tech product presentation.",
    avoid: "no hand-drawn texture, no grain, no photographic clutter, no skeuomorphic ornament",
    palette: "brand",
    motion:
      "Panel trượt vào kèm mờ nền phía sau. Con trỏ giả lập thao tác thật, bấm đâu có phản hồi đó. Chuyển cảnh bằng phóng vào một phần giao diện. Chữ sans hiện đại, cỡ chuẩn hệ thống.",
  },
];

const BUILTIN_IDS = new Set(BUILTIN_VIDEO_STYLES.map((s) => s.id));

/** Phong cách này có phải bản mặc định ship kèm repo không (để UI gắn nhãn + cho phép khôi phục) */
export function isBuiltinVideoStyle(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/** Bản gốc của một phong cách mặc định - dùng cho nút "Khôi phục bản gốc" */
export function builtinVideoStyle(id: string): VideoStyle | null {
  const seed = BUILTIN_VIDEO_STYLES.find((s) => s.id === id);
  if (!seed) return null;
  const now = nowIso();
  return { ...seed, createdAt: now, updatedAt: now };
}

// Thư mục dữ liệu đặt cạnh assets/styles/ (Style Design) cho dễ tìm và dễ sao lưu.
// KHÔNG khai vào paths của config.ts: prompts.ts cũng tự dựng đường dẫn kiểu này,
// và giữ nó ở đây thì cả tính năng nằm gọn trong một file.
const videoStylesDir = path.join(paths.assetsDir, "video-styles");
const videoStylesFile = path.join(videoStylesDir, "video-styles.json");

/**
 * Chuẩn hóa một phong cách đọc từ đĩa (dữ liệu đĩa không tin kiểu).
 * Thiếu id hợp lệ -> null (bỏ khỏi danh sách, không làm hỏng cả file).
 */
function normVideoStyle(raw: unknown): VideoStyle | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || !s.id.trim()) return null;
  const id = s.id.trim();
  const str = (key: string, fallback: string): string =>
    typeof s[key] === "string" && (s[key] as string).trim() ? (s[key] as string) : fallback;
  const now = nowIso();
  return {
    id,
    name: str("name", id),
    art: str("art", ""),
    avoid: str("avoid", ""),
    palette: s.palette === "loose" ? "loose" : "brand",
    motion: str("motion", ""),
    createdAt: str("createdAt", now),
    updatedAt: str("updatedAt", now),
  };
}

/**
 * Cache theo mtime+size của file: `videoStyleExists()` bị gọi cho MỌI project khi
 * web nạp danh sách, đọc lại và parse JSON từng lần là phí. File đổi (server tự
 * ghi hoặc người dùng sửa tay) thì stat đổi theo và cache tự hỏng.
 */
let cache: { key: string; data: VideoStylesFile } | null = null;

function cacheKey(): string | null {
  try {
    const st = fs.statSync(videoStylesFile);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null; // chưa có file
  }
}

/** Gieo file lần đầu từ mảng hạt giống - repo mới clone vẫn có đủ 20 phong cách */
function seedFile(): VideoStylesFile {
  const now = nowIso();
  const data: VideoStylesFile = {
    styles: BUILTIN_VIDEO_STYLES.map((s) => ({ ...s, createdAt: now, updatedAt: now })),
    removedBuiltins: [],
  };
  writeVideoStyles(data);
  return data;
}

/**
 * File có mà hỏng (sửa tay gõ sai, ghi dở) thì GIỮ LẠI một bản trước khi gieo
 * lại - gieo đè thẳng là mất sạch mọi phong cách người dùng đã tạo/sửa.
 */
function reseedCorrupt(): VideoStylesFile {
  const backup = `${videoStylesFile}.corrupt-${Date.now()}`;
  try {
    fs.copyFileSync(videoStylesFile, backup);
    console.warn(`[video-styles] file hỏng - đã lưu bản cũ ở ${backup} rồi gieo lại mặc định`);
  } catch {
    /* không chép được thì vẫn phải gieo lại để hệ thống chạy tiếp */
  }
  return seedFile();
}

/**
 * Đọc video-styles.json. Lần đầu chưa có file thì gieo từ BUILTIN_VIDEO_STYLES;
 * file đã có mà repo vừa thêm phong cách mặc định mới thì chèn bổ sung (trừ các
 * id người dùng đã xóa). File hỏng -> gieo lại, vì một danh sách rỗng sẽ làm
 * mọi project đang trỏ tới phong cách tụt hết về "AI tự quyết".
 */
export function readVideoStyles(): VideoStylesFile {
  const key = cacheKey();
  if (key === null) {
    cache = null;
    return seedFile();
  }
  if (cache && cache.key === key) return cache.data;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(videoStylesFile, "utf8"));
  } catch {
    cache = null;
    return reseedCorrupt();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    cache = null;
    return reseedCorrupt();
  }
  const r = parsed as Record<string, unknown>;
  const styles: VideoStyle[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.styles)) {
    for (const item of r.styles) {
      const s = normVideoStyle(item);
      if (s && !seen.has(s.id)) {
        seen.add(s.id);
        styles.push(s);
      }
    }
  }
  const removedBuiltins = Array.isArray(r.removedBuiltins)
    ? [...new Set(r.removedBuiltins.filter((x): x is string => typeof x === "string"))]
    : [];

  // Phong cách mặc định mới có trong bản cập nhật repo mà file chưa có -> chèn thêm
  const missing = BUILTIN_VIDEO_STYLES.filter(
    (s) => !seen.has(s.id) && !removedBuiltins.includes(s.id),
  );
  const data: VideoStylesFile = { styles, removedBuiltins };
  if (missing.length > 0) {
    const now = nowIso();
    for (const s of missing) data.styles.push({ ...s, createdAt: now, updatedAt: now });
    writeVideoStyles(data);
    return data;
  }
  cache = { key, data };
  return data;
}

export function writeVideoStyles(data: VideoStylesFile): void {
  ensureDir(videoStylesDir);
  // Ghi file tạm rồi rename: tắt máy giữa lúc ghi không để lại JSON cụt
  const tmp = `${videoStylesFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, videoStylesFile);
  const key = cacheKey();
  if (key !== null) cache = { key, data };
}

/**
 * null / không khớp = không áp phong cách nào, dựng theo skill + Style Design.
 *
 * Truyền vào đây phải là `activeVideoStyleId(brief)` chứ không phải
 * `brief.videoStyleId` thô - công tắc tắt thì id vẫn còn nguyên trong meta.
 */
export function getVideoStyle(id: string | null | undefined): VideoStyle | null {
  if (!id) return null;
  return readVideoStyles().styles.find((s) => s.id === id) ?? null;
}

export function videoStyleExists(id: string): boolean {
  return readVideoStyles().styles.some((s) => s.id === id);
}

// ------------------------------------------------------------- Đang dùng ở đâu

/** Loại "project" có brief - mỗi loại một thư mục con ở gốc repo */
export type VideoStyleUsageKind =
  | "video-project"
  | "text-to-video"
  | "auto-cut"
  | "translate-video";

export interface VideoStyleUsage {
  kind: VideoStyleUsageKind;
  id: string;
  name: string;
}

/**
 * Quét mọi project/phiên đang trỏ tới một phong cách.
 *
 * Đọc thẳng meta.json bằng fs chứ KHÔNG import meta.ts: meta.ts đã import file
 * này (videoStyleExists), thêm chiều ngược lại là vòng import.
 */
export function videoStyleUsage(styleId: string): VideoStyleUsage[] {
  const roots: Array<{ kind: VideoStyleUsageKind; dir: string }> = [
    { kind: "video-project", dir: paths.videoProjectsDir },
    { kind: "text-to-video", dir: paths.textToVideoDir },
    { kind: "auto-cut", dir: paths.autoCutDir },
    { kind: "translate-video", dir: paths.translateVideoDir },
  ];
  const out: VideoStyleUsage[] = [];
  for (const { kind, dir } of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // thư mục chưa tồn tại - không phải lỗi
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(dir, entry.name, "meta.json"), "utf8"),
        ) as Record<string, unknown>;
        const brief = raw.brief as Record<string, unknown> | undefined;
        if (!brief || brief.videoStyleId !== styleId) continue;
        // Công tắc phong cách dựng đang TẮT = phong cách không có hiệu lực, đừng
        // đếm là "đang dùng" (xóa nhầm vì thấy con số là chuyện có thật). So với
        // `=== false` chứ không dùng falsy: brief cũ THIẾU hẳn field này, mà
        // thiếu + có id thì briefOf coi là đang bật (xem meta.ts).
        if (brief.videoStyleEnabled === false) continue;
        out.push({
          kind,
          id: entry.name,
          name: typeof raw.name === "string" && raw.name ? raw.name : entry.name,
        });
      } catch {
        /* không có meta.json hoặc JSON hỏng - bỏ qua */
      }
    }
  }
  return out;
}
