// What the two landing-page forms have in common.
//
// This site has no backend and is not getting one (PRODUCT.md: no server-side
// logic at all), so a form here posts straight to a third-party form service
// from the visitor's own browser. The endpoint is build-time configuration like
// every other VITE_ value, which means it is public — that is fine for a form
// service's own submit URL and is the reason it may not be anything else.
//
// Unset, the forms do not pretend. They render their fields disabled and say
// which build they are, rather than accepting an address that would go nowhere.

const env = /** @type {Record<string, string|undefined>} */ (import.meta.env ?? {});

export const NEWSLETTER_ENDPOINT = env.VITE_NEWSLETTER_ENDPOINT ?? '';
export const CONTACT_ENDPOINT = env.VITE_CONTACT_ENDPOINT ?? '';

// Deliberately permissive: the form service does the real validation, and a
// clever local regex that rejects a valid address is worse than a round trip.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @param {string} value */
export const looksLikeEmail = (value) => EMAIL.test(value.trim());

/**
 * Formspree, Buttondown and Tally all answer a rejected submission with JSON
 * naming the reason. Showing it beats "something went wrong"; falling back to
 * the status code beats showing nothing.
 * @param {Response} response
 */
async function reasonFor(response) {
  try {
    const body = await response.json();
    if (Array.isArray(body?.errors)) {
      return body.errors.map((/** @type {{message?: string}} */ error) => error.message).filter(Boolean).join('; ');
    }
    return typeof body?.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} endpoint
 * @param {Record<string, string>} payload
 */
export async function postForm(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  if (response.ok) return;
  throw new Error((await reasonFor(response)) || `the form service answered ${response.status}`);
}
