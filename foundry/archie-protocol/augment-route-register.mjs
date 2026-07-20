#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => { const index = args.indexOf(flag); return index === -1 ? fallback : args[index + 1]; };
const input = value('--input');
const output = value('--out');
if (!input || !output) throw new Error('Usage: augment-route-register.mjs --input route-train.json --out route-train.register.json');

const rows = JSON.parse(fs.readFileSync(input, 'utf8'));
const wrappers = [
  prompt => `hey can you ${prompt}`,
  prompt => `could you help me ${prompt}`,
  prompt => `ok so i need to ${prompt}`,
  prompt => `real quick, ${prompt}`,
  prompt => `please ${prompt}`,
  prompt => `i'm trying to ${prompt}`
];
const normalize = text => String(text).toLowerCase().replace(/\s+/g, ' ').trim();
const seen = new Set(rows.map(row => `${row.route}\0${normalize(row.prompt)}`));
const augmented = [...rows];
for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index];
  const prompt = normalize(row.prompt).replace(/^(please|hey|hi|hello)\s+/, '');
  const count = Math.min(2, wrappers.length);
  for (let offset = 0; offset < count; offset += 1) {
    const wrapper = wrappers[(index + offset * 3) % wrappers.length];
    const candidate = normalize(wrapper(prompt));
    const key = `${row.route}\0${candidate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    augmented.push({
      ...row,
      prompt: candidate,
      augmentation: {
        type: 'conversational-register/v1',
        source_prompt_digest_hint: normalize(row.prompt).slice(0, 80)
      }
    });
  }
}
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(augmented, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, source_rows: rows.length, output_rows: augmented.length, added_rows: augmented.length - rows.length, output: path.resolve(output) }, null, 2));
