import { createClient } from "@supabase/supabase-js";
import type { EventLog } from "./event-log";
import { SyncClient } from "./sync-client";

type SyncConfig = { url: string; anonKey: string; emailEnabled?: boolean; providers?: ("apple" | "google")[] };

export async function setupSyncUi(log: EventLog, refresh: () => Promise<void>): Promise<void> {
  const panel = document.querySelector<HTMLElement>("#accountSync");
  if (!panel) throw new Error("The interface has no account panel");
  const cached = localStorage.getItem("piano-duet.sync-config");
  const response = navigator.onLine ? await fetch("/sync-config.json", { cache: "no-store" }) : null;
  if (!response && !cached || response?.status === 404) {
    panel.textContent = "Account sync is not configured yet. Your progress stays on this device.";
    return;
  }
  if (response && !response.ok) throw new Error(`Could not load sync configuration: ${response.status}`);
  if (response && !response.headers.get("content-type")?.includes("application/json")) {
    panel.textContent = "Account sync is not configured yet. Your progress stays on this device.";
    return;
  }
  const config = (response ? await response.json() : JSON.parse(cached!)) as SyncConfig;
  if (!config.url || !config.anonKey || (config.emailEnabled !== undefined && typeof config.emailEnabled !== "boolean") ||
      (config.providers && config.providers.some((provider) => !["apple", "google"].includes(provider)))) {
    throw new Error("Invalid sync configuration");
  }
  localStorage.setItem("piano-duet.sync-config", JSON.stringify(config));
  const remote = createClient(config.url, config.anonKey, { auth: { flowType: "pkce", detectSessionInUrl: true } });
  panel.innerHTML = `<p class="setting-help">Signing in merges this device's practice attempts, songs, edits, exclusions and learner settings with your account. Audio and models stay on this device. Signing out leaves your history here.</p>
    <p id="syncStatus" role="status" aria-live="polite"></p>
    <p id="syncEmailUnavailable" class="setting-help" hidden>Email sign-in is not available yet. Your progress stays on this device.</p>
    <form id="syncSignIn" hidden><label>Email <input name="email" type="email" autocomplete="email" required></label><button class="secondary" type="submit">Email sign-in link</button></form>
    <div id="syncProviders"></div><button id="syncNow" class="secondary" type="button" hidden>Sync now</button>
    <button id="syncSignOut" class="text-button" type="button" hidden>Sign out</button>`;
  const status = panel.querySelector<HTMLElement>("#syncStatus")!;
  const form = panel.querySelector<HTMLFormElement>("#syncSignIn")!;
  const emailUnavailable = panel.querySelector<HTMLElement>("#syncEmailUnavailable")!;
  const signOut = panel.querySelector<HTMLButtonElement>("#syncSignOut")!;
  const syncNow = panel.querySelector<HTMLButtonElement>("#syncNow")!;
  const providers = panel.querySelector<HTMLElement>("#syncProviders")!;
  let sync: SyncClient | undefined;
  let currentUser: string | undefined;
  let signInError: string | undefined;
  let running: Promise<void> | undefined;
  let requested = false;

  async function exchange(): Promise<void> {
    if (!sync) return;
    if (running) { requested = true; return; }
    if (!navigator.onLine) { status.textContent = "Offline · changes will sync when you reconnect"; return; }
    const client = sync;
    status.textContent = "Syncing…";
    running = (async () => {
      try {
        const added = await client.sync();
        if (client !== sync) return;
        if (added) await refresh();
        status.textContent = "Up to date";
      } catch (error) {
        if (client === sync) status.textContent = `Sync failed: ${typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error)}`;
      }
    })();
    await running;
    running = undefined;
    if (requested) { requested = false; await exchange(); }
  }

  function session(userId: string | undefined, email?: string): void {
    if (userId !== currentUser) {
      currentUser = userId;
      sync = userId ? new SyncClient(log, remote, userId) : undefined;
    }
    form.hidden = Boolean(userId) || !config.emailEnabled;
    emailUnavailable.hidden = Boolean(userId) || Boolean(config.emailEnabled);
    providers.hidden = Boolean(userId);
    signOut.hidden = !userId;
    syncNow.hidden = !userId;
    status.textContent = userId ? `Signed in${email ? ` as ${email}` : ""}` : signInError ?? "Not signed in";
    if (userId) void exchange();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!config.emailEnabled) {
      status.textContent = "Email sign-in is not available yet.";
      return;
    }
    const email = new FormData(form).get("email");
    if (typeof email !== "string" || !email) throw new Error("Email is required");
    void remote.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + "/" } }).then(({ error }) => {
      status.textContent = error ? `Sign-in failed: ${error.message}` : "Check your email for a sign-in link.";
    });
  });
  for (const provider of config.providers ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = `Continue with ${provider === "apple" ? "Apple" : "Google"}`;
    button.addEventListener("click", () => {
      signInError = undefined;
      void remote.auth.signInWithOAuth({ provider, options: { redirectTo: location.origin, ...(provider === "google" ? { scopes: "openid email profile" } : {}) } }).then(({ error }) => {
        if (error) status.textContent = `Sign-in failed: ${error.message}`;
      });
    });
    providers.append(button);
  }
  signOut.addEventListener("click", () => {
    void (async () => {
      if (running) await running;
      const { error } = await remote.auth.signOut({ scope: "local" });
      if (error) status.textContent = `Sign-out failed: ${error.message}`;
    })();
  });
  syncNow.addEventListener("click", () => { void exchange(); });
  log.addEventListener("append", () => { void exchange(); });
  window.addEventListener("online", () => { void exchange(); });
  window.addEventListener("offline", () => { if (sync) status.textContent = "Offline · changes will sync when you reconnect"; });
  window.setInterval(() => { void exchange(); }, 30000);
  remote.auth.onAuthStateChange((_event, value) => { session(value?.user.id, value?.user.email); });
  const { error } = await remote.auth.initialize();
  if (error) {
    signInError = `Sign-in failed: ${error.message}`;
    status.textContent = signInError;
  }
}
