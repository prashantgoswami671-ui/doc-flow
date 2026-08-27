// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ResultCard, { formatFileSize } from "./ResultCard";

/**
 * Focused contract tests for ResultCard's truthfulness rules around the
 * compression result — these back the Phase 3 requirement that a result
 * screen must never claim a reduction that didn't happen. Also covers
 * formatFileSize, the single formatter every size stat in the Compress
 * PDF flow reads from.
 */

const baseProps = {
  fileName: "report.pdf",
  pageCount: 5,
  originalSize: 2_000_000,
  processingTime: 1234,
  mode: "light",
  onDownload: () => {},
  onCompressAnother: () => {},
};

afterEach(() => {
  cleanup();
});

describe("formatFileSize", () => {
  it("formats bytes under 1KB as B", () => {
    expect(formatFileSize(512)).toBe("512 B");
  });

  it("formats sizes under 1MB as KB", () => {
    expect(formatFileSize(2048)).toBe("2.00 KB");
  });

  it("formats sizes at or above 1MB as MB", () => {
    expect(formatFileSize(1024 * 1024 * 3.5)).toBe("3.50 MB");
  });
});

describe("ResultCard reduction messaging", () => {
  it("labels a real reduction as positive", () => {
    render(<ResultCard {...baseProps} processedSize={1_000_000} reduction={50} />);
    expect(screen.getByText(/reduced by/i)).toBeInTheDocument();
    expect(screen.getByText("50.0%")).toBeInTheDocument();
  });

  it("labels a size increase honestly instead of hiding it", () => {
    render(<ResultCard {...baseProps} processedSize={2_500_000} reduction={-25} />);
    expect(screen.getByText(/size increased by/i)).toBeInTheDocument();
    expect(screen.getByText("25.0%")).toBeInTheDocument();
  });

  it("does not claim a reduction for a negligible size change", () => {
    render(<ResultCard {...baseProps} processedSize={1_995_000} reduction={0.25} />);
    expect(screen.getByText("Not significantly reduced")).toBeInTheDocument();
  });

  it("shows a target-missed note when custom mode overshoots the target", () => {
    render(
      <ResultCard
        {...baseProps}
        mode="custom"
        targetSizeMb={1}
        processedSize={1_500_000}
        reduction={25}
      />,
    );
    expect(screen.getByText(/couldn.t be reached/i)).toBeInTheDocument();
  });

  it("does not show a target-missed note when the target was met", () => {
    render(
      <ResultCard
        {...baseProps}
        mode="custom"
        targetSizeMb={2}
        processedSize={1_500_000}
        reduction={25}
      />,
    );
    expect(screen.queryByText(/couldn.t be reached/i)).not.toBeInTheDocument();
  });

  it("does not show a target row or note for non-custom modes even if targetSizeMb is set", () => {
    render(
      <ResultCard
        {...baseProps}
        mode="light"
        targetSizeMb={1}
        processedSize={1_500_000}
        reduction={25}
      />,
    );
    expect(screen.queryByText("🎯 Target Size")).not.toBeInTheDocument();
  });
});

describe("ResultCard actions", () => {
  it("calls onDownload and onCompressAnother from their respective buttons", () => {
    const onDownload = vi.fn();
    const onCompressAnother = vi.fn();
    render(
      <ResultCard
        {...baseProps}
        processedSize={1_000_000}
        reduction={50}
        onDownload={onDownload}
        onCompressAnother={onCompressAnother}
      />,
    );

    screen.getByRole("button", { name: /download pdf again/i }).click();
    screen.getByRole("button", { name: /compress another pdf/i }).click();

    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onCompressAnother).toHaveBeenCalledTimes(1);
  });
});
