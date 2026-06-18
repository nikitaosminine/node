import { ImageResponse } from "next/og";

export const alt = "Node | AI-Native Portfolio Tracker & Macro Workspace";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// On-brand OG card: monochrome, matches the app's dark surface + DM-Sans feel.
export default function Image() {
  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "80px",
        background: "#0a0a0a",
        color: "#fafafa",
      }}
    >
      <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>Node</div>
      <div
        style={{
          marginTop: 32,
          fontSize: 64,
          fontWeight: 600,
          lineHeight: 1.05,
          letterSpacing: "-0.03em",
          maxWidth: 900,
        }}
      >
        Track what you own. Understand why you own it.
      </div>
      <div style={{ marginTop: 28, fontSize: 28, color: "#a1a1aa", maxWidth: 880 }}>
        A clean, high-density investing workspace for individual investors.
      </div>
    </div>,
    { ...size },
  );
}
