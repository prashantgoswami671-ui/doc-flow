// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TranslatePdfCard from "./TranslatePdfCard";
import {
  SUPPORTED_TRANSLATION_LANGUAGES,
} from "../services/ai/translation";

describe("TranslatePdfCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the complete supported target-language allowlist", () => {
    render(<TranslatePdfCard />);

    expect(screen.getByRole("heading", { name: "Translate PDF" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Target language" }).querySelectorAll("option")).toHaveLength(
      SUPPORTED_TRANSLATION_LANGUAGES.length,
    );
    expect(screen.getByRole("option", { name: "English" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Korean" })).toBeInTheDocument();
  });

  it("keeps translation disabled until a PDF is selected", () => {
    render(<TranslatePdfCard />);

    expect(screen.getByRole("button", { name: "Translate PDF" })).toBeDisabled();
  });

  it("does not present an image-only result as ready or offer empty copy", async () => {
    const translateSpy = vi.spyOn(
      await import("../services/ai/translation"),
      "translatePdf",
    ).mockResolvedValue({
      status: "no-text",
      targetLanguage: "English",
      chunks: [],
      sourcePageCount: 2,
      pagesWithoutText: [1, 2],
      truncated: false,
      failedChunkIndexes: [],
      cancelled: false,
    });

    render(<TranslatePdfCard />);
    const input = document.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    if (!input) throw new Error("file input was not rendered");
    fireEvent.change(input, {
      target: { files: [new File(["pdf"], "scan.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Translate PDF" }));

    expect(await screen.findByText("No extractable text found")).toBeInTheDocument();
    expect(screen.queryByText("Translation ready")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy translated text" })).not.toBeInTheDocument();
    expect(screen.getByText(/image-only or contains no extractable text/i)).toBeInTheDocument();
    await waitFor(() => expect(translateSpy).toHaveBeenCalled());
    translateSpy.mockRestore();
  });
});
