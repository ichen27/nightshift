// Builds and runs the headless Claude Code call that inspects one project.
import { readFileSync } from 'node:fs';

const BRIEF = readFileSync(new URL('../prompts/brief.md', import.meta.url), 'utf8');
const TITLE_MAX = 160;
const DETAIL_MAX = 1500;
const KINDS = ['fix', 'dependency-patch', 'dead-code', 'docs'];

const note = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'detail', 'security'],
  properties: { title: { type: 'string' }, detail: { type: 'string' }, security: { type: 'boolean' } },
};

// What the model must reply with. Passed to the command line as --json-schema.
export const AGENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'change', 'proposals'],
  properties: {
    findings: { type: 'array', items: note },
    change: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'summary', 'kind', 'security', 'majorUpgrade', 'claims'],
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            kind: { type: 'string', enum: KINDS },
            security: { type: 'boolean' },
            majorUpgrade: { type: 'boolean' },
            claims: { type: 'array', items: { type: 'string' } },
          },
        },
      ],
    },
    proposals: { type: 'array', items: note },
  },
};

const CHANGE_RULE =
  'Make at most one change tonight: the one most worth making that is small and safe. Add or update a test ' +
  'that fails without your change and passes with it, unless the change is a dependency patch, dead-code ' +
  "removal or documentation. Run the repository's own checks until they pass. Commit to the current branch " +
  'with a plain message describing the change. Only what you commit is kept; files left uncommitted are ' +
  'discarded. Describe it in "change". If nothing is worth changing, set "change" to null; that is a normal result.';
const PUBLIC_RULE =
  ' If the change fixes a security problem, the commit message, the title and the summary must not describe ' +
  'the weakness. Say what the code now does.';
const NO_CHANGE_RULE = 'Do not change any file tonight. Set "change" to null.';

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();
const clip = (text, max) => {
  const flat = oneLine(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function renderBrief({ project, mayChange, isPublic, knownFindings }) {
  const known = knownFindings.length ? knownFindings.map((title) => `- ${oneLine(title)}`).join('\n') : '(nothing yet)';
  const changeRule = mayChange ? CHANGE_RULE + (isPublic ? PUBLIC_RULE : '') : NO_CHANGE_RULE;
  // A function replacement, so "$" in a title is never treated as a pattern.
  const fill = { project: oneLine(project), knownFindings: known, changeRule };
  return BRIEF.replace(/\{(project|knownFindings|changeRule)\}/g, (_match, key) => fill[key]);
}

// `claudeDir` is a folder of the model's own for its sign-in and state, so it never reads
// or writes the user's everyday Claude Code settings.
export function buildAgentCall({ claudePath, brief, claudeDir, token }) {
  return {
    argv: [
      claudePath, '-p', brief,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(AGENT_SCHEMA),
      '--dangerously-skip-permissions',
      '--safe-mode',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--disallowedTools', 'Bash(gh *)', 'Bash(git push *)', 'Bash(git remote *)', 'WebFetch', 'WebSearch',
    ],
    env: { CLAUDE_CONFIG_DIR: claudeDir, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) },
  };
}

const isNote = (item) =>
  item && typeof item.title === 'string' && typeof item.detail === 'string' && typeof item.security === 'boolean';
const isChange = (change) =>
  change === null ||
  (typeof change === 'object' &&
    typeof change.title === 'string' &&
    typeof change.summary === 'string' &&
    KINDS.includes(change.kind) &&
    typeof change.security === 'boolean' &&
    typeof change.majorUpgrade === 'boolean' &&
    Array.isArray(change.claims) &&
    change.claims.every((claim) => typeof claim === 'string'));

function tidy(output) {
  const tidyNote = (item) => ({ title: clip(item.title, TITLE_MAX), detail: clip(item.detail, DETAIL_MAX), security: item.security });
  return {
    findings: output.findings.map(tidyNote),
    change: output.change && {
      title: clip(output.change.title, TITLE_MAX),
      summary: clip(output.change.summary, DETAIL_MAX),
      kind: output.change.kind,
      security: output.change.security,
      majorUpgrade: output.change.majorUpgrade,
      claims: output.change.claims.map((claim) => clip(claim, DETAIL_MAX)),
    },
    proposals: output.proposals.map(tidyNote),
  };
}

function modelName(reply) {
  const usage = Object.entries(reply.modelUsage ?? {});
  if (usage.length === 0) return null;
  return usage.sort(([, a], [, b]) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0))[0][0];
}

function errorReason(text) {
  const message = String(text ?? '');
  if (/usage limit|rate limit|limit reached|hit your limit/i.test(message)) return 'Claude usage limit reached';
  if (/authenticat|not logged in|please log ?in|\/login|OAuth|unauthorized/i.test(message)) return 'Claude is not signed in';
  return `Claude stopped with an error: ${message.trim().split('\n')[0] || 'no detail given'}`;
}

const failed = (failure, model = null) => ({ ok: false, output: null, model, failure });

export async function runAgent({ restrictedRun, call, cwd, cacheDir, claudeDir, timeoutMs }) {
  const result = await restrictedRun(call.argv, { cwd, timeoutMs, writable: [cwd, claudeDir], cacheDir, env: call.env });
  if (result.timedOut) return failed('The model ran out of time.');

  let reply = null;
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    // Handled below.
  }
  if (!reply || typeof reply !== 'object') {
    return failed(result.code !== 0 ? errorReason(result.stderr) : 'Claude returned something that could not be read.');
  }
  const model = modelName(reply);
  if (reply.is_error) return failed(errorReason(reply.result), model);

  const output = reply.structured_output;
  if (output === undefined || output === null) return failed('The model did not return a report.', model);
  const shaped =
    Array.isArray(output.findings) && output.findings.every(isNote) &&
    Array.isArray(output.proposals) && output.proposals.every(isNote) &&
    isChange(output.change ?? null) && output.change !== undefined;
  if (!shaped) return failed('The model returned a report in the wrong shape.', model);
  return { ok: true, output: tidy(output), model, failure: null };
}
