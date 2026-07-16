import process from 'node:process';

export function parseArguments(argv = []) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index]);
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const [name, inline] = value.split('=', 2);
    if (inline !== undefined) {
      const list = flags.get(name) || [];
      list.push(inline);
      flags.set(name, list);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      const list = flags.get(name) || [];
      list.push(String(next));
      flags.set(name, list);
      index += 1;
    } else {
      flags.set(name, ['true']);
    }
  }
  return Object.freeze({ positionals: Object.freeze(positionals), flags });
}

export function last(flags, name, fallback = '') {
  const values = flags.get(name);
  return values?.length ? values[values.length - 1] : fallback;
}

export function has(flags, name) {
  return flags.has(name);
}

export function integer(flags, name, fallback) {
  const value = last(flags, name, String(fallback));
  if (!/^-?\d+$/.test(value)) throw new Error(`${name} requires an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} requires a safe integer.`);
  return parsed;
}

export function number(flags, name, fallback) {
  const value = Number(last(flags, name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${name} requires a finite number.`);
  return value;
}

export function requiredFlag(flags, name) {
  const value = last(flags, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function printJSON(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}
