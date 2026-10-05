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
