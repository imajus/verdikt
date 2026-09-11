# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary (confirmed): hackathon judges and demo viewers.** Someone evaluating the
Verdikt submission in a few minutes, usually cold, often alongside the 3-minute
video cut (`docs/shot-list.md`) and the written tour (`docs/walkthrough.md`).
Their job is to decide whether the verification loop is real and whether it
works. They arrive with no account, no wallet connected, and no prior knowledge
of x402, Arc, or CRE.

Two eventual audiences the product is *built for* but should not be optimized
for ahead of the above:

- **Agent operators** — developers pointing a paying agent at an x402 service and
  wanting assurance that a broken promise is refunded without arbitration. Note
  that the agent itself never visits this dashboard; it calls the proxy. This
  surface is read by the human behind it.
- **Providers** — developers who register a service on Arc, bond a deposit,
  publish an SLA to ENS, and manage it from the provider console (live mode only).

## Product Purpose

A marketplace of x402-gated API services whose delivery is verified per call. The
dashboard is the primary demo surface: it shows what each service *promised* (the
SLA it published to ENS) beside what it *delivered* (the verdict ledger on Arc),
plus bonds, refunds and trailing-7-day conformance/availability scores. Success is
a viewer understanding, without being told twice, that a verdict is written by a
confidential workflow rather than claimed by anyone, and that a failure refunds the
caller automatically.

## Positioning

Delivery is verified per call inside a Chainlink CRE Confidential Workflow against
the provider's own published SLA, and a failed verdict auto-refunds the caller from
the provider's bonded deposit — with **no dispute or arbitration step by design**.
A neighbouring API marketplace cannot truthfully copy the claim, because it requires
the whole pipeline: a proxy that replays the paid call in an enclave, an SLA that
lives as a per-key-scoped ENS text record the provider alone can write, and an
on-chain bond the refund is drawn from.

Supporting mechanism facts that are part of the position, not decoration:

- The refund is capped at `min(fixed refund, what was paid, what remains of the
  bond)` — never a penalty on top, so a manufactured FAIL is never profitable.
- The observed response value never goes on-chain; it reaches only the agent that
  paid for it.
- A service nobody has called scores 1000, not 0 — no traffic is presumed healthy.

## Operating Context

- **Static site, no backend, no accounts.** The browser reads Arc Testnet (registry,
  bonds, verdicts, refunds) and Ethereum Sepolia (ENS: SLA, url, address,
  conformance, availability) directly over public RPC. Verdikt holds no key and
  takes no custody.
- **Two modes.** Unconfigured, `src/source.js` serves seeded demo data so the
  marketplace is never empty; configured (`web/.env.local`), it reads both live
  chains and the provider console appears in the nav. Design must hold up in both.
- **Every write is a transaction the visitor signs** — wallet connect via
  Web3-Onboard, plus a short-lived SIWE proof for provider actions.
- **Deployed two ways:** an assets-only Cloudflare Worker
  (`verdikt-web.denis-perov.workers.dev`) and nginx via Docker. Both resolve any
  unmatched path to `index.html`, which is what makes real routes work.
- Routes: `/` landing, `/marketplace`, `/services/:slug`, `/provider[/:address]`,
  `/how`, `/terms`, `/privacy`.

## Capabilities and Constraints

- Lit + Vite + Web Awesome components; JS with ESM, no TypeScript (types in ambient
  `*.d.ts`). Light and dark themes, persisted to local storage.
- **Config is inlined at build time.** A deployed bundle cannot be repointed at
  another chain without rebuilding, and everything `VITE_`-prefixed is public.
- **No server-side logic at all** — no SSR, no API routes, no analytics endpoint.
  Anything that needs a secret belongs in `proxy/`, not here.
- Terminology the interface must keep exact, because each word is a distinct
  on-chain fact: **conformance** (share of responses that met the SLA) vs
  **availability** (share of paid calls that returned anything usable); **PASS /
  FAIL / DOWN**; **bond**; **contested** (ENS subname and Arc registration owned by
  different addresses — the proxy refuses to route); **status only** (judged without
  an SLA in force); **delivery** (the implicit clause no provider declares);
  **edited since** (a verdict names a clause the SLA no longer declares). Flattening
  any pair of these loses a fact worth showing.
- Undecided / deliberately unfinished, and not to be papered over in copy: a paid
  call end to end, production CRE enrollment, and the recorded video. Each is
  argued at its own task in `docs/Tasks.md`.

## Brand Commitments

- Name **Verdikt**. Existing wordmark and gradient verification mark
  (`web/public/favicon.svg` and the icon set); the mark plus wordmark lockup lives
  in the nav.
- Established tagline (`TAGLINE` in `src/pages.js`): *"x402 services whose delivery
  is verified per call. Every response is judged against the SLA its provider
  published; a broken promise refunds the caller from the provider's bond."*
- Voice as written today: plain, precise, and willing to explain the mechanism
  rather than sell it. It names its own limits out loud — the legal pages say
  outright they are a hackathon demo and not reviewed legal advice, and the empty
  states explain *why* a number is what it is. Preserve that; do not add marketing
  claims the chain cannot back.
- Links: GitHub `imajus/verdikt`, X `@denismajus`.

## Evidence on Hand

Real, and read back off a chain — never to be fabricated or rounded for effect:

- `docs/evidence/` — transcripts of the end-to-end loop on public testnets.
- `docs/walkthrough.md` — the written tour; `docs/shot-list.md` — the 3-minute cut.
- Arc Testnet `VerdiktRegistry` at `0xE182626142E63EF440421cb0c5e4DEbeEF76E4Af`: two
  services bonded, three verdicts written through the real KeystoneForwarder,
  refunds credited and withdrawn.
- Sepolia: `verdikt.eth` with two subnames carrying real `sla`, `url` and `address`
  records, plus scores published by the hourly workflow.

**Absent, and must not be invented:** customers, testimonials, usage numbers,
pricing, uptime claims, press, or any partner endorsement. There are no users yet.

## Product Principles

1. **Show the promise next to the delivery.** The SLA and the verdict ledger belong
   on the same page; the product's whole claim is the comparison between them.
2. **Every number on screen is read off a chain.** No illustrative figures, no
   rounded-up stats, no placeholder metrics that could be mistaken for real ones.
3. **Explain the mechanism, don't assert the outcome.** A cold viewer who does not
   know x402 should leave understanding how a refund happens, not that it is
   trustworthy.
4. **Name limits out loud.** Demo mode, unpublished scores, a contested slug, an
   unreachable naming layer, and the unfinished pieces are stated plainly rather
   than hidden — the honesty is the credibility.
5. **Nothing here needs a server.** Any design that would require a backend,
   an account, or stored personal data is out of bounds by construction.
