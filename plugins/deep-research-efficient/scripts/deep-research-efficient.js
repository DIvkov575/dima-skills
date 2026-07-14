export const meta = {
  name: 'deep-research-efficient',
  description: 'Deep research harness — budget-bounded + model-tiered. fan-out web search, fetch, adversarially verify, synthesize.',
  whenToUse: 'Cheaper variant of deep-research. Pass args as a STRING (question, runs in "balanced" mode) or an OBJECT {question, mode, votes, fetch, claims, angles}. Modes: quick | balanced | thorough. Respects a "+Nk" budget directive via budget.total.',
  phases: [{"title":"Scope","detail":"decompose into N angles"},{"title":"Search","detail":"haiku searchers, one per angle"},{"title":"Fetch","detail":"haiku extractors, top-K sources"},{"title":"Verify","detail":"V-vote adversarial (capable model)"},{"title":"Synthesize","detail":"capable model, cited report"}],
}

// Efficiency vs the built-in deep-research:
//  - Model tiering: search/fetch use haiku+low effort (mechanical); verify/synth use the capable
//    model (judgment). The built-in runs everything on the capable model.
//  - Tunable fan-out via mode/args: votes, fetch count, claim count, angle count.
//  - Hard budget gate: if a "+Nk" directive set budget.total, verification scales down to fit.
//  - cost ≈ 1 + angles + sources + claims*votes + 1; the claims*votes term dominates → it's the
//    main knob. quick mode (1 vote, 8 claims) is ~6-10x cheaper than the built-in (3 votes, 25 claims).

// ─── Parse args: string question OR {question, mode, ...overrides} ───
const A = (typeof args === "object" && args) ? args : {}
const QUESTION = (typeof args === "string" ? args : A.question || "").trim()
if (!QUESTION) {
  return { error: "No question. Pass a string, or {question, mode}. Modes: quick|balanced|thorough." }
}
const MODE = A.mode || "balanced"
// votes = TOTAL votes a surviving claim receives (escalation target).
// Verification is two-stage: a cheap 1-vote screen on ALL claims, then
// screen-survivors escalate to `votes` total for a real majority. You pay the
// extra votes only on claims that would enter the report, not the many killed
// cheaply. This keeps single-skeptic *kills* (cheap, safe due to default-refuted
// bias) while preventing a lone skeptic from *passing* a bad claim into output.
const PRESET = {
  quick:    { angles: 3, fetch: 8,  claims: 8,  votes: 3 },
  balanced: { angles: 5, fetch: 12, claims: 15, votes: 3 },
  thorough: { angles: 6, fetch: 15, claims: 25, votes: 5 },
}[MODE] || { angles: 5, fetch: 12, claims: 15, votes: 3 }

// explicit args override the preset
const N_ANGLES = A.angles ?? PRESET.angles
const MAX_FETCH = A.fetch ?? PRESET.fetch
let MAX_VERIFY_CLAIMS = A.claims ?? PRESET.claims
const VOTES_PER_CLAIM = A.votes ?? PRESET.votes        // total votes for an escalated claim
const REFUTATIONS_REQUIRED = Math.max(1, Math.ceil(VOTES_PER_CLAIM / 2))

const FAST = { model: "haiku", effort: "low" }   // mechanical stages
// verify/synth inherit the session (capable) model — judgment stages

// ─── Budget gate: if "+Nk" set a target, cap verification spend to fit ───
// Escalation cost ≈ screen (1 vote/claim) + escalation ((votes-1) on ~half that
// survive the screen) ≈ claims * (1 + (votes-1)/2) votes. ~6k output tokens/vote.
if (budget.total) {
  const perVote = 6000
  const avgVotesPerClaim = 1 + (VOTES_PER_CLAIM - 1) / 2
  const affordable = Math.floor((budget.remaining() * 0.6) / (perVote * avgVotesPerClaim))
  if (affordable < MAX_VERIFY_CLAIMS) {
    log("Budget gate: capping verify claims " + MAX_VERIFY_CLAIMS + " → " + Math.max(3, affordable))
    MAX_VERIFY_CLAIMS = Math.max(3, affordable)
  }
}

// ─── Schemas ───
const SCOPE_SCHEMA = {
  type: "object", required: ["question", "angles", "summary"],
  properties: {
    question: { type: "string" }, summary: { type: "string" },
    angles: { type: "array", minItems: 2, maxItems: 6, items: {
      type: "object", required: ["label", "query"],
      properties: { label: { type: "string" }, query: { type: "string" }, rationale: { type: "string" } },
    }},
  },
}
const SEARCH_SCHEMA = {
  type: "object", required: ["results"],
  properties: { results: { type: "array", maxItems: 6, items: {
    type: "object", required: ["url", "title", "relevance"],
    properties: { url: { type: "string" }, title: { type: "string" }, snippet: { type: "string" }, relevance: { enum: ["high", "medium", "low"] } },
  }}},
}
const EXTRACT_SCHEMA = {
  type: "object", required: ["claims", "sourceQuality"],
  properties: {
    sourceQuality: { enum: ["primary", "secondary", "blog", "forum", "unreliable"] },
    publishDate: { type: "string" },
    claims: { type: "array", maxItems: 5, items: {
      type: "object", required: ["claim", "quote", "importance"],
      properties: { claim: { type: "string" }, quote: { type: "string" }, importance: { enum: ["central", "supporting", "tangential"] } },
    }},
  },
}
const VERDICT_SCHEMA = {
  type: "object", required: ["refuted", "evidence", "confidence"],
  properties: { refuted: { type: "boolean" }, evidence: { type: "string" }, confidence: { enum: ["high", "medium", "low"] }, counterSource: { type: "string" } },
}
const REPORT_SCHEMA = {
  type: "object", required: ["summary", "findings", "caveats"],
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: {
      type: "object", required: ["claim", "confidence", "sources", "evidence"],
      properties: { claim: { type: "string" }, confidence: { enum: ["high", "medium", "low"] }, sources: { type: "array", items: { type: "string" } }, evidence: { type: "string" }, vote: { type: "string" } },
    }},
    caveats: { type: "string" }, openQuestions: { type: "array", items: { type: "string" } },
  },
}

// ─── Scope ───
phase("Scope")
const scope = await agent(
  "Decompose this research question into " + N_ANGLES + " complementary web search angles.\n\n## Question\n" + QUESTION + "\n\n" +
  "Generate exactly " + N_ANGLES + " distinct, non-redundant search queries covering different angles (broad/primary · technical · recent · contrarian · practitioner — adapt to the domain). " +
  "Return the question, a 1-sentence strategy, and the angles. Structured output only.",
  { label: "scope", schema: SCOPE_SCHEMA }
)
if (!scope) return { error: "Scope agent returned no result." }
log("Q: " + QUESTION.slice(0, 80))
log("Mode=" + MODE + " | angles=" + scope.angles.length + " fetch=" + MAX_FETCH + " claims=" + MAX_VERIFY_CLAIMS + " votes=" + VOTES_PER_CLAIM)

// ─── Dedup state ───
const normURL = u => { try { const p = new URL(u); return (p.hostname.replace(/^www\./, "") + p.pathname.replace(/\/$/, "")).toLowerCase() } catch { return u.toLowerCase() } }
const seen = new Map(); const dupes = []; const budgetDropped = []
const relRank = { high: 0, medium: 1, low: 2 }
let fetchSlots = MAX_FETCH

const SEARCH_PROMPT = (angle) =>
  "## Web Searcher: " + angle.label + "\nQuestion: \"" + QUESTION + "\"\nAngle: " + angle.label + " — " + (angle.rationale || "") + "\nQuery: `" + angle.query + "`\n\n" +
  "Use WebSearch. Return top 4-6 results ranked by relevance to the ORIGINAL question. Skip SEO spam. Structured output only."

const FETCH_PROMPT = (source, angle) =>
  "## Source Extractor\nQuestion: \"" + QUESTION + "\"\nURL: " + source.url + "\nTitle: " + source.title + "\n\n" +
  "1. WebFetch the page. 2. Rate source quality. 3. Extract 2-5 FALSIFIABLE claims bearing on the question, each w/ a direct quote and central/supporting/tangential rating. " +
  "If fetch fails/paywalled/irrelevant: claims: [], sourceQuality: \"unreliable\". Structured output only."

const VERIFY_PROMPT = (claim, v, total) =>
  "## Adversarial Verifier (voter " + (v + 1) + "/" + total + ")\nBe SKEPTICAL; try to REFUTE.\n\nQuestion: " + QUESTION + "\nClaim: \"" + claim.claim + "\"\nSource: " + claim.sourceUrl + " (" + claim.sourceQuality + ")\nQuote: \"" + claim.quote + "\"\n\n" +
  "Check: quote actually supports claim? contradicting evidence (WebSearch)? source quality matches claim strength? outdated? marketing/cherry-picked? " +
  "refuted=true if unsupported/contradicted/weak-source/outdated/fluff. refuted=false ONLY if well-supported, current, adequately sourced. Default refuted=true if uncertain. Structured output only; evidence must be specific."

// ─── Search → dedup → fetch (haiku) ───
const searchResults = await pipeline(
  scope.angles,
  angle => agent(SEARCH_PROMPT(angle), { label: "search:" + angle.label, phase: "Search", schema: SEARCH_SCHEMA, ...FAST })
    .then(r => { if (!r) return null; log(angle.label + ": " + r.results.length + " results"); return { angle: angle.label, results: r.results } }),
  searchResult => {
    const sorted = [...searchResult.results].sort((a, b) => relRank[a.relevance] - relRank[b.relevance])
    const novel = sorted.filter(r => {
      const key = normURL(r.url)
      if (seen.has(key)) { dupes.push({ ...r, dupOf: seen.get(key) }); return false }
      if (fetchSlots <= 0 && relRank[r.relevance] >= 1) { budgetDropped.push({ ...r }); return false }
      seen.set(key, { angle: searchResult.angle, title: r.title }); fetchSlots--; return true
    })
    return parallel(novel.map(source => () => {
      let host = "unknown"; try { host = new URL(source.url).hostname.replace(/^www\./, "") } catch {}
      return agent(FETCH_PROMPT(source, searchResult.angle), { label: "fetch:" + host, phase: "Fetch", schema: EXTRACT_SCHEMA, ...FAST })
        .then(ext => { if (!ext) return null; return { url: source.url, title: source.title, angle: searchResult.angle, sourceQuality: ext.sourceQuality, publishDate: ext.publishDate, claims: ext.claims.map(c => ({ ...c, sourceUrl: source.url, sourceQuality: ext.sourceQuality })) } })
        .catch(e => { log("fetch failed: " + source.url); return { url: source.url, title: source.title, angle: searchResult.angle, sourceQuality: "unreliable", claims: [] } })
    }))
  }
)

const allSources = searchResults.flat().filter(Boolean)
const allClaims = allSources.flatMap(s => s.claims)
const impRank = { central: 0, supporting: 1, tangential: 2 }
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 }
const rankedClaims = [...allClaims]
  .sort((a, b) => (impRank[a.importance] - impRank[b.importance]) || (qualRank[a.sourceQuality] - qualRank[b.sourceQuality]))
  .slice(0, MAX_VERIFY_CLAIMS)
log("Fetched " + allSources.length + " sources → " + allClaims.length + " claims → verifying top " + rankedClaims.length)

if (rankedClaims.length === 0) {
  return { question: QUESTION, summary: "No claims extracted from " + allSources.length + " sources.", findings: [], refuted: [], sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality })), stats: { mode: MODE, angles: scope.angles.length, sources: allSources.length, claims: 0 } }
}

// ─── Verify: two-stage escalation (capable model) ───
// Stage 1 screen: 1 skeptic per claim. A refute kills it cheaply (safe — the
// prompt's default-refuted bias makes a lone kill conservative). A pass only
// makes the claim a *candidate*. Stage 2: screen-passers escalate to
// VOTES_PER_CLAIM total votes, so no single skeptic can pass a claim into the
// report. Cost ≈ claims*1 (screen) + survivors*(votes-1) (escalation), vs the
// old claims*votes flat — far cheaper since most claims die at the screen.
phase("Verify")

const screenedRaw = await parallel(rankedClaims.map(claim => () =>
  agent(VERIFY_PROMPT(claim, 0, VOTES_PER_CLAIM), { label: "screen:" + claim.claim.slice(0, 36), phase: "Verify", schema: VERDICT_SCHEMA })
    .then(verdict => ({ claim, screen: verdict }))
))
const screened = screenedRaw.filter(r => r && r.screen)   // drop null/abstained screens

const screenKilled = screened.filter(r => r.screen.refuted)
const screenPassed = screened.filter(r => !r.screen.refuted)
log("Screen: " + screenPassed.length + "/" + screened.length + " passed (1-vote); " + screenKilled.length + " killed cheaply")

// Escalate only screen-passers to a full majority (skip if votes==1)
const escalatedRaw = await parallel(screenPassed.map(({ claim, screen }) => () => {
  const extra = VOTES_PER_CLAIM - 1
  if (extra <= 0) return Promise.resolve({ claim, verdicts: [screen] })
  return parallel(Array.from({ length: extra }, (_, i) => () =>
    agent(VERIFY_PROMPT(claim, i + 1, VOTES_PER_CLAIM), { label: "v" + (i + 1) + ":" + claim.claim.slice(0, 36), phase: "Verify", schema: VERDICT_SCHEMA })
  )).then(more => ({ claim, verdicts: [screen, ...more.filter(Boolean)] }))
}))
const escalated = escalatedRaw.filter(Boolean)

const voted = [
  // screen-killed claims: record as a finished 0-1 verdict (refuted)
  ...screenKilled.map(({ claim, screen }) => ({ ...claim, verdicts: [screen], refutedVotes: 1, survives: false })),
  // escalated claims: majority over the full vote set
  ...escalated.map(({ claim, verdicts }) => {
    const refuted = verdicts.filter(v => v.refuted).length
    const survives = verdicts.length >= REFUTATIONS_REQUIRED && refuted < REFUTATIONS_REQUIRED
    log("\"" + claim.claim.slice(0, 50) + "…\": " + (verdicts.length - refuted) + "-" + refuted + " " + (survives ? "✓" : "✗"))
    return { ...claim, verdicts, refutedVotes: refuted, survives }
  }),
]

const confirmed = voted.filter(c => c.survives)
const killed = voted.filter(c => !c.survives)
const verifyCalls = screened.length + escalated.reduce((n, e) => n + Math.max(0, e.verdicts.length - 1), 0)
log("Verify done: " + voted.length + " → " + confirmed.length + " confirmed, " + killed.length + " killed (" + verifyCalls + " verify calls)")

if (confirmed.length === 0) {
  return { question: QUESTION, summary: "All " + voted.length + " claims refuted. Inconclusive.", findings: [], refuted: killed.map(c => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes, source: c.sourceUrl })), stats: { mode: MODE, confirmed: 0, killed: killed.length } }
}

// ─── Synthesize (capable model) ───
phase("Synthesize")
const confRank = { high: 0, medium: 1, low: 2 }
const block = confirmed.map((c, i) => {
  const best = c.verdicts.filter(v => !v.refuted).sort((a, b) => confRank[a.confidence] - confRank[b.confidence])[0]
  return "### [" + i + "] " + c.claim + "\nVote " + (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes + " · " + c.sourceUrl + " (" + c.sourceQuality + ")\nQuote: \"" + c.quote + "\"\nEvidence (" + (best ? best.confidence : "?") + "): " + (best ? best.evidence : "") + "\n"
}).join("\n")

const report = await agent(
  "## Synthesis\n**Question:** " + QUESTION + "\n\n" + confirmed.length + " claims survived " + VOTES_PER_CLAIM + "-vote verification.\n\n## Confirmed\n" + block + "\n\n" +
  "1. Merge duplicate claims (combine sources). 2. Group into findings addressing the question. 3. Confidence per finding (high=multi primary/unanimous, medium=secondary/split, low=single/blog). 4. 3-5 sentence summary. 5. Caveats. 6. 2-4 open questions. Structured output only.",
  { label: "synthesize", schema: REPORT_SCHEMA }
)
if (!report) {
  return { question: QUESTION, summary: "Synthesis failed — " + confirmed.length + " verified claims unmerged.", findings: [], confirmed: confirmed.map(c => ({ claim: c.claim, source: c.sourceUrl })), stats: { mode: MODE, confirmed: confirmed.length } }
}

return {
  question: QUESTION, ...report,
  refuted: killed.map(c => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes, source: c.sourceUrl })),
  sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality, angle: s.angle, claimCount: s.claims.length })),
  stats: {
    mode: MODE, angles: scope.angles.length, sourcesFetched: allSources.length,
    claimsExtracted: allClaims.length, claimsVerified: voted.length,
    confirmed: confirmed.length, killed: killed.length, afterSynthesis: report.findings.length,
    urlDupes: dupes.length, budgetDropped: budgetDropped.length,
    verifyCalls,
    agentCalls: 1 + scope.angles.length + allSources.length + verifyCalls + 1,
  },
}
