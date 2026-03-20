import type { ProductSnapshot, VariationAlert } from "../schema/universal.js";

/**
 * Check for variation family changes between two snapshots.
 * Detects orphans, parent changes, attribute drift, children added/removed.
 */
export function checkVariationChanges(
  previous: ProductSnapshot,
  current: ProductSnapshot,
  approvedValues?: Record<string, string>
): VariationAlert[] {
  const alerts: VariationAlert[] = [];

  // Orphaned child: had a parent, now doesn't
  if (previous.parent_asin && !current.parent_asin) {
    alerts.push({
      asin: current.asin,
      alert_type: "orphaned_child",
      details: `Lost parent ASIN ${previous.parent_asin} — product is now standalone`,
      severity: "critical",
    });
  }

  // Parent changed
  if (
    previous.parent_asin &&
    current.parent_asin &&
    previous.parent_asin !== current.parent_asin
  ) {
    alerts.push({
      asin: current.asin,
      alert_type: "parent_changed",
      details: `Parent changed from ${previous.parent_asin} to ${current.parent_asin}`,
      severity: "critical",
    });
  }

  // Children added
  const prevChildren = new Set(previous.child_asins);
  const currChildren = new Set(current.child_asins);
  const added = [...currChildren].filter((c) => !prevChildren.has(c));
  const removed = [...prevChildren].filter((c) => !currChildren.has(c));

  if (added.length > 0) {
    alerts.push({
      asin: current.asin,
      alert_type: "children_added",
      details: `New child ASINs: ${added.join(", ")}`,
      severity: "info",
    });
  }

  if (removed.length > 0) {
    alerts.push({
      asin: current.asin,
      alert_type: "children_removed",
      details: `Removed child ASINs: ${removed.join(", ")}`,
      severity: "warning",
    });
  }

  // Attribute drift: variation attributes changed from approved values
  if (approvedValues && current.variation_attributes) {
    for (const [attr, approvedVal] of Object.entries(approvedValues)) {
      const currentVal = current.variation_attributes[attr];
      if (currentVal && currentVal !== approvedVal) {
        alerts.push({
          asin: current.asin,
          alert_type: "attribute_drift",
          details: `Attribute "${attr}" changed from approved "${approvedVal}" to "${currentVal}"`,
          severity: "warning",
        });
      }
    }
  }

  return alerts;
}
