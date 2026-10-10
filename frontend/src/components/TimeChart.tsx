"use client";

import { useEffect, useRef } from "react";
import {
  AreaSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { PricePoint } from "@/hooks/usePriceStream";

interface Props {
  data: PricePoint[];
  color: string;
  testId?: string;
}

/** Canvas area chart (lightweight-charts) with crosshair hover, sized to its container. */
export default function TimeChart({ data, color, testId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  useEffect(() => {
    const chart = createChart(containerRef.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8b949e",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(42, 51, 65, 0.4)" },
        horzLines: { color: "rgba(42, 51, 65, 0.4)" },
      },
      rightPriceScale: { borderColor: "#2a3341" },
      timeScale: { borderColor: "#2a3341", timeVisible: true, secondsVisible: true },
    });
    chartRef.current = chart;
    seriesRef.current = chart.addSeries(AreaSeries, { lineWidth: 2 });
    return () => chart.remove();
  }, []);

  useEffect(() => {
    seriesRef.current?.applyOptions({
      lineColor: color,
      topColor: `${color}55`,
      bottomColor: `${color}05`,
    });
  }, [color]);

  useEffect(() => {
    seriesRef.current?.setData(
      data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  return <div ref={containerRef} className="h-full w-full" data-testid={testId} />;
}
