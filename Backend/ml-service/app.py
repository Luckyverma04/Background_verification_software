import logging
import threading
from collections import OrderedDict

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
from typing import Any, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("bgv-ml")
logging.basicConfig(level=logging.INFO)

app = FastAPI(
    title="BGV ML Matching Service",
    version="1.0.0"
)

MODEL_NAME = "BAAI/bge-m3"

print(f"Loading ML model: {MODEL_NAME}")

model = SentenceTransformer(MODEL_NAME)

print("ML model loaded successfully")


# The request models deliberately accept ANY JSON value for the texts.
# Validation happens in _clean_text() below, per item, so one malformed profile
# (null, object, nested array ...) can no longer reject - or crash - a whole
# batch. Well-formed requests ({"candidate_text": "...", "result_texts": ["..."]})
# are unchanged.
class MatchRequest(BaseModel):
    candidate_text: Any = None
    result_text: Any = None


class BatchMatchRequest(BaseModel):
    candidate_text: Any = None
    result_texts: List[Any]


# Cap very long texts so a single profile cannot slow the whole batch.
model.max_seq_length = 512

MAX_BATCH = 64

# SentenceTransformer / the HF fast tokenizer are NOT safe for concurrent
# encode() calls. FastAPI runs these sync endpoints in a thread pool, so two
# simultaneous requests (e.g. a warm-up pass and a review-page request) used
# to run encode() in parallel, which can raise "Already borrowed" / OOM and
# surfaces as HTTP 500 or a reset connection. One request encodes at a time.
_encode_lock = threading.Lock()

# The candidate text is identical for every batch of a run: embed it once.
_CAND_CACHE_MAX = 32
_cand_cache = OrderedDict()


# Longest text handed to the tokenizer (characters). The model itself truncates
# to max_seq_length tokens; this only stops absurd payloads reaching it.
MAX_TEXT_CHARS = 20000

# Machine-readable per-item error codes (stable API for the Node client)
EMPTY_TEXT = "EMPTY_TEXT"
NULL_TEXT = "NULL_TEXT"
INVALID_TYPE = "INVALID_TYPE"
ENCODE_FAILED = "ENCODE_FAILED"
BAD_EMBEDDING = "BAD_EMBEDDING"


class EmbeddingError(Exception):
    """The model returned something that is not a usable embedding."""


def _clean_text(value: Any) -> Tuple[Optional[str], Optional[str]]:
    """Return (text, None) for usable input, or (None, error_code).

    - str            -> stripped; empty/whitespace-only is EMPTY_TEXT
    - int / float    -> converted with str() (finite numbers only)
    - None           -> NULL_TEXT
    - bool, dict, list, tuple, bytes, anything else -> INVALID_TYPE
      (a nested array or an object is NOT silently flattened / stringified:
      that would produce a meaningless "profile text" and a fake score)
    """
    if value is None:
        return None, NULL_TEXT
    if isinstance(value, bool):
        return None, INVALID_TYPE
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not np.isfinite(value):
            return None, INVALID_TYPE
        value = str(value)
    if not isinstance(value, str):
        return None, INVALID_TYPE
    value = value.strip()
    if not value:
        return None, EMPTY_TEXT
    return value[:MAX_TEXT_CHARS], None


def _describe_invalid(index: Optional[int], value: Any, code: str) -> dict:
    # Diagnostics carry the position, the Python type and the reason - never
    # the text itself (it can be personal data).
    return {"index": index, "pythonType": type(value).__name__, "code": code}


def _log_invalid(where: str, invalid: List[dict]) -> None:
    if not invalid:
        return
    shown = ", ".join(
        "#%s:%s(%s)" % (d["index"], d["pythonType"], d["code"]) for d in invalid[:20]
    )
    more = "" if len(invalid) <= 20 else " (+%d more)" % (len(invalid) - 20)
    logger.warning("%s: %d invalid text(s) skipped: %s%s", where, len(invalid), shown, more)


def _encode(texts):
    with _encode_lock:
        return model.encode(texts, normalize_embeddings=True)


def _as_vector(raw, name: str) -> np.ndarray:
    arr = np.asarray(raw, dtype=np.float32)
    if arr.ndim != 1 or arr.shape[0] == 0:
        raise EmbeddingError("%s embedding has shape %s, expected (dim,)" % (name, arr.shape))
    if not np.all(np.isfinite(arr)):
        raise EmbeddingError("%s embedding contains NaN/Inf" % name)
    return arr


def _as_matrix(raw, rows: int, dim: int) -> np.ndarray:
    arr = np.asarray(raw, dtype=np.float32)
    if arr.ndim != 2 or arr.shape != (rows, dim):
        raise EmbeddingError("result embeddings have shape %s, expected (%d, %d)" % (arr.shape, rows, dim))
    return arr


def _candidate_embedding(text):
    hit = _cand_cache.get(text)
    if hit is not None:
        _cand_cache.move_to_end(text)
        return hit
    emb = _as_vector(_encode(text), "candidate")  # validated BEFORE it is cached
    _cand_cache[text] = emb
    while len(_cand_cache) > _CAND_CACHE_MAX:
        _cand_cache.popitem(last=False)
    return emb


def _bad_request(code: str, message: str, invalid: Optional[dict] = None):
    return HTTPException(
        status_code=422,
        detail={"success": False, "code": code, "message": message, "invalid": [invalid] if invalid else []},
    )


def _ml_unavailable(message: str = "ML encode failed; see service log"):
    # 503 = the service (not the request data) is the problem: transient.
    return HTTPException(status_code=503, detail={"success": False, "code": "ML_UNAVAILABLE", "message": message})


def _score_row(index, score):
    return {
        "index": index,
        "status": "OK",
        "similarity": round(float(score), 4),
        "similarityPercent": round(float(score) * 100, 2),
    }


def _unavailable_row(index, code, python_type):
    # similarity is null - an item we could not score is NOT a score of 0
    return {
        "index": index,
        "status": "UNAVAILABLE",
        "similarity": None,
        "similarityPercent": None,
        "error": {"code": code, "pythonType": python_type},
    }


@app.get("/")
def root():
    return {"success": True, "service": "BGV ML Matching Service", "endpoints": ["/health", "/match", "/match/batch"]}


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    from fastapi import Response
    return Response(status_code=204)


@app.get("/health")
def health():
    return {
        "success": True,
        "service": "BGV ML Matching Service",
        "model": MODEL_NAME,
        "status": "running"
    }


@app.post("/match")
def match_person(request: MatchRequest):
    cand, code = _clean_text(request.candidate_text)
    if code:
        d = _describe_invalid(None, request.candidate_text, code)
        _log_invalid("/match candidate_text", [d])
        raise _bad_request("INVALID_CANDIDATE_TEXT", "candidate_text is not usable text", d)
    res, code = _clean_text(request.result_text)
    if code:
        d = _describe_invalid(None, request.result_text, code)
        _log_invalid("/match result_text", [d])
        raise _bad_request("INVALID_RESULT_TEXT", "result_text is not usable text", d)

    try:
        candidate_embedding = _candidate_embedding(cand)
        result_embedding = _as_vector(_encode(res), "result")
        if result_embedding.shape != candidate_embedding.shape:
            raise EmbeddingError("embedding dimension mismatch")
    except Exception:
        logger.exception("/match failed")
        raise _ml_unavailable()

    score = float(candidate_embedding @ result_embedding)

    return {
        "success": True,
        "model": MODEL_NAME,
        "similarity": round(score, 4),
        "similarityPercent": round(score * 100, 2)
    }


def _encode_valid(texts: List[str]):
    """Encode the valid texts. Returns (rows, failed) where rows[i] is a vector
    or None and failed[i] is an error code for texts that could not be encoded.

    The whole sub-batch is tried first (the normal, fast path). If that raises,
    the texts are retried one by one so a single poisonous text cannot take the
    valid ones down with it. If NOTHING can be encoded the model/service is
    broken and the caller answers 503."""
    try:
        out = list(_encode(texts))
        if len(out) != len(texts):
            raise EmbeddingError("encoder returned %d rows for %d texts" % (len(out), len(texts)))
        return out, [None] * len(texts)
    except Exception:
        logger.exception("batch encode of %d text(s) failed; isolating per text", len(texts))
    rows, failed = [None] * len(texts), [None] * len(texts)
    for i, t in enumerate(texts):
        try:
            rows[i] = _encode(t)
        except Exception:
            logger.error("single encode failed for valid-text position %d (%s)", i, "length=%d" % len(t))
            failed[i] = ENCODE_FAILED
    return rows, failed


@app.post("/match/batch")
def match_batch(request: BatchMatchRequest):
    if len(request.result_texts) > MAX_BATCH:
        raise HTTPException(status_code=413, detail=f"max {MAX_BATCH} texts per batch")

    cand, code = _clean_text(request.candidate_text)
    if code:
        d = _describe_invalid(None, request.candidate_text, code)
        _log_invalid("/match/batch candidate_text", [d])
        raise _bad_request("INVALID_CANDIDATE_TEXT", "candidate_text is not usable text", d)

    n = len(request.result_texts)
    valid_idx: List[int] = []
    valid_texts: List[str] = []
    rows: List[Optional[dict]] = [None] * n
    invalid: List[dict] = []
    for i, raw in enumerate(request.result_texts):
        text, code = _clean_text(raw)
        if code:
            d = _describe_invalid(i, raw, code)
            invalid.append(d)
            rows[i] = _unavailable_row(i, code, d["pythonType"])
        else:
            valid_idx.append(i)
            valid_texts.append(text)
    _log_invalid("/match/batch", invalid)

    if valid_texts:
        try:
            candidate_embedding = _candidate_embedding(cand)
            dim = candidate_embedding.shape[0]
            encoded, failed = _encode_valid(valid_texts)
            if all(f for f in failed):
                raise EmbeddingError("no text could be encoded")
        except Exception:
            # log the REAL cause (traceback); 503 tells the Node client this is
            # a service problem, not a similarity of zero
            logger.exception("/match/batch failed for %d valid text(s)", len(valid_texts))
            raise _ml_unavailable()

        for pos, i in enumerate(valid_idx):
            if failed[pos]:
                rows[i] = _unavailable_row(i, failed[pos], "str")
                invalid.append({"index": i, "pythonType": "str", "code": failed[pos]})
                continue
            try:
                vec = _as_vector(encoded[pos], "result")
                if vec.shape[0] != dim:
                    raise EmbeddingError("dimension mismatch")
            except EmbeddingError:
                rows[i] = _unavailable_row(i, BAD_EMBEDDING, "str")
                invalid.append({"index": i, "pythonType": "str", "code": BAD_EMBEDDING})
                continue
            rows[i] = _score_row(i, float(vec @ candidate_embedding))

    ok = [r for r in rows if r["status"] == "OK"]
    bad = [r for r in rows if r["status"] != "OK"]
    # keep the historical ordering (best similarity first) for scored items,
    # then the unavailable ones in their original order; "index" is authoritative
    ok.sort(key=lambda item: item["similarity"], reverse=True)

    return {
        "success": True,
        "partial": bool(bad),
        "model": MODEL_NAME,
        "total": n,
        "scored": len(ok),
        "unavailable": len(bad),
        "invalid": sorted(invalid, key=lambda d: d["index"]),
        "results": ok + bad,
    }
