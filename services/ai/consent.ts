/**
 * V6-D03 — Tier-2 consent and disclosure flow (policy/model layer only).
 *
 * Provider-agnostic, deterministic, in-memory consent boundary for
 * content-bearing AI requests. Pure apart from the caller-owned
 * consent store: no network, no generation, no document data, no
 * persistence, no UI rendering.
 *
 * Authority: `runtime.capabilities.requiresConsent` alone determines
 * whether consent is required. Provider names and tiers are never
 * branched on here; `providerId`, `displayName`, and `isLocal` are
 * read from capabilities and never duplicated.
 *
 * Consent is scoped to one provider (`providerId`): a grant for one
 * provider never authorizes another. State lives in an explicit
  * caller-owned in-memory store (`createAiConsentStore`) — no browser
  * or server persistence of any kind, no global singletons, and no
  * hidden long-lived authorizations.
 *
 * Disclosure (`buildAiDisclosure`) produces deterministic UI-ready
 * copy without rendering: SEC-06 §6/§7 wording for consent-requiring
 * runtimes ("Send selected text to [Provider]", extracted text sent,
 * original PDF and password not sent, availability depends on the
 * local service) and scoped in-browser copy otherwise. Absolute
 * claims ("100% private", "nothing leaves your device", "zero
 * network", "completely offline") are never produced.
 */

import type { AiCapabilities, AiRuntime } from "./types";

/** Thrown when a content-bearing request is blocked for missing consent. */
export class AiConsentRequiredError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Consent is required before sending content to "${providerId}".`);
    this.name = "AiConsentRequiredError";
    this.providerId = providerId;
  }
}

/** Thrown for malformed consent/disclosure input (never for states). */
export class AiConsentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConsentValidationError";
  }
}

/** Explicit consent states: required-but-absent, granted, or not needed. */
export type AiConsentStatus = "required" | "granted" | "not-required";

/** One consent evaluation outcome, always provider-scoped. */
export interface AiConsentState {
  readonly status: AiConsentStatus;
  readonly providerId: string;
  readonly displayName: string;
}

/** Explicit in-memory consent store. No persistence, no globals. */
export interface AiConsentStore {
  grant(providerId: unknown): void;
  revoke(providerId: unknown): void;
  isGranted(providerId: unknown): boolean;
  grantedProviders(): readonly string[];
}

/** UI-ready disclosure copy (data only — no rendering here). */
export interface AiDisclosure {
  readonly providerId: string;
  readonly displayName: string;
  readonly requiresConsent: boolean;
  readonly headline: string;
  readonly points: readonly string[];
  readonly confirmLabel: string | null;
  readonly cancelLabel: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidProviderId(providerId: unknown): asserts providerId is string {
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new AiConsentValidationError("Provider identity must be a non-empty string.");
  }
}

/** Reads capability authority fail-loud; rejects document/model/provider objects. */
function readCapabilities(runtime: unknown): AiCapabilities {
  if (!isPlainObject(runtime) || !isPlainObject(runtime["capabilities"])) {
    throw new AiConsentValidationError("Consent requires a runtime with capabilities.");
  }
  const capabilities = runtime["capabilities"] as Record<string, unknown>;
  if (
    typeof capabilities["providerId"] !== "string" ||
    capabilities["providerId"].length === 0 ||
    typeof capabilities["displayName"] !== "string" ||
    capabilities["displayName"].length === 0 ||
    typeof capabilities["requiresConsent"] !== "boolean" ||
    typeof capabilities["isLocal"] !== "boolean"
  ) {
    throw new AiConsentValidationError("Runtime capabilities are malformed.");
  }
  return capabilities as unknown as AiCapabilities;
}

function assertValidStore(store: unknown): asserts store is AiConsentStore {
  if (
    !isPlainObject(store) ||
    typeof store["grant"] !== "function" ||
    typeof store["revoke"] !== "function" ||
    typeof store["isGranted"] !== "function"
  ) {
    throw new AiConsentValidationError("Consent evaluation requires a consent store.");
  }
}

/** Creates an explicit caller-owned in-memory consent store. */
export function createAiConsentStore(): AiConsentStore {
  const granted = new Set<string>();
  return {
    grant(providerId: unknown): void {
      assertValidProviderId(providerId);
      granted.add(providerId);
    },
    revoke(providerId: unknown): void {
      assertValidProviderId(providerId);
      granted.delete(providerId);
    },
    isGranted(providerId: unknown): boolean {
      if (typeof providerId !== "string" || providerId.length === 0) {
        return false;
      }
      return granted.has(providerId);
    },
    grantedProviders(): readonly string[] {
      return Object.freeze([...granted]);
    },
  };
}

/** Convenience: grants consent for one provider in the given store. */
export function grantAiConsent(store: unknown, providerId: unknown): void {
  assertValidStore(store);
  store.grant(providerId);
}

/** Convenience: revokes one provider's consent; others are unaffected. */
export function revokeAiConsent(store: unknown, providerId: unknown): void {
  assertValidStore(store);
  store.revoke(providerId);
}

/**
 * Deterministically evaluates consent for a runtime: `not-required`
 * when `requiresConsent` is false, `granted` when the store holds
 * this provider's grant, otherwise `required`. A grant for another
 * provider never satisfies this runtime.
 */
export function evaluateAiConsent(runtime: unknown, store?: unknown): AiConsentState {
  const capabilities = readCapabilities(runtime);
  if (capabilities.requiresConsent === false) {
    return Object.freeze({
      status: "not-required",
      providerId: capabilities.providerId,
      displayName: capabilities.displayName,
    });
  }
  if (store === undefined) {
    return Object.freeze({
      status: "required",
      providerId: capabilities.providerId,
      displayName: capabilities.displayName,
    });
  }
  assertValidStore(store);
  const status: AiConsentStatus = store.isGranted(capabilities.providerId)
    ? "granted"
    : "required";
  return Object.freeze({ status, providerId: capabilities.providerId, displayName: capabilities.displayName });
}

/**
 * Enforcement gate: returns silently when the request may proceed
 * (consent not required, or granted for this provider) and throws
 * `AiConsentRequiredError` otherwise — including when only another
 * provider's consent exists.
 */
export function assertAiConsent(runtime: unknown, store?: unknown): void {
  const state = evaluateAiConsent(runtime, store);
  if (state.status === "granted" || state.status === "not-required") {
    return;
  }
  throw new AiConsentRequiredError(state.providerId);
}

/**
 * Builds deterministic UI-ready disclosure copy from capability
 * metadata. Consent-requiring runtimes get SEC-06 §6/§7 wording
 * (explicit approval, extracted text sent, original PDF and password
 * not sent, availability depends on the local service); all copy
 * stays scoped — no absolute privacy/offline claims.
 */
export function buildAiDisclosure(runtime: unknown): AiDisclosure {
  const capabilities = readCapabilities(runtime);
  if (capabilities.requiresConsent === false) {
    return Object.freeze({
      providerId: capabilities.providerId,
      displayName: capabilities.displayName,
      requiresConsent: false,
      headline: `${capabilities.displayName}: document text is processed in your browser.`,
      points: Object.freeze([
        `Provider: ${capabilities.displayName}.`,
        "Location: inference runs in your browser.",
        "Data use: extracted document text stays in this browser for this request.",
        "No Tier-2 consent step applies to this provider.",
      ]),
      confirmLabel: null,
      cancelLabel: null,
    });
  }
  const location = capabilities.isLocal
    ? "Location: your local Ollama service on this device."
    : "Location: the configured provider service.";
  return Object.freeze({
    providerId: capabilities.providerId,
    displayName: capabilities.displayName,
    requiresConsent: true,
    headline: `Send selected text to ${capabilities.displayName}.`,
    points: Object.freeze([
      `Provider: ${capabilities.displayName}.`,
      location,
      "Data sent: selected extracted document text and your prompt.",
      "Original PDF is not sent to the provider by the production AI runtime contract.",
      "PDF password is never sent.",
      "Availability depends on the local service and the configured model being reachable.",
      "Explicit approval is required before the content-bearing request proceeds.",
    ]),
    confirmLabel: `Send selected text to ${capabilities.displayName}`,
    cancelLabel: "Cancel",
  });
}

/** Type-guard: structural check that a value upholds the AiRuntime surface. */
export function isAiRuntimeLike(value: unknown): value is AiRuntime {
  if (!isPlainObject(value)) {
    return false;
  }
  try {
    readCapabilities(value);
  } catch {
    return false;
  }
  return (
    typeof value["generateText"] === "function" &&
    typeof value["checkAvailability"] === "function"
  );
}
