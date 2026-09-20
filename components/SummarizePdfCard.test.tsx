// @vitest-environment jsdom
"use client";

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import SummarizePdfCard from "./SummarizePdfCard";
import { AiEmptyContextError } from "../services/ai/orchestration";

// Mock orchestration — keep real BrowserAiRuntime import but mock orchestration layer
vi.mock("../services/ai/orchestration", async () => {
  const actual = await vi.importActual<typeof import("../services/ai/orchestration")>(
    "../services/ai/orchestration",
  );
  return {
    ...actual,
    runAiActionOnPdf: vi.fn(),
  };
});

// Mock Tier-2 validated pipeline + availability (no live Ollama in jsdom)
vi.mock("../services/ai/tier2Summarize", () => {
  class MockTier2ServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "Tier2ServiceError";
      this.code = code;
    }
  }
  return {
    Tier2ServiceError: MockTier2ServiceError,
    runTier2ValidatedSummarize: vi.fn(),
  };
});

vi.mock("../services/ai/ollama/availability", async () => {
  const actual = await vi.importActual<typeof import("../services/ai/ollama/availability")>(
    "../services/ai/ollama/availability",
  );
  return {
    ...actual,
    getOllamaAvailability: vi.fn(),
  };
});

import { runAiActionOnPdf } from "../services/ai/orchestration";
import { BrowserAiRuntime } from "../services/ai/browser/browserAiRuntime";
import { getOllamaAvailability } from "../services/ai/ollama/availability";
import {
  Tier2ServiceError,
  runTier2ValidatedSummarize,
} from "../services/ai/tier2Summarize";

const mockedRun = vi.mocked(runAiActionOnPdf);
const mockedAvailability = vi.mocked(getOllamaAvailability);
const mockedTier2 = vi.mocked(runTier2ValidatedSummarize);

// Helper to create a File
function makePdfFile(name = "test.pdf"): File {
  return new File(["%PDF-1.4 fake"], name, { type: "application/pdf" });
}

// Helper to get hidden file input
function getFileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

describe("SummarizePdfCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockedRun.mockResolvedValue({
      text: "This is a summary.",
      providerId: "browser-ai",
      chunks: [
        { chunkIndex: 0, pageNumber: 1, text: "hello", startOffset: 0, endOffset: 5 },
      ],
      sourcePageCount: 1,
      pagesWithoutText: [],
      truncated: false,
    });
  });

  it("idle: UploadZone visible and Summarize disabled", () => {
    render(<SummarizePdfCard />);
    expect(screen.getByText(/Choose a PDF to summarize/i)).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Summarize PDF/i });
    expect(btn).toBeDisabled();
  });

  it("shows the supported-envelope disclosure (context size, truncation, local processing, quality varies)", () => {
    render(<SummarizePdfCard />);
    expect(
      screen.getByText(/up to about 8,192 characters of extracted PDF text/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/longer documents may be truncated/i)).toBeInTheDocument();
    expect(screen.getByText(/generated locally in your browser/i)).toBeInTheDocument();
    expect(screen.getByText(/quality can vary by document/i)).toBeInTheDocument();
  });

  it("valid PDF selection shows file and enables Summarize", async () => {
    render(<SummarizePdfCard />);
    const file = makePdfFile();
    const input = getFileInput();
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(await screen.findByText("test.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Summarize PDF/i })).toBeEnabled();
  });

  it("invalid file shows valid-PDF validation message", async () => {
    render(<SummarizePdfCard />);
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const input = getFileInput();
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(await screen.findByText(/Please select a valid PDF file/i)).toBeInTheDocument();
  });

  it("summarization calls runAiActionOnPdf once with summarize and File and runtime", async () => {
    render(<SummarizePdfCard />);
    const file = makePdfFile();
    const input = getFileInput();
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    const btn = screen.getByRole("button", { name: /Summarize PDF/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(mockedRun).toHaveBeenCalledTimes(1));
    const args = mockedRun.mock.calls[0][0];
    expect(args.file).toBe(file);
    expect(args.action).toBe("summarize");
    expect(args.runtime).toBeInstanceOf(BrowserAiRuntime);
  });

  it("processing: shows processing UI, disables UploadZone and action, Cancel visible", async () => {
    let resolve!: (v: unknown) => void;
    mockedRun.mockImplementation(() => new Promise((res) => (resolve = res as unknown as (v: unknown) => void)));
    render(<SummarizePdfCard />);
    const file = makePdfFile();
    const input = getFileInput();
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    expect(await screen.findByText(/Generating summary|Extracting text|Processing/i)).toBeInTheDocument();
    // Summarize button should be disabled/busy
    expect(screen.getByRole("button", { name: /Summarizing/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeInTheDocument();
    // Cleanup resolve
    await act(async () => {
      resolve({
        text: "ok",
        providerId: "browser-ai",
        chunks: [{ chunkIndex: 0, pageNumber: 1, text: "hello", startOffset: 0, endOffset: 5 }],
        sourcePageCount: 1,
        pagesWithoutText: [],
        truncated: false,
      });
    });
  });

  it("success renders summary text and result area", async () => {
    render(<SummarizePdfCard />);
    const file = makePdfFile();
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [file] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    expect(await screen.findByText("This is a summary.")).toBeInTheDocument();
    expect(screen.getByText(/Summary ready/i)).toBeInTheDocument();
  });

  it("empty context shows scanned/image-only explanation", async () => {
    mockedRun.mockRejectedValue(new AiEmptyContextError());
    render(<SummarizePdfCard />);
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [makePdfFile()] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    expect(
      await screen.findByText(/No extractable text was found.*scanned\/image-only/i),
    ).toBeInTheDocument();
  });

  it("initialization/generation error shows retryable message", async () => {
    const err = new Error("model failed to load");
    err.name = "AiModelInitializationError";
    mockedRun.mockRejectedValue(err);
    render(<SummarizePdfCard />);
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [makePdfFile()] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    expect(await screen.findByText(/AI initialization failed/i)).toBeInTheDocument();
  });

  it("cancellation: Cancel calls runtime.cancel and shows cancelled state", async () => {
    const runtimeCancelSpy = vi.spyOn(BrowserAiRuntime.prototype, "cancel");
    let resolve: (v: unknown) => void;
    let reject: (e: unknown) => void;
    mockedRun.mockImplementation(
      () =>
        new Promise((res, rej) => {
          resolve = res as unknown as (v: unknown) => void;
          reject = rej;
        }),
    );
    render(<SummarizePdfCard />);
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [makePdfFile()] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    expect(await screen.findByRole("button", { name: /Cancel/i })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    });
    expect(runtimeCancelSpy).toHaveBeenCalled();
    // Simulate cancelled error
    const cancelErr = new Error("cancelled");
    cancelErr.name = "AiGenerationCancelledError";
    await act(async () => {
      reject(cancelErr);
    });
    expect(await screen.findByText(/Generation cancelled/i)).toBeInTheDocument();
    runtimeCancelSpy.mockRestore();

    // retry can run again — resolve next call
    mockedRun.mockResolvedValue({
      text: "second summary",
      providerId: "browser-ai",
      chunks: [{ chunkIndex: 0, pageNumber: 1, text: "hello", startOffset: 0, endOffset: 5 }],
      sourcePageCount: 1,
      pagesWithoutText: [],
      truncated: false,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    expect(await screen.findByText("second summary")).toBeInTheDocument();
  });

  it("truncation disclosure appears when truncated true", async () => {
    mockedRun.mockResolvedValue({
      text: "summary",
      providerId: "browser-ai",
      chunks: [{ chunkIndex: 0, pageNumber: 1, text: "hello", startOffset: 0, endOffset: 5 }],
      sourcePageCount: 5,
      pagesWithoutText: [],
      truncated: true,
    });
    render(<SummarizePdfCard />);
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [makePdfFile()] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    expect(await screen.findByText(/only part of the document was used/i)).toBeInTheDocument();
  });

  it("pagesWithoutText disclosure appears", async () => {
    mockedRun.mockResolvedValue({
      text: "summary",
      providerId: "browser-ai",
      chunks: [{ chunkIndex: 0, pageNumber: 1, text: "hello", startOffset: 0, endOffset: 5 }],
      sourcePageCount: 3,
      pagesWithoutText: [2, 3],
      truncated: false,
    });
    render(<SummarizePdfCard />);
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [makePdfFile()] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    expect(await screen.findByText(/Pages without extractable text: 2, 3/i)).toBeInTheDocument();
  });

  it("replace/reset clears file/result/error and allows another PDF", async () => {
    render(<SummarizePdfCard />);
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [makePdfFile("first.pdf")] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    expect(await screen.findByText("This is a summary.")).toBeInTheDocument();
    const resetBtn = screen.getByRole("button", { name: /Summarize another PDF/i });
    await act(async () => {
      fireEvent.click(resetBtn);
    });
    expect(screen.queryByText("first.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("This is a summary.")).not.toBeInTheDocument();
    // select another
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [makePdfFile("second.pdf")] } });
    });
    expect(await screen.findByText("second.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Summarize PDF/i })).toBeEnabled();
  });

  it("runtime reused across generations and dispose called on unmount", async () => {
    const disposeSpy = vi.spyOn(BrowserAiRuntime.prototype, "dispose");
    const { unmount } = render(<SummarizePdfCard />);
    // first generation creates runtime
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [makePdfFile()] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    await screen.findByText("This is a summary.");
    const firstCallRuntime = mockedRun.mock.calls[0][0].runtime as BrowserAiRuntime;
    // second generation should reuse same instance
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize another PDF/i }));
    });
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [makePdfFile("second.pdf")] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    await screen.findByText("This is a summary.");
    const secondCallRuntime = mockedRun.mock.calls[1][0].runtime as BrowserAiRuntime;
    expect(secondCallRuntime).toBe(firstCallRuntime);

    unmount();
    expect(disposeSpy).toHaveBeenCalled();
    disposeSpy.mockRestore();
  });

  it("stale async completion cannot overwrite reset state", async () => {
    let firstResolve!: (v: unknown) => void;
    mockedRun.mockImplementationOnce(
      () => new Promise((res) => (firstResolve = res as unknown as (v: unknown) => void)),
    );
    render(<SummarizePdfCard />);
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [makePdfFile("first.pdf")] } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    // reset before first resolves (stale)
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Cancel/i }).catch(() => screen.getByRole("button", { name: /Summarize PDF/i })));
      // Use reset if cancel not present, but we have cancel while processing.
      // Instead trigger reset via stale guard: change file which increments requestId
      fireEvent.change(getFileInput(), { target: { files: [makePdfFile("second.pdf")] } });
    });
    // Now resolve stale first — should not show "stale summary"
    mockedRun.mockResolvedValueOnce({
      text: "stale summary",
      providerId: "browser-ai",
      chunks: [{ chunkIndex: 0, pageNumber: 1, text: "hello", startOffset: 0, endOffset: 5 }],
      sourcePageCount: 1,
      pagesWithoutText: [],
      truncated: false,
    } as unknown as ReturnType<typeof mockedRun> extends Promise<infer T> ? T : never);
    // Actually resolve the pending first
    await act(async () => {
      firstResolve({
        text: "stale summary",
        providerId: "browser-ai",
        chunks: [{ chunkIndex: 0, pageNumber: 1, text: "hello", startOffset: 0, endOffset: 5 }],
        sourcePageCount: 1,
        pagesWithoutText: [],
        truncated: false,
      });
    });
    await act(async () => {
      // allow microtasks
    });
    expect(screen.queryByText("stale summary")).not.toBeInTheDocument();
    expect(screen.getByText("second.pdf")).toBeInTheDocument();
  });
});

describe("SummarizePdfCard Tier-2 (Ollama)", () => {
  const availableResult = { status: "available" };

  function groundedResult() {
    return {
      status: "grounded",
      claims: [
        {
          kind: "fact",
          text: "Point one.",
          evidenceIds: ["chunk-0-e0"],
          evidence: [
            {
              item: {
                evidenceId: "chunk-0-e0",
                chunkIndex: 0,
                sourcePages: [1],
                exactText: "exact bytes here",
                kind: "span",
              },
              chunk: {
                chunkIndex: 0,
                pageNumber: 1,
                text: "exact bytes here",
                startOffset: 0,
                endOffset: 16,
              },
            },
          ],
        },
      ],
      providerId: "ollama",
      runtime: "ollama",
      sourcePageCount: 1,
      pagesWithoutText: [],
      contextTruncated: false,
      evidenceAdmitted: 1,
      evidenceTruncated: false,
      rejectedClaims: 0,
      failedChunks: [],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockedAvailability.mockResolvedValue(availableResult as never);
    mockedTier2.mockResolvedValue(groundedResult() as never);
  });

  async function selectOllamaWithFile(name = "test.pdf") {
    render(<SummarizePdfCard />);
    const file = new File(["%PDF-1.4 fake"], name, { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [file] },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Ollama \(qwen3:4b/i));
    });
    return file;
  }

  it("45. Browser remains the default provider and stays usable", async () => {
    render(<SummarizePdfCard />);
    expect(
      (screen.getByLabelText(/Browser AI \(on-device\)/i) as HTMLInputElement).checked,
    ).toBe(true);
    const file = new File(["%PDF-1.4 fake"], "test.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [file] },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    await waitFor(() => expect(mockedRun).toHaveBeenCalledTimes(1));
    expect(mockedTier2).not.toHaveBeenCalled();
  });

  it("46. Ollama option identifies the provider", async () => {
    render(<SummarizePdfCard />);
    expect(screen.getByLabelText(/Ollama \(qwen3:4b, local service\)/i)).toBeInTheDocument();
  });

  it("47. Ollama disclosure appears before any content-bearing request", async () => {
    await selectOllamaWithFile();
    expect(
      await screen.findByText("Send selected text to Ollama (qwen3:4b)."),
    ).toBeInTheDocument();
    expect(mockedTier2).not.toHaveBeenCalled();
  });

  it("48. consent denial prevents generation", async () => {
    await selectOllamaWithFile();
    await screen.findByText("Send selected text to Ollama (qwen3:4b).");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    });
    expect(await screen.findByRole("button", { name: /Review Ollama disclosure/i }))
      .toBeInTheDocument();
    expect(mockedTier2).not.toHaveBeenCalled();
    // Summarize without consent re-shows disclosure instead of generating
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize PDF/i }));
    });
    expect(
      await screen.findByText("Send selected text to Ollama (qwen3:4b)."),
    ).toBeInTheDocument();
    expect(mockedTier2).not.toHaveBeenCalled();
  });

  it("49. provider status shown correctly for unavailable and model-missing", async () => {
    mockedAvailability.mockResolvedValue({ status: "unavailable" } as never);
    render(<SummarizePdfCard />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Ollama \(qwen3:4b/i));
    });
    expect(await screen.findByText(/Ollama is unavailable/i)).toBeInTheDocument();

    cleanup();
    mockedAvailability.mockResolvedValue({ status: "model-unavailable" } as never);
    render(<SummarizePdfCard />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Ollama \(qwen3:4b/i));
    });
    expect(await screen.findByText(/model missing/i)).toBeInTheDocument();
  });

  it("50. truncation state shown correctly", async () => {
    mockedTier2.mockResolvedValue({ ...groundedResult(), evidenceTruncated: true } as never);
    await selectOllamaWithFile();
    await screen.findByText("Send selected text to Ollama (qwen3:4b).");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Send selected text to Ollama (qwen3:4b)" }),
      );
    });
    expect(await screen.findByText(/only part of the document was used/i)).toBeInTheDocument();
  });

  it("51. grounded evidence shown separately from the model restatement", async () => {
    await selectOllamaWithFile();
    await screen.findByText("Send selected text to Ollama (qwen3:4b).");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Send selected text to Ollama (qwen3:4b)" }),
      );
    });
    expect(await screen.findByText("Summary points")).toBeInTheDocument();
    expect(screen.getByText("Source evidence")).toBeInTheDocument();
    expect(screen.getByText("Point one.")).toBeInTheDocument();
    expect(screen.getByText(/exact bytes here/)).toBeInTheDocument();
    expect(await screen.findByText(/Tier-2 Ollama/i)).toBeInTheDocument();
  });

  it("Tier-2 limited state shows no fabricated summary", async () => {
    mockedTier2.mockResolvedValue({
      status: "limited",
      reason: "no-valid-claims",
      claims: [],
      providerId: "ollama",
      runtime: "ollama",
      sourcePageCount: 1,
      pagesWithoutText: [],
      contextTruncated: false,
      evidenceAdmitted: 2,
      evidenceTruncated: false,
      rejectedClaims: 1,
      failedChunks: [],
    } as never);
    await selectOllamaWithFile();
    await screen.findByText("Send selected text to Ollama (qwen3:4b).");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Send selected text to Ollama (qwen3:4b)" }),
      );
    });
    expect(await screen.findByText(/Limited result/i)).toBeInTheDocument();
    expect(screen.queryByText("Source evidence")).not.toBeInTheDocument();
  });

  it("Tier-2 service errors map to user messages", async () => {
    mockedTier2.mockRejectedValue(new Tier2ServiceError("service-unavailable", "down"));
    await selectOllamaWithFile();
    await screen.findByText("Send selected text to Ollama (qwen3:4b).");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Send selected text to Ollama (qwen3:4b)" }),
      );
    });
    expect(await screen.findByText(/Ollama is not reachable/i)).toBeInTheDocument();
  });
});

describe("SummarizePdfCard Tier-2 grounding (E02)", () => {
  function groundedFixture() {
    return {
      status: "grounded",
      claims: [
        {
          kind: "fact",
          text: "Restated point one.",
          evidenceIds: ["chunk-1-e0", "chunk-0-e0", "chunk-1-e0"],
          evidence: [
            {
              item: {
                evidenceId: "chunk-1-e0",
                chunkIndex: 1,
                sourcePages: [2],
                exactText: "store bytes alpha",
                kind: "span",
              },
              chunk: {
                chunkIndex: 1,
                pageNumber: 2,
                text: "unrelated raw chunk text alpha",
                startOffset: 0,
                endOffset: 29,
              },
            },
            {
              item: {
                evidenceId: "chunk-0-e0",
                chunkIndex: 0,
                sourcePages: [1],
                exactText: "store bytes beta",
                kind: "span",
              },
              chunk: {
                chunkIndex: 0,
                pageNumber: 1,
                text: "unrelated raw chunk text beta",
                startOffset: 0,
                endOffset: 28,
              },
            },
            {
              item: {
                evidenceId: "chunk-1-e0",
                chunkIndex: 1,
                sourcePages: [2],
                exactText: "store bytes alpha",
                kind: "span",
              },
              chunk: {
                chunkIndex: 1,
                pageNumber: 2,
                text: "unrelated raw chunk text alpha",
                startOffset: 0,
                endOffset: 29,
              },
            },
          ],
        },
      ],
      providerId: "ollama",
      runtime: "ollama",
      sourcePageCount: 2,
      pagesWithoutText: [2],
      contextTruncated: false,
      evidenceAdmitted: 3,
      evidenceTruncated: false,
      rejectedClaims: 2,
      failedChunks: [1],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockedAvailability.mockResolvedValue({ status: "available" } as never);
  });

  async function approveOllamaFlow(name = "test.pdf") {
    render(<SummarizePdfCard />);
    const file = new File(["%PDF-1.4 fake"], name, { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [file] },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Ollama \(qwen3:4b/i));
    });
    await screen.findByText("Send selected text to Ollama (qwen3:4b).");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Send selected text to Ollama (qwen3:4b)" }),
      );
    });
  }

  it("restatement and source evidence render as separate labeled sections", async () => {
    mockedTier2.mockResolvedValue(groundedFixture() as never);
    await approveOllamaFlow();
    expect(await screen.findByRole("heading", { name: "Summary points" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Source evidence" })).toBeInTheDocument();
    expect(screen.getByText("Restated point one.")).toBeInTheDocument();
  });

  it("displayed evidence equals store exactText, never claim text or raw chunks", async () => {
    mockedTier2.mockResolvedValue(groundedFixture() as never);
    await approveOllamaFlow();
    await screen.findByRole("heading", { name: "Source evidence" });
    expect(screen.getAllByText(/store bytes alpha/)).toHaveLength(2);
    expect(screen.getByText(/store bytes beta/)).toBeInTheDocument();
    expect(screen.queryByText(/unrelated raw chunk text/)).not.toBeInTheDocument();
  });

  it("source pages come from the EvidenceItem", async () => {
    mockedTier2.mockResolvedValue(groundedFixture() as never);
    await approveOllamaFlow();
    await screen.findByRole("heading", { name: "Source evidence" });
    expect(screen.getAllByText(/\(p\. 2\)/)).toHaveLength(2);
    expect(screen.getByText(/\(p\. 1\)/)).toBeInTheDocument();
  });

  it("duplicate references and evidence order are preserved deterministically", async () => {
    mockedTier2.mockResolvedValue(groundedFixture() as never);
    await approveOllamaFlow();
    await screen.findByRole("heading", { name: "Source evidence" });
    const ids = screen.getAllByText(/\[chunk-[01]-e0\]/).map((el) => el.textContent);
    expect(ids).toEqual(["[chunk-1-e0]", "[chunk-0-e0]", "[chunk-1-e0]"]);
  });

  it("model-authored excerpt/pages fields cannot enter the display path", async () => {
    const fixture = groundedFixture() as unknown as Record<string, unknown>;
    const claim = (fixture["claims"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    claim["excerpt"] = "malicious model excerpt";
    claim["pages"] = [99];
    mockedTier2.mockResolvedValue(fixture as never);
    await approveOllamaFlow();
    await screen.findByRole("heading", { name: "Source evidence" });
    expect(screen.queryByText(/malicious model excerpt/)).not.toBeInTheDocument();
    expect(screen.queryByText(/99/)).not.toBeInTheDocument();
  });

  it("rejected-claim, failed-chunk, and pages-without-text notices stay accurate", async () => {
    mockedTier2.mockResolvedValue(groundedFixture() as never);
    await approveOllamaFlow();
    await screen.findByRole("heading", { name: "Source evidence" });
    expect(screen.getByText(/2 model claims were rejected/i)).toBeInTheDocument();
    expect(screen.getByText(/1 document section could not/i)).toBeInTheDocument();
    expect(screen.getByText(/Pages without extractable text: 2/i)).toBeInTheDocument();
  });

  it("provider controls stay keyboard accessible with semantic status messaging", async () => {
    render(<SummarizePdfCard />);
    const browserRadio = screen.getByLabelText(/Browser AI \(on-device\)/i) as HTMLInputElement;
    const ollamaRadio = screen.getByLabelText(/Ollama \(qwen3:4b/i) as HTMLInputElement;
    expect(browserRadio.disabled).toBe(false);
    expect(ollamaRadio.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(ollamaRadio);
    });
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });
});

describe("SummarizePdfCard Tier-2 errors and fallback (E03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockedAvailability.mockResolvedValue({ status: "available" } as never);
  });

  async function startOllamaWithFile(name = "test.pdf") {
    render(<SummarizePdfCard />);
    const file = new File(["%PDF-1.4 fake"], name, { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [file] },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Ollama \(qwen3:4b/i));
    });
    await screen.findByText("Send selected text to Ollama (qwen3:4b).");
  }

  async function approveDisclosure() {
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Send selected text to Ollama (qwen3:4b)" }),
      );
    });
  }

  it("malformed Stage-2 output shows the format-failure limited state", async () => {
    mockedTier2.mockResolvedValue({
      status: "limited",
      reason: "malformed-output",
      claims: [],
      providerId: "ollama",
      runtime: "ollama",
      sourcePageCount: 1,
      pagesWithoutText: [],
      contextTruncated: false,
      evidenceAdmitted: 2,
      evidenceTruncated: false,
      rejectedClaims: 0,
      failedChunks: [],
    } as never);
    await startOllamaWithFile();
    await approveDisclosure();
    expect(await screen.findByText(/unusable response format/i)).toBeInTheDocument();
    expect(screen.queryByText("Source evidence")).not.toBeInTheDocument();
  });

  it("unsupported capability maps to an explicit unsupported message", async () => {
    mockedTier2.mockRejectedValue(new Tier2ServiceError("unsupported-capability", "nope"));
    await startOllamaWithFile();
    await approveDisclosure();
    expect(await screen.findByText(/not supported by the Tier-2 Ollama path/i)).toBeInTheDocument();
  });

  it("consent denial leaves an understandable blocked state without generating", async () => {
    await startOllamaWithFile();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    });
    expect(
      await screen.findByText(/Approval is still required before Ollama can summarize/i),
    ).toBeInTheDocument();
    expect(mockedTier2).not.toHaveBeenCalled();
  });

  it("reset clears a Tier-2 error and stale result state", async () => {
    mockedTier2.mockRejectedValueOnce(new Tier2ServiceError("service-unavailable", "down"));
    await startOllamaWithFile();
    await approveDisclosure();
    expect(await screen.findByText(/Ollama is not reachable/i)).toBeInTheDocument();
    mockedTier2.mockResolvedValue({
      status: "limited",
      reason: "no-evidence",
      claims: [],
      providerId: "ollama",
      runtime: "ollama",
      sourcePageCount: 1,
      pagesWithoutText: [],
      contextTruncated: false,
      evidenceAdmitted: 0,
      evidenceTruncated: false,
      rejectedClaims: 0,
      failedChunks: [0],
    } as never);
    await act(async () => {
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(["%PDF-1.4 fake"], "second.pdf", { type: "application/pdf" })] },
      });
    });
    expect(screen.queryByText(/Ollama is not reachable/i)).not.toBeInTheDocument();
    expect(screen.getByText("second.pdf")).toBeInTheDocument();
  });

  it("error text never carries provider internals or absolute privacy claims", async () => {
    mockedTier2.mockRejectedValue(new Tier2ServiceError("generation-failed", "boom"));
    await startOllamaWithFile();
    await approveDisclosure();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/Tier2ServiceError|OllamaRuntime|stack/i);
    expect(alert.textContent).not.toMatch(/100% private|fully offline|never leaves/i);
  });
});
