---
version: 1
slug: "web-src-lit-app-js"
primary_target: "web/src/lit-app.js"
related_targets: ["web/src/styles.css","web/src/format.js"]
---

# Service page (`/services/:slug`)

Scope: `detailTemplate` in `web/src/lit-app.js` and the styles it owns in
`web/src/styles.css`. Visitor mode: **Operate**.

Audience: an agent operator deciding whether to point a paying agent at this
service, and a judge checking that the verification loop is real. Both arrive
from the marketplace listing. The provider arrives too — its SLA editor and
bond controls append below this template and are not part of this brief.

Action: copy the endpoint and call it. Proof: the verdict ledger, every row
read off Arc in the visitor's own browser.

## Direction contract

THESIS: The page is one argument in four moves — **how to call it → what it
promised → what it delivered → how to check any of it**. It used to be three
undifferentiated dumps of every field the `Listing` carried, with the two
records nobody acts on (the upstream URL, the ENS `address` record) given the
top of the page and the one thing a caller needs (the endpoint) truncated to
`slug.verdikt.bond/…` with no way to copy it.

OWN-WORLD: The incumbent ledger world, inherited unchanged. New to this
surface: a hairline-ruled endpoint row with a copy control; the clause record,
which borrows the landing sheet's margin-note grammar so the machine-readable
pair (type, id) sits in the outer column where this system already keeps
record keys; and a vertical hairline inside the verdict table separating what
a verdict says from where to go and check it.

## Decisions that are load-bearing

- **The endpoint is the page's one action.** Full `https://<slug>.verdikt.bond`
  at 20px mono on a hairline, with a copy button beside it. Where the proxy
  will not route — `DEREGISTERED`, `SUSPENDED`, or a contested slug — the URL
  is struck through, the copy control is withheld, and the reason sits
  directly under it. Offering to copy an address that answers 503 is the page
  inviting a wasted request.

- **Price is read off the ledger, never asserted.** This page fetches no 402
  challenge, so the only honest figure is what its own verdicts recorded: one
  figure when every call paid the same, a range when they differ, and nothing
  at all before the first call. The SLA's price band is only claimed as
  containing that figure when it actually does — `weather`'s ledger runs to
  2.5 USDC against a clause promising at most 0.01, and the page must not talk
  over the FAIL two sections below it.

- **The clause id is the join between the two halves, so it is a link.** A
  verdict's `Broke` cell anchors to the clause record that declares it;
  `delivery`, `status only` and `edited since` name nothing the SLA declares
  and stay unlinked. Anchors are indexed (`clause-0`), not built from the
  provider-authored id, which is unbounded and would need escaping at both
  ends. The `:target` rule hangs in the margin — margin, padding and border
  cancel — so the clause does not jump sideways as the reader arrives at it.

- **The clause type and id left the reading column.** The promise is the
  sentence ("Answers within 15 s"), which encodes the type; the id is
  machinery a reader needs only to follow a verdict back. Both go to the
  margin. The type caption keeps the margin's mono weight but drops the
  uppercasing, because `priceRange` is vocabulary the SLA schema fixes and
  "PRICE RANGE" is a term no schema declares.

- **"Pays to" was wrong twice and is gone.** Issue #37 removed the payTo check
  as security theater; the proxy's trust anchor is the `url` record, bound to
  the bond by the subname's owner matching the Arc provider. The ENS `address`
  record is now labelled `Address record` in the provenance block, with the
  block's closing note saying outright that nothing checks it against the 402
  challenge. `web/src/diagram.js` still says "checks payTo against ENS" on the
  landing schematic and is stale for the same reason.

- **"On the record" names the chain that was read.** Registry address and
  network, service id, subname, provider (linked to its console), upstream
  URL. The registry row renders in live mode only — naming a chain address on
  a page showing seeded data would be provenance the page does not have.

- **Refunds are formatted at six places, not four** (`formatRefundUsdc`). A
  refund is capped at what was paid on the 6-decimal x402 leg, so a real
  credit can be 1e12 wei; four places rendered three of `portfolio`'s refunds
  as `0 USDC`, which is the ledger reporting no refund on rows where the chain
  credited one. Anything below six places reports as `< 0.000001 USDC` rather
  than rounding to nothing.

- **The scores carry their provenance and their arithmetic.** A muted line
  under the head names the window and the subname they were published on; the
  bond carries what has been refunded out of it, so the figure reconciles with
  the deposit. Where nothing is published the explanation is promoted from
  that grey line to a left-ruled standing note — "why is this blank" is the
  reader's live question. When Sepolia itself failed, that note is suppressed:
  the hourly run may well have written the subname, and the unreachable
  warning is the honest account.

- **The verdict strip is labelled "oldest first".** It runs oldest-first while
  the table under it runs newest-first, and an unlabelled row of marks gives a
  reader no way to know that.

## Unresolved

- No block-explorer links: `explorer.testnet.arc.network` does not resolve
  (`docs/walkthrough.md` still links to it). Request ids, payer and block
  carry full values in `title` attributes instead.
- The marketplace row still renders a bond at two places for column fit, so it
  shows `9.99 USDC` where this page shows `9.997 USDC`. Truncation is downward
  in both, and the head's "0.003 USDC refunded out" reconciles it.
