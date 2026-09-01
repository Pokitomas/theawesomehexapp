from receipt_machine import Beam, Ledger, copy, set_value, swap


def main() -> None:
    initial = {"cells": [3, 8, 1], "queue": [], "authority": "root"}
    ledger = Ledger.start(initial)
    ledger = ledger.apply(set_value(("cells", 0), 5, op="set-a"))
    ledger = ledger.apply(copy(("cells", 0), ("cells", 2), ledger.state))
    ledger = ledger.apply(swap(("cells", 0), ("cells", 1), ledger.state))
    assert ledger.state == {"cells": [8, 5, 5], "queue": [], "authority": "root"}
    assert ledger.undo().undo().undo().state == initial

    beam = Beam.start(initial).branch(
        lambda _: (
            (set_value(("cells", 0), 9, op="hypothesis-a"), 0.5),
            (set_value(("cells", 1), 9, op="hypothesis-b"), 0.5),
        )
    )
    beam = beam.observe(lambda state: state["cells"][1] == 9)
    assert beam.best().ledger.state["cells"] == [3, 9, 1]

    print("receipt-machine: exact")


if __name__ == "__main__":
    main()
