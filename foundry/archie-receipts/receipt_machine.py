from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Sequence

Path = tuple[str | int, ...]


class ReceiptError(ValueError):
    pass


def _read(root: Any, path: Path) -> Any:
    node = root
    for key in path:
        node = node[key]
    return node


def _write(root: Any, path: Path, value: Any) -> Any:
    if not path:
        return value
    key, *rest = path
    tail = tuple(rest)
    if isinstance(root, tuple):
        clone = list(root)
        clone[key] = _write(clone[key], tail, value)
        return tuple(clone)
    if isinstance(root, list):
        clone = list(root)
        clone[key] = _write(clone[key], tail, value)
        return clone
    if isinstance(root, Mapping):
        clone = dict(root)
        clone[key] = _write(clone[key], tail, value)
        return clone
    raise ReceiptError(f"cannot write through {type(root).__name__} at {path!r}")


@dataclass(frozen=True, slots=True)
class Write:
    path: Path
    value: Any


@dataclass(frozen=True, slots=True)
class Guard:
    path: Path
    expected: Any

    def accepts(self, state: Any) -> bool:
        return _read(state, self.path) == self.expected


@dataclass(frozen=True, slots=True)
class Receipt:
    op: str
    writes: tuple[Write, ...] = ()
    guards: tuple[Guard, ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def validate(self, state: Any) -> None:
        paths = [write.path for write in self.writes]
        if len(paths) != len(set(paths)):
            raise ReceiptError("one receipt cannot write the same path twice")
        for guard in self.guards:
            if not guard.accepts(state):
                raise ReceiptError(f"guard failed at {guard.path!r}")
        for write in self.writes:
            _read(state, write.path)


@dataclass(frozen=True, slots=True)
class CommittedReceipt:
    forward: Receipt
    inverse: Receipt
    before_hash: int
    after_hash: int


@dataclass(frozen=True, slots=True)
class Ledger:
    state: Any
    commits: tuple[CommittedReceipt, ...] = ()

    @classmethod
    def start(cls, state: Any) -> "Ledger":
        return cls(state=state)

    def apply(self, receipt: Receipt) -> "Ledger":
        receipt.validate(self.state)
        inverse_writes = tuple(Write(write.path, _read(self.state, write.path)) for write in receipt.writes)
        next_state = self.state
        for write in receipt.writes:
            next_state = _write(next_state, write.path, write.value)
        inverse = Receipt(op=f"undo:{receipt.op}", writes=inverse_writes, metadata={"undoes": receipt.op})
        commit = CommittedReceipt(
            forward=receipt,
            inverse=inverse,
            before_hash=hash(_freeze(self.state)),
            after_hash=hash(_freeze(next_state)),
        )
        return Ledger(state=next_state, commits=self.commits + (commit,))

    def undo(self) -> "Ledger":
        if not self.commits:
            raise ReceiptError("ledger is empty")
        commit = self.commits[-1]
        if hash(_freeze(self.state)) != commit.after_hash:
            raise ReceiptError("ledger checksum mismatch")
        previous = self.state
        for write in commit.inverse.writes:
            previous = _write(previous, write.path, write.value)
        if hash(_freeze(previous)) != commit.before_hash:
            raise ReceiptError("inverse receipt failed restoration")
        return Ledger(state=previous, commits=self.commits[:-1])

    def replay(self, receipts: Iterable[Receipt]) -> "Ledger":
        ledger = self
        for receipt in receipts:
            ledger = ledger.apply(receipt)
        return ledger


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return tuple(sorted((key, _freeze(item)) for key, item in value.items()))
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, set):
        return tuple(sorted(_freeze(item) for item in value))
    return value


def _receipt_key(receipt: Receipt) -> Any:
    return (
        receipt.op,
        tuple((write.path, _freeze(write.value)) for write in receipt.writes),
        tuple((guard.path, _freeze(guard.expected)) for guard in receipt.guards),
        _freeze(receipt.metadata),
    )


@dataclass(frozen=True, slots=True)
class Hypothesis:
    ledger: Ledger
    weight: float
    trace: tuple[str, ...] = ()


class Beam:
    def __init__(self, hypotheses: Sequence[Hypothesis]):
        if not hypotheses:
            raise ReceiptError("beam requires at least one hypothesis")
        self.hypotheses = tuple(hypotheses)

    @classmethod
    def start(cls, state: Any) -> "Beam":
        return cls((Hypothesis(Ledger.start(state), 1.0),))

    def branch(self, proposals: Callable[[Any], Iterable[tuple[Receipt, float]]]) -> "Beam":
        candidates: list[Hypothesis] = []
        for hypothesis in self.hypotheses:
            for receipt, probability in proposals(hypothesis.ledger.state):
                if probability <= 0:
                    continue
                try:
                    ledger = hypothesis.ledger.apply(receipt)
                except ReceiptError:
                    continue
                candidates.append(
                    Hypothesis(
                        ledger=ledger,
                        weight=hypothesis.weight * probability,
                        trace=hypothesis.trace + (receipt.op,),
                    )
                )
        if not candidates:
            raise ReceiptError("all receipt hypotheses were rejected")
        return Beam(_merge_equivalent(candidates))

    def observe(self, predicate: Callable[[Any], bool]) -> "Beam":
        survivors = [hypothesis for hypothesis in self.hypotheses if predicate(hypothesis.ledger.state)]
        if not survivors:
            raise ReceiptError("observation killed every hypothesis")
        total = sum(hypothesis.weight for hypothesis in survivors)
        normalized = [
            Hypothesis(hypothesis.ledger, hypothesis.weight / total, hypothesis.trace)
            for hypothesis in survivors
        ]
        return Beam(normalized)

    def best(self) -> Hypothesis:
        return max(self.hypotheses, key=lambda hypothesis: hypothesis.weight)


def _merge_equivalent(hypotheses: Iterable[Hypothesis]) -> tuple[Hypothesis, ...]:
    merged: dict[Any, Hypothesis] = {}
    for hypothesis in hypotheses:
        key = (
            _freeze(hypothesis.ledger.state),
            tuple(_receipt_key(commit.forward) for commit in hypothesis.ledger.commits),
        )
        prior = merged.get(key)
        if prior is None:
            merged[key] = hypothesis
        else:
            merged[key] = Hypothesis(
                ledger=prior.ledger,
                weight=prior.weight + hypothesis.weight,
                trace=min(prior.trace, hypothesis.trace),
            )
    total = sum(hypothesis.weight for hypothesis in merged.values())
    return tuple(
        Hypothesis(hypothesis.ledger, hypothesis.weight / total, hypothesis.trace)
        for hypothesis in merged.values()
    )


def set_value(path: Path, value: Any, *, op: str = "set") -> Receipt:
    return Receipt(op=op, writes=(Write(path, value),))


def swap(left: Path, right: Path, state: Any, *, op: str = "swap") -> Receipt:
    return Receipt(op=op, writes=(Write(left, _read(state, right)), Write(right, _read(state, left))))


def copy(source: Path, destination: Path, state: Any, *, op: str = "copy") -> Receipt:
    return Receipt(op=op, writes=(Write(destination, _read(state, source)),))
