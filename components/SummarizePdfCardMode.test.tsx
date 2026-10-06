// @vitest-environment jsdom
/**
 * V8-A08 — UI/state tests for detail-mode switching.
 *
 * Verifies the minimal SummarizePdfCard switcher projects the
 * ALREADY-produced grounded result locally: mode switch changes the
 * displayed projection without restarting acquisition (A → B → C
 * adds no new acquisition calls).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import SummarizePdfCard from "./SummarizePdfCard";

vi.mock("../services/ai/orchestration", async () => {
  const actual = await vi.importActual<typeof import("../services/ai/orchestration")>(
    "../services/ai/orchestration",
  );
  return { ...actual, runAiActionOnPdf: vi.fn() };
});

vi.mock("../services/ai/tier2Summarize", () => {
  class MockTier2ServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "Tier2ServiceError";
      this.code = code;
    }
  }
  return { Tier2ServiceError: MockTier2ServiceError, runTier2ValidatedSummarize: vi.fn() };
});

vi.mock("../services/ai/ollama/availability", async () => {
  const actual = await vi.importActual<typeof import("../services/ai/ollama/availability")>(
    "../services/ai/ollama/availability",
  );
  return { ...actual, getOllamaAvailability: vi.fn() };
});

import { getOllamaAvailability } from "../services/ai/ollama/availability";
import { runTier2ValidatedSummarize } from "../services/ai/tier2Summarize";

const mockedAvailability = vi.mocked(getOllamaAvailability);
const mockedTier2 = vi.mocked(runTier2ValidatedSummarize);

function claim(text: string, page: number, evidenceId: string, chunkIndex: number) {
  return {
    kind: "fact",
    text,
    evidenceIds: [evidenceId],
    evidence: [
      {
        item: {
          evidenceId,
          chunkIndex,
          sourcePages: [page],
          exactText: `exact bytes ${evidenceId}`,
          kind: "span",
        },
        chunk: {
          chunkIndex,
          pageNumber: page,
          text: `chunk text carrying exact bytes ${evidenceId} plus context`,
          startOffset: 0,
          endOffset: 60,
        },
      },
    ],
  };
}

function fiveClaimResult() {
  return {
    status: "grounded",
    claims: [
      claim("The council approved the annual budget for road maintenance.", 1, "chunk-0-e0", 0),
      claim("Quantum kitchens zebra alpha unrelated distinct wording entirely.", 1, "chunk-0-e1", 0),
      claim("Engineers reported bridge inspection findings with load ratings.", 2, "chunk-1-e0", 1),
      claim("Engineers reported bridge inspection findings with load ratings updated.", 2, "chunk-1-e1", 1),
      claim("The transit authority opened two new park and ride facilities downtown.", 3, "chunk-2-e0", 2),
    ],
    providerId: "ollama",
    runtime: "ollama",
    sourcePageCount: 3,
    pagesWithoutText: [],
    contextTruncated: false,
    evidenceAdmitted: 5,
    evidenceTruncated: false,
    rejectedClaims: 0,
    failedChunks: [],
    sectionCount: 3,
    failedSections: [],
    groundedPages: [1, 2, 3],
  };
}

describe("SummarizePdfCard detail modes (V8-A08)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockedAvailability.mockResolvedValue({ status: "available" } as never);
    mockedTier2.mockResolvedValue(fiveClaimResult() as never);
  });

  async function approveOllamaFlow() {
    render(<SummarizePdfCard />);
    const file = new File(["%PDF-1.4 fake"], "test.pdf", { type: "application/pdf" });
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
    await screen.findByRole("radiogroup", { name: /Summary detail level/i });
  }

  it("exposes Concise, Detailed, and Very Detailed without reacquisition", async () => {
    await approveOllamaFlow();
    expect(screen.getByRole("radio", { name: "Concise" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Detailed" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Very Detailed" })).toBeInTheDocument();
    expect(mockedTier2).toHaveBeenCalledTimes(1);
  });

  it("mode switch changes the displayed projection", async () => {
    await approveOllamaFlow();
    // Default mode is Detailed: near-duplicate suppressed (4 of 5).
    expect(screen.getByText(/4 of 5 points/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Concise" }));
    });
    expect(screen.getByText(/3 of 5 points/i)).toBeInTheDocument();
    // Concise keeps one representative per page: exactly one of the two
    // page-1 claims survives (never both, never zero).
    const page1 = [
      screen.queryByText(/council approved the annual budget/i),
      screen.queryByText(/Quantum kitchens zebra/i),
    ].filter(Boolean);
    expect(page1).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Very Detailed" }));
    });
    expect(screen.getByText(/5 of 5 points/i)).toBeInTheDocument();
    expect(screen.getByText(/Quantum kitchens zebra/i)).toBeInTheDocument();
  });

  it("switching A → B → C adds no new acquisition calls and preserves provenance", async () => {
    await approveOllamaFlow();
    expect(mockedTier2).toHaveBeenCalledTimes(1);
    for (const name of ["Concise", "Very Detailed", "Detailed"] as const) {
      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name }));
      });
      expect(mockedTier2).toHaveBeenCalledTimes(1);
    }
    // Displayed evidence still carries original root IDs, never page-only refs.
    expect(screen.getAllByText(/\[chunk-0-e0\]/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\[p\. 1\]/)).not.toBeInTheDocument();
  });
});

describe("SummarizePdfCard pre-run detail-mode selection (post-V8 UX-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockedAvailability.mockResolvedValue({ status: "available" } as never);
    mockedTier2.mockResolvedValue(fiveClaimResult() as never);
  });

  async function selectFileThenOllama(name = "test.pdf") {
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
    await screen.findByRole("radiogroup", { name: /Summary detail level/i });
    return file;
  }

  async function approveDisclosure() {
    await screen.findByText("Send selected text to Ollama (qwen3:4b).");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Send selected text to Ollama (qwen3:4b)" }),
      );
    });
  }

  it("modes are Tier-2-only: no selector on the Browser path", async () => {
    render(<SummarizePdfCard />);
    await act(async () => {
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(["%PDF-1.4 fake"], "test.pdf", { type: "application/pdf" })] },
      });
    });
    await screen.findByText("test.pdf");
    expect(screen.queryByRole("radiogroup", { name: /Summary detail level/i })).not.toBeInTheDocument();
  });

  it("default mode is Detailed and all three modes are pre-selectable with zero acquisition", async () => {
    await selectFileThenOllama();
    expect(screen.getByRole("radio", { name: "Detailed" })).toHaveAttribute("aria-checked", "true");
    for (const name of ["Concise", "Very Detailed", "Detailed"] as const) {
      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name }));
      });
      expect(screen.getByRole("radio", { name })).toHaveAttribute("aria-checked", "true");
      expect(mockedTier2).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["Concise", "3 of 5 points"],
    ["Detailed", "4 of 5 points"],
    ["Very Detailed", "5 of 5 points"],
  ] as const)("pre-selected %s becomes the initial displayed projection", async (mode, count) => {
    await selectFileThenOllama();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: mode }));
    });
    await approveDisclosure();
    expect(await screen.findByText(new RegExp(count, "i"))).toBeInTheDocument();
    expect(mockedTier2).toHaveBeenCalledTimes(1);
  });

  it("pre-run mode selection does not alter the summarization invocation", async () => {
    const file = await selectFileThenOllama();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Very Detailed" }));
    });
    await approveDisclosure();
    await screen.findByText(/5 of 5 points/i);
    expect(mockedTier2).toHaveBeenCalledTimes(1);
    const args = mockedTier2.mock.calls[0][0] as Record<string, unknown>;
    expect(args.file).toBe(file);
    expect("mode" in args).toBe(false);
    expect("detailMode" in args).toBe(false);
    expect("detail" in args).toBe(false);
  });

  it("mode control is frozen while a run is active (exactly one acquisition)", async () => {
    let release!: (value: unknown) => void;
    mockedTier2.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve as (value: unknown) => void)),
    );
    await selectFileThenOllama();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Concise" }));
    });
    await approveDisclosure();
    expect(screen.getByRole("radio", { name: "Concise" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Detailed" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Very Detailed" })).toBeDisabled();
    await act(async () => {
      release(fiveClaimResult());
    });
    expect(await screen.findByText(/3 of 5 points/i)).toBeInTheDocument();
    expect(mockedTier2).toHaveBeenCalledTimes(1);
  });

  it("file reset returns the selector to Detailed", async () => {
    await selectFileThenOllama();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Concise" }));
    });
    await approveDisclosure();
    await screen.findByText(/3 of 5 points/i);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Summarize another PDF/i }));
    });
    await act(async () => {
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(["%PDF-1.4 fake"], "second.pdf", { type: "application/pdf" })] },
      });
    });
    await screen.findByText("second.pdf");
    expect(screen.getByRole("radio", { name: "Detailed" })).toHaveAttribute("aria-checked", "true");
  });

  it("provider switch returns the selector to Detailed", async () => {
    await selectFileThenOllama();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Very Detailed" }));
    });
    expect(screen.getByRole("radio", { name: "Very Detailed" })).toHaveAttribute("aria-checked", "true");
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Browser AI \(on-device\)/i));
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Ollama \(qwen3:4b/i));
    });
    await screen.findByRole("radiogroup", { name: /Summary detail level/i });
    expect(screen.getByRole("radio", { name: "Detailed" })).toHaveAttribute("aria-checked", "true");
  });
});
