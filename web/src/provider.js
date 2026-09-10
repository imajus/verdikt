/**
 * Resolves the provider console from a shareable address or the connected
 * wallet, and narrows the marketplace to services owned by that address.
 *
 * @param {Listing[]} services
 * @param {'marketplace'|'provider'|'how'} view
 * @param {string|null} routeProvider
 * @param {string|null} account
 */
export function resolveProviderConsole(services, view, routeProvider, account) {
  const effectiveProvider = routeProvider ?? (view === 'provider' ? account : null);
  const owned = effectiveProvider
    ? services.filter((listing) => listing.provider.toLowerCase() === effectiveProvider.toLowerCase())
    : [];
  return { effectiveProvider, owned, target: owned[0] ?? null };
}
