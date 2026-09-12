// The SLA composer: clause by clause, with the schema clause read off a
// sample response rather than written as JSON Schema. One element serves both
// the registration wizard and the service page's editor — each holds the SLA
// as the string it will publish, hands it in as `value`, and takes it back
// from `sla-change`. The composer owns the structured draft in between and
// never re-parses text it emitted itself.
//
// JSON is a view, not a second editor: the form emits only the keyword subset
// the verifier enforces, so switching to JSON and back is lossless. A record
// the form cannot show — one `parseSla` rejects — opens in the JSON view with
// the verifier's own reason, which is also what the marketplace would show.
import { LitElement, html, nothing } from 'lit';
import {
  citedClauseIds, draftFromText, draftProblems, draftToPrettyText, draftToText, emptyDraft, extraKeywords,
  inferNode, newClause, refreshId, usdcToMinorUnits
} from './sla-draft.js';
import { describeSlaValidity } from './sla-validity.js';

/** @type {Record<SlaDraftClauseKind, { title: string, blurb: string }>} */
const KINDS = {
  schema: { title: 'Response shape', blurb: 'The fields every response must carry, read off one real response.' },
  latency: { title: 'Response time', blurb: 'How long a call may take, measured by the verifier from send to last byte.' },
  priceRange: { title: 'Price band', blurb: 'What a call may cost the agent, so a paywall cannot quietly charge more.' }
};

const UNIT = /** @type {Record<string, string>} */ ({ string: 'chars', array: 'items' });

const removeIcon = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

/** @param {Event} event */
const valueOf = (event) => /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value;

/** @param {Event} event */
const checkedOf = (event) => /** @type {{checked:boolean}} */ (/** @type {unknown} */ (event.currentTarget)).checked;

export class VerdiktSlaComposer extends LitElement {
  static properties = {
    value: {}, history: { attribute: false },
    draft: { state: true }, view: { state: true }, jsonText: { state: true }, jsonError: { state: true }, openSamples: { state: true }, sampleErrors: { state: true }
  };
  constructor() {
    super();
    /** The SLA text as the parent holds it. */
    this.value = '';
    /** @type {Array<{ failedClauseId: string | null }>} Verdicts on record, for the rename guard. */
    this.history = [];
    /** @type {SlaDraft} */ this.draft = emptyDraft();
    /** @type {'form'|'json'} */ this.view = 'form';
    this.jsonText = '';
    this.jsonError = '';
    /** @type {Set<number>} Clause indices whose sample textarea is open although a tree exists. */
    this.openSamples = new Set();
    /** @type {Record<number, string>} */ this.sampleErrors = {};
    /** @type {string|null} The last text this element emitted, so its own echo is not re-parsed. */
    this.lastEmitted = null;
  }
  createRenderRoot() { return this; }
  /** @param {Map<PropertyKey, unknown>} changed */
  willUpdate(changed) {
    if (changed.has('value') && this.value !== this.lastEmitted) this.load(this.value);
  }
  /**
   * Adopt a record from outside: the published SLA on the service page, or
   * whatever the wizard held when the visitor stepped back to it.
   * @param {string} text
   */
  load(text) {
    this.lastEmitted = text;
    this.openSamples = new Set();
    this.sampleErrors = {};
    if (!text.trim()) { this.draft = emptyDraft(); this.view = 'form'; this.jsonText = ''; this.jsonError = ''; return; }
    try {
      this.draft = draftFromText(text);
      this.view = 'form';
      this.jsonText = '';
      this.jsonError = '';
    } catch (error) {
      this.draft = emptyDraft();
      this.view = 'json';
      this.jsonText = text;
      this.jsonError = /** @type {Error} */ (error).message;
    }
  }
  /** @param {SlaDraft} draft */
  commit(draft) {
    this.draft = draft;
    this.emit(draft.clauses.length ? draftToText(draft) : '');
  }
  /** @param {string} text */
  emit(text) {
    this.lastEmitted = text;
    this.value = text;
    this.dispatchEvent(new CustomEvent('sla-change', { detail: { value: text, ok: describeSlaValidity(text).ok }, bubbles: true, composed: true }));
  }
  // Form <-> JSON. The form always serializes; JSON only comes back when it
  // parses as an SLA, and stays put with the reason when it does not.
  showJson() {
    this.jsonText = this.draft.clauses.length ? draftToPrettyText(this.draft) : this.jsonText;
    this.jsonError = '';
    this.view = 'json';
  }
  showForm() {
    if (!this.jsonText.trim()) { this.commit(emptyDraft()); this.view = 'form'; this.jsonError = ''; return; }
    try {
      const draft = draftFromText(this.jsonText);
      // Ids in the published record stay guarded across a JSON round trip.
      const original = new Map(this.draft.clauses.map((clause) => [clause.id, clause.originalId]));
      for (const clause of draft.clauses) clause.originalId = original.get(clause.id) ?? null;
      this.jsonError = '';
      this.view = 'form';
      this.commit({ ...draft, removed: this.draft.removed });
    } catch (error) {
      this.jsonError = /** @type {Error} */ (error).message;
    }
  }
  /** @param {Event} event */
  editJson(event) {
    this.jsonText = valueOf(event);
    this.jsonError = '';
    this.emit(this.jsonText);
  }
  startOver() {
    this.jsonText = '';
    this.jsonError = '';
    this.view = 'form';
    this.commit(emptyDraft());
  }
  /** @param {SlaDraftClauseKind} kind */
  addClause(kind) {
    this.commit({ ...this.draft, clauses: [...this.draft.clauses, newClause(kind, this.draft.clauses)] });
  }
  /** @param {number} index */
  removeClause(index) {
    const clause = this.draft.clauses[index];
    const removed = clause.originalId && !this.draft.removed.includes(clause.originalId) ? [...this.draft.removed, clause.originalId] : this.draft.removed;
    this.openSamples = new Set([...this.openSamples].filter((i) => i !== index).map((i) => (i > index ? i - 1 : i)));
    this.commit({ removed, clauses: this.draft.clauses.filter((_, i) => i !== index) });
  }
  /**
   * @param {number} index
   * @param {Partial<SlaDraftClause>} patch
   */
  patchClause(index, patch) {
    const clauses = this.draft.clauses.map((clause, i) => (i === index ? refreshId(/** @type {SlaDraftClause} */ ({ ...clause, ...patch }), this.draft.clauses) : clause));
    this.commit({ ...this.draft, clauses });
  }
  /** Tree edits mutate the node and recommit the draft: the tree is the draft's own object graph, not a copy. */
  touch() { this.commit({ ...this.draft }); }
  /** @param {number} index */
  readSample(index) {
    const clause = /** @type {SlaDraftSchemaClause} */ (this.draft.clauses[index]);
    let parsed;
    try {
      parsed = JSON.parse(clause.sample);
    } catch (error) {
      this.sampleErrors = { ...this.sampleErrors, [index]: `Not JSON: ${/** @type {Error} */ (error).message}` };
      return;
    }
    const rest = { ...this.sampleErrors };
    delete rest[index];
    this.sampleErrors = rest;
    this.openSamples = new Set([...this.openSamples].filter((i) => i !== index));
    this.patchClause(index, { root: inferNode(parsed) });
  }
  /** @param {number} index */
  openSample(index) { this.openSamples = new Set([...this.openSamples, index]); }
  /** @param {number} index */
  closeSample(index) { this.openSamples = new Set([...this.openSamples].filter((i) => i !== index)); }
  /**
   * @param {SlaDraftProblem[]} problems
   * @param {number} clause
   * @param {string} field
   */
  problem(problems, clause, field) {
    const hit = problems.find((problem) => problem.clause === clause && problem.field === field);
    return hit ? html`<p class="field-problem">${hit.message}</p>` : nothing;
  }
  /**
   * @param {SlaDraftNode} node
   * @param {string} name
   * @param {string} path
   * @param {number} depth
   * @param {number} clause
   * @param {SlaDraftProblem[]} problems
   * @param {(() => void)|null} ignore
   * @returns {unknown[]}
   */
  renderNode(node, name, path, depth, clause, problems, ignore) {
    const bounded = ['number', 'integer', 'string', 'array'].includes(node.type);
    const extras = extraKeywords(node);
    const row = html`<tr class=${depth === 0 ? 'root' : ''}>
      <td class="field" style=${`--depth:${depth}`}><code>${name}</code></td>
      <td class="type">${node.type === 'number' || node.type === 'integer'
        ? html`<select aria-label="Type" .value=${node.type} @change=${(/** @type {Event} */ e) => { node.type = /** @type {SlaDraftNodeType} */ (valueOf(e)); this.touch(); }}><option value="number">number</option><option value="integer">integer</option></select>`
        : html`<span>${node.type}</span>`}${extras.length ? html` <span class="extras" title="Constraints this form has no control for; kept exactly as published and editable in the JSON view.">${extras.join(' ')}</span>` : nothing}</td>
      <td class="promised">${depth === 0 ? html`<span class="muted">—</span>` : html`<input type="checkbox" aria-label=${`${name} is promised`} .checked=${node.required} @change=${(/** @type {Event} */ e) => { node.required = checkedOf(e); this.touch(); }}>`}</td>
      <td class="bounds">${bounded ? html`
        <input type="text" inputmode="decimal" class=${problems.some((p) => p.clause === clause && p.field === `${path}.min`) ? 'invalid' : ''} aria-label=${`${name} minimum`} placeholder="min" .value=${node.min} @input=${(/** @type {Event} */ e) => { node.min = valueOf(e); this.touch(); }}>
        <span class="to">to</span>
        <input type="text" inputmode="decimal" class=${problems.some((p) => p.clause === clause && p.field === `${path}.max`) ? 'invalid' : ''} aria-label=${`${name} maximum`} placeholder="max" .value=${node.max} @input=${(/** @type {Event} */ e) => { node.max = valueOf(e); this.touch(); }}>
        ${UNIT[node.type] ? html`<span class="unit">${UNIT[node.type]}</span>` : nothing}` : nothing}</td>
      <td class="act">${ignore ? html`<button type="button" class="quiet icon" aria-label=${`Ignore ${name}`} title="Leave this field out of the promise" @click=${ignore}>${removeIcon}</button>` : nothing}</td>
    </tr>`;
    const problemRows = [`${path}.min`, `${path}.max`].map((field) => problems.find((p) => p.clause === clause && p.field === field)).filter(Boolean)
      .map((p) => html`<tr class="problem-row"><td colspan="5"><p class="field-problem">${/** @type {SlaDraftProblem} */ (p).message}</p></td></tr>`);
    /** @type {unknown[]} */
    const rows = [row, ...problemRows];
    if (node.type === 'object') {
      for (const property of node.properties) {
        if (property.ignored) continue;
        rows.push(...this.renderNode(property.node, property.name, `${path}/${property.name}`, depth + 1, clause, problems, () => { property.ignored = true; this.touch(); }));
      }
      const ignored = node.properties.filter((property) => property.ignored);
      if (ignored.length) {
        rows.push(html`<tr class="ignored"><td colspan="5" style=${`--depth:${depth + 1}`}><span class="muted">Not promised:</span> ${ignored.map((property) => html`<button type="button" class="quiet restore" title="Restore this field to the promise" @click=${() => { property.ignored = false; this.touch(); }}><code>${property.name}</code></button>`)}</td></tr>`);
      }
    }
    if (node.type === 'array' && node.items) {
      rows.push(...this.renderNode(node.items, 'each item', `${path}/[]`, depth + 1, clause, problems, () => { node.items = null; this.touch(); }));
    }
    return rows;
  }
  /**
   * @param {SlaDraftSchemaClause} clause
   * @param {number} index
   * @param {SlaDraftProblem[]} problems
   */
  renderSchema(clause, index, problems) {
    const open = !clause.root || this.openSamples.has(index);
    const error = this.sampleErrors[index];
    return html`
      ${open ? html`
        <label class="composer-label" for=${`sample-${index}`}>${clause.root ? 'Replace the sample' : 'Sample response'}</label>
        <textarea id=${`sample-${index}`} class="sample" spellcheck="false" rows="7" placeholder='{ "current": { "temperature_2m": 12.5 } }' .value=${clause.sample} @input=${(/** @type {Event} */ e) => this.patchClause(index, { sample: valueOf(e) })}></textarea>
        <p class="hint">Paste one real response body. Its fields become the promise; you then untick any that are not always there.</p>
        ${error ? html`<p class="field-problem">${error}</p>` : this.problem(problems, index, 'sample')}
        <div class="composer-actions">
          <wa-button type="button" size="s" id=${`read-sample-${index}`} ?disabled=${!clause.sample.trim()} @click=${() => this.readSample(index)}>Read fields</wa-button>
          ${clause.root ? html`<wa-button type="button" size="s" appearance="outlined" @click=${() => this.closeSample(index)}>Keep current fields</wa-button>` : nothing}
        </div>` : nothing}
      ${clause.root ? html`
        <div class="scroll"><table class="tree">
          <thead><tr><th>Field</th><th>Type</th><th>Promised</th><th>Bounds</th><th></th></tr></thead>
          <tbody>${this.renderNode(clause.root, 'response', '', 0, index, problems, null)}</tbody>
        </table></div>
        <p class="hint">Promised means the field must be present. An unticked field is only checked for its type when it appears; an ignored one is never mentioned.
          ${open ? nothing : html`<button type="button" class="quiet link" @click=${() => this.openSample(index)}>Read from a different sample</button>`}</p>` : nothing}`;
  }
  /**
   * @param {SlaDraftLatencyClause} clause
   * @param {number} index
   * @param {SlaDraftProblem[]} problems
   */
  renderLatency(clause, index, problems) {
    const ms = Number(clause.maxMs);
    const seconds = Number.isFinite(ms) && clause.maxMs !== '' ? `${(ms / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} s` : '';
    return html`
      <div class="composer-inline">
        <label for=${`max-ms-${index}`}>Respond within</label>
        <input id=${`max-ms-${index}`} type="text" inputmode="numeric" class=${`num ${problems.some((p) => p.clause === index && p.field === 'maxMs') ? 'invalid' : ''}`} .value=${clause.maxMs} @input=${(/** @type {Event} */ e) => this.patchClause(index, { maxMs: valueOf(e) })}>
        <span class="unit">ms</span>
        ${seconds ? html`<span class="echo">${seconds}</span>` : nothing}
      </div>
      ${this.problem(problems, index, 'maxMs')}`;
  }
  /**
   * @param {SlaDraftPriceClause} clause
   * @param {number} index
   * @param {SlaDraftProblem[]} problems
   */
  renderPrice(clause, index, problems) {
    const min = usdcToMinorUnits(clause.min);
    const max = usdcToMinorUnits(clause.max);
    return html`
      <div class="composer-inline">
        <label for=${`price-min-${index}`}>Charge between</label>
        <input id=${`price-min-${index}`} type="text" inputmode="decimal" class=${`num ${problems.some((p) => p.clause === index && p.field === 'min') ? 'invalid' : ''}`} placeholder="0.000001" .value=${clause.min} @input=${(/** @type {Event} */ e) => this.patchClause(index, { min: valueOf(e) })}>
        <label for=${`price-max-${index}`}>and</label>
        <input id=${`price-max-${index}`} type="text" inputmode="decimal" class=${`num ${problems.some((p) => p.clause === index && p.field === 'max') ? 'invalid' : ''}`} placeholder="0.01" .value=${clause.max} @input=${(/** @type {Event} */ e) => this.patchClause(index, { max: valueOf(e) })}>
        <span class="unit">${clause.asset}</span>
        ${min !== null && max !== null ? html`<span class="echo">${min} to ${max} minor units</span>` : nothing}
      </div>
      ${this.problem(problems, index, 'min')}${this.problem(problems, index, 'max')}`;
  }
  /**
   * @param {SlaDraftClause} clause
   * @param {number} index
   * @param {SlaDraftProblem[]} problems
   * @param {Record<string, number>} cited
   */
  renderClause(clause, index, problems, cited) {
    const kind = KINDS[clause.kind];
    const citations = clause.originalId ? cited[clause.originalId] ?? 0 : 0;
    const renamed = citations > 0 && clause.id.trim() !== clause.originalId;
    return html`<li class="clause" id=${`clause-${index}`}>
      <span class="clause-index">${String(index + 1).padStart(2, '0')}</span>
      <div class="clause-body">
        <div class="clause-head"><span class="clause-kind">${kind.title}</span><span class="clause-blurb">${kind.blurb}</span></div>
        ${clause.kind === 'schema' ? this.renderSchema(clause, index, problems) : clause.kind === 'latency' ? this.renderLatency(clause, index, problems) : this.renderPrice(clause, index, problems)}
        <div class="clause-meta">
          <div>
            <label class="composer-label" for=${`id-${index}`}>Id</label>
            <input id=${`id-${index}`} type="text" class=${`mono ${problems.some((p) => p.clause === index && p.field === 'id') ? 'invalid' : ''}`} autocomplete="off" spellcheck="false" maxlength="64" .value=${clause.id} @input=${(/** @type {Event} */ e) => this.patchClause(index, { id: valueOf(e), idTouched: true })}>
            ${this.problem(problems, index, 'id')}
          </div>
          <div>
            <label class="composer-label" for=${`note-${index}`}>Note <span class="muted">optional</span></label>
            <input id=${`note-${index}`} type="text" maxlength="256" placeholder="What this promises, in one line. Shown beside the clause on the marketplace." .value=${clause.description} @input=${(/** @type {Event} */ e) => this.patchClause(index, { description: valueOf(e) })}>
          </div>
        </div>
        ${renamed ? html`<p class="field-guard">${citations} verdict${citations === 1 ? '' : 's'} on record cite${citations === 1 ? 's' : ''} <code>${clause.originalId}</code>. Under a new id ${citations === 1 ? 'it reads' : 'they read'} as “edited since” on the marketplace, permanently.</p>` : nothing}
      </div>
      <span class="clause-act"><button type="button" class="quiet icon" id=${`remove-clause-${index}`} aria-label=${`Remove ${kind.title.toLowerCase()} clause`} title="Remove this clause" @click=${() => this.removeClause(index)}>${removeIcon}</button></span>
    </li>`;
  }
  renderForm() {
    const problems = draftProblems(this.draft);
    const cited = citedClauseIds(this.history);
    const removedCited = this.draft.removed.filter((id) => cited[id]);
    const validity = describeSlaValidity(this.value);
    const summary = problems.length
      ? `${problems.length} thing${problems.length === 1 ? '' : 's'} to fix above.`
      : validity.ok ? validity.message : this.draft.clauses.length ? validity.message : 'An SLA needs at least one clause. Most services start with a response shape.';
    return html`
      <ol class="clauses">
        <li class="clause implicit">
          <span class="clause-index">00</span>
          <div class="clause-body">
            <div class="clause-head"><span class="clause-kind">Delivers a response</span><span class="clause-blurb">Status below 500, or the call is a FAIL. Every service is held to this; no provider declares it and none can waive it.</span></div>
          </div>
          <span class="clause-act"></span>
        </li>
        ${this.draft.clauses.map((clause, index) => this.renderClause(clause, index, problems, cited))}
      </ol>
      ${removedCited.length ? html`<p class="field-guard">${removedCited.map((id, i) => html`${i ? ', ' : ''}<code>${id}</code>`)} ${removedCited.length === 1 ? 'is' : 'are'} cited by verdicts on record. Once published without ${removedCited.length === 1 ? 'it' : 'them'}, those verdicts read as “edited since” on the marketplace, permanently.</p>` : nothing}
      <div class="composer-add">
        <span class="composer-label">Add a clause</span>
        ${/** @type {SlaDraftClauseKind[]} */ (['schema', 'latency', 'priceRange']).map((kind) => html`<wa-button type="button" size="s" appearance="outlined" id=${`add-${kind}`} ?disabled=${this.draft.clauses.length >= 32} @click=${() => this.addClause(kind)}>${KINDS[kind].title}</wa-button>`)}
      </div>
      <p class=${`check ${problems.length === 0 && validity.ok ? 'ok' : 'bad'}`} id="composer-check"><i class="dot"></i>${summary}</p>`;
  }
  renderJson() {
    const validity = this.jsonError ? { ok: false, message: this.jsonError } : describeSlaValidity(this.jsonText);
    return html`
      <textarea id="composer-json" class="json" spellcheck="false" rows="18" aria-label="SLA as JSON" .value=${this.jsonText} @input=${this.editJson}></textarea>
      <p class=${`check ${validity.ok ? 'ok' : 'bad'}`} id="composer-check"><i class="dot"></i>${validity.message}</p>
      ${this.jsonError ? html`<p class="hint">The form can only show a record the verifier accepts. Fix it here, or <button type="button" class="quiet link" id="composer-start-over" @click=${this.startOver}>start over with an empty SLA</button>.</p>` : nothing}`;
  }
  render() {
    return html`<div class="composer">
      <div class="composer-views" role="tablist" aria-label="SLA view">
        <button type="button" role="tab" id="composer-view-form" class=${this.view === 'form' ? 'active' : ''} aria-selected=${this.view === 'form'} @click=${this.showForm}>Form</button>
        <button type="button" role="tab" id="composer-view-json" class=${this.view === 'json' ? 'active' : ''} aria-selected=${this.view === 'json'} @click=${this.showJson}>JSON</button>
      </div>
      ${this.view === 'form' ? this.renderForm() : this.renderJson()}
    </div>`;
  }
}

if (!customElements.get('verdikt-sla-composer')) customElements.define('verdikt-sla-composer', VerdiktSlaComposer);
