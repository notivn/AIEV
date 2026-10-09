import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { paths, repoRoot } from "./config.js";
import * as db from "./db.js";
import { buildEditPrompt, type BriefPromptContext } from "./editPrompt.js";
import {
  briefOf,
  defaultBrief,
  listProjectAssets,
  normTags,
  projectAssetsDirOf,
  projectDirOf,
  projectSummaryOf,
  readAssetEntries,
  readMeta,
  writeAssetEntry,
  writeMeta,
  type Brief,
  type ProjectMeta,
  type ProjectSummary,
  type SceneMeta,
} from "./meta.js";
import { readProjectTranscript } from "./transcript.js";
import { getStyle, type StyleDesign } from "./styles.js";
import { RECOMMENDED_TAG, readLibrary } from "./routes/sfx.js";
import { readMusicLibrary } from "./routes/music.js";
import { HttpError, ensureDir, fileKind, nowIso, toKebabAscii } from "./util.js";

/**
 * Tạo PROJECT CON từ một project đã có - nền tảng dùng chung cho hai tính năng:
 *  - "Cắt short từ video dài": mỗi đoạn hay thành một project dọc riêng.
 *  - "Tái chế tỉ lệ khung": cùng nội dung, dựng lại cho khung khác.
 *
 * VÌ SAO tách ra file riêng: cả hai tính năng đều cần đúng bộ thao tác scaffold
 * (thư mục chuẩn HyperFrames + index.html + hyperframes.json + meta.json) mà
 * `POST /api/projects` đang làm, nên phần scaffold được đưa về đây và
 * routes/projects.ts import lại - một nguồn sự thật, hai endpoint cũ không đổi hành vi.
 */

// ------------------------------------------------------------------ Id + scaffold

/**
 * Sinh id project chưa trùng: ép kebab-ascii rồi thêm hậu tố -2, -3...
 * (đúng cách `POST /api/projects` và `POST /api/projects/:id/clone` vẫn làm).
 */
export function uniqueProjectId(base: string): string {
  const root = toKebabAscii(base) || "project";
  let id = root;
  for (let n = 2; fs.existsSync(projectDirOf(id)); n++) id = `${root}-${n}`;
  return id;
}

/**
 * Tạo bộ khung file của một video project mới: compositions/, assets/, renders/,
 * index.html (composition gốc) và hyperframes.json. KHÔNG ghi meta.json - việc
 * đó do người gọi quyết định (project mới và project con có meta khác nhau).
 */
export function scaffoldProjectFiles(
  id: string,
  name: string,
  width: number,
  height: number,
): void {
  const dir = projectDirOf(id);
  ensureDir(dir);
  ensureDir(path.join(dir, "compositions"));
  ensureDir(path.join(dir, "assets"));
  ensureDir(path.join(dir, "renders"));

  fs.writeFileSync(path.join(dir, "index.html"), scaffoldIndexHtml(id, name, width, height), "utf8");
  // Format thật của HyperFrames CLI (DEFAULT_PROJECT_CONFIG trong hyperframes@0.7.x)
  fs.writeFileSync(
    path.join(dir, "hyperframes.json"),
    JSON.stringify(
      {
        $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
        registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
        paths: {
          blocks: "compositions",
          components: "compositions/components",
          assets: "assets",
        },
        media: { autoProxy: true },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

// Format thật của composition gốc HyperFrames: root div có data-composition-id/start/duration/width/height,
// GSAP CDN, timeline paused đăng ký vào window.__timelines[id] (object map, không phải array).
export function scaffoldIndexHtml(
  id: string,
  name: string,
  width: number,
  height: number,
): string {
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${escapeHtml(name)}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: #101113;
        font-family: Inter, system-ui, sans-serif;
      }
      #root {
        position: relative;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: #101113;
      }
      .placeholder {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #ffffff;
      }
      .placeholder h1 { font-size: 64px; font-weight: 800; text-align: center; padding: 0 48px; }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="${escapeHtml(id)}"
      data-start="0"
      data-duration="5"
      data-width="${width}"
      data-height="${height}"
    >
      <div class="placeholder"><h1>${escapeHtml(name)}</h1></div>
      <!-- Thêm scene: <div data-composition-id="s01" data-composition-src="compositions/s01.html" data-start="0" data-duration="3" data-track-index="1"></div> -->
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      // Anchor tween giữ đủ thời lượng slot, chống frame đen cuối composition
      tl.to({}, { duration: 5 }, 0);
      window.__timelines["${escapeHtml(id)}"] = tl;
    </script>
  </body>
</html>
`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ------------------------------------------------------------------ Copy file

/**
 * Mang file sang project con.
 *
 * VÌ SAO hardlink: video nguồn của một project dài có thể vài GB - nhân bản
 * thật sẽ ngốn đĩa vô ích khi cắt ra 5 short. Hardlink không tốn thêm byte nào,
 * fallback copy khi khác ổ đĩa / filesystem không hỗ trợ (đúng cơ chế staging
 * Remotion đang dùng).
 *
 * NGOẠI LỆ: file văn bản (json/srt/txt - kind "other") thì COPY thật, vì agent
 * dựng project con sẽ sửa trực tiếp (transcript cắt lại, remap timestamp) và
 * hardlink sẽ làm hỏng luôn file của project cha.
 */
function bringFile(srcAbs: string, dstAbs: string): void {
  ensureDir(path.dirname(dstAbs));
  if (fs.existsSync(dstAbs)) return; // đã mang sang rồi (trùng basename) - giữ bản đầu
  if (fileKind(srcAbs) === "other") {
    fs.copyFileSync(srcAbs, dstAbs);
    return;
  }
  try {
    fs.linkSync(srcAbs, dstAbs); // hardlink - không tốn dung lượng
  } catch {
    fs.copyFileSync(srcAbs, dstAbs); // fallback (khác ổ đĩa / FS không hỗ trợ)
  }
}

/** Resolve rel bên trong baseDir, chặn path traversal (`..`, đường dẫn tuyệt đối) */
function resolveInside(baseDir: string, rel: string, what: string): string {
  const root = path.resolve(baseDir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new HttpError(400, "PATH_OUTSIDE", `${what} "${rel}" nằm ngoài thư mục cho phép`);
  }
  return abs;
}

/** Copy đệ quy file trong một thư mục (dùng cho compositions/ - toàn file text nhẹ) */
function copyDirDeep(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  ensureDir(dstDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) copyDirDeep(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/** Đường dẫn dạng POSIX (meta.json luôn dùng dấu / dù server chạy Windows) */
function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

// ------------------------------------------------------------------ Tạo project con

export interface CreateChildProjectInput {
  /**
   * Project cha - phải tồn tại (ném 404 nếu không). Để null khi nguồn KHÔNG
   * phải project (Auto cut videos cắt từ file rời trong imports/): lúc đó
   * brief bắt đầu từ defaultBrief() thay vì kế thừa cha.
   */
  parentId: string | null;
  name: string;
  width: number;
  height: number;
  fps: number;
  /** Brief đè lên brief của cha (field không khai thì kế thừa cha) */
  brief: Partial<Brief>;
  scenes?: SceneMeta[];
  /** Khối audio mang sang (tái chế tỉ lệ giữ nguyên voice/sfx/nhạc của cha) */
  audio?: ProjectMeta["audio"];
  /** File asset của cha cần mang sang - relPath TRONG assets/ của cha, giữ nguyên cấu trúc thư mục con */
  copyAssets?: string[];
  /** File ngoài assets/ của cha (vd video final trong outputs/) - destRel tính từ assets/ của con */
  copyFiles?: { srcAbs: string; destRel: string }[];
  /** Copy cả compositions/ của cha không (tái chế tỉ lệ: có; cắt short: không) */
  copyCompositions?: boolean;
}

/**
 * Tạo project con hoàn chỉnh (thư mục + meta.json) và trả summary như
 * `POST /api/projects`. Không đụng renders/outputs/props/qc/publish/review/clips
 * của cha - project con luôn bắt đầu ở trạng thái draft sạch.
 */
export function createChildProject(input: CreateChildProjectInput): ProjectSummary {
  // parentId null = nguồn là file rời (Auto cut videos), không có cha để kế thừa
  const parentMeta = input.parentId === null ? null : readMeta(input.parentId);

  const name = input.name.trim();
  if (!name) throw new HttpError(400, "INVALID_NAME", "Thiếu name cho project con");
  if (
    !Number.isInteger(input.width) ||
    input.width <= 0 ||
    !Number.isInteger(input.height) ||
    input.height <= 0
  ) {
    throw new HttpError(400, "INVALID_SIZE", "width/height phải là số nguyên dương");
  }
  if (!Number.isFinite(input.fps) || input.fps <= 0) {
    throw new HttpError(400, "INVALID_FPS", "fps phải là số dương");
  }

  const id = uniqueProjectId(name);
  scaffoldProjectFiles(id, name, input.width, input.height);

  // Không có cha thì các bước "mang từ cha sang" bên dưới đều bỏ qua
  const parentAssetsDir =
    input.parentId === null ? null : projectAssetsDirOf(input.parentId);
  const childAssetsDir = projectAssetsDirOf(id);
  const parentEntries = input.parentId === null ? {} : readAssetEntries(input.parentId);

  // Mô tả + preset màu của asset đi theo file sang project con (assets.json khóa theo basename)
  const carryEntry = (srcBase: string, dstBase: string): void => {
    const e = parentEntries[srcBase];
    if (!e) return;
    writeAssetEntry(id, dstBase, {
      description: e.description,
      colorGrade: e.colorGrade ?? null,
      colorAdjust: e.colorAdjust ?? null,
    });
  };

  // 1) Asset trong assets/ của cha - giữ nguyên đường dẫn con để scenes tham chiếu không lệch
  if (parentAssetsDir !== null) {
    for (const rel of input.copyAssets ?? []) {
      const srcAbs = resolveInside(parentAssetsDir, rel, "Asset");
      if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) continue;
      const relClean = path.relative(parentAssetsDir, srcAbs);
      if (path.basename(relClean) === "assets.json") continue; // metadata, không phải asset
      const dstAbs = path.join(childAssetsDir, relClean);
      bringFile(srcAbs, dstAbs);
      carryEntry(path.basename(srcAbs), path.basename(dstAbs));
    }
  }

  // 2) File ngoài assets/ (video final trong outputs/) - chặn đường dẫn thoát khỏi repo
  for (const f of input.copyFiles ?? []) {
    const srcAbs = path.resolve(f.srcAbs);
    if (!srcAbs.startsWith(path.resolve(repoRoot) + path.sep)) {
      throw new HttpError(400, "PATH_OUTSIDE_REPO", `Đường dẫn "${f.srcAbs}" nằm ngoài repo`);
    }
    if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) continue;
    const dstAbs = resolveInside(childAssetsDir, f.destRel, "Đích asset");
    bringFile(srcAbs, dstAbs);
    carryEntry(path.basename(srcAbs), path.basename(dstAbs));
  }

  // 3) Transcript của cha - AI dựng project con cần lời thoại kèm mốc giây
  const transcript =
    input.parentId === null || parentAssetsDir === null
      ? null
      : readProjectTranscript(input.parentId);
  if (transcript && parentAssetsDir) {
    const srcAbs = path.join(repoRoot, transcript.relPath);
    if (fs.existsSync(srcAbs)) {
      // relPath là repo-relative; đưa về vị trí tương ứng trong assets/ của con
      const relFromAssets = path.relative(parentAssetsDir, srcAbs);
      const dstRel = relFromAssets.startsWith("..")
        ? path.basename(srcAbs) // transcript nằm ngoài assets/ - đặt thẳng vào assets/
        : relFromAssets;
      bringFile(srcAbs, path.join(childAssetsDir, dstRel));
    }
  }

  // 4) compositions/ (tái chế tỉ lệ: giữ scene HTML của cha để dựng lại bố cục)
  if (input.copyCompositions && input.parentId !== null) {
    copyDirDeep(path.join(projectDirOf(input.parentId), "compositions"), path.join(projectDirOf(id), "compositions"));
  }

  // Brief: default → brief của cha (nếu có) → phần đè của người gọi (bỏ field undefined)
  const brief: Brief = {
    ...defaultBrief(),
    ...(parentMeta ? briefOf(parentMeta) : {}),
  };
  for (const [k, v] of Object.entries(input.brief)) {
    if (v === undefined) continue;
    (brief as unknown as Record<string, unknown>)[k] = v;
  }

  const meta: ProjectMeta = {
    id,
    name,
    width: input.width,
    height: input.height,
    fps: input.fps,
    status: "draft",
    // Truy vết nguồn gốc - hữu ích khi xem lại project con sinh từ đâu
    parentId: input.parentId,
    brief,
    scenes: (input.scenes ?? []).map((s) => ({ ...s })),
    audio: input.audio ? JSON.parse(JSON.stringify(input.audio)) : { voice: null, sfx: [] },
    output: null,
    tags: normTags(parentMeta?.tags),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeMeta(id, meta);

  const summary = projectSummaryOf(id);
  if (!summary) {
    throw new HttpError(500, "CHILD_CREATE_FAILED", `Không đọc lại được project con "${id}"`);
  }
  return summary;
}

/** Đường dẫn asset trong meta.json (scenes.srcVideo) từ rel trong assets/ */
export function sceneAssetPath(relInAssets: string): string {
  return `assets/${toPosix(relInAssets)}`;
}

// ------------------------------------------------------------------ Phiên edit AI

/**
 * Soạn prompt edit + tạo chat session cho một project (KHÔNG chạy agent).
 *
 * Tách từ `POST /api/projects/:id/edit` để "cắt short" và "tái chế tỉ lệ" khởi
 * động phiên edit y hệt endpoint đó. Người gọi tự quyết định lúc nào gọi
 * `runAgent(sessionId, prompt)` - nhờ vậy nhiều project con chạy TUẦN TỰ được
 * (mở nhiều phiên agent cùng lúc rất nặng máy).
 */
/**
 * Chép logo của Style Design vào assets của project.
 *
 * VÌ SAO CHÉP CHỨ KHÔNG CHỈ ĐƯA ĐƯỜNG DẪN: agent dựng scene HyperFrames bằng
 * HTML nằm trong `video-projects/<id>/`, và Remotion stage asset từ đúng thư
 * mục assets của project. Đưa một đường dẫn trỏ ra ngoài repo-root thì scene
 * xem thử được nhưng lúc render Remotion không stage -> ảnh 404 (đã dính đúng
 * lỗi này với srcImage). Chép vào assets là logo đi chung đường với mọi ảnh
 * khác, không có đường nào đi lạc.
 *
 * Tên file CỐ ĐỊNH và ghi đè mỗi lần mở phiên: đổi logo trong Style Design rồi
 * chạy lại edit là video dùng logo mới, không phải dọn tay bản cũ.
 *
 * Trả về tên file trong assets, hoặc null nếu style không có logo.
 */
export function syncBrandLogo(id: string, style: StyleDesign | null): string | null {
  const destDir = projectAssetsDirOf(id);
  const srcRel = style?.logoPath ?? null;
  const srcAbs = srcRel ? path.join(repoRoot, srcRel) : null;
  const hasLogo = Boolean(srcAbs && fs.existsSync(srcAbs));
  const ext = srcRel ? path.extname(srcRel).toLowerCase() || ".png" : "";
  const fileName = hasLogo ? `brand-logo${ext}` : "";

  // Dọn bản chép CŨ trước: đổi logo sang định dạng khác (png -> svg) hay gỡ hẳn
  // logo khỏi style mà để lại file cũ thì nó vẫn nằm trong danh sách asset kèm
  // mô tả "BẮT BUỘC dùng" - agent sẽ ngoan ngoãn dùng đúng cái logo đã bị bỏ.
  if (fs.existsSync(destDir)) {
    for (const f of fs.readdirSync(destDir)) {
      if (/^brand-logo\./i.test(f) && f !== fileName) {
        try {
          fs.rmSync(path.join(destDir, f), { force: true });
          writeAssetEntry(id, f, { description: "" });
        } catch {
          /* file đang bị giữ - bỏ qua, vòng sau dọn tiếp */
        }
      }
    }
  }
  if (!hasLogo || !srcAbs || !style) return null;

  ensureDir(destDir);
  const destAbs = path.join(destDir, fileName);
  try {
    fs.copyFileSync(srcAbs, destAbs);
  } catch {
    // Không chép được (file đang bị khóa...) - vẫn để phiên chạy tiếp, phần
    // prompt sẽ tự bỏ khối logo thay vì bắt agent dùng một file không có thật
    return fs.existsSync(destAbs) ? fileName : null;
  }
  // Mô tả để agent đọc asset listing là hiểu ngay đây là gì và phải làm gì
  writeAssetEntry(id, fileName, {
    description:
      `Logo thương hiệu "${style.name}" - BẮT BUỘC dùng đúng file ảnh này khi video cần logo. ` +
      "Không tự vẽ lại, không thay bằng chữ tên thương hiệu.",
  });
  return fileName;
}

/**
 * Cấu hình brief đã resolve cho prompt - dùng chung cho phiên dựng video
 * (prepareEditSession) và lượt chat đầu của trình chỉnh sửa (routes/timeline.ts),
 * để hai prompt luôn thấy CÙNG một Style Design, logo, bộ sfx và thư viện nhạc.
 * Có tác dụng phụ: chép logo của Style Design vào assets/ (syncBrandLogo).
 */
export function briefPromptContextOf(id: string, meta: ProjectMeta): BriefPromptContext {
  const brief = briefOf(meta);
  const recommendedSfx =
    brief.sfxMode === "recommended"
      ? readLibrary().filter(
          (e) => e.tags.includes(RECOMMENDED_TAG) && fs.existsSync(path.join(paths.sfxDir, e.file)),
        )
      : [];
  // Thư viện nhạc nền - chỉ soạn vào prompt khi brief bật nhạc auto
  const music =
    brief.musicMode === "auto"
      ? readMusicLibrary().filter((e) => fs.existsSync(path.join(paths.musicDir, e.file)))
      : [];

  // Style Design cưỡng chế: style đã chọn trong brief hoặc style default
  const style = getStyle(brief.styleId);
  // Chép logo TRƯỚC khi liệt kê asset để nó nằm luôn trong danh sách agent đọc
  const brandLogoFile = syncBrandLogo(id, style);
  return { brief, style, brandLogoFile, recommendedSfx, music };
}

export function prepareEditSession(input: {
  id: string;
  meta: ProjectMeta;
  extraNotes?: string;
  model?: string | null;
  effort?: string | null;
}): { sessionId: string; prompt: string } {
  const { id, meta } = input;
  const ctx = briefPromptContextOf(id, meta);

  const prompt = buildEditPrompt({
    id,
    meta,
    ...ctx,
    assets: listProjectAssets(id),
    extraNotes: input.extraNotes ?? "",
  });

  const sessionId = `sess_${nanoid()}`;
  // goal='final': phiên edit chỉ được coi là hoàn thành khi video final tồn tại thật
  // (agent.ts gate trong finally - xem docs/API.md mục Chat)
  db.createChatSession(
    sessionId,
    `Edit: ${meta.name || id}`,
    id,
    input.model ?? null,
    input.effort ?? null,
    "final",
  );
  return { sessionId, prompt };
}
