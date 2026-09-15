# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
SlaClaimJudge — the semantic half of a Verdikt verdict.

Verdikt's Chainlink CRE leg judges a paid call against the deterministic
clauses of the provider's SLA, and `evaluate` is pure by invariant: no I/O, no
clock, no network, no floating point. That is what makes a verdict reproducible
inside a DON and exactly what bounds what it can say. A `schema` clause knows
the response parsed; it does not know the response was *right*.

This contract judges the part that purity excludes, on dispute rather than per
call, under Optimistic Democracy. It is a second, independent judgment — never
an appeal of the CRE verdict. See docs/roadmap/genlayer.md.
"""

import json
from dataclasses import dataclass

from genlayer import *

# Error prefixes. Validators compare errors, not just successes, so the class of
# a failure has to survive into the message: `[EXPECTED]`/`[EXTERNAL]` must match
# exactly, `[TRANSIENT]` agrees when both sides hit one, `[LLM_ERROR]` always
# disagrees so consensus rotates instead of locking in a broken answer.
ERROR_EXPECTED = '[EXPECTED]'
ERROR_EXTERNAL = '[EXTERNAL]'
ERROR_TRANSIENT = '[TRANSIENT]'
ERROR_LLM = '[LLM_ERROR]'

OUTCOME_OPEN = 'OPEN'
OUTCOME_BREACH = 'BREACH'
OUTCOME_MET = 'MET'
OUTCOME_UNDETERMINED = 'UNDETERMINED'
OUTCOME_CANCELLED = 'CANCELLED'

RESOLVED_OUTCOMES = (OUTCOME_BREACH, OUTCOME_MET, OUTCOME_UNDETERMINED)

# Everything else resolves UNDETERMINED rather than being forced into a verdict.
TEXT_CONTENT_TYPES = ('application/json', 'text/plain', 'text/html')
IMAGE_CONTENT_TYPES = ('image/png', 'image/jpeg')


@allow_storage
@dataclass
class Claim:
    request_id: str
    clause_id: str
    slug: str
    claimant: Address
    # Frozen at submit time and deliberately never re-read. A provider editing
    # its SLA mid-dispute must not be able to change what is being judged — the
    # same protection `failedClause` hashing gives the deterministic side.
    criteria: str
    resolved: bool
    outcome: str
    reasoning: str


class SlaClaimJudge(gl.Contract):
    owner: Address
    # The proxy's apex host, e.g. `https://verdikt-proxy.workers.dev`. Per-slug
    # hosts serve the paid leg; the internal read endpoints live on the apex.
    proxy_base_url: str
    claims: TreeMap[str, Claim]
    claim_keys: DynArray[str]

    def __init__(self, proxy_base_url: str):
        self.owner = gl.message.sender_address
        self.proxy_base_url = proxy_base_url.rstrip('/')

    # ------------------------------------------------------------------ writes

    @gl.public.write
    def submit_claim(self, request_id: str, clause_id: str, slug: str) -> None:
        """
        Open a claim against one semantic clause of one paid call.

        The key is composite: a single verdict can carry several disputable
        semantic clauses, and each is judged on its own evidence.
        """
        key = _claim_key(request_id, clause_id)
        if key in self.claims:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} Claim already exists')

        criteria = self._fetch_criteria(slug, clause_id)

        self.claims[key] = Claim(
            request_id=request_id,
            clause_id=clause_id,
            slug=slug,
            claimant=gl.message.sender_address,
            criteria=criteria,
            resolved=False,
            outcome=OUTCOME_OPEN,
            reasoning='',
        )
        self.claim_keys.append(key)

    @gl.public.write
    def resolve_claim(self, request_id: str, clause_id: str) -> None:
        """Judge an open claim against the evidence the proxy cached for it."""
        key = _claim_key(request_id, clause_id)
        claim = self._require_open(key)

        judgment = self._judge(claim.request_id, claim.criteria)

        claim.outcome = judgment['outcome']
        claim.reasoning = judgment['reasoning']
        claim.resolved = True

    @gl.public.write
    def cancel_claim(self, request_id: str, clause_id: str) -> None:
        """
        The infrastructure-failure escape hatch.

        A claim whose evidence never becomes fetchable would otherwise sit OPEN
        forever with the claimant's stake inside it. Cancelling is always
        available to the claimant and settles nothing against either side.
        """
        key = _claim_key(request_id, clause_id)
        claim = self._require_open(key)
        if gl.message.sender_address != claim.claimant:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} Only the claimant may cancel')

        claim.outcome = OUTCOME_CANCELLED
        claim.reasoning = 'Cancelled by the claimant'
        claim.resolved = True

    # ------------------------------------------------------------------- views

    @gl.public.view
    def get_claim(self, request_id: str, clause_id: str) -> dict:
        key = _claim_key(request_id, clause_id)
        if key not in self.claims:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} No such claim')
        return _claim_to_dict(self.claims[key])

    @gl.public.view
    def list_claims(self) -> list:
        return [_claim_to_dict(self.claims[key]) for key in self.claim_keys]

    @gl.public.view
    def get_config(self) -> dict:
        return {'owner': self.owner.as_hex, 'proxy_base_url': self.proxy_base_url}

    # ---------------------------------------------------------------- internals

    def _require_open(self, key: str) -> Claim:
        if key not in self.claims:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} No such claim')
        claim = self.claims[key]
        if claim.resolved:
            raise gl.vm.UserError(f'{ERROR_EXPECTED} Claim already resolved')
        return claim

    def _fetch_criteria(self, slug: str, clause_id: str) -> str:
        """
        Read the disputed clause's binding text out of the live SLA.

        `strict_eq` is right here and nowhere else in this contract: the SLA is
        a document served byte-for-byte from an ENS text record, so every
        validator fetching it sees the same bytes. The judgment downstream is
        the part that needs a real comparison.
        """
        url = f'{self.proxy_base_url}/internal/sla/{slug}'

        def fetch() -> str:
            res = gl.nondet.web.get(url)
            if res.status == 404:
                raise gl.vm.UserError(f'{ERROR_EXTERNAL} Unknown service: {slug}')
            if 400 <= res.status < 500:
                raise gl.vm.UserError(f'{ERROR_EXTERNAL} SLA read returned {res.status}')
            if res.status >= 500:
                raise gl.vm.UserError(f'{ERROR_TRANSIENT} SLA read unavailable ({res.status})')
            return _decode_body(res.body)

        payload = _parse_json(gl.eq_principle.strict_eq(fetch), 'SLA response')
        sla = payload.get('sla')
        if isinstance(sla, str):
            sla = _parse_json(sla, 'SLA document')
        if not isinstance(sla, dict):
            raise gl.vm.UserError(f'{ERROR_EXTERNAL} Service {slug} publishes no SLA')

        for clause in sla.get('clauses') or []:
            if not isinstance(clause, dict) or clause.get('id') != clause_id:
                continue
            if clause.get('type') != 'semantic':
                raise gl.vm.UserError(f'{ERROR_EXPECTED} Clause {clause_id} is not semantic')
            criteria = clause.get('criteria')
            if not isinstance(criteria, str) or not criteria.strip():
                raise gl.vm.UserError(f'{ERROR_EXPECTED} Clause {clause_id} declares no criteria')
            return criteria

        raise gl.vm.UserError(f'{ERROR_EXPECTED} Clause {clause_id} is not in the SLA')

    def _judge(self, request_id: str, criteria: str) -> dict:
        """
        The one genuinely subjective call, and the reason this runs on GenLayer.

        The validator re-fetches the evidence and re-judges independently, then
        compares the outcome. It deliberately does not inspect the leader's
        reasoning: a validator that only checks the leader's answer is
        well-formed proves formatting, not agreement, and leaves the leader
        deciding alone.
        """
        url = f'{self.proxy_base_url}/internal/evidence/{request_id}'

        def leader_fn() -> dict:
            return _decide(url, criteria)

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return _agree_on_error(leaders_res, leader_fn)
            mine = _decide(url, criteria)
            return mine['outcome'] == leaders_res.calldata['outcome']

        return gl.vm.run_nondet_unsafe(leader_fn, validator_fn)


# --------------------------------------------------------------- module helpers
#
# Free functions rather than methods: `run_nondet_unsafe` cloudpickles the
# closures it is handed, and capturing `self` would drag contract storage
# through that boundary.


def _claim_key(request_id: str, clause_id: str) -> str:
    return f'{request_id}:{clause_id}'


def _claim_to_dict(claim: Claim) -> dict:
    return {
        'request_id': claim.request_id,
        'clause_id': claim.clause_id,
        'slug': claim.slug,
        'claimant': claim.claimant.as_hex,
        'criteria': claim.criteria,
        'resolved': claim.resolved,
        'outcome': claim.outcome,
        'reasoning': claim.reasoning,
    }


def _decode_body(body) -> str:
    if body is None:
        raise gl.vm.UserError(f'{ERROR_EXTERNAL} Empty response body')
    return bytes(body).decode('utf-8', errors='replace')


def _parse_json(text: str, what: str) -> dict:
    try:
        parsed = json.loads(text)
    except Exception:
        raise gl.vm.UserError(f'{ERROR_EXTERNAL} {what} is not valid JSON')
    if not isinstance(parsed, dict):
        raise gl.vm.UserError(f'{ERROR_EXTERNAL} {what} is not a JSON object')
    return parsed


def _undetermined(reason: str) -> dict:
    """
    Every path that cannot honestly reach a conclusion lands here.

    Not an error: `UNDETERMINED` charges neither side, and that is the point.
    Forcing a binary outcome out of incomplete evidence would make missing
    evidence adjudicable, and therefore worth manufacturing.
    """
    return {'outcome': OUTCOME_UNDETERMINED, 'reasoning': reason}


def _decide(evidence_url: str, criteria: str) -> dict:
    envelope = _fetch_evidence(evidence_url)
    if envelope is None:
        return _undetermined('No evidence is available for this request')

    response = envelope.get('response') or {}
    content_type = str(response.get('contentType') or '').split(';')[0].strip().lower()

    if content_type in IMAGE_CONTENT_TYPES:
        return _undetermined('Image evidence is not judged yet')
    if content_type not in TEXT_CONTENT_TYPES:
        return _undetermined(f'Unsupported evidence content type: {content_type or "unknown"}')

    body = response.get('body')
    if not isinstance(body, str) or not body:
        return _undetermined('Evidence envelope carries no response body')

    request = envelope.get('request') or {}
    prompt = _JUDGMENT_PROMPT.format(
        criteria=criteria,
        method=request.get('method') or 'GET',
        url=request.get('url') or '',
        request_body=request.get('body') or '(none)',
        status=response.get('status'),
        content_type=content_type,
        response_body=body,
    )
    return _judgment_from(gl.nondet.exec_prompt(prompt, response_format='json'))


def _fetch_evidence(url: str):
    res = gl.nondet.web.get(url)
    # 404 means the proxy is not serving evidence for this request: no claim
    # opened, provider never opted in, or the window has closed. None of those
    # is an error — they are all reasons a judgment cannot be reached.
    if res.status == 404:
        return None
    if 400 <= res.status < 500:
        raise gl.vm.UserError(f'{ERROR_EXTERNAL} Evidence read returned {res.status}')
    if res.status >= 500:
        raise gl.vm.UserError(f'{ERROR_TRANSIENT} Evidence read unavailable ({res.status})')
    return _parse_json(_decode_body(res.body), 'Evidence envelope')


def _judgment_from(analysis) -> dict:
    if not isinstance(analysis, dict):
        raise gl.vm.UserError(f'{ERROR_LLM} Judgment was not an object: {type(analysis)}')

    raw = analysis.get('outcome')
    if raw is None:
        for alt in ('verdict', 'result', 'decision'):
            if alt in analysis:
                raw = analysis[alt]
                break
    outcome = str(raw or '').strip().upper()
    if outcome not in RESOLVED_OUTCOMES:
        raise gl.vm.UserError(f'{ERROR_LLM} Judgment named no known outcome: {raw!r}')

    reasoning = analysis.get('reasoning') or analysis.get('analysis') or ''
    return {'outcome': outcome, 'reasoning': str(reasoning)[:1024]}


def _agree_on_error(leaders_res, leader_fn) -> bool:
    leader_msg = getattr(leaders_res, 'message', '')
    try:
        leader_fn()
        # The leader failed where we succeeded: disagree rather than ratify a
        # failure that was not reproducible.
        return False
    except gl.vm.UserError as e:
        mine = getattr(e, 'message', str(e))
        if mine.startswith(ERROR_EXPECTED) or mine.startswith(ERROR_EXTERNAL):
            return mine == leader_msg
        if mine.startswith(ERROR_TRANSIENT) and leader_msg.startswith(ERROR_TRANSIENT):
            return True
        return False
    except Exception:
        return False


_JUDGMENT_PROMPT = """\
You are adjudicating whether an API response satisfied a service-level promise.

THE PROMISE (binding text, authored by the provider):
{criteria}

THE REQUEST THAT WAS PAID FOR:
{method} {url}
Body: {request_body}

THE RESPONSE THAT WAS DELIVERED:
HTTP {status}, Content-Type: {content_type}
{response_body}

Decide one of exactly three outcomes:
- "MET": the response satisfies the promise.
- "BREACH": the response does not satisfy the promise.
- "UNDETERMINED": the evidence is insufficient or contradictory to decide \
either way. Use this only when you genuinely cannot decide, not when the \
answer is merely imperfect.

Judge only against the promise quoted above. Do not apply standards it does \
not state. A response that is ugly, terse, or unhelpful but still satisfies \
the promise is "MET".

Respond with JSON only, no prose before or after:
{{"outcome": "MET" | "BREACH" | "UNDETERMINED", "reasoning": "one or two sentences"}}
"""
