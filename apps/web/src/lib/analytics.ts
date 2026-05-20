import mixpanel from "mixpanel-browser";
import type { User } from "@supabase/supabase-js";

export function identifyUser(user: User) {
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

export function resetAnalytics() {
  mixpanel.reset();
}
