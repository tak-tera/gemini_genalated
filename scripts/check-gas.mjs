// GAS のコードを push 前に確かめる（構文エラーとマニフェストの JSON）。認証は不要。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const projects = readdirSync('.', { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(d.name, '.clasp.json')))
  .map((d) => d.name);

let errors = 0;
for (const p of projects) {
  const dir = join(p, JSON.parse(readFileSync(join(p, '.clasp.json'), 'utf8')).rootDir || '.');
  const files = readdirSync(dir).filter((f) => f.endsWith('.gs'));
  for (const f of files) {
    try {
      new vm.Script(readFileSync(join(dir, f), 'utf8'), { filename: join(dir, f) });
    } catch (e) {
      errors++;
      console.error(`NG  ${join(dir, f)}: ${e.message}`);
    }
  }
  try {
    JSON.parse(readFileSync(join(dir, 'appsscript.json'), 'utf8'));
  } catch (e) {
    errors++;
    console.error(`NG  ${join(dir, 'appsscript.json')}: ${e.message}`);
  }
  console.log(`${p}: .gs ${files.length} 件を確認`);
}
if (errors) {
  console.error(`エラー ${errors} 件`);
  process.exit(1);
}
