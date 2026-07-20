#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, resource, time
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np
from sklearn.metrics import confusion_matrix, log_loss
from factorized_controller import ROUTES
from factorized_controller_v2 import ConservativeFactorizedController


def read_rows(path: str):
    p = Path(path)
    if p.suffix == '.jsonl':
        return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]
    return json.loads(p.read_text())


def sha256(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def ece(confidence: np.ndarray, correct: np.ndarray, bins: int = 10) -> float:
    value = 0.0
    for lo in np.linspace(0.0, 1.0, bins, endpoint=False):
        hi = lo + 1.0 / bins
        mask = (confidence >= lo) & (confidence < (hi if hi < 1 else 1.000001))
        if mask.any():
            value += mask.mean() * abs(correct[mask].mean() - confidence[mask].mean())
    return float(value)


def score(rows, predictions, latencies):
    exact, route_ok, confidence, probabilities, labels = [], [], [], [], []
    categories = defaultdict(lambda: [0, 0])
    sources, errors = Counter(), []
    for row, prediction in zip(rows, predictions):
        expected = row['expected']
        ok = (
            prediction['route'] == expected['route']
            and prediction['authority'] == expected['authority']
            and prediction['context'] == expected['context']
            and prediction['outcomes'] == expected['outcomes']
        )
        route_match = prediction['route'] == expected['route']
        category = row.get('category') or row.get('family', 'unknown')
        exact.append(ok)
        route_ok.append(route_match)
        categories[category][0] += int(ok)
        categories[category][1] += 1
        confidence.append(prediction['confidence'])
        probabilities.append([prediction['probabilities'][route] for route in ROUTES])
        labels.append(ROUTES.index(expected['route']))
        sources[prediction['decision_source']] += 1
        if not ok:
            errors.append({
                'id': row['id'],
                'category': category,
                'request': row['request'],
                'expected': expected,
                'actual': {key: prediction[key] for key in (
                    'route', 'authority', 'context', 'outcomes', 'confidence',
                    'decision_source', 'reference')},
            })
    correct = np.asarray(exact, dtype=float)
    conf = np.asarray(confidence, dtype=float)
    probs = np.asarray(probabilities, dtype=float)
    y_true = np.asarray(labels, dtype=int)
    y_pred = np.asarray([ROUTES.index(item['route']) for item in predictions], dtype=int)
    one_hot = np.eye(len(ROUTES))[y_true]
    order = np.argsort(-conf)
    selective = {}
    for coverage in (0.5, 0.75, 0.9, 1.0):
        count = max(1, int(round(len(rows) * coverage)))
        selective[str(coverage)] = float(correct[order[:count]].mean())
    return {
        'examples': len(rows),
        'correct': int(correct.sum()),
        'accuracy': float(correct.mean()),
        'route_accuracy': float(np.mean(route_ok)),
        'categories': {
            key: {'correct': value[0], 'examples': value[1], 'accuracy': value[0] / value[1]}
            for key, value in sorted(categories.items())
        },
        'confusion_matrix': {
            'labels': ROUTES,
            'matrix': confusion_matrix(y_true, y_pred, labels=range(len(ROUTES))).tolist(),
        },
        'calibration': {
            'nll': float(log_loss(y_true, np.clip(probs, 1e-9, 1), labels=range(len(ROUTES)))),
            'ece_10': ece(conf, correct),
            'brier': float(np.mean(np.sum((probs - one_hot) ** 2, axis=1))),
            'mean_confidence_correct': float(conf[correct == 1].mean()) if (correct == 1).any() else None,
            'mean_confidence_incorrect': float(conf[correct == 0].mean()) if (correct == 0).any() else None,
            'selective_accuracy': selective,
        },
        'decision_sources': dict(sources),
        'latency_ms': {
            'mean': float(np.mean(latencies)),
            'median': float(np.median(latencies)),
            'p95': float(np.percentile(latencies, 95)),
        },
        'max_rss_mb': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
        'errors': errors,
    }


def predict(controller, rows, mode: str):
    predictions, latencies = [], []
    for row in rows:
        start = time.perf_counter()
        if mode == 'semantic-alone':
            probs = controller.semantic_probs([row], 'new')[0]
            route = ROUTES[int(np.argmax(probs))]
            prediction = {
                'route': route,
                'authority': 'allow',
                'context': 'ready',
                'outcomes': [] if route == 'clarify' else ([route] if route != 'compound' else []),
                'confidence': float(probs.max()),
                'probabilities': dict(zip(ROUTES, map(float, probs))),
                'decision_source': 'semantic-new-v2',
                'reference': 'none',
            }
        elif mode == 'structural-alone':
            prediction = controller.infer(row, semantic_mode='new')
        else:
            prediction = controller.infer(row, semantic_mode='conservative')
        latencies.append((time.perf_counter() - start) * 1000)
        predictions.append(prediction)
    return score(rows, predictions, latencies)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('suite')
    parser.add_argument('--out', required=True)
    parser.add_argument('--mode', choices=('semantic-alone', 'structural-alone', 'fused'), default='fused')
    parser.add_argument('--bundle', default='artifacts/factorized-controller-v2.joblib')
    parser.add_argument('--gru', default='artifacts/byte-gru-v2.pt')
    parser.add_argument('--v9', default='/mnt/data/router_bundle.joblib')
    parser.add_argument('--candidate', default='factorized-v2')
    args = parser.parse_args()
    rows = read_rows(args.suite)
    controller = ConservativeFactorizedController(args.bundle, args.gru, args.v9)
    receipt = {
        'schema': 'archie-factorized-postfreeze-evaluation/v1',
        'candidate': args.candidate,
        'suite_sha256': sha256(args.suite),
        'artifact_sha256': {
            'bundle': sha256(args.bundle),
            'gru': sha256(args.gru),
            'v9': sha256(args.v9),
        },
        'metrics': predict(controller, rows, args.mode),
        'promotion': 'not-admitted',
    }
    Path(args.out).write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({
        'candidate': args.candidate,
        'mode': args.mode,
        'correct': receipt['metrics']['correct'],
        'examples': receipt['metrics']['examples'],
        'accuracy': receipt['metrics']['accuracy'],
    }, indent=2))


if __name__ == '__main__':
    main()
