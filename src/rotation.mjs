// Chooses tonight's projects: never visited first, then the ones visited longest ago.
// Ties go to the project that was added first.

export function pickProjects(projects, n) {
  const byAdded = (a, b) => String(a.addedAt).localeCompare(String(b.addedAt));
  const ordered = [...projects].sort((a, b) => {
    if (!a.lastVisitAt && !b.lastVisitAt) return byAdded(a, b);
    if (!a.lastVisitAt) return -1;
    if (!b.lastVisitAt) return 1;
    return a.lastVisitAt.localeCompare(b.lastVisitAt) || byAdded(a, b);
  });
  return ordered.slice(0, Math.max(0, n));
}
