from math import sqrt, log, pi, floor, isfinite, fabs
import random

R3 = sqrt(3.0)
LN2 = log(2.0)


def K_(N):
    a, b, c = N
    return 0.75 * (a * a + b * b + c * c - 2.0 * (a * b + b * c + c * a))


def Om_(y):
    return 1.0 - y[0] * y[0] - y[1] * y[1] - K_(y[2:5])


def q_(y, g):
    return 2.0 * (y[0] * y[0] + y[1] * y[1]) + 0.5 * (3.0 * g - 2.0) * Om_(y)


def F_(y, g):
    sp, sm, n1, n2, n3 = y
    q = q_(y, g)
    Sp = 0.5 * ((n2 - n3) ** 2 - n1 * (2.0 * n1 - n2 - n3))
    Sm = 0.5 * R3 * (n3 - n2) * (n1 - n2 - n3)
    return (-(2.0 - q) * sp - 3.0 * Sp,
            -(2.0 - q) * sm - 3.0 * Sm,
            (q - 4.0 * sp) * n1,
            (q + 2.0 * sp + 2.0 * R3 * sm) * n2,
            (q + 2.0 * sp - 2.0 * R3 * sm) * n3)


A2 = (0.2,)
A3 = (3.0 / 40.0, 9.0 / 40.0)
A4 = (44.0 / 45.0, -56.0 / 15.0, 32.0 / 9.0)
A5 = (19372.0 / 6561.0, -25360.0 / 2187.0, 64448.0 / 6561.0, -212.0 / 729.0)
A6 = (9017.0 / 3168.0, -355.0 / 33.0, 46732.0 / 5247.0, 49.0 / 176.0, -5103.0 / 18656.0)
B5 = (35.0 / 384.0, 0.0, 500.0 / 1113.0, 125.0 / 192.0, -2187.0 / 6784.0, 11.0 / 84.0, 0.0)
B4 = (5179.0 / 57600.0, 0.0, 7571.0 / 16695.0, 393.0 / 640.0,
      -92097.0 / 339200.0, 187.0 / 2100.0, 1.0 / 40.0)


def _ax(y, ks, cs, h):
    return tuple(y[i] + h * sum(c * k[i] for c, k in zip(cs, ks)) for i in range(len(y)))


def dp45(y, g, tau0, tau1, tol, hmax, cb):
    y = tuple(y)
    t = tau0
    d = 1.0 if tau1 > tau0 else -1.0
    h = d * min(hmax, fabs(tau1 - tau0) * 1e-4)
    k1 = F_(y, g)
    nst = 0
    while (tau1 - t) * d > 0.0:
        if fabs(h) > fabs(tau1 - t):
            h = tau1 - t
        k2 = F_(_ax(y, (k1,), A2, h), g)
        k3 = F_(_ax(y, (k1, k2), A3, h), g)
        k4 = F_(_ax(y, (k1, k2, k3), A4, h), g)
        k5 = F_(_ax(y, (k1, k2, k3, k4), A5, h), g)
        k6 = F_(_ax(y, (k1, k2, k3, k4, k5), A6, h), g)
        ks = (k1, k2, k3, k4, k5, k6)
        y5 = tuple(y[i] + h * sum(b * k[i] for b, k in zip(B5[:6], ks)) for i in range(5))
        k7 = F_(y5, g)
        ks7 = ks + (k7,)
        e = max(fabs(h) * fabs(sum((B5[j] - B4[j]) * ks7[j][i] for j in range(7)))
                for i in range(5))
        sc = tol * (1.0 + max(fabs(v) for v in y5))
        if e <= sc or fabs(h) < 1e-14:
            t += h
            y = y5
            k1 = k7
            nst += 1
            cb(t, y)
        f = 0.9 * (sc / e) ** 0.2 if e > 0.0 else 5.0
        h = d * min(hmax, fabs(h) * min(5.0, max(0.15, f)))
        if not all(isfinite(v) for v in y):
            break
    return y, nst


def p_(sp, sm):
    return ((1.0 - 2.0 * sp) / 3.0,
            (1.0 + sp + R3 * sm) / 3.0,
            (1.0 + sp - R3 * sm) / 3.0)


def u_(sp, sm):
    p = sorted(p_(sp, sm))
    d = p[0] + p[1]
    return -p[0] / d if fabs(d) > 1e-12 else float('inf')


def bkl_map(u):
    return u - 1.0 if u >= 2.0 else 1.0 / (u - 1.0)


def ic_(theta, Om0, n, ratio):
    N = (n, n * ratio, n * ratio * ratio)
    k = K_(N)
    r2 = 1.0 - Om0 - k
    if r2 <= 0.0:
        return None
    rr = sqrt(r2)
    from math import cos, sin
    return (rr * cos(theta), rr * sin(theta)) + N


def run_(y0, g, tau1, tol=1e-11, thr=1e-3, rec_bounces=False):
    """integrate S0 ; S := successive near-Kasner points ; rec := raw samples during transitions"""
    S, rec = [], []
    st = {'in': False, 'w': 1e300, 's': None, 'lnH': 0.0, 't': 0.0,
          'mx': 0.0, 'mo': 1e300, 'Mo': -1e300, 'bidx': -1}

    def cb(t, y):
        w = max(fabs(y[2]), fabs(y[3]), fabs(y[4]))
        st['lnH'] += -(1.0 + q_(y, g)) * (t - st['t'])
        st['t'] = t
        st['mx'] = max(st['mx'], max(fabs(v) for v in y))
        o = Om_(y)
        st['mo'] = min(st['mo'], o)
        st['Mo'] = max(st['Mo'], o)
        if w < thr:
            if not st['in'] or w < st['w']:
                st['in'] = True
                st['w'] = w
                st['s'] = (y[0], y[1])
        else:
            if st['in']:
                S.append(st['s'])
                st['in'] = False
                st['w'] = 1e300
                st['bidx'] += 1
            if rec_bounces:
                rec.append((st['bidx'], t, y[0], y[1]))
    st['t'] = 0.0
    yf, nst = dp45(y0, g, 0.0, tau1, tol, 0.05, cb)
    if st['in'] and st['s'] is not None:
        S.append(st['s'])
    return S, st, yf, nst, rec


def m_A(r):
    return r ** 3


def dm_A(r):
    return 3.0 * r * r


def m_B(r):
    return r ** 3 + 0.2 * r ** 5


def dm_B(r):
    return 3.0 * r * r + r ** 4


def m_C(r):
    return r ** 3 / (1.0 + 0.5 * r * r)


def dm_C(r):
    d = 1.0 + 0.5 * r * r
    return (3.0 * r * r + 0.5 * r ** 4) / (d * d)


def ltb_(m, dm, r, s):
    M = m(r)
    D = dm(r)
    sq = sqrt(2.0 * M)
    A = 1.5 * sq * s
    R = A ** (2.0 / 3.0)
    Rp = A ** (-1.0 / 3.0) * (sqrt(r) / (3.0 * M) * (3.0 * M - r * D) + s * D / sq)
    W = M / R ** 3 - D / (3.0 * R * R * Rp)
    Ric = D / (4.0 * pi * R * R * Rp)
    return R, Rp, W, Ric


def slope_(f, s1, s2):
    return (log(fabs(f(s2))) - log(fabs(f(s1)))) / (log(s2) - log(s1))


NB = 40


def gauss_(nseed, nit, nburn, seed, qmax=12):
    """iterate G(x)=1/x-floor(1/x) ; hist of x (h) ; partial quotient a=floor(1/x) (aq)
       u := 1/x_{k-1} is the era-starting BKL parameter ; NOTE u -> (Sigma_+,Sigma_-) is
       6-to-1 (S3 permutation of which axis is unstable), so no invariant measure on the
       (Sigma_+,Sigma_-) circle is well defined without also fixing that labelling; u itself
       has no such ambiguity, so the invariant statistics below are stated on u, not on Sigma_+."""
    rnd = random.Random(seed)
    h = [0] * NB
    aq = [0] * (qmax + 2)
    tot = 0
    lam = 0.0
    for _ in range(nseed):
        x = rnd.random()
        for k in range(nit):
            if x <= 1e-16:
                break
            v = 1.0 / x
            a = int(floor(v))
            lam_k = -2.0 * log(x)
            if k >= nburn:
                h[min(NB - 1, int(x * NB))] += 1
                aq[min(qmax + 1, a)] += 1
                tot += 1
                lam += lam_k
            x = v - a
    return h, aq, tot, lam / tot if tot else 0.0


def gk_(a):
    return log(1.0 + 1.0 / (a * (a + 2.0)), 2.0)


def surv_u(U):
    """P(u > U) for the era-starting BKL parameter, U >= 1 ;  u=1/x, x ~ Gauss measure"""
    return log(1.0 + 1.0 / U) / LN2


def bounce_(t, tB, aB, G, rc):
    """exact solution of  H^2 = (8 pi G/3) rho (1 - rho/rho_c) ,  rho = rho_c (aB/a)^3 ,  tB = 1/sqrt(6 pi G rho_c)"""
    a = aB * (1.0 + (t / tB) ** 2) ** (1.0 / 3.0)
    H = (2.0 * t / 3.0) / (t * t + tB * tB)
    rho = rc / (1.0 + (t / tB) ** 2)
    x = 6.0 * pi * G * rc * t * t
    addot_over_a = -4.0 * pi * G * rc * (x / 3.0 - 1.0) / (x + 1.0) ** 2
    Rscal = 6.0 * (H * H + addot_over_a)
    return a, H, rho, Rscal


def L(s=""):
    print(s)


def H_(n, e):
    L()
    L("=" * 72)
    L(" " + n + "   " + e)
    L("=" * 72)


def main():
    H_("S0", "x := (Sigma_+, Sigma_-, N_1, N_2, N_3) in R^5 ;  gamma in [1,2]")
    L(" K       := (3/4)[ N_1^2 + N_2^2 + N_3^2 - 2(N_1N_2 + N_2N_3 + N_3N_1) ]")
    L(" Omega   := 1 - Sigma_+^2 - Sigma_-^2 - K")
    L(" q       := 2(Sigma_+^2 + Sigma_-^2) + (1/2)(3gamma - 2) Omega")
    L(" S_+     := (1/2)[ (N_2-N_3)^2 - N_1(2N_1 - N_2 - N_3) ]")
    L(" S_-     := (sqrt3/2)(N_3-N_2)(N_1 - N_2 - N_3)")
    L()
    L(" dSigma_+/dtau = -(2-q)Sigma_+ - 3S_+")
    L(" dSigma_-/dtau = -(2-q)Sigma_- - 3S_-")
    L(" dN_1/dtau     = (q - 4Sigma_+)N_1")
    L(" dN_2/dtau     = (q + 2Sigma_+ + 2sqrt3 Sigma_-)N_2")
    L(" dN_3/dtau     = (q + 2Sigma_+ - 2sqrt3 Sigma_-)N_3")
    L(" dH/dtau       = -(1+q)H            dt/dtau = 1/H")
    L()
    L(" p_1=(1-2Sigma_+)/3  p_2=(1+Sigma_++sqrt3 Sigma_-)/3  p_3=(1+Sigma_+-sqrt3 Sigma_-)/3")
    L(" Omega=0, N=0  <=>  Sigma_+^2+Sigma_-^2=1  <=>  sum p_i = sum p_i^2 = 1")

    H_("S1", "R(s,r) = [(3/2)sqrt(2m) s]^(2/3) ;  s := tau_s(r) - tau")
    L(" R'(s,r) = [(3/2)sqrt(2m)]^(-1/3) s^(-1/3) [ (sqrt r /3m)(3m - r m') + s m'/sqrt(2m) ]")
    L()
    L(" %-26s %12s %10s %10s %12s" % ("m(r)", "3m-r*m'", "dlnR/dlns", "dlnR'/dlns", "Ric/Weyl"))
    L(" " + "-" * 74)
    for nm, m, dm in (("r^3", m_A, dm_A),
                      ("r^3 + (1/5)r^5", m_B, dm_B),
                      ("r^3/(1+r^2/2)", m_C, dm_C)):
        r = 1.0
        dg = 3.0 * m(r) - r * dm(r)
        s1, s2 = 1e-9, 1e-10
        eR = slope_(lambda s: ltb_(m, dm, r, s)[0], s1, s2)
        eP = slope_(lambda s: ltb_(m, dm, r, s)[1], s1, s2)
        _, _, W, Ric = ltb_(m, dm, r, s2)
        rt = fabs(Ric / W) if fabs(W) > 0.0 else float('inf')
        L(" %-26s %12.3e %10.4f %10.4f %12.4e" % (nm, dg, eR, eP, rt))
    L()
    L(" 3m-rm'=0  =>  dlnR'/dlns=+2/3, Weyl=0, Ric/Weyl=inf        [Oppenheimer-Snyder]")
    L(" 3m-rm'!=0 =>  dlnR'/dlns=-1/3, (p1,p2,p3)=(-1/3,2/3,2/3)   [generic]")
    L()
    L(" %-26s %10s %14s %14s" % ("m(r)", "s", "Ric/Weyl", "(Ric/Weyl)/s"))
    L(" " + "-" * 68)
    for e in (6, 8, 10, 12):
        s = 10.0 ** (-e)
        _, _, W, Ric = ltb_(m_B, dm_B, 1.0, s)
        L(" %-26s %10.1e %14.6e %14.6f" % ("r^3 + (1/5)r^5", s, fabs(Ric / W), fabs(Ric / W) / s))

    H_("S2", "sup_tau |x| < inf  &  F polynomial  =>  [tau_-,tau_+] = R")
    y0 = ic_(2.2, 1e-4, 1e-3, 0.021)
    S0, st0, yf0, nst0, _ = run_(y0, 1.0, -34.0)
    L(" x(0)   = (%.6f, %.6f, %.3e, %.3e, %.3e)   gamma=1   tau: 0 -> -34" % y0)
    L(" steps  = %d      tol = 1e-11      sup|x| = %.6f" % (nst0, st0['mx']))
    L(" Omega  in [%.3e, %.3e]" % (st0['mo'], st0['Mo']))
    L(" H(-34)/H(0) = %.6e" % (2.718281828459045 ** st0['lnH']))
    L()
    L(" P1  F in R[x]^5                                        [S0]")
    L(" P2  sup_tau |x(tau)| < inf                             [numeric, this run: %.4f]" % st0['mx'])
    L(" P3  P1 & P2 => solution extends to all tau in R        [Picard-Lindelof + a priori bound]")
    L(" P4  I_w = H^w Itilde(x),  sup_X|Itilde| < inf          [homogeneity of degree w]")
    L(" P5  P3 & P4 => sing(I_w) = sing(H^w)                   [P3,P4]")
    L(" P6  H = H_0 exp(-int_0^tau (1+q)dtau'),  q <= 2        [S0]")
    L(" ==> rho = 3H^2 Omega -> inf ,  Omega in [0,1] bounded ,  dx/dtau regular")
    L(" ==> s = int dt = int dtau/H < inf   while   tau in R")

    H_("S3", "one clean BKL run  ->  shared by S3, S7, S8, S9")
    y0 = ic_(2.2, 1e-4, 1e-3, 0.021)
    TAU1, THR = -900.0, 3e-2
    S, st, yf, nst, rec = run_(y0, 1.0, TAU1, thr=THR, rec_bounces=True)
    us = [u_(a, b) for a, b in S]
    L(" x(0) = (%.6f, %.6f, %.3e, %.3e, %.3e)   tau: 0 -> %.0f   thr=%.0e   steps=%d"
      % (y0 + (TAU1, THR, nst)))
    L()
    L(" k    Sigma_+      Sigma_-      p_1       p_2       p_3       u_k")
    L(" " + "-" * 70)
    for i, (a, b) in enumerate(S):
        p = sorted(p_(a, b))
        L(" %-4d %+.6f  %+.6f   %+.5f  %+.5f  %+.5f  %9.4f"
          % (i, a, b, p[0], p[1], p[2], us[i]))

    H_("S4", "G(x) = 1/x - floor(1/x) ;  dmu = dx/[(1+x) ln 2] ;  lambda = int ln|G'| dmu")
    h, aq, tot, lam = gauss_(120000, 26, 6, 20250828)
    L(" N = %d" % tot)
    L()
    L(" %8s %8s %14s %14s %10s" % ("x_lo", "x_hi", "emp", "1/[(1+x)ln2]", "ratio"))
    L(" " + "-" * 60)
    for i in range(0, NB, 4):
        a, b = i / NB, (i + 1) / NB
        emp = h[i] / tot * NB
        th = (log(1.0 + b) - log(1.0 + a)) / LN2 * NB
        L(" %8.4f %8.4f %14.6f %14.6f %10.6f" % (a, b, emp, th, emp / th))
    L()
    L(" lambda_emp = %.6f" % lam)
    L(" pi^2/(6 ln2) = %.6f" % (pi * pi / (6.0 * LN2)))
    L(" ratio        = %.6f" % (lam / (pi * pi / (6.0 * LN2))))

    H_("S5", "P(u>U) := lim (1/n)#{k:u_k>U} ,  u_k:=1/x_{k-1}  [era-starting Kasner parameter]")
    L(" note: u -> (Sigma_+,Sigma_-) is 6-to-1 (S3 permutes which axis is unstable) ;")
    L("       no invariant measure on the (Sigma_+,Sigma_-) circle is well-defined without")
    L("       also fixing that labelling, so this is stated on u, which has no such ambiguity.")
    L()
    L(" %8s %14s %14s %10s" % ("U", "emp", "log2(1+1/U)", "ratio"))
    L(" " + "-" * 50)
    for U in (1, 2, 4, 5, 8, 10, 20, 40):
        j = NB // U
        emp = sum(h[0:j]) / tot
        th = surv_u(float(U))
        L(" %8d %14.6f %14.6f %10.6f" % (U, emp, th, emp / th if th else float('nan')))
    L()
    L(" P(u>1) = 1 exactly : u = 1/x_{k-1} with x in (0,1)  =>  u in [1, inf) always")

    H_("S6", "P(u>U) independent of x0 ;  #bounces vs gamma")
    L(" %8s %14s %12s %12s" % ("seed", "P(u>10) emp", "lambda", "N"))
    L(" " + "-" * 50)
    j10 = NB // 10
    for sd in (11, 2027, 999331, 7777771):
        hh, _, tt, ll = gauss_(30000, 26, 6, sd)
        emp10 = sum(hh[0:j10]) / tt
        L(" %8d %14.6f %12.6f %12d" % (sd, emp10, ll, tt))
    L(" theory P(u>10) = log2(1.1) = %.6f  (same across all seeds, by construction of mu_T)" % surv_u(10.0))
    L()
    L(" %8s %10s %12s %14s %14s" % ("gamma", "#bounces", "sup|x|", "min Omega", "max Omega"))
    L(" " + "-" * 64)
    for g in (1.0, 4.0 / 3.0, 1.5, 1.8, 1.95, 2.0):
        yg = ic_(2.2, 0.35, 1e-3, 0.021)
        Sg, stg, _, _, _ = run_(yg, g, -34.0)
        L(" %8.4f %10d %12.6f %14.6e %14.6e" % (g, len(Sg), stg['mx'], stg['mo'], stg['Mo']))
    L()
    L(" gamma=2 => q=2(Sigma^2+Omega), dSigma/dtau=0 on Sigma^2+Omega=1")
    L(" Sigma^2<1/4 => q-4Sigma_+ , q+/-(2Sigma_++-2sqrt3 Sigma_-) all < 0 => N -> 0  [stiff fluid kills chaos]")

    H_("S7", "a_k := floor(1/x_{k-1})  [BKL era length]  vs  Gauss-Kuzmin  P(a) = log2(1+1/(a(a+2)))")
    L(" %4s %10s %12s %8s" % ("a", "emp", "GK(a)", "ratio"))
    L(" " + "-" * 38)
    for a in range(1, 13):
        emp = aq[a] / tot
        gk = gk_(a)
        L(" %4d %10.6f %12.6f %8.4f" % (a, emp, gk, emp / gk))
    tail_e = aq[13] / tot
    tail_t = 1.0 - sum(gk_(a) for a in range(1, 13))
    L(" %4s %10.6f %12.6f %8.4f" % (">12", tail_e, tail_t, tail_e / tail_t))
    L()
    L(" era length a_k IS the k-th partial quotient of u_0's continued fraction ; law = Gauss-Kuzmin")

    H_("S8", "bkl_map(u) := u-1 (u>=2) else 1/(u-1) ;  cross-check against raw S0 integration")
    errs = []
    for i in range(len(us) - 1):
        pr = bkl_map(us[i])
        if pr == 0.0:
            continue
        errs.append(fabs(pr - us[i + 1]) / fabs(pr))
    L(" %-4s %10s %10s %10s %12s" % ("k", "u_k", "map(u_k)", "u_{k+1}", "rel err"))
    L(" " + "-" * 52)
    for i in range(len(us) - 1):
        L(" %-4d %10.5f %10.5f %10.5f %12.3e" % (i, us[i], bkl_map(us[i]), us[i + 1], errs[i]))
    L()
    L(" n = %d   max rel err = %.3e   median = %.3e" %
      (len(errs), max(errs), sorted(errs)[len(errs) // 2]))
    L(" ODE(S0)  ==  continued-fraction map, to numerical-integration accuracy")

    H_("S9", "chord test: is Sigma(tau) a straight line between successive Kasner points?")
    L(" %-4s %6s %10s %14s %12s" % ("k", "n", "chord", "max perp dev", "rel dev"))
    L(" " + "-" * 52)
    devs = []
    for target in sorted(set(b for b, _, _, _ in rec if b >= 0)):
        pts = [(t, sp, sm) for b, t, sp, sm in rec if b == target]
        if len(pts) < 6 or target + 1 >= len(S):
            continue
        x0, ys0 = S[target]
        x1, ys1 = S[target + 1]
        Ln = sqrt((x1 - x0) ** 2 + (ys1 - ys0) ** 2)
        if Ln < 1e-6:
            continue
        maxdev = max(fabs((ys1 - ys0) * sp - (x1 - x0) * sm + x1 * ys0 - ys1 * x0) / Ln
                     for _, sp, sm in pts)
        devs.append(maxdev / Ln)
        L(" %-4d %6d %10.5f %14.3e %12.3e" % (target, len(pts), Ln, maxdev, maxdev / Ln))
    L()
    L(" max rel deviation from straight chord over all bounces = %.3e" % max(devs))
    L(" Bianchi II (one N_i != 0) is exactly integrable ; the heteroclinic Kasner-to-Kasner")
    L(" transition it produces is, to this accuracy, a straight chord of the Kasner circle")

    H_("S10", "H^2 = (8 pi G/3) rho (1 - rho/rho_c) ,  rho=rho_c(aB/a)^3 ,  a(t)=aB(1+(t/tB)^2)^(1/3)")
    G, rc, aB = 1.0, 1.0, 1.0
    tB = 1.0 / sqrt(6.0 * pi * G * rc)
    L(" tB = 1/sqrt(6 pi G rho_c) = %.6f    [G=rho_c=aB=1]" % tB)
    L()
    L(" %10s %12s %12s %12s %14s %14s" % ("t/tB", "a/aB", "rho/rho_c", "H^2", "RHS", "H^2-RHS"))
    L(" " + "-" * 78)
    for tt in (0.0, 0.1, 0.5, 1.0, 2.0, 5.0, 20.0):
        t = tt * tB
        a, Hv, rho, Rs = bounce_(t, tB, aB, G, rc)
        rhs = (8.0 / 3.0) * pi * G * rho * (1.0 - rho / rc)
        L(" %10.4f %12.6f %12.6f %12.6e %14.6e %14.3e" % (tt, a / aB, rho / rc, Hv * Hv, rhs, Hv * Hv - rhs))
    L()
    _, _, rho0, R0 = bounce_(0.0, tB, aB, G, rc)
    L(" at t=0 (bounce):  rho/rho_c = %.6f (max)   Ricci scalar R = %.6f   24 pi G rho_c = %.6f"
      % (rho0 / rc, R0, 24.0 * pi * G * rc))
    L()
    L(" classical limit rho_c -> inf :  H^2 -> (8piG/3)rho  [standard dust FRW]")
    L(" R(0) = 24 pi G rho_c -> inf  as  rho_c -> inf        [singularity recovered]")
    L(" for any FINITE rho_c the density, H, and R are bounded for all t in R : no singularity, ever")
    L(" this is a toy 1-parameter deformation of GR, not a claim about which deformation nature uses")

    H_("S11", "invariants")
    L(" %-40s %20.10f" % ("pi M / M", pi))
    L(" %-40s %20s" % ("(p_1,p_2,p_3) at u=1", "(-1/3, 2/3, 2/3)"))
    L(" %-40s %20.10f" % ("Sigma_+ at u=1  [axis-1 special]", 1.0))
    L(" %-40s %20.10f" % ("Sigma_- at u=1  [axis-1 special]", 0.0))
    L(" %-40s %20.10f" % ("lambda = pi^2/(6 ln 2)", pi * pi / (6.0 * LN2)))
    L(" %-40s %20.10f" % ("lambda / ln 2  [bits]", pi * pi / (6.0 * LN2) / LN2))
    L(" %-40s %20.10f" % ("Weyl m/R^3 * s^2", 2.0 / 9.0))
    L(" %-40s %20.10f" % ("r_0 / M  [K=0 limit]", 1.5))
    L(" %-40s %20.10f" % ("C / M^2  [K=0 limit]", 3.0 * sqrt(3.0) / 4.0))
    L(" %-40s %20.10f" % ("R_abcd R^abcd (r_0) * M^4", 1024.0 / 243.0))
    L(" %-40s %20.3e" % ("max BKL-map cross-check err (S8)", max(errs)))
    L(" %-40s %20.3e" % ("max chord deviation (S9)", max(devs)))
    L(" %-40s %20.10f" % ("R(bounce) / (pi G rho_c)  (S10)", R0 / (pi * G * rc)))
    L()


if __name__ == "__main__":
    main()
