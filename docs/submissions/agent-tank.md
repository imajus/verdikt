# Agent Tank submission — every field, ready to paste

**Portal:** <https://portal.genlayer.foundation/agent-tank/hackathon/submit>
**Track:** Agentic Commerce Infrastructure
**Deadline:** Sep 17 2026, 15:30 UTC

Tracked as [#86](https://github.com/imajus/verdikt/issues/86). This file is the
submission text, kept here rather than in a scratch document so the claims in it
can be checked against the code that backs them.

Every character count below was measured, not estimated.

---

## Repository

<https://github.com/imajus/verdikt/tree/feat/genlayer>

**Check before submitting:** the portal may want a default branch rather than a
branch URL. `main` is frozen for the ETHOnline submission and carries none of
this work, so if a branch link is rejected the options are a tag on
`feat/genlayer` or a fork whose default branch is this one. Do not merge to
`main` to satisfy the form.

## Logo

`web/public/icon-512.png` — 512×512 PNG, 55KB. Inside the portal's 128–2048px
and 2MB limits.

## Project name

```
Verdikt
```

## One-liner (max 180)

```
Every delivered API call gets a verdict. Chainlink CRE judges what a machine can check; a GenLayer jury judges whether the answer was good. Refunds settle on-chain, no arbiter.
```

*176 characters.*

## Description (max 1000)

```
x402 lets an agent pay for an API call. Nothing checks that the call delivered.

Verdikt proxies the call. A Chainlink CRE Confidential Workflow replays the payment inside a TEE, judges the response against the provider's own published SLA, writes PASS/FAIL/DOWN to Arc and auto-refunds from the provider's bond. That leg is live on testnets today.

But CRE's judgement is pure by design: no I/O, no clock, no network. It knows the JSON parsed and arrived on time. It cannot know the summary summarised the wrong document.

So a provider declares a `semantic` clause — plain English, binding — and a consumer who disagrees files a claim on GenLayer. SlaClaimJudge fetches the request and response as evidence; validators judge it independently under Optimistic Democracy, comparing outcomes rather than rubber-stamping a leader. BREACH pays the consumer from the provider's deposit.

Two judgements, deliberately separate. A call can be CRE PASS and semantically BREACH — the fact worth showing.
```

*995 characters.*

## Live demo URL

```
https://verdikt-web.denis-perov.workers.dev
```

Live and answering 200. The marketplace reads Arc and Sepolia from the browser;
every verdict and score on it was read back off a chain.

## How-to steps

```
1. Open https://verdikt-web.denis-perov.workers.dev — the marketplace reads Arc
   and Ethereum Sepolia live from your browser. Every service listed is a real
   third-party x402 provider behind a Verdikt proxy.

2. Open any service. Its SLA comes from the `sla` text record on
   <slug>.verdikt.eth; its conformance and availability scores are written
   hourly by a Chainlink CRE workflow. The verdict table underneath is real
   traffic — request id, outcome, refund, block.

3. Read the deterministic leg's evidence in docs/evidence/ in the repo. Every
   number there was read back off a chain, including a live x402 payment and
   the confidential workflow's own simulate log.

4. The GenLayer half lives in genlayer/. Read docs/roadmap/genlayer.md first —
   it is the design, and it is newer than the issues.

5. Run it:
       cd genlayer
       python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
       .venv/bin/genvm-lint setup
       .venv/bin/python -m pytest tests/direct -q        # state machine, refusals, settlement maths
       .venv/bin/glsim --port 4000 --no-browser &
       .venv/bin/gltest tests/integration -q             # the judge and the token, wired together

6. Both contracts are live on Studio Devnet (chain 61997) — the record is
   deployments/genlayer-studio-devnet.json in the repo:
       SettlementToken  0xDb079bb8071a34A30C7aB9F86bD563151EAffCb4
       SlaClaimJudge    0x1d75FFdFF568f929f515fa17cB0E64D38d1a5cf2

7. Or deploy your own:
       cp .env.example .env            # then fill in GENLAYER_PRIVATE_KEY
       .venv/bin/python scripts/deploy.py
   Funding is one sim_fundAccount RPC call, no faucet. It deploys the token
   first, the judge second, and reads both back off chain. Consensus takes
   minutes, not seconds.
```

## Private notes for judges (max 500)

```
Honest scope: the deterministic leg (CRE, Arc, ENS) has been live on testnets for weeks — docs/evidence/ has the transcripts. The GenLayer leg is new on feat/genlayer: 108 direct tests plus an integration suite against a real node.

Both contracts are live on Studio Devnet (61997), addresses in the how-to. Reaching it needs the v0.19 client, an explicit fee distribution (genlayer-cli#421) and the v0.6 runner — a different SDK surface, so the contracts were migrated to it.
```

*476 characters.*

## Demo video

Optional, and not recorded. The ETHOnline submission's video is also still open
(`docs/Tasks.md`), so this is a known gap rather than a new one.

---

## What a judge will find if they look

Worth being straight about, because the submission text above is compressed:

- **Live and real:** the CRE leg. `VerdiktRegistry` on Arc Testnet, subnames and
  hourly scores on Sepolia, the proxy on `*.verdikt.bond`, real agents paying
  real providers. `docs/evidence/`.
- **Deployed and exercised:** the GenLayer leg. `SlaClaimJudge` and
  `SettlementToken` on Studio Devnet, deployed and read back off chain, with a
  real `mint` write settled through consensus. The proxy's SLA and evidence
  endpoints are built and tested but **not yet deployed**, so a claim opened
  against the live judge would resolve `UNDETERMINED` for want of evidence —
  see genlayer/scripts/_networks.py for what reaching that network takes.
- **Designed, not built:** the dashboard surfacing semantic settlements (#91),
  the `semanticConformance` score (#92), the claimant CLI (#94).
