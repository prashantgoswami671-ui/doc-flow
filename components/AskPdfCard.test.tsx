// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import AskPdfCard from "./AskPdfCard";
import * as askPdfModule from "../services/ai/askPdf";

vi.mock("../services/ai/ollama/availability", () => ({
  getOllamaAvailability: vi.fn(async () => ({ status: "available" })),
}));

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pdfFile(name = "x.pdf") {
  return new File(["x"], name, { type: "application/pdf" });
}

function selectPdf(file = pdfFile()) {
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
}

function extractionContext() {
  return {
    chunks: [{ chunkIndex: 0, pageNumber: 1, text: "termination clause", startOffset: 0, endOffset: 17 }],
    sourcePageCount: 1, pagesWithoutText: [], truncated: false, totalCharacters: 17, processingTime: 0,
  };
}

vi.mock("../services/ai/askPdf", async () => {
  const actual = await vi.importActual<typeof import("../services/ai/askPdf")>("../services/ai/askPdf");
  return {
    ...actual,
    prepareAskPdfContext: vi.fn(async () => ({
      chunks: [{ chunkIndex: 0, pageNumber: 1, text: "termination clause", startOffset: 0, endOffset: 17 }],
      sourcePageCount: 1, pagesWithoutText: [], truncated: false, totalCharacters: 17, processingTime: 0,
    })),
    askPdf: vi.fn(async () => ({
      status: "ready", answer: { answer: "It applies.", citations: [{ sourceChunkIndex: 0, sourcePageNumber: 1, sourceStartOffset: 0, sourceEndOffset: 17, sourceQuote: "termination clause" }] },
      sourcePageCount: 1, pagesWithoutText: [], selectedChunkIndexes: [0], truncated: false,
    })),
  };
});

describe("AskPdfCard", () => {
  it("requires a PDF and question before asking", () => {
    render(<AskPdfCard />);
    expect(screen.getByRole("heading", { name: "Ask PDF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask question" })).toBeDisabled();
  });

  it("renders a validated answer with source and copy action", async () => {
    render(<AskPdfCard />);
    selectPdf();
    const question = await screen.findByLabelText("Your question");
    fireEvent.change(question, { target: { value: "What is the termination clause?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask question" }));
    expect(await screen.findByText("It applies.")).toBeInTheDocument();
    expect(screen.getByText(/termination clause/, { selector: "blockquote" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy answer" })).toBeInTheDocument();
  });

  it("renders no-text without an answer or copy action", async () => {
    const askModule = await import("../services/ai/askPdf");
    vi.mocked(askModule.askPdf).mockResolvedValueOnce({ status: "no-text", sourcePageCount: 1, pagesWithoutText: [1], selectedChunkIndexes: [], truncated: false });
    render(<AskPdfCard />);
    selectPdf(pdfFile("scan.pdf"));
    const question = await screen.findByLabelText("Your question");
    fireEvent.change(question, { target: { value: "What is shown?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask question" }));
    expect(await screen.findByText("No extractable text found")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy answer" })).not.toBeInTheDocument();
  });

  it("ignores extraction completion after unmount", async () => {
    const pending = deferred<ReturnType<typeof extractionContext>>();
    vi.mocked(askPdfModule.prepareAskPdfContext).mockReturnValueOnce(pending.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<AskPdfCard />);
    selectPdf();
    view.unmount();
    pending.resolve(extractionContext());
    await pending.promise;
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("ignores generation completion and errors after unmount", async () => {
    const pending = deferred<Awaited<ReturnType<typeof askPdfModule.askPdf>>>();
    vi.mocked(askPdfModule.askPdf).mockReturnValueOnce(pending.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<AskPdfCard />);
    selectPdf();
    const question = await screen.findByLabelText("Your question");
    fireEvent.change(question, { target: { value: "What is the termination clause?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask question" }));
    view.unmount();
    pending.resolve({
      status: "ready",
      answer: { answer: "It applies.", citations: [{ sourceChunkIndex: 0, sourcePageNumber: 1, sourceStartOffset: 0, sourceEndOffset: 17, sourceQuote: "termination clause" }] },
      sourcePageCount: 1, pagesWithoutText: [], selectedChunkIndexes: [0], truncated: false,
    });
    await pending.promise;
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();

    const rejected = deferred<Awaited<ReturnType<typeof askPdfModule.askPdf>>>();
    vi.mocked(askPdfModule.askPdf).mockReturnValueOnce(rejected.promise);
    const second = render(<AskPdfCard />);
    selectPdf();
    const secondQuestion = await screen.findByLabelText("Your question");
    fireEvent.change(secondQuestion, { target: { value: "What is the termination clause?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask question" }));
    second.unmount();
    rejected.reject(new Error("provider failed"));
    await expect(rejected.promise).rejects.toThrow("provider failed");
  });

  it("ignores Ollama availability completion and rejection after unmount", async () => {
    const availability = await import("../services/ai/ollama/availability");
    type Availability = Awaited<ReturnType<typeof availability.getOllamaAvailability>>;
    const pending = deferred<Availability>();
    vi.mocked(availability.getOllamaAvailability).mockReturnValueOnce(pending.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<AskPdfCard />);
    fireEvent.click(screen.getByLabelText(/Ollama/));
    view.unmount();
    pending.resolve({ status: "available", capabilities: {} as Availability["capabilities"] });
    await pending.promise;
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();

    const rejected = deferred<Availability>();
    vi.mocked(availability.getOllamaAvailability).mockReturnValueOnce(rejected.promise);
    const second = render(<AskPdfCard />);
    fireEvent.click(screen.getByLabelText(/Ollama/));
    second.unmount();
    rejected.reject(new Error("unavailable"));
    await expect(rejected.promise).rejects.toThrow("unavailable");
  });

  it("keeps request-ID race protection while mounted", async () => {
    const first = deferred<ReturnType<typeof extractionContext>>();
    const second = deferred<ReturnType<typeof extractionContext>>();
    vi.mocked(askPdfModule.prepareAskPdfContext)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<AskPdfCard />);
    selectPdf(pdfFile("first.pdf"));
    selectPdf(pdfFile("second.pdf"));
    await act(async () => {
      first.resolve(extractionContext());
      await first.promise;
    });
    await waitFor(() => expect(screen.getByLabelText("Your question")).toBeDisabled());
    await act(async () => {
      second.resolve(extractionContext());
      await second.promise;
    });
    await waitFor(() => expect(screen.getByLabelText("Your question")).not.toBeDisabled());
  });

  it("remains functional after Strict Mode effect replay", async () => {
    render(<StrictMode><AskPdfCard /></StrictMode>);
    selectPdf();
    const question = await screen.findByLabelText("Your question");
    fireEvent.change(question, { target: { value: "What is the termination clause?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask question" }));
    expect(await screen.findByText("It applies.")).toBeInTheDocument();
  });

  it("ignores stale Ollama availability results while keeping the latest check authoritative", async () => {
    const availability = await import("../services/ai/ollama/availability");
    type Availability = Awaited<ReturnType<typeof availability.getOllamaAvailability>>;
    const first = deferred<Availability>();
    const second = deferred<Availability>();
    vi.mocked(availability.getOllamaAvailability).mockReset();
    vi.mocked(availability.getOllamaAvailability)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<AskPdfCard />);
    fireEvent.click(screen.getByLabelText(/Ollama/));
    await waitFor(() => expect(screen.getByLabelText(/Ollama/)).toBeChecked());
    fireEvent.click(screen.getByLabelText(/Browser AI/));
    await waitFor(() => expect(screen.getByLabelText(/Browser AI/)).toBeChecked());
    fireEvent.click(screen.getByLabelText(/Ollama/));
    await waitFor(() => expect(availability.getOllamaAvailability).toHaveBeenCalledTimes(2));
    first.resolve({ status: "available", capabilities: {} as Availability["capabilities"] });
    await act(async () => { await first.promise; });
    expect(screen.getByText("Checking local Ollama service...")).toBeInTheDocument();
    second.resolve({ status: "unavailable", reasonCode: "service-unreachable", capabilities: {} as Availability["capabilities"] });
    await act(async () => { await second.promise; });
    expect(screen.getByText("Ollama is unavailable.")).toBeInTheDocument();
  });

  it("ignores stale Ollama availability rejection after a newer check succeeds", async () => {
    const availability = await import("../services/ai/ollama/availability");
    type Availability = Awaited<ReturnType<typeof availability.getOllamaAvailability>>;
    const first = deferred<Availability>();
    const second = deferred<Availability>();
    vi.mocked(availability.getOllamaAvailability).mockReset();
    vi.mocked(availability.getOllamaAvailability)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<AskPdfCard />);
    fireEvent.click(screen.getByLabelText(/Ollama/));
    await waitFor(() => expect(screen.getByLabelText(/Ollama/)).toBeChecked());
    fireEvent.click(screen.getByLabelText(/Browser AI/));
    await waitFor(() => expect(screen.getByLabelText(/Browser AI/)).toBeChecked());
    fireEvent.click(screen.getByLabelText(/Ollama/));
    await waitFor(() => expect(availability.getOllamaAvailability).toHaveBeenCalledTimes(2));
    first.reject(new Error("stale failure"));
    await expect(first.promise).rejects.toThrow("stale failure");
    second.resolve({ status: "available", capabilities: {} as Availability["capabilities"] });
    await act(async () => { await second.promise; });
    expect(screen.getByText("Ollama is available.")).toBeInTheDocument();
  });
});
