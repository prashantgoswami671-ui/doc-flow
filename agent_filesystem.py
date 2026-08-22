from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent


def _safe_path(relative_path: str) -> Path:
    """Resolve a project-relative path and prevent access outside doc-flow."""
    requested = (PROJECT_ROOT / relative_path).resolve()

    try:
        requested.relative_to(PROJECT_ROOT)
    except ValueError:
        raise ValueError("Access outside the doc-flow project is not allowed.")

    return requested


def write_file(relative_path: str, content: str) -> None:
    """Write UTF-8 text to a file inside the doc-flow project."""
    file_path = _safe_path(relative_path)

    file_path.write_text(content, encoding="utf-8")


    

def list_files(relative_path: str = ".") -> list[str]:
    """List files and directories inside the specified project directory."""
    directory = _safe_path(relative_path)

    if not directory.exists():
        raise FileNotFoundError(f"Path does not exist: {relative_path}")

    if not directory.is_dir():
        raise ValueError(f"Not a directory: {relative_path}")

    return sorted(
        str(item.relative_to(PROJECT_ROOT))
        for item in directory.iterdir()
    )


def read_file(relative_path: str) -> str:
    """Read a UTF-8 text file from inside the doc-flow project."""
    file_path = _safe_path(relative_path)

    if not file_path.exists():
        raise FileNotFoundError(f"File does not exist: {relative_path}")

    if not file_path.is_file():
        raise ValueError(f"Not a file: {relative_path}")

    return file_path.read_text(encoding="utf-8")


if __name__ == "__main__":
    print("Project root:", PROJECT_ROOT)
    print("\nTop-level files:")
    for item in list_files():
        print(f"  {item}")