# BGV Automation
Run: 
1. Backend: `cd Backend && cp .env.example .env` (fill keys) `&& npm install && node scripts/reportDuplicateSearchResults.js && npm start`
2. ML: `cd Backend/ml-service && pip install -r requirements.txt && uvicorn app:app --port 8001`
3. Frontend: `cd Frontend && npm install && npm run dev` (prod: `npm run build`)
Tests: `cd Backend && TEST_MONGO_URI=<mongo uri> npm test`

Benchmark (mocked, no paid APIs): `cd Backend && TEST_MONGO_URI=<mongo uri> npm run benchmark`
(compare with another tree: `node benchmark/run.js <path-to-other-Backend>`)

Per-platform discovery: every supported platform has its own target (default 15 unique profile-shaped URLs; shape is not a live check, reachability is tracked separately), queries, counters and status.
`GET /api/bgv-runs/:id/platforms` (summary) and `GET /api/candidate-matches/run/:id/platform/:PLATFORM` (ranked list). Tune with the PLATFORM_* variables in Backend/.env.example.
Worst case this is ~370 provider calls per run (31 platforms x 4 queries x 3 calls); lower PLATFORM_MAX_QUERIES / PLATFORM_DISCOVERY_PAGES or set PLATFORM_DISCOVERY_PLATFORMS to save quota.

Call budget (`PLATFORM_DISCOVERY_MAX_CALLS`): capacity is reserved before every real provider attempt, retries included, so concurrent platform workers cannot overspend it. It covers the per-platform discovery phase only (the earlier global discovery/targeted phases are limited by their own query caps). The summary reports logical requests and provider attempts separately.
A confirmed / candidate-supplied profile no longer skips discovery on its platform; set `PLATFORM_DISCOVERY_SKIP_COVERED=true` to opt back in.


## Matching, ranking and exclusions (v5)

* `services/matchSignals.service.js` – pure name / company / title / location / education comparison and signal validation.
  Name matching is token based (order, middle initials, 1-letter typos); a shared first name or surname is never enough.
  Missing or malformed values (sentence fragments, `"teams"`, junk usernames) are UNKNOWN, not mismatches.
* Identity score = name (gate, 40) + independent corroboration (company 25, education 13, location 12, title 10) - capped soft penalties.
  Usernames derived from the name, job domain, profile completeness and URLs *found by search* are **not** identity evidence.
  Only a URL supplied for the candidate counts as a direct match.
* Status: `STRONG` / `POSSIBLE` / `REVIEW_REQUIRED` / `WEAK` (name-only, non-profile page) / `CONFLICT` (contradicting identity data). Thresholds: `MATCH_*` env vars.
* Nothing is hidden silently: every stored result not in the review list has a recorded stage + reason.
  `GET /api/candidate-matches/run/:id/relevant?view=excluded` and `.../platform/:platform?view=excluded` list them; responses carry `counts` (discovered / matched / reviewRequired / weak / rejectedConflicting / inReviewList / notInList).
* Targeted queries only reuse validated signals from results that already look like the candidate; rejected signals are saved in `searchSummary.queryDiagnostics`.
* `npm run benchmark:matching` prints the per-stage funnel and Precision@15 / recall on the labelled dataset.


## Performance, reuse and BGE-M3 stability

* **Search scope** - `utils/locationNormalizer.js` repairs contradictory location input for queries and matching
  (Dewas + Maharashtra -> Madhya Pradesh); the stored candidate is never changed. Queries use city + correct state first;
  state / country-only queries run only if those return too few name-matching profiles.
* **Provider layer** (`searchProvider.service.js`) - one global concurrency limit, a response cache with in-flight
  de-duplication, and metrics (calls / retries / errors / cache hits).
* **Reuse** - a new run of the same candidate re-uses stored profiles and still-fresh enrichment
  (`rawData.reuse` records it). Reviewer decisions are never copied or overwritten; reused profiles start as PENDING.
* **BGE-M3** - bounded concurrency, score cache keyed by model + candidate text + result text, in-flight de-duplication,
  a circuit breaker and one retry. A failed request is `UNAVAILABLE` (`similarityPercent: null`), never `0`; ranking
  falls back to the rule-based score. `ml-service/app.py` serialises `encode()` and logs the real traceback.
* **Timings** - every run stores `searchSummary.timings` (phases, provider, funnel, DB, reuse, ML) and prints `[perf]` lines.
* `npm run benchmark:pipeline` (needs `TEST_MONGO_URI`) times a full run with simulated provider / ML latency.

## Google Sheet import (review -> confirm -> one-by-one search)

Rows of your Google Sheet become candidates automatically. **Import never searches.** You review completeness, confirm, then press "Start sequential search"; candidates are then searched one at a time through the normal BGV run/search/matching/review pipeline.

### Setup
1. Google Cloud Console: create/select a project and **enable the Google Sheets API**.
2. IAM & Admin -> Service accounts -> create one -> Keys -> Add key -> JSON. Save the file **outside git** (e.g. `Backend/secrets/google-sa.json`; add it to `.gitignore`).
3. Open the Google Sheet -> Share -> add the service account's e-mail (`...@...iam.gserviceaccount.com`) as **Viewer**. No other permission is needed; the app only requests the read-only scope `spreadsheets.readonly` and never edits your sheet.
4. In `Backend/.env` set:

| Variable | Meaning | Default |
|---|---|---|
| `GOOGLE_SHEET_ID` | sheet id or full URL (a `#gid=` picks the tab) | required |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | path to the key file (or the JSON itself) | required (or EMAIL + PRIVATE_KEY) |
| `GOOGLE_SHEET_TAB` | tab name | tab from URL gid, else first tab |
| `SHEET_SYNC_INTERVAL_MIN` | polling interval, minutes (0 = manual "Sync now") | 5 |
| `SHEET_SEARCH_ENABLED` | `false` = import/review only | true |
| `SHEET_QUEUE_DELAY_MS` | pause between candidates | 2000 |
| `SHEET_QUEUE_CONCURRENCY` | candidates searched at once (1-3) | 1 |
| `SHEET_DATE_ORDER` | `MDY` or `DMY` for dates like 1/15/2000 | MDY |

5. Restart the backend, open **Google Sheet** in the sidebar, press **Sync now**.

Notes: detection is by polling (not instant). Columns are found by header name (Job ID, Candidate Name, Email, Contact Number(s), Date of Birth, Address(es), Education, Work Experience, Social Media Profiles, Profile Image URL, LinkedIn, Facebook, ...), so order may change. The Job ID is the stable row identity. Blank sheet cells never erase data and manual edits are never overwritten by later sheet changes. Profile URLs from the sheet are search seeds/evidence only, never an automatic identity confirmation. Signed image URLs in the sheet may expire.
