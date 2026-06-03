"use client";

import { LineChart, Line, ResponsiveContainer } from "recharts";

// Extracted into its own module so it can be lazy-loaded via next/dynamic.
// recharts is heavy; keeping it in a separate chunk keeps it out of the
// initial /portfolios bundle (it loads after hydration, when cards render).
export function Sparkline({
  points,
  positive,
}: {
  points: { value: number }[];
  positive: boolean;
}) {
  return (
    <div style={{ width: 110, height: 34 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={positive ? "oklch(0.72 0.19 145)" : "oklch(0.65 0.2 25)"}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
