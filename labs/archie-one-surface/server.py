#!/usr/bin/env python3
import json, os, pathlib, subprocess, time, re, shlex
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = pathlib.Path(__file__).resolve().parent
HOME = pathlib.Path(os.environ.get('ARCHIE_OBSERVED_HOME', '/home/awesomekai')).resolve()
REMOTE = HOME / 'archie-remote'
TRAIN_ROOTS = (HOME / 'runs', HOME / 'archie-quaternion-heisenberg-autoscale-v1', HOME / 'archie-lab-observer-v2')
ROOM_TAIL_BYTES = 256 * 1024
SECRET_FLAGS = ('token', 'password', 'passwd', 'secret', 'api-key', 'api_key', 'authorization', 'cookie', 'credential', 'private_key')
SECRET_PATTERNS = (
    re.compile(r'(?i)(bearer\s+)[A-Za-z0-9._~+\-/=]+'),
    re.compile(r'(?i)\b(sk-[A-Za-z0-9_-]{12,})\b'),
    re.compile(r'(?i)\b(gh[opsu]_[A-Za-z0-9]{12,})\b'),
)


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(errors='replace'))
    except Exception:
        return None


def tail_text(path, lines=14, max_bytes=128 * 1024):
    try:
        with pathlib.Path(path).open('rb') as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes))
            data = handle.read().decode('utf-8', 'replace')
        return '\n'.join(data.splitlines()[-lines:])
    except Exception:
        return ''


def redact_text(value):
    text = str(value or '')
    for pattern in SECRET_PATTERNS:
        text = pattern.sub(lambda match: f'{match.group(1) if match.lastindex else ""}[REDACTED]', text)
    return text


def redact_value(value, key=''):
    if any(flag in str(key).lower() for flag in SECRET_FLAGS):
        return None if value is None else '[REDACTED]'
    if isinstance(value, dict):
        return {str(child_key): redact_value(child, str(child_key)) for child_key, child in value.items()}
    if isinstance(value, list):
        return [redact_value(child) for child in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


def redact_argv(argv):
    try:
        tokens = shlex.split(str(argv or ''))
    except Exception:
        tokens = str(argv or '').split()
    out, redact_next = [], False
    for token in tokens:
        lower = token.lower()
        if redact_next:
            out.append('[REDACTED]')
            redact_next = False
            continue
        if token.startswith('--') and '=' in token:
            name, _value = token.split('=', 1)
            out.append(f'{name}=[REDACTED]' if any(flag in name.lower() for flag in SECRET_FLAGS) else redact_text(token))
            continue
        out.append(redact_text(token))
        if token.startswith('--') and any(flag in lower for flag in SECRET_FLAGS):
            redact_next = True
    return ' '.join(shlex.quote(token) for token in out)


def proc_rows():
    rows = []
    try:
        output = subprocess.run(
            ['ps', '-eo', 'pid=,ppid=,etimes=,args='], capture_output=True, text=True, timeout=2
        ).stdout
        for line in output.splitlines():
            match = re.match(r'\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)', line)
            if match:
                rows.append({'pid': int(match[1]), 'ppid': int(match[2]), 'etimes': int(match[3]), 'argv': match[4]})
    except Exception:
        pass
    return rows


def gpu_rows(procs):
    by_pid = {process['pid']: process for process in procs}
    rows = []
    try:
        output = subprocess.run(
            ['nvidia-smi', '--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=2
        ).stdout
        for line in output.splitlines():
            parts = [item.strip() for item in line.split(',')]
            if parts and parts[0].isdigit():
                pid = int(parts[0])
                process = by_pid.get(pid, {})
                rows.append({
                    'pid': pid,
                    'name': parts[1] if len(parts) > 1 else '',
                    'memory_mib': parts[2] if len(parts) > 2 else '',
                    'argv': redact_argv(process.get('argv', '')),
                })
    except Exception:
        pass
    return rows


def flag(tokens, name):
    try:
        index = tokens.index(name)
        return tokens[index + 1] if index + 1 < len(tokens) else None
    except ValueError:
        return None


def active_trainer(procs, gpu_pids):
    markers = ('archie_lab_train.py', 'train_archie', 'train_typed_delta', 'typed_delta_train')
    candidates = [
        process for process in procs
        if any(marker in process['argv'].lower() for marker in markers)
        and 'observer' not in process['argv'].lower()
    ]
    if not candidates:
        return None
    process = min(candidates, key=lambda item: (0 if item['pid'] in gpu_pids else 1, item['etimes'], -item['pid']))
    try:
        tokens = shlex.split(process['argv'])
    except Exception:
        tokens = process['argv'].split()
    fields = {name: flag(tokens, name) for name in ('--scale', '--arm', '--seed', '--preset', '--model-size', '--max-steps')}
    return {
        'pid': process['pid'],
        'elapsed_seconds': process['etimes'],
        'argv': redact_argv(process['argv']),
        'on_gpu': process['pid'] in gpu_pids,
        'scale': fields['--scale'] or fields['--model-size'],
        'arm': fields['--arm'] or fields['--preset'],
        'seed': fields['--seed'],
        'max_steps': fields['--max-steps'],
    }


def latest_training():
    candidates, cutoff = [], time.time() - 7 * 86400
    for base in TRAIN_ROOTS:
        if not base.exists():
            continue
        try:
            for path in base.rglob('train.log'):
                try:
                    stat = path.stat()
                    if stat.st_size and stat.st_mtime > cutoff:
                        candidates.append((stat.st_mtime, path, stat.st_size))
                except Exception:
                    pass
        except Exception:
            pass
    if not candidates:
        return None
    mtime, path, size = max(candidates, key=lambda item: item[0])
    return {
        'name': str(path).replace(str(HOME) + '/', '~/'),
        'mtime': mtime,
        'bytes': size,
        'tail': redact_text(tail_text(path)),
    }


def recent_events(limit=14):
    path = REMOTE / 'roast.jsonl'
    try:
        with path.open('rb') as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - ROOM_TAIL_BYTES))
            lines = handle.read().decode('utf-8', 'replace').splitlines()[-220:]
    except Exception:
        return []
    events = []
    for line in lines:
        try:
            value = json.loads(line)
            text = str(value.get('text', ''))
            if text and value.get('from') != 'kai':
                events.append({'t': value.get('t', ''), 'from': value.get('from', '?'), 'text': redact_text(text[:500])})
        except Exception:
            pass
    return events[-limit:]


def state():
    procs = proc_rows()
    gpu = gpu_rows(procs)
    gpu_pids = {row['pid'] for row in gpu}
    service_patterns = {
        'runtime truth': 'runtime_truth.py',
        'observer': 'archie-lab-observer-v2/observer.py',
        'gate': 'archie-remote/gate.py',
        'live exec': 'archie-remote/live_exec.py',
        'shell sidecar': 'archie-shell-sidecar.py',
        'resident': 'archie-resident-gpt56/resident.py',
    }
    services = [
        {'name': name, 'live': any(pattern in process['argv'] for process in procs)}
        for name, pattern in service_patterns.items()
    ]
    workers = [
        process for process in procs
        if any(marker in process['argv'] for marker in ('agent_worker.py', 'codex_room_bridge.py', 'resident.py'))
    ]
    return {
        'generated_unix': time.time(),
        'runtime': redact_value(read_json(REMOTE / 'runtime_truth.json') or {}),
        'gpu': gpu,
        'services': services,
        'agents': [{'pid': process['pid'], 'argv': redact_argv(process['argv']), 'live': True} for process in workers],
        'active_trainer': active_trainer(procs, gpu_pids),
        'training': latest_training(),
        'events': recent_events(),
        'representation': {
            'schema': 'archie-one-surface/v1',
            'read_only': True,
            'sources': 'runtime truth + bounded process/log observations',
            'personal_media_scanned': False,
            'sensitive_text_redaction': True,
            'runtime_truth_recursively_redacted': True,
        },
    }


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?', 1)[0] == '/api/state':
            body = json.dumps(state(), indent=2).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    os.chdir(ROOT)
    host = os.environ.get('ARCHIE_ONE_HOST', '127.0.0.1')
    port = int(os.environ.get('ARCHIE_ONE_PORT', '8890'))
    print(f'ARCHIE ONE SURFACE http://{host}:{port}', flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
