from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import SGDClassifier

from diversity_training_io import sha256_bytes

SEED = 73021
QUANT = 4096

@dataclass(frozen=True)
class Dataset:
    texts: list[str]
    labels: dict[str, list[str]]


def train_export_model(train: Dataset, heldout: Dataset, *, schema: str, max_features: int, alpha: float, sparse_features: int) -> tuple[dict, dict]:
    vectorizer = TfidfVectorizer(
        lowercase=True,
        ngram_range=(1, 2),
        min_df=2,
        max_features=max_features,
        token_pattern=r"(?u)\b\w\w+\b",
        norm="l2",
        sublinear_tf=False,
    )
    x_train = vectorizer.fit_transform(train.texts)
    x_test = vectorizer.transform(heldout.texts)
    vocabulary = vectorizer.get_feature_names_out().tolist()
    idf_q = np.rint(vectorizer.idf_ * QUANT).astype(np.int32)
    heads: dict[str, object] = {}
    metrics: dict[str, object] = {}
    for offset, (head, y_train) in enumerate(train.labels.items()):
        classifier = SGDClassifier(
            loss="log_loss",
            alpha=alpha,
            max_iter=40,
            tol=1e-4,
            random_state=SEED + offset,
            average=True,
            class_weight="balanced",
        )
        classifier.fit(x_train, y_train)
        classes = classifier.classes_.tolist()
        coefficients = classifier.coef_
        intercepts = classifier.intercept_
        if len(classes) == 2 and coefficients.shape[0] == 1:
            coefficients = np.vstack([-coefficients[0], coefficients[0]])
            intercepts = np.asarray([-intercepts[0], intercepts[0]])
        q_coef = np.rint(coefficients * QUANT).astype(np.int32)
        q_intercept = np.rint(intercepts * QUANT).astype(np.int32)
        sparse_rows = []
        scores = np.zeros((x_test.shape[0], len(classes)), dtype=np.float64)
        for class_index, row in enumerate(q_coef):
            keep = min(sparse_features, row.shape[0])
            positions = np.argsort(np.abs(row))[-keep:]
            positions = positions[np.argsort(positions)]
            weights = row[positions]
            sparse_rows.append([[int(position), int(weight)] for position, weight in zip(positions, weights) if weight != 0])
            scores[:, class_index] = np.asarray(x_test[:, positions] @ weights).reshape(-1) + q_intercept[class_index]
        predicted = np.asarray(classes, dtype=object)[np.argmax(scores, axis=1)]
        expected = np.asarray(heldout.labels[head], dtype=object)
        accuracy = float(np.mean(predicted == expected))
        failures = [
            {"index": int(i), "expected": str(expected[i]), "predicted": str(predicted[i]), "text_sha256": sha256_bytes(heldout.texts[i].encode())}
            for i in np.flatnonzero(predicted != expected)[:4]
        ]
        heads[head] = {
            "classes": classes,
            "intercept_q4096": q_intercept.tolist(),
            "coefficient_sparse_q4096": sparse_rows,
        }
        metrics[head] = {"accuracy": accuracy, "failures": failures, "classes": len(classes)}
    used_positions = sorted({
        position
        for head in heads.values()
        for class_row in head["coefficient_sparse_q4096"]
        for position, _weight in class_row
    })
    remap = {old: new for new, old in enumerate(used_positions)}
    for head in heads.values():
        head["coefficient_sparse_q4096"] = [
            [[remap[position], weight] for position, weight in class_row]
            for class_row in head["coefficient_sparse_q4096"]
        ]
    compact_vocabulary = [vocabulary[position] for position in used_positions]
    compact_idf_q = [int(idf_q[position]) for position in used_positions]
    model_artifact = {
        "schema": schema,
        "tokenizer": {"lowercase": True, "word_min_chars": 2, "ngrams": [1, 2], "tf": "raw-count", "norm": "l2"},
        "quantization": {"kind": "signed-linear-tfidf", "scale": QUANT},
        "vocabulary": compact_vocabulary,
        "idf_q4096": compact_idf_q,
        "heads": heads,
        "promotion": "not-admitted",
    }
    receipt = {
        "schema": f"{schema}-training-receipt",
        "seed": SEED,
        "training_rows": len(train.texts),
        "heldout_rows": len(heldout.texts),
        "training_text_digest": sha256_bytes("\n".join(train.texts).encode()),
        "heldout_text_digest": sha256_bytes("\n".join(heldout.texts).encode()),
        "vocabulary_size": len(vocabulary),
        "sgd_alpha": alpha,
        "metrics": metrics,
        "promotion": "not-admitted",
    }
    return model_artifact, receipt
