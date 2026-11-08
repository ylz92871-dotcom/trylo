import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationOutput, CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { C18_CENTRAL_CHANGE_INPUT_VERSION, CENTRAL_CHANGE_INPUT_VERSION } from "./change-input-contract.js";
import { createCentralLearningChangeView } from "./change-prompt.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import { centralLearningChangeSchema } from "./change-schema.js";
import { buildCentralDeliberationWireEvidence, isCentralDeliberationWireEvidence } from "./deliberation-wire-evidence.js";

// Produced by the immutable C16 and C17 modules before the C18 source change.
// Full original inputs/proofs and producer hashes are retained in the local
// c18-prompt-version-01 evidence; these constants do not depend on that directory.
const originalRequest: CentralDeliberationRequest = {
  "schemaVersion": 1,
  "scope": "workspace:prompt-version",
  "budgetId": "budget:prompt-version",
  "boardSequence": 3,
  "stateRef": "state:prompt-version",
  "configuration": {
    "schemaVersion": 1,
    "configurationRef": "configuration:prompt-version",
    "authorizationRef": "authorization:prompt-version",
    "allowance": {
      "schemaVersion": 2,
      "unit": "total_model_tokens",
      "maxTokens": 100000,
      "maxCalls": 4,
      "maxSteps": 4,
      "maxPromptChars": 100000
    }
  },
  "resources": {
    "boardSequence": 3,
    "budgetId": "budget:prompt-version",
    "limits": {
      "tokens": 100000,
      "calls": 4,
      "steps": 4
    },
    "occupied": {
      "tokens": 0,
      "calls": 0,
      "steps": 0
    },
    "available": {
      "tokens": 100000,
      "calls": 4,
      "steps": 4
    },
    "status": "available",
    "holdReason": null
  },
  "state": {
    "schemaVersion": 1,
    "scope": "workspace:prompt-version",
    "intents": [],
    "completed": [],
    "running": [],
    "materials": [],
    "consumedSourceRefs": []
  },
  "opportunities": [],
  "materials": [
    {
      "ref": "central-runtime-issue:5a415ab54f2ae39ce3d5e1da3cb0862c0bf291319ce0d0b72cac304d41da85f4",
      "kind": "source",
      "text": "{\"issueId\":\"issue:receiver-version\",\"problemKey\":\"receiver-version\",\"reports\":[{\"evidenceRefs\":[\"session-address:{\\\"sessionId\\\":\\\"session-version\\\",\\\"turnId\\\":\\\"turn-version\\\"}\"],\"facts\":[\"The receiver explicitly requires its original unit.\"],\"reportId\":\"report:receiver-version\",\"source\":{\"memberId\":\"personal_agent\",\"taskId\":\"session-version\",\"teamRunId\":\"turn-version\"}}],\"schemaVersion\":1,\"scope\":\"workspace:prompt-version\"}",
      "sourceRefs": [
        "issue:receiver-version",
        "report:receiver-version",
        "session-address:{\"sessionId\":\"session-version\",\"turnId\":\"turn-version\"}"
      ]
    }
  ],
  "organization": [],
  "operation": {
    "kind": "think",
    "operationId": "operation:prompt-version",
    "purpose": "Choose a useful original receiver inquiry.",
    "expectedChange": "Preserve the original unit condition.",
    "sourceRefs": [
      "central-runtime-issue:5a415ab54f2ae39ce3d5e1da3cb0862c0bf291319ce0d0b72cac304d41da85f4"
    ]
  }
};
const originalOutput: CentralDeliberationOutput = {
  "schemaVersion": 1,
  "intents": [],
  "publicExplanation": "Wait for an actual contrary contract.",
  "sourceRefs": [
    "central-runtime-issue:5a415ab54f2ae39ce3d5e1da3cb0862c0bf291319ce0d0b72cac304d41da85f4"
  ]
};
const historical = [
  {
    "candidate": "C16",
    "version": "central-learning-change-input-v1",
    "inputMessagesHash": "d386f7129572212d5ed117d653a65bc83d72b27528afad70313a8befc3f7a5a3",
    "advertisedSessionRead": false,
    "proof": {
      "schemaVersion": 1,
      "type": "central_deliberation_wire_evidence",
      "projectionVersion": "central-learning-change-v1",
      "inputVersion": "central-learning-change-input-v1",
      "checkpoint": "central-input-checkpoint:6862795409b487e27a09c3c7ab4424d506a4bf3d719a498267cab973dd920f28",
      "requestHash": "6862795409b487e27a09c3c7ab4424d506a4bf3d719a498267cab973dd920f28",
      "dictionaryHash": "29c8020245ed0bab77ae68cd99932fe5235bf44ae3c0fedd365c19404c322625",
      "viewHash": "4f2f99cf7c155e1d5358352484daa9a1233cd33fae21b8213c2e0330a9d6e8f5",
      "exposure": [
        {
          "ref": "central-runtime-issue:5a415ab54f2ae39ce3d5e1da3cb0862c0bf291319ce0d0b72cac304d41da85f4",
          "kind": "body",
          "textHash": "4a22ecb7ba50d0e71f84dada539e5f68c16a38ec8c1724ef5941a822870fe486",
          "readRefs": [
            "central-runtime-issue:5a415ab54f2ae39ce3d5e1da3cb0862c0bf291319ce0d0b72cac304d41da85f4"
          ]
        }
      ],
      "messagesHash": "9c945a5562fda010a456d593ac959f0a0450c7f030835ce9be0c296a9eb54c95",
      "toolsHash": "31341e3602ca67d13a947df6bbbd480055fd7990d92bd1deec9a9353455d55ca",
      "responseSchemaHash": null,
      "maxOutputTokens": 8192,
      "outputHash": "63058fbb8cfa3f17a1f9afc197a0929f528e2f6df115191f311a3868555bbcb9",
      "format": {
        "kind": "tool",
        "description": "Return this bounded public learning change."
      },
      "fundingMessage": {
        "role": "user",
        "content": "{\"available\":{\"calls\":3,\"steps\":3,\"tokens\":80000},\"budgetId\":\"budget:prompt-version\",\"holdReason\":null,\"interpretation\":\"current_root_resources_not_new_authorization_or_value_prediction\",\"limits\":{\"calls\":4,\"steps\":4,\"tokens\":100000},\"occupied\":{\"calls\":1,\"steps\":1,\"tokens\":20000},\"role\":\"host_original_root_after_this_computation_reservation\",\"status\":\"available\",\"thisComputation\":{\"calls\":1,\"maxTokens\":20000,\"reservationId\":\"central-deliberation:6a29db41433e00985bf27a7c9ec4e84eca626f8cfbc0e8ce98d2f8b33012c4b9\",\"steps\":1}}"
      },
      "rawChange": {
        "changes": [],
        "explanation": "Wait for an actual contrary contract.",
        "sources": [
          "b6862795409b4_5"
        ]
      }
    }
  },
  {
    "candidate": "C17",
    "version": "central-learning-change-input-v2",
    "inputMessagesHash": "f71884c5e6772af685860bb7b7aed3b513f0ec92109cbed92e274dc5860abf72",
    "advertisedSessionRead": true,
    "proof": {
      "schemaVersion": 1,
      "type": "central_deliberation_wire_evidence",
      "projectionVersion": "central-learning-change-v1",
      "inputVersion": "central-learning-change-input-v2",
      "checkpoint": "central-input-checkpoint:6862795409b487e27a09c3c7ab4424d506a4bf3d719a498267cab973dd920f28",
      "requestHash": "6862795409b487e27a09c3c7ab4424d506a4bf3d719a498267cab973dd920f28",
      "dictionaryHash": "a72451b29ab5a9e62765d69017bd2374a5845e4f138feb2631d2988b20974c90",
      "viewHash": "5dacda9a184c6ad07d8f87be5ce7a508b5d959c713f0c98271520355c5a61072",
      "exposure": [
        {
          "ref": "central-runtime-issue:5a415ab54f2ae39ce3d5e1da3cb0862c0bf291319ce0d0b72cac304d41da85f4",
          "kind": "body",
          "textHash": "4a22ecb7ba50d0e71f84dada539e5f68c16a38ec8c1724ef5941a822870fe486",
          "readRefs": [
            "session-address:{\"sessionId\":\"session-version\",\"turnId\":\"turn-version\"}",
            "central-runtime-issue:5a415ab54f2ae39ce3d5e1da3cb0862c0bf291319ce0d0b72cac304d41da85f4"
          ]
        }
      ],
      "messagesHash": "b9e2834c14a4561bb2eb4e0039f3bd658b768f5b628ea592b9ead19b47876b45",
      "toolsHash": "31341e3602ca67d13a947df6bbbd480055fd7990d92bd1deec9a9353455d55ca",
      "responseSchemaHash": null,
      "maxOutputTokens": 8192,
      "outputHash": "63058fbb8cfa3f17a1f9afc197a0929f528e2f6df115191f311a3868555bbcb9",
      "format": {
        "kind": "tool",
        "description": "Return this bounded public learning change."
      },
      "fundingMessage": {
        "role": "user",
        "content": "{\"available\":{\"calls\":3,\"steps\":3,\"tokens\":80000},\"budgetId\":\"budget:prompt-version\",\"holdReason\":null,\"interpretation\":\"current_root_resources_not_new_authorization_or_value_prediction\",\"limits\":{\"calls\":4,\"steps\":4,\"tokens\":100000},\"occupied\":{\"calls\":1,\"steps\":1,\"tokens\":20000},\"role\":\"host_original_root_after_this_computation_reservation\",\"status\":\"available\",\"thisComputation\":{\"calls\":1,\"maxTokens\":20000,\"reservationId\":\"central-deliberation:6a29db41433e00985bf27a7c9ec4e84eca626f8cfbc0e8ce98d2f8b33012c4b9\",\"steps\":1}}"
      },
      "rawChange": {
        "changes": [],
        "explanation": "Wait for an actual contrary contract.",
        "sources": [
          "b6862795409b4_5"
        ]
      }
    }
  }
] as const;

test("versioned learning prompts preserve frozen wire receipts while v3 states this call's decision boundary", () => {
  const c18 = createCentralLearningChangeView(originalRequest, [], C18_CENTRAL_CHANGE_INPUT_VERSION);
  const current = createCentralLearningChangeView(originalRequest);

  assert.equal(C18_CENTRAL_CHANGE_INPUT_VERSION, "central-learning-change-input-v3");
  assert.equal(c18.version, "central-learning-change-input-v3", "the decision boundary must retain its explicit historical version");
  assert.equal(current.version, CENTRAL_CHANGE_INPUT_VERSION, "the default view follows the current production version");
  const address = 'session-address:{"sessionId":"session-version","turnId":"turn-version"}';
  const originalBytes = JSON.stringify({ request: originalRequest, output: originalOutput, historical });
  let oldInstruction: string | undefined;

  for (const [index, fixture] of historical.entries()) {
    const replay = createCentralLearningChangeView(originalRequest, [], fixture.version);

    assert.equal(replay.version, fixture.version);
    assert.equal(contentHashOf(replay.messages), fixture.inputMessagesHash, fixture.candidate + " message bytes changed");
    assert.equal(replay.dictionary.entries.some(row => row.kind === "read" && row.ref === address), fixture.advertisedSessionRead);
    assert.equal(isCentralDeliberationWireEvidence(fixture.proof, originalRequest, originalOutput), true,
      fixture.candidate + " original actual wire proof must replay unchanged");
    const other = historical[index === 0 ? 1 : 0]!;

    assert.notEqual(fixture.proof.dictionaryHash, other.proof.dictionaryHash);
    assert.equal(isCentralDeliberationWireEvidence({ ...fixture.proof, inputVersion: other.version }, originalRequest, originalOutput), false,
      "a version label cannot borrow the other version's read-capability semantics");
    assert.equal(isCentralDeliberationWireEvidence({ ...fixture.proof, messagesHash: "0".repeat(64) }, originalRequest, originalOutput), false);
    const instruction = replay.messages[0]?.content;
    assert.equal(typeof instruction, "string");

    if (oldInstruction === undefined) oldInstruction = instruction as string;
    else assert.equal(instruction, oldInstruction, "C16 and C17 retain their identical original system instruction");
  }

  assert.ok(oldInstruction);
  const instruction = c18.messages[0]?.content;
  assert.equal(typeof instruction, "string");
  assert.ok((instruction as string).startsWith(oldInstruction), "the historical instruction remains the exact prefix");
  const boundary = (instruction as string).slice(oldInstruction.length);

  for (const meaning of [/worthwhile[\s\S]*question/i, /related changes/i, /optional/i, /inventory/i,
    /original read/i, /useful decision/i, /delegat/i, /authorized[\s\S]*subsystem/i,
    /multiple|multi|several/i, /pause/i, /counterexample/i, /no action|no-action/i]) assert.match(boundary, meaning);

  assert.match(boundary, /opportunity handle retains its original subject/i);
  assert.match(boundary, /direct choice needs no new central derivation/i);
  assert.match(boundary, /does not establish applicability, quality or benefit/i);
  assert.match(boundary, /newly derived central purposes or relations[\s\S]*grounding in delivered bodies/i);
  assert.equal(c18.dictionary.entries.some(row => row.kind === "read" && row.ref === address), true,
    "v3 retains the authenticated report-address capability introduced in v2");
  assert.equal(contentHashOf(c18.view), historical[1]!.proof.viewHash, "v3 changes the instruction, not the v2 data view");
  assert.equal(contentHashOf({ checkpoint: c18.dictionary.checkpoint, entries: c18.dictionary.entries }),
    historical[1]!.proof.dictionaryHash, "v3 retains the exact v2 typed dictionary");
  assert.equal(isCentralDeliberationWireEvidence({ ...historical[1]!.proof, inputVersion: "central-learning-change-input-v3" },
    originalRequest, originalOutput), false, "a historical receipt cannot be upgraded to the new instruction by relabeling");
  assert.equal(isCentralDeliberationWireEvidence({ ...historical[1]!.proof, inputVersion: "central-learning-change-input-v999" },
    originalRequest, originalOutput), false, "unknown prompt versions fail closed");
  const source = current.dictionary.entries.find(row => row.kind === "source" && row.ref === originalRequest.materials[0]!.ref);
  assert.ok(source);
  const selectionCode = current.view.checkpoint;
  assert.equal(typeof selectionCode, "string");
  const rawChange = { checkpoint: selectionCode, changes: [], explanation: "Wait for an actual contrary contract.", sources: [source.handle] };
  const output = decodeCentralDeliberation(compileCentralLearningChange(rawChange, originalRequest, current.dictionary,
    CENTRAL_CHANGE_INPUT_VERSION), originalRequest, [], CENTRAL_CHANGE_INPUT_VERSION);

  assert.deepEqual(output, originalOutput);
  const wire = { messages: [...current.messages, historical[1]!.proof.fundingMessage], maxOutputTokens: 8192,
    tools: [{ name: "submit_learning_change", description: "Return this bounded public learning change.",
      parameters: centralLearningChangeSchema(originalRequest, current.dictionary, CENTRAL_CHANGE_INPUT_VERSION) }] };
  const proof = buildCentralDeliberationWireEvidence({ request: originalRequest, output, rawChange, wire });
  assert.ok(proof);
  assert.equal(proof.inputVersion, CENTRAL_CHANGE_INPUT_VERSION);
  assert.equal(isCentralDeliberationWireEvidence(proof, originalRequest, output), true);
  assert.equal(isCentralDeliberationWireEvidence({ ...proof, inputVersion: historical[1]!.version }, originalRequest, output), false,
    "the current instruction and reference encoding cannot be replayed under the old message version");
  assert.equal(JSON.stringify({ request: originalRequest, output: originalOutput, historical }), originalBytes);
});
