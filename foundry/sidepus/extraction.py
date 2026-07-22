#!/usr/bin/env python3
"""Extract governed WARC holdings into provenance-separated developmental records."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import tempfile
import urllib.parse
from collections import Counter
from collections.abc import Iterable, Mapping
from html.parser import HTMLParser
from typing import Any

from .catalog import Catalog, atomic_json, digest_json, sha256_file, stable_json, utc_now
from .development import INVENTORY_SCHEMA
from .governance import current_content_policy_digest

EXTRACTION_SCHEMA = "sidepus-warc-extraction/v1"
RIGHTS_SCHEMA = "sidepus-rights-decision/v1"
TEXT_MIME_TYPES = {
    "application/atom+xml",
    "application/javascript",
    "application/json",
    "application/ld+json",
    "application/rss+xml",
    "application/xhtml+xml",
    "application/x-javascript",
    "application/xml",
    "image/svg+xml",
}
CODE_EXTENSIONS = {
    ".bash", ".c", ".cc", ".cpp", ".cxx", ".go", ".h", ".hpp",
    ".java", ".js", ".jsx", ".json", ".kt", ".kts", ".php", ".ps1",
    ".py", ".pyi", ".rb", ".rs", ".scala", ".sh", ".sql", ".swift",
    ".toml", ".ts", ".tsx", ".xml", ".yaml", ".yml", ".zsh",
}


class VisibleText(HTMLParser):
    """Extract visible text while refusing script/style/template shortcuts."""

    hidden_tags = {"canvas", "noscript", "script", "style", "svg", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hidden_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in self.hidden_tags:
            self.hidden_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self.hidden_tags:
            self.hidden_depth = max(0, self.hidden_depth - 1)

    def handle_data(self, data: str) -> None:
        if self.hidden_depth == 0 and data.strip():
            self.parts.append(data)

    def value(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.parts)).strip()


def _load_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.resolve().read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    return value


def _import_bytes(catalog: Catalog, payload: bytes, media_type: str) -> tuple[str, int]:
    with tempfile.NamedTemporaryFile(dir=catalog.temporary, delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        digest, size, _ = catalog.import_object(
            temporary, media_type=media_type, move=True
        )
    finally:
        temporary.unlink(missing_ok=True)
    return digest, size


def _mime(record: Any, indexed: Mapping[str, Any]) -> str:
    value = None
    if getattr(record, "http_headers", None) is not None:
        value = record.http_headers.get_header("Content-Type")
    value = value or indexed.get("content_type") or "application/octet-stream"
    return str(value).split(";", 1)[0].strip().lower()


def _charset(record: Any) -> str:
    if getattr(record, "http_headers", None) is None:
        return "utf-8"
    header = record.http_headers.get_header("Content-Type") or ""
    match = re.search(r"charset\s*=\s*['\"]?([^;'\"\s]+)", header, re.I)
    return match.group(1) if match else "utf-8"


def _text(payload: bytes, mime: str, charset: str) -> str | None:
    if not (mime.startswith("text/") or mime in TEXT_MIME_TYPES):
        return None
    try:
        decoded = payload.decode(charset, errors="replace")
    except LookupError:
        decoded = payload.decode("utf-8", errors="replace")
    if mime in {"text/html", "application/xhtml+xml"}:
        parser = VisibleText()
        try:
            parser.feed(decoded)
            decoded = parser.value()
        except Exception:
            decoded = re.sub(r"<[^>]+>", " ", decoded)
    decoded = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]+", " ", decoded)
    return re.sub(r"\s+", " ", decoded).strip()


def _language(source: Mapping[str, Any]) -> str:
    locator = source.get("locator") if isinstance(source.get("locator"), dict) else {}
    value = locator.get("languages") or source.get("languages") or "und"
    if isinstance(value, list):
        value = value[0] if value else "und"
    code = str(value).split(",", 1)[0].split(";", 1)[0].strip().lower()
    return {"eng": "en", "spa": "es", "und": "und"}.get(code, code[:8] or "und")


def _era(date: Any) -> str:
    match = re.match(r"(\d{4})", str(date or ""))
    if not match:
        return "unknown"
    year = int(match.group(1))
    if year < 1900:
        return "pre_1900"
    if year < 1990:
        return "1900_1989"
    if year < 2010:
        return "1990_2009"
    if year < 2020:
        return "2010_2019"
    return "2020_2026"


def _quality(text: str | None, mime: str) -> tuple[float, list[str]]:
    flags: list[str] = []
    if text is None:
        return (0.55 if mime.startswith(("image/", "audio/", "video/")) else 0.25), flags
    length = len(text)
    if length < 80:
        flags.append("very-short")
    printable = sum(ch.isprintable() for ch in text) / max(length, 1)
    alpha = sum(ch.isalpha() for ch in text) / max(length, 1)
    words = re.findall(r"\w+", text.lower())
    diversity = len(set(words)) / max(len(words), 1)
    sample = text[:2000]
    repeated = max((sample.count(ch) for ch in set(sample)), default=0) / max(len(sample), 1)
    score = min(
        1.0,
        0.15 + min(length / 4000.0, 0.35) + printable * 0.2
        + alpha * 0.15 + diversity * 0.15,
    )
    if repeated > 0.45:
        score -= 0.25
        flags.append("repetition-heavy")
    lowered = text[:20000].lower()
    spam_hits = sum(
        lowered.count(term)
        for term in ("buy now", "casino", "click here", "free money", "seo backlinks")
    )
    if spam_hits >= 3:
        score -= 0.25
        flags.append("spam-signals")
    if text.count("�") / max(length, 1) > 0.01:
        score -= 0.15
        flags.append("decode-damage")
    return max(0.0, min(1.0, score)), sorted(set(flags))


def _domain(target_uri: str, mime: str, text: str | None, flags: Iterable[str]) -> str:
    parsed = urllib.parse.urlparse(target_uri)
    host = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    suffix = pathlib.PurePosixPath(path).suffix
    evidence = f"{(text or '')[:12000]} {host} {path}".lower()
    if "spam-signals" in set(flags):
        return "adversarial_messy"
    if mime.startswith(("image/", "audio/", "video/")):
        return "multimodal_episode"
    formal_mimes = {
        "application/javascript", "application/json", "application/ld+json",
        "application/x-javascript", "application/xml", "text/css",
    }
    if (
        suffix in CODE_EXTENSIONS
        or mime in formal_mimes
        or any(term in evidence for term in (
            "api reference", "compiler", "github", "source code",
        ))
    ):
        return "formal_executable"
    if host.endswith((".edu", ".ac.uk")) or any(term in evidence for term in (
        "biology", "chemistry", "dataset", "evidence", "experiment", "journal",
        "mathematics", "measurement", "medicine", "physics", "research", "scientific",
    )):
        return "empirical_world"
    if host.endswith(".gov") or any(term in evidence for term in (
        "court", "economics", "election", "government", "institution", "legislation",
        "news", "organization", "policy", "public administration", "regulation",
    )):
        return "social_institutional"
    return "language_expression"


def _rights_rules(path: pathlib.Path | None) -> list[dict[str, Any]]:
    if path is None:
        return []
    value = _load_json(path)
    if value.get("schema") != RIGHTS_SCHEMA or value.get("approved_by_operator") is not True:
        raise ValueError(
            f"rights manifest must use {RIGHTS_SCHEMA} and be operator-approved"
        )
    if not isinstance(value.get("rules"), list):
        raise ValueError("rights manifest rules must be a list")
    return [dict(rule) for rule in value["rules"]]


def _rights(
    target_uri: str,
    source: Mapping[str, Any],
    rules: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    host = (urllib.parse.urlparse(target_uri).hostname or "").lower()
    adapter = str(source.get("adapter") or source.get("source_id") or "")
    for rule in rules:
        suffix = str(rule.get("host_suffix", "")).lower()
        required_adapter = str(rule.get("adapter", ""))
        if suffix and not (host == suffix.lstrip(".") or host.endswith(suffix)):
            continue
        if required_adapter and required_adapter != adapter:
            continue
        return {
            "status": str(rule.get("status", "unresolved")),
            "label": str(rule.get("label", "operator-rule")),
            "allow_training": rule.get("allow_training") is True,
        }
    return {
        "status": "unresolved",
        "label": "no-matching-rights-rule",
        "allow_training": False,
    }


def _record_id(object_sha256: str, ordinal: int) -> str:
    material = f"{EXTRACTION_SCHEMA}\x1f{object_sha256}\x1f{ordinal}".encode()
    return "sidepus_record_" + hashlib.sha256(material).hexdigest()[:32]


def export_developmental_inventory(
    *,
    state_dir: pathlib.Path,
    output: pathlib.Path,
    rights_manifest: pathlib.Path | None = None,
    maximum_records: int = 1_000_000,
    maximum_payload_bytes: int = 64 << 20,
) -> dict[str, Any]:
    if maximum_records < 1 or maximum_payload_bytes < 1:
        raise ValueError("record and payload limits must be positive")
    output = output.expanduser().resolve()
    if output.exists():
        raise ValueError(f"refusing to overwrite {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    rules = _rights_rules(rights_manifest)
    try:
        from warcio.archiveiterator import ArchiveIterator  # type: ignore
    except ImportError as error:
        raise RuntimeError("warcio is required for developmental WARC extraction") from error

    counts: Counter[str] = Counter()
    domains: Counter[str] = Counter()
    inventory_hash = hashlib.sha256()
    with Catalog(state_dir.expanduser().resolve()) as catalog:
        policy_digest = current_content_policy_digest(catalog)
        archives = catalog.connection.execute("""
            SELECT DISTINCT w.object_sha256, o.relative_path
            FROM warc_records AS w
            JOIN objects AS o ON o.sha256=w.object_sha256
            ORDER BY w.object_sha256
        """).fetchall()
        with tempfile.NamedTemporaryFile(
            dir=output.parent, delete=False, mode="w", encoding="utf-8"
        ) as handle:
            temporary = pathlib.Path(handle.name)
            try:
                for archive in archives:
                    if counts["selected"] >= maximum_records:
                        break
                    archive_sha = str(archive["object_sha256"])
                    archive_path = catalog.root / str(archive["relative_path"])
                    indexed = {
                        int(row["record_ordinal"]): dict(row)
                        for row in catalog.connection.execute(
                            "SELECT * FROM warc_records WHERE object_sha256=? ORDER BY record_ordinal",
                            (archive_sha,),
                        )
                    }
                    with archive_path.open("rb") as stream:
                        for ordinal, record in enumerate(
                            ArchiveIterator(stream, arc2warc=True)
                        ):
                            if counts["selected"] >= maximum_records:
                                break
                            row = indexed.get(ordinal)
                            if row is None:
                                counts["missing_catalog_row"] += 1
                                continue
                            if str(record.rec_type) not in {
                                "conversion", "resource", "response"
                            }:
                                counts["non_payload_record"] += 1
                                continue
                            target_uri = str(
                                record.rec_headers.get_header("WARC-Target-URI")
                                or row.get("target_uri")
                                or ""
                            )
                            if not target_uri.startswith(("http://", "https://")):
                                counts["non_http_target"] += 1
                                continue
                            source = json.loads(str(row["source_json"]))
                            mime = _mime(record, row)
                            payload = record.content_stream().read(
                                maximum_payload_bytes + 1
                            )
                            if len(payload) > maximum_payload_bytes:
                                counts["oversized_payload"] += 1
                                continue
                            if not payload:
                                counts["empty_payload"] += 1
                                continue

                            observation_sha, observation_bytes = _import_bytes(
                                catalog, payload, mime
                            )
                            text = _text(payload, mime, _charset(record))
                            quality, quality_flags = _quality(text, mime)
                            subject = _domain(
                                target_uri, mime, text, quality_flags
                            )
                            rights = _rights(target_uri, source, rules)
                            flags = list(quality_flags)
                            if not rights["allow_training"]:
                                flags.append("rights-blocked")
                            locator = source.get("locator")
                            if (
                                isinstance(locator, dict)
                                and locator.get("derivative_boundary")
                            ):
                                flags.append("derivative-replay")

                            context = {
                                "schema": "sidepus-production-context/v1",
                                "archive_object_sha256": archive_sha,
                                "record_ordinal": ordinal,
                                "target_uri": target_uri,
                                "warc_date": row.get("warc_date"),
                                "warc_type": row.get("warc_type"),
                                "payload_digest": row.get("payload_digest"),
                                "mime": mime,
                                "source": source,
                                "rights": rights,
                            }
                            context_sha, _ = _import_bytes(
                                catalog,
                                (stable_json(context) + "\n").encode(),
                                "application/json",
                            )
                            interpretation = {
                                "schema": "sidepus-extraction-interpretation/v1",
                                "domain": subject,
                                "language": _language(source),
                                "era": _era(row.get("warc_date")),
                                "quality_score": quality,
                                "flags": sorted(set(flags)),
                                "extractor": EXTRACTION_SCHEMA,
                            }
                            interpretation_sha, _ = _import_bytes(
                                catalog,
                                (stable_json(interpretation) + "\n").encode(),
                                "application/json",
                            )
                            channel_objects: dict[str, list[dict[str, Any]]] = {
                                "observation": [{
                                    "sha256": observation_sha,
                                    "media_type": mime,
                                    "bytes": observation_bytes,
                                }],
                                "production_context": [{
                                    "sha256": context_sha,
                                    "media_type": "application/json",
                                }],
                                "interpretation": [{
                                    "sha256": interpretation_sha,
                                    "media_type": "application/json",
                                }],
                            }
                            channels = [
                                "interpretation", "observation", "production_context"
                            ]
                            if text:
                                utterance_sha, utterance_bytes = _import_bytes(
                                    catalog,
                                    (text + "\n").encode("utf-8"),
                                    "text/plain; charset=utf-8",
                                )
                                channel_objects["utterance"] = [{
                                    "sha256": utterance_sha,
                                    "media_type": "text/plain; charset=utf-8",
                                    "bytes": utterance_bytes,
                                }]
                                channels.append("utterance")
                            estimated_tokens = max(
                                1,
                                int(len(text) / 4)
                                if text is not None
                                else int(len(payload) / 4),
                            )
                            inventory = {
                                "schema": INVENTORY_SCHEMA,
                                "record_id": _record_id(archive_sha, ordinal),
                                "object_sha256": archive_sha,
                                "bytes": len(payload),
                                "estimated_tokens": estimated_tokens,
                                "domain": subject,
                                "medium": mime.split("/", 1)[0]
                                if "/" in mime else "binary",
                                "language": interpretation["language"],
                                "era": interpretation["era"],
                                "channels": sorted(channels),
                                "channel_objects": channel_objects,
                                "rights": rights,
                                "quality_score": quality,
                                "flags": sorted(set(flags)),
                                "source_host": urllib.parse.urlparse(
                                    target_uri
                                ).hostname,
                                "target_uri_sha256": hashlib.sha256(
                                    target_uri.encode()
                                ).hexdigest(),
                            }
                            encoded = stable_json(inventory)
                            handle.write(encoded + "\n")
                            inventory_hash.update((encoded + "\n").encode())
                            counts["selected"] += 1
                            counts["bytes"] += len(payload)
                            counts["estimated_tokens"] += estimated_tokens
                            domains[subject] += 1
                handle.flush()
                os.fsync(handle.fileno())
                os.replace(temporary, output)
            except Exception:
                temporary.unlink(missing_ok=True)
                raise

        receipt = {
            "schema": EXTRACTION_SCHEMA,
            "created_at": utc_now(),
            "state_dir": str(catalog.root),
            "content_policy_digest": policy_digest,
            "rights_manifest": str(rights_manifest.resolve())
            if rights_manifest else None,
            "rights_manifest_sha256": sha256_file(rights_manifest.resolve())
            if rights_manifest else None,
            "maximum_records": maximum_records,
            "maximum_payload_bytes": maximum_payload_bytes,
            "inventory_path": str(output),
            "inventory_sha256": sha256_file(output),
            "inventory_digest": inventory_hash.hexdigest(),
            "counts": dict(sorted(counts.items())),
            "domains": dict(sorted(domains.items())),
            "claim_boundary": (
                "Extraction preserves channel boundaries and fail-closed rights labels; "
                "it does not prove semantic correctness, legal status, or training value."
            ),
        }
        receipt["receipt_digest"] = digest_json(receipt)
        receipt_path = output.with_suffix(output.suffix + ".receipt.json")
        atomic_json(receipt_path, receipt)
        catalog.append_event("developmental-inventory-exported", {
            "inventory_sha256": receipt["inventory_sha256"],
            "inventory_digest": receipt["inventory_digest"],
            "records": counts["selected"],
            "receipt_digest": receipt["receipt_digest"],
        })
        return receipt


def verify_inventory(receipt_path: pathlib.Path) -> dict[str, Any]:
    receipt = _load_json(receipt_path)
    body = dict(receipt)
    expected = body.pop("receipt_digest", None)
    inventory = pathlib.Path(receipt["inventory_path"])
    rights_path = receipt.get("rights_manifest")
    checks = {
        "schema": receipt.get("schema") == EXTRACTION_SCHEMA,
        "receipt_digest": expected == digest_json(body),
        "inventory_file": inventory.is_file()
        and sha256_file(inventory) == receipt.get("inventory_sha256"),
        "rights_manifest": rights_path is None
        or sha256_file(pathlib.Path(rights_path))
        == receipt.get("rights_manifest_sha256"),
    }
    return {
        "schema": "sidepus-warc-extraction-verification/v1",
        "receipt": str(receipt_path.resolve()),
        "checks": checks,
        "passed": all(checks.values()),
    }
