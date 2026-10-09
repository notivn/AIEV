#!/usr/bin/env node
/**
 * Cổng kiểm tra hệ thống thiết kế - chạy `node scripts/check-design-system.mjs`.
 *
 * VÌ SAO CÓ FILE NÀY: đợt đại tu tháng 8/2026 dọn 416 chỗ `text-xs` dùng sai bậc
 * và hơn 40 bản chép tay của các primitive. Không có cổng chặn thì sáu tháng nữa
 * mọi thứ trôi về đúng chỗ cũ - lần trước chính là như vậy: spec viết body 14px
 * mà thực tế 12px thành mặc định, không ai nhận ra vì không có gì đếm giúp.
 *
 * Cổng này KHÔNG thay người review. Nó chỉ bắt đúng những lỗi máy đếm được.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, không phải URL.pathname: pathname giữ nguyên %20 nên thư mục
// có dấu cách (C:\Users\Nguyen Van A\…) sẽ không tìm thấy src/
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

/** Cỡ chữ ngoài thang ba bậc (text-sm / text-meta / text-xs). */
const BANNED_TEXT =
  /\btext-\[(?:9|10|11|13|15|16|17|18|19|20|21|22|23|24|25|27|29|30)px\]|\btext-base\b|\btext-lg\b|\btext-2xl\b|\btext-3xl\b/g;

/** Khoảng cách ngoài nhịp 4/8/12/16/24. */
const BANNED_SPACE = /\bgap-(?:0\.5|1\.5|2\.5|5|7|9)\b|\bp-(?:0\.5|1\.5|2\.5)\b/g;

/** Màu thô nằm ngoài bảng token. */
const BANNED_COLOR =
  /(?:bg|text|border)-\[#[0-9a-fA-F]{3,8}\]|\b(?:bg|text)-(?:white|black|gray|slate|zinc|neutral|stone|red|blue|green|yellow)-\d{2,3}\b/g;

/** Bản chép tay của primitive đã có sẵn. */
const HANDROLLED = [
  {
    re: /rounded-\[var\(--radius\)\]\s+border\s+border-\[var\(--border\)\]\s+bg-\[var\(--bg-subtle\)\]/g,
    msg: "hộp lồng chép tay - dùng <Panel>",
  },
  {
    re: /className="btn btn-(?:primary|secondary|destructive)/g,
    msg: "class .btn viết tay - dùng <Button>",
  },
  {
    re: /\brounded-\[3px\]/g,
    msg: "bán kính thô - dùng var(--radius)",
  },
];

/** File được miễn, kèm LÝ DO. Không có lý do thì không được vào đây. */
const ALLOW = new Map([
  // Trang mobile quét QR: nền trắng thật cho ảnh QR để camera đọc được.
  ["src/app/m/[id]/page.tsx", ["BANNED_COLOR"]],
  // Lớp phủ điều khiển đè lên media - phải tương phản với nội dung video bất kỳ.
  ["src/components/MediaPreviewModal.tsx", ["BANNED_COLOR"]],
  // Ảnh QR cần nền trắng thật, không theo theme.
  ["src/components/PhoneConnectModal.tsx", ["BANNED_COLOR"]],
  // Khung xem trước phụ đề mô phỏng khung hình video tối.
  ["src/app/translate-video/[id]/page.tsx", ["BANNED_COLOR"]],
  // Xem trước chữ thương hiệu: cỡ chữ là DỮ LIỆU của style, không phải chrome.
  ["src/app/styles/[id]/page.tsx", ["BANNED_TEXT"]],
  // StatTile: con số lớn 28px theo spec, là bậc riêng đã ghi trong tài liệu.
  ["src/components/StatTile.tsx", ["BANNED_TEXT"]],
  // Khung xem trước ảnh chỉnh màu: viền + nền chờ tải bọc quanh chính tấm ảnh,
  // không phải hộp nhóm nội dung, nên <Panel> không đúng nghĩa ở đây.
  ["src/components/ProjectAssetsCard.tsx", ["HANDROLLED"]],
  // Ô vuông nhỏ vẽ TỈ LỆ KHUNG HÌNH (~16px): bán kính 3px là hình dạng của
  // chính cái icon; var(--radius) = 8px sẽ bo tròn nó thành một cục.
  ["src/components/ImageProjectForm.tsx", ["HANDROLLED"]],
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const findings = [];

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (rel.includes("/locales/")) continue; // chỉ là chuỗi dịch
  const allowed = ALLOW.get(rel) ?? [];
  // Dòng chú thích thành chuỗi rỗng (KHÔNG xóa hẳn - phải giữ đúng số dòng để
  // báo đúng vị trí). Các primitive tả ngay trong JSDoc cái mà chúng thay thế
  // ("thay cho p-1.5, h-7, h-8…"), đếm cả những dòng đó thì cổng báo động giả
  // ngay tại chính file đã làm đúng - mà cổng hay báo giả là cổng bị bỏ qua.
  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => (/^\s*(?:\*|\/\/|\/\*)/.test(l) ? "" : l));

  const checks = [
    ["BANNED_TEXT", BANNED_TEXT, "cỡ chữ ngoài thang 3 bậc"],
    ["BANNED_SPACE", BANNED_SPACE, "khoảng cách ngoài nhịp 4/8/12/16/24"],
    ["BANNED_COLOR", BANNED_COLOR, "màu ngoài bảng token"],
  ];

  for (const [id, re, label] of checks) {
    if (allowed.includes(id)) continue;
    lines.forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        findings.push({ rel, line: i + 1, label, hit: m[0] });
      }
    });
  }

  for (const { re, msg } of HANDROLLED) {
    if (allowed.includes("HANDROLLED")) break;
    lines.forEach((line, i) => {
      // Khung ảnh KHÔNG phải hộp lồng: một <img> có viền + nền chờ tải dùng
      // đúng bộ class đó nhưng nó là chính cái ảnh, không phải vật chứa - bọc
      // nó trong <Panel> chỉ đẻ thêm một tầng div vô nghĩa.
      if (/<img|object-(?:cover|contain|fill)/.test(line)) return;
      for (const m of line.matchAll(re)) {
        findings.push({ rel, line: i + 1, label: msg, hit: m[0].slice(0, 40) });
      }
    });
  }
}

if (findings.length === 0) {
  console.log("Hệ thống thiết kế: sạch.");
  process.exit(0);
}

const byLabel = new Map();
for (const f of findings) {
  if (!byLabel.has(f.label)) byLabel.set(f.label, []);
  byLabel.get(f.label).push(f);
}

console.log(`Hệ thống thiết kế: ${findings.length} chỗ lệch\n`);
for (const [label, items] of [...byLabel].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${label} (${items.length})`);
  for (const it of items.slice(0, 12)) {
    console.log(`    ${it.rel}:${it.line}  ${it.hit}`);
  }
  if (items.length > 12) console.log(`    … và ${items.length - 12} chỗ nữa`);
  console.log("");
}
process.exit(1);
