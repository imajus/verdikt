// The How it works page's request-path schematic.
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
// once when the figure scrolls into view, each block coming up to full ink as
// the line reaching it lands, which needs a lifecycle hook and an
// IntersectionObserver. Nothing is hidden to achieve it — the paths render
// fully drawn and every block at full opacity, and `.drawing` is added only at
// the moment the animation starts, so a reader with no JavaScript, or with
// reduced motion asked for, sees the finished figure instead of an empty frame.
//
// A block is a `<g class="dg-stage">` carrying its own `--r` reveal delay; the
// grouping is what the fade needs, since a block is a frame, a logo and three
// or four labels that have to come up together. Timings live in styles.css.
//
// **ENS is deliberately absent, and the hourly aggregate with it.** Both are
// real and live, and neither is something a reader of this page has to hold:
// where an SLA is hosted is infrastructure, and a trailing reputation score is
// a marketplace figure shown as a number where it is actually used. Naming a
// second chain to explain the storage of a document bought the figure a whole
// band and a pair of crossing reads, for nothing the paying agent does. So the
// facts those reads carried now sit on the blocks that own them — the proxy
// relays to the registered endpoint, the workflow judges the published SLA —
// and the band they occupied went to GenLayer instead. This also means the
// figure survives issue #116, which drops ENS outright and has not yet decided
// where an SLA will live afterwards: a figure that never named the host has
// nothing to correct.

import { LitElement, html } from 'lit';

const TITLE = 'How one paid call is judged';
const DESC =
  'A paying agent sends its x402 payment to the Verdikt proxy, which relays the call to the provider’s registered endpoint. The call is replayed inside a Chainlink CRE confidential workflow, which evaluates the provider’s response against the SLA that provider published, without letting the response leave the enclave. The workflow writes PASS, FAIL or DOWN to the VerdiktRegistry on Arc; a FAIL or DOWN credits the payer from the provider’s bond, capped at the smaller of the fixed refund, what was paid, and what remains of the bond, and the agent calls withdraw to collect. Separately, and only when a consumer disputes what the response meant, that consumer files a bonded claim with the SlaClaimJudge on GenLayer, which binds the claim to the verdict already on Arc and settles it MET, BREACH, UNDETERMINED or CANCELLED.';

// Neither figure interpolates anything: server-side rendering parses an <svg>
// subtree as HTML, where a `${}` between SVG children silently loses its part
// and the whole template throws. So the markers are written out per variant
// with literal ids, and the figure's text alternative lives outside the svg —
// where it is also the more useful place for it.
//
// Horizontal: the request path across the middle, Arc under it, GenLayer under
// that. Reading down the figure is reading outward in time — what every call
// does, then what is recorded, then what is only ever done on dispute.
//
// The trace runs in the order a call actually travels, one step a second:
// agent → proxy → CRE → provider → CRE → Arc → agent, and then, a beat later
// and pointing the other way, GenLayer → Arc. That last one is dashed and
// arrives last on purpose: it is a coda, not a step, and a reader who stops
// watching before it has still seen a complete paid call.
const wide = () => html`
  <svg class="dg dg-wide" viewBox="0 0 900 354" role="img" aria-label="How one paid call is judged" aria-describedby="dg-alt">
    <defs>
      <marker id="dgw-tip" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="dg-tip" d="M0,0 L8,4 L0,8 Z"></path>
      </marker>
      <marker id="dgw-tip-quiet" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path class="dg-tip quiet" d="M0,0 L8,4 L0,8 Z"></path>
      </marker>
    </defs>

    <g class="dg-stage" style="--r:1900ms">
      <rect class="dg-bound dg-cre" x="422" y="26" width="228" height="90"></rect>
      <text class="dg-band end dg-cre" x="640" y="112.5">ENCLAVE BOUNDARY</text>
      <rect class="dg-box dg-cre" x="428" y="40" width="216" height="62"></rect>
      <use class="dg-logo dg-cre" href="#lg-cre" x="440" y="53" width="13" height="13"></use>
      <text class="dg-title" x="459" y="64">CRE confidential workflow</text>
      <text class="dg-sub" x="440" y="82">replays the payment, in a TEE</text>
    </g>

    <g class="dg-stage" style="--r:0ms">
      <rect class="dg-box" x="0" y="40" width="136" height="62"></rect>
      <use class="dg-logo" href="#lg-agent" x="12" y="53" width="13" height="13"></use>
      <text class="dg-title" x="31" y="64">paying agent</text>
      <text class="dg-sub" x="12" y="82">signs its own x402</text>
    </g>

    <g class="dg-stage" style="--r:900ms">
      <rect class="dg-box dg-verdikt" x="192" y="40" width="176" height="62"></rect>
      <use class="dg-logo dg-verdikt" href="#lg-verdikt" x="204" y="53" width="13" height="13"></use>
      <text class="dg-title" x="223" y="64">proxy</text>
      <text class="dg-key sm dg-verdikt" x="204" y="82">service.verdikt.bond</text>
    </g>

    <g class="dg-stage" style="--r:2900ms">
      <rect class="dg-box" x="708" y="40" width="144" height="62"></rect>
      <use class="dg-logo" href="#lg-x402" x="720" y="53" width="13" height="13"></use>
      <text class="dg-title" x="739" y="64">provider</text>
      <text class="dg-key sm" x="720" y="82">x402 endpoint</text>
    </g>

    <g class="dg-stage" style="--r:4900ms">
      <text class="dg-band dg-arc" x="0" y="170">ARC TESTNET</text>
      <text class="dg-cap dg-arc" x="192" y="170">VerdiktRegistry</text>
      <rect class="dg-box dg-arc" x="192" y="178" width="468" height="62"></rect>
      <line class="dg-div dg-arc" x1="424" y1="178" x2="424" y2="240"></line>
      <use class="dg-logo dg-arc" href="#lg-arc" x="204" y="191" width="13" height="13"></use>
      <text class="dg-title" x="223" y="202">the verdict ledger</text>
      <text class="dg-sub" x="204" y="222"><tspan class="dg-pass">PASS</tspan> · <tspan class="dg-fail">FAIL</tspan> · <tspan class="dg-dn">DOWN</tspan>, final</text>
      <text class="dg-key" x="436" y="202">bond and owed[payer]</text>
      <text class="dg-sub" x="436" y="222">refund ≤ min(fixed, paid, bond)</text>
    </g>

    <g class="dg-stage" style="--r:6900ms">
      <text class="dg-band dg-genlayer" x="0" y="270">GENLAYER</text>
      <text class="dg-cap dg-genlayer" x="192" y="270">SlaClaimJudge</text>
      <rect class="dg-box dg-genlayer" x="192" y="278" width="468" height="62"></rect>
      <line class="dg-div dg-genlayer" x1="424" y1="278" x2="424" y2="340"></line>
      <use class="dg-logo dg-genlayer" href="#lg-judge" x="204" y="291" width="13" height="13"></use>
      <text class="dg-title" x="223" y="302">semantic claim</text>
      <text class="dg-sub" x="204" y="322">on dispute, not every call</text>
      <text class="dg-key" x="436" y="302">MET · BREACH</text>
      <text class="dg-sub" x="436" y="322">or UNDETERMINED, charging nobody</text>
    </g>

    <path class="dg-flow" style="--d:0ms" pathLength="1" marker-end="url(#dgw-tip)" d="M136,71 H186"></path>
    <text class="dg-note mid" x="164" y="59">pays</text>

    <path class="dg-flow" style="--d:1000ms" pathLength="1" marker-end="url(#dgw-tip)" d="M368,71 H424"></path>
    <text class="dg-note mid" x="398" y="59">replays</text>

    <path class="dg-flow" style="--d:2000ms" pathLength="1" marker-end="url(#dgw-tip)" d="M644,63 H702"></path>
    <text class="dg-note mid" x="676" y="51">calls</text>
    <path class="dg-read" style="--d:3000ms" marker-end="url(#dgw-tip-quiet)" d="M702,81 H648"></path>
    <text class="dg-note mid" x="676" y="97">response</text>

    <path class="dg-flow dg-arc" style="--d:4000ms" pathLength="1" marker-end="url(#dgw-tip)" d="M540,120 V172"></path>
    <text class="dg-note end" x="530" y="136">setVerdict</text>
    <text class="dg-note end" x="530" y="150"><tspan class="dg-pass">PASS</tspan> · <tspan class="dg-fail">FAIL</tspan> · <tspan class="dg-dn">DOWN</tspan></text>
    <text class="dg-note" x="560" y="136">judged against the SLA</text>
    <text class="dg-note" x="560" y="150">the provider published</text>

    <path class="dg-flow dg-arc" style="--d:5000ms" pathLength="1" marker-end="url(#dgw-tip)" d="M192,208 H68 V108"></path>
    <text class="dg-note" x="78" y="128">owed[payer]</text>
    <text class="dg-note" x="78" y="142">the agent calls withdraw()</text>

    <path class="dg-read dg-genlayer" style="--d:6000ms" marker-end="url(#dgw-tip-quiet)" d="M300,278 V244"></path>
    <text class="dg-note" x="310" y="264">binds the claim to that verdict</text>
  </svg>`;

// Vertical: the same six stages stacked, each fact folded into the stage that
// owns it so no connector has to cross the column on a narrow screen.
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

    <g class="dg-stage" style="--r:0ms">
      <rect class="dg-box" x="44" y="8" width="304" height="64"></rect>
      <use class="dg-logo" href="#lg-agent" x="56" y="22" width="15" height="15"></use>
      <text class="dg-title" x="77" y="34">paying agent</text>
      <text class="dg-sub" x="56" y="54">signs its own x402 payment</text>
    </g>

    <path class="dg-flow" style="--d:0ms" pathLength="1" marker-end="url(#dgt-tip)" d="M196,72 V118"></path>
    <text class="dg-note" x="206" y="100">pays</text>

    <g class="dg-stage" style="--r:900ms">
      <rect class="dg-box dg-verdikt" x="44" y="124" width="304" height="64"></rect>
      <use class="dg-logo dg-verdikt" href="#lg-verdikt" x="56" y="138" width="15" height="15"></use>
      <text class="dg-key sm dg-verdikt" x="77" y="150">proxy · service.verdikt.bond</text>
      <text class="dg-sub" x="56" y="170">relays to the registered endpoint</text>
    </g>

    <path class="dg-flow" style="--d:1000ms" pathLength="1" marker-end="url(#dgt-tip)" d="M196,188 V232"></path>
    <text class="dg-note" x="206" y="214">replayed in a TEE</text>

    <g class="dg-stage" style="--r:1900ms">
      <rect class="dg-bound dg-cre" x="34" y="238" width="314" height="92"></rect>
      <rect class="dg-box dg-cre" x="44" y="248" width="304" height="72"></rect>
      <use class="dg-logo dg-cre" href="#lg-cre" x="56" y="260" width="15" height="15"></use>
      <text class="dg-title" x="77" y="272">CRE confidential workflow</text>
      <text class="dg-sub" x="56" y="292">replays the payment in a TEE</text>
      <text class="dg-sub" x="56" y="308">judges the published SLA</text>
    </g>

    <path class="dg-flow" style="--d:2000ms" pathLength="1" marker-end="url(#dgt-tip)" d="M196,330 V366"></path>
    <text class="dg-note" x="206" y="354">calls the endpoint</text>

    <g class="dg-stage" style="--r:2900ms">
      <rect class="dg-box" x="44" y="372" width="304" height="64"></rect>
      <use class="dg-logo" href="#lg-x402" x="56" y="386" width="15" height="15"></use>
      <text class="dg-title" x="77" y="398">provider’s x402 endpoint</text>
      <text class="dg-sub" x="56" y="418">the body never leaves it</text>
    </g>

    <path class="dg-flow dg-arc" style="--d:3000ms" pathLength="1" marker-end="url(#dgt-tip)" d="M196,436 V482"></path>
    <text class="dg-note" x="206" y="462">writes the verdict</text>

    <g class="dg-stage" style="--r:3900ms">
      <rect class="dg-box dg-arc" x="44" y="488" width="304" height="80"></rect>
      <use class="dg-logo dg-arc" href="#lg-arc" x="56" y="500" width="15" height="15"></use>
      <text class="dg-cap dg-arc" x="77" y="512">VerdiktRegistry on Arc</text>
      <text class="dg-sub" x="56" y="532"><tspan class="dg-pass">PASS</tspan> · <tspan class="dg-fail">FAIL</tspan> · <tspan class="dg-dn">DOWN</tspan>, final</text>
      <text class="dg-sub" x="56" y="550">refund ≤ min(fixed, paid, bond)</text>
    </g>

    <path class="dg-flow dg-arc" style="--d:5000ms" pathLength="1" marker-end="url(#dgt-tip)" d="M44,528 H24 V38 H38"></path>
    <text class="dg-note mid" transform="rotate(-90 18 300)" x="18" y="300">owed[payer] · withdraw()</text>

    <path class="dg-read dg-genlayer" style="--d:4000ms" marker-end="url(#dgt-tip-quiet)" d="M196,568 V618"></path>
    <text class="dg-note" x="206" y="598">on dispute only</text>

    <g class="dg-stage" style="--r:4900ms">
      <rect class="dg-box dg-genlayer" x="44" y="624" width="304" height="60"></rect>
      <use class="dg-logo dg-genlayer" href="#lg-judge" x="56" y="638" width="15" height="15"></use>
      <text class="dg-key sm dg-genlayer" x="77" y="650">SlaClaimJudge on GenLayer</text>
      <text class="dg-sub" x="56" y="670">MET · BREACH · UNDETERMINED</text>
    </g>
  </svg>`;

// Partner marks, each taken from its owner's own artwork and normalised into a
// shared 24-unit box so the logos, drawn at five scales, sit at one optical
// weight. They ship as one sprite both figures reference, never duplicated.
// Sources: Chainlink from chain.link/brand-assets (via simple-icons, CC0);
// Arc's arch and x402's cross lifted from the official wordmarks at
// arc.network and x402.org; the droplet is Verdikt's own favicon; the paying
// agent's mark is Material Symbols' smart_toy (Apache 2.0), chosen over a more
// detailed robot glyph because it is still legible at 13px.
//
// Two of the six are deliberately *not* anybody's logo. The paying agent is a
// role rather than a brand, and so is the claim judge: GenLayer publishes a
// mark, but drawing one from memory would put a wrong version of somebody
// else's identity on the page, which is worse than drawing none. So the judge
// gets a plain balance scale on the same terms the agent gets a robot — the
// thing it does, not who made it.
//
// All are drawn in one flat colour — the zone they sit in, or ink for the two
// parties (agent, provider) that belong to no zone — which is identification
// inside a schematic, not a badge of endorsement.
const marks = () => html`
  <svg class="dg-marks" aria-hidden="true" focusable="false">
    <defs>
      <symbol id="lg-cre" viewBox="0 0 24 24">
        <path transform="translate(0.000 0.000) scale(1.00000)" d="M12 0L9.798 1.266l-6 3.468L1.596 6v12l2.202 1.266 6.055 3.468L12.055 24l2.202-1.266 5.945-3.468L22.404 18V6l-2.202-1.266-6-3.468zM6 15.468V8.532l6-3.468 6 3.468v6.936l-6 3.468z"></path>
      </symbol>
      <symbol id="lg-arc" viewBox="0 0 24 24">
        <path transform="translate(0.552 0.000) scale(0.48000)" d="M23.8574 0C31.0115 0 37.371 6.19775 41.7656 17.4521C44.0513 23.3056 45.7332 30.2603 46.7295 37.8262C46.8186 38.5019 46.8939 39.1888 46.9717 39.874C46.9969 39.9162 47.0119 39.9553 47.0068 39.9873C47.0068 39.9873 47.5924 43.6447 47.7168 50H47.6514C46.7829 49.2873 36.54 41.2389 19.5615 43.5693C19.8177 40.6962 20.1699 37.9004 20.625 35.2207C20.6482 35.0838 20.6755 34.9514 20.6992 34.8154C27.3585 34.6146 33.1876 35.3879 37.6572 36.4014C37.6406 36.2954 37.6263 36.1865 37.6094 36.0811C36.6906 30.3599 35.3355 25.1217 33.5879 20.6455C30.7304 13.3264 27.001 8.77832 23.8574 8.77832C20.7141 8.77863 16.9853 13.3266 14.1279 20.6455C13.4363 22.4157 12.8068 24.3036 12.2422 26.2949C11.4483 29.0854 10.7807 32.0773 10.248 35.2207C9.45968 39.8629 8.96755 44.8418 8.78613 50H0C0.405408 37.7593 2.48104 26.3352 5.9502 17.4521C10.3437 6.19798 16.7036 0.000184295 23.8574 0Z"></path>
      </symbol>
      <symbol id="lg-x402" viewBox="0 0 24 24">
        <path transform="translate(0.019 -11.125) scale(0.18824)" d="M10.5,59.5c.6-.6,1.6-.6,2.3,0l50.9,50.9,19.5-19.5c.6-.6,1.6-.6,2.3,0l10,10c.6.6.6,1.7,0,2.3l-14.4,14.4v10.4l45.8,45.8c.6.6.6,1.7,0,2.3l-10,10c-.6.6-1.6.6-2.3,0l-50.9-50.9-50.9,50.9c-.6.6-1.6.6-2.3,0L.5,176.1c-.6-.6-.6-1.7,0-2.3l45.8-45.8v-10.4L.5,71.8c-.6-.6-.6-1.7,0-2.3l10-10Z"></path>
      </symbol>
      <symbol id="lg-agent" viewBox="0 0 24 24">
        <path transform="translate(-1.091 25.636) scale(0.02727)" d="M160-360q-50 0-85-35t-35-85q0-50 35-85t85-35v-80q0-33 23.5-56.5T240-760h120q0-50 35-85t85-35q50 0 85 35t35 85h120q33 0 56.5 23.5T800-680v80q50 0 85 35t35 85q0 50-35 85t-85 35v160q0 33-23.5 56.5T720-120H240q-33 0-56.5-23.5T160-200v-160Zm200-80q25 0 42.5-17.5T420-500q0-25-17.5-42.5T360-560q-25 0-42.5 17.5T300-500q0 25 17.5 42.5T360-440Zm240 0q25 0 42.5-17.5T660-500q0-25-17.5-42.5T600-560q-25 0-42.5 17.5T540-500q0 25 17.5 42.5T600-440ZM320-280h320v-80H320v80Z"></path>
      </symbol>
      <symbol id="lg-judge" viewBox="0 0 24 24">
        <path d="M11.3 3.2h1.4v17.2h-1.4zM6.5 20.4h11v1.4h-11zM4 5.6h16v1.4H4zM1 7.4h6.4L4.2 12.6zM16.6 7.4H23l-3.2 5.2z"></path>
      </symbol>
      <symbol id="lg-verdikt" viewBox="0 0 24 24">
        <path transform="translate(-4.879 -5.275) scale(0.13187)" d="M128,40 C170,40 198,72 198,112 C198,160 128,222 128,222 C128,222 58,160 58,112 C58,72 86,40 128,40 Z"></path>
      </symbol>
    </defs>
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
    return html`<p class="visually-hidden" id="dg-alt">${TITLE}. ${DESC}</p>${marks()}${wide()}${tall()}`;
  }
}

if (!customElements.get('verdikt-diagram')) customElements.define('verdikt-diagram', VerdiktDiagram);
