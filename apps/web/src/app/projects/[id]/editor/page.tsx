"use client";

/**
 * Trình chỉnh sửa video của một project - xem trước bằng Remotion Player,
 * timeline nhiều track, inspector, chat AI ở panel phải. Toàn bộ logic nằm ở
 * components/editor/ (xem VideoEditor.tsx); trang chỉ lấy id từ URL.
 */

import { useParams } from "next/navigation";
import { VideoEditor } from "@/components/editor/VideoEditor";

export default function ProjectEditorPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";
  // key: đổi project là dựng lại editor từ đầu (store, playhead, lịch sử hoàn tác)
  return <VideoEditor key={id} projectId={id} />;
}
