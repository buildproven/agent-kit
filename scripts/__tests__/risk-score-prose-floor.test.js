const {
  matchesSecurityFloor,
  computeScore,
  CRITICAL_RISK_SCORE,
  DEFAULTS,
} = require("../risk-score");

// ---------------------------------------------------------------------------
// Ordinary changes must not receive critical treatment.
//
// The security-floor patterns are deliberately token-broad so real credential
// material (id_rsa, .p12, oauth config) cannot evade them. Applied to prose,
// that breadth misfired: `docs/monkey.md` matched `**/*key*.*` and scored 85,
// forcing a full mutation + xhigh-Codex campaign onto a documentation edit.
//
// These tests pin BOTH directions: prose escapes the floor on name alone, and
// every genuinely sensitive surface keeps it.
// ---------------------------------------------------------------------------

describe("prose files do not reach the security floor by filename alone", () => {
  const falsePositives = [
    // Ordinary words ending in "key". The deny-list replaced an open-ended
    // qualifier allowlist, so these pin the other side of that inversion — a
    // future widening must not swallow them.
    ["docs/monkeys.md", "plural of monkey"],
    ["docs/donkey.md", "donkey"],
    ["docs/turkey.md", "turkey"],
    ["docs/whiskey.md", "whiskey"],
    ["docs/keynote.md", "'keynote' only starts with key"],
    // Word-formation suffixes. These are the false positives the whole change
    // exists to remove; catching them again would reintroduce the 44% rate.
    ["docs/tokenizer.md", "'tokenizer' is not a token"],
    ["docs/secretary.md", "'secretary' is not a secret"],
    ["docs/passwordless.md", "'passwordless' is an auth-flow doc"],
    ["docs/token-prod.md", "compound, not a decorated bare noun"],
    ["docs/secret-santa.md", "compound"],
    ["docs/rate-limit (1).md", "decoration on a non-credential noun"],
    ["docs/monkey (1).md", "decoration on monkey"],
    ["docs/monkey.md", "'monkey' contains the substring 'key'"],
    ["docs/api-keyboard.md", "'api-keyboard' is not an api key"],
    ["docs/keyboard-shortcuts.md", "'keyboard' contains 'key'"],
    ["docs/token-budget.md", "'token-budget' is a cost doc, not a credential"],
    ["docs/auth-guide.md", "an auth *guide* is prose about auth"],
    ["docs/deploy-notes.md", "deploy notes are prose, not a deploy script"],
    ["notes/passwords-ux.txt", "prose discussing password UX"],
    ["docs/licensing-faq.mdx", "licensing FAQ prose"],
    ["CHANGELOG.md", "ordinary changelog"],
  ];

  it.each(falsePositives)("%s is not on the floor (%s)", (file) => {
    expect(matchesSecurityFloor(file)).toBe(false);
  });
});

describe("security-relevant prose keeps the floor", () => {
  // Prose living inside a sensitive directory documents the very surface the
  // floor protects. Escaping by extension would be a real weakening.
  const stillSensitive = [
    // Regressions caught by independent review of this PR — each was on the
    // floor before the prose carve-out and silently fell off it. Kept as
    // explicit cases because the original suite tested only paths the
    // implementation already handled, so it was not red-capable against the
    // actual weakening.
    [".github/workflows/README.md", "CI dir is top-tier supply-chain surface"],
    [".github/workflows/notes.txt", "same, .txt"],
    [".husky/README.md", "git hooks directory"],
    ["my-secret-key.txt", "qualifier-prefixed credential name"],
    ["prod-api-key.txt", "qualifier-prefixed api key"],
    ["license-key.md", "license key"],
    ["key-prod.md", "trailing-token credential name"],
    ["session-key-notes.md", "credential stem mid-name"],
    [".env.md", "prose suffix must not launder .env"],
    [".env.production.md", "multi-extension .env"],
    ["prod.env.md", ".env as inner extension"],
    ["docs/id_rsa.md", "ssh private key under a prose suffix"],
    ["id_rsa.txt", "same, .txt"],
    ["docs/id_ed25519.txt", "ed25519 private key"],
    ["passwd/README.md", "prose inside a passwd directory"],
    ["src/api-key.txt", "a .txt named api-key may BE the credential"],
    ["src/api_key.txt", "underscore variant"],
    ["src/apikey.txt", "unseparated variant"],
    ["config/access-key.txt", "access-key .txt"],
    ["src/key.txt", "bare 'key' stem"],
    ["src/keys.txt", "bare 'keys' stem"],
    ["secrets/rotation.md", "runbook inside secrets/"],
    ["auth/README.md", "README inside auth/"],
    ["keys/README.txt", "README inside keys/"],
    ["deploy/runbook.md", "runbook inside deploy/"],
    ["licensing/terms.md", "prose inside licensing/"],
    ["docs/credentials/handling.md", "nested credentials dir"],
    ["README-secrets-policy.md", "named as a secrets policy document"],
  ];

  it.each(stillSensitive)("%s stays on the floor (%s)", (file) => {
    expect(matchesSecurityFloor(file)).toBe(true);
  });
});

describe("non-prose security surfaces are untouched", () => {
  // The narrowing applies ONLY to prose extensions. Nothing executable or
  // credential-bearing may change behavior.
  const sensitive = [
    ".env",
    ".env.example",
    "certs/server.pem",
    "certs/tls.key",
    "config/auth/session.js",
    "scripts/deploy.sh",
    "test/license.test.js",
    ".github/workflows/ci.yml",
    "src/keystore.ts",
    "id_rsa",
    "secrets.json",
  ];

  it.each(sensitive)("%s stays on the floor", (file) => {
    expect(matchesSecurityFloor(file)).toBe(true);
  });
});

describe("no credential-shaped path escapes the floor", () => {
  // The hand-written lists above only cover cases someone thought of, which is
  // how three regression classes shipped past the first draft. This derives its
  // candidates FROM the floor patterns themselves, so a newly-added floor
  // pattern is swept automatically rather than needing a matching test.
  //
  // It asserts the narrow, non-negotiable property: a path whose basename
  // denotes credential MATERIAL keeps the floor under every prose extension.
  // Security-topic prose (docs/auth.md) is deliberately excluded — see the
  // trade-off note in risk-score.js.
  const CREDENTIAL_MATERIAL = [
    ".env",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "api-key",
    "api_key",
    "apikey",
    "access-key",
    "private-key",
    "secret-key",
    "signing-key",
    "key",
    "keys",
    "keystore",
    "keyring",
    "keychain",
    "credentials",
    "secrets",
    // Credential NOUNS, singular and plural. The first repair generalized over
    // key-material extensions only, so `token.json.md` and `password.txt` still
    // dropped — the same "fixed the instances, not the class" miss. Listing the
    // nouns here makes the derived sweep cover them automatically.
    "credential",
    "secret",
    "password",
    "passwd",
    "token",
    "tokens",
    "access_token",
    "refresh-token",
  ];
  // Multi-extension forms: a prose suffix must not launder any of the above.
  const LAUNDERED_SUFFIXES = [".json", ".yaml", ".yml", ".conf"];
  const PROSE_EXTS = [".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"];
  const SENSITIVE_DIRS = [
    ".github/workflows",
    ".husky",
    "secrets",
    "auth",
    "keys",
    "deploy",
    "passwd",
    "passwords",
  ];

  const materialCases = CREDENTIAL_MATERIAL.flatMap((stem) =>
    PROSE_EXTS.flatMap((ext) => [
      `${stem}${ext}`,
      `docs/${stem}${ext}`,
      `src/prod-${stem}${ext}`,
      // Laundered through a config extension: token.json.md, password.yaml.txt
      ...LAUNDERED_SUFFIXES.map((inner) => `${stem}${inner}${ext}`),
    ]),
  );

  // The sweep above varies the credential NOUN and holds the extension prose.
  // BUI-640 lived on the other axis: key material identified by its EXTENSION
  // rather than its stem. `certs/server.pem.md` has no credential noun to
  // tokenize, so nothing above could ever generate it, and every probe of
  // `.key` looked healthy because `.key` matches the `**/*key*` substring
  // pattern instead of the extension path.
  const KEY_MATERIAL_EXTENSIONS = [
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".jks",
    ".keystore",
    ".ppk",
    ".pk8",
    ".kdb",
    ".kdbx",
  ];

  const keyMaterialCases = KEY_MATERIAL_EXTENSIONS.flatMap((material) =>
    PROSE_EXTS.flatMap((ext) => [
      `server${material}${ext}`,
      `certs/server${material}${ext}`,
      `docs/tls${material}${ext}`,
    ]),
  );

  it.each(keyMaterialCases)(
    "keeps the security floor for laundered key material %s",
    (file) => {
      expect(matchesSecurityFloor(file)).toBe(true);
    },
  );

  // Separator variants must tokenize like the hyphen form.
  // Decoration around a credential noun — the OS-generated duplicate names a
  // pasted credential dump actually arrives under, plus the invisible-character
  // variants that render identically to the bare noun.
  const DECORATED = ["token", "secrets", "password", "credentials"].flatMap(
    (noun) => [
      `docs/${noun} (1).md`,
      `docs/${noun} copy.txt`,
      `docs/${noun}(copy).md`,
      `docs/${noun} .md`,
      `docs/${noun}!.md`,
      `docs/[${noun}].md`,
      `docs/${noun}\u200b.md`,
      `docs/${noun}\ufeff.md`,
      `docs/${noun}\u00a0.md`,
      `docs/${noun}\u202e.md`,
    ],
  );

  it.each(DECORATED)("%j keeps the security floor", (file) => {
    expect(matchesSecurityFloor(file)).toBe(true);
  });

  // Unseparated <qualifier>key compounds. The old allowlist was open-ended and
  // three review rounds each added more; this asserts the inverted deny-list
  // handles qualifiers nobody enumerated.
  const QUALIFIER_KEYS = [
    "deploy",
    "priv",
    "pub",
    "root",
    "gpg",
    "rsa",
    "hmac",
    "session",
    "service",
    "jwt",
    "bearer",
    "refresh",
    "client",
    "aes",
    "pgp",
  ].flatMap((q) => [`docs/${q}key.md`, `docs/${q}keys.txt`]);

  it.each(QUALIFIER_KEYS)("%s keeps the security floor", (file) => {
    expect(matchesSecurityFloor(file)).toBe(true);
  });

  const separatorCases = [
    "api key.md",
    "api+key.md",
    "api~key.txt",
    "api key.txt",
  ];

  it.each(separatorCases)("%s keeps the security floor", (file) => {
    expect(matchesSecurityFloor(file)).toBe(true);
  });

  it.each(materialCases)("%s keeps the security floor", (file) => {
    expect(matchesSecurityFloor(file)).toBe(true);
  });

  const dirCases = SENSITIVE_DIRS.flatMap((dir) =>
    PROSE_EXTS.map((ext) => `${dir}/README${ext}`),
  );

  it.each(dirCases)("%s keeps the security floor", (file) => {
    expect(matchesSecurityFloor(file)).toBe(true);
  });
});

describe("repo-declared securityFloor patterns survive the carve-out", () => {
  // The carve-out narrows the BUILT-IN floor, whose breadth is an accident of
  // substring matching. A pattern a repository deliberately adds to
  // harness-config.json is a decision, and additiveFloorPatterns exists so repo
  // policy can only ever ADD strictness. Running isProsePath() first silently
  // voided those opt-ins — no test exercised matchesSecurityFloor with a custom
  // cfg, so nothing caught it.
  const withCompliance = {
    ...DEFAULTS,
    securityFloor: [...DEFAULTS.securityFloor, "**/compliance/**"],
  };

  it("honors a repo-added pattern for prose", () => {
    expect(matchesSecurityFloor("compliance/soc2.md", withCompliance)).toBe(
      true,
    );
  });

  it("honors a repo-added pattern regardless of its casing", () => {
    // normalizeFloorPath lowercases the PATH, so a pattern carrying any
    // capitals could never match and the opt-in was silently voided.
    const upper = {
      ...DEFAULTS,
      securityFloor: [...DEFAULTS.securityFloor, "**/Compliance/**"],
    };
    expect(matchesSecurityFloor("Compliance/soc2.md", upper)).toBe(true);
    expect(matchesSecurityFloor("compliance/soc2.md", upper)).toBe(true);
  });

  it("honors a repo-added pattern for code", () => {
    expect(matchesSecurityFloor("compliance/app.js", withCompliance)).toBe(
      true,
    );
  });

  // …without disabling the carve-out for the built-in patterns. Diffing against
  // DEFAULTS is what separates the two: cfg.securityFloor legitimately contains
  // the built-in list, so treating the whole array as repo-declared would undo
  // this entire change.
  it.each(["docs/monkey.md", "docs/monkeys.md", "docs/token-budget.md"])(
    "%s still escapes the built-in floor under a custom cfg",
    (file) => {
      expect(matchesSecurityFloor(file, withCompliance)).toBe(false);
    },
  );
});

describe("scored tier for ordinary documentation work", () => {
  // End-to-end: a docs-only change must land far below the critical band, not
  // merely below the floor.
  function scoreFor(files) {
    return computeScore(
      files.map((file) => ({ status: "M", file })),
      { files: files.length, lines: 12 },
      DEFAULTS,
    );
  }

  it("keeps a docs-only change out of the critical band", () => {
    const result = scoreFor([
      "docs/monkey.md",
      "docs/token-budget.md",
      "docs/auth-guide.md",
    ]);
    expect(result.riskScore).toBeLessThan(CRITICAL_RISK_SCORE);
  });

  it("still escalates when real security surface is touched", () => {
    const result = scoreFor(["docs/monkey.md", "config/auth/session.js"]);
    expect(result.riskScore).toBeGreaterThanOrEqual(
      DEFAULTS.base.securityFloor,
    );
  });
});

describe("content promotes prose the filename released (BUI-641)", () => {
  // The root cause behind four review rounds: the floor asked "is this
  // credential material?" — a question about CONTENT — using only the
  // filename. No pattern refinement can answer it, which is why six
  // name-matching mechanisms accreted and each review found another variant.
  //
  // This is the mirror of contentAwareFloor/workflowDiffIsRiskBearing: those
  // DEMOTE a floor path whose diff is inert, this PROMOTES a released path
  // whose diff carries a secret.
  const descriptor = (file, patch) => ({ status: "M", file, patch });
  const scoreOf = (file, patch) =>
    computeScore([descriptor(file, patch)], { files: 1, lines: 5 }, DEFAULTS);

  const SECRETS = [
    ["-----BEGIN RSA PRIVATE KEY-----", "PEM private key"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----", "OpenSSH private key"],
    ["AKIAIOSFODNN7EXAMPLE", "AWS access key id"],
    ["ghp_0123456789abcdefghijklmnopqrstuvwxyz", "GitHub token"],
    ["sk-ant-0123456789abcdefghijklmn", "Anthropic key"],
  ];

  it.each(SECRETS)("a doc that ADDS %s reaches the floor (%s)", (secret) => {
    const result = scoreOf("docs/setup-guide.md", `+${secret}\n`);
    expect(result.riskScore).toBeGreaterThanOrEqual(
      DEFAULTS.base.securityFloor,
    );
  });

  // NAME-INDEPENDENCE. The first version of this branch was gated on
  // isProsePath — a NAME test — so a file the name logic had already
  // disqualified could never be promoted by its content. That reintroduced the
  // exact coupling the content check exists to break, and left BUI-640's
  // dangerous case open: certs/server.pem.md with a real key scored 10.
  it.each([
    "certs/server.pem.md",
    "foo.p12.txt",
    "x.pfx.md",
    "bar.jks.md",
    "z.kdbx.md",
    "src/config.js",
    "data/fixture.json",
    "README.rst",
  ])("%s reaches the floor on content alone, whatever its name", (file) => {
    const result = scoreOf(file, "+-----BEGIN RSA PRIVATE KEY-----\n");
    expect(result.riskScore).toBeGreaterThanOrEqual(
      DEFAULTS.base.securityFloor,
    );
  });

  it("REMOVING a leaked secret is remediation, not risk", () => {
    // Penalising the cleanup with a critical-tier review would discourage it.
    const result = scoreOf(
      "docs/guide.md",
      "ـ".replace("ـ", "-") + "-----BEGIN RSA PRIVATE KEY-----\n",
    );
    expect(result.riskScore).toBeLessThan(DEFAULTS.base.securityFloor);
  });

  it.each([
    ["docs/notes.md", "+ordinary prose about the system\n"],
    ["CHANGELOG.md", "+### Added\n+- a feature\n"],
    ["docs/monkey.md", "+monkeys are primates\n"],
    ["docs/token-budget.md", "+We spent 40k tokens this week.\n"],
  ])("%s stays released when its diff carries no secret", (file, patch) => {
    expect(scoreOf(file, patch).riskScore).toBeLessThan(
      DEFAULTS.base.securityFloor,
    );
  });
});
