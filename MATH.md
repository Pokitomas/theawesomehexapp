# Automatic saturation policy

The feed never asks the user to choose a path. “Base” and “lateral” are latent candidate families inside one ranking policy.

## 1. Session load

For each axis \(a\) (topic concentration, source concentration, viewpoint concentration, graphic intensity, arousal, low novelty, repetition, passive-consumption proxy), the browser computes an exposure-weighted raw measurement \(R_a(t)\).

Fast state uses real elapsed-time decay:

\[
L^f_a(t)=e^{-\Delta t/\tau^f_a}L^f_a(t-\Delta t)+\left(1-e^{-\Delta t/\tau^f_a}\right)R_a(t)
\]

A slow cross-session baseline uses the same update with a multi-hour time constant. The normalized load is

\[
z_a(t)=\frac{0.82L^f_a(t)+0.18L^s_a(t)-\mu_a}{\sigma_a+\epsilon}.
\]

Enter saturation when either

\[
\max_a z_a(t)>\theta^{high}_a
\]

or the sum of the three largest positive axis loads exceeds a joint threshold. Exit requires all axes below their low thresholds, minimum exposure after the boundary, and meaningful interaction with newly introduced informational axes. This is hysteresis, not a one-threshold toggle.

## 2. No visible two-path choice

The system maintains two posterior reward models:

\[
q_B\sim \operatorname{Beta}(\alpha_B,\beta_B),\qquad
q_L\sim \operatorname{Beta}(\alpha_L,\beta_L)
\]

where \(B\) is ordinary exploitation and \(L\) is same-motive/different-axis retrieval. The user never sees these labels.

At a phase boundary, Thompson samples are drawn:

\[
\tilde q_B\sim q_B,\qquad \tilde q_L\sim q_L.
\]

The continuous automatic gate is

\[
g_t=\operatorname{clip}\left(
\rho(z_t)+0.54\,\sigma\left(4.2(\tilde q_L-\tilde q_B)+1.15(z_{max}-0.85)\right),
0.08,0.88
\right)
\]

with

\[
\rho(z_t)=\operatorname{clip}\left(\frac{z_{max}-0.55}{2.8},0,0.43\right).
\]

So uncertainty does not force a fake decision. When the model does not know which family will be better, it interleaves candidates and learns from ordinary behavior. As saturation risk rises, a minimum lateral share appears even when the posterior is uncertain.

The implemented gate is smoothed over time so the candidate distribution does not jump slate-to-slate:

\[
g_t\leftarrow g_{t-1}+\left(1-e^{-\Delta t/\tau_g}\right)(g_t^*-g_{t-1}).
\]

## 3. Candidate value

The untouched base score is

\[
B_i=0.55E_i+0.30A_i+0.15R_i
\]

where \(E_i\) is predicted engagement, \(A_i\) is affinity to the active motive/topic, and \(R_i\) is relevance.

The lateral value is

\[
\begin{aligned}
V_i={}&0.24D^{axis}_i+0.15N^{source}_i+0.12G^{view}_i\\
&+0.19C_i+0.18M_i+0.06P_i+0.06D^{topic}_i\\
&-0.16R^{duplicate}_i-0.15R^{graphic}_i.
\end{aligned}
\]

The automatic ranking score is

\[
S_i(t)=B_i+g_tV_i+g_tU_i+\eta_i
\]

where \(U_i\) is the sampled posterior advantage of the candidate’s latent family and \(\eta_i\) is bounded exploration noise. A greedy set-diversity pass then penalizes repeated source clusters and duplicate families inside the served slate.

There is no branch that says “now show good posts.” There is one candidate union and one score whose geometry changes after the phase boundary.

## 4. Online posterior update

Normal interactions produce a clipped proxy reward \(r\in[0,1]\): rapid skip is low; sufficiently long exposure is weak evidence; open is stronger; save/share are stronger still. For a candidate from family \(k\):

\[
\alpha_k\leftarrow\alpha_k+w r,
\qquad
\beta_k\leftarrow\beta_k+w(1-r).
\]

This is deliberately a demo proxy, not a claim to measure wellbeing. A production model would replace it with delayed survey-calibrated satisfaction and return outcomes, using contextual rather than two-arm posteriors.

## 5. Deep saturation

Repeated rejection of lateral candidates while the original load remains high changes state to `deep_saturation`. The system does not return immediately to ordinary ranking. It raises exploration temperature and broadens underexposed axis retrieval. This prevents the normal → saturation → normal limit cycle caused by exposure-only exit rules.

## 6. Measurements implemented in the prototype

- Topic concentration: normalized entropy deficit of exposure-weighted topic bins.
- Source concentration: HHI over ownership/coordination cluster IDs.
- Viewpoint concentration: entropy deficit over coarse simulated stance bins.
- Graphic intensity: exposure-weighted precomputed prototype score.
- Emotional intensity: arousal weighted by negative valence.
- Low novelty: similarity to the recent exposure centroid.
- Repetition: duplicate-family HHI plus dominant-family share.
- Passive-consumption proxy: prolonged exposure without deliberate actions.

All classifier-like fields in the corpus are synthetic metadata. `?debug=1` exposes the state, equations’ inputs, thresholds, posterior, gate, and top ranking components.
