// A static explainer, drawn from docs/walkthrough.md — what a cold visitor
// needs before "conformance 958" on the marketplace means anything.

export function renderHowItWorks() {
  return `
    <header class="masthead">
      <div>
        <h1><a href="?">Verdikt</a></h1>
        <p class="tagline">How the verification loop works, end to end.</p>
      </div>
    </header>

    <section class="block">
      <h3>Two chains, each for one reason</h3>
      <p>
        <strong>Arc</strong> holds the registry, the escrow, the verdicts and the
        refunds — and the x402 payment itself. USDC is Arc's native gas token, so
        value moves as <code>msg.value</code>, not an ERC-20 transfer: no
        <code>approve</code>/<code>transferFrom</code>, no token address. Payment,
        bond and refund are the same asset on the same chain, which is what removes
        any cross-chain correlation between the leg an agent paid on and the leg it
        is refunded on.
      </p>
      <p>
        <strong>Ethereum Sepolia</strong> holds ENS. The SLA a provider promises
        lives only as the <code>sla</code> text record on
        <code>&lt;slug&gt;.verdikt.eth</code> — there is no SLA field on Arc at
        all. A per-key access list scopes the provider to <code>sla</code> and
        <code>url</code>, and the CRE signer to <code>conformance</code> and
        <code>availability</code>; a provider that tries to write its own score
        is refused on-chain, not by convention.
      </p>
    </section>

    <section class="block">
      <h3>What happens on a paid call</h3>
      <p>
        A proxy sits between the paying agent and the provider's own x402
        endpoint. Without a payment header, it is a plain passthrough — it only
        checks that the 402 challenge's payout address matches what the
        provider published on ENS, so an agent never signs a payment toward a
        spoofed address. With a payment attached, the call is replayed inside a
        Chainlink CRE Confidential Workflow — a TEE the provider's own response
        body passes through, evaluated against the SLA the provider itself
        published, without Verdikt or the node operators ever seeing the raw
        response outside the enclave.
      </p>
      <p>
        The workflow writes one verdict on Arc: PASS, FAIL, or DOWN (nothing
        usable came back at all). A FAIL or DOWN credits the payer from the
        service's own bonded deposit — capped at <code>min(fixed refund, what
        was actually paid, what remains of the bond)</code>, so failing on
        purpose is never profitable.
      </p>
    </section>

    <section class="block">
      <h3>Why there is no dispute layer</h3>
      <p>
        A verdict is final by design. The refund cap keeps a false FAIL from
        being worth manufacturing, and the observed value that decided a
        verdict never goes on-chain — it reaches only the agent that paid for
        it, on that agent's own response headers. Everything else — which
        clause broke, how much was refunded, a service's trailing 7-day
        conformance and availability — is public, on Arc and on ENS, and is
        exactly what this marketplace shows.
      </p>
    </section>`;
}
