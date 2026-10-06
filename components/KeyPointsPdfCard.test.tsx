// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import KeyPointsPdfCard from "./KeyPointsPdfCard";

afterEach(() => cleanup());

describe("KeyPointsPdfCard", () => {
  it("renders provider controls and keeps action disabled without a PDF", () => {
    render(<KeyPointsPdfCard />);
    expect(screen.getByRole("heading", { name: "Key Points" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Browser AI/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Ollama/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get key points" })).toBeDisabled();
  });
  it("shows no-text and caps presentation while retaining the full result", async () => {
    const spy = vi.spyOn(await import("../services/ai/keyPoints"), "generateKeyPoints").mockResolvedValue({
      status: "ready", sourcePageCount: 1, pagesWithoutText: [], truncated: false, failedChunkIndexes: [], cancelled: false,
      points: Array.from({ length: 21 }, (_, i) => ({ pointIndex: i, text: `point ${i}`, sourceChunkIndex: 0, sourcePageNumber: 1, sourceStartOffset: 0, sourceEndOffset: 1, sourceText: "x" })),
    });
    render(<KeyPointsPdfCard />);
    const input = document.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["x"], "x.pdf", { type: "application/pdf" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Get key points" }));
    expect(await screen.findByText(/Showing 20 of 21/)).toBeInTheDocument();
    expect(screen.queryByText("point 20")).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it("renders no-text without a ready title or empty copy action", async () => {
    const spy = vi.spyOn(await import("../services/ai/keyPoints"), "generateKeyPoints").mockResolvedValue({
      status: "no-text",
      sourcePageCount: 2,
      pagesWithoutText: [1, 2],
      truncated: false,
      failedChunkIndexes: [],
      cancelled: false,
      points: [],
    });
    render(<KeyPointsPdfCard />);
    const input = document.querySelector('input[type="file"]');
    if (!input) throw new Error("file input was not rendered");
    fireEvent.change(input, { target: { files: [new File(["x"], "scan.pdf", { type: "application/pdf" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Get key points" }));
    expect(await screen.findByText("No extractable text found")).toBeInTheDocument();
    expect(screen.queryByText("Key points ready")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy key points" })).not.toBeInTheDocument();
    expect(screen.getByText(/OCR is not included/i)).toBeInTheDocument();
    spy.mockRestore();
  });
});
