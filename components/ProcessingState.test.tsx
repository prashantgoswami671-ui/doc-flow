// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ProcessingState from "./ProcessingState";

/**
 * Focused contract tests for ProcessingState's label-precedence rule,
 * which every processing/result screen in DocFlow relies on:
 * stage.label > message > nothing, and children only render when not
 * processing.
 */

afterEach(() => {
  cleanup();
});

describe("ProcessingState", () => {
  it("renders children when not processing", () => {
    render(
      <ProcessingState isProcessing={false}>
        <span>done content</span>
      </ProcessingState>,
    );

    expect(screen.getByText("done content")).toBeInTheDocument();
  });

  it("renders nothing when not processing and no children given", () => {
    const { container } = render(<ProcessingState isProcessing={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("prefers stage.label over message while processing", () => {
    render(
      <ProcessingState
        isProcessing
        message="generic message"
        stage={{ id: "s1", label: "Rasterizing pages" }}
      />,
    );

    expect(screen.getByText("Rasterizing pages")).toBeInTheDocument();
    expect(screen.queryByText("generic message")).not.toBeInTheDocument();
  });

  it("falls back to message when no stage is given", () => {
    render(<ProcessingState isProcessing message="Compressing..." />);
    expect(screen.getByText("Compressing...")).toBeInTheDocument();
  });

  it("renders nothing while processing with neither stage nor message", () => {
    const { container } = render(<ProcessingState isProcessing />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not render children while processing, even if provided", () => {
    render(
      <ProcessingState isProcessing message="Working">
        <span>done content</span>
      </ProcessingState>,
    );

    expect(screen.queryByText("done content")).not.toBeInTheDocument();
  });
});
