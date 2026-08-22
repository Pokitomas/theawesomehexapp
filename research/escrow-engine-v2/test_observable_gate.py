import pytest

from observable_gate import certify_observable_decoder, decode, tv


def test_one_state_zero_factor_debt_does_not_hide_observable_error():
    cert = certify_observable_decoder(
        decoder=[[0.5, 0.5]],
        artifact_observables=[[1.0, 0.0]],
        artifact_factors=[[1.0]],
        reference_observables=[[0.0, 1.0]],
        reference_factors=[[1.0]],
        artifact_support=[1],
        reference_support=[1],
    )
    assert cert.observable_bound(0.0) == pytest.approx(1.0)
    with pytest.raises(ValueError, match="exceeds gate"):
        cert.require_admission(0.0, 0.1)


def test_unsupported_rows_fail_closed_even_with_small_residual():
    cert = certify_observable_decoder(
        decoder=[[1.0, 0.0], [0.0, 1.0]],
        artifact_observables=[[1.0, 0.0]],
        artifact_factors=[[1.0, 0.0]],
        reference_observables=[[1.0, 0.0]],
        reference_factors=[[1.0, 0.0]],
        artifact_support=[3, 0],
        reference_support=[3, 0],
    )
    with pytest.raises(ValueError, match="unsupported artifact"):
        cert.require_admission(0.0, 0.1)


def test_exact_decoder_lifts_factor_debt():
    cert = certify_observable_decoder(
        decoder=[[1.0, 0.0], [0.0, 1.0]],
        artifact_observables=[[0.8, 0.2], [0.1, 0.9]],
        artifact_factors=[[0.8, 0.2], [0.1, 0.9]],
        reference_observables=[[0.75, 0.25], [0.15, 0.85]],
        reference_factors=[[0.75, 0.25], [0.15, 0.85]],
        artifact_support=[4, 4],
        reference_support=[4, 4],
    )
    assert cert.require_admission(0.05, 0.051) == pytest.approx(0.05)


def test_triangle_lift_is_numerically_sound():
    decoder = [[0.9, 0.1], [0.2, 0.8]]
    mu_art = [0.7, 0.3]
    mu_ref = [0.6, 0.4]
    decoded_art = decode(mu_art, decoder)
    decoded_ref = decode(mu_ref, decoder)
    p_art = [decoded_art[0] + 0.02, decoded_art[1] - 0.02]
    p_ref = [decoded_ref[0] - 0.01, decoded_ref[1] + 0.01]
    cert = certify_observable_decoder(
        decoder=decoder,
        artifact_observables=[p_art],
        artifact_factors=[mu_art],
        reference_observables=[p_ref],
        reference_factors=[mu_ref],
        artifact_support=[1, 1],
        reference_support=[1, 1],
    )
    lifted = cert.observable_bound(tv(mu_art, mu_ref))
    assert tv(p_art, p_ref) <= lifted + 1e-12
