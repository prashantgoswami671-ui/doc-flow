import difflib
import json

from ai_assistant import AIAssistant
from agent_filesystem import read_file, write_file


class CodingAgent:
    """Approval-based, repository-aware coding agent for DocFlow."""

    def __init__(self):
        self.ai = AIAssistant()

    def inspect_files(self, files: list[str]) -> str:
        """Read selected project files."""

        file_contents = []

        for file_path in files:
            try:
                content = read_file(file_path)
                file_contents.append(
                    f"\n===== {file_path} =====\n"
                    f"{content}\n"
                    f"===== END {file_path} =====\n"
                )
            except Exception as error:
                file_contents.append(
                    f"\n===== {file_path} =====\n"
                    f"ERROR READING FILE: {error}\n"
                    f"===== END {file_path} =====\n"
                )

        return "\n".join(file_contents)

    def propose_changes(self, task: str, files: list[str]) -> dict:
        """Ask Nemotron to propose exact file contents without modifying files."""

        project_context = self.inspect_files(files)

        prompt = f"""
You are an approval-based coding agent working on the DocFlow project.

TASK:
{task}

You have been given the ACTUAL contents of these files:

{project_context}

Your job is to propose the smallest possible code changes.

IMPORTANT:
- Do NOT invent files or code that you have not seen.
- Do NOT assume missing information.
- Do NOT modify any files.
- Only propose changes required to accomplish the task.
- Keep the change as small and focused as possible.
- Preserve existing behavior unless the task explicitly requires a behavior change.
- Do not propose unrelated cleanup or refactoring.
- For every file you modify, return the COMPLETE proposed file contents.
- The "content" field must contain the entire replacement file.
- Do not use placeholders such as "...", "existing code", or "rest of file".
- Do not return Markdown code fences.
- If no changes are required, return an empty "changes" array.

Return ONLY valid JSON in this exact structure:

{{
  "summary": "short description",
  "changes": [
    {{
      "file": "relative/path/to/file",
      "action": "modify",
      "reason": "why this file needs changing",
      "content": "COMPLETE proposed file contents"
    }}
  ],
  "risks": [
    "possible risk"
  ],
  "verification": [
    "command or test to run"
  ]
}}
"""

        response = self.ai.ask(prompt, temperature=0.2)

        try:
            return json.loads(response)
        except json.JSONDecodeError:
            return {
                "summary": "Nemotron returned a non-JSON proposal.",
                "raw_response": response,
            }

    def show_diff(self, file_path: str, proposed_content: str) -> None:
        """Display the proposed change as a unified diff."""

        current_content = read_file(file_path)

        diff = difflib.unified_diff(
            current_content.splitlines(keepends=True),
            proposed_content.splitlines(keepends=True),
            fromfile=f"{file_path} (current)",
            tofile=f"{file_path} (proposed)",
        )

        diff_text = "".join(diff)

        if not diff_text:
            print(f"\nNo actual content change detected for {file_path}.")
            return

        print("\n" + "=" * 70)
        print(f"DIFF: {file_path}")
        print("=" * 70)
        print(diff_text)
        print("=" * 70)

    def apply_proposal(self, proposal: dict) -> None:
        """Validate, diff, and (on approval) safely write a Nemotron proposal.

        All validation happens before anything is shown or written. If any
        change fails validation, the whole proposal is rejected and nothing
        is written (all-or-nothing at validation time). Changes whose
        proposed content is identical to the current file are treated as
        no-ops and skipped rather than written.
        """

        changes = proposal.get("changes", [])

        if not changes:
            print("\nNo code changes proposed.")
            return

        validated_changes = []

        # Validate proposal structure and filesystem safety before showing
        # an approval prompt. A single failure rejects the whole proposal
        # and nothing is written.
        for change in changes:
            file_path = change.get("file")
            content = change.get("content")

            if not file_path or not isinstance(file_path, str):
                print("\n❌ Proposal rejected: missing or invalid file path.")
                return

            if change.get("action") != "modify":
                print(
                    f"\n❌ Proposal rejected: unsupported action "
                    f"'{change.get('action')}' for {file_path}."
                )
                return

            if not isinstance(content, str):
                print(
                    f"\n❌ Proposal rejected: missing complete content "
                    f"for {file_path}."
                )
                return

            # Read through the safe filesystem layer. This rejects path
            # traversal, absolute paths, and files outside the repository
            # with a clean message instead of a traceback, and rejects
            # proposals that target nonexistent files (no arbitrary new
            # file creation via this path, since action must be "modify").
            try:
                current_content = read_file(file_path)
            except (ValueError, FileNotFoundError) as error:
                print(f"\n❌ Proposal rejected for {file_path}: {error}")
                return
            except Exception as error:
                print(
                    f"\n❌ Proposal rejected: could not safely read "
                    f"{file_path}: {error}"
                )
                return

            if content == current_content:
                print(f"\nℹ️  No actual content change for {file_path}; skipping.")
                continue

            validated_changes.append(
                {
                    "file": file_path,
                    "content": content,
                    "current_content": current_content,
                }
            )

        if not validated_changes:
            print("\nNo effective code changes after validation.")
            return

        print("\n" + "=" * 70)
        print("PROPOSED CHANGES")
        print("=" * 70)

        for change in validated_changes:
            self.show_diff(
                change["file"],
                change["content"],
            )

        print("\n" + "=" * 70)

        approval = input("Apply these changes? [y/N]: ").strip().lower()

        if approval != "y":
            print("\n❌ Changes rejected. No files were modified.")
            return

        applied = []
        failures = []

        for change in validated_changes:
            try:
                write_file(change["file"], change["content"])
            except Exception as error:
                failures.append((change["file"], f"write failed: {error}"))
                continue

            try:
                written_content = read_file(change["file"])
            except Exception as error:
                failures.append((change["file"], f"verification read failed: {error}"))
                continue

            if written_content != change["content"]:
                failures.append((change["file"], "verification mismatch"))
                continue

            applied.append(change["file"])
            print(f"✅ Updated and verified {change['file']}")

        if failures:
            print("\n⚠️  Some changes did not verify correctly:")
            for file_path, reason in failures:
                print(f"   - {file_path}: {reason}")

        if applied and not failures:
            print("\n✅ All approved changes were applied and verified.")
        elif applied:
            print(
                f"\n⚠️  {len(applied)} change(s) applied and verified; "
                f"see failures above for the rest."
            )
        else:
            print("\n❌ No changes were successfully applied.")


if __name__ == "__main__":
    agent = CodingAgent()

    proposal = agent.propose_changes(
        task=(
            "Review Task 22.2 for the Metadata Editor. "
            "Determine whether any migration work is still required. "
            "If the migration is already complete, propose no code changes."
        ),
        files=[
            "components/UploadZone.tsx",
            "components/MetadataEditorCard.tsx",
        ],
    )

    print(json.dumps(proposal, indent=2))

    agent.apply_proposal(proposal)