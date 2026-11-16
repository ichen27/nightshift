// The nightly report: its shape, its counts and how it is written out.

export function countEntries(report) {
  const counts = { found: 0, proposed: 0, did: 0, rolledBack: 0 };
  for (const entry of report.entries ?? []) {
    if (entry.tag === 'found') counts.found += 1;
    else if (entry.tag === 'proposed') counts.proposed += 1;
    else if (entry.tag === 'did') counts.did += 1;
    if (entry.liveState === 'rolled-back') counts.rolledBack += 1;
  }
  return counts;
}
