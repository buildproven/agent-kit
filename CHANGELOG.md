# Changelog

All notable changes to claude-kit are documented here.

## Unreleased

### Added

- A deterministic, provider-free V-cycle creator now binds immutable
  traceability, committed build candidates, creator-run verification receipts,
  rework, and completion in external locked state (BUI-790).
- A public deterministic quality runner now executes one exact manifest through
  risk selection, gates, bounded review, optional protected merge, and terminal
  telemetry. It resumes exact-head evidence and returns a typed external
  capability pause instead of asking the model to sequence phase scripts
  (BUI-791).

- The revision-bound quality engine now supports opt-in Gemini review as a
  bounded, read-only primary or fallback provider. Gemini responses use the
  same strict structured-review schema, provider circuit, attempt governor,
  artifact inventory, and fail-closed merge evidence as Claude and Codex
  (#139).

## [4.10.1](https://github.com/buildproven/agent-kit/compare/v4.10.0...v4.10.1) (2026-09-15)


### Bug Fixes

* honor the mutation acknowledgement the gate already accepted ([#535](https://github.com/buildproven/agent-kit/issues/535)) ([5894481](https://github.com/buildproven/agent-kit/commit/58944816d54624e66ba84fd6528b7cf270d3042e))
* let an operator acknowledge missing mutation evidence ([#532](https://github.com/buildproven/agent-kit/issues/532)) ([45f5089](https://github.com/buildproven/agent-kit/commit/45f50892e7412d157fa582b6ad8ab63d293663cb))
* pass only named build variables into repository gates ([#529](https://github.com/buildproven/agent-kit/issues/529)) ([39607a0](https://github.com/buildproven/agent-kit/commit/39607a063d693467afb4ff9c8d11ca011e690012))

## [4.10.0](https://github.com/buildproven/claude-kit/compare/v4.9.1...v4.10.0) (2026-09-15)


### Features

* add native advisory task selection ([#503](https://github.com/buildproven/claude-kit/issues/503)) ([b80eea3](https://github.com/buildproven/claude-kit/commit/b80eea397ac311a3a9167381aaf80b01524609eb))
* add product delivery evidence contracts ([7f29968](https://github.com/buildproven/claude-kit/commit/7f2996899428c6f70cb9b2e3373bf02ce1c2e236))
* add protected engineering delivery claim ([7bb2b18](https://github.com/buildproven/claude-kit/commit/7bb2b18b2d4558bfe8a9440e4fa32336434f53fe))
* add protected product evidence admission ([#477](https://github.com/buildproven/claude-kit/issues/477)) ([882c93f](https://github.com/buildproven/claude-kit/commit/882c93f7f4b65473ae299560dff91345731dd3fb))
* reap finished quality campaign state ([#525](https://github.com/buildproven/claude-kit/issues/525)) ([dadaca5](https://github.com/buildproven/claude-kit/commit/dadaca5b34515ef66b8affb5bfcb5fdd7120d54b))
* share task completion impact checks ([#499](https://github.com/buildproven/claude-kit/issues/499)) ([f6ad4aa](https://github.com/buildproven/claude-kit/commit/f6ad4aa99e4bdbc0fad04f5c1cfbb25c885dd9c6))


### Bug Fixes

* accept role-complete Claude fallback ([e8884b2](https://github.com/buildproven/claude-kit/commit/e8884b2d95167bec6df2fb15ea17161c83db7789))
* add repository-scoped product trust ([#505](https://github.com/buildproven/claude-kit/issues/505)) ([182e17f](https://github.com/buildproven/claude-kit/commit/182e17ffb75673124188922bc1f667c93676e587))
* admit CI budget for every redispatch ([5d01620](https://github.com/buildproven/claude-kit/commit/5d0162090a14694f10e880ccb7d8e540bd9b6bf1))
* admit CI budget for every redispatch ([e4a90d2](https://github.com/buildproven/claude-kit/commit/e4a90d2774216fdf078da6271e76854870bb4e13))
* allow large review patches in agent selection ([#483](https://github.com/buildproven/claude-kit/issues/483)) ([5469916](https://github.com/buildproven/claude-kit/commit/546991633c9183c874bfbf9f7996f28e1a41097f))
* apply the security floor to prose-suffixed key material ([#526](https://github.com/buildproven/claude-kit/issues/526)) ([7e7d79c](https://github.com/buildproven/claude-kit/commit/7e7d79c65568fd078df43a8e227c1b21513b6498))
* authenticate product completion receipts ([3df7ab5](https://github.com/buildproven/claude-kit/commit/3df7ab5d7f1193d300af6a51e9b359b20d62bd4d))
* avoid unsafe documentation matching ([c079dfd](https://github.com/buildproven/claude-kit/commit/c079dfd04edfc66d6d38278efb8938b360519e58))
* bind delivery receipts to revision ([4ad0eb5](https://github.com/buildproven/claude-kit/commit/4ad0eb537fef26cfa8f21d7d7b6944eb28000c3b))
* bind dependency preflight trust boundaries ([6202a72](https://github.com/buildproven/claude-kit/commit/6202a722b167bf694d602038b830fec53e8d6909))
* bind dependency selections and command owners ([5e8ffd7](https://github.com/buildproven/claude-kit/commit/5e8ffd76ceffde9f0a94fd880ba37a5abfada3f4))
* bind MCP lock to process identity ([80984dd](https://github.com/buildproven/claude-kit/commit/80984dda2bf8453c8a6ecf414fa8ef6af0af90ac))
* bind preflight resource and path budgets ([d910139](https://github.com/buildproven/claude-kit/commit/d910139183fe622fd3e369167d1c7fcd40c864b9))
* bind preflight to exact package identities ([ac09d4c](https://github.com/buildproven/claude-kit/commit/ac09d4c808e80bd262bd8469a40ae1908a545a2b))
* bind product admission evidence ([#497](https://github.com/buildproven/claude-kit/issues/497)) ([6b90059](https://github.com/buildproven/claude-kit/commit/6b900592c192725d3c117ca63b6b285a7ed78e89))
* bind public trust artifacts to repository ID ([75f9607](https://github.com/buildproven/claude-kit/commit/75f96075d3c847e045db17e75a8ab417c9761751))
* bind rejected dispatch expiry ([#520](https://github.com/buildproven/claude-kit/issues/520)) ([848a678](https://github.com/buildproven/claude-kit/commit/848a6782b04b4235cdfb85b54bfa2817cfe03162))
* bind required-check completion to campaign ([36e08da](https://github.com/buildproven/claude-kit/commit/36e08da32f71f7b2f33a8b8e504c4b34815020ed))
* bind rewritten required checks to workflow runs ([#513](https://github.com/buildproven/claude-kit/issues/513)) ([5ff6805](https://github.com/buildproven/claude-kit/commit/5ff6805052d0b2a5784a3b16cd2f8d9602204536))
* bind source evidence environment identity ([b91d2bd](https://github.com/buildproven/claude-kit/commit/b91d2bd64f71bf845ebf76d1cc85156d79af8bd7))
* bind zsh provenance to evidence bundle ([d16e59f](https://github.com/buildproven/claude-kit/commit/d16e59ffe52179b87bcc7c98324dae92192188d7))
* bound mutation selector adaptation ([fadabd8](https://github.com/buildproven/claude-kit/commit/fadabd8228163676098bfc81560c52ff3a1a9f70))
* bound provider cancellation test cleanup ([#444](https://github.com/buildproven/claude-kit/issues/444)) ([4954513](https://github.com/buildproven/claude-kit/commit/4954513d563a158c091ebf038bcd8656713ebfe7))
* bound the CI wait so a stuck check cannot hang a campaign ([#524](https://github.com/buildproven/claude-kit/issues/524)) ([0c459b6](https://github.com/buildproven/claude-kit/commit/0c459b69da8039f8b3fe92eca3fc70fe20bfcde1))
* bound vitest concurrency for quality runs ([4997db7](https://github.com/buildproven/claude-kit/commit/4997db7d73c402a3a067e8854893fa0ae5de1b48))
* classify dependency maintenance by committed manifest changes ([#498](https://github.com/buildproven/claude-kit/issues/498)) ([53a9453](https://github.com/buildproven/claude-kit/commit/53a94534253ac20d927cfb2c72cc02354cfb618d))
* classify quality controls as non-product ([370b815](https://github.com/buildproven/claude-kit/commit/370b8150dcf047935c168bddb4c6973e3c3f9904))
* classify quality runtime link as contract ([#493](https://github.com/buildproven/claude-kit/issues/493)) ([2b15da8](https://github.com/buildproven/claude-kit/commit/2b15da8adfd08e16d7d96e4622013de4e7a68c0c))
* classify runtime content as product changes ([0f553da](https://github.com/buildproven/claude-kit/commit/0f553dafca73337b1cb51376ec9d256150f7ace3))
* classify test configuration as infrastructure ([#495](https://github.com/buildproven/claude-kit/issues/495)) ([6195ca1](https://github.com/buildproven/claude-kit/commit/6195ca12dc6e5b16c89f338a2d58e2adb1e4ef8c))
* classify workflow contract script as infrastructure ([#494](https://github.com/buildproven/claude-kit/issues/494)) ([aec0d5a](https://github.com/buildproven/claude-kit/commit/aec0d5ae45113a75da082f3f5d86d89dda22f783))
* close cross-manager preflight review gaps ([e54a3a7](https://github.com/buildproven/claude-kit/commit/e54a3a76b8a5b6858404df12f931d308f855e6ce))
* close dependency preflight trust gaps ([63aad15](https://github.com/buildproven/claude-kit/commit/63aad15bb211672e6d87605bcf577662bd681fb7))
* contain MCP profile cache paths ([6f5d76e](https://github.com/buildproven/claude-kit/commit/6f5d76e6dea5c327b286adef4f2973a04cb05514))
* cover imperative self delegation ([c50e4c7](https://github.com/buildproven/claude-kit/commit/c50e4c742c0b83fad4184a8b134745dd6c3bfa0b))
* cover product evidence producer changes ([883d019](https://github.com/buildproven/claude-kit/commit/883d01972059ed06a01cb2d9598b79d983416b28))
* detect backticked self delegation ([2b56a8d](https://github.com/buildproven/claude-kit/commit/2b56a8d4c35f79c1ce0f1cec906545e51ea0d3cc))
* diagnose CI admission conditions before budget denial ([514b544](https://github.com/buildproven/claude-kit/commit/514b54494f2242dbdc9988818b96d31557a43daf))
* emit schema-valid acceptance receipts ([#508](https://github.com/buildproven/claude-kit/issues/508)) ([081a58a](https://github.com/buildproven/claude-kit/commit/081a58a55bd2d8d13c4eec68b5cae1febdb14f57))
* enforce leading npx local-only option ([c8d95c6](https://github.com/buildproven/claude-kit/commit/c8d95c677d61abfde21e9389a7582cc7bc626d1e))
* exclude generated bundles from pattern checks ([c74e2eb](https://github.com/buildproven/claude-kit/commit/c74e2ebe4d9924c08580b08a795806b2d2470540))
* fail closed on implicit product claims ([9764489](https://github.com/buildproven/claude-kit/commit/97644890077a04a7a07194275069bc59209eed0f))
* fail closed on quality recovery ([ec0abe2](https://github.com/buildproven/claude-kit/commit/ec0abe2a910ff9171438366e3d841d294d63a272))
* fallback on provider input limits ([f8beb36](https://github.com/buildproven/claude-kit/commit/f8beb36371777c960bfcf032c7724be8047f0a90))
* fund audit impact test gates ([#516](https://github.com/buildproven/claude-kit/issues/516)) ([b829fca](https://github.com/buildproven/claude-kit/commit/b829fcab1878f5e248a7b9ed7ec6d9b85c2c14ff))
* fund claude-kit native test gate ([7f19e2e](https://github.com/buildproven/claude-kit/commit/7f19e2e79a2a8c7349b5bc1081f0d6c9d61b1fb0))
* fund declared long quality gates ([f44a151](https://github.com/buildproven/claude-kit/commit/f44a15166bf2420932eceb017533b9962b48d3c6))
* handle empty quality review panels ([#489](https://github.com/buildproven/claude-kit/issues/489)) ([16dab9e](https://github.com/buildproven/claude-kit/commit/16dab9e8149b77e8fd0553f50c839e84f86c12e3))
* handle npm mutation audit forms ([ebfa67f](https://github.com/buildproven/claude-kit/commit/ebfa67fbc5d66c624f9d26c138cf6983b1ec62f4))
* harden delivery claim evidence ([78bca5d](https://github.com/buildproven/claude-kit/commit/78bca5dab82ea8154050bf7f1ae9e5a358606b70))
* harden dependency preflight parsing ([8ebe408](https://github.com/buildproven/claude-kit/commit/8ebe40867a9c662636e83e1d74389eb17465eb54))
* harden MCP cache provenance ([2c8341b](https://github.com/buildproven/claude-kit/commit/2c8341b0ba048b44efabdd7fa69f85ee473c706b))
* harden quality runtime integrity ([ee1b667](https://github.com/buildproven/claude-kit/commit/ee1b667797789c92b71478742029cc37afa901ee))
* honor native operator route floor ([#518](https://github.com/buildproven/claude-kit/issues/518)) ([7d4ca99](https://github.com/buildproven/claude-kit/commit/7d4ca99438d7e7e8d511a2164840d8f76d16df00))
* install protected admission trust root ([5416ec4](https://github.com/buildproven/claude-kit/commit/5416ec46f660f40a5f4f5d24e176bec84e5bcbff))
* isolate Codex quality cache by version ([b92472d](https://github.com/buildproven/claude-kit/commit/b92472dca801f0e09d040845929aad1b89c60d7a))
* keep environment provenance in diagnostics ([7e7ff8f](https://github.com/buildproven/claude-kit/commit/7e7ff8f650d1e7f8003090e515c7cb26e104903d))
* keep impact gate budgets focused ([50c869c](https://github.com/buildproven/claude-kit/commit/50c869ceee37d600ec97d2b95b6e3df9cd136fa6))
* keep provider failure advisory ([d8bdd5a](https://github.com/buildproven/claude-kit/commit/d8bdd5ad9400ca1302e8df33567d91fd090985a9))
* make green ref-CAS delivery autonomous ([#438](https://github.com/buildproven/claude-kit/issues/438)) ([ab0be94](https://github.com/buildproven/claude-kit/commit/ab0be948bb0eadd472c3a15e088368b90794e404))
* make quality dependency checks pnpm-compatible ([#487](https://github.com/buildproven/claude-kit/issues/487)) ([2be2ca7](https://github.com/buildproven/claude-kit/commit/2be2ca7c1b1400f8f730b226381fbe620df03d5c))
* make status and backlog skills executable ([dcf191a](https://github.com/buildproven/claude-kit/commit/dcf191a37a9c38745fb102cd3e299f0e9b53880f))
* map Claude review companion tests ([ccce485](https://github.com/buildproven/claude-kit/commit/ccce48510e41c869e6ab8ae18cc8e9d9f3c30416))
* map protected evidence workflow tests ([e268ed4](https://github.com/buildproven/claude-kit/commit/e268ed444519cea634ce7b6112fde1c549b07bd7))
* map quality risk resolver tests ([06a928f](https://github.com/buildproven/claude-kit/commit/06a928f198da4025f4a57ca6295fc9d5e3451f78))
* narrow quality-control path exemption ([3fd60b6](https://github.com/buildproven/claude-kit/commit/3fd60b646aa02a477df6ef0340757e9d7bbdeb32))
* normalize Node selector arguments ([7241ba3](https://github.com/buildproven/claude-kit/commit/7241ba36d1fc516c8bad17e09110438751fb60f1))
* parse mutation runner arguments safely ([9fd27f1](https://github.com/buildproven/claude-kit/commit/9fd27f1f5b2bb3249484f920515dde848b8c6795))
* patch js-yaml dependency audit finding ([09bbc01](https://github.com/buildproven/claude-kit/commit/09bbc013c92d61cdd37e4a587eb75321dc7a6b5c))
* permit controlled self-mutation proof ([40ff2ca](https://github.com/buildproven/claude-kit/commit/40ff2ca7e426570459f3eb8a80ce74006ea6bc13))
* persist required-check registration deadline ([18d0f7b](https://github.com/buildproven/claude-kit/commit/18d0f7b77bfe3611e3098f2e80418f476c051f81))
* pin product evidence runner dependencies ([fcd2338](https://github.com/buildproven/claude-kit/commit/fcd23383556ed0de13fd189d37be648ce5c8f51a))
* portable autonomous-loop usage checks for Codex and Claude ([#468](https://github.com/buildproven/claude-kit/issues/468)) ([7a20076](https://github.com/buildproven/claude-kit/commit/7a200766e029db53bc344c629d82f1a8915447f7))
* prefer protected workflow controllers ([2bb28d8](https://github.com/buildproven/claude-kit/commit/2bb28d8f26d1ae0bc17ef0be7ff3f0c8ccb71338))
* preflight required-check dispatch safely ([d3cc863](https://github.com/buildproven/claude-kit/commit/d3cc86325615676575cd8fcd48aafe2ab108a2da))
* preserve check bindings through merge admission ([#514](https://github.com/buildproven/claude-kit/issues/514)) ([425d9a1](https://github.com/buildproven/claude-kit/commit/425d9a117186663ed8511722195fb1036c9dcee5))
* preserve CI admission read failures ([#521](https://github.com/buildproven/claude-kit/issues/521)) ([92d189a](https://github.com/buildproven/claude-kit/commit/92d189a05ea797086bbd68455535d07bfb2ee8c3))
* preserve default quality budgets ([25bd530](https://github.com/buildproven/claude-kit/commit/25bd530dba9e048878d4bdce314151a65f5a7ad4))
* preserve optional public trust commissioning ([77f3cc3](https://github.com/buildproven/claude-kit/commit/77f3cc32322d921c2fb3fae6c5bda3e383908370))
* preserve product verification diagnostics ([b2ffd07](https://github.com/buildproven/claude-kit/commit/b2ffd07ab6fc6d9d708b0e731e6b52a0361210a3))
* preserve provider reset recovery ([d99774d](https://github.com/buildproven/claude-kit/commit/d99774d18fc81669490f16fa2c640265ce67e832))
* preserve quality evidence across recovery ([#491](https://github.com/buildproven/claude-kit/issues/491)) ([27863b9](https://github.com/buildproven/claude-kit/commit/27863b9b8bcd5401f95a903739c0ae406c5e71d0))
* preserve trusted source environment provenance ([e481ec3](https://github.com/buildproven/claude-kit/commit/e481ec3ee2118da38551dc4d20ef054549e3f8be))
* preserve unfinished overnight outcomes and repair verification gates ([#469](https://github.com/buildproven/claude-kit/issues/469)) ([baffe22](https://github.com/buildproven/claude-kit/commit/baffe226d00b99f80addeb307486b80f488bd6ad))
* prevent concurrent quality runners ([#510](https://github.com/buildproven/claude-kit/issues/510)) ([6ece200](https://github.com/buildproven/claude-kit/commit/6ece200dc077ebf66ec9e5e2651f2a1893ef26fc))
* prevent recursive mutation audit tests ([23164c0](https://github.com/buildproven/claude-kit/commit/23164c07399fe000b87101ed26aae38afb1a3994))
* prevent unadmitted required-check replans ([e647532](https://github.com/buildproven/claude-kit/commit/e6475322aa2620407ef69b23d05bf78cfa2dcce0))
* prove submodule revision mutations ([#517](https://github.com/buildproven/claude-kit/issues/517)) ([2fb452d](https://github.com/buildproven/claude-kit/commit/2fb452d5a493fc72fad8b5750bbd3315969ef035))
* provision zsh for product evidence source ([d16481d](https://github.com/buildproven/claude-kit/commit/d16481d24608f2700da69e2fe37ae89e9d786271))
* read delivery receipts atomically ([f97d4fe](https://github.com/buildproven/claude-kit/commit/f97d4fe3f72e9871c65cee41b2154008562828ad))
* reclaim closed orphaned quality leases ([#466](https://github.com/buildproven/claude-kit/issues/466)) ([e83769d](https://github.com/buildproven/claude-kit/commit/e83769dab7f0bf6312cf13d637c47655c0e67698))
* recognize unprotected green checks ([dc3d844](https://github.com/buildproven/claude-kit/commit/dc3d844daa2b692c64af59ef0a8677cd44f9c609))
* reconcile ambiguous check dispatches ([#523](https://github.com/buildproven/claude-kit/issues/523)) ([ec22afa](https://github.com/buildproven/claude-kit/commit/ec22afa40b1623239287e1a1361c7d8a0118f731))
* reconcile proved-dead quality runners ([#515](https://github.com/buildproven/claude-kit/issues/515)) ([7f63f36](https://github.com/buildproven/claude-kit/commit/7f63f361965fe1760762e9d95d6ac4e5438ad544))
* recover dead quality manifest locks ([#501](https://github.com/buildproven/claude-kit/issues/501)) ([1086bb6](https://github.com/buildproven/claude-kit/commit/1086bb6f517fde0ca3087679f520f2dc43013477))
* recover exact campaigns after CI read failures ([#506](https://github.com/buildproven/claude-kit/issues/506)) ([4d6dc8f](https://github.com/buildproven/claude-kit/commit/4d6dc8fdcb0ea969395078689f3d7f646ab669b6))
* recover quality after green CI ([9896832](https://github.com/buildproven/claude-kit/commit/9896832e01118fe8787b78bdc2dca1f7c29381fd))
* recover unexecuted panel selection ([#502](https://github.com/buildproven/claude-kit/issues/502)) ([d8ff2f7](https://github.com/buildproven/claude-kit/commit/d8ff2f75a7bab5ba288e0d384ee5203dc1f5515f))
* reject control bytes in diagnostics ([bfb9598](https://github.com/buildproven/claude-kit/commit/bfb95981da31f16ab1eeee7c57a8c145bcaed53e))
* reject empty mutation selector plans ([683287a](https://github.com/buildproven/claude-kit/commit/683287ad09d94d2a0949369beb911f38fb149fb8))
* remove dependency read race ([de0281d](https://github.com/buildproven/claude-kit/commit/de0281d56392eba102dc799629b9aeb0d496fbb7))
* remove forced opus quality routing ([e9ce6af](https://github.com/buildproven/claude-kit/commit/e9ce6af3d727c02aad6702e6b339f27c2651535b))
* require Claude fallback model identity ([b096302](https://github.com/buildproven/claude-kit/commit/b096302602c036dd2ac77d5c7846d1fcc9ccfab5))
* resolve numeric GitHub repository identity ([5c6b079](https://github.com/buildproven/claude-kit/commit/5c6b079da853c8ca3137bc47f1150218b68efbeb))
* resolve the governor baseline through a proven rebase carry ([#527](https://github.com/buildproven/claude-kit/issues/527)) ([d779979](https://github.com/buildproven/claude-kit/commit/d779979921ff21b2da2c5c540dfe0f8fe645fa1f))
* restore mutation target classifier ([1922521](https://github.com/buildproven/claude-kit/commit/1922521a9d401c5a5f8e526a1922a820569e4569))
* resume interrupted quality campaigns ([d58806b](https://github.com/buildproven/claude-kit/commit/d58806bfa5dbe0e34e4416fd4af1073eee3f1966))
* resume interrupted quality campaigns ([d9f6c4c](https://github.com/buildproven/claude-kit/commit/d9f6c4cc929e8d15f7f98b3109b47d371b837adc))
* resume quality remediation loop ([f3b700e](https://github.com/buildproven/claude-kit/commit/f3b700e110cf12d30ec78e77f5c9423637ffad5b))
* retain deleted paths in product evidence ([#480](https://github.com/buildproven/claude-kit/issues/480)) ([cef7ecd](https://github.com/buildproven/claude-kit/commit/cef7ecdd517581ffc665391797eda9a749672297))
* retry definite dispatch rejections ([#519](https://github.com/buildproven/claude-kit/issues/519)) ([7742f23](https://github.com/buildproven/claude-kit/commit/7742f2398a5fb7fb645d6b9a699b945a5fa1b2a7))
* scope product workflow impact tests ([686abab](https://github.com/buildproven/claude-kit/commit/686abab8d69df0db84b68d9aea3f1127080c9e66))
* scope rebase mutation to live patch ([#522](https://github.com/buildproven/claude-kit/issues/522)) ([d7c123f](https://github.com/buildproven/claude-kit/commit/d7c123fe573ca1ad7239ddee35abc1e3e7f5a8b8))
* separate mutation plan failures ([d749f45](https://github.com/buildproven/claude-kit/commit/d749f4522ea7ca7b8bcac96cfb889da93534e223))
* separate product preflight from admission ([69f3617](https://github.com/buildproven/claude-kit/commit/69f3617a089b06de8372f9d23870948086c3566f))
* simplify receipt verification ([c092dc9](https://github.com/buildproven/claude-kit/commit/c092dc9c3c87bd61ec90682b5b1fd6d8e3534bcd))
* stop stalled quality remediation ([3752618](https://github.com/buildproven/claude-kit/commit/3752618b086825de374a0979b3c7e3c4a9fec231))
* stream Claude review prompts through stdin ([2fdd551](https://github.com/buildproven/claude-kit/commit/2fdd551b479d889bf414b023dd1e88a1b4c2284f))
* use shared supervisor for Claude review timeouts ([#488](https://github.com/buildproven/claude-kit/issues/488)) ([2d24d00](https://github.com/buildproven/claude-kit/commit/2d24d0013cf69da1176ea8a5aeec29ad909306a5))
* validate gate timeout input ([d072f1e](https://github.com/buildproven/claude-kit/commit/d072f1ea7beb72b14bec2ac320abc79f77444bcc))
* validate resumed required-check monitors ([f8391c6](https://github.com/buildproven/claude-kit/commit/f8391c6e69632ab3c20f868e856f4c7443b42e79))
* verify exact dependency installations ([34504dd](https://github.com/buildproven/claude-kit/commit/34504dd9778b2a2960407a678b6a98a34122824b))
* wait for CI before local review evidence ([0a2a8fa](https://github.com/buildproven/claude-kit/commit/0a2a8fabf0112fec42bfa48d5ecc09427ad9b6f1))


### Performance Improvements

* bound required-check workflow mapping ([ed4fb6d](https://github.com/buildproven/claude-kit/commit/ed4fb6d074bb724f5d3aa57190a08c02c9d013a8))
* cache verified MCP parity ([1b21e0c](https://github.com/buildproven/claude-kit/commit/1b21e0c8b7e2dbf79b7ef976fb14934dadc37c3f))
* keep focused quality tests local ([fedd1a1](https://github.com/buildproven/claude-kit/commit/fedd1a1284b2a92cd3ab52b566c0f9b8126cef36))
* preflight and reuse mutation evidence ([#443](https://github.com/buildproven/claude-kit/issues/443)) ([a935aa7](https://github.com/buildproven/claude-kit/commit/a935aa772c8c88267b7df9b230b6b8eb392f412c))

## [4.9.1](https://github.com/buildproven/claude-kit/compare/v4.9.0...v4.9.1) (2026-08-26)


### Bug Fixes

* advance recovery epoch on re-entry ([cbda92a](https://github.com/buildproven/claude-kit/commit/cbda92ad589508f5fa8987b67f6ca2c55559b83c))
* bind recovery telemetry to epoch ([535bb38](https://github.com/buildproven/claude-kit/commit/535bb381b63f0bf11e47370cb5b11b7a2355917e))
* fail when quality runtime is absent ([8e0e16b](https://github.com/buildproven/claude-kit/commit/8e0e16b2818ebb0093ab2a0ba1c9e555c481ff82))
* fence merge admission recovery ([1fbaded](https://github.com/buildproven/claude-kit/commit/1fbaded7c0fc5b35506517dfec990687040c44f2))
* fence recovered merge failures ([e473699](https://github.com/buildproven/claude-kit/commit/e47369974a1c71e4a9971ca07dbd8e9da8679ea7))
* isolate quality gate environment ([a015b0d](https://github.com/buildproven/claude-kit/commit/a015b0ded5c51ce44c95440cce6eb83b79baae32))
* persist nonstrict recovery conditions ([891a8ae](https://github.com/buildproven/claude-kit/commit/891a8ae583160f0d23cd106b492a78948a3684fa))
* persist recoverable merge requirements ([9b6981f](https://github.com/buildproven/claude-kit/commit/9b6981ffc963db86753d3999ec299086b81e87b1))
* preserve recovered merge capability pauses ([8ba41e6](https://github.com/buildproven/claude-kit/commit/8ba41e64e8f556bcd93f17f9ec55fb3a4068e5aa))
* preserve runtime cohort diagnostics ([1cd9247](https://github.com/buildproven/claude-kit/commit/1cd92476f6823fe91e1ab9ef98cf6e5c0f48ed67))
* preserve signed recovery capability conditions ([a5afd5a](https://github.com/buildproven/claude-kit/commit/a5afd5a5e2e3ef00394f779daced689afbf92b98))
* propagate incomplete runtime cohorts ([ed0d5af](https://github.com/buildproven/claude-kit/commit/ed0d5af82078713993b70385ad8ad7fa6a7ce672))
* rearm exact-head gate budget ([7a3382d](https://github.com/buildproven/claude-kit/commit/7a3382d94dfcb8c64938c70b70aca620dc524368))
* reconcile fenced merge receipts ([c1faeb8](https://github.com/buildproven/claude-kit/commit/c1faeb81c20d3a92bbd254cff39cb4106eddfc51))
* recover signed same-head merge blocks ([0d7afce](https://github.com/buildproven/claude-kit/commit/0d7afce6487374466ffbdb062c1df649b29d96d0))
* reopen proven descendant campaigns ([5a84abc](https://github.com/buildproven/claude-kit/commit/5a84abccc91f295dbb82f4756f3b7f36c6810318))
* report incomplete runtime siblings ([69cfc9b](https://github.com/buildproven/claude-kit/commit/69cfc9ba243c0ee6d2e2b5e5302a534582b4a70e))
* require complete quality runtime cohort ([884e714](https://github.com/buildproven/claude-kit/commit/884e7149e37f6a0b61dfde70af015b5866f8ad39))
* resume terminal campaign at merge ([b708b41](https://github.com/buildproven/claude-kit/commit/b708b411a8fb0d524151be2f546eb27ad1f330b5))
* scope terminal merge recovery ([ca3ae07](https://github.com/buildproven/claude-kit/commit/ca3ae07df02b7841a73f8b350fd4c8a1877ebeed))


### Performance Improvements

* coalesce overlapping vitest impact runs ([9020b1f](https://github.com/buildproven/claude-kit/commit/9020b1f8cbd73ecb40bc3a76c6015edf7d37a966))

## [4.9.0](https://github.com/buildproven/claude-kit/compare/v4.8.0...v4.9.0) (2026-08-23)


### Features

* expand phase-aware worker routing ([858f6ca](https://github.com/buildproven/claude-kit/commit/858f6ca40ccde316bc74477f68129fac17e3496c))


### Bug Fixes

* close phase routing integrity gaps ([f1e32a0](https://github.com/buildproven/claude-kit/commit/f1e32a0b2ef3f4153bd4278fbca8e3860d928fce))
* move overnight evidence outside governed targets ([e8c786d](https://github.com/buildproven/claude-kit/commit/e8c786dda1ecf0eeacbfc24346b2e29a2d6d8dcd))
* preserve provider defaults and protect dependencies ([ba4f7c1](https://github.com/buildproven/claude-kit/commit/ba4f7c11d98b6dab54550c24fe2ac81c8dc24dcc))
* protect the routing control plane ([bd0c480](https://github.com/buildproven/claude-kit/commit/bd0c4807c438a01a654bb7e46017a46c3bb32694))

## [4.8.0](https://github.com/buildproven/claude-kit/compare/v4.7.4...v4.8.0) (2026-08-22)


### Features

* add deterministic quality runner ([cc205e8](https://github.com/buildproven/claude-kit/commit/cc205e8245ebf8f0ad5e143141992f71bf61e754))
* add deterministic V-cycle creator ([1094c08](https://github.com/buildproven/claude-kit/commit/1094c08b94ce3c70bf3ca9187757a7f60e5446a8))
* support signed non-strict outage merges ([e52871c](https://github.com/buildproven/claude-kit/commit/e52871c2b759f5cdd7903035b16c26d4d739cfda))


### Bug Fixes

* authorize ref CAS descendant advance ([f8fb275](https://github.com/buildproven/claude-kit/commit/f8fb27560a3186aac6e79102f0a63148b574097a))
* bind merge evidence to candidate head ([bab304e](https://github.com/buildproven/claude-kit/commit/bab304e2a2c2be4156d54cce595c907dbfaca6ed))
* bind outage ref CAS at mutation boundary ([32138f1](https://github.com/buildproven/claude-kit/commit/32138f17f79b8e6dc152c081bc9e029d809d8beb))
* budget gates from review reserve ([ecce4ac](https://github.com/buildproven/claude-kit/commit/ecce4ac6361ca6d553ed2f2d935a5d332d26403e))
* compose ref CAS descendant authority ([7191229](https://github.com/buildproven/claude-kit/commit/7191229ea767a5da43735c876febf570a880f7a6))
* compose ref CAS review authority ([c4b4390](https://github.com/buildproven/claude-kit/commit/c4b439026e33132397797f3623211b63c612213a))
* discover owned provider processes through procfs ([aa8ec1d](https://github.com/buildproven/claude-kit/commit/aa8ec1d82e04fc6579c545ae86fcac9cddddbdaf))
* enforce quality runner terminal evidence ([e1947cc](https://github.com/buildproven/claude-kit/commit/e1947cc58754d9000d57da2ab74bbbb6ad558b63))
* enforce shared quality campaign budget ([9518080](https://github.com/buildproven/claude-kit/commit/95180802ae10f767f323f17bbc05adcebf92fb74))
* harden ref CAS convergence ([c5ad202](https://github.com/buildproven/claude-kit/commit/c5ad20291a7925bb8a7cdd32aaa6a88e5ca554dc))
* honor signed review exception at merge ([3ce15a3](https://github.com/buildproven/claude-kit/commit/3ce15a3a5134606f5ccdf2563bf0bbcc4778693c))
* keep V-cycle baseline and recovery controlled ([656fab2](https://github.com/buildproven/claude-kit/commit/656fab256613a450c9dd5900d56ab97ff780d4b9))
* make quality telemetry economically exact ([6234740](https://github.com/buildproven/claude-kit/commit/62347409c4cf2da9e37717e49ea63bae558666cb))
* parse judge telemetry through guarded helper ([d7e787c](https://github.com/buildproven/claude-kit/commit/d7e787c51bb5b6c52424156f37a0d9899cb3504d))
* parse V-cycle gate commands by position ([a9964c4](https://github.com/buildproven/claude-kit/commit/a9964c473464e94d4082fecd9039a81402ac708c))
* pass ref CAS admin authority to lease ([7ca97c4](https://github.com/buildproven/claude-kit/commit/7ca97c4a6423d68d5f510cd687a6548b997587d9))
* preserve quality runner lifecycle contracts ([2610087](https://github.com/buildproven/claude-kit/commit/2610087c87e530e6a1794871771c8d5661d83806))
* preserve ref CAS recovery intent ([eae07b6](https://github.com/buildproven/claude-kit/commit/eae07b687886e05e4f6c1dfadd0c0c2bf2d4a047))
* quarantine ambiguous ref responses ([7a0d712](https://github.com/buildproven/claude-kit/commit/7a0d712c038397d6713ba8f03c2157daf7e5fff7))
* reap escaped provider helpers ([8bd81d5](https://github.com/buildproven/claude-kit/commit/8bd81d5b9f89a012dbc68f3c977538c750ddf7e9))
* release rejected ref CAS guards ([17675c0](https://github.com/buildproven/claude-kit/commit/17675c0dc695ad0343f885a449532a6969015ab3))
* retain budget after incomplete review ([fe670d0](https://github.com/buildproven/claude-kit/commit/fe670d010ef2a2513b49c36a24a0719f8700d206))
* revalidate ref CAS authority at mutation ([f6d669e](https://github.com/buildproven/claude-kit/commit/f6d669edf47cedf267c160fd992b35fb3331d90f))
* sign ref CAS descendant authority ([38b1e53](https://github.com/buildproven/claude-kit/commit/38b1e53853d0ebed0120e63ef7890eb37ce673d8))
* signal provider group before escaped processes ([6dcb1e6](https://github.com/buildproven/claude-kit/commit/6dcb1e6f97c4ff2d49d8a65f95f03c8fb88138ba))
* supersede stale exact-head approval ([d74cbe5](https://github.com/buildproven/claude-kit/commit/d74cbe5612dc055458ff23d120bb1337be655c34))
* support green non-strict ref CAS ([10f40e4](https://github.com/buildproven/claude-kit/commit/10f40e465a024308115e33ed79b5816408df3fb5))
* type quality runner action boundaries ([33d1d8d](https://github.com/buildproven/claude-kit/commit/33d1d8d66cdf3a6bf3dbffc47d03799d7768b530))
* validate composed descendant decision ([9e13ab9](https://github.com/buildproven/claude-kit/commit/9e13ab99bf2f68ec6a0bad91c4bf0e991dd055f6))
* validate provider process identity before signals ([84aca47](https://github.com/buildproven/claude-kit/commit/84aca4764e1f8163a000226060d053193ed239a7))

## [4.7.4](https://github.com/buildproven/claude-kit/compare/v4.7.3...v4.7.4) (2026-08-21)


### Bug Fixes

* authorize protected dispatches ([#388](https://github.com/buildproven/claude-kit/issues/388)) ([9fc8cc1](https://github.com/buildproven/claude-kit/commit/9fc8cc1a9298f3417e185a18244c2ad3247ef6ba))
* avoid secret scanner false positive ([#416](https://github.com/buildproven/claude-kit/issues/416)) ([c2043a1](https://github.com/buildproven/claude-kit/commit/c2043a1e89cd456e1e59f7462612b524514c05e5))
* bind dispatched secret scans to reviewed heads ([#382](https://github.com/buildproven/claude-kit/issues/382)) ([ce1e2fb](https://github.com/buildproven/claude-kit/commit/ce1e2fb5200efc8945cbc07c4ca1b4dd06f56033))
* bound zsh setup in quality CI ([#410](https://github.com/buildproven/claude-kit/issues/410)) ([d5c0b1a](https://github.com/buildproven/claude-kit/commit/d5c0b1a640686b8def1ca472cfa2d07fe31e2839))
* budget complete release audits ([#393](https://github.com/buildproven/claude-kit/issues/393)) ([4102246](https://github.com/buildproven/claude-kit/commit/41022461325dcfb58d135156580865be10cb92b1))
* budget pushes that update open pull requests ([#395](https://github.com/buildproven/claude-kit/issues/395)) ([875f661](https://github.com/buildproven/claude-kit/commit/875f661a87d4c7acce6fa7d5cae6d9c3bab542e3))
* classify action-required CI billing blocks ([#401](https://github.com/buildproven/claude-kit/issues/401)) ([94155ca](https://github.com/buildproven/claude-kit/commit/94155cad290247ecd8a149afed3110906d6bc647))
* classify dispatch-only billing failures ([#389](https://github.com/buildproven/claude-kit/issues/389)) ([9d6422f](https://github.com/buildproven/claude-kit/commit/9d6422f628c0c868eb44439bb25209f657297236))
* compose quality and CI billing overrides ([#390](https://github.com/buildproven/claude-kit/issues/390)) ([c9e2b68](https://github.com/buildproven/claude-kit/commit/c9e2b68d47af307b34998b25d1c74ec36968a5fd))
* dispatch secret scans from protected branch ([#383](https://github.com/buildproven/claude-kit/issues/383)) ([1a85b82](https://github.com/buildproven/claude-kit/commit/1a85b82656ad0760c7b995f7021617c06f98adf8))
* dispatch secret scans from protected default ([#385](https://github.com/buildproven/claude-kit/issues/385)) ([696873e](https://github.com/buildproven/claude-kit/commit/696873e64061066cc931b7626b512a0248257338))
* installer crash, submodule worktree paths, CI-budget push scoping ([#392](https://github.com/buildproven/claude-kit/issues/392)) ([8588950](https://github.com/buildproven/claude-kit/commit/8588950d2e7d8b3bf02fd7e15107233f35cf9bf5))
* protect harness required checks ([#387](https://github.com/buildproven/claude-kit/issues/387)) ([c74543e](https://github.com/buildproven/claude-kit/commit/c74543e2bfc87607d98873d7bb25084a92282318))
* reject ambiguous CI billing evidence ([#408](https://github.com/buildproven/claude-kit/issues/408)) ([ac67a58](https://github.com/buildproven/claude-kit/commit/ac67a58b96e96c75f53ccde4586d80d8a65b65d3))
* report swap cleanup result honestly ([#412](https://github.com/buildproven/claude-kit/issues/412)) ([2b8ae2c](https://github.com/buildproven/claude-kit/commit/2b8ae2c7e7916ebbeb8c512a87569c836a20f710))
* require CI billing waiver provenance ([#402](https://github.com/buildproven/claude-kit/issues/402)) ([97e2189](https://github.com/buildproven/claude-kit/commit/97e2189abae288724bb44ea2218396681a594413))
* retain complete release audit headroom ([#396](https://github.com/buildproven/claude-kit/issues/396)) ([4dd55fb](https://github.com/buildproven/claude-kit/commit/4dd55fb5d6fccc2f3e187a17213861bfd6de3fd1))
* retain dispatch claim expiry metadata ([#391](https://github.com/buildproven/claude-kit/issues/391)) ([57e2dae](https://github.com/buildproven/claude-kit/commit/57e2dae477cf07d8ec49967f1d306305495932b0))
* reuse trusted protected scan results ([#386](https://github.com/buildproven/claude-kit/issues/386)) ([d5bac37](https://github.com/buildproven/claude-kit/commit/d5bac3729bbe84d82740c9dc9a86908a8bb361bb))
* stabilize no-job billing waiver evidence ([#405](https://github.com/buildproven/claude-kit/issues/405)) ([0e04b7f](https://github.com/buildproven/claude-kit/commit/0e04b7fccfd26da856190c55ad6910166be0a13d))
* support current mutation runtimes ([#409](https://github.com/buildproven/claude-kit/issues/409)) ([3bc5521](https://github.com/buildproven/claude-kit/commit/3bc5521d2bf81a9bb5dfdf825e660366dfe63848))
* support empty provider and quality arguments ([#394](https://github.com/buildproven/claude-kit/issues/394)) ([1b7d1d5](https://github.com/buildproven/claude-kit/commit/1b7d1d5073207fe7b15d2b50c3467389fd9d5eaa))

## [4.7.3](https://github.com/buildproven/claude-kit/compare/v4.7.2...v4.7.3) (2026-08-16)


### Bug Fixes

* allow dependency-free mutation sandboxes ([#379](https://github.com/buildproven/claude-kit/issues/379)) ([8b9848d](https://github.com/buildproven/claude-kit/commit/8b9848df185c46a8bac00623aaff286741f82008))
* bound steward convergence repairs ([#377](https://github.com/buildproven/claude-kit/issues/377)) ([14246e2](https://github.com/buildproven/claude-kit/commit/14246e2deef37ded3ef3254beebed93d31f7a143))
* govern review model effort ([#376](https://github.com/buildproven/claude-kit/issues/376)) ([a6227b2](https://github.com/buildproven/claude-kit/commit/a6227b2339c885cd1d741ca34941bcb398fe6aab))
* prefer canonical fleet checkout ([#373](https://github.com/buildproven/claude-kit/issues/373)) ([ab97dc5](https://github.com/buildproven/claude-kit/commit/ab97dc5a6a90de1340293d95e17a5e19524b8dc0))
* prepare mutation dependencies in sandbox ([#375](https://github.com/buildproven/claude-kit/issues/375)) ([3546f41](https://github.com/buildproven/claude-kit/commit/3546f417bfcb14f56b301d9f2eccc482beaca744))
* prepare workspace mutation dependencies ([#380](https://github.com/buildproven/claude-kit/issues/380)) ([bf38aaa](https://github.com/buildproven/claude-kit/commit/bf38aaa591f36c6bbda26bafd2f1c45da027897f))
* refresh SOTA currency baseline ([#381](https://github.com/buildproven/claude-kit/issues/381)) ([2f28fc6](https://github.com/buildproven/claude-kit/commit/2f28fc6af1cd19638e0a60baaa0a6c7abe312505))

## [4.7.2](https://github.com/buildproven/claude-kit/compare/v4.7.1...v4.7.2) (2026-08-13)


### Bug Fixes

* accept policy-exempt local review evidence ([#371](https://github.com/buildproven/claude-kit/issues/371)) ([4848d21](https://github.com/buildproven/claude-kit/commit/4848d219ff9e9559006358c8065a76771664602e))

## [4.7.1](https://github.com/buildproven/claude-kit/compare/v4.7.0...v4.7.1) (2026-08-13)


### Bug Fixes

* fail closed on CI lookup errors ([#370](https://github.com/buildproven/claude-kit/issues/370)) ([341aac9](https://github.com/buildproven/claude-kit/commit/341aac96b0a1273b2d740b2d72dfa2653b8b6f51))
* reuse green unrequired CI evidence ([#368](https://github.com/buildproven/claude-kit/issues/368)) ([77f39a5](https://github.com/buildproven/claude-kit/commit/77f39a5bc0d61f94a6137418df996cf4870175d7))

## [4.7.0](https://github.com/buildproven/claude-kit/compare/v4.6.4...v4.7.0) (2026-08-13)


### Features

* add safe test impact fallback ([#363](https://github.com/buildproven/claude-kit/issues/363)) ([54f4b62](https://github.com/buildproven/claude-kit/commit/54f4b6287a9ecd1b69338651cca9d7593257ba6f))
* enforce efficient fleet assurance ([#334](https://github.com/buildproven/claude-kit/issues/334)) ([5af4003](https://github.com/buildproven/claude-kit/commit/5af40031a4d1ccfc48516feb747f9f6f8edc9f5f))
* govern fresh provider compute ([#342](https://github.com/buildproven/claude-kit/issues/342)) ([57bb5f1](https://github.com/buildproven/claude-kit/commit/57bb5f167d24c0a367e0b2e170892ed8341ca6b5))
* report fleet quality efficiency ([#356](https://github.com/buildproven/claude-kit/issues/356)) ([4405064](https://github.com/buildproven/claude-kit/commit/440506414aa7b531d566a0119bdb17608b661203))
* resolve protected test Git ranges ([#367](https://github.com/buildproven/claude-kit/issues/367)) ([80c21bd](https://github.com/buildproven/claude-kit/commit/80c21bdbe2c21128d5e46b38818f0c0625f474e3))
* select changed Node tests ([#359](https://github.com/buildproven/claude-kit/issues/359)) ([0fbf4c3](https://github.com/buildproven/claude-kit/commit/0fbf4c389b698471da158e83f06fd8f01e8e8eaa))


### Bug Fixes

* automate safe dev delivery handoff ([2111799](https://github.com/buildproven/claude-kit/commit/2111799ed1be6c6d1269ee6b751ed78d072f7c6b))
* automate safe dev delivery handoff ([8388aab](https://github.com/buildproven/claude-kit/commit/8388aab463183b25cf93344c4481899197db7edd))
* bind delivery evidence lifecycle ([#346](https://github.com/buildproven/claude-kit/issues/346)) ([87d7d2a](https://github.com/buildproven/claude-kit/commit/87d7d2ae8152ae8e99ed2ea88f0f25600c4dce3b))
* bind governed launches to immutable inputs ([#345](https://github.com/buildproven/claude-kit/issues/345)) ([9a137d2](https://github.com/buildproven/claude-kit/commit/9a137d2c0638b7e89dd411ec539c3164a502ed0a))
* bound public lease waits ([#366](https://github.com/buildproven/claude-kit/issues/366)) ([9166cb7](https://github.com/buildproven/claude-kit/commit/9166cb730716b5c0587bcdd4a379bac5fa82da94))
* classify common protected auth prompts ([#354](https://github.com/buildproven/claude-kit/issues/354)) ([a87abae](https://github.com/buildproven/claude-kit/commit/a87abae4e13f5222804db97e865f7ef739428188))
* close governed execution binding schema ([#348](https://github.com/buildproven/claude-kit/issues/348)) ([6f36e70](https://github.com/buildproven/claude-kit/commit/6f36e70bd24b321e002b58e067df014eafceb969))
* consume CI waiver before dispatch ([#349](https://github.com/buildproven/claude-kit/issues/349)) ([8dc264e](https://github.com/buildproven/claude-kit/commit/8dc264e418f0950f6b2e1bf1d9137dbc131ab080))
* enforce governed launch contract ([#350](https://github.com/buildproven/claude-kit/issues/350)) ([6470f2b](https://github.com/buildproven/claude-kit/commit/6470f2bd317e45da2a7f0d835be6c21f8fd3a882))
* fail closed on absent quality evidence ([#358](https://github.com/buildproven/claude-kit/issues/358)) ([72e00ca](https://github.com/buildproven/claude-kit/commit/72e00cab46ae7309254f4362116758fe333d0cbd))
* focus mutation proof on mapped behavior ([#364](https://github.com/buildproven/claude-kit/issues/364)) ([05a42b5](https://github.com/buildproven/claude-kit/commit/05a42b5f655dc0b558a1a8286e03c27216032d05))
* forward local review evidence under CI waiver ([#355](https://github.com/buildproven/claude-kit/issues/355)) ([9d561de](https://github.com/buildproven/claude-kit/commit/9d561de2216fd8a5194634f8dca43f817f99f856))
* make governed delivery receipt monotonic ([#347](https://github.com/buildproven/claude-kit/issues/347)) ([77c6c69](https://github.com/buildproven/claude-kit/commit/77c6c69ca61717de3609fc36bc01e253e5608a61))
* make governed handoff post-apply transactional ([#353](https://github.com/buildproven/claude-kit/issues/353)) ([f89e055](https://github.com/buildproven/claude-kit/commit/f89e055e817d23c408878f471c8aa83a6922cc1d))
* reject invalid review provider policy at bootstrap ([#336](https://github.com/buildproven/claude-kit/issues/336)) ([ddbce00](https://github.com/buildproven/claude-kit/commit/ddbce0082bf8b60e57ea619edda60bc2e86c00c0))
* require explicit Node test entry points ([#365](https://github.com/buildproven/claude-kit/issues/365)) ([40cb959](https://github.com/buildproven/claude-kit/commit/40cb9593e27189508402378ee2586e303c2cace7))
* select evidence-backed affected tests ([#338](https://github.com/buildproven/claude-kit/issues/338)) ([88ee230](https://github.com/buildproven/claude-kit/commit/88ee2300bcbb2ac293a7f9e374b4a8dda687aedb))
* support SHA-256 governed Git heads ([#352](https://github.com/buildproven/claude-kit/issues/352)) ([dc61b7c](https://github.com/buildproven/claude-kit/commit/dc61b7ce22eb598aab60334f7fd68cc1cbcdeecf))
* trust base test policy and bound quality startup ([#361](https://github.com/buildproven/claude-kit/issues/361)) ([b208c86](https://github.com/buildproven/claude-kit/commit/b208c8690426df390a45d122439caf59642e4c3f))
* use shared planner for mutation checks ([#362](https://github.com/buildproven/claude-kit/issues/362)) ([f17dcc4](https://github.com/buildproven/claude-kit/commit/f17dcc49adaf335c7e3168d15d4ed2ada1d818d8))
* validate governed provider mappings ([#351](https://github.com/buildproven/claude-kit/issues/351)) ([3373442](https://github.com/buildproven/claude-kit/commit/33734427e75f707dcdb0706187650f4d12530883))

## [4.6.4](https://github.com/buildproven/claude-kit/compare/v4.6.3...v4.6.4) (2026-08-12)


### Bug Fixes

* account for repository exploration in review budget ([#332](https://github.com/buildproven/claude-kit/issues/332)) ([125b632](https://github.com/buildproven/claude-kit/commit/125b6324a64674040fd5b4f5c07a687a39fc0cda))

## [4.6.3](https://github.com/buildproven/claude-kit/compare/v4.6.2...v4.6.3) (2026-08-12)


### Bug Fixes

* harden review head and lease lifecycle ([#327](https://github.com/buildproven/claude-kit/issues/327)) ([ff53963](https://github.com/buildproven/claude-kit/commit/ff5396345e79bfb5ef22ba86c3717a403034596a))
* make CI billing evidence digest stable ([630e411](https://github.com/buildproven/claude-kit/commit/630e411eff749ec989a317c91bb47d9ac632f2dd))
* reconcile provider state on head drift ([eb4a6f9](https://github.com/buildproven/claude-kit/commit/eb4a6f9e3882948107846e14f8493bf0a1308f73))
* require signed review evidence authorization ([ba4c166](https://github.com/buildproven/claude-kit/commit/ba4c166d481e9168e7ef02f2e32a780da906938a))

## [4.6.2](https://github.com/buildproven/claude-kit/compare/v4.6.1...v4.6.2) (2026-08-12)


### Bug Fixes

* detect documented background agent workflows ([06b06ed](https://github.com/buildproven/claude-kit/commit/06b06ede2a30db4a5901bc020e07e78462a1c4d5))
* detect documented background agent workflows ([5fb84ec](https://github.com/buildproven/claude-kit/commit/5fb84ec39896d6ff9733c29c845a19664dccfd7a))
* **quality:** block incomplete required reviews ([#324](https://github.com/buildproven/claude-kit/issues/324)) ([8c09ea6](https://github.com/buildproven/claude-kit/commit/8c09ea65a8d524b1d93b54e58b5cd7d5034dad03))
* **quality:** canonicalize recursive review diffs ([#320](https://github.com/buildproven/claude-kit/issues/320)) ([07367ef](https://github.com/buildproven/claude-kit/commit/07367ef1ef9b40580a5b781a1c1844870983de72))
* **quality:** fail closed on incomplete review inputs ([#323](https://github.com/buildproven/claude-kit/issues/323)) ([46124d2](https://github.com/buildproven/claude-kit/commit/46124d214349bcf7e74817a98ba79bd12fc4d747))
* **quality:** prevent recursive mutation test runs ([#322](https://github.com/buildproven/claude-kit/issues/322)) ([fe07867](https://github.com/buildproven/claude-kit/commit/fe078676ab0211b667fc5dd754eba133045cb951))

## [4.6.1](https://github.com/buildproven/claude-kit/compare/v4.6.0...v4.6.1) (2026-08-11)


### Bug Fixes

* **quality:** bind CI billing overrides to diagnosed evidence ([#317](https://github.com/buildproven/claude-kit/issues/317)) ([e6810d6](https://github.com/buildproven/claude-kit/commit/e6810d6dba2de37fece5ee30e36bf7004921d4bb))

## [4.6.0](https://github.com/buildproven/claude-kit/compare/v4.5.0...v4.6.0) (2026-08-11)


### Features

* **quality:** measure review token proxy and compact prompts ([#314](https://github.com/buildproven/claude-kit/issues/314)) ([b2cf5b2](https://github.com/buildproven/claude-kit/commit/b2cf5b24ced15678034648dcd2689443d292f475))


### Bug Fixes

* accept successful primary critical reviews ([#315](https://github.com/buildproven/claude-kit/issues/315)) ([be4560b](https://github.com/buildproven/claude-kit/commit/be4560b05b78bb29dd7f7a0e799511d21b1c46dd))
* bound provider review to prepared evidence ([08564ec](https://github.com/buildproven/claude-kit/commit/08564ec69a06725f278b25147a52708f5a13d7d2))
* **quality:** generalize descriptive Codex approvals ([#311](https://github.com/buildproven/claude-kit/issues/311)) ([4625f4f](https://github.com/buildproven/claude-kit/commit/4625f4fe32f85f382e03fdd3ce8bd77275dc8231))
* **quality:** recover interrupted gate campaigns ([#316](https://github.com/buildproven/claude-kit/issues/316)) ([b2daa22](https://github.com/buildproven/claude-kit/commit/b2daa2285b3a3f5331f7f3c82f498b8490516b14))
* **quality:** remove new empty stamp commits ([#313](https://github.com/buildproven/claude-kit/issues/313)) ([7248646](https://github.com/buildproven/claude-kit/commit/72486465f2e938a498d5f9a98cfa5a9b5bd8edde))
* reap detached provider helpers ([25c76b5](https://github.com/buildproven/claude-kit/commit/25c76b569e57ebbf6ea97d6e55c20ad3648b089d))


### Performance Improvements

* throttle provider tree tracking ([#312](https://github.com/buildproven/claude-kit/issues/312)) ([3567e24](https://github.com/buildproven/claude-kit/commit/3567e246aff663eb8e7952a534088984ab3cc4fe))

## [4.5.0](https://github.com/buildproven/claude-kit/compare/v4.4.3...v4.5.0) (2026-08-10)


### Features

* share gate result protocol ([#306](https://github.com/buildproven/claude-kit/issues/306)) ([fbcb7a4](https://github.com/buildproven/claude-kit/commit/fbcb7a4eaf125894cbee87fc1d2b110fa68ab11c))


### Bug Fixes

* allow bespoke diversity recovery ([#307](https://github.com/buildproven/claude-kit/issues/307)) ([b360596](https://github.com/buildproven/claude-kit/commit/b3605964fcae51cc45a316b1b3ca1d7c7c27068c))
* initialize mutation worktree submodules ([#304](https://github.com/buildproven/claude-kit/issues/304)) ([59af0aa](https://github.com/buildproven/claude-kit/commit/59af0aa22d98f8f058476ba8e65a8a495b0901f0))

## [4.4.3](https://github.com/buildproven/claude-kit/compare/v4.4.2...v4.4.3) (2026-08-10)


### Bug Fixes

* **quality:** fail closed before provider dispatch ([#299](https://github.com/buildproven/claude-kit/issues/299)) ([3c49837](https://github.com/buildproven/claude-kit/commit/3c498376308e3909447a4041979bc7e88d13e490))
* **quality:** recover exhausted reviews after descendant fixes ([#300](https://github.com/buildproven/claude-kit/issues/300)) ([7373791](https://github.com/buildproven/claude-kit/commit/737379108559e92413277c2f4567bd1beddbdaa2))


### Performance Improvements

* collapse Bash PreToolUse hook launches ([#302](https://github.com/buildproven/claude-kit/issues/302)) ([5695275](https://github.com/buildproven/claude-kit/commit/5695275a0990d933c3e43d437f69a972a324e2b1))
* split Ralph skill for progressive disclosure ([#303](https://github.com/buildproven/claude-kit/issues/303)) ([0f1f8e9](https://github.com/buildproven/claude-kit/commit/0f1f8e9c13d037b150bf2cbb8967a56bf51e9495))

## [4.4.2](https://github.com/buildproven/claude-kit/compare/v4.4.1...v4.4.2) (2026-08-09)


### Bug Fixes

* **quality:** recover missing gate executables ([#297](https://github.com/buildproven/claude-kit/issues/297)) ([946f965](https://github.com/buildproven/claude-kit/commit/946f965d33854883ad6b6d0765b89736af449bbc))

## [4.4.1](https://github.com/buildproven/claude-kit/compare/v4.4.0...v4.4.1) (2026-08-07)


### Bug Fixes

* fund remediation mutation evidence ([#296](https://github.com/buildproven/claude-kit/issues/296)) ([4ca658b](https://github.com/buildproven/claude-kit/commit/4ca658b326a12dc7e48d030fcaa5e9475e480ec4))
* harden untrusted review inputs ([#289](https://github.com/buildproven/claude-kit/issues/289)) ([fe2fb48](https://github.com/buildproven/claude-kit/commit/fe2fb48ae74c5ea1b3fdd7f7366dbb0aad98391f))
* **quality:** allow critical diversity recovery ([#291](https://github.com/buildproven/claude-kit/issues/291)) ([3ebc4e6](https://github.com/buildproven/claude-kit/commit/3ebc4e6b86208682a1d2899dae00cee66dd05b94))
* **quality:** bind overrides to exact manifests ([#290](https://github.com/buildproven/claude-kit/issues/290)) ([af09c05](https://github.com/buildproven/claude-kit/commit/af09c0555c1cacd2a97773f3117677a6047eb89d))
* **quality:** recover campaigns across lifecycle changes ([#292](https://github.com/buildproven/claude-kit/issues/292)) ([ec0cce0](https://github.com/buildproven/claude-kit/commit/ec0cce0af1cb5f5918cdf5e38a5eb41705806cc4))
* **quality:** reserve lease-aware review capacity ([b4731f7](https://github.com/buildproven/claude-kit/commit/b4731f72aa6364618e7ce9bd8439533f378ce748))
* **quality:** serialize xdist mutation probes ([#293](https://github.com/buildproven/claude-kit/issues/293)) ([01ca1e8](https://github.com/buildproven/claude-kit/commit/01ca1e81200703d9f923a0de792d590cc7c3285c))
* **quality:** track delayed required check workflows ([#295](https://github.com/buildproven/claude-kit/issues/295)) ([58e7161](https://github.com/buildproven/claude-kit/commit/58e7161ce81a35655092639ebee2966b71ff00dd))

## [4.4.0](https://github.com/buildproven/claude-kit/compare/v4.3.0...v4.4.0) (2026-08-06)


### Features

* **codex:** add cross-review skill for Codex→Claude delegation ([#280](https://github.com/buildproven/claude-kit/issues/280)) ([2543938](https://github.com/buildproven/claude-kit/commit/2543938cf5e9e9c974b483f9562144360e445dda))


### Bug Fixes

* attribute quality telemetry outcomes ([#277](https://github.com/buildproven/claude-kit/issues/277)) ([4b55555](https://github.com/buildproven/claude-kit/commit/4b5555547b73852eedc492e915b1319ad485a28d))
* harden credential and review evidence gates ([#267](https://github.com/buildproven/claude-kit/issues/267)) ([d17fc05](https://github.com/buildproven/claude-kit/commit/d17fc052d7281b4660df0971849601be157572ee))
* make AI review advisory and evidence-bound ([#274](https://github.com/buildproven/claude-kit/issues/274)) ([a7fc81c](https://github.com/buildproven/claude-kit/commit/a7fc81c3d9e106d4be34a7b9d6d97ba88b3d89c4))
* preserve review campaign evidence ([#276](https://github.com/buildproven/claude-kit/issues/276)) ([b8b5462](https://github.com/buildproven/claude-kit/commit/b8b546242074ec1d1ae76b5c141d3cf1d4d964a0))
* **quality:** accept signed v2 fallback evidence ([#279](https://github.com/buildproven/claude-kit/issues/279)) ([f8d8e7b](https://github.com/buildproven/claude-kit/commit/f8d8e7ba9f53e73b3b46fe7cb792280968826283))
* **quality:** content promotion must not depend on the filename ([#271](https://github.com/buildproven/claude-kit/issues/271)) ([61cde3c](https://github.com/buildproven/claude-kit/commit/61cde3c6a7f5a00d855afb6dbbae171e40983058))
* **quality:** fail fast on pytest mutations ([#273](https://github.com/buildproven/claude-kit/issues/273)) ([7efcb05](https://github.com/buildproven/claude-kit/commit/7efcb057b30cc976fa3be5765a6d1016c45413a6))
* **quality:** floor micro gate execution budget ([#284](https://github.com/buildproven/claude-kit/issues/284)) ([520f756](https://github.com/buildproven/claude-kit/commit/520f756330837d1331d0b3fdb140451e30a96db5))
* **quality:** fund exact-head remediation gates ([#285](https://github.com/buildproven/claude-kit/issues/285)) ([835af4d](https://github.com/buildproven/claude-kit/commit/835af4df653029327ae01ca33788a290a27ce6aa))
* **quality:** judge prose by content, not filename (BUI-641 root cause) + quorum diagnostics ([#270](https://github.com/buildproven/claude-kit/issues/270)) ([6e7df7b](https://github.com/buildproven/claude-kit/commit/6e7df7becdf57a68966a1bdd1cdb23e6fdf982ae))
* **quality:** normalize verified Codex approvals ([#282](https://github.com/buildproven/claude-kit/issues/282)) ([82b51c6](https://github.com/buildproven/claude-kit/commit/82b51c635224669e3d930460f084f4ce888aca4b))
* **quality:** persist terminal telemetry automatically ([#278](https://github.com/buildproven/claude-kit/issues/278)) ([be58c15](https://github.com/buildproven/claude-kit/commit/be58c1530a6b2b8778251b93ad1100ca42bba98b))
* **quality:** record the terminal state on a successful merge ([#272](https://github.com/buildproven/claude-kit/issues/272)) ([f98f69d](https://github.com/buildproven/claude-kit/commit/f98f69d1553941e3ecfd168f8726936673c89232))
* **quality:** reject compound pytest scripts ([#275](https://github.com/buildproven/claude-kit/issues/275)) ([6225633](https://github.com/buildproven/claude-kit/commit/62256330c111a6dd69d88600778f3041daff3a63))
* **quality:** stop ordinary changes reaching critical tier ([#268](https://github.com/buildproven/claude-kit/issues/268)) ([d7fa276](https://github.com/buildproven/claude-kit/commit/d7fa276ecd4f157f368f0f638b9926d8388c38d8))
* serialize repository merge campaigns ([#281](https://github.com/buildproven/claude-kit/issues/281)) ([b44627d](https://github.com/buildproven/claude-kit/commit/b44627dea44c909cae21f41f3d9407399b33ce6b))

## [4.3.0](https://github.com/buildproven/claude-kit/compare/v4.2.0...v4.3.0) (2026-08-03)


### Features

* **quality:** add opt-in --verify-app gate that boots the app (BUI-306) ([#254](https://github.com/buildproven/claude-kit/issues/254)) ([9703f5f](https://github.com/buildproven/claude-kit/commit/9703f5fef6da0c204941ea3fa726ccf076928402))
* **quality:** add signed operator override with named condition acceptance ([#255](https://github.com/buildproven/claude-kit/issues/255)) ([c2cf145](https://github.com/buildproven/claude-kit/commit/c2cf145af0872303c568b0de7a78edb141cde230))


### Bug Fixes

* **agents,skills:** tighten agent tool scoping and fix shell hygiene issues ([#249](https://github.com/buildproven/claude-kit/issues/249)) ([73e9f10](https://github.com/buildproven/claude-kit/commit/73e9f10bb7d14f4ec79cf5a99799b4a1a1527f96))
* batch same-repository merge reviews ([#261](https://github.com/buildproven/claude-kit/issues/261)) ([ac856e1](https://github.com/buildproven/claude-kit/commit/ac856e1d772aab14f41d18f8cc745721c425678a))
* harden rebase review carry ([#263](https://github.com/buildproven/claude-kit/issues/263)) ([70e8980](https://github.com/buildproven/claude-kit/commit/70e8980975d1251ddc8d41160190d33cf3a64353))
* **hotfix:** make CI-timeout guard and empty-test-scope reporting correct ([#248](https://github.com/buildproven/claude-kit/issues/248)) ([937d04e](https://github.com/buildproven/claude-kit/commit/937d04e29fc9c5093c13774caa5a32d698c2550c))
* **quality:** close remaining fail-open paths in risk scoring and evidence checks ([#246](https://github.com/buildproven/claude-kit/issues/246)) ([b0621be](https://github.com/buildproven/claude-kit/commit/b0621bedfaadf9671b0a4f527abef4bc2a413a87))
* **quality:** fix PR resolution when invoked from outside the target checkout ([#253](https://github.com/buildproven/claude-kit/issues/253)) ([ba74935](https://github.com/buildproven/claude-kit/commit/ba7493539b692a580181e2cf8656706b5530c1b7))
* **quality:** only require mypy when the diff actually touches .py ([#256](https://github.com/buildproven/claude-kit/issues/256)) ([8a7ccd4](https://github.com/buildproven/claude-kit/commit/8a7ccd496ee24c4a31107c63db305baf2d82c5e7))
* **quality:** persist abandoned-execution reconciliation before budget checks can discard it ([#251](https://github.com/buildproven/claude-kit/issues/251)) ([4bfb85a](https://github.com/buildproven/claude-kit/commit/4bfb85ac9b112f5af81104146d921f4bb57474d0))
* **quality:** pin gh pr view to GIT_ROOT's repo, not ambient CWD ([#250](https://github.com/buildproven/claude-kit/issues/250)) ([316f5ee](https://github.com/buildproven/claude-kit/commit/316f5ee8359eb8debfd217ac03386b8c15c79bba))
* **quality:** polish PR HEAD retry loop in quality-stamp-and-merge.sh (BUI-466) ([#257](https://github.com/buildproven/claude-kit/issues/257)) ([ec24393](https://github.com/buildproven/claude-kit/commit/ec243932255795813762d13be0466c8fc50878a0))
* **quality:** surface exhausted review coverage ([#266](https://github.com/buildproven/claude-kit/issues/266)) ([e5ab4e5](https://github.com/buildproven/claude-kit/commit/e5ab4e5ec733c066d5dda3593fc97a01a81823a1))
* **quality:** verify a branch-matched worktree actually belongs to the resolved PR's repo ([#252](https://github.com/buildproven/claude-kit/issues/252)) ([5492aed](https://github.com/buildproven/claude-kit/commit/5492aed7a24e9117e5a7e18f20d58a6a88d8ed0e))

## [4.2.0](https://github.com/buildproven/claude-kit/compare/v4.1.0...v4.2.0) (2026-08-01)


### Features

* add generic codex-parity and merge-train skills ([#146](https://github.com/buildproven/claude-kit/issues/146)) ([466e064](https://github.com/buildproven/claude-kit/commit/466e06412512ef85ded6549f196b7aa5dbabdac7))
* allow signed operator quality overrides ([c4fc8b6](https://github.com/buildproven/claude-kit/commit/c4fc8b6c4bdaa12078d2c5ced33695790263073e))
* **commands:** add /bs:prd command for the prd skill ([#221](https://github.com/buildproven/claude-kit/issues/221)) ([8862a89](https://github.com/buildproven/claude-kit/commit/8862a892fcc8732385b52c716661556bee2720cf))
* **merge-train:** enforce shared batch review budget ([#158](https://github.com/buildproven/claude-kit/issues/158)) ([e0f9315](https://github.com/buildproven/claude-kit/commit/e0f9315d6a48c0fcf908a0a4f47c4404d20d1e91))
* **quality:** add on-demand /bs:quality status command (BUI-383) ([#145](https://github.com/buildproven/claude-kit/issues/145)) ([0e240b1](https://github.com/buildproven/claude-kit/commit/0e240b1a343c9e4349cb6c79945aaa9271769708))
* **quality:** attribute review telemetry arms ([#157](https://github.com/buildproven/claude-kit/issues/157)) ([00c453a](https://github.com/buildproven/claude-kit/commit/00c453a68e1c429635677ced28bca990f369ca9c))
* **quality:** discover Python repository gates ([#161](https://github.com/buildproven/claude-kit/issues/161)) ([6b048a1](https://github.com/buildproven/claude-kit/commit/6b048a1b8bac615d176d0f8e4e505230e0cfa7f3))
* **quality:** let an operator explicitly waive CI billing failures on protected repos ([#237](https://github.com/buildproven/claude-kit/issues/237)) ([008e865](https://github.com/buildproven/claude-kit/commit/008e8657e85ab53a682ebb80ba2b106d9f821a88))
* **quality:** make merge authority autonomous by default ([#156](https://github.com/buildproven/claude-kit/issues/156)) ([f5f954a](https://github.com/buildproven/claude-kit/commit/f5f954a1fddd74e9612c6182d4442319497d69c7))
* **quality:** require red-capable evidence for high risk ([#155](https://github.com/buildproven/claude-kit/issues/155)) ([8f15434](https://github.com/buildproven/claude-kit/commit/8f1543428c69f2fef9b6984e623295f2eb89baeb))
* **quality:** sign review evidence tuples ([#195](https://github.com/buildproven/claude-kit/issues/195)) ([1cb70bd](https://github.com/buildproven/claude-kit/commit/1cb70bdf804723112d2f364c06fa011a31790c6e))


### Bug Fixes

* align model routing with runtime policy ([#197](https://github.com/buildproven/claude-kit/issues/197)) ([d81a526](https://github.com/buildproven/claude-kit/commit/d81a526cbd6776ba511e4ebef3e74199d6320c5c))
* **backlog:** close all cited Linear issues after merge ([#160](https://github.com/buildproven/claude-kit/issues/160)) ([effd8d7](https://github.com/buildproven/claude-kit/commit/effd8d7ded0bfcb37e73e1ab1619a84696039145))
* **backlog:** use native Linear merge automation ([#169](https://github.com/buildproven/claude-kit/issues/169)) ([36569ce](https://github.com/buildproven/claude-kit/commit/36569ce7ed4d1bfcd75987415e4d0255cf93d9ef))
* **ci:** unblock release-please with the automatic workflow token ([#239](https://github.com/buildproven/claude-kit/issues/239)) ([e01fe3c](https://github.com/buildproven/claude-kit/commit/e01fe3c398382cb4da733dd34974f7564314896d))
* clean merged PR worktrees after branch deletion ([#215](https://github.com/buildproven/claude-kit/issues/215)) ([91f9359](https://github.com/buildproven/claude-kit/commit/91f93594fdf07a2f0319b3aee5022677c7057250))
* **csc1:** exempt commands/OVERRIDES.md from command contract lint ([#165](https://github.com/buildproven/claude-kit/issues/165)) ([5e29cec](https://github.com/buildproven/claude-kit/commit/5e29cec6cc1294ba774cc43a8302abc7fb62f7ed))
* **csc1:** scope overrides registry exemption ([#168](https://github.com/buildproven/claude-kit/issues/168)) ([a36ff6d](https://github.com/buildproven/claude-kit/commit/a36ff6db40f85c9f8756ee6ccd5223869464ce2c))
* **docs:** add missing hotfix command wrapper, caveat recover-quality templates ([#140](https://github.com/buildproven/claude-kit/issues/140)) ([6676b1f](https://github.com/buildproven/claude-kit/commit/6676b1fc04d40571549f6de67630fdc74de9a3c3))
* **gates:** stop untracked scratch space from breaking five gates ([#229](https://github.com/buildproven/claude-kit/issues/229)) ([b19a162](https://github.com/buildproven/claude-kit/commit/b19a162487f2ff192b47292d976b77be4667d768))
* honor named quality review levels ([#162](https://github.com/buildproven/claude-kit/issues/162)) ([8344462](https://github.com/buildproven/claude-kit/commit/8344462dadc0efcfa2435b07b933095226f98fa2))
* **hooks:** block recursive rm nested in shell control constructs ([#136](https://github.com/buildproven/claude-kit/issues/136)) ([69434de](https://github.com/buildproven/claude-kit/commit/69434de238b722d2ca5208baa2baa96d4764cc34))
* **hooks:** close destructive-path guard bypasses ([#228](https://github.com/buildproven/claude-kit/issues/228)) ([9dd9417](https://github.com/buildproven/claude-kit/commit/9dd9417e8c228734268e4ec0c27d3840487616a5))
* **hooks:** report detected secrets instead of failing open ([#230](https://github.com/buildproven/claude-kit/issues/230)) ([4427b45](https://github.com/buildproven/claude-kit/commit/4427b453a3c3239a3a7b6f2c0e3ce613509d24d9))
* **hooks:** resolve the git dir so session hooks work in worktrees ([#233](https://github.com/buildproven/claude-kit/issues/233)) ([29b5def](https://github.com/buildproven/claude-kit/commit/29b5defc96d0684ca499a96441f291876b541efd))
* **hooks:** restore branch protection dead since v1.0.0 ([#227](https://github.com/buildproven/claude-kit/issues/227)) ([b6ca4f2](https://github.com/buildproven/claude-kit/commit/b6ca4f2c85ec36325edbc51ba4d28eb4529a0e66))
* make unresolved review-agent definitions fail loud (BUI-461) ([#184](https://github.com/buildproven/claude-kit/issues/184)) ([e4e770a](https://github.com/buildproven/claude-kit/commit/e4e770a95d9754a10b048615669f71b5344b19f8))
* **merge-train:** enforce shared quality reservations ([#174](https://github.com/buildproven/claude-kit/issues/174)) ([461ce68](https://github.com/buildproven/claude-kit/commit/461ce68138042fb46e94399998bf8ae329dfa5e3))
* **quality:** accept bare no-findings markers ([#154](https://github.com/buildproven/claude-kit/issues/154)) ([9506ff1](https://github.com/buildproven/claude-kit/commit/9506ff142520068fce1ec791413fecfd913ff971))
* **quality:** accept no-findings sentinel preceded by rationale prose ([#177](https://github.com/buildproven/claude-kit/issues/177)) ([65111ac](https://github.com/buildproven/claude-kit/commit/65111acaf94cc866d9902b0749e312a3a7f97138))
* **quality:** complete signed review evidence ([#214](https://github.com/buildproven/claude-kit/issues/214)) ([201c161](https://github.com/buildproven/claude-kit/commit/201c1611288e4a8f4acafcaa54e110f8fd553796))
* **quality:** enforce the reviewer quorum per review, not per campaign ([#235](https://github.com/buildproven/claude-kit/issues/235)) ([87914d0](https://github.com/buildproven/claude-kit/commit/87914d08e3993dfc92c99a5f1b053535269cc2fe))
* **quality:** fail over inconclusive reviews ([#135](https://github.com/buildproven/claude-kit/issues/135)) ([202d3d4](https://github.com/buildproven/claude-kit/commit/202d3d47d6dd944e30b137ed0f383c4016fa11f8))
* **quality:** fail over on Codex OAuth refresh failure ([#216](https://github.com/buildproven/claude-kit/issues/216)) ([a9bf311](https://github.com/buildproven/claude-kit/commit/a9bf311fff11629cd464e9bfe7361a0ae44ead4d))
* **quality:** fail over to fallback provider on rc=77 budget-decline (BUI-348) ([#148](https://github.com/buildproven/claude-kit/issues/148)) ([b9ab249](https://github.com/buildproven/claude-kit/commit/b9ab2497ceca510541a4de3ab6b3e7091b7d8f70))
* **quality:** harden merge-train contracts ([#192](https://github.com/buildproven/claude-kit/issues/192)) ([a4cb86a](https://github.com/buildproven/claude-kit/commit/a4cb86a7b0db4d42316c890c73d2ddc7f81b7e9d))
* **quality:** harden orchestration surfaces ([#149](https://github.com/buildproven/claude-kit/issues/149)) ([dbe6bc6](https://github.com/buildproven/claude-kit/commit/dbe6bc6f170cb974ae9dd7e7f0e438533f7f4f3d))
* **quality:** isolate Codex reviews from user MCP config ([#220](https://github.com/buildproven/claude-kit/issues/220)) ([1341254](https://github.com/buildproven/claude-kit/commit/1341254822fbece00862a32ad9d0065391663566))
* **quality:** let break-glass approval survive a rebase-only HEAD change ([#141](https://github.com/buildproven/claude-kit/issues/141)) ([021f9bb](https://github.com/buildproven/claude-kit/commit/021f9bb5488d92f1e339d02bc92ce0358a5ceda1))
* **quality:** make low-risk AI review advisory ([#173](https://github.com/buildproven/claude-kit/issues/173)) ([f5ab589](https://github.com/buildproven/claude-kit/commit/f5ab5898b73dbcb3c229b96b07d0daaa7eb96570))
* **quality:** make risk scorer's workflow security floor content-aware (BUI-381) ([#143](https://github.com/buildproven/claude-kit/issues/143)) ([cf29057](https://github.com/buildproven/claude-kit/commit/cf29057f8dd9dede61330bbf2dd930e77fc1c2bc))
* **quality:** normalize same-provider fallback ([#224](https://github.com/buildproven/claude-kit/issues/224)) ([3b6c054](https://github.com/buildproven/claude-kit/commit/3b6c0542c0b7165a40be0decb2c9787ef4bc94d3))
* **quality:** persist terminal gate failures ([#226](https://github.com/buildproven/claude-kit/issues/226)) ([9c5ab80](https://github.com/buildproven/claude-kit/commit/9c5ab8053e18a6c2c55cd093d6646060321324ac))
* **quality:** pin a non-1M review model ([#191](https://github.com/buildproven/claude-kit/issues/191)) ([4628a15](https://github.com/buildproven/claude-kit/commit/4628a1555f9a6ec24fb2f40d06deebb0479b8b77))
* **quality:** preflight signed primary-only stamps ([#218](https://github.com/buildproven/claude-kit/issues/218)) ([78e06ec](https://github.com/buildproven/claude-kit/commit/78e06ec95da6f89569ec40b7a3e1e357a477af22))
* **quality:** prove config changes via the test that guards them (BUI-511) ([#189](https://github.com/buildproven/claude-kit/issues/189)) ([c0430be](https://github.com/buildproven/claude-kit/commit/c0430be908124cac3b59f28b4c5f2ee0db9ecf22))
* **quality:** record mutation evidence for the gitlink-skip path ([#181](https://github.com/buildproven/claude-kit/issues/181)) ([994d3af](https://github.com/buildproven/claude-kit/commit/994d3af8c59347c204bede79d060b3b4e479d4bc))
* **quality:** require structured Claude review output ([#199](https://github.com/buildproven/claude-kit/issues/199)) ([f53c7ad](https://github.com/buildproven/claude-kit/commit/f53c7ad5af70c5a0b8aba6bda2333e5b125d7245))
* **quality:** reserve gate time before review ([#171](https://github.com/buildproven/claude-kit/issues/171)) ([99a713a](https://github.com/buildproven/claude-kit/commit/99a713aa8c859805834f5d9118745ed770c03cc5))
* **quality:** retry PR HEAD check to survive GitHub read-after-write lag ([#178](https://github.com/buildproven/claude-kit/issues/178)) ([bcbcd29](https://github.com/buildproven/claude-kit/commit/bcbcd2944597ea1df1a988ba0c9606a5e385a49a))
* **quality:** scope --pr resolution to --target-dir's repo (BUI-391) ([#186](https://github.com/buildproven/claude-kit/issues/186)) ([860e108](https://github.com/buildproven/claude-kit/commit/860e1081723978f5a97a630941f37e1cb33e64da))
* **quality:** separate execution and lifecycle budgets ([#163](https://github.com/buildproven/claude-kit/issues/163)) ([3daca2d](https://github.com/buildproven/claude-kit/commit/3daca2d966a78c188623e6bb1753ffe690487fd2))
* **quality:** size submodule review budgets from child diff (BUI-358) ([#167](https://github.com/buildproven/claude-kit/issues/167)) ([9a95938](https://github.com/buildproven/claude-kit/commit/9a959387042a81979be2e78cea18aabfd995d1fd))
* **quality:** skip mutation gate for pure gitlink diffs (BUI-464) ([#179](https://github.com/buildproven/claude-kit/issues/179)) ([cffa0b8](https://github.com/buildproven/claude-kit/commit/cffa0b82148bb2a6b7f2d3e43eabc049bedabcfc))
* **quality:** skip mutation gate on diffs with no mutable source (BUI-483) ([#188](https://github.com/buildproven/claude-kit/issues/188)) ([bb77e25](https://github.com/buildproven/claude-kit/commit/bb77e2532c1bdcd4286e357f4e54488f46d47ba5))
* **quality:** stop false-positive "base changed during bootstrap" from stale gh pr view cache (BUI-382) ([#144](https://github.com/buildproven/claude-kit/issues/144)) ([b0d84f7](https://github.com/buildproven/claude-kit/commit/b0d84f7310373b3c01b491c47fffcc5a585fc3d1))
* **quality:** support shell mutation targets ([#170](https://github.com/buildproven/claude-kit/issues/170)) ([a757b25](https://github.com/buildproven/claude-kit/commit/a757b25b9a0d8f9c2b78e286d1a52ab62214fd85))
* **quality:** treat an empty findings sentinel as malformed, not blocking ([#190](https://github.com/buildproven/claude-kit/issues/190)) ([7891a26](https://github.com/buildproven/claude-kit/commit/7891a2618f6a98f92bcf36b6d0fde1e0f3ab4502))
* **quality:** verify signed CI review evidence ([#219](https://github.com/buildproven/claude-kit/issues/219)) ([7ec316a](https://github.com/buildproven/claude-kit/commit/7ec316a694ef55a9c74c7dc31c827d0eb74e354d))
* **ralph:** gate autonomous loop context and usage ([#150](https://github.com/buildproven/claude-kit/issues/150)) ([e70e35a](https://github.com/buildproven/claude-kit/commit/e70e35a444b06f15e1edff011bd38ce3d7eb95fb))
* **ralph:** stop marking backlog items done without doing the work ([#240](https://github.com/buildproven/claude-kit/issues/240)) ([5a03c0a](https://github.com/buildproven/claude-kit/commit/5a03c0acde1b954769d4ef3b3fdf6e75422e0411))
* **release:** anchor release-please to the existing v-prefixed tags ([#244](https://github.com/buildproven/claude-kit/issues/244)) ([8aa9591](https://github.com/buildproven/claude-kit/commit/8aa9591a5f4a9fd98070eb2c6ba34fe5a016c768))
* repair curl installer upgrade path for pre-manifest checkouts (BUI-444) ([#183](https://github.com/buildproven/claude-kit/issues/183)) ([0d178af](https://github.com/buildproven/claude-kit/commit/0d178afc1090f5e95f40323579eaaa36cd09bb02))
* resolve overlay root correctly when embedded as a nested submodule ([#147](https://github.com/buildproven/claude-kit/issues/147)) ([2f89176](https://github.com/buildproven/claude-kit/commit/2f891760960777d0a482a12ed1a5fba044404765))
* **risk:** fail closed on unreadable diffs and job-level permissions ([#232](https://github.com/buildproven/claude-kit/issues/232)) ([90cb6dd](https://github.com/buildproven/claude-kit/commit/90cb6dd10223325f63175526d7ea7f2a477fa2fe))
* route review effort from change evidence ([#210](https://github.com/buildproven/claude-kit/issues/210)) ([1770342](https://github.com/buildproven/claude-kit/commit/17703421ab70877e0117feae8845c81641c96e89))
* **scripts:** classify provider exhaustion from structured events only (BUI-325) ([#185](https://github.com/buildproven/claude-kit/issues/185)) ([4947f4c](https://github.com/buildproven/claude-kit/commit/4947f4c4bccbe1a8ee5768e8ad0662ba2fbcf48c))
* **security:** replace license-checker with maintained rseidelsohn fork (BUI-473) ([#182](https://github.com/buildproven/claude-kit/issues/182)) ([4df5e97](https://github.com/buildproven/claude-kit/commit/4df5e9779060f73740b54465c55a0b7b7cbd2609))
* **workflow:** base suggested branches on origin ([#196](https://github.com/buildproven/claude-kit/issues/196)) ([3c8859e](https://github.com/buildproven/claude-kit/commit/3c8859e9767da2f18d24dda6a3cc68bc549e352c))
* **worktree:** preserve safety during forced cleanup ([4c80fad](https://github.com/buildproven/claude-kit/commit/4c80fadf3f72b35ae463e30d9faf027724da6c3d))
* **worktree:** refresh origin before basing new worktrees on default branch ([#172](https://github.com/buildproven/claude-kit/issues/172)) ([e40b249](https://github.com/buildproven/claude-kit/commit/e40b24901183411f48fde7ac18f430e80bf7a466))
* **worktree:** remove eligible submodule worktrees ([#152](https://github.com/buildproven/claude-kit/issues/152)) ([242979c](https://github.com/buildproven/claude-kit/commit/242979c2e18c1f4955c3855c885ab3a19654d6f9))
* **worktrees:** make stale-lock recovery atomic and release safe ([#234](https://github.com/buildproven/claude-kit/issues/234)) ([9d8f891](https://github.com/buildproven/claude-kit/commit/9d8f891e946548bcbb07da4f4fdb4f3496413fa1))
* **worktrees:** reconcile terminal quality locks safely ([#225](https://github.com/buildproven/claude-kit/issues/225)) ([51ea736](https://github.com/buildproven/claude-kit/commit/51ea736706e060f41aca9a38b5739ea43e1466f7))
* **worktrees:** reject unparseable removal thresholds ([#231](https://github.com/buildproven/claude-kit/issues/231)) ([ab700c2](https://github.com/buildproven/claude-kit/commit/ab700c29ff433210bd6a9c8bb79d9e8b391e2a5e))

## [4.1.0] - 2026-07-19

### Added

- Tool-agnostic provider parity for Codex and Claude Code across the quality
  workflow (#121).
- Campaign telemetry recorder for quality runs (#115).
- Repo-context-aware critical gate with an always-human review floor (#128).
- Strengthened engineering and UI design disciplines in shared skills (#105).
- Review depth now routes by task type instead of a single fixed policy (#133).
- Unified worktree lifecycle management (#131).

### Changed

- Quality provider health probing now detects an unwinnable Codex cache and
  skips straight to fallback instead of stalling (#124).
- Quality CI jobs consolidated to eliminate per-job round-up overhead (#123).
- Default Codex skill surface trimmed to reduce install footprint (#102).
- Risk-change-nature detection extracted into a single shared module so
  fail-open channels can't diverge between call sites (#113, #114).

### Fixed

- Concurrent quality review runs now converge instead of racing to
  inconsistent verdicts (#98).
- Review verdict consistency enforced across providers (#103).
- Quality reviews are bounded to avoid runaway cost (#104).
- Merge state is isolated per revision, closing a cross-run leak (#100).
- Final evidence gaps in the quality gate closed (#110).
- `stop-validation.sh` no longer crashes in bare repositories (#112).
- Codex clean prose verdicts are accepted instead of blocking merges (#119).
- Removed a `-a` flag from `codex exec` invocations that Codex no longer
  supports (#116).
- Quality falls back to the secondary provider on review timeout (#120).
- Merges on unprotectable bases are no longer blocked; N/A SOTA scores are
  excluded from scoring (#126).
- Plugin manifest YAML with a colon-bearing description is now quoted
  correctly, with CI validation added to catch regressions (#127).
- Rename risk detection and failure recovery made actionable instead of
  silently degrading (#129).
- Quality campaigns are now durable and failure-aware across interruptions
  (#117).
- Validated CI billing waivers are now honored instead of blocking merges
  (#134).
- Gemini provider support is now opt-in and diagnosable instead of silently
  misconfigured (#130).
- CI is now validated on unprotectable repos instead of being skipped (#138).
- A recursive temp-cleanup trap that could delete unintended paths was
  removed (#107).
- Vitest global timeout raised to fix parallel-load flakes (#118).
- Changelog helper now resolves beside the gate it documents (#106).

### Security

- `notify` now passes text as an argv element instead of interpolating it
  into an AppleScript string, closing an AppleScript injection vector (#122).

## [4.0.1] - 2026-07-16

### Fixed

- Active-repository discovery now maps GitHub repositories only to primary
  checkouts, never to ephemeral linked worktrees with the same remote.

## [4.0.0] - 2026-07-16

### Added

- Native Codex Agent Skills installation from a curated allowlist, with drift
  checking and the same canonical instructions used by Claude Code.
- A provider-neutral runner and shared policy for Codex-primary, Claude-primary,
  explicit fallback, typed quota/authentication/timeout failures, and bounded runs.
- Active-repository fleet discovery and convergence auditing, plus isolated
  worktree repair mode through the repository's normal PR quality workflow.
- Declarative MCP parity tooling for Claude Code and Codex, including forced
  convergence and separate OAuth login.
- A command/skill surface audit with an explicit public command budget.

### Changed

- Overnight loop engineering now uses the shared provider policy instead of
  hardcoding Claude Code.
- Twelve redundant command wrappers were removed. Their durable skills remain
  available where they are useful; internal implementation skills are hidden from
  user menus with `user-invocable: false`.
- Steward state moved out of the repository into the XDG state directory.
- The distributed plugin and marketplace manifests now match v4.0.0, and the
  duplicate standard hooks declaration was removed so fresh installs load cleanly.

## [3.2.0] - 2026-07-15

### Changed

- Removed the lightly modified vendored `webapp-testing` skill; Anthropic's upstream
  repository is now the canonical maintained source.
- Documented the substantial modifications and Apache-2.0 attribution for
  `frontend-design`; all other kit content remains MIT.
- Made plugin installs resolve the inline-list parser and ensemble runner through
  `CLAUDE_PLUGIN_ROOT`.
- Raised the supported runtime floor to Node 24 LTS and committed the npm lockfile
  for reproducible `npm ci` builds.
- Upgraded the lint and commit toolchain, including ESLint 10 compatibility for
  the bundled defensive rules.

### Security and quality

- Added sandbox credential and metadata-network protections while using Claude
  Code's guarded `auto` permission mode.
- Promoted the tested destructive-path hook from the private overlay into the
  public kit and wired it before every Bash tool call.
- Made Semgrep findings fail CI, added license enforcement and a pre-push security
  gate, and enabled weekly dependency and GitHub Actions updates.
- Removed destructive stale-branch automation and two dead private-only scripts.
- Corrected SOTA scoring for sandbox networking, skill frontmatter, CI security,
  plugin-native paths, git hooks, and opt-in OpenTelemetry.
- Added direct tests for every published defensive ESLint rule and hardened JSX
  handler analysis against namespaced and short prop names.

## [3.1.0] - 2026-07-13

The kit stops doing things to your repo that you didn't ask for.

### BREAKING — the hooks no longer mutate your working tree

**`session-start-context.sh` was force-deleting your branches.** On every session
start, in whatever repo you had open, it ran `git branch -D` on every branch whose
upstream was gone, and `git branch -d` on merged ones. No prompt, no opt-out — and
it was wired into the _recommended_ plugin install.

`-D` is a force delete. If a remote branch was deleted while you still had unpushed
local commits, those commits went with it. Install the plugin, open Claude in an
unrelated repo, lose work.

It now **reports** and deletes nothing:

> 🌿 Branches whose remote is gone: `feature` — review, then `git branch -D` if
> you're sure (they may hold unpushed commits).

Set `CLAUDE_KIT_AUTO_PRUNE=1` to restore the old behavior. Off by default.

**`auto-branch-on-main.sh` was switching your branch mid-edit.** On any Edit/Write
while on `main` it ran `git checkout -b feat/<filename>` in your tree — and if the
branch already existed, a bare `git checkout`, which carries uncommitted changes
across it. Every git call was `2>/dev/null`, so failures were invisible.

It now **denies with a message** telling you what to run (exit 2) — which is what
its own header always claimed it did, and what `block-commit-main.sh` already does.
Set `CLAUDE_KIT_ALLOW_MAIN_EDITS=1` to disable the hook.

### BREAKING — the quality gate now blocks on failing reviews

`BLOCKING_COUNT` was only ever interpolated into the `Reviewed-By` trailer text
(`findings=2`); it was never compared to zero. Every `MERGE BLOCKED` guard verified
the review _ran_ — none verified it _passed_. An attendance register, not an exam.

Unresolved BLOCKING findings now abort the merge.

Compounding it: `skills/quality/SKILL.md` was **17,394 tokens against a 5,000-token
compaction re-attach cap**, so the merge gates — which live late in the file —
silently ceased to exist after any compaction, i.e. in exactly the long sessions
where they matter most. The CI check for this was `continue-on-error: true`.

SKILL.md is now split (under 5,000 tokens) and `check-skill-size.sh` is a hard gate.

### BREAKING — defaults that surprised you

- **`fallbackModel` was Opus-first.** A stranger on a metered plan installed this and
  was billed at Opus rates by default. Now `claude-sonnet-5` → `claude-haiku-4-5`.
- **`alwaysThinkingEnabled: true`** forced extended thinking on for everyone.
  Thinking tokens are output tokens. Removed — that's your call, not the toolkit's.
- **`permissions.allow` blanket-allowed `mcp__*`**, i.e. every tool from every MCP
  server you might install. Removed.

### Fixed

- **`Bash(chown -R:*)` never fired.** Per the permissions docs, `:*` is only
  recognized at the _end_ of a pattern; a mid-pattern colon is a literal. So this
  prefix-matched the string `chown -R:` and matched nothing. A user read a deny rule
  that appeared to block recursive chown; it didn't.
- **The flaky detector counted a skipped test as a failure.** Any conditionally
  skipped test (env var, platform, missing binary) flipped pass↔fail between runs,
  got flagged flaky, and failed the run with exit 1 — a false-positive generator
  inside the false-positive detector. Also, its `flips` field reported the number of
  _runs_, not transitions.
- **`/bs:strategy` exited 0 with an empty report** when `acpx` (a binary named in no
  README, installed by nothing) was absent. It now fails loudly with an install
  pointer, and exits non-zero when every provider fails.
- **`/bs:backlog`, `/bs:dev --next` and `/bs:triage`** hard-required Linear/Sentry MCP
  servers with no detection and no message. They now say what's missing and stop.
- **Notification hooks ran raw `osascript`**, which does not exist on Linux/WSL — so
  the hook exited 127 on every permission prompt, every idle prompt and every agent
  completion. Replaced with `scripts/notify.sh` (osascript / notify-send / silent).
- Removed a vendored third-party **facebook-mcp-server** and a `.env.template` of 20
  social-media credentials, neither read by any shipped command.
- Removed maintainer-only references — `keyflash`, `BUI-*` ticket IDs, private doc
  paths, and one instruction to obtain "written permission from Brett" — that
  `CONTRIBUTING.md` itself forbids.

### Added

- **Coverage 64.76% → 87.94%** (312 tests, up from 237). The gap was worst in the
  differentiated part: `risk-score.js` (62% → 84%) and the run governor's `bumpRound`
  — the round cap that terminates the fix→re-review loop — which had **no tests at
  all** despite its whole safety property being that it fails closed.
- Regression tests that pin the three failures above: a real `: gone]` branch holding
  an unpushed commit must survive; `BLOCKING_COUNT` must be _compared_, not merely
  interpolated; SKILL.md must stay inside the compaction budget.
- A **Prerequisites** section in the README. There wasn't one.

### Changed

- `requiredMinimumVersion` 2.1.198 → 2.1.207.
- `requiredMinimumVersion` 2.1.207 → 2.1.210 for the latest worktree and
  destructive-path safety fixes.

## [3.0.0] - 2026-07-12

The paid tier is gone. claude-kit is now the whole thing, free and MIT.

### Changed — claude-kit-pro folded in and archived

Anthropic shipped the orchestration layer natively (workflows, background agents,
agent teams), which is most of what the paid tier sold. Keeping a middle tier that
duplicated the platform stopped making sense, so `claude-kit-pro` was folded into
this repo and archived on 2026-07-11. Everything it had — quality, ralph, strategy,
sota, steward, review, backlog, the domain skills, all 14 agents — is here, MIT.

The old three-tier chain (setup → kit-pro → kit) is collapsed. There is no "core
layer" and no "pro"; there is just the kit.

### Fixed — the installer was silently broken

`install.sh` symlinked `commands/`, `skills/` and `agents/` into `~/.claude/` but
**not `scripts/`** — while `config/settings.json` wires 14 hooks to
`$HOME/.claude/scripts/*.sh`. Every hook (including the `block-push-main` and
`block-commit-main` safety rails) silently no-opped for anyone who installed from a
clean clone. One missing word in a `for` loop.

- `install.sh`: link `scripts/` as well (#—)
- `scripts/setup-claude-sync.sh`: **added**. Six files referenced this script and it
  did not exist; `/bs:sync`, whose entire job is repairing symlinks, invoked it. It
  now exists, links all four directories, and verifies every hook named in
  `settings.json` actually resolves. `--check` exits non-zero when they don't.
- `skills/ralph/SKILL.md`: `SCRIPT` was built from `$SETUP_REPO`, a variable that is
  never set — so ralph's runner path resolved to `/scripts/ralph-next-run.sh` and
  failed for everyone. Now resolved through the standard candidate chain.
- `commands/bs/sync.md`: same `$SETUP_REPO` bug.

### Fixed — hardcoded maintainer-only paths

`skills/quality/SKILL.md` and `skills/ralph/SKILL.md` fell back to
`$HOME/Projects/products/claude-kit/...`, a path that exists on exactly one machine.
Removed; the chain now ends at `$HOME/.claude/scripts/`, which the installer creates.
This is the rule CONTRIBUTING.md already stated and the repo was violating.

### Changed — tightened default Bash permissions (BREAKING)

`config/settings.json` listed a bare `"Bash"` in `permissions.allow`, which
auto-approved **every** shell command and effectively neutered the `deny` and `ask`
rules below it. Removed. The allow-list now only covers the specific read-only
patterns (`Bash(**/grep *)`, `Bash(**/cat *)`, …).

Expect prompts for Bash commands that previously ran unprompted. That is the point —
widen the allow-list in your own `~/.claude/settings.json` if you want it back.

### Fixed — CI hostile to contributors

- `.github/workflows/cascade-to-pro.yml`: **removed**. It fired on every push to
  main, dispatching to `claude-kit-pro` — now archived and private. It failed every
  time, leaving a permanent red ✗ on the repo homepage, and advertised a private repo.
- `.github/workflows/stale-prs.yml`: this auto-closed **any** PR after 48 hours. It is
  a solo-maintainer discipline hack and it was pointed at the public: a first-time
  contributor opening a PR on Friday would have it closed by Sunday. Now scoped to
  PRs explicitly labelled `maintainer`; community PRs are invisible to it.

### Fixed — dangling command references

`/bs:post`, `/bs:maintain`, `/bs:resume` and `/bs:context` were referenced in shipped
docs but ship in no version of the kit (the first two are private; the latter two were
removed). `/bs:workflow` — the guide the README points newcomers at — told them to run
commands that do not exist. All 44 referenced `/bs:*` commands now resolve.

### Fixed — version skew

`plugin.json` said 3.0.0, `package.json` said 1.2.1, the latest tag said v2.2.0.
Now uniformly 3.0.0.

## [1.2.1] - 2026-05-17

### Fixed

- `commands/bs/quality.md`: removed an unsafe cleanup-cron example that suggested a periodic find-and-delete rooted at the `$TMPDIR` variable. Even bounded by `-name` and `-mtime` filters, deleting through a shell-resolved path matches the dangerous-pattern rule documented in CLAUDE.md (filesystem-safety policy, 2026-04-19 incident). The OS reclaims `$TMPDIR` on its own schedule, so no user-level cron is needed (#42).

## [1.2.0] - 2026-05-16

### Repositioned

claude-kit is now positioned as a **complete OSS Claude Code toolkit**, not "the free core layer that pro extends." Most devs won't need anything beyond it. Pro (claude-kit-pro) is a different category — autonomous workflow + commercial intelligence + license enforcement — not "more features."

The full kit↔pro de-duplication arc landed across 5 PRs (#36–#40). Items that weren't truly commercial or pro-only moved into kit:

### Added

- **`quality` skill — full body absorbed from pro** (#36): tier classification (`--level auto`, `harness-config.json` risk routing), Codex cross-review (`--codex-effort`, `--codex-skip`, `--no-codex`), break-glass approval for critical tier, agent panel mapping, `--background`/`--wait` flags, full `--target-dir` PR/branch/worktree resolver. Was previously a forked pro-only superset; now lives in kit canonically. `reference.md` and `checklist.md` also added (kit was missing both).
- **`scripts/quality-target-resolver.js`** (410 lines) + **32 tests** (#36) — full PR / branch / worktree-path resolution moved from the claude-setup overlay so kit-only users get the full target resolver, not just the legacy `--target-dir` parser.
- **`skills/healthcheck`: `model: haiku` frontmatter** (#36).
- **Basic-hygiene skills** (#37): `cost`, `deps`, `status`, `workflow` skills + `bs:cost`, `bs:deps` commands. License gates stripped on the kit copies. Pro's overrides deleted.
- **Sticky-funnel skills** (#38): `frontend-design` (Apache 2.0, Anthropic-original), `ui-reviewer` (Brett-authored), `webapp-testing` (Apache 2.0, Anthropic-original Playwright toolkit), `visualise` (Brett-authored). LICENSE.txt files preserved on the Apache 2.0 skills.
- **6 generic SWE agents** (#39): `accessibility-tester`, `architect-reviewer`, `performance-engineer`, `postgres-pro`, `prompt-engineer`, `refactoring-specialist`. Joining the existing 2 (`code-reviewer`, `security-auditor`) for **8 total SWE agents**.
- **2 dev-hygiene commands** (#39): `bs:investigate`, `bs:init-project`. License gates stripped.
- **README rewritten** (#40): 15-row tier comparison table, lists all 14+ skills with one-liners, dedicated Agents section, "When you might want pro" section that honestly tells readers when they don't need pro.

### Fixed

- **Drift hazard for 5 duplicated items eliminated** (#36): `skills/quality`, `skills/healthcheck`, `skills/recover`, `agents/code-reviewer`, `agents/security-auditor` had been forked between kit and pro with 782 lines of divergence on quality alone. Kit absorbed pro's canonical versions and pro deleted its copies.

### Changed

- **`tests/__tests__/quality-target-resolution.test.js`** runs under Vitest as part of the standard suite (32 tests, all green).

## [1.1.0] - 2026-05-15

### Added

- **`scrub` skill** — `/bs:scrub` is now backed by `skills/scrub/SKILL.md` and auto-invokes on natural language ("prep this for open source", "scrub for release", "clean before publishing", "prep for giveaway", "prepare commercial release"). The 334-line implementation moved from a top-level command file into a proper Skill, matching the same pattern used by `/bs:quality`, `/bs:ralph`, and `/bs:dev`. Slash-command users can still call `/bs:scrub` directly; the file at `commands/bs/scrub.md` is now a thin shim that invokes the skill.

### Fixed

- **`skills/scrub`: Phase 9 release block restored** — the original `commands/bs:scrub.md` had a `Phase 9: Version Bump + GitHub Release` step (auto-bumps `package.json`, tags, runs `gh release create`). It was missing from the initial skill conversion; restored verbatim so the documented end-to-end "scrub + cut release" flow works.
- **`skills/scrub`: hardened submodule deletion example** — the previous `git submodule deinit` walkthrough included a `rm -rf .git/modules/<path>` snippet that would trip the filesystem-safety hook. Rewrote to require explicit literal-path resolution, repo-boundary check, and user confirmation before any deletion.
- **`skills/quality`: persist git root through forked Bash blocks** — `--target-dir` now survives skill forks (#33).
- **`skills/quality`: arg propagation across fork boundary** — `$ARGUMENTS` now persists via a tempfile bridge (`--args-file`), so flags reach the forked skill reliably (#26).
- **`skills/quality`: auto-select scope+level from diff size and risk tier** (#30), with a coaching note when `--scope changed` is the right call for tiny critical/high-tier changes (#31).

### Removed

- **`commands/bs:scrub.md`** (top-level, colon-prefix variant) — superseded by `commands/bs/scrub.md` + `skills/scrub/`.

## [1.0.6] - internal

Version bumped in #32; no CHANGELOG entry written at the time. Covered by 1.1.0.

## [1.0.5] - internal

Tag without a CHANGELOG entry. Covered by 1.1.0.

## [1.0.4] - 2026-05-06

### Fixed

- Add the missing `.semgrep/defensive-patterns.yaml` config so `npm run security:scan:ci` works for release checks.
- Wire Husky `pre-commit` and `commit-msg` hooks to match the documented lint-staged and commitlint workflow.
- Tighten `knip.config.js` to the actual source layout so `npm run dead-code:strict` passes.
- Apply Prettier formatting to release-facing templates, `SECURITY.md`, `/bs:scrub`, and the agent dashboard server.

### Removed

- Remove unused `fast-check` dev dependency.

## [1.0.2] - 2026-04-19

### Fixed

- **`skills/quality/`**: remove Codex Cross-Review section (requires paid ChatGPT subscription — belongs in claude-kit-pro). Fix acpx 0.5.3 syntax in the Parallel Sub-Review block — the old syntax (`acpx claude exec --no-wait`, `acpx status`, `acpx output`) had not worked since acpx 0.5.3, so `/bs:quality --parallel` silently fell back to sequential. Now uses the correct `sessions new` → `prompt --no-wait` → `sessions read` flow with history-based completion detection.
- **`commands/bs/dev.md`**: remove `--alt` Second Opinion mode (Codex-based, paid tier).
- **`skills/quality/reference.md`**: drop `--no-codex` flag and `CODEX_TIMEOUT` env var.
- **`skills/quality/checklist.md`**: drop the "Claude AND Codex" confidence-boost line.

### Removed

- **`scripts/risk-policy-gate.js`** (+ its tests, stryker config, and the Harness Policy Gate workflow). The scrub that created v1.0 removed the required `harness-config.json`, leaving an always-failing workflow on every PR. `quality.yml` is the primary CI gate.
- **`mcp-servers/dataforseo-mcp-server/dist/`** — 380K of compiled 3rd-party JS with no source, LICENSE, or attribution. Free-tier users cannot use it anyway (needs paid DataForSEO credentials).
- **`mcp-servers/twitter-mcp-server/`** — only a rate-limit cache file, no source/LICENSE.
- **`scripts/run-dataforseo-mcp.sh`** — now-orphan wrapper.
- **Stryker mutation testing**: config + package.json scripts + deps. Only mutated the removed `risk-policy-gate.js`.

### Added

- **Pull-request CI**: `quality.yml` now triggers on `pull_request` (lint-and-format + test jobs). Previously PRs had zero automated CI after the Harness Policy Gate workflow was removed.
- **`.defensive-patterns.json`**: exclusion config for `eslint-plugin-defensive/` (self-referential false positives — its rule definitions contain the patterns they describe) and `mcp-servers/*/dist/`.

### Chore

- Prettier auto-format across 80 files (non-semantic — repo's existing prettier config applied).

## [1.0.1] - earlier

Initial public release cycle.

## [1.0.0] - 2026-04-12

Initial public release of claude-kit (renamed from claude-power-kit).
