import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/exec.mjs';
import { LABEL, renderPlist, schedulePath } from '../scripts/install-schedule.mjs';

const values = {
  nodePath: '/opt/node/bin/node', repoDir: '/code/nightshift', dataDir: '/data/night & day', logDir: '/home/me/Library/Logs/nightshift',
  path: '/opt/node/bin:/usr/bin:/bin', home: '/home/me',
};

// Checks tags are balanced and properly nested. Enough to catch a broken template.
function wellFormed(xml) {
  const stack = [];
  const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '');
  for (const [, closing, name, selfClosing] of body.matchAll(/<(\/?)([A-Za-z][\w.-]*)[^>]*?(\/?)>/g)) {
    if (selfClosing) continue;
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0 && !/&(?!(amp|lt|gt|quot|apos);)/.test(body);
}
const valueAfter = (xml, key) => new RegExp(`<key>${key}</key>\\s*<(string|integer)>([^<]*)</\\1>`).exec(xml)?.[2];

test('the plist is well-formed XML with no placeholder left in it', () => {
  const plist = renderPlist(values);
  assert.ok(wellFormed(plist));
  assert.doesNotMatch(plist, /\{\{|\}\}/);
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist /);
});

test('the job runs the nightly command at 2:00 and never at load', () => {
  const plist = renderPlist(values);
  assert.equal(valueAfter(plist, 'Label'), LABEL);
  assert.equal(LABEL, 'com.ichen27.nightshift-run');
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/code\/nightshift\/src\/cli\.mjs<\/string>\s*<string>run<\/string>\s*<\/array>/);
  assert.match(plist, /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>2<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>\s*<\/dict>/);
  assert.doesNotMatch(plist, /RunAtLoad|KeepAlive/);
});

test('the job gets PATH, HOME and the data folder, and logs under the given folder', () => {
  const plist = renderPlist(values);
  assert.equal(valueAfter(plist, 'PATH'), '/opt/node/bin:/usr/bin:/bin');
  assert.equal(valueAfter(plist, 'HOME'), '/home/me');
  assert.equal(valueAfter(plist, 'NIGHTSHIFT_DATA_DIR'), '/data/night &amp; day', 'values are escaped');
  assert.equal(valueAfter(plist, 'StandardOutPath'), '/home/me/Library/Logs/nightshift/run.log');
  assert.equal(valueAfter(plist, 'StandardErrorPath'), '/home/me/Library/Logs/nightshift/run.log');
});

test('another time can be given, and a time that is not a time is refused', () => {
  const plist = renderPlist({ ...values, hour: 23, minute: 30 });
  assert.match(plist, /<integer>23<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/);
  for (const bad of [{ hour: 24 }, { minute: 60 }, { hour: -1 }, { hour: 2.5 }, { hour: '2' }]) {
    assert.throws(() => renderPlist({ ...values, ...bad }), /time/);
  }
});

test('the job\'s PATH starts with the folder node is in and has the usual tool folders once each', () => {
  assert.equal(schedulePath({ execPath: '/opt/homebrew/bin/node', home: '/home/me' }),
    '/opt/homebrew/bin:/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(schedulePath({ execPath: '/x/node', home: '/h' }).split(':')[0], '/x');
});

test('on macOS the rendered plist passes plutil', { skip: process.platform !== 'darwin' }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'nightshift-plist-')), 'job.plist');
  writeFileSync(file, renderPlist(values));
  const lint = await run(['/usr/bin/plutil', '-lint', file]);
  assert.equal(lint.code, 0, lint.stdout + lint.stderr);
});
