# Provider listing and the registration wizard

The provider console does three unrelated jobs on one page. It lists the
address's services; it shows a **detail pane for `owned[0]`** — an arbitrary
service nobody picked; and it carries the registration flow, fragmented so
that the slug step sits *above* the listing while the SLA editor and bond
controls sit *below* it, bound to that same unpicked `owned[0]`.

The fragmentation is what makes it read as one broken form. It is not: the
wizard registers a **new** service, while the SLA editor and bond controls
manage an **existing** one. Splitting them apart is most of this change.

- **The provider page becomes a listing and nothing else** — the same grid
  the marketplace renders, whose rows link to `/services/<slug>`.
- **Managing a service happens on that service's own page**, where the
  reader has already said which service they mean.
- **Registering a service happens at `/register`**, as a four-step wizard
  that collects every input before it spends anything.

## 1 · Routing

`/register` is a static view: it reads no chain data to decide what it is.

| URL | `view` | `slug` | `address` |
| --- | --- | --- | --- |
| `/marketplace` | `marketplace` | `null` | `null` |
| `/services/<slug>` | `service` | the slug | `null` |
| `/provider` | `provider` | `null` | `null` |
| `/provider/0x…` | `provider` | `null` | the address |
| `/register` | `register` | `null` | `null` |

It joins `STATIC_VIEWS` in `web/src/router.js` and `TITLES` as
`List a service — Verdikt`.

**No address in the path, deliberately.** Registration always acts on the
connected wallet, never on an address someone browsed to. A
`/provider/<addr>/new` route would invite `/provider/0xSomeoneElse/new` and
force a guard comparing path to wallet — reintroducing exactly the
routing/authorization conflation that
`2026-09-11-provider-route-authorization-design.md` removed. `/register`
carries no claim about whose page it is, so there is nothing to contradict.

The landing page's `or list a service of your own` link repoints from
`PROVIDER_PATH` to `REGISTER_PATH`. It was the only entry point that pointed
a would-be provider at a console keyed by an address they might not have.

## 2 · The provider page is a listing

`renderProvider` in `web/src/lit-app.js` keeps the page head, the sign-in
aside, and the four figures. It gains an **Add a service** button linking to
`/register`, shown when the viewer is on their own page. It loses:

- the `<div class="layout">` two-column wrapper,
- `<section class="detail">` and its `detailTemplate(target)` call,
- the SLA editor section,
- the bond section,
- and `const target = owned[0]`, which fed all three.

What remains is `listingHead()` + `owned.map(listingRow)` inside
`section.listing.flush` — the same markup `renderMarketplace` emits, so rows
link to `/services/<slug>` with no new row template.

`detailTemplate` itself is untouched and stays exported; §3 is now its only
caller.

The **Add a service** button is gated on `ownPage`, not on `canWrite`. It is
a link, not a mount, so it cannot become a dead control, and `/register`
carries its own connect/sign-in gate (§4) — sending an unsigned owner there
to be told what to do next beats hiding the only path forward.

## 3 · Managing a service happens on the service page

`renderService` renders the public detail exactly as today, then appends the
two owner sections — same `#sla-editor-mount` and `#bond-controls-mount`
ids, same components — when the connected wallet **is** `listing.provider`,
is signed in, and is on Arc or Sepolia.

Both components are already `listing`-driven (`VerdiktSlaEditor.listing`,
`VerdiktBondControls.listing`), so this is a re-binding in `main.js`, not a
rewrite of either. The difference is that `listing` is now the service the
reader navigated to rather than `owned[0]`.

When the connected wallet owns the listing but is not signed in, or is on an
unsupported chain, the service page shows the same *Enable provider actions*
aside the provider page uses. Without it the controls would be silently
absent from a page their owner has every reason to expect them on.

### 3.1 · One authorization helper, two views

`canWrite` in `lit-app.js` and `providerAuthorization` in `main.js` must
agree, or a section renders with no mount behind it (a dead control) or a
mount appears with no section around it (an invisible one). That invariant
now spans two views instead of one, so both sides derive it from a single
shape keyed on the provider address:

```js
// lit-app.js — same computation for either view
writeAuthorization(providerAddress) // → { ownPage, signedIn, supported, canWrite }
```

`renderProvider` passes `route.address`; `renderService` passes
`listing.provider`.

`providerAuthorization` in `main.js` becomes route-aware and resolves the
target the same way the renderer picks one:

| `route.view` | target | `canWrite` |
| --- | --- | --- |
| `service` | the listing matching `route.slug` | wallet owns that listing ∧ session matches |
| `register` | none | wallet connected ∧ session matches |
| `provider` | none | — (no mounts on this page any more) |

`draw()`'s pre-render clearing follows: on `/services/<slug>` an
unauthorized or absent target clears the SLA and bond mounts; on `/register`
an unauthorized wallet clears the wizard. The provider route clears nothing,
because it now mounts nothing.

## 4 · The registration wizard

`/register` renders, in order: the page head; a demo-build notice when
`mode !== 'live'`; a connect prompt when no wallet is attached; the sign-in
aside when a wallet is attached but has no matching session; and otherwise
`<verdikt-wizard id="wizard-mount">` plus a back link to the caller's own
console.

The page renders its chrome **before** the `!this.marketplace` guard — it
needs no listing to be itself, and the marketplace-shaped skeleton would be
a lie on this route. The wizard element renders nothing until `main.js`
supplies `deps`, which it does once `DEPOSIT_AMOUNT` has been read.

### 4.1 · Collect everything, then sign

Today the wizard interleaves typing and signing: a slug is typed, a Sepolia
transaction signs immediately, an Arc transaction spends the bond, and only
then is the provider asked for the URL and the SLA. The deposit is committed
before the SLA the service will be judged against has been written.

The new sequence separates the two phases:

| Step | Content | Wallet |
| --- | --- | --- |
| 1 | Slug, checked for availability against ENS | no |
| 2 | Endpoint URL | no |
| 3 | SLA JSON, validated live | no |
| 4 | Review, then execute | yes |

Back/Next move between 1–3; Next is gated on that step's own validity —
`available` for the slug, `^https?://` for the URL, a parse for the SLA.
Step 4 lists what is about to happen, including the bond amount and which
chain each transaction lands on, behind a single **Register service**.

### 4.2 · Execution order is unchanged

The transactions run in the order the current file's header comment
mandates, for the reason it gives — ENS is claimed before Arc registration,
so a newly registered service can never begin life with conflicting
ownership:

```
1/4  claim     Sepolia   claimSubname
2/4  register  Arc       registerService   ← the bond is spent here
3/4  url       Sepolia   publishUrl
4/4  sla       Sepolia   publishSla
```

Only *input collection* moved. The sequence itself, and the invariant it
protects, are untouched.

### 4.3 · Failure recovery

The current wizard has no story for a reverted or rejected transaction: the
step simply reports `Failed: …` and the provider is left to guess. A
half-registered service is the normal outcome of a rejected step 2, and
restarting from step 1 would find the slug already claimed — by themselves.

Execution is therefore a list of four descriptors with a `done` cursor.
Each success advances it; a failure parks it and records which step failed.
**Retry resumes from the failed step**, so a claimed subname is never
re-claimed.

Steps 1–3 stay editable only while `done === 0`. Once anything is on-chain
the slug is frozen — it names the subname that was claimed, and editing it
would silently retarget the remaining three transactions.

### 4.4 · Two cleanups that fall out

- The wizard's `slaValidity` getter duplicates `describeSlaValidity` in
  `forms/sla-editor.js`. It imports that instead; one SLA-validity message
  for both surfaces.
- `execute()` captures `deps` once at the top rather than reading
  `this.deps` after each `await`. A chain switch mid-run calls
  `ensureSignedChain` → `draw()` → re-mount, which replaces `this.deps`
  while a step is in flight. Capturing removes the window.

## 5 · Styles

`web/src/styles.css` replaces `.wizard-steps` — a flat `<ol>` of three
labels — with a full-page wizard: a numbered progress rail, a step panel, a
Back/Next row, a review table, and the execution progress list with per-step
chain and state. `.editor` and the `verdikt-*` block rules carry over to the
service page unchanged.

## 6 · Tests

| File | Change |
| --- | --- |
| `web/src/router.test.js` | `/register` parses to `view: 'register'`; its title |
| `web/src/main.test.js` | reworked: the wizard mounts on `/register`, not `/provider/<addr>`; SLA and bond mount on `/services/<slug>` only for the owning signed-in wallet, and are cleared on a foreign service page or a wallet change |
| `web/src/forms/wizard.test.js` | new: Next is gated per step; the four actions run in the §4.2 order; a mid-run failure parks `done` and Retry resumes from the failed step rather than the start; steps 1–3 lock once `done > 0` |
| existing provider-render assertions | those naming the detail pane are dropped |

The wallet-change tests in `main.test.js` are the ones worth keeping honest:
the reason they exist is that `verdikt-app` stays mounted across an account
switch, and a stale `deps` would let one provider's controls submit against
another's service. Moving the mounts to different routes does not retire
that hazard, it relocates it.

## Out of scope

- The nav highlights *Marketplace* for `view: 'service'`, so reaching a
  service page from a provider console highlights the wrong tab. Pre-existing
  and cosmetic; left alone.
- No change to `detailTemplate`, the SLA editor's or bond controls' own
  behaviour, `actions.js`, or anything below `web/`.
