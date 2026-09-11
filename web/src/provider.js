/**
 * Narrows the marketplace to the services owned by the address in the path.
 *
 * This knows nothing about the connected wallet, and must not: routing
 * decides whose console is on screen, authorization decides only which
 * controls appear on it. A null address selects no provider at all — it is
 * never quietly filled in from whoever happens to be connected
 * (docs/superpowers/specs/2026-09-11-provider-route-authorization-design.md).
 *
 * @param {Listing[]} services
 * @param {string|null} address
 */
export function resolveProviderConsole(services, address) {
  const owned = address
    ? services.filter((listing) => listing.provider.toLowerCase() === address.toLowerCase())
    : [];
  return { owned, target: owned[0] ?? null };
}
