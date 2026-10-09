"use client";

/**
 * Inspector - thuộc tính của phần tử đang chọn. Người dùng thấy GIÂY, timeline
 * lưu theo hợp đồng (scene from/to giây; cue, sfx frame tuyệt đối) - đổi đơn vị
 * nằm hết ở đây và ops.ts.
 *
 * Toàn bộ form nằm trong <fieldset disabled> lúc chỉ đọc (AI đang sửa project):
 * một chỗ khóa mọi ô, không ô nào phải tự nhớ.
 */

import {
  Copy,
  Highlighter,
  MousePointerClick,
  Plus,
  RotateCcw,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Field, SwitchField } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { Panel } from "@/components/Panel";
import { Segmented } from "@/components/Segmented";
import {
  SUBTITLE_FONTS,
  type Timeline,
  type TimelineCaptionCue,
  type TimelineHighlightCue,
  type TimelinePreview,
  type TimelineScene,
  type TimelineSfx,
  type TimelineSubtitleCue,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useEditor, type EditOptions } from "./EditorContext";
import { fmtNumber, NumberField, ReadOnlyRow, TextField, VolumeField } from "./fields";
import {
  footageWindow,
  insertCaptionWord,
  insertHighlightPart,
  patchCaptionWord,
  patchHighlightPart,
  patchMusic,
  patchOverlay,
  patchScene,
  patchSfx,
  patchSubtitle,
  readPunchIn,
  removeCaptionWord,
  removeHighlightPart,
  sceneIndexById,
  sceneKind,
  sceneMaxFrames,
  sceneSourcePath,
  setCueDuration,
  setCueStart,
  setFootageWindow,
  setSceneDuration,
  setScenePunchIn,
  setSubtitleStyle,
  setTransitionOverlap,
  type PunchIn,
  type SceneKind,
  type Selection,
} from "./ops";
import { TYPING_COALESCE_MS } from "./store";
import { sceneDurationFrames, type SceneSpan } from "./timing";

export interface InspectorActions {
  split: () => void;
  duplicate: () => void;
  remove: () => void;
  canSplit: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
}

const typing = (key: string): EditOptions => ({ coalesce: key, windowMs: TYPING_COALESCE_MS });

const baseName = (path: string | null | undefined): string =>
  path ? (path.split(/[\\/]/).pop() ?? path) : "";

/** Nhãn loại scene - key i18n tĩnh để cổng check-i18n đếm được. */
export function useSceneKindLabel(): (kind: SceneKind) => string {
  const { t } = useT();
  return (kind) => {
    switch (kind) {
      case "footage":
        return t("editor.scene.kind-footage");
      case "image":
        return t("editor.scene.kind-image");
      case "hyperframes":
        return t("editor.scene.kind-hyperframes");
      case "render":
        return t("editor.scene.kind-render");
      default:
        return t("editor.scene.kind-empty");
    }
  };
}

export function Inspector({
  timeline,
  spans,
  preview,
  actions,
}: {
  timeline: Timeline;
  spans: SceneSpan[];
  preview: TimelinePreview;
  actions: InspectorActions;
}) {
  const { t } = useT();
  const { selection, readOnly } = useEditor();

  let body: ReactNode;
  let title = t("editor.inspector.title");
  if (!selection) {
    body = (
      <EmptyState
        icon={MousePointerClick}
        title={t("editor.inspector.empty-title")}
        description={t("editor.inspector.empty")}
      />
    );
  } else {
    switch (selection.kind) {
      case "scene": {
        const index = sceneIndexById(timeline, selection.id);
        title = t("editor.inspector.scene");
        body =
          index >= 0 ? (
            <SceneForm
              key={selection.id}
              timeline={timeline}
              index={index}
              span={spans[index]}
              preview={preview}
            />
          ) : null;
        break;
      }
      case "caption":
        title = t("editor.inspector.caption");
        body = timeline.captions[selection.index] ? (
          <CaptionForm
            key={`c${selection.index}`}
            index={selection.index}
            cue={timeline.captions[selection.index]}
          />
        ) : null;
        break;
      case "subtitle":
        title = t("editor.inspector.subtitle");
        body = timeline.subtitles[selection.index] ? (
          <SubtitleForm
            key={`s${selection.index}`}
            index={selection.index}
            cue={timeline.subtitles[selection.index]}
            timeline={timeline}
          />
        ) : null;
        break;
      case "overlay":
        title = t("editor.inspector.overlay");
        body = timeline.overlays[selection.index] ? (
          <OverlayForm
            key={`o${selection.index}`}
            index={selection.index}
            cue={timeline.overlays[selection.index]}
          />
        ) : null;
        break;
      case "sfx":
        title = t("editor.inspector.sfx");
        body = timeline.audio.sfx[selection.index] ? (
          <SfxForm
            key={`x${selection.index}`}
            index={selection.index}
            sfx={timeline.audio.sfx[selection.index]}
            preview={preview}
          />
        ) : null;
        break;
      case "music":
        title = t("editor.inspector.music");
        body = timeline.audio.music ? <MusicForm timeline={timeline} preview={preview} /> : null;
        break;
      case "voice":
        title = t("editor.inspector.voice");
        body = <VoiceForm timeline={timeline} preview={preview} />;
        break;
    }
  }

  return (
    <section className="card editor-inspector flex flex-col gap-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {selection && <SelectionActions actions={actions} selection={selection} />}
      </div>
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-3">
        {body}
      </fieldset>
    </section>
  );
}

function SelectionActions({
  actions,
  selection,
}: {
  actions: InspectorActions;
  selection: Selection;
}) {
  const { t } = useT();
  const { readOnly } = useEditor();
  if (selection.kind === "voice") return null;
  return (
    <div className="flex items-center gap-1">
      {selection.kind !== "music" && (
        <>
          <IconButton
            label={t("editor.action.split")}
            disabled={readOnly || !actions.canSplit}
            onClick={actions.split}
          >
            <Scissors size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label={t("editor.action.duplicate")}
            disabled={readOnly || !actions.canDuplicate}
            onClick={actions.duplicate}
          >
            <Copy size={16} strokeWidth={1.75} />
          </IconButton>
        </>
      )}
      <IconButton
        label={t("editor.action.delete")}
        tone="danger"
        disabled={readOnly || !actions.canDelete}
        onClick={actions.remove}
      >
        <Trash2 size={16} strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}

// ================================================================ scene

function SceneForm({
  timeline,
  index,
  span,
  preview,
}: {
  timeline: Timeline;
  index: number;
  span: SceneSpan | undefined;
  preview: TimelinePreview;
}) {
  const { t, tf } = useT();
  const { fps, ops, edit } = useEditor();
  const kindLabel = useSceneKindLabel();
  const scene: TimelineScene = timeline.scenes[index];
  const kind = sceneKind(scene);
  const source = sceneSourcePath(scene);
  const render = ops.sceneRender(scene);
  const duration = sceneDurationFrames(scene, fps);
  const sid = `scene-${index}`;
  const key = (field: string) => typing(`scene:${scene.id}:${field}`);
  const isLast = index === timeline.scenes.length - 1;
  const next = timeline.scenes[index + 1];
  const nextDuration = next ? sceneDurationFrames(next, fps) : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="muted" dot={false} label={kindLabel(kind)} />
        <span className="min-w-0 text-meta text-[var(--text-muted)] [overflow-wrap:anywhere]">
          {tf("editor.scene.id", { id: scene.id })}
        </span>
      </div>

      {source && (
        <ReadOnlyRow label={t("editor.scene.source")}>
          <span className="text-meta">{source}</span>
          {kind === "footage" && scene.srcVideo && (
            <MediaLength path={scene.srcVideo} preview={preview} />
          )}
        </ReadOnlyRow>
      )}
      {(kind === "hyperframes" || kind === "render") && (
        <ReadOnlyRow label={t("editor.scene.preview-file")}>
          {render ? (
            <span className="text-meta">
              {render}
              <MediaLength path={render} preview={preview} />
            </span>
          ) : (
            <span className="text-meta text-[var(--text-muted)]">{t("editor.scene.not-rendered")}</span>
          )}
        </ReadOnlyRow>
      )}

      {span && (
        <p className="text-meta text-[var(--text-muted)]">
          {tf("editor.scene.position", {
            start: fmtNumber(span.start / fps),
            end: fmtNumber(span.end / fps),
          })}
        </p>
      )}

      {kind === "footage" ? (
        <FootageWindowFields timeline={timeline} index={index} idPrefix={sid} />
      ) : (
        <NumberField
          id={`${sid}-dur`}
          label={t("editor.scene.duration")}
          unit="s"
          value={(duration ?? 0) / fps}
          min={1 / fps}
          max={(() => {
            const max = sceneMaxFrames(scene, ops);
            return max === null ? Number.POSITIVE_INFINITY : Math.max(max, duration ?? 0) / fps;
          })()}
          hint={
            kind === "hyperframes" || kind === "render"
              ? t("editor.scene.duration-hint-hf")
              : undefined
          }
          onCommit={(sec) =>
            edit((tl) => setSceneDuration(tl, index, Math.round(sec * fps), ops), key("dur"))
          }
        />
      )}

      {kind === "footage" && (
        <SwitchField
          id={`${sid}-muted`}
          label={t("editor.scene.muted")}
          hint={t("editor.scene.muted-hint")}
          checked={scene.muted === true}
          onChange={(v) => edit((tl) => patchScene(tl, index, { muted: v ? true : undefined }))}
        />
      )}

      <NumberField
        id={`${sid}-overlap`}
        label={t("editor.scene.transition")}
        unit="s"
        value={(scene.transitionOverlap ?? 0) / fps}
        min={0}
        max={
          isLast || duration === null || nextDuration === null
            ? Number.POSITIVE_INFINITY
            : Math.min(duration, nextDuration) / fps
        }
        disabled={isLast}
        hint={isLast ? t("editor.scene.transition-last") : t("editor.scene.transition-hint")}
        onCommit={(sec) =>
          edit((tl) => setTransitionOverlap(tl, index, Math.round(sec * fps)), key("overlap"))
        }
      />

      <PunchInFields scene={scene} index={index} idPrefix={sid} />
    </>
  );
}

function MediaLength({ path, preview }: { path: string; preview: TimelinePreview }) {
  const { tf } = useT();
  const sec = preview.media[path]?.durationSec;
  if (typeof sec !== "number") return null;
  return (
    <span className="text-meta text-[var(--text-muted)]">
      {" · "}
      {tf("editor.media.length", { sec: fmtNumber(sec) })}
    </span>
  );
}

function FootageWindowFields({
  timeline,
  index,
  idPrefix,
}: {
  timeline: Timeline;
  index: number;
  idPrefix: string;
}) {
  const { t, tf } = useT();
  const { fps, ops, edit } = useEditor();
  const scene = timeline.scenes[index];
  const win = footageWindow(scene, fps);
  const mediaSec = scene.srcVideo ? ops.mediaDurationSec(scene.srcVideo) : null;
  if (!win) {
    return <Banner tone="danger" message={t("editor.scene.no-window")} />;
  }
  const max = mediaSec ?? Number.POSITIVE_INFINITY;
  const key = (field: string) => typing(`scene:${scene.id}:${field}`);
  return (
    <div className="grid grid-cols-2 gap-3">
      <NumberField
        id={`${idPrefix}-in`}
        label={t("editor.scene.in")}
        unit="s"
        value={win.inFrame / fps}
        min={0}
        max={Math.max(0, max - 1 / fps)}
        validate={(v) =>
          Math.round(v * fps) >= win.outFrame ? t("editor.scene.in-after-out") : null
        }
        onCommit={(sec) =>
          edit((tl) => setFootageWindow(tl, index, Math.round(sec * fps), win.outFrame, ops), key("in"))
        }
      />
      <NumberField
        id={`${idPrefix}-out`}
        label={t("editor.scene.out")}
        unit="s"
        value={win.outFrame / fps}
        min={1 / fps}
        max={max}
        hint={tf("editor.scene.length", { sec: fmtNumber((win.outFrame - win.inFrame) / fps) })}
        validate={(v) =>
          Math.round(v * fps) <= win.inFrame ? t("editor.scene.out-before-in") : null
        }
        onCommit={(sec) =>
          edit((tl) => setFootageWindow(tl, index, win.inFrame, Math.round(sec * fps), ops), key("out"))
        }
      />
    </div>
  );
}

const DEFAULT_PUNCH: PunchIn = { startScale: 1, endScale: 1.12, ease: "out" };

function PunchInFields({
  scene,
  index,
  idPrefix,
}: {
  scene: TimelineScene;
  index: number;
  idPrefix: string;
}) {
  const { t, tf } = useT();
  const { ops, edit } = useEditor();
  const current = readPunchIn(scene);
  const punch = current?.punch ?? DEFAULT_PUNCH;
  const key = (field: string) => typing(`scene:${scene.id}:zoom-${field}`);
  const write = (next: PunchIn, field: string) =>
    edit((tl) => setScenePunchIn(tl, index, next, ops), key(field));

  return (
    <Panel title={t("editor.zoom.title")}>
      <SwitchField
        id={`${idPrefix}-zoom`}
        label={t("editor.zoom.enable")}
        hint={t("editor.zoom.hint")}
        checked={current !== null}
        onChange={(on) => edit((tl) => setScenePunchIn(tl, index, on ? DEFAULT_PUNCH : null, ops))}
      />
      {current && (
        <>
          {current.custom && (
            <p className="text-meta text-[var(--text-muted)]">
              {tf("editor.zoom.custom", { n: scene.zoom?.keys.length ?? 0 })}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              id={`${idPrefix}-zoom-start`}
              label={t("editor.zoom.start")}
              unit="×"
              value={punch.startScale}
              min={0.5}
              max={4}
              step={0.01}
              onCommit={(v) => write({ ...punch, startScale: v }, "start")}
            />
            <NumberField
              id={`${idPrefix}-zoom-end`}
              label={t("editor.zoom.end")}
              unit="×"
              value={punch.endScale}
              min={0.5}
              max={4}
              step={0.01}
              onCommit={(v) => write({ ...punch, endScale: v }, "end")}
            />
          </div>
          <Field label={t("editor.zoom.ease")}>
            <Segmented
              label={t("editor.zoom.ease")}
              value={punch.ease}
              onChange={(ease) => write({ ...punch, ease }, "ease")}
              options={[
                { value: "linear", label: t("editor.zoom.ease-linear") },
                { value: "out", label: t("editor.zoom.ease-out") },
                { value: "inOut", label: t("editor.zoom.ease-inout") },
              ]}
            />
          </Field>
        </>
      )}
    </Panel>
  );
}

// ================================================================ cue chung

function CueTimingFields({
  kind,
  index,
  from,
  duration,
  idPrefix,
}: {
  kind: "captions" | "subtitles" | "overlays";
  index: number;
  from: number;
  duration: number;
  idPrefix: string;
}) {
  const { t } = useT();
  const { fps, edit } = useEditor();
  const key = (field: string) => typing(`${kind}:${index}:${field}`);
  return (
    <div className="grid grid-cols-2 gap-3">
      <NumberField
        id={`${idPrefix}-start`}
        label={t("editor.cue.start")}
        unit="s"
        value={from / fps}
        min={0}
        onCommit={(sec) => edit((tl) => setCueStart(tl, kind, index, Math.round(sec * fps)), key("start"))}
      />
      <NumberField
        id={`${idPrefix}-dur`}
        label={t("editor.cue.duration")}
        unit="s"
        value={duration / fps}
        min={1 / fps}
        onCommit={(sec) =>
          edit((tl) => setCueDuration(tl, kind, index, Math.max(1, Math.round(sec * fps))), key("dur"))
        }
      />
    </div>
  );
}

// ================================================================ karaoke

function CaptionForm({ index, cue }: { index: number; cue: TimelineCaptionCue }) {
  const { t, tf } = useT();
  const { fps, edit } = useEditor();
  const [wordIndex, setWordIndex] = useState(0);
  const safeIndex = Math.min(wordIndex, cue.words.length - 1);
  const word = cue.words[safeIndex];
  const id = `cap-${index}`;
  const key = (field: string) => typing(`captions:${index}:w${safeIndex}:${field}`);
  const cueEnd = cue.from + cue.durationInFrames;

  useEffect(() => {
    if (wordIndex !== safeIndex) setWordIndex(safeIndex);
  }, [wordIndex, safeIndex]);

  return (
    <>
      <CueTimingFields
        kind="captions"
        index={index}
        from={cue.from}
        duration={cue.durationInFrames}
        idPrefix={id}
      />
      <Field label={t("editor.caption.words")} hint={t("editor.caption.words-hint")}>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("editor.caption.words")}>
          {cue.words.map((w, i) => (
            <button
              key={i}
              type="button"
              className={`word-chip ${w.hi ? "is-hi" : ""}`}
              aria-pressed={i === safeIndex}
              onClick={() => setWordIndex(i)}
            >
              {w.text}
            </button>
          ))}
        </div>
      </Field>
      {word && (
        <Panel
          title={tf("editor.caption.word-n", { n: safeIndex + 1, total: cue.words.length })}
          actions={
            <div className="flex items-center gap-1">
              <IconButton
                label={t("editor.caption.add-word")}
                onClick={() => {
                  edit((tl) => insertCaptionWord(tl, index, safeIndex, t("editor.caption.new-word")));
                  setWordIndex(safeIndex + 1);
                }}
              >
                <Plus size={16} strokeWidth={1.75} />
              </IconButton>
              <IconButton
                label={t("editor.caption.remove-word")}
                tone="danger"
                disabled={cue.words.length <= 1}
                onClick={() => edit((tl) => removeCaptionWord(tl, index, safeIndex))}
              >
                <Trash2 size={16} strokeWidth={1.75} />
              </IconButton>
            </div>
          }
        >
          <TextField
            id={`${id}-w-text`}
            label={t("editor.caption.word-text")}
            value={word.text}
            onCommit={(text) => edit((tl) => patchCaptionWord(tl, index, safeIndex, { text }), key("text"))}
          />
          <SwitchField
            id={`${id}-w-hi`}
            label={t("editor.caption.word-hi")}
            hint={t("editor.caption.word-hi-hint")}
            checked={word.hi === true}
            onChange={(on) =>
              edit((tl) => patchCaptionWord(tl, index, safeIndex, { hi: on ? true : undefined }))
            }
          />
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              id={`${id}-w-start`}
              label={t("editor.caption.word-start")}
              unit="s"
              value={word.start / fps}
              min={cue.from / fps}
              max={cueEnd / fps}
              validate={(v) =>
                Math.round(v * fps) > word.end ? t("editor.caption.start-after-end") : null
              }
              onCommit={(sec) =>
                edit((tl) => patchCaptionWord(tl, index, safeIndex, { start: Math.round(sec * fps) }), key("start"))
              }
            />
            <NumberField
              id={`${id}-w-end`}
              label={t("editor.caption.word-end")}
              unit="s"
              value={word.end / fps}
              min={cue.from / fps}
              max={cueEnd / fps}
              validate={(v) =>
                Math.round(v * fps) < word.start ? t("editor.caption.end-before-start") : null
              }
              onCommit={(sec) =>
                edit((tl) => patchCaptionWord(tl, index, safeIndex, { end: Math.round(sec * fps) }), key("end"))
              }
            />
          </div>
        </Panel>
      )}
    </>
  );
}

// ================================================================ phụ đề

function SubtitleForm({
  index,
  cue,
  timeline,
}: {
  index: number;
  cue: TimelineSubtitleCue;
  timeline: Timeline;
}) {
  const { t } = useT();
  const { edit, vertical } = useEditor();
  const id = `sub-${index}`;
  const style = timeline.subtitleStyle ?? {};
  const styleKey = (field: string) => typing(`subtitleStyle:${field}`);
  const fonts = SUBTITLE_FONTS;
  const fontLabel = (f: (typeof SUBTITLE_FONTS)[number]): string => {
    switch (f) {
      case "vietnamese":
        return t("tv.font.vietnamese");
      case "sans":
        return t("tv.font.sans");
      case "serif":
        return t("tv.font.serif");
      case "mono":
        return t("tv.font.mono");
    }
  };
  const font = typeof style.fontFamily === "string" ? style.fontFamily : "vietnamese";

  return (
    <>
      <TextField
        id={`${id}-text`}
        label={t("editor.subtitle.text")}
        hint={t("editor.subtitle.text-hint")}
        multiline
        value={cue.text}
        onCommit={(text) => edit((tl) => patchSubtitle(tl, index, { text }), typing(`subtitles:${index}:text`))}
      />
      <CueTimingFields
        kind="subtitles"
        index={index}
        from={cue.from}
        duration={cue.durationInFrames}
        idPrefix={id}
      />
      <Panel
        title={t("editor.subtitle.style")}
        actions={
          timeline.subtitleStyle ? (
            <Button variant="secondary" small onClick={() => edit((tl) => setSubtitleStyle(tl, null))}>
              <RotateCcw size={14} strokeWidth={2} />
              {t("editor.subtitle.style-reset")}
            </Button>
          ) : undefined
        }
      >
        <p className="text-meta text-[var(--text-muted)]">{t("editor.subtitle.style-hint")}</p>
        <Field label={t("tv.font")} htmlFor={`${id}-font`}>
          <select
            id={`${id}-font`}
            className="input"
            value={font}
            onChange={(e) => edit((tl) => setSubtitleStyle(tl, { fontFamily: e.target.value }))}
          >
            {!fonts.some((f) => f === font) && <option value={font}>{font}</option>}
            {fonts.map((f) => (
              <option key={f} value={f}>
                {fontLabel(f)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("tv.backdrop")}>
          <Segmented
            label={t("tv.backdrop")}
            value={style.backdrop ?? "blur"}
            onChange={(backdrop) => edit((tl) => setSubtitleStyle(tl, { backdrop }))}
            options={[
              { value: "blur", label: t("tv.backdrop.blur") },
              { value: "solid", label: t("tv.backdrop.solid") },
              { value: "none", label: t("tv.backdrop.none") },
            ]}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            id={`${id}-size`}
            label={t("editor.subtitle.size")}
            unit="px"
            digits={0}
            step={1}
            value={typeof style.fontSizePx === "number" ? style.fontSizePx : 62}
            min={16}
            max={160}
            onCommit={(v) => edit((tl) => setSubtitleStyle(tl, { fontSizePx: Math.round(v) }), styleKey("size"))}
          />
          <NumberField
            id={`${id}-bottom`}
            label={t("editor.subtitle.bottom")}
            unit="px"
            digits={0}
            step={1}
            value={typeof style.bottomPx === "number" ? style.bottomPx : vertical ? 320 : 130}
            min={0}
            max={600}
            onCommit={(v) => edit((tl) => setSubtitleStyle(tl, { bottomPx: Math.round(v) }), styleKey("bottom"))}
          />
        </div>
      </Panel>
    </>
  );
}

// ================================================================ highlight

function OverlayForm({ index, cue }: { index: number; cue: TimelineHighlightCue }) {
  const { t, tf } = useT();
  const { edit } = useEditor();
  const id = `ov-${index}`;
  const key = (field: string) => typing(`overlays:${index}:${field}`);

  return (
    <>
      <TextField
        id={`${id}-kicker`}
        label={t("editor.overlay.kicker")}
        hint={t("editor.overlay.kicker-hint")}
        required={false}
        value={cue.kicker ?? ""}
        onCommit={(kicker) =>
          edit((tl) => patchOverlay(tl, index, { kicker: kicker.trim() ? kicker : undefined }), key("kicker"))
        }
      />
      <Field label={t("editor.overlay.parts")} hint={t("editor.overlay.parts-hint")}>
        <div className="flex flex-col gap-2">
          {cue.parts.map((part, i) => (
            <PartRow key={i} cueIndex={index} partIndex={i} text={part.t} hi={part.hi === true} canRemove={cue.parts.length > 1} label={tf("editor.overlay.part-n", { n: i + 1 })} />
          ))}
          <div>
            <Button
              variant="secondary"
              small
              onClick={() =>
                edit((tl) => insertHighlightPart(tl, index, cue.parts.length - 1, t("editor.overlay.new-part")))
              }
            >
              <Plus size={14} strokeWidth={2} />
              {t("editor.overlay.add-part")}
            </Button>
          </div>
        </div>
      </Field>
      <div className="flex flex-col gap-3">
        <Field label={t("editor.overlay.tier")}>
          <Segmented
            label={t("editor.overlay.tier")}
            value={cue.tier ?? "main"}
            onChange={(tier) => edit((tl) => patchOverlay(tl, index, { tier }))}
            options={[
              { value: "main", label: t("editor.overlay.tier-main") },
              { value: "sub", label: t("editor.overlay.tier-sub") },
            ]}
          />
        </Field>
        <Field label={t("editor.overlay.accent")}>
          <Segmented
            label={t("editor.overlay.accent")}
            value={cue.accent ?? "hot"}
            onChange={(accent) => edit((tl) => patchOverlay(tl, index, { accent }))}
            options={[
              { value: "hot", label: t("editor.overlay.accent-hot") },
              { value: "cool", label: t("editor.overlay.accent-cool") },
            ]}
          />
        </Field>
      </div>
      <CueTimingFields
        kind="overlays"
        index={index}
        from={cue.from}
        duration={cue.durationInFrames}
        idPrefix={id}
      />
    </>
  );
}

function PartRow({
  cueIndex,
  partIndex,
  text,
  hi,
  canRemove,
  label,
}: {
  cueIndex: number;
  partIndex: number;
  text: string;
  hi: boolean;
  canRemove: boolean;
  label: string;
}) {
  const { t } = useT();
  const { edit, endCoalesce } = useEditor();
  const [value, setValue] = useState(text);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState(false);
  const [synced, setSynced] = useState(text);
  if (!focused && text !== synced) {
    setSynced(text);
    setValue(text);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input
          className="input min-w-0 flex-1"
          aria-label={label}
          aria-invalid={error || undefined}
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setError(false);
            setValue(text);
            endCoalesce();
          }}
          onChange={(e) => {
            setValue(e.target.value);
            if (e.target.value === "") {
              setError(true);
              return;
            }
            setError(false);
            const next = e.target.value;
            edit((tl) => patchHighlightPart(tl, cueIndex, partIndex, { t: next }), typing(`overlays:${cueIndex}:p${partIndex}`));
          }}
        />
        <IconButton
          label={t("editor.overlay.part-hi")}
          aria-pressed={hi}
          className={hi ? "text-[var(--primary)]" : ""}
          onClick={() =>
            edit((tl) => patchHighlightPart(tl, cueIndex, partIndex, { hi: hi ? undefined : true }))
          }
        >
          <Highlighter size={16} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label={t("editor.overlay.remove-part")}
          tone="danger"
          disabled={!canRemove}
          onClick={() => edit((tl) => removeHighlightPart(tl, cueIndex, partIndex))}
        >
          <X size={16} strokeWidth={1.75} />
        </IconButton>
      </div>
      {error && <p className="text-meta text-[var(--danger)]">{t("editor.field.required")}</p>}
    </div>
  );
}

// ================================================================ âm thanh

function SfxForm({ index, sfx, preview }: { index: number; sfx: TimelineSfx; preview: TimelinePreview }) {
  const { t } = useT();
  const { fps, edit } = useEditor();
  const id = `sfx-${index}`;
  const key = (field: string) => typing(`sfx:${index}:${field}`);
  const mediaSec = preview.media[sfx.file]?.durationSec ?? null;
  return (
    <>
      <ReadOnlyRow label={t("editor.audio.file")}>
        <span className="text-meta">{sfx.file}</span>
        <MediaLength path={sfx.file} preview={preview} />
      </ReadOnlyRow>
      <NumberField
        id={`${id}-at`}
        label={t("editor.sfx.at")}
        unit="s"
        value={sfx.atFrame / fps}
        min={0}
        onCommit={(sec) => edit((tl) => patchSfx(tl, index, { atFrame: Math.max(0, Math.round(sec * fps)) }), key("at"))}
      />
      <VolumeField
        id={`${id}-vol`}
        label={t("editor.audio.volume")}
        hint={sfx.volume === undefined ? t("editor.sfx.volume-default") : undefined}
        value={sfx.volume ?? 0.3}
        onCommit={(volume) => edit((tl) => patchSfx(tl, index, { volume }), key("vol"))}
      />
      <NumberField
        id={`${id}-skip`}
        label={t("editor.sfx.media-start")}
        hint={t("editor.sfx.media-start-hint")}
        unit="s"
        value={sfx.mediaStart ?? 0}
        min={0}
        max={mediaSec ?? Number.POSITIVE_INFINITY}
        onCommit={(sec) =>
          edit((tl) => patchSfx(tl, index, { mediaStart: sec > 0 ? Math.round(sec * 1000) / 1000 : undefined }), key("skip"))
        }
      />
    </>
  );
}

function MusicForm({ timeline, preview }: { timeline: Timeline; preview: TimelinePreview }) {
  const { t, tf } = useT();
  const { edit } = useEditor();
  const music = timeline.audio.music;
  if (!music) return null;
  return (
    <>
      <ReadOnlyRow label={t("editor.audio.file")}>
        <span className="text-meta">{music.file}</span>
        <MediaLength path={music.file} preview={preview} />
      </ReadOnlyRow>
      <VolumeField
        id="music-vol"
        label={t("editor.music.volume")}
        hint={t("editor.music.volume-hint")}
        value={music.volume ?? 0.35}
        onCommit={(volume) => edit((tl) => patchMusic(tl, { volume }), typing("music:vol"))}
      />
      <VolumeField
        id="music-duck"
        label={t("editor.music.duck")}
        hint={t("editor.music.duck-hint")}
        value={music.duckVolume ?? 0.12}
        onCommit={(duckVolume) => edit((tl) => patchMusic(tl, { duckVolume }), typing("music:duck"))}
      />
      <p className="text-meta text-[var(--text-muted)]">
        {tf("editor.music.speech", { n: Array.isArray(music.speech) ? music.speech.length : 0 })}
      </p>
    </>
  );
}

function VoiceForm({ timeline, preview }: { timeline: Timeline; preview: TimelinePreview }) {
  const { t } = useT();
  const voice = timeline.audio.voice;
  if (!voice) return null;
  return (
    <>
      <ReadOnlyRow label={t("editor.audio.file")}>
        <span className="text-meta">{baseName(voice)}</span>
        <MediaLength path={voice} preview={preview} />
      </ReadOnlyRow>
      <p className="text-meta text-[var(--text-muted)]">{t("editor.voice.hint")}</p>
    </>
  );
}
