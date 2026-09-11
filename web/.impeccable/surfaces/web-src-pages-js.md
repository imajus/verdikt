---
version: 1
slug: "web-src-pages-js"
primary_target: "web/src/pages.js"
related_targets: ["web/src/lit-app.js","web/src/styles.css"]
---

# Landing page (`/`)

Scope: the `/` route only. Visitor mode: **Persuade**.

Audience, in the order the page serves them (user's call this round, which
overrides PRODUCT.md's judge-first ordering for this surface alone): **providers
and agent operators** deciding whether to list a service or point a paying agent
at one. Hackathon judges are the secondary read and are served by the same real
chain evidence, not by a separate register.

Action: browse the marketplace, read the mechanism, subscribe, or write.
Proof: the four platform figures and the latest verdict, both read off Arc at
page load. Constraints: static site, no backend, no accounts; both forms POST to
third-party endpoints supplied as `VITE_NEWSLETTER_ENDPOINT` /
`VITE_CONTACT_ENDPOINT` and render an honest unconfigured state when unset.
The Privacy page gains a line because an email now leaves the page.

The architecture section is a drawn request-path schematic with short labels;
`/how` keeps the prose and the section links to it. No prose duplication.

The sheet runs five entries, 00–04, and three margin notes — on 01, 02 and 03.
The copy budget is the rule that keeps the page scannable: an entry states its
point once and lets the drawing, the form, or `/how` carry the rest. Anything
the schematic already labels does not get a paragraph above it, and anything a
form's own label or placeholder says does not get restated in the prose that
introduces it.

Entry 04 closes the sheet and carries both asks, side by side above 1040px and
stacked below it (`.entry-split`). Left, **Tell us what you are building** and
the contact form; right, **Be informed about our progress** — the forward look,
the newsletter, and under it the muted `star` / `follow` row as the quietest
action rank. It is the one entry with no margin note, which is what frees the
outer column for the second half; the gutter between the halves is a 1px rule,
the same vertical divider the platform figures row is set with, so they read as
ruled columns rather than two loose blocks. The two form hints are worded
identically on purpose — side by side, one rule stated twice reads as a system
and two near-paraphrases read as sloppiness.

The forward look names what lands next — a paid call carried the whole way, the
workflow in production rather than simulation, the walkthrough — as work in
front rather than as a confession (the user's call). The facts are unchanged and
still stated plainly, and it may never acquire traction the project does not
have: PRODUCT.md's *Absent, and must not be invented* still binds.

Unresolved: the two form endpoint URLs are not yet supplied.

## Direction contract

THESIS: The landing page is one continuous ruled ledger sheet, and every
section is an entry on it — numbered in a left index rail, annotated in the
outer margin. It refuses the category default of stacked full-bleed marketing
bands with centred headings, and it refuses the card grid: nothing on this page
is a box.

OWN-WORLD: The incumbent ledger world, unchanged and inherited. Paper `#f6f4ee`
/ ink `#191713` (dark: `#141310` / `#ece7dc`), hairline `--rule` separators and
a single 1.5px `--rule-strong` above a major entry, Bricolage Grotesque for
display and section heads, IBM Plex Sans for prose, IBM Plex Mono reserved for
anything that came off a chain. New to this surface: a 1-column mono index rail
and a 3-column outer margin column, both hung off the same rules; form inputs
that sit on a hairline instead of inside a box; and one authored SVG schematic
drawn in the same hairline weights.

STORY: A provider or agent operator understands within one viewport that
delivery here is judged per call against a published SLA and that failure
refunds without arbitration; believes it because the figures and the latest
verdict beside them were read off Arc in their own browser; then browses the
marketplace, reads the path, or leaves an address. They get there by reading
five entries, not by reading an essay: entry 02 states the gap in two
paragraphs and hands the answer to the drawing below it.

FIRST VIEWPORT: Nav, then entries 00 and 01. The index rail runs down the far
left in mono at 13px. `00` sits in it, level with a display line at 60px/1.02
across an 8-column measure: "Verified per call. Refunded on failure. No
arbitration." The tagline follows at 19px, then two actions on one baseline — a
filled `Browse the marketplace` and a ruled `How the loop works`. Entry 00 takes
no margin: the hero states the terms and leaves its outer column empty, which is
the page's one piece of air.

Entry 01 follows inside the same viewport and carries all of the chain evidence:
the four platform figures on the measure, and in the outer margin, right of a
hairline, the latest real verdict in mono — outcome, service, block, paid,
refunded, and the registry address it was read from. The figures are the totals
and the verdict is the newest line behind them, so they belong level with each
other. That margin column is the page's only claim about provenance: it names a
chain address in live mode and flags `seeded` in amber in demo mode, and it must
never do both or neither.

FORM: The Running Ledger — candidate 3 of my seven ordered structures, dealt by
the roll and locked by the user over the dealt lead (The Settlement Statement).
Seed key `e7679b0b`, surface scope, persuade mode, code-led.

FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance.
