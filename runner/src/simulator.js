// Supervises one long-lived `cre workflow simulate <name> --listen` child
// process (cre/workflows/README.md). Compiles once at startup, then serves
// every trigger over its own HTTP port for the life of the process — this is
// the piece that turns "one CLI run per request" into "one CLI run, ever,
// per host restart" (see README.md "Why --listen" for the full reasoning).
//
// Deliberately dumb: it does not parse CLI output for structured status, only
// greps stdout for something that looks like a readiness banner, with a
// fixed-delay fallback if that grep never matches (see the caveat in
// README.md — the exact banner text is unverified in this environment, since
// `cre` is not installed here to observe it directly).

import { spawn } from 'node:child_process';

const READY_HINT_PATTERN = /listen|localhost:2000|server started|serving/i;

/**
 * @param {{
 *   workflowDir: string,
 *   workflowName: string,
 *   target: string,
 *   broadcast: boolean,
 *   warmupMs: number,
 *   spawnImpl?: typeof spawn,
 *   onLog?: (line: string, stream: 'stdout'|'stderr') => void
 * }} options
 */
export function createSimulatorSupervisor(options) {
  const doSpawn = options.spawnImpl ?? spawn;
  const onLog = options.onLog ?? (() => {});

  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let restarting = false;
  let stopped = false;
  /** @type {(() => void)|null} */
  let readyResolve = null;
  /** @type {Promise<void>|null} */
  let readyPromise = null;

  function buildArgs() {
    const args = ['workflow', 'simulate', options.workflowName, '--listen', '--target', options.target];
    if (options.broadcast) args.push('--broadcast');
    return args;
  }

  function spawnChild() {
    readyPromise = new Promise((resolve) => {
      readyResolve = resolve;
    });
    // A fallback timer in case the banner never matches — see file header.
    const fallback = setTimeout(() => readyResolve?.(), options.warmupMs);
    fallback.unref?.();

    child = doSpawn('cre', buildArgs(), { cwd: options.workflowDir, stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      onLog(text, 'stdout');
      if (READY_HINT_PATTERN.test(text)) readyResolve?.();
    });
    child.stderr?.on('data', (chunk) => onLog(chunk.toString('utf8'), 'stderr'));

    /** @param {string} message */
    function restartAfterFailure(message) {
      onLog(message, 'stderr');
      readyResolve?.();
      if (!stopped && !restarting) {
        restarting = true;
        // Simple fixed backoff. A crash loop here means `cre login` expired
        // or the workflow itself is broken — both need a human, not a tight
        // retry loop, so this does not attempt exponential backoff or a
        // retry cap; it just keeps the process from exiting outright.
        setTimeout(() => {
          restarting = false;
          if (!stopped) spawnChild();
        }, 3000).unref?.();
      }
    }

    child.on('exit', (code, signal) => {
      restartAfterFailure(`cre workflow simulate exited (code=${code}, signal=${signal})`);
    });
    // spawn() reports failures such as a missing `cre` executable or invalid
    // cwd through `error`, often without ever emitting `exit`.
    child.on('error', (error) => {
      restartAfterFailure(`could not start cre workflow simulate: ${error.message}`);
    });
  }

  return {
    start() {
      if (child) return readyPromise;
      spawnChild();
      return readyPromise;
    },
    /** Resolves once the readiness heuristic fires, or the warmup fallback elapses. */
    waitUntilReady() {
      return readyPromise ?? Promise.resolve();
    },
    stop() {
      stopped = true;
      child?.kill();
    },
    get pid() {
      return child?.pid ?? null;
    }
  };
}
