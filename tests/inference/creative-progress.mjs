export async function waitForCreativeProgress({ label, read, pause, diagnostic, errors, now = Date.now,
  maxMs = 360000, stallMs = 120000 }) {
  const began = now();
  let changed = began, signature = "";
  while (now() - began < maxMs) {
    const state = await read();
    if (state.error) throw new Error(`${await diagnostic(label)}; ${JSON.stringify(state)}`);
    if (state.done) return;
    const next = JSON.stringify([state.progress, state.status, state.timing, state.download]);
    if (next !== signature) { signature = next; changed = now(); }
    if (now() - changed >= stallMs) throw new Error(`${await diagnostic(`${label} stopped progressing`)}; ${JSON.stringify({ state, errors })}`);
    await pause();
  }
  throw new Error(await diagnostic(`${label} exceeded its total deadline`));
}
