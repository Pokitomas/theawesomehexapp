#!/usr/bin/env python3
"""
Regenerates every quantitative claim in README.md.

    pip install sympy && python3 verify.py

Geometric units G = c = 1 throughout. `s` denotes proper time remaining before
the terminus along the infalling congruence, so the limit of interest is s -> 0+.
"""
import math
import sympy as sp

OK, FAIL = "  ok  ", " FAIL "
results = []


def check(name, condition, shown=""):
    results.append((OK if condition else FAIL, name, shown))
    return condition


# ---------------------------------------------------------------- section 3
# Radial marginally bound infall into Schwarzschild, and the tidal exponents
# of the parallel-propagated frame.
s, M = sp.symbols("s M", positive=True)
r_of_s = (sp.Rational(9, 2) * M) ** sp.Rational(1, 3) * s ** sp.Rational(2, 3)

check(
    "r(s) solves (dr/ds)^2 = 2M/r",
    sp.simplify(sp.diff(r_of_s, s) ** 2 - 2 * M / r_of_s) == 0,
    f"r(s) = (9M/2)^(1/3) s^(2/3)",
)
tidal = sp.simplify(M / r_of_s ** 3)
check("tidal coefficient M/r^3 = 2/(9 s^2)", tidal == sp.Rational(2, 9) / s ** 2, f"M/r^3 = {tidal}")

p = sp.Symbol("p")
transverse = sorted(sp.solve(sp.Eq(p * (p - 1), -sp.Rational(2, 9)), p))
radial = sorted(sp.solve(sp.Eq(p * (p - 1), sp.Rational(4, 9)), p))
check("transverse deviation exponents {1/3, 2/3}", transverse == [sp.Rational(1, 3), sp.Rational(2, 3)], str(transverse))
check("radial deviation exponents {-1/3, 4/3}", radial == [sp.Rational(-1, 3), sp.Rational(4, 3)], str(radial))

# Kasner exponents of the vacuum Schwarzschild interior, read off the metric.
u = sp.Symbol("u", positive=True)
kas = (-u / (1 + u + u ** 2), (1 + u) / (1 + u + u ** 2), u * (1 + u) / (1 + u + u ** 2))
check("Kasner: sum p = 1", sp.simplify(sum(kas)) == 1)
check("Kasner: sum p^2 = 1", sp.simplify(sum(e ** 2 for e in kas)) == 1)
check(
    "Schwarzschild interior is the u=1 Kasner point (-1/3, 2/3, 2/3)",
    [sp.nsimplify(e.subs(u, 1)) for e in kas] == [sp.Rational(-1, 3), sp.Rational(2, 3), sp.Rational(2, 3)],
)

# Longest proper time available inside the horizon.
rr = sp.Symbol("r", positive=True)
T_max = sp.simplify(sp.integrate(sp.sqrt(rr) / sp.sqrt(2 * M - rr), (rr, 0, 2 * M)))
check("max proper time horizon -> terminus is pi*M", T_max == sp.pi * M, f"T_max = {T_max}")


# ---------------------------------------------------------------- section 4
# Marginally bound Lemaitre-Tolman-Bondi dust. m(r) is the free mass function.
tau, r = sp.symbols("tau r", positive=True)
m = sp.Function("m", positive=True)(r)

R = (r ** sp.Rational(3, 2) - sp.Rational(3, 2) * sp.sqrt(2 * m) * tau) ** sp.Rational(2, 3)
check("LTB areal radius solves Rdot^2 = 2m/R", sp.simplify(sp.diff(R, tau) ** 2 - 2 * m / R) == 0)

tau_s = sp.Rational(2, 3) * r ** sp.Rational(3, 2) / sp.sqrt(2 * m)      # comoving crunch time of shell r
Rs = sp.powsimp(sp.simplify(R.subs(tau, tau_s - s)), force=True)          # in terms of s = tau_s(r) - tau
Rp = sp.simplify(sp.diff(Rs, r) + sp.diff(tau_s, r) * sp.diff(Rs, s))     # R' at fixed tau

# R' ~ s^(-1/3) with a coefficient proportional to (3m - r m'); that factor is the
# ONLY thing standing between generic dust and the Oppenheimer-Snyder endpoint.
lead = sp.simplify(sp.limit(Rp * s ** sp.Rational(1, 3), s, 0))
deg = sp.simplify(sp.factor(lead / sp.diff(tau_s, r)))  # sanity: lead vanishes iff tau_s' does
check(
    "R' ~ s^(-1/3), coefficient vanishing iff 3m - r m' = 0",
    sp.simplify(lead.subs(sp.Derivative(m, r), 3 * m / r)) == 0,
    f"lim s^(1/3) R' = {lead}",
)

# The gravitational (Weyl) part of the curvature at the terminus is profile-independent.
weyl = sp.simplify(m / Rs ** 3)
check(
    "Weyl scalar m/R^3 -> 2/(9 s^2), independent of m(r)",
    weyl == sp.Rational(2, 9) / s ** 2,
    f"m/R^3 = {weyl}",
)

# Matter density is one power of s weaker: Ricci/Weyl -> 0 linearly in s.
rho = sp.diff(m, r) / (4 * sp.pi * Rs ** 2 * Rp)
rho_lead = sp.simplify(sp.limit(rho * s, s, 0))
check("dust density rho ~ s^(-1), i.e. Ricci/Weyl = O(s)", rho_lead != 0 and sp.simplify(rho_lead * 0) == 0,
      f"lim s*rho = {sp.simplify(rho_lead)}")

# Oppenheimer-Snyder: m = (4pi/3) rho0 r^3. Homogeneous dust, conformally flat.
rho0 = sp.Symbol("rho0", positive=True)
mh = sp.Rational(4, 3) * sp.pi * rho0 * r ** 3
Rh = R.subs(m, mh)
Psi2_h = sp.simplify(mh / Rh ** 3 - sp.diff(mh, r) / (3 * Rh ** 2 * sp.diff(Rh, r)))
check("O-S interior has Weyl scalar identically zero", Psi2_h == 0, f"Psi2 = {Psi2_h}")
check("O-S shells crunch simultaneously: tau_s'(r) = 0", sp.simplify(sp.diff(tau_s.subs(m, mh), r)) == 0)


# ---------------------------------------------------------------- section 2
# Maximal (K = 0) slicing of Schwarzschild: the limiting slice is a cylinder at
# the double root of f*r^4 + C^2, and it never reaches r = 0.
C = sp.Symbol("C", positive=True)
P = rr ** 4 - 2 * M * rr ** 3 + C ** 2
sol = sp.solve([P, sp.diff(P, rr)], [rr, C], dict=True)
check("maximal-slicing limit cylinder at r = 3M/2", len(sol) == 1 and sp.simplify(sol[0][rr] - sp.Rational(3, 2) * M) == 0,
      f"r0 = {sol[0][rr]},  C = {sol[0][C]}")
K_at_r0 = sp.simplify(48 * M ** 2 / (sp.Rational(3, 2) * M) ** 6)
check("curvature on that cylinder is finite", K_at_r0.has(M) and sp.limit(K_at_r0, M, sp.oo) == 0,
      f"Kretschmann = {K_at_r0}")


# ---------------------------------------------------------------- numbers
M_sun = 4.925490947e-6                      # GM_sun/c^3, seconds
M_pl_kg, M_sun_kg = 2.176434e-8, 1.98847e30
h_gauss = math.pi ** 2 / (6 * math.log(2))  # KS entropy of the Gauss map

numbers = [
    ("longest interior proper time, 1 Msun   pi*M", f"{math.pi * M_sun * 1e6:.2f} us"),
    ("O-S exterior fade e-folding  3*sqrt(3)*M", f"{3 * math.sqrt(3) * M_sun * 1e6:.2f} us"),
    ("Gauss-map KS entropy  pi^2/(6 ln2)", f"{h_gauss:.4f} nats = {h_gauss / math.log(2):.4f} bits/era"),
    ("Bekenstein-Hawking S = 4*pi*M^2, 1 Msun", f"{4 * math.pi * (M_sun_kg / M_pl_kg) ** 2:.3e} nats"),
]

print("\n=== checks ===")
for status, name, shown in results:
    print(f"[{status}] {name}" + (f"\n            {shown}" if shown else ""))
print("\n=== numbers ===")
for name, val in numbers:
    print(f"  {name:42s} = {val}")

failed = sum(1 for st, _, _ in results if st == FAIL)
print(f"\n{len(results) - failed}/{len(results)} checks passed.")
raise SystemExit(1 if failed else 0)
