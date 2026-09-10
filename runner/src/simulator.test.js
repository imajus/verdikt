import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createSimulatorSupervisor } from './simulator.js';

/** A minimal stand-in for a ChildProcess, just the surface simulator.js touches. */
function fakeChild() {
  const child = /** @type {any} */ (new EventEmitter());
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => child.emit('exit', null, 'SIGTERM'));
  return child;
}

describe('createSimulatorSupervisor', () => {
  it('spawns cre workflow simulate <name> --listen --target <target>, from workflowDir', () => {
    const spawnImpl = vi.fn().mockReturnValue(fakeChild());
    const supervisor = createSimulatorSupervisor({
      workflowDir: '/app/cre/workflows',
      workflowName: 'verify',
      target: 'staging-settings',
      broadcast: false,
      warmupMs: 50,
      spawnImpl
    });

    supervisor.start();

    expect(spawnImpl).toHaveBeenCalledWith(
      'cre',
      ['workflow', 'simulate', 'verify', '--listen', '--target', 'staging-settings'],
      expect.objectContaining({ cwd: '/app/cre/workflows' })
    );
  });

  it('appends --broadcast when configured', () => {
    const spawnImpl = vi.fn().mockReturnValue(fakeChild());
    const supervisor = createSimulatorSupervisor({
      workflowDir: '/app/cre/workflows',
      workflowName: 'verify',
      target: 'staging-settings',
      broadcast: true,
      warmupMs: 50,
      spawnImpl
    });

    supervisor.start();

    expect(spawnImpl.mock.calls[0][1]).toContain('--broadcast');
  });

  it('resolves waitUntilReady once stdout matches the readiness heuristic', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);
    const supervisor = createSimulatorSupervisor({
      workflowDir: '/app/cre/workflows',
      workflowName: 'verify',
      target: 'staging-settings',
      broadcast: false,
      warmupMs: 60_000,
      spawnImpl
    });

    supervisor.start();
    let resolved = false;
    supervisor.waitUntilReady().then(() => {
      resolved = true;
    });

    child.stdout.emit('data', Buffer.from('compiling workflow...\n'));
    await Promise.resolve();
    expect(resolved).toBe(false);

    child.stdout.emit('data', Buffer.from('server started, listening on http://localhost:2000\n'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(resolved).toBe(true);
  });

  it('falls back to resolving after warmupMs if no banner ever matches', async () => {
    const spawnImpl = vi.fn().mockReturnValue(fakeChild());
    const supervisor = createSimulatorSupervisor({
      workflowDir: '/app/cre/workflows',
      workflowName: 'verify',
      target: 'staging-settings',
      broadcast: false,
      warmupMs: 20,
      spawnImpl
    });

    supervisor.start();
    await expect(supervisor.waitUntilReady()).resolves.toBeUndefined();
  });

  it('restarts the child after it exits unexpectedly', async () => {
    const first = fakeChild();
    const second = fakeChild();
    const spawnImpl = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const supervisor = createSimulatorSupervisor({
      workflowDir: '/app/cre/workflows',
      workflowName: 'verify',
      target: 'staging-settings',
      broadcast: false,
      warmupMs: 20,
      spawnImpl
    });

    supervisor.start();
    first.emit('exit', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 3100));

    expect(spawnImpl).toHaveBeenCalledTimes(2);
  }, 5000);

  it('does not restart after stop()', async () => {
    const first = fakeChild();
    const spawnImpl = vi.fn().mockReturnValue(first);
    const supervisor = createSimulatorSupervisor({
      workflowDir: '/app/cre/workflows',
      workflowName: 'verify',
      target: 'staging-settings',
      broadcast: false,
      warmupMs: 20,
      spawnImpl
    });

    supervisor.start();
    supervisor.stop();

    expect(first.kill).toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('restarts when spawning cre emits an error', async () => {
    const first = fakeChild();
    const second = fakeChild();
    const spawnImpl = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const supervisor = createSimulatorSupervisor({
      workflowDir: '/missing/workflows', workflowName: 'verify', target: 'staging-settings',
      broadcast: false, warmupMs: 20, spawnImpl
    });

    supervisor.start();
    first.emit('error', new Error('ENOENT'));
    await new Promise((resolve) => setTimeout(resolve, 3100));

    expect(spawnImpl).toHaveBeenCalledTimes(2);
  }, 5000);
});
