import type { PricePoint } from "@/hooks/usePriceStream";

interface Props {
  points: PricePoint[];
  width?: number;
  height?: number;
}

/** Tiny SVG line of price since page load, colored by net direction. */
export default function Sparkline({ points, width = 80, height = 24 }: Props) {
  if (points.length < 2) return <svg width={width} height={height} />;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;
  const path = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - 2 - ((v - min) / range) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg width={width} height={height} data-testid="sparkline">
      <polyline
        points={path}
        fill="none"
        stroke={up ? "var(--color-up)" : "var(--color-down)"}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}
