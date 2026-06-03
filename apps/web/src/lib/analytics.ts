import type { User } from "@supabase/supabase-js";

// mixpanel-browser is loaded lazily (dynamic import) so it stays out of the
// initial bundle and off the critical hydration path — it ran on load before,
// causing a forced reflow (flagged by Lighthouse). These calls are
// fire-and-forget from the auth hook, so returning a promise is fine.

export async function identifyUser(user: User) {
  const { default: mixpanel } = await import("mixpanel-browser");
  mixpanel.identify(user.id);
  const meta = user.user_metadata ?? {};
  mixpanel.people.set({
    $email: user.email,
    $name: meta.full_name ?? meta.name ?? user.email,
    $avatar: meta.avatar_url,
    $created: user.created_at,
    auth_provider: user.app_metadata?.provider,
  });
}

export async function resetAnalytics() {
  const { default: mixpanel } = await import("mixpanel-browser");
  mixpanel.reset();
}
