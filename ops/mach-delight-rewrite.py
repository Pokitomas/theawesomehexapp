from __future__ import annotations
import hashlib, os, sys
from pathlib import Path

EXPECTED = {
    'shell/desktop.mach': 'f3cb4f78bee3b5260a6d9a9e8a818fba0dafde3bf7462467aa566fb205f192e1',
    'shell/desktop-apps.mach': '2b33325a44c4f641ebf0fc8fef4c8013935d58e65a77fedc92939d0c6162bf3e',
    'shell/enchiridion.mach': 'e7ab9326a3f65f0bf0b453e5e281bd669de5068959d0a94bd306aac04c644b1e',
}

def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def replace_once(s: str, old: str, new: str, label: str) -> str:
    n = s.count(old)
    if n != 1:
        raise RuntimeError(f'{label}: expected exactly one match, got {n}')
    return s.replace(old, new, 1)

def atomic_text(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + '.mach-rewrite.tmp')
    tmp.write_text(text, encoding='utf-8', newline='\n')
    os.replace(tmp, path)

def patch(root: Path) -> None:
    for rel, expected in EXPECTED.items():
        p = root / rel
        got = sha(p)
        if got != expected:
            raise RuntimeError(f'{rel}: observed version changed; expected {expected}, got {got}')

    desktop_path = root / 'shell/desktop.mach'
    s = desktop_path.read_text(encoding='utf-8')

    s = replace_once(s,
'''(state gui/menu false)\n(state gui/hover "")''',
'''(state gui/menu false) ; legacy persisted name: no longer owns a menu\n(state gui/lens false)\n(state gui/query "")\n(state gui/lens-choice 0)\n(state gui/halo-state nil)\n(state gui/snap "")\n(state gui/traces (list))\n(state gui/hover "")''', 'desktop states')

    s = replace_once(s,
'''(rule gui/change! (fn (id changes) (do\n  (put "gui/windows" (each (fn (w) (if (= (get w "id") id)\n    (m/fold1 (fn (d p) (assoc d (nth p 0) (nth p 1))) w (pairs changes)) w)) gui/windows))\n  (gui/persist!))))''',
'''(rule gui/change-now! (fn (id changes) (do\n  ; Pointer-rate geometry is field state, not disk state. Commit once at the\n  ; boundary of the gesture; this keeps a 120 Hz hand from becoming 120 stores.\n  (put "gui/windows" (each (fn (w) (if (= (get w "id") id)\n    (m/fold1 (fn (d p) (assoc d (nth p 0) (nth p 1))) w (pairs changes)) w)) gui/windows)))))\n(rule gui/change! (fn (id changes) (do (gui/change-now! id changes) (gui/persist!))))\n\n; Short-lived consequences, not a log. They are ordinary values whose visual\n; presence is derived from age; there is no timer callback and nothing to clear.\n(rule gui/emit! (fn (kind x y) (do\n  (put "gui/traces" (take 12 (cons (map "kind" kind "x" x "y" y "at" (tick 0.04)) gui/traces))) true)))\n(rule gui/live-traces (do\n  (def t (tick 0.04))\n  (keep (fn (p) (< (- t (get p "at" t)) 0.72)) gui/traces)))\n(rule gui/trace-paint (fn (p) (do\n  (def age (- (tick 0.04) (get p "at")))\n  (def life (clamp (- 1 (/ age 0.72)) 0 1))\n  (def radius (+ 5 (* (- 1 life) 34)))\n  (def colour (if (= (get p "kind") "snap") (rgb 180 226 238)\n    (if (= (get p "kind") "birth") (rgb 202 227 176)\n      (if (= (get p "kind") "sink") (rgb 225 166 179) (rgb 218 235 246)))))\n  (disc (get p "x") (get p "y") radius colour (* 0.48 life) (+ 0.8 (* 1.8 life))))))\n(rule gui/traces-view (if (ench/is "trace")\n  (leaf (scene (each gui/trace-paint gui/live-traces)) (list))\n  (leaf (scene) (list))))''', 'change now + traces')

    s = replace_once(s,
'''  (ench/sink! (gui/box (gui/find id)))\n  (put "gui/windows"''',
'''  (def gone (gui/box (gui/find id)))\n  (ench/sink! gone)\n  (gui/emit! "sink" (+ (nth gone 0) (/ (nth gone 2) 2)) (+ (nth gone 1) (/ (nth gone 3) 2)))\n  (put "gui/windows"''', 'remove trace')

    s = replace_once(s,
'''(rule gui/maximize! (fn (id) (gui/change! id (map "max" (not (get (gui/find id) "max" false))))))''',
'''(rule gui/maximize! (fn (id) (gui/change! id (map "max" (not (get (gui/find id) "max" false))))))\n(rule gui/snap-kind (fn (x y)\n  (if (< y 18) "fill" (if (< x 26) "left" (if (> x (- screen/w 26)) "right" "")))))\n(rule gui/snap-box (fn (kind) (do\n  (def half (floor (/ (- screen/w 24) 2)))\n  (def height (max 200 (- screen/h 74)))\n  (if (= kind "left") (list 8 8 half height)\n    (if (= kind "right") (list (+ 16 half) 8 half height)\n      (list 8 8 (max 280 (- screen/w 16)) height))))))\n(rule gui/snap! (fn (id kind) (if (= kind "") false (do\n  (if (= kind "fill") (gui/change! id (map "max" true))\n    (gui/change! id (map "max" false "box" (gui/snap-box kind))))\n  (def b (gui/box (gui/find id)))\n  (gui/emit! "snap" (+ (nth b 0) (/ (nth b 2) 2)) (+ (nth b 1) 18)) true))))''', 'snap rules')

    s = replace_once(s,
'''    (gui/front! id)\n    ((get spec "start" (fn (id) false)) id)''',
'''    (gui/front! id)\n    (gui/emit! "birth" (+ (nth at 0) (/ bw 2)) (+ (nth at 1) 24))\n    ((get spec "start" (fn (id) false)) id)''', 'open trace')

    s = replace_once(s,
'''(rule gui/leave! (fn () (do (put "gui/enabled" false) (put "gui/menu" false)\n  (put "mode" "space") (put "work/page" "terminal") (gui/persist!))))''',
'''(rule gui/leave! (fn () (do (put "gui/enabled" false) (put "gui/menu" false)\n  (put "gui/lens" false) (put "gui/halo-state" nil)\n  (put "mode" "space") (put "work/page" "terminal") (gui/persist!))))''', 'leave transient close')

    start = s.index('(rule gui/taskbar ')
    end = s.index('(rule gui/dialog ', start)
    replacement = r'''(rule gui/shelf-item (fn (id label x y w action selected) (leaf
  (scene (rrect x y w 34 17
    (if selected (mix gui/accent (rgb 238 246 250) 0.16)
      (if (= gui/hover id) (rgb 57 68 82) (rgb 38 47 59))) 1)
    (text (+ x 12) (+ y 8) (fit label (- w 24) 12 500)
      (if selected (rgb 250 252 254) (rgb 205 216 228)) 12 1 500))
  (list (gui/target id label (list x y w 34) action)))))

; The shelf is an edge condition, not a taskbar. It floats above the medium and
; only represents things that are actually open plus one entrance into the lens.
(rule gui/taskbar (do
  (def y (- screen/h (+ 14 ench/tide)))
  (def x 14) (def w (- screen/w 28))
  (def n (len gui/windows))
  (def slot (min 126 (max 46 (/ (max 120 (- w 190)) (max 1 n)))))
  (compose (list
    (leaf (scene
      (rrect x y w 48 22 (rgb 20 27 36) 0.94)
      (line (+ x 18) y (- (+ x w) 18) y (rgb 217 235 246) 0.18 1)
      (text (- (+ x w) 93) (+ y 9) (time/format (tick 60) "%I:%M") (rgb 198 214 226) 11 1 500)) (list))
    (gui/shelf-item "desktop/lens" "find" (+ x 7) (+ y 7) 58 gui/lens-open! gui/lens)
    (compose (each (fn (i) (do
      (def win (nth gui/windows i)) (def id (get win "id"))
      (def label (get (gui/state id) "title" (get (rawof (get win "app")) "name")))
      (gui/shelf-item (cat "task/" id) label (+ x 73 (* i slot)) (+ y 7) (- slot 5)
        (fn () (if (and (= gui/focus id) (not (get win "min" false))) (gui/minimize! id) (gui/front! id)))
        (and (= gui/focus id) (not (get win "min" false))))))
      (range n)))))))

(rule gui/lens-open! (fn () (do
  (put "gui/lens" true) (put "gui/menu" false) (put "gui/halo-state" nil)
  (put "gui/query" "") (put "gui/lens-choice" 0) true)))
(rule gui/lens-close! (fn () (do (put "gui/lens" false) (put "gui/query" "") true)))
(rule gui/lens-items (do
  (def q (lower gui/query))
  (take 7 (keep (fn (app) (do
    (def spec (rawof app))
    (or (= q "") (>= (find (lower (get spec "name" "")) q) 0)))) gui/apps))))
(rule gui/lens-choose! (fn (delta) (do
  (def n (len gui/lens-items))
  (put "gui/lens-choice" (if (= n 0) 0 (clamp (+ gui/lens-choice delta) 0 (- n 1)))) true)))
(rule gui/lens-run! (fn () (if (= (len gui/lens-items) 0) false (do
  (def app (nth gui/lens-items (clamp gui/lens-choice 0 (- (len gui/lens-items) 1))))
  (gui/lens-close!) (gui/open! app ".") true))))
(rule gui/lens-row (fn (app i x y w) (do
  (def spec (rawof app)) (def id (cat "lens/" app))
  (leaf (scene
    (rrect x y w 42 10
      (if (= i gui/lens-choice) (rgb 56 77 94)
        (if (= gui/hover id) (rgb 43 54 68) (rgb 31 39 50))) 1)
    (gui/icon (get spec "icon") (+ x 10) (+ y 8) 26 (get spec "colour" gui/accent))
    (text (+ x 48) (+ y 10) (get spec "name") (rgb 235 241 247) 13 1 500))
    (list (gui/target id (get spec "name") (list x y w 42)
      (fn () (do (gui/lens-close!) (gui/open! app ".")))))))))
(rule gui/launcher (if gui/lens (do
  (def w (min 620 (- screen/w 36))) (def x (/ (- screen/w w) 2)) (def y 54)
  (def items gui/lens-items) (def h (+ 84 (* 46 (max 1 (len items)))))
  (compose (list
    (leaf (scene
      (rrect (- x 5) (- y 5) (+ w 10) (+ h 10) 20 (rgb 0 0 0) 0.16)
      (rrect x y w h 16 (rgb 21 28 38) 0.97)
      (text (+ x 22) (+ y 16) (if (= gui/query "") "type to reshape what is here" gui/query)
        (if (= gui/query "") (rgb 124 143 160) (rgb 241 246 250)) 17 1 500)
      (line (+ x 20) (+ y 52) (- (+ x w) 20) (+ y 52) (rgb 170 205 224) 0.22 1))
      (list (gui/target "lens/body" "Lens" (list x y w h) (fn () false))))
    (compose (each (fn (i) (gui/lens-row (nth items i) i (+ x 12) (+ y 64 (* i 46)) (- w 24)))
      (range (len items)))))))
  (leaf (scene) (list))))

(rule gui/halo-item (fn (id label x y action) (leaf
  (scene (rrect x y 88 32 16
      (if (= gui/hover id) (rgb 76 96 108) (rgb 31 41 51)) 0.96)
    (text (+ x 12) (+ y 7) label (rgb 235 242 246) 11 1 500))
  (list (gui/target id label (list x y 88 32) action)))))
(rule gui/halo-open! (fn (x y win) (if (ench/is "halo") (do
  (put "gui/lens" false) (put "gui/halo-state" (map "x" x "y" y "window" win))
  (gui/emit! "touch" x y) true) false)))
(rule gui/halo-view (if gui/halo-state (do
  (def hx (clamp (get gui/halo-state "x") 108 (- screen/w 108)))
  (def hy (clamp (get gui/halo-state "y") 92 (- screen/h 92)))
  (def win (get gui/halo-state "window" "")) (def has (> (len win) 0))
  (compose (list
    (leaf (scene
      (disc hx hy 28 (rgb 205 231 241) 0.10 7)
      (disc hx hy 8 (rgb 225 242 248) 0.66 1.4)
      (line hx (- hy 42) hx (+ hy 42) (rgb 201 225 235) 0.16 1)
      (line (- hx 52) hy (+ hx 52) hy (rgb 201 225 235) 0.16 1)) (list))
    (gui/halo-item "halo/up" (if has "fill" "files") (- hx 44) (- hy 64)
      (fn () (do (put "gui/halo-state" nil) (if has (gui/maximize! win) (gui/open! "app/files" ".")))))
    (gui/halo-item "halo/right" (if has "front" "world") (+ hx 38) (- hy 16)
      (fn () (do (put "gui/halo-state" nil) (if has (gui/front! win) (gui/open! "app/world" ".")))))
    (gui/halo-item "halo/down" (if has "sink" "surface") (- hx 44) (+ hy 32)
      (fn () (do (put "gui/halo-state" nil) (if has (gui/close! win) (gui/open! "app/enchiridion" ".")))))
    (gui/halo-item "halo/left" (if has "hide" "terminal") (- hx 126) (- hy 16)
      (fn () (do (put "gui/halo-state" nil) (if has (gui/minimize! win) (gui/open! "app/terminal" "."))))))) )
  (leaf (scene) (list))))

(rule gui/snap-view (if (and (ench/is "snap") (not (= gui/snap ""))) (do
  (def b (gui/snap-box gui/snap))
  (leaf (scene
    (rrect (nth b 0) (nth b 1) (nth b 2) (nth b 3) 14 (rgb 198 228 238) 0.12)
    (rrect (+ (nth b 0) 5) (+ (nth b 1) 5) (- (nth b 2) 10) (- (nth b 3) 10) 11
      (rgb 213 239 246) 0.06)) (list)))
  (leaf (scene) (list))))
'''
    s = s[:start] + replacement + s[end:]

    s = replace_once(s,
'''(rule gui/root (compose (list gui/desktop gui/desktop-icons\n  (compose (each gui/window (keep (fn (win) (not (get win "min" false))) gui/windows)))\n  gui/taskbar gui/launcher gui/dialog)))''',
'''(rule gui/root (compose (list gui/desktop gui/desktop-icons\n  (compose (each gui/window (keep (fn (win) (not (get win "min" false))) gui/windows)))\n  gui/snap-view gui/traces-view gui/taskbar gui/halo-view gui/launcher gui/dialog)))''', 'root layers')

    pstart = s.index('(rule gui/pointer! ')
    pend = s.index('\n\n; The shell vocabulary', pstart)
    pointer = r'''(rule gui/pointer! (fn (event) (do
  (def phase (get event "phase")) (def x (get event "x")) (def y (get event "y"))
  (def target (gui/hit x y)) (def id (get target "id" "")) (def button (get event "button" 0))
  (put "gui/hover" id)
  (if (= phase "down") (do
    (put "gui/born-at" (list x y)) (ench/touch! x y true) (gui/emit! "touch" x y))
    (if (= phase "up") (ench/touch! x y false) 0))
  (if (= phase "down")
    (if (= button 3)
      (do (def context-win (get target "window" "")) (gui/halo-open! x y context-win))
      (do
        (if (not (= (cut id 0 5) "halo/")) (put "gui/halo-state" nil) false)
        (def win (get target "window" ""))
        (if (> (len win) 0) (gui/front! win) false)
        (put "gui/pressed" id)
        (if (if (get target "drag" false)
              (if (= (get target "drag") "resize") (ench/is "corner") true) false) (do
          (def old gui/last-click)
          (if (and (and (= (get old "id" "") id) (ench/is "double-lift"))
                   (< (- (get event "at") (get old "at" 0)) 380000000))
            (do (gui/maximize! win) (put "gui/drag" nil))
            (put "gui/drag" (map "window" win "kind" (get target "drag") "x" x "y" y "box" (gui/box (gui/find win)))))
          (put "gui/last-click" (map "id" id "at" (get event "at"))))
          ((get target "press" (fn (event) false)) event)))) )
    (if (= phase "move")
      (if gui/drag (do
        (if (ench/is "wake") (ripple x y 2 0.55) 0)
        (put "gui/fling" (list x y (get event "at") 0))
        (def b (get gui/drag "box")) (def dx (- x (get gui/drag "x"))) (def dy (- y (get gui/drag "y")))
        (def moving (= (get gui/drag "kind") "move"))
        (put "gui/snap" (if (and moving (ench/is "snap")) (gui/snap-kind x y) ""))
        (gui/change-now! (get gui/drag "window") (map "max" false "box"
          (if moving
            (list (+ (nth b 0) dx) (+ (nth b 1) dy) (nth b 2) (nth b 3))
            (list (nth b 0) (nth b 1) (max 280 (+ (nth b 2) dx)) (max 200 (+ (nth b 3) dy))))))) false)
      (if (= phase "up") (do
        (def drag gui/drag) (def snap gui/snap)
        (if drag
          (if (and (= (get drag "kind") "move") (not (= snap "")))
            (gui/snap! (get drag "window") snap)
            (do (gui/persist!) (ench/throw! (get drag "window") x y)))
          (if (= gui/pressed id) ((get target "action" (fn () false))) false))
        (put "gui/pressed" "") (put "gui/drag" nil) (put "gui/snap" "")) false)) true)))'''
    s = s[:pstart] + pointer + s[pend:]
    atomic_text(desktop_path, s)

    apps_path = root / 'shell/desktop-apps.mach'
    a = apps_path.read_text(encoding='utf-8')
    old_settings = '''(rule settings/view (fn (id w h) (compose (list\n  (leaf (scene (rect 0 0 w h gui/paper 1) (text 22 22 "Appearance" gui/ink 19 1 600)\n    (text 22 59 "Desktop colour" gui/muted 13)\n    (text 22 147 "Window controls" gui/ink 14 1 500)\n    (text 22 179 "Drag a title bar to move. Double-click it to maximise." gui/muted 12)\n    (text 22 204 "Drag the lower-right corner to resize." gui/muted 12)\n    (text 22 229 "Open programs stay in the taskbar when minimised." gui/muted 12)\n    (text 22 278 "Your windows and unsaved documents reopen next time." gui/muted 12)) (list))\n  (gui/button (cat id "/blue") "Blue" 22 89 118 34 (fn () (do (put "gui/theme" "blue") (gui/persist!))) (= gui/theme "blue"))\n  (gui/button (cat id "/plum") "Plum" 149 89 118 34 (fn () (do (put "gui/theme" "plum") (gui/persist!))) (= gui/theme "plum"))))))'''
    new_settings = '''(rule settings/view (fn (id w h) (compose (list\n  (leaf (scene (rect 0 0 w h gui/paper 1)\n    (text 22 22 "Surface" gui/ink 19 1 600)\n    (text 22 60 "Appearance is a consequence of behaviour." gui/muted 13)\n    (text 22 91 "Water, wake, throw, edge composition, traces and sound are" gui/muted 12)\n    (text 22 113 "live laws in the Enchiridion, not a collection of themes." gui/muted 12)\n    (text 22 176 "Ctrl+K opens the lens. Right-click grows actions where you are." gui/ink 12 1 500)\n    (text 22 201 "Drag into an edge to compose space. Release commits once." gui/muted 12)\n    (text 22 254 "The machine remembers documents and windows; gestures evaporate." gui/muted 12)) (list))\n  (gui/button (cat id "/laws") "Open surface laws" 22 137 180 34\n    (fn () (gui/open! "app/enchiridion" ".")) true)))))'''
    a = replace_once(a, old_settings, new_settings, 'settings surface')
    a = a.replace('(rule app/settings (map "name" "Settings"', '(rule app/settings (map "name" "Surface"', 1)

    old_key = '''(rule input/key (fn (e) (if gui/enabled (do\n  (def key (get e "key")) (def win (gui/find gui/focus))\n  (if (not (= gui/confirm "")) (if (= key "Escape") (put "gui/confirm" "") false)\n    (if (and (get e "alt" false) (= key "F4")) (if win (gui/close! gui/focus) false)\n      (if (= key "Escape") (put "gui/menu" false)\n        (if win ((get (rawof (get win "app")) "key" (fn (id e) false)) gui/focus e) false)))) true) false)))'''
    new_key = '''(rule gui/lens-key! (fn (e) (do\n  (def key (get e "key")) (def text (get e "text" ""))\n  (if (= key "Escape") (gui/lens-close!)\n    (if (= key "BackSpace") (do\n      (put "gui/query" (cut gui/query 0 (max 0 (- (len gui/query) 1))))\n      (put "gui/lens-choice" 0))\n      (if (= key "Up") (gui/lens-choose! -1)\n        (if (= key "Down") (gui/lens-choose! 1)\n          (if (= key "Return") (gui/lens-run!)\n            (if (and (> (len text) 0) (not (get e "ctrl" false)))\n              (do (put "gui/query" (cat gui/query text)) (put "gui/lens-choice" 0)) false))))))\n  true)))\n(rule input/key (fn (e) (if gui/enabled (do\n  (def key (get e "key")) (def win (gui/find gui/focus))\n  (if (not (= gui/confirm ""))\n    (if (= key "Escape") (put "gui/confirm" "") false)\n    (if gui/lens (gui/lens-key! e)\n      (if (and (get e "ctrl" false) (= (lower key) "k")) (gui/lens-open!)\n        (if (and (get e "alt" false) (= key "F4")) (if win (gui/close! gui/focus) false)\n          (if (= key "Escape") (do (put "gui/menu" false) (put "gui/halo-state" nil))\n            (if win ((get (rawof (get win "app")) "key" (fn (id e) false)) gui/focus e) false))))))\n  true) false)))'''
    a = replace_once(a, old_key, new_key, 'global lens key')
    atomic_text(apps_path, a)

    ench_path = root / 'shell/enchiridion.mach'
    e = ench_path.read_text(encoding='utf-8')
    old_tail = '''  (map "n" 15 "id" "sound"        "kind" "medium"\n       "name" "Audible surface"\n       "says" "The field's energy is a tone. You can hear the machine settle."\n       "default" false)))'''
    new_tail = '''  (map "n" 15 "id" "sound"        "kind" "medium"\n       "name" "Audible surface"\n       "says" "The field's energy is a tone. You can hear the machine settle."\n       "default" false)\n  (map "n" 16 "id" "halo"         "kind" "input"\n       "name" "Halo"\n       "says" "Right-click grows the few actions that make sense exactly where you are."\n       "default" true)\n  (map "n" 17 "id" "snap"         "kind" "motion"\n       "name" "Edge composition"\n       "says" "An edge is a spatial verb: release into it and windows compose themselves."\n       "default" true)\n  (map "n" 18 "id" "trace"        "kind" "time"\n       "name" "Afterimage"\n       "says" "Gestures leave short-lived consequences that decay instead of becoming logs."\n       "default" true)))'''
    e = replace_once(e, old_tail, new_tail, 'ench entries')
    e = e.replace('(gui/change! (get w "id") (map "box"', '(gui/change-now! (get w "id") (map "box"', 1)
    atomic_text(ench_path, e)

    print('MACH_DELIGHT_PATCH_OK')
    for rel in EXPECTED:
        print(rel, sha(root / rel))

if __name__ == '__main__':
    root = Path(sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\AwesomeKai\mach')
    patch(root)
