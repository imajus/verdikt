// Reading environment variables without being defeated by an empty one.
//
// `.env.example` ships keys with no value — `VERDIKT_REGISTRY_ADDRESS=` — and
// anyone who copies it gets empty strings, not absent ones. `??` only falls
// through on null and undefined, so `process.env.X ?? fallback` silently
// returns `''` and the fallback never runs.
//
// That is not hypothetical: it took the proxy down after the registry address
// moved into `deployments/`, with an error insisting the contract was not
// deployed while the file plainly held its address.

/**
 * The variable's value, or undefined when it is unset OR set to whitespace.
 * @param {string} name
 * @returns {string|undefined}
 */
export function env(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
