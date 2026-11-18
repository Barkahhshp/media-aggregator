const STATUS_LABELS: Record<string, string> = {
  enabled: "Enabled",
  disabled: "Disabled",
  running: "Running",
  succeeded: "Succeeded",
  partial: "Partial",
  failed: "Failed",
  blocked: "Blocked",
  storage_limit: "Storage limit",
  not_modified: "Not modified (304)",
  disabled_source: "Disabled source",
  pending: "Pending",
  retry_wait: "Waiting to retry",
  leased: "In progress",
};

function statusClass(status: string): string {
  if (status === "enabled") return "status-badge status-badge--good";
  if (status === "disabled") return "status-badge status-badge--caution";
  if (["failed", "blocked", "storage_limit"].includes(status)) return "status-badge status-badge--attention";
  if (["partial", "retry_wait", "disabled_source"].includes(status)) return "status-badge status-badge--caution";
  if (["succeeded", "not_modified"].includes(status)) return "status-badge status-badge--good";
  return "status-badge";
}

export function StatusBadge({ status }: { status: string | null }) {
  const normalized = status?.trim() ?? "";
  const label = normalized === "" ? "Not run yet" : STATUS_LABELS[normalized] ?? normalized;
  return <span className={statusClass(normalized)}>{label}</span>;
}
