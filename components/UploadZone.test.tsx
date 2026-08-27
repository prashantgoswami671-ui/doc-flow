// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import UploadZone from "./UploadZone";

/**
 * Focused contract tests for UploadZone — the shared upload primitive
 * used by 8+ tools. These tests exist to protect the one thing every
 * consumer depends on: a file reaches `onFileSelect` on selection or
 * drop when enabled, and NOTHING reaches it when `disabled` is true.
 * Styling/layout is intentionally not asserted here.
 */

function makeFile(name = "test.pdf") {
  return new File(["content"], name, { type: "application/pdf" });
}

afterEach(() => {
  cleanup();
});

describe("UploadZone", () => {
  it("calls onFileSelect with the chosen file when the hidden input changes", () => {
    const onFileSelect = vi.fn();
    render(<UploadZone onFileSelect={onFileSelect} title="Upload" />);

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const file = makeFile();
    fireEvent.change(input, { target: { files: [file] } });

    expect(onFileSelect).toHaveBeenCalledTimes(1);
    expect(onFileSelect).toHaveBeenCalledWith(file);
  });

  it("calls onFileSelect with the dropped file when enabled", () => {
    const onFileSelect = vi.fn();
    render(<UploadZone onFileSelect={onFileSelect} title="Upload" />);

    const dropzone = screen.getByRole("button");
    const file = makeFile("dropped.pdf");
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });

    expect(onFileSelect).toHaveBeenCalledTimes(1);
    expect(onFileSelect).toHaveBeenCalledWith(file);
  });

  it("does not call onFileSelect on drop when disabled", () => {
    const onFileSelect = vi.fn();
    render(<UploadZone onFileSelect={onFileSelect} title="Upload" disabled />);

    const dropzone = screen.getByRole("button");
    fireEvent.drop(dropzone, { dataTransfer: { files: [makeFile()] } });

    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it("does not open the file picker via click when disabled", () => {
    const onFileSelect = vi.fn();
    render(<UploadZone onFileSelect={onFileSelect} title="Upload" disabled />);

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button"));

    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("opens the file picker via click when enabled", () => {
    const onFileSelect = vi.fn();
    render(<UploadZone onFileSelect={onFileSelect} title="Upload" />);

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button"));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("opens the file picker on Enter and Space, and ignores other keys", () => {
    const onFileSelect = vi.fn();
    render(<UploadZone onFileSelect={onFileSelect} title="Upload" />);

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    const dropzone = screen.getByRole("button");

    fireEvent.keyDown(dropzone, { key: "Enter" });
    fireEvent.keyDown(dropzone, { key: " " });
    fireEvent.keyDown(dropzone, { key: "a" });

    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it("marks the zone aria-disabled and disables the hidden input when disabled", () => {
    const onFileSelect = vi.fn();
    render(<UploadZone onFileSelect={onFileSelect} title="Upload" disabled />);

    expect(screen.getByRole("button")).toHaveAttribute("aria-disabled", "true");
    expect(document.querySelector("input[type='file']")).toBeDisabled();
  });

  it("forwards the accept prop to the hidden input", () => {
    const onFileSelect = vi.fn();
    render(
      <UploadZone onFileSelect={onFileSelect} title="Upload" accept="application/pdf" />,
    );

    expect(document.querySelector("input[type='file']")).toHaveAttribute(
      "accept",
      "application/pdf",
    );
  });
});
