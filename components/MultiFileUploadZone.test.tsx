// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import MultiFileUploadZone from "./MultiFileUploadZone";

/**
 * Focused contract tests for MultiFileUploadZone — the multi-file sibling
 * used by Merge PDF and Image→PDF. Same guarantee as UploadZone but for a
 * FileList of N files: onFilesSelect only fires with a non-empty FileList,
 * and never fires at all while disabled.
 */

function makeFileList(names: string[]): FileList {
  // jsdom does not implement DataTransfer; build a minimal FileList mock that
  // satisfies the component contract (.length, numeric index, .item(), iterable).
  const files = names.map(
    (name) => new File(["content"], name, { type: "application/pdf" }),
  );
  const fileList = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    ...Object.fromEntries(files.map((file, index) => [index, file] as const)),
    [Symbol.iterator]: () => files[Symbol.iterator](),
  } as unknown as FileList;
  return fileList;
}

afterEach(() => {
  cleanup();
});

describe("MultiFileUploadZone", () => {
  it("calls onFilesSelect with every selected file when the input changes", () => {
    const onFilesSelect = vi.fn();
    render(<MultiFileUploadZone onFilesSelect={onFilesSelect} title="Upload" />);

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const files = makeFileList(["a.pdf", "b.pdf"]);
    fireEvent.change(input, { target: { files } });

    expect(onFilesSelect).toHaveBeenCalledTimes(1);
    const received = onFilesSelect.mock.calls[0][0] as FileList;
    expect(received).toHaveLength(2);
    expect(received[0].name).toBe("a.pdf");
    expect(received[1].name).toBe("b.pdf");
  });

  it("calls onFilesSelect with every dropped file when enabled", () => {
    const onFilesSelect = vi.fn();
    render(<MultiFileUploadZone onFilesSelect={onFilesSelect} title="Upload" />);

    const dropzone = screen.getByRole("button");
    const files = makeFileList(["x.pdf", "y.pdf", "z.pdf"]);
    fireEvent.drop(dropzone, { dataTransfer: { files } });

    expect(onFilesSelect).toHaveBeenCalledTimes(1);
    expect(onFilesSelect.mock.calls[0][0]).toHaveLength(3);
  });

  it("does not call onFilesSelect on drop when disabled", () => {
    const onFilesSelect = vi.fn();
    render(<MultiFileUploadZone onFilesSelect={onFilesSelect} title="Upload" disabled />);

    fireEvent.drop(screen.getByRole("button"), {
      dataTransfer: { files: makeFileList(["a.pdf"]) },
    });

    expect(onFilesSelect).not.toHaveBeenCalled();
  });

  it("does not open the file picker via click when disabled", () => {
    const onFilesSelect = vi.fn();
    render(<MultiFileUploadZone onFilesSelect={onFilesSelect} title="Upload" disabled />);

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button"));

    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("marks the zone aria-disabled and the hidden input disabled when disabled", () => {
    const onFilesSelect = vi.fn();
    render(<MultiFileUploadZone onFilesSelect={onFilesSelect} title="Upload" disabled />);

    expect(screen.getByRole("button")).toHaveAttribute("aria-disabled", "true");
    expect(document.querySelector("input[type='file']")).toBeDisabled();
  });

  it("accepts multiple files via the hidden input's multiple attribute", () => {
    const onFilesSelect = vi.fn();
    render(<MultiFileUploadZone onFilesSelect={onFilesSelect} title="Upload" />);

    expect(document.querySelector("input[type='file']")).toHaveAttribute("multiple");
  });
});
