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

import { runAiActionOnPdf } from "../services/ai/orchestration";
import { BrowserAiRuntime } from "../services/ai/browser/browserAiRuntime";

const mockedRun = vi.mocked(runAiActionOnPdf);

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
