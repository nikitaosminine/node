import { redirect } from "next/navigation";

// The waitlist lives at the root `/` (canonical, best SEO). `/waitlist` is kept as
// a friendly alias and permanently redirects there to avoid duplicate content.
export default function WaitlistAlias() {
  redirect("/");
}
