// The list of projects Nightshift looks after, kept in projects.json.
import { parseRepoLink } from './repo-link.mjs';

// A problem with the project the user asked for, worded for the page.
export class ProjectError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectError';
  }
}

const FILE = 'projects.json';
const UPDATABLE = ['defaultBranch', 'isPublic', 'lastVisitAt', 'lastResult', 'status'];

export const projectKey = (owner, repo) => `${owner}__${repo}`;
const same = (project, owner, repo) =>
  project.owner.toLowerCase() === owner.toLowerCase() && project.repo.toLowerCase() === repo.toLowerCase();

export function createProjects({ store, github, now = () => new Date() }) {
  const list = () => store.read(FILE, []);

  async function add(link) {
    const parsed = parseRepoLink(link);
    const listed = list().find((p) => same(p, parsed.owner, parsed.repo));
    if (listed) return { project: listed, created: false };

    const repo = await github.getRepo(parsed.owner, parsed.repo);
    if (!repo.exists) throw new ProjectError("That repository doesn't exist or you can't see it.");
    if (repo.archived) throw new ProjectError('That repository is archived.');
    if (!repo.canPush) throw new ProjectError("You don't have write access to that repository.");

    // Read the list again: the check above waited on GitHub.
    const projects = list();
    const existing = projects.find((p) => same(p, repo.owner, repo.repo));
    if (existing) return { project: existing, created: false };
    const project = {
      owner: repo.owner,
      repo: repo.repo,
      defaultBranch: repo.defaultBranch,
      isPublic: repo.isPublic,
      addedAt: now().toISOString(),
      lastVisitAt: null,
      lastResult: null,
      status: 'healthy',
    };
    store.write(FILE, [...projects, project]);
    return { project, created: true };
  }

  // Takes the project off the list and deletes its private clone. Reports stay.
  // openPrs is null when GitHub could not be asked.
  async function remove(owner, repo) {
    const project = list().find((p) => same(p, owner, repo));
    if (!project) return { removed: false, openPrs: [] };
    let openPrs = null;
    try {
      openPrs = (await github.listNightshiftPrs(project.owner, project.repo)).map((pr) => pr.url);
    } catch {
      openPrs = null;
    }
    store.write(FILE, list().filter((p) => !same(p, owner, repo)));
    store.remove(`workspaces/${projectKey(project.owner, project.repo)}`);
    return { removed: true, openPrs };
  }

  function update(owner, repo, patch) {
    const projects = list();
    const index = projects.findIndex((p) => same(p, owner, repo));
    if (index === -1) return null;
    const next = { ...projects[index] };
    for (const key of UPDATABLE) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    projects[index] = next;
    store.write(FILE, projects);
    return next;
  }

  return { list, add, remove, update };
}
