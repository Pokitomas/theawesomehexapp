from __future__ import annotations

import random

from diversity_training_linear import Dataset, SEED
from diversity_training_visual_data import (
    AUDIENCES, DENSITIES, JOBS, MOTIONS, VISUAL_ARCHETYPES, VISUAL_LAYOUTS, VISUAL_STYLES,
)

def choose_phrase(rng: random.Random, mapping: dict[str, list[str]], label: str) -> str:
    return rng.choice(mapping[label])


def make_visual_dataset(rows: int, templates: list[str], seed: int) -> Dataset:
    rng = random.Random(seed)
    labels = {name: [] for name in ["archetype", "layout", "style", "density", "motion"]}
    texts: list[str] = []
    archetypes = list(VISUAL_ARCHETYPES)
    layouts = list(VISUAL_LAYOUTS)
    styles = list(VISUAL_STYLES)
    densities = list(DENSITIES)
    motions = list(MOTIONS)
    defaults = {
        "tracker": ("list-detail", "calm"), "dashboard": ("command-deck", "industrial"), "planner": ("timeline", "craft"),
        "editor": ("split-workbench", "editorial"), "catalog": ("card-mosaic", "editorial"), "communication": ("list-detail", "calm"),
        "learning": ("stacked-flow", "playful"), "utility": ("kiosk", "high-contrast"), "field": ("stacked-flow", "industrial"),
        "decision": ("ledger", "clinical")
    }
    for index in range(rows):
        archetype = archetypes[index % len(archetypes)] if index < len(archetypes) * 5 else rng.choice(archetypes)
        default_layout, default_style = defaults[archetype]
        layout = default_layout if rng.random() < 0.34 else rng.choice(layouts)
        style = default_style if rng.random() < 0.34 else rng.choice(styles)
        density = rng.choice(densities)
        motion = rng.choice(motions)
        values = {
            "product": choose_phrase(rng, VISUAL_ARCHETYPES, archetype),
            "audience": rng.choice(AUDIENCES),
            "job": rng.choice(JOBS),
            "layout": choose_phrase(rng, VISUAL_LAYOUTS, layout),
            "style": choose_phrase(rng, VISUAL_STYLES, style),
            "density": choose_phrase(rng, DENSITIES, density),
            "motion": choose_phrase(rng, MOTIONS, motion),
        }
        text = rng.choice(templates).format(**values)
        if layout == default_layout and rng.random() < 0.20:
            text = text.replace(f", use a {values['layout']} structure", "").replace(f"; compose it like {values['layout']}", "")
        if style == default_style and rng.random() < 0.20:
            text = text.replace(f"Make it {values['style']}, ", "").replace(f"Think {values['style']}; ", "")
        if rng.random() < 0.14:
            text += " Keep all data on this device and make the result downloadable."
        texts.append(text)
        for head, label in [("archetype", archetype), ("layout", layout), ("style", style), ("density", density), ("motion", motion)]:
            labels[head].append(label)
    return Dataset(texts, labels)
