// The landing page's request-path schematic.
//
// Drawn, not generated: a technical figure in the same hairline weights the
// ledger tables use, so the mechanism is set in the page's own language rather
// than dropped in as a picture. Two authored viewBoxes rather than one that
// scales — a horizontal figure squeezed onto a phone either sets its labels at
// eight pixels or asks the reader to swipe a diagram sideways, and this page's
// centre figure may do neither. CSS picks one; the other leaves the
// accessibility tree with it.
//
// Every stroke and fill comes from a CSS class in styles.css, never an
// attribute, because the whole figure has to invert with the theme.
//
// This is a custom element rather than a template function for one reason: the
// page's single authored motion lives here. The flow lines trace themselves
// once when the figure scrolls into view, which needs a lifecycle hook and an
// IntersectionObserver. Nothing is hidden to achieve it — the paths render
// fully drawn, and `.drawing` is added only at the moment the animation starts,
// so a reader with no JavaScript, or with reduced motion asked for, sees the
// finished figure instead of an empty frame.

import { LitElement, html } from 'lit';

const TITLE = 'How one paid call is judged';
const DESC =
  'A paying agent sends its x402 payment to the Verdikt proxy. Without a payment the proxy compares the challenge’s payout address against the address record on ENS and blocks a mismatch. With a payment, the call is replayed inside a Chainlink CRE confidential workflow, which reads the service’s SLA from ENS and evaluates the provider’s response against it without letting the response leave the enclave. The workflow writes PASS, FAIL or DOWN to the VerdiktRegistry on Arc; a FAIL or DOWN credits the payer from the provider’s bond, capped at the smaller of the fixed refund, what was paid, and what remains of the bond, and the agent calls withdraw to collect. Separately, an hourly workflow reads the verdict events off Arc and publishes trailing seven-day conformance and availability scores back to ENS.';

// Neither figure interpolates anything: server-side rendering parses an <svg>
// subtree as HTML, where a `${}` between SVG children silently loses its part
// and the whole template throws. So the markers are written out per variant
// with literal ids, and the figure's text alternative lives outside the svg —
// where it is also the more useful place for it.
//
// Horizontal: ENS above, the request path across the middle, Arc below.
const wide = () => html`
  <svg class="dg dg-wide" viewBox="0 0 900 372" role="img" aria-label="How one paid call is judged" aria-describedby="dg-alt">
    <defs>
      <marker id="dgw-tip" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="dg-tip" d="M0,0 L8,4 L0,8 Z"></path>
      </marker>
      <marker id="dgw-tip-quiet" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path class="dg-tip quiet" d="M0,0 L8,4 L0,8 Z"></path>
      </marker>
    </defs>

    <text class="dg-band" x="0" y="20">ETHEREUM SEPOLIA · ENS</text>
    <text class="dg-cap" x="204" y="20">&lt;slug&gt;.verdikt.eth</text>
    <rect class="dg-box" x="204" y="28" width="440" height="64"></rect>
    <line class="dg-div" x1="424" y1="28" x2="424" y2="92"></line>
    <text class="dg-key" x="216" y="52">sla · url · address</text>
    <text class="dg-sub" x="216" y="72">the provider writes these</text>
    <text class="dg-key" x="436" y="52">conformance · availability</text>
    <text class="dg-sub" x="436" y="72">only the CRE signer can</text>

    <rect class="dg-bound" x="422" y="150" width="228" height="90"></rect>
    <text class="dg-band end" x="650" y="142">ENCLAVE BOUNDARY</text>

    <rect class="dg-box" x="0" y="164" width="136" height="62"></rect>
    <text class="dg-title" x="12" y="188">paying agent</text>
    <text class="dg-sub" x="12" y="206">signs its own x402</text>

    <rect class="dg-box" x="192" y="164" width="176" height="62"></rect>
    <text class="dg-title" x="204" y="188">proxy</text>
    <text class="dg-key sm" x="204" y="206">&lt;slug&gt;.verdikt.bond</text>

    <rect class="dg-box" x="428" y="164" width="216" height="62"></rect>
    <text class="dg-title" x="440" y="188">CRE confidential workflow</text>
    <text class="dg-sub" x="440" y="206">replays the payment, in a TEE</text>

    <rect class="dg-box" x="708" y="164" width="144" height="62"></rect>
    <text class="dg-title" x="720" y="188">provider</text>
    <text class="dg-key sm" x="720" y="206">x402 endpoint</text>

    <text class="dg-band" x="0" y="288">ARC TESTNET</text>
    <text class="dg-cap" x="192" y="288">VerdiktRegistry</text>
    <rect class="dg-box" x="192" y="296" width="468" height="62"></rect>
    <line class="dg-div" x1="424" y1="296" x2="424" y2="358"></line>
    <text class="dg-title" x="204" y="320">the verdict ledger</text>
    <text class="dg-sub" x="204" y="340">PASS · FAIL · DOWN, final</text>
    <text class="dg-key" x="436" y="320">bond and owed[payer]</text>
    <text class="dg-sub" x="436" y="340">refund ≤ min(fixed, paid, bond)</text>

    <path class="dg-flow" style="--d:0ms" pathLength="1" marker-end="url(#dgw-tip)" d="M136,195 H186"></path>
    <text class="dg-note mid" x="164" y="183">pays</text>

    <path class="dg-flow" style="--d:150ms" pathLength="1" marker-end="url(#dgw-tip)" d="M368,195 H424"></path>
    <text class="dg-note mid" x="398" y="183">replays</text>

    <path class="dg-flow" style="--d:300ms" pathLength="1" marker-end="url(#dgw-tip)" d="M644,187 H702"></path>
    <text class="dg-note mid" x="676" y="175">calls</text>
    <path class="dg-read" pathLength="1" marker-end="url(#dgw-tip-quiet)" d="M702,205 H648"></path>
    <text class="dg-note mid" x="676" y="221">response</text>

    <path class="dg-read" marker-end="url(#dgw-tip-quiet)" d="M280,164 V98"></path>
    <text class="dg-note" x="290" y="118">reads the address record</text>
    <text class="dg-note" x="290" y="132">and blocks a mismatch</text>

    <path class="dg-read" marker-end="url(#dgw-tip-quiet)" d="M540,150 V98"></path>
    <text class="dg-note" x="550" y="118">reads the sla</text>

    <path class="dg-flow" style="--d:450ms" pathLength="1" marker-end="url(#dgw-tip)" d="M540,240 V290"></path>
    <text class="dg-note end" x="530" y="262">setVerdict</text>
    <text class="dg-note end" x="530" y="276">PASS · FAIL · DOWN</text>

    <path class="dg-flow" style="--d:600ms" pathLength="1" marker-end="url(#dgw-tip)" d="M192,326 H68 V232"></path>
    <text class="dg-note" x="78" y="252">owed[payer]</text>
    <text class="dg-note" x="78" y="266">the agent calls withdraw()</text>

    <path class="dg-read" marker-end="url(#dgw-tip-quiet)" d="M660,326 H872 V60 H652"></path>
    <text class="dg-note end" x="858" y="112">hourly, plain workflow</text>
    <text class="dg-note end" x="858" y="126">trailing 7-day ratios</text>
  </svg>`;

// Vertical: the same six stages stacked, ENS reads folded into each stage's
// own line so no connector has to cross the column on a narrow screen.
const tall = () => html`
  <svg class="dg dg-tall" viewBox="0 0 380 700" role="img" aria-label="How one paid call is judged" aria-describedby="dg-alt">
    <defs>
      <marker id="dgt-tip" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="dg-tip" d="M0,0 L8,4 L0,8 Z"></path>
      </marker>
      <marker id="dgt-tip-quiet" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path class="dg-tip quiet" d="M0,0 L8,4 L0,8 Z"></path>
      </marker>
    </defs>

    <rect class="dg-box" x="44" y="8" width="304" height="64"></rect>
    <text class="dg-title" x="56" y="34">paying agent</text>
    <text class="dg-sub" x="56" y="54">signs its own x402 payment</text>

    <path class="dg-flow" style="--d:0ms" pathLength="1" marker-end="url(#dgt-tip)" d="M196,72 V118"></path>
    <text class="dg-note" x="206" y="100">pays</text>

    <rect class="dg-box" x="44" y="124" width="304" height="64"></rect>
    <text class="dg-key sm" x="56" y="150">proxy · &lt;slug&gt;.verdikt.bond</text>
    <text class="dg-sub" x="56" y="170">checks payTo against ENS</text>

    <path class="dg-flow" style="--d:150ms" pathLength="1" marker-end="url(#dgt-tip)" d="M196,188 V232"></path>
    <text class="dg-note" x="206" y="214">replayed in a TEE</text>

    <rect class="dg-bound" x="34" y="238" width="314" height="92"></rect>
    <rect class="dg-box" x="44" y="248" width="304" height="72"></rect>
    <text class="dg-title" x="56" y="272">CRE confidential workflow</text>
    <text class="dg-sub" x="56" y="292">replays the payment in a TEE</text>
    <text class="dg-sub" x="56" y="308">evaluates it against the sla</text>

    <path class="dg-flow" style="--d:300ms" pathLength="1" marker-end="url(#dgt-tip)" d="M196,330 V366"></path>
    <text class="dg-note" x="206" y="354">calls the endpoint</text>

    <rect class="dg-box" x="44" y="372" width="304" height="64"></rect>
    <text class="dg-title" x="56" y="398">provider’s x402 endpoint</text>
    <text class="dg-sub" x="56" y="418">the body never leaves it</text>

    <path class="dg-flow" style="--d:450ms" pathLength="1" marker-end="url(#dgt-tip)" d="M196,436 V482"></path>
    <text class="dg-note" x="206" y="462">writes the verdict</text>

    <rect class="dg-box" x="44" y="488" width="304" height="80"></rect>
    <text class="dg-cap" x="56" y="512">VerdiktRegistry on Arc</text>
    <text class="dg-sub" x="56" y="532">PASS · FAIL · DOWN, final</text>
    <text class="dg-sub" x="56" y="550">refund ≤ min(fixed, paid, bond)</text>

    <path class="dg-flow" style="--d:600ms" pathLength="1" marker-end="url(#dgt-tip)" d="M44,528 H24 V38 H38"></path>
    <text class="dg-note mid" transform="rotate(-90 18 300)" x="18" y="300">owed[payer] · withdraw()</text>

    <path class="dg-read" marker-end="url(#dgt-tip-quiet)" d="M196,568 V618"></path>
    <text class="dg-note" x="206" y="598">hourly aggregate</text>

    <rect class="dg-box" x="44" y="624" width="304" height="60"></rect>
    <text class="dg-key sm" x="56" y="650">conformance · availability on ENS</text>
    <text class="dg-sub" x="56" y="670">trailing 7 days, hourly</text>
  </svg>`;

export class VerdiktDiagram extends LitElement {
  createRenderRoot() { return this; }
  firstUpdated() {
    if (typeof IntersectionObserver !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.classList.add('drawing');
        observer.disconnect();
      }
    }, { threshold: 0.25 });
    observer.observe(this);
  }
  render() {
    // One alternative for both orientations — they describe the same loop, and
    // only one of them is ever in the accessibility tree.
    return html`<p class="visually-hidden" id="dg-alt">${TITLE}. ${DESC}</p>${wide()}${tall()}`;
  }
}

if (!customElements.get('verdikt-diagram')) customElements.define('verdikt-diagram', VerdiktDiagram);
