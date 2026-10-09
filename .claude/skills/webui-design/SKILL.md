---
name: webui-design
description: Design system for the AI Edit Video web dashboard (noti.vn) - the three-step type scale, light/dark color tokens, the component primitives every page must use, Inter font, SVG icons, Shopify Admin style layout. MUST read before writing or modifying any UI in apps/web.
---

# Web UI Design System - AI Edit Video by noti.vn

The web UI is a **monitoring and management dashboard** with one exception: the **video editor** at `/projects/[id]/editor` (preview player + timeline + inspector + AI chat, see `docs/EDITOR-PLAN.md` and section 12). Aesthetic standard everywhere, the editor included: Shopify Admin - minimal, high information density but still airy, every element has a reason to exist.

**Enforcement:** `cd apps/web && node scripts/check-design-system.mjs`. It flags off-scale type sizes, off-rhythm spacing, raw colors, and hand-rolled copies of existing primitives. Run it before you claim a UI change is done.

## 1. The type scale - three steps, no fourth

This is the single rule that decides whether the dashboard reads clean or noisy, so it comes first.

| Class | Size | Role |
|---|---|---|
| `text-sm` | 14px | **Content.** The default. Descriptions, values, field labels, item names in a list, messages. When in doubt, this one. |
| `text-meta` | 13px | **Metadata.** Timestamps, ids, counts, the hint under a field, file paths. |
| `text-xs` | 12px | **Chrome detail.** Only inside badges/chips, table `<th>`, and `.t-eyebrow`. Never for a sentence. |

Plus exactly two headings - `text-xl font-semibold` (20px) for the page title, `text-sm font-semibold` (14px) for a card title - and `text-[28px] font-bold` for the big figure inside `<StatTile>`. Never more than 2 heading levels on one page.

**Banned:** `text-[10px]`, `text-[11px]`, `text-[13px]`, `text-[15px]`, `text-base`, `text-lg`, and every other arbitrary size. Need 13px? That is what `text-meta` is for - a hand-typed arbitrary size is exactly how a fourth step sneaks back in. Below 12px there is no step at all: either the text matters enough to be readable, or it should not be on screen.

`text-meta` is defined in `globals.css` via `@theme { --text-meta }`, so it is a real Tailwind utility, not a convention.

**Why this is written down so forcefully:** before the August 2026 overhaul the codebase had **416 uses of `text-xs` against 136 of `text-sm`**. 12px had silently become the body size, with a long tail of 10/11/13/15px underneath. Everything looked the same, so nothing read as more important than anything else. The spec said 14px body the whole time - what was missing was a name for 13px and something that counted.

## 2. Spacing rhythm

Gaps and padding come from one scale: `gap-1` (4px), `gap-2` (8px), `gap-3` (12px), `gap-4` (16px), `gap-6` (24px); `p-2`, `p-3`, `p-4`. **Banned:** `gap-0.5`, `gap-2.5`, `gap-5`, `p-0.5`, `p-1.5`, `p-2.5`. Icon buttons do not need their own padding - use `<IconButton>`.

Page shell: content gutter 20px (`Shell.tsx`), cards 16px inside, 16px between cards. `<PageHeader>` deliberately carries **no bottom margin** - the page's own `gap-4` provides it. Adding `mb-4` back doubles it to 32px and detaches the title from its page.

## 3. Primitives - use them, never re-derive them

Every one of these exists because the same thing had been hand-written many times over. Reaching past a primitive to raw Tailwind is the failure mode this system is built to prevent.

| Need | Use | Replaced |
|---|---|---|
| Button | `<Button variant="primary\|secondary\|destructive" small>` | raw `className="btn btn-primary"` |
| Icon-only button | `<IconButton label size="sm\|md" tone="default\|danger">` | 10+ copies at 4 sizes, 3 hover colors |
| Card | `<Card title hint actions>` | `<div className="card p-0">` variants |
| Box nested inside a card | `<Panel title actions>` | 8 verbatim copies of the same class string |
| Label + input + hint + error | `<Field>`, `<SwitchField>`, `<CheckboxField>` | 7 variants at 3 different label sizes |
| Pick one of a few short options | `<Segmented>` | 6 variants, 3 radii, 3 paddings |
| Pick one option needing a description | `<OptionCard>` in `<OptionCardGroup>` | 5 variants, 2 missing `role="radio"` |
| Status / category label | `<Badge tone label dot>` | 13 hand-rolled pills at 10px and 11px |
| Page or card level message | `<Banner tone="danger\|success\|info\|muted">` | 4 error styles + 4 invented success boxes |
| Loading | `<Skeleton>`, `<TableSkeleton>`, `<CardGridSkeleton>` | 3 loading patterns incl. a primitive defined inside a page |
| Dashboard figure | `<StatTile label value sub icon href>` | defined inside `app/page.tsx`, plus a copy |
| Copy to clipboard | `<CopyButton>` | 2 unrelated-looking implementations |
| List toolbar: search / filter / bulk | `<Toolbar>` + `<FilterChip>` | in-card, outside-card, and absent |
| Empty list | `<EmptyState icon title description action>` | bare `<p>` in several places |
| Progress | `<ProgressBar>` / `.progress-indeterminate` | 4 implementations at 2 heights |

**Nesting depth is capped at Card → Panel.** Three nested borders and the eye can no longer tell what contains what - this happened for real on the translate-video page (Card → bordered box → bordered `<li>`).

**Errors:** a single field's error goes in `<Field error>`, right under the offending input. A card- or page-level error goes in `<Banner tone="danger">`. Never a bare `<p className="text-[var(--danger)]">`, and never swallow the raw log - pass it to `detail`.

## 4. Color tokens

Every color goes through a CSS custom property declared in `:root` and `[data-theme="dark"]`. **Components never contain hex codes**, and never Tailwind's palette (`bg-gray-100`, `text-white`) - map those to tokens. Do not apply alpha modifiers to tokens (`bg-[var(--primary-soft)]/40`) - that produces a color outside the table.

```css
:root {
  /* Brand */
  --primary: #ed3c47;
  --primary-hover: #d62e3a;
  --primary-soft: #fdedef;
  --secondary: #ff7849;

  /* Surface */
  --bg: #ffffff;          /* page background */
  --bg-subtle: #f6f6f7;   /* sidebar, nested blocks, zebra rows */
  --surface: #ffffff;     /* card */
  --border: #e7e7ea;

  /* Text */
  --text: #101113;
  --text-muted: #5f6470;

  /* Semantic */
  --success: #16a34a;
  --success-bg: #e7f6ec;
  --danger: #e8590c;
  --danger-bg: #fbeee5;

  /* Chart series - multi-series dataviz only, validated against the dataviz checker */
  --chart-2: #2f6fed;
  --chart-3: #0d9488;

  /* Shape & motion */
  --radius: 8px;
  --radius-lg: 12px;
  --shadow-card: 0 1px 2px rgba(16, 17, 19, 0.06);
  --transition: 150ms ease;
}

[data-theme="dark"] {
  --primary: #ed3c47;          /* brand color stays the same */
  --primary-hover: #f25560;    /* in dark, hover goes LIGHTER, not darker */
  --primary-soft: #3a1d20;
  --secondary: #ff7849;

  --bg: #131417;
  --bg-subtle: #1a1b1f;
  --surface: #1e1f24;
  --border: #2c2d33;

  --text: #f2f3f5;
  --text-muted: #9a9ea9;

  --success: #2ebd6b;
  --success-bg: #17301f;
  --danger: #f0742e;
  --danger-bg: #33231a;

  --chart-2: #5b8def;
  --chart-3: #27ab92;

  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);
}
```

Dark mode rule: only change token **values**, NEVER add dark-only tokens. Write the component once, it runs in both themes.

The handful of legitimate exceptions (a QR code needing a real white background, an overlay on top of arbitrary video) are listed with their reasons in the `ALLOW` map of `scripts/check-design-system.mjs`. Adding an entry there requires a reason written next to it.

## 5. General principles

1. **Light is the default**, dark is opt-in. The toggle persists to `localStorage` and is applied via the `data-theme` attribute on `<html>`.
2. **Icons are 100% inline SVG** - Lucide set, stroke 1.5-2px, `currentColor` so they inherit text color. No icon fonts, no PNGs, no emoji as functional icons (this includes emoji inside `<option>` labels).
3. **Inter font** via the `@fontsource/inter` package, imported in `apps/web/src/app/layout.tsx` (weights 400/500/600/700). Bundled at build time, so self-hosted - never load fonts from a CDN at runtime.
4. Fixed metadata: title `AI Edit Video by: noti.vn`, description `Edit video tự động bằng AI`, favicon from `public/brand/favicon.png`.

## 6. Brand assets

| File in `apps/web/public/brand/` | Download source | Used when |
|---|---|---|
| `logo-duong-ban.png` | https://noti.vn/image/new/logo-duong-ban.png | Header in light theme |
| `logo-am-ban.png` | https://noti.vn/image/new/logo-am-ban.png | Header in dark theme |
| `favicon.png` | https://noti.vn/image/new/favicon.png | `<link rel="icon">` |

The logo swaps with the theme at the same moment as the tokens (same `data-theme` listener).

## 7. Frame layout

```
┌────────────────────────────────────────────────────────┐
│ Topbar 56px: logo · page name · hardware · backend ·   │
│ language · theme                                       │
├─────────┬────────────────────────────────┬─────────────┤
│ Rail    │  Content: FULL WIDTH, 20px     │ AI panel    │
│ 220px ↔ │  gutter, cards 16px apart      │ 440px ↔ 40px│
│ 56px    │  NO max-width                  │ (a slot of  │
│         │                                │  the shell) │
└─────────┴────────────────────────────────┴─────────────┘
```

Rail and panel widths are decided by **CSS custom properties driven by `data-nav`/`data-panel` on `<html>`**, never by React state - read the long comment block at the top of `globals.css` before changing anything there. Pages declare their right panel with `<ShellRightPanel title="…">`; they never compute padding for it themselves.

**Space rule:** never leave dead whitespace. Lists and tables stretch with the screen. Only standalone forms (create project, edit skill) may cap their width for readability (~640px).

Sidebar - **16 items**, source of truth is `NAV` in `apps/web/src/components/Shell.tsx` (do not re-list them here; this doc has drifted from that array before):
Dashboard, Videos Project, Images Project, Auto cut, Text to video, Dịch video, Voices, Style Design, Phong cách dựng, Render Queue, Assets, Sound Effects, Prompts, Skills, Cấu hình, Kết nối.

`/accelerate` and `/chat` are legacy `redirect()` stubs and correctly absent from NAV. `/m/[id]` is the phone-upload page and bypasses the shell entirely.

## 8. Page skeletons - same job, same shape

**List page** (projects, images, queue, assets, sfx, prompts, skills, styles, video-styles, voices):

```tsx
<div className="flex flex-col gap-4">
  <PageHeader title={…} hint={{titleKey, bodyKey}} actions={<Button>…</Button>} />
  {error && <ErrorBanner message={…} detail={…} />}
  <Card>
    <Toolbar search={…} selectedCount={…} bulkActions={…} onClearSelection={…}>
      <FilterChip … />
    </Toolbar>
    {loading ? <TableSkeleton /> : rows.length ? <table className="table">…</table> : <EmptyState … />}
  </Card>
</div>
```

**Detail page** (projects/[id], text-to-video/[id], translate-video/[id], auto-cut/[id], images/[id], styles/[id]): the 3-column `<Workspace>` from `components/Workspace.tsx`, in work-rhythm order **source → setup → output**, with `<OutputBlock>` first in column 3. Column widths come from a **container query**, not a media query, because the real width depends on whether the rail and panel are collapsed. Hand-rolling `xl:grid-cols-5` here is a bug, not a style choice - it ignores the rail/panel state.

Destructive and save actions live in `<PageHeader actions>` on every detail page. Not at the bottom of the page, not inside a card, not as a bare text button.

## 9. Standard components (CSS contracts in `globals.css`)

- **Button**: 36px tall, 16px horizontal padding, radius `--radius`. `.btn-sm` is 30px/13px. There is no third size - do not override `<Button>` with `h-6`/`h-12`. **One exception:** `/m/[id]`, the phone upload page, uses 64px/48px primary buttons. That page is thumb-driven on a real phone rather than mouse-driven on a desktop, and 36px is below the touch-target minimum. It is the only route outside the dashboard shell, and the exception does not travel.
- **Segmented**: 32px by default; pass `size="md"` for 36px when it sits on the same row as an `.input` or a `<Button>`. A 4px height difference between adjacent controls is immediately visible even to someone who can't name it.
- **Card**: `--surface`, 1px `--border`, radius `--radius-lg`, `--shadow-card`, **padding 16px**. Title 14px/600.
- **Panel**: `--bg-subtle`, 1px `--border`, radius `--radius`, padding 12px. Title 13px/600 - deliberately smaller than a card title so nesting reads correctly.
- **Badge**: 12px, full radius, 6px dot. `dot={false}` for *category* labels - the dot is the convention for *status*, and putting it on a category reads as "running/done".
- **Table**: header 12px uppercase muted, row hover `--bg-subtle`, horizontal rules only, no vertical borders.
- **Progress bar**: 6px, track `--bg-subtle`, fill `--primary`. `.progress-indeterminate` is the same 6px so swapping between them doesn't nudge the layout.
- **Input**: 36px/14px. Never shrink the surface the user types into - `input h-8 text-[13px]` was the single most common violation before the overhaul.

## 10. Realtime & state

- Job/agent state streams over SSE - the UI updates live, and never polls more than once per 5s for static data.
- Every list needs a real empty state: muted SVG icon + one sentence + the primary action.
- Loading is a `<Skeleton>` holding the space the content will occupy, never a centered "Đang tải…" that vanishes and shoves everything upward.
- NEVER swallow errors - the raw log goes in `<Banner detail={…}>`, collapsed.

## 11. What NOT to do

- No flashy gradients, no glassmorphism, no decorative animation - the only motion allowed is the 150ms transition, the progress bar, and the skeleton pulse.
- Never a color outside the token table (including Tailwind grays and alpha-modified tokens).
- Never a hex value in JSX/TSX.
- Never re-implement something in the primitive table above. If a primitive nearly fits, extend the primitive - do not fork it locally.
- Never process or encode video in the browser. The editor only PREVIEWS (Remotion Player) and EDITS `meta.json`; every render goes through the backend render queue.
- Never add editing features outside `/projects/[id]/editor` - other pages stay monitoring/management pages.

## 12. The video editor (`/projects/[id]/editor`)

The one dense, tool-style screen in the app. Everything above still applies (type scale, tokens, primitives, Lucide icons, `t()` strings in vi + en); these are the editor-specific additions:

- **Layout**: top bar (back, name, save state, undo/redo, history, export, render) - left library (collapsible) - center preview player - right inspector - bottom timeline (resizable). The AI chat lives in the shell's existing right panel (`ShellRightPanel`), not in a second chat UI.
- **Timeline colors are tokens**: track colors are CSS custom properties defined for light AND dark in `globals.css` (`--track-*`), never hex and never Tailwind palette classes. The set is `--track-scene|highlight|caption|subtitle|sfx|voice|music` (strong color: block border + label swatch) each with a `-bg` partner (block fill; text on it is always `--text`), plus `--timeline-snap` for the snap guide (the playhead is `--primary`). A row picks its pair with `data-track="scene|overlay|caption|subtitle|sfx|voice|music"`; editor layout and timeline chrome are the `.editor-*` / `.tl-*` classes in `globals.css` - reuse them, do not restyle blocks inline.
- **Code layout** (`components/editor/`): `ops.ts` = every timeline mutation as a pure function (keeps unknown fields, returns the same object on a no-op), `timing.ts` = frame math that must match `Assemble` frame-for-frame, `store.ts` = reducer (history with drag/typing coalescing, save state), `playback.ts` = playhead outside React state (it changes every frame). New editing features add an op + a call through `useEditor().edit(...)`; never mutate the timeline in a component.
- **Allowed motion** (in addition to section 11): the playhead moving with playback, and an element following the pointer while it is dragged. No other animation.
- **Every edit is saved** automatically (debounced) with the timeline version from the server; a conflict is shown as a banner with "load latest" / "keep mine", never resolved silently. "Keep mine" saves with the history label `editor-overwrite`, which the server never coalesces, so the overwritten version always stays restorable (the history modal labels it).
- **Read-only while the AI is editing** the same project, with a banner saying so; the preview reloads as the AI writes.
- **Keyboard first**: Space play/pause, arrows step frames, Alt+←/→ moves the selected scene earlier/later (the keyboard path for drag-to-reorder - drag is never the only way), S split, Delete remove, Ctrl/Cmd+Z / Shift+Z undo/redo, `?` shows the shortcut list. Shortcuts never fire while focus is in a text input, and editing shortcuts are swallowed while a timeline block is being dragged (they would change the timeline under the drag). Escape with a menu open only closes the menu.
- **Leaving never silently loses edits**: on unmount (in-app navigation) and `pagehide` the editor flushes unsaved changes (keepalive PUT); when they can't be saved (conflict / invalid / save error / AI lock) in-app links and the menu ask first with an in-place `<Modal>`. Dirty means `timeline !== savedTimeline` by identity, so undoing back to the saved state is clean again; a save sends only the top-level keys that changed.
- **Malformed AI data never crashes the editor**: timeline/inspector read cue data defensively (`isWellFormed`, `captionWordsOf`…), a malformed element shows a banner in the inspector, and Timeline + Inspector each sit in `EditorErrorBoundary`.
- **Library column** (`LibraryPanel.tsx`, `.editor-library` / `.lib-item`): tabs Project / SFX / Nhạc, collapsible to a 48px strip (remembered per browser in `localStorage`, wrapped in try/catch). Below 1100px it becomes a full-width section UNDER the player (the player always stays on top), never a horizontal scroll. Items drag with HTML5 drag-and-drop; the contract lives in `library.ts` (one JSON payload type + empty "target" types, because `dragover` can only read `dataTransfer.types`). Every draggable item also has a "+" button that does the same thing at the playhead - drag is never the only way. The SFX tag filter is ONE `<select>`, not chips: ~70 tags as chips ate the whole column. Audio preview is ONE shared `<audio>` element for the column (starting another item stops the first; collapsing/leaving stops it).
- **Drop feedback**: the receiving row gets `data-drop="true"` (dashed `--timeline-snap` outline), a scene insert shows `.tl-drop` (3px `--text` bar - the scene track is blue, a blue bar on blue borders disappears), an sfx drop shows the `.tl-snap` line at the frame it will land on (it snaps like a block drag; Alt disables). Whatever a drop/"+" adds becomes the selection so the inspector opens on it, and it is one undo step.
- **Add at playhead**: the "+" in the Highlight / Karaoke / Phụ đề track labels adds a 2s cue at the playhead (shortened to end with the video when the playhead is near the end). New editing features still go through an op in `ops.ts` (`addScene`, `addSfx`, `setMusic`, `addCue`…) + `edit()`.
- **Confirm only what destroys a choice**: replacing an existing background music track asks first (in-place `<Modal>`); adding anything else does not - undo is the safety net. Version restore confirms inside the history modal itself (the body switches to the question) - never a second modal stacked on the first.
- **The shell rail auto-collapses on the editor route** (`Shell.tsx`, also in the pre-paint `SHELL_SCRIPT` so a direct load doesn't flash). The forced collapse is never written to `localStorage`; leaving the editor restores the user's own choice, and a toggle the user makes inside the editor counts as their new choice.
- **Vertical (9:16) previews are limited by HEIGHT, not width**: on a 900px-tall screen every pixel taken from the timeline (32px rows, default height 304px) or by a wrapping transport row (the start/end buttons hide via a container query when the center column is narrow) is a pixel of player height. Check the 1440x900 layout with the library + inspector + AI panel all open after any layout change.
