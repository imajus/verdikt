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
marketplace, reads the path, or leaves an address.

FIRST VIEWPORT: Nav, then entry 00. The index rail runs down the far left in
mono at 13px. `00` sits in it, level with a display line at 60px/1.02 across an
8-column measure: "Verified per call. Refunded on failure. No arbitration." The
tagline follows at 19px, then two actions on one baseline — a filled
`Browse the marketplace` and a ruled `How the loop works`. In the outer margin,
right of a hairline, the latest real verdict is set in mono: outcome, block,
paid, refunded, and the registry address it was read from. That margin column is
the page's proof and it is present above the fold.

FORM: The Running Ledger — candidate 3 of my seven ordered structures, dealt by
the roll and locked by the user over the dealt lead (The Settlement Statement).
Seed key `e7679b0b`, surface scope, persuade mode, code-led.

FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance.
