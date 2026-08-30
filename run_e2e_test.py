"""
Task 23 — Real end-to-end test driver for the CodingAgent.

This is a standalone script so it does NOT touch coding_agent.py's existing
__main__ block (which runs the separate Metadata Editor review task).

Usage:
    python run_e2e_test.py

Requires NVIDIA_API_KEY to be set in .env (already configured per
ai_assistant.py). Makes a real call to Nemotron.
"""

import json

from coding_agent import CodingAgent

TASK = (
    "Make one small, harmless test change to agent_e2e_test.py. "
    "Change TEST_VALUE from 1 to 2. Do not make any other changes."
)

if __name__ == "__main__":
    agent = CodingAgent()

    proposal = agent.propose_changes(
        task=TASK,
        files=["agent_e2e_test.py"],
    )

    print("\n----- RAW PROPOSAL -----")
    print(json.dumps(proposal, indent=2))
    print("-------------------------\n")

    agent.apply_proposal(proposal)
