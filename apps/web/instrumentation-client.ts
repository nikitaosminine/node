import mixpanel from "mixpanel-browser";

mixpanel.init(process.env.NEXT_PUBLIC_MIXPANEL_TOKEN ?? "78e42f11e1e8fdd204da34fc6048fab6", {
  autocapture: true,
  record_sessions_percent: 100,
  api_host: "https://api-eu.mixpanel.com",
});
