// Shared test helpers. Not a test file.

// A fake `run` that records every call and answers from a list of [matcher, result] pairs.
// A result may be an object or a function of (argv, options). Unmatched commands fail.
export function fakeRun(answers = []) {
  const calls = [];
  const run = async (argv, options = {}) => {
    calls.push({ argv, options });
    for (const [match, result] of answers) {
      if (match(argv, options)) {
        const value = typeof result === 'function' ? await result(argv, options) : result;
        return { code: 0, stdout: '', stderr: '', timedOut: false, ...value };
      }
    }
    return { code: 1, stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, timedOut: false };
  };
  return { run, calls };
}

// Matches an argv that contains every given word.
export const has = (...words) => (argv) => words.every((w) => argv.includes(w));
