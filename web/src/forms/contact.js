import { LitElement, html } from 'lit';
import { CONTACT_ENDPOINT, looksLikeEmail, postForm } from './submit.js';

/**
 * The field starts at the height of the message most people write and grows
 * into the one some people write, so it never shows a block of dead rule
 * waiting to be filled.
 * @param {HTMLTextAreaElement} field
 */
function grow(field) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

export class VerdiktContact extends LitElement {
  static properties = { endpoint: {}, email: { state: true }, message: { state: true }, pending: { state: true }, done: { state: true }, error: { state: true } };
  constructor() {
    super();
    this.endpoint = CONTACT_ENDPOINT;
    this.email = '';
    this.message = '';
    this.pending = false;
    this.done = false;
    /** @type {string} */ this.error = '';
  }
  createRenderRoot() { return this; }
  /** @param {InputEvent} event */
  editEmail(event) {
    this.email = /** @type {HTMLInputElement} */ (event.currentTarget).value;
    if (this.error) this.error = '';
  }
  /** @param {InputEvent} event */
  editMessage(event) {
    const field = /** @type {HTMLTextAreaElement} */ (event.currentTarget);
    this.message = field.value;
    grow(field);
    if (this.error) this.error = '';
  }
  /** @param {SubmitEvent} event */
  async submit(event) {
    event.preventDefault();
    if (this.pending || !this.endpoint) return;
    if (!looksLikeEmail(this.email)) {
      this.error = 'That address is missing an @ or a domain — without it there is no way to answer you.';
      return;
    }
    if (this.message.trim().length < 10) {
      this.error = 'Add a sentence or two about what you are building, so the reply is worth reading.';
      return;
    }
    this.pending = true;
    this.error = '';
    try {
      await postForm(this.endpoint, { email: this.email.trim(), message: this.message.trim(), source: 'verdikt-landing-contact' });
      this.done = true;
    } catch (error) {
      this.error = `Not sent — ${/** @type {Error} */ (error).message}. Your message is still in the box; try again, or open an issue instead.`;
    } finally {
      this.pending = false;
    }
  }
  render() {
    if (this.done) {
      return html`<p class="form-done" role="status">Sent. You will get an answer at <code>${this.email}</code> — from a person, not a sequence.</p>`;
    }
    if (!this.endpoint) {
      // Same register as the subscribe off-state: what the visitor gets, not
      // which VITE_ value is missing. Both links this used to carry now sit in
      // the entry's own link row below this form.
      return html`<p class="form-off">This form is not open yet. An issue on the repository reaches the same person it would.</p>`;
    }
    return html`
      <form class="ledger-form" novalidate @submit=${this.submit}>
        <div class="ledger-field">
          <label for="contact-email">Email address</label>
          <input
            id="contact-email"
            type="email"
            name="email"
            inputmode="email"
            autocomplete="email"
            placeholder="you@example.com"
            aria-invalid=${this.error && !looksLikeEmail(this.email) ? 'true' : 'false'}
            aria-describedby=${this.error ? 'contact-error' : 'contact-hint'}
            .value=${this.email}
            @input=${this.editEmail} />
        </div>
        <div class="ledger-field">
          <label for="contact-message">What you are building</label>
          <textarea
            id="contact-message"
            name="message"
            rows="3"
            placeholder="A service to list, an agent to point at one, or a hole in the mechanism."
            aria-describedby=${this.error ? 'contact-error' : 'contact-hint'}
            .value=${this.message}
            @input=${this.editMessage}></textarea>
        </div>
        <wa-button type="submit" ?disabled=${this.pending} ?loading=${this.pending}>Send</wa-button>
        ${this.error
          ? html`<p class="form-error" id="contact-error" role="alert">${this.error}</p>`
          : html`<p class="form-hint" id="contact-hint">Goes to the form service named in the <a href="/privacy">privacy policy</a>. Nothing is stored on this page.</p>`}
      </form>`;
  }
}

if (!customElements.get('verdikt-contact')) customElements.define('verdikt-contact', VerdiktContact);
