// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ResultPanel from "./ResultPanel";

/**
 * Focused contract tests for ResultPanel — the shared "operation
 * complete" panel every tool's result screen renders. Covers the two
 * things consumers actually depend on: the accessibility contract
 * (status role + live region, always present) and that the
 * download/reset actions are opt-in — present only when a callback is
 * given, and wired to that exact callback.
 */

afterEach(() => {
  cleanup();
});

describe("ResultPanel", () => {
  it("always exposes an aria-live status region", () => {
    render(<ResultPanel title="Done" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
  });

  it("renders the title and optional message", () => {
    render(<ResultPanel title="Protection complete" message="Your file is ready" />);
    expect(screen.getByText("Protection complete")).toBeInTheDocument();
    expect(screen.getByText("Your file is ready")).toBeInTheDocument();
  });

  it("renders all provided stats as label/value pairs", () => {
    render(
      <ResultPanel
        title="Done"
        stats={[
          { label: "Pages", value: 12 },
          { label: "Size", value: "1.2 MB" },
        ]}
      />,
    );

    expect(screen.getByText("Pages")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
    expect(screen.getByText("1.2 MB")).toBeInTheDocument();
  });

  it("does not render a download button when onDownload is omitted", () => {
    render(<ResultPanel title="Done" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders a download button that calls onDownload when clicked", () => {
    const onDownload = vi.fn();
    render(<ResultPanel title="Done" onDownload={onDownload} downloadLabel="Save PDF" />);

    const button = screen.getByRole("button", { name: "Save PDF" });
    button.click();
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("does not render a reset button when onReset is omitted", () => {
    const onDownload = vi.fn();
    render(<ResultPanel title="Done" onDownload={onDownload} />);
    expect(screen.queryByRole("button", { name: /start over/i })).not.toBeInTheDocument();
  });

  it("renders a reset button that calls onReset when clicked, with a default label", () => {
    const onReset = vi.fn();
    render(<ResultPanel title="Done" onReset={onReset} />);

    const button = screen.getByRole("button", { name: "Start over" });
    button.click();
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
