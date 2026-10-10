import { formatSigned, formatUsd, pnlColor } from "@/lib/format";
import type { ConnectionStatus } from "@/lib/types";

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connected: "bg-up",
  reconnecting: "bg-accent",
  disconnected: "bg-down",
};

interface StatProps {
  label: string;
  value: string;
  testId: string;
  className?: string;
}

function Stat({ label, value, testId, className = "" }: StatProps) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <span data-testid={testId} className={`font-mono text-sm ${className}`}>
        {value}
      </span>
    </div>
  );
}

interface Props {
  totalValue: number;
  cash: number;
  pnl: number;
  status: ConnectionStatus;
}

/** Top bar: brand, live portfolio value, cash, P&L and SSE connection status. */
export default function Header({ totalValue, cash, pnl, status }: Props) {
  return (
    <header className="flex items-center justify-between border-b border-border bg-panel px-4 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-bold tracking-tight text-accent">FinAlly</span>
        <span className="hidden text-xs text-muted sm:inline">AI Trading Workstation</span>
      </div>
      <div className="flex items-center gap-6">
        <Stat label="Portfolio" value={formatUsd(totalValue)} testId="total-value" />
        <Stat label="Cash" value={formatUsd(cash)} testId="cash-balance" />
        <Stat label="Unrealized" value={formatSigned(pnl)} testId="unrealized-pnl" className={pnlColor(pnl)} />
        <div className="flex items-center gap-1.5" title={`Stream ${status}`}>
          <span
            data-testid="connection-status"
            data-status={status}
            className={`h-2.5 w-2.5 rounded-full ${STATUS_COLOR[status]}`}
          />
          <span className="text-xs capitalize text-muted">{status}</span>
        </div>
      </div>
    </header>
  );
}
