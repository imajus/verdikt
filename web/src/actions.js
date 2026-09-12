// The six transactions a signed-in provider can send, each a thin wrapper
// around a wallet client's own writeContract/sendTransaction — never a
// Verdikt-held key. `@verdikt/sla` is a dependency here on purpose: unlike the
// proxy, the dashboard's provider console is squarely on the human side of
// the enclave boundary (CLAUDE.md), and the caller — not this file — decides
// when to validate a draft with parseSla before calling publishSla.

import { parseAbi } from 'viem';
import { setTextCalldata } from '@verdikt/sdk';

/**
 * Provider-facing write surface of VerdiktRegistry. Deliberately not
 * @verdikt/sdk/arc's registryAbi — that file's ABI is the read surface the
 * proxy also uses, and register/topUp/deregister are provider actions with no
 * business in a reader shared with the proxy (packages/sdk/arc.js's own
 * comment on this).
 */
export const registryWriteAbi = parseAbi([
  'function register(string calldata slug) external payable returns (bytes32 serviceId)',
  'function topUp(bytes32 serviceId) external payable',
  'function deregister(bytes32 serviceId) external',
  'function withdraw() external returns (uint256 amount)'
]);

/** VerdiktSubnameRegistrar's one entrypoint. */
export const registrarAbi = parseAbi(['function claim(string calldata slug, address payTo) external returns (bytes32 node)']);

/**
 * @param {{ walletClient: { writeContract: Function }, registrarAddress: string, slug: string, payTo: string }} params
 */
export async function claimSubname({ walletClient, registrarAddress, slug, payTo }) {
  const hash = await walletClient.writeContract({
    address: registrarAddress,
    abi: registrarAbi,
    functionName: 'claim',
    args: [slug, payTo]
  });
  return { hash };
}

/**
 * @param {{ walletClient: { writeContract: Function }, registryAddress: string, slug: string, depositAmount: bigint }} params
 */
export async function registerService({ walletClient, registryAddress, slug, depositAmount }) {
  const hash = await walletClient.writeContract({
    address: registryAddress,
    abi: registryWriteAbi,
    functionName: 'register',
    args: [slug],
    value: depositAmount
  });
  return { hash };
}

/**
 * @param {{ walletClient: { writeContract: Function }, registryAddress: string, serviceId: string, amount: bigint }} params
 */
export async function topUpBond({ walletClient, registryAddress, serviceId, amount }) {
  const hash = await walletClient.writeContract({
    address: registryAddress,
    abi: registryWriteAbi,
    functionName: 'topUp',
    args: [serviceId],
    value: amount
  });
  return { hash };
}

/**
 * @param {{ walletClient: { writeContract: Function }, registryAddress: string, serviceId: string }} params
 */
export async function retireService({ walletClient, registryAddress, serviceId }) {
  const hash = await walletClient.writeContract({
    address: registryAddress,
    abi: registryWriteAbi,
    functionName: 'deregister',
    args: [serviceId]
  });
  return { hash };
}

/**
 * The pull-payment path: the connected wallet claims its own credited
 * refund. There is no argument beyond the wallet itself — `withdraw()`
 * pays whatever is booked under `msg.sender` (CLAUDE.md: pull payments).
 *
 * @param {{ walletClient: { writeContract: Function }, registryAddress: string }} params
 */
export async function withdrawRefund({ walletClient, registryAddress }) {
  const hash = await walletClient.writeContract({
    address: registryAddress,
    abi: registryWriteAbi,
    functionName: 'withdraw',
    args: []
  });
  return { hash };
}

/**
 * @param {{ walletClient: { sendTransaction: Function }, slug: string, value: string }} params
 */
export async function publishSla({ walletClient, slug, value }) {
  const call = setTextCalldata(slug, 'sla', value);
  const hash = await walletClient.sendTransaction({ to: call.to, data: call.data });
  return { hash };
}

/**
 * @param {{ walletClient: { sendTransaction: Function }, slug: string, value: string }} params
 */
export async function publishUrl({ walletClient, slug, value }) {
  const call = setTextCalldata(slug, 'url', value);
  const hash = await walletClient.sendTransaction({ to: call.to, data: call.data });
  return { hash };
}
