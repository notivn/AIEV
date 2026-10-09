#!/usr/bin/env node
/**
 * Tải logo brand vào `assets/brand-logos/` để dựng video không phải tự vẽ logo.
 *
 * NGUỒN: Simple Icons (https://simple-icons.org) - bộ SVG do cộng đồng duy trì,
 * file phát hành theo CC0-1.0. Đây là nguồn DUY NHẤT script này dùng, cố ý:
 * nhặt logo trôi nổi trên mạng thì vừa sai bản chính thức vừa không rõ giấy phép.
 *
 * BA ĐIỀU PHẢI BIẾT TRƯỚC KHI DÙNG:
 *
 * 1. CC0 áp cho FILE SVG, KHÔNG phải cho THƯƠNG HIỆU. Logo vẫn là nhãn hiệu của
 *    chủ sở hữu. Dùng để nhắc tới/minh họa (video nói về ChatGPT có logo OpenAI)
 *    thì bình thường; dùng kiểu ngụ ý được brand đó tài trợ/chứng thực thì không.
 *
 * 2. Đây là glyph MỘT MÀU, không phải logo đầy đủ màu. Hình dáng là bản chính
 *    thức, nhưng vd Google nhiều màu thì ở đây chỉ còn chữ "G" một màu. Cần bản
 *    đủ màu thì tải từ trang brand chính chủ rồi bỏ vào thư mục này - script sẽ
 *    giữ nguyên file bạn thêm vào (xem KEEP_EXTRA bên dưới).
 *
 * 3. Vài brand KHÔNG có trong Simple Icons vì chính chủ yêu cầu gỡ (Microsoft
 *    qua bộ phận pháp lý, LinkedIn theo brand guidelines...). Script sẽ liệt kê
 *    những brand thiếu chứ KHÔNG đi tìm nguồn khác thay thế - lách yêu cầu của
 *    chủ sở hữu không phải việc của script này. Muốn có thì tự tải từ trang
 *    brand chính chủ và tự chịu trách nhiệm.
 *
 * Chạy:
 *   node scripts/fetch-brand-logos.mjs              # tải danh sách chuẩn
 *   node scripts/fetch-brand-logos.mjs figma notion # bổ sung thêm brand
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT_DIR = path.join(REPO, "assets", "brand-logos");
const LIBRARY = path.join(OUT_DIR, "library.json");

const INDEX_URL = "https://cdn.jsdelivr.net/npm/simple-icons@latest/data/simple-icons.json";
const SVG_URL = (slug) => `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`;

/**
 * Danh sách chuẩn - chọn theo thứ tự hay gặp trong video tiếng Việt về công
 * nghệ/mạng xã hội, KHÔNG phải "100 brand lớn nhất thế giới". Brand nào Simple
 * Icons không có thì bị bỏ qua và báo lại ở cuối.
 */
const CANDIDATES = [
  // --- Mạng xã hội & nhắn tin ---
  "facebook", "messenger", "instagram", "tiktok", "youtube", "telegram", "whatsapp",
  "x", "threads", "snapchat", "pinterest", "reddit", "discord", "viber", "line",
  "wechat", "sinaweibo", "zalo", "twitch", "signal", "mastodon", "bluesky", "kakaotalk",
  // --- AI ---
  "claude", "anthropic", "googlegemini", "deepseek", "kimi", "perplexity",
  "mistralai", "ollama", "huggingface", "githubcopilot", "midjourney", "elevenlabs",
  "runway", "qwen", "zhipu", "nvidia", "replicate", "langchain", "n8n",
  // --- Big tech & phần cứng ---
  "google", "apple", "meta", "samsung", "huawei", "xiaomi", "oppo", "intel", "amd",
  "qualcomm", "tesla", "ibm", "oracle", "sony", "lg", "asus", "lenovo", "dell", "hp",
  // --- Công cụ & sáng tạo ---
  "adobephotoshop", "adobepremierepro", "adobeaftereffects", "adobeillustrator",
  "figma", "notion", "slack", "zoom", "dropbox", "trello", "canvasapps",
  "blender", "unity", "unrealengine", "obsstudio", "audacity", "davinciresolve",
  // --- Giải trí ---
  "spotify", "netflix", "soundcloud", "steam", "epicgames", "roblox", "shazam",
  // --- Lập trình ---
  "github", "gitlab", "docker", "kubernetes", "python", "javascript", "typescript",
  "react", "nodedotjs", "nextdotjs", "vuedotjs", "tailwindcss", "vercel", "cloudflare",
  "firebase", "mongodb", "postgresql", "mysql", "redis", "git", "linux", "ubuntu",
  "android", "rust", "go", "php", "laravel", "wordpress",
  // --- Thanh toán, thương mại, Việt Nam & Đông Nam Á ---
  "visa", "mastercard", "paypal", "stripe", "alipay", "binance", "coinbase",
  "bitcoin", "ethereum", "shopee", "grab", "alibabadotcom", "aliexpress", "ebay",
];

/** File người dùng tự thêm - script KHÔNG được xóa, chỉ đưa vào library.json */
const KEEP_EXTRA = true;

const slugify = (t) =>
  t.toLowerCase().replace(/\+/g, "plus").replace(/\./g, "dot").replace(/[^a-z0-9]/g, "");

async function main() {
  const extra = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
  const wanted = [...new Set([...CANDIDATES, ...extra])];

  process.stdout.write(`Đang lấy danh mục Simple Icons...\n`);
  const res = await fetch(INDEX_URL);
  if (!res.ok) throw new Error(`Không tải được danh mục (HTTP ${res.status})`);
  const raw = await res.json();
  const icons = Array.isArray(raw) ? raw : raw.icons;
  process.stdout.write(`  có ${icons.length} icon trong danh mục\n\n`);

  const bySlug = new Map();
  const byTitle = new Map();
  for (const i of icons) {
    const slug = i.slug ?? slugify(i.title);
    bySlug.set(slug, { ...i, slug });
    byTitle.set(i.title.toLowerCase(), { ...i, slug });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const found = [];
  const missing = [];
  for (const w of wanted) {
    const hit = bySlug.get(w) ?? byTitle.get(w.toLowerCase()) ?? bySlug.get(slugify(w));
    if (!hit) {
      missing.push(w);
      continue;
    }
    const file = `${hit.slug}.svg`;
    const dest = path.join(OUT_DIR, file);
    if (!fs.existsSync(dest)) {
      const r = await fetch(SVG_URL(hit.slug));
      if (!r.ok) {
        missing.push(`${w} (tải SVG lỗi ${r.status})`);
        continue;
      }
      const svg = await r.text();
      // Chặn rác: file phải thật sự là SVG, không phải trang lỗi của CDN
      if (!svg.includes("<svg")) {
        missing.push(`${w} (nội dung không phải SVG)`);
        continue;
      }
      fs.writeFileSync(dest, svg, "utf8");
      process.stdout.write(`  + ${hit.title} -> ${file}\n`);
    }
    found.push({
      slug: hit.slug,
      title: hit.title,
      /** Màu chính thức của brand (hex, KHÔNG có dấu #) - dùng khi tô SVG inline */
      color: `#${hit.hex}`,
      file,
      source: hit.source ?? null,
    });
  }

  // File người dùng tự bỏ vào (vd logo đủ màu tải từ trang brand chính chủ)
  if (KEEP_EXTRA) {
    const known = new Set(found.map((f) => f.file));
    // Entry đang có trong library.json (server tải từ Wikidata/Commons, kèm
    // title/source/license riêng) phải giữ NGUYÊN - dựng lại thành
    // "title = slug, source = null" là mất giấy phép từng file, và license CC0
    // chung ở đầu file lại phủ lên cả những file Commons không phải CC0.
    const existing = new Map();
    try {
      for (const e of JSON.parse(fs.readFileSync(LIBRARY, "utf8")).icons ?? []) {
        if (e && typeof e.file === "string") existing.set(e.file, e);
      }
    } catch {
      /* chưa có / hỏng - dựng mới như trước */
    }
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (!/\.(svg|png)$/i.test(f) || known.has(f)) continue;
      if (existing.has(f)) {
        found.push(existing.get(f));
        continue;
      }
      const slug = f.replace(/\.(svg|png)$/i, "");
      found.push({
        slug,
        title: slug,
        color: null,
        file: f,
        source: null,
        addedByUser: true,
      });
      process.stdout.write(`  = giữ file bạn tự thêm: ${f}\n`);
    }
  }

  found.sort((a, b) => a.title.localeCompare(b.title));
  const library = {
    generatedAt: new Date().toISOString(),
    source: "https://simple-icons.org",
    license: "CC0-1.0 (áp cho file SVG, KHÔNG áp cho quyền nhãn hiệu của brand)",
    notice:
      "Logo là nhãn hiệu của chủ sở hữu. Dùng để nhắc tới/minh họa thì được; " +
      "không được dùng theo cách ngụ ý brand đó tài trợ hay chứng thực nội dung. " +
      "Glyph một màu - cần bản đủ màu thì tải từ trang brand chính chủ và bỏ vào thư mục này.",
    count: found.length,
    icons: found,
  };
  fs.writeFileSync(LIBRARY, JSON.stringify(library, null, 2) + "\n", "utf8");

  process.stdout.write(`\nXong: ${found.length} logo trong ${path.relative(REPO, OUT_DIR)}\n`);
  if (missing.length) {
    process.stdout.write(
      `\nKHÔNG có trong Simple Icons (${missing.length}) - phần lớn là do chính chủ\n` +
        `thương hiệu yêu cầu gỡ. Muốn dùng thì tự tải SVG từ trang brand chính chủ,\n` +
        `đặt vào ${path.relative(REPO, OUT_DIR)}/<ten>.svg rồi chạy lại script:\n` +
        missing.map((m) => `  - ${m}`).join("\n") +
        "\n",
    );
  }
}

main().catch((err) => {
  process.stderr.write(`Lỗi: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
