/**
 * Hợp đồng kéo-thả giữa cột Thư viện và timeline (THUẦN, không React).
 *
 * Kéo bằng HTML5 drag-and-drop: lúc `dragover` trình duyệt KHÔNG cho đọc dữ liệu
 * (chỉ đọc được danh sách `types`), nên ngoài gói dữ liệu chính còn gắn thêm
 * vài type rỗng đánh dấu track nào nhận được món này - timeline nhìn `types` là
 * biết tô sáng làn nào, khỏi đoán.
 *
 * Nút "+" cạnh từng món (cho người dùng bàn phím) đi chung đường xử lý với thả,
 * chỉ khác vị trí: lấy playhead thay vì con trỏ.
 */

/** Một món kéo được từ thư viện. Đường dẫn project là TƯƠNG ĐỐI thư mục project. */
export type LibraryItem =
  | { source: "project"; kind: "video" | "image" | "audio"; relPath: string; name: string }
  | { source: "sfx"; file: string; name: string }
  | { source: "music"; file: string; name: string };

/** Track nhận thả - trùng giá trị `data-track` của `.tl-row`. */
export type DropTrack = "scene" | "sfx" | "music";

/** Gói dữ liệu chính (JSON của LibraryItem). */
export const LIBRARY_MIME = "application/x-aiev-library";
/** Type đánh dấu track nhận được - type MIME luôn bị trình duyệt hạ chữ thường. */
export const TARGET_MIME: Record<DropTrack, string> = {
  scene: "application/x-aiev-target-scene",
  sfx: "application/x-aiev-target-sfx",
  music: "application/x-aiev-target-music",
};

/** Track mà một món đổ vào được - món đầu tiên là đích của nút "+". */
export function dropTracksOf(item: LibraryItem): DropTrack[] {
  switch (item.source) {
    case "project":
      // Audio của project: mặc định là hiệu ứng âm, thả lên làn Nhạc nền thì thành nhạc
      return item.kind === "audio" ? ["sfx", "music"] : ["scene"];
    case "sfx":
      return ["sfx"];
    case "music":
      return ["music"];
  }
}

/** Track `dataTransfer.types` cho phép thả vào (rỗng = không phải món của thư viện). */
export function acceptedTracks(types: readonly string[]): DropTrack[] {
  if (!types.includes(LIBRARY_MIME)) return [];
  return (Object.keys(TARGET_MIME) as DropTrack[]).filter((k) => types.includes(TARGET_MIME[k]));
}

export function writeDragData(dt: DataTransfer, item: LibraryItem): void {
  dt.setData(LIBRARY_MIME, JSON.stringify(item));
  for (const track of dropTracksOf(item)) dt.setData(TARGET_MIME[track], "1");
  dt.effectAllowed = "copy";
}

export function readDragData(dt: DataTransfer): LibraryItem | null {
  try {
    const raw: unknown = JSON.parse(dt.getData(LIBRARY_MIME));
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    if (o.source === "project" && typeof o.relPath === "string") {
      if (o.kind === "video" || o.kind === "image" || o.kind === "audio") {
        return { source: "project", kind: o.kind, relPath: o.relPath, name };
      }
      return null;
    }
    if ((o.source === "sfx" || o.source === "music") && typeof o.file === "string") {
      return { source: o.source, file: o.file, name };
    }
    return null;
  } catch {
    return null;
  }
}

/** Đích thả/thêm: track + frame (sfx) hoặc vị trí chèn scene. */
export interface DropTarget {
  track: DropTrack;
  /** Frame tuyệt đối (sfx thả đúng chỗ con trỏ) */
  frame: number;
  /** Vị trí chèn trong mảng scenes (track "scene") */
  sceneIndex: number;
}

/** "video-projects/<id>/assets/x.mp4" → "assets/x.mp4" (đường dẫn trong meta). */
export function projectRelPath(repoRel: string, projectId: string): string {
  const norm = repoRel.replace(/\\/g, "/");
  const prefix = `video-projects/${projectId}/`;
  return norm.startsWith(prefix) ? norm.slice(prefix.length) : norm;
}
