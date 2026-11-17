// Entry point: the lifecycle between this forge and the make.fun env.
// The env hands us its origin in MAKEFUN_ENV_URL; we bind an ephemeral
// port, tell the env that port, then wait until the env says the trial is
// over. The suite grades the server in app.ts — this file only runs the
// handshake, so it stays small and does nothing clever.
//
// Steps:
//   1. MAKEFUN_ENV_URL must be set (in a trial it is the env's origin).
//      Without it there is nobody to register with, so exit 1.
//   2. Start the app and listen on port 0: the kernel picks a free port.
//      Never bind 8080 — that port belongs to the env.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The env records our
//      address from the request plus N and dials us from then on. The
//      first register wins; a 409 means another entry registered first,
//      and we keep waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env
//      answers immediately ({"done": false} while the suite runs), so this
//      is a poll. A failed or slow poll is retried with backoff; we never
//      exit before the env says done.
//   5. Close the server and exit 0. The harness then stops the env,
//      which writes the export the scorer reads.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

// One register or done request may take this long before it is abandoned.
const REQUEST_TIMEOUT_MS = 30_000;
// Retry waits start here and grow to at most this long.
const RETRY_FIRST_MS = 250;
const RETRY_LIMIT_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wait after `attempt` failed requests: exponential, capped at RETRY_LIMIT_MS.
function retryDelay(attempt: number): number {
  return Math.min(RETRY_LIMIT_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

// POST the bound port until the env accepts it. 200 is the normal answer
// and 409 means a first register already won, which is not ours to fix.
// 400 and 405 are contract errors and end the program; a network error or
// another status is retried, since the env may still be starting.
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done.
    }
    await sleep(retryDelay(attempt));
  }
}

// Bind the port, register it, then wait for the env: the whole life of the process.
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
