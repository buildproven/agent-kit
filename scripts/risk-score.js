#!/usr/bin/env node
"use strict";

/**
 * risk-score.js — kit-native review-depth scorer.
 *
 * Computes a 0–100 risk score for the current change from `git diff` alone, so
 * the quality skill can scale machine-review depth (Claude agent count, Codex
 * effort, Codex rounds) proportionally. Works in ANY repo with zero per-repo
 * setup: built-in defaults cover the common cases; a repo's harness-config.json
 * (scorePolicy/securityFloor/mergeAuthority) is merged over the defaults when
 * present.
 *
 * Why this exists: review is machine-only (Claude finds, Codex verifies) on
 * flat-rate subscriptions, so the real cost is wall-clock. Running the full
 * 6-agent + Codex-adversarial pass on a one-line comment change is pure waste;
 * skipping depth on a security-surface change is dangerous. The score scales
 * depth between those — but never to zero. Merge authority is a separate,
 * explicit policy: autonomous by default, with manual governance available as
 * an opt-in for repositories that need it.
 *
 * Design constraints:
 *   - Zero runtime dependencies (must run in 23 repos with no node_modules).
 *   - Deterministic + explainable (every score ships a `reasons[]` trail).
 *   - Conservative: mechanical/size heuristics can only LOWER score off a
 *     non-sensitive base, never below the security floor; magnitude only raises.
 *
 * Output (JSON to stdout, or GITHUB_OUTPUT lines when that env is set):
 *   { riskScore, taskType, changeNature, diffStats, reasons, knobs }
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
// Shared, single-sourced change-nature primitives (see risk-change-nature.js).
// Formerly duplicated here and in scripts/risk-policy-gate.js — extracted to end
// the drift. This file keeps only its own `fileIsMechanical` (which legitimately
// differs from the setup gate's dep-bump/generated-path variant) and injects it.
const {
  patchIsCommentWhitespaceOnly,
  patchIsAdditiveOnly,
  isTestPath,
  isForcedLogic,
  classifyChangeNature: classifyChangeNatureShared,
} = require("./risk-change-nature");

const CRITICAL_RISK_SCORE = 75;

// ---------------------------------------------------------------------------
// Built-in defaults (overridable via harness-config.json: scorePolicy)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  // Review risk controls how deeply the system verifies a change; it is not a
  // proxy for whether an operator must type an approval command. New quality
  // campaigns merge autonomously once their revision-bound evidence is clean.
  // A repository can explicitly retain the legacy signed human capability by
  // setting scorePolicy.mergeAuthority to "human-required".
  mergeAuthority: "autonomous",
  // A direct protected-branch ref-CAS cannot atomically bind a concurrent PR
  // close or retarget. Keep that transaction signed-only unless the repository
  // commits an explicit, reviewable acceptance of this exact cancellation risk.
  protectedNonstrictRefCas: "signed-only",
  // Path → base score. First matching tier wins (most-sensitive first).
  // Security surface pins a high floor regardless of change nature.
  securityFloor: [
    "**/.github/workflows/**",
    "**/.husky/**",
    "**/*.husky/**",
    "**/auth/**",
    "**/*auth*/**",
    "**/licensing*.*",
    "**/license*.*",
    "**/*licens*/**",
    "**/*secret*",
    "**/*secret*/**",
    "**/*credential*",
    "**/*credential*/**",
    "**/*password*",
    "**/*password*/**",
    "**/*passwd*",
    "**/*passwd*/**",
    "**/*token*",
    "**/*token*/**",
    "**/deploy*.*",
    "**/*deploy-*.*",
    "**/*deploy*/**",
    "**/install.sh",
    "**/webhook*.*",
    "**/*webhook*/**",
    "**/key/**",
    "**/keys/**",
    "**/*-key/**",
    "**/*-keys/**",
    "**/*_key/**",
    "**/*_keys/**",
    "**/key*/**",
    "**/*-key*/**",
    "**/*_key*/**",
    "**/*keystore*/**",
    "**/*keyring*/**",
    "**/*keychain*/**",
    "**/key.*",
    "**/keys.*",
    "**/key-*.*",
    "**/key_*.*",
    "**/*-key*.*",
    "**/*_key*.*",
    "**/*apikey*.*",
    "**/*privatekey*.*",
    "**/*secretkey*.*",
    "**/*accesskey*.*",
    "**/*signingkey*.*",
    "**/*keystore*.*",
    "**/*keyring*.*",
    "**/*keychain*.*",
    "**/middleware.*",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/*.pfx",
    "**/*.jks",
    "**/*.keystore",
    "**/*.ppk",
    "**/*.pk8",
    "**/*.kdb",
    "**/*.kdbx",
    "**/id_rsa*",
    "**/id_dsa*",
    "**/id_ecdsa*",
    "**/id_ed25519*",
    "**/.env*",
    "**/harness-config.json",
  ],
  // The legacy manual-governance subset of the security floor. It is evaluated
  // only when a repository explicitly selects mergeAuthority=human-required.
  // Repositories may EXTEND this list via scorePolicy.humanFloor, but cannot
  // remove the built-in minimum: policy from the reviewed revision must never
  // relax its own manually governed surface.
  // Matched CASE-INSENSITIVELY (see touchesHumanFloor) so AUTH/, .PEM, .Env
  // cannot evade by casing. Token-broad on purpose: a floor that misses id_rsa,
  // .p12, oauth, or password is not a floor (Codex + security-auditor review).
  humanFloor: [
    "**/auth/**",
    "**/*auth*", // oauth, authn, authz, auth-config …
    "**/*auth*/**",
    "**/licensing*.*",
    "**/license*.*",
    "**/*licens*/**",
    "**/*secret*",
    "**/*secret*/**",
    "**/*credential*",
    "**/*credential*/**",
    "**/*password*",
    "**/*password*/**",
    "**/*passwd*",
    "**/*passwd*/**",
    "**/*token*",
    "**/*token*/**",
    "**/deploy/**",
    "**/deploy*.*",
    "**/*deploy-*.*",
    "**/*deploy*/**",
    "**/webhook*.*",
    "**/*webhook*/**",
    "**/key/**",
    "**/keys/**",
    "**/*-key/**",
    "**/*-keys/**",
    "**/*_key/**",
    "**/*_keys/**",
    "**/key*/**",
    "**/*-key*/**",
    "**/*_key*/**",
    "**/*keystore*/**",
    "**/*keyring*/**",
    "**/*keychain*/**",
    "**/key.*",
    "**/keys.*",
    "**/key-*.*",
    "**/key_*.*",
    "**/*-key*.*",
    "**/*_key*.*",
    "**/*apikey*.*",
    "**/*privatekey*.*",
    "**/*secretkey*.*",
    "**/*accesskey*.*",
    "**/*signingkey*.*",
    "**/*keystore*.*",
    "**/*keyring*.*",
    "**/*keychain*.*",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/*.pfx",
    "**/*.jks",
    "**/*.keystore",
    "**/*.ppk",
    "**/*.pk8",
    "**/*.kdb",
    "**/*.kdbx",
    "**/id_rsa*",
    "**/id_dsa*",
    "**/id_ecdsa*",
    "**/id_ed25519*",
    "**/.env*",
    "**/harness-config.json",
  ],
  // High-sensitivity (non-floor) source paths.
  high: ["**/api/**", "**/server/**", "**/db/**", "**/payments/**"],
  // Low-sensitivity paths.
  low: [
    "**/*.md",
    "**/docs/**",
    "**/LICENSE",
    "**/CHANGELOG*",
    "**/__tests__/**",
    "**/tests/**",
    "**/test/**",
    "**/*.test.*",
    "**/*.spec.*",
  ],
  base: {
    securityFloor: 85, // pinned floor for sensitive surface
    high: 60,
    medium: 35, // default for unclassified source
    low: 10,
  },
  // Path patterns from securityFloor whose floor classification is
  // content-gated rather than an unconditional path pin (BUI-381). A file
  // matching one of these still starts in securityFloor's path tier, but is
  // only actually HELD at the floor score if its diff touches risk-bearing
  // content (see workflowDiffIsRiskBearing); otherwise it is downgraded to
  // the `high` tier so a one-line comment/version-pin edit doesn't force the
  // same critical-tier review as a permissions/secrets/run: rewrite.
  contentAwareFloor: ["**/.github/workflows/**"],
  mechanicalDelta: -25, // bounded subtraction for mechanical changes
  magnitude: {
    // Diff size adds risk and caps how far mechanical can subtract.
    linesForSmall: 50, // ≤ this: no size add
    linesForLarge: 600, // ≥ this: full size add
    maxAdd: 20, // max points added by size
    capMechanicalAboveLines: 400, // large diffs cannot be treated as low-risk
  },
  // Score → review depth. Moderate curve (user-chosen).
  curve: [
    { maxScore: 20, agents: 0, codex: "skip", codexRounds: 0 },
    { maxScore: 50, agents: 1, codex: "high", codexRounds: 1 },
    {
      maxScore: CRITICAL_RISK_SCORE - 1,
      agents: 1,
      codex: "high",
      codexRounds: 1,
    },
    { maxScore: 100, agents: 2, codex: "xhigh", codexRounds: 1 },
  ],
  // Score ≥ this always runs Codex even if the band says skip.
  codexForceFloor: 75,
};

// ---------------------------------------------------------------------------
// Tiny zero-dependency glob matcher (subset: ** * ? and literals)
// ---------------------------------------------------------------------------

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** → match across path separators (and an optional trailing /)
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // collapse **/ so it can match zero dirs
      } else {
        re += "[^/]*"; // * → within a single segment
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  // Git permits control characters, including newlines, in path segments.
  // DotAll keeps `**` faithful to "any characters across separators"; without
  // it, `safe\n/auth/session.js` evades an otherwise matching `**/auth/**`.
  return new RegExp("^" + re + "$", "s");
}

const _matcherCache = new Map();
function matchesPattern(filepath, patterns) {
  for (const pattern of patterns || []) {
    let rx = _matcherCache.get(pattern);
    if (!rx) {
      rx = globToRegExp(pattern);
      _matcherCache.set(pattern, rx);
    }
    if (rx.test(filepath)) return true;
  }
  return false;
}

function normalizeFloorPath(file) {
  return String(file).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function hasControlCharacters(file) {
  return Array.from(String(file)).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function additiveFloorPatterns(defaultPatterns, configuredPatterns) {
  const configured = Array.isArray(configuredPatterns)
    ? configuredPatterns
    : [];
  return [
    ...new Set(
      [...defaultPatterns, ...configured].map((pattern) =>
        pattern.toLowerCase(),
      ),
    ),
  ];
}

function effectiveSecurityFloor(cfg = DEFAULTS) {
  return additiveFloorPatterns(
    [...DEFAULTS.securityFloor, ...DEFAULTS.humanFloor],
    cfg?.securityFloor,
  );
}

// Extensions whose contents are prose, not executable or credential-bearing
// material. A file with one of these extensions cannot reach the security floor
// on the strength of its NAME alone.
//
// Why: the floor patterns are deliberately token-broad (`**/*key*.*`,
// `**/*token*.*`, `**/*deploy*.*`) so that id_rsa, .p12, and oauth-config
// cannot evade them. Applied to prose, that same breadth misfires badly —
// `docs/monkey.md` matches `**/*key*.*`, and `docs/token-budget.md` matches
// `**/*token*.*`. Both scored 85 (critical band) purely because of a substring
// in the filename, which forced a full mutation + xhigh-Codex campaign onto a
// documentation edit and blocked the mechanical downgrade that would otherwise
// apply.
//
// This does NOT weaken the floor for credential MATERIAL. A .pem/.key/.p12/.env
// keeps the floor even under a prose suffix (see CREDENTIAL_STEM), prose inside
// a sensitive directory keeps it (PROSE_DIRECTORY_FLOOR), credential-shaped
// basenames keep it (hasCredentialToken + PROSE_NAME_FLOOR), and anything whose
// CONTENT is sensitive is still caught by the secret scanners.
//
// DELIBERATE TRADE-OFF, decided rather than inherited: prose *named after* a
// security topic — `docs/auth.md`, `docs/token.md`, `docs/deploy.md`,
// `docs/middleware.md` — does drop from the critical band to ordinary review.
// These are files ABOUT the protected surface, not the surface itself, and
// treating every such document as critical is what produced the 44%-critical
// rate this change exists to fix. Two things bound the risk: the human floor
// (touchesHumanFloor) is untouched and still catches them for manual-governance
// repos, and any real secret pasted into one is caught by content scanning
// rather than by its filename. Revisit by extending PROSE_NAME_FLOOR if a
// specific document turns out to warrant the floor on its name alone.
//
// One exception to the human-floor backstop: `middleware.*` is in
// DEFAULTS.securityFloor but NOT in DEFAULTS.humanFloor, so `docs/middleware.md`
// is off both. Accepted — a middleware design doc is genuinely prose — but
// stated here so the backstop is not read as universal.
//
// WHERE THE LINE IS, precisely. Decoration around a credential noun keeps the
// floor (`secrets (1).md`, `token .md`, `password copy.txt`) because the stem
// still IS the noun. An alphanumeric SUFFIX does not (`token0.md`, `tokenA.md`)
// because it is indistinguishable from ordinary word-formation: the same
// substring rule that would catch `token0` also catches `tokenizer.md`,
// `secretary.md`, `passwordless.md`, and `token-budget.md` — which the original
// floor did catch, and which are the precise false positives this change
// exists to remove. There is no filename-only test that separates `token0`
// from `tokenizer`, so this boundary is a deliberate limit of name-based
// classification, not an oversight. Content scanning, not the path floor, is
// what catches a secret pasted into `token0.md`.
const PROSE_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".markdown",
  ".txt",
  ".rst",
  ".adoc",
]);

// The narrowing above applies to the FILENAME only. Prose that lives inside a
// security-sensitive DIRECTORY keeps the floor: `secrets/rotation.md`,
// `auth/README.md`, and `keys/README.txt` are runbooks for the very surface the
// floor exists to protect, and an edit to them is a security-relevant change
// even though the file is Markdown.
//
// So: a prose file escapes the floor only when every floor pattern it matches
// is satisfied by its own basename. If any floor pattern matches by virtue of a
// parent directory, the floor still applies.
const PROSE_DIRECTORY_FLOOR = [
  // CI and hook directories are the top-tier supply-chain surface: a .md or
  // .txt added under .github/workflows/ is exactly the shape used to smuggle
  // content a workflow later reads. These were missing from the first draft of
  // this list, which silently dropped `.github/workflows/README.md` off the
  // floor — the most sensitive directories in DEFAULTS.securityFloor.
  "**/.github/workflows/**",
  "**/.husky/**",
  "**/*.husky/**",
  "**/security/**",
  "**/*secret*/**",
  "**/*credential*/**",
  "**/auth/**",
  "**/*auth*/**",
  "**/key/**",
  "**/keys/**",
  "**/*key*/**",
  "**/*token*/**",
  "**/*password*/**",
  "**/*passwd*/**",
  "**/*licens*/**",
  "**/deploy/**",
  "**/*deploy*/**",
  "**/*webhook*/**",
  "**/*keystore*/**",
  "**/*keyring*/**",
  "**/*keychain*/**",
];

// Credential-bearing stems that keep the floor even under a prose extension.
// A prose SUFFIX must not launder a credential filename: `.env.md`,
// `id_rsa.txt`, and `cert.pem.md` are routine ways to stage or leak secret
// material, and classifying by the LAST extension alone lets all three through.
// These are tested against the basename with prose extensions stripped.
const CREDENTIAL_STEM = [
  "**/.env*",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.ppk",
  "**/*.pk8",
  "**/*.kdb",
  "**/*.kdbx",
  // The same laundering trick applies along the NOUN axis, not just the
  // key-material-extension axis: `token.json.md` and `access_token.yaml.md`
  // strip to `token.json` / `access_token.yaml`, which the original floor
  // caught via `**/*token*`. Fixing only the extensions left this class open —
  // the same "fixed the named instances, not the class" error twice over.
  "**/*token*.*",
  "**/*secret*.*",
  "**/*password*.*",
  "**/*passwd*.*",
  "**/*credential*.*",
];

// Prose whose own name marks it as a security document keeps the floor too.
//
// This list also covers names that may denote the CREDENTIAL ITSELF rather than
// writing about one. `src/api-key.txt` is far more likely to be a pasted key
// than an essay, so a credential-shaped basename keeps the floor even with a
// prose extension. Only descriptive/compound names (monkey, token-budget,
// auth-guide) are allowed through.
const PROSE_NAME_FLOOR = [
  "**/threat-model*.*",
  "**/*security-policy*.*",
  "**/*secret*-policy*.*",
  "**/*passwd*.*",
  // Exact-stem, both numbers. Hardcoding only the plurals meant
  // `secrets.json.md` kept the floor while `secret.json.md` did not — an
  // asymmetry with no defensible reading. These must stay exact-stem globs:
  // widening to `**/*token*.*` here would drag `docs/token-budget.md` back into
  // the critical band and undo the change this PR exists to make.
  "**/credential.*",
  "**/credentials.*",
  "**/secret.*",
  "**/secrets.*",
  "**/password.*",
  "**/passwords.*",
  "**/token.*",
  "**/tokens.*",
  // Compound credential nouns anywhere in the basename. These are names for the
  // secret itself rather than writing about one, and the original floor caught
  // every one via `**/*apikey*.*` and friends. Distinct from hasCredentialToken
  // above, which handles the separated `<qualifier>-key` forms.
  "**/*apikey*.*",
  "**/*privatekey*.*",
  "**/*secretkey*.*",
  "**/*accesskey*.*",
  "**/*signingkey*.*",
  "**/*keystore*.*",
  "**/*keyring*.*",
  "**/*keychain*.*",
];

// Credential-shaped basenames such as `api-key.txt`, `apikey.txt`, or
// `access_key.txt`: the file may BE the credential rather than prose about one.
// Expressed as a regex rather than a glob because the distinction is
// "<qualifier>key" as a whole word-ish token — `api-keyboard.md` must NOT match,
// and a `?` single-char glob both misses `apikey` and catches `api-keyboard`.
// Anchored to the BASENAME so `monkey.md` and `api-keyboard.md` are excluded:
// the token before "key" must be a real qualifier, or "key"/"keys" must stand
// alone as the whole stem.
//
// An optional leading token is allowed before the qualifier — anchoring the
// qualifier at ^ meant `my-secret-key.txt`, `prod-api-key.txt`, and
// `license-key.md` all escaped while the bare `secret-key.txt` was caught, even
// though the original floor caught every one of them via `**/*-key*.*`. The
// leading group must end in a [-_.] separator, which is what still excludes
// `monkey.md` (no separator before "key") and `api-keyboard.md` (fails the
// `keys?` stem anchor — "keyboard" is not "key").
// A trailing token after the stem is allowed too, so `key-prod.md` and
// `session-key-notes.md` keep the floor — the original caught them via
// `**/key-*.*` and `**/*-key*.*`. `monkey.md` is still excluded (the leading
// group must end in a separator) and `api-keyboard.md` still is too (a trailing
// token must START with a separator, and "board" does not).
// Implemented as a token scan rather than one regex: the natural expression
// (`^(.*[-_.])?<stem>([-_.].*)?\.ext$`) nests unbounded wildcards on both sides
// of the stem, which is a catastrophic-backtracking risk on a
// partially-attacker-influenced filename (eslint security/detect-unsafe-regex).
// Splitting the basename on separators is linear and easier to reason about.
// INVERTED on purpose. An allowlist of credential qualifiers is open-ended —
// three review rounds each added more (`deploykey`, `privkey`, `pubkey`,
// `gpgkey`, `sessionkey`, `hmackey`, `rootkey`, …) and the next reader will
// think of more still. The set of ordinary English words that merely END in
// "key" is small, closed, and enumerable. Deny-listing that instead means a
// qualifier nobody anticipated fails SAFE (keeps the floor) rather than
// silently escaping.
//
// `privkey.pem` is the OpenSSL/Let's Encrypt default name and "deploy key" is
// GitHub's own term, so these are literal conventional credential filenames —
// and the separated forms (`deploy-key.md`) already kept the floor, making the
// allowlist's asymmetry indefensible.
const KEY_WORD_FALSE_POSITIVES = new Set([
  "monkey",
  "monkeys",
  "donkey",
  "donkeys",
  "turkey",
  "turkeys",
  "hockey",
  "jockey",
  "jockeys",
  "whiskey",
  "whiskeys",
  "lackey",
  "lackeys",
  "mickey",
  "hokey",
  "hokeys",
  "pinkey",
  "pinkeys",
  "malarkey",
  "malarkeys",
  "hickey",
  "hickeys",
  "mickeys",
  "hockeys",
]);

// A token is credential-shaped when it ends in `key`/`keys` and is not one of
// the ordinary words above. Bare `key`/`keys` counts too.
function isKeyToken(token) {
  if (KEY_WORD_FALSE_POSITIVES.has(token)) return false;
  return token.endsWith("key") || token.endsWith("keys");
}

function hasCredentialToken(basename) {
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return false;
  // Split on any non-alphanumeric run, not just [-_.] — `api key.md` (space)
  // and `api+key.md` (plus) must tokenize the way `api-key.md` does; the
  // original floor caught them via its substring globs.
  const tokens = basename
    .slice(0, dot)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // Any token ending in key/keys — bare (`key-prod.md`, `session-key-notes.md`)
  // or compound (`apikey.txt`, `privkey.md`, `deploykey.md`) — except the
  // ordinary English words above. `keyboard` and `keynote` are excluded because
  // they only START with "key"; the test is on the ending.
  return tokens.some(isKeyToken);
}

// Drop decoration from the basename's stem while preserving its extension, so
// `docs/secrets (1).md` reduces to `docs/secrets.md` and `docs/token<U+200B>.md`
// to `docs/token.md` before the exact-stem credential globs are applied.
// Alphanumerics and the word separators [-_.] survive, so genuine compounds
// (`token-budget`, `secret-santa`, `rate-limit`) are untouched and stay
// released.
function decorationStrippedNames(normalized) {
  const slash = normalized.lastIndexOf("/");
  const dir = slash === -1 ? "" : normalized.slice(0, slash + 1);
  const basename = normalized.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return [];
  const extension = basename.slice(dot);
  const rawStem = basename.slice(0, dot);
  // Decoration is a word BOUNDARY, not nothing: deleting it outright would turn
  // `secrets (1)` into `secrets1`, which is not the credential noun either.
  // Map decoration to `-`, collapse runs, and trim the ends.
  const stem = rawStem
    .replace(/[^a-z0-9\-_.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  if (!stem || stem === rawStem) return [];
  const candidates = [`${dir}${stem}${extension}`];
  // `password copy.txt` and `secrets (1).md` normalize to `password-copy` /
  // `secrets-1`, which still are not the bare noun. The decoration marked a
  // boundary, so the leading segment is the real name — test it too. Safe
  // against genuine compounds: `token-budget.md` is unchanged by the
  // normalization above, so it never reaches this branch.
  const lead = stem.split(/[-_.]/)[0];
  if (lead && lead !== stem) candidates.push(`${dir}${lead}${extension}`);
  return candidates;
}

// Strip prose extensions repeatedly so `.env.production.md` reduces to `.env`
// and `id_rsa.txt` to `id_rsa` before the credential-stem patterns are applied.
function stripProseExtensions(basename) {
  let stem = basename;
  for (let guard = 0; guard < 5; guard += 1) {
    const dot = stem.lastIndexOf(".");
    if (dot <= 0) break;
    if (!PROSE_EXTENSIONS.has(stem.slice(dot))) break;
    stem = stem.slice(0, dot);
  }
  return stem;
}

function hasCredentialBasename(normalized) {
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return hasCredentialToken(basename);
}

function isProsePath(file) {
  const normalized = normalizeFloorPath(file);
  const dot = normalized.lastIndexOf(".");
  if (dot === -1) return false;
  if (!PROSE_EXTENSIONS.has(normalized.slice(dot))) return false;
  // Security-relevant prose — by directory or by document name — keeps the floor.
  if (matchesPattern(normalized, PROSE_DIRECTORY_FLOOR)) return false;
  if (matchesPattern(normalized, PROSE_NAME_FLOOR)) return false;
  if (hasCredentialBasename(normalized)) return false;
  // Decoration is not word-compounding. PROSE_NAME_FLOOR pins credential nouns
  // as EXACT stems (`**/token.*`), so any trailing character defeats it —
  // `token .md`, `secrets (1).md`, `password copy.txt`, and the invisible
  // variants (U+200B, U+FEFF, U+00A0, U+202E) all escaped. Those are exactly
  // the OS-generated duplicate names a pasted credential dump arrives under,
  // and the zero-width forms are visually identical to `token.md`, which the
  // floor DOES catch — an evasion primitive, not a false-positive fix.
  //
  // Re-test with decoration stripped: keep only alphanumerics and the word
  // separators [-_.], which is the same normalization hasCredentialToken
  // already applies on the key path.
  for (const candidate of decorationStrippedNames(normalized)) {
    if (matchesPattern(candidate, PROSE_NAME_FLOOR)) return false;
  }
  // A prose suffix must not launder a credential filename: re-test the path
  // with prose extensions stripped, so `.env.md` is judged as `.env` and
  // `id_rsa.txt` as `id_rsa`.
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const stem = stripProseExtensions(basename);
  if (stem !== basename && matchesPattern(stem, CREDENTIAL_STEM)) return false;
  return true;
}

function matchesSecurityFloor(file, cfg = DEFAULTS) {
  // Git accepts control characters in filenames. Treat every such path as
  // security-sensitive instead of trying to assign ordinary risk to an
  // ambiguous/adversarial display surface.
  if (hasControlCharacters(file)) return true;
  const normalized = normalizeFloorPath(file);
  // A repo-declared securityFloor pattern is an explicit opt-in and is NEVER
  // subject to the prose carve-out. The carve-out narrows the BUILT-IN floor,
  // whose breadth is an accident of substring matching; a pattern a repository
  // deliberately added to harness-config.json is a decision, not an accident.
  //
  // Checking it after isProsePath() silently voided that decision — with
  // scorePolicy.securityFloor: ["**/compliance/**"], `compliance/soc2.md`
  // scored 40 instead of 85 while `compliance/app.js` correctly stayed 85.
  // That breaks the documented additive contract (additiveFloorPatterns exists
  // precisely so repo policy can only ever ADD strictness, never remove it),
  // and no built-in trade-off covers it: the accepted trade-offs are about
  // built-in security *concepts*, not repo-declared surface.
  // Only patterns the repo ADDED count. cfg.securityFloor legitimately contains
  // the built-in list (loadConfig merges over DEFAULTS), so treating the whole
  // array as repo-declared would bypass the carve-out for every built-in
  // pattern and undo this change entirely — `docs/monkeys.md` floored again.
  // Diff against DEFAULTS to isolate the genuine opt-ins.
  const builtIn = new Set(
    [...DEFAULTS.securityFloor, ...DEFAULTS.humanFloor].map((pattern) =>
      pattern.toLowerCase(),
    ),
  );
  // Lowercase the patterns too. `normalized` is already lowercased (see
  // normalizeFloorPath), so a repo pattern with any capitals — `**/Compliance/**`
  // — could never match, silently voiding the opt-in this branch exists to
  // honor. additiveFloorPatterns lowercases for exactly this reason; the
  // built-in comparison above already did, and only the match did not.
  const added = (Array.isArray(cfg?.securityFloor) ? cfg.securityFloor : [])
    .map((pattern) => String(pattern).toLowerCase())
    .filter((pattern) => !builtIn.has(pattern));
  if (added.length > 0 && matchesPattern(normalized, added)) {
    return true;
  }
  if (isProsePath(file)) return false;
  const floor = effectiveSecurityFloor(cfg);
  if (matchesPattern(normalized, floor)) return true;
  // isProsePath refuses to EXEMPT laundered key material, but refusing an
  // exemption is not the same as applying the floor: the floor patterns are
  // extension-anchored (`**/*.pem`), and `certs/server.pem.md` still ends in
  // `.md`. Nothing re-tested the stripped path, so every prose-suffixed key
  // extension scored as ordinary documentation — `.pem.md`, `.p12.txt`,
  // `.pfx.md`, `.jks.md`, `.ppk.txt`, `.kdbx.md`.
  //
  // `.key` appeared to work only by accident: it matches the `**/*key*`
  // substring pattern, not the extension path, which is why probing `.key`
  // alone made the floor look healthy (BUI-640).
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const stem = stripProseExtensions(basename);
  if (stem === basename) return false;
  const directory = normalized.slice(0, normalized.lastIndexOf("/") + 1);
  return matchesPattern(`${directory}${stem}`, floor);
}

function securityFloorScore(cfg = DEFAULTS) {
  const configured = Number(cfg?.base?.securityFloor);
  return Math.max(
    DEFAULTS.base.securityFloor,
    Number.isFinite(configured) ? configured : DEFAULTS.base.securityFloor,
  );
}

// ---------------------------------------------------------------------------
// git helpers (injectable runner for tests)
// ---------------------------------------------------------------------------

function defaultGitRunner(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Resolve the base ref the diff is scored against. Determinism matters: the
// same change MUST score the same regardless of which refs happen to be fetched
// locally. The old last-resort of `HEAD~1` was the bug — in a freshly
// materialized worktree without origin/main fetched, it silently diffed only
// the last commit, so a large branch scored like a one-line change (observed:
// 35 vs 87 for the same diff). When no durable base can be found we do NOT
// quietly fall back to a one-commit diff; we return { unresolved: true } and let
// the caller fail CLOSED (score maximum risk) instead of a misleadingly low one.
function resolveBase(gitRunner, baseArg) {
  if (baseArg) return { ref: baseArg };
  if (process.env.GITHUB_BASE_REF)
    return { ref: `origin/${process.env.GITHUB_BASE_REF}` };
  // Prefer the tracked upstream of the current branch — the true PR base — over
  // guessing origin/main, and try to fetch a known remote base if it is missing
  // locally so a fresh worktree scores the same as a full checkout.
  try {
    const upstream = gitRunner([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    if (upstream) {
      gitRunner(["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`]);
      return { ref: upstream };
    }
  } catch {
    /* no upstream configured — fall through */
  }
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    try {
      gitRunner(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return { ref };
    } catch {
      /* try next */
    }
  }
  // No durable base. Do not silently diff HEAD~1 — that is the non-determinism
  // that let a big change score small. Signal it; the caller fails closed.
  return { unresolved: true };
}

// ---------------------------------------------------------------------------
// Change-nature classification (mechanical vs logic)
// ---------------------------------------------------------------------------

// The 9 shared predicates (isCommentWhitespaceSafeLang, isDirectiveComment,
// isWholeLineInertComment, patchIsCommentWhitespaceOnly, patchIsAdditiveOnly,
// isTestPath, isExecutablePromptSurface, isForcedLogic, classifyChangeNature)
// now live in ./risk-change-nature.js and are imported above. Only the pieces
// unique to the numeric scorer remain local.

// This scorer's mechanical sub-rule set: test additions + inert comment edits,
// never a floor file. (The setup gate's variant additionally treats dep-version
// bumps and generated-file refreshes as mechanical — that is why the sub-rule
// is injected into the shared classifier rather than living in it.)
function fileIsMechanical(file, status, patch, floorPaths, descriptor = {}) {
  if (
    matchesPattern(
      normalizeFloorPath(file),
      additiveFloorPatterns(DEFAULTS.securityFloor, floorPaths),
    )
  )
    return false; // floor files are never mechanical
  if (descriptor.pureRename === true) return true;
  const testRuleAllowed = isTestPath(file);
  return (
    (testRuleAllowed && status === "A") ||
    (testRuleAllowed && patchIsAdditiveOnly(patch)) ||
    patchIsCommentWhitespaceOnly(file, patch)
  );
}

/**
 * Classify the whole changeset using this scorer's native call convention
 * (descriptors + a floorPaths array), delegating the drift-prone control flow to
 * the shared classifier and injecting this file's matcher + fileIsMechanical.
 */
function classifyChangeNature(descriptors, floorPaths) {
  const normalizedDescriptors = descriptors.map((descriptor) => ({
    ...descriptor,
    file: normalizeFloorPath(descriptor.file),
  }));
  return classifyChangeNatureShared(normalizedDescriptors, {
    floorPaths: additiveFloorPatterns(DEFAULTS.securityFloor, floorPaths),
    matchesPattern,
    fileIsMechanical,
  });
}

// ---------------------------------------------------------------------------
// Diff collection
// ---------------------------------------------------------------------------

function collectDescriptors(base, gitRunner) {
  let mergeBase;
  let mergeBaseFallback = false;
  try {
    mergeBase = gitRunner(["merge-base", "HEAD", base]) || base;
  } catch {
    mergeBase = base;
    mergeBaseFallback = true;
  }

  // These two calls are STRUCTURAL: everything downstream is derived from them.
  // They must not go through safeGit, which turns a git failure into "" and is
  // then indistinguishable from "the diff is genuinely empty" — that path
  // scored a change at base.medium with the reason "no changes detected", so a
  // large security-surface change against an unreachable base (shallow clone,
  // GC'd object, missing submodule ref) was under-provisioned AND explained
  // with a misleading reason. Report the failure so score() can fail closed,
  // matching the unresolved-base contract above.
  let nameStatus;
  let numstat;
  try {
    nameStatus = gitRunner([
      "diff",
      "--name-status",
      "--find-renames",
      "-z",
      `${mergeBase}...HEAD`,
    ]);
    numstat = gitRunner([
      "diff",
      "--numstat",
      "--find-renames",
      "-z",
      `${mergeBase}...HEAD`,
    ]);
  } catch (error) {
    return {
      descriptors: [],
      diffStats: { files: 0, lines: 0 },
      mergeBase,
      collectionFailed: true,
      collectionError: error?.message || String(error),
    };
  }

  const statuses = parseNameStatusZ(nameStatus);
  const stats = parseNumstatZ(numstat);
  let totalLines = 0;
  const descriptors = [];
  for (let index = 0; index < stats.length; index += 1) {
    const { add, del, paths } = stats[index];
    const statusInfo = statuses[index] || {
      status: "M",
      baseFile: paths[0],
      file: paths.at(-1),
      similarity: null,
    };
    const file = statusInfo.file || paths.at(-1);
    const isBinary = add === "-" && del === "-";
    const lines = isBinary
      ? 0
      : (parseInt(add, 10) || 0) + (parseInt(del, 10) || 0);
    totalLines += lines;
    descriptors.push(
      collectDescriptor({
        file,
        isBinary,
        lines,
        statusInfo,
        mergeBase,
        gitRunner,
      }),
    );
  }

  return {
    descriptors,
    diffStats: {
      files: descriptors.length,
      lines: totalLines,
    },
    mergeBase,
    mergeBaseFallback,
  };
}

const TASK_TYPE_RANK = {
  unknown: 0,
  chore: 1,
  docs: 2,
  build: 3,
  ci: 4,
  feature: 5,
  bugfix: 6,
  performance: 7,
};
const TASK_TYPES = new Set(Object.keys(TASK_TYPE_RANK));

function conventionalTaskType(subject) {
  const head = String(subject || "")
    .split(":", 1)[0]
    .trim()
    .toLowerCase()
    .replace(/!$/, "")
    .replace(/\([^)]*\)$/, "");
  if (head === "perf") return "performance";
  if (head === "fix" || head === "revert") return "bugfix";
  if (head === "feat") return "feature";
  if (head === "ci") return "ci";
  if (head === "build") return "build";
  if (head === "docs") return "docs";
  if (["chore", "style", "test"].includes(head)) return "chore";
  return "unknown";
}

function pathTaskType(file) {
  const normalized = normalizeFloorPath(file);
  if (
    normalized.startsWith(".github/workflows/") ||
    normalized.startsWith(".circleci/") ||
    normalized === ".gitlab-ci.yml"
  ) {
    return "ci";
  }
  if (
    normalized === "dockerfile" ||
    normalized.endsWith("/dockerfile") ||
    normalized === "makefile" ||
    normalized.endsWith("/makefile") ||
    normalized.startsWith("build/") ||
    normalized.startsWith("scripts/build")
  ) {
    return "build";
  }
  if (
    normalized.endsWith(".md") ||
    normalized.startsWith("docs/") ||
    normalized === "license" ||
    normalized.startsWith("changelog")
  ) {
    return "docs";
  }
  return "unknown";
}

function strictestTaskType(types) {
  return types.reduce(
    (strictest, candidate) =>
      TASK_TYPE_RANK[candidate] > TASK_TYPE_RANK[strictest]
        ? candidate
        : strictest,
    "unknown",
  );
}

function classifyTaskType(descriptors, subjects = []) {
  const fromCommits = strictestTaskType(
    subjects.map((subject) => conventionalTaskType(subject)),
  );
  if (fromCommits !== "unknown") return fromCommits;
  if (descriptors.length === 0) return "unknown";
  const fromPaths = descriptors.map((descriptor) =>
    pathTaskType(descriptor.file),
  );
  if (fromPaths.some((type) => type === "unknown")) return "unknown";
  return strictestTaskType(fromPaths);
}

function collectCommitSubjects(mergeBase, gitRunner) {
  return safeGit(gitRunner, [
    "log",
    "--no-merges",
    "--format=%s",
    `${mergeBase}..HEAD`,
  ])
    .split("\n")
    .map((subject) => subject.trim())
    .filter(Boolean);
}

function applyTaskTypeFloor(scored, taskType, cfg) {
  const floors = {
    feature: cfg.base.medium,
  };
  const floor = floors[taskType];
  if (!Number.isFinite(floor) || scored.riskScore >= floor) return scored;
  return {
    ...scored,
    riskScore: floor,
    reasons: [
      ...scored.reasons,
      `task type ${taskType} → ${
        taskType === "feature" ? "standard" : "high-review"
      } floor ${floor}`,
    ],
  };
}

function parseNameStatusZ(raw) {
  if (!String(raw).includes("\0")) {
    return String(raw)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [code, baseFile, renamedFile] = line.split("\t");
        const status = code[0];
        return {
          status,
          similarity: /^[RC][0-9]+$/.test(code) ? Number(code.slice(1)) : null,
          baseFile,
          file: ["R", "C"].includes(status) ? renamedFile : baseFile,
        };
      });
  }
  const tokens = String(raw).split("\0");
  const rows = [];
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++];
    if (!code) continue;
    const status = code[0];
    const similarity = /^[RC][0-9]+$/.test(code) ? Number(code.slice(1)) : null;
    const baseFile = tokens[index++] || "";
    const file = ["R", "C"].includes(status) ? tokens[index++] || "" : baseFile;
    rows.push({ status, similarity, baseFile, file });
  }
  return rows;
}

function parseNumstatZ(raw) {
  if (!String(raw).includes("\0")) {
    return String(raw)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [add, del, file] = line.split("\t");
        return { add, del, paths: [file] };
      });
  }
  const tokens = String(raw).split("\0");
  const rows = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++];
    if (!token) continue;
    const [add, del, file] = token.split("\t");
    if (file === "") {
      rows.push({
        add,
        del,
        paths: [tokens[index++] || "", tokens[index++] || ""],
      });
    } else {
      rows.push({ add, del, paths: [file] });
    }
  }
  return rows;
}

function collectDescriptor({
  file,
  isBinary,
  lines,
  statusInfo,
  mergeBase,
  gitRunner,
}) {
  const status = statusInfo.status;
  let patch = "";
  if (!isBinary && status !== "D") {
    patch = safeGit(gitRunner, ["diff", `${mergeBase}...HEAD`, "--", file]);
    if (patch.length > 200 * 1024) patch = "";
  }
  const descriptor = {
    file,
    baseFile: statusInfo.baseFile,
    status,
    isBinary,
    lines,
    patch,
    similarity: statusInfo.similarity,
    pureRename: status === "R" && statusInfo.similarity === 100 && lines === 0,
  };
  if (matchesPattern(file, ["**/package.json"])) {
    descriptor.manifest = collectManifestSnapshots(
      descriptor,
      mergeBase,
      gitRunner,
    );
  }
  return descriptor;
}

function tryGit(gitRunner, args) {
  try {
    return { ok: true, value: gitRunner(args) };
  } catch {
    return { ok: false, value: "" };
  }
}

function collectManifestSnapshots(descriptor, mergeBase, gitRunner) {
  const before =
    descriptor.status === "A"
      ? { ok: true, value: null }
      : tryGit(gitRunner, [
          "show",
          `${mergeBase}:${descriptor.baseFile || descriptor.file}`,
        ]);
  const after =
    descriptor.status === "D"
      ? { ok: true, value: null }
      : tryGit(gitRunner, ["show", `HEAD:${descriptor.file}`]);
  return { before, after };
}

function safeGit(gitRunner, args) {
  try {
    return gitRunner(args) || "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function pathBase(file, cfg) {
  if (matchesSecurityFloor(file, cfg)) return securityFloorScore(cfg);
  if (matchesPattern(file, cfg.high)) return cfg.base.high;
  if (matchesPattern(file, cfg.low)) return cfg.base.low;
  return cfg.base.medium;
}

function magnitudeAdd(lines, cfg) {
  const { linesForSmall, linesForLarge, maxAdd } = cfg.magnitude;
  if (lines <= linesForSmall) return 0;
  if (lines >= linesForLarge) return maxAdd;
  const frac = (lines - linesForSmall) / (linesForLarge - linesForSmall);
  return Math.round(frac * maxAdd);
}

const MANIFEST_CRITICAL_FIELDS = new Set(["overrides", "resolutions"]);
const MANIFEST_HIGH_FIELDS = new Set([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "scripts",
  "bin",
  "exports",
  "imports",
  "main",
  "module",
  "browser",
  "type",
  "types",
  "typings",
  "files",
  "name",
  "workspaces",
  "packageManager",
  "publishConfig",
]);
const MANIFEST_MEDIUM_FIELDS = new Set([
  "devDependencies",
  "engines",
  "os",
  "cpu",
  "version",
  "license",
  "private",
]);
const MANIFEST_LOW_FIELDS = new Set([
  "description",
  "keywords",
  "homepage",
  "bugs",
  "author",
  "contributors",
  "funding",
  "repository",
]);
const INSTALL_LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
]);
const DEPENDENCY_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
]);

function parseManifestSnapshot(snapshot) {
  if (!snapshot || snapshot.ok !== true) return { ok: false, value: null };
  if (snapshot.value === null) return { ok: true, value: null };
  try {
    const value = JSON.parse(snapshot.value);
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value }
      : { ok: false, value: null };
  } catch {
    return { ok: false, value: null };
  }
}

function changedTopLevelFields(before, after) {
  const fields = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  return [...fields].filter(
    (field) =>
      JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field]),
  );
}

function hasNonRegistryDependencySource(value) {
  if (typeof value === "string") {
    return !isRegistryDependencySpec(value);
  }
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(hasNonRegistryDependencySource);
}

function isRegistryDependencySpec(value) {
  const spec = value.trim();
  if (!spec) return false;
  const normalized = spec.toLowerCase();
  if (normalized.endsWith(".tgz") || normalized.endsWith(".tar.gz"))
    return false;
  if (spec.startsWith("workspace:")) {
    return isPlainRegistrySelector(spec.slice("workspace:".length));
  }
  if (spec.startsWith("npm:")) {
    return isRegistryAlias(spec.slice("npm:".length));
  }
  return isPlainRegistrySelector(spec);
}

function isRegistryAlias(alias) {
  const separator = alias.startsWith("@")
    ? alias.indexOf("@", alias.indexOf("/") + 1)
    : alias.indexOf("@");
  const name = separator >= 0 ? alias.slice(0, separator) : alias;
  const selector = separator >= 0 ? alias.slice(separator + 1) : "";
  return (
    isRegistryPackageName(name) &&
    (!selector || isPlainRegistrySelector(selector))
  );
}

function isRegistryPackageName(name) {
  if (!name || [...name].some((character) => character.trim() === ""))
    return false;
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    return (
      slash > 1 &&
      slash === name.lastIndexOf("/") &&
      slash < name.length - 1 &&
      !name.includes(":") &&
      !name.includes("\\")
    );
  }
  return !["/", ":", "@", "\\"].some((character) => name.includes(character));
}

function isPlainRegistrySelector(spec) {
  if (!spec || spec.startsWith(".")) return false;
  const hasWhitespace = [...spec].some((character) => character.trim() === "");
  const hasRangeSignal = [...spec].some(
    (character) =>
      (character >= "0" && character <= "9") || "<>=~^*|".includes(character),
  );
  if (hasWhitespace && !hasRangeSignal) return false;
  return !["/", ":", "@", "\\"].some((character) => spec.includes(character));
}

function manifestFieldRisk(field, before, after, cfg) {
  const afterValue = after[field];
  if (MANIFEST_CRITICAL_FIELDS.has(field)) {
    return {
      score: cfg.base.securityFloor,
      reason: `critical manifest field changed: ${field}`,
    };
  }
  if (
    field === "scripts" &&
    changedTopLevelFields(before.scripts, after.scripts).some((name) =>
      INSTALL_LIFECYCLE_SCRIPTS.has(name),
    )
  ) {
    return {
      score: cfg.base.securityFloor,
      reason: "install lifecycle script changed",
    };
  }
  if (
    DEPENDENCY_FIELDS.has(field) &&
    hasNonRegistryDependencySource(afterValue)
  ) {
    return {
      score: cfg.base.securityFloor,
      reason: `non-registry dependency source changed: ${field}`,
    };
  }
  if (MANIFEST_HIGH_FIELDS.has(field)) {
    return {
      score: cfg.base.high,
      reason: `runtime manifest field changed: ${field}`,
    };
  }
  if (MANIFEST_MEDIUM_FIELDS.has(field) || !MANIFEST_LOW_FIELDS.has(field)) {
    return {
      score: cfg.base.medium,
      reason: `manifest field changed: ${field}`,
    };
  }
  return { score: cfg.base.low, reason: "manifest metadata only" };
}

function manifestRisk(descriptor, cfg = DEFAULTS) {
  if (
    !descriptor.manifest ||
    ["A", "D", "R", "C", "T"].includes(descriptor.status)
  ) {
    return {
      score: cfg.base.securityFloor,
      fields: [],
      reason: "manifest added, deleted, renamed, copied, or type-changed",
    };
  }

  const before = parseManifestSnapshot(descriptor.manifest.before);
  const after = parseManifestSnapshot(descriptor.manifest.after);
  if (!before.ok || !after.ok || !before.value || !after.value) {
    return {
      score: cfg.base.securityFloor,
      fields: [],
      reason: "manifest base or HEAD snapshot unreadable or invalid",
    };
  }

  const fields = changedTopLevelFields(before.value, after.value);
  const risks = fields.map((field) =>
    manifestFieldRisk(field, before.value, after.value, cfg),
  );
  const highest = risks.reduce(
    (highest, risk) => (risk.score > highest.score ? risk : highest),
    { score: cfg.base.low, reason: "manifest metadata only" },
  );
  return { ...highest, fields };
}

// Risk-bearing GitHub Actions diff hunk content (BUI-381): a workflow diff
// that ONLY touches version pins, comments, `on:` triggers, or job/step
// names is not the same risk as one that touches permissions, secrets, or
// what actually executes. Conservative by construction — added OR removed
// lines matching any of these patterns are enough to keep the floor; only a
// diff with NONE of these signals downgrades. An unparsable/empty patch
// (e.g. binary, truncated >200KB) is treated as risk-bearing (fail closed).
const WORKFLOW_RISK_PATTERNS = [
  // Leading `\s*` is required: a JOB-level permissions block is indented under
  // `jobs.<id>:`, and that is the more common form. Anchoring at column 0
  // matched only the top-level block, so escalating a job to
  // `contents: write` + `id-token: write` — the OIDC-credential-exfiltration
  // class this floor exists to catch — scored below the critical band. The
  // sibling `run:`/`uses:` patterns already allow indentation.
  /^\s*permissions\s*:/i, // top-level or job-level permissions block
  /permissions\s*:\s*\{/i, // inline permissions map
  /\bsecrets\s*\.\s*[A-Z0-9_]+/, // secrets.FOO reference (added or removed)
  /\bsecrets\s*:/i, // secrets: passthrough block (reusable workflow calls)
  /^\s*run\s*:/i, // run: shell step content
  /^\s*uses\s*:/i, // any uses: line change — new action pin or reference swap
  /\benv\s*:\s*$/i, // env: block header (new/changed env injection point)
  /\bGITHUB_TOKEN\b/,
  /\bpull_request_target\b/i, // notoriously unsafe trigger
];

function workflowDiffIsRiskBearing(patch) {
  if (!patch || !patch.trim()) return true; // fail closed on empty/unreadable
  for (const line of patch.split("\n")) {
    if (!(line.startsWith("+") || line.startsWith("-"))) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const content = line.slice(1);
    if (WORKFLOW_RISK_PATTERNS.some((pattern) => pattern.test(content))) {
      return true;
    }
  }
  return false;
}

// Credential material visible in a diff. The mirror image of
// WORKFLOW_RISK_PATTERNS: those DEMOTE a floor path whose diff turns out to be
// inert, these PROMOTE a released path whose diff turns out to carry a secret.
//
// This is the answer to the question the name-based floor cannot answer. A
// prose file is released or held on what it CONTAINS, not what it is called —
// so `docs/setup-guide.md` with a pasted private key is caught, while
// `docs/api-key.md` that merely discusses API keys is not.
//
// Deliberately narrow: unambiguous credential FORMATS, not "looks secret-ish".
// A broad entropy heuristic would re-import the false-positive problem this
// exists to remove. gitleaks (.gitleaks.toml + credential-history-scan.yml)
// remains the exhaustive scanner; this is the review-depth signal.
const CREDENTIAL_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /-----BEGIN OPENSSH PRIVATE KEY-----/,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/, // AWS temporary access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}/, // GitHub token family
  /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab PAT
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack token
  /\bsk-[A-Za-z0-9]{32,}/, // OpenAI-style secret key
  /\bsk-ant-[A-Za-z0-9_-]{24,}/, // Anthropic key
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b(?=[\s"']*$)/i,
];

// True when a diff ADDS credential-shaped content. Only added lines count:
// removing a leaked secret is remediation and must not be penalised with a
// critical-tier review, which would discourage the cleanup.
function diffAddsCredentialContent(patch) {
  if (!patch) return false;
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const content = line.slice(1);
    if (CREDENTIAL_CONTENT_PATTERNS.some((pattern) => pattern.test(content))) {
      return true;
    }
  }
  return false;
}

function descriptorBaseRisk(descriptor, cfg) {
  if (
    matchesPattern(descriptor.file, ["**/package.json"]) &&
    !matchesSecurityFloor(descriptor.file, cfg)
  ) {
    return manifestRisk(descriptor, cfg);
  }
  if (
    matchesPattern(descriptor.file, cfg.contentAwareFloor || []) &&
    !workflowDiffIsRiskBearing(descriptor.patch)
  ) {
    return {
      score: cfg.base.high,
      reason:
        "workflow diff touches only version pins/comments/triggers → high, not security floor",
    };
  }
  // Content promotes ANY path the name-based floor released. The floor cannot
  // see a private key pasted into `docs/setup-guide.md`; this can.
  //
  // NOT gated on isProsePath. The first version of this branch was, which
  // reintroduced the very coupling it exists to break: isProsePath is a NAME
  // test, so a file the name logic had already disqualified could never be
  // promoted by its content. `certs/server.pem.md` containing a real
  // BEGIN RSA PRIVATE KEY block still scored 10 (BUI-640) — fail-open by
  // exclusion, and precisely the case the content check was written for.
  //
  // The `!matchesSecurityFloor` guard is what keeps this a pure strictness
  // increase: it only ever runs on paths already released, so it can add the
  // floor and never remove it. Name and content are now independent signals —
  // either one alone is sufficient to hold a file at the floor.
  if (
    !matchesSecurityFloor(descriptor.file, cfg) &&
    diffAddsCredentialContent(descriptor.patch)
  ) {
    return {
      score: securityFloorScore(cfg),
      reason: "diff adds credential-shaped content → security floor",
    };
  }
  return { score: pathBase(descriptor.file, cfg), reason: "" };
}

function computeScore(descriptors, diffStats, cfg) {
  const reasons = [];
  if (descriptors.length === 0) {
    return {
      riskScore: cfg.base.medium,
      changeNature: "logic",
      reasons: ["no changes detected → default medium"],
    };
  }

  // Base = highest path sensitivity across all files.
  let base = 0;
  let topFile = "";
  let topReason = "";
  for (const d of descriptors) {
    const risk = descriptorBaseRisk(d, cfg);
    if (
      risk.score > base ||
      (risk.score === base && isTestPath(topFile) && !isTestPath(d.file))
    ) {
      base = risk.score;
      topFile = d.file;
      topReason = risk.reason;
    }
  }
  // A file matches the (additive, repo-extensible) security floor by path
  // but is excluded from touchesFloor when it is ALSO in contentAwareFloor
  // (currently just workflow YAML) AND its own diff is provably not
  // risk-bearing (BUI-381). Any other floor file (secrets, auth, deploy,
  // install.sh, humanFloor, a repo's own extensions, etc.) is an
  // unconditional path pin, unchanged. This must mirror descriptorBaseRisk's
  // downgrade exactly, or a downgraded file's score could still get
  // re-pinned to the floor right back here.
  const touchesFloor = descriptors.some((d) => {
    if (!matchesSecurityFloor(d.file, cfg)) return false;
    if (matchesPattern(d.file, cfg.contentAwareFloor || [])) {
      return workflowDiffIsRiskBearing(d.patch);
    }
    return true;
  });
  reasons.push(`path base ${base} (most-sensitive: ${topFile || "n/a"})`);
  if (topReason) reasons.push(topReason);

  const changeNature = classifyChangeNature(
    descriptors,
    effectiveSecurityFloor(cfg),
  );
  let score = base;

  // Mechanical downgrade — never on a floor touch, bounded, capped by size.
  if (changeNature === "mechanical" && !touchesFloor) {
    if (diffStats.lines >= cfg.magnitude.capMechanicalAboveLines) {
      reasons.push(
        `mechanical but ${diffStats.lines} lines ≥ cap → no downgrade`,
      );
    } else {
      score += cfg.mechanicalDelta;
      reasons.push(`mechanical change → ${cfg.mechanicalDelta}`);
    }
  } else if (touchesFloor) {
    reasons.push("security-surface touched → mechanical downgrade blocked");
  } else {
    reasons.push("logic change → base kept");
  }

  // Magnitude only raises.
  const add = magnitudeAdd(diffStats.lines, cfg);
  if (add > 0) {
    score += add;
    reasons.push(`+${add} for ${diffStats.lines} changed lines`);
  }

  // Security floor pin.
  const floorScore = securityFloorScore(cfg);
  if (touchesFloor && score < floorScore) {
    score = floorScore;
    reasons.push(`pinned to security floor ${floorScore}`);
  }

  const numericScore = Number(score);
  if (!Number.isFinite(numericScore)) {
    score = 100;
    reasons.push("non-finite risk policy result → maximum risk fail-closed");
  } else {
    score = Math.max(0, Math.min(100, numericScore));
  }
  return { riskScore: score, changeNature, reasons };
}

function nonnegativeInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function configuredKnobs(score, cfg) {
  const curve =
    Array.isArray(cfg?.curve) && cfg.curve.length ? cfg.curve : DEFAULTS.curve;
  const band =
    curve.find((candidate) => score <= Number(candidate.maxScore)) ||
    curve[curve.length - 1];
  return {
    agents: nonnegativeInteger(band?.agents),
    codex: ["skip", "high", "xhigh"].includes(band?.codex)
      ? band.codex
      : "skip",
    codexRounds: nonnegativeInteger(band?.codexRounds),
  };
}

function scoreToKnobs(score, cfg) {
  const numericScore = Number(score);
  const effectiveScore = Number.isFinite(numericScore) ? numericScore : 100;
  const knobs = configuredKnobs(effectiveScore, cfg);
  const configuredForceFloor = Number(cfg?.codexForceFloor);
  const codexForceFloor = Math.min(
    DEFAULTS.codexForceFloor,
    Number.isFinite(configuredForceFloor)
      ? configuredForceFloor
      : DEFAULTS.codexForceFloor,
  );
  if (effectiveScore >= codexForceFloor && knobs.codex === "skip") {
    knobs.codex = "high";
    knobs.codexRounds = 1;
  }
  // A repo-committed curve must never authorize weaker review than the
  // built-in baseline for the same score — floor it unconditionally, not
  // only in the critical band. See humanFloor's non-replaceable-additive
  // reasoning below for why repo config can extend but not weaken a floor.
  const baseline =
    DEFAULTS.curve.find((candidate) => effectiveScore <= candidate.maxScore) ||
    DEFAULTS.curve[DEFAULTS.curve.length - 1];
  const codexRank = { skip: 0, high: 1, xhigh: 2 };
  // Reviewer count is a contract, not a repository tuning knob. Domain
  // selection supplies the useful diversity; allowing an override to restore
  // 4-6 agents would recreate the correlated panel this policy removes and
  // would disagree with the exact selector at stamp time.
  knobs.agents = baseline.agents;
  if ((codexRank[knobs.codex] ?? -1) < codexRank[baseline.codex]) {
    knobs.codex = baseline.codex;
  }
  knobs.codexRounds = Math.max(knobs.codexRounds, baseline.codexRounds);
  return knobs;
}

// ---------------------------------------------------------------------------
// Config merge
// ---------------------------------------------------------------------------

function deepMerge(base, override) {
  if (!override || typeof override !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseConfigJson(raw, file) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid risk policy JSON at ${file}: ${error.message}`, {
      cause: error,
    });
  }
}

function requireFiniteNumber(value, name, { minimum = -Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(
      `invalid risk policy: ${name} must be a finite number >= ${minimum}`,
    );
  }
}

function requirePatternList(value, name) {
  if (
    !Array.isArray(value) ||
    value.some((pattern) => typeof pattern !== "string")
  ) {
    throw new Error(`invalid risk policy: ${name} must be an array of strings`);
  }
}

function validateCurve(curve) {
  if (!Array.isArray(curve) || curve.length === 0) {
    throw new Error("invalid risk policy: curve must be a non-empty array");
  }
  let previousMaximum = -Infinity;
  for (const [index, band] of curve.entries()) {
    if (!band || typeof band !== "object" || Array.isArray(band)) {
      throw new Error(`invalid risk policy: curve[${index}] must be an object`);
    }
    requireFiniteNumber(band.maxScore, `curve[${index}].maxScore`, {
      minimum: 0,
    });
    requireFiniteNumber(band.agents, `curve[${index}].agents`, { minimum: 0 });
    requireFiniteNumber(band.codexRounds, `curve[${index}].codexRounds`, {
      minimum: 0,
    });
    if (
      !Number.isInteger(band.agents) ||
      !Number.isInteger(band.codexRounds) ||
      !["skip", "high", "xhigh"].includes(band.codex) ||
      band.maxScore <= previousMaximum
    ) {
      throw new Error(`invalid risk policy: curve[${index}] is malformed`);
    }
    previousMaximum = band.maxScore;
  }
  if (previousMaximum < 100) {
    throw new Error("invalid risk policy: curve must cover score 100");
  }
}

function assertBuiltInAgentCurve(curve) {
  for (let score = 0; score <= 100; score += 1) {
    const configured = configuredKnobs(score, { curve }).agents;
    const builtIn = configuredKnobs(score, DEFAULTS).agents;
    if (configured !== builtIn) {
      throw new Error(
        `invalid risk policy: curve may not change the built-in reviewer target at score ${score} (${configured} != ${builtIn})`,
      );
    }
  }
}

function validateScoreConfig(cfg) {
  if (!["autonomous", "human-required"].includes(cfg?.mergeAuthority)) {
    throw new Error(
      "mergeAuthority must be either 'autonomous' or 'human-required'",
    );
  }
  validateProtectedNonstrictRefCas(cfg?.protectedNonstrictRefCas);
  for (const name of ["securityFloor", "humanFloor", "high", "low"]) {
    requirePatternList(cfg?.[name], name);
  }
  for (const name of ["securityFloor", "high", "medium", "low"]) {
    requireFiniteNumber(cfg?.base?.[name], `base.${name}`, { minimum: 0 });
  }
  requireFiniteNumber(cfg?.mechanicalDelta, "mechanicalDelta");
  for (const name of [
    "linesForSmall",
    "linesForLarge",
    "maxAdd",
    "capMechanicalAboveLines",
  ]) {
    requireFiniteNumber(cfg?.magnitude?.[name], `magnitude.${name}`, {
      minimum: 0,
    });
  }
  requireFiniteNumber(cfg?.codexForceFloor, "codexForceFloor", { minimum: 0 });
  validateCurve(cfg?.curve);
  return cfg;
}

function validateProtectedNonstrictRefCas(value) {
  if (!["signed-only", "accept-non-atomic-pr-state"].includes(value)) {
    throw new Error(
      "protectedNonstrictRefCas must be either 'signed-only' or 'accept-non-atomic-pr-state'",
    );
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function configFromRoot(repoCfg) {
  if (!isPlainObject(repoCfg)) {
    throw new Error(
      "invalid risk policy: harness-config root must be an object",
    );
  }
  if (!Object.hasOwn(repoCfg, "scorePolicy")) {
    return validateScoreConfig(DEFAULTS);
  }
  if (!isPlainObject(repoCfg.scorePolicy)) {
    throw new Error("invalid risk policy: scorePolicy must be an object");
  }
  const cfg = deepMerge(DEFAULTS, repoCfg.scorePolicy);
  cfg.securityFloor = effectiveSecurityFloor(cfg);
  cfg.humanFloor = additiveFloorPatterns(DEFAULTS.humanFloor, cfg.humanFloor);
  cfg.base = {
    ...cfg.base,
    securityFloor: securityFloorScore(cfg),
  };
  validateScoreConfig(cfg);
  assertBuiltInAgentCurve(cfg.curve);
  return cfg;
}

function loadConfig(repoRoot) {
  const p = path.join(repoRoot || process.cwd(), "harness-config.json");
  if (!fs.existsSync(p)) return validateScoreConfig(DEFAULTS);
  return configFromRoot(parseConfigJson(fs.readFileSync(p, "utf8"), p));
}

function loadConfigAtRevision(repoRoot, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision || "")) {
    throw new Error("risk policy base revision must be an exact SHA");
  }
  const root = repoRoot || process.cwd();
  try {
    execFileSync(
      "git",
      ["-C", root, "cat-file", "-e", `${revision}^{commit}`],
      {
        stdio: "ignore",
      },
    );
  } catch {
    throw new Error(
      `risk policy base revision is not a readable commit: ${revision}`,
    );
  }
  let policyPath;
  try {
    policyPath = execFileSync(
      "git",
      [
        "-C",
        root,
        "ls-tree",
        "--name-only",
        revision,
        "--",
        "harness-config.json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    throw new Error(
      `risk policy tree is not readable at base revision: ${revision}`,
    );
  }
  if (!policyPath) return validateScoreConfig(DEFAULTS);
  let raw;
  try {
    raw = execFileSync(
      "git",
      ["-C", root, "show", `${revision}:harness-config.json`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    throw new Error(
      `risk policy file is not readable at base revision: ${revision}`,
    );
  }
  return configFromRoot(
    parseConfigJson(raw, `${revision}:harness-config.json`),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function score({
  base = null,
  gitRunner = defaultGitRunner,
  config = null,
  repoRoot = null,
  taskType: persistedTaskType = null,
} = {}) {
  const cfg = validateScoreConfig(config || loadConfig(repoRoot));
  const resolved = resolveBase(gitRunner, base);

  // Fail CLOSED when no durable base could be found. Scoring a change against an
  // unknown base can only produce a misleadingly LOW number (a truncated diff),
  // which would under-provision review and skip break-glass. Instead score
  // maximum risk with an explicit reason so the operator sees why.
  if (resolved.unresolved) {
    const knobs = scoreToKnobs(100, cfg);
    return {
      riskScore: 100,
      mergeAuthority: cfg.mergeAuthority,
      taskType: "unknown",
      changeNature: "unknown",
      diffStats: { files: 0, lines: 0 },
      reasons: [
        "risk base unresolved (no --base, no GITHUB_BASE_REF, no upstream, no origin/main) — scoring maximum risk fail-closed; pass --base or fetch the base ref for an accurate score",
      ],
      knobs,
      base: null,
      baseUnresolved: true,
    };
  }

  const resolvedBase = resolved.ref;
  const {
    descriptors,
    diffStats,
    mergeBase,
    mergeBaseFallback,
    collectionFailed,
    collectionError,
  } = collectDescriptors(resolvedBase, gitRunner);

  // Fail CLOSED when the diff itself could not be read. Same reasoning as the
  // unresolved-base branch above: an unreadable diff can only produce a
  // misleadingly LOW score, and here it would also be labelled "no changes
  // detected" — actively misleading the operator.
  if (collectionFailed) {
    return {
      riskScore: 100,
      mergeAuthority: cfg.mergeAuthority,
      taskType: "unknown",
      changeNature: "unknown",
      diffStats: { files: 0, lines: 0 },
      reasons: [
        `diff collection failed against ${resolvedBase} — scoring maximum risk fail-closed${
          collectionError ? ` (${collectionError})` : ""
        }; fetch the base ref or unshallow the clone for an accurate score`,
      ],
      knobs: scoreToKnobs(100, cfg),
      base: resolvedBase,
      diffCollectionFailed: true,
    };
  }

  if (persistedTaskType !== null && !TASK_TYPES.has(persistedTaskType)) {
    throw new Error(`invalid persisted task type '${persistedTaskType}'`);
  }
  const taskType =
    persistedTaskType ||
    classifyTaskType(descriptors, collectCommitSubjects(mergeBase, gitRunner));
  const scored = applyTaskTypeFloor(
    computeScore(descriptors, diffStats, cfg),
    taskType,
    cfg,
  );
  if (mergeBaseFallback) {
    scored.reasons = [
      `merge-base HEAD ${resolvedBase} failed — diff computed against raw ${resolvedBase} instead, which may include base-side commits and distort line counts`,
      ...scored.reasons,
    ];
  }
  const knobs = scoreToKnobs(scored.riskScore, cfg);
  return {
    ...scored,
    mergeAuthority: cfg.mergeAuthority,
    taskType,
    diffStats,
    knobs,
    base: resolvedBase,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { base: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base" && argv[i + 1]) out.base = argv[++i];
    else if (argv[i] === "--json") out.json = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = score({ base: args.base });

  const gh = process.env.GITHUB_OUTPUT;
  if (gh) {
    const lines = [
      `riskScore=${result.riskScore}`,
      `taskType=${result.taskType}`,
      `changeNature=${result.changeNature}`,
      `diffFiles=${result.diffStats.files}`,
      `diffLines=${result.diffStats.lines}`,
      `agents=${result.knobs.agents}`,
      `codex=${result.knobs.codex}`,
      `codexRounds=${result.knobs.codexRounds}`,
    ];
    fs.appendFileSync(gh, lines.join("\n") + "\n");
  }

  if (args.json || !gh) {
    console.log(JSON.stringify(result, null, 2));
  }
}

if (require.main === module) main();

/**
 * True when ANY changed file matches the legacy manual-governance subset
 * (`humanFloor`). `quality-authorize-merge.sh` evaluates this only when the
 * persisted policy explicitly selects human-required merge authority. `files`
 * is repo-relative paths; `cfg` is the effective scoring config.
 */
function touchesHumanFloor(files, cfg = DEFAULTS) {
  // Case-INSENSITIVE, normalized matching: an attacker/agent must not evade the
  // floor by casing (AUTH/, .PEM), a leading ./, or backslash separators. We
  // lowercase both the path and the patterns and normalize separators before
  // matching, rather than changing the shared matchesPattern (which tier scoring
  // also uses) — keeping this hardening local to the human floor.
  // The built-in list is an immutable security minimum. Configuration comes
  // from the reviewed checkout, so treating cfg.humanFloor as a replacement
  // would let a PR commit `humanFloor: []` and authorize its own sensitive diff.
  // Repository policy can only add stricter patterns.
  const patterns = additiveFloorPatterns(DEFAULTS.humanFloor, cfg?.humanFloor);
  return (files || []).some(
    (file) =>
      hasControlCharacters(file) ||
      matchesPattern(normalizeFloorPath(file), patterns),
  );
}

module.exports = {
  score,
  computeScore,
  classifyChangeNature,
  scoreToKnobs,
  classifyTaskType,
  manifestRisk,
  matchesPattern,
  globToRegExp,
  fileIsMechanical,
  workflowDiffIsRiskBearing,
  descriptorBaseRisk,
  isForcedLogic,
  matchesSecurityFloor,
  touchesHumanFloor,
  loadConfig,
  loadConfigAtRevision,
  deepMerge,
  parseNameStatusZ,
  parseNumstatZ,
  DEFAULTS,
  CRITICAL_RISK_SCORE,
};
