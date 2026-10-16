# CLAUSE design system

The interface is a **product register**: a tool people work in for hours, so it stays out of the way. Neutral surfaces, hairline borders, one blue accent, and status colours that always come with an icon and words. Written from the built UI (`apps/web/src/index.css` is the source of truth for every value here).

## Principles
1. **Neutral so signals read.** Canvas, paper and ink have no colour cast. The only colours are the accent (actions, selection, focus) and the status pairs (pass, fail, review). If a screen is colourful, something on it is wrong.
2. **Flat and border-led.** Surfaces are separated by a 6% ink hairline, not shadows. Shadow exists only on overlays (dialogs, the command palette, toasts, the card being dragged).
3. **Proven versus advised.** Engine facts are plain text on paper; AI opinions carry a model name, a "reported by the model" label and verified evidence. They are never styled alike.
4. **Nothing animates for keyboard-driven actions.** The command palette opens instantly. Motion is for state changes and is under 250 ms.

## Colour
| Token | Light | Dark | Use |
|---|---|---|---|
| `canvas` | #fafafa | #0b0b0c | page background |
| `paper` | #ffffff | #141416 | panels, the document sheet |
| `ink` | #141416 | #f2f2f4 | text |
| `muted` | #5e6169 | #9b9ea8 | secondary text (contrast ≥ 4.5:1 on canvas) |
| `line` | ink at 6% | white at 7% | every resting border |
| `line-strong` | ink at 15% | white at 16% | inputs and deliberate emphasis |
| `accent` | #235a96 | #7fb0ec | primary actions, selection, focus ring |
| `pass` / `fail` / `review` | #146b45 / #b3261e / #8a5300 | lighter equivalents | status, always with an icon and a word |

## Type
- **Interface:** STK Miso (variable, 100–900), with a metric-matched fallback so text does not jump when it loads. Hierarchy comes from weight and size, never from a second display face.
- **Contracts:** the document text is set in a serif (Iowan Old Style, Palatino, Georgia). It is content, not interface.
- **Scale (px):** 11, 12, 13, 14 (body), 15, 16, 20, 24, 30. Tabular numerals on every number that changes. No negative tracking, no uppercase eyebrows.
- **STK Miso is a commercial typeface** taken from the owner's other project. It is not open source: do not redistribute it, and swap it for another face if this repository is ever published.

## Shape and depth
- Two radii. Panels and cards: **12px**. Controls (buttons, inputs, nav rows, segmented toggles): **8px**. Pills only for small status chips. Dialogs and the palette: 20–24px.
- A card has a border or a fill, never both a border and a shadow.
- Overlay shadow: `0 0 0 1px` hairline plus one soft long shadow.

## Motion
- Easing `cubic-bezier(0.23, 1, 0.32, 1)` for anything entering; 100 ms for press and colour; 180 ms for lists and dialogs; springs only where a thing slides to a new place (tab underline, segmented highlight, dragged card).
- Buttons scale to 0.97 on press. Lists animate add and remove (auto-animate). Numbers roll (NumberFlow). Loading text shimmers instead of spinning.
- `prefers-reduced-motion` turns all of it off.

## Components
`Button` (primary, secondary, ghost, danger; sm and md), `Tabs` (roving tabindex, sliding underline), `Segmented` (radiogroup with a sliding highlight), `StatusPill`, `Pill`, `Kbd`, `Skeleton`, `EmptyState`, toasts (sonner), command palette (cmdk), request board (dnd-kit, keyboard operable, announced to screen readers).

## Sources
Patterns and packages, with licences: **sonner**, **cmdk**, **@dnd-kit**, **@formkit/auto-animate**, **@number-flow/react**, **class-variance-authority**, **clsx**, **tailwind-merge**, **motion**, **lucide-react** (all MIT or ISC, installed from npm at exact versions). `AnimatedBackground` and `TextShimmer` are adapted from **Motion Primitives** (MIT, © ibelick; notices kept in the files). Interaction craft follows the owner's design skills (Emil Kowalski's design-engineering rules, Apple's fluid-interface principles).
