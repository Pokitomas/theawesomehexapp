#!/usr/bin/env python3
"""Reference model of the ARCHIE event-semidirect state law.

This is a dependency-light re-implementation of the transition algebra recorded
in ARCHIE_COMPLETE_EVERYTHING_AUDIT.txt.  It exists so that Court IV can execute
falsifiers against the shipped law without a GPU, a checkpoint, or PyTorch.

It models the transition algebra only.  It is not the trainer, it is not the
Triton kernel, and running it proves nothing about the checkpoint's quality.

The state of one fiber is s = (s0, s1, s2).  One token event applies

    F(s) = q N(x, y, z) s + w,        N(x, y, z) = [[1, x, z],
                                                   [0, 1, y],
                                                   [0, 0, 1]]

so the transition group is the semidirect product R_{>0} x H_3 acting affinely,
where H_3 is the 3x3 upper unitriangular (Heisenberg) group.
"""

from __future__ import annotations

import math
from typing import Callable, Iterable, List, NamedTuple, Sequence

# Shipped hyperparameters, from the launch-time audit.
TRANSPORT_SCALE = 0.2
WRITE_SCALE = 1.0
RETENTION_RATE_MIN = 0.002
RETENTION_RATE_MAX = 0.2
RETENTION_BIAS = 4.0
FIBERS = 1536
COORDS_PER_FIBER = 3
EVENT_VALUES_PER_FIBER = 7


class Event(NamedTuple):
    """One composed affine map q N(x, y, z) . + w."""

    q: float
    x: float
    y: float
    z: float
    w0: float
    w1: float
    w2: float


IDENTITY = Event(1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)


def compose(later: Event, earlier: Event) -> Event:
    """Return `later` after `earlier`, i.e. the map s -> later(earlier(s)).

    q21 = q2 q1
    x21 = x2 + x1
    y21 = y2 + y1
    z21 = z2 + z1 + x2 y1          <- the noncommutative term
    w21 = q2 N(x2, y2, z2) w1 + w2
    """
    a, b = later, earlier
    n0 = b.w0 + a.x * b.w1 + a.z * b.w2
    n1 = b.w1 + a.y * b.w2
    n2 = b.w2
    return Event(
        a.q * b.q,
        a.x + b.x,
        a.y + b.y,
        a.z + b.z + a.x * b.y,
        a.q * n0 + a.w0,
        a.q * n1 + a.w1,
        a.q * n2 + a.w2,
    )


def apply_event(event: Event, state: Sequence[float]) -> List[float]:
    """Apply one composed event to a fiber state."""
    s0, s1, s2 = state
    return [
        event.q * (s0 + event.x * s1 + event.z * s2) + event.w0,
        event.q * (s1 + event.y * s2) + event.w1,
        event.q * s2 + event.w2,
    ]


def operator_norm_inf(event: Event) -> float:
    """Exact infinity-norm of the linear part q N(x, y, z)."""
    return event.q * max(1.0 + abs(event.x) + abs(event.z), 1.0 + abs(event.y), 1.0)


# --------------------------------------------------------------------------
# Retention normalizers.  Each maps (ceiling, gate_logit, x, y, z) -> q.
# --------------------------------------------------------------------------


def normalizer_shipped(ceiling: float, gate: float, x: float, y: float, z: float) -> float:
    """The shipped law: q = c sigma(a) / (1 + |x| + |y| + |z|)."""
    return ceiling * _sigmoid(gate) / (1.0 + abs(x) + abs(y) + abs(z))


def normalizer_exact_inf(ceiling: float, gate: float, x: float, y: float, z: float) -> float:
    """Tightest per-step infinity-norm contraction: divide by the true ||N||."""
    return ceiling * _sigmoid(gate) / max(1.0 + abs(x) + abs(z), 1.0 + abs(y))


def normalizer_decoupled(ceiling: float, gate: float, x: float, y: float, z: float) -> float:
    """No transport penalty at all: q = c sigma(a).

    Per-step infinity-norm contraction is given up.  Prefix products stay
    bounded anyway because the Heisenberg part grows polynomially while the
    scalar part decays geometrically -- but the worst-case constant is large.
    """
    return ceiling * _sigmoid(gate)


def retention_rate_ceilings(fibers: int = FIBERS) -> List[float]:
    """c_i = exp(-linspace(RETENTION_RATE_MIN, RETENTION_RATE_MAX)_i)."""
    if fibers == 1:
        return [math.exp(-RETENTION_RATE_MIN)]
    span = RETENTION_RATE_MAX - RETENTION_RATE_MIN
    return [
        math.exp(-(RETENTION_RATE_MIN + span * i / (fibers - 1)))
        for i in range(fibers)
    ]


def decay_rates(fibers: int = FIBERS) -> List[float]:
    """lambda_i, the per-fiber log-decay ceiling."""
    if fibers == 1:
        return [RETENTION_RATE_MIN]
    span = RETENTION_RATE_MAX - RETENTION_RATE_MIN
    return [RETENTION_RATE_MIN + span * i / (fibers - 1) for i in range(fibers)]


def scale_free_transport(lam: float, kappa: float = 1.0) -> float:
    """Court IV's proposed per-fiber transport cap: tau_i = min(0.2, kappa lambda_i).

    Accumulated transport over a fiber's own memory horizon 1/lambda_i is then
    kappa, independent of the fiber.  See ARCHIE_COURT_IV.md section 5.
    """
    return min(TRANSPORT_SCALE, kappa * lam)


def event_from_coefficients(
    raw: Sequence[float],
    ceiling: float,
    normalizer: Callable[[float, float, float, float, float], float] = normalizer_shipped,
    transport_scale: float = TRANSPORT_SCALE,
    write_scale: float = WRITE_SCALE,
) -> Event:
    """Build one event from the 7 raw coefficient-head outputs for one fiber.

    Channel order, from the audit:
        0 raw retention, 1 x transport, 2 y transport, 3 z transport,
        4..6 write coordinates.
    """
    x = transport_scale * math.tanh(raw[1])
    y = transport_scale * math.tanh(raw[2])
    z = transport_scale * math.tanh(raw[3])
    q = normalizer(ceiling, raw[0], x, y, z)
    return Event(
        q,
        x,
        y,
        z,
        write_scale * math.tanh(raw[4]),
        write_scale * math.tanh(raw[5]),
        write_scale * math.tanh(raw[6]),
    )


# --------------------------------------------------------------------------
# Scans.  Three parenthesizations of the same associative reduction.
# --------------------------------------------------------------------------


def prefix_serial(events: Sequence[Event]) -> List[Event]:
    """Left-to-right serial recurrence: ((e3 . e2) . e1)."""
    out: List[Event] = []
    running = IDENTITY
    for event in events:
        running = compose(event, running)
        out.append(running)
    return out


def prefix_hillis_steele(events: Sequence[Event]) -> List[Event]:
    """Inclusive Hillis-Steele scan, the reference parallel implementation."""
    current = list(events)
    offset = 1
    while offset < len(current):
        nxt = list(current)
        for i in range(offset, len(current)):
            nxt[i] = compose(current[i], current[i - offset])
        current = nxt
        offset *= 2
    return current


def _reduce_tree(events: Sequence[Event]) -> Event:
    if not events:
        return IDENTITY
    if len(events) == 1:
        return events[0]
    mid = len(events) // 2
    return compose(_reduce_tree(events[mid:]), _reduce_tree(events[:mid]))


def prefix_binary_tree(events: Sequence[Event]) -> List[Event]:
    """Balanced-tree parenthesization of every prefix.

    Deliberately the most expensive scan.  It exists only to give a third,
    structurally different bracketing for the associativity check.
    """
    return [_reduce_tree(events[: i + 1]) for i in range(len(events))]


def run_state_serial(events: Sequence[Event], initial: Sequence[float]) -> List[List[float]]:
    """Ground-truth state trajectory, one event at a time."""
    state = list(initial)
    trajectory = []
    for event in events:
        state = apply_event(event, state)
        trajectory.append(list(state))
    return trajectory


# --------------------------------------------------------------------------
# Diagnostics
# --------------------------------------------------------------------------


def effective_horizon(q: float) -> float:
    """Tokens until a fiber's retained signal falls by 1/e.  inf if q >= 1."""
    if q >= 1.0:
        return float("inf")
    if q <= 0.0:
        return 0.0
    return 1.0 / (-math.log(q))


def half_life(q: float) -> float:
    if q >= 1.0:
        return float("inf")
    if q <= 0.0:
        return 0.0
    return math.log(2.0) / (-math.log(q))


def saturated_prefix_norm(
    ceiling_q: float, transport: float, steps: int
) -> float:
    """Infinity-norm of a k-step product with every transport pinned and aligned.

    This is the analytic worst case: x = y = z = +transport at every step, so
    X = Y = k*transport and Z = k*transport + transport^2 k(k-1)/2.
    """
    big_x = steps * transport
    big_y = steps * transport
    big_z = steps * transport + transport * transport * steps * (steps - 1) / 2.0
    linear = ceiling_q**steps
    return linear * max(1.0 + big_x + big_z, 1.0 + big_y)


def _sigmoid(value: float) -> float:
    if value >= 0.0:
        return 1.0 / (1.0 + math.exp(-value))
    scaled = math.exp(value)
    return scaled / (1.0 + scaled)


def max_abs_difference(left: Iterable[float], right: Iterable[float]) -> float:
    return max((abs(a - b) for a, b in zip(left, right)), default=0.0)


def event_difference(left: Event, right: Event) -> float:
    return max_abs_difference(left, right)
