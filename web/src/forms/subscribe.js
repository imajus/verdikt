import { LitElement, html } from 'lit';
import { NEWSLETTER_ENDPOINT, looksLikeEmail, postForm } from './submit.js';

export class VerdiktSubscribe extends LitElement {
  static properties = { endpoint: {}, email: { state: true }, pending: { state: true }, done: { state: true }, error: { state: true } };
  constructor() {
    super();
    this.endpoint = NEWSLETTER_ENDPOINT;
    this.email = '';
    this.pending = false;
    this.done = false;
    /** @type {string} */ this.error = '';
  }
  createRenderRoot() { return this; }
  /** @param {InputEvent} event */
  edit(event) {
    this.email = /** @type {HTMLInputElement} */ (event.currentTarget).value;
    if (this.error) this.error = '';
  }
  /** @param {SubmitEvent} event */
  async submit(event) {
    event.preventDefault();
    if (this.pending || !this.endpoint) return;
    if (!looksLikeEmail(this.email)) {
      this.error = 'That address is missing an @ or a domain. Check it and send again.';
      return;
    }
    this.pending = true;
    this.error = '';
    try {
      await postForm(this.endpoint, { email: this.email.trim(), source: 'verdikt-landing-newsletter' });
      this.done = true;
    } catch (error) {
      this.error = `Not sent — ${/** @type {Error} */ (error).message}. Nothing was stored; try again or open an issue on GitHub.`;
    } finally {
      this.pending = false;
    }
  }
  render() {
    if (this.done) {
      return html`<p class="form-done" role="status">Noted — <code>${this.email}</code> gets one message per milestone, and nothing else.</p>`;
    }
    if (!this.endpoint) {
      // Says what the visitor gets, not which VITE_ value is missing. The
      // entry's own link row sits below both forms and reaches the repository,
      // so this names it without spending a second link on it.
      return html`<p class="form-off">The mailing list is not open yet. Until it is, the repository is where each milestone lands first.</p>`;
    }
    return html`
      <form class="ledger-form" novalidate @submit=${this.submit}>
        <div class="ledger-field">
          <label for="subscribe-email">Email address</label>
          <input
            id="subscribe-email"
            type="email"
            name="email"
            inputmode="email"
            autocomplete="email"
            placeholder="you@example.com"
            aria-invalid=${this.error ? 'true' : 'false'}
            aria-describedby=${this.error ? 'subscribe-error' : 'subscribe-hint'}
            .value=${this.email}
            @input=${this.edit} />
        </div>
        <wa-button type="submit" ?disabled=${this.pending} ?loading=${this.pending}>Send it to me</wa-button>
        ${this.error
          ? html`<p class="form-error" id="subscribe-error" role="alert">${this.error}</p>`
          : html`<p class="form-hint" id="subscribe-hint">Your address goes to the form service named in the <a href="/privacy">privacy policy</a> and nowhere else.</p>`}
      </form>`;
  }
}

if (!customElements.get('verdikt-subscribe')) customElements.define('verdikt-subscribe', VerdiktSubscribe);
