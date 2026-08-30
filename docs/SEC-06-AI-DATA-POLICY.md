# SEC-06 — AI Data Security & Privacy Policy
Status: **Approved policy document.** Documentation/policy scope only — no AI code exists yet.
Source: `SEC-06 Read-Only Audit` (read-only inspection of the repository, no code modified).
This is the authoritative reference for Phase 5 (`AI-01` onward) in `docs/DOCFLOW_STATUS.md`. Any future AI implementation must conform to this document. Do not begin `AI-01` until this policy is reviewed against the actual chosen provider/deployment and re-confirmed still accurate.

---

## 0. Current reality (as of this policy's approval)

Production DocFlow, today, has:
- No production AI pipeline, AI server, remote AI provider, or Ollama integration.
- No AI API key used by browser code or by a production server (no production server exists).
- All PDF processing client-side, in browser memory (`File`, `ArrayBuffer`, PDF.js, `pdf-lib`, canvas, `Blob`, object URLs).
- One production third-party network path: the Fix Page Orientation OCR fallback, which downloads Tesseract worker/core/language assets from jsDelivr. The rendered page image and OCR text stay local and are not uploaded.
- One **developer-only** Python tool (`ai_assistant.py`) that can send repository text explicitly supplied to it to NVIDIA's Nemotron endpoint. It is not imported or bundled by the Next.js product and cannot be triggered by production users. This path must never be conflated with, or implied to be part of, the user-facing DocFlow product.

Nothing below authorizes building AI functionality. It defines the rules that future AI functionality (Phase 5) must follow when it is built.

---

## 1. Browser-only original PDFs

The original user-selected PDF must remain browser-only. Phase 5 v1 must **never** upload the original PDF to an AI server or remote AI provider.

The following must never be sent to an AI provider of any kind:
- Original PDF bytes
- `File` objects
- PDF `ArrayBuffer` / `Uint8Array`
- Passwords
- Page images
- Thumbnails
- Unrequested PDF metadata

AI processing may only receive minimized extracted text/chunks explicitly selected for AI processing.

---

## 2. Text egress rule

PDF text extraction and chunking must occur in the browser. Only the minimum required extracted text/chunks may leave the browser.

AI requests may contain:
- Selected extracted text/chunks
- User prompt
- Necessary non-sensitive request settings
- Minimal page/chunk identifiers when required

They must not contain the original PDF or unrelated document data.

---

## 3. Provider categories

### Local Ollama
A user-controlled Ollama service running on the user's device/loopback. Selected extracted text and the user's prompt may be sent from the browser to the configured local Ollama service. This must be disclosed to the user. Only describe it as "local" after the deployment has actually been verified as local/loopback — never assume.

### Self-hosted remote
An Ollama or compatible AI service controlled by the user/organization but running on another machine/network. Treat this as a network transmission boundary. It must **not** be described as "local."

### Third-party hosted provider
A remote AI provider operated by an external company. Only the minimum selected extracted text/chunks and prompt may be transmitted. The original PDF and password must never be sent. Requires explicit affirmative consent immediately before the first content-bearing request.

---

## 4. Retention and logging

DocFlow must not retain by default:
- Source PDFs
- Extracted text
- Prompts
- AI requests
- AI responses/outputs

For any future server-side AI proxy:
- Disable request-body/content logging.
- Do not persist document content, prompts, or AI outputs.
- Use only minimal operational telemetry that contains no document content.
- Define deletion responsibilities for any unavoidable temporary data before shipping.

---

## 5. API-key security

Remote AI provider API keys/secrets must never be shipped to browser JavaScript. Provider credentials must remain:
- Server-side in a trusted DocFlow backend, or
- In a user-controlled local deployment.

Never use `NEXT_PUBLIC_*` variables for AI secrets.

---

## 6. Consent and disclosure

Before any content-bearing request to a remote provider, the UI must clearly disclose:
- Provider name
- Service location/type
- Whether it is local, self-hosted remote, or third-party hosted
- Exactly what data will be sent
- That the original PDF is not sent
- That the PDF password is not sent
- Relevant provider privacy/retention terms
- DocFlow's privacy policy

Consent must be explicit, affirmative, not pre-checked, and requested immediately before the first content-bearing remote request. Use wording equivalent to **"Send selected text to [Provider]"** with a clear **Cancel** option. Provider identity/status must remain visible for AI results, and changing provider must be an explicit user action.

---

## 7. Local Ollama disclosure

Once Ollama is actually verified as loopback/local, use wording equivalent to:

> "Selected extracted text and your prompt will be sent from this browser to your configured local Ollama service. No DocFlow server receives it."

Do not use this wording for remote or self-hosted deployments.

---

## 8. Privacy terminology

Do not introduce or approve unsupported absolute claims such as: "100% private," "completely private," "nothing ever leaves your device," "no data is ever sent anywhere," "no third-party requests," "zero data," or "AI processing is always local."

Privacy messaging must distinguish:
- **Processed in browser**
- **Sent to local Ollama**
- **Sent to self-hosted remote service**
- **Sent to named third-party provider**

Do not call all AI modes "local" or "private."

---

## 9. Technical guardrails for future AI implementation

To be treated as mandatory acceptance criteria for `AI-01`/`AI-02` and subsequent Phase 5 implementation.

**Provider interface** — must carry only `textChunks`, prompt, and non-sensitive request settings. Must explicitly exclude `File`, raw PDF bytes, password, page image, thumbnail, and arbitrary metadata, enforced by both TypeScript typing and runtime validation.

**Browser processing** — extraction and chunking occur in the browser; enforce maximum chunk size/count; respect explicit selected-page scope; minimize text sent to providers.

**Provider separation** — separate local and remote provider implementations. Remote providers must be server-mediated. A browser must never directly receive or contain a third-party provider secret.

**Remote provider safeguards** — provider-origin allowlist, model allowlist, strict request schema, authentication, rate limiting, content-free logging, no request-body persistence.

**Egress tests** — must fail if any AI client receives PDF bytes, `File`, password, `FormData`, raw page image, or thumbnail. Also require provider/consent integration tests, retention/logging tests, and browser network assertions.

**Ollama URL security** — treat an Ollama URL as controlled configuration; do not allow arbitrary browser destinations. Fail closed when provider classification is unavailable, consent is missing, provider configuration is invalid, or a remote provider has not been explicitly approved. Remote AI must be opt-in and disabled by default.

---

## 10. Developer-only tooling boundary

The developer-only NVIDIA Nemotron path (`ai_assistant.py`, `coding_agent.py`, `agent_filesystem.py`) must remain isolated from the production bundle (tracked as `SEC-01`, already verified). Documentation and product copy must never imply that production DocFlow currently sends user PDFs to NVIDIA or any AI provider.

---

## 11. Completion criteria this document satisfies

1. Browser-only-PDF and text-egress rules — §1, §2.
2. Local Ollama / self-hosted remote / third-party remote categories defined — §3.
3. Retention/logging defaults defined — §4.
4. Remote-provider consent/disclosure requirements defined — §6, §7.
5. Server-side remote-provider/key boundary mandated — §5.
6. Prohibited fields and AI-01/AI-02 guardrails documented — §1, §9.

This document does not itself implement any of the above — it is the policy Phase 5 code must be built and tested against.
