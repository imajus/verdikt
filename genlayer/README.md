# GenLayer — SlaClaimJudge

Second, parallel hackathon submission (GenLayer's Agent Tank, track: Agentic
Commerce Infrastructure, deadline Sep 17 2026) built on top of the same
Verdikt marketplace. Lives on the `feat/genlayer` branch; `main` stays frozen
for the ETHOnline submission.

## What this is

Chainlink CRE (`../cre/`) keeps judging deterministic, schema-checkable SLA
clauses on every x402 call, untouched. `SlaClaimJudge` is a second claim-type
handler for deliverables that need judgment rather than a schema match — LLM
output quality, file/media evidence — via a GenLayer Intelligent Contract
using GenLayer's Optimistic Democracy / Equivalence Principle.

See the docstring in `contracts/sla_claim_judge.py` for the design and why
the SLA is fetched from a proxy endpoint rather than re-deriving ENSv2's
resolver ABI encoding inside GenVM.

## Status (Day 1)

- [x] Contract scaffold (`contracts/sla_claim_judge.py`)
- [x] Direct-mode tests with mocked web/LLM (`tests/direct/`)
- [ ] `GET /internal/sla/<slug>` endpoint on `../proxy` wrapping
      `resolveServiceRecord` (Day 2 — contract currently assumes this shape
      but nothing serves it yet)
- [ ] Relay/poller to write the verdict back to Arc for escrow release (Day 2)
- [ ] Deploy to Bradbury testnet (Day 2)
- [ ] Submission assets via the Agent Tank portal (Day 3)

## Commands

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

pytest tests/direct/ -v          # fast, no Studio needed
genvm-lint check contracts/sla_claim_judge.py
gltest tests/integration/ -v -s  # requires `genlayer up` (Studio)
```
