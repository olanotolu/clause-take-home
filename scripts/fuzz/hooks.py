"""Schemathesis hook: fuzz against REAL document ids so requests reach the edit/search logic
instead of bouncing off 404s. Point it at a DISPOSABLE database: the run mutates documents.

    SCHEMATHESIS_HOOKS=hooks schemathesis run http://127.0.0.1:3222/openapi.json ...   (cwd: scripts/fuzz)
"""
import json
import os
import re
import urllib.request

import schemathesis

BASE = os.environ.get("CLAUSE_BASE", "http://127.0.0.1:3222")


def _ids():
    with urllib.request.urlopen(f"{BASE}/documents?limit=100") as r:
        return [d["id"] for d in json.load(r)["items"]]


IDS = _ids()


@schemathesis.hook
def map_path_parameters(context, path_parameters):
    # Schemathesis 4 wraps generated values: the dict lives in `.value`.
    params = getattr(path_parameters, "value", path_parameters)
    if not params:
        return path_parameters
    # Only substitute values that were ALREADY valid. Overwriting a deliberately invalid value (negative
    # testing) with a valid one would hide exactly the bugs the fuzzer is trying to find.
    ident = params.get("id")
    if isinstance(ident, str) and 1 <= len(ident) <= 64 and IDS:
        params["id"] = IDS[sum(map(ord, ident)) % len(IDS)]  # deterministic, so a seed reproduces the run
    version = params.get("version")
    if isinstance(version, (str, int)) and re.fullmatch(r"[1-9][0-9]{0,8}", str(version)):
        params["version"] = 1  # every seeded document has a revision 1
    return path_parameters
