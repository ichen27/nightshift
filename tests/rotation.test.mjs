import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickProjects } from '../src/rotation.mjs';

const p = (repo, lastVisit, addedAt = '2026-01-01T00:00:00.000Z') => ({
  owner: 'octo', repo, addedAt, lastVisitAt: lastVisit ? `${lastVisit}T07:00:00.000Z` : null,
});

test('never-visited projects go first, then oldest', () =>
  assert.deepEqual(
    pickProjects([p('a', '2026-11-10'), p('b', null), p('c', '2026-11-01'), p('d', '2026-11-12')], 3).map((x) => x.repo),
    ['b', 'c', 'a'],
  ));

test('ties are broken by when the project was added', () => {
  const projects = [p('late', null, '2026-03-01T00:00:00.000Z'), p('early', null, '2026-02-01T00:00:00.000Z')];
  assert.deepEqual(pickProjects(projects, 2).map((x) => x.repo), ['early', 'late']);
  const visited = [p('late', '2026-11-01', '2026-03-01T00:00:00.000Z'), p('early', '2026-11-01', '2026-02-01T00:00:00.000Z')];
  assert.deepEqual(pickProjects(visited, 1).map((x) => x.repo), ['early']);
});

test('asking for more than there are returns them all, and the input is not reordered', () => {
  const projects = [p('a', '2026-11-10'), p('b', null)];
  assert.equal(pickProjects(projects, 5).length, 2);
  assert.deepEqual(projects.map((x) => x.repo), ['a', 'b']);
  assert.deepEqual(pickProjects(projects, 0), []);
  assert.deepEqual(pickProjects([], 3), []);
});
