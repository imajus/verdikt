---
name: Verdikt
description: A ledger sheet for x402 services — what was promised, set beside what was delivered.
colors:
  paper: "#f6f4ee"
  paper-2: "#edeae2"
  rule: "#d8d3c7"
  rule-strong: "#191713"
  ink: "#191713"
  ink-2: "#4b4740"
  muted: "#6a6559"
  link: "#1f4bb8"
  good: "#1c7c46"
  fair: "#9a6b00"
  poor: "#b8321e"
  down: "#4f5d7a"
  good-track: "#cfe6d7"
  fair-track: "#efe1b8"
  poor-track: "#f1cfc8"
  net-sepolia: "#985606"
  net-arc: "#6d28a8"
  net-cre: "#1e3a8a"
  net-verdikt: "#0e7490"
typography:
  lead:
    fontFamily: "Bricolage Grotesque, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(31px, 4.6vw, 60px)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  display:
    fontFamily: "Bricolage Grotesque, Helvetica Neue, Arial, sans-serif"
    fontSize: "37.5px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Bricolage Grotesque, Helvetica Neue, Arial, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Bricolage Grotesque, Helvetica Neue, Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "16.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "IBM Plex Sans, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  record:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
    fontFeature: "tabular-nums"
  record-caption:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.1em"
rounded:
  none: "0"
  hairline: "1px"
  sm: "2px"
  md: "3px"
  dot: "50%"
spacing:
  hair: "4px"
  xs: "8px"
  sm: "10px"
  md: "14px"
  lg: "18px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    size: "15px"
  button-primary-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    size: "15px"
  cta-accent:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "0 22px"
    size: "16.5px"
  cta-accent-hover:
    backgroundColor: "{colors.ink-2}"
    textColor: "{colors.paper}"
  cta-outlined:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 22px"
    size: "16.5px"
  cta-outlined-hover:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
  input-console:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
    typography: "{typography.record}"
    size: "15px"
  field-ledger:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "6px 2px"
    typography: "{typography.body}"
  field-ledger-focus:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
  listing-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "13px 10px 13px 14px"
  listing-row-hover:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
  aside-note:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.none}"
    padding: "2px 0 2px 14px"
    size: "15.5px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.none}"
    padding: "2px 0"
    size: "15px"
  nav-item-active:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
---

# Design System: Verdikt

## Overview

**Creative North Star: "The Running Ledger"**

Verdikt sets a chain the way a bound ledger sets a transaction: ruled lines,
a measure, a margin for annotation, and no decoration that would make a number
look more certain than it is. The whole product is one comparison — what a
provider promised, beside what it delivered — so the surface is built out of
rules and alignment rather than containers. Nothing on it is a card. A section,
a notice, a table row and a landing entry are all the same object: content
hung between two hairlines.

The density is editorial rather than dashboard. Type does the ranking, not
fills: a display grotesk (Bricolage Grotesque) opens a section, prose runs in
IBM Plex Sans on a 64–78ch measure, and IBM Plex Mono appears only where a
value came off a chain or names a record key. Light and dark are both authored
in full, because a comparison table that is half-themed is unreadable; the
scheme is set on `<html>` before paint so native controls and the component
library inherit it.

Colour is scarce and semantic. There is no brand accent to spend: ink on paper
carries every focal action, and the four signal hues (`good`, `fair`, `poor`,
`down`) exist to name an outcome, never to enliven a layout. Where an outcome
matters, shape repeats what colour says, so the page survives a red/green
deficiency. The one authored motion on the whole surface is the request-path
schematic tracing itself once on scroll; everything else is still.

**Key Characteristics:**

- Hairline rules instead of boxed cards; nothing is a container
- Two-weight rule system: 1px `rule` separates, 1.5px `rule-strong` opens
- Mono reserved for chain data, record keys and measurement — never for prose
- Signal colour plus shape: outcomes are legible without hue
- Light and dark authored in full, including selection, caret, scrollbar, focus
- Flat by construction: no elevation, no shadow vocabulary

## Colors

A paper-and-ink neutral field carrying four semantic signal hues and one link
blue; there is no decorative accent and none is needed.

### Primary

- **Ink** (`#191713` light / `#ece7dc` dark): body text and every focal action.
  The primary CTA, the provider console's default button, the active nav
  underline, the selection highlight and the focus ring are all ink — the
  system has no brand colour to spend on emphasis, so weight and contrast do
  it. `rule-strong` is the same value, named separately because it is used as a
  stroke (the 1.5px rule that opens a page head, listing or detail).
- **Ink Two** (`#4b4740` / `#c5bfb2`): secondary prose — taglines, entry body
  copy, margin annotations, the second line of the landing lead, and the
  schematic's flow strokes. It is the voice of supporting text, not of a
  disabled state.

### Secondary

- **Ledger Blue** (`#1f4bb8` / `#8fb0ff`): links only, underlined at 1px with a
  2px offset. It never fills anything and never marks a state.

### Tertiary

The four signal hues. Each names an on-chain fact and is used nowhere else.

- **Conforming Green** (`#1c7c46` / `#4cc38a`): PASS, active status, a good
  score band, a completed wizard step, live-source and success messages.
- **Caution Amber** (`#9a6b00` / `#e0b040`): a fair score band, demo-mode
  source, `edited since`, the warning aside's rule, the `seeded` margin flag.
- **Failing Red** (`#b8321e` / `#f0705a`): FAIL, suspended, contested, a poor
  score band, an invalid field's rule, form errors.
- **Absent Slate** (`#4f5d7a` / `#93a3c4`): DOWN — the outcome where nothing
  usable came back. Deliberately the coolest, quietest signal: an absence, not
  a failure.
- **Track hues** (`good-track` / `fair-track` / `poor-track`): the unfilled
  remainder of a score meter, a lighter step of the same hue as its fill, so
  the band is readable across the whole bar and not only its filled part.

### Neutral

- **Paper** (`#f6f4ee` / `#141310`): the page field. Also the text colour on an
  ink fill, so a primary button is literally ink on paper.
- **Paper Two** (`#edeae2` / `#1d1b17`): the only tonal step in the system. It
  marks a row hover, a focused hairline field, a console input or textarea
  fill, and the empty part of a breakdown bar. It is a tint, never a card.
- **Rule** (`#d8d3c7` / `#2f2c26`): every hairline — table rows, entry
  separators, the margin's vertical rule, the aside's left rule, the schematic's
  boxes and dividers.
- **Muted** (`#6a6559` / `#8f897d`): placeholders, field labels, figure labels,
  table heads, the footer, the index rail and the scrollbar thumb. Held to
  body-text contrast (5.3:1 on paper), so it is a quiet voice, not a faint one.

### Named Rules

**The Two Schemes Rule.** Every colour is defined in both `:root` and
`:root[data-theme="dark"]`. A value that only exists in one scheme is a bug —
a half-themed comparison table is unreadable, and the theme is applied before
first paint.

**The Signal Scarcity Rule.** `good`, `fair`, `poor` and `down` name an
on-chain fact — an outcome, a status, a score band, a validity. They are never
used to decorate, categorise or brighten. If a colour on screen cannot be
traced to a chain value, it is ink, muted, a rule, or one of the four identity
hues below.

**The Two Families Rule.** There are exactly two coloured families and they
answer different questions. The signal family (`good` / `fair` / `poor` /
`down`) answers *what did this call do*. The identity family (`net-sepolia` /
`net-arc` / `net-cre` / `net-verdikt`) answers *whose system is this* — a fact
about the architecture, not about any one call. The identity hues live only in
the request-path figure, where the whole subject is that four parties' systems
each own one part of the loop, and they never touch a number, a score, a status
or a table. A thing that belongs to nobody stays neutral: in the figure the
paying agent and the provider's endpoint are drawn in `rule` grey precisely
because they are the two parties transacting rather than systems, and that
distinction is drawn rather than captioned. A connector takes the colour of the
system it reaches, which leaves the request-and-payment path as the only black
lines on the drawing.

`net-verdikt` is the cyan stop of the brand mark's gradient and `net-arc` its
violet stop, both darkened to hold on paper. Dark-mode values are composed for
the dark ground rather than inverted — a `#1e3a8a` navy on near-black is a
shape you cannot see.

**The Shape-and-Colour Rule.** Wherever an outcome is coloured it also differs
in form. In the verdict strip, PASS and FAIL are filled marks and DOWN is drawn
hollow (a 1.5px inset outline) — an absent answer drawn as an absence — so the
record reads without hue.

## Typography

**Display Font:** Bricolage Grotesque (with Helvetica Neue, Arial fallback)
**Body Font:** IBM Plex Sans (with Helvetica Neue, Helvetica, Arial fallback)
**Label/Mono Font:** IBM Plex Mono (with ui-monospace, SF Mono, Menlo, Consolas)

**Character:** A tightly-tracked variable grotesk over a humanist text face —
the display voice is compact and editorial, the prose voice plainly readable
at a long measure. The mono is not a mood; it is a claim of provenance.

### Hierarchy

- **Lead** (600, `clamp(31px, 4.6vw, 60px)`, 1.02, -0.035em): the landing's
  opening statement only, set as three block lines so a statement of terms does
  not wrap wherever the measure ends; its last line drops to `ink-2`.
- **Display** (700/600, 37.5px, 1.1/1.0, -0.02em): the page head's `h1` and the
  service detail's `h2`. The same 37.5px also sets a platform figure's value at
  weight 500, so a number and a title carry equal rank.
- **Headline** (600, 26px, 1.2, -0.02em): a landing entry's heading, capped at
  34ch with balanced wrapping; the nav wordmark at 700/1.0. Drops to 22px below
  560px.
- **Title** (600, 20px, 1.2, -0.01em): a `.block` section heading, closed by a
  1px rule; its trailing `small` reverts to sans 14.5px in muted.
- **Body** (400, 16.5px, 1.5): all prose. Measure is capped by content type —
  64ch for a page-head tagline, 70ch for an entry body and figure source, 78ch
  for an aside and a wide caption, 90ch for the footer.
- **Label** (400, 14.5px): figure labels, field labels, source chips, footer,
  status text; almost always `muted`. Table heads and small table text drop to
  14–15px.
- **Record** (400, 14px, tabular-nums, mono): ledger tables, `code`, addresses,
  hashes, margin key/value blocks (12–12.5px), the index rail (13px) and the
  schematic's labels (10.5–13px).
- **Record caption** (400, 11px, 0.1em, uppercase, mono): the margin
  annotation's own heading, sitting directly above a record block in the outer
  column.

### Named Rules

**The Chain-Data Rule.** IBM Plex Mono is reserved for what came off a chain or
names a record: addresses, hashes, block numbers, amounts, record keys, the
entry index, form status. Prose is never set in mono to look technical, and a
mono table (`table.ledger`) still sets its own `thead` in sans, because a
column heading is a label and not a value.

**The Tabular Rule.** Any figure that is compared down a column or across a
margin carries `font-variant-numeric: tabular-nums` — scores, amounts, block
numbers, the index rail. A number that shifts as it updates is a defect.

**The Measure Rule.** Prose is capped in `ch`, never in pixels, and never runs
the full 1280px container. If a paragraph has no `max-width`, it is missing one.

## Layout

The container is a single centred column, max 1280px, padded 28px/32px with a
72px foot (20px/18px/56px below 560px). There is no page-level grid; each
region declares its own.

**The landing sheet** is a three-column ledger: a 2.5rem mono index rail, the
measure (`minmax(0, 1fr)`), and a 16rem outer margin for annotation, with a
32px column gap. Each entry is padded 30px/34px and separated by a 1px rule;
the first entry drops its rule and the last closes the sheet with one. The
margin column hangs off its own left hairline. One entry (the request-path
schematic) is `wide`: its body spans columns 2–3 and its annotation becomes a
caption ruled across the top, beneath the figure.

**The marketplace** is a five-column row grid — name, then three 5.4rem numeric
columns and a 5.8rem status column — with the name cell elastic and the numeric
cells right-aligned. Above 1040px the page splits into a 560px listing and a
fluid detail pane, and the listing sticks at 24px from the top.

**Platform figures** are a four-column ruled row with 1px vertical dividers and
a closing 1px rule, no tiles; they fall to two columns below 720px.

**Responsive steps** are 1040px (entry margin folds under the body; layout
becomes single-column), 760px (the schematic swaps to its portrait viewBox and
steps out past the index rail; nav wraps), 720px (figures halve), and 560px
(rail narrows to 1.75rem with a 14px gap, lead and headings step down, CTAs go
full width, the nav becomes two rows — wordmark plus icons, then links).

**Rhythm.** Vertical spacing runs on a loose 4px-derived set used at
4/8/10/14/18/24/32/48px; sections open at 30px (`.block` 30px, editor 44px,
footer 56px). Density is deliberately tighter in tables (6–13px row padding)
than in prose.

### Named Rules

**The Hairline Rule.** Separation is a 1px `rule`; the opening of a major region
is a single 1.5px `rule-strong`. Two rules never sit within a few pixels of each
other — where a page head's bottom rule already draws the line, the listing
below drops its own (`.listing.flush`), and a footer following the sheet drops
its top rule.

**The Margin Rule.** Supporting evidence — provenance, a caveat, the latest
verdict — belongs in the outer margin beside the claim it supports, not
interleaved into the measure. Below 1040px it folds under the body with a rule
above it, never into a box.

## Elevation & Depth

There is no elevation. The system ships zero drop shadows, no blur, no
translucency and no z-layering as a visual device. Depth is entirely ruled and
tonal: a hairline separates, a 1.5px rule opens, and `paper-2` is the single
tonal step available for a hover, a focus, a field fill, or a bar track. The
only `box-shadow` in the stylesheet is an inset 1.5px outline drawing the DOWN
mark as a hollow rectangle — an outline stroke, not a lift.

### Named Rules

**The Flat Sheet Rule.** A surface is never raised. If something needs to read
as distinct, give it a rule, a measure, or the `paper-2` tint — in that order.
Shadow is not in this system's vocabulary, and an offset or hard shadow would
belong to a different world entirely.

## Shapes

The form language is rectangular and nearly radius-free. Corners are 0 by
default (rows, entries, hairline fields, the sheet itself), 2px where a control
must read as a control (buttons, CTAs, console inputs and textareas, skeleton
bars, score meters, the verdict strip's marks at 1px), and 3px on a breakdown
bar. Web Awesome's own radius scale is pulled down to a third
(`--wa-border-radius-scale: 0.33`) so its components land in the same range.
The only circle in the system is the 7px status dot that precedes an outcome or
status word.

Borders are strokes, not frames: most elements carry a border on exactly one
edge — bottom for a row or a hairline field, left for an aside or a margin
column, top for an entry or a caption. A four-sided border appears only on a
console input, a console textarea and the schematic's boxes, all at 1px.

### Named Rules

**The No-Box Rule.** A notice is a rule down the left with no fill (`.aside`,
2px `rule`, amber when it warns). A tinted, boxed callout is how a generated
dashboard says "notice"; a marginal rule is how a ledger does. The same
applies to sections: nothing on the landing sheet is a card.

## Components

### Buttons

- **Shape:** square-ish, 2px radius on every variant.
- **Primary (console):** ink fill, paper text, 1px `rule-strong` border,
  8px/16px padding, 15px. Hover drops opacity to 0.88; disabled goes to 0.4
  with `not-allowed`.
- **Secondary:** the same shape, transparent fill, ink text.
- **Landing CTA (accent):** Web Awesome's button repainted through
  `::part(button)` — ink fill, paper text, a 1.5px ink border, 22px inline
  padding at 16.5px/500, colour transitions at 120ms. It must be selected by
  `[appearance="accent"]`, because Web Awesome reflects that attribute onto the
  host. Hover moves fill and border to `ink-2`.
- **Landing CTA (outlined):** no fill, ink text, 1.5px `rule-strong` border;
  hover fills `paper-2`. The two CTAs share one baseline and go full-width
  below 560px.
- **Text aside CTA:** a muted link with a 1px `rule` underline that goes ink on
  hover — the third, quietest action rank.

### Inputs / Fields

Two families ship, and they are not interchangeable.

- **Hairline field (`.ledger-field`, landing forms):** no fill, no frame, one
  1.5px `rule` under it, 6px/2px padding, body type at 16.5px, ink caret.
  Hover darkens the rule to `muted`; focus suppresses the outline, thickens the
  rule to 2.5px ink and tints the line with `paper-2` — a hairline field's
  focus has to be as loud as a box's ring. An invalid field's rule goes `poor`.
  Its textarea has no resize grabber and grows as you type.
- **Boxed field (provider console):** `paper-2` fill, 1px `rule` border, 2px
  radius, mono at 15px (textarea 14px, min-height 240px, vertical resize).
  Focus is a 1.5px ink outline inset by 1px. Use this where a value is
  configuration being edited; use the hairline field where a visitor is writing
  a line on the page.
- **Labels** are sans 14.5px muted above the field.
- **Messages** sit under the form at 14px on a 44ch measure: hint muted, error
  `poor`, done `good`, and an unconfigured-endpoint notice as a left-ruled
  `.form-off` block.

### Navigation

A single flex bar at 15px: wordmark lockup (mark plus 26px display text) on the
left, links in the middle at `muted`, external icon links and the theme toggle
pushed right. A link gains ink text on hover and ink text plus a 1.5px ink
underline when active — the same rule vocabulary as the rest of the page. Icons
are inline SVG at 16px inheriting `currentColor`, never an icon font. Below
760px the bar wraps; below 560px it becomes two rows, with the links scrolling
horizontally on the second.

### Tables

Borderless except for a 1px bottom rule per row; heads are sans 14px/400 muted,
left-aligned, and the last row drops its rule. Three variants: the default
(15px), `kv` (a 15.5px key/value table whose key column is muted, sans and
shrink-wrapped), and `ledger` (mono 14px, nowrap, tighter rows) — used where
every cell is chain data, and still setting its head in sans.

### Score

A number over a meter: the figure at weight 500 with tabular numerals, and a
3px full-width bar beneath it whose track is the lighter step of the fill's own
hue (`good-track` / `fair-track` / `poor-track`). An unknown score is a muted
400 number with no meter at all — never a zeroed bar.

### Verdict Strip

One 9×16px mark per verdict, oldest first, 2px apart, wrapping. PASS is a
`good` fill, FAIL a `poor` fill, DOWN a transparent mark with a 1.5px inset
`down` outline. It sits above the verdict table so a service's whole record
reads at a glance before any row is read.

### Landing Entry

The signature composition: `entry-index` (mono 13px muted, `aria-hidden` —
decorative for a screen reader), `entry-body` (headline plus prose on a 70ch
measure), and `entry-note` in the outer margin behind a left hairline, opening
with an uppercase mono caption and usually carrying a mono key/value block or a
short provenance line. The index numbering is load-bearing only because a
ledger's lines are referenced by index; it is not a decorative section counter.

### Request-Path Schematic

An authored SVG in two viewBoxes (landscape and portrait), the unused one
`display: none` so it leaves the accessibility tree. Every stroke and fill is
themed from CSS classes, never from markup attributes: 1px boxes, dashed
boundaries, 1.25px flow lines, dashed 1.15px reads, and mono labels from 10.5px
to 13px (the portrait figure sets its type larger in figure units to land at the
same size on glass).

Colour enters here and nowhere else in the system. A zone class (`dg-sepolia`,
`dg-arc`, `dg-cre`, `dg-verdikt`) sets nothing but `--zone`; the element classes
read `var(--zone, …)` and fall back to `rule` / `muted` / `ink-2`, so an
unzoned box is neutral by construction rather than by omission. A zone colours a
frame, its divider, its band label and its caption — never the record keys
inside it, which stay `ink` because they are data. `context-stroke` on the
marker fill lets one arrowhead per figure serve every line colour, with a flat
`ink-2` fill declared before it as the fallback. The words PASS, FAIL and DOWN
are `tspan`s carrying `good`, `poor` and `down`, so the figure names an outcome
in the same voice the ledger table and the verdict strip do.

**Partner marks.** Six logos sit in the top-left corner of the blocks they
name: ENS, Chainlink (for CRE), Arc, x402, the paying agent's robot glyph, and
Verdikt's own droplet. Each is taken from its owner's own artwork rather than
redrawn — a logo that merely resembles the real one is worse than none — and
every one is normalised into a shared 24-unit box, so six marks drawn at six
original scales carry one optical weight. The agent's mark is Material
Symbols' `smart_toy` (Apache 2.0), picked over a more detailed robot glyph
after checking both at 13px: the detailed one collapsed into an unreadable
blob, `smart_toy`'s antenna-and-eyes silhouette survived. They live in a
single `<symbol>` sprite that both figures `<use>`, never duplicated. A mark is
filled with `var(--zone)` like everything else in its block, which is what
keeps six foreign personalities reading as one drawing instead of a row of
badges; the x402 cross and the agent's robot both fall back to `ink-2` because
neither the provider nor the paying agent belongs to a zone — they are the two
parties transacting, not systems. Only the block's first line indents past its
mark, so the line beneath keeps the full measure. These are nominative marks
identifying which system a block is — never a partner, sponsorship or
endorsement claim, which PRODUCT.md rules out.

On scroll into view the flow lines trace once over 2533ms
`cubic-bezier(0.16, 1, 0.3, 1)` with per-line delays (0/500/1000/1500/2000ms —
0.3x the original speed, i.e. every duration and delay divided by 0.3 together,
so the sequence still reads as one continuous draw rather than a quick flash
followed by a long wait), then the dashed reads fade in over 1733ms starting at
2533ms — the figure renders finished, and the animating class only arrives at
the instant it starts, so no JavaScript and `prefers-reduced-motion: reduce`
both land on the completed drawing.

### Hero Headline Reveal

The page's other authored moment, at the top rather than the bottom of the
first scroll: entry 00's three-line headline sets itself onto the page once on
load, left edge first per line, in the same drawn-not-dissolved grammar as the
request-path figure's connectors — this page's motion signature is things
being inscribed, never faded. Each `span` is `width: fit-content` rather than
the block-level default of stretching to the measure, which is what makes the
effect exact at any viewport or font size with no script: a `clip-path` reveal
reads its inset as a percentage of the element's own box, so the box has to
end exactly where the glyphs end for the percentage to track the visible text
rather than empty space beside it. `inset(0 100% 0 0)` animates to
`inset(0 0 0 0)` over 640ms `cubic-bezier(0.16, 1, 0.3, 1)` — the same easing
curve as the request-path trace, so the two authored moments read as one
motion language — with the three lines staggered 200ms apart so the whole
headline settles by ~1040ms. No transform, no opacity, no blur: a plain wipe
is the restrained reading of "freshly set," and stacking a second technique
onto it would have been decoration, not thesis. `clip-path` is declared only
inside `@media (prefers-reduced-motion: no-preference)`; the unconditional
rule sets no clip-path at all, so `reduce`, a disabled stylesheet, or a
non-supporting browser all show the finished headline immediately, never a
hidden one.

### Loading Skeleton

Shapes redacted rather than shimmered: a `rule`-filled bar at 0.85em (22px in a
figure value) with a 2px radius, pulsing opacity 0.5→1 over 1.4s, and the pulse
itself gated behind `prefers-reduced-motion: no-preference`. A skeleton row
loses its pointer cursor and hover.

## Do's and Don'ts

### Do:

- **Do** separate with a 1px `rule` and open a region with a single 1.5px
  `rule-strong`; drop one of two rules that would land within a few pixels.
- **Do** reserve IBM Plex Mono for chain data, record keys, labels and
  measurement, and set a mono table's head in sans.
- **Do** carry every outcome in shape as well as colour (filled PASS/FAIL,
  hollow DOWN; a dot before every status word).
- **Do** define every new colour in both `:root` and `:root[data-theme="dark"]`.
- **Do** theme the browser's own surfaces — `::selection` (ink on paper),
  `caret-color`, `scrollbar-color` (muted on paper), and a 2px ink
  `:focus-visible` ring at 2px offset.
- **Do** cap prose in `ch` (64/70/78/90 by role) rather than letting it run the
  container.
- **Do** use `font-variant-numeric: tabular-nums` on any compared figure.
- **Do** give a score its meter track in the lighter step of its own hue, and
  drop the meter entirely when the score is unknown.
- **Do** gate every animation behind `prefers-reduced-motion: no-preference`
  and make the un-animated state the finished one.
- **Do** repaint a Web Awesome control through `::part()` and the `--wa-*`
  tokens when the library's neutral would otherwise ship on a focal action;
  select the primary by `[appearance="accent"]`, which the host reflects.
- **Do** inline icons as SVG at 16px inheriting `currentColor`.
- **Do** pick the field family by job: the hairline `.ledger-field` where a
  visitor writes a line on the page, the boxed console input where a value is
  configuration being edited.

### Don't:

- **Don't** box a notice. A standing note is a 2px left rule with no fill;
  amber only when it warns.
- **Don't** add elevation. No drop shadow, no offset shadow, no blur, no
  translucency — `paper-2` and a rule are the whole depth vocabulary.
- **Don't** put a card around a section, a figure, or a landing entry.
- **Don't** set prose in mono to make it look technical, and don't set a chain
  value in sans.
- **Don't** spend `good` / `fair` / `poor` / `down` on anything that is not an
  on-chain fact, and don't introduce a decorative brand accent — ink carries
  emphasis.
- **Don't** show a number whose provenance is unstated; a chain address is
  named only where a chain was actually read, and demo data says so out loud.
- **Don't** rely on hue alone to distinguish an outcome.
- **Don't** hardcode a hex in a component; every colour comes from a custom
  property. (The wordmark's fixed white `V` is the single deliberate exception,
  because it sits on the theme-independent gradient mark.)
- **Don't** add a second authored motion to a page; this system animates once,
  at the schematic, plus the skeleton's pulse.
- **Don't** introduce an uppercase eyebrow or kicker above a heading. The
  uppercase mono caption belongs to the outer margin, where it labels a record
  block — it is not licence for a kicker in the measure.
- **Don't** use an icon font or a glyph character as an icon.
