#!/usr/bin/env python3
"""Lock enforcer for cas-ledger-v1 (see coordination/PROTOCOL.md).

Reads locks from the `frankenstate` ref's ledger.yml and fails if any commit
in the checked range modifies a file locked by an owner whose `Agent:` trailer
the commit does not carry. Turns tonight's advisory (collided-twice) locking
into a mechanical guarantee using nothing but git + CI.

Usage in CI:   enforce_locks.py --base <sha> --head <sha>
Local test:    enforce_locks.py --self-test
"""
import argparse, re, subprocess, sys

def sh(*args):
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout

def parse_ledger(text):
    """Minimal parser for our ledger subset (no external deps in CI).
    Expects:  locks:\n  - owner: NAME\n    files:\n      - PATTERN ..."""
    locks, owner, in_files = [], None, False
    for raw in text.splitlines():
        line = raw.rstrip()
        s = line.strip()
        if s.startswith('- owner:'):
            owner = s.split(':', 1)[1].strip()
            locks.append({'owner': owner, 'files': []})
            in_files = False
        elif s.startswith('files:') and owner is not None:
            in_files = True
        elif in_files and s.startswith('- '):
            locks[-1]['files'].append(s[2:].strip())
        elif s and not line.startswith(' '):
            owner, in_files = None, False
    return locks

def lock_owner(path, locks):
    for lock in locks:
        for pat in lock['files']:
            if pat.endswith('/**'):
                if path.startswith(pat[:-2]):
                    return lock['owner']
            elif path == pat:
                return lock['owner']
    return None

def evaluate(commits, locks):
    """commits: [{'sha':.., 'agent': str|None, 'files': [..]}] -> violations list."""
    violations = []
    for c in commits:
        for f in c['files']:
            owner = lock_owner(f, locks)
            if owner is None:
                continue
            if c['agent'] != owner:
                violations.append(
                    f"{c['sha'][:9]}: '{f}' is locked by '{owner}' but commit is "
                    f"attributed to '{c['agent'] or 'NO Agent trailer'}'")
    return violations

def commit_agent(sha):
    body = sh('git', 'log', '-1', '--format=%B', sha)
    m = re.search(r'^Agent:\s*(\S+)\s*$', body, re.M)
    return m.group(1) if m else None

def gather(base, head):
    shas = sh('git', 'rev-list', f'{base}..{head}').split()
    out = []
    for sha in shas:
        files = sh('git', 'diff-tree', '--no-commit-id', '--name-only', '-r', sha).split()
        out.append({'sha': sha, 'agent': commit_agent(sha), 'files': files})
    return out

def self_test():
    locks = parse_ledger(
        "version: 1\nlocks:\n  - owner: sol\n    files:\n"
        "      - studio/manual/product/**\n      - .github/workflows/pages.yml\n")
    assert lock_owner('studio/manual/product/studio.js', locks) == 'sol'
    assert lock_owner('coordination/PROTOCOL.md', locks) is None
    cases = [
        # (agent, files, expect_violation)
        ('claude', ['studio/manual/product/studio.js'], True),   # wrong agent on locked file
        ('sol',    ['studio/manual/product/studio.js'], False),  # owner touching own lock
        (None,     ['coordination/PROTOCOL.md'],        False),  # unlocked file, no trailer needed
        (None,     ['.github/workflows/pages.yml'],     True),   # locked file, unattributed
    ]
    for i, (agent, files, expect) in enumerate(cases):
        v = evaluate([{'sha': f'deadbeef{i}', 'agent': agent, 'files': files}], locks)
        assert bool(v) == expect, f'case {i} failed: {v}'
    print('self-test: 4/4 cases pass (both directions verified)')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base'); ap.add_argument('--head', default='HEAD')
    ap.add_argument('--ledger-ref', default='refs/remotes/origin/frankenstate')
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    try:
        ledger = sh('git', 'show', f'{a.ledger_ref}:ledger.yml')
    except subprocess.CalledProcessError:
        print('no frankenstate ledger found; nothing to enforce'); return
    locks = parse_ledger(ledger)
    if not locks:
        print('ledger has no active locks; pass'); return
    violations = evaluate(gather(a.base, a.head), locks)
    if violations:
        print('LOCK VIOLATIONS:\n' + '\n'.join(violations)); sys.exit(1)
    print(f'lock check pass: {a.base[:9]}..{a.head[:9]} respects all ledger locks')

if __name__ == '__main__':
    main()
