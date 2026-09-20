#!/usr/bin/env node
"use strict";

// The signed approval payload and its persisted manifest projection must
// describe the same immutable decision. Keeping these comparisons together
// prevents callers from accepting only part of that identity (BUI-905).

function approvalPayloadCoreIdentityMatches(manifest, approval, payload) {
  return (
    payload?.repoKey === manifest.repo.key &&
    payload?.pr === manifest.repo.pr &&
    payload?.head === approval.head &&
    payload?.invocationId === manifest.invocationId &&
    payload?.approver === approval.approver &&
    payload?.expiresAt === approval.expiresAt
  );
}

function approvalPayloadScopeAndConditionsMatch(approval, payload) {
  const scopeMatches =
    (payload?.scope || "standard") === (approval.scope || "standard");
  const conditionsMatch =
    JSON.stringify(payload?.acceptedConditions || []) ===
    JSON.stringify(approval.acceptedConditions || []);
  return scopeMatches && conditionsMatch;
}

function approvalPayloadIdentityMatches(manifest, approval, payload) {
  return (
    approvalPayloadCoreIdentityMatches(manifest, approval, payload) &&
    approvalPayloadScopeAndConditionsMatch(approval, payload) &&
    (approval.ciBillingEvidenceSha256 ?? null) ===
      (payload.ciBillingEvidenceSha256 || null) &&
    (approval.protectedNonstrictProtectionDigest ?? null) ===
      (payload.protectedNonstrictProtectionDigest || null) &&
    (approval.protectedNonstrictBaseSha ?? null) ===
      (payload.protectedNonstrictBaseSha || null) &&
    JSON.stringify(approval.protectedNonstrictRequiredChecks || null) ===
      JSON.stringify(payload.protectedNonstrictRequiredChecks || null)
  );
}

module.exports = { approvalPayloadIdentityMatches };
