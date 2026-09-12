import { describe, expect, it, vi } from 'vitest';
import { claimSubname, publishSla, publishUrl, registerService, retireService, topUpBond, withdrawRefund } from './actions.js';

/** @param {Record<string, unknown>} [overrides] */
function fakeWalletClient(overrides = {}) {
  return {
    writeContract: vi.fn(async () => '0xhash'),
    sendTransaction: vi.fn(async () => '0xhash'),
    ...overrides
  };
}

describe('claimSubname', () => {
  it('calls the registrar with the slug and payTo', async () => {
    const walletClient = fakeWalletClient();
    const registrarAddress = '0xREG0000000000000000000000000000000000';
    const result = await claimSubname({ walletClient, registrarAddress, slug: 'weather', payTo: '0xPay000000000000000000000000000000000000' });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: registrarAddress,
        functionName: 'claim',
        args: ['weather', '0xPay000000000000000000000000000000000000']
      })
    );
  });
});

describe('registerService', () => {
  it('calls register with the slug and the exact deposit amount as value', async () => {
    const walletClient = fakeWalletClient();
    const registryAddress = '0xREGISTRY000000000000000000000000000000';
    const result = await registerService({ walletClient, registryAddress, slug: 'weather', depositAmount: 10n * 10n ** 18n });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: registryAddress, functionName: 'register', args: ['weather'], value: 10n * 10n ** 18n })
    );
  });
});

describe('topUpBond', () => {
  it('calls topUp with the serviceId and the top-up amount as value', async () => {
    const walletClient = fakeWalletClient();
    const registryAddress = '0xREGISTRY000000000000000000000000000000';
    const serviceId = `0x${'1'.repeat(64)}`;
    const result = await topUpBond({ walletClient, registryAddress, serviceId, amount: 5n * 10n ** 18n });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: registryAddress, functionName: 'topUp', args: [serviceId], value: 5n * 10n ** 18n })
    );
  });
});

describe('retireService', () => {
  it('calls deregister with the serviceId', async () => {
    const walletClient = fakeWalletClient();
    const registryAddress = '0xREGISTRY000000000000000000000000000000';
    const serviceId = `0x${'2'.repeat(64)}`;
    const result = await retireService({ walletClient, registryAddress, serviceId });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: registryAddress, functionName: 'deregister', args: [serviceId] })
    );
  });
});

describe('withdrawRefund', () => {
  it('calls withdraw with no arguments, taking the payer from the wallet itself', async () => {
    const walletClient = fakeWalletClient();
    const registryAddress = '0xREGISTRY000000000000000000000000000000';
    const result = await withdrawRefund({ walletClient, registryAddress });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: registryAddress, functionName: 'withdraw', args: [] })
    );
  });
});

describe('publishSla / publishUrl', () => {
  it('sends the setText calldata @verdikt/sdk already builds, for sla', async () => {
    const walletClient = fakeWalletClient();
    const result = await publishSla({ walletClient, slug: 'weather', value: '{"version":1,"clauses":[]}' });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: expect.stringMatching(/^0x/), data: expect.stringMatching(/^0x/) })
    );
  });

  it('sends the setText calldata for url', async () => {
    const walletClient = fakeWalletClient();
    const result = await publishUrl({ walletClient, slug: 'weather', value: 'https://provider.example/weather' });
    expect(result.hash).toBe('0xhash');
    expect(walletClient.sendTransaction).toHaveBeenCalled();
  });
});
