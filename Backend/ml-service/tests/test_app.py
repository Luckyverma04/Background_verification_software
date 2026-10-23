"""Tests for the ML service. The real BGE-M3 model is replaced by a small
deterministic fake (no torch / model download needed). The fake raises the same
TypeError the HF tokenizer raises for non-string input, so these tests prove
that bad data is stopped BEFORE model.encode()."""
import importlib
import logging
import os
import sys
import types

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DIM = 8


class FakeModel:
    max_seq_length = 512

    def __init__(self, *a, **k):
        self.calls = []
        self.fail_on = None       # substring -> raise for that text
        self.fail_all = False
        self.bad_shape = False
        self.nan = False

    def _vec(self, text):
        if not isinstance(text, str):
            raise TypeError("TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]")
        rng = np.random.default_rng(abs(hash(("seed", text))) % (2**32))
        # texts sharing a first word are similar; identical text -> identical vector
        base = np.random.default_rng(abs(hash(text.split()[0] if text.split() else "")) % (2**32)).normal(size=DIM)
        v = base + 0.05 * rng.normal(size=DIM)
        return (v / np.linalg.norm(v)).astype(np.float32)

    def encode(self, texts, normalize_embeddings=True):
        self.calls.append(texts)
        if self.fail_all:
            raise RuntimeError("model exploded")
        if self.bad_shape:
            return np.zeros((3, 3, 3), dtype=np.float32)
        single = isinstance(texts, str)
        items = [texts] if single else texts
        if not single and not isinstance(texts, list):
            raise TypeError("TextEncodeInput must be ...")
        out = []
        for t in items:
            if self.fail_on and isinstance(t, str) and self.fail_on in t:
                raise RuntimeError("poisonous text")
            v = self._vec(t)
            if self.nan:
                v = v * np.nan
            out.append(v)
        return out[0] if single else np.stack(out)


@pytest.fixture()
def env(monkeypatch):
    stub = types.ModuleType("sentence_transformers")
    stub.SentenceTransformer = FakeModel
    monkeypatch.setitem(sys.modules, "sentence_transformers", stub)
    sys.modules.pop("app", None)
    mod = importlib.import_module("app")
    from fastapi.testclient import TestClient
    mod._cand_cache.clear()
    yield mod, TestClient(mod.app), mod.model
    sys.modules.pop("app", None)


def post(client, texts, cand="alice engineer python"):
    return client.post("/match/batch", json={"candidate_text": cand, "result_texts": texts})


def by_index(body):
    return {r["index"]: r for r in body["results"]}


def test_normal_strings(env):
    mod, c, model = env
    r = post(c, ["alice developer", "bob farmer"])
    assert r.status_code == 200
    b = r.json()
    assert b["success"] and not b["partial"] and b["scored"] == 2 and b["unavailable"] == 0
    assert b["invalid"] == []
    rows = by_index(b)
    assert all(rows[i]["status"] == "OK" and isinstance(rows[i]["similarity"], float) for i in (0, 1))
    assert rows[0]["similarity"] > rows[1]["similarity"]          # same first word is closer
    assert b["results"][0]["similarity"] >= b["results"][1]["similarity"]  # historical ordering kept


def test_numbers_are_converted_to_strings(env):
    _, c, model = env
    b = post(c, [12345, 3.5, "text"]).json()
    assert b["scored"] == 3
    assert ["12345", "3.5", "text"] == model.calls[-1]


def test_none_is_unavailable_with_index(env):
    _, c, _ = env
    b = post(c, ["alice dev", None, "alice other"]).json()
    r = by_index(b)
    assert r[1]["status"] == "UNAVAILABLE" and r[1]["similarity"] is None and r[1]["similarityPercent"] is None
    assert r[1]["error"] == {"code": "NULL_TEXT", "pythonType": "NoneType"}
    assert r[0]["status"] == "OK" and r[2]["status"] == "OK"
    assert b["partial"] is True


def test_empty_and_whitespace_strings(env):
    _, c, _ = env
    b = post(c, ["", "   \n\t", "alice ok"]).json()
    r = by_index(b)
    assert r[0]["error"]["code"] == "EMPTY_TEXT" and r[1]["error"]["code"] == "EMPTY_TEXT"
    assert r[0]["similarity"] is None and r[1]["similarityPercent"] is None
    assert r[2]["status"] == "OK"


def test_dict_and_nested_arrays(env):
    _, c, model = env
    b = post(c, [{"title": "x"}, [["a", "b"], ["c"]], ["flat", "list"], "alice ok"]).json()
    r = by_index(b)
    assert r[0]["error"] == {"code": "INVALID_TYPE", "pythonType": "dict"}
    assert r[1]["error"] == {"code": "INVALID_TYPE", "pythonType": "list"}
    assert r[2]["error"]["code"] == "INVALID_TYPE"
    assert r[3]["status"] == "OK"
    # nothing malformed ever reached model.encode()
    assert model.calls[-1] == ["alice ok"]


def test_bool_and_nan_are_invalid(env):
    _, c, _ = env
    b = post(c, [True, "alice ok"]).json()
    assert by_index(b)[0]["error"]["code"] == "INVALID_TYPE"
    assert by_index(b)[0]["error"]["pythonType"] == "bool"


def test_mixed_batch_preserves_indexes_and_valid_results(env):
    _, c, _ = env
    texts = ["alice a", None, "", {"a": 1}, "bob b", [1, 2], "alice c"]
    b = post(c, texts).json()
    assert b["total"] == 7 and b["scored"] == 3 and b["unavailable"] == 4 and b["partial"]
    assert sorted(r["index"] for r in b["results"]) == list(range(7))
    r = by_index(b)
    assert [i for i in r if r[i]["status"] == "OK"] == [0, 4, 6] or sorted(i for i in r if r[i]["status"] == "OK") == [0, 4, 6]
    assert [(d["index"], d["code"]) for d in b["invalid"]] == [(1, "NULL_TEXT"), (2, "EMPTY_TEXT"), (3, "INVALID_TYPE"), (5, "INVALID_TYPE")]
    # unavailable items are never reported as a similarity of 0
    assert all(r[i]["similarity"] is None for i in (1, 2, 3, 5))


def test_all_invalid_batch_needs_no_model_call(env):
    _, c, model = env
    model.calls.clear()
    r = post(c, [None, "", {}])
    assert r.status_code == 200
    assert r.json()["scored"] == 0 and r.json()["unavailable"] == 3
    assert model.calls == []


@pytest.mark.parametrize("bad", [None, "", "   ", {"a": 1}, ["x"], 5 and True])
def test_invalid_candidate_text_is_422_structured(env, bad):
    _, c, model = env
    r = c.post("/match/batch", json={"candidate_text": bad, "result_texts": ["alice"]})
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["success"] is False and d["code"] == "INVALID_CANDIDATE_TEXT"
    assert d["invalid"][0]["pythonType"] == type(bad).__name__


def test_result_texts_must_be_a_list(env):
    _, c, _ = env
    r = c.post("/match/batch", json={"candidate_text": "alice", "result_texts": "not a list"})
    assert r.status_code == 422


def test_ml_exception_is_503_not_a_score(env):
    _, c, model = env
    model.fail_all = True
    r = post(c, ["alice a", "alice b"])
    assert r.status_code == 503
    d = r.json()["detail"]
    assert d["code"] == "ML_UNAVAILABLE" and d["success"] is False
    assert "results" not in d


def test_poisonous_text_is_isolated_valid_ones_survive(env):
    _, c, model = env
    model.fail_on = "POISON"
    b = post(c, ["alice a", "alice POISON x", "alice b"]).json()
    r = by_index(b)
    assert r[0]["status"] == "OK" and r[2]["status"] == "OK"
    assert r[1]["status"] == "UNAVAILABLE" and r[1]["error"]["code"] == "ENCODE_FAILED"
    assert b["partial"]


def test_candidate_encode_failure_is_503(env):
    _, c, model = env
    model.fail_on = "BOOM"
    r = post(c, ["alice a"], cand="BOOM candidate")
    assert r.status_code == 503


def test_wrong_embedding_shape_is_rejected(env):
    _, c, model = env
    model.bad_shape = True
    r = post(c, ["alice a"], cand="alice cand")
    assert r.status_code == 503   # candidate embedding is not (dim,)


def test_nan_embeddings_never_become_scores(env):
    _, c, model = env
    model.nan = True
    assert post(c, ["alice a"]).status_code == 503


def test_candidate_cache_only_stores_valid_embeddings(env):
    mod, c, model = env
    model.bad_shape = True
    post(c, ["alice a"], cand="cache me")
    assert "cache me" not in mod._cand_cache
    model.bad_shape = False
    assert post(c, ["alice a"], cand="cache me").status_code == 200
    assert "cache me" in mod._cand_cache


def test_dimension_mismatch_item_is_bad_embedding(env, monkeypatch):
    mod, c, model = env
    real = mod._encode_valid

    def odd(texts):
        rows, failed = real(texts)
        rows[1] = np.ones(DIM + 3, dtype=np.float32)
        return rows, failed

    monkeypatch.setattr(mod, "_encode_valid", odd)
    r = by_index(post(c, ["alice a", "alice b", "alice c"]).json())
    assert r[1]["error"]["code"] == "BAD_EMBEDDING" and r[1]["similarity"] is None
    assert r[0]["status"] == "OK" and r[2]["status"] == "OK"


def test_diagnostics_have_index_and_type_but_no_personal_data(env, caplog):
    _, c, _ = env
    secret = "Jane Q. Secretperson jane@example.com"
    with caplog.at_level(logging.WARNING, logger="bgv-ml"):
        post(c, [None, {"name": secret}, [secret]])
    log = caplog.text
    assert "#0:NoneType(NULL_TEXT)" in log and "#1:dict(INVALID_TYPE)" in log and "#2:list(INVALID_TYPE)" in log
    assert "Secretperson" not in log and "jane@example.com" not in log


def test_batch_limit_still_enforced(env):
    _, c, _ = env
    assert post(c, ["x"] * 65).status_code == 413


def test_single_match_endpoint(env):
    _, c, model = env
    ok = c.post("/match", json={"candidate_text": "alice a", "result_text": "alice b"})
    assert ok.status_code == 200 and "similarityPercent" in ok.json()
    bad = c.post("/match", json={"candidate_text": "alice a", "result_text": None})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "INVALID_RESULT_TEXT"
    model.fail_all = True
    assert c.post("/match", json={"candidate_text": "zzz new", "result_text": "alice b"}).status_code == 503


def test_health_still_works(env):
    _, c, _ = env
    assert c.get("/health").json()["status"] == "running"
