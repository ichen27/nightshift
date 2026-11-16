// Every call to the GitHub CLI goes through here.

const GH_TIMEOUT_MS = 60_000;

export function createGithub({ run, ghPath }) {
  const gh = (args, options = {}) => run([ghPath, ...args], { timeoutMs: GH_TIMEOUT_MS, ...options });

  async function getRepo(owner, repo) {
    const result = await gh(['api', `repos/${owner}/${repo}`]);
    if (result.code !== 0) {
      if (/HTTP 404|Not Found/i.test(result.stderr)) return { exists: false };
      throw new Error(`GitHub could not be reached: ${firstLine(result.stderr) || 'gh failed'}`);
    }
    const data = JSON.parse(result.stdout);
    const allowed = [
      ['squash', data.allow_squash_merge],
      ['merge', data.allow_merge_commit],
      ['rebase', data.allow_rebase_merge],
    ];
    // GitHub omits these fields for some callers; when it says nothing, assume all three.
    const known = allowed.some(([, value]) => typeof value === 'boolean');
    return {
      exists: true,
      owner: data.owner.login,
      repo: data.name,
      archived: data.archived === true,
      canPush: data.permissions?.push === true,
      isPublic: data.private === false,
      defaultBranch: data.default_branch,
      mergeMethods: allowed.filter(([, value]) => !known || value === true).map(([name]) => name),
    };
  }

  async function listNightshiftPrs(owner, repo) {
    const result = await gh([
      'pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'open', '--limit', '100',
      '--json', 'number,url,headRefName,headRefOid',
    ]);
    if (result.code !== 0) {
      throw new Error(`Could not list pull requests for ${owner}/${repo}: ${firstLine(result.stderr) || 'gh failed'}`);
    }
    return JSON.parse(result.stdout).filter((pr) => pr.headRefName.startsWith('nightshift/'));
  }

  return { getRepo, listNightshiftPrs };
}

function firstLine(text) {
  return String(text || '').trim().split('\n')[0];
}
