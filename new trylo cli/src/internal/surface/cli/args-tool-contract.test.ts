import assert from "node:assert/strict";
import test from "node:test";
import { parseToolContract } from "./args-tool-contract.js";

test("contract correction commands require an exact reviewed approval and reject broad switches", () => {
  assert.deepEqual(parseToolContract(["contract-propose", "proposal.json", "--json"]), { kind: "contract-propose", proposalFile: "proposal.json" });
  assert.deepEqual(parseToolContract(["contract-show", "proposal"]), { kind: "contract-show", proposalId: "proposal" });
  assert.deepEqual(parseToolContract(["contract-approve", "proposal", "--approve", "review"]), { kind: "contract-approve", proposalId: "proposal", reviewId: "review" });
  assert.deepEqual(parseToolContract(["contract-withdraw", "proposal", "--approve", "withdraw-review"]), { kind: "contract-withdraw", proposalId: "proposal", reviewId: "withdraw-review" });

  for (const tokens of [["contract-approve", "proposal"], ["contract-withdraw", "proposal"], ["contract-approve", "proposal", "--yes"], ["contract-approve", "proposal", "--approve", "review", "--force"]]) {
    assert.equal(parseToolContract(tokens)?.kind, "error");
  }

  assert.equal(parseToolContract(["production-show", "version"]), undefined);
});
