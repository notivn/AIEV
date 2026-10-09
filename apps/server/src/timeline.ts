import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { metaPathOf, projectDirOf, readMeta, type ProjectMeta } from "./meta.js";
import { ensureDir, execFileCaptureAll, fileKind, nowIso } from "./util.js";

/**
 * Logic thuần của trình chỉnh sửa video (docs/EDITOR-PLAN.md mục 1-2): tách khóa
 * timeline khỏi meta.json, tính version, validate tay (bám zod của
 * engines/remotion/src/manifest.ts), ghi nguyên tử, lịch sử phiên bản, đo media
 * và dựng file FCP7 XML. Route nằm ở routes/timeline.ts.
 *
 * KHÔNG import zod của engine: khác package, và server không được thêm zod.
 * Hệ quả: sửa schema bên manifest.ts thì PHẢI sửa validator ở đây theo - hai bên
 * lệch nhau là editor lưu được một timeline mà render chết giữa chừng.
 */

// ------------------------------------------------------------------ Khóa timeline

/**
 * Các khóa TOP-LEVEL của meta.json mà editor được ghi. Thứ tự này là một phần
 * của hợp đồng version - đổi thứ tự là mọi version đang cầm trong tab trình
 * duyệt đều thành "xung đột" dù không ai sửa gì.
 */
export const TIMELINE_KEYS = [
  "scenes",
  "audio",
  "captions",
  "subtitles",
  "subtitleStyle",
  "overlays",
] as const;

export type TimelineKey = (typeof TIMELINE_KEYS)[number];

type Obj = Record<string, unknown>;

/** Timeline trả cho client - khóa thiếu đã điền mặc định (xem timelineForClient) */
export interface Timeline {
  scenes: Obj[];
  audio: Obj & { voice: string | null; sfx: Obj[]; music: Obj | null };
  captions: Obj[];
  subtitles: Obj[];
  /** Không có = mặc định của SubtitleTrack. KHÔNG bao giờ null (zod: optional, không nullable) */
  subtitleStyle?: Obj;
  overlays: Obj[];
}

/** Giá trị thô của 6 khóa đúng như trên đĩa - khóa thiếu = null */
export type RawTimeline = Record<TimelineKey, unknown>;

export interface TimelineIssue {
  path: string;
  message: string;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const nonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function rawTimelineOf(meta: ProjectMeta): RawTimeline {
  const out = {} as RawTimeline;
  for (const key of TIMELINE_KEYS) out[key] = meta[key] === undefined ? null : meta[key];
  return out;
}

/**
 * sha1 (16 ký tự hex đầu) của JSON.stringify 6 khóa theo thứ tự cố định, khóa
 * thiếu = null. Đổi brief/tên/status KHÔNG đổi version - nên AI cập nhật status
 * hay người dùng đổi tên project không làm editor báo xung đột oan.
 */
export function versionOfRaw(raw: RawTimeline): string {
  const ordered: Obj = {};
  for (const key of TIMELINE_KEYS) ordered[key] = raw[key] ?? null;
  return crypto.createHash("sha1").update(JSON.stringify(ordered)).digest("hex").slice(0, 16);
}

export function timelineVersion(meta: ProjectMeta): string {
  return versionOfRaw(rawTimelineOf(meta));
}

/**
 * Timeline cho client: khóa thiếu/sai kiểu điền mặc định ([] / {voice:null,
 * sfx:[], music:null}). Object con giữ NGUYÊN (field lạ đi theo) - editor sửa
 * trên bản sao rồi gửi lại cả khóa, nên lọc field ở đây là xóa dữ liệu của agent.
 */
export function timelineForClient(meta: ProjectMeta): Timeline {
  const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
  const audioRaw = isObj(meta.audio) ? (meta.audio as Obj) : {};
  const audio = {
    ...audioRaw,
    voice: typeof audioRaw.voice === "string" ? audioRaw.voice : null,
    sfx: arr(audioRaw.sfx),
    music: isObj(audioRaw.music) ? (audioRaw.music as Obj) : null,
  };
  const out: Timeline = {
    scenes: arr(meta.scenes),
    audio,
    captions: arr(meta.captions),
    subtitles: arr(meta.subtitles),
    overlays: arr(meta.overlays),
  };
  if (isObj(meta.subtitleStyle)) out.subtitleStyle = meta.subtitleStyle as Obj;
  return out;
}

// ------------------------------------------------------------------ Đường dẫn trong project

/**
 * Đường dẫn media trong meta (tương đối thư mục project) → đường dẫn tuyệt đối,
 * hoặc lý do từ chối. Cùng hàng rào với `stage()` của jobs/assemble.ts (resolve
 * rồi so tiền tố project + sep), cộng thêm vài luật chặn sớm để báo lỗi dễ hiểu
 * ngay lúc lưu thay vì đợi tới lúc render:
 *  - tuyệt đối kiểu posix lẫn Windows (`C:\`, `\\server\`), kể cả `C:foo` (tương
 *    đối theo ổ - path.win32.isAbsolute trả false nhưng vẫn thoát khỏi project);
 *  - đoạn `..` ở bất cứ đâu, kể cả khi resolve xong vẫn nằm trong project
 *    (`assets/../assets/x.mp4`): không có lý do chính đáng nào để viết vậy;
 *  - file/thư mục ẩn (`.history/`, `.env`): /media không phát dotfile, và
 *    `.history` là lịch sử nội bộ của editor.
 */
export function resolveProjectPath(
  projectDir: string,
  rel: unknown,
): { abs: string } | { error: string } {
  if (typeof rel !== "string" || !rel) return { error: "đường dẫn phải là chuỗi không rỗng" };
  if (rel.includes("\0")) return { error: "đường dẫn chứa ký tự không hợp lệ" };
  if (
    path.posix.isAbsolute(rel) ||
    path.win32.isAbsolute(rel) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rel)
  ) {
    return { error: "đường dẫn phải TƯƠNG ĐỐI thư mục project (vd assets/x.mp4)" };
  }
  const segs = rel.split(/[\\/]+/);
  if (segs.includes("..")) return { error: 'đường dẫn không được chứa ".."' };
  if (segs.some((s) => s.startsWith(".") && s !== ".")) {
    return { error: "đường dẫn không được trỏ vào file/thư mục ẩn" };
  }
  const root = path.resolve(projectDir);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return { error: "đường dẫn nằm ngoài thư mục project" };
  return { abs };
}

// ------------------------------------------------------------------ Validate

/**
 * Bộ gom lỗi - mỗi lỗi có `path` kiểu `scenes[2].from` để UI chỉ thẳng vào
 * phần tử hỏng. Gom HẾT lỗi thay vì dừng ở lỗi đầu: sửa từng lỗi một qua mỗi
 * lần lưu là trải nghiệm tệ nhất có thể.
 */
class Issues {
  list: TimelineIssue[] = [];
  constructor(private projectDir: string) {}

  add(p: string, message: string): void {
    // Trần 200 lỗi: một mảng captions hỏng cả nghìn cue sẽ đẻ ra response vài MB
    if (this.list.length < 200) this.list.push({ path: p, message });
  }

  /** Số tùy chọn: undefined thì bỏ qua; có thì phải là số hữu hạn trong [min, max] */
  optNum(o: Obj, key: string, p: string, min: number, max = Infinity, exclusiveMin = false): void {
    const v = o[key];
    if (v === undefined) return;
    this.num(v, `${p}.${key}`, min, max, exclusiveMin);
  }

  num(v: unknown, p: string, min: number, max = Infinity, exclusiveMin = false): boolean {
    const okMin = isNum(v) && (exclusiveMin ? v > min : v >= min);
    if (!isNum(v) || !okMin || v > max) {
      const range =
        max === Infinity ? `${exclusiveMin ? ">" : ">="} ${min}` : `trong khoảng ${min}..${max}`;
      this.add(p, `phải là số ${range}`);
      return false;
    }
    return true;
  }

  int(v: unknown, p: string, min: number, exclusiveMin = false): boolean {
    if (!isInt(v) || (exclusiveMin ? v <= min : v < min)) {
      this.add(p, `phải là số nguyên ${exclusiveMin ? ">" : ">="} ${min}`);
      return false;
    }
    return true;
  }

  optStr(o: Obj, key: string, p: string): void {
    if (o[key] !== undefined && typeof o[key] !== "string") this.add(`${p}.${key}`, "phải là chuỗi");
  }

  optBool(o: Obj, key: string, p: string): void {
    if (o[key] !== undefined && typeof o[key] !== "boolean") {
      this.add(`${p}.${key}`, "phải là true/false");
    }
  }

  optEnum(o: Obj, key: string, p: string, values: readonly string[]): void {
    const v = o[key];
    if (v !== undefined && !values.includes(v as string)) {
      this.add(`${p}.${key}`, `phải là một trong: ${values.join(" | ")}`);
    }
  }

  mediaPath(v: unknown, p: string): void {
    const r = resolveProjectPath(this.projectDir, v);
    if ("error" in r) this.add(p, r.error);
  }

  /** from nguyên >= 0 + durationInFrames nguyên dương - chung cho mọi loại cue */
  cueBase(c: Obj, p: string): void {
    this.int(c.from, `${p}.from`, 0);
    this.int(c.durationInFrames, `${p}.durationInFrames`, 0, true);
  }
}

function validateScenes(v: unknown, is: Issues): void {
  if (!Array.isArray(v)) {
    is.add("scenes", "phải là mảng");
    return;
  }
  const seen = new Map<string, number>();
  v.forEach((s, i) => {
    const p = `scenes[${i}]`;
    if (!isObj(s)) {
      is.add(p, "scene phải là object");
      return;
    }
    if (typeof s.id !== "string" || !s.id.trim()) {
      is.add(`${p}.id`, "id phải là chuỗi không rỗng");
    } else if (seen.has(s.id)) {
      is.add(`${p}.id`, `id "${s.id}" trùng với scenes[${seen.get(s.id)}]`);
    } else {
      seen.set(s.id, i);
    }
    // src/srcVideo/render: zod là string().optional() - null KHÔNG hợp lệ;
    // srcImage là string().nullable() nên null được
    for (const key of ["src", "srcVideo", "render"]) {
      if (s[key] === undefined) continue;
      if (typeof s[key] !== "string") is.add(`${p}.${key}`, "phải là chuỗi");
      else if (s[key]) is.mediaPath(s[key], `${p}.${key}`);
    }
    if (s.srcImage !== undefined && s.srcImage !== null) {
      if (typeof s.srcImage !== "string") is.add(`${p}.srcImage`, "phải là chuỗi hoặc null");
      else if (s.srcImage) is.mediaPath(s.srcImage, `${p}.srcImage`);
    }
    is.optNum(s, "from", p, 0);
    is.optNum(s, "to", p, 0);
    if (isNum(s.from) && isNum(s.to) && !(s.to > s.from)) {
      is.add(`${p}.to`, "to phải lớn hơn from");
    }
    if (s.durationInFrames !== undefined) is.int(s.durationInFrames, `${p}.durationInFrames`, 0, true);
    if (s.transitionOverlap !== undefined) is.int(s.transitionOverlap, `${p}.transitionOverlap`, 0);
    is.optBool(s, "muted", p);
    if (s.zoom !== undefined) validateZoom(s.zoom, `${p}.zoom`, is);

    // Nguồn + thời lượng: khớp resolveSceneDurationInFrames của engine - chỉ
    // scene srcVideo có ĐỦ from/to mới được bỏ trống durationInFrames, mọi scene
    // khác thiếu nó là Remotion ném lỗi ngay lúc render.
    const hasSource = ["src", "srcVideo", "srcImage", "render"].some((k) => nonEmptyStr(s[k]));
    const inferable = nonEmptyStr(s.srcVideo) && isNum(s.from) && isNum(s.to);
    if (!hasSource && s.durationInFrames === undefined) {
      is.add(p, "scene cần ít nhất một nguồn (src | srcVideo | srcImage | render) hoặc durationInFrames");
    } else if (s.durationInFrames === undefined && !inferable) {
      is.add(
        `${p}.durationInFrames`,
        "thiếu durationInFrames (chỉ scene srcVideo có đủ from/to mới được bỏ trống)",
      );
    }
  });
}

function validateZoom(v: unknown, p: string, is: Issues): void {
  if (!isObj(v)) {
    is.add(p, "phải là object { origin?, keys[] }");
    return;
  }
  is.optStr(v, "origin", p);
  if (!Array.isArray(v.keys) || v.keys.length < 2) {
    is.add(`${p}.keys`, "phải là mảng có ít nhất 2 mốc");
    return;
  }
  v.keys.forEach((k, i) => {
    const kp = `${p}.keys[${i}]`;
    if (!isObj(k)) {
      is.add(kp, "mốc zoom phải là object");
      return;
    }
    is.num(k.frame, `${kp}.frame`, 0);
    is.num(k.scale, `${kp}.scale`, 0, Infinity, true);
    is.optEnum(k, "ease", kp, ["linear", "out", "inOut"]);
  });
}

function validateAudio(v: unknown, is: Issues): void {
  if (!isObj(v)) {
    is.add("audio", "phải là object { voice, sfx, music }");
    return;
  }
  if (v.voice !== undefined && v.voice !== null) {
    if (typeof v.voice !== "string") is.add("audio.voice", "phải là chuỗi hoặc null");
    else if (v.voice) is.mediaPath(v.voice, "audio.voice");
  }
  if (v.sfx !== undefined) {
    if (!Array.isArray(v.sfx)) {
      is.add("audio.sfx", "phải là mảng");
    } else {
      v.sfx.forEach((x, i) => {
        const p = `audio.sfx[${i}]`;
        if (!isObj(x)) {
          is.add(p, "sfx phải là object");
          return;
        }
        if (!nonEmptyStr(x.file)) is.add(`${p}.file`, "file phải là chuỗi không rỗng");
        else is.mediaPath(x.file, `${p}.file`);
        is.int(x.atFrame, `${p}.atFrame`, 0);
        is.optNum(x, "volume", p, 0, 1);
        is.optNum(x, "mediaStart", p, 0);
      });
    }
  }
  if (v.music !== undefined && v.music !== null) {
    const m = v.music;
    if (!isObj(m)) {
      is.add("audio.music", "phải là object hoặc null");
      return;
    }
    if (!nonEmptyStr(m.file)) is.add("audio.music.file", "file phải là chuỗi không rỗng");
    else is.mediaPath(m.file, "audio.music.file");
    is.optNum(m, "volume", "audio.music", 0, 1);
    is.optNum(m, "duckVolume", "audio.music", 0, 1);
    if (m.speech !== undefined) {
      if (!Array.isArray(m.speech)) {
        is.add("audio.music.speech", "phải là mảng các cặp [giâyBắtĐầu, giâyKếtThúc]");
      } else {
        m.speech.forEach((r, i) => {
          if (!Array.isArray(r) || r.length !== 2 || !isNum(r[0]) || !isNum(r[1])) {
            is.add(`audio.music.speech[${i}]`, "phải là cặp số [giâyBắtĐầu, giâyKếtThúc]");
          }
        });
      }
    }
  }
}

function validateCaptions(v: unknown, is: Issues): void {
  if (!Array.isArray(v)) {
    is.add("captions", "phải là mảng");
    return;
  }
  v.forEach((c, i) => {
    const p = `captions[${i}]`;
    if (!isObj(c)) {
      is.add(p, "cue phải là object");
      return;
    }
    is.cueBase(c, p);
    if (!Array.isArray(c.words) || c.words.length < 1) {
      is.add(`${p}.words`, "phải là mảng có ít nhất 1 từ");
      return;
    }
    c.words.forEach((w, j) => {
      const wp = `${p}.words[${j}]`;
      if (!isObj(w)) {
        is.add(wp, "từ phải là object");
        return;
      }
      if (!nonEmptyStr(w.text)) is.add(`${wp}.text`, "text phải là chuỗi không rỗng");
      is.num(w.start, `${wp}.start`, 0);
      is.num(w.end, `${wp}.end`, 0);
      is.optBool(w, "hi", wp);
    });
  });
}

function validateSubtitles(v: unknown, is: Issues): void {
  if (!Array.isArray(v)) {
    is.add("subtitles", "phải là mảng");
    return;
  }
  v.forEach((c, i) => {
    const p = `subtitles[${i}]`;
    if (!isObj(c)) {
      is.add(p, "cue phải là object");
      return;
    }
    is.cueBase(c, p);
    if (!nonEmptyStr(c.text)) is.add(`${p}.text`, "text phải là chuỗi không rỗng");
  });
}

function validateSubtitleStyle(v: unknown, is: Issues): void {
  if (!isObj(v)) {
    is.add("subtitleStyle", "phải là object (gửi null để xóa)");
    return;
  }
  const p = "subtitleStyle";
  is.optStr(v, "fontFamily", p);
  is.optNum(v, "fontSizePx", p, 0, Infinity, true);
  is.optStr(v, "color", p);
  is.optEnum(v, "backdrop", p, ["blur", "solid", "none"]);
  is.optStr(v, "backdropColor", p);
  is.optNum(v, "blurPx", p, 0);
  is.optNum(v, "bottomPx", p, 0);
}

function validateOverlays(v: unknown, is: Issues): void {
  if (!Array.isArray(v)) {
    is.add("overlays", "phải là mảng");
    return;
  }
  v.forEach((c, i) => {
    const p = `overlays[${i}]`;
    if (!isObj(c)) {
      is.add(p, "cue phải là object");
      return;
    }
    is.cueBase(c, p);
    is.optStr(c, "kicker", p);
    is.optEnum(c, "tier", p, ["main", "sub"]);
    is.optEnum(c, "accent", p, ["hot", "cool"]);
    if (!Array.isArray(c.parts) || c.parts.length < 1) {
      is.add(`${p}.parts`, "phải là mảng có ít nhất 1 phần chữ");
      return;
    }
    c.parts.forEach((part, j) => {
      const pp = `${p}.parts[${j}]`;
      if (!isObj(part)) {
        is.add(pp, "phần chữ phải là object { t, hi? }");
        return;
      }
      if (!nonEmptyStr(part.t)) is.add(`${pp}.t`, "t phải là chuỗi không rỗng");
      is.optBool(part, "hi", pp);
    });
  });
}

/**
 * Validate các khóa CÓ TRONG patch của PUT /timeline (khóa không gửi giữ nguyên
 * trên đĩa và KHÔNG bị soi). Cố ý: meta do agent ghi có thể đang lệch ở một khóa
 * khác - bắt editor sửa luôn khóa đó mới cho lưu là khóa chết người dùng, trong
 * khi editor không làm tình trạng tệ thêm.
 *
 * `subtitleStyle: null` hợp lệ = xóa khóa (zod để optional, không nullable).
 */
export function validateTimelinePatch(patch: Obj, projectDir: string): TimelineIssue[] {
  const is = new Issues(projectDir);
  for (const key of Object.keys(patch)) {
    if (!(TIMELINE_KEYS as readonly string[]).includes(key)) {
      is.add(
        `timeline.${key}`,
        `khóa "${key}" không sửa được qua trình chỉnh sửa (chỉ: ${TIMELINE_KEYS.join(", ")})`,
      );
    }
  }
  if ("scenes" in patch) validateScenes(patch.scenes, is);
  if ("audio" in patch) validateAudio(patch.audio, is);
  if ("captions" in patch) validateCaptions(patch.captions, is);
  if ("subtitles" in patch) validateSubtitles(patch.subtitles, is);
  if ("subtitleStyle" in patch && patch.subtitleStyle !== null) {
    validateSubtitleStyle(patch.subtitleStyle, is);
  }
  if ("overlays" in patch) validateOverlays(patch.overlays, is);
  return is.list;
}

/**
 * Khóa tùy chọn của manifest mà `null` phải hiểu là "không có". zod của engine
 * chỉ điền mặc định (`.default([])`, `.optional()`) cho UNDEFINED - gặp null là
 * từ chối cả manifest, mà agent viết tay meta.json rất hay ghi `"captions": null`
 * hay `"subtitleStyle": null` để nói "không dùng". Trình phát đã hiểu vậy
 * (timelineForClient điền mặc định, PreviewPlayer dùng `??`), nên bản render
 * cũng phải hiểu y hệt - không thì xem trước chạy mà bấm render thì chết.
 * (`audio.music: null` và `audio.voice: null` thì zod nhận sẵn - giữ nguyên.)
 */
const NULL_AS_ABSENT_KEYS = ["audio", "captions", "subtitles", "subtitleStyle", "overlays"] as const;

/**
 * Xóa các khóa `null` ở trên (và `audio.sfx: null`) - SỬA TẠI CHỖ object truyền
 * vào và trả lại chính nó. jobs/assemble.ts gọi trên bản sao props trước khi
 * ghi props.resolved.json; validateTimelineForRender gọi trên bản sao nông để
 * soi đúng thứ sẽ được render.
 */
export function dropNullOptionalKeys<T extends Obj>(m: T): T {
  for (const key of NULL_AS_ABSENT_KEYS) {
    if (m[key] === null) delete m[key];
  }
  if (isObj(m.audio) && m.audio.sfx === null) delete m.audio.sfx;
  return m;
}

/**
 * Validate toàn bộ timeline đang trên đĩa trước khi xếp job render (POST
 * /editor/render): khóa thiếu = mặc định của engine, scenes phải có ít nhất 1.
 * Bắt lỗi ở đây rẻ hơn nhiều so với để Remotion chết sau khi đã render scene.
 *
 * Soi bản ĐÃ chuẩn hóa null giống hệt jobs/assemble.ts (dropNullOptionalKeys):
 * null ở khóa tùy chọn được assemble xóa đi nên ở đây cũng là "thiếu", còn
 * null ở chỗ khác (vd `scenes: null`, `audio.sfx[0]: null`) vẫn báo lỗi đúng chỗ.
 */
export function validateTimelineForRender(meta: ProjectMeta, projectDir: string): TimelineIssue[] {
  const is = new Issues(projectDir);
  const normalized = dropNullOptionalKeys({
    ...(meta as Obj),
    audio: isObj(meta.audio) ? { ...(meta.audio as Obj) } : meta.audio,
  });
  const raw = rawTimelineOf(normalized as ProjectMeta);
  if (raw.scenes === null || (Array.isArray(raw.scenes) && raw.scenes.length === 0)) {
    is.add("scenes", "cần ít nhất 1 scene để render");
  } else {
    validateScenes(raw.scenes, is);
  }
  if (raw.audio !== null) validateAudio(raw.audio, is);
  if (raw.captions !== null) validateCaptions(raw.captions, is);
  if (raw.subtitles !== null) validateSubtitles(raw.subtitles, is);
  if (raw.subtitleStyle !== null) validateSubtitleStyle(raw.subtitleStyle, is);
  if (raw.overlays !== null) validateOverlays(raw.overlays, is);
  return is.list;
}

// ------------------------------------------------------------------ Ghi nguyên tử

/**
 * Ghi JSON nguyên tử: file tạm cùng thư mục rồi rename đè. Ghi thẳng
 * (writeFileSync) mà tiến trình chết giữa chừng là meta.json cụt nửa - mất trắng
 * cả project. Windows: rename đè có thể dính EPERM/EBUSY khi antivirus hay trình
 * index đang mở file - thử lại vài lần, cuối cùng mới ghi thẳng.
 */
export function atomicWriteJson(file: string, data: unknown): void {
  const text = JSON.stringify(data, null, 2) + "\n";
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, text, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retriable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (retriable && attempt < 4) {
        // Chờ đồng bộ ngắn - chỉ xảy ra trên Windows khi file đang bị giữ
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
        continue;
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* bỏ qua */
      }
      if (retriable) {
        fs.writeFileSync(file, text, "utf8");
        return;
      }
      throw err;
    }
  }
}

/**
 * Ghi các khóa timeline vào meta.json, GIỮ NGUYÊN mọi khóa khác.
 *
 * Đọc lại file thô ngay trước khi ghi (không dùng bản meta caller đang cầm): giữa
 * lúc route đọc để so version và lúc ghi không có await nào nên trong tiến trình
 * này không ai chen vào được, nhưng đọc lại vẫn là cách rẻ nhất để chắc chắn
 * không ghi đè một khóa ngoài timeline bằng bản cũ.
 *
 * Giá trị `null` = XÓA khóa (dùng cho subtitleStyle, và khi khôi phục bản lịch
 * sử mà lúc đó khóa chưa tồn tại).
 */
export function writeTimelineKeys(id: string, patch: Partial<Record<TimelineKey, unknown>>): ProjectMeta {
  const meta = readMeta(id);
  for (const key of TIMELINE_KEYS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === null || v === undefined) delete (meta as Obj)[key];
    else (meta as Obj)[key] = v;
  }
  meta.updatedAt = nowIso();
  atomicWriteJson(metaPathOf(id), meta);
  return meta;
}

// ------------------------------------------------------------------ Lịch sử phiên bản

export type RevisionSource = "editor" | "ai-before" | "ai-after" | "restore";

export interface RevisionSummary {
  rev: string;
  createdAt: string;
  label: string | null;
  source: RevisionSource;
  version: string;
}

export interface Revision extends RevisionSummary {
  timeline: RawTimeline;
}

const MAX_REVISIONS = 100;
/**
 * Tự lưu của editor bắn PUT mỗi ~700ms khi đang kéo. Mỗi PUT một bản lịch sử
 * thì 100 bản bị một lần kéo thả nuốt hết, đẩy mất bản "trước khi AI sửa" - thứ
 * người dùng thật sự cần quay lại. Các lần lưu liên tiếp trong cửa sổ này gộp
 * vào bản đầu tiên của loạt (trạng thái TRƯỚC loạt sửa); hoàn tác từng bước
 * nhỏ là việc của undo phía trình duyệt.
 */
const EDITOR_COALESCE_MS = 10_000;
/**
 * Nhãn của lượt "Giữ bản của tôi" (ghi đè bản tab khác/AI vừa lưu). Lượt này
 * KHÔNG BAO GIỜ gộp: snapshot của nó chính là bản của người kia - thứ duy nhất
 * cứu được nếu ghi đè nhầm. Nhãn khác "editor" đã tự phá điều kiện gộp với tự
 * lưu thường, nhưng hai lần ghi đè liên tiếp trong 10s thì cùng nhãn - nên chặn
 * hẳn ở đây. Web gửi đúng chuỗi này (editor/HistoryModal.tsx EDITOR_OVERWRITE_LABEL).
 */
export const EDITOR_OVERWRITE_LABEL = "editor-overwrite";

/**
 * `rev` = thời gian ISO + 4 ký tự ngẫu nhiên, nhưng ":" và "." đổi thành "-":
 * Windows cấm ":" trong tên file, mà rev chính là tên file. Sắp theo tên =
 * sắp theo thời gian.
 */
const REV_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{4}$/;

export function isValidRev(rev: string): boolean {
  return REV_RE.test(rev);
}

function newRev(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(4);
  let suffix = "";
  for (const b of bytes) suffix += alphabet[b % alphabet.length];
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${suffix}`;
}

export function historyDirOf(id: string): string {
  return path.join(projectDirOf(id), ".history");
}

/** File lịch sử không bao giờ sửa sau khi ghi → cache tóm tắt theo đường dẫn là an toàn */
const summaryCache = new Map<string, RevisionSummary>();

function revFiles(id: string): string[] {
  try {
    return fs
      .readdirSync(historyDirOf(id))
      .filter((f) => f.endsWith(".json") && REV_RE.test(f.slice(0, -5)))
      .sort();
  } catch {
    return [];
  }
}

function parseRevision(raw: unknown, rev: string): Revision | null {
  if (!isObj(raw) || !isObj(raw.timeline)) return null;
  const sources: RevisionSource[] = ["editor", "ai-before", "ai-after", "restore"];
  const timeline = {} as RawTimeline;
  for (const key of TIMELINE_KEYS) {
    const v = (raw.timeline as Obj)[key];
    timeline[key] = v === undefined ? null : v;
  }
  return {
    rev,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    label: typeof raw.label === "string" ? raw.label : null,
    source: sources.includes(raw.source as RevisionSource) ? (raw.source as RevisionSource) : "editor",
    version: typeof raw.version === "string" ? raw.version : versionOfRaw(timeline),
    timeline,
  };
}

export function readRevision(id: string, rev: string): Revision | null {
  if (!REV_RE.test(rev)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(historyDirOf(id), `${rev}.json`), "utf8"));
    return parseRevision(raw, rev);
  } catch {
    return null;
  }
}

/** Danh sách bản lịch sử, MỚI NHẤT TRƯỚC. File hỏng bị bỏ qua (không làm sập cả danh sách). */
export function listRevisions(id: string): RevisionSummary[] {
  const out: RevisionSummary[] = [];
  const dir = historyDirOf(id);
  for (const f of revFiles(id).reverse()) {
    const key = path.join(dir, f);
    let summary = summaryCache.get(key);
    if (!summary) {
      const r = readRevision(id, f.slice(0, -5));
      if (!r) continue;
      summary = { rev: r.rev, createdAt: r.createdAt, label: r.label, source: r.source, version: r.version };
      summaryCache.set(key, summary);
    }
    out.push(summary);
  }
  return out;
}

/**
 * Chụp timeline HIỆN TẠI trên đĩa vào `.history/<rev>.json`, giữ 100 bản mới nhất
 * (20 bản ai-before/ai-after mới nhất luôn được giữ - xem pruneHistory).
 * Trả về null khi bỏ qua: bản mới nhất đã cùng version (trạng thái đó đã khôi
 * phục được, chụp nữa chỉ tốn chỗ - vd nhiều lượt AI liên tiếp không sửa gì),
 * hoặc đang trong cửa sổ gộp của tự lưu editor (EDITOR_COALESCE_MS).
 */
export function snapshotTimeline(
  id: string,
  source: RevisionSource,
  label: string | null,
  meta?: ProjectMeta,
): RevisionSummary | null {
  const m = meta ?? readMeta(id);
  const timeline = rawTimelineOf(m);
  const version = versionOfRaw(timeline);
  const newest = listRevisions(id)[0];
  if (newest) {
    if (newest.version === version) return null;
    const age = Date.now() - Date.parse(newest.createdAt);
    if (
      source === "editor" &&
      newest.source === "editor" &&
      newest.label === label &&
      label !== EDITOR_OVERWRITE_LABEL &&
      Number.isFinite(age) &&
      age >= 0 &&
      age < EDITOR_COALESCE_MS
    ) {
      return null;
    }
  }
  const dir = historyDirOf(id);
  ensureDir(dir);
  const rev: Revision = { rev: newRev(), createdAt: nowIso(), label, source, version, timeline };
  atomicWriteJson(path.join(dir, `${rev.rev}.json`), rev);
  pruneHistory(id);
  return { rev: rev.rev, createdAt: rev.createdAt, label, source, version };
}

/**
 * Số bản "ai-before"/"ai-after" mới nhất KHÔNG BAO GIỜ bị dọn. Một buổi kéo thả
 * dài trong editor đẻ đủ 100 bản "editor" (mỗi bản cách nhau > EDITOR_COALESCE_MS)
 * là đủ đẩy rơi điểm khôi phục "trước khi AI sửa" - đúng thứ lịch sử sinh ra để
 * giữ. Nên dọn theo hai ngân sách: tổng vẫn tối đa MAX_REVISIONS, nhưng chỉ xóa
 * bản cũ nhất NGOÀI nhóm được giữ này.
 */
const KEEP_AI_REVISIONS = 20;

function pruneHistory(id: string): void {
  const files = revFiles(id); // cũ nhất trước
  const excess = files.length - MAX_REVISIONS;
  if (excess <= 0) return;
  const dir = historyDirOf(id);
  // listRevisions đọc qua summaryCache - không parse lại cả trăm file mỗi lần chụp
  const sourceOf = new Map(listRevisions(id).map((r) => [`${r.rev}.json`, r.source]));
  const protectedAi = new Set(
    files
      .filter((f) => {
        const s = sourceOf.get(f);
        return s === "ai-before" || s === "ai-after";
      })
      .slice(-KEEP_AI_REVISIONS),
  );
  // File hỏng (không đọc được source) không được bảo vệ - dọn trước như mọi bản thường
  const victims = files.filter((f) => !protectedAi.has(f)).slice(0, excess);
  for (const f of victims) {
    const abs = path.join(dir, f);
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      /* file đang bị giữ - lần sau dọn tiếp */
    }
    summaryCache.delete(abs);
  }
}

/**
 * Hook của agent.ts: phiên AI gắn project BẮT ĐẦU → chụp "ai-before" và trả
 * version lúc đó để so khi kết thúc. KHÔNG BAO GIỜ ném: lịch sử là lưới an toàn
 * phụ, không được phép làm hỏng một lượt chạy AI (đĩa đầy, meta.json hỏng...).
 */
export function agentRunStarted(projectId: string, label: string | null): string | null {
  try {
    const meta = readMeta(projectId);
    snapshotTimeline(projectId, "ai-before", label, meta);
    return timelineVersion(meta);
  } catch (err) {
    console.warn(`[timeline] Không chụp được ai-before cho ${projectId}:`, err);
    return null;
  }
}

/** Hook của agent.ts: phiên AI KẾT THÚC mà version đổi → chụp "ai-after". Không bao giờ ném. */
export function agentRunFinished(
  projectId: string,
  versionBefore: string | null,
  label: string | null,
): void {
  try {
    const meta = readMeta(projectId);
    if (versionBefore !== null && timelineVersion(meta) === versionBefore) return;
    snapshotTimeline(projectId, "ai-after", label, meta);
  } catch (err) {
    console.warn(`[timeline] Không chụp được ai-after cho ${projectId}:`, err);
  }
}

// ------------------------------------------------------------------ Media info (ffprobe, cache theo mtime)

export interface MediaInfo {
  durationSec: number | null;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

interface ProbeJson {
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    disposition?: { attached_pic?: number };
    tags?: Record<string, string>;
    side_data_list?: Array<Record<string, unknown>>;
  }>;
  format?: { duration?: string };
}

const MEDIA_CACHE_MAX = 2000;
const mediaCache = new Map<string, { mtimeMs: number; size: number; info: MediaInfo }>();

/**
 * Đo một file media. null = file không tồn tại; ffprobe hỏng thì vẫn trả
 * `{ durationSec: null }` (và CACHE kết quả đó) - không thì mỗi lần GET timeline
 * lại đốt một lượt ffprobe vào cùng một file hỏng.
 *
 * Cache theo (mtime, size): file render lại/thay thế là đo lại, còn GET timeline
 * gọi liên tục khi AI đang sửa thì không phải spawn ffprobe cho từng file mỗi lần.
 */
export async function probeMediaInfo(abs: string): Promise<MediaInfo | null> {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const hit = mediaCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;

  let info: MediaInfo = { durationSec: null };
  try {
    const { code, stdout } = await execFileCaptureAll(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height:stream_disposition=attached_pic:stream_side_data=rotation:stream_tags=rotate:format=duration",
        "-of",
        "json",
        abs,
      ],
      { timeoutMs: 20_000 },
    );
    if (code === 0) info = parseProbe(JSON.parse(stdout) as ProbeJson, abs);
  } catch {
    /* ffprobe thiếu/hỏng - giữ durationSec null */
  }
  if (mediaCache.size >= MEDIA_CACHE_MAX) {
    const oldest = mediaCache.keys().next().value;
    if (oldest !== undefined) mediaCache.delete(oldest);
  }
  mediaCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, info });
  return info;
}

function parseProbe(data: ProbeJson, abs: string): MediaInfo {
  const streams = data.streams ?? [];
  // Ảnh bìa nhúng trong mp3 hiện ra như một luồng video - không phải hình thật
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const isImage = fileKind(abs) === "image";
  const dur = Number(data.format?.duration);
  const info: MediaInfo = {
    // Ảnh tĩnh: ffprobe báo 0.04s (một frame) - vô nghĩa, ảnh dài bao lâu là do scene quyết
    durationSec: !isImage && Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) / 1000 : null,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
  if (video?.width && video.height) {
    // Cùng luật với reframe.ts probeVideo: video quay dọc bằng điện thoại có cờ
    // xoay ±90 - kích thước THẬT khi phát là đã hoán đổi
    let rotation = 0;
    for (const sd of video.side_data_list ?? []) {
      const r = Number((sd as { rotation?: unknown }).rotation);
      if (Number.isFinite(r) && r !== 0) rotation = r;
    }
    if (rotation === 0) {
      const tag = Number(video.tags?.rotate);
      if (Number.isFinite(tag)) rotation = tag;
    }
    const swap = Math.abs(rotation) % 180 === 90;
    info.width = swap ? video.height : video.width;
    info.height = swap ? video.width : video.height;
  }
  return info;
}

/** Chạy fn trên từng phần tử, tối đa `limit` cái cùng lúc - ffprobe song song vừa phải */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Đo mọi đường dẫn (tương đối project) → map relPath → MediaInfo. Đường dẫn
 * vượt rào bị BỎ QUA (không đo file ngoài project); file không tồn tại →
 * `{ durationSec: null }` để UI vẫn biết đó là file thiếu.
 */
export async function mediaInfoMap(
  projectDir: string,
  rels: string[],
): Promise<Record<string, MediaInfo>> {
  const out: Record<string, MediaInfo> = {};
  const unique = [...new Set(rels)];
  await mapLimit(unique, 4, async (rel) => {
    const r = resolveProjectPath(projectDir, rel);
    if ("error" in r) return;
    out[rel] = (await probeMediaInfo(r.abs)) ?? { durationSec: null };
  });
  return out;
}

/**
 * mtime (ms) của một file trong project - null khi đường dẫn vượt rào, không
 * tồn tại hoặc không phải file thường.
 */
export function projectFileMtimeMs(projectDir: string, rel: unknown): number | null {
  const r = resolveProjectPath(projectDir, rel);
  if ("error" in r) return null;
  try {
    const st = fs.statSync(r.abs);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * Trạng thái file render của một scene HyperFrames (có `src`) - nguồn DUY NHẤT
 * cho trình phát (sceneRenderFor), POST /editor/render (scene nào phải render
 * lại) và jobs/assemble.ts (bản nào được phép lắp). Cùng quy ước đặt tên với
 * jobs/sceneRender.ts: final = scene.render hoặc renders/<id>.mp4, draft = cùng
 * tên đuôi .draft.mp4. `*Mtime` null = file chưa có (hoặc đường dẫn vượt rào).
 *
 * `srcMtime` = mtime của file composition (`src`). Bản render CŨ HƠN nó là bản
 * dựng từ composition trước khi sửa: còn tồn tại không có nghĩa là còn đúng -
 * đã gặp thật: sửa scene, bấm render final, video ra vẫn là nội dung cũ.
 */
export interface SceneRenderState {
  finalRel: string;
  /**
   * Trùng finalRel khi scene.render không đuôi .mp4 (không suy ra được tên bản
   * draft) - khi đó draftMtime = finalMtime: một file đóng cả hai vai, như trước.
   */
  draftRel: string;
  finalMtime: number | null;
  draftMtime: number | null;
  srcMtime: number | null;
}

export function sceneRenderState(projectDir: string, scene: Obj): SceneRenderState {
  const id = typeof scene.id === "string" ? scene.id : "";
  const finalRel = nonEmptyStr(scene.render) ? scene.render : `renders/${id}.mp4`;
  const draftRel = finalRel.replace(/\.mp4$/i, ".draft.mp4");
  const finalMtime = projectFileMtimeMs(projectDir, finalRel);
  return {
    finalRel,
    draftRel,
    finalMtime,
    draftMtime: draftRel === finalRel ? finalMtime : projectFileMtimeMs(projectDir, draftRel),
    srcMtime: projectFileMtimeMs(projectDir, scene.src),
  };
}

/**
 * Bản render có mtime `renderMtime` đã CŨ so với composition chưa? Không biết
 * mtime của src (src thiếu/vượt rào) thì coi như còn mới - không có gì để so,
 * và chặn ở đây là khóa chết những project cũ vẫn render được.
 */
export function isRenderStale(renderMtime: number, st: SceneRenderState): boolean {
  return st.srcMtime !== null && renderMtime < st.srcMtime;
}

/**
 * File render dùng để XEM TRƯỚC một scene HyperFrames. Có cả bản final lẫn
 * .draft.mp4 thì lấy bản MỚI HƠN (mtime): ưu tiên cứng bản final là trình phát
 * cứ chiếu bản final cũ trong khi AI vừa sửa composition và render lại draft
 * (đúng việc prompt của /editor/chat bảo nó làm). Bằng nhau → final (nét hơn).
 * null = chưa render (hoặc scene.render vượt rào).
 */
export function sceneRenderFor(projectDir: string, scene: Obj): string | null {
  const st = sceneRenderState(projectDir, scene);
  if (st.finalMtime !== null && (st.draftMtime === null || st.finalMtime >= st.draftMtime)) {
    return st.finalRel;
  }
  return st.draftMtime !== null ? st.draftRel : null;
}

/** Map sceneId → file xem trước, CHỈ cho scene HyperFrames (có `src`) */
export function sceneRendersOf(projectDir: string, meta: ProjectMeta): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const s of Array.isArray(meta.scenes) ? meta.scenes : []) {
    if (!isObj(s) || !nonEmptyStr(s.src) || typeof s.id !== "string") continue;
    out[s.id] = sceneRenderFor(projectDir, s);
  }
  return out;
}

/**
 * `preview.mediaVersions` của GET timeline: relPath → mtimeMs (số nguyên) cho
 * mọi file media timeline tham chiếu MÀ CÓ TRÊN ĐĨA (khóa y hệt chuỗi trong
 * meta / sceneRenders / watermark.file). Trình phát gắn `?v=<số>` vào URL
 * /media: render lại renders/intro.draft.mp4 thì TÊN file không đổi, không có
 * số này trình duyệt cứ phát bản cũ trong cache.
 */
export function mediaVersionsOf(projectDir: string, rels: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rel of new Set(rels)) {
    const m = projectFileMtimeMs(projectDir, rel);
    if (m !== null) out[rel] = Math.floor(m);
  }
  return out;
}

/** Mọi đường dẫn media timeline tham chiếu (+ file xem trước của scene HyperFrames) */
export function referencedMediaPaths(
  meta: ProjectMeta,
  sceneRenders: Record<string, string | null>,
): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (nonEmptyStr(v)) out.push(v);
  };
  for (const s of Array.isArray(meta.scenes) ? meta.scenes : []) {
    if (!isObj(s)) continue;
    push(s.srcVideo);
    push(s.srcImage);
    // Scene HyperFrames: đo file xem trước thật (render có thể chưa tồn tại)
    if (nonEmptyStr(s.src)) push(typeof s.id === "string" ? sceneRenders[s.id] : null);
    else push(s.render);
  }
  const audio = isObj(meta.audio) ? (meta.audio as Obj) : {};
  push(audio.voice);
  if (Array.isArray(audio.sfx)) for (const x of audio.sfx) if (isObj(x)) push(x.file);
  if (isObj(audio.music)) push(audio.music.file);
  return out;
}

// ------------------------------------------------------------------ Bố cục scene (khớp engine)

export interface SceneSlot {
  scene: Obj;
  /** Frame bắt đầu trên timeline composition */
  start: number;
  /** Số frame scene chiếm */
  duration: number;
}

/**
 * Vị trí từng scene trên timeline - ĐÚNG phép tính của engine
 * (resolveSceneDurationInFrames + totalDurationInFrames) cộng với phép kẹp
 * transitionOverlap của jobs/assemble.ts. Lệch một frame ở đây là file XML mở
 * trong Premiere/DaVinci trượt khỏi bản render.
 */
export function layoutScenes(scenes: Obj[], fps: number): { slots: SceneSlot[]; total: number } {
  const durOf = (s: Obj): number | null => {
    if (isInt(s.durationInFrames) && s.durationInFrames > 0) return s.durationInFrames;
    if (nonEmptyStr(s.srcVideo) && isNum(s.from) && isNum(s.to)) {
      return Math.max(1, Math.round(s.to * fps) - Math.round(s.from * fps));
    }
    return null;
  };
  const slots: SceneSlot[] = [];
  let from = 0;
  let total = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const duration = durOf(s);
    if (duration === null) continue; // scene không có độ dài - engine sẽ báo lỗi, ở đây bỏ qua
    let overlap = isInt(s.transitionOverlap) && s.transitionOverlap > 0 ? s.transitionOverlap : 0;
    const next = i + 1 < scenes.length ? durOf(scenes[i + 1]) : null;
    if (overlap > 0 && next !== null) overlap = Math.min(overlap, Math.max(0, Math.min(duration, next)));
    slots.push({ scene: s, start: from, duration });
    total = Math.max(total, from + duration);
    from += duration - overlap;
  }
  return { slots, total: Math.max(1, total) };
}

// ------------------------------------------------------------------ FCP7 XML (xmeml v5)

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Ký tự điều khiển (trừ tab/xuống dòng) làm XML 1.0 hỏng - NLE từ chối mở cả file
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/**
 * timebase + ntsc từ fps project. fps nguyên (24/25/30/60) → ntsc FALSE. fps
 * kiểu NTSC (23.976, 29.97, 59.94 = n*1000/1001) → timebase làm tròn + ntsc
 * TRUE, vì xmeml chỉ biểu diễn được rate nguyên hoặc nguyên*1000/1001; ghi
 * FALSE với 29.97 là mọi mốc trượt 0.1% (lệch ~3.6s mỗi giờ).
 */
export function xmlRate(fps: number): { timebase: number; ntsc: boolean } {
  const timebase = Math.max(1, Math.round(fps));
  const ntsc = Math.abs(fps - timebase) > 0.001 && Math.abs(fps - (timebase * 1000) / 1001) < 0.01;
  return { timebase, ntsc };
}

export interface Fcp7Input {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  meta: ProjectMeta;
  projectDir: string;
  sceneRenders: Record<string, string | null>;
  media: Record<string, MediaInfo>;
}

/**
 * Dựng FCP7 XML (xmeml version 5) - mở được trong Premiere Pro và DaVinci
 * Resolve. Mọi thời gian tính bằng FRAME theo fps project; đường dẫn file là
 * file:// TUYỆT ĐỐI trên máy chạy server (NLE mở file gốc, không qua staging).
 *
 * Track video: scene (footage có in/out, bản render HyperFrames, ảnh tĩnh).
 * Scene chồng lấn (transitionOverlap) bị cắt thẳng ở mốc scene sau bắt đầu -
 * một track FCP7 không cho hai clip chồng nhau; người dựng tự thêm chuyển cảnh.
 * Track audio: tiếng gốc của footage (nếu không muted), voice, sfx (tự dàn ra
 * nhiều track khi chồng nhau), nhạc nền (lặp lại nếu ngắn hơn video).
 */
export function buildFcp7Xml(input: Fcp7Input): string {
  const { fps, meta, projectDir, sceneRenders, media } = input;
  const { timebase, ntsc } = xmlRate(fps);
  const rateXml = `<rate><timebase>${timebase}</timebase><ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;
  const scenes = (Array.isArray(meta.scenes) ? meta.scenes : []).filter(isObj) as Obj[];
  const { slots, total } = layoutScenes(scenes, fps);
  const audio = isObj(meta.audio) ? (meta.audio as Obj) : {};

  // ---- file: mỗi file định nghĩa đầy đủ MỘT lần, các lần sau chỉ tham chiếu id
  const fileIds = new Map<string, string>();
  const fileXml = (rel: string): string | null => {
    const r = resolveProjectPath(projectDir, rel);
    if ("error" in r) return null;
    const known = fileIds.get(r.abs);
    if (known) return `<file id="${known}"/>`;
    const fid = `file-${fileIds.size + 1}`;
    fileIds.set(r.abs, fid);
    const info = media[rel] ?? { durationSec: null };
    const isImage = fileKind(r.abs) === "image";
    const durFrames = info.durationSec ? Math.max(1, Math.ceil(info.durationSec * fps)) : total;
    const parts: string[] = [];
    if (isImage || info.width) {
      parts.push(
        `<video><samplecharacteristics>${rateXml}` +
          `<width>${info.width ?? input.width}</width><height>${info.height ?? input.height}</height>` +
          `</samplecharacteristics></video>`,
      );
    }
    if (info.hasAudio || (!isImage && !info.width)) {
      parts.push(
        "<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate>" +
          "</samplecharacteristics><channelcount>2</channelcount></audio>",
      );
    }
    return (
      `<file id="${fid}"><name>${escapeXml(path.basename(r.abs))}</name>` +
      `<pathurl>${escapeXml(pathToFileURL(r.abs).href)}</pathurl>${rateXml}` +
      `<duration>${durFrames}</duration><media>${parts.join("")}</media></file>`
    );
  };

  /** Mô tả một clipitem - CHƯA ra XML (xem renderClip) */
  interface ClipSpec {
    name: string;
    rel: string;
    start: number;
    end: number;
    inF: number;
    kind: "video" | "audio";
    level?: number;
  }
  /** null khi clip rỗng hoặc file vượt rào (không bao giờ ghi đường dẫn ngoài project) */
  const clip = (o: ClipSpec): ClipSpec | null => {
    if (o.end <= o.start) return null;
    if ("error" in resolveProjectPath(projectDir, o.rel)) return null;
    return o;
  };

  // XML của clip dựng LƯỜI, đúng thứ tự xuất hiện trong tài liệu: `<file id/>`
  // tham chiếu chỉ hợp lệ SAU chỗ định nghĩa đầy đủ, mà sfx được dàn track theo
  // thời gian chứ không theo thứ tự in ra - dựng ngay lúc tạo là có lúc tham
  // chiếu đứng trước định nghĩa và Premiere báo file offline.
  let clipSeq = 0;
  const renderClip = (o: ClipSpec): string => {
    const file = fileXml(o.rel);
    if (!file) return "";
    clipSeq++;
    const info = media[o.rel] ?? { durationSec: null };
    const fileFrames = info.durationSec
      ? Math.max(1, Math.ceil(info.durationSec * fps))
      : o.inF + (o.end - o.start);
    const levelXml =
      o.level !== undefined
        ? "<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid>" +
          "<effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype>" +
          "<mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name>" +
          `<valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${o.level}</value>` +
          "</parameter></effect></filter>"
        : "";
    const sourceTrack =
      o.kind === "audio"
        ? "<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>"
        : "";
    return (
      `<clipitem id="clipitem-${clipSeq}"><name>${escapeXml(o.name)}</name><enabled>TRUE</enabled>` +
      `<duration>${fileFrames}</duration>${rateXml}<start>${o.start}</start><end>${o.end}</end>` +
      `<in>${o.inF}</in><out>${o.inF + (o.end - o.start)}</out>${file}${sourceTrack}${levelXml}</clipitem>`
    );
  };
  const keep = (c: ClipSpec | null): c is ClipSpec => c !== null;

  // ---- Video: một track, cắt thẳng ở chỗ chồng lấn
  const videoClips: ClipSpec[] = [];
  const footageAudio: ClipSpec[] = [];
  slots.forEach((slot, i) => {
    const s = slot.scene;
    const nextStart = i + 1 < slots.length ? slots[i + 1].start : Infinity;
    const end = Math.min(slot.start + slot.duration, nextStart);
    const name = typeof s.id === "string" ? s.id : `scene-${i + 1}`;
    let v: ClipSpec | null = null;
    if (nonEmptyStr(s.src)) {
      const rel = typeof s.id === "string" ? sceneRenders[s.id] : null;
      if (rel) v = clip({ name, rel, start: slot.start, end, inF: 0, kind: "video" });
    } else if (nonEmptyStr(s.srcVideo)) {
      const inF = isNum(s.from) ? Math.round(s.from * fps) : 0;
      v = clip({ name, rel: s.srcVideo, start: slot.start, end, inF, kind: "video" });
      if (v && s.muted !== true && media[s.srcVideo]?.hasAudio) {
        footageAudio.push({ ...v, kind: "audio" });
      }
    } else if (nonEmptyStr(s.srcImage)) {
      v = clip({ name, rel: s.srcImage, start: slot.start, end, inF: 0, kind: "video" });
    } else if (nonEmptyStr(s.render)) {
      v = clip({ name, rel: s.render, start: slot.start, end, inF: 0, kind: "video" });
    }
    if (v) videoClips.push(v);
  });

  // ---- Audio
  const framesOf = (rel: string): number | null => {
    const d = media[rel]?.durationSec;
    return d ? Math.max(1, Math.round(d * fps)) : null;
  };
  const audioTracks: ClipSpec[][] = [];
  if (footageAudio.length) audioTracks.push(footageAudio);

  if (nonEmptyStr(audio.voice)) {
    const len = framesOf(audio.voice) ?? total;
    const v = clip({ name: "voice", rel: audio.voice, start: 0, end: Math.min(total, len), inF: 0, kind: "audio" });
    if (v) audioTracks.push([v]);
  }

  // SFX: xếp tham lam vào track đầu tiên đã trống tại thời điểm đó (FCP7 không
  // cho hai clip chồng nhau trên một track)
  const sfxTracks: { end: number; clips: ClipSpec[] }[] = [];
  const sfxList = (Array.isArray(audio.sfx) ? audio.sfx : []).filter(isObj) as Obj[];
  const sfxSorted = sfxList
    .filter((x) => nonEmptyStr(x.file) && isInt(x.atFrame) && x.atFrame >= 0)
    .sort((a, b) => (a.atFrame as number) - (b.atFrame as number));
  for (const x of sfxSorted) {
    const rel = x.file as string;
    const start = x.atFrame as number;
    if (start >= total) continue;
    const inF = isNum(x.mediaStart) && x.mediaStart > 0 ? Math.round(x.mediaStart * fps) : 0;
    const len = framesOf(rel);
    // Không đo được độ dài file thì cho 1 giây - đủ để người dựng thấy và kéo lại
    const end = Math.min(total, start + Math.max(1, (len ?? inF + timebase) - inF));
    const level = isNum(x.volume) ? x.volume : 0.3; // mặc định của SfxTrack
    const item = clip({ name: path.basename(rel), rel, start, end, inF, kind: "audio", level });
    if (!item) continue;
    let t = sfxTracks.find((tr) => tr.end <= start);
    if (!t) {
      t = { end: 0, clips: [] };
      sfxTracks.push(t);
    }
    t.clips.push(item);
    t.end = end;
  }
  for (const t of sfxTracks) audioTracks.push(t.clips);

  // Nhạc nền: lặp lại tới hết video như MusicTrack; mức âm = volume (bỏ ducking -
  // người dựng tự vẽ lại keyframe trong NLE nếu cần)
  if (isObj(audio.music) && nonEmptyStr(audio.music.file)) {
    const rel = audio.music.file;
    const len = framesOf(rel) ?? total;
    const level = isNum(audio.music.volume) ? audio.music.volume : 0.35;
    const clips: ClipSpec[] = [];
    for (let start = 0; start < total; start += len) {
      const c = clip({
        name: path.basename(rel),
        rel,
        start,
        end: Math.min(total, start + len),
        inF: 0,
        kind: "audio",
        level,
      });
      if (c) clips.push(c);
    }
    if (clips.length) audioTracks.push(clips);
  }

  const videoFormat =
    `<format><samplecharacteristics>${rateXml}<width>${input.width}</width>` +
    `<height>${input.height}</height><pixelaspectratio>square</pixelaspectratio>` +
    `<fielddominance>none</fielddominance></samplecharacteristics></format>`;
  const audioFormat =
    "<format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate>" +
    "</samplecharacteristics></format>";
  // Dựng theo ĐÚNG thứ tự in: video trước, rồi từng track audio từ trên xuống
  const track = (clips: ClipSpec[]): string =>
    `<track>${clips.filter(keep).map(renderClip).join("")}</track>`;
  const videoXml = `<video>${videoFormat}${track(videoClips)}</video>`;
  const audioXml = `<audio>${audioFormat}${(audioTracks.length ? audioTracks : [[]]).map(track).join("")}</audio>`;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE xmeml>",
    '<xmeml version="5">',
    `<sequence id="sequence-1"><name>${escapeXml(input.name || input.id)}</name>`,
    `<duration>${total}</duration>${rateXml}`,
    `<timecode>${rateXml}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
    "<media>",
    videoXml,
    audioXml,
    "</media>",
    "</sequence>",
    "</xmeml>",
  ];
  return lines.join("\n") + "\n";
}
