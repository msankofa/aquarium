// Every test-*.mjs in turn. Plain Node scripts, no framework -- the workshop's own convention.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

let failed = 0;
for (const file of readdirSync('.').filter(f => /^test-.*\.mjs$/.test(f)).sort()) {
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  const tail = (r.stdout || '').trim().split('\n').pop() || (r.stderr || '').trim().split('\n').pop();
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file.padEnd(36)} ${tail}`);
}
console.log(failed ? `\n${failed} test file(s) failed` : '\nall test files passed');
process.exit(failed ? 1 : 0);
