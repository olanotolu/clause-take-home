# CLAUSE design system

The interface is a tool people work in for hours, so it stays out of the way: neutral surfaces, hairline borders, one blue accent, and status colours that always come with an icon and words. This file was written from the built UI; `apps/web/src/index.css` is the source of truth for every value here.

## Icons

Phosphor, through one module (`apps/web/src/ui/icons.tsx`). Regular weight for inline marks, fill for status and the current navigation item, bold for small controls (carets, plus, close). Lucide was dropped because it is the default of almost every generated interface, so it makes a product read as generated. Phosphor's drawing and six weights let one family cover every context. Chosen after comparing Phosphor, Tabler, Solar, Hugeicons, Iconoir, and Heroicons.

## Principles

1. **Neutral so signals read.** Canvas, paper, and ink carry no colour cast. The only colours are the accent (actions, selection, focus) and the status pairs (pass, fail, review). If a screen is colourful, something on it is wrong.
2. **Soft frame, flat content.** The shell is a greige; the working area is a white panel floating inside it; board lanes sit a shade between. Inside the panel, separation is a 6% ink hairline or a hairline-weight shadow. Real shadows exist only on overlays (dialogs, the command palette, toasts, the card being dragged). No gradients, glows, or tinted washes.
3. **Proven versus advised.** Engine facts are plain text on paper. AI opinions carry a model name, a "reported by the model" label, and verified evidence. The two are never styled alike.
4. **Nothing animates for keyboard-driven actions.** The command palette opens instantly. Motion is for state changes and stays under 250 ms.

## Colour

| Token | Value | Use |
|---|---|---|
| `canvas` | #fafafa | page background |
| `paper` | #ffffff | panels, the document sheet |
| `ink` | #141416 | text |
| `muted` | #5e6169 | secondary text (contrast ≥ 4.5:1 on canvas) |
| `line` | ink at 6% | every resting border |
| `line-strong` | ink at 15% | inputs and deliberate emphasis |
| `accent` | #235a96 | primary actions, selection, focus ring |
| `pass` / `fail` / `review` | #146b45 / #b3261e / #8a5300 | status, always with an icon and a word |

## Type

- Interface: STK Miso (variable, 100-900), with a metric-matched fallback so text does not jump when it loads. Hierarchy comes from weight and size, never from a second display face.
- Contracts: document text is set in a serif (Iowan Old Style, Palatino, Georgia). It is content, not interface.
- Scale (px): 11, 12, 13, 14 (body), 15, 16, 20, 24, 30. Tabular numerals on every number that changes. No negative tracking, no uppercase eyebrows.

## Shape and depth

- Three radii. Floating panel and board lanes: 24px. Cards: 18-20px. Controls (buttons, inputs, nav rows, segmented toggles): 10-12px. Pills for chips and the search field. Dialogs and the palette: 20-24px.
- A card gets a hairline shadow or a border, never both plus a decorative shadow.
- Overlay shadow: `0 0 0 1px` hairline plus one soft long shadow.

## Motion

- Easing `cubic-bezier(0.23, 1, 0.32, 1)` for anything entering. 100 ms for press and colour, 180 ms for lists and dialogs. Springs only where a thing slides to a new place (tab underline, segmented highlight, dragged card).
- Buttons scale to 0.97 on press. Lists animate add and remove (auto-animate). Numbers roll in 280 ms (NumberFlow with its 900 ms default replaced, see `ui/Num.tsx`). Loading text shimmers instead of spinning. The navigation highlight, tab underline, and segmented highlight glide on a spring. The request panel slides shut instead of vanishing, the proposed-changes tray rises only when it has content, a save gives the sheet one ring, a redline draws its strikethroughs left to right, and the CI bar fills in with its rows arriving in sequence.
- `MotionConfig reducedMotion="user"` plus a global media query turn motion off for people who ask.

## Components

`Button` (primary, secondary, ghost, danger; sm and md), `Tabs` (roving tabindex, sliding underline), `Segmented` (radiogroup with sliding highlight), `StatusPill`, `Pill`, `Kbd`, `Skeleton`, `EmptyState`, toasts (sonner), command palette (cmdk), request board (dnd-kit, keyboard operable, announced to screen readers).

## Sources

Patterns and packages, with licences: **sonner**, **cmdk**, **@dnd-kit**, **@formkit/auto-animate**, **@number-flow/react**, **class-variance-authority**, **clsx**, **tailwind-merge**, **motion**, **@phosphor-icons/react** (all MIT or ISC, installed from npm at exact versions). `AnimatedBackground` and `TextShimmer` are adapted from **Motion Primitives** (MIT, © ibelick; notices kept in the files). Interaction craft follows the owner's design skills (Emil Kowalski's design-engineering rules, Apple's fluid-interface principles).
