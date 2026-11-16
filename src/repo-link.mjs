// Turns whatever was pasted into { owner, repo }, or throws LinkError.

export class LinkError extends Error {
  constructor() {
    super("That isn't a GitHub repository link.");
    this.name = 'LinkError';
  }
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SCP_FORM = /^git@github\.com:(.+)$/i;
const URL_FORM = /^(?:(?:https?|ssh|git):\/\/)?(?:git@)?(?:www\.)?github\.com\/(.+)$/i;

export function parseRepoLink(text) {
  if (typeof text !== 'string') throw new LinkError();
  const link = text.trim();
  if (link === '' || /\s/.test(link)) throw new LinkError();

  let path;
  let shorthand = false;
  const scp = SCP_FORM.exec(link);
  const url = URL_FORM.exec(link);
  if (scp) path = scp[1];
  else if (url) path = url[1];
  else if (!link.includes(':')) {
    path = link;
    shorthand = true;
  } else throw new LinkError();

  const parts = path.split(/[?#]/)[0].split('/');
  if (shorthand ? parts.length !== 2 : parts.length < 2) throw new LinkError();
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') throw new LinkError();
  return { owner, repo };
}
