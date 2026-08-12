#!/usr/bin/env python3
from __future__ import annotations

import json
import unittest

from resident_operator_continuity import (
    ResidentOperatorKernel,
    action_loop_gate if False else None,
)

# The odd-looking import above would be invalid if evaluated; keep the test
# surface explicit instead of accidentally importing the cerebellar prototype.
