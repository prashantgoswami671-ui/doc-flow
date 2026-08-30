// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ToolPageShell from "./ToolPageShell";
import { getToolBySlug } from "../../lib/toolCatalog";

/**
 * SEC-05 — Shared privacy messaging shown on every /tools/{slug} page.
 *
 * Guards two things at once: (1) the intended privacy statement renders
 * for any tool rendered through the shared shell, and (2) the wording
 * stays scoped to what the client-side architecture actually supports —
 * it must not regress into an unsupported absolute claim like "100%
 * private", "never leaves your device", or "no third-party requests".
 */
describe("ToolPageShell privacy messaging", () => {
  afterEach(() => {
    cleanup();
  });

  const tool = getToolBySlug("protect-pdf");
  if (!tool) {
    throw new Error("Expected 'protect-pdf' to exist in the tool catalog.");
  }

  it("renders the scoped client-side processing statement", () => {
    render(
      <ToolPageShell tool={tool}>
        <div>tool content</div>
      </ToolPageShell>,
    );

    expect(
      screen.getByText(
        /your pdf is processed in your browser and is not uploaded to our servers/i,
      ),
    ).toBeInTheDocument();
  });

  it("does not contain unsupported absolute privacy claims", () => {
    render(
      <ToolPageShell tool={tool}>
        <div>tool content</div>
      </ToolPageShell>,
    );

    const bodyText = document.body.textContent ?? "";
    const lowerBodyText = bodyText.toLowerCase();

    expect(lowerBodyText).not.toMatch(/100% private/);
    expect(lowerBodyText).not.toMatch(/never leaves your (device|browser)/);
    expect(lowerBodyText).not.toMatch(/no third-party requests/);
    expect(lowerBodyText).not.toMatch(/zero data/);
  });
});
