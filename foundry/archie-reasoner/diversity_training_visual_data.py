VISUAL_ARCHETYPES = {
    "tracker": ["habit tracker", "inventory tracker", "progress log", "status tracker", "collection manager"],
    "dashboard": ["analytics dashboard", "operations dashboard", "metric monitor", "performance overview", "control center"],
    "planner": ["weekly planner", "project planner", "trip planner", "schedule builder", "campaign calendar"],
    "editor": ["writing editor", "content studio", "design editor", "document builder", "creative workspace"],
    "catalog": ["product catalog", "resource directory", "recipe library", "media browser", "reference collection"],
    "communication": ["team inbox", "message center", "client follow up tool", "community board", "conversation organizer"],
    "learning": ["study coach", "flashcard app", "lesson tracker", "practice trainer", "learning companion"],
    "utility": ["calculator", "converter", "formatter", "generator", "single purpose tool"],
    "field": ["field notes", "inspection app", "site capture tool", "mobile recorder", "on location log"],
    "decision": ["decision matrix", "comparison tool", "option scorer", "prioritization app", "tradeoff evaluator"],
}

VISUAL_LAYOUTS = {
    "split-workbench": ["split pane", "side by side", "workbench", "editor and preview", "dual column"],
    "card-mosaic": ["mosaic", "card grid", "tile wall", "visual gallery", "modular cards"],
    "ledger": ["ledger", "dense table", "rows and columns", "data sheet", "register"],
    "timeline": ["timeline", "chronological", "calendar rail", "milestones", "time based"],
    "command-deck": ["command deck", "control room", "status console", "operator panel", "mission control"],
    "canvas": ["canvas", "freeform board", "spatial workspace", "drag surface", "visual map"],
    "list-detail": ["list detail", "master detail", "inbox layout", "sidebar list", "select and inspect"],
    "kiosk": ["kiosk", "single action", "focused screen", "one task", "large touch controls"],
    "board": ["kanban", "board", "columns", "swimlanes", "workflow board"],
    "stacked-flow": ["stacked", "step by step", "vertical flow", "guided form", "progressive sections"],
}

VISUAL_STYLES = {
    "editorial": ["editorial", "magazine", "typographic", "publication", "serif led"],
    "industrial": ["industrial", "machined", "technical", "instrument panel", "utilitarian"],
    "playful": ["playful", "friendly", "colorful", "toy like", "bouncy"],
    "clinical": ["clinical", "medical", "precise", "sterile", "calm professional"],
    "brutalist": ["brutalist", "raw", "hard borders", "oversized type", "unpolished"],
    "neo-retro": ["retro", "1990s", "vintage computer", "pixel", "old software"],
    "calm": ["calm", "quiet", "minimal", "soft", "low distraction"],
    "craft": ["crafted", "paper", "warm", "tactile", "handmade"],
    "cinematic": ["cinematic", "dramatic", "immersive", "dark theater", "high atmosphere"],
    "high-contrast": ["high contrast", "accessible", "bold", "black and white", "visibility first"],
    "terminal": ["terminal", "monospace", "developer console", "command line", "green screen"],
    "glass": ["glass", "translucent", "layered", "frosted", "luminous"],
}

DENSITIES = {
    "compact": ["compact", "dense", "power user", "show more at once", "information rich"],
    "balanced": ["balanced", "comfortable", "normal density", "everyday", "moderate spacing"],
    "spacious": ["spacious", "large touch", "airy", "few controls", "presentation mode"],
}

MOTIONS = {
    "still": ["no animation", "still", "reduced motion", "instant", "static"],
    "subtle": ["subtle motion", "gentle transitions", "quiet animation", "small feedback", "soft movement"],
    "expressive": ["expressive motion", "animated", "kinetic", "dramatic transitions", "lively"],
}

TRAIN_TEMPLATES = [
    "Build a {product} for {audience} that helps them {job}. Make it {style}, use a {layout} structure, keep it {density}, with {motion}.",
    "I need a {style} {product}. The main job is to {job} for {audience}. Organize it as {layout}; density should be {density}; motion is {motion}.",
    "Create a local-first {product} for {audience}: {job}. Visually it should feel {style} and structurally {layout}, with {density} information and {motion}.",
    "Make {audience} a {product} to {job}. Prefer {layout}. Give it a {style} visual language, {density} spacing, and {motion}.",
    "Product brief: {product}; user: {audience}; outcome: {job}; visual: {style}; composition: {layout}; density: {density}; motion: {motion}.",
    "Design a {product} where {audience} can {job}. It should be {style}, laid out as {layout}, {density}, and {motion}.",
]

HELDOUT_TEMPLATES = [
    "For {audience}, ship something that lets them {job}. It is essentially a {product}. Think {style}; compose it like {layout}; make the surface {density}; animation should be {motion}.",
    "The finished product is a {product} used by {audience} to {job}. Its character is {style}, its information architecture is {layout}, its rhythm is {density}, and its movement is {motion}.",
    "Turn this need into software: {audience} must {job}. Use the interaction model of a {product}, the visual voice of {style}, the structure of {layout}, {density} spacing, and {motion}.",
]

AUDIENCES = ["one person on a phone", "a neighborhood group", "a small creative team", "a shop manager", "students", "a field technician", "a volunteer crew", "a freelance operator", "a family", "a community organizer"]
JOBS = ["capture useful details quickly", "see what changed today", "compare options without losing context", "turn a messy request into a clear next move", "organize work offline", "review progress at a glance", "collect evidence and export it", "keep recurring tasks from disappearing", "make a decision with visible criteria", "move from draft to finished output"]
